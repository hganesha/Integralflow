"""Read-only asset, category, token, and source-route inventory for this audit."""
import collections
import hashlib
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
OUT = Path(__file__).resolve().parent
def read(path): return (ROOT / path).read_text()
def save(name, value): (OUT / name).write_text(json.dumps(value, indent=2) + '\n')

snapshot = json.loads(read('apps/fincrime-host/docs/ui/contracts/fixtures/catalogs.json'))
entries = snapshot['entries']
icons = re.findall(r'^  "([^"]+)":', read('packages/ui-kit/src/icon/sprite.ts'), re.M)
paths = {m[0]:json.loads(m[1]) for m in re.findall(r'^  "([^"]+)": ("(?:\\.|[^"\\])*"),?$', read('packages/ui-kit/src/icon/sprite.ts'), re.M)}
source_files = [p for base in ['apps/web/src','packages/ui-kit/src','packages/ui-shell/src','packages/ui-tokens/src'] for p in (ROOT/base).rglob('*') if p.is_file() and p.suffix in ['.ts','.tsx'] and not re.search(r'\.(test|spec)\.',p.name) and p.name!='sprite.ts']
text_by_file = {str(p.relative_to(ROOT)):p.read_text() for p in source_files}
uses = {icon:[{'file':p,'literalOccurrences':len(re.findall(r'[\'\"]'+re.escape(icon)+r'[\'\"]',t))} for p,t in text_by_file.items() if re.search(r'[\'\"]'+re.escape(icon)+r'[\'\"]',t)] for icon in icons}
duplicates = collections.defaultdict(list)
for name,path in paths.items(): duplicates[path].append(name)
save('icon-usage-inventory.json',{'note':'String-literal references include typed presentation maps and generated state maps, not only JSX. No-reference candidates are not proven unused when names may arrive dynamically.','icons':[{'name':icon,'literalReferences':uses[icon]} for icon in icons],'noLiteralReferenceCandidates':[i for i in icons if not uses[i]],'duplicatePathNames':[names for names in duplicates.values() if len(names)>1]})
groups = {}
for kind in ['skills', 'external-capabilities']:
    rows = [e for e in entries if e['kind'] == kind]
    groups[kind] = {t: dict(sorted(collections.Counter(e['group'] for e in rows if e['entryType'] == t).items())) for t in sorted(set(e['entryType'] for e in rows))}
assets = [p for base in ['apps/web/src', 'apps/web/icons', 'apps/fincrime-host/docs/ui/assets', 'packages/ui-kit/src'] for p in (ROOT / base).rglob('*') if p.is_file() and p.suffix.lower() in ['.svg','.png','.jpg','.jpeg','.webp','.gif','.ico','.woff2']]
save('asset-category-inventory.json', {'sourceRelease':snapshot['sourceRelease'], 'counts':dict(collections.Counter(e['kind'] for e in entries)), 'entryTypeCounts':{k:dict(collections.Counter(e['entryType'] for e in entries if e['kind']==k)) for k in sorted(set(e['kind'] for e in entries))},'groups':groups, 'sprite':icons, 'spriteCount':len(icons), 'assets':[{'path':str(p.relative_to(ROOT)),'bytes':p.stat().st_size} for p in assets], 'entriesWithoutCategory':[{'kind':e['kind'],'id':e['id']} for e in entries if not e.get('group')], 'skillAndCapabilityTitlesWithoutIconMetadata':sum(1 for e in entries if e['kind'] in groups and not e.get('icon'))})

# A reviewable proposal, not a change to the running UI. Reuse product-owned assets.
category_icons = {'AML':'shield','Alert':'bell','Case':'inbox','Decision':'gavel','Document':'copy','EDD':'searchcheck','Entity':'building','Evidence':'file','Fraud':'scan','Investigation':'search','Monitor':'activity','Monitoring':'activity','Network':'graph','Ownership':'branch','Party':'users','Quality':'checkcircle','Registry':'database','Regulatory':'scale','Risk':'gauge','Screening':'shieldcheck','Transaction':'swap','Account':'lock','Business':'building','Credential':'lock','Crypto':'hash','Financial':'table','Identity':'fingerprint','Platform':'cpu','Questionnaire':'file','Reference':'book','Travel rule':'globe','Workflow':'workflow'}
proposals = [{'kind':e['kind'],'entryType':e['entryType'],'id':e['id'],'title':e['title'],'category':e['group'],'icon':category_icons[e['group']],'rationale':'Inherit the descriptive category icon; add an explicit item override only when it improves recognition.'} for e in entries if e['kind'] in groups]
assert all(p['icon'] in icons for p in proposals)
save('proposed-icon-map.json', {'status':'proposal; not applied','categoryIcons':category_icons,'coverage':dict(collections.Counter(e['entryType'] for e in proposals)), 'entries':proposals})

css = [p for base in ['apps/web/src','packages/ui-kit/src','packages/ui-shell/src'] for p in (ROOT / base).rglob('*.css')]
generated = read('packages/ui-tokens/src/generated/tokens.css')
declared = set(re.findall(r'(--[\w-]+)\s*:',generated))
all_declared = declared | {v for p in css for v in re.findall(r'(--[\w-]+)\s*:',p.read_text())}
undefined = collections.defaultdict(list)
literals = []
raw_palette = []
for p in css:
    for n,line in enumerate(p.read_text().splitlines(),1):
        for token in re.findall(r'var\((--[\w-]+)',line):
            if token not in all_declared: undefined[token].append({'file':str(p.relative_to(ROOT)),'line':n,'fallback':bool(re.search(r'var\('+re.escape(token)+r'\s*,',line))})
        if re.search(r'#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(',line): literals.append({'file':str(p.relative_to(ROOT)),'line':n,'text':line.strip()})
        if re.search(r'var\(--(?:porcelain|graphite|emerald|amber|crimson|cobalt)-',line): raw_palette.append({'file':str(p.relative_to(ROOT)),'line':n,'text':line.strip()})
save('token-inventory.json', {'cssFiles':len(css),'generatedTokens':len(declared),'undefinedReferences':dict(undefined),'runtimePropertiesConfirmedInTsx':['--extraction-width','--object-color'],'unresolvedDesignTokens':['--font-body','--space-7'],'literalColorLines':literals,'directPaletteLines':raw_palette,'tokenSourceHashes':{p:hashlib.sha256((ROOT/p).read_bytes()).hexdigest() for p in ['apps/fincrime-host/docs/ui/tokens.json','packages/ui-tokens/vendor/tokens.json']}})

route_source = read('apps/web/src/platform/routes.ts') + read('apps/web/src/domains/fincrime/module.ts')
patterns = set(re.findall(r'(?:r|p|later)\("([^\"]+)"',route_source)) | {'/','/catalogs','/catalogs/$kind','/catalogs/$kind/$entryId'}
def route_exists(path):
    path = path.split('?')[0].split('#')[0].rstrip('/') or '/'
    return any(re.fullmatch(re.sub(r'\$\w+',r'[^/]+',p),path) for p in patterns)
workspaces = [{'kind':e['kind'],'id':e['id'],'workspace':e['workspace'],'registeredPattern':route_exists(e['workspace'])} for e in entries if e.get('workspace')]
lookup = {(e['kind'],e['id']) for e in entries}
dangling = [{'fromKind':e['kind'],'fromId':e['id'],'target':r} for e in entries for r in e['relationships'] if (r['kind'],r['id']) not in lookup]
save('catalog-link-inventory.json',{'routePatterns':sorted(patterns),'workspaceLinks':len(workspaces),'unmatchedWorkspaceRoutes':[e for e in workspaces if not e['registeredPattern']],'danglingRelationships':dangling,'workspaces':workspaces})
print(json.dumps({'iconCount':len(icons),'categories':{k:{t:len(g) for t,g in v.items()} for k,v in groups.items()},'cssFiles':len(css),'undefinedTokens':list(undefined),'literalColorLines':len(literals),'directPaletteLines':len(raw_palette),'workspaceLinks':len(workspaces),'unmatchedWorkspaceRoutes':sum(not e['registeredPattern'] for e in workspaces),'danglingRelationships':len(dangling)},indent=2))
