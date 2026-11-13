import { randomUUID } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
import {
  contextBindingSchema,
  contextConnectionSchema,
  stableDigest,
} from "@ehf/contracts";
import fixture from "../../../packages/contracts/test-fixtures/context-source.json" with { type: "json" };
import { contextSourceModule } from "./adapters/context-source.js";
import type {
  AdapterInvocationContext,
  AdapterModuleDeps,
} from "./adapters/types.js";
import type { CapabilityDefinition } from "@ehf/contracts";

const mock = vi.hoisted(() => ({
  load: vi.fn(),
  qualification: vi.fn(),
  read: vi.fn(),
}));
vi.mock("@ehf/persistence", () => ({
  loadContextBinding: mock.load,
  contextSourceQualification: mock.qualification,
}));
vi.mock("@ehf/context-connectors", async (original) => ({
  ...(await original<typeof import("@ehf/context-connectors")>()),
  runContextConnector: mock.read,
}));
const connection = contextConnectionSchema.parse(fixture.connection);
const binding = contextBindingSchema.parse({
  ...fixture.binding,
  subjectField: "subject_id",
  purposes: ["review"],
  parameters: [
    {
      name: "customer_id",
      type: "string",
      required: true,
      valueFrom: { source: "input", path: "subject.customerId" },
    },
  ],
});
const name = `${stableDigest({ tenantId: "tenant-test" }).slice(0, 16)}:${binding.id}.r1`;
const context = {
  tenantId: "tenant-test",
  invocationId: randomUUID(),
  sourceAuthorization: { checkEndpoint: vi.fn() },
  execution: { claims: { case_id: "CASE-1042" } },
} as unknown as AdapterInvocationContext;
const adapter = contextSourceModule.create({
  env: {},
  db: {},
  fetch: vi.fn(),
} as unknown as AdapterModuleDeps);
beforeEach(() => {
  vi.clearAllMocks();
  mock.load.mockResolvedValue({
    binding: { definition: binding, revision: 1, digest: "a".repeat(64) },
    connection: { definition: connection, digest: "b".repeat(64) },
  });
  mock.qualification.mockResolvedValue({
    status: "passed",
    id: "qualification-1",
    bindingDigest: "a".repeat(64),
    connectionDigest: "b".repeat(64),
    schemaFingerprint: "c".repeat(64),
  });
  mock.read.mockResolvedValue({
    rows: [
      {
        id: "CIF-123",
        name: "Example",
        entity_type: "company",
        identifiers: [],
        subject_id: "ENTITY-789",
        observed_at: new Date(Date.now() - 1000).toISOString(),
      },
    ],
    fields: [],
    truncated: false,
    schemaFingerprint: "c".repeat(64),
  });
});
it("uses the saved field mapping on the gateway read and preserves returned subject/purpose lineage", async () => {
  const result = await adapter.invoke(
    name,
    {} as CapabilityDefinition,
    { subject: { customerId: "CIF-123" }, customer_id: "override" },
    context,
  );
  expect(mock.read.mock.calls[0]?.[2]).toEqual({ customer_id: "CIF-123" });
  expect(mock.read.mock.calls[0]?.[3].checkTransport).toBe(
    context.sourceAuthorization!.checkEndpoint,
  );
  expect(result.output).toMatchObject({
    records: [
      {
        subject_ids: ["ENTITY-789"],
        purposes: ["review"],
        provenance: { provider_check_id: "qualification-1" },
      },
    ],
  });
});
it("fails unresolved lookup input before making a source call", async () => {
  await expect(
    adapter.invoke(
      name,
      {} as CapabilityDefinition,
      { customer_id: "no-fallback" },
      context,
    ),
  ).rejects.toThrow("lookup_value_missing");
  expect(mock.read).not.toHaveBeenCalled();
});
it("resolves signed case IDs independently of caller input and requires execution authority", async () => {
  const scoped = {
    ...binding,
    parameters: [
      {
        name: "customer_id",
        type: "string",
        required: true,
        valueFrom: { source: "case_id" },
      },
    ],
  };
  mock.load.mockResolvedValue({
    binding: { definition: scoped, revision: 1, digest: "a".repeat(64) },
    connection: { definition: connection, digest: "b".repeat(64) },
  });
  await adapter.invoke(
    name,
    {} as CapabilityDefinition,
    { caseId: "different-case" },
    context,
  );
  expect(mock.read.mock.calls[0]?.[2]).toEqual({ customer_id: "CASE-1042" });
  const { execution: _, ...withoutExecution } = context;
  await expect(
    adapter.invoke(
      name,
      {} as CapabilityDefinition,
      { caseId: "spoofed" },
      withoutExecution,
    ),
  ).rejects.toThrow("case_authority_required");
  expect(mock.read).toHaveBeenCalledOnce();
});
