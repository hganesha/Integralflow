import { describe, expect, it } from "vitest";
import type { CaseStore } from "@ehf/case-store";
import type { BusinessCommandType } from "@ehf/contracts";
import { mintDelegatedEnvelope, mintExecutionEnvelope, verifyExecutionEnvelope } from "@ehf/execution-auth";
import { buildCaseApi } from "./app.js";

// The skill-commit and release endpoints refuse authority the node's envelope does not carry
// before the store is touched: this store fails every query.
const EDGE_TOKEN = "edge-service-token-for-tests-0001";
const RUNTIME_TOKEN = "runtime-service-token-for-tests-01";
const INTEGRATION_TOKEN = "integration-service-token-for-tests-0001";
const SECRET = "case-skill-commit-envelope-secret-001";
const digest = "a".repeat(64);
let touched = 0;

function untouchableStore(): CaseStore {
  const fail = async () => { touched += 1; throw new Error("store must not be reached"); };
  return {
    db: { query: fail, connect: fail }, ownsDatabase: false, schemas: { core: "case_core", ledger: "case_ledger", evidence: "evidence" },
    artifactBackend: "postgres", evidenceRequireScan: false, evidenceMaxBytes: 1024,
  } as unknown as CaseStore;
}

function api() {
  const app = buildCaseApi({
    store: untouchableStore(), env: {}, executionSecret: SECRET,
    serviceGrants: [
      { token: EDGE_TOKEN, subjectId: "control-surface-edge", roles: ["Edge.Delegate"], tenantId: "tenant_demo" },
      { token: RUNTIME_TOKEN, subjectId: "harness-runtime", roles: ["Case.Api.Access"], tenantId: "tenant_demo" },
      { token: INTEGRATION_TOKEN, subjectId: "integration-worker", roles: ["Integration.Dispatch"], tenantId: "tenant_demo" },
    ],
  });
  app.log.level = "silent";
  return app;
}

function envelope(caseWrites: BusinessCommandType[], caseWritesHeld: BusinessCommandType[] = [], nodeId = "ubo-resolve") {
  return mintExecutionEnvelope({
    secret: SECRET, tenantId: "tenant_demo", caseId: "case_1", invocationId: `INV-${nodeId}`, runId: "RUN-1", nodeId, attempt: 1,
    planDigest: digest, permissionDigest: digest, capabilities: [], effects: [], caseWrites, caseWritesHeld, fencingEpoch: 1,
  });
}

const commit = (commands: Array<{ localRef: string; commandType: string; payload?: Record<string, unknown> }>, extra: Record<string, unknown> = {}) => ({
  tenantId: "tenant_demo", caseId: "case_1",
  binding: {
    skillId: "ownership.ubo.resolve", skillVersion: "0.2.0", executionId: "RUN-1:ubo-resolve:x", manifestDigest: digest,
    bundleDigest: `sha256:${digest}`, receiptDigest: digest, requestDigest: digest, contextHash: digest, codeDigest: null, instructionsDigest: null,
  },
  effectMode: "internal_write", approval: "none",
  commands: commands.map((command) => ({ payload: {}, ...command })), held: [], releaseNodeId: null, approvalNodeId: null, uncommitted: [],
  ...extra,
});

describe("skill commit endpoint", () => {
  it("refuses a command type outside the envelope's case_writes, a forbidden command, and a held-only command, before the store", async () => {
    const app = api();
    touched = 0;
    try {
      const post = async (body: unknown, token: string) => app.inject({ payload: body as Record<string, unknown>,
        method: "POST", url: "/v1/cases/case_1/skill-commits",
        headers: { authorization: `Bearer ${RUNTIME_TOKEN}`, "x-execution-envelope": token },
      });
      const undeclared = await post(commit([{ localRef: "record:a", commandType: "ProposeClaim" }]), await envelope(["LinkEvidence"]));
      expect(undeclared.statusCode).toBe(403);
      expect(undeclared.json().error).toBe("authorization.command_not_declared");
      for (const forbidden of ["FinalizeDisposition", "RecordReview", "RecordGateResult", "AcceptClaimAsFact"] as const) {
        const refused = await post(commit([{ localRef: "effect:k", commandType: forbidden }], { expectedCaseSequence: 1 }), await envelope([forbidden]));
        expect(refused.statusCode).toBe(403);
        expect(refused.json().error).toBe("skill_commit.command_forbidden");
      }
      const heldOnly = await post(commit([{ localRef: "effect:k", commandType: "TransitionCaseStatus" }], { expectedCaseSequence: 1 }), await envelope([], ["TransitionCaseStatus"]));
      expect(heldOnly.statusCode).toBe(403);
      expect(heldOnly.json().error).toBe("skill_commit.command_held_only");
      const shape = await post(commit([{ localRef: "record:a", commandType: "TransitionCaseStatus" }]), await envelope(["TransitionCaseStatus"]));
      expect(shape.json().error).toBe("skill_commit.command_shape_invalid");
      // Effects without the case sequence they were computed against are not accepted at all.
      const unsequenced = await post(commit([{ localRef: "effect:k", commandType: "RequestHumanReview" }]), await envelope(["RequestHumanReview"]));
      expect(unsequenced.statusCode).toBe(400);
      expect(touched).toBe(0);
    } finally { await app.close(); }
  });

  it("accepts only the runtime with a node envelope: never a skill host's delegated envelope, a human, or the integration worker", async () => {
    const app = api();
    touched = 0;
    try {
      const body = commit([{ localRef: "record:a", commandType: "ProposeClaim" }]);
      const parent = await verifyExecutionEnvelope(await envelope(["ProposeClaim"]), SECRET);
      const delegated = await mintDelegatedEnvelope({
        secret: SECRET, parent, delegatedTo: "skills:ownership.ubo.resolve@0.2.0", capabilities: [], effects: [], deadlineAt: Math.floor(Date.now() / 1000) + 30,
      });
      const fromHost = await app.inject({ method: "POST", url: "/v1/cases/case_1/skill-commits",
        headers: { authorization: `Bearer ${RUNTIME_TOKEN}`, "x-execution-envelope": delegated.envelope }, payload: body });
      expect(fromHost.statusCode).toBe(403);
      expect(fromHost.json().error).toBe("authorization.delegated_envelope_refused");
      const human = await app.inject({ method: "POST", url: "/v1/cases/case_1/skill-commits",
        headers: { authorization: `Bearer ${EDGE_TOKEN}`, "x-actor-id": "analyst@example.test", "x-actor-roles": "Case.Analyst" }, payload: body });
      expect(human.json().error).toBe("authorization.skill_commit_runtime_required");
      const integration = await app.inject({ method: "POST", url: "/v1/cases/case_1/skill-commits",
        headers: { authorization: `Bearer ${INTEGRATION_TOKEN}` }, payload: body });
      expect(integration.json().error).toBe("authorization.skill_commit_runtime_required");
      const release = await app.inject({ method: "POST", url: "/v1/cases/case_1/skill-executions/RUN-1:x/release",
        headers: { authorization: `Bearer ${RUNTIME_TOKEN}`, "x-execution-envelope": delegated.envelope },
        payload: { tenantId: "tenant_demo", caseId: "case_1", executionId: "RUN-1:x", skillNodeId: "a", approvalNodeId: "b", bindingDigest: digest,
          decision: { decision: "APPROVE", authority: "HUMAN", decisionIds: ["d"], reviewerPrincipalIds: ["r"] }, routedActions: [] } });
      expect(release.json().error).toBe("authorization.delegated_envelope_refused");
      expect(touched).toBe(0);
    } finally { await app.close(); }
  });

  it("keeps held-only and release grants off the generic command endpoint", async () => {
    const app = api();
    try {
      const response = await app.inject({
        method: "POST", url: "/v1/cases/case_1/commands",
        headers: { authorization: `Bearer ${RUNTIME_TOKEN}`, "x-execution-envelope": await envelope([], ["TransitionCaseStatus"], "close-effects") },
        payload: {
          commandId: "cmd_1", commandType: "TransitionCaseStatus", commandVersion: "v1", tenantId: "tenant_demo", caseId: "case_1",
          actor: { type: "AGENT", principalId: "runtime", roles: [] }, authority: { planDigest: digest, permissionEnvelopeDigest: digest, policySnapshotDigest: digest },
          payload: { toStatus: "VALIDATING", reason: "bypass" }, preconditions: { caseSequence: 1 }, idempotencyKey: "k",
        },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json().error).toBe("authorization.command_not_declared");
    } finally { await app.close(); }
  });
});
