import { describe, expect, it } from "vitest";
import { CONTEXT_PROVIDERS } from "@ehf/contracts/context-sources";
import type {
  ContextDefinitionRevision,
  ContextDefinition,
} from "@ehf/contracts";
import { CONNECTOR_CATALOG, connectorSetupSearch } from "./catalog";
import { expressionSourcePaths, objectFieldCoverage } from "./coverage";

const digest = "a".repeat(64);
const revision = (
  definition: unknown,
  number = 1,
  pin = digest,
): ContextDefinitionRevision => ({
  definition: definition as ContextDefinition,
  digest: pin,
  revision: number,
  createdAt: "2026-11-11T12:00:00Z",
  createdBy: "test",
});
const connection = (id: string) =>
  revision({ kind: "connection", id, name: id.toUpperCase() });
const resource = (id: string) =>
  revision({
    kind: "resource",
    id,
    connectionId: id,
    connectionDigest: digest,
    schema: "public",
    table: "customers",
  });
const mapping = (id: string, resourceId: string, fields: unknown, number = 1) =>
  revision(
    {
      kind: "mapping",
      id,
      name: id,
      resourceId,
      resourceDigest: digest,
      outputs: [
        { objectType: "Entity", fields },
        {
          objectType: "Party",
          fields: { role: { op: "field", path: "role" } },
        },
      ],
    },
    number,
  );

describe("connector catalog setup boundaries", () => {
  it("routes the requested vendors to supported provider contracts", () => {
    expect(CONNECTOR_CATALOG.map((c) => c.id)).toEqual(
      expect.arrayContaining([
        "databricks",
        "fabric",
        "snowflake",
        "sqlserver",
        "openapi",
      ]),
    );
    expect(CONNECTOR_CATALOG.find((c) => c.id === "sqlserver")?.setup).toEqual({
      kind: "product",
      provider: "sqlserver",
    });
    for (const c of CONNECTOR_CATALOG)
      if (c.setup?.kind === "product")
        expect(CONTEXT_PROVIDERS).toContain(c.setup.provider);
    expect(new Set(CONNECTOR_CATALOG.map((c) => c.id)).size).toBe(
      CONNECTOR_CATALOG.length,
    );
  });
  it("preserves consumer/object scope but clears the previous mapping when switching vendors", () => {
    const next = connectorSetupSearch(
      {
        object: "Entity",
        field: "name",
        product: "party360",
        agent: "reviewer",
        draft: "draft-1",
        mapping: "old",
        source: "old",
        sample: "old",
      },
      { kind: "product", provider: "databricks" },
    );
    expect(next).toEqual({
      object: "Entity",
      field: "name",
      product: "party360",
      agent: "reviewer",
      draft: "draft-1",
      productId: "party360",
      tab: "connections",
      connectionMode: "enterprise",
      provider: "databricks",
    });
  });
  it("reuses a resource through the record mapping path without changing product authority", () => {
    expect(
      connectorSetupSearch(
        { product: "identity.intelligence", productId: "other", field: "name" },
        { kind: "records", provider: "fenergo", adapterId: "context-fenergo" },
        "verified-entities",
      ),
    ).toMatchObject({
      product: "identity.intelligence",
      productId: "other",
      field: "name",
      provider: "fenergo",
      source: "verified-entities",
      connectionMode: "shared",
    });
  });
});

describe("object source coverage", () => {
  it("resolves pinned canonical scalar and enum references for display", () => {
    const rows = objectFieldCoverage(
      [],
      "Entity",
      {
        properties: {
          name: { $ref: "#/$defs/Id" },
          entity_type: { $ref: "#/$defs/EntityKind" },
          identifiers: { type: "array", items: { $ref: "#/$defs/Id" } },
        },
      },
      {
        Id: { type: "string" },
        EntityKind: { type: "string", enum: ["company"] },
      },
    );
    expect(rows.map((r) => r.type)).toEqual(["string", "enum", "string[]"]);
  });
  const schema = {
    properties: {
      name: { type: "string" },
      identifiers: { type: "array" },
      entity_type: { type: "string" },
    },
    required: ["name", "entity_type"],
  };
  it("shows complementary and overlapping saved mappings without claiming values are resolved", () => {
    const rows = objectFieldCoverage(
      [
        connection("crm"),
        resource("crm"),
        connection("clm"),
        resource("clm"),
        mapping("crm-entity", "crm", {
          name: { op: "trim", value: { op: "field", path: "legal_name" } },
          identifiers: { op: "field", path: "ids" },
        }),
        mapping("clm-entity", "clm", {
          name: { op: "field", path: "verified_name" },
        }),
      ],
      "Entity",
      schema,
    );
    expect(rows.map((r) => [r.field, r.required, r.supplies.length])).toEqual([
      ["name", true, 2],
      ["identifiers", false, 1],
      ["entity_type", true, 0],
    ]);
    expect(
      rows[0]?.supplies.map((s) => [s.connectionName, s.pinState]),
    ).toEqual([
      ["CRM", "matching"],
      ["CLM", "matching"],
    ]);
    expect(rows.some((r) => r.field === "role")).toBe(false);
  });
  it("uses latest revisions independent of response order and reports changed resource pins", () => {
    const rows = objectFieldCoverage(
      [
        connection("crm"),
        resource("crm"),
        revision(
          {
            kind: "resource",
            id: "crm",
            connectionId: "crm",
            connectionDigest: digest,
            schema: "public",
            table: "new_view",
          },
          2,
          "b".repeat(64),
        ),
        mapping(
          "entity",
          "crm",
          { name: { op: "field", path: "new_name" } },
          2,
        ),
        mapping("entity", "crm", { name: { op: "field", path: "old_name" } }),
      ],
      "Entity",
      schema,
    );
    expect(rows[0]?.supplies).toHaveLength(1);
    expect(rows[0]?.supplies[0]).toMatchObject({
      revision: 2,
      pinState: "changed",
      expression: { path: "new_name" },
    });
  });
  it("reports missing source metadata without treating a saved field as live-ready", () => {
    const rows = objectFieldCoverage(
      [
        mapping("entity", "deleted", {
          name: { op: "literal", value: "Example" },
        }),
      ],
      "Entity",
      schema,
    );
    expect(rows[0]?.supplies[0]).toMatchObject({
      connectionName: "Connection unavailable",
      pinState: "missing",
    });
    expect(rows[0]?.supplies[0]).not.toHaveProperty("fresh");
  });
  it("lists only expression source paths, not literal or crosswalk values", () => {
    expect(
      expressionSourcePaths({
        op: "coalesce",
        values: [
          { op: "trim", value: { op: "field", path: "name" } },
          {
            op: "crosswalk",
            value: { op: "field", path: "source_key" },
            values: { other: "private-id" },
            revision: digest,
            reviewedBy: "reviewer",
          },
          { op: "literal", value: { path: "not-a-source-path" } },
        ],
      }),
    ).toEqual(["name", "source_key"]);
  });
});
