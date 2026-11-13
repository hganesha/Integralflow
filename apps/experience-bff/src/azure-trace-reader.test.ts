import { ManagedIdentityCredential } from "@azure/identity";
import { describe, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";
import { azureTraceAuthority, readAzureTrace } from "./azure-trace-reader.js";
import { applicationInsightsResourceId, createApplicationInsightsQuery, type ApplicationInsightsQuery } from "./azure-trace-query.js";
import type { Upstream } from "./upstream.js";

const tenantId = "tenant_test";
const traceId = "b".repeat(32);
const linkedTraceId = "c".repeat(32);
const rootSpanId = "1".repeat(16);
const callerSpanId = "2".repeat(16);
const invocationSpanId = "3".repeat(16);
const nativeChildId = "4".repeat(16);
const startedAt = "2026-11-12T20:29:45.000Z";
const completedAt = "2026-11-12T20:29:50.000Z";
const now = Date.parse("2026-11-12T20:36:00Z");
const resourcePrefix = "/subscriptions/2840dd81-b9aa-4345-81b2-ffffc39fd67e/resourceGroups/ehf-test/providers/Microsoft.Insights/components/";
const platformResource = resourcePrefix + "platform";
const foundryResource = resourcePrefix + "foundry";
const projectEndpoint = "https://test-foundry.services.ai.azure.com/api/projects/trace-qualification";
const clientId = "12345678-1234-1234-1234-123456789012";
const env: NodeJS.ProcessEnv = {
  BFF_TRACE_BACKEND: "azure_monitor",
  BFF_TRACE_APP_INSIGHTS_RESOURCE_ID: platformResource,
  BFF_TRACE_MANAGED_IDENTITY_CLIENT_ID: clientId,
};
const roots = [{ runId: "run-1", spanId: rootSpanId, sampled: true, startedAt, completedAt }];
const binding = {
  projectEndpoint, agentName: "trace-probe", agentVersion: "1", applicationInsightsResourceId: foundryResource,
  tenantId, contentIsolation: "synthetic_only",
};
const foundryLink = {
  applicationInsightsResourceId: foundryResource, projectEndpoint, agentName: "trace-probe", agentVersion: "1",
  parentSpanId: callerSpanId, responseId: "resp_native_result", startedAt, completedAt,
};

function span(id: string, parent: string | null, overrides: Record<string, unknown> = {}) {
  return {
    OperationId: traceId, SpanId: id, ParentSpanId: parent, StartedAt: startedAt, DurationMs: 10.25,
    Success: "True", Role: "harness-runtime-dispatcher", Name: "harness.run", ...overrides,
  };
}

const platformRows = [
  span(rootSpanId, null),
  span(callerSpanId, rootSpanId, { Name: "sensitive request text", Role: "unexpected service value", Success: false }),
  span("5".repeat(16), null, { Name: "another run sharing the operation" }),
];
const native = (operationId = traceId, parent: string | null = callerSpanId) => [
  span(invocationSpanId, parent, {
    OperationId: operationId, Role: "responsesapi", Name: "invoke_agent trace-probe:1", Operation: "invoke_agent", ResponseId: foundryLink.responseId,
  }),
  span(nativeChildId, invocationSpanId, {
    OperationId: operationId, Role: "responsesapi", Name: "provider-sensitive label", Operation: "chat", ResponseId: foundryLink.responseId,
    DurationMs: "00:00:00.025", InputTokens: 20, OutputTokens: 2,
  }),
];

function authorized(foundry = [foundryLink]) {
  return azureTraceAuthority({ traceId, roots, foundry });
}

describe("Azure trace scopes and correlation", () => {
  it("scopes platform rows to durable roots and uses only safe display labels", async () => {
    const query = vi.fn<ApplicationInsightsQuery>(async () => ({ rows: platformRows, partial: false }));
    const result = await readAzureTrace(traceId, tenantId, authorized([]), env, query, now);
    expect(query).toHaveBeenCalledExactlyOnceWith(platformResource, expect.stringContaining(`operation_Id == "${traceId}"`), {
      startTime: "2026-11-12T20:28:45.000Z", endTime: "2026-11-12T20:30:50.000Z",
    });
    expect(result).toMatchObject({ status: "available", backend: "azure_monitor", spanCount: 2, rawViewerUrl: null });
    expect(result.spans).toEqual(expect.arrayContaining([
      expect.objectContaining({ spanId: rootSpanId, depth: 0, durationMs: 10.25 }),
      expect.objectContaining({ spanId: callerSpanId, depth: 1, status: "error", operationName: "Platform operation", serviceName: "Platform" }),
    ]));
    expect(JSON.stringify(result)).not.toMatch(/sensitive request text|unexpected service value|another run/);
  });

  it("uses the stored parent for native spans on the same trace and keeps a separate operation separate", async () => {
    const configured = { ...env, FOUNDRY_TRACE_BINDING_JSON: JSON.stringify(binding) };
    const query = vi.fn<ApplicationInsightsQuery>(async () => ({ rows: [], partial: false }))
      .mockResolvedValueOnce({ rows: platformRows, partial: false })
      .mockResolvedValueOnce({ rows: native(), partial: false })
      .mockResolvedValueOnce({ rows: platformRows, partial: false })
      .mockResolvedValueOnce({ rows: native(linkedTraceId, null), partial: false });

    const shared = await readAzureTrace(traceId, tenantId, authorized(), configured, query, now);
    expect(shared.spans).toEqual(expect.arrayContaining([
      expect.objectContaining({ spanId: invocationSpanId, parentSpanId: callerSpanId, source: "foundry", depth: 2 }),
      expect.objectContaining({ spanId: nativeChildId, parentSpanId: invocationSpanId, depth: 3, durationMs: 25 }),
    ]));
    expect(shared.foundry).toEqual([expect.objectContaining({ status: "available", spans: [], traceId })]);

    const separate = await readAzureTrace(traceId, tenantId, authorized(), configured, query, now);
    expect(separate.spanCount).toBe(2);
    expect(separate.foundry).toEqual([
      expect.objectContaining({
        status: "available", traceId: linkedTraceId,
        spans: expect.arrayContaining([expect.objectContaining({ spanId: invocationSpanId, parentSpanId: null, depth: 0 })]),
      }),
    ]);
    const published = JSON.stringify(separate);
    expect(published).not.toContain(foundryLink.responseId);
    expect(published).not.toContain("provider-sensitive label");
  });

  it("does not query an unapproved resource, an expired qualification, or synthetic-only production data", async () => {
    const query = vi.fn<ApplicationInsightsQuery>(async () => ({ rows: platformRows, partial: false }));
    const production = { ...env, SECURITY_PROFILE: "production", FOUNDRY_TRACE_BINDING_JSON: JSON.stringify(binding) };
    const expired = { ...production, FOUNDRY_TRACE_BINDING_JSON: JSON.stringify({
      ...binding, contentIsolation: "verified", qualificationExpiresAt: "2020-01-01T00:00:00Z",
    }) };
    const wrongResource = authorized([{ ...foundryLink, applicationInsightsResourceId: resourcePrefix + "unapproved" }]);
    const cases = [[authorized(), production], [authorized(), expired], [wrongResource, {
      ...env, FOUNDRY_TRACE_BINDING_JSON: JSON.stringify(binding),
    }]] as const;
    for (const [authority, config] of cases) {
      const result = await readAzureTrace(traceId, tenantId, authority, config, query, now);
      expect(result.foundry?.[0]?.status).toBe("unavailable");
      expect(result.spanCount).toBe(2);
    }
    expect(query.mock.calls.map(([resource]) => resource)).toEqual(Array(3).fill(platformResource));
  });

  it("retains platform spans when native matching is ambiguous or unavailable", async () => {
    const query = vi.fn<ApplicationInsightsQuery>()
      .mockResolvedValueOnce({ rows: platformRows, partial: true })
      .mockResolvedValueOnce({ rows: [...native(), ...native(linkedTraceId, null)], partial: false })
      .mockResolvedValueOnce({ rows: platformRows, partial: false })
      .mockRejectedValueOnce(new Error("native query rejected"));
    const configured = { ...env, FOUNDRY_TRACE_BINDING_JSON: JSON.stringify(binding) };
    const ambiguous = await readAzureTrace(traceId, tenantId, authorized(), configured, query, now);
    expect(ambiguous).toMatchObject({ status: "partial", spanCount: 2, foundry: [{ status: "uncorrelated" }] });
    const unavailable = await readAzureTrace(traceId, tenantId, authorized(), configured, query, now);
    expect(unavailable).toMatchObject({ status: "available", spanCount: 2, foundry: [{ status: "unavailable" }] });
  });

  it("distinguishes unsampled, expired, and pending traces and refuses graph cycles", async () => {
    const query = vi.fn<ApplicationInsightsQuery>().mockResolvedValue({ rows: [], partial: false });
    const unsampled = azureTraceAuthority({ roots: [{ ...roots[0], sampled: false }] });
    expect(await readAzureTrace(traceId, tenantId, unsampled, env, query, now)).toMatchObject({ status: "not_sampled" });
    expect(await readAzureTrace(traceId, tenantId, authorized([]), env, query, now + 31 * 86400000)).toMatchObject({ status: "expired" });
    expect(query).not.toHaveBeenCalled();
    expect(await readAzureTrace(traceId, tenantId, authorized([]), env, query, now)).toMatchObject({ status: "pending" });
    query.mockResolvedValueOnce({ rows: [span(rootSpanId, callerSpanId), span(callerSpanId, rootSpanId)], partial: false });
    await expect(readAzureTrace(traceId, tenantId, authorized([]), env, query, now)).rejects.toMatchObject({ code: "trace.parent_cycle" });
  });
});

describe("Azure trace transport", () => {
  it("never requests Azure credentials or telemetry before control-api authority", async () => {
    const upstream = vi.fn<Upstream>().mockResolvedValue({ status: 403, body: { error: "authorization.denied" } });
    const traceFetch = vi.fn<typeof fetch>();
    const token = vi.spyOn(ManagedIdentityCredential.prototype, "getToken");
    const app = buildApp({
      env, upstream, traceFetch,
      principalResolver: { source: "local", resolve: async () => ({ source: "local", subjectId: "operator", tenantId, actorType: "human", roles: ["Harness.Operator"] }) },
    });
    try {
      expect((await app.inject(`/api/v1/traces/${traceId}`)).statusCode).toBe(404);
      expect((await app.inject(`/api/v1/traces/${"0".repeat(32)}`)).statusCode).toBe(404);
      expect(upstream).toHaveBeenCalledOnce();
      expect(token).not.toHaveBeenCalled();
      expect(traceFetch).not.toHaveBeenCalled();
    } finally {
      await app.close();
      token.mockRestore();
    }
  });

  it("uses the deployed managed identity and fixed resource endpoint and decodes partial responses", async () => {
    const token = vi.spyOn(ManagedIdentityCredential.prototype, "getToken")
      .mockResolvedValue({ token: "managed-token", expiresOnTimestamp: now + 60000 });
    const traceFetch = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify({
      error: { code: "PartialError" },
      tables: [{ columns: [{ name: "SpanId" }], rows: [[rootSpanId]] }],
    }))).mockResolvedValueOnce(new Response(null, { status: 429 }));
    try {
      const query = createApplicationInsightsQuery(env, traceFetch);
      const window = { startTime: startedAt, endTime: completedAt };
      expect(await query(platformResource, "requests | take 1", window)).toEqual({ rows: [{ SpanId: rootSpanId }], partial: true });
      expect(token).toHaveBeenCalledWith("https://api.loganalytics.io/.default", expect.objectContaining({ abortSignal: expect.any(AbortSignal) }));
      expect(traceFetch).toHaveBeenCalledWith(`https://api.loganalytics.azure.com/v1${platformResource}/query`, expect.objectContaining({
        method: "POST", redirect: "error", headers: expect.objectContaining({ authorization: "Bearer managed-token" }),
      }));
      await expect(query(platformResource, "requests | take 1", window)).rejects.toMatchObject({ code: "trace.reader_busy" });
      expect(applicationInsightsResourceId(resourcePrefix + "..")).toBe(false);
      await expect(query(resourcePrefix + "../other", "requests | take 1", window)).rejects.toMatchObject({ code: "trace.reader_configuration_invalid" });
      expect(traceFetch).toHaveBeenCalledTimes(2);
    } finally {
      token.mockRestore();
    }
  });
});
