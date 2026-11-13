import type { FastifyRequest } from "fastify";
import { CaseStoreError } from "@ehf/case-store";
import type { BusinessCommand, CaseActor, CaseReadGrant, CaseSnapshot, ContextClassificationPolicy, CreateKycCaseRequest, ExecutionEnvelopeClaims, IntegrationEnvelopeClaims } from "@ehf/contracts";
import { verifyExecutionEnvelope, verifyIntegrationEnvelope } from "@ehf/execution-auth";
import type { Principal } from "@ehf/identity";

export const EXECUTION_ENVELOPE_HEADER = "x-execution-envelope";
export const INTEGRATION_ENVELOPE_HEADER = "x-integration-envelope";

export function envelopeToken(request: FastifyRequest): string | undefined {
  const value = request.headers[EXECUTION_ENVELOPE_HEADER];
  return (Array.isArray(value) ? value[0] : value)?.trim() || undefined;
}

export function integrationEnvelopeToken(request: FastifyRequest): string | undefined {
  const value = request.headers[INTEGRATION_ENVELOPE_HEADER];
  return (Array.isArray(value) ? value[0] : value)?.trim() || undefined;
}

export async function verifyIntegrationWriteAuthority(
  request: FastifyRequest,
  secret: string,
): Promise<IntegrationEnvelopeClaims> {
  const token = integrationEnvelopeToken(request);
  if (!token) throw new CaseStoreError("authorization.integration_envelope_required", 401);
  if (!secret) throw new CaseStoreError("authorization.integration_verifier_unavailable", 503);
  try {
    return await verifyIntegrationEnvelope(token, secret);
  } catch {
    throw new CaseStoreError("authorization.integration_envelope_invalid", 403);
  }
}

export function assertCaseCreationWithinIntegrationEnvelope(
  request: CreateKycCaseRequest,
  claims: IntegrationEnvelopeClaims,
): void {
  if (claims.intent !== "create_case" || claims.case_id !== null) throw new CaseStoreError("authorization.integration_intent_mismatch", 403);
  if (request.tenantId !== claims.tenant_id) throw new CaseStoreError("authorization.integration_tenant_mismatch", 403);
  if (request.harnessPlanDigest !== claims.plan_digest) throw new CaseStoreError("authorization.integration_plan_mismatch", 403);
  if (request.actor.type !== "INTEGRATION") throw new CaseStoreError("authorization.integration_actor_required", 403);
}

export function assertCommandWithinIntegrationEnvelope(
  command: BusinessCommand,
  claims: IntegrationEnvelopeClaims,
): void {
  if (claims.intent !== "submit_case_command" || claims.command_type !== command.commandType) {
    throw new CaseStoreError("authorization.integration_command_not_declared", 403);
  }
  if (claims.case_id !== command.caseId || claims.tenant_id !== command.tenantId) {
    throw new CaseStoreError("authorization.integration_case_mismatch", 403);
  }
  if (claims.plan_digest !== command.authority.planDigest) throw new CaseStoreError("authorization.integration_plan_mismatch", 403);
  if (command.actor.type !== "INTEGRATION") throw new CaseStoreError("authorization.integration_actor_required", 403);
}

/**
 * Establish what a workload is allowed to write to a case.
 *
 * A workload token only says which service is calling. It does not say that this run,
 * at this node, was granted the authority to submit a particular canonical command --
 * and case writes used to travel with no credential at all, so anything that could
 * reach the service could write to a case as an agent. The envelope carries the
 * plan-declared command types for the node, so the plan, not the runtime, decides.
 */
export async function verifyCaseWriteAuthority(
  request: FastifyRequest,
  secret: string,
): Promise<ExecutionEnvelopeClaims> {
  const token = envelopeToken(request);
  if (!token) throw new CaseStoreError("authorization.execution_envelope_required", 401);
  if (!secret) throw new CaseStoreError("authorization.envelope_verifier_unavailable", 503);
  let claims: ExecutionEnvelopeClaims;
  try {
    claims = await verifyExecutionEnvelope(token, secret);
  } catch {
    throw new CaseStoreError("authorization.execution_envelope_invalid", 403);
  }
  // A delegated envelope is a skill host's authority for gateway dependency calls only
  // (skill.execution.v1 §6.1): a skill never writes or reads the case store directly.
  if (claims.delegated_to !== undefined) throw new CaseStoreError("authorization.delegated_envelope_refused", 403);
  return claims;
}

/** Verify the same node-scoped envelope for a workload case-context read. */
export async function verifyCaseReadAuthority(
  request: FastifyRequest,
  secret: string,
): Promise<ExecutionEnvelopeClaims> {
  return verifyCaseWriteAuthority(request, secret);
}

/**
 * Resolve a workload's signed case-context grants and bind them to this case's
 * admitted plan. A caller-controlled purpose header is only a consistency assertion;
 * the purpose itself comes from the signed selector contracts.
 */
export function assertSnapshotWithinEnvelope(
  snapshot: Pick<CaseSnapshot, "planDigest">,
  claimedPurpose: string | undefined,
  claims: ExecutionEnvelopeClaims,
): { purpose: string; selectors: CaseReadGrant[]; policies: ContextClassificationPolicy[] } {
  const selectors = claims.case_reads;
  if (selectors.length === 0) throw new CaseStoreError("authorization.context_not_declared", 403);
  const purposes = [...new Set(selectors.map((selector) => selector.purpose))];
  if (purposes.length !== 1) throw new CaseStoreError("authorization.context_purpose_ambiguous", 403);
  const purpose = purposes[0]!;
  if (claimedPurpose && claimedPurpose !== purpose) {
    throw new CaseStoreError("authorization.context_purpose_mismatch", 403);
  }
  if (snapshot.planDigest !== claims.plan_digest) {
    throw new CaseStoreError("authorization.context_plan_mismatch", 403);
  }
  const classifications = new Set(selectors.map((selector) => selector.classification));
  const policies = claims.case_read_policies.filter((policy) => classifications.has(policy.classification));
  if (policies.length !== classifications.size || new Set(policies.map((policy) => policy.classification)).size !== classifications.size) {
    throw new CaseStoreError("authorization.context_classification_policy_missing", 403);
  }
  return { purpose, selectors, policies };
}

/**
 * Check a command against the authority the envelope actually granted.
 *
 * The command names its own plan and permission envelope; those claims are only
 * believable when they match the envelope the control plane signed for this node.
 */
export function assertCommandWithinEnvelope(command: BusinessCommand, claims: ExecutionEnvelopeClaims): void {
  if (command.tenantId !== claims.tenant_id || command.caseId !== claims.case_id) throw new CaseStoreError("authorization.execution_scope_mismatch", 403);
  if (command.actor.type !== "AGENT") throw new CaseStoreError("authorization.agent_actor_required", 403);
  if (!claims.case_writes.includes(command.commandType)) {
    throw new CaseStoreError("authorization.command_not_declared", 403);
  }
  if (command.authority.planDigest !== claims.plan_digest) {
    throw new CaseStoreError("authorization.command_plan_mismatch", 403);
  }
  if (command.authority.permissionEnvelopeDigest !== claims.permission_digest) {
    throw new CaseStoreError("authorization.command_permission_mismatch", 403);
  }
  if (command.actor.type === "AGENT" && command.actor.executionId && command.actor.executionId !== claims.run_id) {
    throw new CaseStoreError("authorization.command_execution_mismatch", 403);
  }
}

/** Identify the acting run and node in audit records without leaking envelope claims. */
export function executionSubject(claims: ExecutionEnvelopeClaims): string {
  return `run:${claims.run_id}#${claims.node_id}`;
}

export function isWorkload(principal: Principal): boolean {
  return principal.actorType === "workload";
}

/** Only verified identity supplies ledger attribution; request roles carry no authority. */
export function verifiedActor(principal: Principal, claimed: CaseActor, execution?: ExecutionEnvelopeClaims): CaseActor {
  // The control plane re-planning a case (case.replan) writes in its own name, as SYSTEM.
  const expected = !isWorkload(principal) ? "HUMAN" : principal.roles.includes("Integration.Dispatch") ? "INTEGRATION"
    : principal.roles.includes("Case.Replan") ? "SYSTEM" : "AGENT";
  if (claimed.type !== expected) throw new CaseStoreError("authorization.actor_type_invalid", 403);
  if (expected === "HUMAN") return {
    type: "HUMAN", principalId: principal.subjectId,
    roles: principal.roles.includes("Case.Reviewer") ? ["KYC.SeniorReviewer"] : principal.roles.includes("Case.Analyst") ? ["KYC.Analyst"] : [],
  };
  return { type: expected, principalId: principal.subjectId, roles: [], ...(execution ? { executionId: execution.run_id } : {}) };
}

export function requireHuman(principal: Principal): void {
  if (isWorkload(principal)) throw new CaseStoreError("authorization.interactive_user_required", 403);
}
