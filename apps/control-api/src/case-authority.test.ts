import { beforeEach, expect, it, vi } from "vitest";
import { getPlan, getPublishedPolicy, requireExecutableRelease } from "@ehf/persistence";
import { buildControlApi } from "./app.js";

vi.mock("@ehf/persistence", async (original) => ({
  ...await original<typeof import("@ehf/persistence")>(),
  getPlan: vi.fn(), getPublishedPolicy: vi.fn(), requireExecutableRelease: vi.fn(),
}));
const digest = "a".repeat(64);
const bundleDigest = "b".repeat(64);
const plan = { planDigest: digest, dependencyManifestDigest: "c".repeat(64),
  policyBundles: [{ policyId: "onboarding", bundleDigest }] };
const headers = { authorization: "Bearer edge-token-long-enough-for-tests", "x-actor-id": "analyst",
  "x-actor-roles": "Case.Analyst", "x-tenant-id": "tenant_verified" };
const url = `/v1/plans/${digest}/case-authority`;
function app() {
  return buildControlApi({ db: { query: vi.fn() } as never, contextStore: null,
    serviceGrants: [{ token: "edge-token-long-enough-for-tests", subjectId: "edge", roles: ["Edge.Delegate"], tenantId: "tenant_verified" }],
    env: { IDENTITY_PROVIDER: "local_headers", AUTHORING_MODE: "disabled" } });
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getPlan).mockResolvedValue(plan as never);
  vi.mocked(requireExecutableRelease).mockResolvedValue({ manifest: { policyBundleDigests: [`sha256:${bundleDigest}`] } } as never);
  vi.mocked(getPublishedPolicy).mockResolvedValue({ compiledBundle: { sourceDigest: "d".repeat(64), policyVersion: "1.0.0" } } as never);
});
it("registers case authority at startup and returns only the released policy pins to a case creator", async () => {
  const server = app();
  try {
    const response = await server.inject({ url, headers });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({ planDigest: digest, policySnapshotDigest: "d".repeat(64),
      policyAuthority: { policyId: "onboarding", policyVersion: "1.0.0", policyBundleDigest: bundleDigest, dependencyDigest: "c".repeat(64) } });
    expect(getPlan).toHaveBeenCalledWith(expect.anything(), digest, "tenant_verified");
    expect(requireExecutableRelease).toHaveBeenCalledWith(expect.anything(), "tenant_verified", digest, "development");
    expect(getPublishedPolicy).toHaveBeenCalledWith(expect.anything(), "tenant_verified", bundleDigest);
  } finally { await server.close(); }
});
it("rejects a missing case-write role and forged tenant before reading plan authority", async () => {
  const server = app();
  try {
    expect((await server.inject({ url, headers: { ...headers, "x-actor-roles": "Harness.Reader" } })).statusCode).toBe(403);
    const forged = await server.inject({ url, headers: { ...headers, "x-tenant-id": "other_tenant" } });
    expect(forged.statusCode).toBe(403);
    expect(forged.json().error).toBe("authorization.delegated_tenant_mismatch");
    expect(getPlan).not.toHaveBeenCalled();
  } finally { await server.close(); }
});
it("refuses ambiguous or unpublished policy authority and a policy outside the active release", async () => {
  const server = app();
  const request = () => server.inject({ url, headers });
  try {
    vi.mocked(getPlan).mockResolvedValueOnce({ ...plan, policyBundles: [...plan.policyBundles, { policyId: "other", bundleDigest }] } as never);
    expect((await request()).json().error).toBe("case.policy_authority_ambiguous");
    vi.mocked(getPublishedPolicy).mockResolvedValueOnce(null);
    expect((await request()).json().error).toBe("case.policy_authority_unavailable");
    vi.mocked(requireExecutableRelease).mockResolvedValueOnce({ manifest: { policyBundleDigests: ["e".repeat(64)] } } as never);
    const response = await request();
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe("case.policy_authority_unavailable");
  } finally { await server.close(); }
});
it("returns a missing plan without disclosing policy state", async () => {
  const server = app();
  try {
    vi.mocked(getPlan).mockResolvedValueOnce(null);
    expect((await server.inject({ url, headers })).statusCode).toBe(404);
    expect(requireExecutableRelease).not.toHaveBeenCalled();
    expect(getPublishedPolicy).not.toHaveBeenCalled();
  } finally { await server.close(); }
});
