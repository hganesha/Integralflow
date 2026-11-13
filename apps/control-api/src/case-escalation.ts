import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { stableDigest, type HarnessPlanV2 } from "@ehf/contracts";
import type { PlatformAction, ResourceRef } from "@ehf/identity";
import { createRun, getPlan, type Database } from "@ehf/persistence";
import { selectCasePin, type CaseScope } from "./case-plans.js";

/**
 * Enhanced due-diligence escalation. A standard or simplified process's decision-ready checkpoint
 * answers EDD_ESCALATION_REQUIRED with an EDD_ESCALATION work item when the EDD triggers fired. This
 * moves the case onto the released enhanced process for the same customer type, trigger and pinned
 * pack (jurisdiction and products) and starts its run. It runs automatically when the work item's
 * event reaches the control plane, and a case worker may run it again (it is idempotent).
 *
 * The move is a ReplanCase command the control plane issues in its own name (case.replan, which no
 * person or agent holds). The case store accepts it only while that work item is open, and completes
 * the item with it, so a case is never moved without its policy having asked for it.
 */
export type CaseServiceRequest = (tenantId: string, path: string, init?: { method?: string; body?: unknown; headers?: Record<string, string> }) => Promise<any>;

export type EscalationResult =
  | { status: "not_required" | "already_enhanced"; caseId: string }
  | { status: "replanned"; caseId: string; fromPlanDigest: string; toPlanDigest: string; policyId: string; runId: string | null; runNote?: string }
  | { status: "refused"; caseId: string; httpStatus: number; error: string; message?: string };

type WorkItemRow = { work_item_id: string; work_type: string; status: string };
type PackEntry = { id: string; scope?: { jurisdiction?: string; products?: string[]; institution?: string } };

export async function escalateCaseDueDiligence(input: {
  db: Database; environment: string; tenantId: string; caseId: string; requestedBy: string;
  caseService: CaseServiceRequest; runsRequireSourceContext?: boolean;
}): Promise<EscalationResult> {
  const { db, tenantId, caseId } = input;
  const refused = (httpStatus: number, error: string, message?: string): EscalationResult => ({ status: "refused", caseId, httpStatus, error, ...(message ? { message } : {}) });
  const view = await input.caseService(tenantId, `/v1/cases/${encodeURIComponent(caseId)}/replan-context`);
  const kase = view.case as { status: string; jurisdiction: string; harnessPlanDigest: string; policySnapshotDigest: string; caseSequence: number };
  const escalation = ((view.workItems ?? []) as WorkItemRow[]).find((item) => item.work_type === "EDD_ESCALATION" && item.status === "OPEN");
  if (!escalation) return { status: "not_required", caseId };
  if (["APPROVED", "DECLINED", "CLOSED"].includes(kase.status)) return refused(409, "case.escalation_case_final");
  const current = await getPlan(db, kase.harnessPlanDigest, tenantId) as HarnessPlanV2 | null;
  if (!current) return refused(409, "case.escalation_plan_unknown");
  const gate = current.graph.nodes.find((node) => node.kind === "gate" && node.config.processScope);
  const processScope = gate?.config.processScope as { customerType: string; trigger: string; event?: string; dueDiligence: string; institution: string } | undefined;
  if (!processScope) return refused(409, "case.escalation_scope_unknown", "The case's process records no scope, so its enhanced process cannot be chosen.");
  if (processScope.dueDiligence === "enhanced") return { status: "already_enhanced", caseId };
  // The pack the case is pinned to, by its policy jurisdiction: its product set carries over.
  const packs = ((gate!.config.policyPacks ?? []) as PackEntry[]).filter((pack) => pack.scope?.jurisdiction === kase.jurisdiction);
  if (packs.length !== 1) return refused(409, "case.escalation_pack_ambiguous", `${packs.length} packs of the case's process cover ${kase.jurisdiction}.`);
  const scope: CaseScope = {
    customerType: processScope.customerType as CaseScope["customerType"], trigger: processScope.trigger as CaseScope["trigger"],
    ...(processScope.event ? { event: processScope.event } : {}), dueDiligence: "enhanced",
    jurisdiction: kase.jurisdiction, products: packs[0]!.scope!.products ?? [], institution: processScope.institution,
  };
  const selected = await selectCasePin(db, tenantId, input.environment, scope);
  if (!selected.ok) return refused(selected.status, String(selected.body.error), selected.body.message as string | undefined);
  const pin = selected.pin;
  await input.caseService(tenantId, `/v1/cases/${encodeURIComponent(caseId)}/commands`, { method: "POST", body: {
    commandId: randomUUID(), commandType: "ReplanCase", commandVersion: "harness.case-replan.v1", tenantId, caseId,
    actor: { type: "SYSTEM", principalId: "control-api", roles: [] },
    authority: { planDigest: kase.harnessPlanDigest, policySnapshotDigest: kase.policySnapshotDigest,
      permissionEnvelopeDigest: stableDigest({ action: "ReplanCase", caseId, workItemId: escalation.work_item_id }) },
    payload: { harnessPlanDigest: pin.planDigest, policySnapshotDigest: pin.policySnapshotDigest, policyAuthority: pin.policyAuthority,
      workItemId: escalation.work_item_id, reason: "The EDD triggers fired; the case continues under enhanced due diligence.", requestedBy: input.requestedBy },
    preconditions: { caseSequence: kase.caseSequence },
    idempotencyKey: `replan:${tenantId}:${caseId}:${escalation.work_item_id}`,
  } });
  // The case continues under the enhanced process: its run starts here unless a source context must
  // be admitted first (sourced plans, production), which the operator's run start supplies.
  if (input.runsRequireSourceContext) {
    return { status: "replanned", caseId, fromPlanDigest: kase.harnessPlanDigest, toPlanDigest: pin.planDigest, policyId: pin.policyAuthority.policyId,
      runId: null, runNote: "run.source_context_required" };
  }
  const target = await getPlan(db, pin.planDigest, tenantId) as HarnessPlanV2 | null;
  if (target?.sourceAuthorization) {
    return { status: "replanned", caseId, fromPlanDigest: kase.harnessPlanDigest, toPlanDigest: pin.planDigest, policyId: pin.policyAuthority.policyId,
      runId: null, runNote: "run.source_context_required" };
  }
  const run = await createRun(db, { planDigest: pin.planDigest, runInput: { tenantId, caseId }, idempotencyKey: `replan:${caseId}:${escalation.work_item_id}`, tenantId });
  return { status: "replanned", caseId, fromPlanDigest: kase.harnessPlanDigest, toPlanDigest: pin.planDigest, policyId: pin.policyAuthority.policyId,
    runId: run.run.runId };
}

type Authorize = (request: FastifyRequest, action: PlatformAction, resource?: ResourceRef) => Promise<{ tenantId: string; subjectId: string; actorType?: string }>;

/** A case worker re-runs the escalation (for instance after a release of the enhanced process). */
export function registerCaseEscalationRoutes(app: FastifyInstance, options: { db: Database; authorize: Authorize; environment: string;
  caseService: CaseServiceRequest; runsRequireSourceContext: boolean }) {
  app.post<{ Params: { caseId: string } }>("/v1/cases/:caseId/due-diligence/escalate", async (request, reply) => {
    const principal = await options.authorize(request, "case.write", { kind: "case", id: request.params.caseId });
    if (principal.actorType !== undefined && principal.actorType !== "human") return reply.code(403).send({ error: "authorization.interactive_user_required" });
    try {
      const result = await escalateCaseDueDiligence({ db: options.db, environment: options.environment, tenantId: principal.tenantId,
        caseId: request.params.caseId, requestedBy: principal.subjectId, caseService: options.caseService, runsRequireSourceContext: options.runsRequireSourceContext });
      if (result.status === "refused") return reply.code(result.httpStatus).send({ error: result.error, ...(result.message ? { message: result.message } : {}) });
      return result;
    } catch (error) {
      return reply.code(502).send({ error: error instanceof Error ? error.message : "case.escalation_failed" });
    }
  });
}
