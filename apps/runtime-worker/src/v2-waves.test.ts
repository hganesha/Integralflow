import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HarnessPlanV2 } from "@ehf/contracts";

/**
 * Exercises the durable dispatcher's wave scheduling against an in-memory stand-in for the
 * work-item ledger and a scripted runtime provider.
 */
const state = vi.hoisted(() => ({
  status: new Map<string, string>(),
  outputs: new Map<string, unknown>(),
  failures: new Map<string, string>(),
  suspended: [] as string[],
  inFlight: 0,
  maxInFlight: 0,
  invoked: [] as string[],
  finished: null as null | { status: string; terminalOutcome: string; output: unknown },
  humanRequested: [] as string[],
}));

vi.mock("@ehf/persistence", () => ({
  getExecutionWorkItem: async (_db: unknown, _tenant: string, workItemId: string) => ({
    status: state.status.get(workItemId) ?? "READY", caseId: "case-1", dispatch: { generation: 1, queue: "q" },
  }),
  getExecutionOutput: async (_db: unknown, _tenant: string, workItemId: string) => state.outputs.get(workItemId),
  reconcileExecutionWorkItems: async () => {},
  scheduleExecutionWork: async () => [],
  publishPostgresExecutionDispatch: async () => {},
  acquireExecutionWorkItemLease: async (_db: unknown, input: { workItemId: string }) => ({
    outcome: "acquired", workItem: { lease: { executionId: `exec-${input.workItemId}`, fencingEpoch: 1 } },
  }),
  startExecutionWorkItem: async () => {},
  completeExecutionWorkItem: async (_db: unknown, input: { workItemId: string; output: unknown }) => {
    state.status.set(input.workItemId, "COMPLETED");
    state.outputs.set(input.workItemId, input.output);
  },
  suspendExecutionWorkItem: async (_db: unknown, input: { workItemId: string }) => { state.suspended.push(input.workItemId); },
  requestHumanExecutionDecision: async (_db: unknown, input: { workItemId: string }) => { state.humanRequested.push(input.workItemId); },
  renewLease: async () => true,
  renewExecutionWorkItemLease: async () => true,
  cancellationRequested: async () => null,
  requireExecutableRelease: async () => ({}),
  resolveSettingSection: async () => ({ value: { provider: "local_http", bindings: {} } }),
  completeRun: async (_db: unknown, input: { status: string; terminalOutcome: string; output: unknown }) => { state.finished = input; },
  retainExecutionOutcome: async () => {},
  latestExecutionOutcome: async () => null,
}));

vi.mock("@ehf/execution-auth", () => ({ mintRuntimeGrant: async () => "grant" }));

vi.mock("@ehf/runtime-provider", () => ({
  createRuntimeProvider: () => ({
    kind: "local_http", executionProfileDigest: "a".repeat(64),
    invoke: async (invocation: { invocationId: string; runId: string; nodeExecution: { nodeId: string; predecessorValues: Record<string, unknown> } }) => {
      const nodeId = invocation.nodeExecution.nodeId;
      state.invoked.push(nodeId);
      state.inFlight += 1;
      state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
      await new Promise((resolve) => setTimeout(resolve, 20));
      state.inFlight -= 1;
      const failure = state.failures.get(nodeId);
      if (failure) return { contractVersion: "runtime.result.v1", invocationId: invocation.invocationId, runId: invocation.runId, status: "failed", output: null, errorCode: failure, checkpointId: null, providerMetadata: {} };
      return { contractVersion: "runtime.result.v1", invocationId: invocation.invocationId, runId: invocation.runId, status: "completed",
        output: { node: nodeId, saw: Object.keys(invocation.nodeExecution.predecessorValues).sort() }, errorCode: null, checkpointId: null, providerMetadata: {} };
    },
  }),
}));

const { executeV2WorkGraph, settlesIntoAllSettledJoin } = await import("./v2-execution.js");

function plan(joinMode: "all" | "allSettled", maxConcurrency = 4, withApproval = false): HarnessPlanV2 {
  const ids = ["input", "a", "b", "c", "join", ...(withApproval ? ["approve"] : []), "output"];
  const nodes = ids.map((id) => ({
    id, name: id, contextSelectorIds: [],
    kind: id === "input" ? "input" : id === "output" ? "output" : id === "join" ? "join" : id === "approve" ? "approval" : "tool",
    config: id === "join" ? { mode: joinMode } : {},
  }));
  const edges = [
    ...["a", "b", "c"].flatMap((id) => [{ id: `in-${id}`, from: "input", to: id, kind: "data" }, { id: `${id}-join`, from: id, to: "join", kind: "data" }]),
    ...(withApproval
      ? [{ id: "join-approve", from: "join", to: "approve", kind: "data" }, { id: "approve-out", from: "approve", to: "output", kind: "data" }]
      : [{ id: "join-out", from: "join", to: "output", kind: "data" }]),
  ];
  return {
    planDigest: "b".repeat(64), budgets: { maxDurationMs: 60_000 }, execution: { maxConcurrency },
    graph: { nodes, edges, nodeOrder: ids },
  } as unknown as HarnessPlanV2;
}

async function run(target: HarnessPlanV2) {
  await executeV2WorkGraph({
    db: {} as never, run: { runId: "RUN-1", tenantId: "t1", attempt: 1, fencingEpoch: 1, input: {} } as never,
    plan: target, workerId: "w1", grantSecret: "secret", leaseSeconds: 30, env: {},
    workIds: new Map(target.graph.nodes.map((node) => [node.id, `work-${node.id}`])),
  });
}

beforeEach(() => {
  state.status.clear(); state.outputs.clear(); state.failures.clear();
  state.suspended = []; state.inFlight = 0; state.maxInFlight = 0; state.invoked = []; state.finished = null; state.humanRequested = [];
});

describe("durable dispatcher waves", () => {
  it("runs independent branches concurrently and joins on committed results", async () => {
    await run(plan("all"));
    expect(state.maxInFlight).toBe(3);
    expect(state.finished?.status).toBe("completed");
    expect(state.outputs.get("work-join")).toMatchObject({ saw: ["a", "b", "c", "input"] });
  });

  it("bounds concurrency by the plan", async () => {
    await run(plan("all", 2));
    expect(state.maxInFlight).toBe(2);
    expect(state.finished?.status).toBe("completed");
  });

  it("commits a branch failure as a rejected settlement when it only feeds an allSettled join", async () => {
    state.failures.set("b", "vendor.timeout");
    const target = plan("allSettled");
    expect(settlesIntoAllSettledJoin(target, "b")).toBe(true);
    await run(target);
    expect(state.outputs.get("work-b")).toEqual({ __workflowRejected: true, reason: { code: "vendor.timeout" } });
    expect(state.finished?.status).toBe("completed");
    expect(state.suspended).toEqual([]);
  });

  it("fails closed on a branch failure outside allSettled, after siblings settle", async () => {
    state.failures.set("b", "vendor.timeout");
    await run(plan("all"));
    expect(state.finished).toMatchObject({ status: "manual_review", terminalOutcome: "vendor.timeout" });
    expect(state.suspended).toEqual(["work-b"]);
    // Siblings already in flight committed their results instead of being abandoned.
    expect(state.status.get("work-a")).toBe("COMPLETED");
    expect(state.status.get("work-c")).toBe("COMPLETED");
    expect(state.invoked).not.toContain("join");
  });

  it("requests an approval only after everything before it has committed", async () => {
    await run(plan("all", 4, true));
    expect(state.humanRequested).toEqual(["work-approve"]);
    expect(state.status.get("work-join")).toBe("COMPLETED");
    expect(state.finished).toBeNull();
  });
});
