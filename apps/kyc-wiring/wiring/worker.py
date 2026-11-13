import time,copy,json,random,logging,os,hmac,hashlib
from sqlalchemy import select,update
from .core import read,ATLAS,stamp,uid,WiringError,canonical,sha
from .connectors import simulation,HTTPConnector,RetryUpstream,Progress,check_url
from vendor.atlas.normalizers import validate_semantics
log=logging.getLogger('wiring.worker')
class Worker:
 def __init__(self,store,registry,connector=None):self.store=store;self.registry=registry;self.connector=connector or HTTPConnector(store.settings)
 def failure(self,row,request,code,artifact=None):
  result=copy.deepcopy(read(ATLAS/f"examples/capabilities/{request['capability']}.json"))
  result.update(result_id=uid(),tenant_id=row['tenant'],request_id=request['request_id'],subject_entity_id=request['subject_entity_id'],entities=request['entities'],relationships=[],assertions=[],evidence=[])
  result['provider'].update(provider_id=row['provider'],adapter_version='wiring-1',status_original=None,decision_origin='unknown');result['execution'].update(status='failed',received_at=stamp());result['assessment'].update(outcome='unknown',reason_codes=[code],bank_decision='not_evaluated');result['errors']=[{'code':code,'category':'schema_drift' if code in ['SCHEMA_INVALID','NATIVE_MAPPING_MISSING','SEMANTIC_INVALID'] else 'unknown','message':'Integration did not produce an accepted result. No verification or approval implied.','retryable':False}]
  result['warnings']=['Integration failure; inspect operational audit and reconcile before retrying'];result['extensions']={'execution_mode':'simulation' if self.store.settings.demo else 'live','wiring_check_id':row['id']};result['raw_payload']={'vault_ref':'artifact://checks/'+row['id'],'sha256':(artifact or {}).get('sha256',sha(canonical(artifact or {}))),'classification':'restricted'}
  if result['result']['kind']=='business':result['result']['organization_entity_id']=request['subject_entity_id']
  if result['result']['kind']=='ownership':result['result']['root_entity_id']=request['subject_entity_id']
  return result
 def run_one(self):
  row=self.store.claim()
  if not row:return False
  request=self.store.dec(row['request']);artifact=self.store.dec(row['artifact']) or {}
  try:
   op,c=self.registry.resolve(request,row['provider'])
   result,artifact=simulation(row,request,op) if self.store.settings.demo else self.connector.execute(row,request,op,c,artifact)
   self.registry.validate('host',result)
   errors=validate_semantics(result)
   if errors:raise WiringError('SEMANTIC_INVALID','Host semantic reference validation failed')
   self.store.finish(row,result,artifact,'failed' if result['execution']['status']=='failed' else 'partial' if result['execution']['status']=='partial' else 'completed')
  except Progress as e:
   if e.mode=='webhook':self.store.await_webhook(row,e.artifact)
   else:self.store.defer_poll(row,e.artifact,e.delay)
  except RetryUpstream as e:self.store.retry(row,e.code,e.delay,e.ambiguous)
  except WiringError as e:
   if e.code=='SOURCE_AUTHORIZATION_DENIED':
    self.store.hold_source_authorization(row,artifact);return True
   result=self.failure(row,request,e.code,artifact);self.registry.validate('host',result);self.store.finish(row,result,artifact,'failed')
  except Exception:
   # No exception str/trace here: native HTTP libraries can include URLs/tokens.
   log.error('Internal worker failure; check_id=%s',row['id']);self.store.retry(row,'INTERNAL_WORKER_ERROR',2,ambiguous=not self.store.settings.demo)
  return True
 def deliver_one(self):
  s=self.store;token=uid();t=time.time();d=s.deliveries
  with s.engine.begin() as c:
   rows=c.execute(select(d).where(d.c.status.in_(['queued','retry_wait','running']),d.c.available_at<=t,d.c.lease_until<t).limit(10)).mappings().all();row=None
   for r in rows:
    n=c.execute(update(d).where(d.c.id==r['id'],d.c.status==r['status'],d.c.lease_until==r['lease_until']).values(status='running',lease_owner=token,lease_until=t+60,attempts=r['attempts']+1)).rowcount
    if n:row=dict(r);break
  if not row:return False
  destination=s.settings.destinations.get(row['destination']);code=None;success=False;final=False
  try:
   if not destination or not destination.get('approved') or row['tenant']not in destination.get('tenant_ids',[]):raise WiringError('DESTINATION_DENIED','Destination not approved for tenant')
   if s.settings.demo:raise WiringError('DEMO_EGRESS_DISABLED','Outbound callback networking disabled in demo; read events API instead')
   base=check_url(destination['url'],[destination['url']]);secret=os.environ[destination['signing_secret_env']]
   with s.engine.connect() as c:ev=c.execute(select(s.events).where(s.events.c.id==row['event_id'],s.events.c.tenant==row['tenant'])).mappings().one()
   payload=canonical(s.dec(ev['body'])).encode();timestamp=str(int(time.time()));signature=hmac.new(secret.encode(),timestamp.encode()+b'.'+payload,hashlib.sha256).hexdigest()
   # Destination is static operator configuration, never caller-supplied URL.
   resp=self.connector.client.post(base,content=payload,headers={'Content-Type':'application/json','X-Wiring-Event-Id':row['event_id'],'X-Wiring-Timestamp':timestamp,'X-Wiring-Signature':signature});code=str(resp.status_code);success=200<=resp.status_code<300
  # Configuration denials cannot heal in-process (settings load at startup), so dead-letter them at once.
  except WiringError as e:code=e.code;final=True
  except Exception:code='DELIVERY_ERROR';log.warning('Event delivery failed; delivery_id=%s',row['id'])
  with s.engine.begin() as c:c.execute(update(d).where(d.c.id==row['id'],d.c.lease_owner==token).values(status='delivered' if success else 'dead_letter' if final or row['attempts']+1>=5 else 'retry_wait',lease_owner=None,lease_until=0,last_code=code,available_at=time.time()+min(120,2**(row['attempts']+1)+random.random())))
  return True

def main():
 from .core import Settings,Registry
 from .store import Store
 settings=Settings.env();store=Store(settings);worker=Worker(store,Registry(settings))
 while True:
  worked=worker.run_one();delivered=worker.deliver_one()
  if not worked and not delivered:time.sleep(.5)
if __name__=='__main__':main()
