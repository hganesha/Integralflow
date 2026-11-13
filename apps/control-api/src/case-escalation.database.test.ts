import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { HarnessPlanV2 } from "@ehf/contracts";

/**
 * EDD escalation end to end below the outbox: the control plane's escalation against a real case API
 * (its authorization, command validation and ledger) on a real case store in PostgreSQL. The release
 * catalogue is the real KYC and KYC-EDD plans with their releases stubbed.
 */
const database = process.env.EHF_TEST_DATABASE_URL;
const read = (name: string) => JSON.parse(readFileSync(new URL(`../../../artifacts/${name}.plan.json`, import.meta.url), "utf8")) as HarnessPlanV2;
const kyc = read("kyc-agentic");
const kycEdd = read("kyc-edd-agentic");
const plans = new Map([kyc, kycEdd].map((plan) => [plan.planDigest, plan]));
const release = (plan: HarnessPlanV2) => ({
  manifest: { planDigest: plan.planDigest, policyBundleDigests: [plan.policyBundles[0]!.bundleDigest], scope: { environment: "development" }, manifestDigest: "m" },
  record: { status: "active" },
});
const runs: unknown[] = [];
vi.mock("@ehf/persistence", async (original) => ({
  ...(await original<typeof import("@ehf/persistence")>()),
  listReleases: vi.fn(async () => [release(kyc), release(kycEdd)]),
  // The releases in effect: both, as every active release is here.
  listReleasesInEffect: vi.fn(async () => [release(kyc), release(kycEdd)]),
  getPlan: vi.fn(async (_db: unknown, digest: string) => plans.get(digest) ?? null),
  requireExecutableRelease: vi.fn(async (_db: unknown, _tenant: string, digest: string) => release(plans.get(digest)!)),
  getPublishedPolicy: vi.fn(async (_db: unknown, _tenant: string, digest: string) => ({ compiledBundle: { bundleDigest: digest, sourceDigest: "e".repeat(64) } })),
  createRun: vi.fn(async (_db: unknown, input: unknown) => { runs.push(input); return { created: true, run: { runId: "RUN-edd" } }; }),
}));

describe.skipIf(!database)("EDD escalation through the case API in PostgreSQL", async () => {
  const { escalateCaseDueDiligence } = await import("./case-escalation.js");
  // The case API and case store from source (computed paths: outside this package's compilation).
  const caseApiModule = new URL("../../case-api/src/app.ts", import.meta.url).href, caseStoreModule = new URL("../../../packages/case-store/src/index.ts", import.meta.url).href;
  const { buildCaseApi } = await import(caseApiModule) as { buildCaseApi: (options: Record<string, unknown>) => import("fastify").FastifyInstance };
  const { createCaseStore, createKycCase, submitBusinessCommand } = await import(caseStoreModule) as {
    createCaseStore: (options: { connectionString: string }) => { db: { query: (sql: string, values?: unknown[]) => Promise<{ rows: any[] }>; end: () => Promise<void> } };
    createKycCase: (store: unknown, request: unknown, key: string) => Promise<{ case: { caseId: string } }>;
    submitBusinessCommand: (store: unknown, command: unknown) => Promise<unknown>;
  };
  const { createKycCaseRequestSchema } = await import("@ehf/contracts");
  // A skipped describe still collects: the store is only opened when a database is configured.
  const store = database ? createCaseStore({ connectionString: database }) : null!;
  afterAll(() => store?.db.end().catch(() => undefined));
  const TOKEN = `control-api-token-${randomBytes(8).toString("hex")}`;

  it("moves the case onto the enhanced process, completes the escalation once, and attributes it to the control plane", async () => {
    const tenantId = `t-${randomUUID()}`;
    for (const plan of [kyc, kycEdd]) {
      await store.db.query("insert into harness_control.plans(plan_digest,plan_id,name,domain,version,plan,tenant_id) values($1,$2,'test','kyc','1','{}',$3) on conflict do nothing",
        [plan.planDigest, `plan-${plan.planDigest.slice(0, 8)}-${tenantId.slice(2, 10)}`, tenantId]);
    }
    const policy = randomBytes(32).toString("hex");
    const created = await createKycCase(store, createKycCaseRequestSchema.parse({
      tenantId, jurisdiction: "GB", policySnapshotDigest: policy, harnessPlanDigest: kyc.planDigest,
      actor: { type: "HUMAN", principalId: "analyst@example.test", roles: [] },
      policyAuthority: { policyId: "policy.pack.gb.bank-synthetic.personal-banking", policyVersion: "2.0.0", policyBundleDigest: randomBytes(32).toString("hex"), dependencyDigest: kyc.dependencyManifestDigest },
    }), randomUUID());
    const caseId = String(created.case.caseId);
    const sequence = async () => Number((await store.db.query("select case_sequence from case_core.cases where tenant_id=$1 and case_id=$2", [tenantId, caseId])).rows[0].case_sequence);
    // The decision-ready checkpoint's escalation, as the case API records it.
    await submitBusinessCommand(store, {
      commandId: randomUUID(), commandType: "ProposeWorkItem", commandVersion: "v1", tenantId, caseId,
      actor: { type: "SYSTEM", principalId: "policy", roles: [] },
      authority: { planDigest: kyc.planDigest, permissionEnvelopeDigest: "b".repeat(64), policySnapshotDigest: policy },
      payload: { workItemId: "edd-escalation", workType: "EDD_ESCALATION", priority: "HIGH" }, preconditions: { caseSequence: await sequence() }, idempotencyKey: randomUUID(),
    });

    const caseApi = buildCaseApi({ store, env: {}, serviceGrants: [{ token: TOKEN, subjectId: "control-api", roles: ["Edge.Delegate", "Case.Replan"], tenantId }] });
    const caseService = async (tenant: string, path: string, init: { method?: string; body?: unknown } = {}) => {
      const response = await caseApi.inject({ method: (init.method ?? "GET") as "GET" | "POST", url: path, headers: { authorization: `Bearer ${TOKEN}`, "x-tenant-id": tenant }, ...(init.body !== undefined ? { payload: init.body as object } : {}) });
      const body = response.json();
      if (response.statusCode >= 400) throw new Error(String(body.error ?? response.statusCode));
      return body;
    };
    const escalate = () => escalateCaseDueDiligence({ db: {} as never, environment: "development", tenantId, caseId, requestedBy: "policy:edd-escalation", caseService });

    const result = await escalate();
    expect(result).toMatchObject({ status: "replanned", fromPlanDigest: kyc.planDigest, toPlanDigest: kycEdd.planDigest, policyId: "policy.pack.gb.bank-synthetic.personal-banking", runId: "RUN-edd" });
    const row = (await store.db.query("select harness_plan_digest, policy_id from case_core.cases where tenant_id=$1 and case_id=$2", [tenantId, caseId])).rows[0];
    expect(row).toEqual({ harness_plan_digest: kycEdd.planDigest, policy_id: "policy.pack.gb.bank-synthetic.personal-banking" });
    const item = (await store.db.query("select status from case_core.case_work_items where tenant_id=$1 and case_id=$2 and work_item_id='edd-escalation'", [tenantId, caseId])).rows[0];
    expect(item.status).toBe("COMPLETED");
    const event = (await store.db.query("select actor, payload from case_ledger.case_events where tenant_id=$1 and case_id=$2 and event_type='case.replanned'", [tenantId, caseId])).rows;
    expect(event).toHaveLength(1);
    expect(event[0].actor).toMatchObject({ type: "SYSTEM", principalId: "control-api" });
    expect(event[0].payload).toMatchObject({ fromPlanDigest: kyc.planDigest, toPlanDigest: kycEdd.planDigest, requestedBy: "policy:edd-escalation" });
    // The escalation is spent: running it again does nothing.
    expect(await escalate()).toEqual({ status: "not_required", caseId });
    await caseApi.close();
  });
});
