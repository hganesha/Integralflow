// Read-only audit diagnostic. Run from repository root with `node docs/audits/2026-11-09-ui/check-wiring.mjs`.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildApp } from '../../../apps/experience-bff/src/app.ts';
import { OPERATIONS } from '../../../packages/ui-contracts/src/generated/operations.ts';

const out = 'docs/audits/2026-11-09-ui';
console.error('Audit: imports loaded');
function files(dir: string): string[] { return readdirSync(dir, {withFileTypes:true}).flatMap(e => e.isDirectory() ? files(join(dir,e.name)) : [join(dir,e.name)]); }
const sources = files('apps/web/src').filter(f=>/\.[tj]sx?$/.test(f) && !/\.(test|spec)\./.test(f));
const sourceText = sources.map(file => ({file,text:readFileSync(file,'utf8')}));
console.error(`Audit: read ${sourceText.length} UI sources`);
const app = buildApp();
await app.ready();
console.error('Audit: BFF ready');
const operations = OPERATIONS.map(op => {
  const route = '/api'+op.path.replace(/\{([^}]+)\}/g, ':$1');
  return {...op, registered: app.hasRoute({method:op.method,url:route}), alternateUnprefixedRoute:op.path.startsWith('/auth/') && app.hasRoute({method:op.method,url:op.path}), uiFiles:sourceText.filter(f=>f.text.includes(op.operationId)).map(f=>f.file)};
});
const probes = [];
for (const url of ['/api/v1/search?q=ownership','/api/v1/fincrime/agents','/api/v1/fincrime/skills/ownership.ubo.resolve','/api/v1/runs','/api/v1/cases','/api/v1/human-work','/api/v1/admin/runtime']) {
  const result = await app.inject({method:'GET',url});
  probes.push({url,status:result.statusCode,body:result.json()});
}
for (const url of ['/api/auth/logout','/auth/logout']) {
  const result = await app.inject({method:'POST',url});
  probes.push({url,status:result.statusCode,body:result.json()});
}
const catalog = buildApp({
  principalResolver:{source:'local',resolve:async()=>({subjectId:'audit',tenantId:'tenant_demo',actorType:'human',roles:['Harness.Author'],source:'local'})},
  catalogSource:()=>JSON.parse(readFileSync('apps/fincrime-host/docs/ui/contracts/fixtures/catalogs.json','utf8')),
  upstream:async()=>({status:503,body:{error:'audit.simulated_registry_outage'}}),
});
await catalog.ready();
const outageProbes=[];
for (const url of ['/api/v1/catalogs','/api/v1/catalogs?kind=skills&limit=1']) {
  const result=await catalog.inject({method:'GET',url});
  outageProbes.push({url,status:result.statusCode,error:result.json().error??null});
}
await catalog.close();
const summary = { declared:operations.length, nonMock:operations.filter(o=>!o.mockOnly).length, registeredNonMock:operations.filter(o=>!o.mockOnly&&o.registered).length, missingNonMock:operations.filter(o=>!o.mockOnly&&!o.registered).length, missingAnyRoute:operations.filter(o=>!o.mockOnly&&!o.registered&&!o.alternateUnprefixedRoute).length, authBaseMismatches:operations.filter(o=>!o.registered&&o.alternateUnprefixedRoute).length, directlyReferenced:operations.filter(o=>o.uiFiles.length).length, missingDirectlyReferenced:operations.filter(o=>!o.mockOnly&&o.uiFiles.length&&!o.registered).length };
writeFileSync(out+'/bff-operation-coverage.json',JSON.stringify({summary,probes,outageProbes,operations},null,2)+'\n');
writeFileSync(out+'/bff-routes.txt',app.printRoutes());
console.log(JSON.stringify({summary,probes,outageProbes},null,2));
await app.close();
