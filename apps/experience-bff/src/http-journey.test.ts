import Fastify from 'fastify';
import {readFileSync} from 'node:fs';
import {expect,it} from 'vitest';
import {buildApp} from './app.js';
const artifact=JSON.parse(readFileSync(new URL('../../fincrime-host/catalog/ehf-catalog.json',import.meta.url),'utf8'));
const catalog={...JSON.parse(artifact.content),catalogDigest:artifact.sha256};
it('runs the catalog/agent/skill journey over HTTP with the edge credential and delegated user context',async()=>{
  const control=Fastify();const requests:Record<string,unknown>[]=[];
  control.addHook('onRequest',async request=>{requests.push(request.headers);});
  control.get('/v1/context/catalog',async()=>catalog);
  control.get('/v1/authoring/drafts',async()=>({drafts:[]}));
  control.get('/v1/plan-records',async()=>({records:[]}));
  control.get('/v1/runs',async()=>({runs:[]}));
  const controlOrigin=await control.listen({port:0,host:'127.0.0.1'});
  const edge=buildApp({env:{CONTROL_API_INTERNAL_URL:controlOrigin,EDGE_SERVICE_TOKEN:'edge-only-test-token',BFF_IDENTITY_MODE:'delegated'},
    principalResolver:{source:'local',resolve:async()=>({subjectId:'verified-author',tenantId:'verified-tenant',actorType:'human',roles:['Harness.Author'],source:'local'})}});
  const edgeOrigin=await edge.listen({port:0,host:'127.0.0.1'});
  try {
    const headers={authorization:'Bearer user-test-token','x-tenant-id':'spoofed','x-actor-id':'spoofed'};
    const atlas=await fetch(edgeOrigin+'/api/v1/fincrime/agents',{headers});expect(atlas.status).toBe(200);
    const card=(await atlas.json() as any).agents[0];
    const profile=await fetch(edgeOrigin+'/api/v1/fincrime/agents/'+card.agent.id,{headers});expect(profile.status).toBe(200);
    const id=Object.keys(card.agent.execution.allowed_skills)[0]!;
    const skill=await fetch(edgeOrigin+'/api/v1/fincrime/skills/'+id,{headers});expect(skill.status).toBe(200);
    expect((await skill.json() as any).manifest.id).toBe(id);
    expect(requests.every(h=>h.authorization==='Bearer edge-only-test-token'&&h['x-tenant-id']==='verified-tenant'&&h['x-actor-id']==='verified-author'&&h['x-ehf-forwarded-authorization']==='Bearer user-test-token')).toBe(true);
    expect(requests.every(h=>h['x-correlation-id']&&h['x-purpose']==='interactive_ui')).toBe(true);
    const etag=skill.headers.get('etag')!;
    expect((await fetch(edgeOrigin+'/api/v1/fincrime/skills/'+id,{headers:{...headers,'if-none-match':etag}})).status).toBe(304);
    const overview=await fetch(edgeOrigin+'/api/v1/overview',{headers});expect(overview.status).toBe(200);expect((await overview.json() as any).limitations.length).toBeGreaterThan(0);
  }finally{await edge.close();await control.close();}
});
