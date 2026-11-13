import {readFileSync} from 'node:fs';
import {expect,it,vi} from 'vitest';
import {validateResponse} from '@ehf/ui-contracts/validate';
import {buildApp} from './app.js';
import type {Upstream} from './upstream.js';
const artifact=JSON.parse(readFileSync(new URL('../../fincrime-host/catalog/ehf-catalog.json',import.meta.url),'utf8'));
const source={...JSON.parse(artifact.content),catalogDigest:artifact.sha256};
const principal={subjectId:'author',tenantId:'tenant_verified',actorType:'human' as const,roles:['Harness.Author'],source:'local' as const};
it('loads a source catalog → agent → pinned skill → task journey with real projections and conditional reads',async()=>{
  const upstream=vi.fn<Upstream>(async(_s,_m,path)=>({status:200,body:path==='/v1/context/catalog'?source:{drafts:[],records:[],cases:[]}}));
  const app=buildApp({principalResolver:{source:'local',resolve:async()=>principal},upstream});
  try {
    const atlas=await app.inject('/api/v1/fincrime/agents');
    expect(atlas.statusCode,atlas.body).toBe(200);expect(validateResponse('getFincrimeAgents',200,atlas.json()).valid).toBe(true);
    const agent=atlas.json().agents[0].agent;
    expect(atlas.json().agents[0].runtimeObserved).toBe(false);
    const detail=await app.inject('/api/v1/fincrime/agents/'+agent.id);
    expect(detail.statusCode,detail.body).toBe(200);
    expect(validateResponse('getFincrimeAgentsAgentId',200,detail.json()).valid).toBe(true);
    const skill=Object.keys(agent.execution.allowed_skills)[0]!;
    const contract=await app.inject('/api/v1/fincrime/skills/'+skill);
    expect(contract.statusCode,contract.body).toBe(200);expect(contract.json().summary.version).toBe(contract.json().manifest.semver);
    const task=await app.inject('/api/v1/fincrime/tasks/'+agent.task_ids[0]);
    expect(task.statusCode,task.body).toBe(200);expect(validateResponse('getFincrimeTasksTaskId',200,task.json()).valid).toBe(true);
    expect((await app.inject({url:'/api/v1/fincrime/skills/'+skill,headers:{'if-none-match':contract.headers.etag!}})).statusCode).toBe(304);
    const search=await app.inject('/api/v1/search?q=ownership');
    expect(search.statusCode,search.body).toBe(200);expect(validateResponse('getSearch',200,search.json()).valid).toBe(true);
    expect(search.json().groups.some((g:any)=>g.kind==='skill')).toBe(true);
    expect(upstream.mock.calls.every(c=>c[3].tenantId==='tenant_verified')).toBe(true);
  }finally{await app.close();}
});
it('does not query a denied source and exposes an outage as a recoverable contract-shaped error',async()=>{
  const upstream=vi.fn<Upstream>(async()=>({status:503,body:{error:'storage.unavailable'}}));
  const app=buildApp({principalResolver:{source:'local',resolve:async()=>({...principal,roles:['Case.Analyst']})},upstream});
  expect((await app.inject('/api/v1/fincrime/agents')).statusCode).toBe(403);expect(upstream).not.toHaveBeenCalled();await app.close();
  const authorized=buildApp({principalResolver:{source:'local',resolve:async()=>principal},upstream});
  const response=await authorized.inject('/api/v1/fincrime/agents');expect(response.statusCode).toBe(503);
  expect(response.json()).toMatchObject({retryable:true,error:'catalog.source_unavailable'});expect(response.json().correlationId).toBeTruthy();await authorized.close();
});
