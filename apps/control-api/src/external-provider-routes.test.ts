import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createDatabase, createExternalProvider, listExternalProviders, type Database } from "@ehf/persistence";
import { buildControlApi } from "./app.js";

const token = "external-provider-route-tests-000001";
const headers = (role = "Platform.Admin", tenant = "tenant_demo") => ({ authorization: `Bearer ${token}`, "x-actor-id": "provider-author", "x-actor-roles": role, "x-tenant-id": tenant });
const connection = { id: "search-sandbox", name: "Search sandbox", environment: "sandbox", adapterId: "databricks-vector", binding: "main.cases.case_index", endpoint: "https://workspace.example.com", authentication: "api_key", credentialRef: "SEARCH_API_KEY", capabilityIds: ["knowledge.vector.search.v1"], jurisdiction: "gb", coverageNote: "Synthetic test scope" };

it("enforces administration authority and validates configuration before writes", async () => {
  const db = { query: async () => { throw new Error("unexpected database write"); } } as unknown as Database;
  const app = buildControlApi({ db, env: { EDGE_SERVICE_TOKEN: token } });
  try {
    expect((await app.inject({ method: "POST", url: "/v1/external-providers", headers: headers("Harness.Author"), payload: { id: "new", name: "New", description: "" } })).statusCode).toBe(403);
    expect((await app.inject({ url: "/v1/external-providers" })).statusCode).toBe(401);
    const submit = (draft: unknown) => app.inject({ method: "POST", url: "/v1/external-providers/persona/connections", headers: headers(), payload: { connection: draft, expectedRevision: null } });
    for (const patch of [{ endpoint: "https://user:password@example.com" }, { endpoint: "https://example.com/?key=secret" }, { credentialRef: "sk-secret-value" }, { enabled: true }, { capabilityIds: ["identity.person.verify.v1"] }, { adapterId: "unknown" }, { binding: "../unsafe" }]) {
      expect((await submit({ ...connection, ...patch })).statusCode).toBe(400);
    }
    expect((await submit({ ...connection, id: "" })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/v1/external-providers", headers: headers(), payload: { id: "persona", name: "Duplicate", description: "" } })).statusCode).toBe(409);
    expect((await app.inject({ method: "POST", url: "/v1/external-providers/finantier/connections", headers: headers(), payload: { connection, expectedRevision: null } })).statusCode).toBe(409);
  } finally { await app.close(); }
});

describe.skipIf(!process.env.EHF_TEST_DATABASE_URL)("external providers in PostgreSQL", () => {
  it("persists drafts and activity, isolates tenants and rejects stale concurrent edits without changing runtime connectors", async () => {
    const db = createDatabase(process.env.EHF_TEST_DATABASE_URL);
    const tenant = `providers-${randomUUID()}`;
    const app = buildControlApi({ db, env: {}, serviceGrants: [{ token, subjectId: "edge", roles: ["Edge.Delegate"], tenantId: tenant }] });
    const id = `test-${randomUUID()}`;
    const provider = { id, name: "Provider persistence test", description: "Synthetic" };
    const auth = headers("Platform.Admin", tenant);
    const post = (path: string, payload: unknown) => app.inject({ method: "POST", url: path, headers: auth, payload: payload as Record<string, unknown> });
    try {
      // Other suites register independent providers concurrently; compare this provider's actual runtime definitions.
      const before = await db.query("select connector_id,definition_digest,status from harness_gateway.connector_registry where provider_id=$1 order by connector_id",[id]);
      expect((await post("/v1/external-providers", provider)).statusCode).toBe(201);
      expect((await post("/v1/external-providers", provider)).statusCode).toBe(409);
      const path = `/v1/external-providers/${id}/connections`;
      expect((await post(path, { connection, expectedRevision: null })).json().revision).toBe(1);
      expect((await post(path, { connection, expectedRevision: null })).statusCode).toBe(409);
      const race = await Promise.all(["First edit", "Other edit"].map(name => post(path, { connection: { ...connection, name }, expectedRevision: 1 })));
      expect(race.map(result => result.statusCode).sort()).toEqual([200, 409]);
      const inventory = (await app.inject({ url: "/v1/external-providers", headers: auth })).json();
      const stored = inventory.providers.find((record: { provider: { id: string } }) => record.provider.id === id);
      expect(stored.connections[0].revision).toBe(2);
      expect(stored.activity.map((event: { action: string }) => event.action)).toEqual(["connection.updated", "connection.created", "provider.created"]);
      expect(await listExternalProviders(db, `${tenant}-foreign`)).toEqual([]);
      await createExternalProvider(db, { tenantId: `${tenant}-foreign`, actor: "other-tenant", provider });
      expect((await listExternalProviders(db, `${tenant}-foreign`))[0]?.connections).toEqual([]);
      expect((await db.query("select connector_id,definition_digest,status from harness_gateway.connector_registry where provider_id=$1 order by connector_id",[id])).rows).toEqual(before.rows);
      expect((await post("/v1/external-providers/missing-provider/connections", { connection, expectedRevision: null })).statusCode).toBe(404);
      // A current operator quarantine also applies, independently of the checked-in catalog.
      await db.query("update harness_gateway.connector_registry set status='quarantined' where connector_id='wiring:persona:identity.person.verify'");
      expect((await post("/v1/external-providers/persona/connections", { connection, expectedRevision: null })).statusCode).toBe(409);
      await db.query("update harness_gateway.connector_registry set status='available' where connector_id='wiring:persona:identity.person.verify'");
    } finally { await app.close(); await db.end(); }
  });
});
