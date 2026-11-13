"""Explicit authenticated credential-testing API, isolated from production readiness.
Durable reservation prevents repeated paid calls for a reused Idempotency-Key.
"""
import os,json
from typing import Any,Literal
from fastapi import Depends,Header,Query
from pydantic import BaseModel,ConfigDict,Field
from sqlalchemy import Table,Column,String,Text,UniqueConstraint,select,insert,update
from sqlalchemy.exc import IntegrityError
from wiring.core import WiringError,uid,stamp,sha,canonical,ATLAS,read
from .client import definitions,VendorClient,prefix,spec_for,deref
from .normalization import interpret
from .capability_mapping import mapping as operation_mapping,check_requested
class VendorInput(BaseModel):
 model_config=ConfigDict(extra='forbid')
 purpose:Literal['vendor_integration_test']='vendor_integration_test'
 region:str|None=None
 path:dict[str,Any]=Field(default_factory=dict)
 query:dict[str,Any]=Field(default_factory=dict)
 headers:dict[str,str]=Field(default_factory=dict)
 body:Any=None
 files:dict[str,dict[str,str]]=Field(default_factory=dict)
 request_id:str=Field(min_length=1,max_length=200)
 subject_entity_id:str=Field(min_length=1,max_length=200)
 canonical_request:dict|None=None

def inventory():
 discovery=read(__import__('pathlib').Path(__file__).parent/'sources/discovery.json');clients=definitions()
 for r in discovery:
  v=clients.get(r['provider_id']);r['implementation_status']='quarantined'if r['restriction']else 'implemented_unverified'if v else 'not_implemented'
  r['implemented_operations']=len(v['operations'])if v else 0;r['documentation_sources']=v['sources']if v else r['documentation_links'];r['live_tested']=False
  if not v and not r['restriction']:r['gap']='Documented vendor-specific request/authentication implementation still required. Homepage/doc-link discovery is not API implementation.'
 return discovery

def install(app,settings,store,registry,auth,admin):
 t=Table('vendor_test_invocations',store.meta,Column('id',String,primary_key=True),Column('tenant',String,index=True),Column('idempotency',String),Column('digest',String),Column('provider',String),Column('operation',String),Column('status',String),Column('payload',Text),Column('error',Text),Column('created_at',String),UniqueConstraint('tenant','idempotency',name='uq_vendor_test_tenant_key'))
 t.create(store.engine,checkfirst=True);client=VendorClient();app.state.vendor_client=client
 @app.get('/v1/vendor-connections',tags=['Documented vendor testing'])
 def list_connections(implemented:bool|None=None,p=Depends(auth)):
  rows=inventory()
  if implemented is not None:rows=[r for r in rows if bool(r['implemented_operations'])==implemented]
  return {'catalog_records':len(registry.providers),'implemented_vendors':len(definitions()),'implemented_operations':sum(len(v['operations'])for v in definitions().values()),'live_tested':0,'items':rows}
 @app.get('/v1/vendor-connections/{provider_id}',tags=['Documented vendor testing'])
 def connection(provider_id:str,p=Depends(auth)):
  row=next((r for r in inventory()if r['provider_id']==provider_id),None)
  if row is None:raise WiringError('UNKNOWN_PROVIDER','Unknown catalog provider',404)
  return {'inventory':row,'contract':definitions().get(provider_id),'credential_environment_prefix':prefix(provider_id)}
 @app.get('/v1/vendor-connections/{provider_id}/operations/{operation_id}',tags=['Documented vendor testing'])
 def operation_contract(provider_id:str,operation_id:str,p=Depends(auth)):
  v=definitions().get(provider_id);op=v['operations'].get(operation_id)if v else None
  if not op:raise WiringError('OPERATION_NOT_IMPLEMENTED','No pinned native operation',404)
  spec=spec_for(provider_id)
  body_schema={'schema':op.get('body_schema'), 'resolution_root_file':'vendor_connections/'+v['openapi_file']}if spec else None
  return {'provider_id':provider_id,'operation_id':operation_id,'contract':op,'body_schema':body_schema,'credentials':[prefix(provider_id)+k for k in v['auth']['keys']],'sources':v['sources'],'maturity':'implemented_unverified'}
 @app.post('/v1/vendor-connections/{provider_id}/operations/{operation_id}/invoke',tags=['Documented vendor testing'])
 def invoke(provider_id:str,operation_id:str,body:VendorInput,idempotency_key:str=Header(...,min_length=1,max_length=200),p=Depends(admin)):
  if os.getenv('SECURITY_PROFILE')=='production' or os.getenv('RELEASE_ENVIRONMENT')=='production':raise WiringError('SOURCE_AUTHORIZATION_DENIED','Production source calls must use the governed checks endpoint',403)
  if settings.demo or os.getenv('VENDOR_TEST_ENABLED')!='1':raise WiringError('VENDOR_TEST_DISABLED','Real calls are disabled in demo. Configure non-demo mode and VENDOR_TEST_ENABLED=1 on your private deployment.',409)
  try:tenants=json.loads(os.getenv('VENDOR_TEST_TENANTS_JSON','[]'))
  except Exception:tenants=None
  if not isinstance(tenants,list):raise WiringError('VENDOR_TEST_CONFIG_INVALID','VENDOR_TEST_TENANTS_JSON must be an array',409)
  if p['tenant_id']not in tenants:raise WiringError('VENDOR_TEST_TENANT_DENIED','Tenant not enabled for credential testing',403)
  if provider_id not in definitions():raise WiringError('VENDOR_NOT_IMPLEMENTED','No documented client implemented for this provider; see inventory gap',409)
  if operation_id not in definitions()[provider_id]['operations']:raise WiringError('OPERATION_NOT_IMPLEMENTED','Unknown documented operation',404)
  context={'request_id':body.request_id,'subject_entity_id':body.subject_entity_id,'tenant_id':p['tenant_id']}
  if body.canonical_request:
   req=body.canonical_request;registry.validate('request',req)
   if req['tenant_id']!=p['tenant_id']:raise WiringError('TENANT_MISMATCH','Canonical request tenant must match credential tenant',403)
   if req['request_id']!=body.request_id or req['subject_entity_id']!=body.subject_entity_id:raise WiringError('REQUEST_CONTEXT_MISMATCH','Canonical and native request context differ')
   if provider_id not in req['routing']['provider_allowlist']:raise WiringError('ROUTING_DENIED','Canonical request must explicitly allow this provider',403)
   if req['subject_entity_id']not in [e['entity_id']for e in req['entities']]:raise WiringError('SUBJECT_INVALID','Canonical subject missing')
   context.update(capability=req['capability'],entities=req['entities'])
  # The reviewed operation mapping decides what this call can satisfy; reject mismatches before anything is reserved or sent.
  check_requested(operation_mapping(provider_id,operation_id),context.get('capability'))
  inputs=body.model_dump(exclude={'region','request_id','subject_entity_id','purpose','canonical_request'});digest=sha(canonical({'provider':provider_id,'operation':operation_id,'request':body.model_dump()}));iid=uid()
  # Build (endpoint, credentials, serialization, signing) before reserving the key: those failures send nothing.
  request,o,credentials=client.build(provider_id,operation_id,inputs,region=body.region)
  try:
   with store.engine.begin()as c:
    c.execute(insert(t).values(id=iid,tenant=p['tenant_id'],idempotency=idempotency_key,digest=digest,provider=provider_id,operation=operation_id,status='reserved',created_at=stamp()));store.log(c,p['tenant_id'],'vendor_test.reserved',iid,{'provider_id':provider_id,'operation_id':operation_id})
  except IntegrityError:
   with store.engine.connect()as c:r=c.execute(select(t).where(t.c.tenant==p['tenant_id'],t.c.idempotency==idempotency_key)).mappings().one()
   if r['digest']!=digest:raise WiringError('IDEMPOTENCY_CONFLICT','Vendor test key reused with changed operation/input',409)
   if r['status']in ['completed','upstream_error']:return {'invocation_id':r['id'],'idempotent_reuse':True,'result':store.dec(r['payload'])}
   raise WiringError('VENDOR_TEST_RECONCILIATION_REQUIRED','Invocation already reserved or failed. Reconcile the upstream result before using a new key.',409)
  native=None
  try:
   native=client.send(provider_id,operation_id,request,o,credentials)
   mapped=interpret(native,context,'artifact://vendor-tests/'+iid)
   if mapped['host']is not None:registry.validate('host',mapped['host'])
   result={'native':native,**mapped,'execution_profile':'user_testing_not_production_approval'}
   with store.engine.begin()as c:
    c.execute(update(t).where(t.c.id==iid).values(status='completed'if native['successful_http']else 'upstream_error',payload=store.enc(result)));store.log(c,p['tenant_id'],'vendor_test.completed',iid,{'http_status':native['http_status']})
   return {'invocation_id':iid,'idempotent_reuse':False,'result':result}
  except WiringError as e:
   with store.engine.begin()as c:c.execute(update(t).where(t.c.id==iid).values(status='reconciliation_required',payload=store.enc({'native':native,'host':None,'operation_receipt':None})if native else None,error=store.enc({'code':e.code,'message':e.message})))
   # The upstream call already happened; a mapping failure is a server-side fault, not a client input error.
   if native is not None:raise WiringError(e.code,e.message+'; upstream call completed, reconcile invocation '+iid,502)
   raise
  except Exception:
   with store.engine.begin()as c:c.execute(update(t).where(t.c.id==iid).values(status='reconciliation_required',payload=store.enc({'native':native,'host':None,'operation_receipt':None})if native else None,error=store.enc({'code':'VENDOR_TEST_INTERNAL_ERROR'})))
   raise WiringError('VENDOR_TEST_INTERNAL_ERROR','Invocation failed after reservation; reconcile before resubmitting',502)
 @app.get('/v1/vendor-invocations/{invocation_id}',tags=['Documented vendor testing'])
 def invocation(invocation_id:str,p=Depends(admin)):
  with store.engine.begin()as c:
   r=c.execute(select(t).where(t.c.id==invocation_id,t.c.tenant==p['tenant_id'])).mappings().first()
   if not r:raise WiringError('NOT_FOUND','Vendor invocation not found',404)
   store.log(c,p['tenant_id'],'vendor_test.artifact_accessed',invocation_id)
  return {'invocation_id':r['id'],'status':r['status'],'result':store.dec(r['payload']),'error':store.dec(r['error'])}
