import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { foundryProjectTraceSchema, foundryTraceBindingSchema, isFoundryTraceBindingQualified } from "@ehf/contracts/foundry";
import { actionsForRoles, isProductionProfile } from "@ehf/identity";
import { applicationInsightsResourceId, createApplicationInsightsQuery } from "./azure-trace-query.js";
import { errorResponse } from "./relay.js";
import type { sessionAccess } from "./session.js";
import { UpstreamError } from "./upstream.js";

const PROBE_WINDOW_MS = 10 * 60_000;
const QUERY_INTERVAL_MS = 15_000;
type CheckState = "not_configured" | "unverified" | "pending" | "passed" | "failed" | "blocked";
type Check = { id: string; label: string; state: CheckState; detail: string; checkedAt: string | null };
type Query = ReturnType<typeof createApplicationInsightsQuery>;

function collectorUrl(raw: string | undefined, production: boolean): URL | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
        production && url.protocol !== "https:") return null;
    return url;
  } catch {
    return null;
  }
}

function deployedFoundry(raw: string | undefined) {
  if (!raw || raw.length > 4096) return null;
  try {
    const parsed = foundryTraceBindingSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function candidate(raw: string | undefined) {
  if (!raw || raw.length > 4096) return null;
  try {
    const value = JSON.parse(raw);
    const parsed = foundryProjectTraceSchema.safeParse({
      projectEndpoint: value?.projectEndpoint,
      agentName: value?.agentName,
      agentVersion: value?.agentVersion,
      applicationInsightsResourceId: value?.applicationInsightsResourceId,
    });
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function observabilityChecks(
  env: NodeJS.ProcessEnv,
  fetcher: typeof fetch = globalThis.fetch,
  query: Query = createApplicationInsightsQuery(env, fetcher),
  now = Date.now,
) {
  const resourceId = env.BFF_TRACE_APP_INSIGHTS_RESOURCE_ID;
  const endpoint = collectorUrl(env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT, isProductionProfile(env));
  const collectorEndpoint = endpoint?.href ?? null;
  const azure = env.BFF_TRACE_BACKEND === "azure_monitor" && applicationInsightsResourceId(resourceId);
  const retention = Number(env.BFF_TRACE_RETENTION_DAYS ?? "30");
  const sampler = Number(env.OTEL_TRACES_SAMPLER_ARG ?? "1");
  const backend = azure ? "azure_monitor" : env.BFF_JAEGER_QUERY_URL ? "jaeger" : "unconfigured";
  const configuredFoundry = candidate(env.FOUNDRY_TRACE_BINDING_JSON);
  const foundry = configuredFoundry ?? candidate(env.BFF_TRACE_FOUNDRY_CANDIDATE_JSON);
  const foundryBinding = deployedFoundry(env.FOUNDRY_TRACE_BINDING_JSON);
  const qualifiedFoundry = () => foundryBinding && isFoundryTraceBindingQualified(foundryBinding, true, now());
  const checks: Check[] = [
    { id: "receiver", label: "Collector receiver", state: collectorEndpoint ? "unverified" : "not_configured", detail: "Send a synthetic span to test the configured receiver.", checkedAt: null },
    { id: "query", label: "Azure query authorization", state: azure ? "unverified" : "not_configured", detail: "Checks the BFF identity against the Application Insights span table.", checkedAt: null },
    { id: "ingestion", label: "Platform span ingestion", state: azure ? "unverified" : "not_configured", detail: "Checks whether the synthetic span arrives in Application Insights.", checkedAt: null },
  ];
  if (foundry) checks.push({ id: "foundry-query", label: "Foundry query authorization", state: "unverified", detail: "Checks the BFF identity against the isolated Foundry span table.", checkedAt: null });
  let probe: { traceId: string; spanId: string; started: number; nextRead: number } | undefined;
  let work: Promise<void> | undefined;
  let lastStarted: number | undefined;
  const set = (id: string, state: CheckState, detail: string) => {
    const check = checks.find(item => item.id === id)!;
    Object.assign(check, { state, detail, checkedAt: new Date(now()).toISOString() });
  };
  const snapshot = () => ({
    backend,
    revision: env.BFF_TRACE_CONFIGURATION_REVISION ?? null,
    collectorEndpoint,
    applicationInsightsResourceId: azure ? resourceId! : null,
    lookupDays: azure && Number.isInteger(retention) && retention >= 1 && retention <= 730 ? retention : null,
    samplerRatio: azure && Number.isFinite(sampler) && sampler >= 0 && sampler <= 1 ? sampler : null,
    foundry,
    editUrl: env.ONBOARDING_CONSOLE_ORIGIN ? "/onboarding?step=1" : null,
    checks: [
      ...checks.map(check => check.id === "foundry-query" && !qualifiedFoundry()
        ? { ...check, state: "blocked" as const, detail: "Qualify the Foundry destination before testing query access.", checkedAt: null }
        : { ...check }),
      ...(foundry ? [{
        id: "foundry", label: "Foundry native trace qualification",
        ...((): Pick<Check, "state" | "detail" | "checkedAt"> => {
          if (qualifiedFoundry()) {
            return { state: "passed", detail: "Deployment qualification verified correlation and content isolation.", checkedAt: env.BFF_TRACE_FOUNDRY_QUALIFICATION_CHECKED_AT ?? null };
          }
          return { state: "blocked", detail: "A current deployment qualification for this project and reader identity is required.", checkedAt: null };
        })(),
      }] : []),
    ],
  });

  async function readProbe(): Promise<void> {
    if (!probe || !resourceId || now() < probe.nextRead) return;
    if (now() - probe.started >= PROBE_WINDOW_MS) {
      set("ingestion", "failed", "The synthetic span was not visible before the ten-minute deadline.");
      probe = undefined;
      return;
    }
    const current = probe;
    current.nextRead = now() + QUERY_INTERVAL_MS;
    try {
      const result = await query(resourceId,
        `dependencies | where operation_Id == "${current.traceId}" and id == "${current.spanId}" | project operation_Id, id | take 1`,
        { startTime: new Date(current.started - 60_000).toISOString(), endTime: new Date(now()).toISOString() });
      if (!result.partial && result.rows.some(row => row.operation_Id === current.traceId && row.id === current.spanId)) {
        set("ingestion", "passed", "Application Insights returned the synthetic Collector span.");
        probe = undefined;
      }
    } catch {
      set("ingestion", "pending", "The reader could not confirm ingestion. Verification will retry.");
    }
  }

  async function start(): Promise<void> {
    const started = now();
    const traceId = randomBytes(16).toString("hex");
    const spanId = randomBytes(8).toString("hex");
    const traceTime = BigInt(started) * 1_000_000n;
    if (!endpoint) throw new UpstreamError(409, "observability.collector_not_configured");
    if (azure && resourceId) {
      set("query", "pending", "Checking span table access.");
      set("ingestion", "pending", "Waiting for a synthetic span.");
    }
    set("receiver", "pending", "Sending a synthetic span.");
    const receiver = (async () => {
      try {
        const response = await fetcher(endpoint, {
          method: "POST", headers: { "content-type": "application/json" }, redirect: "error",
          signal: AbortSignal.timeout(5000),
          body: JSON.stringify({ resourceSpans: [{
            resource: { attributes: [{ key: "service.name", value: { stringValue: "harness-observability-probe" } }] },
            scopeSpans: [{ scope: { name: "harness.observability" }, spans: [{
              traceId, spanId, name: "observability.verify", kind: 3,
              startTimeUnixNano: traceTime.toString(), endTimeUnixNano: (traceTime + 1_000_000n).toString(),
              status: { code: 1 },
            }] }],
          }] }),
        });
        await response.body?.cancel();
        if (!response.ok) throw new Error("collector refused");
        set("receiver", "passed", "The Collector accepted the synthetic export.");
        return true;
      } catch {
        set("receiver", "failed", "The Collector did not accept the synthetic export.");
        return false;
      }
    })();
    const authorizeQuery = async (id: string, component: string) => {
      set(id, "pending", "Checking span table access.");
      try {
        const result = await query(component, "dependencies | take 0 | count",
          { startTime: new Date(started - 60_000).toISOString(), endTime: new Date(started).toISOString() });
        if (result.partial || !result.rows.length) throw new Error("query not confirmed");
        set(id, "passed", "The deployed BFF identity can query the span table.");
        return true;
      } catch {
        set(id, "failed", "The BFF identity could not query the span table. Check access and network configuration.");
        return false;
      }
    };
    const canQuery = azure && resourceId ? authorizeQuery("query", resourceId) : false;
    const canQueryFoundry = foundryBinding && qualifiedFoundry()
      ? authorizeQuery("foundry-query", foundryBinding.applicationInsightsResourceId) : false;
    const [sent, allowed] = await Promise.all([receiver, canQuery, canQueryFoundry]);
    if (azure && sent && allowed) {
      probe = { traceId, spanId, started, nextRead: started };
      await readProbe();
    } else if (azure) {
      set("ingestion", "failed", "Resolve the receiver or query check before verifying ingestion.");
    }
  }

  return {
    snapshot,
    async refresh() {
      if (!work && probe && now() >= probe.nextRead) {
        work = readProbe().finally(() => { work = undefined; });
        await work;
      }
      return snapshot();
    },
    async verify() {
      if (work || probe || lastStarted !== undefined && now() - lastStarted < QUERY_INTERVAL_MS) return snapshot();
      lastStarted = now();
      work = start().finally(() => { work = undefined; });
      await work;
      return snapshot();
    },
  };
}

export function registerObservabilityExperience(app: FastifyInstance, access: ReturnType<typeof sessionAccess>, checks: ReturnType<typeof observabilityChecks>) {
  app.get("/api/v1/admin/observability", async (request, reply) => {
    reply.header("cache-control", "no-store");
    try {
      const principal = await access.resolver.resolve(request);
      if (principal.actorType !== "human" || !actionsForRoles(principal.roles).has("admin.read")) {
        throw new UpstreamError(403, "authorization.role_missing");
      }
      return await checks.refresh();
    } catch (error) {
      const failure = errorResponse(error, request);
      return reply.code(failure.status).send(failure.body);
    }
  });
  app.post<{ Body: { reason?: unknown } }>("/api/v1/admin/observability/verify", async (request, reply) => {
    reply.header("cache-control", "no-store");
    try {
      const principal = await access.resolver.resolve(request);
      if (principal.actorType !== "human" || !actionsForRoles(principal.roles).has("admin.write")) {
        throw new UpstreamError(403, "authorization.role_missing");
      }
      if (!access.csrf(request)) throw new UpstreamError(403, "csrf.invalid");
      const reason = typeof request.body?.reason === "string" ? request.body.reason.trim() : "";
      if (reason.length < 3 || reason.length > 500) throw new UpstreamError(400, "observability.reason_required");
      request.log.info({ actor: principal.subjectId, tenantId: principal.tenantId, reasonDigest: createHash("sha256").update(reason).digest("hex") }, "observability.verify");
      return await checks.verify();
    } catch (error) {
      const failure = errorResponse(error, request);
      return reply.code(failure.status).send(failure.body);
    }
  });
}
