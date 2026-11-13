import { assignmentFor, classifyOutcome, bridgeOutcomeSchema, type AssignmentScope, type CanonicalCatalog, type CanonicalTaskPlan,
  type FinancialCrimeClient, type BridgeOutcome } from '@ehf/fincrime-integration';
import { executionWorkItemSchema, stableDigest } from '@ehf/contracts';
import { acquireExecutionWorkItemLease, createExecutionWorkItems, getExecutionWorkItem, getExecutionOutput,
  scheduleExecutionWork, publishPostgresExecutionDispatch, startExecutionWorkItem, completeExecutionWorkItem,
  reconcileExecutionWorkItems, retainExecutionOutcome, requestHumanExecutionDecision, suspendExecutionWorkItem,
  renewExecutionWorkItemLease, latestExecutionOutcome, type Database } from '@ehf/persistence';
import { runReadyGraph } from './ready-graph.js';

/** Called by the control plane after admission; no timers, retries or human decisions live in Python. */
export async function dispatchCanonicalTask(options:{db:Database;catalog:CanonicalCatalog;client:FinancialCrimeClient;plan:CanonicalTaskPlan;
  catalogDigest:string;
  owner:string;instanceId:string;maxConcurrency:number;
  // Called under the current work lease, after retaining the observation and before terminal/human transition.
  commitObservation?:(outcome:BridgeOutcome)=>Promise<{commandRef:string}|null>;
  // Verified application authority, not a serialized Principal/permission set from a request body.
  authorize:()=>Promise<Omit<AssignmentScope,'node_id'|'work_item_id'|'execution_id'|'work_fencing_epoch'|'task_id'|'task_version'|'profile_id'|'profile_hash'|'skill_id'|'skill_version'|'bundle_code_hash'|'instruction_hash'>&{admitted_catalog_digest:string}>;
}) {
  const {db,plan,catalog,client}=options;
  async function authorize(){const {admitted_catalog_digest,...scope}=await options.authorize();
    if(admitted_catalog_digest!==options.catalogDigest)throw new Error('fincrime.catalog_not_admitted');return scope;}
  const base=await authorize();
  const actor={type:'SYSTEM' as const,principalId:options.owner,roles:['workflow.executor']};
  const creator={type:'SYSTEM' as const,principalId:'fincrime-task-controller',roles:['workflow.controller']};
  const task=catalog.tasks.find(t=>t.sha256===plan.task_hash && t.value.id===plan.task_id);
  const agent=catalog.agents.find(a=>a.sha256===plan.profile_hash && a.value.id===plan.profile_id);
  if(!task || !agent || task.value.agent_profile!==agent.value.id) throw new Error('fincrime.plan_not_admitted');
  const declared=task.value.steps as Array<{id:string;skill_id:string;skill_version:string;dependencies:string[]}>;
  if(plan.steps.length!==declared.length || new Set(plan.steps.map(s=>s.id)).size!==declared.length
    || plan.steps.some(s=>!declared.some(d=>d.id===s.id && d.skill_id===s.skill_id && d.skill_version===s.skill_version
      && stableDigest(d.dependencies)===stableDigest(s.dependencies)))) throw new Error('fincrime.plan_steps_changed');
  // The full plan/input hash participates in work identity. Reusing an instance with changed inputs conflicts at insertion.
  const workIds=new Map(plan.steps.map(s=>[s.id,`FC-${stableDigest({tenant:base.tenant_id,case:base.case_id,instance:options.instanceId,step:s.id}).slice(0,40)}`]));
  const firstWork=workIds.values().next().value;
  if(!firstWork) throw new Error('fincrime.empty_task');
  const prior=await getExecutionWorkItem(db,base.tenant_id,firstWork);
  const timestamp=prior?.createdAt??new Date().toISOString();
  await createExecutionWorkItems(db,plan.steps.map(s=>executionWorkItemSchema.parse({
    apiVersion:'harness.factory/execution-work-item-v1',kind:'ExecutionWorkItem',tenantId:base.tenant_id,caseId:base.case_id,
    workItemId:workIds.get(s.id),workType:'fincrime.skill',capabilityId:`fincrime.${s.skill_id}`,assuranceClass:'HIGH',revision:0,
    caseSequenceBasis:base.case_sequence,planDigest:base.plan_digest,policyContextRef:base.snapshot_digest,schemaVersion:'fincrime.task.v1',
    objective:String(task.value.objective),subjectRefs:[],requiredOutputs:[],constraints:{taskHash:plan.task_hash,inputHash:plan.input_hash,
      parameters:s.parameters,bundleCodeHash:catalog.bundleCodeHash,profileHash:plan.profile_hash,runId:base.run_id,nodeId:s.id,dualControlRequired:true},
    dependencyIds:s.dependencies.map(id=>workIds.get(id)),dependencyDigest:stableDigest(s.dependencies),invalidationPolicy:'BLOCK',
    status:s.dependencies.length?'BLOCKED':'READY',reasonCode:'fincrime.task_materialized',priority:10,readyAt:null,deadlineAt:null,terminalAt:null,
    dispatch:{generation:0,queue:'fincrime.skill',publishedAt:null,brokerMessageId:null},lease:null,
    limits:{maxAttempts:3,maxReworkCycles:1,maxDurationMs:30_000,maxCostUsd:0,maxModelCalls:0,maxCapabilityCalls:10},result:null,
    createdBy:creator,transitionSequence:0,traceId:null,createdAt:timestamp,updatedAt:timestamp,
  })));
  const outcomes:Record<string,unknown>={};
  let humanRejected=false;
  const result=await runReadyGraph({nodes:plan.steps.map(s=>s.id),edges:plan.steps.flatMap(s=>s.dependencies.map(from=>({from,to:s.id}))),
    maxConcurrency:options.maxConcurrency,execute:async nodeId=>{
      const step=plan.steps.find(s=>s.id===nodeId)!,workItemId=workIds.get(nodeId)!;
      let work=(await getExecutionWorkItem(db,base.tenant_id,workItemId))!;
      if(work.status==='COMPLETED'){
        const output=await getExecutionOutput(db,base.tenant_id,workItemId);
        const original=bridgeOutcomeSchema.safeParse(await latestExecutionOutcome(db,base.tenant_id,workItemId));
        if(original.success && original.data.status==='NEEDS_REVIEW') {
          outcomes[nodeId]={...original.data,human_decision:output};
          if((output as {decision?:string})?.decision!=='APPROVE'){humanRejected=true;return 'pause';}
        } else outcomes[nodeId]=output;
        return 'continue';
      }
      if(['HUMAN_REQUIRED','WAITING_HUMAN','SUSPENDED'].includes(work.status)) {
        outcomes[nodeId]=await latestExecutionOutcome(db,base.tenant_id,workItemId);return 'pause';
      }
      await authorize();await reconcileExecutionWorkItems(db);
      await scheduleExecutionWork(db,1,{tenantId:base.tenant_id,workItemId});
      work=(await getExecutionWorkItem(db,base.tenant_id,workItemId))!;
      await publishPostgresExecutionDispatch(db,{tenantId:base.tenant_id,caseId:base.case_id,workItemId,generation:work.dispatch.generation,
        queue:work.dispatch.queue,messageId:`${base.tenant_id}:${workItemId}:${work.dispatch.generation}`});
      const acquired=await acquireExecutionWorkItemLease(db,{tenantId:base.tenant_id,workItemId,generation:work.dispatch.generation,
        owner:options.owner,leaseSeconds:60,actor});
      if(acquired.outcome!=='acquired' || !acquired.workItem.lease) return 'pause';
      const lease=acquired.workItem.lease;
      const fence={tenantId:base.tenant_id,workItemId,executionId:lease.executionId,fencingEpoch:lease.fencingEpoch,actor};
      await startExecutionWorkItem(db,fence);
      const abort=new AbortController();
      const heartbeat=setInterval(()=>{void renewExecutionWorkItemLease(db,{...fence,leaseSeconds:60}).then(ok=>{
        if(!ok)abort.abort(new Error('workflow.lease_lost'));
      }).catch(error=>abort.abort(error));},10_000).unref();
      try {
        const current=await authorize();
        if(stableDigest(current)!==stableDigest(base)) throw new Error('fincrime.context_basis_changed');
        const scope=assignmentFor(catalog,{taskId:plan.task_id,skillId:step.skill_id,scope:{...base,node_id:nodeId,
          work_item_id:workItemId,execution_id:lease.executionId,work_fencing_epoch:lease.fencingEpoch}});
        const outcome=await client.execute(scope,step.parameters,abort.signal);
        await retainExecutionOutcome(db,{...fence,outcome});outcomes[nodeId]=outcome;
        const accepted=options.commitObservation ? await options.commitObservation(outcome) : null;
        const failurePolicy=task.value.failure_policy as Record<string,string>;
        const policyStatus=outcome.error_code==='SOURCE_UNAVAILABLE'?failurePolicy.unavailable_required_source
          : ['CONTEXT_MISSING','CONTEXT_STALE'].includes(outcome.error_code??'')?failurePolicy.missing_required_evidence:undefined;
        // Task policy may route a failure, never turn missing evidence into success.
        const disposition=policyStatus && ['NEEDS_EVIDENCE','NEEDS_REVIEW','BLOCKED','FAILED'].includes(policyStatus)
          ? policyStatus as BridgeOutcome['status']:outcome.status;
        const classification=classifyOutcome({...outcome,status:disposition});
        if(classification==='human'){await requestHumanExecutionDecision(db,fence);return 'pause';}
        if(classification!=='complete'){await suspendExecutionWorkItem(db,{tenantId:base.tenant_id,workItemId,reasonCode:`fincrime.${disposition.toLowerCase()}`,actor});return 'pause';}
        if(stableDigest(await authorize())!==stableDigest(base)) throw new Error('fincrime.context_basis_changed');
        await completeExecutionWorkItem(db,{...fence,output:outcome,result:{agentResultRef:`sha256:${stableDigest(outcome)}`,
          acceptedCommandRefs:accepted?[accepted.commandRef]:[],outputRefs:[],failureCode:null,failureDetailRef:null}});
        return 'continue';
      } catch(error) {
        await suspendExecutionWorkItem(db,{tenantId:base.tenant_id,workItemId,reasonCode:'fincrime.execution_interrupted',actor}).catch(()=>undefined);
        throw error;
      } finally {clearInterval(heartbeat);}
    }});
  return {state:humanRejected?'REJECTED':result==='complete'?'COMPLETED':'WAITING',outcomes,workIds:Object.fromEntries(workIds)};
}
