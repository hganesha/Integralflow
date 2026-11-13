// Run from this checkout: node --import tsx docs/audits/2026-11-09-ui/implementation/verify.mts
import {readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {buildApp,servedOperations} from '../../../../apps/experience-bff/src/app.ts';
import {routePath} from '../../../../apps/experience-bff/src/relay.ts';
import {UNAVAILABLE} from '../../../../apps/experience-bff/src/availability.ts';
import {presentationFor} from '../../../../apps/web/src/presentation/model.ts';
import {ICON_PATHS} from '../../../../packages/ui-kit/src/icon/sprite.ts';
const out=dirname(fileURLToPath(import.meta.url));const root=resolve(out,'../../../..');
const read=(p:string)=>readFileSync(join(root,p),'utf8');
const snapshot=JSON.parse(read('apps/fincrime-host/docs/ui/contracts/fixtures/catalogs.json'));
const entries=snapshot.entries as any[];
const inventory=entries.filter(e=>['skills','external-capabilities','documents'].includes(e.kind));
const missing=inventory.filter(e=>{const p=presentationFor(e.kind,e.id);return !p.known||['grid','layers','help'].includes(p.icon)||!(p.icon in ICON_PATHS);}).map(e=>e.id);
const walk=(dir:string):string[]=>readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(join(dir,e.name)):[join(dir,e.name)]);
const css=['apps/web/src','packages/ui-kit/src','packages/ui-shell/src'].flatMap(d=>walk(join(root,d)).filter(p=>p.endsWith('.css'))).map(p=>({path:p,text:readFileSync(p,'utf8')}));
const declared=new Set(['--object-color','--extraction-width',...Array.from((read('packages/ui-tokens/src/generated/tokens.css')+css.map(c=>c.text).join('\n')).matchAll(/(--[\w-]+)\s*:/g),m=>m[1]!)]);
const undefinedTokens=[...new Set(css.flatMap(c=>Array.from(c.text.matchAll(/var\((--[\w-]+)/g),m=>m[1]!).filter(t=>!declared.has(t))))];
const rawPaletteFiles=css.filter(c=>/var\(--(?:graphite|porcelain|emerald)-/.test(c.text)).map(c=>c.path.slice(root.length+1));
const routeSource=read('apps/web/src/platform/routes.ts')+read('apps/web/src/domains/fincrime/module.ts');
const patterns=[...Array.from(routeSource.matchAll(/(?:r|p|later)\("([^\"]+)"/g),m=>m[1]!),'/catalogs','/catalogs/$kind','/catalogs/$kind/$entryId','/'];
const routeExists=(url:string)=>patterns.some(p=>new RegExp('^'+p.replace(/\$\w+/g,'[^/]+')+'$').test(url.split(/[?#]/)[0]!));
const brokenWorkspaceLinks=entries.filter(e=>e.workspace&&!routeExists(e.workspace)).map(e=>e.id);
const ids=new Set(entries.map(e=>e.kind+':'+e.id));
const danglingRelationships=entries.flatMap(e=>e.relationships.filter((r:any)=>!ids.has(r.kind+':'+r.id)).map((r:any)=>({from:e.id,to:r.id})));
const navSource=read('apps/web/src/platform/routes.ts').split('export const PLATFORM_NAV')[1]!;
const navIds=Array.from(navSource.matchAll(/id: "([^"]+)"/g),m=>m[1]!);
const app=buildApp();await app.ready();
const missingRoutes=servedOperations().filter(op=>!app.hasRoute({method:op.method,url:routePath(op)})).map(op=>op.operationId);
const result={verifiedAt:new Date().toISOString(),baseHead:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),workingTree:'Isolated UI product-polish PR branch; see PR-VALIDATION.md for validation scope.',
  catalogs:{entries:entries.length,mappedPresentationEntries:inventory.length,skillCount:inventory.filter(e=>e.kind==='skills').length,capabilityDefinitions:inventory.filter(e=>e.kind==='external-capabilities'&&e.entryType==='definition').length,providerBindings:inventory.filter(e=>e.entryType==='binding').length,documentTypes:inventory.filter(e=>e.kind==='documents'&&e.entryType==='definition').length,documentFields:inventory.filter(e=>e.kind==='documents'&&e.entryType==='field').length,documentCategories:new Set(inventory.filter(e=>e.kind==='documents').map(e=>e.group)).size,missingPresentation:missing,spriteIcons:Object.keys(ICON_PATHS).length},
  tokens:{undefinedTokens,rawPaletteFiles},navigation:{brokenWorkspaceLinks,danglingRelationships,duplicateNavIds:navIds.filter((id,i)=>navIds.indexOf(id)!==i)},
  bff:{nonMockOperations:servedOperations().length,missingRoutes,unavailable:UNAVAILABLE,note:'Registration coverage is not proof of live service behavior. See HTTP journey tests and the documented unavailable operations.'}};
writeFileSync(join(out,'verification.json'),JSON.stringify(result,null,2)+'\n');await app.close();
if(missing.length||undefinedTokens.length||rawPaletteFiles.length||brokenWorkspaceLinks.length||danglingRelationships.length||missingRoutes.length||result.navigation.duplicateNavIds.length)throw new Error('UI acceptance inventory failed; inspect verification.json');
console.log(JSON.stringify({mappedEntries:inventory.length,missingIcons:missing.length,undefinedTokens:undefinedTokens.length,brokenWorkspaceLinks:brokenWorkspaceLinks.length,registeredOperations:servedOperations().length,explicitlyUnavailable:Object.keys(UNAVAILABLE).length}));
