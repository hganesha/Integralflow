import { describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { observabilityChecks, registerObservabilityExperience } from "./observability-experience.js";
import { overallReadiness } from "@ehf/contracts/platform-health";
import { telemetryComponents } from "./system.js";

const resourceId = "/subscriptions/11111111-1111-4111-8111-111111111111/resourceGroups/ehf/providers/Microsoft.Insights/components/platform";
const env = {
  SECURITY_PROFILE: "production",
  BFF_TRACE_BACKEND: "azure_monitor",
  BFF_TRACE_APP_INSIGHTS_RESOURCE_ID: resourceId,
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://collector.example.com/v1/traces",
};

describe("deployed observability verification", () => {
  it("keeps Collector acceptance, Azure authorization and span ingestion distinct", async () => {
    let now = Date.parse("2026-11-12T20:30:00.000Z");
    let ingested = false;
    const transport = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));
    const query = vi.fn(async (_resource: string, kql: string) => {
      if (kql.endsWith("| count")) return { rows: [{ Count: 0 }], partial: false };
      const sent = JSON.parse(String(transport.mock.calls[0]?.[1]?.body));
      const span = sent.resourceSpans[0].scopeSpans[0].spans[0];
      expect(kql).toContain(span.traceId);
      expect(kql).toContain(span.spanId);
      return { rows: ingested ? [{ operation_Id: span.traceId, id: span.spanId }] : [], partial: false };
    });
    const service = observabilityChecks(env, transport, query, () => now);
    const view = await service.verify();
    expect(view.checks.map(item => [item.id, item.state])).toEqual([
      ["receiver", "passed"], ["query", "passed"], ["ingestion", "pending"],
    ]);
    expect(query).toHaveBeenCalledTimes(2);
    expect(await service.verify()).toEqual(view);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(await service.refresh()).toEqual(view);
    expect(query).toHaveBeenCalledTimes(2);
    now += 16_000;
    ingested = true;
    expect((await service.refresh()).checks[2]).toMatchObject({ state: "passed" });
  });

  it("blocks unqualified Foundry candidates and separates collector and reader failures", async () => {
    const transport = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));
    const query = vi.fn(async () => { throw new Error("denied"); });
    const service = observabilityChecks({
      ...env,
      BFF_TRACE_FOUNDRY_CANDIDATE_JSON: JSON.stringify({ projectEndpoint: "https://foundry.services.ai.azure.com/api/projects/demo", agentName: "pilot", agentVersion: "1", applicationInsightsResourceId: resourceId + "-foundry" }),
    }, transport, query);
    expect((await service.verify()).checks.map(item => item.state)).toEqual(["passed", "failed", "failed", "blocked", "blocked"]);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("tests native query access only while the isolated destination is qualified", async () => {
    let now = Date.parse("2026-11-12T20:30:00.000Z");
    const foundryResource = resourceId + "-foundry";
    const query = vi.fn(async (component: string, kql: string) => {
      if (component === foundryResource) throw new Error("denied");
      return { rows: kql.endsWith("| count") ? [{ Count: 0 }] : [], partial: false };
    });
    const service = observabilityChecks({
      ...env,
      FOUNDRY_TRACE_BINDING_JSON: JSON.stringify({
        tenantId: "tenant-a", projectEndpoint: "https://foundry.services.ai.azure.com/api/projects/demo",
        agentName: "pilot", agentVersion: "1", applicationInsightsResourceId: foundryResource,
        contentIsolation: "verified", qualificationExpiresAt: "2026-11-12T20:31:00.000Z",
      }),
    }, async () => new Response(null, { status: 200 }), query, () => now);
    const view = await service.verify();
    expect(view.checks.find(check => check.id === "foundry")).toMatchObject({ state: "passed" });
    expect(view.checks.find(check => check.id === "foundry-query")).toMatchObject({ state: "failed" });
    expect(query.mock.calls.filter(([component]) => component === foundryResource)).toHaveLength(1);
    now += 60_000;
    expect((await service.refresh()).checks.find(check => check.id === "foundry-query")).toMatchObject({ state: "blocked", checkedAt: null });
  });

  it("requires interactive administration and CSRF before a verification can export", async () => {
    const app = Fastify();
    let roles = ["Case.Analyst"];
    let csrf = false;
    const transport = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));
    const query = vi.fn(async () => ({ rows: [{ Count: 0 }], partial: false }));
    registerObservabilityExperience(app, {
      resolver: { source: "local", resolve: async () => ({ tenantId: "test", subjectId: "user", actorType: "human", source: "local", roles }) },
      csrf: () => csrf,
      authorization: () => undefined,
    }, observabilityChecks(env, transport, query));
    try {
      const read = () => app.inject("/api/v1/admin/observability");
      const verify = () => app.inject({ method: "POST", url: "/api/v1/admin/observability/verify", payload: { reason: "check telemetry" } });
      expect((await read()).statusCode).toBe(403);
      expect((await verify()).statusCode).toBe(403);
      roles = ["Platform.Admin"];
      expect((await read()).statusCode).toBe(200);
      expect((await verify()).json().error).toBe("csrf.invalid");
      expect(transport).not.toHaveBeenCalled();
      csrf = true;
      expect((await verify()).statusCode).toBe(200);
      expect(transport).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it("counts only telemetry checks that have a result toward platform readiness", () => {
    const check = (id: string, state: "not_configured" | "unverified" | "pending" | "passed" | "failed" | "blocked") =>
      ({ id, label: id, state, detail: "", checkedAt: null });
    // A freshly started process: nothing has been verified yet, so telemetry says nothing.
    const fresh = telemetryComponents([check("receiver", "unverified"), check("query", "unverified"), check("ingestion", "pending"), check("foundry-query", "not_configured")]);
    expect(fresh).toEqual([]);
    expect(overallReadiness(fresh)).toBe("Ready");
    const verified = telemetryComponents([check("receiver", "passed"), check("query", "passed"), check("ingestion", "failed"), check("foundry", "blocked")]);
    expect(verified.map(item => [item.id, item.status])).toEqual([
      ["telemetry-query", "Ready"], ["telemetry-ingestion", "Degraded"], ["telemetry-foundry", "Degraded"],
    ]);
    expect(overallReadiness(verified)).toBe("Degraded");
  });
});
