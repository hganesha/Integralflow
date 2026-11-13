import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { HarnessPlanV2 } from "@ehf/contracts";

const read = (name: string) => JSON.parse(readFileSync(new URL(`../../../artifacts/${name}.plan.json`, import.meta.url), "utf8")) as HarnessPlanV2;
const kyc = read("kyc-agentic");
const kycEdd = read("kyc-edd-agentic");
const plans = new Map([kyc, kycEdd].map((plan) => [plan.planDigest, plan]));
const release = (plan: HarnessPlanV2) => ({
  manifest: { planDigest: plan.planDigest, policyBundleDigests: [plan.policyBundles[0]!.bundleDigest], scope: { environment: "development" }, manifestDigest: "m" },
  record: { status: "active" },
});
const state = { releases: [release(kyc), release(kycEdd)] };
const runs: Array<{ planDigest: string; runInput: unknown; idempotencyKey: string }> = [];

vi.mock("@ehf/persistence", async (original) => ({
  ...(await original<typeof import("@ehf/persistence")>()),
  listReleases: vi.fn(async () => state.releases),
  // The releases in effect: here every active release in the environment.

  listReleasesInEffect: vi.fn(async (_db: unknown, _tenant: string, environment: string) => (state.releases).filter((entry: { record: { status: string }; manifest: { scope: { environment: string } } }) => entry.record.status === "active" && entry.manifest.scope.environment === environment)),
  getPlan: vi.fn(async (_db: unknown, digest: string) => plans.get(digest) ?? null),
  requireExecutableRelease: vi.fn(async (_db: unknown, _tenant: string, digest: string) => release(plans.get(digest)!)),
  getPublishedPolicy: vi.fn(async (_db: unknown, _tenant: string, digest: string) => ({ compiledBundle: { bundleDigest: digest, sourceDigest: "s".repeat(64) } })),
  createRun: vi.fn(async (_db: unknown, input: { planDigest: string; runInput: unknown; idempotencyKey: string }) => { runs.push(input); return { created: true, run: { runId: "RUN-1" } }; }),
}));
const { escalateCaseDueDiligence } = await import("./case-escalation.js");

function caseService(view: { plan: HarnessPlanV2; jurisdiction?: string; workItems?: Array<{ work_item_id: string; work_type: string; status: string }>; status?: string }) {
  const commands: any[] = [];
  const request = vi.fn(async (_tenant: string, path: string, init?: { method?: string; body?: unknown }) => {
    if (init?.method === "POST") { commands.push(init.body); return { ok: true }; }
    expect(path).toBe("/v1/cases/case-1/replan-context");
    return { case: { status: view.status ?? "SCREENING", jurisdiction: view.jurisdiction ?? "GB", harnessPlanDigest: view.plan.planDigest, policySnapshotDigest: "p".repeat(64), caseSequence: 12 },
      workItems: view.workItems ?? [{ work_item_id: "edd-escalation", work_type: "EDD_ESCALATION", status: "OPEN" }] };
  });
  return { request, commands };
}
const escalate = (service: ReturnType<typeof caseService>, extra: { runsRequireSourceContext?: boolean } = {}) => escalateCaseDueDiligence({
  db: {} as never, environment: "development", tenantId: "tenant-1", caseId: "case-1", requestedBy: "policy:edd-escalation", caseService: service.request, ...extra,
});

describe("enhanced due-diligence escalation", () => {
  it("moves a standard case onto the released enhanced process for its pinned pack, completes the escalation and starts the run", async () => {
    runs.length = 0;
    const service = caseService({ plan: kyc });
    const result = await escalate(service);
    const pack = ((kycEdd.graph.nodes.find((node) => node.kind === "gate")!.config.policyPacks) as Array<{ id: string; digest: string; scope: { jurisdiction: string } }>)
      .find((item) => item.scope.jurisdiction === "GB")!;
    expect(result).toMatchObject({ status: "replanned", fromPlanDigest: kyc.planDigest, toPlanDigest: kycEdd.planDigest, policyId: pack.id, runId: "RUN-1" });
    expect(service.commands).toHaveLength(1);
    expect(service.commands[0]).toMatchObject({
      commandType: "ReplanCase", tenantId: "tenant-1", caseId: "case-1", preconditions: { caseSequence: 12 },
      authority: { planDigest: kyc.planDigest, policySnapshotDigest: "p".repeat(64) },
      payload: { harnessPlanDigest: kycEdd.planDigest, workItemId: "edd-escalation", requestedBy: "policy:edd-escalation",
        policyAuthority: { policyId: pack.id, policyBundleDigest: pack.digest, dependencyDigest: kycEdd.dependencyManifestDigest } },
      idempotencyKey: "replan:tenant-1:case-1:edd-escalation",
    });
    expect(runs).toEqual([{ planDigest: kycEdd.planDigest, runInput: { tenantId: "tenant-1", caseId: "case-1" }, idempotencyKey: "replan:case-1:edd-escalation", tenantId: "tenant-1" }]);
  });

  it("does nothing without an open escalation, or for a case already under enhanced due diligence", async () => {
    const closed = caseService({ plan: kyc, workItems: [{ work_item_id: "edd-escalation", work_type: "EDD_ESCALATION", status: "COMPLETED" }, { work_item_id: "w", work_type: "DOCUMENT_REQUEST", status: "OPEN" }] });
    expect(await escalate(closed)).toEqual({ status: "not_required", caseId: "case-1" });
    const enhanced = caseService({ plan: kycEdd });
    expect(await escalate(enhanced)).toEqual({ status: "already_enhanced", caseId: "case-1" });
    expect([...closed.commands, ...enhanced.commands]).toEqual([]);
  });

  it("refuses with the reason when no enhanced process is released, the jurisdiction has no pack, or the case is final", async () => {
    state.releases = [release(kyc)];
    const unreleased = caseService({ plan: kyc });
    expect(await escalate(unreleased)).toMatchObject({ status: "refused", httpStatus: 422, error: "case.plan_no_plan" });
    state.releases = [release(kyc), release(kycEdd)];
    expect(await escalate(caseService({ plan: kyc, jurisdiction: "DE" }))).toMatchObject({ status: "refused", error: "case.escalation_pack_ambiguous" });
    expect(await escalate(caseService({ plan: kyc, status: "APPROVED" }))).toMatchObject({ status: "refused", error: "case.escalation_case_final" });
    expect(unreleased.commands).toEqual([]);
  });

  it("leaves the run to the operator where a source context must be admitted first", async () => {
    runs.length = 0;
    expect(await escalate(caseService({ plan: kyc }), { runsRequireSourceContext: true })).toMatchObject({ status: "replanned", runId: null, runNote: "run.source_context_required" });
    expect(runs).toEqual([]);
  });
});
