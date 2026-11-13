"""Download and locally bundle vendor-owned OpenAPI documents. Build-time network only."""
from pathlib import Path
from urllib.parse import urljoin,urldefrag
from concurrent.futures import ThreadPoolExecutor
import requests,yaml,json,hashlib,copy
P=Path(__file__).resolve().parents[1]/'vendor_connections';orig=json.loads((P/'sources/openapi-origins.json').read_text())
urls={
'companies-house':'https://developer-specs.company-information.service.gov.uk/api.ch.gov.uk-specifications/swagger-2.0/spec/swagger.json',
'entrust-onfido':'https://raw.githubusercontent.com/onfido/onfido-openapi-spec/master/openapi.yaml',
'fingerprint':'https://raw.githubusercontent.com/fingerprintjs/openapi/main/schemas/fingerprint-server-api-v4.yaml',
'mx':'https://raw.githubusercontent.com/mxenabled/openapi/master/openapi/v20250224.yml'}
for vendor,url in urls.items():
 docs={};pending={url}
 def fetch(u):
  r=requests.get(u,timeout=20);r.raise_for_status();text=r.text.replace('http://127.0.0.1:10000/','https://developer-specs.company-information.service.gov.uk/') if vendor=='companies-house' else r.text;return u,yaml.safe_load(text),hashlib.sha256(r.content).hexdigest()
 while pending:
  with ThreadPoolExecutor(max_workers=20)as pool:
   for u,obj,digest in pool.map(fetch,pending):docs[u]=(obj,digest)
  def refs(o,base):
   if isinstance(o,dict):
    if '$ref'in o:
     u,frag=urldefrag(urljoin(base,o['$ref']))
     if u not in docs:yield u
    for v in o.values():yield from refs(v,base)
   elif isinstance(o,list):
    for v in o:yield from refs(v,base)
  pending=set(u for base,(obj,_)in list(docs.items())for u in refs(obj,base))
 keys={u:'doc_'+hashlib.sha256(u.encode()).hexdigest()[:16]for u in docs}
 def rewrite(o,base):
  if isinstance(o,dict):
   result={k:rewrite(v,base)for k,v in o.items()}
   if '$ref'in o:
    u,frag=urldefrag(urljoin(base,o['$ref']));result['$ref']='#/$defs/'+keys[u]+frag
   return result
  if isinstance(o,list):return [rewrite(v,base)for v in o]
  return o
 root=rewrite(docs[url][0],url);root['$defs']={keys[u]:rewrite(o,u)for u,(o,_)in docs.items()}
 (P/f'schemas/{vendor}.json').write_text(json.dumps(root,indent=2,default=str)+'\n')
 orig[vendor]={'url':url,'source_files':[{'url':u,'sha256':d}for u,(_,d)in docs.items()]}
 print(vendor,'bundled',len(docs),'official source files')
(P/'sources/openapi-origins.json').write_text(json.dumps(orig,indent=2)+'\n')
