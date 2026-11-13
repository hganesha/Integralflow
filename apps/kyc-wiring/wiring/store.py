"""SQLAlchemy persistence. SQLite demo / PostgreSQL deployment. Encrypted payload columns.
Optimistic compare-and-swap leasing prevents two workers from claiming the same job.
A lost live lease is sent to reconciliation rather than blindly re-running paid calls.
"""
import json,time,datetime
from sqlalchemy import create_engine,MetaData,Table,Column,String,Text,Integer,Float,UniqueConstraint,select,update,insert,and_,or_,event
from sqlalchemy.exc import IntegrityError
from cryptography.fernet import Fernet
from .core import canonical,sha,stamp,uid,WiringError
class Store:
 def __init__(self,settings):
  self.settings=settings;self.crypto=Fernet(settings.encryption_key.encode())
  connect={'check_same_thread':False,'timeout':20} if settings.database_url.startswith('sqlite') else {}
  self.engine=create_engine(settings.database_url,connect_args=connect,pool_pre_ping=True)
  self.meta=MetaData()
  self.checks=Table('checks',self.meta,Column('id',String,primary_key=True),Column('tenant',String,index=True),Column('idempotency',String),Column('digest',String),Column('provider',String),Column('capability',String),Column('status',String,index=True),Column('request',Text),Column('result',Text),Column('artifact',Text),Column('error',String),Column('attempts',Integer,default=0),Column('available_at',Float),Column('lease_until',Float),Column('lease_owner',String),Column('version',Integer,default=1),Column('created_at',String),Column('updated_at',String),UniqueConstraint('tenant','idempotency',name='uq_tenant_idempotency'))
  self.events=Table('events',self.meta,Column('id',String,primary_key=True),Column('tenant',String,index=True),Column('check_id',String,index=True),Column('version',Integer),Column('body',Text),Column('created_at',String))
  self.inbox=Table('webhook_inbox',self.meta,Column('id',String,primary_key=True),Column('tenant',String),Column('check_id',String),Column('digest',String),Column('raw',Text),Column('created_at',String),UniqueConstraint('check_id','digest',name='uq_webhook_digest'))
  self.audit=Table('audit',self.meta,Column('id',String,primary_key=True),Column('tenant',String,index=True),Column('action',String),Column('check_id',String),Column('at',String),Column('detail',Text))
  self.subscriptions=Table('subscriptions',self.meta,Column('id',String,primary_key=True),Column('tenant',String,index=True),Column('destination',String),Column('created_at',String),UniqueConstraint('tenant','destination',name='uq_subscription'))
  self.deliveries=Table('deliveries',self.meta,Column('id',String,primary_key=True),Column('tenant',String,index=True),Column('event_id',String),Column('destination',String),Column('status',String),Column('attempts',Integer,default=0),Column('available_at',Float),Column('lease_owner',String),Column('lease_until',Float),Column('last_code',String),UniqueConstraint('event_id','destination',name='uq_event_destination'))
  self.results=Table('result_history',self.meta,Column('id',String,primary_key=True),Column('tenant',String,index=True),Column('check_id',String,index=True),Column('version',Integer),Column('payload',Text),Column('artifact',Text),Column('created_at',String),UniqueConstraint('check_id','version',name='uq_check_result_version'))
  self.meta.create_all(self.engine)
  if settings.database_url.startswith('sqlite'):
   with self.engine.connect() as c:c.exec_driver_sql('PRAGMA journal_mode=WAL')
 def enc(self,x):return self.crypto.encrypt(canonical(x).encode()).decode()
 def dec(self,x):return json.loads(self.crypto.decrypt(x.encode())) if x else None
 def log(self,c,tenant,action,check_id=None,detail=None):c.execute(insert(self.audit).values(id=uid(),tenant=tenant,action=action,check_id=check_id,at=stamp(),detail=self.enc(detail or {})))
 def row(self,check_id,tenant=None):
  q=select(self.checks).where(self.checks.c.id==check_id)
  if tenant is not None:q=q.where(self.checks.c.tenant==tenant)
  with self.engine.connect() as c:return c.execute(q).mappings().first()
 def submit(self,tenant,request,provider):
  logical={**request,'extensions':{k:v for k,v in request.get('extensions',{}).items() if k!='source_authorization'}}
  token=request['idempotency_key'];digest=sha(canonical({'provider':provider,'request':logical}));check_id=uid()
  values=dict(id=check_id,tenant=tenant,idempotency=token,digest=digest,provider=provider,capability=request['capability'],status='queued',request=self.enc(request),attempts=0,available_at=time.time(),lease_until=0,version=1,created_at=stamp(),updated_at=stamp())
  try:
   with self.engine.begin() as c:c.execute(insert(self.checks).values(**values));self.log(c,tenant,'check.created',check_id)
   return self.row(check_id,tenant),False
  except IntegrityError:
   with self.engine.connect() as c:row=c.execute(select(self.checks).where(self.checks.c.tenant==tenant,self.checks.c.idempotency==token)).mappings().one()
   if row['digest']!=digest:raise WiringError('IDEMPOTENCY_CONFLICT','Idempotency key already used with different request or provider',409)
   if not self.settings.demo and request.get('extensions',{}).get('source_authorization') and row['status'] in ['queued','retry_wait','awaiting_webhook','authorization_required']:
    # Admission already verified the renewed proof. Business input and the source contract stay pinned.
    import base64
    def scope(document):
     part=document['extensions']['source_authorization']['token'].split('.')[1]
     return json.loads(base64.urlsafe_b64decode(part+'='*(-len(part)%4)))['scope']
    old_scope=scope(self.dec(row['request']));new_scope=scope(request)
    if any(old_scope.get(key)!=new_scope.get(key) for key in ['binding_digest','upstream_contract_digest']):raise WiringError('SOURCE_AUTHORIZATION_DENIED','Source contract changed; reconcile the existing check',403)
    with self.engine.begin() as c:
     c.execute(update(self.checks).where(self.checks.c.id==row['id'],self.checks.c.version==row['version'],self.checks.c.status==row['status']).values(request=self.enc(request),status='queued' if row['status']=='authorization_required' else row['status'],version=row['version']+1,available_at=time.time() if row['status']=='authorization_required' else row['available_at'],error=None,updated_at=stamp()))
     self.log(c,tenant,'check.source_authority_renewed',row['id'])
    row=self.row(row['id'],tenant)
   return row,True
 def hold_source_authorization(self,row,artifact):
  with self.engine.begin() as c:
   c.execute(update(self.checks).where(self.checks.c.id==row['id'],self.checks.c.lease_owner==row['lease_owner'],self.checks.c.status=='running').values(status='authorization_required',artifact=self.enc(artifact),lease_owner=None,lease_until=0,error='SOURCE_AUTHORIZATION_DENIED',version=row['version']+1,updated_at=stamp()))
   self.log(c,row['tenant'],'check.source_authorization_required',row['id'])
 def list_checks(self,tenant,limit=50,offset=0):
  with self.engine.connect() as c:return list(c.execute(select(self.checks).where(self.checks.c.tenant==tenant).order_by(self.checks.c.created_at.desc()).limit(limit).offset(offset)).mappings())
 def claim(self):
  token=uid();t=time.time()
  with self.engine.begin() as c:
   # Recovery must not repeat an ambiguous live upstream execution.
   stale=list(c.execute(select(self.checks).where(self.checks.c.status=='running',self.checks.c.lease_until<t)).mappings())
   for row in stale:
    c.execute(update(self.checks).where(self.checks.c.id==row['id'],self.checks.c.status=='running',self.checks.c.lease_until<t).values(status='queued' if self.settings.demo else 'reconciliation_required',lease_owner=None,available_at=t,error='LEASE_EXPIRED'))
   candidates=list(c.execute(select(self.checks).where(self.checks.c.status.in_(['queued','retry_wait']),self.checks.c.available_at<=t).order_by(self.checks.c.created_at).limit(20)).mappings())
   for row in candidates:
    n=c.execute(update(self.checks).where(self.checks.c.id==row['id'],self.checks.c.status==row['status'],self.checks.c.version==row['version']).values(status='running',lease_owner=token,lease_until=t+self.settings.lease_seconds,attempts=row['attempts']+1,version=row['version']+1,updated_at=stamp())).rowcount
    if n:
     self.log(c,row['tenant'],'check.claimed',row['id']);r=dict(row);r.update(status='running',lease_owner=token,attempts=row['attempts']+1,version=row['version']+1);return r
  return None
 def finish(self,row,result,artifact,status='completed'):
  t=self.checks
  with self.engine.begin() as c:
   version=row['version']+1
   n=c.execute(update(t).where(t.c.id==row['id'],t.c.lease_owner==row['lease_owner'],t.c.status=='running').values(status=status,result=self.enc(result),artifact=self.enc(artifact),lease_owner=None,lease_until=0,version=version,updated_at=stamp(),error=None)).rowcount
   if not n:return False
   c.execute(insert(self.results).values(id=result['result_id'],tenant=row['tenant'],check_id=row['id'],version=version,payload=self.enc(result),artifact=self.enc(artifact),created_at=stamp()))
   body={'specversion':'1.0','id':uid(),'source':'https://host.example.invalid/kyc-wiring','type':'kyc.check.failed.v1' if status=='failed' else 'kyc.check.result.updated.v1','time':stamp(),'subject':'checks/'+row['id'],'tenant_id':row['tenant'],'resource_version':version,'data':{'check_id':row['id'],'result_id':result['result_id'],'result_schema_version':'1.0.0','changed_paths':['/execution','/assessment','/result']}}
   c.execute(insert(self.events).values(id=body['id'],tenant=row['tenant'],check_id=row['id'],version=version,body=self.enc(body),created_at=stamp()))
   for sub in c.execute(select(self.subscriptions).where(self.subscriptions.c.tenant==row['tenant'])).mappings():c.execute(insert(self.deliveries).values(id=uid(),tenant=row['tenant'],event_id=body['id'],destination=sub['destination'],status='queued',attempts=0,available_at=time.time(),lease_until=0))
   self.log(c,row['tenant'],'check.'+status,row['id'])
  return True
 def retry(self,row,code,delay=1,ambiguous=False):
  status='reconciliation_required' if ambiguous else 'dead_letter' if row['attempts']>=self.settings.max_attempts else 'retry_wait'
  with self.engine.begin() as c:
   c.execute(update(self.checks).where(self.checks.c.id==row['id'],self.checks.c.lease_owner==row['lease_owner'],self.checks.c.status=='running').values(status=status,error=code,lease_owner=None,lease_until=0,available_at=time.time()+delay,updated_at=stamp()))
   self.log(c,row['tenant'],'check.'+status,row['id'],{'code':code})
 def await_webhook(self,row,artifact):
  with self.engine.begin() as c:
   c.execute(update(self.checks).where(self.checks.c.id==row['id'],self.checks.c.lease_owner==row['lease_owner'],self.checks.c.status=='running').values(status='awaiting_webhook',artifact=self.enc(artifact),lease_owner=None,lease_until=0,updated_at=stamp()))
 def accept_webhook(self,check_id,raw):
  row=self.row(check_id)
  if not row:raise WiringError('NOT_FOUND','Unknown webhook resource',404)
  try:
   with self.engine.begin() as c:
    c.execute(insert(self.inbox).values(id=uid(),tenant=row['tenant'],check_id=check_id,digest=sha(raw),raw=self.enc({'hex':raw.hex()}),created_at=stamp()))
    if row['status']!='awaiting_webhook':raise WiringError('WEBHOOK_STATE_CONFLICT','Check not awaiting webhook; reconcile instead of overwriting newer state',409)
    submission=self.dec(row['artifact']) or {}
    artifact={'provider_record_id':submission.get('provider_record_id'),'submission_artifact':submission,'webhook_payload':json.loads(raw),'native_payload':json.loads(raw),'raw_http_hex':raw.hex(),'sha256':sha(raw),'digest_representation':'original verified webhook bytes'}
    n=c.execute(update(self.checks).where(self.checks.c.id==check_id,self.checks.c.status=='awaiting_webhook',self.checks.c.version==row['version']).values(status='queued',artifact=self.enc(artifact),available_at=time.time(),version=row['version']+1,updated_at=stamp())).rowcount
    if not n:raise WiringError('WEBHOOK_STATE_CONFLICT','Concurrent state update',409)
    self.log(c,row['tenant'],'webhook.persisted',check_id)
   return False
  except IntegrityError:return True
 def audit_rows(self,tenant):
  with self.engine.connect() as c:return [dict(r,id=r['id'],detail=self.dec(r['detail'])) for r in c.execute(select(self.audit).where(self.audit.c.tenant==tenant).order_by(self.audit.c.at.desc()).limit(100)).mappings()]
 def defer_poll(self,row,artifact,delay):
  with self.engine.begin() as c:
   c.execute(update(self.checks).where(self.checks.c.id==row['id'],self.checks.c.lease_owner==row['lease_owner'],self.checks.c.status=='running').values(status='retry_wait',artifact=self.enc(artifact),lease_owner=None,lease_until=0,attempts=max(0,row['attempts']-1),available_at=time.time()+delay,updated_at=stamp()))
 def requeue(self,check_id,tenant):
  with self.engine.begin() as c:
   row=c.execute(select(self.checks).where(self.checks.c.id==check_id,self.checks.c.tenant==tenant)).mappings().first()
   if not row:raise WiringError('NOT_FOUND','Check not found',404)
   if row['status']not in ['dead_letter','failed']:raise WiringError('REPLAY_DENIED','Only failed/dead-letter jobs can be retried here. Ambiguous live calls need explicit external reconciliation.',409)
   c.execute(update(self.checks).where(self.checks.c.id==check_id,self.checks.c.version==row['version']).values(status='queued',attempts=0,version=row['version']+1,available_at=time.time(),updated_at=stamp(),error=None))
   self.log(c,tenant,'check.manual_retry',check_id)
