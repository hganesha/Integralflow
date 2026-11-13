import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { HarnessPlanV2 } from "@ehf/contracts";
import { selectCasePlan } from "@ehf/flow-composer";
import type { PlatformAction, ResourceRef } from "@ehf/identity";
import { getPlan, getPublishedPolicy, listReleasesInEffect, requireExecutableRelease, type Database } from "@ehf/persistence";

/**
 * Case-time plan selection from the plan catalogue: a case names its scope and gets the one released
 * plan composed for its customer type, trigger, review event and due-diligence level, and that plan's
 * one pinned policy pack for its jurisdiction and products. The pin is the pack (id and digest), which
 * is what the checkpoints and every policy-reading skill select their projection by. Nothing is
 * chosen by default: no plan, no pack, or more than one, is refused with the reason.
 */
export const caseScopeSchema = z.object({
  customerType: z.enum(["individual", "corporate", "trust"]),
  trigger: z.enum(["onboarding", "periodic_review", "event_review"]),
  dueDiligence: z.enum(["simplified", "standard", "enhanced"]).optional(),
  event: z.string().regex(/^[a-z][a-z_]{0,63}$/).optional(),
  jurisdiction: z.string().regex(/^[A-Z]{2}$/),
  products: z.array(z.string().regex(/^[a-z][a-z_]{0,63}$/)).min(1).max(20),
  institution: z.string().regex(/^[a-z0-9][a-z0-9.-]*$/).max(120).optional(),
}).strict();

type Authorize = (request: FastifyRequest, action: PlatformAction, resource?: ResourceRef) => Promise<{ tenantId: string; actorType?: string }>;
export type CaseScope = z.infer<typeof caseScopeSchema>;

export type CasePinResult =
  | { ok: true; pin: { planDigest: string; policySnapshotDigest: string;
      policyAuthority: { policyId: string; policyVersion: string; policyBundleDigest: string; dependencyDigest: string };
      scope: unknown; pack: { id: string; scope: unknown } } }
  | { ok: false; status: number; body: Record<string, unknown> };

/**
 * The catalogue's pin for a case scope: the one released plan (active release in this environment)
 * composed for it and that plan's one pack for its jurisdiction and products, with the release's
 * executable authority re-checked. Shared by case creation and due-diligence escalation.
 */
export async function selectCasePin(db: Database, tenantId: string, environment: string, scope: CaseScope): Promise<CasePinResult> {
  // Only releases in effect: a scheduled release is not chosen before its date, nor a superseded one after.
  const releases = await listReleasesInEffect(db, tenantId, environment);
  const plans = (await Promise.all([...new Set(releases.map((release) => release.manifest.planDigest))]
    .map((digest) => getPlan(db, digest, tenantId)))).filter((plan): plan is HarnessPlanV2 => plan !== null);
  const selection = selectCasePlan(plans, scope);
  if (selection.status !== "selected") {
    return { ok: false, status: 422, body: { error: `case.plan_${selection.status}`, message: selection.reason, candidates: selection.candidates } };
  }
  const plan = selection.plan;
  try {
    const release = await requireExecutableRelease(db, tenantId, plan.planDigest, environment);
    if (plan.policyBundles.length !== 1) return { ok: false, status: 409, body: { error: "case.policy_authority_ambiguous" } };
    const binding = plan.policyBundles[0]!;
    const bundle = (await getPublishedPolicy(db, tenantId, binding.bundleDigest))?.compiledBundle;
    if (!bundle || !release.manifest.policyBundleDigests.some((digest) => digest.replace(/^sha256:/, "") === binding.bundleDigest.replace(/^sha256:/, ""))) {
      return { ok: false, status: 409, body: { error: "case.policy_authority_unavailable" } };
    }
    return { ok: true, pin: {
      planDigest: plan.planDigest, policySnapshotDigest: bundle.sourceDigest,
      // The case is pinned to the pack: the checkpoints' policy set and each skill's projection are chosen by it.
      policyAuthority: { policyId: selection.pack.id, policyVersion: selection.pack.version, policyBundleDigest: selection.pack.digest, dependencyDigest: plan.dependencyManifestDigest },
      scope: selection.scope, pack: { id: selection.pack.id, scope: selection.pack.scope },
    } };
  } catch (error) {
    return { ok: false, status: 409, body: { error: error instanceof Error ? error.message : "case.plan_unavailable" } };
  }
}

export function registerCasePlanRoutes(app: FastifyInstance, options: { db: Database; authorize: Authorize; environment: string }) {
  app.post("/v1/case-plans/select", async (request, reply) => {
    const principal = await options.authorize(request, "case.write", { kind: "plan" });
    if (principal.actorType !== undefined && principal.actorType !== "human") return reply.code(403).send({ error: "authorization.interactive_user_required" });
    const parsed = caseScopeSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "case.scope_invalid" });
    const result = await selectCasePin(options.db, principal.tenantId, options.environment, parsed.data);
    return result.ok ? result.pin : reply.code(result.status).send(result.body);
  });
}
