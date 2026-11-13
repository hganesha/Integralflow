import { describe, expect, it } from "vitest";
import { harnessPlanV2Schema, stableDigest } from "@ehf/contracts";
import { executeRuntimeInvocation, type RuntimeExecutorDependencies } from "./executor.js";

const digest = "a".repeat(64);

function planV2() {
  const content = {
    apiVersion: "harness.factory/plan-v2" as const,
    kind: "HarnessPlan" as const,
    packageDigest: digest,
    compiler: { name: "harnessc" as const, version: "2.0.0", digest, compatibilityVersion: "4", lgirCoreRevision: "abcdef0" },
    metadata: { name: "host-v2", version: "2.0.0", domain: "test", objective: "Exercise v2 host" },
    execution: {
      engine: { kind: "harness-runtime" as const, adapterVersion: "harness-runtime-v2", profile: "production-v2" },
      coordinationMode: "caseStore" as const,
      maxTransitions: 10,
      maxConcurrency: 2,
      durability: "durable" as const,
    },
    budgets: { maxDurationMs: 30_000, maxCostUsd: 1, maxModelCalls: 1, maxCapabilityCalls: 1 },
    schemas: { input: { type: "object" }, output: { type: "object" }, schemaSetDigest: digest },
    modelProfiles: [], agentProfiles: [], capabilities: [], permissionEnvelopes: [],
    policyBundles: [], contextSelectors: [], contextClassificationPolicies: [],
    graph: {
      apiVersion: "ladder.dev/v1alpha1" as const,
      name: "host-v2",
      nodes: [
        { id: "input", kind: "input" as const, name: "Input", contextSelectorIds: [], config: {} },
        { id: "output", kind: "output" as const, name: "Output", contextSelectorIds: [], config: {} },
      ],
      edges: [{ id: "edge", from: "input", to: "output", kind: "data" as const }],
      nodeOrder: ["input", "output"],
    },
    releaseConstraints: { regions: ["US"], dataClasses: [], evaluationRequirementIds: [] },
    dependencyManifest: [], dependencyManifestDigest: digest,
    createdAt: "2026-09-19T12:00:00.000Z",
    buildProvenanceDigest: digest,
  };
  return harnessPlanV2Schema.parse({ ...content, planId: "plan_host_v2", planDigest: stableDigest(content) });
}

function dependencies(withAdapters = true): RuntimeExecutorDependencies {
  return {
    gatewayUrl: "http://gateway",
    caseApiUrl: "http://case-api",
    controlPlaneUrl: "http://control",
    serviceToken: "service-token",
    createStateStore: () => ({
      nodeStarted: async () => undefined,
      nodeFinished: async () => undefined,
      appendEvent: async () => undefined,
      markCheckpoint: async () => undefined,
    }),
    ...(withAdapters ? {
      v2Adapters: {
        loadCaseSnapshot: async () => { throw new Error("unexpected snapshot"); },
        evaluateGate: async () => { throw new Error("unexpected gate"); },
        executeFanoutBody: async () => { throw new Error("unexpected fanout"); },
      },
    } : {}),
  };
}

function invocation() {
  const plan = planV2();
  return {
    contractVersion: "runtime.invocation.v2" as const,
    invocationId: "INV-v2",
    runId: "RUN-v2",
    attempt: 1,
    workerId: "worker-1",
    leaseId: "RUN-v2:1:1",
    fencingEpoch: 1,
    deadlineAt: new Date(Date.now() + 30_000).toISOString(),
    planDigest: plan.planDigest,
    executionProfileDigest: digest,
    executionGrant: "grant",
    plan,
    input: { tenantId: "tenant-1", caseId: "case-1", value: 7 },
  };
}

describe("runtime executor v2 integration", () => {
  it("executes an admitted v2 plan through the v2 lowering", async () => {
    await expect(executeRuntimeInvocation(invocation(), dependencies())).resolves.toMatchObject({
      invocationId: "INV-v2",
      runId: "RUN-v2",
      status: "completed",
      output: { tenantId: "tenant-1", caseId: "case-1", value: 7 },
    });
  });

  it("fails closed when authority adapters were not configured", async () => {
    await expect(executeRuntimeInvocation(invocation(), dependencies(false))).resolves.toMatchObject({
      status: "failed",
      errorCode: "runtime.v2.adapters_missing",
    });
  });

  it("passes the invocation grant and fence to a case-context adapter", async () => {
    const plan = structuredClone(planV2());
    plan.contextSelectors = [{ id: "case-id", source: "case", path: "case.caseId", purpose: "TEST", classification: "CONFIDENTIAL", required: true }];
    plan.graph.nodes[1]!.contextSelectorIds = ["case-id"];
    const { planId: _planId, planDigest: _planDigest, ...content } = plan;
    plan.planDigest = stableDigest(content);
    const canonical = {
      apiVersion: "harness.factory/case-snapshot-v1" as const, kind: "CaseSnapshot" as const,
      tenantId: "tenant-1", caseId: "case-1", caseSequence: 1,
      dependencyDigest: digest, planDigest: plan.planDigest,
      policyAuthority: { policyId: "policy.test", policyVersion: "1", policySnapshotDigest: digest, policyBundleDigest: digest },
      consistency: "strong" as const, classification: "CONFIDENTIAL", data: { case: { caseId: "case-1" } },
    };
    const snapshotDigest = stableDigest(canonical);
    const dependenciesForRead = dependencies();
    dependenciesForRead.v2Adapters = {
      loadCaseSnapshot: async (request) => {
        expect(request.execution).toEqual({ grant: "grant", invocationId: "INV-v2", runId: "RUN-v2", attempt: 1, workerId: "worker-1", fencingEpoch: 1 });
        return { ...canonical, snapshotId: `snapshot_${snapshotDigest}`, snapshotDigest, capturedAt: "2026-09-20T00:00:00.000Z" };
      },
      evaluateGate: async () => { throw new Error("unexpected gate"); },
    };
    await expect(executeRuntimeInvocation({ ...invocation(), plan, planDigest: plan.planDigest }, dependenciesForRead)).resolves.toMatchObject({ status: "completed" });
  });
});
