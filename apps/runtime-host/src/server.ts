import { MemorySaver } from "@langchain/langgraph";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import {
  assertPlatformInvariants,
  createWorkloadResolverFromEnv,
  createWorkloadTokenProvider,
  isProductionProfile,
  MECHANISM_REQUIREMENTS,
  serviceGrants,
  workloadAuth,
} from "@ehf/identity";
import { initializeTelemetry } from "@ehf/telemetry";
import type { V2ExecutionAdapters } from "@ehf/runtime-langgraph";
import { buildRuntimeHost } from "./app.js";
import { HttpInvocationStore } from "@ehf/runtime-state";
import { executeRuntimeInvocation } from "./executor.js";
import { openPostgresCheckpointSaver } from "./checkpoint.js";
import {runtimeReadiness} from "./readiness.js";

function requiredEnv(name: string, error: string): string {
  const value = process.env[name];
  if (!value) throw new Error(error);
  return value;
}

function serviceUrl(name: string, localDefault: string, requireHttps: boolean): string {
  const value = process.env[name] ?? (requireHttps ? requiredEnv(name, `runtime_host.${name.toLowerCase()}_missing`) : localDefault);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`runtime_host.${name.toLowerCase()}_invalid`);
  }
  if (requireHttps && url.protocol !== "https:") throw new Error(`runtime_host.${name.toLowerCase()}_https_required`);
  return url.toString().replace(/\/$/, "");
}

function optionalServiceUrl(name: string, requireHttps: boolean): string | undefined {
  const value = process.env[name];
  return value ? serviceUrl(name, value, requireHttps) : undefined;
}

// The runtime signs nothing and journals through the control plane, so it must not hold
// an envelope secret in any profile, and must hold no database credential in production.
if (process.env.EXECUTION_ENVELOPE_SECRET) throw new Error("runtime.envelope_secret_forbidden");
if (process.env.RUNTIME_GRANT_SECRET) throw new Error("runtime.grant_secret_forbidden");
assertPlatformInvariants({
  mechanisms: ["WORKLOAD_AUTH", "TELEMETRY_EXPORTER"],
  forbidden: ["RUNTIME_SERVICE_TOKEN", "RUNTIME_HOST_AUTH_TOKEN", "RUNTIME_CHECKPOINT_DATABASE_URL"],
  requiredFor: { "WORKLOAD_AUTH=workload_identity": MECHANISM_REQUIREMENTS["WORKLOAD_AUTH=workload_identity"] },
  databaseUrls: ["RUNTIME_CHECKPOINT_DATABASE_URL"],
});

const telemetry = initializeTelemetry({ serviceName: "harness-runtime-host" });
const workloadIdentity = workloadAuth() === "workload_identity";
// One identity for every platform service the runtime calls (control plane, gateway,
// case API): its projected workload token, or the development shared token.
if (!workloadIdentity) requiredEnv("RUNTIME_SERVICE_TOKEN", "runtime.service_token_missing");
const serviceToken = createWorkloadTokenProvider({ staticTokenEnv: "RUNTIME_SERVICE_TOKEN" });
// Under workload identity, only the dispatcher's verified identity may invoke this host.
const hostAuthorization = workloadIdentity
  ? createWorkloadResolverFromEnv(serviceGrants([{ subjectId: "runtime-dispatcher", roles: [], tokenEnv: "RUNTIME_HOST_AUTH_TOKEN" }]), process.env)
  : null;

const verifyWorkload = hostAuthorization
  ? async (authorization: string | undefined) => {
      try {
        await hostAuthorization.resolve({ headers: { authorization } });
        return true;
      } catch {
        return false;
      }
    }
  : undefined;

// A production runtime reaches platform services only over https, at explicitly
// configured addresses.
const requireHttps = isProductionProfile();
const capabilityGatewayUrl = serviceUrl("CAPABILITY_GATEWAY_URL", "http://capability-gateway:4101", requireHttps);
const caseApiUrl = serviceUrl("CASE_API_URL", "http://case-api:4102", requireHttps);
const controlPlaneUrl = serviceUrl("ENVELOPE_BROKER_URL", "http://control-api:4100", requireHttps);
const policyEvaluatorUrl = optionalServiceUrl("POLICY_EVALUATOR_URL", requireHttps) ?? `${caseApiUrl}/v2/policy/evaluate`;
const fanoutExecutorUrl = optionalServiceUrl("FANOUT_EXECUTOR_URL", requireHttps);
const subgraphExecutorUrl = optionalServiceUrl("SUBGRAPH_EXECUTOR_URL", requireHttps);

async function workloadToken(): Promise<string> {
  return serviceToken();
}

async function authenticatedJson(
  url: string,
  init: { method: "GET" | "POST"; body?: unknown; headers?: Record<string, string>; signal?: AbortSignal },
): Promise<unknown> {
  const token = await workloadToken();
  const timeout = AbortSignal.timeout(30_000);
  const response = await fetch(url, {
    method: init.method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...init.headers,
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
  });
  const body = await response.json().catch(() => ({ error: "runtime.v2.adapter_invalid_response" })) as Record<string, unknown>;
  if (!response.ok) throw new Error(String(body.error ?? `runtime.v2.adapter_http_${response.status}`));
  return body;
}

/** Exchange the dispatcher's runtime grant for the node-scoped read authority. */
async function caseReadEnvelope(request: Parameters<V2ExecutionAdapters["loadCaseSnapshot"]>[0]): Promise<string> {
  const execution = request.execution;
  if (!execution) throw new Error("runtime.v2.snapshot_execution_required");
  const body = await authenticatedJson(`${controlPlaneUrl}/v1/runtime/envelopes`, {
    method: "POST",
    headers: { "x-runtime-grant": execution.grant },
    body: {
      runId: execution.runId,
      nodeId: request.nodeId,
      attempt: execution.attempt,
      invocationId: `${execution.invocationId}:case-read:${request.nodeId}`,
    },
  }) as Record<string, unknown>;
  if (typeof body.envelope !== "string" || !body.envelope) throw new Error("runtime.v2.snapshot_envelope_invalid");
  return body.envelope;
}

const v2Adapters: V2ExecutionAdapters = {
  loadCaseSnapshot: async (request, signal) => {
    if (request.purposes.length !== 1) throw new Error("runtime.v2.snapshot_purpose_ambiguous");
    // Normally issued with the node's start; asked for separately only when it was not.
    const envelope = request.caseReadEnvelope ?? await caseReadEnvelope(request);
    return authenticatedJson(`${caseApiUrl}/v2/cases/${encodeURIComponent(request.caseId)}/snapshot`, {
      method: "GET",
      headers: {
        "x-purpose": request.purposes[0]!,
        "x-tenant-id": request.tenantId,
        "x-execution-envelope": envelope,
      },
      ...(signal ? { signal } : {}),
    });
  },
  evaluateGate: async (request, signal) => {
    if (!policyEvaluatorUrl) throw new Error("runtime.v2.policy_evaluator_missing");
    return authenticatedJson(policyEvaluatorUrl, {
      method: "POST",
      body: request,
      ...(signal ? { signal } : {}),
    });
  },
  ...(fanoutExecutorUrl ? {
    executeFanoutBody: (request, signal) => authenticatedJson(fanoutExecutorUrl, { method: "POST", body: request, signal }),
  } : {}),
  ...(subgraphExecutorUrl ? {
    executeSubgraph: (request, signal) => authenticatedJson(subgraphExecutorUrl, {
      method: "POST", body: request, ...(signal ? { signal } : {}),
    }),
  } : {}),
};

/**
 * Checkpoint backend, chosen explicitly.
 *
 * `postgres` keeps runs resumable and is the local default. `memory` exists so the
 * runtime can be deployed with no database credential whatsoever -- which is what a
 * hosted agent outside the platform's trust boundary needs -- at the cost of
 * resumability. A deployment using it is a connectivity milestone, not a durable one.
 */
const checkpointBackend = process.env.RUNTIME_CHECKPOINT_BACKEND ?? "postgres";
let saver: BaseCheckpointSaver;
let closeSaver = async (): Promise<void> => {};
if (checkpointBackend === "postgres") {
  const connectionString = requiredEnv("RUNTIME_CHECKPOINT_DATABASE_URL", "runtime.checkpoint_database_url_missing");
  // The control migrations own the checkpoint tables; the saver's setup() is not run.
  const postgres = await openPostgresCheckpointSaver(connectionString);
  saver = postgres;
  closeSaver = () => postgres.end();
} else if (checkpointBackend === "memory") {
  saver = new MemorySaver();
} else {
  throw new Error(`runtime.checkpoint_backend_unsupported:${checkpointBackend}`);
}

// Deployed as a Databricks App, the Apps proxy authenticates the dispatcher and forwards
// its identity; only the listed service principal(s) may invoke.
const databricksApp = process.env.RUNTIME_HOST_MODE === "databricks_app"
  ? { allowedPrincipals: requiredEnv("RUNTIME_HOST_DATABRICKS_PRINCIPALS", "runtime_host.databricks_principals_missing").split(",").map((value) => value.trim()).filter(Boolean) }
  : null;

const app = buildRuntimeHost({
  readiness:runtimeReadiness({checkpointBackend,checkpoints:()=>saver.list({configurable:{thread_id:'__platform_readiness__'}},{limit:1}).next(),
    journal:()=>new HttpInvocationStore({baseUrl:controlPlaneUrl,credential:serviceToken}).read('__platform_readiness__'),gatewayUrl:capabilityGatewayUrl,caseApiUrl}),
  invocationStore: new HttpInvocationStore({baseUrl:controlPlaneUrl,credential:serviceToken}),
  ...(databricksApp
    ? { databricksApp }
    : hostAuthorization
    ? {
        authorize: verifyWorkload!,
      }
    : { authToken: requiredEnv("RUNTIME_HOST_AUTH_TOKEN", "runtime_host.auth_token_missing") }),
  execute: (request, signal) => executeRuntimeInvocation(request, {
    saver,
    gatewayUrl: capabilityGatewayUrl,
    caseApiUrl,
    controlPlaneUrl,
    serviceToken,
    v2Adapters,
    providerMetadata: {
      host: databricksApp ? "databricks" : "local_http",
      contractVersion: "runtime.invocation.v2",
      checkpointBackend,
    },
  }, signal),
});

const close = async () => {
  await app.close();
  await closeSaver();
  await telemetry.shutdown();
};
process.once("SIGTERM", () => { void close(); });
process.once("SIGINT", () => { void close(); });

const port = Number(process.env.PORT ?? process.env.DATABRICKS_APP_PORT ?? process.env.RUNTIME_HOST_PORT ?? 8088);
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("runtime_host.port_invalid");
await app.listen({ host: "0.0.0.0", port });
