import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import type { Upstream } from "./upstream.js";
const plan = JSON.parse(readFileSync(new URL("../../../artifacts/archive/kyb.plan.json", import.meta.url), "utf8"));
const now = "2026-11-08T12:00:00Z";
const run = { runId: "run_source", idempotencyKey: "source-intent", planDigest: plan.planDigest, status: "queued", terminalOutcome: null, input: {}, output: null, attempt: 0, fencingEpoch: 0, latestCheckpointId: null, currentNodeId: null, errorCode: null, traceId: null, rootSpanId: null, traceFlags: null, costUsd: 0, costComplete: true, modelCalls: 0, capabilityCalls: 0, createdAt: now, startedAt: null, completedAt: null, updatedAt: now };
const apps: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });
async function setup(roles = ["Harness.Operator"]) {
  const upstream = vi.fn<Upstream>(async () => ({ status: 200, body: { artifacts: [] } }));
  const app = buildApp({ env: { BFF_PUBLIC_ORIGIN: "http://bff.test" }, principalResolver: { source: "local", resolve: async () => ({ subjectId: "reviewer", tenantId: "verified-tenant", actorType: "human", roles, source: "local" }) }, upstream });
  apps.push(app);
  const session = await app.inject("/api/v1/session");
  const headers = { origin: "http://bff.test", cookie: String(session.headers["set-cookie"]).split(";")[0]!, "x-csrf-token": session.json().csrfToken, "idempotency-key": "source-intent" };
  return { app, upstream, headers };
}
it("relays source reads with the verified tenant and preserves the artifact filter", async () => {
  const { app, upstream } = await setup();
  const response = await app.inject({ url: "/api/v1/source-policies/artifacts?kind=source-binding", headers: { "x-tenant-id": "spoofed" } });
  expect(response.statusCode).toBe(200);
  expect(upstream.mock.calls[0]!.slice(0, 3)).toEqual(["control-api", "GET", "/v1/source-policies/artifacts?kind=source-binding"]);
  expect(upstream.mock.calls[0]![3].tenantId).toBe("verified-tenant");
});
it("blocks writes without CSRF and missing-role approvals before the upstream call", async () => {
  const { app, upstream, headers } = await setup(["Harness.Author"]);
  expect((await app.inject({ method: "POST", url: "/api/v1/authoring/source-policies/compile", payload: { artifact: {} } })).statusCode).toBe(403);
  expect((await app.inject({ method: "POST", url: `/api/v1/source-policies/artifacts/source-binding/${"a".repeat(64)}/approve`, headers })).statusCode).toBe(403);
  expect(upstream).not.toHaveBeenCalled();
});
it("forwards source-context run pins and retry identity, normalizing creation and replay", async () => {
  const { app, upstream, headers } = await setup();
  const payload = { planDigest: plan.planDigest, input: { caseId: "case-source", tenantId: "verified-tenant" }, sourceContextDigest: "c".repeat(64) };
  for (const created of [true, false]) {
    upstream.mockResolvedValueOnce({ status: 200, body: { created, run: { ...run, sourceContextDigest: payload.sourceContextDigest } } });
    const response = await app.inject({ method: "POST", url: "/api/v1/runs", payload, headers });
    expect(response.statusCode, response.body).toBe(created ? 201 : 200);
    expect(response.json().sourceContextDigest).toBe(payload.sourceContextDigest);
  }
  expect(upstream.mock.calls.every(call => JSON.stringify(call[4]) === JSON.stringify(payload) && call[5]?.["idempotency-key"] === "source-intent")).toBe(true);
});
it("preserves upstream denials and rejects malformed success responses", async () => {
  const { app, upstream } = await setup();
  upstream.mockResolvedValueOnce({ status: 403, body: { error: "source_policy.tenant_denied" } });
  expect((await app.inject("/api/v1/source-policies/artifacts")).json().error).toBe("source_policy.tenant_denied");
  upstream.mockResolvedValueOnce({ status: 200, body: [] });
  expect((await app.inject("/api/v1/source-policies/artifacts")).statusCode).toBe(502);
});
