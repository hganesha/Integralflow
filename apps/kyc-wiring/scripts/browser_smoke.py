"""Optional browser test. Install playwright and chromium + OS deps separately.
Run against an already-running demo service only. Not part of runtime requirements.
"""
from playwright.sync_api import sync_playwright
from pathlib import Path
import json,os
P=Path(__file__).resolve().parents[1]
with sync_playwright() as p:
 browser=p.chromium.launch(headless=True,args=['--no-sandbox'])
 page=browser.new_page(viewport={'width':1440,'height':1080})
 errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
 page.goto(os.getenv('BROWSER_TEST_URL','http://127.0.0.1:8000/'),wait_until='networkidle')
 page.wait_for_function("document.querySelector('#bindings').textContent === '824'")
 assert page.locator('#ready').inner_text()=='0'
 page.locator('#run').click();page.wait_for_function("document.querySelector('#resultTag').textContent.startsWith('completed')",timeout=15000)
 assert 'not_evaluated' in page.locator('#output').inner_text()
 page.screenshot(path=str(P/'docs/console-desktop.png'),full_page=True)
 page.locator('#events').click();page.wait_for_function("document.querySelector('#resultTag').textContent==='Tenant event stream'")
 page.set_viewport_size({'width':390,'height':844});page.screenshot(path=str(P/'docs/console-mobile.png'),full_page=True)
 assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), 'Mobile horizontal overflow'
 report={'desktop_console_loaded':True,'binding_count':824,'live_ready':0,'synthetic_check_completed':True,'bank_decision':'not_evaluated','event_stream_visible':True,'mobile_overflow':False,'javascript_errors':errors}
 (P/'docs/browser-test-results.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report))
 browser.close()
