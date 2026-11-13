import json,time,copy,hmac,hashlib,os
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch
import pytest,httpx
from cryptography.fernet import Fernet
from fastapi.testclient import TestClient
from sqlalchemy import select,update,func,insert
from wiring.core import Settings,Registry,ATLAS,read,uid,stamp,canonical,WiringError,template
from wiring.store import Store
from wiring.app import create_app
from wiring.worker import Worker
from wiring.connectors import simulation,HTTPConnector,RetryUpstream,check_url,relative_path
from vendor.atlas.normalizers import validate_semantics
from source_proof_helpers import KEY as SOURCE_PROOF_KEY, proof_for, authorize_stored_request

@pytest.fixture
def settings(tmp_path,monkeypatch):
 monkeypatch.setenv('SOURCE_AUTHORIZATION_VERIFY_KEY',SOURCE_PROOF_KEY)
 original_submit=Store.submit
 def trusted_worker_fixture(store,tenant,request,provider):
  # Direct store submissions model the already-verified admission path in worker tests.
  if not store.settings.demo and not request.get('extensions',{}).get('source_authorization'):
   authorize_stored_request(request,provider,store.settings.contracts.get(provider+':'+request['capability'],{}))
  return original_submit(store,tenant,request,provider)
 monkeypatch.setattr(Store,'submit',trusted_worker_fixture)
 return Settings(demo=True,database_url='sqlite:///'+str(tmp_path/'test.db'),encryption_key=Fernet.generate_key().decode(),api_keys={'test-a':{'tenant_id':'tenant-a','role':'admin'},'test-b':{'tenant_id':'tenant-b','role':'admin'},'reader':{'tenant_id':'tenant-a','role':'reader'}},worker_enabled=False)
@pytest.fixture
def app(settings):return create_app(settings)
@pytest.fixture
def client(app):
 with TestClient(app) as c:yield c
H={'Authorization':'Bearer test-a'};HB={'Authorization':'Bearer test-b'};HR={'Authorization':'Bearer reader'}
def request(aid='persona',tenant='tenant-a'):
 r=read(ATLAS/f'examples/requests/{aid}.json');r['tenant_id']=tenant;r['idempotency_key']=uid();r['request_id']=uid();return r
def post(client,r,provider='persona',h=H):
 if not client.app.state.settings.demo:
  token,body=proof_for(r,provider,client.app.state.settings.contracts.get(provider+':'+r['capability'],{}))
  return client.post('/v1/checks',headers={**h,'Content-Type':'application/json','Idempotency-Key':r['idempotency_key'],'X-Source-Authorization':token},content=body)
 return client.post('/v1/checks',headers={**h,'Idempotency-Key':r['idempotency_key']},json={'provider_id':provider,'request':r})
def live_contract(aid='persona',req=None):
 req=req or request(aid);provider={'companies_house':'companies-house'}.get(aid,aid)
 bases={'persona':'https://api.withpersona.com','companies_house':'https://api.company-information.service.gov.uk','opencorporates':'https://api.opencorporates.com','gleif':'https://api.gleif.org','opensanctions':'https://api.opensanctions.org','plaid':'https://sandbox.plaid.com'}
 return {'enabled':True,'approved':True,'maturity':'sandbox_tested','connector':'native_subset','base_url':bases[aid],'approved_base_urls':[bases[aid]],'product':'test product','api_version':'synthetic-test-version','mapping_version':'test-1','tenant_ids':['tenant-a'],'countries':['GB'],'residency_regions':['GB'],'processing_regions':['GB'],'purposes':[req['purpose']],'legal_bases':[req['legal_basis']],'policy_refs':[req['policy']['policy_id']+':'+req['policy']['policy_version']],'upstream_datasets':['fixture-scope'],'entitlement_ref':'test://entitlement','required_secret_env':['TEST_VENDOR_KEY'] if aid!='gleif' else [],'api_key_env':'TEST_VENDOR_KEY','client_id_env':'TEST_CLIENT_ID','client_secret_env':'TEST_CLIENT_SECRET','account_token_refs':{'example://secrets/plaid/item001':'TEST_ACCOUNT_TOKEN'},'async_mode':'sync'}

def test_health(client):
 r=client.get('/healthz').json();assert r['bindings']==824 and r['live_ready']==0 and r['mode']=='simulation'
def test_auth_required(client):assert client.get('/v1/providers').status_code==401
def test_bad_token(client):assert client.get('/v1/providers',headers={'Authorization':'Bearer bad'}).status_code==401
def test_registry_complete(client):
 assert client.get('/v1/providers?limit=500',headers=H).json()['total']==376
 x=client.get('/v1/connections?limit=1000',headers=H).json();assert x['total']==824 and len(x['items'])==824;assert sum(v['demo_supported'] for v in x['items'])==822
 assert len(client.get('/v1/capabilities',headers=H).json()['items'])==37
def test_every_binding_simulated_schema_valid(settings):
 registry=Registry(settings);count=0
 for op in registry.operations.values():
  if registry.providers[op['provider_id']]['routing_eligibility'].startswith('quarantined'):continue
  r=request();r['capability']=op['capability'];r['routing']['provider_allowlist']=[op['provider_id']];row={'id':uid(),'tenant':'tenant-a','provider':op['provider_id']}
  registry.resolve(r,op['provider_id']);result,artifact=simulation(row,r,op);registry.validate('host',result);assert not validate_semantics(result);assert result['assessment']['bank_decision']=='not_evaluated';assert artifact['synthetic'];count+=1
 assert count==822

def test_submit_worker_results_events(client,app):
 r=post(client,request());assert r.status_code==202;id=r.json()['check']['id'];assert app.state.worker.run_one()
 out=client.get('/v1/checks/'+id+'/results',headers=H).json();assert out['status']=='completed' and len(out['items'])==1
 result=out['items'][0];assert result['tenant_id']=='tenant-a';assert result['assessment']['outcome']=='inconclusive';assert result['assessment']['bank_decision']=='not_evaluated';assert result['extensions']['execution_mode']=='simulation'
 ev=client.get('/v1/events',headers=H).json()['items'];assert len(ev)==1;app.state.registry.validate('event',ev[0])
def test_idempotency_reuse(client):
 r=request();a=post(client,r).json();b=post(client,r).json();assert a['check']['id']==b['check']['id'] and b['idempotent_reuse']
def test_idempotency_conflict(client):
 r=request();post(client,r);r['purpose']='changed';assert post(client,r).status_code==409
def test_idempotency_header_required(client):
 assert client.post('/v1/checks',headers=H,json={'provider_id':'persona','request':request()}).status_code==422
def test_tenant_body_mismatch(client):assert post(client,request(tenant='tenant-b')).status_code==403
def test_tenant_visibility(client,app):
 id=post(client,request()).json()['check']['id'];app.state.worker.run_one()
 for path in ['', '/results','/artifact']:
  assert client.get('/v1/checks/'+id+path,headers=HB).status_code==404
 assert client.get('/v1/checks',headers=HB).json()['items']==[];assert client.get('/v1/events',headers=HB).json()['items']==[]
def test_reader_cannot_mutate(client):assert post(client,request(),h=HR).status_code==403
def test_reader_cannot_get_artifact(client):
 id=post(client,request()).json()['check']['id'];assert client.get('/v1/checks/'+id+'/artifact',headers=HR).status_code==403
def test_schema_malformed(client):
 r=request();del r['legal_basis'];assert post(client,r).status_code==422
def test_subject_unknown(client):
 r=request();r['subject_entity_id']='not-present';assert post(client,r).status_code==422
def test_routing_explicit_allowlist(client):
 r=request();r['routing']['provider_allowlist']=[];assert post(client,r).status_code==403
def test_deadline(client):
 r=request();r['routing']['deadline_at']='2000-01-01T00:00:00Z';assert post(client,r).status_code==409
def test_quarantine(client):
 x=client.post('/v1/demo/run',headers=H,json={'operation_id':'finantier:account.ownership.verify'});assert x.status_code==409;assert x.json()['code']=='QUARANTINED'
def test_unsupported_binding(client):assert post(client,request(),'gleif').status_code==422
def test_live_missing_contract_blocks_before_job(settings):
 settings.demo=False;a=create_app(settings)
 with TestClient(a) as c:
  x=post(c,request());assert x.status_code==409 and x.json()['code']=='CONNECTION_NOT_READY';assert c.get('/v1/checks',headers=H).json()['items']==[];assert c.post('/v1/demo/run',headers=H,json={}).status_code==404

def test_live_entitlement_residency_secrets(settings,monkeypatch):
 settings.demo=False;r=request();c=live_contract(req=r);settings.contracts={'persona:identity.person.verify':c};reg=Registry(settings)
 authorize_stored_request(r,'persona',c)
 with pytest.raises(WiringError):reg.resolve(r,'persona')
 monkeypatch.setenv('TEST_VENDOR_KEY','synthetic-secret');assert reg.resolve(r,'persona')[1]==c
 c['processing_regions']=['US']
 with pytest.raises(WiringError):reg.resolve(r,'persona')
 c['processing_regions']=['GB'];c['tenant_ids']=['tenant-b']
 with pytest.raises(WiringError):reg.resolve(r,'persona')
def test_payloads_encrypted_at_rest(client,app):
 r=request();id=post(client,r).json()['check']['id'];row=app.state.store.row(id);assert 'Alex Example' not in row['request'];assert row['request'].startswith('gAAAA');assert app.state.store.dec(row['request'])==r
 app.state.worker.run_one();row=app.state.store.row(id);assert 'inconclusive' not in row['result'];assert 'inq_synthetic' not in row['artifact']
def test_persistent_restart(settings):
 s=Store(settings);r=request();row,_=s.submit('tenant-a',r,'persona');s.engine.dispose();s2=Store(settings);assert s2.dec(s2.row(row['id'],'tenant-a')['request'])==r
def test_two_workers_one_claim(settings):
 s=Store(settings);s.submit('tenant-a',request(),'persona')
 with ThreadPoolExecutor(max_workers=2) as e:rows=list(e.map(lambda _:s.claim(),range(2)))
 assert sum(x is not None for x in rows)==1

def test_result_and_outbox_atomic_idempotent_finish(settings):
 s=Store(settings);reg=Registry(settings);s.submit('tenant-a',request(),'persona');row=s.claim();r=s.dec(row['request']);op,_=reg.resolve(r,'persona');result,artifact=simulation(row,r,op)
 assert s.finish(row,result,artifact);assert not s.finish(row,result,artifact)
 with s.engine.connect() as c:
  assert c.execute(select(func.count()).select_from(s.events)).scalar_one()==1;assert c.execute(select(func.count()).select_from(s.results)).scalar_one()==1

def test_live_lease_expiry_requires_reconciliation(settings):
 s=Store(settings);r=request();row,_=s.submit('tenant-a',r,'persona');s.claim()
 with s.engine.begin() as c:c.execute(update(s.checks).values(lease_until=0))
 settings.demo=False;assert s.claim() is None;assert s.row(row['id'])['status']=='reconciliation_required'
def test_retry_deadletter_and_manual_requeue(settings):
 s=Store(settings);row,_=s.submit('tenant-a',request(),'persona')
 for _ in range(3):r=s.claim();assert r;s.retry(r,'MOCK_429',0)
 assert s.row(row['id'])['status']=='dead_letter';s.requeue(row['id'],'tenant-a');assert s.row(row['id'])['status']=='queued'
def test_ambiguous_retry_denied(settings):
 s=Store(settings);row,_=s.submit('tenant-a',request(),'persona');r=s.claim();s.retry(r,'TIMEOUT',0,True)
 with pytest.raises(WiringError):s.requeue(row['id'],'tenant-a')
def test_restricted_artifact_read_is_audited(client,app):
 id=post(client,request()).json()['check']['id'];app.state.worker.run_one();assert client.get('/v1/checks/'+id+'/artifact',headers=H).status_code==200
 assert any(x['action']=='restricted_artifact.read' for x in client.get('/v1/audit',headers=H).json()['items'])

@pytest.mark.parametrize('aid',['persona','companies_house','opencorporates','gleif','opensanctions','plaid'])
def test_six_native_http_connectors(settings,monkeypatch,aid):
 for k in ['TEST_VENDOR_KEY','TEST_CLIENT_ID','TEST_CLIENT_SECRET','TEST_ACCOUNT_TOKEN']:monkeypatch.setenv(k,'synthetic-test-secret')
 settings.demo=False;r=request(aid);provider={'companies_house':'companies-house'}.get(aid,aid);c=live_contract(aid,r);settings.contracts={provider+':'+r['capability']:c};reg=Registry(settings);s=Store(settings);calls=[]
 def upstream(req):calls.append(req);return httpx.Response(200,json=read(ATLAS/f'examples/native/{aid}.json'))
 http=HTTPConnector(settings,httpx.Client(transport=httpx.MockTransport(upstream),follow_redirects=False,trust_env=False))
 row,_=s.submit('tenant-a',r,provider);worker=Worker(s,reg,http)
 with patch('wiring.connectors.check_url',return_value=c['base_url']):assert worker.run_one()
 result=s.dec(s.row(row['id'])['result']);assert result['extensions']['execution_mode']=='live';assert result['assessment']['bank_decision']=='not_evaluated';assert calls and result['tenant_id']=='tenant-a';reg.validate('host',result)
 if aid=='plaid':assert json.loads(calls[0].content)['access_token']=='synthetic-test-secret'
 if aid=='persona':assert calls[0].headers['Authorization']=='Bearer synthetic-test-secret'

def test_redirect_denied(settings):
 c=HTTPConnector(settings,httpx.Client(transport=httpx.MockTransport(lambda r:httpx.Response(302,headers={'Location':'http://127.0.0.1'}))))
 with pytest.raises(WiringError):c.send('GET','https://example.invalid',{},None,{},True)
def test_429_retry_and_ambiguous_post_timeout(settings):
 c=HTTPConnector(settings,httpx.Client(transport=httpx.MockTransport(lambda r:httpx.Response(429,headers={'Retry-After':'3'}))))
 with pytest.raises(RetryUpstream) as e:c.send('GET','https://example.invalid',{},None,{},True)
 assert e.value.delay>=3 and not e.value.ambiguous
 def timeout(r):raise httpx.ReadTimeout('synthetic')
 c=HTTPConnector(settings,httpx.Client(transport=httpx.MockTransport(timeout)))
 with pytest.raises(RetryUpstream) as e:c.send('POST','https://example.invalid',{},None,{},False)
 assert e.value.ambiguous

def test_egress_rejects_private_and_nonallowlist():
 for url,approved in [('http://example.com',['http://example.com']),('https://unknown.invalid',[]),('https://user:password@example.com',['https://user:password@example.com'])]:
  with pytest.raises(WiringError):check_url(url,approved)
 with patch('socket.getaddrinfo',return_value=[(2,1,6,'',('127.0.0.1',443))]):
  with pytest.raises(WiringError):check_url('https://example.com',['https://example.com'])
def test_path_traversal_denied():
 for p in ['//evil.example','/../secret','/%2e%2e/secret','/x?token=1','https://example.com']:
  with pytest.raises(WiringError):relative_path(p)
def test_template_no_eval_and_unknown_status():
 assert template({'$enum':{'path':'/status','values':{'ok':'passed'},'unknown':'unknown'}},native={'status':'future'})=='unknown'
 assert template({'$each':'/items','template':{'x':{'$item':'/id'}}},native={'items':[{'id':'one'}]})==[{'x':'one'}]
 assert template('__import__("os").system("not executed")')=='__import__("os").system("not executed")'
 with pytest.raises(WiringError):template({'$native':'/missing'},native={})

def declarative_config(settings,r):
 c=live_contract(req=r);c.update(connector='declarative',base_url='https://provider.example.invalid',approved_base_urls=['https://provider.example.invalid'],method='POST',path='/checks',request_template={'name':{'$request':'/entities/0/names/0/full'}},response_template=copy.deepcopy(read(ATLAS/'examples/host/persona.json')))
 c['response_template']['assessment']['outcome']={'$enum':{'path':'/status','values':{'approved':'passed'},'unknown':'unknown'}}
 return c

def test_declarative_real_transport_mapping(settings,monkeypatch):
 monkeypatch.setenv('TEST_VENDOR_KEY','test');settings.demo=False;r=request();c=declarative_config(settings,r);settings.contracts={'persona:identity.person.verify':c};s=Store(settings);reg=Registry(settings);row,_=s.submit('tenant-a',r,'persona');http=HTTPConnector(settings,httpx.Client(transport=httpx.MockTransport(lambda req:httpx.Response(200,json={'status':'approved'}))))
 with patch('wiring.connectors.check_url',return_value=c['base_url']):Worker(s,reg,http).run_one()
 result=s.dec(s.row(row['id'])['result']);assert result['assessment']['outcome']=='passed' and result['assessment']['bank_decision']=='not_evaluated'

def test_polling_create_once_then_get(settings,monkeypatch):
 monkeypatch.setenv('TEST_VENDOR_KEY','test');settings.demo=False;r=request();c=declarative_config(settings,r);c.update(async_mode='poll',submission_resource_pointer='/id',completion_pointer='/done',completion_value=True,poll_path_segments=['checks',{'$context':'/provider_record_id'}],poll_seconds=1);settings.contracts={'persona:identity.person.verify':c};s=Store(settings);reg=Registry(settings);row,_=s.submit('tenant-a',r,'persona');calls=[]
 def upstream(req):
  calls.append(req.method);return httpx.Response(200,json={'id':'resource-1','done':len(calls)>1,'status':'approved'})
 worker=Worker(s,reg,HTTPConnector(settings,httpx.Client(transport=httpx.MockTransport(upstream))))
 with patch('wiring.connectors.check_url',return_value=c['base_url']):
  worker.run_one();assert s.row(row['id'])['status']=='retry_wait'
  with s.engine.begin() as db:db.execute(update(s.checks).values(available_at=0))
  worker.run_one()
 assert calls==['POST','GET'];assert s.row(row['id'])['status']=='completed'

def test_signed_webhook_replay_resource_and_state(settings,monkeypatch):
 monkeypatch.setenv('TEST_VENDOR_KEY','test');monkeypatch.setenv('TEST_WEBHOOK_KEY','synthetic-signing-secret');settings.demo=False;r=request();c=declarative_config(settings,r);c.update(async_mode='webhook',submission_resource_pointer='/id',webhook={'approved':True,'secret_env':'TEST_WEBHOOK_KEY','scheme':'timestamp_dot_body_hmac_sha256','signature_header':'X-Wiring-Signature','resource_id_pointer':'/id'});settings.contracts={'persona:identity.person.verify':c};app=create_app(settings);http=HTTPConnector(settings,httpx.Client(transport=httpx.MockTransport(lambda req:httpx.Response(200,json={'id':'resource-1'}))));app.state.worker.connector=http
 with TestClient(app) as client:
  id=post(client,r).json()['check']['id']
  with patch('wiring.connectors.check_url',return_value=c['base_url']):app.state.worker.run_one()
  assert app.state.store.row(id)['status']=='awaiting_webhook'
  raw=b'{"id":"resource-1","status":"approved"}';ts=str(int(time.time()));sig=hmac.new(b'synthetic-signing-secret',ts.encode()+b'.'+raw,hashlib.sha256).hexdigest();headers={'X-Wiring-Timestamp':ts,'X-Wiring-Signature':sig,'Content-Type':'application/json'}
  assert client.post('/v1/webhooks/'+id,content=raw,headers={**headers,'X-Wiring-Signature':'bad'}).status_code==401
  assert client.post('/v1/webhooks/'+id,content=raw,headers={**headers,'X-Wiring-Timestamp':'0'}).status_code==401
  first=client.post('/v1/webhooks/'+id,content=raw,headers=headers);assert first.status_code==202
  assert client.post('/v1/webhooks/'+id,content=raw,headers=headers).json()['duplicate']
  app.state.worker.run_one();assert app.state.store.row(id)['status']=='completed'
  raw2=b'{"id":"resource-1","status":"new"}';sig2=hmac.new(b'synthetic-signing-secret',ts.encode()+b'.'+raw2,hashlib.sha256).hexdigest();assert client.post('/v1/webhooks/'+id,content=raw2,headers={**headers,'X-Wiring-Signature':sig2}).status_code==409

def test_outbox_signed_delivery(settings,monkeypatch):
 monkeypatch.setenv('TEST_DEST_KEY','synthetic-destination-secret');settings.demo=False;settings.destinations={'approved-dest':{'approved':True,'tenant_ids':['tenant-a'],'url':'https://receiver.example.invalid/events','signing_secret_env':'TEST_DEST_KEY'}};s=Store(settings);reg=Registry(settings)
 with s.engine.begin() as db:db.execute(insert(s.subscriptions).values(id=uid(),tenant='tenant-a',destination='approved-dest',created_at=stamp()))
 row,_=s.submit('tenant-a',request(),'persona');row=s.claim();r=s.dec(row['request']);op=reg.operations['persona:identity.person.verify'];result,artifact=simulation(row,r,op);s.finish(row,result,artifact);calls=[]
 def receiver(req):calls.append(req);return httpx.Response(204)
 worker=Worker(s,reg,HTTPConnector(settings,httpx.Client(transport=httpx.MockTransport(receiver))))
 with patch('wiring.worker.check_url',return_value='https://receiver.example.invalid/events'):assert worker.deliver_one()
 sent=calls[0];expected=hmac.new(b'synthetic-destination-secret',sent.headers['X-Wiring-Timestamp'].encode()+b'.'+sent.content,hashlib.sha256).hexdigest();assert sent.headers['X-Wiring-Signature']==expected
 with s.engine.connect() as db:assert db.execute(select(s.deliveries.c.status)).scalar_one()=='delivered'
def test_subscription_url_not_caller_controlled(client):assert client.post('/v1/event-subscriptions',headers=H,json={'destination_ref':'https://127.0.0.1/'}).status_code==403
def test_schema_endpoint_path_allowlist(client):assert client.get('/v1/schemas/unknown',headers=H).status_code==404
def test_openapi_and_dashboard(client):
 assert client.get('/').status_code==200;x=client.get('/openapi.json').json();assert x['openapi'].startswith('3.1');assert 'CanonicalHostRequest'in x['components']['schemas'];assert '/v1/webhooks/{check_id}'in x['paths']

def test_every_nonquarantined_binding_through_http_worker_storage_events(client,app):
 count=0
 for op in app.state.registry.readiness():
  response=client.post('/v1/demo/run',headers=H,json={'operation_id':op['operation_id']})
  if not op['demo_supported']:
   assert response.status_code==409;continue
  # Exercise API, DB queue, worker, mapping, strict host validation and atomic outbox.
  assert response.status_code==202,response.text
  check_id=response.json()['check']['id'];assert app.state.worker.run_one()
  row=app.state.store.row(check_id,'tenant-a');assert row['status']in ['completed','partial'];result=app.state.store.dec(row['result']);assert result['capability']==op['capability'];assert result['assessment']['bank_decision']=='not_evaluated';count+=1
  # Avoid triggering the real per-token API limiter in this exhaustive offline test.
  # Separate principals still authenticate to the same tenant, just as rotated keys do.
  if count%100==0:
   token='rotation-'+str(count);app.state.settings.api_keys[token]={'tenant_id':'tenant-a','role':'admin'};H['Authorization']='Bearer '+token
 with app.state.store.engine.connect() as c:
  assert c.execute(select(func.count()).select_from(app.state.store.results)).scalar_one()==822
  assert c.execute(select(func.count()).select_from(app.state.store.events)).scalar_one()==822
 assert count==822
 H['Authorization']='Bearer test-a'

def test_body_size_limit(client):
 assert client.post('/v1/checks',headers={**H,'Content-Type':'application/json'},content=b'x'*2_000_001).status_code==413

def test_schema_drift_result_fails_closed_and_archived(settings,monkeypatch):
 monkeypatch.setenv('TEST_VENDOR_KEY','test');settings.demo=False;r=request();c=live_contract(req=r);settings.contracts={'persona:identity.person.verify':c};s=Store(settings);reg=Registry(settings);row,_=s.submit('tenant-a',r,'persona');worker=Worker(s,reg,HTTPConnector(settings,httpx.Client(transport=httpx.MockTransport(lambda req:httpx.Response(200,json={'wrong':'shape'})))))
 with patch('wiring.connectors.check_url',return_value=c['base_url']):worker.run_one()
 row=s.row(row['id']);result=s.dec(row['result']);assert row['status']=='failed';assert result['assessment']['outcome']=='unknown';reg.validate('host',result)

def test_batch_per_item_idempotency_and_partial_errors(client):
 a=request();b=request();b['tenant_id']='tenant-b';payload={'items':[{'provider_id':'persona','request':a},{'provider_id':'persona','request':b}]}
 response=client.post('/v1/checks/batch',headers=H,json=payload);assert response.status_code==207;x=response.json()['items'];assert x[0]['status']==202 and x[1]['status']==403
 retry=client.post('/v1/checks/batch',headers=H,json=payload).json()['items'];assert retry[0]['body']['idempotent_reuse']

def test_reused_client_trace_different_operations_have_distinct_result_ids(client,app):
 r=request();one=post(client,r).json()['check']['id'];r['idempotency_key']=uid();two=post(client,r).json()['check']['id'];app.state.worker.run_one();app.state.worker.run_one()
 a=app.state.store.dec(app.state.store.row(one)['result']);b=app.state.store.dec(app.state.store.row(two)['result']);assert a['request_id']==b['request_id'];assert a['result_id']!=b['result_id']


@pytest.mark.parametrize('deadline',['2099-01-01T00:00:00','not-a-date'])
def test_naive_or_malformed_deadline_is_422_not_500(client,deadline):
 r=request();r['routing']['deadline_at']=deadline;assert post(client,r).status_code==422

def test_denied_delivery_dead_letters_immediately_with_reason(settings):
 store=Store(settings);worker=Worker(store,Registry(settings))
 with store.engine.begin()as c:c.execute(insert(store.deliveries).values(id='d1',tenant='tenant-a',event_id='e1',destination='unknown',status='queued',attempts=0,available_at=0,lease_until=0))
 assert worker.deliver_one()
 with store.engine.connect()as c:row=c.execute(select(store.deliveries)).mappings().one()
 assert row['status']=='dead_letter' and row['last_code']=='DESTINATION_DENIED'

def test_vendored_normalizers_match_atlas_source():
 # vendor/atlas is a copy of tools/kyc-provider-atlas; fail loudly if the two drift apart.
 source=ATLAS.parents[3]/'tools/kyc-provider-atlas/adapters/runtime.py'
 if not source.exists():pytest.skip('kyc-provider-atlas checkout not present')
 assert (ATLAS/'normalizers.py').read_bytes()==source.read_bytes()
