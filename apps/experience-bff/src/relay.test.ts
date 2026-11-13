import {expect,it,vi} from 'vitest';
import {buildApp,servedOperations} from './app.js';
import {relayTarget,routePath} from './relay.js';
import type {Upstream} from './upstream.js';
import {createKycCaseRequestSchema,stableDigest} from '@ehf/contracts';
const principal={subjectId:'reviewer',tenantId:'tenant_verified',actorType:'human' as const,roles:['Case.Reviewer','Harness.Author'],source:'local' as const};

it('serves release records from the control API release envelopes', async () => {
  const record = {
    releaseId: 'release-1',
    manifestDigest: 'a'.repeat(64),
    status: 'candidate',
    revision: 1,
    activatedAt: null,
    deprecatedAt: null,
    revokedAt: null,
    reasonCode: null,
    updatedAt: '2026-11-11T12:00:00Z',
  };
  const upstream = vi.fn<Upstream>(async () => ({
    status: 200,
    body: { releases: [{ record, manifest: {}, createdBy: 'author', approvedBy: null }] },
  }));
  const app = buildApp({
    principalResolver: { source: 'local', resolve: async () => principal },
    upstream,
  });
  try {
    const response = await app.inject('/api/v1/releases');
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({ releases: [record], generatedAt: expect.any(String) });
  } finally {
    await app.close();
  }
});

it('binds human commands to verified session authority, preserving concurrency and idempotency',async()=>{
  const snapshot={tenantId:principal.tenantId,caseId:'case-test',caseSequence:7,planDigest:'a'.repeat(64),policyAuthority:{policySnapshotDigest:'b'.repeat(64)}};
  const upstream=vi.fn<Upstream>(async(_s,method)=>method==='GET'?{status:200,body:snapshot}:{status:200,body:{outcome:'ACCEPTED',commandId:'cmd-1',caseSequence:8}});
  const app=buildApp({env:{BFF_PUBLIC_ORIGIN:'http://ui.test',BFF_IDENTITY_MODE:'delegated'},principalResolver:{source:'local',resolve:async()=>principal},upstream});
  try {
    const session=await app.inject({url:'/api/v1/session',headers:{authorization:'Bearer delegated'}});
    const headers={cookie:String(session.headers['set-cookie']).split(';')[0]!,origin:'http://ui.test','x-csrf-token':session.json().csrfToken,'idempotency-key':'key-1'};
    const payload={commandType:'RecordReview',commandVersion:'1.0.0',payload:{},preconditions:{caseSequence:7,subjectRevision:null},idempotencyKey:'key-1',actor:{principalId:'forged'}};
    expect((await app.inject({method:'POST',url:'/api/v1/cases/case-test/commands',payload})).statusCode).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
    const response=await app.inject({method:'POST',url:'/api/v1/cases/case-test/commands',payload,headers});
    expect(response.statusCode,response.body).toBe(200);
    const sent=upstream.mock.calls.at(-1)!;
    expect(sent[4]).toMatchObject({tenantId:'tenant_verified',actor:{type:'HUMAN',principalId:'reviewer'},preconditions:{caseSequence:7},authority:{planDigest:snapshot.planDigest}});
    expect(sent[4]).not.toHaveProperty('preconditions.subjectRevision');
    expect(sent[5]).toMatchObject({'x-ehf-forwarded-authorization':'Bearer delegated','x-purpose':'interactive_ui','idempotency-key':'key-1'});
    payload.preconditions.caseSequence=6;
    upstream.mockImplementation(async(_s,method)=>method==='GET'?{status:200,body:snapshot}:{status:409,body:{error:'command.case_sequence_conflict',details:{expected:6,current:7}}});
    const stale=await app.inject({method:'POST',url:'/api/v1/cases/case-test/commands',payload,headers});
    expect(stale.statusCode).toBe(409);expect(stale.json().error).toBe('case.sequence_conflict');
    // A stale command the case store did not answer from a receipt is never reported as accepted.
    upstream.mockImplementation(async(_s,method)=>method==='GET'?{status:200,body:snapshot}:{status:200,body:{outcome:'ACCEPTED',caseId:'case-test',caseSequence:8,eventId:'evt-2'}});
    expect((await app.inject({method:'POST',url:'/api/v1/cases/case-test/commands',payload,headers})).statusCode).toBe(502);
  }finally{await app.close();}
});
it('answers an exact replay of a recorded command with its original receipt after the case has moved on',async()=>{
  const snapshot={tenantId:principal.tenantId,caseId:'case-test',caseSequence:7,planDigest:'a'.repeat(64),policyAuthority:{policySnapshotDigest:'b'.repeat(64)}};
  const receipts=new Map<string,{digest:string;response:Record<string,unknown>}>();
  // The case store's receipt rule: a held key answers before the sequence check, by request digest.
  const upstream=vi.fn<Upstream>(async(_s,method,_path,_p,body:any)=>{
    if(method==='GET')return {status:200,body:snapshot};
    const prior=receipts.get(body.idempotencyKey);
    if(prior)return prior.digest===stableDigest(body)?{status:200,body:{...prior.response,replayed:true}}:{status:409,body:{error:'command.idempotency_conflict'}};
    if(body.preconditions.caseSequence!==snapshot.caseSequence)return {status:409,body:{error:'command.case_sequence_conflict'}};
    const response={outcome:'ACCEPTED',caseId:'case-test',caseSequence:++snapshot.caseSequence,eventId:'evt-'+snapshot.caseSequence,eventDigest:'e'.repeat(64),createdIdentifiers:{}};
    receipts.set(body.idempotencyKey,{digest:stableDigest(body),response});
    return {status:200,body:response};
  });
  const app=buildApp({env:{BFF_PUBLIC_ORIGIN:'http://ui.test'},principalResolver:{source:'local',resolve:async()=>principal},upstream});
  try {
    const session=await app.inject('/api/v1/session');
    const headers={cookie:String(session.headers['set-cookie']).split(';')[0]!,origin:'http://ui.test','x-csrf-token':session.json().csrfToken};
    const payload={commandType:'RecordReview',commandVersion:'1.0.0',payload:{reviewType:'NOTE'},preconditions:{caseSequence:7},idempotencyKey:'key-replay'};
    const first=await app.inject({method:'POST',url:'/api/v1/cases/case-test/commands',payload,headers});
    expect(first.statusCode,first.body).toBe(200);
    expect(first.json()).toEqual({outcome:'ACCEPTED',commandId:expect.stringMatching(/^cmd_/),caseSequence:8,reasonCode:null,eventIds:['evt-8']});
    const replay=await app.inject({method:'POST',url:'/api/v1/cases/case-test/commands',payload,headers});
    expect(replay.statusCode,replay.body).toBe(200);expect(replay.json()).toEqual(first.json());
    const changed=await app.inject({method:'POST',url:'/api/v1/cases/case-test/commands',payload:{...payload,payload:{reviewType:'OTHER'}},headers});
    expect(changed.statusCode).toBe(409);expect(changed.json().error).toBe('command.idempotency_conflict');
    const stale=await app.inject({method:'POST',url:'/api/v1/cases/case-test/commands',payload:{...payload,idempotencyKey:'key-new'},headers});
    expect(stale.statusCode).toBe(409);expect(stale.json().error).toBe('case.sequence_conflict');
    expect(snapshot.caseSequence).toBe(8);
  }finally{await app.close();}
});
it('encodes identity segments while preserving action suffixes and query parameters',()=>{
  const meta=servedOperations().find(op=>op.operationId==='postIntegrationsBindingsBindingIdActivate')!;
  expect(relayTarget(meta,{params:{bindingId:'id /?#'},query:{q:'A&B'}})).toBe('/v1/integrations/bindings/id%20%2F%3F%23:activate?q=A%26B');
  expect(routePath(servedOperations().find(op=>op.operationId==='postAuthLogout')!)).toBe('/auth/logout');
});
it('passes binary exports and upstream failures without JSON parsing or status loss',async()=>{
  const upstream=vi.fn<Upstream>(async()=>({status:200,body:Buffer.from('%PDF-test'),headers:{'content-type':'application/pdf','content-disposition':'attachment; filename="test.pdf"'}}));
  const app=buildApp({principalResolver:{source:'local',resolve:async()=>principal},upstream});
  const response=await app.inject('/api/v1/cases/case-test/exports/'+'a'.repeat(64)+'/pdf');
  expect(response.statusCode,response.body).toBe(200);expect(response.body).toBe('%PDF-test');expect(response.headers['content-type']).toBe('application/pdf');
  upstream.mockResolvedValue({status:409,body:{error:'case.sequence_conflict'}});
  const stale=await app.inject('/api/v1/cases/case-test/snapshot');expect(stale.statusCode).toBe(409);expect(stale.json().error).toBe('case.sequence_conflict');expect(stale.json().correlationId).toBeTruthy();
  await app.close();
});
it('completes case creation with published policy pins and normalizes creation and replay',async()=>{
  const digest='a'.repeat(64);
  const upstream=vi.fn<Upstream>(async(_s,method)=>method==='GET'?{status:200,body:{planDigest:digest,policySnapshotDigest:'b'.repeat(64),policyAuthority:{policyId:'policy-test',policyVersion:'1.0.0',policyBundleDigest:'c'.repeat(64),dependencyDigest:'d'.repeat(64)}}}:{status:201,body:{created:true,case:{caseId:'new-case',caseSequence:1}}});
  const app=buildApp({env:{BFF_PUBLIC_ORIGIN:'http://ui.test'},principalResolver:{source:'local',resolve:async()=>({...principal,roles:['Case.Analyst']})},upstream});
  try {
    const session=await app.inject('/api/v1/session');
    const response=await app.inject({method:'POST',url:'/api/v1/cases',headers:{cookie:String(session.headers['set-cookie']).split(';')[0]!,origin:'http://ui.test','x-csrf-token':session.json().csrfToken,'idempotency-key':'create-intent'},payload:{caseType:'kyc_onboarding',harnessPlanDigest:digest,externalRef:null,classification:'CONFIDENTIAL'}});
    expect(response.statusCode,response.body).toBe(201);expect(response.json()).toEqual({caseId:'new-case',caseSequence:1});
    expect(createKycCaseRequestSchema.safeParse(upstream.mock.calls.at(-1)![4]).success).toBe(true);
    expect(upstream.mock.calls.at(-1)![5]?.['idempotency-key']).toBe('create-intent');
  }finally{await app.close();}
});
it('matches literal action suffixes at the HTTP boundary',async()=>{
  const upstream=vi.fn<Upstream>(async()=>({status:409,body:{error:'integration.test_conflict'}}));
  const app=buildApp({env:{BFF_PUBLIC_ORIGIN:'http://ui.test'},principalResolver:{source:'local',resolve:async()=>({...principal,roles:['Harness.Operator','Platform.Admin','Harness.Author']})},upstream});
  try {
    const session=await app.inject('/api/v1/session');
    const response=await app.inject({method:'POST',url:'/api/v1/integrations/bindings/binding-7:activate',headers:{cookie:String(session.headers['set-cookie']).split(';')[0]!,origin:'http://ui.test','x-csrf-token':session.json().csrfToken},payload:{}});
    expect(response.statusCode,response.body).toBe(409);
    expect(upstream.mock.calls[0]?.[2]).toBe('/v1/integrations/bindings/binding-7:activate');
  }finally{await app.close();}
});
it('keeps unreported gateway metrics unknown instead of presenting zero traffic or a successful connection test',async()=>{
  const upstream:Upstream=async()=>({status:200,body:{readiness:'Ready',openRouterState:'Configured',openSanctionsState:'Missing',runtimeMode:'OpenRouter',envelopeVerifierStatus:'Configured',generatedAt:'2026-11-09T12:00:00Z',kycWiringState:'Not configured'}});
  const app=buildApp({principalResolver:{source:'local',resolve:async()=>({...principal,roles:['Harness.Author']})},upstream});
  const response=await app.inject('/api/v1/gateway/status');expect(response.statusCode,response.body).toBe(200);
  expect(response.json()).toMatchObject({calls24h:null,denials24h:null,lastConnectionTestAt:null,telemetryFreshThrough:null});await app.close();
});

it('relays Recon separately from the case room and requires CSRF on requests', async () => {
  const actor = { ...principal, roles: ['Case.Analyst'] };
  const upstream = vi.fn<Upstream>(async (_service, method) => ({
    status: 200, body: { status: method === 'POST' ? 'queued' : 'idle', canRequest: method === 'GET', brief: null },
  }));
  const app = buildApp({ env: { BFF_PUBLIC_ORIGIN: 'http://ui.test' }, principalResolver: { source: 'local', resolve: async () => actor }, upstream });
  const url = '/api/v1/fincrime/cases/case-test/recon';
  try {
    const session = await app.inject('/api/v1/session');
    const read = await app.inject(url);
    expect(read.statusCode, read.body).toBe(200);
    expect(read.json()).toEqual({ status: 'idle', canRequest: true, brief: null });
    expect((await app.inject({ method: 'POST', url })).statusCode).toBe(403);
    const headers = { cookie: String(session.headers['set-cookie']).split(';')[0]!, origin: 'http://ui.test', 'x-csrf-token': session.json().csrfToken };
    const queued = await app.inject({ method: 'POST', url, headers });
    expect(queued.statusCode, queued.body).toBe(200);
    expect(queued.json()).toEqual({ status: 'queued', canRequest: false, brief: null });
    const live = await app.inject({ method: 'POST', url: url + '?mode=live', headers });
    expect(live.statusCode, live.body).toBe(200);
    expect(upstream.mock.calls.map(call => call.slice(0, 4))).toEqual([
      ['case-api', 'GET', '/v1/cases/case-test/recon', actor],
      ['case-api', 'POST', '/v1/cases/case-test/recon', actor],
      ['case-api', 'POST', '/v1/cases/case-test/recon?mode=live', actor],
    ]);
  } finally {
    await app.close();
  }
});
