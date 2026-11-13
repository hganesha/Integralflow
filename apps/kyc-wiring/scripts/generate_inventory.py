"""Export every binding and an explicitly disabled native-contract template."""
import sys,json,csv
from pathlib import Path
P=Path(__file__).resolve().parents[1];sys.path.insert(0,str(P))
from wiring.core import Settings,Registry
s=Settings.env();r=Registry(s);rows=r.readiness();templates={}
for op in rows:
 templates[op['operation_id']]={'enabled':False,'approved':False,'maturity':'proposed','provider_id':op['provider_id'],'capability':op['capability'],'connector':'native_subset' if op['fixture_normalizer'] in ['persona','companies_house','opencorporates','gleif','opensanctions','plaid'] else 'declarative','base_url':None,'approved_base_urls':[],'method':None,'path':None,'product':None,'api_version':None,'mapping_version':None,'tenant_ids':[],'countries':[],'residency_regions':[],'processing_regions':[],'purposes':[],'legal_bases':[],'policy_refs':[],'upstream_datasets':[],'entitlement_ref':None,'required_secret_env':[],'request_template':None,'response_template':None,'async_mode':'sync','missing_inputs':op['blockers']}
(P/'config/connection-templates.json').write_text(json.dumps(templates,indent=2)+'\n')
(P/'docs/connection-readiness.json').write_text(json.dumps(rows,indent=2)+'\n')
with (P/'docs/connection-readiness.csv').open('w',newline='') as f:
 w=csv.DictWriter(f,fieldnames=list(rows[0]));w.writeheader();w.writerows([{**x,'blockers':'; '.join(x['blockers'])} for x in rows])
from openpyxl import Workbook
from openpyxl.styles import Font,PatternFill,Alignment
w=Workbook();ws=w.active;ws.title='All connection bindings';ws.append(list(rows[0]))
for x in rows:ws.append([ '; '.join(v) if isinstance(v,list) else v for v in x.values()])
ws.freeze_panes='C2';ws.auto_filter.ref=ws.dimensions
for cell in ws[1]:cell.font=Font(color='FFFFFF',bold=True);cell.fill=PatternFill('solid',fgColor='17334A')
for col,width in {'A':65,'B':34,'C':34,'D':37,'E':25,'F':20,'G':25,'H':18,'I':85}.items():ws.column_dimensions[col].width=width
for row in ws.iter_rows(min_row=2):
 for c in row:c.alignment=Alignment(wrap_text=True,vertical='top')
 ws.row_dimensions[row[0].row].height=45
summary=w.create_sheet('Read me');summary.append(['Metric','Value']);summary.append(['Catalog records',len(r.providers)]);summary.append(['Capability bindings',len(rows)]);summary.append(['Simulatable bindings',sum(x['demo_supported'] for x in rows)]);summary.append(['Quarantined bindings',sum(not x['demo_supported'] for x in rows)]);summary.append(['Live-ready external integrations',sum(x['live_ready'] for x in rows)]);summary.append(['Documented subset HTTP connectors implemented',6]);summary.append(['Fixture normalizers',9]);summary.append(['Important','Platform wiring is runnable; external vendor connections remain incomplete pending contracts, credentials, mapping and sandbox acceptance.']);summary.column_dimensions['A'].width=55;summary.column_dimensions['B'].width=110
w.save(P/'Connection_Readiness.xlsx')
print('Exported',len(rows),'bindings;',sum(x['demo_supported'] for x in rows),'simulatable;',sum(x['live_ready'] for x in rows),'live-ready')
