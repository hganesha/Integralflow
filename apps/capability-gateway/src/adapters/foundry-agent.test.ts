import { describe, expect, it, vi } from "vitest";
import type { CapabilityDefinition } from "@ehf/contracts";
import type { FoundryTraceBinding } from "@ehf/contracts/foundry";
import type { Database } from "@ehf/persistence";
import { createFoundryAgentAdapter, FOUNDRY_AGENT_CAPABILITY } from "./foundry-agent.js";

const traceId = "a".repeat(32);
const spanId = "b".repeat(16);
const traceparent = `00-${traceId}-${spanId}-01`;
const traceState = vi.hoisted(() => ({
  span: { setAttributes: vi.fn(), setStatus: vi.fn() },
  inject: vi.fn(),
}));

vi.mock("@ehf/telemetry", () => ({
  withSpan: async (_name: unknown, _options: unknown, callback: (span: typeof traceState.span) => unknown) => callback(traceState.span),
  traceReference: () => ({ traceId, spanId }),
  injectTraceContext: (headers: Record<string, string>) => {
    traceState.inject(headers);
    Object.assign(headers, { traceparent, tracestate: "ehf=value", baggage: "subject=secret" });
  },
  SpanKind: { CLIENT: 2 },
  SpanStatusCode: { OK: 1 },
}));

const appInsights = "/subscriptions/11111111-2222-3333-4444-555555555555/resourceGroups/pilot/providers/Microsoft.Insights/components/agents";
const binding: FoundryTraceBinding = {
  projectEndpoint: "https://example.services.ai.azure.com/api/projects/pilot",
  agentName: "trace-probe",
  agentVersion: "2",
  applicationInsightsResourceId: appInsights,
  tenantId: "authorized-tenant",
  contentIsolation: "verified",
  qualificationExpiresAt: new Date(Date.now() + 60_000).toISOString(),
};

const capability: CapabilityDefinition = {
  id: FOUNDRY_AGENT_CAPABILITY,
  kind: "model",
  effect: "paid",
  adapterBindingId: "foundry-agent:trace-probe",
  inputSchema: {},
  outputSchema: {},
  timeoutMs: 1000,
  maxAttempts: 1,
  idempotent: false,
};

function fixture(overrides: Partial<FoundryTraceBinding> = {}, data: {
  destination?: string; tools?: unknown[]; responseStatus?: string; responseAgent?: { name: string; version: string } | null;
} = {}) {
  const env = { FOUNDRY_TRACE_BINDING_JSON: JSON.stringify({ ...binding, ...overrides }), SECURITY_PROFILE: "production" };
  const fetch = vi.fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(Response.json({ value: [{ type: "AppInsights", isDefault: false, target: data.destination ?? appInsights }] }))
    .mockResolvedValueOnce(Response.json({ name: binding.agentName, version: binding.agentVersion,
      definition: { kind: "prompt", model: "gpt-test", tools: data.tools ?? [] } }))
    .mockResolvedValueOnce(Response.json({ id: "resp_test", status: data.responseStatus ?? "completed",
      ...(data.responseAgent === null ? {} : { agent_reference: {
        type: "agent_reference", ...(data.responseAgent ?? { name: binding.agentName, version: binding.agentVersion }),
      } }),
      usage: { input_tokens: 3, output_tokens: 2 },
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "agent result" }] }] }));
  const token = vi.fn().mockResolvedValue("synthetic-bearer");
  const adapter = createFoundryAgentAdapter({
    env, fetch, db: {} as Database, modelProfilesPath: "",
    workloadToken: async () => "platform-token",
    delegate: async () => { throw new Error("not applicable"); },
  }, token);
  const link = vi.fn();
  const dispatch = vi.fn();
  return { adapter, fetch, link, token, dispatch, context: {
    tenantId: binding.tenantId, onFoundryDispatch: dispatch, recordFoundryInvocationLink: link,
  } };
}

describe("Foundry prompt-agent gateway adapter", () => {
  it("sends one pinned Responses request with W3C context and captures restricted linkage", async () => {
    const f = fixture();
    f.adapter.assertCapability(capability);
    const result = await f.adapter.invoke(binding.agentName, capability, { prompt: "case input" }, f.context);
    expect(result).toEqual({ output: { text: "agent result" }, provider: "azure_foundry_agents",
      model: "gpt-test", providerRequestId: null, inputTokens: 3, outputTokens: 2, costUsd: null });
    expect(f.fetch).toHaveBeenCalledTimes(3);
    const [url, init] = f.fetch.mock.calls[2]!;
    expect(url).toBe(`${binding.projectEndpoint}/openai/v1/responses`);
    expect(new Headers(init?.headers).get("traceparent")).toBe(traceparent);
    expect(new Headers(init?.headers).get("tracestate")).toBe("ehf=value");
    expect(new Headers(init?.headers).has("baggage")).toBe(false);
    expect(JSON.parse(init?.body as string)).toEqual({
      agent_reference: { type: "agent_reference", name: binding.agentName, version: binding.agentVersion },
      input: [{ role: "user", content: "case input" }],
    });
    expect(init?.redirect).toBe("error");
    expect(f.dispatch).toHaveBeenCalledOnce();
    expect(f.link).toHaveBeenCalledWith(expect.objectContaining({
      traceId, parentSpanId: spanId, responseId: "resp_test", applicationInsightsResourceId: appInsights,
      projectEndpoint: binding.projectEndpoint, agentVersion: "2",
    }));
    expect(JSON.stringify(traceState.span.setAttributes.mock.calls)).not.toContain("case input");
    expect(JSON.stringify(traceState.span.setAttributes.mock.calls)).not.toContain("agent result");
    expect(JSON.stringify(traceState.span.setAttributes.mock.calls)).not.toContain("resp_test");
  });

  it("fails before authentication for another tenant or an expired or synthetic-only production qualification", async () => {
    const wrongTenant = fixture();
    await expect(wrongTenant.adapter.invoke(binding.agentName, capability, { prompt: "anything" }, { tenantId: "other" }))
      .rejects.toThrow("gateway.foundry_agent_binding_unqualified");
    expect(wrongTenant.token).not.toHaveBeenCalled();
    for (const overrides of [{ contentIsolation: "synthetic_only" as const }, { qualificationExpiresAt: "2020-01-01T00:00:00Z" }]) {
      const f = fixture(overrides);
      expect((await f.adapter.descriptor(binding.tenantId)).bindingOptions).toEqual([]);
      await expect(f.adapter.invoke(binding.agentName, capability, { prompt: "anything" }, f.context))
        .rejects.toThrow("gateway.foundry_agent_binding_unqualified");
      expect(f.token).not.toHaveBeenCalled();
    }
  });

  it("blocks drifted trace destinations and provider tools before sending any input", async () => {
    const moved = fixture({}, { destination: `${appInsights}-other` });
    await expect(moved.adapter.invoke(binding.agentName, capability, { prompt: "case input" }, moved.context))
      .rejects.toThrow("gateway.foundry_agent_trace_destination_changed");
    expect(moved.fetch).toHaveBeenCalledTimes(1);
    const tools = fixture({}, { tools: [{ type: "web_search" }] });
    await expect(tools.adapter.invoke(binding.agentName, capability, { prompt: "case input" }, tools.context))
      .rejects.toThrow("gateway.foundry_agent_tools_not_admitted");
    expect(tools.fetch).toHaveBeenCalledTimes(2);
    expect(tools.dispatch).not.toHaveBeenCalled();
  });

  it("records returned response identity even when the provider result is incomplete", async () => {
    const f = fixture({}, { responseStatus: "incomplete" });
    await expect(f.adapter.invoke(binding.agentName, capability, { prompt: "case input" }, f.context))
      .rejects.toThrow("gateway.foundry_agent_response_invalid");
    expect(f.link).toHaveBeenCalledWith(expect.objectContaining({ responseId: "resp_test" }));
  });

  it("rejects responses that omit or change the pinned agent identity", async () => {
    for (const responseAgent of [null, { name: "other-agent", version: "2" }, { name: binding.agentName, version: "3" }]) {
      const f = fixture({}, { responseAgent });
      await expect(f.adapter.invoke(binding.agentName, capability, { prompt: "case input" }, f.context))
        .rejects.toThrow("gateway.foundry_agent_response_version_mismatch");
      expect(f.dispatch).toHaveBeenCalledOnce();
      expect(f.link).not.toHaveBeenCalled();
    }
  });
});
