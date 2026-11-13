import { randomUUID } from "node:crypto";
import { MemorySaver } from "@langchain/langgraph";
import { Validator } from "@cfworker/json-schema";
import { lowerHarnessPlanV2 } from "@ehf/runtime-langgraph";
import { stableDigest, type CapabilityDefinition, type CapabilityResult, type DraftTestRequest, type DraftTestRun, type HarnessPlanV2 } from "@ehf/contracts";
import type { RuntimeContext } from "@ehf/runtime-core";
import type { AdapterResult } from "@ehf/adapters";
import type { FixtureCheckpoint, FixtureDebugger } from "./draft-test-debugger.js";

export function checkTestValue(schema: Record<string, unknown>, value: unknown, code: string): void {
  const result = new Validator(schema as never, "2020-12", false).validate(value);
  if (!result.valid) throw new Error(`${code}: ${result.errors.slice(0, 4).map(e => `${e.instanceLocation} ${e.error}`).join("; ")}`);
}

/** All IO stays in the test record. The shared graph engine retains routing and loop semantics. */
export async function executeDraftTest(input: {
  plan: HarnessPlanV2; request: DraftTestRequest; run: DraftTestRun; tenantId: string;
  save(run: DraftTestRun): Promise<void>;
  signal: AbortSignal;
  debugger?: FixtureDebugger;
  checkpoint?: FixtureCheckpoint;
  executionNodeId?: string;
  model(capability: CapabilityDefinition, value: unknown, signal: AbortSignal): Promise<AdapterResult>;
}): Promise<DraftTestRun> {
  const { plan, request, run, signal } = input;
  const debug = input.debugger;
  const checkpointer = new MemorySaver();
  const thread = { configurable: { thread_id: run.testRunId, checkpoint_ns: "" } };
  const nodeKinds = new Map(plan.graph.nodes.map(node => [node.id, node.kind]));
  const node = (id: string) => run.nodes.find(n => n.nodeId === id)!;
  const identity = { ...request.input, tenantId: input.tenantId, caseId: `draft-test:${run.testRunId}` };
  let callCount = 0, modelCount = 0, cost = 0;
  const now = () => new Date().toISOString();
  const persist = async () => { await input.save(structuredClone(run)); };
  const data = { ...request.context, case: { ...(request.context.case as Record<string, unknown> ?? {}), caseId: identity.caseId } };
  const canonical = {
    apiVersion: "harness.factory/case-snapshot-v1", kind: "CaseSnapshot", tenantId: input.tenantId,
    caseId: identity.caseId, caseSequence: 0, dependencyDigest: stableDigest(data), planDigest: plan.planDigest,
    policyAuthority: { policyId: plan.policyBundles[0]?.policyId ?? "draft-test", policyVersion: "1.0.0", policySnapshotDigest: stableDigest({ test: run.testRunId }), policyBundleDigest: plan.policyBundles[0]?.bundleDigest ?? stableDigest({ test: true }) },
    consistency: "strong", classification: "CONFIDENTIAL", data,
  };
  const snapshotDigest = stableDigest(canonical);
  const sampleTime = typeof request.context.asOfTime === "string" && Number.isFinite(Date.parse(request.context.asOfTime)) ? new Date(request.context.asOfTime).toISOString() : now();
  const snapshot = { ...canonical, snapshotId: `snapshot_${snapshotDigest}`, snapshotDigest, capturedAt: sampleTime };
  const context: RuntimeContext = {
    plan, runId: run.testRunId, runAttempt: 1, workerId: "draft-test", fencingEpoch: 1,
    // These endpoints are never used: every capability is intercepted, writes are suppressed.
    gatewayUrl: "", envelopeBrokerUrl: "", executionGrant: "", serviceToken: "",
    state: {
      nodeStarted: async (_fence, event) => { Object.assign(node(event.nodeId), { status: "running", startedAt: now() }); await persist(); },
      nodeFinished: async (_fence, event) => { Object.assign(node(event.nodeId), { status: event.status, error: event.errorCode ?? null, finishedAt: now() }); await persist(); },
      appendEvent: async (_fence, event) => {
        if (event.code === "approval.suspended" && event.nodeId) {
          Object.assign(node(event.nodeId), { status: "blocked", error: "Human approval requires a released run.", finishedAt: now() }); await persist();
        }
      },
      markCheckpoint: async () => {},
    },
    draftTest: {
      ...(debug ? { beforeNode: async (nodeId: string, nodeKind: string) => {
        debug.retain(nodeId, await checkpointer.getTuple(thread));
        await debug.visit({ nodeId, nodeKind, capabilityId: null }, signal, persist);
      } } : {}),
      suppressEffect: (nodeId, command, conditional) => {
        run.effects ??= [];
        if (run.effects.length < 128) run.effects.push({ nodeId, command, conditional });
      },
      failed: (id, error) => {
        const code = error instanceof Error ? error.message : "draft_test.node_failed";
        Object.assign(node(id), { status: code.includes("requires_live_run") ? "blocked" : "failed", error: code, finishedAt: now() });
      },
      observe: (id, value, output) => {
        node(id).input = value;
        if (output !== undefined) {
          const values = (output as { values?: Record<string, unknown> }).values;
          node(id).output = values && Object.hasOwn(values, id) ? values[id] : output;
        }
      },
      invoke: async (nodeId, capabilityId, value) => {
        signal.throwIfAborted();
        const capability = plan.capabilities.find(c => c.id === capabilityId);
        const permission = plan.permissionEnvelopes.find(p => p.nodeId === nodeId);
        if (!capability || !permission?.capabilities.includes(capabilityId)) throw new Error(`draft_test.capability_not_permitted:${capabilityId}`);
        checkTestValue(capability.inputSchema, value, `draft_test.input_invalid:${capabilityId}`);
        await debug?.visit({ nodeId, nodeKind: nodeKinds.get(nodeId) ?? "", capabilityId }, signal, persist);
        if (++callCount > Math.min(plan.budgets.maxCapabilityCalls, 100)) throw new Error("draft_test.capability_budget_exceeded");
        const started = performance.now();
        let output: unknown, provider = "sample-fixture", costUsd: number | null = 0;
        if (capability.kind === "model") {
          if (++modelCount > Math.min(plan.budgets.maxModelCalls, 20) || cost >= plan.budgets.maxCostUsd) throw new Error("draft_test.model_budget_exceeded");
          const result = await input.model(capability, value, signal);
          output = result.output; provider = result.provider; costUsd = result.costUsd;
          if (costUsd !== null) cost += costUsd;
          if (request.mode === "models" && provider === "recorded") throw new Error("draft_test.live_model_required");
        } else {
          if (!Object.hasOwn(request.capabilityOutputs, capabilityId)) throw new Error(`draft_test.tool_sample_required:${capabilityId}`);
          output = structuredClone(request.capabilityOutputs[capabilityId]);
        }
        // Loop model calls return the action protocol; runAgentLoop validates each action
        // and the final answer against the agent's output contract.
        const loopModel = capability.kind === "model" && plan.graph.nodes.find(n => n.id === nodeId)?.config.loop !== undefined;
        if (!loopModel) checkTestValue(capability.outputSchema, output, `draft_test.output_invalid:${capabilityId}`);
        const latencyMs = Math.round(performance.now() - started);
        run.calls.push({ nodeId, capabilityId, provider, costUsd, latencyMs });
        await persist();
        signal.throwIfAborted();
        return { invocationId: `test_${randomUUID()}`, capabilityId, status: "succeeded", output, errorCode: null,
          provider, model: null, providerRequestId: null, usage: { inputTokens: null, outputTokens: null, costUsd }, latencyMs, receiptDigest: stableDigest({ capabilityId, output }) } satisfies CapabilityResult;
      },
    },
  };
  try {
    const graph = lowerHarnessPlanV2(plan, context, {
      loadCaseSnapshot: async () => snapshot,
      // Policy results must never be invented by test fixtures.
      evaluateGate: async () => { throw new Error("draft_test.policy_gate_requires_live_run"); },
    }, checkpointer, input.executionNodeId);
    const checkpoint = input.checkpoint?.tuple;
    if (checkpoint && !input.executionNodeId) {
      const detached = { ...checkpoint.checkpoint, channel_values: { ...checkpoint.checkpoint.channel_values, input: identity } };
      await checkpointer.put(thread, detached, { ...checkpoint.metadata, source: "fork", parents: {} });
    }
    const values = (checkpoint?.checkpoint.channel_values.values ?? {}) as Record<string, unknown>;
    const settlements = (checkpoint?.checkpoint.channel_values.settlements ?? {}) as Record<string, unknown>;
    const result = await graph.invoke(checkpoint && !input.executionNodeId ? null : { input: identity, values, settlements }, {
      ...thread, maxConcurrency: debug ? 1 : Math.min(plan.execution.maxConcurrency, 4),
      recursionLimit: Math.min(plan.execution.maxTransitions, 500), signal,
    });
    run.output = result.output ?? null;
    run.status = Array.isArray(result.__interrupt__) && result.__interrupt__.length ? "blocked" : "completed";
  } catch (error) {
    run.error = signal.aborted ? (signal.reason instanceof Error ? signal.reason.message : "draft_test.cancelled") : error instanceof Error ? error.message : "draft_test.execution_failed";
    run.status = signal.aborted && signal.reason?.message === "draft_test.cancelled" ? "cancelled" : run.error.includes("requires_live_run") ? "blocked" : "failed";
    for (const step of run.nodes.filter(n => n.status === "running")) Object.assign(step, { status: "failed", error: run.error, finishedAt: now() });
  }
  for (const step of run.nodes.filter(n => n.status === "pending")) step.status = "skipped";
  if (run.status === "blocked" && !run.error) run.error = "Human approval requires a released run.";
  run.finishedAt = now();
  debug?.finish();
  await persist();
  return run;
}
