import { OPERATIONS, type OperationMeta } from '@ehf/ui-contracts';
import { validateResponse } from '@ehf/ui-contracts/validate';
import { actionsForRoles, AuthorizationError } from '@ehf/identity';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { sessionAccess } from './session.js';
import { UpstreamError, type Service, type Upstream } from './upstream.js';
import { applicationCaseType, stableDigest } from '@ehf/contracts';
import { platformRelayView } from './platform-relay-views.js';

const SERVICES = new Set(['control-api','case-api','capability-gateway']);
const TARGET_OVERRIDES:Record<string,string> = {
  // These contracts are agent instructions, distinct from canonical business skills.
  getAuthoringSkills:'/v1/authoring/agent-instructions',
  getCasesCaseIdSnapshot:'/v2/cases/:caseId/snapshot',
  postAuthoringSkills:'/v1/authoring/agent-instructions',
};
export function routePath(meta:OperationMeta) {
  // find-my-way requires doubled colons for literal action suffixes. Escape before
  // inserting parameter colons, or bindingId:activate becomes one parameter name.
  const path=meta.path.replaceAll(':','::').replace(/\{([^}]+)\}(?=::)/g,':$1([^/]+)').replace(/\{([^}]+)\}/g,':$1');
  return meta.path.startsWith('/auth/') ? path : '/api'+path;
}
export function relayTarget(meta:OperationMeta, request:Pick<FastifyRequest,'params'|'query'>) {
  const params=request.params as Record<string,string>;
  const target=TARGET_OVERRIDES[meta.operationId]??meta.xUpstream?.path;
  if(!target)throw new UpstreamError(503,'bff.operation_unavailable');
  const path=target.replace(/:([A-Za-z][A-Za-z0-9_]*)|\{([^}]+)\}/g,(token,a,b)=>{
    const key=a??b;
    const value=params[key]??(key==='digest'?params.planDigest:undefined);
    return value===undefined ? token : encodeURIComponent(value);
  });
  const url=new URL(path,'http://relay.invalid');
  for(const [key,value] of Object.entries(request.query as Record<string,unknown> ?? {})) {
    if(value!==undefined && value!==null) for(const item of Array.isArray(value)?value:[value]) url.searchParams.append(key,String(item));
  }
  if(meta.operationId==='getPlansPlanDigestRuns')url.searchParams.set('planDigest',params.planDigest!);
  return url.pathname+(url.search?url.search:'');
}
export function delegatedHeaders(request:FastifyRequest, access:ReturnType<typeof sessionAccess>,env:NodeJS.ProcessEnv) {
  const authorization=access.authorization(request);
  const result:Record<string,string>={ 'x-correlation-id':request.id, 'x-purpose':'interactive_ui' };
  if(authorization && env.BFF_IDENTITY_MODE==='delegated')result['x-ehf-forwarded-authorization']=authorization;
  for(const name of ['if-none-match','if-match','idempotency-key']) {
    const value=request.headers[name];if(typeof value==='string')result[name]=value;
  }
  return result;
}
export function errorResponse(error:unknown,request:FastifyRequest) {
  const status=error instanceof UpstreamError?error.status:error instanceof AuthorizationError?error.httpStatus:503;
  const code=error instanceof UpstreamError?error.code:error instanceof AuthorizationError?error.decision.reasonCode:'bff.upstream_unavailable';
  return {status,body:{error:code,message:status>=500?'This service is temporarily unavailable. Try again shortly.':status===403?'Your role cannot perform this action.':code.replaceAll('_',' '),status,correlationId:request.id,retryable:status>=500}};
}
/** An upstream refusal in the ApiError envelope: status, reason code, message, remedy and details kept. */
export function upstreamFailure(reply:FastifyReply,request:FastifyRequest,result:{status:number;body?:any}) {
  const body=result.body??{};
  const candidates=Array.isArray(body.candidates)?body.candidates.map(String):null;
  const details=body.details||body.issues||body.report||candidates?{...(body.details??{}),...(body.issues?{issues:body.issues}:{}),...(body.report?{report:body.report}:{}),...(candidates?{candidates}:{})}:null;
  return reply.code(result.status).send({error:body.error??'bff.upstream_failed',message:body.message??null,...(typeof body.remedy==='string'?{remedy:body.remedy}:{}),status:result.status,correlationId:request.id,retryable:result.status>=500,...(details?{details}:{})});
}
/** Register reviewed contract relays after the specialized compositions. Upstream services
 * retain tenant, body-specific, concurrency and execution authority checks. */
export function registerRelays(app:FastifyInstance,access:ReturnType<typeof sessionAccess>,upstream:Upstream,env:NodeJS.ProcessEnv) {
  for(const meta of OPERATIONS as readonly OperationMeta[]) {
    if(meta.mockOnly || !SERVICES.has(meta.xUpstream?.service??'') || !meta.xUpstream?.path || app.hasRoute({method:meta.method,url:routePath(meta)}))continue;
    app.route({method:meta.method,url:routePath(meta),bodyLimit:16*1024*1024,handler:async(request,reply)=>{
      reply.header('cache-control','no-store').header('x-correlation-id',request.id);
      try {
        const principal=await access.resolver.resolve(request);
        const actions=actionsForRoles(principal.roles);
        const required=[...new Set(meta.xAction?.match(/[a-z_]+\.[a-z_.]+/g)??[])];
        if(principal.actorType!=='human' || required.length && !required.some(action=>actions.has(action as never)))throw new UpstreamError(403,'authorization.role_missing');
        if(meta.method!=='GET' && !access.csrf(request))throw new UpstreamError(403,'csrf.invalid');
        let input=request.body as any;
        if(meta.operationId==='postCases') {
          if(!input||!['KYB','kyc_onboarding','kyb_onboarding'].includes(input.caseType))throw new UpstreamError(400,'case.type_not_supported');
          const digest=String(input.harnessPlanDigest??'').replace(/^sha256:/,'');
          if(!/^[a-f0-9]{64}$/.test(digest))throw new UpstreamError(400,'plan.digest_invalid');
          // A case opened by its scope is pinned to the plan and pack the catalogue selects for it (the
          // selection the creator reviewed, re-made here); otherwise to the plan's single policy pin, in US.
          const scope=input.scope;
          // Selection is read-only: the creation's idempotency key belongs to the case-api call alone.
          const selectHeaders=delegatedHeaders(request,access,env);delete selectHeaders['idempotency-key'];
          const authority=scope===undefined
            ? await upstream('control-api','GET',`/v1/plans/${digest}/case-authority`,principal,undefined,delegatedHeaders(request,access,env))
            : await upstream('control-api','POST','/v1/case-plans/select',principal,scope,selectHeaders);
          if(authority.status!==200) {
            if(scope!==undefined && authority.status<500)return upstreamFailure(reply,request,authority);
            throw new UpstreamError(authority.status,authority.body?.error??'case.policy_authority_unavailable');
          }
          if(scope!==undefined&&authority.body.pack?.scope?.jurisdiction!==scope.jurisdiction)throw new UpstreamError(409,'case.plan_selection_changed');
          if(String(authority.body.planDigest).replace(/^sha256:/,'')!==digest)throw new UpstreamError(409,scope===undefined?'case.policy_authority_mismatch':'case.plan_selection_changed');
          // The case type follows the scope's customer type, as an application's does: KYB for a business or trust.
          const caseType=scope===undefined?{caseType:'kyc_onboarding',schemaVersion:'kyc.case.v1'}:applicationCaseType(scope.customerType);
          input={tenantId:principal.tenantId,...caseType,jurisdiction:scope===undefined?'US':String(authority.body.pack?.scope?.jurisdiction??''),harnessPlanDigest:digest,
            policySnapshotDigest:authority.body.policySnapshotDigest,policyAuthority:authority.body.policyAuthority,classification:input.classification,
            ...(input.externalRef?{externalRef:input.externalRef}:{}),actor:{type:'HUMAN',principalId:principal.subjectId,roles:principal.roles}};
        }
        if(meta.operationId==='postCasesCaseIdCommands') {
          const {caseId}=request.params as {caseId:string};
          const snapshot=await upstream('case-api','GET',`/v2/cases/${encodeURIComponent(caseId)}/snapshot`,principal,undefined,delegatedHeaders(request,access,env));
          if(snapshot.status!==200)throw new UpstreamError(snapshot.status,'case.snapshot_unavailable');
          const submitted=await submitCaseCommand(upstream,principal,delegatedHeaders(request,access,env),input,caseId,snapshot.body);
          if(submitted.status>=400)return upstreamFailure(reply,request,submitted);
          if(!validateResponse(meta.operationId,200,submitted.body).valid)throw new UpstreamError(502,'bff.upstream_contract_invalid');
          return reply.code(200).send(submitted.body);
        }
        const result=await upstream(meta.xUpstream!.service as Service,meta.method,relayTarget(meta,request),principal,input,delegatedHeaders(request,access,env));
        if(result.status>=400)return upstreamFailure(reply,request,result);
        for(const [key,value] of Object.entries(result.headers??{}))reply.header(key,value);
        if(result.status===304||result.status===204)return reply.code(result.status).send();
        let body=platformRelayView(meta.operationId,result.body) as any;
        if(meta.operationId==='getGatewayStatus') {
          body={readiness:body.readiness,openRouterState:body.openRouterState,openSanctionsState:body.openSanctionsState,runtimeMode:body.runtimeMode,envelopeVerifierStatus:body.envelopeVerifierStatus,
            lastConnectionTestAt:body.lastConnectionTestAt??null,lastConnectionLatencyMs:body.lastConnectionLatencyMs??null,lastConnectionMessage:body.lastConnectionMessage??null,
            calls24h:body.calls24h??null,denials24h:body.denials24h??null,generatedAt:body.generatedAt,telemetryFreshThrough:body.telemetryFreshThrough??null};
        }
        if(meta.operationId==='postCasesCaseIdLedgerVerify')body={verified:body.valid??body.verified,checkedEvents:body.checkedEvents,headDigest:body.headDigest??null,failedSequence:body.failedSequence??null};
        if(meta.operationId==='postCases')body={caseId:body.caseId??body.case?.caseId,caseSequence:body.caseSequence??body.case?.caseSequence};
        let valid=false;
        try { valid=validateResponse(meta.operationId,result.status,body).valid; } catch { /* An upstream returned an undeclared success status. */ }
        if(!valid && meta.method==='GET') {
          const items=Array.isArray(body)?body:body?.items??body?.records??body?.agents??body?.skills??body?.instructions??body?.drafts??body?.events??body?.attempts??body?.releases??body?.cases??body?.runs;
          if(Array.isArray(items)) {
            const candidate={items,nextCursor:body?.nextCursor??null,generatedAt:new Date().toISOString()};
            if(validateResponse(meta.operationId,result.status,candidate).valid) {body=candidate;valid=true;}
          }
        }
        if(meta.operationId==='getCasesCaseIdExportsDigestFormat' && (Buffer.isBuffer(body)||typeof body==='string'))valid=true;
        if(!valid)throw new UpstreamError(502,'bff.upstream_contract_invalid');
        return reply.code(result.status).send(body);
      } catch(error) {const failure=errorResponse(error,request);return reply.code(failure.status).send(failure.body);}
    }});
  }
}

/** Browser input never supplies actor or authority. Bind the intended command to a
 * consistent, tenant-scoped snapshot; the case service rechecks the sequence on submit.
 * `replay` binds a command whose expected sequence is behind the snapshot, for submitCaseCommand
 * alone: the case store answers it only from the receipt held for its idempotency key. */
export function completeCaseCommand(input:any,caseId:string,snapshot:any,principal:import('@ehf/identity').Principal,{replay=false}:{replay?:boolean}={}) {
  if(!input || snapshot.caseId!==caseId || snapshot.tenantId!==principal.tenantId)throw new UpstreamError(403,'case.authority_mismatch');
  if(!Number.isInteger(input.preconditions?.caseSequence) || !replay && input.preconditions.caseSequence!==snapshot.caseSequence)throw new UpstreamError(409,'case.sequence_conflict');
  if(typeof input.idempotencyKey!=='string'||!input.idempotencyKey)throw new UpstreamError(400,'command.idempotency_key_required');
  const authority={planDigest:snapshot.planDigest,policySnapshotDigest:snapshot.policyAuthority.policySnapshotDigest,
    permissionEnvelopeDigest:stableDigest({planDigest:snapshot.planDigest,commandType:input.commandType,actor:principal.subjectId})};
  return {commandId:'cmd_'+stableDigest({tenantId:principal.tenantId,caseId,key:input.idempotencyKey}),tenantId:principal.tenantId,caseId,
    commandType:input.commandType,commandVersion:input.commandVersion,payload:input.payload,
    preconditions:{caseSequence:input.preconditions.caseSequence,...(input.preconditions.subjectRevision==null?{}:{subjectRevision:input.preconditions.subjectRevision})},
    actor:{type:'HUMAN',principalId:principal.subjectId,roles:principal.roles},authority,idempotencyKey:input.idempotencyKey};
}

/** The contract's CommandReceipt for a case-store command result, first or replayed. The store's
 * receipt does not repeat the command id; it is the one the command was submitted under, which is
 * derived from the idempotency key and so the same on every replay. */
export function commandReceipt(result:any,commandId:string) {
  return {outcome:result.outcome,commandId:typeof result.commandId==='string'?result.commandId:commandId,caseSequence:result.caseSequence,
    reasonCode:result.reasonCode??null,eventIds:Array.isArray(result.eventIds)?result.eventIds:typeof result.eventId==='string'?[result.eventId]:[]};
}

/**
 * Submit a person's command on a case and answer with its CommandReceipt. A command bound to the
 * current snapshot is submitted as usual. One whose expected sequence is not the snapshot's is new
 * work against a stale view or a retry of a command already recorded, and only the case store's
 * receipts can tell which: it is forwarded unchanged, so an exact replay returns the original receipt,
 * a different command under the same key is refused as an idempotency conflict, and anything else is
 * refused on the sequence, as before. A stale command the store did not answer from a receipt is
 * never reported as accepted.
 */
export async function submitCaseCommand(upstream:Upstream,principal:import('@ehf/identity').Principal,headers:Record<string,string>,input:any,caseId:string,snapshot:any):Promise<{status:number;body:any}> {
  const replay=input?.preconditions?.caseSequence!==snapshot.caseSequence;
  const command=completeCaseCommand(input,caseId,snapshot,principal,{replay});
  const result=await upstream('case-api','POST',`/v1/cases/${encodeURIComponent(caseId)}/commands`,principal,command,headers);
  if(result.status>=400) {
    if(replay&&result.body?.error==='command.case_sequence_conflict')return {status:409,body:{...result.body,error:'case.sequence_conflict'}};
    return result;
  }
  if(replay&&result.body?.replayed!==true)throw new UpstreamError(502,'bff.upstream_contract_invalid');
  return {status:result.status,body:commandReceipt(result.body,command.commandId)};
}
