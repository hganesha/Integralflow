import { z } from "zod";
import { runtimeInvocationAnyVersionSchema, runtimeInvocationResultSchema } from "@ehf/contracts";
import { verifyRuntimeGrant } from "@ehf/execution-auth";
import { getExecutionWorkItem, getRun, postgresInvocationStore, type Database } from "@ehf/persistence";
import { authorizeStateWrite } from "./runtime-state-routes.js";

const operationSchema = z.discriminatedUnion("operation", [
  z.object({operation:z.literal("claim"),request:runtimeInvocationAnyVersionSchema}).strict(),
  z.object({operation:z.literal("complete"),request:runtimeInvocationAnyVersionSchema,result:runtimeInvocationResultSchema}).strict(),
  z.object({operation:z.literal("read"),invocationId:z.string().min(1)}).strict(),
  z.object({operation:z.literal("cancel"),invocationId:z.string().min(1)}).strict(),
]);
export async function invocationStoreOperation(db:Database,tenantId:string,secret:string,raw:unknown) {
  const operation=operationSchema.parse(raw), store=postgresInvocationStore(db,tenantId);
  if(operation.operation==='read') return store.read(operation.invocationId);
  if(operation.operation==='cancel') return store.cancel(operation.invocationId);
  const r=operation.request, grant=await verifyRuntimeGrant(r.executionGrant,secret);
  const run=await getRun(db,r.runId,tenantId);
  if(!run || grant.run_id!==r.runId || grant.attempt!==r.attempt || grant.fencing_epoch!==r.fencingEpoch
    || grant.worker_id!==r.workerId || grant.plan_digest.replace(/^sha256:/,'')!==r.planDigest.replace(/^sha256:/,'')) {
    throw new Error('runtime_invocations.grant_binding_invalid');
  }
  if(operation.operation==='claim') {
    await authorizeStateWrite(db,r.executionGrant,secret,{runId:r.runId,attempt:r.attempt,workerId:r.workerId,fencingEpoch:r.fencingEpoch});
    if(r.nodeExecution) {
      const work=await getExecutionWorkItem(db,tenantId,r.nodeExecution.workItemId);
      if(grant.node_id!==r.nodeExecution.nodeId || grant.work_item_id!==r.nodeExecution.workItemId
        || grant.work_fencing_epoch!==r.nodeExecution.fencingEpoch || work?.status!=='RUNNING' || !work.lease
        || work.lease.fencingEpoch!==r.nodeExecution.fencingEpoch || Date.parse(work.lease.leaseUntil)<=Date.now()) {
        throw new Error('runtime_invocations.work_binding_invalid');
      }
    }
    return store.claim(r);
  }
  // Retain late runtime observations for reconciliation; they cannot commit business/work state.
  await store.complete(r,operation.result); return {recorded:true};
}
