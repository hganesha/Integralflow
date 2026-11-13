import { recordWorkerHeartbeat } from "@ehf/persistence";
import { hostname } from "node:os";
import { executeV2WorkGraph } from "./v2-execution.js";
import { createServer } from "node:http";
import { PLAN_V1_REMOVED, stableDigest, type HarnessPlanV2 } from "@ehf/contracts";
import {
  appendEvent,
  bindRunTrace,
  claimExecutionDispatches,
  claimRun,
  completeRun,
  createDatabase,
  createExecutionWorkItems,
  createRunQueueListener,
  failExhaustedRuns,
  finalizeAbandonedCancellations,
  getExecutionWorkQueueStats,
  getPlan,
  getRunQueueStats,
  reconcileExecutionWorkItems,
  publishPostgresExecutionDispatch,
  scheduleExecutionWork,
  type ClaimedRun,
} from "@ehf/persistence";
import { v2ExecutionPredecessors } from "@ehf/runtime-core";
import { assertPlatformInvariants, createPrivateKeyJwtSignerFromEnv, envelopeSigner, MECHANISM_REQUIREMENTS } from "@ehf/identity";
import {
  SpanKind,
  SpanStatusCode,
  contextFromTraceReference,
  initializeTelemetry,
  traceReference,
  withSpan,
} from "@ehf/telemetry";

const telemetry = initializeTelemetry({ serviceName: "harness-runtime-dispatcher" });

assertPlatformInvariants({
  mechanisms: ["WORKLOAD_AUTH", "ENVELOPE_SIGNER", "DATABASE_AUTH", "TELEMETRY_EXPORTER"],
  forbidden: ["RUNTIME_GRANT_SECRET", "RUNTIME_HOST_AUTH_TOKEN"],
  requiredFor: {
    "WORKLOAD_AUTH=workload_identity": MECHANISM_REQUIREMENTS["WORKLOAD_AUTH=workload_identity"],
    "ENVELOPE_SIGNER=private_key": ["RUNTIME_GRANT_PRIVATE_KEY_FILE", "RUNTIME_GRANT_KEY_ID"],
  },
});

function requiredEnv(name: string, error: string): string {
  const value = process.env[name];
  if (!value) throw new Error(error);
  return value;
}

// The dispatcher owns the lease and the fence, so it is the only component that may
// issue authority for an invocation. The runtime receives a grant, never a signing key.
const keySigner = envelopeSigner() === "private_key";
const grantSecret = keySigner ? undefined : requiredEnv("RUNTIME_GRANT_SECRET", "runtime.grant_secret_missing");
const grantSigner = keySigner ? createPrivateKeyJwtSignerFromEnv("RUNTIME_GRANT") : undefined;
const db = createDatabase();
const workerId = process.env.WORKER_ID ?? `${hostname()}:${process.pid}`;
const workerConcurrency = Number(process.env.WORKER_CONCURRENCY ?? 1);
const leaseSeconds = Number(process.env.WORKER_LEASE_SECONDS ?? 60);
const pollMs = Number(process.env.WORKER_POLL_MS ?? 750);
const metricsPort = Number(process.env.WORKER_METRICS_PORT ?? process.env.PORT ?? 9090);
const inFlight = new Set<string>();
let claimedTotal = 0;
let failedIterationsTotal = 0;

/**
 * The run's admitted plan. A run queued against a removed v1 plan can never execute: it
 * is failed terminally here (null) instead of letting every attempt fail on the same plan.
 */
async function executablePlan(run: ClaimedRun, slotWorkerId: string): Promise<HarnessPlanV2 | null> {
  let plan: HarnessPlanV2 | null;
  try {
    plan = await getPlan(db, run.planDigest);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith(PLAN_V1_REMOVED)) throw error;
    await completeRun(db, {
      runId: run.runId, workerId: slotWorkerId, fencingEpoch: run.fencingEpoch,
      status: "failed", terminalOutcome: "failed", output: { error: PLAN_V1_REMOVED }, errorCode: PLAN_V1_REMOVED,
    });
    await appendEvent(db, {
      runId: run.runId, eventKey: `run:${run.attempt}:failed`, code: "run.failed", nodeId: null,
      status: "failed", values: { errorCode: PLAN_V1_REMOVED },
    });
    return null;
  }
  if (!plan) throw new Error("runtime.plan_missing");
  return plan;
}

async function workOnce(slotWorkerId: string): Promise<boolean> {
  const run = await claimRun(db, slotWorkerId, leaseSeconds);
  if (!run) return false;
  inFlight.add(run.runId);
  claimedTotal += 1;
  try {
  const claimedRun = run;
  const plan = await executablePlan(run, slotWorkerId);
  if (!plan) return true;
  // Executes under durable per-node leases and resumes committed predecessors.
  const parent = contextFromTraceReference(run.traceId && run.rootSpanId ? {
    traceId: run.traceId,
    spanId: run.rootSpanId,
    traceFlags: run.traceFlags ?? 0,
  } : null);
  return withSpan("harness.run", {
    kind: SpanKind.CONSUMER,
    attributes: {
      "harness.execution.id": run.runId,
      "harness.execution.attempt": run.attempt,
      "harness.plan.digest_prefix": run.planDigest.slice(0, 12),
      "harness.domain": plan.metadata.domain,
      "harness.engine": plan.execution.engine.kind,
      "harness.engine.adapter_version": plan.execution.engine.adapterVersion,
      "harness.fencing.epoch": run.fencingEpoch,
      "harness.runtime.provider": "durable-node-dispatch",
    },
  }, async (span) => {
    const root = traceReference(span);
    await bindRunTrace(db, {
      runId: run.runId,
      attempt: run.attempt,
      workerId: slotWorkerId,
      fencingEpoch: run.fencingEpoch,
      traceId: root.traceId,
      spanId: root.spanId,
      traceFlags: root.traceFlags,
      serviceName: "harness-runtime-dispatcher",
    });
    await appendEvent(db, {
      runId: run.runId,
      eventKey: `run:${run.attempt}:started`,
      code: "run.started",
      nodeId: null,
      status: "observed",
      values: { workerId: slotWorkerId, fencingEpoch: run.fencingEpoch, traceId: root.traceId },
    });
    await materializeV2ExecutionWork({
      ...claimedRun,
      traceId: root.traceId,
      rootSpanId: root.spanId,
      traceFlags: root.traceFlags,
    }, plan, slotWorkerId);
    span.setStatus({ code: SpanStatusCode.OK });
    return true;
  }, parent);
  } finally {
    inFlight.delete(run.runId);
  }
}

function inputRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

async function materializeV2ExecutionWork(run: ClaimedRun, plan: HarnessPlanV2, slotWorkerId: string): Promise<void> {
  const input = inputRecord(run.input);
  const caseId = typeof input.caseId === "string" && input.caseId.length > 0 ? input.caseId : run.runId;
  const caseSequenceBasis = typeof input.caseSequenceBasis === "number" && Number.isInteger(input.caseSequenceBasis)
    && input.caseSequenceBasis >= 0 ? input.caseSequenceBasis : 0;
  const policyContextRef = typeof input.policyContextRef === "string" && input.policyContextRef.length > 0
    ? input.policyContextRef : `plan:${plan.planDigest}`;
  const createdBy = { type: "SYSTEM" as const, principalId: "runtime-worker", roles: ["workflow.materializer"] };
  const nodeWorkIds = new Map(plan.graph.nodes.map((node) => [
    node.id,
    `WI-${stableDigest({ tenantId: run.tenantId, caseId, runId: run.runId, nodeId: node.id }).slice(0, 40)}`,
  ]));
  const workItems = plan.graph.nodes.map((node) => {
    const dependencies = v2ExecutionPredecessors(plan, node.id)
      .map((dependencyId) => nodeWorkIds.get(dependencyId))
      .filter((id): id is string => Boolean(id));
    const capability = typeof node.config.capabilityId === "string" ? node.config.capabilityId : null;
    const queue = typeof node.config.queue === "string" ? node.config.queue : `work.ready.${node.kind}`;
    const requiredOutputs = Array.isArray(node.config.requiredOutputs)
      ? node.config.requiredOutputs.filter((value): value is string => typeof value === "string" && value.length > 0)
      : [];
    return {
      apiVersion: "harness.factory/execution-work-item-v1" as const,
      kind: "ExecutionWorkItem" as const,
      tenantId: run.tenantId,
      caseId,
      workItemId: nodeWorkIds.get(node.id)!,
      workType: node.kind,
      capabilityId: capability,
      assuranceClass: typeof node.config.assuranceClass === "string" ? node.config.assuranceClass : "STANDARD",
      revision: 0,
      caseSequenceBasis,
      planDigest: plan.planDigest,
      policyContextRef,
      schemaVersion: "execution-work-item-v1",
      objective: node.name,
      subjectRefs: [],
      requiredOutputs,
      constraints: { runId: run.runId, nodeId: node.id, dualControlRequired: node.config.dualControlRequired === true },
      dependencyIds: dependencies,
      dependencyDigest: stableDigest(dependencies),
      invalidationPolicy: "BLOCK" as const,
      status: "PROPOSED" as const,
      reasonCode: "workflow.materialized",
      priority: typeof node.config.priority === "number" && Number.isInteger(node.config.priority) ? node.config.priority : 0,
      readyAt: null,
      deadlineAt: null,
      terminalAt: null,
      dispatch: { generation: 0, queue, publishedAt: null, brokerMessageId: null },
      lease: null,
      limits: {
        maxAttempts: typeof node.config.maxAttempts === "number" && Number.isInteger(node.config.maxAttempts)
          && node.config.maxAttempts > 0 ? node.config.maxAttempts : 3,
        maxReworkCycles: 2,
        maxDurationMs: plan.budgets.maxDurationMs,
        maxCostUsd: plan.budgets.maxCostUsd,
        maxModelCalls: plan.budgets.maxModelCalls,
        maxCapabilityCalls: plan.budgets.maxCapabilityCalls,
      },
      result: null,
      createdBy,
      transitionSequence: 0,
      traceId: run.traceId,
      createdAt: run.createdAt,
      updatedAt: run.createdAt,
    };
  });
  await createExecutionWorkItems(db, workItems);
  await executeV2WorkGraph({ db, run, plan, workerId: slotWorkerId,
    ...(grantSigner ? { grantSigner } : { grantSecret: grantSecret! }),
    workIds: nodeWorkIds, leaseSeconds, env: process.env });
}

if (!Number.isInteger(workerConcurrency) || workerConcurrency < 1 || workerConcurrency > 64) {
  throw new Error("runtime.worker_concurrency_invalid");
}
if (!Number.isInteger(metricsPort) || metricsPort < 1 || metricsPort > 65_535) {
  throw new Error("runtime.worker_metrics_port_invalid");
}
if (!Number.isFinite(pollMs) || pollMs < 25 || pollMs > 60_000) {
  throw new Error("runtime.worker_poll_interval_invalid");
}

let lastSuccessAt:Date|null=null;
const heartbeat=setInterval(()=>{void recordWorkerHeartbeat(db,{id:workerId,kind:"runtime-worker",concurrency:workerConcurrency,inFlight:inFlight.size,lastSuccessAt,state:stopping?"draining":"ready"}).catch(()=>undefined);},5_000);
heartbeat.unref();
let stopping = false;
process.on("SIGTERM", () => { stopping = true; });
process.on("SIGINT", () => { stopping = true; });

// Behind a transaction-mode pooler DATABASE_URL points at the pooler and LISTEN would
// silently never fire; DATABASE_LISTEN_URL then names the direct server port.
const listenDb = process.env.DATABASE_LISTEN_URL ? createDatabase(process.env.DATABASE_LISTEN_URL, { max: 1 }) : db;
const queueListener = await createRunQueueListener(listenDb).catch((error: unknown) => {
  process.stderr.write(`dispatcher.listen_unavailable ${error instanceof Error ? error.message : "unknown"}\n`);
  return null;
});

const metricsServer = createServer(async (request, response) => {
  if (request.url === "/health/live") {
    response.writeHead(200, { "content-type": "application/json" }).end('{"status":"ok"}');
    return;
  }
  if (request.url !== "/health/ready" && request.url !== "/metrics") {
    response.writeHead(404).end();
    return;
  }
  try {
    const queue = await getRunQueueStats(db);
    const executionWork = await getExecutionWorkQueueStats(db);
    if (request.url === "/health/ready") {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
        status: "ready", concurrency: workerConcurrency, inFlight: inFlight.size, queue, executionWork,
      }));
      return;
    }
    const lines = [
      "# TYPE ehf_runtime_worker_concurrency gauge",
      `ehf_runtime_worker_concurrency ${workerConcurrency}`,
      "# TYPE ehf_runtime_worker_in_flight gauge",
      `ehf_runtime_worker_in_flight ${inFlight.size}`,
      "# TYPE ehf_runtime_queue_ready gauge",
      `ehf_runtime_queue_ready ${queue.ready}`,
      "# TYPE ehf_runtime_queue_delayed gauge",
      `ehf_runtime_queue_delayed ${queue.delayed}`,
      "# TYPE ehf_runtime_queue_oldest_ready_seconds gauge",
      `ehf_runtime_queue_oldest_ready_seconds ${queue.oldestReadySeconds}`,
      "# TYPE ehf_execution_work_ready gauge",
      `ehf_execution_work_ready ${executionWork.ready}`,
      "# TYPE ehf_execution_work_reconciliation_open gauge",
      `ehf_execution_work_reconciliation_open ${executionWork.reconciliationOpen}`,
      "# TYPE ehf_runtime_worker_claimed_total counter",
      `ehf_runtime_worker_claimed_total ${claimedTotal}`,
      "# TYPE ehf_runtime_worker_iteration_failures_total counter",
      `ehf_runtime_worker_iteration_failures_total ${failedIterationsTotal}`,
      "",
    ];
    response.writeHead(200, { "content-type": "text/plain; version=0.0.4" }).end(lines.join("\n"));
  } catch {
    response.writeHead(503, { "content-type": "application/json" }).end('{"status":"unavailable"}');
  }
});
metricsServer.listen(metricsPort, "0.0.0.0");

// A throw here used to reject at the top level and take the process with it, so one
// unadmitted plan or one transport error turned into a container restart loop. The loop
// absorbs failures; the claimed run is released by lease expiry and retried under the
// normal attempt budget.
async function runSlot(slot: number): Promise<void> {
  const slotWorkerId = `${workerId}:${slot}`;
  while (!stopping) {
    let worked = false;
    try {
      worked = await workOnce(slotWorkerId);
      lastSuccessAt=new Date();
    } catch (error) {
      failedIterationsTotal += 1;
      process.stderr.write(`dispatcher.iteration_failed ${error instanceof Error ? error.message : "unknown"}\n`);
    }
    if (!worked) {
      if (slot === 0) {
        try {
          await failExhaustedRuns(db);
          await finalizeAbandonedCancellations(db);
        } catch { /* the sweep retries on the next idle poll */ }
      }
      if (queueListener) await queueListener.wait(pollMs);
      else await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }
}

// PostgreSQL notification is the local transport adapter. The outbox remains the
// authority, so a crash before acknowledgement simply republishes the same message ID;
// a consumer must still acquire the matching database generation and fence.
async function runExecutionWorkController(): Promise<void> {
  while (!stopping) {
    try {
      await reconcileExecutionWorkItems(db);
      await scheduleExecutionWork(db);
      const dispatches = await claimExecutionDispatches(db);
      for (const dispatch of dispatches) {
        await publishPostgresExecutionDispatch(db, dispatch);
      }
    } catch (error) {
      failedIterationsTotal += 1;
      process.stderr.write(`workflow.controller_iteration_failed ${error instanceof Error ? error.message : "unknown"}\n`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

await Promise.all([
  ...Array.from({ length: workerConcurrency }, (_, slot) => runSlot(slot)),
  runExecutionWorkController(),
]);
await queueListener?.close();
await new Promise<void>((resolve) => metricsServer.close(() => resolve()));
if (listenDb !== db) await listenDb.end();
clearInterval(heartbeat);
await recordWorkerHeartbeat(db,{id:workerId,kind:"runtime-worker",concurrency:workerConcurrency,inFlight:0,lastSuccessAt,state:"stopped"}).catch(()=>undefined);
await db.end();
await telemetry.shutdown();
