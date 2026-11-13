"""Export honest every-record coverage and editable real-call request collections."""
from pathlib import Path
import sys,json,csv,hashlib,re
from openpyxl import Workbook
from openpyxl.styles import Font,PatternFill,Alignment
P=Path(__file__).resolve().parents[1];sys.path.insert(0,str(P))
from vendor_connections.client import definitions,prefix
from vendor_connections.api import inventory
clients=definitions();rows=inventory();count=sum(len(v['operations'])for v in clients.values())
(P/'docs/vendor-connection-coverage.json').write_text(json.dumps({'catalog_records':len(rows),'implemented_records':len(clients),'native_operations':count,'remaining_unimplemented':len(rows)-len(clients),'live_tested':0,'items':rows},indent=2)+'\n')
cols=['provider_id','provider_name','category','implementation_status','implemented_operations','live_tested','homepage_url','documentation_sources','gap']
flat=[]
for r in rows:
 d={k:r.get(k,'')for k in cols};d['documentation_sources']=' | '.join(d['documentation_sources']);flat.append(d)
with (P/'docs/vendor-connection-coverage.csv').open('w',newline='')as f:
 w=csv.DictWriter(f,fieldnames=cols);w.writeheader();w.writerows(flat)
wb=Workbook();ws=wb.active;ws.title='Every catalog record';ws.append(cols)
for r in flat:ws.append([r[k]for k in cols])
ws.freeze_panes='A2';ws.auto_filter.ref=ws.dimensions
for c in ws[1]:c.font=Font(color='FFFFFF',bold=True);c.fill=PatternFill('solid',fgColor='123A4A')
for col,width in zip('ABCDEFGHI',[33,36,31,28,24,16,55,80,90]):ws.column_dimensions[col].width=width
for row in ws.iter_rows(min_row=2):
 for cell in row:cell.alignment=Alignment(vertical='top',wrap_text=True)
 for cell in row:
  if row[3].value=='implemented_unverified':cell.fill=PatternFill('solid',fgColor='E3F3EC')
  elif row[3].value=='quarantined':cell.fill=PatternFill('solid',fgColor='F9D6D6')
ws=wb.create_sheet('Implemented operations');ws.append(['provider_id','operation_id','method','path','maturity','source','content_type','semantics'])
for id,v in clients.items():
 for name,o in v['operations'].items():ws.append([id,name,o['method'],o['path'],v['maturity'],o['source'],o['content'],o['semantics']])
ws.freeze_panes='A2';ws.auto_filter.ref=ws.dimensions
for c in ws[1]:c.font=Font(color='FFFFFF',bold=True);c.fill=PatternFill('solid',fgColor='123A4A')
for col,width in zip('ABCDEFGH',[33,52,14,75,28,85,18,24]):ws.column_dimensions[col].width=width
ws=wb.create_sheet('Read me');notes=[['Metric','Value'],['Catalog records',len(rows)],['Implemented documented vendor/source clients',len(clients)],['Concrete native operations',count],['Unimplemented catalog records',len(rows)-len(clients)],['Externally tested',0],['Important','Not all vendors are connected. Partial per-vendor endpoint coverage; maturity is implemented_unverified.'],['Testing','No prior sandbox maturity required in explicit private vendor-test profile.'],['Production','Existing approval gates are unchanged. No production readiness or bank decision is implied.'],['Normalization','Common envelope for supported calls; selected deep mappings only. Native fields remain restricted evidence.'],['Gaps','Documentation-link discovery is not implementation or proof that public docs are unavailable.'],['Quarantine','The unimplemented remainder includes one historical quarantined provider record.']]
for r in notes:ws.append(r)
ws.column_dimensions['A'].width=55;ws.column_dimensions['B'].width=120
for row in ws:
 for c in row:c.alignment=Alignment(wrap_text=True,vertical='top')
wb.save(P/'Vendor_Connection_Coverage.xlsx')
secrets=['# EXAMPLE ONLY. Put actual values in your PRIVATE .provider-secrets.env, never in source control.','# Host/testing enablement belongs in shell/Compose configuration. See docs/Vendor_Testing_Guide.md.']
folders=[];examples={}
for vendor,v in sorted(clients.items()):
 pre=prefix(vendor);secrets+=['',f'# {vendor}; version {v["version"]}; '+('optional credential'if v['auth'].get('optional')else 'required credentials')]
 secrets +=[pre+k+'='for k in v['auth']['keys']]
 if not v['bases']:secrets +=[pre+'BASE_URL=',pre+'APPROVED_BASE_URLS_JSON=[]']
 items=[]
 for name,o in v['operations'].items():
  body={'purpose':'vendor_integration_test','request_id':'REPLACE_WITH_UNIQUE_REQUEST_ID','subject_entity_id':'YOUR_TEST_SUBJECT','path':{k:'REPLACE_WITH_'+k for k in re.findall(r'\{([^}]+)\}',o['path'])},'query':{k:'REPLACE_WITH_'+k for k in o['required_query']},'headers':{k:'REPLACE_WITH_'+k for k in o['allowed_input_headers']}}
  if v['bases']:body['region']=o.get('regions',[next(iter(v['bases']))])[0]
  if o['body_example']is not None:body['body']=o['body_example']
  elif o['required_body']:body['body']={k:'REPLACE_WITH_NATIVE_VALUE'for k in o['required_body']}
  elif o.get('body_required'):body['body']={'REPLACE_WITH_DOCUMENTED_NATIVE_BODY':True}
  if o['content']=='multipart':body['files']={'REPLACE_WITH_NATIVE_FILE_FIELD':{'filename':'test.jpg','base64':'REPLACE_WITH_TEST_FILE_BASE64','content_type':'image/jpeg'}}
  item={'name':name,'request':{'method':'POST','header':[{'key':'Authorization','value':'Bearer {{host_token}}'},{'key':'Content-Type','value':'application/json'},{'key':'Idempotency-Key','value':'{{$guid}}'}],'url':'{{base_url}}/v1/vendor-connections/'+vendor+'/operations/'+name+'/invoke','description':f'REAL OUTBOUND CALL. Native {o["method"]} {o["path"]}. Edit placeholders to vendor-valid test data. No external validation performed. Source: {o["source"]}','body':{'mode':'raw','raw':json.dumps(body,indent=2),'options':{'raw':{'language':'json'}}}}}
  items.append(item)
  examples[vendor+':'+name]=body
 folders.append({'name':vendor,'description':v['notes']+' Partial operation coverage; not live tested.','item':items})
collection={'info':{'name':'Documented vendor connections — PRIVATE REAL CALLS','schema':'https://schema.getpostman.com/json/collection/v2.1.0/collection.json','description':'732 actual native operation wrappers, not simulations. Edit native fields using the referenced vendor docs/schema. Running this collection can incur vendor fees and create upstream resources. Never run it indiscriminately. Each invocation gets a NEW key: repeating Send can create another upstream resource. Use a fixed key yourself to test idempotent replay.'},'variable':[{'key':'base_url','value':'http://localhost:8000'},{'key':'host_token','value':'REPLACE_WITH_YOUR_PRIVATE_HOST_TOKEN'}],'item':folders}
(P/'docs/Documented_Vendor_Connections.postman_collection.json').write_text(json.dumps(collection,indent=2)+'\n')
(P/'config/vendor-native-input.examples.json').write_text(json.dumps(examples,indent=2)+'\n')
(P/'config/vendor-secrets.env.example').write_text('\n'.join(secrets)+'\n')
orig=json.loads((P/'vendor_connections/sources/openapi-origins.json').read_text())
for k,r in orig.items():
 f=P/'vendor_connections/schemas'/f'{k}.json'
 if f.exists():r['bundled_schema_sha256']=hashlib.sha256(f.read_bytes()).hexdigest()
(P/'vendor_connections/sources/openapi-origins.json').write_text(json.dumps(orig,indent=2)+'\n')
print('Exported:',len(rows),'records;',len(clients),'implemented;',count,'operations;',len(rows)-len(clients),'unimplemented')
