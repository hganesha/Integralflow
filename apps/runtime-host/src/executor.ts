import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import {
  runtimeInvocationAnyVersionSchema,
  type RuntimeInvocationResult,
  type RuntimeSettlement,
} from "@ehf/contracts";
import {
  lowerHarnessPlanV2,
  type V2ExecutionAdapters,
} from "@ehf/runtime-langgraph";
import { HttpRuntimeStateStore, type RuntimeStateStore, type WorkloadCredential } from "@ehf/runtime-state";

export type RuntimeExecutorDependencies = {
  /** Optional: absent when the deployment runs without a resumable checkpoint backend. */
  saver?: BaseCheckpointSaver;
  gatewayUrl: string;
  caseApiUrl?: string;
  controlPlaneUrl: string;
  serviceToken: WorkloadCredential;
  providerMetadata?: Record<string, string>;
  /** Authority-preserving adapters required by the v2 lowering. */
  v2Adapters?: V2ExecutionAdapters;
  /** Overridable so contract tests can drive a Postgres-backed store directly. */
  createStateStore?: (grant: string) => RuntimeStateStore;
};

export async function executeRuntimeInvocation(
  raw: unknown,
  dependencies: RuntimeExecutorDependencies,
  cancellation?: AbortSignal,
): Promise<RuntimeInvocationResult> {
  const request = runtimeInvocationAnyVersionSchema.parse(raw);
  const providerMetadata = {
    ...(dependencies.providerMetadata ?? { host: "local_http" }),
    contractVersion: request.contractVersion,
  };
  const remainingMs = new Date(request.deadlineAt).getTime() - Date.now();
  if (remainingMs <= 0) throw new Error("runtime.deadline_exceeded");
  const timeoutMs = Math.min(remainingMs, request.plan.budgets.maxDurationMs);
  const state = dependencies.createStateStore?.(request.executionGrant) ?? new HttpRuntimeStateStore({
    baseUrl: dependencies.controlPlaneUrl,
    serviceToken: dependencies.serviceToken,
    executionGrant: request.executionGrant,
  });
  const fenced = {
    runId: request.runId,
    attempt: request.attempt,
    workerId: request.workerId,
    fencingEpoch: request.fencingEpoch,
  };
  // Case-read envelopes handed back with each node's start; used once, and only while
  // comfortably inside their lifetime, otherwise the read asks for a fresh one.
  const caseReadEnvelopes = new Map<string, { envelope: string; expiresAt: number }>();
  const takeCaseReadEnvelope = (nodeId: string): string | undefined => {
    const issued = caseReadEnvelopes.get(nodeId);
    caseReadEnvelopes.delete(nodeId);
    return issued && issued.expiresAt - Date.now() > 10_000 ? issued.envelope : undefined;
  };
  const runtimeContext = {
    state,
    plan: request.plan,
    runId: request.runId,
    runAttempt: request.attempt,
    workerId: request.workerId,
    fencingEpoch: request.fencingEpoch,
    gatewayUrl: dependencies.gatewayUrl,
    ...(dependencies.caseApiUrl ? { caseApiUrl: dependencies.caseApiUrl } : {}),
    envelopeBrokerUrl: dependencies.controlPlaneUrl,
    executionGrant: request.executionGrant,
    serviceToken: dependencies.serviceToken,
    caseReadEnvelopes,
  };
  try {
    const checkpointScope=request.nodeExecution
      ? `${request.runId}:${request.nodeExecution.workItemId}:${request.attempt}:${request.nodeExecution.fencingEpoch}` : request.runId;
    const adapters = dependencies.v2Adapters ? { ...dependencies.v2Adapters,
      loadCaseSnapshot: (input: Parameters<NonNullable<RuntimeExecutorDependencies["v2Adapters"]>["loadCaseSnapshot"]>[0], signal?: AbortSignal) =>
        dependencies.v2Adapters!.loadCaseSnapshot((() => {
          const prefetched = takeCaseReadEnvelope(input.nodeId);
          return {
            ...input,
            execution: { ...fenced, grant: request.executionGrant, invocationId: request.invocationId },
            ...(prefetched ? { caseReadEnvelope: prefetched } : {}),
          };
        })(), signal),
      evaluateGate: (input: Parameters<NonNullable<RuntimeExecutorDependencies["v2Adapters"]>["evaluateGate"]>[0], signal?: AbortSignal) =>
        dependencies.v2Adapters!.evaluateGate({ ...input, execution: { ...fenced, grant: request.executionGrant } }, signal),
    } : undefined;
    if (!adapters) throw new Error("runtime.v2.adapters_missing");
    const compiled = lowerHarnessPlanV2(request.plan, runtimeContext, adapters, dependencies.saver, request.nodeExecution?.nodeId);
    // Predecessor settlements reach a node two ways, and both are honoured:
    // - runtime.invocation.v3 carries the settlements earlier node invocations reported
    //   (runtime.result.v2) as `predecessorSettlements`;
    // - the durable dispatcher commits a failed branch that feeds only allSettled joins as a
    //   `__workflowRejected` marker value (v2 and v3), which is a rejected settlement, not a value.
    const predecessors = request.nodeExecution?.predecessorValues ?? {};
    const values: Record<string, unknown> = {};
    const settlements: Record<string, RuntimeSettlement> = request.contractVersion === "runtime.invocation.v3"
      ? { ...(request.nodeExecution?.predecessorSettlements ?? {}) } : {};
    for (const [nodeId, value] of Object.entries(predecessors)) {
      const marker = value as { __workflowRejected?: unknown; reason?: { code?: unknown } } | null;
      if (marker && typeof marker === "object" && marker.__workflowRejected === true) {
        const code = typeof marker.reason?.code === "string" ? marker.reason.code : "runtime.node_failed";
        settlements[nodeId] = { status: "rejected", reason: { code, message: code } };
      } else values[nodeId] = value;
    }
    const output = await compiled.invoke({ input: request.input, values, ...(Object.keys(settlements).length ? { settlements } : {}) }, {
      configurable: { thread_id: checkpointScope, checkpoint_ns: request.planDigest },
      recursionLimit: request.plan.execution.maxTransitions,
      maxConcurrency: request.plan.execution.maxConcurrency,
      // The deadline and an explicit cancellation both stop the graph; whichever
      // arrives first wins.
      signal: cancellation
        ? AbortSignal.any([AbortSignal.timeout(timeoutMs), cancellation])
        : AbortSignal.timeout(timeoutMs),
    });
    const checkpoint = await dependencies.saver?.getTuple({
      configurable: { thread_id: checkpointScope, checkpoint_ns: request.planDigest },
    });
    const checkpointId = checkpoint?.checkpoint.id ?? null;
    await state.markCheckpoint(fenced, { checkpointId, nodeId: null });
    const interrupts = output && typeof output === "object"
      ? (output as Record<string, unknown>).__interrupt__
      : undefined;
    if (Array.isArray(interrupts) && interrupts.length > 0) {
      return {
        contractVersion: "runtime.result.v1",
        invocationId: request.invocationId,
        runId: request.runId,
        status: "failed",
        output: null,
        errorCode: "runtime.approval_suspended",
        checkpointId,
        providerMetadata,
      };
    }
    return {
      contractVersion: "runtime.result.v2",
      invocationId: request.invocationId,
      runId: request.runId,
      status: "completed",
      output: request.nodeExecution
        ? output.values?.[request.nodeExecution.nodeId] ?? null : output.output ?? output.values,
      errorCode: null,
      checkpointId,
      providerMetadata,
      settlements:output.settlements??{},
    };
  } catch (error) {
    const errorCode = cancellation?.aborted
      ? "runtime.cancelled"
      : error instanceof Error ? error.message : "runtime.unhandled";
    return {
      contractVersion: "runtime.result.v1",
      invocationId: request.invocationId,
      runId: request.runId,
      status: errorCode.includes("denied") ? "denied" : "failed",
      output: null,
      errorCode,
      checkpointId: null,
      providerMetadata,
    };
  }
}
