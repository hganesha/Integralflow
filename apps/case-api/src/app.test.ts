import { describe, expect, it } from "vitest";
import type { CaseStore } from "@ehf/case-store";
import { buildCaseApi } from "./app.js";

const EDGE_TOKEN = "edge-service-token-for-tests-0001";
const RUNTIME_TOKEN = "runtime-service-token-for-tests-01";

function stubStore(): CaseStore {
  return {
    db: { query: async () => ({ rowCount: 0, rows: [] }) },
    ownsDatabase: false,
    schemas: { core: "case_core", ledger: "case_ledger", evidence: "evidence" },
    artifactBackend: "postgres",
    evidenceRequireScan: false,
    evidenceMaxBytes: 1024,
  } as unknown as CaseStore;
}

function caseApi() {
  return buildCaseApi({
    store: stubStore(),
    env: {},
    serviceGrants: [
      { token: EDGE_TOKEN, subjectId: "control-surface-edge", roles: ["Edge.Delegate"], tenantId: "tenant_demo" },
      { token: RUNTIME_TOKEN, subjectId: "harness-runtime", roles: ["Case.Api.Access"], tenantId: "tenant_demo" },
    ],
  });
}

describe("case tenancy", () => {
  it("rejects an anonymous read that asserts a tenant header", async () => {
    const app = caseApi();
    // x-tenant-id used to be the only thing between a caller and a tenant's cases.
    const response = await app.inject({
      method: "GET", url: "/v1/cases", headers: { "x-tenant-id": "tenant_demo" },
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("rejects a delegated caller asking for a tenant it was not assigned", async () => {
    const app = caseApi();
    const response = await app.inject({
      method: "GET", url: "/v1/cases",
      headers: {
        authorization: `Bearer ${EDGE_TOKEN}`,
        "x-actor-id": "analyst@example.test",
        "x-actor-roles": "Case.Analyst",
        "x-tenant-id": "tenant_other",
      },
    });
    // Authenticated, but the edge may narrow its assigned tenant, never widen it.
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toBe("authorization.delegated_tenant_mismatch");
    await app.close();
  });

  it("scopes case pagination by an admitted harness plan digest", async () => {
    const queries: unknown[][] = [];
    const store = {
      ...stubStore(),
      // Case reads run in a transaction bound to the tenant, so the fake hands out a client.
      db: { connect: async () => ({
        query: async (sql: string, values?: unknown[]) => {
          if (sql.includes("from ")) queries.push(values ?? []);
          return { rowCount: 0, rows: [] };
        },
        release: () => {},
      }) },
    } as unknown as CaseStore;
    const app = buildCaseApi({
      store,
      env: {},
      serviceGrants: [{ token: EDGE_TOKEN, subjectId: "control-surface-edge", roles: ["Edge.Delegate"], tenantId: "tenant_demo" }],
    });
    const digest = "b".repeat(64);
    const response = await app.inject({
      method: "GET",
      url: `/v1/cases?planDigest=${digest}`,
      headers: {
        authorization: `Bearer ${EDGE_TOKEN}`,
        "x-actor-id": "reader@example.test",
        "x-actor-roles": "Harness.Reader",
        "x-tenant-id": "tenant_demo",
      },
    });
    expect(response.statusCode).toBe(200);
    expect(queries[0]?.[2]).toBe(digest);
    await app.close();
  });

  it("rejects a command whose body names another tenant", async () => {
    const app = caseApi();
    const response = await app.inject({
      method: "POST", url: "/v1/cases/case_1/commands",
      headers: { authorization: `Bearer ${RUNTIME_TOKEN}` },
      payload: {
        commandId: "cmd_1", commandType: "AddSubject", commandVersion: "v1",
        tenantId: "tenant_other", caseId: "case_1",
        actor: { type: "AGENT", principalId: "node", roles: [] },
        authority: { planDigest: "a".repeat(64), permissionEnvelopeDigest: "a".repeat(64), policySnapshotDigest: "a".repeat(64) },
        payload: { subjectType: "individual" }, preconditions: { caseSequence: 0 },
        idempotencyKey: "k1",
      },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toBe("authorization.tenant_mismatch");
    await app.close();
  });

  it("denies a reader the write actions", async () => {
    const app = caseApi();
    const response = await app.inject({
      method: "POST", url: "/v1/evidence:register",
      headers: {
        authorization: `Bearer ${EDGE_TOKEN}`,
        "x-actor-id": "reader@example.test",
        "x-actor-roles": "Harness.Reader",
      },
      payload: {},
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toBe("authorization.role_missing");
    await app.close();
  });

  it("requires a declared purpose for an authority-bearing case snapshot", async () => {
    const app = caseApi();
    const response = await app.inject({
      method: "GET", url: "/v1/cases/case_1/snapshot",
      headers: {
        authorization: `Bearer ${EDGE_TOKEN}`,
        "x-actor-id": "analyst@example.test",
        "x-actor-roles": "Case.Analyst",
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("case.snapshot_purpose_required");
    await app.close();
  });

  it("requires a declared purpose on the canonical v2 snapshot path without replacing v1", async () => {
    const app = caseApi();
    const response = await app.inject({
      method: "GET", url: "/v2/cases/case_1/snapshot",
      headers: {
        authorization: `Bearer ${EDGE_TOKEN}`,
        "x-actor-id": "analyst@example.test",
        "x-actor-roles": "Case.Analyst",
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("case.snapshot_purpose_required");
    await app.close();
  });

  it("returns the typed fail-closed response when canonical snapshot authority is incomplete", async () => {
    const row = {
      tenant_id: "tenant_demo", case_id: "case_1", case_type: "kyc_onboarding", schema_version: "kyc.case.v1",
      jurisdiction: "US", status: "SCREENING", case_sequence: 7, external_ref: null,
      policy_snapshot_digest: "a".repeat(64), harness_plan_digest: "b".repeat(64), classification: "CONFIDENTIAL",
      created_by: { type: "HUMAN", principalId: "analyst", roles: [] },
      created_at: new Date("2026-01-01T00:00:00.000Z"), updated_at: new Date("2026-01-02T00:00:00.000Z"),
    };
    const client = {
      query: async (sql: string) => sql.includes('from "case_core"."cases"')
        ? { rows: [row], rowCount: 1 }
        : { rows: [], rowCount: 0 },
      release: () => undefined,
    };
    const store = {
      ...stubStore(),
      db: { connect: async () => client },
    } as unknown as CaseStore;
    const app = buildCaseApi({
      store,
      env: {},
      serviceGrants: [{ token: EDGE_TOKEN, subjectId: "control-surface-edge", roles: ["Edge.Delegate"], tenantId: "tenant_demo" }],
    });
    const response = await app.inject({
      method: "GET", url: "/v2/cases/case_1/snapshot",
      headers: {
        authorization: `Bearer ${EDGE_TOKEN}`,
        "x-actor-id": "analyst@example.test",
        "x-actor-roles": "Case.Analyst",
        "x-purpose": "KYC_POLICY_EVALUATION",
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: "case.snapshot_authority_incomplete",
      missingAuthorityFields: ["dependencyDigest", "policyId", "policyVersion", "policyBundleDigest"],
    });
    await app.close();
  });
});

describe("case context read authority", () => {
  const ENVELOPE_SECRET = "case-read-envelope-secret-for-tests-01";
  const planDigest = "b".repeat(64);

  function canonicalStore(): CaseStore {
    const row = {
      tenant_id: "tenant_demo", case_id: "case_1", case_type: "kyc_onboarding", schema_version: "kyc.case.v1",
      jurisdiction: "US", status: "SCREENING", case_sequence: 7, external_ref: null,
      policy_snapshot_digest: "a".repeat(64), harness_plan_digest: planDigest, dependency_digest: "c".repeat(64),
      policy_id: "policy.kyc.customer-acceptance.v1", policy_version: "1.0.0", policy_bundle_digest: "d".repeat(64),
      classification: "CONFIDENTIAL", created_by: { type: "HUMAN", principalId: "analyst", roles: [] },
      created_at: new Date("2026-01-01T00:00:00.000Z"), updated_at: new Date("2026-01-02T00:00:00.000Z"),
    };
    return {
      ...stubStore(),
      db: { query: async (sql: string) => sql.includes("lock_case_execution") ? { rows: [{ allowed: true }], rowCount: 1 } : { rows: [], rowCount: 0 }, connect: async () => ({
        query: async (sql: string) => sql.includes('from "case_core"."cases"')
          ? { rows: [row], rowCount: 1 }
          : { rows: [], rowCount: 0 },
        release: () => undefined,
      }) },
    } as unknown as CaseStore;
  }

  function api() {
    return buildCaseApi({
      store: canonicalStore(), env: {}, executionSecret: ENVELOPE_SECRET,
      serviceGrants: [{ token: RUNTIME_TOKEN, subjectId: "harness-runtime", roles: ["Case.Api.Access"], tenantId: "tenant_demo" }],
    });
  }

  async function envelope(overrides: { purpose?: string; planDigest?: string; includeClassificationPolicy?: boolean } = {}) {
    const { mintExecutionEnvelope } = await import("@ehf/execution-auth");
    return mintExecutionEnvelope({
      tenantId: "tenant_demo", caseId: "case_1",
      secret: ENVELOPE_SECRET, invocationId: "INV-READ-1", runId: "RUN-READ-1", nodeId: "screen",
      attempt: 1, planDigest: overrides.planDigest ?? planDigest, permissionDigest: "e".repeat(64),
      capabilities: [], effects: [], caseReads: [{
        id: "case-id", source: "case", path: "case.caseId", purpose: overrides.purpose ?? "KYC_SCREENING", classification: "CONFIDENTIAL", required: true,
      }], ...(overrides.includeClassificationPolicy === false ? {} : {
        caseReadPolicies: [{ classification: "CONFIDENTIAL", action: "allow" as const }],
      }), fencingEpoch: 1,
    });
  }

  it("requires a signed context grant for a workload canonical snapshot", async () => {
    const app = api();
    const response = await app.inject({
      method: "GET", url: "/v2/cases/case_1/snapshot",
      headers: { authorization: `Bearer ${RUNTIME_TOKEN}`, "x-purpose": "KYC_SCREENING" },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error).toBe("authorization.execution_envelope_required");
    await app.close();
  });

  it("returns only signed selector data and binds it to the envelope plan", async () => {
    const app = api();
    const response = await app.inject({
      method: "GET", url: "/v2/cases/case_1/snapshot",
      headers: {
        authorization: `Bearer ${RUNTIME_TOKEN}`,
        "x-purpose": "KYC_SCREENING",
        "x-execution-envelope": await envelope(),
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual({ case: { caseId: "case_1" } });
    expect(response.json().data).not.toHaveProperty("evidence");
    await app.close();
  });

  it("denies an invented purpose or a different plan", async () => {
    const app = api();
    const purposeMismatch = await app.inject({
      method: "GET", url: "/v2/cases/case_1/snapshot",
      headers: { authorization: `Bearer ${RUNTIME_TOKEN}`, "x-purpose": "OTHER", "x-execution-envelope": await envelope() },
    });
    expect(purposeMismatch.statusCode).toBe(403);
    expect(purposeMismatch.json().error).toBe("authorization.context_purpose_mismatch");
    const planMismatch = await app.inject({
      method: "GET", url: "/v2/cases/case_1/snapshot",
      headers: { authorization: `Bearer ${RUNTIME_TOKEN}`, "x-purpose": "KYC_SCREENING", "x-execution-envelope": await envelope({ planDigest: "f".repeat(64) }) },
    });
    expect(planMismatch.statusCode).toBe(403);
    expect(planMismatch.json().error).toBe("document.execution_not_authorized");
    await app.close();
  });

  it("requires the signed classification treatment for every workload selector", async () => {
    const app = api();
    const response = await app.inject({
      method: "GET", url: "/v2/cases/case_1/snapshot",
      headers: { authorization: `Bearer ${RUNTIME_TOKEN}`, "x-purpose": "KYC_SCREENING", "x-execution-envelope": await envelope({ includeClassificationPolicy: false }) },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toBe("authorization.context_classification_policy_missing");
    await app.close();
  });
});

describe("case write authority", () => {
  const ENVELOPE_SECRET = "case-envelope-secret-for-tests-0001";

  function api() {
    return buildCaseApi({
      store: stubStore(),
      env: {},
      executionSecret: ENVELOPE_SECRET,
      serviceGrants: [
        { token: EDGE_TOKEN, subjectId: "control-surface-edge", roles: ["Edge.Delegate"], tenantId: "tenant_demo" },
        { token: RUNTIME_TOKEN, subjectId: "harness-runtime", roles: ["Case.Api.Access"], tenantId: "tenant_demo" },
      ],
    });
  }

  const digest = "a".repeat(64);
  const command = (commandType: string) => ({
    commandId: "cmd_1", commandType, commandVersion: "v1",
    tenantId: "tenant_demo", caseId: "case_1",
    actor: { type: "AGENT", principalId: "node", executionId: "RUN-1", roles: [] },
    authority: { planDigest: digest, permissionEnvelopeDigest: digest, policySnapshotDigest: digest },
    payload: { subjectType: "individual" }, preconditions: { caseSequence: 0 },
    idempotencyKey: "k1",
  });

  async function envelope(caseWrites: string[]) {
    const { mintExecutionEnvelope } = await import("@ehf/execution-auth");
    return mintExecutionEnvelope({
      tenantId: "tenant_demo", caseId: "case_1",
      secret: ENVELOPE_SECRET, invocationId: "INV-1", runId: "RUN-1", nodeId: "node",
      attempt: 1, planDigest: digest, permissionDigest: digest,
      capabilities: [], effects: [], caseWrites: caseWrites as never, fencingEpoch: 1,
    });
  }

  it("rejects a workload case write with no execution envelope", async () => {
    const app = api();
    // A workload token says which service is calling. It does not say that this run's
    // node was granted authority to submit a canonical command.
    const response = await app.inject({
      method: "POST", url: "/v1/cases/case_1/commands",
      headers: { authorization: `Bearer ${RUNTIME_TOKEN}` },
      payload: command("AddSubject"),
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error).toBe("authorization.execution_envelope_required");
    await app.close();
  });

  it("rejects a command type the plan never declared for that node", async () => {
    const app = api();
    const response = await app.inject({
      method: "POST", url: "/v1/cases/case_1/commands",
      headers: {
        authorization: `Bearer ${RUNTIME_TOKEN}`,
        "x-execution-envelope": await envelope(["LinkEvidence"]),
      },
      payload: command("AddSubject"),
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toBe("authorization.command_not_declared");
    await app.close();
  });

  it("rejects an envelope signed with another secret", async () => {
    const app = api();
    const { mintExecutionEnvelope } = await import("@ehf/execution-auth");
    const forged = await mintExecutionEnvelope({
      tenantId: "tenant_demo", caseId: "case_1",
      secret: "an-attackers-envelope-secret-0001", invocationId: "INV-1", runId: "RUN-1",
      nodeId: "node", attempt: 1, planDigest: digest, permissionDigest: digest,
      capabilities: [], effects: [], caseWrites: ["AddSubject"], fencingEpoch: 1,
    });
    const response = await app.inject({
      method: "POST", url: "/v1/cases/case_1/commands",
      headers: { authorization: `Bearer ${RUNTIME_TOKEN}`, "x-execution-envelope": forged },
      payload: command("AddSubject"),
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toBe("authorization.execution_envelope_invalid");
    await app.close();
  });

  it("rejects a person recording a command as an agent", async () => {
    const app = api();
    const response = await app.inject({
      method: "POST", url: "/v1/cases/case_1/commands",
      headers: {
        authorization: `Bearer ${EDGE_TOKEN}`,
        "x-actor-id": "analyst@example.test",
        "x-actor-roles": "Case.Analyst",
      },
      payload: command("AddSubject"),
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toBe("authorization.actor_type_invalid");
    await app.close();
  });

  it("refuses a person without standing on the case before anything is written, and lets a workload through", async () => {
    const asked: string[] = [];
    const app = buildCaseApi({
      store: stubStore(), env: {}, executionSecret: ENVELOPE_SECRET,
      serviceGrants: [
        { token: EDGE_TOKEN, subjectId: "control-surface-edge", roles: ["Edge.Delegate"], tenantId: "tenant_demo" },
        { token: RUNTIME_TOKEN, subjectId: "harness-runtime", roles: ["Case.Api.Access"], tenantId: "tenant_demo" },
      ],
      caseStanding: async (_tenant, caseId, subjectId) => { asked.push(`${caseId}:${subjectId}`); return "none"; },
    });
    const response = await app.inject({
      method: "POST", url: "/v1/cases/case_1/commands",
      headers: { authorization: `Bearer ${EDGE_TOKEN}`, "x-actor-id": "analyst@example.test", "x-actor-roles": "Case.Analyst" },
      payload: { ...command("AddSubject"), actor: { type: "HUMAN", principalId: "analyst@example.test", roles: [] } },
    });
    expect(response.statusCode, response.body).toBe(403);
    expect(response.json().error).toBe("authorization.case_standing_missing");
    expect(asked).toEqual(["case_1:analyst@example.test"]);
    // An agent's authority is its execution envelope, never a person's standing.
    await app.inject({
      method: "POST", url: "/v1/cases/case_1/commands",
      headers: { authorization: `Bearer ${RUNTIME_TOKEN}`, "x-execution-envelope": await envelope(["AddSubject"]) },
      payload: command("AddSubject"),
    });
    expect(asked).toHaveLength(1);
    await app.close();
  });

  it("rejects a command claiming a plan the envelope did not authorize", async () => {
    const app = api();
    const response = await app.inject({
      method: "POST", url: "/v1/cases/case_1/commands",
      headers: {
        authorization: `Bearer ${RUNTIME_TOKEN}`,
        "x-execution-envelope": await envelope(["AddSubject"]),
      },
      payload: { ...command("AddSubject"), authority: { planDigest: "b".repeat(64), permissionEnvelopeDigest: digest, policySnapshotDigest: digest } },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toBe("authorization.command_plan_mismatch");
    await app.close();
  });
});

describe("integration case authority", () => {
  const integrationToken = "integration-service-token-for-tests-0001";
  const integrationSecret = "integration-envelope-secret-tests-0001";
  const digest = "a".repeat(64);

  it.each([
    { roles: ["Case.Api.Access"], header: "x-integration-envelope", error: "authorization.execution_envelope_required" },
    { roles: ["Integration.Dispatch"], header: "x-execution-envelope", error: "authorization.integration_envelope_required" },
  ])("selects write authority from verified roles, not $header", async ({ roles, header, error }) => {
    const app = buildCaseApi({ store: stubStore(), env: {}, integrationSecret,
      serviceGrants: [{ token: integrationToken, subjectId: "workload", roles, tenantId: "tenant_demo" }] });
    try {
      const response = await app.inject({ method: "POST", url: "/v1/cases/case_1/commands",
        headers: { authorization: `Bearer ${integrationToken}`, [header]: "caller-chosen" },
        payload: { commandId: "cmd_1", commandType: "AddSubject", commandVersion: "v1", tenantId: "tenant_demo", caseId: "case_1",
          actor: { type: "INTEGRATION", principalId: "binding:binding-1", roles: ["Integration.Dispatch"] },
          authority: { planDigest: digest, permissionEnvelopeDigest: digest, policySnapshotDigest: digest },
          payload: { subjectType: "individual" }, preconditions: { caseSequence: 0 }, idempotencyKey: "receipt-1" },
      });
      expect(response.statusCode).toBe(401);
      expect(response.json().error).toBe(error);
    } finally { await app.close(); }
  });

  it("rejects an integration command that was not declared by the signed binding envelope", async () => {
    const { mintIntegrationEnvelope } = await import("@ehf/execution-auth");
    const envelope = await mintIntegrationEnvelope({ secret: integrationSecret, envelopeId: "integration-1",
      tenantId: "tenant_demo", deploymentId: "development", bindingId: "binding-1", bindingRevision: 1,
      planDigest: digest, caseId: "case_1", intent: "submit_case_command", commandType: "LinkEvidence", nonce: "receipt-1" });
    const app = buildCaseApi({ store: stubStore(), env: {}, integrationSecret,
      serviceGrants: [{ token: integrationToken, subjectId: "integration-worker", roles: ["Integration.Dispatch"], tenantId: "tenant_demo" }] });
    const response = await app.inject({ method: "POST", url: "/v1/cases/case_1/commands",
      headers: { authorization: `Bearer ${integrationToken}`, "x-integration-envelope": envelope },
      payload: { commandId: "cmd_1", commandType: "AddSubject", commandVersion: "v1", tenantId: "tenant_demo", caseId: "case_1",
        actor: { type: "INTEGRATION", principalId: "binding:binding-1", roles: ["Integration.Dispatch"] },
        authority: { planDigest: digest, permissionEnvelopeDigest: digest, policySnapshotDigest: digest },
        payload: { subjectType: "individual" }, preconditions: { caseSequence: 0 }, idempotencyKey: "receipt-1" },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toBe("authorization.integration_command_not_declared");
    await app.close();
  });
});


describe("request admission", () => {
  it("bounds requests per peer and rejects forwarding-header spoofing", async () => {
    const app = caseApi();
    app.log.level = "silent";
    try {
      for (let i = 0; i < 1000; i++) {
        const response = await app.inject({ method: "GET", url: "/health/live", remoteAddress: "192.0.2.1" });
        expect(response.statusCode).toBe(200);
      }
      const denied = await app.inject({ method: "GET", url: "/health/live", remoteAddress: "192.0.2.1", headers: { "x-forwarded-for": "192.0.2.99" } });
      expect(denied.statusCode).toBe(429);
      expect(Number(denied.headers["retry-after"])).toBeGreaterThan(0);
      expect((await app.inject({ method: "GET", url: "/health/live", remoteAddress: "192.0.2.2" })).statusCode).toBe(200);
    } finally { await app.close(); }
  });
});

describe("case re-planning authority", () => {
  const CONTROL_TOKEN = "control-api-service-token-for-tests";
  const replanApi = () => buildCaseApi({
    store: stubStore(), env: {},
    serviceGrants: [
      { token: EDGE_TOKEN, subjectId: "control-surface-edge", roles: ["Edge.Delegate"], tenantId: "tenant_demo" },
      { token: RUNTIME_TOKEN, subjectId: "harness-runtime", roles: ["Case.Api.Access"], tenantId: "tenant_demo" },
      { token: CONTROL_TOKEN, subjectId: "control-api", roles: ["Edge.Delegate", "Case.Replan"], tenantId: "tenant_demo" },
    ],
  });
  const command = {
    commandId: "cmd-1", commandType: "ReplanCase", commandVersion: "v1", tenantId: "tenant_demo", caseId: "case-1",
    actor: { type: "SYSTEM", principalId: "control-api", roles: [] },
    authority: { planDigest: "a".repeat(64), permissionEnvelopeDigest: "b".repeat(64), policySnapshotDigest: "c".repeat(64) },
    payload: {}, preconditions: { caseSequence: 1 }, idempotencyKey: "replan-1",
  };
  const post = (headers: Record<string, string>) => replanApi().inject({ method: "POST", url: "/v1/cases/case-1/commands", payload: command, headers: { "x-tenant-id": "tenant_demo", ...headers } });

  it("is refused to a case worker, a reviewer and the runtime: only the control plane in its own name holds case.replan", async () => {
    for (const roles of ["Case.Analyst", "Case.Reviewer", "Case.Analyst,Case.Reviewer"]) {
      const response = await post({ authorization: `Bearer ${EDGE_TOKEN}`, "x-actor-id": "analyst@example.test", "x-actor-roles": roles });
      expect(response.statusCode, roles).toBe(403);
    }
    expect((await post({ authorization: `Bearer ${RUNTIME_TOKEN}` })).statusCode).toBe(403);
    // The control plane delegating for a person does not carry its own authority either.
    expect((await post({ authorization: `Bearer ${CONTROL_TOKEN}`, "x-actor-id": "analyst@example.test", "x-actor-roles": "Case.Analyst" })).statusCode).toBe(403);
  });

  it("keeps the re-planning context (pin, status, work items) to the re-planning authority", async () => {
    const get = (headers: Record<string, string>) => replanApi().inject({ method: "GET", url: "/v1/cases/case-1/replan-context", headers: { "x-tenant-id": "tenant_demo", ...headers } });
    expect((await get({ authorization: `Bearer ${EDGE_TOKEN}`, "x-actor-id": "analyst@example.test", "x-actor-roles": "Case.Analyst" })).statusCode).toBe(403);
    expect((await get({ authorization: `Bearer ${RUNTIME_TOKEN}` })).statusCode).toBe(403);
    // The control plane's own role reads it (past the authority checks the stub store fails)...
    expect([401, 403]).not.toContain((await get({ authorization: `Bearer ${CONTROL_TOKEN}` })).statusCode);
    // ...but not the full case view, with its subjects and records.
    expect((await replanApi().inject({ method: "GET", url: "/v1/cases/case-1", headers: { "x-tenant-id": "tenant_demo", authorization: `Bearer ${CONTROL_TOKEN}` } })).statusCode).toBe(403);
  });

  it("reaches the case store for the control plane in its own name", async () => {
    const response = await post({ authorization: `Bearer ${CONTROL_TOKEN}` });
    // Authorized: the stub store then fails to load the case, which is past the authority checks.
    expect(response.statusCode).not.toBe(401);
    expect(response.statusCode).not.toBe(403);
  });
});
