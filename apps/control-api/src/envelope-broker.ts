import {
  businessCommandTypeSchema,
  delegatedEnvelopeRequestSchema,
  businessSkillDependencies,
  delegatedSkillAudience,
  envelopeRequestSchema,
  caseReadGrantSchema,
  contextClassificationPolicySchema,
  isHeldSkillGrant,
  nodeShowsModelContext,
  skillBindingForNode,
  SKILL_ADAPTER_PREFIX,
  type BusinessCommandType,
  type CaseReadGrant,
  type ContextClassificationPolicy,
  type EffectClass,
  type ExecutionEnvelopeClaims,
  type HarnessPlanV2,
} from "@ehf/contracts";
import {
  EnvelopeAuthorityError,
  mintExecutionEnvelope,
  verifyExecutionEnvelope,
  verifyRuntimeGrant,
  type JwtSigner,
} from "@ehf/execution-auth";
import {
  currentFencingEpoch,
  getBusinessSkill,
  getPlan,
  getRun,
  getExecutionWorkItem,
  requireExecutableRelease,
  type Database,
} from "@ehf/persistence";

// One error type for envelope authority refusals, shared with the gateway's in-process
// delegation so both map reason codes to HTTP statuses the same way.
export const EnvelopeBrokerError = EnvelopeAuthorityError;
export type EnvelopeBrokerError = EnvelopeAuthorityError;

function declaredCommandTypes(plan: HarnessPlanV2, nodeId: string, held: boolean): BusinessCommandType[] {
  const node = plan.graph.nodes.find((candidate) => candidate.id === nodeId);
  const writes = Array.isArray(node?.config.caseWrites) ? node.config.caseWrites : [];
  const declared = writes.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    if (isHeldSkillGrant(entry) !== held) return [];
    const parsed = businessCommandTypeSchema.safeParse((entry as Record<string, unknown>).commandType);
    return parsed.success ? [parsed.data] : [];
  });
  return [...new Set(declared)];
}

/**
 * Command types the plan declares this node may submit, in declaration order: its declarative
 * writes and its skill `proposal`/`effect` grants. `held`/`release` grants are not among them.
 */
function nodeShowsModelContextById(plan: HarnessPlanV2, nodeId: string): boolean {
  const node = plan.graph.nodes.find((candidate) => candidate.id === nodeId);
  return node ? nodeShowsModelContext(node) : false;
}

export function declaredCaseWrites(plan: HarnessPlanV2, nodeId: string): BusinessCommandType[] {
  return declaredCommandTypes(plan, nodeId, false);
}

/**
 * Command types the node may only hold (a skill node's approval-required effects) or release
 * after the approval (the release node): the envelope's `case_writes_held`.
 */
export function declaredHeldCaseWrites(plan: HarnessPlanV2, nodeId: string): BusinessCommandType[] {
  return declaredCommandTypes(plan, nodeId, true);
}

/**
 * Context authority comes from the compiled plan, never from a runtime request: the plan
 * carries explicit selector contracts.
 */
export function declaredCaseReads(plan: HarnessPlanV2, nodeId: string): CaseReadGrant[] {
  const node = plan.graph.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) return [];
  const selectors = new Map(plan.contextSelectors.map((selector) => [selector.id, selector]));
  const reads = node.contextSelectorIds.map((id) => selectors.get(id)).filter((selector): selector is CaseReadGrant => Boolean(selector));
  return reads.map((read) => caseReadGrantSchema.parse(read));
}

/**
 * Sign only the classification rules needed for this node's declared reads. The
 * Case API never looks up a mutable local classification table while serving a
 * workload request; the release-bound configuration arrives in this envelope.
 */
export function declaredCaseReadPolicies(
  plan: HarnessPlanV2,
  reads: readonly CaseReadGrant[],
): ContextClassificationPolicy[] {
  const wanted = new Set(reads.map((read) => read.classification));
  const policies = new Map(plan.contextClassificationPolicies.map((policy) => [policy.classification, policy]));
  return [...wanted].map((classification) => {
    const policy = policies.get(classification);
    if (!policy) throw new EnvelopeBrokerError(`broker.case_read_classification_policy_missing:${classification}`, 409);
    return contextClassificationPolicySchema.parse(policy);
  });
}

export type BrokerDependencies = {
  db: Database;
  envelopeSecret?: string;
  envelopeSigner?: JwtSigner;
  grantSecret: string;
  envelopeTtlSeconds?: number;
  environment?: string;
};

/**
 * Exchange a runtime grant for a capability envelope scoped to one node.
 *
 * This is the step that used to happen inside the runtime with a shared signing secret.
 * Moving it here means the authority is re-derived from durable state every time: the
 * run must still be running, the fence must still be the one the grant was issued under,
 * and the capabilities and effects come from the admitted plan rather than from anything
 * the caller said. A stale runtime gets a denial instead of a signature.
 */
export async function issueExecutionEnvelope(
  dependencies: BrokerDependencies,
  grantToken: string,
  body: unknown,
): Promise<{
  envelope: string;
  expiresInSeconds: number;
  caseWrites: BusinessCommandType[];
  caseReads: CaseReadGrant[];
  caseReadPolicies: ContextClassificationPolicy[];
}> {
  const request = envelopeRequestSchema.parse(body);
  let grant;
  try {
    grant = await verifyRuntimeGrant(grantToken, dependencies.grantSecret);
  } catch {
    throw new EnvelopeBrokerError("broker.grant_invalid", 401);
  }
  if (grant.run_id !== request.runId) throw new EnvelopeBrokerError("broker.run_mismatch");
  if (grant.attempt !== request.attempt) throw new EnvelopeBrokerError("broker.attempt_mismatch");

  const run = await getRun(dependencies.db, request.runId);
  if (!run) throw new EnvelopeBrokerError("broker.run_not_found", 404);
  if (run.attempt !== grant.attempt) throw new EnvelopeBrokerError("broker.attempt_mismatch");
  if (run.status !== "running") throw new EnvelopeBrokerError("broker.run_not_running");
  if (run.planDigest !== grant.plan_digest) throw new EnvelopeBrokerError("broker.plan_mismatch");

  // The fence is read now, not taken from the grant: a runtime whose lease was stolen
  // while it was working must not be able to keep buying authority with an old grant.
  const epoch = await currentFencingEpoch(dependencies.db, request.runId);
  if (epoch === null || epoch !== grant.fencing_epoch) throw new EnvelopeBrokerError("broker.stale_fence");

  const plan = await getPlan(dependencies.db, run.planDigest);
  if (!plan) throw new EnvelopeBrokerError("broker.plan_not_admitted", 404);
  const tenant = await dependencies.db.query<{ tenant_id: string }>("select tenant_id from harness_runtime.runs where run_id=$1", [run.runId]);
  const tenantId = tenant.rows[0]?.tenant_id;
  if (!tenantId) throw new EnvelopeBrokerError("broker.tenant_missing");
  const caseId = typeof (run.input as { caseId?: unknown })?.caseId === "string" ? (run.input as { caseId: string }).caseId : null;
  await requireExecutableRelease(dependencies.db, tenantId, plan.planDigest, dependencies.environment ?? "development");
  if (grant.node_id !== request.nodeId || !grant.work_item_id) throw new EnvelopeBrokerError("broker.node_grant_required");
  const work = await getExecutionWorkItem(dependencies.db, tenantId, grant.work_item_id);
  if (work?.status !== "RUNNING" || !work.lease || work.lease.fencingEpoch !== grant.work_fencing_epoch
    || work.lease.owner !== grant.worker_id || Date.parse(work.lease.leaseUntil) <= Date.now()
    || work.constraints.nodeId !== request.nodeId || work.constraints.runId !== run.runId) {
    throw new EnvelopeBrokerError("broker.work_authority_expired");
  }
  const permission = plan.permissionEnvelopes.find((item) => item.nodeId === request.nodeId);
  if (!permission) throw new EnvelopeBrokerError("broker.node_not_permitted");

  const advisory = plan.metadata.domain === "discovery";
  const caseWrites = declaredCaseWrites(plan, request.nodeId);
  const caseWritesHeld = declaredHeldCaseWrites(plan, request.nodeId);
  const caseReads = declaredCaseReads(plan, request.nodeId);
  if (advisory && (caseWrites.length || caseWritesHeld.length || caseReads.length)) {
    throw new EnvelopeBrokerError("broker.discovery_case_authority_denied");
  }
  const caseReadPolicies = declaredCaseReadPolicies(plan, caseReads);
  const purposes = new Set(caseReads.map((read) => read.purpose));
  if (purposes.size > 1) throw new EnvelopeBrokerError("broker.case_read_purpose_ambiguous");
  const ttlSeconds = dependencies.envelopeTtlSeconds ?? 60;
  const envelope = await mintExecutionEnvelope({
    ...(dependencies.envelopeSigner ? { signer: dependencies.envelopeSigner } : { secret: dependencies.envelopeSecret! }),
    tenantId, caseId: advisory ? null : caseId,
    ...(grant.work_item_id ? { workItemId: grant.work_item_id, workFencingEpoch: grant.work_fencing_epoch! } : {}),
    invocationId: request.invocationId,
    runId: request.runId,
    nodeId: request.nodeId,
    attempt: request.attempt,
    planDigest: plan.planDigest,
    permissionDigest: permission.digest,
    capabilities: permission.capabilities,
    effects: permission.effects,
    caseWrites,
    caseWritesHeld,
    caseReads,
    caseReadPolicies,
    // Discovery context can be recorded for the advisory run. It has no authority
    // to register a model context as evidence in a case.
    contextRequired: !advisory && nodeShowsModelContextById(plan, request.nodeId),
    fencingEpoch: epoch,
    ttlSeconds,
  });
  return { envelope, expiresInSeconds: ttlSeconds, caseWrites, caseReads, caseReadPolicies };
}
