import json,base64,hmac,hashlib,re,copy
from pathlib import Path
import pytest,httpx
from fastapi.testclient import TestClient
from cryptography.fernet import Fernet
from vendor_connections import client as vc
from vendor_connections.normalization import normalize
from wiring.core import Settings,Registry,WiringError
from wiring.app import create_app
CONTRACTS=vc.definitions()
@pytest.fixture(autouse=True)
def offline_dns_and_customer_host(monkeypatch):
 import socket
 monkeypatch.setattr(socket,'getaddrinfo',lambda *args,**kwargs:[(socket.AF_INET,socket.SOCK_STREAM,6,'',('1.1.1.1',443))])
 for vendor in CONTRACTS:
  if not CONTRACTS[vendor]['bases']:monkeypatch.setenv(vc.prefix(vendor)+'APPROVED_BASE_URLS_JSON','["https://customer.example.com"]')
ALL=[(v,o)for v,d in CONTRACTS.items()for o in d['operations']]
def inputs_for(vendor,operation):
 d=CONTRACTS[vendor];o=d['operations'][operation];p={k:'test-identifier'for k in re.findall(r'\{([^}]+)\}',o['path'])};q={k:'test-value'for k in o['required_query']};body=copy.deepcopy(o['body_example'])
 if o['required_body']and body is None:body={k:'test-value'for k in o['required_body']}
 if o.get('body_required')and body is None:body={}
 if d.get('openapi_file'):
  spec=vc.spec_for(vendor)
  for param in o.get('parameters',[]):
   param=vc.deref(spec,param)
   if param.get('required')and param.get('in')=='query':q[param['name']]='test-value'
 return {'path':p,'query':q,'body':body,'headers':{k:'test-consent'for k in o['allowed_input_headers']}}
@pytest.mark.parametrize('vendor,operation',ALL)
def test_every_documented_operation_serializes_and_uses_transport(vendor,operation,monkeypatch):
 # This breadth test isolates transport/serialization, not validity of synthetic
 # native field values. Schema enforcement is independently exercised below.
 monkeypatch.setattr(vc,'validate_schema',lambda *args:None)
 d=CONTRACTS[vendor];o=d['operations'][operation];credentials={k:'test-secret'for k in d['auth']['keys']};base=next(iter(d['bases'].values()),'https://customer.example.com');region=o.get('regions',[next(iter(d['bases']),'customer')])[0];seen=[]
 def upstream(request):
  seen.append(request);raw=b'<records><record/></records>'if o['response']=='xml'else b'{}';headers={'content-type':'application/xml'if o['response']=='xml'else 'application/json'}
  if d['auth']['type']=='veriff':headers['X-HMAC-SIGNATURE']=hmac.new(credentials['SHARED_SECRET'].encode(),raw,hashlib.sha256).hexdigest()
  if d['auth']['type']=='shufti':headers['Signature']=hashlib.sha256(raw+hashlib.sha256(credentials['SECRET_KEY'].encode()).hexdigest().encode()).hexdigest()
  return httpx.Response(200,content=raw,headers=headers)
 c=vc.VendorClient(httpx.Client(transport=httpx.MockTransport(upstream)));r=c.invoke(vendor,operation,inputs_for(vendor,operation),credentials=credentials,base=base,region=region);c.close()
 assert len(seen)==1 and seen[0].method==o['method']and str(seen[0].url).startswith(base)
 assert r['bank_decision']=='not_evaluated'and not r['externally_tested']and r['successful_http']
 assert r['raw_sha256']==hashlib.sha256(base64.b64decode(r['raw_bytes_base64'])).hexdigest()
 assert not any(s in json.dumps({k:x for k,x in r.items()if k!='native_payload'})for s in credentials.values())

def test_sumsub_signature_covers_exact_query_and_utf8_body():
 creds={'APP_TOKEN':'token','SECRET_KEY':'secret'};inputs={'path':{},'query':{'levelName':'basic KYC'},'body':{'externalUserId':'user-ü'}}
 r,_=vc.prepare('sumsub','create_applicant',inputs,creds,'https://api.sumsub.com',clock=123)
 expected=hmac.new(b'secret',b'123POST'+r.url.raw_path+r.content,hashlib.sha256).hexdigest()
 assert r.headers['X-App-Access-Sig']==expected and r.headers['X-App-Access-Ts']=='123'
 assert r.url.raw_path.endswith(b'levelName=basic+KYC')

def test_veriff_signs_id_for_retrieval_and_raw_body_for_create():
 c={'API_KEY':'key','SHARED_SECRET':'secret'}
 r,_=vc.prepare('veriff','get_decision',{'path':{'id':'session-1'}},c,'https://customer.example.com')
 assert r.headers['X-HMAC-SIGNATURE']==hmac.new(b'secret',b'session-1',hashlib.sha256).hexdigest()
 r,_=vc.prepare('veriff','create_session',{'body':{'verification':{'vendorData':'client1'}}},c,'https://customer.example.com')
 assert r.headers['X-HMAC-SIGNATURE']==hmac.new(b'secret',r.content,hashlib.sha256).hexdigest()

@pytest.mark.parametrize('vendor,op,credentials,body',[('veriff','get_decision',{'API_KEY':'key','SHARED_SECRET':'s'},None),('shufti','get_status',{'CLIENT_ID':'c','SECRET_KEY':'s'},{'reference':'r'})])
def test_bad_response_signature_is_rejected(vendor,op,credentials,body):
 c=vc.VendorClient(httpx.Client(transport=httpx.MockTransport(lambda r:httpx.Response(200,json={},headers={'Signature':'wrong','X-HMAC-SIGNATURE':'wrong'}))))
 with pytest.raises(WiringError)as e:c.invoke(vendor,op,{'path':{'id':'r'}if vendor=='veriff'else {},'body':body},credentials=credentials,base='https://customer.example.com'if vendor=='veriff'else 'https://api.shuftipro.com')
 assert e.value.code=='VENDOR_RESPONSE_SIGNATURE_INVALID';c.close()

@pytest.mark.parametrize('value',['..','a/b','%2e%2e','%2f','//example.com','%252f','\\host','a?b'])
def test_native_path_escape_denied(value):
 with pytest.raises(WiringError)as e:vc.prepare('persona','get_inquiry',{'path':{'id':value}},{'API_KEY':'s'},'https://api.withpersona.com')
 assert e.value.code=='PATH_DENIED'

def test_header_override_denied():
 with pytest.raises(WiringError)as e:vc.prepare('persona','get_inquiry',{'path':{'id':'id'},'headers':{'Authorization':'stolen'}},{'API_KEY':'s'},'https://api.withpersona.com')
 assert e.value.code=='NATIVE_HEADER_DENIED'

def test_openapi_required_body_and_parameters_enforced():
 d=CONTRACTS['plaid'];name=next(k for k,v in d['operations'].items()if v['path']=='/identity/get')
 with pytest.raises(WiringError)as e:vc.prepare('plaid',name,{'body':{}},{'CLIENT_ID':'c','SECRET':'s'},'https://sandbox.plaid.com')
 assert e.value.code=='NATIVE_INPUT_INVALID'
 d=CONTRACTS['opensanctions'];name=next(k for k,v in d['operations'].items()if v['path']=='/match/{dataset}')
 request,_=vc.prepare('opensanctions',name,{'path':{'dataset':'default'},'body':{'queries':{'q':{'schema':'Person','properties':{'name':['Test Name']}}}}},{'API_KEY':'s'},'https://api.opensanctions.org')
 assert request.headers['Authorization']=='ApiKey s'

def test_basic_header_and_form_serialization():
 r,_=vc.prepare('telesign','phone_score',{'path':{'phone':'15555551212'},'body':{'account_lifecycle_event':'create'}},{'CUSTOMER_ID':'c','API_KEY':'s'},'https://rest-api.telesign.com',region='standard')
 assert r.headers['Authorization']=='Basic '+base64.b64encode(b'c:s').decode()and b'account_lifecycle_event=create'in r.content
 r,_=vc.prepare('complycube','get_check',{'path':{'id':'check'}},{'API_KEY':'s'},'https://api.complycube.com/v1')
 assert r.headers['Authorization']=='s'

def test_redirect_and_ambiguous_transport_never_retried():
 count=[]
 def redirect(r):count.append(r);return httpx.Response(302,headers={'Location':'https://attacker.example.com'})
 c=vc.VendorClient(httpx.Client(transport=httpx.MockTransport(redirect)))
 with pytest.raises(WiringError)as e:c.invoke('persona','get_inquiry',{'path':{'id':'id'}},credentials={'API_KEY':'s'},base='https://api.withpersona.com')
 assert e.value.code=='VENDOR_REDIRECT_DENIED'and len(count)==1;c.close()

def test_common_host_session_not_approval_and_no_fixture_facts(tmp_path):
 settings=Settings(database_url='sqlite:///'+str(tmp_path/'host.db'),encryption_key=Fernet.generate_key().decode());registry=Registry(settings)
 native={'provider_id':'idenfy','operation_id':'generate_token','semantics':'session','successful_http':True,'native_status':None,'native_payload':{'authToken':'sensitive','scanRef':'scan1'},'raw_sha256':'0'*64,'source':'https://documentation.idenfy.com/kyc/generate-token','resource_id':'scan1'}
 h=normalize(native,{'tenant_id':'t','request_id':'r','subject_entity_id':'s'},'artifact://id');registry.validate('host',h)
 assert h['execution']['status']=='pending'and h['assessment']['outcome']=='not_checked'and h['assessment']['bank_decision']=='not_evaluated'and h['assertions']==[]
 assert 'sensitive'not in json.dumps(h)
 native.update(successful_http=False);h=normalize(native|{'http_status':401},{'tenant_id':'t','request_id':'r','subject_entity_id':'s'},'artifact://id');registry.validate('host',h)

def app_settings(tmp_path,demo=False):return Settings(demo=demo,database_url='sqlite:///'+str(tmp_path/'vendor.db'),encryption_key=Fernet.generate_key().decode(),api_keys={'secret':{'tenant_id':'test','role':'admin'},'other':{'tenant_id':'other','role':'admin'},'reader':{'tenant_id':'test','role':'reader'}},worker_enabled=False)

def test_private_testing_without_sandbox_attestation_and_durable_idempotency(tmp_path,monkeypatch):
 monkeypatch.setenv('VENDOR_TEST_ENABLED','1');monkeypatch.setenv('VENDOR_TEST_TENANTS_JSON','["test"]');app=create_app(app_settings(tmp_path));calls=[]
 def upstream(*args,**kwargs):
  calls.append(args);return {'provider_id':'idenfy','operation_id':'generate_token','semantics':'session','successful_http':True,'http_status':200,'native_status':None,'native_payload':{'scanRef':'s'},'raw_sha256':'0'*64,'raw_bytes_base64':'e30=','source':'https://documentation.idenfy.com/kyc/generate-token','resource_id':'s'}
 monkeypatch.setattr(app.state.vendor_client,'build',lambda *args,**kwargs:(None,None,None));monkeypatch.setattr(app.state.vendor_client,'send',upstream)
 with TestClient(app)as c:
  h={'Authorization':'Bearer secret','Idempotency-Key':'key'};body={'request_id':'r','subject_entity_id':'s','body':{'clientId':'c'}};url='/v1/vendor-connections/idenfy/operations/generate_token/invoke'
  first=c.post(url,json=body,headers=h);assert first.status_code==200,first.text
  second=c.post(url,json=body,headers=h);assert second.json()['idempotent_reuse']and len(calls)==1
  assert c.post(url,json=body|{'body':{'clientId':'changed'}},headers=h).status_code==409
  iid=first.json()['invocation_id'];assert c.get('/v1/vendor-invocations/'+iid,headers={'Authorization':'Bearer other'}).status_code==404
  assert c.get('/v1/vendor-invocations/'+iid,headers={'Authorization':'Bearer reader'}).status_code==403
  assert c.get('/v1/vendor-invocations/'+iid,headers=h).status_code==200
  inventory=c.get('/v1/vendor-connections',headers=h).json();assert len(inventory['items'])==376 and inventory['implemented_vendors']==len(CONTRACTS)
  assert c.post('/v1/checks',headers={'Authorization':'Bearer secret','Idempotency-Key':'x'},json={'provider_id':'idenfy','request':{}}).status_code==422
 with app.state.store.engine.connect()as conn:
  blob=conn.exec_driver_sql('SELECT payload FROM vendor_test_invocations').scalar();assert 'scanRef'not in blob and blob.startswith('gAAAA')

def test_demo_cannot_make_real_calls_even_when_flag_set(tmp_path,monkeypatch):
 monkeypatch.setenv('VENDOR_TEST_ENABLED','1');monkeypatch.setenv('VENDOR_TEST_TENANTS_JSON','["test"]')
 with TestClient(create_app(app_settings(tmp_path,demo=True)))as c:
  r=c.post('/v1/vendor-connections/idenfy/operations/generate_token/invoke',json={'request_id':'r','subject_entity_id':'s','body':{'clientId':'c'}},headers={'Authorization':'Bearer secret','Idempotency-Key':'x'})
  assert r.status_code==409 and r.json()['code']=='VENDOR_TEST_DISABLED'


def test_sdk_rejects_unapproved_base_before_outbound():
 seen=[];c=vc.VendorClient(httpx.Client(transport=httpx.MockTransport(lambda r:seen.append(r))))
 with pytest.raises(WiringError)as e:c.invoke('persona','get_inquiry',{'path':{'id':'id'}},credentials={'API_KEY':'secret'},base='https://attacker.example.com')
 assert e.value.code=='EGRESS_DENIED'and seen==[];c.close()


def test_veriff_body_requests_sign_payload_not_session_id():
 c={'API_KEY':'key','SHARED_SECRET':'secret'}
 for op,body in [('submit_session',{'verification':{'status':'submitted'}}),('upload_media',{'image':{'context':'document-front','content':'aGk='}})]:
  r,_=vc.prepare('veriff',op,{'path':{'id':'session-1'},'body':body},c,'https://customer.example.com')
  assert r.content and r.headers['X-HMAC-SIGNATURE']==hmac.new(b'secret',r.content,hashlib.sha256).hexdigest()

def test_shared_client_does_not_replay_vendor_cookies():
 seen=[]
 def upstream(r):seen.append(r.headers.get('cookie'));return httpx.Response(200,json={},headers={'Set-Cookie':'session=tenant-a; Domain=api.withpersona.com; Path=/'})
 c=vc.VendorClient(httpx.Client(transport=httpx.MockTransport(upstream),cookies=vc.no_cookies()))
 for _ in range(2):c.invoke('persona','get_inquiry',{'path':{'id':'id'}},credentials={'API_KEY':'s'},base='https://api.withpersona.com')
 assert seen==[None,None];c.close()

def vendor_app(tmp_path,monkeypatch,tenants='["test"]'):
 monkeypatch.setenv('VENDOR_TEST_ENABLED','1');monkeypatch.setenv('VENDOR_TEST_TENANTS_JSON',tenants);return create_app(app_settings(tmp_path))
URL='/v1/vendor-connections/idenfy/operations/generate_token/invoke';BODY={'request_id':'r','subject_entity_id':'s','body':{'clientId':'c'}}

def test_pre_send_failures_do_not_burn_idempotency_key(tmp_path,monkeypatch):
 app=vendor_app(tmp_path,monkeypatch);sent=[]
 app.state.vendor_client.client=httpx.Client(transport=httpx.MockTransport(lambda r:sent.append(r) or httpx.Response(200,json={'scanRef':'s','authToken':'t'})))
 with TestClient(app)as c:
  h={'Authorization':'Bearer secret','Idempotency-Key':'key'}
  r=c.post(URL,json=BODY,headers=h);assert r.status_code==409 and r.json()['code']=='VENDOR_CREDENTIALS_MISSING' and sent==[]
  monkeypatch.setenv('VENDOR_IDENFY_API_KEY','k');monkeypatch.setenv('VENDOR_IDENFY_API_SECRET','s')
  r=c.post(URL,json=BODY,headers=h);assert r.status_code==200,r.text;assert len(sent)==1

def test_failed_invocation_is_not_replayed_as_success(tmp_path,monkeypatch):
 app=vendor_app(tmp_path,monkeypatch)
 monkeypatch.setattr(app.state.vendor_client,'build',lambda *args,**kwargs:(None,None,None))
 monkeypatch.setattr(app.state.vendor_client,'send',lambda *args:{'provider_id':'idenfy','successful_http':True,'http_status':200})
 with TestClient(app)as c:
  h={'Authorization':'Bearer secret','Idempotency-Key':'key'}
  first=c.post(URL,json=BODY,headers=h);assert first.status_code==502,first.text
  second=c.post(URL,json=BODY,headers=h);assert second.status_code==409 and second.json()['code']=='VENDOR_TEST_RECONCILIATION_REQUIRED'

def test_tenant_allowlist_must_be_an_array(tmp_path,monkeypatch):
 with TestClient(vendor_app(tmp_path,monkeypatch,'"test,other"'))as c:
  r=c.post(URL,json=BODY,headers={'Authorization':'Bearer secret','Idempotency-Key':'k'});assert r.status_code==409 and r.json()['code']=='VENDOR_TEST_CONFIG_INVALID'
