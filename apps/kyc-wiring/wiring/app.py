from contextlib import asynccontextmanager
import os,asyncio,json,time,hmac,hashlib,collections,threading
from pathlib import Path
from fastapi import FastAPI,Request,Depends,Header,Query
from fastapi.responses import JSONResponse,HTMLResponse,Response
from fastapi.openapi.utils import get_openapi
from pydantic import BaseModel,ConfigDict,Field
from sqlalchemy import select,insert
from sqlalchemy.exc import IntegrityError
from .core import Settings,Registry,WiringError,stamp,uid,pointer,sha,ATLAS,ROOT,read,now,instant
from .store import Store
from .worker import Worker
from .connectors import simulation

class CreateCheck(BaseModel):
 model_config=ConfigDict(extra='forbid')
 provider_id:str=Field(min_length=1,max_length=200)
 request:dict
class BatchCheck(BaseModel):
 model_config=ConfigDict(extra='forbid')
 items:list[CreateCheck]=Field(min_length=1,max_length=50)
class Subscription(BaseModel):
 model_config=ConfigDict(extra='forbid')
 destination_ref:str=Field(min_length=1,max_length=150)
class DemoRun(BaseModel):
 model_config=ConfigDict(extra='forbid')
 operation_id:str

def create_app(settings=None):
 settings=settings or Settings.env();registry=Registry(settings);store=Store(settings);worker=Worker(store,registry)
 @asynccontextmanager
 async def lifespan(app):
  stop=asyncio.Event()
  async def runner():
   while not stop.is_set():
    try:
     work=await asyncio.to_thread(worker.run_one);delivery=await asyncio.to_thread(worker.deliver_one)
    except Exception:work=False;delivery=False
    if not work and not delivery:
     try:await asyncio.wait_for(stop.wait(),timeout=.3)
     except asyncio.TimeoutError:pass
  task=asyncio.create_task(runner()) if settings.worker_enabled else None
  yield
  stop.set()
  if task:await task
  worker.connector.client.close();app.state.vendor_client.close();store.engine.dispose()
 app=FastAPI(title='KYC API Wiring',version='2.0.0',description='Runnable host wiring for all catalog bindings. Simulation ≠ external API completion. Unvalidated live routes are denied.',lifespan=lifespan,docs_url='/docs' if settings.demo or os.getenv('ENABLE_API_DOCS')=='1'else None,redoc_url=None)
 app.state.settings=settings;app.state.registry=registry;app.state.store=store;app.state.worker=worker
 limiter=collections.defaultdict(collections.deque);lock=threading.Lock()
 @app.exception_handler(WiringError)
 async def wiring_error(req,e):return JSONResponse({'code':e.code,'message':e.message},status_code=e.status)
 @app.middleware('http')
 async def bounds(request,call_next):
  if request.method in ['POST','PUT','PATCH']:
   try:
    if int(request.headers.get('content-length','0'))>2_000_000:return JSONResponse({'code':'BODY_TOO_LARGE'},status_code=413)
   except ValueError:return JSONResponse({'code':'BAD_CONTENT_LENGTH'},status_code=400)
   body=bytearray()
   async for chunk in request.stream():
    body.extend(chunk)
    if len(body)>2_000_000:return JSONResponse({'code':'BODY_TOO_LARGE'},status_code=413)
   request._body=bytes(body)
  response=await call_next(request)
  response.headers['X-Content-Type-Options']='nosniff';response.headers['Cache-Control']='no-store';response.headers['Referrer-Policy']='no-referrer'
  # No iframe embedding block: preview uses a sandboxed iframe.
  return response
 def auth(authorization:str=Header(default='')):
  if not authorization.startswith('Bearer '):raise WiringError('UNAUTHORIZED','Bearer API token required',401)
  token=authorization[7:];principal=settings.authenticate(token);key=sha(token)
  with lock:
   q=limiter[key];t=time.time()
   while q and q[0]<t-60:q.popleft()
   if len(q)>=240:raise WiringError('RATE_LIMIT','Request rate exceeded; retry later',429)
   q.append(t)
  return principal
 def admin(principal=Depends(auth)):
  if principal.get('role')!='admin':raise WiringError('ADMIN_REQUIRED','Admin role required',403)
  return principal
 def operator(principal=Depends(auth)):
  if principal.get('role') not in ['operator','admin']:raise WiringError('OPERATOR_REQUIRED','Operator role required',403)
  return principal
 def own(check_id,p):
  row=store.row(check_id,p['tenant_id'])
  if not row:raise WiringError('NOT_FOUND','Check not found',404)
  return row
 def summary(row):
  return {k:row[k] for k in ['id','provider','capability','status','attempts','version','error','created_at','updated_at']}
 def accept(body,p,key):
  request=body.request;registry.validate('request',request)
  if request['tenant_id']!=p['tenant_id']:raise WiringError('TENANT_MISMATCH','Body tenant must match authenticated tenant',403)
  if key is None or key!=request['idempotency_key']:raise WiringError('IDEMPOTENCY_REQUIRED','Idempotency-Key header must match request idempotency_key')
  ids=[e['entity_id'] for e in request['entities']]
  if len(ids)!=len(set(ids)) or request['subject_entity_id']not in ids:raise WiringError('SUBJECT_INVALID','Subject must exist exactly once in entity collection')
  deadline=request['routing'].get('deadline_at')
  if deadline and instant(deadline)<=now():raise WiringError('DEADLINE_EXPIRED','Request deadline has expired',409)
  registry.resolve(request,body.provider_id)
  row,reused=store.submit(p['tenant_id'],request,body.provider_id)
  return {'check':summary(row),'idempotent_reuse':reused,'execution_mode':'simulation' if settings.demo else 'live','links':{'self':'/v1/checks/'+row['id'],'results':'/v1/checks/'+row['id']+'/results'}}
 @app.get('/healthz',tags=['Operations'])
 def health():return {'status':'ok','mode':'simulation' if settings.demo else 'live','catalog_records':len(registry.providers),'bindings':len(registry.operations),'live_ready':sum(x['live_ready'] for x in registry.readiness()),'worker_in_process':settings.worker_enabled,'warning':'Never upload real customer data to the public demo'}
 @app.get('/',response_class=HTMLResponse,include_in_schema=False)
 def index():
  if not settings.demo:return '<h1>KYC API Wiring</h1><p>Live mode. Authenticated API only. Consult operator documentation.</p>'
  return (ROOT/'docs/dashboard.html').read_text()
 @app.get('/v1/capabilities',tags=['Registry'])
 def capabilities(p=Depends(auth)):return {'items':[{'capability':k,'result_family':v} for k,v in registry.caps.items()]}
 @app.get('/v1/providers',tags=['Registry'])
 def providers(q:str='',category:str='',limit:int=Query(50,ge=1,le=500),offset:int=Query(0,ge=0),p=Depends(auth)):
  found=[r for r in registry.providers.values() if (not category or r['category']==category) and (not q or q.lower() in (r['name']+' '+r['notes']).lower())]
  return {'total':len(found),'items':found[offset:offset+limit],'next_offset':offset+limit if offset+limit<len(found) else None}
 @app.get('/v1/providers/{provider_id}',tags=['Registry'])
 def provider(provider_id:str,p=Depends(auth)):
  if provider_id not in registry.providers:raise WiringError('UNKNOWN_PROVIDER','Provider not found',404)
  return {'provider':registry.providers[provider_id],'connections':[r for r in registry.readiness() if r['provider_id']==provider_id]}
 @app.get('/v1/connections',tags=['Readiness'])
 def connections(provider_id:str='',live_ready:bool|None=None,limit:int=Query(100,ge=1,le=1000),offset:int=Query(0,ge=0),p=Depends(auth)):
  all_rows=registry.readiness();rows=[r for r in all_rows if (not provider_id or r['provider_id']==provider_id) and (live_ready is None or r['live_ready']==live_ready)]
  return {'total':len(rows),'live_ready_total':sum(r['live_ready'] for r in all_rows),'items':rows[offset:offset+limit],'next_offset':offset+limit if offset+limit<len(rows) else None}
 @app.get('/v1/schemas/{name}',tags=['Contracts'])
 def schema(name:str,p=Depends(auth)):
  if name not in ['host','request','adapter','event']:raise WiringError('NOT_FOUND','Unknown schema',404)
  return read(ATLAS/f'schemas/{name}.schema.json')
 @app.post('/v1/checks',status_code=202,tags=['Checks'])
 async def submit(body:CreateCheck,raw:Request,idempotency_key:str=Header(...,min_length=1),x_source_authorization:str=Header(default=''),p=Depends(operator)):
  if not settings.demo:
   registry.validate('request',body.request)
   from .source_authorization import verify_source_authorization
   if 'source_authorization' in body.request.get('extensions',{}):raise WiringError('SOURCE_AUTHORIZATION_DENIED','Reserved source authorization extension',403)
   body.request.setdefault('extensions',{})['source_authorization']={'token':x_source_authorization,'request_body':(await raw.body()).decode()}
   verify_source_authorization(body.request,body.provider_id)
  return await asyncio.to_thread(accept,body,p,idempotency_key)
 @app.post('/v1/checks/batch',status_code=207,tags=['Checks'])
 def batch(body:BatchCheck,p=Depends(operator)):
  if not settings.demo:raise WiringError('SOURCE_AUTHORIZATION_DENIED','Live submissions require an individually authorized gateway request',403)
  outcomes=[]
  for index,item in enumerate(body.items):
   try:outcomes.append({'index':index,'status':202,'body':accept(item,p,item.request.get('idempotency_key'))})
   except WiringError as e:outcomes.append({'index':index,'status':e.status,'code':e.code,'message':e.message})
  return {'items':outcomes,'note':'Independent per-item transactions, not atomic batch; each item uses its own idempotency key'}
 @app.get('/v1/checks',tags=['Checks'])
 def checks(limit:int=Query(50,ge=1,le=100),offset:int=Query(0,ge=0),p=Depends(auth)):return {'items':[summary(r) for r in store.list_checks(p['tenant_id'],limit,offset)]}
 @app.get('/v1/checks/{check_id}',tags=['Checks'])
 def check(check_id:str,p=Depends(auth)):return summary(own(check_id,p))
 @app.get('/v1/checks/{check_id}/results',tags=['Checks'])
 def results(check_id:str,limit:int=Query(50,ge=1,le=100),offset:int=Query(0,ge=0),p=Depends(auth)):
  row=own(check_id,p)
  with store.engine.connect() as c:history=c.execute(select(store.results).where(store.results.c.tenant==p['tenant_id'],store.results.c.check_id==check_id).order_by(store.results.c.version.desc()).offset(offset).limit(limit+1)).mappings().all()
  return {'check_id':check_id,'status':row['status'],'items':[store.dec(r['payload']) for r in history[:limit]],'next_offset':offset+limit if len(history)>limit else None}
 @app.get('/v1/checks/{check_id}/artifact',tags=['Restricted evidence'])
 def artifact(check_id:str,result_id:str|None=None,p=Depends(admin)):
  row=own(check_id,p);encrypted=row['artifact']
  with store.engine.begin() as c:
   if result_id:
    historical=c.execute(select(store.results).where(store.results.c.tenant==p['tenant_id'],store.results.c.check_id==check_id,store.results.c.id==result_id)).mappings().first()
    if not historical:raise WiringError('NOT_FOUND','Historical evidence not found',404)
    encrypted=historical['artifact']
   store.log(c,p['tenant_id'],'restricted_artifact.read',check_id)
  return {'check_id':check_id,'classification':'restricted','artifact':store.dec(encrypted)}
 @app.post('/v1/checks/{check_id}/retry',status_code=202,tags=['Operations'])
 def retry(check_id:str,p=Depends(admin)):
  own(check_id,p);store.requeue(check_id,p['tenant_id']);return {'check_id':check_id,'status':'queued'}
 @app.get('/v1/events',tags=['Events'])
 def events(limit:int=Query(50,ge=1,le=100),offset:int=Query(0,ge=0),p=Depends(auth)):
  with store.engine.connect() as c:rows=c.execute(select(store.events).where(store.events.c.tenant==p['tenant_id']).order_by(store.events.c.created_at,store.events.c.id).offset(offset).limit(limit+1)).mappings().all()
  return {'items':[store.dec(r['body']) for r in rows[:limit]],'next_offset':offset+limit if len(rows)>limit else None}
 @app.post('/v1/event-subscriptions',status_code=201,tags=['Events'])
 def subscription(body:Subscription,p=Depends(admin)):
  d=settings.destinations.get(body.destination_ref)
  if not d or not d.get('approved') or p['tenant_id']not in d.get('tenant_ids',[]):raise WiringError('DESTINATION_DENIED','Use an operator-approved destination reference',403)
  sid=uid()
  try:
   with store.engine.begin() as c:c.execute(insert(store.subscriptions).values(id=sid,tenant=p['tenant_id'],destination=body.destination_ref,created_at=stamp()));store.log(c,p['tenant_id'],'subscription.created',detail={'destination_ref':body.destination_ref})
  except IntegrityError:
   with store.engine.connect() as c:sid=c.execute(select(store.subscriptions.c.id).where(store.subscriptions.c.tenant==p['tenant_id'],store.subscriptions.c.destination==body.destination_ref)).scalar_one()
  return {'subscription_id':sid,'destination_ref':body.destination_ref}
 @app.get('/v1/deliveries',tags=['Events'])
 def deliveries(p=Depends(auth)):
  with store.engine.connect() as c:rows=c.execute(select(store.deliveries).where(store.deliveries.c.tenant==p['tenant_id']).limit(100)).mappings().all()
  return {'items':[dict(r) for r in rows]}
 @app.get('/v1/audit',tags=['Operations'])
 def audit(p=Depends(admin)):return {'items':store.audit_rows(p['tenant_id'])}
 @app.post('/v1/webhooks/{check_id}',status_code=202,tags=['Vendor ingress'])
 async def webhook(check_id:str,request:Request):
  row=store.row(check_id)
  if not row:raise WiringError('NOT_FOUND','Unknown webhook resource',404)
  c=settings.contracts.get(row['provider']+':'+row['capability'],{});profile=c.get('webhook',{})
  if not profile.get('approved') or not profile.get('resource_id_pointer'):raise WiringError('WEBHOOK_NOT_CONFIGURED','No approved webhook verification profile',403)
  secret=os.getenv(profile.get('secret_env',''),'')
  if not secret:raise WiringError('WEBHOOK_SECRET_UNAVAILABLE','Webhook verification unavailable',503)
  raw=await request.body();received=request.headers.get(profile.get('signature_header','X-Wiring-Signature'),'')
  scheme=profile.get('scheme')
  if scheme=='timestamp_dot_body_hmac_sha256':
   timestamp=request.headers.get(profile.get('timestamp_header','X-Wiring-Timestamp'),'')
   try:
    if abs(time.time()-int(timestamp))>300:raise ValueError()
   except ValueError:raise WiringError('WEBHOOK_STALE','Invalid or stale signed timestamp',401)
   signed=timestamp.encode()+b'.'+raw
  elif scheme=='raw_body_hmac_sha256':signed=raw
  else:raise WiringError('WEBHOOK_SCHEME_UNSUPPORTED','Vendor-specific verifier required',403)
  expected=hmac.new(secret.encode(),signed,hashlib.sha256).hexdigest()
  if not hmac.compare_digest(expected,received):raise WiringError('WEBHOOK_SIGNATURE_INVALID','Webhook signature rejected',401)
  try:native=json.loads(raw)
  except ValueError:raise WiringError('WEBHOOK_INVALID_JSON','Invalid callback JSON')
  artifact=store.dec(row['artifact']) or {}
  if not artifact.get('provider_record_id') or str(pointer(native,profile['resource_id_pointer']))!=artifact['provider_record_id']:raise WiringError('WEBHOOK_RESOURCE_MISMATCH','Signed callback does not match registered provider resource',409)
  duplicate=store.accept_webhook(check_id,raw)
  return {'accepted':True,'duplicate':duplicate}
 if settings.demo:
  @app.post('/v1/demo/run',status_code=202,tags=['Simulation'])
  def demo_run(body:DemoRun,p=Depends(operator)):
   op=registry.operations.get(body.operation_id)
   if not op:raise WiringError('UNSUPPORTED_BINDING','Unknown catalog operation',404)
   aid=op.get('adapter_id');req=read(ATLAS/f'examples/requests/{aid}.json') if aid else read(ATLAS/'examples/requests/persona.json')
   request_id=uid();req.update(request_id=request_id,idempotency_key=request_id,tenant_id=p['tenant_id'],capability=op['capability']);req['routing']['provider_allowlist']=[op['provider_id']]
   return accept(CreateCheck(provider_id=op['provider_id'],request=req),p,request_id)
 def openapi():
  if app.openapi_schema:return app.openapi_schema
  schema=get_openapi(title=app.title,version=app.version,description=app.description,routes=app.routes)
  components=schema.setdefault('components',{});components.setdefault('securitySchemes',{})['BearerAuth']={'type':'http','scheme':'bearer'}
  for path,methods in schema['paths'].items():
   if path not in ['/healthz'] and not path.startswith('/v1/webhooks/'):
    for spec in methods.values():
     if isinstance(spec,dict):spec['security']=[{'BearerAuth':[]}]
  for name,title in [('request','CanonicalHostRequest'),('host','CanonicalHostResult')]:
   value=read(ATLAS/f'schemas/{name}.schema.json')
   def fix(x):
    if isinstance(x,dict):return {k:('#/components/schemas/'+title+'/$defs/'+v[8:] if k=='$ref' and isinstance(v,str) and v.startswith('#/$defs/') else fix(v)) for k,v in x.items() if k!='$id'}
    if isinstance(x,list):return [fix(y) for y in x]
    return x
   components.setdefault('schemas',{})[title]=fix(value)
  components['schemas']['CreateCheck']['properties']['request']={'$ref':'#/components/schemas/CanonicalHostRequest'}
  app.openapi_schema=schema;return schema
 from vendor_connections.api import install
 install(app,settings,store,registry,auth,admin)
 app.openapi=openapi
 return app
