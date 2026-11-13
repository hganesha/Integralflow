import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createDatabase, type Database } from "@ehf/persistence";
import { externalBindingDraftSchema, externalBindingError } from "@ehf/contracts";
import { buildControlApi } from "./app.js";
import { externalBindingCatalog } from "./external-binding-routes.js";
const token = "external-binding-tests-token-000001";
const headers = (role = "Platform.Admin", tenant = "tenant_demo") => ({ authorization: `Bearer ${token}`, "x-actor-id": "binding-author", "x-actor-roles": role, "x-tenant-id": tenant });
const catalog = externalBindingCatalog();
const source = catalog.bindings.find(item => item.bindingId.includes(":aamva-dldv:"))!;
const path = `/v1/external-capability-bindings/${encodeURIComponent(source.bindingId)}`;
const definition = { ...source.definition, jurisdiction: { code: "us", evidenceRefs: ["evidence:source-scope-test"] } };
const body = { definition, sourceDigest: source.sourceDigest, expectedRevision: 0, reason: "Proposed US source scope for review" };
it("offers every imported binding and enforces semantic validation and admin authority before writing", async () => {
  expect(catalog.bindings).toHaveLength(825);
  for (const item of catalog.bindings) {
    expect(externalBindingDraftSchema.safeParse(item.definition).success).toBe(true);
    expect(externalBindingError(item.definition, catalog)).toBeNull();
  }
  const db = { connect: async () => { throw new Error("Unexpected database access"); } } as unknown as Database;
  const app = buildControlApi({ db, env: { EDGE_SERVICE_TOKEN: token } });
  try {
    expect((await app.inject({ url: path })).statusCode).toBe(401);
    expect((await app.inject({ url: path, headers: headers("Harness.Reader") })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: path, headers: headers("Harness.Author"), payload: body })).statusCode).toBe(403);
    for (const patch of [
      { definition: { ...definition, governance: { enabled: true } } },
      { definition: { ...definition, actions: ["approve"] } },
      { definition: { ...definition, jurisdiction: { code: "zz", evidenceRefs: [] } } },
      { definition: { ...definition, coverage: { ...definition.coverage, eligibleSubjectCountries: ["eu"] } } },
      { definition: { ...definition, coverage: { ...definition.coverage, status: "complete", evidenceRefs: [] } } },
      { definition: { ...definition, jurisdiction: { code: "global", evidenceRefs: [] } } },
      { reason: " " },
    ]) expect((await app.inject({ method: "POST", url: path, headers: headers(), payload: { ...body, ...patch } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: path, headers: headers(), payload: { ...body, sourceDigest: "0".repeat(64) } })).statusCode).toBe(409);
    expect((await app.inject({ method: "POST", url: "/v1/external-capability-bindings/missing", headers: headers(), payload: body })).statusCode).toBe(404);
  } finally { await app.close(); }
});
describe.skipIf(!process.env.EHF_TEST_DATABASE_URL)("binding revisions in PostgreSQL", () => {
  it("persists all bindings including quarantined ones, preserves history, isolates tenants and rejects concurrent edits", async () => {
    const db = createDatabase(process.env.EHF_TEST_DATABASE_URL);
    const tenant = `bindings-${randomUUID()}`;
    const app = buildControlApi({ db, env: {}, serviceGrants: [{ token, subjectId: "edge", roles: ["Edge.Delegate"], tenantId: tenant }] });
    const auth = headers("Platform.Admin", tenant);
    const post = (payload: unknown, url = path) => app.inject({ method: "POST", url, headers: auth, payload: payload as Record<string, unknown> });
    try {
      const runtimeBefore = await db.query("select connector_id,status from harness_gateway.connector_registry order by connector_id");
      const initial = await app.inject({ url: path, headers: auth });
      expect(initial.json().revision).toBe(0);
      const race = await Promise.all([post(body), post({ ...body, reason: "Concurrent first edit" })]);
      expect(race.map(result => result.statusCode).sort()).toEqual([200, 409]);
      const saved = await post({ ...body, expectedRevision: 1, definition: { ...definition, jurisdiction: { code: "ca", evidenceRefs: [] } } });
      expect(saved.json().revision).toBe(2);
      expect((await post({ ...body, expectedRevision: 1 })).statusCode).toBe(409);
      const reloaded = (await app.inject({ url: path, headers: auth })).json();
      expect(reloaded.definition.jurisdiction.code).toBe("ca");
      expect(reloaded.history.map((item: { revision: number }) => item.revision)).toEqual([2, 1]);
      expect(reloaded.history[0].updatedBy).toBe("binding-author");
      const foreign = await app.inject({ url: path, headers: headers("Platform.Admin", `${tenant}-foreign`) });
      // Explicit delegated service grants fix the tenant; persistence is also independently scoped below.
      const { listExternalBindingRevisions } = await import("@ehf/persistence");
      expect(await listExternalBindingRevisions(db, `${tenant}-foreign`)).toEqual([]);
      expect(foreign.statusCode).toBe(403);
      const quarantined = catalog.bindings.find(item => item.bindingId.includes(":finantier:"))!;
      expect((await post({ ...body, definition: quarantined.definition, sourceDigest: quarantined.sourceDigest }, `/v1/external-capability-bindings/${encodeURIComponent(quarantined.bindingId)}`)).statusCode).toBe(200);
      const inventory = (await app.inject({ url: "/v1/external-capability-bindings", headers: auth })).json();
      expect(inventory.items).toHaveLength(2);
      expect((await db.query("select connector_id,status from harness_gateway.connector_registry order by connector_id")).rows).toEqual(runtimeBefore.rows);
      const policies = await db.query("select relrowsecurity,relforcerowsecurity from pg_class where oid='harness_admin.external_capability_binding_revisions'::regclass");
      expect(policies.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    } finally { await app.close(); await db.end(); }
  });
});
