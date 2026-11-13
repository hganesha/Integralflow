"""Locate public specs on official-homepage-linked documentation hosts.
Discovery only; no client or maturity is asserted until a contract is reviewed.
"""
from concurrent.futures import ThreadPoolExecutor,as_completed
from pathlib import Path
from urllib.parse import urlsplit
import requests,json,hashlib,yaml
P=Path(__file__).resolve().parents[1]/'vendor_connections';rows=json.loads((P/'sources/discovery.json').read_text());existing={f.stem for f in (P/'definitions').glob('*.json')};jobs=[];seen=set()
for r in rows:
 if r['provider_id']in existing:continue
 for u in r['documentation_links']:
  h=urlsplit(u)
  if not h.hostname or h.hostname in ['chatgpt.com','claude.ai','www.linkedin.com']or h.query:continue
  if not any(x in h.hostname for x in ['docs.','developer.','developers.','api-reference.','apideveloper.']):continue
  root='https://'+h.netloc
  if root in seen:continue
  seen.add(root)
  for path in ['/openapi.json','/openapi.yaml','/swagger.json','/swagger/v1/swagger.json','/v3/api-docs']:
   jobs.append((r['provider_id'],root+path))
def get(job):
 id,u=job
 try:
  r=requests.get(u,timeout=(2,5),headers={'Accept':'application/json, application/yaml'},stream=True);raw=b''
  if r.status_code!=200:return None
  for b in r.iter_content(65536):
   raw+=b
   if len(raw)>6_000_000:r.close();return None
  if b'<html'in raw[:2000].lower()or b'<!doctype'in raw[:2000].lower():return None
  s=yaml.safe_load(raw)
  if not isinstance(s,dict)or not isinstance(s.get('paths'),dict)or not isinstance(s.get('info'),dict)or not(s.get('openapi')or s.get('swagger')):return None
  name='discovered-'+id+'-'+hashlib.sha256(u.encode()).hexdigest()[:10]+'.json';(P/'schemas'/name).write_text(json.dumps(s,indent=2,default=str)+'\n')
  return {'provider_id':id,'url':u,'schema_file':name,'sha256':hashlib.sha256(raw).hexdigest(),'title':s['info'].get('title'),'servers':s.get('servers'),'host':s.get('host'),'security':s.get('security'),'security_schemes':s.get('components',{}).get('securitySchemes',s.get('securityDefinitions',{})),'paths':len(s['paths']),'review_status':'discovered_not_implemented'}
 except Exception:return None
found=[]
with ThreadPoolExecutor(max_workers=40)as pool:
 for f in as_completed([pool.submit(get,j)for j in jobs]):
  r=f.result()
  if r:found.append(r);print(json.dumps(r))
(P/'sources/public-spec-discovery.json').write_text(json.dumps({'urls_attempted':len(jobs),'found':found},indent=2)+'\n');print('Attempted',len(jobs),'found',len(found))
