import { afterEach, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { validateResponse } from "@ehf/ui-contracts/validate";
import { buildApp } from "./app.js";
import { UpstreamError, type Upstream } from "./upstream.js";

const applications: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(applications.splice(0).map(app => app.close())); });
function make(upstream: Upstream, roles = ["Platform.Admin"], tenantId = "tenant_verified") {
  const app = buildApp({ env: { BFF_PUBLIC_ORIGIN: "http://bff.test" }, principalResolver: { source: "local", resolve: async () => ({ subjectId: "verified-operator", tenantId, actorType: "human", roles, source: "local" }) }, upstream });
  applications.push(app); return app;
}
const ready = (id: string, group: string) => ({ id, name: id, group, status: "Ready", detail: "Responding.", latencyMs: 2 });
const reports: Record<string, unknown[]> = {
  "control-api": [ready("control-store", "store"), ready("context-store", "store"), ready("runtime-host", "runtime")],
  "case-api": [ready("case-store", "store"), ready("evidence-store", "store")],
  "capability-gateway": [ready("skill-host", "endpoint"), { ...ready("evidence-pipeline", "endpoint"), status: "NotConfigured", latencyMs: null }],
};

it("combines every service's own dependency checks into one contract-valid report", async () => {
  const upstream = vi.fn<Upstream>(async service => ({ status: 200, body: { components: reports[service] } }));
  const response = await make(upstream).inject("/api/v1/platform/health");
  expect(response.statusCode).toBe(200);
  expect(validateResponse("getPlatformHealth", 200, response.json())).toMatchObject({ valid: true });
  const body = response.json();
  expect(body.overall).toBe("Ready");
  expect(body.components.map((item: { id: string }) => item.id)).toEqual(["experience-bff", "control-api", "case-api", "capability-gateway",
    "control-store", "context-store", "runtime-host", "case-store", "evidence-store", "skill-host", "evidence-pipeline"]);
  expect(body.components.find((item: { id: string }) => item.id === "context-store").reportedBy).toBe("control-api");
  expect(upstream.mock.calls.map(call => `${call[0]} ${call[1]} ${call[2]}`).sort()).toEqual(["capability-gateway", "case-api", "control-api"].map(service => `${service} GET /v1/platform/dependencies`));
  expect(upstream.mock.calls.every(call => call[3].tenantId === "tenant_verified")).toBe(true);
});

it("reports a service that does not answer as unavailable without guessing its dependencies", async () => {
  const app = make(async service => {
    if (service === "case-api") throw new Error("connect ECONNREFUSED case-api.internal");
    if (service === "capability-gateway") return { status: 200, body: { components: [{ ...ready("skill-host", "endpoint"), status: "Unavailable" }] } };
    return { status: 200, body: { components: reports[service] } };
  });
  const body = (await app.inject("/api/v1/platform/health")).json();
  expect(validateResponse("getPlatformHealth", 200, body)).toMatchObject({ valid: true });
  expect(body.overall).toBe("Unavailable");
  expect(body.components.find((item: { id: string }) => item.id === "case-api")).toMatchObject({ status: "Unavailable", detail: "No answer." });
  expect(body.components.some((item: { id: string }) => item.id === "case-store")).toBe(false);
  expect(JSON.stringify(body)).not.toContain("ECONNREFUSED");
});

it("degrades for an unreachable endpoint, a refused identity or an unreadable report", async () => {
  const endpointDown = make(async service => ({ status: 200, body: { components: service === "capability-gateway" ? [{ ...ready("skill-host", "endpoint"), status: "Unavailable" }] : reports[service] } }), ["Platform.Admin"], "tenant_a");
  expect((await endpointDown.inject("/api/v1/platform/health")).json().overall).toBe("Degraded");
  const refused = make(async service => service === "control-api" ? { status: 403, body: { error: "authorization.role_missing" } }
    : service === "case-api" ? { status: 200, body: { components: [{ id: "case-store", url: "postgresql://secret" }] } } : (() => { throw new UpstreamError(503, "bff.delegation_not_configured"); })(), ["Platform.Admin"], "tenant_b");
  const body = (await refused.inject("/api/v1/platform/health")).json();
  expect(body.components.slice(1).map((item: { status: string }) => item.status)).toEqual(["Degraded", "Degraded", "Unavailable"]);
  expect(JSON.stringify(body)).not.toContain("postgresql://");
});

it("requires a signed-in person and reuses a tenant's report between polls", async () => {
  const upstream = vi.fn<Upstream>(async service => ({ status: 200, body: { components: reports[service] } }));
  const app = make(upstream, ["Platform.Admin"], "tenant_c");
  await app.inject("/api/v1/platform/health"); await app.inject("/api/v1/platform/health");
  expect(upstream).toHaveBeenCalledTimes(3);
  const denied = await make(upstream, []).inject("/api/v1/platform/health");
  expect(denied.statusCode).toBe(403);
  expect(upstream).toHaveBeenCalledTimes(3);
});
