import { expect, it, vi } from "vitest";
import { createKycCaseRequestSchema } from "@ehf/contracts";
import { buildApp } from "./app.js";
import type { Upstream } from "./upstream.js";

const principal = { subjectId: "analyst", tenantId: "tenant-cases", actorType: "human" as const, roles: ["Case.Analyst"], source: "local" as const };
const SCOPE = { customerType: "corporate", trigger: "onboarding", dueDiligence: "standard", jurisdiction: "GB", products: ["deposit", "payments"] };
const PLAN = "e".repeat(64);
const SELECTION = {
  planDigest: PLAN, policySnapshotDigest: "5".repeat(64),
  policyAuthority: { policyId: "policy.pack.gb.bank-synthetic.business-banking", policyVersion: "1.0.0", policyBundleDigest: "8".repeat(64), dependencyDigest: "b".repeat(64) },
  scope: { customerType: "corporate", trigger: "onboarding", dueDiligence: "standard", jurisdictions: ["US", "GB"], products: ["deposit", "lending", "merchant_acquiring", "payments"], institution: "bank.synthetic" },
  pack: { id: "policy.pack.gb.bank-synthetic.business-banking", scope: { jurisdiction: "GB", institution: "bank.synthetic", productSet: "business-banking", products: ["deposit", "lending", "merchant_acquiring", "payments"], customerTypes: ["corporate"] } },
};

async function harness(upstream: Upstream) {
  const app = buildApp({ env: { BFF_PUBLIC_ORIGIN: "http://ui.test", BFF_IDENTITY_MODE: "delegated" }, principalResolver: { source: "local", resolve: async () => principal }, upstream });
  const session = await app.inject({ url: "/api/v1/session", headers: { authorization: "Bearer analyst-session" } });
  const headers = { cookie: String(session.headers["set-cookie"]).split(";")[0]!, origin: "http://ui.test", "x-csrf-token": session.json().csrfToken };
  return { app, headers };
}

it("relays a case plan selection and keeps a refusal's reason and candidates", async () => {
  const upstream = vi.fn<Upstream>(async () => ({ status: 200, body: SELECTION }));
  const { app, headers } = await harness(upstream);
  try {
    const response = await app.inject({ method: "POST", url: "/api/v1/case-plans/select", payload: SCOPE, headers });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().pack.id).toBe("policy.pack.gb.bank-synthetic.business-banking");
    expect(upstream.mock.calls.at(-1)?.slice(0, 5)).toEqual(["control-api", "POST", "/v1/case-plans/select", principal, SCOPE]);
    upstream.mockResolvedValueOnce({ status: 422, body: { error: "case.plan_no_pack", message: "no released plan pins a pack for AU covering card", candidates: ["a".repeat(64)] } });
    const refused = await app.inject({ method: "POST", url: "/api/v1/case-plans/select", payload: { ...SCOPE, customerType: "individual", jurisdiction: "AU", products: ["card"] }, headers });
    expect(refused.statusCode).toBe(422);
    expect(refused.json()).toMatchObject({ error: "case.plan_no_pack", message: expect.stringContaining("AU"), details: { candidates: ["a".repeat(64)] } });
  } finally { await app.close(); }
});

it("opens a case by its scope: re-selects the plan, pins its pack and uses the scope's jurisdiction", async () => {
  const upstream = vi.fn<Upstream>(async (_service, method, path) => path === "/v1/case-plans/select" ? { status: 200, body: SELECTION }
    : method === "POST" ? { status: 201, body: { created: true, case: { caseId: "case-gb", caseSequence: 1 } } } : { status: 500, body: {} });
  const { app, headers } = await harness(upstream);
  try {
    const payload = { caseType: "kyc_onboarding", harnessPlanDigest: PLAN, externalRef: "ACME-GB-1", classification: "confidential", scope: SCOPE };
    const response = await app.inject({ method: "POST", url: "/api/v1/cases", payload, headers: { ...headers, "idempotency-key": "create-gb" } });
    expect(response.statusCode, response.body).toBe(201);
    expect(response.json()).toEqual({ caseId: "case-gb", caseSequence: 1 });
    const [select, create] = upstream.mock.calls;
    expect(select?.slice(1, 3)).toEqual(["POST", "/v1/case-plans/select"]);
    expect(select?.[5]).not.toHaveProperty("idempotency-key");
    expect(create?.slice(0, 3)).toEqual(["case-api", "POST", "/v1/cases"]);
    expect(create?.[4]).toMatchObject({ jurisdiction: "GB", harnessPlanDigest: PLAN, policySnapshotDigest: SELECTION.policySnapshotDigest, policyAuthority: SELECTION.policyAuthority, externalRef: "ACME-GB-1" });
    expect(create?.[4]).not.toHaveProperty("scope");
    expect(createKycCaseRequestSchema.safeParse(create?.[4]).success).toBe(true);
    expect(create?.[5]?.["idempotency-key"]).toBe("create-gb");
    expect(upstream.mock.calls.some((call) => String(call[2]).includes("case-authority"))).toBe(false);

    // The creator reviewed one plan; a different selection now is a conflict, never a silent switch.
    upstream.mockClear();
    const changed = await app.inject({ method: "POST", url: "/api/v1/cases", payload: { ...payload, harnessPlanDigest: "f".repeat(64) }, headers });
    expect(changed.statusCode).toBe(409);
    expect(changed.json().error).toBe("case.plan_selection_changed");
    expect(upstream.mock.calls.filter((call) => call[0] === "case-api")).toHaveLength(0);

    upstream.mockResolvedValueOnce({ status: 422, body: { error: "case.plan_no_plan", message: "no released plan for trust onboarding with standard due diligence", candidates: [] } });
    const refused = await app.inject({ method: "POST", url: "/api/v1/cases", payload: { ...payload, scope: { ...SCOPE, customerType: "trust" } }, headers });
    expect(refused.statusCode).toBe(422);
    expect(refused.json()).toMatchObject({ error: "case.plan_no_plan", message: expect.stringContaining("trust") });
  } finally { await app.close(); }
});

it("opens a scoped case with the case type of its customer: KYB for a business or trust, KYC for a person", async () => {
  const upstream = vi.fn<Upstream>(async (_service, method, path, _principal, body) => path === "/v1/case-plans/select"
    ? { status: 200, body: { ...SELECTION, pack: { ...SELECTION.pack, scope: { ...SELECTION.pack.scope, jurisdiction: (body as { jurisdiction: string }).jurisdiction } } } }
    : method === "POST" ? { status: 201, body: { created: true, case: { caseId: "case-x", caseSequence: 1 } } } : { status: 500, body: {} });
  const { app, headers } = await harness(upstream);
  try {
    for (const [customerType, caseType, schemaVersion] of [["corporate", "kyb_onboarding", "kyb.case.v1"], ["trust", "kyb_onboarding", "kyb.case.v1"], ["individual", "kyc_onboarding", "kyc.case.v1"]] as const) {
      upstream.mockClear();
      const response = await app.inject({ method: "POST", url: "/api/v1/cases", headers: { ...headers, "idempotency-key": `create-${customerType}` },
        payload: { caseType: customerType === "individual" ? "kyc_onboarding" : "kyb_onboarding", harnessPlanDigest: PLAN, classification: "confidential", scope: { ...SCOPE, customerType } } });
      expect(response.statusCode, response.body).toBe(201);
      const create = upstream.mock.calls.find((call) => call[0] === "case-api")!;
      expect(create[4]).toMatchObject({ caseType, schemaVersion });
      expect(createKycCaseRequestSchema.safeParse(create[4]).success).toBe(true);
    }
    // Without a scope the plan's single policy pin applies, as before: a KYC case in US.
    upstream.mockImplementation(async (_service, method, path) => path.endsWith("/case-authority")
      ? { status: 200, body: { planDigest: PLAN, policySnapshotDigest: SELECTION.policySnapshotDigest, policyAuthority: SELECTION.policyAuthority } }
      : method === "POST" ? { status: 201, body: { created: true, case: { caseId: "case-us", caseSequence: 1 } } } : { status: 500, body: {} });
    upstream.mockClear();
    const unscoped = await app.inject({ method: "POST", url: "/api/v1/cases", headers: { ...headers, "idempotency-key": "create-unscoped" }, payload: { caseType: "KYB", harnessPlanDigest: PLAN, classification: "confidential" } });
    expect(unscoped.statusCode, unscoped.body).toBe(201);
    expect(upstream.mock.calls.find((call) => call[0] === "case-api")![4]).toMatchObject({ caseType: "kyc_onboarding", schemaVersion: "kyc.case.v1", jurisdiction: "US" });
  } finally { await app.close(); }
});
