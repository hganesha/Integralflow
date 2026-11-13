from pathlib import Path
from concurrent.futures import ThreadPoolExecutor,as_completed
from urllib.parse import urljoin,urlsplit
import requests,json,re,hashlib
from bs4 import BeautifulSoup
P=Path(__file__).resolve().parents[1]
rows=json.loads((P/'vendor/atlas/catalog/providers.json').read_text())
cache={};allurls=sorted(set(x['reference_url'] for x in rows if not x['routing_eligibility'].startswith('quarantined')))
def get(url):
 try:
  r=requests.get(url,timeout=(3,7),headers={'User-Agent':'Mozilla/5.0'},stream=True);raw=b''
  for chunk in r.iter_content(65536):
   raw+=chunk
   if len(raw)>750000:break
  r.close();soup=BeautifulSoup(raw,'html.parser');links=[]
  for a in soup.find_all('a',href=True):
   href=urljoin(r.url,a['href']);label=a.get_text(' ',strip=True);h=urlsplit(href)
   if h.scheme=='https' and re.search(r'(developer|documentation|api.reference|apidocs|docs\.)',href+' '+label,re.I) and not re.search(r'(blog|linkedin|twitter|facebook|youtube|careers|mailto)',href,re.I):links.append(href.split('#')[0])
  text=soup.get_text(' ',strip=True)
  return {'url':url,'final_url':r.url,'status':r.status_code,'title':soup.title.get_text(' ',strip=True) if soup.title else '', 'sha256':hashlib.sha256(raw).hexdigest(),'documentation_links':sorted(set(links))[:12]}
 except Exception as e:return {'url':url,'status':None,'error':type(e).__name__,'documentation_links':[]}
with ThreadPoolExecutor(max_workers=32) as pool:
 for f in as_completed([pool.submit(get,u) for u in allurls]):
  r=f.result();cache[r['url']]=r
out=[]
for r in rows:
 d=cache.get(r['reference_url'],{});out.append({'provider_id':r['provider_id'],'provider_name':r['name'],'category':r['category'],'family_id':r['family_id'],'homepage_status':d.get('status'),'homepage_url':r['reference_url'],'documentation_links':d.get('documentation_links',[]),'implementation_status':'not_implemented','restriction':'quarantined' if r['routing_eligibility'].startswith('quarantined') else None})
(P/'vendor_connections/sources/discovery.json').write_text(json.dumps(out,indent=2)+'\n')
(P/'vendor_connections/sources/homepage-evidence.json').write_text(json.dumps(list(cache.values()),indent=2)+'\n')
print('Homepages attempted:',len(cache),'records with doc links:',sum(bool(x['documentation_links']) for x in out))
for x in out:
 if x['documentation_links']:print(x['provider_name'],'|',' | '.join(x['documentation_links'][:3]))
