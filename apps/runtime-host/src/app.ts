import rateLimit from "@fastify/rate-limit";
import { timingSafeEqual } from "node:crypto";
import Fastify from "fastify";
import {
  runtimeInvocationAnyVersionSchema,
  runtimeInvocationResultSchema,
  stableDigest,
  type RuntimeInvocationResult,
  type RuntimeInvocationStatus,
} from "@ehf/contracts";
import { extractTraceContext, SpanKind, withSpan } from "@ehf/telemetry";
import { invocationRequestDigest, type InvocationStore } from "@ehf/runtime-state";

export type RuntimeHostExecutor = (request: unknown, signal?: AbortSignal) => Promise<unknown>;

function tokenMatches(header: string | undefined, expected: string): boolean {
  const supplied = header?.startsWith("Bearer ") ? header.slice(7) : "";
  const suppliedBuffer = Buffer.from(supplied);
  const expectedBuffer = Buffer.from(expected);
  return suppliedBuffer.length === expectedBuffer.length
    && suppliedBuffer.length > 0
    && timingSafeEqual(suppliedBuffer, expectedBuffer);
}

type InFlight = {
  requestDigest: string;
  runId: string;
  executionProfileDigest: string;
  state: RuntimeInvocationStatus["state"];
  controller: AbortController;
  result?: RuntimeInvocationResult;
  execution: Promise<RuntimeInvocationResult>;
};


/**
 * A runtime host deployed as a Databricks App sits behind the Apps proxy, which
 * authenticates the caller's workspace OAuth token and forwards the caller's identity
 * instead of the bearer. Trust those headers only when startup declared this mode, and
 * only for the dispatcher's service principal(s). Authority still comes from the execution
 * grant inside the invocation, which the envelope broker verifies.
 */
export type DatabricksAppHostBinding = { allowedPrincipals: string[] };
const DATABRICKS_FORWARDED_IDENTITY_HEADERS = ["x-forwarded-email", "x-forwarded-user", "x-forwarded-preferred-username"];


function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function buildRuntimeHost(input: {
  authToken?: string;
  /** Verifies the dispatcher's workload-identity token (WORKLOAD_AUTH=workload_identity). */
  authorize?: (authorization: string | undefined) => Promise<boolean>;
  /** Deployed as a Databricks App: trust the Apps proxy's forwarded identity for these principals. */
  databricksApp?: DatabricksAppHostBinding;
  execute: RuntimeHostExecutor;
  invocationStore?: InvocationStore;
  readiness?: () => Promise<{ status: "ready" | "degraded" | "unavailable"; checks: Array<{ name:string;status:string;detail:string }> }>;
}) {
  if (input.databricksApp) {
    if (input.authToken || input.authorize) throw new Error("runtime_host.authorization_ambiguous");
    if (!input.databricksApp.allowedPrincipals.length || input.databricksApp.allowedPrincipals.some((value) => !value.trim())) {
      throw new Error("runtime_host.databricks_principals_missing");
    }
  } else {
    const authorizationModes = [Boolean(input.authToken), Boolean(input.authorize)].filter(Boolean).length;
    if (authorizationModes === 0) throw new Error("runtime_host.authorization_missing");
    if (authorizationModes !== 1) throw new Error("runtime_host.authorization_ambiguous");
  }
  const app = Fastify({ logger: true, bodyLimit: 2 * 1024 * 1024 });
  // Per-replica admission bound. Do not trust caller-supplied forwarding headers.
  void app.register(rateLimit, { global: false, max: 1000, timeWindow: 60_000, skipOnError: false });
  app.after((error) => {
    if (error) throw error;
    // Install one shared limiter after the plugin boots, including routes that
    // these synchronous builders have already registered.
    app.addHook("onRequest", app.rateLimit());
  });

  /**
   * Invocations this host has seen, so a dispatcher that lost contact can ask what
   * happened rather than guessing. Bounded: an entry is dropped once its terminal state
   * has been observable for long enough to be collected by the dispatcher.
   */
  const inFlight = new Map<string, InFlight>();
  const forget = (invocationId: string) => setTimeout(() => inFlight.delete(invocationId), 5 * 60_000).unref();

  const authorizedInvocation = async (request: {
    headers: Record<string, string | string[] | undefined> & { authorization?: string | undefined };
  }): Promise<boolean> => {
    if (input.databricksApp) return databricksPrincipalAllowed(request.headers);
    if (input.authorize) return input.authorize(request.headers.authorization);
    return tokenMatches(request.headers.authorization, input.authToken ?? "");
  };

  // Status and cancellation are reached with the same identity as invocation.
  const authorizedLifecycle = authorizedInvocation;

  function databricksPrincipalAllowed(headers: Record<string, string | string[] | undefined>): boolean {
    const allowed = new Set(input.databricksApp!.allowedPrincipals.map((value) => value.trim().toLowerCase()));
    return DATABRICKS_FORWARDED_IDENTITY_HEADERS.some((name) => {
      const value = singleHeader(headers[name])?.trim().toLowerCase();
      return Boolean(value) && allowed.has(value!);
    });
  }

  const providerMetadata = (): Record<string, string> => input.databricksApp
    ? { host: "databricks" }
    : { host: "local_http" };

  app.get("/health/live", async () => ({ status: "ok" }));
  app.get("/health/ready", async (_request,reply) => {
    try {
      if(!input.readiness)return reply.code(503).send({status:"unavailable",contractVersion:"runtime.invocation.v2",checks:[]});
      const report=await input.readiness();
      return reply.code(report.status==="unavailable"?503:200).send({...report,contractVersion:"runtime.invocation.v2",inFlight:inFlight.size});
    }catch{return reply.code(503).send({status:"unavailable",contractVersion:"runtime.invocation.v2",checks:[]});}
  });
  app.get<{ Params: { invocationId: string } }>("/invocations/:invocationId", async (request, reply) => {
    if (!await authorizedLifecycle(request)) return reply.code(401).send({ error: "runtime_host.unauthorized" });
    const entry = inFlight.get(request.params.invocationId);
    if(input.invocationStore) {
      const record=await input.invocationStore.read(request.params.invocationId);
      return reply.send({contractVersion:'runtime.status.v1',invocationId:request.params.invocationId,state:record?.state??'unknown',
        providerMetadata:{...providerMetadata(),durability:'postgres',cancellationRequested:String(record?.cancellationRequested??false)}});
    }
    // An invocation this host has no record of is genuinely unknown, not failed: saying
    // "failed" would licence a retry that could duplicate an effect already committed.
    const status: RuntimeInvocationStatus = {
      contractVersion: "runtime.status.v1",
      invocationId: request.params.invocationId,
      state: entry?.state ?? "unknown",
      providerMetadata: providerMetadata(),
    };
    return reply.send(status);
  });

  app.post<{ Params: { invocationId: string } }>("/invocations/:invocationId/cancel", async (request, reply) => {
    if (!await authorizedLifecycle(request)) return reply.code(401).send({ error: "runtime_host.unauthorized" });
    const entry = inFlight.get(request.params.invocationId);
    if(input.invocationStore) {
      const record=await input.invocationStore.read(request.params.invocationId);
      if(!record) return reply.code(404).send({error:'runtime_host.invocation_unknown'});
      const accepted=await input.invocationStore.cancel(request.params.invocationId);
      if(accepted) entry?.controller.abort(new Error('runtime.cancelled'));
      return reply.code(202).send({accepted});
    }
    if (!entry) return reply.code(404).send({ error: "runtime_host.invocation_unknown" });
    // Requested, not effective: the runtime stops at its next cancellation point, and
    // an effect it already committed stays committed.
    entry.controller.abort(new Error("runtime.cancelled"));
    return reply.code(202).send({ accepted: true });
  });

  app.post("/invocations", async (request, reply) => {
    if (!await authorizedInvocation(request)) {
      return reply.code(401).send({ error: "runtime_host.unauthorized" });
    }
    // The dispatcher sends runtime.invocation.v3 for node work; the executor accepts both versions.
    const parsed = runtimeInvocationAnyVersionSchema.safeParse(request.body);
    if (!parsed.success) {
      request.log.warn({ issues: parsed.error.issues.slice(0, 5).map((issue) => ({ path: issue.path.join("."), message: issue.message })) }, "runtime invocation rejected");
      return reply.code(400).send({ error: "runtime_host.invalid_invocation" });
    }
    const requestDigest = invocationRequestDigest(parsed.data);
    const existing = inFlight.get(parsed.data.invocationId);
    if (existing) {
      if (existing.requestDigest !== requestDigest || existing.runId !== parsed.data.runId) {
        return reply.code(409).send({ error: "runtime_host.invocation_conflict" });
      }
      const value = existing.result ?? await existing.execution;
      return reply.send(value);
    }
    if(input.invocationStore) {
      let claimed;
      try{claimed=await input.invocationStore.claim(parsed.data);}
      catch{return reply.code(409).send({error:'runtime_host.invocation_conflict'});}
      if(!claimed.created) {
        if(claimed.record.result) return reply.send(claimed.record.result);
        return reply.code(409).send({error:'runtime_host.invocation_in_progress'});
      }
    }
    const parent = extractTraceContext(request.headers);
    const controller = new AbortController();
    const entry: InFlight = {
      requestDigest,
      runId: parsed.data.runId,
      executionProfileDigest: parsed.data.executionProfileDigest.replace(/^sha256:/, ""),
      state: "running",
      controller,
      // Replaced synchronously below before another request can observe the entry.
      execution: Promise.resolve(undefined as never),
    };
    inFlight.set(parsed.data.invocationId, entry);
    const cancellationPoll=input.invocationStore ? setInterval(()=>{
      void input.invocationStore!.read(parsed.data.invocationId).then(record=>{
        if(record?.cancellationRequested) controller.abort(new Error('runtime.cancelled'));
      }).catch(()=>controller.abort(new Error('runtime.lifecycle_unavailable')));
    },500).unref():null;
    entry.execution = withSpan("runtime.invoke", {
      kind: SpanKind.SERVER,
      attributes: {
        "harness.execution.id": parsed.data.runId,
        "harness.execution.attempt": parsed.data.attempt,
        "harness.fencing.epoch": parsed.data.fencingEpoch,
        "harness.plan.digest_prefix": parsed.data.planDigest.slice(0, 12),
        "harness.runtime.contract": parsed.data.contractVersion,
      },
    }, async (span) => {
      try {
        const rawResult = runtimeInvocationResultSchema.parse(await input.execute(parsed.data, entry.controller.signal));
        if (rawResult.invocationId !== parsed.data.invocationId || rawResult.runId !== parsed.data.runId) {
          throw new Error("runtime_host.result_correlation_mismatch");
        }
        const value = runtimeInvocationResultSchema.parse({
          ...rawResult,
          providerMetadata: {
            ...rawResult.providerMetadata,
            ...providerMetadata(),
          },
        });
        entry.result = value;
        entry.state = entry.controller.signal.aborted
          ? "cancelled"
          : value.status === "completed" ? "completed" : "failed";
        if(input.invocationStore) await input.invocationStore.complete(parsed.data,value);
        span.setAttribute("harness.outcome", value.status.toUpperCase());
        return value;
      } catch (error) {
        entry.state = entry.controller.signal.aborted ? "cancelled" : "failed";
        const failed:RuntimeInvocationResult={contractVersion:'runtime.result.v1',invocationId:parsed.data.invocationId,runId:parsed.data.runId,
          status:'failed',output:null,errorCode:entry.controller.signal.aborted?'runtime.cancelled':'runtime.execution_failed',checkpointId:null,providerMetadata:providerMetadata()};
        if(input.invocationStore) {await input.invocationStore.complete(parsed.data,failed);entry.result=failed;return failed;}
        throw error;
      } finally {
        if(cancellationPoll) clearInterval(cancellationPoll);
        forget(parsed.data.invocationId);
      }
    }, parent);
    const result = await entry.execution;
    return reply.send(result);
  });

  return app;
}
