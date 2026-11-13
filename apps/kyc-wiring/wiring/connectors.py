"""Real HTTP transport plus declarative mapping, and isolated synthetic execution.
No native URL or authentication mechanism is guessed for unverified providers.
"""
import os,json,copy,time,urllib.parse,ipaddress,socket,random,http.cookiejar
import httpx
from .core import ATLAS,read,template,pointer,stamp,sha,canonical,uid,WiringError
from vendor.atlas.normalizers import normalize,plan_request,validate_semantics
class RetryUpstream(Exception):
 def __init__(self,code,delay=1,ambiguous=False):self.code=code;self.delay=delay;self.ambiguous=ambiguous
class Progress(Exception):
 def __init__(self,artifact,mode='poll',delay=5):self.artifact=artifact;self.mode=mode;self.delay=delay

NATIVE_BASES={
 'persona':{'https://api.withpersona.com'},'companies_house':{'https://api.company-information.service.gov.uk'},'opencorporates':{'https://api.opencorporates.com'},'gleif':{'https://api.gleif.org'},'opensanctions':{'https://api.opensanctions.org'},'plaid':{'https://sandbox.plaid.com','https://production.plaid.com'}}

def no_cookies():return http.cookiejar.CookieJar(policy=http.cookiejar.DefaultCookiePolicy(allowed_domains=[]))

def check_url(base,approved):
 u=urllib.parse.urlsplit(base)
 if base not in approved or u.scheme!='https' or u.username or u.password or u.query or u.fragment or u.port not in [None,443] or not u.hostname:raise WiringError('EGRESS_DENIED','Only exact operator-approved HTTPS base URLs allowed')
 # Resolver check is defense-in-depth, not a replacement for egress firewall/proxy.
 try:
  addrs=socket.getaddrinfo(u.hostname,443,type=socket.SOCK_STREAM)
 except socket.gaierror:raise RetryUpstream('DNS_FAILURE')
 if any(not ipaddress.ip_address(a[4][0]).is_global for a in addrs):raise WiringError('EGRESS_DENIED','Private or non-global destinations prohibited')
 return base.rstrip('/')

def relative_path(path):
 if not isinstance(path,str) or not path.startswith('/') or path.startswith('//') or '?'in path or '#'in path or '\\'in path or any(urllib.parse.unquote(p) in ['.','..'] for p in path.split('/')):raise WiringError('PATH_DENIED','Native paths must be safe relative paths without query strings')
 return path

def context(row,request,provider):
 return {'check_id':row['id'],'tenant_id':row['tenant'],'request_id':request['request_id'],'subject_entity_id':request['subject_entity_id'],'provider_id':provider,'result_id':uid(),'received_at':stamp(),'idempotency_key':request['idempotency_key']}

def simulation(row,request,op):
 aid=op.get('adapter_id');raw=None
 if aid:
  raw=read(ATLAS/f'examples/native/{aid}.json')
  host=normalize(aid,raw,request_id=request['request_id'],tenant_id=row['tenant'],subject_entity_id=request['subject_entity_id'],received_at=stamp(),raw_vault_ref='artifact://checks/'+row['id'])
 else:
  raw={'synthetic':True,'provider_id':row['provider'],'capability':request['capability'],'note':'HOST CONTRACT SIMULATION: not a vendor wire payload'}
  host=copy.deepcopy(read(ATLAS/f"examples/capabilities/{request['capability']}.json"))
  host.update(result_id=uid(),request_id=request['request_id'],tenant_id=row['tenant'],subject_entity_id=request['subject_entity_id'],entities=request['entities'],relationships=[],assertions=[],evidence=[])
  host['provider'].update(provider_id=row['provider'],adapter_version='simulation-1',status_original=None,decision_origin='unknown');host['assessment'].update(outcome='not_checked',bank_decision='not_evaluated');host['execution'].update(status='completed',received_at=stamp());host['result']['kind']=op['result_family']
  if op['result_family']=='business':host['result']['organization_entity_id']=request['subject_entity_id']
  if op['result_family']=='ownership':host['result']['root_entity_id']=request['subject_entity_id']
  host['raw_payload']={'vault_ref':'artifact://checks/'+row['id'],'sha256':sha(canonical(raw)),'classification':'restricted'}
 host['result_id']=uid()  # A result belongs to a host operation, not an assumed-unique client trace ID.
 host['warnings']+=['DEMO_ONLY_NO_VENDOR_CALL','No vendor entitlement, coverage, identity match or compliance decision established']
 host['extensions']['execution_mode']='simulation';host['extensions']['wiring_check_id']=row['id'];host['assessment']['bank_decision']='not_evaluated'
 return host,{'synthetic':True,'native_payload':raw,'digest_representation':'canonical JSON','sha256':sha(canonical(raw))}

class HTTPConnector:
 def __init__(self,settings,client=None):
  self.settings=settings;self.client=client or httpx.Client(timeout=httpx.Timeout(20,connect=5),follow_redirects=False,trust_env=False,cookies=no_cookies())
 def execute(self,row,request,op,c,artifact=None):
  artifact={} if artifact is None else artifact;ctx=context(row,request,row['provider']);aid=op.get('adapter_id');webhook=artifact.get('webhook_payload')
  if webhook is not None:return self.map(row,request,op,c,webhook,artifact)
  base=check_url(c['base_url'],c['approved_base_urls']);headers={'Accept':'application/json','Content-Type':'application/json'};body=None;params={};method=c.get('method','GET');path=c.get('path','/')
  if c['connector']=='native_subset':
   if base not in NATIVE_BASES.get(aid,set()):raise WiringError('EGRESS_DENIED','Base URL not in documented native connector allowlist')
   plan=plan_request(aid,request);method=plan['method'];path=plan['path'];body=plan['body'];headers.update(plan.get('headers',{}))
   if aid=='persona':headers['Authorization']='Bearer '+self.secret(c,'api_key_env')
   elif aid=='companies_house':
    import base64
    headers['Authorization']='Basic '+base64.b64encode((self.secret(c,'api_key_env')+':').encode()).decode()
   elif aid=='opencorporates':params['api_token']=self.secret(c,'api_key_env')
   elif aid=='opensanctions':headers['Authorization']='ApiKey '+self.secret(c,'api_key_env')
   elif aid=='plaid':
    token_ref=request['input'].get('account_token_ref');envname=c.get('account_token_refs',{}).get(token_ref)
    if not envname or not os.getenv(envname):raise WiringError('TOKEN_REFERENCE_DENIED','No tenant-approved account token mapping')
    body['access_token']=os.environ[envname];body['client_id']=self.secret(c,'client_id_env');body['secret']=self.secret(c,'client_secret_env')
  else:
   if method not in ['GET','POST','PUT','PATCH','DELETE']:raise WiringError('METHOD_DENIED','Unsupported method')
   if c.get('request_template') is not None:body=template(c['request_template'],request=request,context=ctx)
   for k,v in c.get('header_secret_env',{}).items():
    if not os.getenv(v):raise WiringError('SECRET_UNAVAILABLE','Required upstream secret unavailable',503)
    headers[k]=c.get('header_prefix',{}).get(k,'')+os.environ[v]
   if c.get('path_segments'):
    segments=template(c['path_segments'],request=request,context=ctx);path='/'+'/'.join(urllib.parse.quote(str(x),safe='') for x in segments)
  if artifact.get('provider_record_id') and c.get('async_mode')=='poll':
   if artifact.get('poll_count',0)>=c.get('max_polls',24):raise WiringError('POLL_LIMIT','Polling bound exceeded; reconcile externally')
   ctx['provider_record_id']=artifact['provider_record_id'];parts=template(c['poll_path_segments'],request=request,context=ctx);path='/'+'/'.join(urllib.parse.quote(str(x),safe='') for x in parts);method='GET';body=None
  path=relative_path(path)
  if c.get('idempotency_header'):headers[c['idempotency_header']]=request['idempotency_key']
  response=self.send(method,base+path,headers,body,params,idempotent=method=='GET' or bool(c.get('upstream_idempotency_validated') and c.get('idempotency_header')))
  raw=response.content
  if len(raw)>2_000_000:raise WiringError('UPSTREAM_TOO_LARGE','Response exceeds payload size limit')
  try:native=response.json()
  except ValueError:raise WiringError('UPSTREAM_INVALID_JSON','Upstream returned non-JSON response')
  artifact.update(native_payload=native,raw_http_hex=raw.hex(),sha256=sha(raw),digest_representation='original HTTP response bytes',http_status=response.status_code)
  mode=c.get('async_mode','sync')
  if mode in ['poll','webhook']:
   if not artifact.get('provider_record_id'):artifact['provider_record_id']=str(pointer(native,c['submission_resource_pointer']))
   if mode=='webhook':raise Progress(artifact,'webhook')
   if pointer(native,c['completion_pointer'])!=c['completion_value']:
    artifact['poll_count']=artifact.get('poll_count',0)+1;raise Progress(artifact,'poll',min(30,max(1,c.get('poll_seconds',5))))
  return self.map(row,request,op,c,native,artifact)
 def secret(self,c,key):
  name=c.get(key)
  if not name or not os.getenv(name):raise WiringError('SECRET_UNAVAILABLE','Required upstream secret unavailable',503)
  return os.environ[name]
 def send(self,method,url,headers,body,params,idempotent):
  try:
   # Stream with a hard cap before decoding; do not load unlimited provider bodies.
   with self.client.stream(method,url,headers=headers,json=body,params=params) as r:
    if 300<=r.status_code<400:raise WiringError('UPSTREAM_REDIRECT_DENIED','Upstream redirects require operator review')
    if r.status_code==429 or r.status_code>=500:
     retry=r.headers.get('Retry-After','1')
     try:delay=min(120,max(1,float(retry)))+random.random()
     except ValueError:delay=2
     raise RetryUpstream('UPSTREAM_'+str(r.status_code),delay,ambiguous=not idempotent and r.status_code>=500)
    if r.status_code in [401,403]:raise WiringError('UPSTREAM_AUTH_DENIED','Provider rejected credentials or entitlement',502)
    if r.status_code>=400:raise WiringError('UPSTREAM_REQUEST_REJECTED','Provider rejected request; inspect restricted upstream artifact',502)
    data=bytearray()
    for chunk in r.iter_bytes():
     data.extend(chunk)
     if len(data)>2_000_000:raise WiringError('UPSTREAM_TOO_LARGE','Response exceeds size limit')
    return httpx.Response(r.status_code,headers=r.headers,content=bytes(data))
  except (httpx.TimeoutException,httpx.NetworkError):raise RetryUpstream('UPSTREAM_TIMEOUT_OR_NETWORK',2,ambiguous=not idempotent)
 def map(self,row,request,op,c,native,artifact):
  ctx=context(row,request,row['provider'])
  if c['connector']=='native_subset':result=normalize(op['adapter_id'],native,request_id=request['request_id'],tenant_id=row['tenant'],subject_entity_id=request['subject_entity_id'],received_at=stamp(),raw_vault_ref='artifact://checks/'+row['id'])
  else:result=template(c['response_template'],native=native,request=request,context=ctx)
  # Always restore isolation/correlation fields from trusted host context.
  for key in ['tenant_id','request_id','subject_entity_id','result_id']:result[key]=ctx[key]
  result['capability']=request['capability'];result['provider']['provider_id']=row['provider'];result['provider']['product']=c['product'];result['provider']['api_version']=c['api_version'];result['provider']['adapter_version']=c['mapping_version']
  result['assessment']['bank_decision']='not_evaluated';result['extensions']['execution_mode']='live';result['extensions']['wiring_check_id']=row['id']
  result['raw_payload']={'vault_ref':'artifact://checks/'+row['id'],'sha256':artifact.get('sha256',sha(canonical(native))),'classification':'restricted'}
  evidence_mapping=c.get('source_evidence_mapping')
  if evidence_mapping:
   try:
    dataset_ids=pointer(native,evidence_mapping['dataset_ids_pointer']);observed_at=pointer(native,evidence_mapping['observed_at_pointer'])
    complete=pointer(native,evidence_mapping['complete_pointer']) is True
    if not isinstance(dataset_ids,list) or not all(isinstance(item,str) and item for item in dataset_ids):raise ValueError('dataset scope')
    from .core import instant
    instant(observed_at)
    fields=[]
    for field,path in evidence_mapping['field_pointers'].items():
     try:value=pointer(native,path)
     except (KeyError,IndexError):value=None
     if value is not None:fields.append(field)
    role=evidence_mapping['role']
    if role not in ['primary','corroborating','supplemental','processing']:raise ValueError('role')
    result['extensions']['source_evidence']={'datasetIds':sorted(set(dataset_ids)),'fields':sorted(set(fields)),'observedAt':observed_at,'complete':complete,'role':role}
   except Exception:raise WiringError('SOURCE_EVIDENCE_MAPPING_INVALID','Approved source evidence mapping could not establish the response scope')
  return result,artifact
