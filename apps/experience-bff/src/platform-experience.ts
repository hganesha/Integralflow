import type { FastifyInstance } from 'fastify';
import { actionsForRoles } from '@ehf/identity';
import { validateResponse } from '@ehf/ui-contracts/validate';
import type { sessionAccess } from './session.js';
import { delegatedHeaders, errorResponse } from './relay.js';
import { UpstreamError, type Upstream } from './upstream.js';

type Row=Record<string,any>;
const page=(items:unknown[],nextCursor:string|null=null)=>({items,nextCursor,generatedAt:new Date().toISOString()});
const pick=(row:Row,keys:string[])=>Object.fromEntries(keys.map(key=>[key,row[key]]));
export const caseSummary=(row:Row)=>({...pick(row,['tenantId','caseId','caseType','jurisdiction','status','caseSequence','harnessPlanDigest','classification','createdAt','updatedAt']),externalRef:row.externalRef??''});
export function runSummary(run:Row,plan:Row) {
  return {...pick(run,['runId','planDigest','currentNodeId','attempt','fencingEpoch','modelCalls','capabilityCalls','rootSpanId','traceId','updatedAt']),
    status:run.status==='cancelled'?'failed':run.status,terminalOutcome:run.status==='cancelled'?'cancelled':run.terminalOutcome,
    harnessName:plan.metadata.name,packageVersion:plan.metadata.version,domain:plan.metadata.domain,
    modelTiers:plan.modelProfiles.map((p:Row)=>p.id),cost:{reportedUsd:run.costUsd,complete:run.costComplete},
    durationMs:run.completedAt&&run.startedAt?Date.parse(run.completedAt)-Date.parse(run.startedAt):null,
    startedAt:run.startedAt??run.createdAt,fixture:false,traceViewerUrl:run.traceId?`/platform/traces/${run.traceId}`:null,
    needsAttention:['manual_review','denied','failed'].includes(run.status)};
}
function planView(plan:Row,admittedAt:string) {
  return {schemaVersion:plan.apiVersion,planDigest:plan.planDigest,name:plan.metadata.name,packageVersion:plan.metadata.version,domain:plan.metadata.domain,
    objective:plan.metadata.objective,compilerVersion:plan.compiler.version,admittedAt,
    inputSchema:plan.schemas.input,outputSchema:plan.schemas.output,
    terminalOutcomes:(plan.terminalOutcomes??[]).map((outcome:any)=>typeof outcome==='string'?{code:outcome,label:outcome,description:outcome,category:outcome==='denied'?'denied':outcome==='manual_review'?'manual_review':'completed'}:outcome),
    failurePolicy:{defaultAction:plan.failurePolicy?.defaultAction??'Not declared in this plan',retryBackoff:plan.failurePolicy?.retry?JSON.stringify(plan.failurePolicy.retry):'Not declared in this plan',fencingMode:'Lease epoch',effectSafeGuard:'Execution envelope'},
    budgets:{...plan.budgets,maxRetries:Math.max(0,...plan.capabilities.map((c:Row)=>(c.maxAttempts??1)-1)),maxConcurrency:plan.execution.maxConcurrency},
    dependencies:plan.dependencyManifest.map((d:Row)=>({packageId:d.id,version:'Pinned by digest',digest:d.digest,kind:['schema','adapter','policy_envelope','evaluator','source'].includes(d.kind)?d.kind:'source'})),
    nodes:plan.graph.nodes.map((node:Row,index:number)=>{
      const envelope=plan.permissionEnvelopes.find((e:Row)=>e.nodeId===node.id);
      const capability=plan.capabilities.find((c:Row)=>c.id===node.config?.capabilityId);
      const effects=envelope?.effects??[];
      const effectClass=effects.some((e:string)=>['external','reversible','paid','destructive'].includes(e))?'external_mutation':effects.includes('read')?'read_only':'none';
      return {id:node.id,name:node.name??node.id,primitive:node.kind,purpose:node.summary??node.config?.purpose??'',x:(index%3)*320,y:Math.floor(index/3)*200,
        effectClass,allowedEffects:effects,permissionEnvelopeDigest:envelope?.digest??'',timeoutMs:capability?.timeoutMs??0,maxRetries:(capability?.maxAttempts??1)-1,maxCostUsd:0,
        inputSchema:node.inputSchema??{},outputSchema:node.outputSchema??{},caseWrites:(node.config?.caseWrites??[]).map((write:Row)=>({commandType:write.commandType,payloadSchema:write.payloadSchema??{}})),
        ...(node.config?.agentRef?{agentRef:node.config.agentRef}:{}),...(node.config?.skillId?{skillRefs:[node.config.skillId]}:{})};
    }),
    edges:plan.graph.edges.map((edge:Row,index:number)=>({id:edge.id??`edge-${index}`,from:edge.from,to:edge.to,mappingSummary:edge.sourcePath||edge.targetPath?`${edge.sourcePath??''} → ${edge.targetPath??''}`:'',...(edge.condition?{conditionLabel:typeof edge.condition==='string'?edge.condition:JSON.stringify(edge.condition)}:{})}))};
}
export function registerPlatformExperience(app:FastifyInstance,access:ReturnType<typeof sessionAccess>,upstream:Upstream,env:NodeJS.ProcessEnv) {
  const routes=[
    ['getPlans','/v1/plans','plan.read'],['getPlansPlanDigest','/v1/plans/:planDigest','plan.read'],
    ['getRuns','/v1/runs','run.read'],['getPlansPlanDigestRuns','/v1/plans/:planDigest/runs','run.read'],
    ['getRunsRunId','/v1/runs/:runId','run.read'],['getRunsRunIdExecution','/v1/runs/:runId/execution','run.read'],
    ['getRunsRunIdEvents','/v1/runs/:runId/events','event.read'],['getCases','/v1/cases','case.read'],
    ['getGatewayProfiles','/v1/gateway/profiles','capability.read'],
  ] as const;
  for(const [operation,path,action] of routes)app.get('/api'+path,async(request,reply)=>{
    reply.header('cache-control','no-store').header('x-correlation-id',request.id);
    try {
      const principal=await access.resolver.resolve(request);
      if(principal.actorType!=='human'||!actionsForRoles(principal.roles).has(action))throw new UpstreamError(403,'authorization.role_missing');
      const headers=delegatedHeaders(request,access,env);
      const get=async(service:Parameters<Upstream>[0],path:string)=>{
        const result=await upstream(service,'GET',path,principal,undefined,headers);
        if(result.status>=400)throw new UpstreamError(result.status,result.body?.error??'bff.upstream_unavailable');
        return result.body;
      };
      const params=request.params as Record<string,string>;
      const query=request.query as Record<string,string>;
      const search=new URLSearchParams(Object.entries(query).filter(([key])=>['cursor','limit','planDigest','status'].includes(key)));
      let body:any;
      if(operation==='getGatewayProfiles') {
        const [result,status]=await Promise.all([get('capability-gateway','/v1/model-profiles'),get('capability-gateway','/v1/status')]);
        body=page(result.profiles.map((p:Row)=>({tierId:p.id,version:String(p.revision??p.version??'Not declared'),purpose:p.purpose??'Governed model routing',profileDigest:p.digest??'',resolvedOpenRouterModel:p.model,
          maxInputTokens:p.maxInputTokens??0,maxOutputTokens:p.maxOutputTokens,timeoutMs:p.timeoutMs,concurrencyLimit:p.maxConcurrency,
          enabled:p.providerStatus? p.providerStatus==='active':true,credentialState:p.credentialState??status.openRouterState,lastSuccessAt:null})));
      } else if(operation==='getCases') {
        const result=await get('case-api','/v1/cases?'+search);
        body=page(result.cases.map(caseSummary),result.nextCursor??null);
      } else if(operation==='getRunsRunIdExecution') {
        const result=await get('control-api',`/v1/runs/${encodeURIComponent(params.runId!)}/execution`);
        body={...result,plan:{planDigest:result.plan.planDigest,graph:{nodes:result.plan.graph.nodes.map((n:Row)=>({id:n.id,name:n.name??n.id,kind:n.kind,summary:n.summary??'',config:n.config})),edges:result.plan.graph.edges.map((e:Row,i:number)=>({id:e.id??`edge-${i}`,from:e.from,to:e.to,condition:typeof e.condition==='string'?e.condition:JSON.stringify(e.condition??'')}))}},
          attempts:result.attempts.map((a:Row)=>({...pick(a,['nodeId','attempt','fencingEpoch','status','startedAt','completedAt','errorCode','inputDigest','outputDigest','traceId']),humanReview:a.humanReview??null}))};
      } else if(operation==='getRunsRunIdEvents') {
        const result=await get('control-api',`/v1/runs/${encodeURIComponent(params.runId!)}/events?${new URLSearchParams(query)}`);
        body={events:result.events,nextCursor:result.nextCursor??null};
      } else if(operation==='getRuns'||operation==='getPlansPlanDigestRuns') {
        if(params.planDigest)search.set('planDigest',params.planDigest);
        const result=await get('control-api','/v1/runs?'+search);
        const plans=new Map<string,Row>();
        await Promise.all([...new Set<string>(result.runs.map((r:Row)=>r.planDigest))].map(async id=>plans.set(id,await get('control-api','/v1/plans/'+encodeURIComponent(id)))));
        body=page(result.runs.filter((r:Row)=>!query.status||r.status===query.status).map((r:Row)=>runSummary(r,plans.get(r.planDigest)!)),result.nextCursor??null);
      } else if(operation==='getRunsRunId') {
        const result=await get('control-api',`/v1/runs/${encodeURIComponent(params.runId!)}/execution`);
        body={...runSummary(result.run,result.plan),idempotencyKey:result.run.idempotencyKey,inputPayload:result.run.input,
          plan:planView(result.plan,''),events:[],nodeAttempts:{},failureInfo:null};
      } else {
        let records=await get('control-api','/v1/plan-records?'+(params.planDigest?'limit=100':search));
        // A saved plan link must work even after newer admissions move it off the first page.
        const seenRecordCursors=new Set<string>();
        while(params.planDigest&&!records.records.some((record:Row)=>record.plan.planDigest===params.planDigest)&&records.nextCursor) {
          const cursor=String(records.nextCursor);
          if(seenRecordCursors.has(cursor))throw new UpstreamError(502,'pagination.cursor_repeated');
          seenRecordCursors.add(cursor);
          records=await get('control-api','/v1/plan-records?'+new URLSearchParams({limit:'100',cursor}));
        }
        const rows=records.records as Row[];
        const summaries=await Promise.all(rows.filter(r=>!params.planDigest||r.plan.planDigest===params.planDigest).map(async record=>{
          const plan=record.plan;
          // No runtime totals are inferred from a single page.
          let cursor:string|undefined;const runs:Row[]=[];const seen=new Set<string>();
          do {const result=await get('control-api',`/v1/runs?planDigest=${encodeURIComponent(plan.planDigest)}&limit=100${cursor?'&cursor='+encodeURIComponent(cursor):''}`);runs.push(...result.runs);cursor=result.nextCursor??undefined;if(cursor&&seen.has(cursor))throw new UpstreamError(502,'pagination.cursor_repeated');if(cursor)seen.add(cursor);}while(cursor);
          const completed=runs.filter(r=>r.status==='completed');
          const durations=completed.filter(r=>r.startedAt&&r.completedAt).map(r=>Date.parse(r.completedAt)-Date.parse(r.startedAt)).sort((a,b)=>a-b);
          const value={planDigest:plan.planDigest,name:plan.metadata.name,packageVersion:plan.metadata.version,domain:plan.metadata.domain,objective:plan.metadata.objective,compilerVersion:plan.compiler.version,admittedAt:record.admittedAt,
            nodeCount:plan.graph.nodes.length,edgeCount:plan.graph.edges.length,modelTiers:plan.modelProfiles.map((m:Row)=>m.id),capabilityCount:plan.capabilities.length,effectfulCapabilityCount:plan.capabilities.filter((c:Row)=>!['none','read'].includes(c.effect)).length,
            runs:runs.length,completedRuns:completed.length,completionRatePct:runs.length?completed.length/runs.length*100:null,
            meanReportedCost:{reportedUsd:runs.length?runs.reduce((n,r)=>n+r.costUsd,0)/runs.length:0,complete:runs.every(r=>r.costComplete)},
            p50DurationMs:durations.length?durations[Math.floor((durations.length-1)*.5)]:null,p95DurationMs:durations.length?durations[Math.ceil((durations.length-1)*.95)]:null,
            lastRunAt:runs.map(r=>r.createdAt).sort().at(-1)??null,nodesPreview:plan.graph.nodes.map((n:Row,i:number)=>({id:n.id,name:n.name??n.id,primitive:n.kind,x:(i%3)*320,y:Math.floor(i/3)*200})),edgesPreview:plan.graph.edges.map((e:Row)=>({from:e.from,to:e.to}))};
          return params.planDigest?{...value,fixture:false,plan:planView(plan,record.admittedAt)}:value;
        }));
        body=params.planDigest?summaries[0]:page(summaries.filter(row=>(!query.query||`${row.name} ${row.planDigest}`.toLowerCase().includes(query.query.toLowerCase()))&&(!query.domain||row.domain===query.domain)),records.nextCursor??null);
      }
      if(!body)throw new UpstreamError(404,'resource.not_found');
      if(!validateResponse(operation,200,body).valid)throw new UpstreamError(502,'bff.upstream_contract_invalid');
      return body;
    } catch(error){const failure=errorResponse(error,request);return reply.code(failure.status).send(failure.body);}
  });
}
