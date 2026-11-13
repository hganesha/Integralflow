import { beforeEach, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { stableDigest, type ContextCaseBinding } from "@ehf/contracts";
import { registerContextPulls, sourceKeysForCase } from "./context-pulls.js";
import * as persistence from "@ehf/persistence";
vi.mock("@ehf/persistence", async (actual) => ({
  ...(await actual<object>()),
  getContextDefinition: vi.fn(),
  getContextEnablement: vi.fn(),
  getPlan: vi.fn(),
  loadSourceAuthority: vi.fn(),
  requireExecutableRelease: vi.fn(),
  createRun: vi.fn(),
  listContextDefinitions: vi.fn(),
  getRun: vi.fn(),
}));
vi.mock("@ehf/context-bank-connectors", () => ({
  assertContextSourceDestination: vi.fn(),
}));
vi.mock("@ehf/context-mapping", () => ({
  compileMapping: () => ({ digest: "m".repeat(64) }),
}));
vi.mock("@ehf/policy-engine", () => ({
  evaluateSourceAuthorization: () => ({ outcome: "ALLOW" }),
}));
const binding: ContextCaseBinding = {
  kind: "case-binding",
  id: "case-source",
  caseId: "case-1",
  mappingId: "customers",
  mappingDigest: "a".repeat(64),
  enablementRevision: 1,
  planDigest: "b".repeat(64),
  nodeId: "fetch",
  sourceContextDigest: "c".repeat(64),
  subjects: [{ subjectId: "canonical-1", sourceKey: "crm-1" }],
  enabled: true,
};
const plan = {
  planDigest: binding.planDigest,
  contextSelectors: [{ id: "case-meta", source: "case", path: "case" }],
  capabilities: [
    {
      id: "context.records.fetch.v1",
      adapterBindingId: "context-salesforce:customers",
    },
  ],
  graph: {
    nodes: [
      { id: "input", kind: "input", config: {} },
      {
        id: "project",
        kind: "transform",
        config: { operation: "project", fields: ["subjects"] },
      },
      {
        id: "fetch",
        kind: "tool",
        contextSelectorIds: ["case-meta"],
        config: {
          capabilityId: "context.records.fetch.v1",
          usePredecessorInput: true,
          caseWrites: [
            {
              commandType: "RecordCanonicalRecords",
              payload: { records: "{{output.records}}" },
            },
          ],
        },
      },
      { id: "output", kind: "output", config: {} },
    ],
    edges: [
      { from: "input", to: "project", kind: "data" },
      { from: "project", to: "fetch", kind: "data" },
      { from: "fetch", to: "output", kind: "data" },
    ],
  },
};
const revision = (definition: unknown, digest: string) => ({
  definition,
  digest,
  revision: 1,
  createdAt: "2026-11-09T12:00:00Z",
  createdBy: "reviewer",
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(persistence.getContextDefinition).mockImplementation(
    async (_db, _scope, kind) => {
      if (kind === "case-binding")
        return revision(binding, stableDigest(binding)) as never;
      if (kind === "mapping")
        return revision(
          {
            kind: "mapping",
            id: "customers",
            resourceId: "resource",
            resourceDigest: "d".repeat(64),
            outputs: [{ objectType: "Entity" }],
          },
          binding.mappingDigest,
        ) as never;
      if (kind === "resource")
        return revision(
          {
            kind: "resource",
            id: "resource",
            connectionId: "connection",
            connectionDigest: "e".repeat(64),
            datasetId: "salesforce.Account",
            columns: ["key"],
            api: { kind: "salesforce", fields: { key: "Id" } },
          },
          "d".repeat(64),
        ) as never;
      return revision(
        {
          kind: "connection",
          id: "connection",
          connectorId: "context-salesforce:customers",
          api: { kind: "salesforce" },
        },
        "e".repeat(64),
      ) as never;
    },
  );
  vi.mocked(persistence.getContextEnablement).mockResolvedValue({
    revision: 1,
    mappingDigest: binding.mappingDigest,
    paused: false,
    authority: {
      planDigest: binding.planDigest,
      contextDigest: binding.sourceContextDigest,
    },
  } as never);
  vi.mocked(persistence.getPlan).mockResolvedValue(plan as never);
  vi.mocked(persistence.loadSourceAuthority).mockResolvedValue({
    context: { caseId: "case-1" },
    binding: {
      mappingVersion: "m".repeat(64),
      datasetIds: ["salesforce.Account"],
      fields: ["Id"],
    },
  } as never);
  vi.mocked(persistence.createRun).mockResolvedValue({
    created: true,
    run: { runId: "run-1", status: "queued" },
  } as never);
  vi.mocked(persistence.listContextDefinitions).mockResolvedValue([
    revision(binding, stableDigest(binding)),
  ] as never);
});
const request = {
  bindingId: binding.id,
  expectedBindingDigest: stableDigest(binding),
  subjects: ["canonical-1"],
  idempotencyKey: "request-1",
};
async function app() {
  const app = Fastify();
  registerContextPulls(app, {
    db: { query: vi.fn().mockResolvedValue({ rows: [] }) } as never,
    env: {},
    authorize: vi.fn(
      async () =>
        ({
          tenantId: "tenant",
          subjectId: "operator",
          actorType: "human",
          roles: ["Harness.Operator"],
        }) as never,
    ),
  });
  return app;
}
it("resolves only reviewed case subjects to source keys", () => {
  expect(sourceKeysForCase(binding, ["canonical-1"])).toEqual(["crm-1"]);
  expect(() => sourceKeysForCase(binding, ["crm-1"])).toThrow(
    "case_subject_scope_denied",
  );
  expect(() =>
    sourceKeysForCase(binding, ["canonical-1", "canonical-1"]),
  ).toThrow("case_subject_scope_denied");
});
it("queues a released acquisition with server-derived source keys and reports uncommitted status", async () => {
  const a = await app();
  try {
    const r = await a.inject({
      method: "POST",
      url: "/v1/context/cases/case-1/pulls",
      payload: request,
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({
      runId: "run-1",
      committed: false,
      status: "queued",
    });
    expect(persistence.createRun).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        tenantId: "tenant",
        runInput: expect.objectContaining({
          caseId: "case-1",
          subjects: ["crm-1"],
          canonicalSubjects: ["canonical-1"],
          contextPullBinding: { id: binding.id, digest: stableDigest(binding) },
        }),
      }),
    );
  } finally {
    await a.close();
  }
});
it("rejects foreign cases, source IDs supplied as canonical IDs, changed pins and arbitrary query fields before admission", async () => {
  const a = await app();
  try {
    for (const [caseId, payload] of [
      ["other", request],
      ["case-1", { ...request, subjects: ["foreign"] }],
      ["case-1", { ...request, expectedBindingDigest: "f".repeat(64) }],
      ["case-1", { ...request, query: "SELECT everything" }],
    ] as const) {
      const r = await a.inject({
        method: "POST",
        url: `/v1/context/cases/${caseId}/pulls`,
        payload,
      });
      expect(r.statusCode).toBeGreaterThanOrEqual(400);
    }
    expect(persistence.createRun).not.toHaveBeenCalled();
  } finally {
    await a.close();
  }
});
it("case metadata reads never acquire sources or start a run, and hide vendor source keys", async () => {
  const a = await app();
  try {
    const r = await a.inject("/v1/context/cases/case-1/bindings");
    expect(r.statusCode).toBe(200);
    expect(r.json().items[0].definition.subjects).toEqual(["canonical-1"]);
    expect(r.body).not.toContain("crm-1");
    const status = await a.inject("/v1/context/cases/case-1/pulls");
    expect(status.json()).toEqual({ items: [] });
    expect(persistence.loadSourceAuthority).not.toHaveBeenCalled();
    expect(persistence.createRun).not.toHaveBeenCalled();
  } finally {
    await a.close();
  }
});
it("does not report a completed run as committed without the matching canonical write receipt", async () => {
  const a = Fastify();
  const query = vi
    .fn()
    .mockResolvedValueOnce({ rows: [{ run_id: "run-1" }] })
    .mockResolvedValueOnce({ rows: [] });
  vi.mocked(persistence.getRun).mockResolvedValue({
    runId: "run-1",
    planDigest: binding.planDigest,
    status: "completed",
    input: {
      caseId: "case-1",
      contextPullNodeId: "fetch",
      contextPullBinding: { id: binding.id, digest: stableDigest(binding) },
      canonicalSubjects: ["canonical-1"],
    },
    createdAt: "2026-11-09T12:00:00Z",
    completedAt: "2026-11-09T12:01:00Z",
    errorCode: null,
  } as never);
  registerContextPulls(a, {
    db: { query } as never,
    env: {},
    authorize: vi.fn(
      async () =>
        ({
          tenantId: "tenant",
          subjectId: "operator",
          actorType: "human",
          roles: ["Harness.Operator"],
        }) as never,
    ),
  });
  try {
    const r = await a.inject("/v1/context/cases/case-1/pulls");
    expect(r.statusCode).toBe(200);
    expect(r.json().items[0]).toMatchObject({
      status: "failed",
      committed: false,
      errorCode: "context.pull_commit_missing",
    });
    expect(query.mock.calls[1]?.[1]).toEqual(["run-1", "fetch"]);
  } finally {
    await a.close();
  }
});
