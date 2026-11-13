import { businessDecisionSchema, type BusinessDecision, stableDigest, runtimeInvocationResultSchema, type HarnessPlanV2, type CaseActor, type RuntimeInvocationV3 } from "@ehf/contracts";
import { bridgeOutcomeSchema, classifyOutcome } from "@ehf/fincrime-integration";
import { mintRuntimeGrant, type JwtSigner } from "@ehf/execution-auth";
import { evaluateCondition, v2ExecutionEdges } from "@ehf/runtime-core";
import { createRuntimeProvider } from "@ehf/runtime-provider";
import {
  acquireExecutionWorkItemLease, completeExecutionWorkItem, completeRun, getExecutionOutput,
  getExecutionWorkItem, publishPostgresExecutionDispatch, reconcileExecutionWorkItems,
  renewExecutionWorkItemLease, renewLease, requestHumanExecutionDecision, requireExecutableRelease, resolveSettingSection,
  scheduleExecutionWork, startExecutionWorkItem, suspendExecutionWorkItem, cancellationRequested,
  type ClaimedRun, type Database,
  retainExecutionOutcome, latestExecutionOutcome,
} from "@ehf/persistence";

type Settlement = { status: "fulfilled"; value: unknown } | { status: "rejected"; reason: { code: string; message: string } };

/** Select branches from committed predecessor results, never from a caller's run payload. */
export function nodeIsReachable(plan: HarnessPlanV2, nodeId: string, values: Record<string, unknown>): boolean {
  const incoming = v2ExecutionEdges(plan).filter((edge) => edge.to === nodeId);
  if (!incoming.length) return true;
  return incoming.some((edge) => {
    const value = values[edge.from] as Record<string, unknown> | undefined;
    if (value?.__workflowSkipped === true) return false;
    if (edge.outcome !== undefined) {
      const source=plan.graph.nodes.find(n=>n.id===edge.from);
      if(source?.config.businessDecision==="v2") return (value?.result as {state?:string}|undefined)?.state===edge.outcome;
      return value?.outcome === edge.outcome || value?.decision === edge.outcome;
    }
    // A routed condition reads committed node outputs only (`<node>.<path> == <value>`, as the
    // LangGraph lowering evaluates it); a condition on anything else is not a durable branch.
    if (edge.condition?.trim()) {
      const path = edge.condition.trim().split(/\s*(?:==|!=)\s*/)[0] ?? "";
      const head = path.split(".")[0] ?? "";
      if (!/^[\w./$-]+$/.test(path) || !plan.graph.nodes.some((node) => node.id === head)) throw new Error("runtime.v2.durable_condition_requires_outcome");
      return evaluateCondition(edge.condition, values);
    }
    return true;
  });
}

export function executionOrder(plan: HarnessPlanV2): string[] {
  const edges = v2ExecutionEdges(plan);
  const pending = new Set(plan.graph.nodeOrder);
  const ordered: string[] = [];
  while (pending.size) {
    const ready = [...pending].filter((id) => edges.filter((edge) => edge.to === id).every((edge) => ordered.includes(edge.from)));
    if (!ready.length) throw new Error("runtime.v2.graph_not_acyclic");
    for (const id of ready) { ordered.push(id); pending.delete(id); }
  }
  return ordered;
}

/** A node whose every outgoing execution edge enters an allSettled join. */
export function settlesIntoAllSettledJoin(plan: HarnessPlanV2, nodeId: string): boolean {
  const outgoing = v2ExecutionEdges(plan).filter((edge) => edge.from === nodeId);
  return outgoing.length > 0 && outgoing.every((edge) => {
    const target = plan.graph.nodes.find((node) => node.id === edge.to);
    return target?.kind === "join" && String(target.config.mode ?? target.config.join ?? target.config.operation ?? "all") === "allSettled";
  });
}

export async function executeV2WorkGraph(options: {
  db: Database; run: ClaimedRun; plan: HarnessPlanV2; workerId: string; grantSecret?: string; grantSigner?: JwtSigner;
  workIds: Map<string, string>; leaseSeconds: number; env: NodeJS.ProcessEnv;
}): Promise<void> {
  const { db, run, plan, workerId, grantSecret, grantSigner, workIds, leaseSeconds, env } = options;
  const actor: CaseActor = { type: "SYSTEM", principalId: workerId, roles: ["workflow.executor"] };
  const values: Record<string, unknown> = {};
  // allSettled outcomes reported by the runtime (runtime.result.v2), handed to later nodes as
  // runtime.invocation.v3 `predecessorSettlements`. Failures the worker itself settles are
  // committed as `__workflowRejected` markers in `values` instead; the host decodes both.
  const settlements: Record<string, Settlement> = {};
  const controller = new AbortController();
  const deadline = Date.now() + plan.budgets.maxDurationMs;
  type Lease = { workItemId: string; executionId: string; fencingEpoch: number };
  // Every node currently holding a work-item lease; the heartbeat renews all of them.
  const active = new Map<string, Lease>();
  const heartbeat = setInterval(() => {
    void (async () => {
      if (!await renewLease(db, run.runId, workerId, run.fencingEpoch, leaseSeconds)) throw new Error("runtime.lease_lost");
      if (await cancellationRequested(db, run.runId)) throw new Error("runtime.cancelled");
      for (const lease of active.values()) {
        if (!await renewExecutionWorkItemLease(db, { tenantId: run.tenantId, ...lease, leaseSeconds })) throw new Error("workflow.lease_lost");
      }
      await requireExecutableRelease(db, run.tenantId, plan.planDigest, env.RELEASE_ENVIRONMENT ?? "development");
    })().catch((error: unknown) => controller.abort(error));
  }, Math.max(1_000, Math.min(10_000, leaseSeconds * 400)));

  type Fence = Lease & { tenantId: string; actor: CaseActor };
  type NodeOutcome =
    | { kind: "completed"; output: unknown }
    // A human decision this node needs; requested once the whole wave has settled.
    | { kind: "human_request"; nodeId: string; fence: Fence; policyDecision?: BusinessDecision }
    // An existing work item already waiting on a human.
    | { kind: "human_required"; workItemId: string }
    // The node's financial-crime outcome cannot complete; its work item is suspended.
    | { kind: "paused"; reason: string };

  /** Lease, execute and commit one node. Throws only after releasing or settling its work item. */
  const runNode = async (
    nodeId: string,
    committed: Readonly<Record<string, unknown>>,
    committedSettlements: Readonly<Record<string, Settlement>>,
  ): Promise<NodeOutcome> => {
    await requireExecutableRelease(db, run.tenantId, plan.planDigest, env.RELEASE_ENVIRONMENT ?? "development");
    const node = plan.graph.nodes.find((item) => item.id === nodeId)!;
    const workItemId = workIds.get(nodeId)!;
    let work = await getExecutionWorkItem(db, run.tenantId, workItemId);
    if (!work) throw new Error("workflow.work_item_not_found");
    if (work.status === "COMPLETED") {
      const observed = runtimeInvocationResultSchema.safeParse(await latestExecutionOutcome(db, run.tenantId, workItemId));
      if (observed.success && observed.data.contractVersion === "runtime.result.v2") Object.assign(settlements, observed.data.settlements);
      return { kind: "completed", output: await getExecutionOutput(db, run.tenantId, workItemId) };
    }
    if (work.status === "HUMAN_REQUIRED" || work.status === "WAITING_HUMAN") return { kind: "human_required", workItemId };
    // Reconciliation and scheduling are shared, and both skip rows another pass holds. A parallel
    // branch's pass can therefore leave this item not yet released, or advance its dispatch
    // generation between the read and the lease. Both are stale reads, not refusals: go round again.
    let acquired: Awaited<ReturnType<typeof acquireExecutionWorkItemLease>> | undefined;
    const passes = 6;
    for (let pass = 0; pass < passes; pass += 1) {
      await reconcileExecutionWorkItems(db);
      await scheduleExecutionWork(db);
      work = (await getExecutionWorkItem(db, run.tenantId, workItemId))!;
      if (work.status !== "READY") {
        if (pass < passes - 1 && (work.status === "PROPOSED" || work.status === "BLOCKED")) {
          await new Promise((resolve) => setTimeout(resolve, 100 * (pass + 1)));
          continue;
        }
        throw new Error(`workflow.node_not_ready:${work.status}`);
      }
      await publishPostgresExecutionDispatch(db, { tenantId: run.tenantId, caseId: work.caseId,
        workItemId, generation: work.dispatch.generation, queue: work.dispatch.queue,
        messageId: `${run.tenantId}:${workItemId}:${work.dispatch.generation}` });
      acquired = await acquireExecutionWorkItemLease(db, { tenantId: run.tenantId, workItemId,
        generation: work.dispatch.generation, owner: workerId, leaseSeconds, actor });
      if (acquired.outcome !== "stale_generation") break;
    }
    if (acquired?.outcome !== "acquired" || !acquired.workItem?.lease) throw new Error("workflow.node_lease_unavailable");
    const lease = acquired.workItem.lease;
    const held: Lease = { workItemId, executionId: lease.executionId, fencingEpoch: lease.fencingEpoch };
    active.set(nodeId, held);
    const fence: Fence = { tenantId: run.tenantId, ...held, actor };
    try {
      await startExecutionWorkItem(db, fence);
      let output: unknown;
      if (!nodeIsReachable(plan, nodeId, committed)) {
        output = { __workflowSkipped: true };
      } else if (node.kind === "approval") {
        return { kind: "human_request", nodeId, fence };
      } else {
        // Each node is resolved independently through the runtime adapter registry, so one
        // plan can run nodes on different runtimes (local, hosted HTTP, Databricks, ...). The
        // plan's target wins; administered settings supply the default and named bindings,
        // re-read per node so repointing a binding reaches the next node, not the next deploy.
        const target = typeof node.config.runtimeTarget === "string" ? node.config.runtimeTarget : undefined;
        const runtimeSettings = (await resolveSettingSection(db, run.tenantId, "runtime", env)).value;
        const provider = createRuntimeProvider(target, { env, settings: runtimeSettings });
        const invocationId = `INV-${stableDigest({ workItemId, executionId: lease.executionId }).slice(0, 32)}`;
        const executionGrant = await mintRuntimeGrant({ ...(grantSigner ? { signer: grantSigner } : { secret: grantSecret! }), grantId: invocationId,
          runId: run.runId, attempt: run.attempt, workerId, planDigest: plan.planDigest, fencingEpoch: run.fencingEpoch,
          nodeId, workItemId, workFencingEpoch: lease.fencingEpoch,
          ttlSeconds: Math.ceil(plan.budgets.maxDurationMs / 1000) + 30 });
        const invocation: RuntimeInvocationV3 = {
          contractVersion: "runtime.invocation.v3", invocationId, runId: run.runId, attempt: run.attempt,
          workerId, leaseId: lease.executionId, fencingEpoch: run.fencingEpoch,
          deadlineAt: new Date(deadline).toISOString(),
          planDigest: plan.planDigest, executionProfileDigest: provider.executionProfileDigest, executionGrant, plan,
          input: run.input, nodeExecution: { nodeId, workItemId, fencingEpoch: lease.fencingEpoch, predecessorValues: { ...committed },
            predecessorSettlements: { ...committedSettlements } },
        };
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error("runtime.deadline_exceeded");
        const result = await provider.invoke(invocation, AbortSignal.any([controller.signal, AbortSignal.timeout(remaining)]));
        await retainExecutionOutcome(db, { ...fence, outcome: result });
        if (result.contractVersion === "runtime.result.v2") Object.assign(settlements, result.settlements);
        if (result.status !== "completed") throw new Error(result.errorCode ?? "runtime.node_failed");
        const own = result.contractVersion === "runtime.result.v2" ? result.settlements[nodeId] : undefined;
        if (own?.status === "rejected") {
          // The runtime settled this node's failure for an allSettled join: commit it durably
          // as the same rejected marker the worker writes for failures it settles itself.
          const rejected = { __workflowRejected: true, reason: { code: own.reason.code } };
          await completeExecutionWorkItem(db, { ...fence, output: rejected, result: { agentResultRef: `sha256:${stableDigest(rejected)}`,
            acceptedCommandRefs: [], outputRefs: [], failureCode: own.reason.code, failureDetailRef: null } });
          active.delete(nodeId);
          return { kind: "completed", output: rejected };
        }
        output = result.output;
        if(node.kind==="gate" && node.config.businessDecision==="v2") {
          const decision=businessDecisionSchema.parse(output);
          if(decision.result.state==="NEEDS_HUMAN") return {kind:"human_request",nodeId,fence,policyDecision:decision};
        }
        if (node.config.fincrimeTaskId) {
          const outcome = bridgeOutcomeSchema.parse(output);
          const classification = classifyOutcome(outcome);
          if (classification === "human") return { kind: "human_request", nodeId, fence };
          if (classification !== "complete") {
            const reason = `fincrime.${outcome.status.toLowerCase()}`;
            await suspendExecutionWorkItem(db, { tenantId: run.tenantId, workItemId, reasonCode: reason, actor });
            active.delete(nodeId);
            return { kind: "paused", reason };
          }
        }
      }
      controller.signal.throwIfAborted();
      await requireExecutableRelease(db, run.tenantId, plan.planDigest, env.RELEASE_ENVIRONMENT ?? "development");
      await completeExecutionWorkItem(db, { ...fence, output, result: { agentResultRef: `sha256:${stableDigest(output)}`,
        acceptedCommandRefs: [], outputRefs: [], failureCode: null, failureDetailRef: null } });
      active.delete(nodeId);
      return { kind: "completed", output };
    } catch (error) {
      const code = error instanceof Error ? error.message : "runtime.v2.failed";
      // A failure that only feeds allSettled joins is the declared, expected shape of the
      // workflow: commit it as a rejected settlement so the join (and the gates after it)
      // see the failure instead of the run aborting. Cancellation and lost authority are
      // never settled this way.
      if (settlesIntoAllSettledJoin(plan, nodeId) && !controller.signal.aborted) {
        const rejected = { __workflowRejected: true, reason: { code } };
        await completeExecutionWorkItem(db, { ...fence, output: rejected, result: { agentResultRef: `sha256:${stableDigest(rejected)}`,
          acceptedCommandRefs: [], outputRefs: [], failureCode: code, failureDetailRef: null } });
        active.delete(nodeId);
        return { kind: "completed", output: rejected };
      }
      await suspendExecutionWorkItem(db, { tenantId: run.tenantId, workItemId, reasonCode: code, actor }).catch(() => undefined);
      active.delete(nodeId);
      throw error;
    }
  };

  try {
    const order = executionOrder(plan);
    const edges = v2ExecutionEdges(plan);
    const predecessors = new Map(order.map((id) => [id, edges.filter((edge) => edge.to === id).map((edge) => edge.from)]));
    const maxConcurrency = Math.max(1, plan.execution.maxConcurrency);
    const done = new Set<string>();
    while (done.size < order.length) {
      controller.signal.throwIfAborted();
      const ready = order.filter((id) => !done.has(id) && predecessors.get(id)!.every((from) => done.has(from)));
      if (!ready.length) throw new Error("runtime.v2.graph_stalled");
      // Approvals suspend the run, so they go last: siblings that are already ready run
      // (and commit) first, then the approval is requested on its own.
      const work = ready.filter((id) => plan.graph.nodes.find((node) => node.id === id)?.kind !== "approval");
      const wave = (work.length ? work : ready).slice(0, work.length ? maxConcurrency : 1);
      const committed = Object.freeze({ ...values });
      const committedSettlements = Object.freeze({ ...settlements });
      // Drain the whole wave before acting on any outcome: no detached node may commit
      // after the run is suspended or finalized.
      const settled = await Promise.allSettled(wave.map((id) => runNode(id, committed, committedSettlements)));
      let failure: unknown = null;
      let humanRequired: string | null = null;
      let pausedReason: string | null = null;
      const humanRequests: Array<{ nodeId: string; fence: Fence; policyDecision?: BusinessDecision }> = [];
      settled.forEach((outcome, index) => {
        const nodeId = wave[index]!;
        if (outcome.status === "rejected") { failure ??= outcome.reason; return; }
        if (outcome.value.kind === "completed") { values[nodeId] = outcome.value.output; done.add(nodeId); }
        else if (outcome.value.kind === "human_request") humanRequests.push(outcome.value);
        else if (outcome.value.kind === "paused") pausedReason ??= outcome.value.reason;
        else humanRequired ??= outcome.value.workItemId;
      });
      if (failure) throw failure;
      if (humanRequests.length) {
        // The first request suspends the parent run; the rest only park their work items.
        for (const [index, request] of humanRequests.entries()) {
          await requestHumanExecutionDecision(db, { ...request.fence,
            ...(request.policyDecision ? {policyDecision:request.policyDecision} : {}),
            ...(index === 0 ? { parent: { runId: run.runId, workerId, fencingEpoch: run.fencingEpoch } } : {}) });
          active.delete(request.nodeId);
        }
        return;
      }
      if (pausedReason) { await finish("manual_review", pausedReason, { reason: pausedReason }); return; }
      if (humanRequired) { await finish("manual_review", "workflow.human_decision_required", { workItemId: humanRequired }); return; }
    }
    const outputs = plan.graph.nodes.filter((node) => node.kind === "output")
      .map((node) => values[node.id]).filter((value) => !(value as Record<string, unknown> | null)?.__workflowSkipped);
    if (!outputs.length) {
      const stoppedAt = plan.graph.nodes.find((node) => {
        const value = values[node.id] as Record<string, unknown> | undefined;
        return node.kind === "gate" && typeof value?.outcome === "string"
          && !v2ExecutionEdges(plan).some((edge) => edge.from === node.id && edge.outcome === value.outcome);
      });
      const outcome = stoppedAt ? String((values[stoppedAt.id] as Record<string, unknown>).outcome) : "NO_TERMINAL_OUTPUT";
      await finish("manual_review", "workflow.fail_closed_no_terminal_output", { stoppedAt: stoppedAt?.id ?? null, outcome });
      return;
    }
    await finish("completed", "completed", outputs.length === 1 ? outputs[0] : outputs);
  } catch (error) {
    const code = error instanceof Error ? error.message : "runtime.v2.failed";
    controller.abort(error);
    // Nodes still holding a lease (e.g. awaiting a human request that never went out) are
    // released so the work item does not sit leased until expiry.
    for (const lease of active.values()) {
      await suspendExecutionWorkItem(db, { tenantId: run.tenantId, workItemId: lease.workItemId, reasonCode: code, actor }).catch(() => undefined);
    }
    active.clear();
    await finish("manual_review", code, { error: code });
  } finally { clearInterval(heartbeat); }

  async function finish(status: "completed" | "manual_review", reason: string, output: unknown) {
    await completeRun(db, { runId: run.runId, workerId, fencingEpoch: run.fencingEpoch, status,
      terminalOutcome: reason, output, ...(status === "manual_review" ? { errorCode: reason } : {}) });
  }
}
