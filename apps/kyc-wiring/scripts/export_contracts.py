"""Export actual FastAPI OpenAPI, native subset examples and a demo Postman collection."""
from pathlib import Path
import sys,json,copy
P=Path(__file__).resolve().parents[1];sys.path.insert(0,str(P))
from wiring.app import create_app
from wiring.core import Settings,ATLAS,read
from wiring.connectors import NATIVE_BASES
s=Settings.env();s.worker_enabled=False;app=create_app(s)
(P/'docs/openapi.json').write_text(json.dumps(app.openapi(),indent=2)+'\n')
configs={}
for aid in ['persona','companies_house','opencorporates','gleif','opensanctions','plaid']:
 req=read(ATLAS/f'examples/requests/{aid}.json');provider='companies-house' if aid=='companies_house' else aid
 base='https://sandbox.plaid.com' if aid=='plaid' else sorted(NATIVE_BASES[aid])[0]
 c={'enabled':False,'approved':False,'maturity':'documented_subset_not_vendor_tested','connector':'native_subset','base_url':base,'approved_base_urls':[base],'product':None,'api_version':'2026-09-29' if aid=='persona' else '0.4' if aid=='opencorporates' else 'v1' if aid=='gleif' else None,'mapping_version':'documented-subset-0.1','tenant_ids':[],'countries':[],'residency_regions':[],'processing_regions':[],'purposes':[],'legal_bases':[],'policy_refs':[],'upstream_datasets':[],'entitlement_ref':None,'required_secret_env':[] if aid=='gleif' else [aid.upper()+'_API_KEY'],'api_key_env':None if aid=='gleif' else aid.upper()+'_API_KEY','async_mode':'sync','source_manifest':'vendor/atlas/manifests/'+aid+'.json'}
 if aid=='plaid':c.update(required_secret_env=['PLAID_CLIENT_ID','PLAID_CLIENT_SECRET'],api_key_env=None,client_id_env='PLAID_CLIENT_ID',client_secret_env='PLAID_CLIENT_SECRET',account_token_refs={},requires_consent=True)
 configs[provider+':'+req['capability']]=c
(P/'config/native-six.examples.json').write_text(json.dumps(configs,indent=2)+'\n')
# Explicitly synthetic, disabled declarative mapping. Native status fields are not a vendor claim.
base=copy.deepcopy(read(ATLAS/'examples/host/persona.json'))
for key in ['tenant_id','request_id','subject_entity_id','result_id']:base[key]={'$context':'/'+key}
base['provider']['provider_id']={'$context':'/provider_id'};base['assessment']['outcome']={'$enum':{'path':'/status','values':{'approved':'passed','rejected':'failed'},'unknown':'unknown'}};base['entities']={'$request':'/entities'};base['result']['checks']=[];base['result']['assertion_ids']=[];base['assertions']=[];base['evidence']=[];base['warnings']=['SYNTHETIC_MAPPING_EXAMPLE_NOT_A_VENDOR_CONTRACT'];base['execution']['received_at']={'$context':'/received_at'}
example={'description':'Synthetic documentation example only; not a real provider or native API','enabled':False,'approved':False,'maturity':'proposed','connector':'declarative','base_url':'https://provider.example.invalid','approved_base_urls':[],'method':'POST','path':'/checks','product':None,'api_version':None,'mapping_version':'example-only','tenant_ids':[],'countries':[],'residency_regions':[],'processing_regions':[],'purposes':[],'legal_bases':[],'policy_refs':[],'upstream_datasets':[],'entitlement_ref':None,'required_secret_env':[],'request_template':{'full_name':{'$request':'/entities/0/names/0/full'},'client_reference':{'$context':'/check_id'}},'response_template':base,'async_mode':'sync'}
(P/'config/declarative.example.json').write_text(json.dumps(example,indent=2)+'\n')
req=read(ATLAS/'examples/requests/persona.json')
items=[]
def item(name,method,path,body=None,test=None):
 r={'name':name,'request':{'method':method,'header':[{'key':'Authorization','value':'Bearer {{host_token}}'}],'url':'{{base_url}}'+path}}
 if body is not None:r['request']['header'].append({'key':'Content-Type','value':'application/json'});r['request']['body']={'mode':'raw','raw':json.dumps(body,indent=2),'options':{'raw':{'language':'json'}}}
 if test:r['event']=[{'listen':'test','script':{'type':'text/javascript','exec':test}}]
 items.append(r);return r
item('Health','GET','/healthz')
item('Connection readiness','GET','/v1/connections?limit=1000')
item('Submit synthetic Sumsub check (DEMO ONLY)','POST','/v1/demo/run',{'operation_id':'sumsub:identity.person.verify'},['const body = pm.response.json();','if (body.check) pm.collectionVariables.set("check_id", body.check.id);'])
item('Get lifecycle (repeat until terminal)','GET','/v1/checks/{{check_id}}')
item('Get canonical results','GET','/v1/checks/{{check_id}}/results')
item('Pull tenant events','GET','/v1/events')
item('Inspect restricted artifact (admin)','GET','/v1/checks/{{check_id}}/artifact')
item('Get host schema','GET','/v1/schemas/host')
collection={'info':{'name':'KYC API Wiring — Demo / Host API','schema':'https://schema.getpostman.com/json/collection/v2.1.0/collection.json','description':'Synthetic demo requests only; no vendor credentials. Start the local service first. Results are asynchronous; retry GET lifecycle until terminal.'},'variable':[{'key':'base_url','value':'http://localhost:8000'},{'key':'host_token','value':'demo-token-local-only'},{'key':'check_id','value':''}],'item':items}
(P/'docs/KYC_API_Wiring.postman_collection.json').write_text(json.dumps(collection,indent=2)+'\n')
# A canonical envelope example for callers that do not use demo generation.
(P/'docs/submit-check.example.json').write_text(json.dumps({'provider_id':'persona','request':req},indent=2)+'\n')
print('Exported',len(app.openapi()['paths']),'API paths, six disabled native configs, declarative example and Postman requests')
