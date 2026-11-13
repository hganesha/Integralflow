"""Configuration, strict JSON templates, schema validation and catalog registry."""
import os,json,hashlib,uuid,datetime,secrets
from pathlib import Path
from dataclasses import dataclass,field
from cryptography.fernet import Fernet
from jsonschema import Draft202012Validator,FormatChecker
ROOT=Path(__file__).resolve().parents[1]
ATLAS=ROOT/'vendor/atlas'
def now():return datetime.datetime.now(datetime.timezone.utc)
def stamp():return now().isoformat().replace('+00:00','Z')
def uid():return str(uuid.uuid4())
def canonical(x):return json.dumps(x,sort_keys=True,separators=(',',':'),ensure_ascii=False)
def sha(x):return hashlib.sha256((x if isinstance(x,bytes) else x.encode())).hexdigest()
def read(p):return json.loads(Path(p).read_text())
class WiringError(Exception):
 def __init__(self,code,message,status=422):self.code=code;self.message=message;self.status=status
def instant(value):
 # RFC 3339 requires an offset; naive or malformed values must be a 422, never a 500 from comparing with aware time.
 try:t=datetime.datetime.fromisoformat(value.replace('Z','+00:00'))
 except (AttributeError,ValueError):t=None
 if t is None or t.tzinfo is None:raise WiringError('SCHEMA_INVALID','Timestamp must be RFC 3339 with a UTC offset')
 return t
@dataclass
class Settings:
 demo:bool=True
 database_url:str=''
 encryption_key:str=''
 api_keys:dict=field(default_factory=dict)
 contracts:dict=field(default_factory=dict)
 destinations:dict=field(default_factory=dict)
 worker_enabled:bool=True
 max_attempts:int=3
 lease_seconds:int=90
 @classmethod
 def env(cls):
  demo=os.getenv('WIRING_MODE','demo')=='demo'
  key=os.getenv('ENCRYPTION_KEY','')
  keys=json.loads(os.getenv('API_KEYS_JSON','{}'))
  if demo:
   location=ROOT/'.local';location.mkdir(exist_ok=True)
   keyfile=location/'demo-encryption-key'
   if not key:
    if not keyfile.exists():keyfile.write_bytes(Fernet.generate_key());keyfile.chmod(0o600)
    key=keyfile.read_text().strip()
   if not keys:keys={'demo-token-local-only':{'tenant_id':'demo-tenant','role':'admin'}}
  if not key or not keys:raise RuntimeError('Live mode requires ENCRYPTION_KEY and API_KEYS_JSON')
  Fernet(key.encode())
  return cls(demo=demo,database_url=os.getenv('DATABASE_URL','sqlite:///'+str(ROOT/'.local/wiring.db')),encryption_key=key,api_keys=keys,contracts=read(os.getenv('CONTRACTS_PATH',str(ROOT/'config/contracts.json'))),destinations=read(os.getenv('DESTINATIONS_PATH',str(ROOT/'config/destinations.json'))),worker_enabled=os.getenv('WORKER_ENABLED','1')=='1')
 def authenticate(self,token):
  # Compare all configured keys in constant time; never log tokens.
  for k,v in self.api_keys.items():
   if secrets.compare_digest(k,token):return v
  raise WiringError('UNAUTHORIZED','Valid API token required',401)
class Registry:
 def __init__(self,settings):
  self.settings=settings;self.providers={p['provider_id']:p for p in read(ATLAS/'catalog/providers.json')};self.operations={o['operation_id']:o for o in read(ATLAS/'catalog/provider-capabilities.json')};self.caps={x['capability']:x['result_family'] for x in read(ATLAS/'catalog/capabilities.json')}
  self.validators={k:Draft202012Validator(read(ATLAS/f'schemas/{k}.schema.json'),format_checker=FormatChecker()) for k in ['host','request','event']}
 def validate(self,kind,payload):
  error=next(self.validators[kind].iter_errors(payload),None)
  if error:raise WiringError('SCHEMA_INVALID',f'{kind} schema mismatch at /'+ '/'.join(map(str,error.absolute_path)))
 def resolve(self,request,provider_id):
  if provider_id not in self.providers:raise WiringError('UNKNOWN_PROVIDER','Provider is not in registry',404)
  opid=provider_id+':'+request['capability'];op=self.operations.get(opid)
  if not op:raise WiringError('UNSUPPORTED_BINDING','Provider/capability binding is not cataloged')
  if self.providers[provider_id]['routing_eligibility'].startswith('quarantined'):raise WiringError('QUARANTINED','Historical reference is quarantined; connection prohibited',409)
  allow=request['routing']['provider_allowlist']
  if provider_id not in allow:raise WiringError('ROUTING_DENIED','Provider must be explicitly allowed by this request',403)
  if self.settings.demo:return op,None
  c=self.settings.contracts.get(opid)
  blockers=self.blockers(op,c,request)
  if blockers:raise WiringError('CONNECTION_NOT_READY','; '.join(blockers),409)
  from .source_authorization import verify_source_authorization
  verify_source_authorization(request,provider_id,c)
  return op,c
 def blockers(self,op,c,request=None):
  p=self.providers[op['provider_id']]
  if p['routing_eligibility'].startswith('quarantined'):return ['quarantined_reference']
  if not c:return ['approved_native_contract_missing','vendor_credentials_missing','entitlements_unvalidated','country_and_residency_scope_missing','vendor_sandbox_acceptance_missing']
  b=[]
  if c.get('enabled') is not True:b.append('connection_disabled')
  if c.get('approved') is not True:b.append('operator_approval_missing')
  if c.get('maturity') not in ['sandbox_tested','production_validated']:b.append('vendor_sandbox_acceptance_missing')
  if not c.get('entitlement_ref'):b.append('entitlement_missing')
  if not c.get('policy_refs'):b.append('purpose_and_legal_basis_policy_missing')
  if not c.get('countries') or not c.get('residency_regions'):b.append('country_and_residency_scope_missing')
  if not c.get('upstream_datasets'):b.append('dataset_scope_missing')
  if not c.get('api_version'):b.append('api_version_not_pinned')
  if not c.get('product'):b.append('product_not_pinned')
  if c.get('connector') not in ['native_subset','declarative']:b.append('connector_not_implemented')
  if not c.get('base_url') or c.get('base_url') not in c.get('approved_base_urls',[]):b.append('approved_endpoint_missing')
  if not c.get('mapping_version'):b.append('mapping_version_missing')
  if c.get('connector')=='declarative':
   if not c.get('response_template'):b.append('native_response_mapping_missing')
   if c.get('method') not in ['GET','POST','PUT','PATCH','DELETE']:b.append('native_method_missing')
   if not c.get('path') and not c.get('path_segments'):b.append('native_path_missing')
  if c.get('async_mode','sync') not in ['sync','poll','webhook']:b.append('async_mode_unsupported')
  if c.get('async_mode')=='poll' and not all(k in c for k in ['submission_resource_pointer','completion_pointer','completion_value','poll_path_segments']):b.append('poll_contract_incomplete')
  if c.get('async_mode')=='webhook' and (not c.get('submission_resource_pointer') or c.get('webhook',{}).get('approved') is not True):b.append('webhook_contract_incomplete')
  if c.get('connector')=='native_subset' and op.get('adapter_id') not in ['persona','companies_house','opencorporates','gleif','opensanctions','plaid']:b.append('native_subset_client_unavailable')
  for var in c.get('required_secret_env',[]):
   if not os.getenv(var):b.append('secret_unavailable:'+var)
  if request:
   if request['tenant_id'] not in c.get('tenant_ids',[]):b.append('tenant_not_entitled_to_connection')
   if request['purpose'] not in c.get('purposes',[]) or request['legal_basis'] not in c.get('legal_bases',[]):b.append('purpose_or_legal_basis_not_approved')
   policy=request['policy'];rkey=policy['policy_id']+':'+policy['policy_version']
   if rkey not in c.get('policy_refs',[]):b.append('request_policy_not_approved')
   if not set(policy.get('jurisdictions',[])) or not set(policy['jurisdictions'])<=set(c.get('countries',[])):b.append('jurisdiction_not_entitled')
   if not set(policy.get('data_residency_allowlist',[])) or not set(c.get('processing_regions',[])) or not set(c.get('processing_regions',[]))<=set(policy['data_residency_allowlist']):b.append('processing_region_not_permitted')
   if not set(c.get('processing_regions',[]))<=set(c.get('residency_regions',[])):b.append('contract_processing_regions_invalid')
   if not set(request['routing'].get('required_datasets',[]))<=set(c.get('upstream_datasets',[])):b.append('required_dataset_not_entitled')
   if c.get('requires_consent') and not request.get('consent_ref'):b.append('consent_reference_required')
   deadline=request['routing'].get('deadline_at')
   if deadline and instant(deadline)<=now():b.append('request_deadline_expired')
  return b
 def readiness(self):
  result=[]
  for key,op in self.operations.items():
   c=self.settings.contracts.get(key);b=self.blockers(op,c)
   result.append({'operation_id':key,'provider_id':op['provider_id'],'provider_name':self.providers[op['provider_id']]['name'],'capability':op['capability'],'host_result_family':op['result_family'],'demo_supported':not self.providers[op['provider_id']]['routing_eligibility'].startswith('quarantined'),'fixture_normalizer':op['adapter_id'],'live_ready':not b,'blockers':b,'upstream_contract_digest':sha(canonical(c)) if c else None})
  return result

def pointer(value,path):
 if path=='':return value
 if not path.startswith('/'):raise WiringError('BAD_TEMPLATE','JSON pointer must start with /')
 for part in path[1:].split('/'):
  part=part.replace('~1','/').replace('~0','~')
  try:value=value[int(part)] if isinstance(value,list) else value[part]
  except (KeyError,IndexError,TypeError,ValueError):raise WiringError('NATIVE_MAPPING_MISSING','Required mapping source not present')
 return value

def template(node,*,native=None,request=None,context=None,item=None):
 """No eval, code loading or native/network URL interpolation. Strict missing fields.
 {"$native":"/pointer"}, {"$request":"/pointer"}, {"$context":"/pointer"},
 {"$item":"/pointer"}, {"$each":"/native/array","template":{...}},
 {"$enum":{"path":"/status","values":{"ok":"passed"},"unknown":"unknown"}}
 """
 args=dict(native=native,request=request,context=context,item=item)
 if isinstance(node,list):return [template(n,**args) for n in node]
 if not isinstance(node,dict):return node
 for key,val in [('$native',native),('$request',request),('$context',context),('$item',item)]:
  if key in node:
   if len(node)!=1:raise WiringError('BAD_TEMPLATE','Reference templates have exactly one key')
   return pointer(val,node[key])
 if '$each'in node:
  values=pointer(native,node['$each'])
  if not isinstance(values,list):raise WiringError('BAD_TEMPLATE','Expected an array')
  return [template(node['template'],native=native,request=request,context=context,item=x) for x in values]
 if '$enum'in node:
  e=node['$enum'];value=pointer(native,e['path']);return e['values'].get(str(value),e.get('unknown','unknown'))
 return {k:template(v,**args) for k,v in node.items()}
