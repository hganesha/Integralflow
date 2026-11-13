from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
import requests,json,hashlib
from bs4 import BeautifulSoup
P=Path(__file__).resolve().parents[1]/'vendor_connections';urls=sorted(set(u for f in (P/'definitions').glob('*.json')for u in json.loads(f.read_text())['sources']if 'raw.githubusercontent.com'not in u))
def fetch(u):
 try:
  r=requests.get(u,timeout=(4,12));text=BeautifulSoup(r.content,'html.parser').get_text(' ',strip=True);digest=hashlib.sha256(r.content).hexdigest();name=hashlib.sha256(u.encode()).hexdigest()[:20]+'.txt';return {'url':u,'http_status':r.status_code,'final_url':r.url,'sha256':digest,'retrieved_at':'2026-10-15'}
 except Exception as e:return {'url':u,'error':type(e).__name__}
with ThreadPoolExecutor(max_workers=24)as pool:rows=list(pool.map(fetch,urls))
(P/'sources/official-doc-evidence.json').write_text(json.dumps(rows,indent=2)+'\n')
for x in rows:print(x.get('http_status',x.get('error')),x['url'])
