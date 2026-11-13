import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { harnessPlanV2Schema, stableDigest, verifyHarnessPlanDigest, type HarnessPlanV2 } from "@ehf/contracts";
import { mintRuntimeGrant, verifyExecutionEnvelope } from "@ehf/execution-auth";
import type { Database } from "@ehf/persistence";
import { declaredCaseReadPolicies, declaredCaseReads, declaredCaseWrites, declaredHeldCaseWrites, EnvelopeBrokerError, issueExecutionEnvelope } from "./envelope-broker.js";

// Release authority and the node's work-item lease are durable state with their own
// tests; here they are stand-ins so the broker's own checks are what is exercised.
vi.mock("@ehf/persistence", async (importOriginal) => ({
  ...await importOriginal<typeof import("@ehf/persistence")>(),
  requireExecutableRelease: async () => ({}),
  getExecutionWorkItem: async (_db: unknown, _tenantId: string, workItemId: string) => ({
    status: "RUNNING",
    lease: { fencingEpoch: 1, owner: "worker-1", leaseUntil: new Date(Date.now() + 60_000).toISOString() },
    constraints: { nodeId: workItemId.replace(/^WI-/, ""), runId: "RUN-1" },
  }),
}));

const ENVELOPE_SECRET = "broker-envelope-secret-for-tests-01";
const GRANT_SECRET = "broker-grant-secret-for-tests-000001";

/** Checked-in plan emitted by harnessc, so the test needs no build output. */
function fixturePlan(): HarnessPlanV2 {
  return harnessPlanV2Schema.parse(JSON.parse(readFileSync(
    new URL("../../../packages/contracts/test-fixtures/conformance.plan.json", import.meta.url),
    "utf8",
  )));
}

/** Minimal stand-in for the run/plan reads the broker performs. */
function database(plan: HarnessPlanV2, overrides: { status?: string; epoch?: number } = {}): Database {
  return {
    query: async (text: string) => {
      if (text.includes("from harness_control.plans")) return { rows: [{ plan }], rowCount: 1 };
      if (text.includes("select fencing_epoch")) {
        return overrides.status && overrides.status !== "running"
          ? { rows: [], rowCount: 0 }
          : { rows: [{ fencing_epoch: overrides.epoch ?? 4 }], rowCount: 1 };
      }
      return {
        rowCount: 1,
        rows: [{
          tenant_id: "tenant_demo", run_id: "RUN-1", idempotency_key: "k", plan_digest: plan.planDigest,
          status: overrides.status ?? "running", terminal_outcome: null, input: { caseId: "CASE-1" }, output: null,
          attempt: 2, fencing_epoch: overrides.epoch ?? 4, latest_checkpoint_id: null,
          current_node_id: null, error_code: null, trace_id: null, root_span_id: null,
          trace_flags: null, cost_usd: 0, cost_complete: true, model_calls: 0, capability_calls: 0,
          created_at: new Date(), started_at: null, completed_at: null, updated_at: new Date(),
        }],
      };
    },
  } as unknown as Database;
}

function grant(plan: HarnessPlanV2, overrides: Partial<{ runId: string; attempt: number; epoch: number; nodeId: string }> = {}) {
  const nodeId = overrides.nodeId ?? "lookup";
  return mintRuntimeGrant({
    secret: GRANT_SECRET, grantId: "INV-1",
    runId: overrides.runId ?? "RUN-1", attempt: overrides.attempt ?? 2,
    workerId: "worker-1", planDigest: plan.planDigest,
    fencingEpoch: overrides.epoch ?? 4, ttlSeconds: 120,
    nodeId, workItemId: `WI-${nodeId}`, workFencingEpoch: 1,
  });
}

const request = { runId: "RUN-1", nodeId: "lookup", attempt: 2, invocationId: "INV-1" };

describe("execution envelope broker", () => {
  it("derives case-read grants from the node selector set", () => {
    const plan = {
      apiVersion: "harness.factory/plan-v2",
      graph: { nodes: [{ id: "screen", contextSelectorIds: ["subject"] }] },
      contextSelectors: [{ id: "subject", source: "case", path: "case.subject", purpose: "KYC_SCREENING", classification: "CONFIDENTIAL", required: true }],
      contextClassificationPolicies: [{ classification: "CONFIDENTIAL", action: "allow" }],
    } as unknown as import("@ehf/contracts").HarnessPlanV2;
    const reads = declaredCaseReads(plan, "screen");
    expect(reads).toEqual([{ id: "subject", source: "case", path: "case.subject", purpose: "KYC_SCREENING", classification: "CONFIDENTIAL", required: true }]);
    expect(declaredCaseReadPolicies(plan, reads)).toEqual([{ classification: "CONFIDENTIAL", action: "allow" }]);
    expect(declaredCaseReads(plan, "unknown")).toEqual([]);
  });

  it("issues an envelope whose authority comes from the admitted plan", async () => {
    const plan = fixturePlan();
    expect(verifyHarnessPlanDigest(plan)).toBe(true);
    const result = await issueExecutionEnvelope(
      { db: database(plan), envelopeSecret: ENVELOPE_SECRET, grantSecret: GRANT_SECRET },
      await grant(plan),
      request,
    );
    const claims = await verifyExecutionEnvelope(result.envelope, ENVELOPE_SECRET);
    const permission = plan.permissionEnvelopes.find((item) => item.nodeId === "lookup");
    expect(claims.permission_digest).toBe(permission?.digest);
    expect(claims.capabilities).toEqual(permission?.capabilities);
    expect(claims.fencing_epoch).toBe(4);
    // Case-write authority is the plan's declaration, not anything the caller asserted.
    expect(claims.case_writes).toEqual(["LinkEvidence", "ProposeClaim"]);
    expect(declaredCaseWrites(plan, "lookup")).toEqual(["LinkEvidence", "ProposeClaim"]);
    // Case-read authority is the node's compiled selector set.
    expect(result.caseReads.map((read) => read.id)).toEqual(["case-id"]);
    expect(result.caseReadPolicies).toEqual([{ classification: "PUBLIC", action: "allow" }]);
  });

  it("marks the envelope of a node that shows a model a context pack, and only such a node", async () => {
    const plan = harnessPlanV2Schema.parse(JSON.parse(readFileSync(new URL("../../../packages/contracts/test-fixtures/agent-profiles.plan.json", import.meta.url), "utf8")));
    const claimsFor = async (nodeId: string) => verifyExecutionEnvelope((await issueExecutionEnvelope(
      { db: database(plan), envelopeSecret: ENVELOPE_SECRET, grantSecret: GRANT_SECRET },
      await grant(plan, { nodeId }), { ...request, nodeId },
    )).envelope, ENVELOPE_SECRET);
    // Agent and evaluate nodes with an agent profile: their agent commands must cite the pack.
    expect((await claimsFor("kyc-investigation")).context_required).toBe(true);
    expect((await claimsFor("case-assessment")).context_required).toBe(true);
    // A tool node reads the case but shows no model a pack.
    expect((await claimsFor("sanctions-screen")).context_required).toBeUndefined();
  });

  it("gives discovery neither a case identity nor evidence promotion authority", async () => {
    const source = harnessPlanV2Schema.parse(JSON.parse(readFileSync(
      new URL("../../../packages/contracts/test-fixtures/agent-profiles.plan.json", import.meta.url), "utf8",
    )));
    const nodeId = "kyc-investigation";
    const { planId, planDigest: _digest, ...content } = source;
    content.metadata.domain = "discovery";
    const node = content.graph.nodes.find(item => item.id === nodeId)!;
    const seal = () => ({ ...content, planId, planDigest: stableDigest(content) });
    const issue = async (plan: HarnessPlanV2) => issueExecutionEnvelope(
      { db: database(plan), envelopeSecret: ENVELOPE_SECRET, grantSecret: GRANT_SECRET }, await grant(plan, { nodeId }), { ...request, nodeId },
    );
    await expect(issue(seal())).rejects.toThrow("broker.discovery_case_authority_denied");
    node.contextSelectorIds = [];
    delete node.config.caseWrites;
    delete node.config.evidenceCapture;
    const envelope = (await issue(seal())).envelope;
    const claims = await verifyExecutionEnvelope(envelope, ENVELOPE_SECRET);
    expect(claims.case_id).toBeNull();
    expect(claims.case_writes).toEqual([]);
    expect(claims.case_reads).toEqual([]);
    expect(claims.context_required).toBeUndefined();
  });

  it("puts skill grants a node may only hold or release into case_writes_held, never case_writes", async () => {
    const skillPlan = JSON.parse(readFileSync(new URL("../../../packages/contracts/test-fixtures/skill-commit.plan.json", import.meta.url), "utf8")) as HarnessPlanV2;
    expect(declaredCaseWrites(skillPlan, "case-close")).toEqual(["LinkEvidence", "ProposeClaim", "RecordScreeningFinding", "RaiseContradiction", "ProposeWorkItem", "RecordCanonicalRecords"]);
    expect(declaredHeldCaseWrites(skillPlan, "case-close")).toEqual(["TransitionCaseStatus"]);
    expect(declaredCaseWrites(skillPlan, "case-close-effects")).toEqual([]);
    expect(declaredHeldCaseWrites(skillPlan, "case-close-effects")).toEqual(["TransitionCaseStatus"]);
    expect(declaredHeldCaseWrites(skillPlan, "ubo-review")).toEqual([]);
  });

  it("refuses a grant signed with the wrong secret", async () => {
    const plan = fixturePlan();
    const forged = await mintRuntimeGrant({
      secret: "an-attackers-grant-secret-value-01", grantId: "INV-1", runId: "RUN-1",
      attempt: 2, workerId: "worker-1", planDigest: plan.planDigest, fencingEpoch: 4, ttlSeconds: 120,
    });
    await expect(issueExecutionEnvelope(
      { db: database(plan), envelopeSecret: ENVELOPE_SECRET, grantSecret: GRANT_SECRET }, forged, request,
    )).rejects.toThrow("broker.grant_invalid");
  });

  it("refuses to sign for a node the plan does not permit", async () => {
    const plan = fixturePlan();
    await expect(issueExecutionEnvelope(
      { db: database(plan), envelopeSecret: ENVELOPE_SECRET, grantSecret: GRANT_SECRET },
      await grant(plan, { nodeId: "intake" }),
      { ...request, nodeId: "intake" },
    )).rejects.toThrow("broker.node_not_permitted");
  });

  it("refuses a grant issued for a different node", async () => {
    const plan = fixturePlan();
    await expect(issueExecutionEnvelope(
      { db: database(plan), envelopeSecret: ENVELOPE_SECRET, grantSecret: GRANT_SECRET },
      await grant(plan, { nodeId: "intake" }),
      request,
    )).rejects.toThrow("broker.node_grant_required");
  });

  it("refuses a grant whose fence has moved on", async () => {
    // A runtime that lost its lease keeps a syntactically valid grant. The fence is read
    // from durable state at issue time precisely so that grant stops buying authority.
    const plan = fixturePlan();
    await expect(issueExecutionEnvelope(
      { db: database(plan, { epoch: 9 }), envelopeSecret: ENVELOPE_SECRET, grantSecret: GRANT_SECRET },
      await grant(plan, { epoch: 4 }),
      request,
    )).rejects.toThrow("broker.stale_fence");
  });

  it("refuses once the run is no longer running", async () => {
    const plan = fixturePlan();
    await expect(issueExecutionEnvelope(
      { db: database(plan, { status: "completed" }), envelopeSecret: ENVELOPE_SECRET, grantSecret: GRANT_SECRET },
      await grant(plan),
      request,
    )).rejects.toThrow("broker.run_not_running");
  });

  it("refuses a grant issued for a different run", async () => {
    const plan = fixturePlan();
    await expect(issueExecutionEnvelope(
      { db: database(plan), envelopeSecret: ENVELOPE_SECRET, grantSecret: GRANT_SECRET },
      await grant(plan, { runId: "RUN-OTHER" }),
      request,
    )).rejects.toBeInstanceOf(EnvelopeBrokerError);
  });
});
