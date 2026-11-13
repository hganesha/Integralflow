import { afterEach, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { validateResponse } from "@ehf/ui-contracts/validate";
import { buildApp } from "./app.js";
import type { Upstream } from "./upstream.js";

const applications: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(applications.splice(0).map(app => app.close())); });
const make = (upstream: Upstream, roles = ["Platform.Admin"]) => {
  const app = buildApp({ env: { BFF_PUBLIC_ORIGIN: "http://bff.test" }, principalResolver: { source: "local", resolve: async () => ({ subjectId: "verified-author", tenantId: "tenant_verified", actorType: "human", roles, source: "local" }) }, upstream });
  applications.push(app); return app;
};
it("combines catalog proposals with current gateway facts and follows all connector pages", async () => {
  const upstream = vi.fn<Upstream>(async (service, _method, path) => {
    if (service === "control-api") return { status: 200, body: _method === "GET" && path === "/v1/external-capability-bindings" ? { items: [] } : { providers: [] } };
    if (path === "/v1/adapters") return { status: 200, body: { adapters: [{ id: "databricks-vector", credentialState: "Missing" }], modules: [{ id: "databricks-vector", label: "Databricks Vector Search", enabled: true, connectorTemplate: { adapterId: "databricks-vector", cloud: "databricks", bindingPattern: "^[a-z]+$", capabilityIds: ["knowledge.vector.search.v1"], configEnv: ["DATABRICKS_HOST"], description: "Search index" } }] } };
    return { status: 200, body: { connectors: [{ connector: { connectorId: path.includes("cursor") ? "databricks-vector:two" : "databricks-vector:one", providerId: "search", providerName: "Search", adapterId: "databricks-vector", capabilityId: "knowledge.vector.search.v1", status: "available", liveBlockers: ["acceptance_missing"] } }], nextCursor: path.includes("cursor") ? null : "next/page" } };
  });
  const app = make(upstream);
  const response = await app.inject("/api/v1/external-providers");
  expect(response.statusCode).toBe(200);
  expect(validateResponse("getExternalProviders", 200, response.json())).toMatchObject({ valid: true });
  expect(response.json().items.find((provider: { id: string }) => provider.id === "search").gatewayBindings).toHaveLength(2);
  expect(response.json().items.find((provider: { id: string }) => provider.id === "persona").capabilities.length).toBeGreaterThan(0);
  expect(upstream.mock.calls.every(call => call[3].tenantId === "tenant_verified")).toBe(true);
  expect(upstream.mock.calls.some(call => call[2].includes("cursor=next%2Fpage"))).toBe(true);
});
it("keeps unavailable readiness unknown and never substitutes a missing tenant registry", async () => {
  const app = make(async (service, _method, path) => service === "control-api" ? { status: 200, body: path === "/v1/external-capability-bindings" ? { items: [] } : { providers: [] } } : { status: 503, body: { error: "gateway.unavailable" } });
  const response = await app.inject("/api/v1/external-providers");
  expect(response.statusCode).toBe(200);
  expect(response.json().gatewayAvailable).toBe(false);
  expect(response.json().adapters).toEqual([]);
  const failed = make(async () => ({ status: 503, body: { error: "registry.unavailable" } }));
  expect((await failed.inject("/api/v1/external-providers")).statusCode).toBe(503);
});
it("requires admin authority and CSRF, forwards the verified principal and preserves conflicts", async () => {
  const upstream = vi.fn<Upstream>(async () => ({ status: 409, body: { error: "external_provider.already_exists" } }));
  const app = make(upstream);
  const session = await app.inject("/api/v1/session");
  const body = { id: "acme", name: "Acme", description: "" };
  expect((await app.inject({ method: "POST", url: "/api/v1/external-providers", payload: body })).statusCode).toBe(403);
  const response = await app.inject({ method: "POST", url: "/api/v1/external-providers", headers: { origin: "http://bff.test", cookie: String(session.headers["set-cookie"]).split(";")[0]!, "x-csrf-token": session.json().csrfToken, "x-actor-id": "spoof" }, payload: body });
  expect(response.statusCode).toBe(409);
  expect(response.json().error).toBe("external_provider.already_exists");
  expect(upstream.mock.calls[0]?.[3].subjectId).toBe("verified-author");
  const reader = make(upstream, ["Harness.Reader"]);
  expect((await reader.inject({ method: "POST", url: "/api/v1/external-providers", payload: body })).statusCode).toBe(403);
  expect(upstream).toHaveBeenCalledTimes(1);
});
