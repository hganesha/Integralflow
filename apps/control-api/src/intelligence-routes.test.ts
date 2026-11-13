import mcpFixture from "../../../packages/contracts/test-fixtures/intelligence-mcp.json" with { type: "json" };
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import fixture from "../../../packages/contracts/test-fixtures/intelligence-binding.json" with { type: "json" };
import documentFixture from "../../../packages/contracts/test-fixtures/intelligence-document.json" with { type: "json" };
import decisionFixture from "../../../packages/contracts/test-fixtures/intelligence-decision.json" with { type: "json" };
import { createDatabase, type Database } from "@ehf/persistence";
import { buildControlApi } from "./app.js";

const token = "intelligence-edge-test-token";
const headers = (role = "Platform.Admin", tenant = "tenant_demo") => ({ authorization: `Bearer ${token}`, "x-actor-id": "verified-operator", "x-actor-type": "human", "x-actor-roles": role, "x-tenant-id": tenant });
it("independently authorizes and rejects invalid proposals before touching persistence", async () => {
  const db = { query: async () => { throw new Error("unexpected database write"); } } as unknown as Database;
  const app = buildControlApi({ db, env: { EDGE_SERVICE_TOKEN: token } });
  try {
    expect((await app.inject("/v1/intelligence")).statusCode).toBe(401);
    expect((await app.inject({ url: "/v1/intelligence", headers: headers("Harness.Reader") })).statusCode).toBe(403);
    const submit = (definition: unknown, extra = {}) => app.inject({ method: "POST", url: "/v1/intelligence/candidates", headers: headers(), payload: { definition, expectedRevision: null, reason: "test", ...extra } });
    expect((await app.inject({ method: "POST", url: "/v1/intelligence/candidates", headers: headers("Platform.Auditor"), payload: { definition: fixture, expectedRevision: null, reason: "test" } })).statusCode).toBe(403);
    expect((await submit(fixture, { environment: "production" })).statusCode).toBe(400);
    expect((await submit({ ...fixture, connection: { ...fixture.connection, endpoint: "https://user:secret@models.example.com" } })).statusCode).toBe(400);
    expect((await submit({ ...fixture, id: "reasoning.xhigh" })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/v1/intelligence/bindings/reasoning.med/checks", headers: headers(), payload: {} })).statusCode).toBe(400);
  } finally { await app.close(); }
});
describe.skipIf(!process.env.EHF_TEST_DATABASE_URL)("intelligence control API PostgreSQL", () => {
  it.each([fixture, documentFixture, decisionFixture, mcpFixture])("persists $serviceClass proposals in the server-selected environment and projects current configuration", async definition => {
    const db = createDatabase(process.env.EHF_TEST_DATABASE_URL);
    const tenant = `intelligence-route-${randomUUID()}`;
    const app = buildControlApi({ db, env: { EHF_ENVIRONMENT: "sandbox", EDGE_SERVICE_TOKEN: token }, serviceGrants: [{ token, subjectId: "edge", roles: ["Edge.Delegate"], tenantId: tenant }] });
    try {
      const submit = (expectedRevision: number | null) => app.inject({ method: "POST", url: "/v1/intelligence/candidates", headers: headers("Platform.Admin", tenant), payload: { definition, expectedRevision, reason: "Synthetic non-production test" } });
      expect((await submit(null)).json()).toMatchObject({ revision: 1, definition: { id: definition.id } });
      expect((await submit(null)).statusCode).toBe(409);
      const checked = await app.inject({ method: "POST", url: `/v1/intelligence/bindings/${definition.id}/checks`, headers: headers("Platform.Admin", tenant), payload: { expectedRevision: 1 } });
      expect(checked.statusCode).toBe(200);
      expect(checked.json()).toMatchObject({ executionVerified: false, revision: 1 });
      const index = await app.inject({ url: "/v1/intelligence", headers: headers("Platform.Auditor", tenant) });
      expect(index.statusCode).toBe(200);
      expect(index.json()).toMatchObject({ environment: "sandbox", consumerInventoryAvailable: false, candidates: [{ revision: 1 }] });
      expect(index.json().runtimes[0].target).toBe("local_http");
      if (definition.serviceClass === "mcp") {
        const bulk = { ...mcpFixture, id: "mcp.bulk_catalog", configuration: { ...mcpFixture.configuration, tools: Array.from({ length: 50 }, (_, position) => ({ ...mcpFixture.configuration.tools[0]!, name: `tool_${position}`, capabilityId: `mcp.tool_${position}.call.v1`, inputSchemaRef: `schema:${"i".repeat(350)}`, outputSchemaRef: `schema:${"o".repeat(350)}` })) } };
        expect(JSON.stringify(bulk).length).toBeGreaterThan(32768);
        const result = await app.inject({ method: "POST", url: "/v1/intelligence/candidates", headers: headers("Platform.Admin", tenant), payload: { definition: bulk, expectedRevision: null, reason: "Bounded multi-tool catalog" } });
        expect(result.statusCode).toBe(200);
      }

    } finally { await app.close(); await db.end(); }
  });
});
