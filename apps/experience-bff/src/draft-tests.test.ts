import { expect, it, vi } from "vitest";
import { buildApp } from "./app.js";
import type { Upstream } from "./upstream.js";

it("relays draft tests with CSRF, role, tenant and idempotency context intact", async () => {
  const principal = { subjectId: "author", tenantId: "tenant-tests", actorType: "human" as const, roles: ["Harness.Author"], source: "local" as const };
  const run = { testRunId: "dtest-1", draftId: "draft-1", revision: 4, planDigest: "a".repeat(64), mode: "recorded", status: "running", createdAt: new Date().toISOString(), finishedAt: null, error: null, output: null, warnings: [], calls: [], nodes: [] };
  const upstream = vi.fn<Upstream>(async () => ({ status: 200, body: run }));
  const app = buildApp({ env: { BFF_PUBLIC_ORIGIN: "http://ui.test", BFF_IDENTITY_MODE: "delegated" }, principalResolver: { source: "local", resolve: async () => principal }, upstream });
  try {
    const session = await app.inject({ url: "/api/v1/session", headers: { authorization: "Bearer author-session" } });
    const headers = { cookie: String(session.headers["set-cookie"]).split(";")[0]!, origin: "http://ui.test", "x-csrf-token": session.json().csrfToken, "idempotency-key": "test-request-1" };
    const url = "/api/v1/authoring/drafts/draft-1/test-runs";
    const payload = { expectedRevision: 4, mode: "recorded", input: {}, context: {}, capabilityOutputs: {} };
    expect((await app.inject({ method: "POST", url, payload })).statusCode).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
    const response = await app.inject({ method: "POST", url, payload, headers });
    expect(response.statusCode, response.body).toBe(200);
    expect(upstream.mock.calls.at(-1)?.slice(0, 3)).toEqual(["control-api", "POST", "/v1/authoring/drafts/draft-1/test-runs"]);
    expect(upstream.mock.calls.at(-1)?.[5]).toMatchObject({ "x-ehf-forwarded-authorization": "Bearer author-session", "idempotency-key": "test-request-1" });
    principal.roles = ["Harness.Reader"];
    expect((await app.inject({ method: "POST", url, payload, headers })).statusCode).toBe(403);
    upstream.mockResolvedValueOnce({ status: 409, body: { error: "authoring.revision_conflict" } });
    principal.roles = ["Harness.Author"];
    expect((await app.inject({ method: "POST", url, payload, headers })).json().error).toBe("authoring.revision_conflict");
  } finally { await app.close(); }
});
