import { afterEach, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { validateResponse } from "@ehf/ui-contracts/validate";
import { buildApp } from "./app.js";
import type { Upstream } from "./upstream.js";

const applications: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(applications.splice(0).map(app => app.close())); });
const registry = { environment: "sandbox", generatedAt: "2026-11-08T12:00:00Z", profiles: [], providers: [], runtimes: [], adapters: [], candidates: [], history: [], activity: [], reports: [], consumerInventoryAvailable: false };
function make(upstream: Upstream, roles = ["Platform.Admin"]) {
  const app = buildApp({ env: { BFF_PUBLIC_ORIGIN: "http://bff.test" }, principalResolver: { source: "local", resolve: async () => ({ subjectId: "verified-operator", tenantId: "tenant_verified", actorType: "human", roles, source: "local" }) }, upstream });
  applications.push(app); return app;
}
it("combines authoritative configuration with gateway availability without inventing health", async () => {
  const upstream = vi.fn<Upstream>(async service => service === "control-api" ? { status: 200, body: registry } : { status: 200, body: { adapters: [{ id: "openrouter" }] } });
  const response = await make(upstream).inject("/api/v1/intelligence");
  expect(response.statusCode).toBe(200);
  expect(validateResponse("getIntelligence", 200, response.json())).toMatchObject({ valid: true });
  expect(response.json()).toMatchObject({ gatewayAvailable: true, gatewayAdapters: ["openrouter"], consumerInventoryAvailable: false });
  expect(upstream.mock.calls.every(call => call[3].tenantId === "tenant_verified")).toBe(true);
});
it("preserves registry failures and returns unknown gateway state on a gateway outage", async () => {
  const app = make(async service => service === "control-api" ? { status: 200, body: registry } : { status: 503, body: { error: "gateway.unavailable" } });
  expect((await app.inject("/api/v1/intelligence")).json()).toMatchObject({ gatewayAvailable: false, gatewayAdapters: [] });
  const failed = make(async () => ({ status: 503, body: { error: "registry.unavailable" } }));
  const response = await failed.inject("/api/v1/intelligence");
  expect(response.statusCode).toBe(503);
  expect(response.json().error).toBe("registry.unavailable");
  const malformed = make(async () => ({ status: 200, body: {} }));
  expect((await malformed.inject("/api/v1/intelligence")).json().error).toBe("intelligence.inventory_invalid");
});
it("gates reads and checks with session authority and CSRF and preserves revision conflicts", async () => {
  const upstream = vi.fn<Upstream>(async () => ({ status: 409, body: { error: "intelligence.revision_conflict" } }));
  const reader = make(upstream, ["Harness.Reader"]);
  expect((await reader.inject("/api/v1/intelligence")).statusCode).toBe(403);
  const app = make(upstream);
  const url = "/api/v1/intelligence/bindings/reasoning.med/checks";
  expect((await app.inject({ method: "POST", url, payload: { expectedRevision: 1 } })).statusCode).toBe(403);
  const session = await app.inject("/api/v1/session");
  const response = await app.inject({ method: "POST", url, headers: { origin: "http://bff.test", cookie: String(session.headers["set-cookie"]).split(";")[0]!, "x-csrf-token": session.json().csrfToken }, payload: { expectedRevision: 1 } });
  expect(response.statusCode).toBe(409);
  expect(response.json().error).toBe("intelligence.revision_conflict");
  expect(upstream).toHaveBeenCalledTimes(1);
  expect(upstream.mock.calls[0]?.[3].subjectId).toBe("verified-operator");
});
