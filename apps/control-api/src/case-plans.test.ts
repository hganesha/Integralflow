import { readFileSync } from "node:fs";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { HarnessPlanV2 } from "@ehf/contracts";

const read = (name: string) => JSON.parse(readFileSync(new URL(`../../../artifacts/${name}.plan.json`, import.meta.url), "utf8")) as HarnessPlanV2;
const kyc = read("kyc-agentic");
const kyb = read("kyb-agentic");
const plans = new Map([kyc, kyb].map((plan) => [plan.planDigest, plan]));
const bundleOf = (plan: HarnessPlanV2) => plan.policyBundles[0]!.bundleDigest;
const release = (plan: HarnessPlanV2, environment = "development") => ({
  manifest: { planDigest: plan.planDigest, policyBundleDigests: [bundleOf(plan)], scope: { environment }, manifestDigest: "m" },
  record: { status: "active" },
});
const state = { releases: [release(kyc), release(kyb)], executable: true };

vi.mock("@ehf/persistence", async (original) => ({
  ...(await original<typeof import("@ehf/persistence")>()),
  listReleases: vi.fn(async () => state.releases),
  // The releases in effect: here every active release in the environment.

  listReleasesInEffect: vi.fn(async (_db: unknown, _tenant: string, environment: string) => (state.releases).filter((entry: { record: { status: string }; manifest: { scope: { environment: string } } }) => entry.record.status === "active" && entry.manifest.scope.environment === environment)),
  getPlan: vi.fn(async (_db: unknown, digest: string) => plans.get(digest) ?? null),
  requireExecutableRelease: vi.fn(async (_db: unknown, _tenant: string, digest: string) => {
    if (!state.executable) throw new Error("release.executable_authority_missing");
    return release(plans.get(digest)!);
  }),
  getPublishedPolicy: vi.fn(async (_db: unknown, _tenant: string, digest: string) => ({ compiledBundle: { bundleDigest: digest, sourceDigest: "s".repeat(64) } })),
}));
const { registerCasePlanRoutes } = await import("./case-plans.js");

function app(actorType = "human") {
  const server = Fastify();
  registerCasePlanRoutes(server, { db: {} as never, environment: "development", authorize: async () => ({ tenantId: "tenant-1", actorType }) });
  return server;
}
const select = (scope: Record<string, unknown>, actorType?: string) => app(actorType).inject({ method: "POST", url: "/v1/case-plans/select", payload: scope });

describe("case plan selection", () => {
  it("pins a business case to the released KYB plan and its jurisdiction's pack", async () => {
    const response = await select({ customerType: "corporate", trigger: "onboarding", jurisdiction: "GB", products: ["deposit", "payments"] });
    expect(response.statusCode, response.body).toBe(200);
    const pack = (kyb.graph.nodes.find((node) => node.kind === "gate")!.config.policyPacks as Array<{ id: string; digest: string; version: string }>)
      .find((item) => item.id === "policy.pack.gb.bank-synthetic.business-banking")!;
    expect(response.json()).toMatchObject({
      planDigest: kyb.planDigest,
      policyAuthority: { policyId: pack.id, policyBundleDigest: pack.digest, policyVersion: pack.version, dependencyDigest: kyb.dependencyManifestDigest },
      scope: { customerType: "corporate", trigger: "onboarding", dueDiligence: "standard" },
    });
  });

  it("refuses with the reason when no released plan or pack covers the case", async () => {
    const enhanced = await select({ customerType: "individual", trigger: "onboarding", dueDiligence: "enhanced", jurisdiction: "US", products: ["card"] });
    expect(enhanced.statusCode).toBe(422);
    expect(enhanced.json().error).toBe("case.plan_no_plan");
    const australia = await select({ customerType: "individual", trigger: "onboarding", jurisdiction: "AU", products: ["card"] });
    expect(australia.json().error).toBe("case.plan_no_pack");
    const lending = await select({ customerType: "individual", trigger: "onboarding", jurisdiction: "US", products: ["lending"] });
    expect(lending.json().error).toBe("case.plan_no_pack");
    expect((await select({ customerType: "partnership", trigger: "onboarding", jurisdiction: "US", products: ["deposit"] })).statusCode).toBe(400);
    expect((await select({ customerType: "trust", trigger: "onboarding", jurisdiction: "US", products: ["deposit"] })).json().error).toBe("case.plan_no_plan");
  });

  it("only offers plans with an active release in this environment, and re-checks its authority", async () => {
    state.releases = [release(kyc, "production")];
    expect((await select({ customerType: "individual", trigger: "onboarding", jurisdiction: "US", products: ["card"] })).json().error).toBe("case.plan_no_plan");
    state.releases = [release(kyc), release(kyb)];
    state.executable = false;
    const revoked = await select({ customerType: "individual", trigger: "onboarding", jurisdiction: "US", products: ["card"] });
    expect(revoked.statusCode).toBe(409);
    expect(revoked.json().error).toBe("release.executable_authority_missing");
    state.executable = true;
  });

  it("is for an interactive case creator", async () => {
    expect((await select({ customerType: "individual", trigger: "onboarding", jurisdiction: "US", products: ["card"] }, "service")).statusCode).toBe(403);
  });
});
