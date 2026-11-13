import { expect, it, vi } from "vitest";
import { stableDigest, type CanonicalMapping } from "@ehf/contracts";
import { compileMapping } from "@ehf/context-mapping";
import {
  getContextDefinition,
  getContextEnablement,
  getRun,
  loadSourceAuthority,
} from "@ehf/persistence";
import { fetchContextSample } from "@ehf/context-postgres";
import { contextPostgresModule } from "./adapters/context-postgres.js";
import type {
  AdapterModuleDeps,
  AdapterInvocationContext,
} from "./adapters/types.js";
vi.mock("@ehf/persistence", async (actual) => ({
  ...(await actual<object>()),
  getContextDefinition: vi.fn(),
  getContextEnablement: vi.fn(),
  getRun: vi.fn(),
  loadSourceAuthority: vi.fn(),
}));
vi.mock("@ehf/context-postgres", async (actual) => ({
  ...(await actual<object>()),
  fetchContextSample: vi.fn(),
}));
it("executes only exact enabled mapping pins and emits service-owned canonical provenance; invalid or truncated batches never commit", async () => {
  const connection = {
    kind: "connection" as const,
    id: "crm",
    name: "CRM",
    connectorId: "context-postgres:customers",
    credentialRef: "CONTEXT_SOURCE_TEST",
    credentialGeneration: "v1",
    identityMode: "service" as const,
    resources: [
      {
        schema: "public",
        table: "customers",
        columns: ["key", "name", "observed_at"],
      },
    ],
  };
  const resource = {
    kind: "resource" as const,
    id: "customers",
    connectionId: "crm",
    connectionDigest: stableDigest(connection),
    schema: "public",
    table: "customers",
    columns: ["key", "name", "observed_at"],
    subjectColumn: "key",
    observedAtColumn: "observed_at",
    schemaFingerprint: "f".repeat(64),
    maxRows: 100,
  };
  const field = (path: string) => ({ op: "field" as const, path });
  const identity = {
    op: "id" as const,
    namespace: "entity",
    value: field("key"),
  };
  const mapping: CanonicalMapping = {
    kind: "mapping",
    id: "customers",
    name: "Customers",
    productId: "identity.intelligence",
    resourceId: "customers",
    resourceDigest: stableDigest(resource),
    schemaVersion: "2.0.0",
    catalogDigest: "a".repeat(64),
    subject: identity,
    outputs: [
      {
        objectType: "Entity",
        identity,
        fields: {
          name: field("name"),
          entity_type: { op: "literal", value: "individual" },
          identifiers: { op: "array", items: [field("key")] },
        },
      },
    ],
  };
  vi.mocked(getContextDefinition).mockImplementation(
    async (_db, _scope, kind) => {
      const definition =
        kind === "mapping"
          ? mapping
          : kind === "resource"
            ? resource
            : connection;
      return {
        definition,
        revision: 1,
        digest: stableDigest(definition),
        createdAt: "2026-11-09T00:00:00Z",
        createdBy: "author",
      };
    },
  );
  const enablement = {
    mappingId: "customers",
    revision: 1,
    mappingDigest: stableDigest(mapping),
    reportId: "report",
    reportDigest: "d".repeat(64),
    authority: {
      planDigest: "b".repeat(64),
      contextDigest: "c".repeat(64),
      capabilityId: "context.records.fetch.v1",
      connectorId: connection.connectorId,
    },
    paused: false,
    enabledBy: "operator",
  };
  vi.mocked(getContextEnablement).mockResolvedValue(enablement);
  vi.mocked(getRun).mockResolvedValue({
    sourceContextDigest: "c".repeat(64),
  } as never);
  vi.mocked(loadSourceAuthority).mockResolvedValue({
    binding: {
      mappingVersion: compileMapping(mapping).digest,
      datasetIds: ["public.customers"],
      fields: resource.columns,
      evidenceRoles: ["primary"],
      transport: "local",
      approvedEndpoints: [],
    },
    context: { purpose: "KYC_ONBOARDING" },
  } as never);
  vi.mocked(fetchContextSample).mockResolvedValue({
    rows: [{ key: "1", name: "Example", observed_at: "2026-11-09T12:00:00Z" }],
    truncated: false,
    fingerprint: resource.schemaFingerprint,
  });
  const adapter = contextPostgresModule.create({
    env: {
      CONTEXT_SOURCE_TEST: JSON.stringify({
        tenantId: "tenant",
        connectorId: connection.connectorId,
        generation: "v1",
        connectionString: "postgresql://127.0.0.1/test",
      }),
    },
    db: {},
  } as unknown as AdapterModuleDeps);
  const capability = {
    id: "context.records.fetch.v1",
    kind: "tool",
    effect: "read",
    adapterBindingId: connection.connectorId,
  } as const;
  const context = {
    tenantId: "tenant",
    invocationId: "invocation",
    execution: {
      claims: { case_id: "case-1", run_id: "run-1" },
      plan: { planDigest: "b".repeat(64) },
    },
  } as unknown as AdapterInvocationContext;
  const result = await adapter.invoke(
    "customers",
    capability as never,
    { subjects: ["1"] },
    context,
  );
  expect(result.output).toMatchObject({
    records: [
      {
        tenant_id: "tenant",
        case_id: "case-1",
        synthetic: false,
        provenance: {
          method: "connector_normalizer",
          invocation_id: "invocation",
          connector_id: connection.connectorId,
        },
      },
    ],
  });
  expect(result.sourceEvidence).toMatchObject({
    complete: true,
    datasetIds: ["public.customers"],
    observedAt: "2026-11-09T12:00:00.000Z",
  });
  const same = await adapter.invoke(
    "customers",
    capability as never,
    { subjects: ["1"] },
    context,
  );
  expect(
    (same.output as { records: Array<{ version_id: string }> }).records[0]!
      .version_id,
  ).toBe(
    (result.output as { records: Array<{ version_id: string }> }).records[0]!
      .version_id,
  );
  const refreshed = await adapter.invoke(
    "customers",
    capability as never,
    { subjects: ["1"] },
    { ...context, invocationId: "new-invocation" },
  );
  expect(
    (refreshed.output as { records: Array<{ version_id: string }> }).records[0]!
      .version_id,
  ).not.toBe(
    (result.output as { records: Array<{ version_id: string }> }).records[0]!
      .version_id,
  );
  vi.mocked(fetchContextSample).mockResolvedValueOnce({
    rows: [],
    truncated: true,
    fingerprint: resource.schemaFingerprint,
  });
  await expect(
    adapter.invoke(
      "customers",
      capability as never,
      { subjects: ["1"] },
      context,
    ),
  ).rejects.toThrow("context.ingestion_requires_repair");
  vi.mocked(getContextEnablement).mockResolvedValue({
    ...enablement,
    paused: true,
  });
  await expect(
    adapter.invoke(
      "customers",
      capability as never,
      { subjects: ["1"] },
      context,
    ),
  ).rejects.toThrow("context.mapping_not_enabled");
});
