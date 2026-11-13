"""Pinned vendor contracts, native serializers and signing. No runtime spec downloads.
No retries: a timed-out paid/create request may already have succeeded upstream.
"""
from pathlib import Path
from functools import lru_cache
from urllib.parse import quote,unquote,urlsplit
import os,json,re,time,hashlib,hmac,base64,copy,http.cookiejar
import httpx
from jsonschema import Draft202012Validator,RefResolver
from wiring.core import WiringError
from wiring.connectors import check_url,relative_path,RetryUpstream,no_cookies
ROOT=Path(__file__).resolve().parent
@lru_cache
def definitions():return {f.stem:json.loads(f.read_text())for f in (ROOT/'definitions').glob('*.json')}
@lru_cache
def spec_for(vendor):
 v=definitions()[vendor]
 if 'openapi_file'not in v:return None
 s=json.loads((ROOT/v['openapi_file']).read_text())
 def adapt(o):
  if isinstance(o,list):return [adapt(x)for x in o]
  if not isinstance(o,dict):return o
  o={k:adapt(x)for k,x in o.items()}
  if o.get('nullable')and isinstance(o.get('type'),str):o['type']=[o['type'],'null']
  # OpenAPI readOnly properties cannot be required on requests.
  if 'required'in o and isinstance(o.get('properties'),dict):o['required']=[k for k in o['required']if not o['properties'].get(k,{}).get('readOnly')]
  return o
 return adapt(s)
def deref(spec,obj):
 seen=set()
 while isinstance(obj,dict)and '$ref'in obj:
  ref=obj['$ref']
  if not ref.startswith('#/')or ref in seen:raise WiringError('CONTRACT_REF_INVALID','Only pinned local references supported')
  seen.add(ref);obj=spec
  for k in ref[2:].split('/'):obj=obj[k.replace('~1','/').replace('~0','~')]
 return obj
def field(obj,pointer):
 try:
  for p in pointer.strip('/').split('/'):obj=obj[int(p)]if isinstance(obj,list)else obj[p.replace('~1','/').replace('~0','~')]
  return obj
 except (KeyError,IndexError,TypeError,ValueError,AttributeError):return None
def prefix(vendor):return 'VENDOR_'+re.sub('[^A-Z0-9]','_',vendor.upper())+'_'
def credentials_from_env(vendor):
 v=definitions().get(vendor)
 if not v:raise WiringError('VENDOR_NOT_IMPLEMENTED','No documented client for this provider',409)
 result={k:os.getenv(prefix(vendor)+k,'')for k in v['auth']['keys']}
 if not v['auth'].get('optional')and any(not x for x in result.values()):raise WiringError('VENDOR_CREDENTIALS_MISSING','Set '+', '.join(prefix(vendor)+k for k,x in result.items()if not x),409)
 return result
def endpoint(vendor,region=None,override=None):
 v=definitions()[vendor];bases=v['bases'];selected=region or next(iter(bases),'customer')
 configured=os.getenv(prefix(vendor)+'BASE_URL','');base=override or configured or bases.get(selected)
 allowed=set(bases.values())
 if configured or override:
  # Customer-specific/contract-specific host is supplied by operator, never HTTP input.
  extra=os.getenv(prefix(vendor)+'APPROVED_BASE_URLS_JSON','[]')
  try:allowed.update(json.loads(extra))
  except Exception:raise WiringError('EGRESS_CONFIG_INVALID','Approved bases must be a JSON array')
 if not base:raise WiringError('VENDOR_ENDPOINT_REQUIRED','Set customer BASE_URL and APPROVED_BASE_URLS_JSON',409)
 check_url(base,allowed)
 return base,selected
def validate_schema(schema,value,spec):
 try:error=next(Draft202012Validator(schema,resolver=RefResolver.from_schema(spec)).iter_errors(value),None)
 except Exception:raise WiringError('NATIVE_CONTRACT_VALIDATION_FAILED','Pinned schema could not be resolved; no upstream request was sent',409)
 if error:raise WiringError('NATIVE_INPUT_INVALID','Native payload/schema mismatch at /'+'/'.join(map(str,error.absolute_path)))
def prepare(vendor,operation,inputs,credentials,base,region=None,clock=None):
 v=definitions().get(vendor)
 if not v:raise WiringError('VENDOR_NOT_IMPLEMENTED','Provider has no documented client',409)
 o=v['operations'].get(operation)
 if not o:raise WiringError('OPERATION_NOT_IMPLEMENTED','Operation not present in pinned vendor contract',404)
 if o.get('regions')and region not in o['regions']:raise WiringError('REGION_OPERATION_MISMATCH','Operation path differs by vendor region')
 path_values=inputs.get('path',{});query=copy.deepcopy(inputs.get('query',{}));body=copy.deepcopy(inputs.get('body'));extra=inputs.get('headers',{})
 if set(extra)-set(o['allowed_input_headers']):raise WiringError('NATIVE_HEADER_DENIED','Only documented per-call headers allowed')
 for name in o['allowed_input_headers']:
  if name not in extra:raise WiringError('NATIVE_INPUT_MISSING','Required per-call header: '+name)
 def replace(m):
  key=m[1]
  if key not in path_values:raise WiringError('NATIVE_INPUT_MISSING','Required path parameter: '+key)
  value=str(path_values[key]);decoded=unquote(value)
  if not value or decoded in ['.','..']or any(c in decoded for c in '/\\?#\r\n')or '%'in decoded:raise WiringError('PATH_DENIED','Unsafe native identifier')
  return quote(value,safe='')
 path=relative_path(re.sub(r'\{([^}]+)\}',replace,o['path']))
 expected=set(re.findall(r'\{([^}]+)\}',o['path']))
 if set(path_values)!=expected:raise WiringError('NATIVE_INPUT_INVALID','Unexpected path parameter')
 for name in o['required_query']:
  if name not in query:raise WiringError('NATIVE_INPUT_MISSING','Required query parameter: '+name)
 for name in o['required_body']:
  if not isinstance(body,dict)or name not in body:raise WiringError('NATIVE_INPUT_MISSING','Required body field: '+name)
 if o.get('body_required')and body is None:raise WiringError('NATIVE_INPUT_MISSING','Native request body required')
 if o['method']in ['GET','HEAD']and body is not None:raise WiringError('NATIVE_INPUT_INVALID','This retrieval operation does not accept a body')
 spec=spec_for(vendor)
 if spec:
  for p in o.get('parameters',[]):
   p=deref(spec,p);loc=p.get('in');name=p.get('name');values={'path':path_values,'query':query,'header':extra}.get(loc)
   if values is None:continue
   # Authentication and version headers are injected, never supplied by caller.
   if loc=='header'and name not in o['allowed_input_headers']:continue
   if p.get('required')and name not in values:raise WiringError('NATIVE_INPUT_MISSING','Required '+loc+' parameter: '+name)
   if name in values:
    schema=p.get('schema')or {k:p[k]for k in ['type','enum','items','minimum','maximum']if k in p}
    validate_schema(schema,values[name],spec)
    if loc=='query'and isinstance(query[name],list)and (p.get('explode')is False or p.get('collectionFormat')=='csv'):query[name]=','.join(str(x)for x in query[name])
  if o.get('body_schema')and (body is not None or inputs.get('files')):
   validated={**(body or {}),**{k:f.get('base64','')for k,f in inputs.get('files',{}).items()}}if o['content']=='multipart'else body
   validate_schema(o['body_schema'],validated,spec)
 headers={'Accept':'application/json','Accept-Encoding':'identity',**v.get('headers',{}),**extra};auth=v['auth'];kind=auth['type'];keys=auth['keys']
 if set(credentials)!=set(keys)or (not auth.get('optional')and any(not credentials[k]for k in keys)):raise WiringError('VENDOR_CREDENTIALS_MISSING','All documented credentials required',409)
 if kind in ['basic','shufti']:
  password=''if auth.get('empty_password')else credentials[keys[1]]
  headers['Authorization']='Basic '+base64.b64encode((credentials[keys[0]]+':'+password).encode()).decode()
 elif kind=='header':headers[auth['name']]=auth.get('prefix','')+credentials[keys[0]]
 elif kind=='optional_header':
  if credentials[keys[0]]:headers[auth['name']]=credentials[keys[0]]
 elif kind=='multi_header':headers.update({name:credentials[key]for name,key in auth['headers'].items()})
 elif kind=='query':query[auth['name']]=credentials[keys[0]]
 elif kind=='veriff':headers['X-AUTH-CLIENT']=credentials['API_KEY']
 elif kind=='sumsub':headers['X-App-Token']=credentials['APP_TOKEN']
 kwargs={'params':query,'headers':headers}
 if body is not None:
  if o['content']=='json':kwargs['content']=json.dumps(body,ensure_ascii=False,separators=(',',':')).encode();headers.setdefault('Content-Type','application/json')
  elif o['content']=='form':kwargs['data']={k:str(x).lower()if isinstance(x,bool)else x for k,x in body.items()}
  elif o['content']=='multipart':kwargs['data']={k:str(x)for k,x in body.items()if k not in inputs.get('files',{})}
 if o['content']=='multipart':
  files={}
  for name,f in inputs.get('files',{}).items():
   try:files[name]=(f['filename'],base64.b64decode(f['base64'],validate=True),f.get('content_type','application/octet-stream'))
   except Exception:raise WiringError('NATIVE_FILE_INVALID','Expected filename and valid base64')
  kwargs['files']=files
 elif inputs.get('files'):raise WiringError('NATIVE_INPUT_INVALID','This operation does not accept files')
 request=httpx.Request(o['method'],base.rstrip('/')+path,**kwargs);request.read()
 if kind=='sumsub':
  ts=str(int(time.time()if clock is None else clock));message=ts.encode()+o['method'].encode()+request.url.raw_path+request.content
  request.headers['X-App-Access-Ts']=ts;request.headers['X-App-Access-Sig']=hmac.new(credentials['SECRET_KEY'].encode(),message,hashlib.sha256).hexdigest()
 if kind=='veriff':
  # Veriff signs the payload for body requests and the session id only for body-less GET/DELETE.
  message=path_values.get('id');payload=request.content if request.content or message is None else str(message).encode()
  request.headers['X-HMAC-SIGNATURE']=hmac.new(credentials['SHARED_SECRET'].encode(),payload,hashlib.sha256).hexdigest()
 return request,o
class VendorClient:
 # Cookie jar refuses every cookie: one process-wide client must not replay vendor session cookies across tenants.
 def __init__(self,client=None):self.client=client or httpx.Client(timeout=httpx.Timeout(30,connect=5),follow_redirects=False,trust_env=False,cookies=no_cookies())
 def build(self,vendor,operation,inputs,*,credentials=None,base=None,region=None):
  """Everything that can fail before bytes leave the process. Nothing here needs reconciliation."""
  try:
   base,region=endpoint(vendor,region,override=base)
   credentials=credentials if credentials is not None else credentials_from_env(vendor)
   request,o=prepare(vendor,operation,inputs,credentials,base,region)
  except RetryUpstream:raise WiringError('VENDOR_DNS_FAILURE','Vendor host did not resolve; no request was sent',503)
  except (AttributeError,TypeError,ValueError):raise WiringError('NATIVE_INPUT_INVALID','Native input has the wrong shape for this operation; no request was sent')
  return request,o,credentials
 def invoke(self,vendor,operation,inputs,*,credentials=None,base=None,region=None):
  return self.send(vendor,operation,*self.build(vendor,operation,inputs,credentials=credentials,base=base,region=region))
 def send(self,vendor,operation,request,o,credentials):
  try:
   with self.client.stream(request.method,request.url,headers=request.headers,content=request.content)as response:
    raw=bytearray()
    for chunk in response.iter_bytes():
     raw.extend(chunk)
     if len(raw)>(100_000_000 if o['semantics']=='dataset'else 25_000_000):raise WiringError('VENDOR_RESPONSE_TOO_LARGE','Upstream response exceeded configured class limit (JSON 25 MB; datasets 100 MB); reconcile call',502)
    raw=bytes(raw);headers=response.headers;status=response.status_code
  except httpx.HTTPError:raise WiringError('VENDOR_TRANSPORT_AMBIGUOUS','Transport failed; no automatic retry. Reconcile paid/create calls before resubmission.',502)
  auth=definitions()[vendor]['auth'];kind=auth['type'];signature_verified=None
  if kind=='veriff':expected=hmac.new(credentials['SHARED_SECRET'].encode(),raw,hashlib.sha256).hexdigest();signature_verified=hmac.compare_digest(headers.get('X-HMAC-SIGNATURE','').lower(),expected)
  if kind=='shufti':expected=hashlib.sha256(raw+hashlib.sha256(credentials['SECRET_KEY'].encode()).hexdigest().encode()).hexdigest();signature_verified=hmac.compare_digest(headers.get('Signature','').lower(),expected)
  if signature_verified is False:raise WiringError('VENDOR_RESPONSE_SIGNATURE_INVALID','Unsigned or tampered vendor response rejected',502)
  # Never follow Location: a redirect must not receive credential headers.
  if 300<=status<400:raise WiringError('VENDOR_REDIRECT_DENIED','Pinned vendor endpoint redirected; review documentation/base configuration',502)
  parsed=None
  try:parsed=json.loads(raw)
  except (ValueError,UnicodeError):
   if o['response']=='xml':
    try:
     from defusedxml.ElementTree import fromstring
     root=fromstring(raw);parsed={'format':'xml','root_tag':root.tag,'record_elements':len(root)}
    except Exception:raise WiringError('VENDOR_RESPONSE_INVALID','Invalid or unsafe XML response',502)
   elif 200<=status<300 and not any(x in headers.get('content-type','')for x in ['pdf','image/','video/','octet-stream','zip'])and raw:raise WiringError('VENDOR_RESPONSE_INVALID','Expected documented JSON or binary response',502)
  return {'provider_id':vendor,'operation_id':operation,'http_status':status,'successful_http':200<=status<300,'signature_verified':signature_verified,'native_payload':parsed,'raw_bytes_base64':base64.b64encode(raw).decode(),'raw_sha256':hashlib.sha256(raw).hexdigest(),'native_status':field(parsed,o['status_pointer'])if o.get('status_pointer')else None,'resource_id':field(parsed,o['resource_pointer'])if o.get('resource_pointer')else None,'source':o['source'],'semantics':o['semantics'],'maturity':'implemented_unverified','externally_tested':False,'bank_decision':'not_evaluated'}
 def close(self):self.client.close()
