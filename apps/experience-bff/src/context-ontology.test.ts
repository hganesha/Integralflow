import { afterEach, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import type { Upstream } from "./upstream.js";
const apps: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(a => a.close())); });
function app(upstream: Upstream, roles = ["Harness.Author"]) {
  const a = buildApp({ env: { BFF_PUBLIC_ORIGIN: "http://bff.test", BFF_IDENTITY_MODE: "delegated" }, principalResolver: {
    source: "local", resolve: async () => ({ subjectId: "author", tenantId: "tenant", actorType: "human", roles, source: "local" }) }, upstream });
  apps.push(a); return a;
}
async function csrf(a: FastifyInstance) {
  const s = await a.inject({ url: "/api/v1/session", headers: { authorization: "Bearer verified" } });
  return { origin: "http://bff.test", cookie: String(s.headers["set-cookie"]).split(";")[0]!, "x-csrf-token": s.json().csrfToken, "x-tenant-id": "spoofed" };
}
const payload = { planDigest: "a".repeat(64), nodeId: "step", sourceContextDigest: "b".repeat(64), query: { direction: "both", pageSize: 10, maxDepth: 2 } };
const graph = { scope: "authorized_case", snapshotDigest: "c".repeat(64), relationshipDigest: "d".repeat(64), asOf: "2026-11-09T12:00:00Z", knowledgeCutoff: "2026-11-09T12:00:00Z", purpose: "KYB_ONBOARDING", subjects: [], root: null, nodes: [], edges: [], unresolved: [], nextCursor: null, complete: true, truncated: false, limitations: [] };
it("rechecks source use, pins challenge time and forwards verified identity on the retry", async () => {
  let traversals = 0;
  const challenge = { caseId: "case/one", planDigest: payload.planDigest, nodeId: payload.nodeId, snapshotDigest: graph.snapshotDigest, offset: 0, query: { ...payload.query, asOf: graph.asOf, knowledgeCutoff: graph.knowledgeCutoff }, decisionIds: ["source-decision"], challengeToken: "held-challenge" };
  const upstream = vi.fn<Upstream>(async (_service, _method, path) => {
    if (path.endsWith("traversal-target")) return { status: 200, body: { plan: { pinned: true } } };
    if (path.endsWith("traversal-authority")) return { status: 200, body: { proof: "fresh-proof" } };
    return ++traversals === 1 ? { status: 403, body: { error: "context.traversal_source_authority_required", details: challenge } } : { status: 200, body: graph };
  });
  const a = app(upstream); const headers = await csrf(a);
  const r = await a.inject({ method: "POST", url: "/api/v1/fincrime/cases/case%2Fone/context:traverse", headers, payload });
  expect(r.statusCode, r.body).toBe(200); expect(r.headers["cache-control"]).toBe("no-store");
  expect(upstream.mock.calls).toHaveLength(4);
  for (const call of upstream.mock.calls) { expect(call[3]).toMatchObject({ tenantId: "tenant", subjectId: "author" }); expect(call[5]).toEqual({ "x-ehf-forwarded-authorization": "Bearer verified" }); }
  expect(upstream.mock.calls[2]?.[4]).toEqual({ ...challenge, challengeToken: undefined, sourceContextDigest: payload.sourceContextDigest });
  expect(upstream.mock.calls[3]?.[2]).toBe("/v2/cases/case%2Fone/context:traverse");
  expect(upstream.mock.calls[3]?.[4]).toMatchObject({ query: challenge.query, sourceProof: "fresh-proof", challengeToken: challenge.challengeToken });
});
it("rejects CSRF, unauthorized roles and invalid scope before reading upstream", async () => {
  const upstream = vi.fn<Upstream>(); const a = app(upstream);
  expect((await a.inject({ method: "POST", url: "/api/v1/fincrime/cases/c/context:traverse", payload })).statusCode).toBe(403);
  const headers = await csrf(a);
  expect((await a.inject({ method: "POST", url: "/api/v1/fincrime/cases/c/context:traverse", headers, payload: { ...payload, tenantId: "spoofed" } })).statusCode).toBe(400);
  const denied = app(upstream, ["Case.Analyst"]);
  expect((await denied.inject("/api/v1/fincrime/context/ontology")).statusCode).toBe(403);
  expect(upstream).not.toHaveBeenCalled();
});
it("does not retry denied source authority or accept an invalid graph response", async () => {
  const upstream = vi.fn<Upstream>(async (_s, _m, path) => path.endsWith("traversal-target") ? { status: 200, body: { plan: {} } } : { status: 200, body: { nodes: [{ secret: "bad" }] } });
  const a = app(upstream); const headers = await csrf(a);
  const r = await a.inject({ method: "POST", url: "/api/v1/fincrime/cases/c/context:traverse", headers, payload });
  expect(r.statusCode).toBe(502); expect(r.body).not.toContain("secret");
});
it("stops at a denied current source-use decision without retrying the graph read", async () => {
  const upstream = vi.fn<Upstream>(async (_s, _m, path) => {
    if (path.endsWith("traversal-target")) return { status: 200, body: { plan: {} } };
    if (path.endsWith("traversal-authority")) return { status: 403, body: { error: "context.traversal_source_use_denied" } };
    return { status: 403, body: { error: "context.traversal_source_authority_required", details: { challengeToken: "challenge", query: payload.query } } };
  });
  const a = app(upstream); const headers = await csrf(a);
  const response = await a.inject({ method: "POST", url: "/api/v1/fincrime/cases/c/context:traverse", headers, payload });
  expect(response.statusCode).toBe(403); expect(response.json().error).toBe("context.traversal_source_use_denied");
  expect(upstream.mock.calls).toHaveLength(3); expect(response.json()).not.toHaveProperty("details");
});
