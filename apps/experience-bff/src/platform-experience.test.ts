import {readFileSync} from 'node:fs';
import {expect,it,vi} from 'vitest';
import {PLATFORM_SETTING_DEFAULTS, PLATFORM_SETTING_FIELDS, PLATFORM_SETTING_SCOPES} from '@ehf/contracts';
import {validateResponse} from '@ehf/ui-contracts/validate';
import {buildApp} from './app.js';
import type {Upstream} from './upstream.js';
const plan=JSON.parse(readFileSync(new URL('../../../artifacts/kyb-agentic.plan.json',import.meta.url),'utf8'));
const now='2026-11-09T12:00:00Z';
const run={runId:'run-test',idempotencyKey:'intent',planDigest:plan.planDigest,status:'queued',terminalOutcome:null,input:{},output:null,attempt:0,fencingEpoch:0,latestCheckpointId:null,currentNodeId:null,errorCode:null,traceId:null,rootSpanId:null,traceFlags:null,costUsd:0,costComplete:true,modelCalls:0,capabilityCalls:0,createdAt:now,startedAt:null,completedAt:null,updatedAt:now};
it('projects actual admitted plans, run records and execution without fixture-only UI data',async()=>{
  const upstream=vi.fn<Upstream>(async(_s,_m,path)=>({status:200,body:path.startsWith('/v1/plan-records')?{records:[{plan,admittedAt:now}],nextCursor:null}:path.endsWith('/execution')?{run,plan,attempts:[]}:path.startsWith('/v1/runs?')?{runs:[run],nextCursor:null}:plan}));
  const app=buildApp({principalResolver:{source:'local',resolve:async()=>({subjectId:'reader',tenantId:'tenant-verified',actorType:'human',roles:['Harness.Reader'],source:'local'})},upstream});
  try {
    for(const [operation,url] of [['getPlans','/api/v1/plans'],['getPlansPlanDigest','/api/v1/plans/'+plan.planDigest],['getRuns','/api/v1/runs'],['getRunsRunId','/api/v1/runs/run-test'],['getRunsRunIdExecution','/api/v1/runs/run-test/execution']]) {
      const result=await app.inject(url!);expect(result.statusCode,operation+': '+result.body).toBe(200);expect(validateResponse(operation!,200,result.json()).valid).toBe(true);
    }
    expect(upstream.mock.calls.every(c=>c[3].tenantId==='tenant-verified')).toBe(true);
  }finally{await app.close();}
});

it('resolves a saved plan link beyond the first admission page',async()=>{
  const upstream=vi.fn<Upstream>(async(_service,_method,path)=>({status:200,body:
    path==='/v1/plan-records?limit=100'?{records:[],nextCursor:'older/admissions'}:
    path==='/v1/plan-records?limit=100&cursor=older%2Fadmissions'?{records:[{plan,admittedAt:now}],nextCursor:null}:
    path.startsWith('/v1/runs?')?{runs:[],nextCursor:null}:null}));
  const app=buildApp({principalResolver:{source:'local',resolve:async()=>({subjectId:'reader',tenantId:'tenant-verified',actorType:'human',roles:['Harness.Reader'],source:'local'})},upstream});
  try {
    const response=await app.inject('/api/v1/plans/'+plan.planDigest);
    expect(response.statusCode,response.body).toBe(200);
    expect(response.json()).toMatchObject({planDigest:plan.planDigest,admittedAt:now,runs:0});
    expect(upstream.mock.calls.some(call=>call[2].includes('cursor=older%2Fadmissions'))).toBe(true);
  }finally{await app.close();}
});

it('relays platform settings with JSON field descriptors', async () => {
  const sections = (['gateway', 'runtime', 'observability'] as const).map(section => ({
    section,
    value: PLATFORM_SETTING_DEFAULTS[section],
    source: 'default',
    updatedAt: null,
    updatedBy: null,
    ...PLATFORM_SETTING_SCOPES[section],
    deploymentManaged: section !== 'gateway',
    fields: PLATFORM_SETTING_FIELDS[section].map(field => ({ ...field, envPresent: false })),
  }));
  const app = buildApp({
    principalResolver: {
      source: 'local',
      resolve: async () => ({ subjectId: 'admin', tenantId: 'tenant-verified', actorType: 'human', roles: ['Platform.Admin'], source: 'local' }),
    },
    upstream: async () => ({ status: 200, body: { sections } }),
  });
  try {
    const response = await app.inject('/api/v1/admin/settings');
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().items).toEqual(sections);
  } finally {
    await app.close();
  }
});
