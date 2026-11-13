import { recordWorkerHeartbeat } from "@ehf/persistence";
import { processContextRefresh } from "./context-refresh.js";
import { deliverIntegrationEvent } from "./delivery.js";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { stableDigest, type BusinessCommandType } from "@ehf/contracts";
import { mintIntegrationEnvelope, type JwtSigner } from "@ehf/execution-auth";
import {
  assertPlatformInvariants,
  createPrivateKeyJwtSignerFromEnv,
  createWorkloadAuthorization,
  envelopeSigner,
  MECHANISM_REQUIREMENTS,
  resolveSecretRef,
} from "@ehf/identity";
import {
  claimDelivery,
  claimIngressReceipt,
  createDatabase,
  finishDelivery,
  finishIngressReceipt,
  getIntegrationBindingContext,
  type Database,
  type IngressReceipt,
} from "@ehf/persistence";

type JsonMap = Record<string, unknown>;
let inFlight=0;

function object(value: unknown, code = "integration.mapping_object_required"): JsonMap {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  return value as JsonMap;
}

function getPath(value: unknown, path: string): unknown {
  if (path === "$" || path === "/") return value;
  return path.replace(/^\$\.?/, "").split(/[./]/).filter(Boolean).reduce<unknown>((current, key) =>
    current && typeof current === "object" ? (current as JsonMap)[key] : undefined, value);
}

function materialize(value: unknown, scope: JsonMap): unknown {
  if (typeof value === "string") {
    const exact = value.match(/^\{\{\s*([^}]+)\s*\}\}$/);
    if (exact) return getPath(scope, exact[1]!.trim());
    return value.replace(/\{\{\s*([^}]+)\s*\}\}/g, (_match, path: string) => {
      const selected = getPath(scope, path.trim());
      return typeof selected === "string" ? selected : JSON.stringify(selected ?? null);
    });
  }
  if (Array.isArray(value)) return value.map((item) => materialize(item, scope));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as JsonMap).map(([key, item]) => [key, materialize(item, scope)]));
  return value;
}

async function secretFromRef(reference: string): Promise<string> {
  try {
    return await resolveSecretRef(reference, process.env);
  } catch (error) {
    throw new Error(error instanceof Error && error.message === "secret.ref_unsupported"
      ? "integration.credential_ref_unsupported" : "integration.credential_unavailable");
  }
}

/** This worker's one service identity, presented to every platform API it calls. */
const serviceAuthorization = createWorkloadAuthorization({ staticTokenEnv: "INTEGRATION_SERVICE_TOKEN" });

async function apiJson(base: string, path: string, init: RequestInit): Promise<any> {
  const response = await fetch(`${base.replace(/\/$/, "")}${path}`, {
    ...init,
    headers: { authorization: await serviceAuthorization(), ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(20_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(String(body.error ?? `integration.http_${response.status}`));
  return body;
}

async function envelope(input: {
  receipt: IngressReceipt; deploymentId: string; planDigest: string; caseId: string | null;
  commandType: BusinessCommandType | null; signer?: JwtSigner;
}): Promise<string> {
  const signing = input.signer
    ? { signer: input.signer }
    : process.env.INTEGRATION_ENVELOPE_SECRET
      ? { secret: process.env.INTEGRATION_ENVELOPE_SECRET }
      : {};
  return mintIntegrationEnvelope({
    ...signing,
    envelopeId: `integration_${randomUUID()}`,
    tenantId: input.receipt.tenantId,
    deploymentId: input.deploymentId,
    bindingId: input.receipt.bindingId,
    bindingRevision: input.receipt.bindingRevision,
    planDigest: input.planDigest,
    caseId: input.caseId,
    intent: input.receipt.intent,
    commandType: input.commandType,
    nonce: input.receipt.receiptId,
    ttlSeconds: 90,
  });
}

async function executeIngress(db: Database, receipt: IngressReceipt & { claimId: string }, signer?: JwtSigner): Promise<unknown> {
  const context = await getIntegrationBindingContext(db, { tenantId: receipt.tenantId, bindingId: receipt.bindingId, revision: receipt.bindingRevision });
  if (!context || context.binding.binding.status !== "ACTIVE") throw new Error("integration.binding_not_active");
  const trigger = context.plan.apiVersion === "harness.factory/plan-v2"
    ? context.plan.integrations?.triggers.find((item) => item.id === context.binding.binding.contractId)
    : undefined;
  if (!trigger || trigger.target.intent !== receipt.intent) throw new Error("integration.trigger_not_found");
  const mapped = object(materialize(trigger.mapping, { event: receipt.payload, receipt }));
  const caseApi = process.env.CASE_API_URL ?? "http://case-api:4102";
  const controlApi = process.env.CONTROL_API_URL ?? "http://control-api:4100";

  if (receipt.intent === "create_case") {
    const token = await envelope({ receipt, deploymentId: context.binding.binding.deploymentId,
      planDigest: context.binding.binding.planDigest, caseId: null, commandType: null, ...(signer ? { signer } : {}) });
    const request = { ...mapped, tenantId: receipt.tenantId, harnessPlanDigest: context.binding.binding.planDigest,
      actor: { type: "INTEGRATION", principalId: `binding:${receipt.bindingId}`, roles: ["Integration.Dispatch"] } };
    return apiJson(caseApi, "/v1/cases", { method: "POST", headers: { "content-type": "application/json",
      "idempotency-key": receipt.receiptId, "x-integration-envelope": token }, body: JSON.stringify(request) });
  }

  const caseId = String(mapped.caseId ?? "");
  if (!caseId) throw new Error("integration.case_id_required");
  if (receipt.intent === "start_run") {
    const token = await envelope({ receipt, deploymentId: context.binding.binding.deploymentId,
      planDigest: context.binding.binding.planDigest, caseId, commandType: null, ...(signer ? { signer } : {}) });
    return apiJson(controlApi, "/v1/runs", { method: "POST", headers: { "content-type": "application/json",
      "idempotency-key": receipt.receiptId, "x-integration-envelope": token },
      body: JSON.stringify({ planDigest: context.binding.binding.planDigest, input: { ...object(mapped.input ?? {}), tenantId: receipt.tenantId, caseId } }) });
  }

  const expectedCaseSequence = Number(mapped.expectedCaseSequence);
  if (!Number.isInteger(expectedCaseSequence) || expectedCaseSequence < 0) throw new Error("integration.case_sequence_required");
  const commandType = trigger.target.commandType;
  if (!commandType) throw new Error("integration.command_type_required");
  const token = await envelope({ receipt, deploymentId: context.binding.binding.deploymentId,
    planDigest: context.binding.binding.planDigest, caseId, commandType, ...(signer ? { signer } : {}) });
  const commandId = `cmd_integration_${stableDigest({ tenantId: receipt.tenantId, bindingId: receipt.bindingId,
    bindingRevision: receipt.bindingRevision, sourceEventId: receipt.sourceEventId, intent: receipt.intent }).slice(0, 32)}`;
  const command = {
    commandId, commandType, commandVersion: "harness.integration.v1",
    tenantId: receipt.tenantId, caseId,
    actor: { type: "INTEGRATION", principalId: `binding:${receipt.bindingId}`, roles: ["Integration.Dispatch"] },
    authority: { planDigest: context.binding.binding.planDigest,
      // The policy digest the case is pinned to is filled in by the case API, which already
      // holds the case: one call instead of a read followed by a write.
      permissionEnvelopeDigest: stableDigest({ bindingId: receipt.bindingId, revision: receipt.bindingRevision, commandType }) },
    payload: object(mapped.payload ?? {}), preconditions: { caseSequence: expectedCaseSequence },
    idempotencyKey: `${receipt.tenantId}:${receipt.bindingId}:${receipt.bindingRevision}:${receipt.sourceEventId}:${receipt.intent}`,
  };
  return apiJson(caseApi, `/v1/cases/${encodeURIComponent(caseId)}/commands`, { method: "POST",
    headers: { "content-type": "application/json", "x-integration-envelope": token }, body: JSON.stringify(command) });
}

async function processIngress(db: Database, signer?: JwtSigner): Promise<boolean> {
  const receipt = await claimIngressReceipt(db);
  if (!receipt) return false;
  inFlight++;
  try {
    const result = await executeIngress(db, receipt, signer);
    await finishIngressReceipt(db, { receiptId: receipt.receiptId, claimId: receipt.claimId, result });
  } catch (error) {
    const code = error instanceof Error ? error.message : "integration.ingress_failed";
    const retryable = /timeout|fetch failed|http_5\d\d|queue_saturated|environment_stopped/.test(code);
    await finishIngressReceipt(db, { receiptId: receipt.receiptId, claimId: receipt.claimId, errorCode: code, retryable });
  } finally { inFlight--; }
  return true;
}

async function processDelivery(db: Database): Promise<boolean> {
  const delivery = await claimDelivery(db);
  if (!delivery) return false;
  inFlight++;
  try {
  if (!delivery.connector.endpoint) {
    await finishDelivery(db, { delivery, outcome: "DEAD_LETTER", errorCode: "integration.connector_endpoint_missing" });
    return true;
  }
  try {
    const response = await deliverIntegrationEvent(delivery, secretFromRef);
    if (response.status >= 200 && response.status < 300) await finishDelivery(db, { delivery, outcome: "DELIVERED", httpStatus: response.status });
    else if ([408, 429].includes(response.status) || response.status >= 500) await finishDelivery(db, { delivery,
      outcome: delivery.attemptNumber < 8 ? "RETRY" : "DEAD_LETTER", httpStatus: response.status, errorCode: `http_${response.status}` });
    else await finishDelivery(db, { delivery, outcome: "DEAD_LETTER", httpStatus: response.status, errorCode: `http_${response.status}` });
  } catch (error) {
    await finishDelivery(db, { delivery, outcome: delivery.attemptNumber < 8 ? "RETRY" : "DEAD_LETTER",
      errorCode: error instanceof Error ? error.message : "integration.delivery_failed" });
  }
  return true;
  } finally { inFlight--; }
}

assertPlatformInvariants({
  mechanisms: ["IDENTITY_PROVIDER", "WORKLOAD_AUTH", "ENVELOPE_SIGNER", "DATABASE_AUTH", "TELEMETRY_EXPORTER"],
  forbidden: ["INTEGRATION_SERVICE_TOKEN", "INTEGRATION_ENVELOPE_SECRET"],
  requiredFor: {
    ...MECHANISM_REQUIREMENTS,
    "ENVELOPE_SIGNER=private_key": ["INTEGRATION_ENVELOPE_PRIVATE_KEY_FILE", "INTEGRATION_ENVELOPE_KEY_ID"],
  },
});

const db = createDatabase();
const signer = envelopeSigner(process.env) === "private_key" ? createPrivateKeyJwtSignerFromEnv("INTEGRATION_ENVELOPE") : undefined;
const healthPort = Number(process.env.INTEGRATION_WORKER_PORT ?? process.env.PORT ?? 9091);
if (!Number.isInteger(healthPort) || healthPort < 1 || healthPort > 65_535) throw new Error("integration.worker_port_invalid");
let lastSuccessAt:Date|null=null;
const heartbeat=setInterval(()=>{void recordWorkerHeartbeat(db,{id:`integration:${process.pid}:${process.env.HOSTNAME??"local"}`,kind:"integration-worker",concurrency:1,inFlight,lastSuccessAt,state:stopping?"draining":"ready"}).catch(()=>undefined);},5_000);
heartbeat.unref();
let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => { stopping = true; });

// Health only. Work arrives through the database the worker polls, so nothing needs to
// call the worker to wake it; a queue-depth autoscaler (KEDA's PostgreSQL scaler, or any
// equivalent) handles scale-out.
const healthServer = createServer(async (request, response) => {
  if (request.url === "/health/live") {
    response.writeHead(200, { "content-type": "application/json" }).end('{"status":"ok"}');
    return;
  }
  if (request.url === "/health/ready") {
    try {
      if (stopping) throw new Error("integration.stopping");
      await db.query("select 1");
      response.writeHead(200, { "content-type": "application/json" }).end('{"status":"ready"}');
    } catch {
      response.writeHead(503, { "content-type": "application/json" }).end('{"status":"unavailable"}');
    }
    return;
  }
  response.writeHead(404).end();
});
healthServer.listen(healthPort, "0.0.0.0");

while (!stopping) {
  let worked = false;
  try {
    worked = await processIngress(db, signer) || worked;
    worked = await processDelivery(db) || worked;
    worked = await processContextRefresh(db, { onClaim:()=>{inFlight++;return ()=>{inFlight--;};}, tenantId: process.env.PLATFORM_TENANT_ID ?? process.env.LOCAL_DEFAULT_TENANT_ID ?? "tenant_demo",
      ...(signer ? { signer } : process.env.INTEGRATION_ENVELOPE_SECRET ? { secret: process.env.INTEGRATION_ENVELOPE_SECRET } : {}),
      start: (body, headers) => apiJson(process.env.CONTROL_API_URL ?? "http://control-api:4100", "/v1/runs", { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) }),
    }) || worked;
    lastSuccessAt=new Date();
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ level: "error", service: "integration-worker", error: error instanceof Error ? error.message : String(error) })}\n`);
  }
  if (!worked) await new Promise((resolve) => setTimeout(resolve, Number(process.env.INTEGRATION_POLL_INTERVAL_MS ?? 1_000)));
}
await new Promise<void>((resolve) => healthServer.close(() => resolve()));
clearInterval(heartbeat);
await recordWorkerHeartbeat(db,{id:`integration:${process.pid}:${process.env.HOSTNAME??"local"}`,kind:"integration-worker",concurrency:1,inFlight:0,lastSuccessAt,state:"stopped"}).catch(()=>undefined);
await db.end();
