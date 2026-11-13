import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createDatabase,
  getContextSample,
  listContextDefinitions,
  type Database,
} from "@ehf/persistence";
import { stableDigest, type CanonicalMapping } from "@ehf/contracts";
import { buildControlApi } from "./app.js";
import { contextCatalog } from "./context-setup-routes.js";
const token = "context-source-test-token-000000000001";
const headers = (
  tenant: string,
  roles = "Harness.Author,Platform.Admin,Harness.Operator",
) => ({
  authorization: `Bearer ${token}`,
  "x-tenant-id": tenant,
  "x-actor-id": "source-author",
  "x-actor-roles": roles,
});
it("serves the verified catalog/schema and rejects unauthorized setup before touching storage", async () => {
  const db = {
    connect: async () => {
      throw new Error("Unexpected storage");
    },
  } as unknown as Database;
  const app = buildControlApi({ db, env: { EDGE_SERVICE_TOKEN: token } });
  app.log.level = "silent";
  try {
    expect(
      (
        await app.inject({
          url: "/v1/context/catalog",
          headers: headers("tenant_demo"),
        })
      ).statusCode,
    ).toBe(200);
    const schema = await app.inject({
      url: "/v1/context/schema",
      headers: headers("tenant_demo"),
    });
    expect(schema.statusCode).toBe(200);
    expect(schema.json().objectTypes).toContain("Entity");
    const relationships = await app.inject({ url: "/v1/context/relationships", headers: headers("tenant_demo") });
    expect(relationships.statusCode).toBe(200);
    expect(relationships.json().relationships).toHaveLength(34);
    expect(relationships.json().schemaVersion).toBe(schema.json().schemaVersion);

    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/context/definitions",
          headers: headers("tenant_demo", "Harness.Reader"),
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/context/sample-runs",
          headers: headers("tenant_demo"),
          payload: {},
        })
      ).statusCode,
    ).toBe(400);
  } finally {
    await app.close();
  }
});
describe.skipIf(!process.env.EHF_TEST_DATABASE_URL)(
  "context setup and isolated samples in PostgreSQL",
  () => {
    it("persists revisions, retains canonical errors, isolates tenants and refuses upload qualification", async () => {
      const tenant = `context-${randomUUID()}`;
      const db = createDatabase(process.env.EHF_TEST_DATABASE_URL);
      const app = buildControlApi({
        db,
        env: {},
        serviceGrants: [
          {
            token,
            subjectId: "edge",
            roles: ["Edge.Delegate"],
            tenantId: tenant,
          },
        ],
      });
      app.log.level = "silent";
      const post = (url: string, payload: unknown) =>
        app.inject({
          method: "POST",
          url,
          headers: headers(tenant),
          payload: payload as Record<string, unknown>,
        });
      const save = (definition: unknown, expectedRevision = 0) =>
        post("/v1/context/definitions", {
          definition,
          expectedRevision,
          reason: "Context source integration test",
        });
      try {
        const connection = {
          kind: "connection",
          id: "crm",
          name: "CRM",
          connectorId: "context-postgres:customers",
          credentialRef: "CONTEXT_SOURCE_TEST",
          credentialGeneration: "v1",
          identityMode: "service",
          resources: [
            {
              schema: "public",
              table: "customers",
              columns: ["key", "name", "kind", "observed_at"],
            },
          ],
        };
        const race = await Promise.all([save(connection), save(connection)]);
        expect(race.map((r) => r.statusCode).sort()).toEqual([200, 409]);
        const c = race.find((r) => r.statusCode === 200)!.json();
        const resource = {
          kind: "resource",
          id: "crm-customers",
          connectionId: "crm",
          connectionDigest: c.digest,
          schema: "public",
          table: "customers",
          columns: ["key", "name", "kind", "observed_at"],
          subjectColumn: "key",
          observedAtColumn: "observed_at",
          schemaFingerprint: null,
          maxRows: 100,
        };
        const rr = await save(resource);
        expect(rr.statusCode, rr.body).toBe(200);
        const field = (path: string) => ({ op: "field" as const, path });
        const identity = {
          op: "id" as const,
          namespace: "entity",
          value: field("key"),
        };
        const mapping: CanonicalMapping = {
          kind: "mapping",
          id: "customers",
          name: "Customer identities",
          productId: "identity.intelligence",
          resourceId: resource.id,
          resourceDigest: rr.json().digest,
          schemaVersion: "2.0.0",
          catalogDigest: contextCatalog({}).catalogDigest,
          subject: identity,
          outputs: [
            {
              objectType: "Entity",
              identity,
              fields: {
                name: field("name"),
                entity_type: field("kind"),
                identifiers: { op: "array", items: [field("key")] },
              },
            },
          ],
        };
        const mr = await save(mapping);
        expect(mr.statusCode, mr.body).toBe(200);
        const sample = await post("/v1/context/sample-runs", {
          mappingId: mapping.id,
          expectedDigest: mr.json().digest,
          origin: "uploaded",
          observedAt: "2026-11-09T12:00:00Z",
          rows: [
            { key: "a", name: "Valid", kind: "individual" },
            { key: "b", name: "Unknown", kind: "invalid" },
          ],
        });
        expect(sample.statusCode, sample.body).toBe(200);
        const report = sample.json();
        expect(report.counts).toMatchObject({
          rows: 2,
          acceptedRows: 1,
          rejectedRows: 1,
          candidates: 1,
        });
        expect(
          report.issues.some(
            (i: { code: string }) =>
              i.code === "context.canonical_data_invalid",
          ),
        ).toBe(true);
        const got = await app.inject({
          url: `/v1/context/sample-runs/${report.id}`,
          headers: headers(tenant),
        });
        expect(got.json().inputDigest).toBe(report.inputDigest);
        expect(
          await listContextDefinitions(db, {
            tenantId: `${tenant}-other`,
            environment: "local",
          }),
        ).toEqual([]);
        await expect(
          getContextSample(
            db,
            { tenantId: `${tenant}-other`, environment: "local" },
            report.id,
          ),
        ).rejects.toThrow("context.sample_not_found_or_expired");
        const enabled = await post(
          `/v1/context/mappings/${mapping.id}/enable`,
          {
            reportId: report.id,
            expectedDigest: mr.json().digest,
            expectedRevision: 0,
          },
        );
        expect(enabled.statusCode).toBe(409);
        expect(
          (
            await db.query(
              "select count(*)::int as count from harness_control.context_enablements where tenant_id=$1",
              [tenant],
            )
          ).rows[0].count,
        ).toBe(0);
        expect(
          (await save({ ...mapping, name: "Changed mapping" }, 1)).statusCode,
        ).toBe(200);
        expect(
          (
            await post("/v1/context/sample-runs", {
              mappingId: mapping.id,
              expectedDigest: mr.json().digest,
              origin: "uploaded",
              rows: [{ key: "a" }],
              observedAt: "2026-11-09T12:00:00Z",
            })
          ).statusCode,
        ).toBe(409);
        expect(stableDigest(report.candidates)).toBe(
          stableDigest(got.json().candidates),
        );
      } finally {
        await app.close();
        await db.end();
      }
    });
  },
);
