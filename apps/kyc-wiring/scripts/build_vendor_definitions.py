"""Executable request contracts transcribed from the cited official documentation.
These are credential-testable implementations, not live-tested or product-wide certifications.
"""
from pathlib import Path
import json,re
P=Path(__file__).resolve().parents[1]/'vendor_connections';vendors={}
def vendor(id,bases,auth,docs,version='documented-public',notes=''):
 v={'provider_id':id,'version':version,'bases':bases if isinstance(bases,dict)else {'default':bases},'auth':auth,'sources':docs if isinstance(docs,list)else [docs],'notes':notes,'maturity':'implemented_unverified','live_tested':False,'operations':{}};vendors[id]=v;return v
def op(v,id,method,path,required=(),*,query=(),body=None,content='json',semantics='resource',status=None,resource=None,source=None,headers=(),response='json'):
 v['operations'][id]={'method':method,'path':path,'required_body':list(required),'required_query':list(query),'body_example':body,'content':content,'semantics':semantics,'status_pointer':status,'resource_pointer':resource,'source':source or v['sources'][0],'allowed_input_headers':list(headers),'response':response}
v=vendor('sumsub','https://api.sumsub.com',{'type':'sumsub','keys':['APP_TOKEN','SECRET_KEY']},['https://docs.sumsub.com/reference/authentication','https://docs.sumsub.com/reference/create-applicant','https://docs.sumsub.com/reference/get-applicant-review-status','https://docs.sumsub.com/reference/get-applicant-data','https://docs.sumsub.com/reference/get-aml-case-data'])
op(v,'create_applicant','POST','/resources/applicants',('externalUserId',),query=('levelName',),body={'externalUserId':'YOUR_USER_ID'},semantics='session',resource='/id',source=v['sources'][1])
op(v,'get_applicant','GET','/resources/applicants/{applicantId}/one',resource='/id',source=v['sources'][3])
op(v,'review_status','GET','/resources/applicants/{applicantId}/status',status='/reviewStatus',source=v['sources'][2],semantics='identity_result')
op(v,'aml_case','GET','/resources/api/applicants/{applicantId}/amlCase',semantics='screening',source=v['sources'][4])
v=vendor('veriff',{}, {'type':'veriff','keys':['API_KEY','SHARED_SECRET']},['https://devdocs.veriff.com/apidocs/v1sessionsiddecision-1','https://devdocs.veriff.com/docs/proof-of-address-capture','https://devdocs.veriff.com/apidocs/v1sessionsidwatchlist-screening-1'],notes='Customer integration HTTPS base must be explicitly configured. Response HMAC required; session creation is not a decision.')
op(v,'create_session','POST','/v1/sessions/',('verification',),body={'verification':{'vendorData':'YOUR_REFERENCE'}},semantics='session',resource='/verification/id',source=v['sources'][1])
op(v,'get_decision','GET','/v1/sessions/{id}/decision',semantics='identity_result',status='/verification/status',resource='/verification/id')
op(v,'get_watchlist','GET','/v1/sessions/{id}/watchlist-screening',semantics='screening',source=v['sources'][2])
op(v,'upload_media','POST','/v1/sessions/{id}/media',('image',),semantics='submission',source=v['sources'][1])
op(v,'submit_session','PATCH','/v1/sessions/{id}',('verification',),body={'verification':{'status':'submitted'}},semantics='submission',source=v['sources'][1])
v=vendor('complycube','https://api.complycube.com/v1',{'type':'header','name':'Authorization','keys':['API_KEY']},['https://docs.complycube.com/documentation/quick-guides/api-quick-guide/run-a-document-check','https://docs.complycube.com/documentation/quick-guides/api-quick-guide/run-an-aml-screening-check'])
op(v,'create_client','POST','/clients',('type',),body={'type':'person','personDetails':{'firstName':'YOUR_FIRST_NAME','lastName':'YOUR_LAST_NAME'}},resource='/id')
op(v,'create_document','POST','/documents',('clientId','type'),resource='/id')
op(v,'upload_front','POST','/documents/{id}/upload/front',('fileName','data'),semantics='submission')
op(v,'create_check','POST','/checks',('clientId','type'),body={'clientId':'YOUR_CLIENT_ID','type':'document_check','documentId':'YOUR_DOCUMENT_ID'},semantics='submission',resource='/id')
op(v,'get_check','GET','/checks/{id}',semantics='check_result',status='/status',resource='/id')
v=vendor('idenfy','https://ivs.idenfy.com',{'type':'basic','keys':['API_KEY','API_SECRET']},'https://documentation.idenfy.com/kyc/generate-token')
op(v,'generate_token','POST','/api/v2/token',('clientId',),body={'clientId':'YOUR_USER_ID','firstName':'YOUR_FIRST_NAME','lastName':'YOUR_LAST_NAME'},semantics='session',resource='/scanRef')
v=vendor('shufti','https://api.shuftipro.com',{'type':'shufti','keys':['CLIENT_ID','SECRET_KEY']},['https://developers.shuftipro.com/docs/verification_endpoints/requests','https://developers.shuftipro.com/docs/verification_endpoints/responses'],notes='Basic authentication; post-2023-03-15 SHA256-secret response signature. Legacy signature accounts need an explicit documented change, not silent fallback.')
op(v,'verify','POST','/',('reference',),body={'reference':'UNIQUE_REFERENCE','country':'GB','language':'EN','verification_mode':'any'},semantics='session',status='/event',resource='/reference')
op(v,'get_status','POST','/status',('reference',),body={'reference':'YOUR_REFERENCE'},semantics='identity_result',status='/event',resource='/reference')
v=vendor('complyadvantage',{'eu':'https://api.complyadvantage.com','us':'https://api.us.complyadvantage.com','ap':'https://api.ap.complyadvantage.com'},{'type':'header','name':'Authorization','prefix':'Token ','keys':['API_KEY']},'https://docs.complyadvantage.com/api-docs')
op(v,'create_search','POST','/searches',('search_term',),body={'search_term':'YOUR_SUBJECT_NAME','fuzziness':0.6,'filters':{'types':['sanction','pep']}},semantics='screening',resource='/content/data/id')
op(v,'get_search','GET','/searches/{id}',semantics='screening',resource='/content/data/id')
v=vendor('seon',{'eu':'https://api.seon.io','us':'https://api.us-east-1-main.seon.io','me':'https://api.me-central-1-main.seon.io'},{'type':'header','name':'X-API-KEY','keys':['API_KEY']},'https://docs.seon.io/api-reference/fraud-api',notes='EU uses v2.0; US/ME use v2/. Choose matching operation and region.')
op(v,'fraud_eu','POST','/SeonRestService/fraud-api/v2.0',body={'ip':'YOUR_IP','email':'YOUR_EMAIL'},semantics='risk',status='/data/state');v['operations']['fraud_eu']['regions']=['eu']
op(v,'fraud_us_me','POST','/SeonRestService/fraud-api/v2/',body={'ip':'YOUR_IP','email':'YOUR_EMAIL'},semantics='risk',status='/data/state');v['operations']['fraud_us_me']['regions']=['us','me']
v=vendor('dojah',{'production':'https://api.dojah.io','sandbox':'https://sandbox.dojah.io'},{'type':'multi_header','headers':{'Authorization':'SECRET_KEY','AppId':'APP_ID'},'keys':['SECRET_KEY','APP_ID']},['https://docs.dojah.io/api-reference/individual-verification/nigeria/lookup-nin','https://docs.dojah.io/api-reference/financial-credit/nuban-kyc-status','https://docs.dojah.io/api-reference/address-verification/fetch-address-verification-data'])
op(v,'lookup_nin','GET','/api/v1/kyc/nin',query=('nin',),semantics='identity_data')
op(v,'nuban_status','GET','/api/v1/kyc/nuban/status',query=('account_number','bank_code'),semantics='account_data',source=v['sources'][1])
op(v,'address_result','GET','/api/v1/kyc/address',query=('reference_id',),semantics='address_data',source=v['sources'][2])
v=vendor('prembly','https://api.prembly.com',{'type':'multi_header','headers':{'x-api-key':'API_KEY','app-id':'APP_ID'},'keys':['API_KEY','APP_ID']},['https://docs.prembly.com/docs/national-id','https://docs.prembly.com/docs/international-passport-copy-2','https://docs.prembly.com/docs/company-search-by-person-copy-16'])
v['notes']='The national-id source labels its example Zambia but documents /verification/gb/id. This country/path inconsistency is preserved, not interpreted as UK coverage. Confirm this product path with Prembly before submitting personal data.'
op(v,'documented_national_id','POST','/verification/gb/id',('number',),semantics='identity_data')
op(v,'ghana_passport','POST','/verification/gh/passport',('number',),semantics='identity_data',source=v['sources'][1])
op(v,'company_search','POST','/identitypass/verification/global/company/search_with_string',('query',),semantics='business_data',source=v['sources'][2])
v=vendor('unit21',{}, {'type':'header','name':'u21-key','keys':['API_KEY']},['https://docs.unit21.ai/reference/encryption','https://docs.unit21.ai/reference/placeholder-objects'],notes='Use customer-specific API_ENDPOINT. Optional Fernet transport mode is not enabled; only ordinary documented TLS JSON mode is implemented.')
op(v,'create_entity','POST','/v1/entities/create',('general_data',),body={'general_data':{'entity_id':'YOUR_ENTITY_ID','entity_type':'user','status':'ACTIVE','registered_at':0},'user_data':{}},semantics='submission',source=v['sources'][1])
v=vendor('flagright',{'sandbox':'https://sandbox.api.flagright.com'},{'type':'header','name':'x-api-key','keys':['API_KEY']},['https://docs.flagright.com/guides/use-cases/swift-payments','https://docs.flagright.com/framl-api/api-reference/api-reference/transaction-events/get','https://docs.flagright.com/framl-api/api-reference/api-reference/business-user-events/get'])
op(v,'create_business_user','POST','/business/users',('userId',),semantics='submission')
op(v,'get_transaction_event','GET','/events/transaction/{eventId}',source=v['sources'][1])
op(v,'get_business_user_event','GET','/events/business/user/{eventId}',source=v['sources'][2])
v=vendor('namescan','https://api.namescan.io',{'type':'header','name':'api-key','keys':['API_KEY']},'https://api.namescan.io/doc/index.html?v=6',version='3.1')
v['headers']={'Content-Type':'application/json-patch+json'}
for subject in ['person','organisation']:
 for tier in ['emerald','sapphire']:
  op(v,f'create_{subject}_{tier}','POST',f'/v3.1/{subject}-scans/{tier}',semantics='screening')
  op(v,f'get_{subject}_{tier}','GET',f'/v3.1/{subject}-scans/{tier}/{{scanId}}',semantics='screening')
 op(v,f'{subject}_risk_check','POST',f'/v3.1/risk-check/{subject}',semantics='risk')
v=vendor('dilisense','https://api.dilisense.com',{'type':'header','name':'x-api-key','keys':['API_KEY']},['https://developers.dilisense.com/products/adverse-media-screening-api/','https://developers.dilisense.com/products/aml-database/','https://developers.dilisense.com/products/ongoing-monitoring/'])
for name,endpoint in [('individual_media','checkIndividual'),('entity_media','checkEntity'),('search_media','search')]:op(v,name,'GET','/v1/media/'+endpoint,query=('search_all',),semantics='screening')
op(v,'consolidated_file','GET','/v1/getConsolidatedFile',semantics='dataset',source=v['sources'][1])
op(v,'consolidated_delta','GET','/v1/getConsolidatedDelta',query=('previous',),semantics='dataset',source=v['sources'][1])
v=vendor('maxmind',{'production':'https://minfraud.maxmind.com','sandbox':'https://sandbox.maxmind.com'},{'type':'basic','keys':['ACCOUNT_ID','LICENSE_KEY']},['https://dev.maxmind.com/minfraud/api-documentation/requests/','https://dev.maxmind.com/minfraud/sandbox-environment/'],version='2.0')
for service in ['score','insights','factors']:op(v,service,'POST','/minfraud/v2.0/'+service,body={'device':{'ip_address':'128.101.101.101'}},semantics='risk',resource='/id')
v=vendor('ipinfo','https://api.ipinfo.io',{'type':'query','name':'token','keys':['TOKEN']},'https://ipinfo.io/developers/core-api')
op(v,'lookup','GET','/lookup/{ip}',semantics='network_data')
v=vendor('ipqs','https://www.ipqualityscore.com',{'type':'header','name':'ipqs-key','keys':['API_KEY']},'https://www.ipqualityscore.com/documentation/about-ipqs-apis/submitting-data-to-ipqs-apis')
for service in ['ip','email','phone']:op(v,service,'POST','/api/json/'+service+'/',(service,),semantics='risk')
v=vendor('telesign',{'standard':'https://rest-api.telesign.com','enterprise':'https://rest-ww.telesign.com'},{'type':'basic','keys':['CUSTOMER_ID','API_KEY']},['https://developer.telesign.com/standard/reference/score-api-get-started','https://developer.telesign.com/enterprise/docs/phone-id-tutorial-use-identity-attributes'])
op(v,'phone_score','POST','/v1/score/{phone}',('account_lifecycle_event',),body={'account_lifecycle_event':'create'},content='form',semantics='risk');v['operations']['phone_score']['regions']=['standard']
op(v,'phone_id','POST','/v1/phoneid/{phone}',body={'addons':{'contact':{}}},semantics='identity_data',source=v['sources'][1]);v['operations']['phone_id']['regions']=['enterprise']
v=vendor('middesk',{'production':'https://api.middesk.com/v1','sandbox':'https://api-sandbox.middesk.com/v1'},{'type':'basic','keys':['API_KEY'],'empty_password':True},['https://docs.middesk.com/build/api-keys','https://docs.middesk.com/online-presence/web-presence'])
op(v,'create_business','POST','/businesses',('name',),body={'name':'YOUR_BUSINESS_NAME','addresses':[{'full_address':'YOUR_ADDRESS'}]},semantics='submission',resource='/id',source=v['sources'][1])
op(v,'get_business','GET','/businesses/{id}',semantics='business_data',status='/status',resource='/id',source=v['sources'][1])
v=vendor('truelayer',{'production':'https://api.truelayer.com','sandbox':'https://api.truelayer-sandbox.com'},{'type':'header','name':'Authorization','prefix':'Bearer ','keys':['ACCESS_TOKEN']},['https://docs.truelayer.com/docs/account-and-card-data','https://docs.truelayer.com/reference/getaccount'])
op(v,'accounts','GET','/data/v1/accounts',semantics='account_data')
op(v,'account','GET','/data/v1/accounts/{account_id}',semantics='account_data',source=v['sources'][1])
op(v,'balance','GET','/data/v1/accounts/{account_id}/balance',semantics='account_data')
op(v,'transactions','GET','/data/v1/accounts/{account_id}/transactions',query=('from','to'),semantics='transaction_data')
v=vendor('yapily','https://api.yapily.com',{'type':'basic','keys':['APPLICATION_ID','APPLICATION_SECRET']},['https://docs.yapily.com/api-reference/financial-data/get-accounts','https://docs.yapily.com/api-reference/financial-data/get-account-transactions'])
op(v,'accounts','GET','/accounts',headers=('consent',),semantics='account_data')
op(v,'transactions','GET','/accounts/{accountId}/transactions',headers=('consent',),semantics='transaction_data',source=v['sources'][1])
v=vendor('belvo',{'production':'https://api.belvo.com','sandbox':'https://sandbox.belvo.com'},{'type':'basic','keys':['SECRET_ID','SECRET_PASSWORD']},'https://developers.belvo.com/products/aggregation_brazil/aggregation-brazil-integration-widget')
for service in ['owners','accounts','transactions','bills','investments','investment-transactions']:op(v,service.replace('-','_'),'GET','/api/'+service+'/',query=('link',),semantics='account_data')
v=vendor('gleif','https://api.gleif.org',{'type':'none','keys':[]},'https://api.gleif.org/docs',version='v1')
op(v,'search_lei','GET','/api/v1/lei-records',semantics='business_data')
op(v,'get_lei','GET','/api/v1/lei-records/{lei}',semantics='business_data',resource='/data/id')
v=vendor('opencorporates','https://api.opencorporates.com',{'type':'query','name':'api_token','keys':['API_TOKEN']},'https://api.opencorporates.com/documentation/API-Reference',version='v0.4')
op(v,'company_search','GET','/v0.4/companies/search',query=('q',),semantics='business_data')
op(v,'get_company','GET','/v0.4/companies/{jurisdiction}/{company_number}',semantics='business_data')
v=vendor('persona','https://api.withpersona.com',{'type':'header','name':'Authorization','prefix':'Bearer ','keys':['API_KEY']},'https://docs.withpersona.com/reference/introduction',version='2023-01-05')
v['headers']={'Persona-Version':'2023-01-05'}
op(v,'get_inquiry','GET','/api/v1/inquiries/{id}',semantics='identity_result',status='/data/attributes/status',resource='/data/id')
op(v,'create_inquiry','POST','/api/v1/inquiries',('data',),body={'data':{'attributes':{'inquiry-template-id':'YOUR_TEMPLATE_ID','reference-id':'YOUR_REFERENCE'}}},semantics='session',resource='/data/id')
v=vendor('sec-edgar','https://data.sec.gov',{'type':'header','name':'User-Agent','keys':['USER_AGENT']},'https://www.sec.gov/search-filings/edgar-application-programming-interfaces',notes='USER_AGENT must identify organization and contact email. Zero-pad CIK to 10 digits. SEC rate/fair-access rules apply.')
op(v,'submissions','GET','/submissions/CIK{cik}.json',semantics='business_data')
v=vendor('br-nn-ysund-register-centre','https://data.brreg.no',{'type':'none','keys':[]},'https://data.brreg.no/enhetsregisteret/api/docs/index.html')
op(v,'search_entities','GET','/enhetsregisteret/api/enheter',semantics='business_data')
op(v,'get_entity','GET','/enhetsregisteret/api/enheter/{organisasjonsnummer}',semantics='business_data')
v=vendor('prh','https://avoindata.prh.fi',{'type':'none','keys':[]},'https://avoindata.prh.fi/en/index.html',version='v3')
op(v,'search_companies','GET','/opendata-ytj-api/v3/companies',semantics='business_data')
v=vendor('ofac-sanctions-list-service','https://sanctionslistservice.ofac.treas.gov',{'type':'none','keys':[]},'https://ofac.treasury.gov/sanctions-list-service')
op(v,'download_sdn','GET','/api/PublicationPreview/exports/SDN.XML',semantics='dataset',response='xml')
v=vendor('un-security-council-consolidated-list','https://scsanctions.un.org',{'type':'none','keys':[]},'https://main.un.org/securitycouncil/en/content/un-sc-consolidated-list')
op(v,'download_consolidated','GET','/resources/xml/en/consolidated.xml',semantics='dataset',response='xml')
v=vendor('uk-sanctions-list','https://sanctionslist.fcdo.gov.uk',{'type':'none','keys':[]},'https://www.gov.uk/government/publications/the-uk-sanctions-list')
op(v,'download_consolidated','GET','/docs/UK-Sanctions-List.xml',semantics='dataset',response='xml')
v=vendor('truora','https://api.checks.truora.com',{'type':'header','name':'Truora-API-Key','keys':['API_KEY']},'https://docs.truora.com/')
op(v,'create_check','POST','/v1/checks',('country','type','user_authorized'),content='form',body={'country':'ALL','type':'person','user_authorized':True},semantics='submission',resource='/check_id')
op(v,'list_checks','GET','/v1/checks')
op(v,'get_check','GET','/v1/checks/{check_id}',semantics='check_result',status='/status',resource='/check_id')
op(v,'check_details','GET','/v1/checks/{check_id}/details',semantics='check_result')
v=vendor('twilio-lookup','https://lookups.twilio.com',{'type':'basic','keys':['ACCOUNT_SID','AUTH_TOKEN']},'https://support.twilio.com/hc/en-us/articles/360050891214-Getting-started-with-the-Twilio-lookup-API',version='v2')
op(v,'lookup_phone','GET','/v2/PhoneNumbers/{phone}',semantics='phone_data')
v=vendor('mono','https://api.withmono.com',{'type':'header','name':'mono-sec-key','keys':['SECRET_KEY']},'https://docs.mono.co/api/telco-data/integration-guide',version='v2')
op(v,'exchange_code','POST','/v2/accounts/auth',('code',),semantics='session')
op(v,'get_identity','GET','/v2/accounts/{id}/identity',semantics='identity_data')
v=vendor('fintoc','https://api.fintoc.com',{'type':'header','name':'Authorization','keys':['SECRET_API_KEY']},'https://docs.fintoc.com/docs/quickstart',version='v1')
op(v,'accounts','GET','/v1/accounts',query=('link_token',),semantics='account_data')
op(v,'movements','GET','/v1/accounts/{account_id}/movements',query=('link_token',),semantics='transaction_data')
# Vendor-owned pinned OpenAPI contracts; import only concrete operations, never invent endpoints.
orig=json.loads((P/'sources/openapi-origins.json').read_text())
profiles={
'incode':('https://demo-api.incodesmile.com',{'type':'header','name':'x-api-key','keys':['API_KEY']}),
'flinks':({}, {'type':'optional_header','name':'x-api-key','keys':['API_KEY'],'optional':True}),
'opensanctions':('https://api.opensanctions.org',{'type':'header','name':'Authorization','prefix':'ApiKey ','keys':['API_KEY']}),
'companies-house':('https://api.company-information.service.gov.uk',{'type':'basic','keys':['API_KEY'],'empty_password':True}),
'entrust-onfido':({'eu':'https://api.eu.onfido.com/v3.6','us':'https://api.us.onfido.com/v3.6','ca':'https://api.ca.onfido.com/v3.6'},{'type':'header','name':'Authorization','prefix':'Token token=','keys':['API_TOKEN']}),
'fingerprint':({'global':'https://api.fpjs.io/v4','eu':'https://eu.api.fpjs.io/v4','ap':'https://ap.api.fpjs.io/v4'},{'type':'header','name':'Authorization','prefix':'Bearer ','keys':['SECRET_API_KEY']}),
'mx':({'sandbox':'https://int-api.mx.com','production':'https://api.mx.com'},{'type':'basic','keys':['CLIENT_ID','API_KEY']}),
'plaid':({'sandbox':'https://sandbox.plaid.com','production':'https://production.plaid.com'},{'type':'multi_header','headers':{'PLAID-CLIENT-ID':'CLIENT_ID','PLAID-SECRET':'SECRET'},'keys':['CLIENT_ID','SECRET']})}
def resolve(spec,x):
 while isinstance(x,dict)and '$ref'in x:
  ref=x['$ref'];assert ref.startswith('#/'),ref;x=spec
  for k in ref[2:].split('/'):x=x[k.replace('~1','/').replace('~0','~')]
 return x
for id,(bases,auth)in profiles.items():
 spec=json.loads((P/f'schemas/{id}.json').read_text());v=vendor(id,bases,auth,orig[id]['url'],version=spec['info']['version']);v['openapi_file']=f'schemas/{id}.json'
 if id=='incode':v['headers']={'api-version':'1.0'}
 if id=='flinks':v['notes']='Set the customer-specific instance BASE_URL and approved HTTPS base. Optional x-api-key security is supported when enabled by Flinks. Session credentials and customerId remain native documented parameters.'
 if id=='plaid':v['headers']={'Plaid-Version':'2020-09-14'}
 if id=='mx':v['headers']={'Accept-Version':'v20250224'}
 for path,item in spec['paths'].items():
  item=resolve(spec,item)
  for method,o in item.items():
   if method not in ['get','post','put','patch','delete']:continue
   o=resolve(spec,o)
   if id=='incode'and '/api-key'in path:continue
   # Exclude payment/funds movement and unrelated administration from identity testing service.
   if id=='plaid'and not any(path.startswith('/'+s+'/')for s in ['identity','identity_verification','auth','accounts','item','link','institutions','asset_report','income','transactions','watchlist_screening','user','sandbox']):continue
   if id=='plaid'and any(x in path for x in ['/payment','transfer','deposit','wire','sweep','payroll_income','processor','credit/']):continue
   if id=='mx'and any(x in path for x in ['ach_returns','payment','money_movement','transfers','processor']):continue
   name=o.get('operationId')or method+'_'+re.sub(r'[^a-z0-9]+','_',path.lower()).strip('_')
   assert name not in v['operations'],(id,name)
   content=resolve(spec,o.get('requestBody',{})).get('content',{})
   if content:
    if 'application/json'in content:kind='json'
    elif 'multipart/form-data'in content:kind='multipart'
    elif 'application/x-www-form-urlencoded'in content:kind='form'
    else:continue
   else:kind='json'
   op(v,name,method.upper(),path,content=kind,semantics='vendor_native')
   z=v['operations'][name];z['openapi_path']=path;z['openapi_method']=method;z['summary']=o.get('summary','');z['body_required']=resolve(spec,o.get('requestBody',{})).get('required',False)
   z['parameters']=item.get('parameters',[])+o.get('parameters',[])
   if id=='incode':
    security=o.get('security',spec.get('security',[]));scheme_names=set(k for option in security for k in option)
    if 'IncodeHardwareIdAuth'in scheme_names:z['allowed_input_headers'].append('X-Incode-Hardware-Id')
    if 'BearerAuth'in scheme_names:z['allowed_input_headers'].append('Authorization')
   injected={'accept','content-type'}|{x.lower()for x in v.get('headers',{})}
   if auth['type']=='header':injected.add(auth['name'].lower())
   if auth['type']=='multi_header':injected.update(x.lower()for x in auth['headers'])
   if auth['type']=='basic':injected.add('authorization')
   for param in z['parameters']:
    param=resolve(spec,param)
    if param.get('in')=='header'and param.get('required')and param['name'].lower()not in injected and param['name']not in z['allowed_input_headers']:z['allowed_input_headers'].append(param['name'])
   names=re.findall(r'\{([^}]+)\}',path);declared=[resolve(spec,p)['name']for p in z['parameters']if resolve(spec,p).get('in')=='path']
   if len(names)==len(declared)and set(names)!=set(declared):
    for old,new in zip(names,declared):z['path']=z['path'].replace('{'+old+'}','{'+new+'}')
    z['source_placeholder_correction']={'original_path':path,'reason':'Vendor Swagger path placeholder names differ from its parameter declarations; HTTP route unchanged.'}
   if content:z['body_schema']=content[{'json':'application/json','multipart':'multipart/form-data','form':'application/x-www-form-urlencoded'}[kind]].get('schema',{})
   z['responses']=o.get('responses',{})
   if id=='entrust-onfido'and path.startswith('/reports'):z.update(semantics='identity_result',status_pointer='/result')
   if id=='entrust-onfido'and path.startswith('/checks'):z.update(semantics='identity_result',status_pointer='/status')
   if id=='plaid'and path.startswith('/identity_verification'):z.update(semantics='identity_result',status_pointer='/status')
   if id=='opensanctions'and path.startswith('/match'):z['semantics']='screening'
for id,v in vendors.items():(P/f'definitions/{id}.json').write_text(json.dumps(v,indent=2)+'\n')
print(len(vendors),'documented vendor clients;',sum(len(v['operations'])for v in vendors.values()),'concrete operations')
for id,v in vendors.items():print(id,len(v['operations']))
