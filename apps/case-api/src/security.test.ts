import { describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import type { CaseStore } from "@ehf/case-store";
import { assertActiveCaseExecution, submitBusinessCommand } from "@ehf/case-store";
import { businessCommandSchema } from "@ehf/contracts";
import { mintExecutionEnvelope } from "@ehf/execution-auth";
import { buildCaseApi } from "./app.js";
import { verifiedActor } from "./execution-authority.js";

const edge = "test-edge-credential-00000000001";
const runtime = "test-runtime-credential-00000001";
const secret = "test-execution-secret-0000000001";
const digest = "a".repeat(64);
const actor = { type: "HUMAN" as const, principalId: "forged-reviewer", roles: ["KYC.SeniorReviewer"] };
const command = businessCommandSchema.parse({ commandId: "cmd", commandType: "FinalizeDisposition", commandVersion: "v1",
  tenantId: "tenant_demo", caseId: "case_a", actor, authority: { planDigest: digest, permissionEnvelopeDigest: digest, policySnapshotDigest: digest },
  payload: {}, preconditions: { caseSequence: 1 }, idempotencyKey: "cmd" });
const execution = { tenant_id: "tenant_demo", case_id: "case_a", run_id: "run_a", plan_digest: digest, attempt: 1, fencing_epoch: 1 };
const grants = [{ token: edge, subjectId: "edge", tenantId: "tenant_demo", roles: ["Edge.Delegate"] },
  { token: runtime, subjectId: "runtime", tenantId: "tenant_demo", roles: ["Case.Api.Access"] }];
function setup() {
  const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
  const store = { db: { query }, ownsDatabase: false, evidenceMaxBytes: 1048576 } as unknown as CaseStore;
  const app = buildCaseApi({ store, serviceGrants: grants, executionSecret: secret, env: {} });
  app.log.level = "silent";
  return { app, query };
}
const mint = (caseId = "case_a") => mintExecutionEnvelope({ secret, tenantId: "tenant_demo", caseId, invocationId: "inv",
  runId: "run_a", nodeId: "node", attempt: 1, planDigest: digest, permissionDigest: digest, capabilities: [], effects: [],
  caseWrites: ["AddSubject"], fencingEpoch: 1 });

describe("case security boundaries", () => {
  it("derives human identity and domain roles exclusively from verified assignments", () => {
    const principal = { subjectId: "actual-analyst", tenantId: "tenant_demo", actorType: "human" as const, roles: ["Case.Analyst"], source: "local" as const };
    expect(verifiedActor(principal, actor)).toEqual({ type: "HUMAN", principalId: "actual-analyst", roles: ["KYC.Analyst"] });
    expect(verifiedActor({ ...principal, roles: ["Case.Reviewer"] }, actor).roles).toEqual(["KYC.SeniorReviewer"]);
    expect(() => verifiedActor({ ...principal, actorType: "workload" }, actor)).toThrow("authorization.actor_type_invalid");
  });
  it("denies analyst disposition regardless of supplied actor roles", async () => {
    const { app, query } = setup();
    const response = await app.inject({ method: "POST", url: "/v1/cases/case_a/commands", payload: command,
      headers: { authorization: `Bearer ${edge}`, "x-actor-id": "analyst", "x-actor-roles": "Case.Analyst" } });
    expect(response.statusCode).toBe(403);
    expect(query).not.toHaveBeenCalled();
    await app.close();
  });
  it("never lets the edge speak for a workload, whatever it forwards", async () => {
    const { app, query } = setup();
    const response = await app.inject({ method: "POST", url: "/v1/cases/case_a/commands", payload: { ...command, commandType: "AddSubject" },
      headers: { authorization: `Bearer ${edge}`, "x-ehf-forwarded-authorization": `Bearer ${runtime}`, "x-actor-id": "runtime-oid", "x-actor-roles": "Case.Api.Access" } });
    // A forwarded credential is not an identity: the request is the edge acting for a
    // person, and a workload role asserted for a person grants nothing.
    expect(response.statusCode).toBe(403);
    expect(query).not.toHaveBeenCalled();
    await app.close();
  });
  it.each(["/v1/cases", "/v1/cases/case_b", "/v1/cases/case_b/snapshot", "/v1/evidence/ev_b", "/v1/cases/case_b/exports/digest/json"])("denies workload reads via %s before touching data", async (url) => {
    const { app, query } = setup();
    for (const token of [undefined, await mint()]) {
      const response = await app.inject({ url, headers: { authorization: `Bearer ${runtime}`, ...(token ? { "x-execution-envelope": token } : {}) } });
      expect(response.statusCode).toBe(403);
    }
    expect(query).not.toHaveBeenCalled();
    await app.close();
  });
  it("denies wrong-case reads and writes even with matching plan digests", async () => {
    const { app, query } = setup();
    const headers = { authorization: `Bearer ${runtime}`, "x-execution-envelope": await mint("case_b") };
    expect((await app.inject({ url: "/v2/cases/case_a/snapshot", headers })).json().error).toBe("authorization.execution_scope_mismatch");
    const result = await app.inject({ method: "POST", url: "/v1/cases/case_a/commands", headers,
      payload: { ...command, commandType: "AddSubject", actor: { type: "AGENT", principalId: "runtime", roles: [] } } });
    expect(result.json().error).toBe("authorization.execution_scope_mismatch");
    expect(query).not.toHaveBeenCalled();
    await app.close();
  });
  it("rejects old unscoped and expired signed envelopes", async () => {
    const { app } = setup();
    const base = { run_id: "run_a", node_id: "node", attempt: 1, plan_digest: digest, permission_digest: digest, capabilities: [], effects: [], fencing_epoch: 1 };
    for (const expired of [false, true]) {
      const payload = { ...base, ...(expired ? { tenant_id: "tenant_demo", case_id: "case_a" } : {}),
        iss: "ehf-runtime", aud: "ehf-capability-gateway", jti: "old", iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + (expired ? -60 : 60) };
      const input = `${Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url")}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
      const token = `${input}.${createHmac("sha256", secret).update(input).digest("base64url")}`;
      const response = await app.inject({ url: "/v2/cases/case_a/snapshot", headers: { authorization: `Bearer ${runtime}`, "x-execution-envelope": token } });
      expect(response.json().error).toBe("authorization.execution_envelope_invalid");
    }
    await app.close();
  });
  it("checks live authority and holds its transaction until the case commit", async () => {
    const calls: string[] = [];
    const executionQuery = vi.fn(async (sql: string) => { calls.push(`execution:${sql}`); return { rows: [{ allowed: true }], rowCount: 1 }; });
    const caseQuery = vi.fn(async (sql: string) => { calls.push(`case:${sql}`); return { rows: [], rowCount: 0 }; });
    const store = { db: { connect: async () => ({ query: caseQuery, release() {} }) },
      executionDb: { connect: async () => ({ query: executionQuery, release() {} }) }, schemas: { core: "case_core", ledger: "case_ledger", evidence: "evidence" } } as unknown as CaseStore;
    await expect(submitBusinessCommand(store, command, execution)).rejects.toThrow("case.not_found");
    expect(calls[0]).toBe("execution:begin");
    expect(calls.findIndex((value) => value.includes("lock_case_execution"))).toBeLessThan(calls.findIndex((value) => value.includes('from "case_core"')));
    // The case transaction ends before the execution transaction releases the lease; the
    // refused command is recorded only after both have ended.
    const caseRollback = calls.indexOf("case:rollback");
    const executionRollback = calls.indexOf("execution:rollback");
    expect(caseRollback).toBeGreaterThan(0);
    expect(executionRollback).toBeGreaterThan(caseRollback);
    expect(calls.findIndex((value) => value.includes("rejected_commands"))).toBeGreaterThan(executionRollback);
    expect(executionQuery.mock.calls[1]?.[0]).toContain("lock_case_execution");
    await expect(assertActiveCaseExecution({ query: async () => ({ rows: [{ allowed: false }] }) } as never, execution, "tenant_demo", "case_a"))
      .rejects.toThrow("authorization.execution_inactive");
  });
});
