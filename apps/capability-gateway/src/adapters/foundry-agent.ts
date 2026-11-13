import { ManagedIdentityCredential } from "@azure/identity";
import {
  FOUNDRY_AGENT_NAME_PATTERN,
  foundryAgentNameSchema,
  foundryAgentVersionSchema,
  foundryResponseIdSchema,
  foundryTraceBindingSchema,
  isFoundryTraceBindingQualified,
  type FoundryTraceBinding,
} from "@ehf/contracts/foundry";
import { isProductionProfile } from "@ehf/identity";
import { injectTraceContext, SpanKind, SpanStatusCode, traceReference, withSpan } from "@ehf/telemetry";
import { z } from "zod";
import type { AdapterModuleDeps, CapabilityAdapterModule } from "./types.js";

export const FOUNDRY_AGENT_ADAPTER = "foundry-agent";
export const FOUNDRY_AGENT_CAPABILITY = "foundry.agent.prompt.v1";
const SYNTHETIC_PROMPT = "Reply with the synthetic Foundry trace verification result.";
const MODEL_NAME = /^[a-z0-9][a-z0-9_.-]{0,127}$/i;
const CLIENT_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const MAX_RESPONSE_BYTES = 256 * 1024;
const promptSchema = z.object({ prompt: z.string().min(1).max(32768) }).strict();
const responseAgentSchema = z.object({ agent_reference: z.object({
  type: z.literal("agent_reference"),
  name: foundryAgentNameSchema,
  version: foundryAgentVersionSchema,
}) });
const responseSchema = z.object({
  id: foundryResponseIdSchema,
  status: z.literal("completed"),
  output: z.array(z.object({
    type: z.string(),
    role: z.string().optional(),
    content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional(),
  })).max(32),
  usage: z.object({ input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative() }).nullish(),
});

function readBinding(env: NodeJS.ProcessEnv): FoundryTraceBinding | null {
  if (!env.FOUNDRY_TRACE_BINDING_JSON) return null;
  try {
    return foundryTraceBindingSchema.parse(JSON.parse(env.FOUNDRY_TRACE_BINDING_JSON));
  } catch {
    return null;
  }
}

async function boundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("gateway.foundry_agent_response_invalid");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new Error("gateway.foundry_agent_response_too_large");
      chunks.push(chunk.value);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    } catch {
      throw new Error("gateway.foundry_agent_response_invalid");
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

async function foundryRequest(
  fetcher: typeof globalThis.fetch, url: string, init: RequestInit,
  signal: AbortSignal,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetcher(url, { ...init, signal, redirect: "error" });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("gateway.source_policy_denied:")) throw error;
    throw new Error(signal.aborted ? "gateway.foundry_agent_timeout" : "gateway.foundry_agent_transport_failed");
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`gateway.foundry_agent_http_${response.status}`);
  }
  try {
    return await boundedJson(response);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("gateway.foundry_agent_response_")) throw error;
    throw new Error(signal.aborted ? "gateway.foundry_agent_timeout" : "gateway.foundry_agent_transport_failed");
  }
}

async function verifiedModel(
  deps: AdapterModuleDeps, binding: FoundryTraceBinding, agentPath: string,
  token: string, signal: AbortSignal,
) {
  const connections = await foundryRequest(
    deps.fetch, `${binding.projectEndpoint}/connections?api-version=v1&connectionType=AppInsights`,
    { method: "GET", headers: { authorization: `Bearer ${token}` } }, signal,
  );
  const connection = z.object({ value: z.tuple([z.object({
    type: z.literal("AppInsights"),
    target: z.string(),
  })]), nextLink: z.string().nullable().optional() }).safeParse(connections);
  if (!connection.success || connection.data.nextLink || connection.data.value[0].target.toLowerCase() !== binding.applicationInsightsResourceId.toLowerCase()) {
    throw new Error("gateway.foundry_agent_trace_destination_changed");
  }
  const metadata = await foundryRequest(
    deps.fetch, `${agentPath}/versions/${binding.agentVersion}?api-version=v1`,
    { method: "GET", headers: { authorization: `Bearer ${token}` } }, signal,
  );
  const version = z.object({
    version: z.literal(binding.agentVersion),
    name: z.literal(binding.agentName),
    definition: z.object({ kind: z.literal("prompt"), model: z.string().regex(MODEL_NAME) }).passthrough(),
  }).safeParse(metadata);
  if (!version.success) throw new Error("gateway.foundry_agent_version_mismatch");
  const definition = version.data.definition;
  // This gateway capability budgets a single model request. A prompt agent with provider-hosted
  // tools or a different harness could take external actions beyond its admitted capability.
  if (definition.harness != null || definition.toolsets != null
    || (definition.tools != null && (!Array.isArray(definition.tools) || definition.tools.length !== 0))) {
    throw new Error("gateway.foundry_agent_tools_not_admitted");
  }
  return definition.model;
}

export function createFoundryAgentAdapter(
  deps: AdapterModuleDeps,
  accessToken?: (signal: AbortSignal) => Promise<string>,
) {
  const binding = readBinding(deps.env);
  const clientId = deps.env.FOUNDRY_AGENT_MANAGED_IDENTITY_CLIENT_ID;
  const credential = clientId && CLIENT_ID.test(clientId) ? new ManagedIdentityCredential({ clientId }) : null;
  const production = isProductionProfile(deps.env) || deps.env.RELEASE_ENVIRONMENT === "production";
  const configured = (tenantId: string) => binding !== null && binding.tenantId === tenantId
    && Boolean(credential || accessToken) && isFoundryTraceBindingQualified(binding, production);
  return {
    descriptor: async (tenantId: string) => ({
      id: FOUNDRY_AGENT_ADAPTER,
      label: "Azure Foundry prompt agent",
      supportedKinds: ["model"],
      credentialState: configured(tenantId) ? "Configured" : "Missing",
      bindingOptions: configured(tenantId) ? [{ value: binding!.agentName, label: binding!.agentName }] : [],
    }),
    assertCapability: (capability) => {
      if (capability.id !== FOUNDRY_AGENT_CAPABILITY || capability.kind !== "model" || capability.effect !== "paid"
        || capability.maxAttempts !== 1 || capability.idempotent) throw new Error("gateway.foundry_agent_capability_invalid");
    },
    invoke: async (name, capability, input, context) => {
      if (!binding || name !== binding.agentName || !configured(context.tenantId)) throw new Error("gateway.foundry_agent_binding_unqualified");
      const parsed = promptSchema.safeParse(input);
      if (!parsed.success) throw new Error("gateway.foundry_agent_input_invalid");
      const prompt = parsed.data.prompt;
      if (binding.contentIsolation === "synthetic_only" && prompt !== SYNTHETIC_PROMPT) {
        throw new Error("gateway.foundry_agent_synthetic_input_required");
      }
      const timeout = AbortSignal.timeout(Math.min(capability.timeoutMs, 90_000));
      const signal = context.signal ? AbortSignal.any([context.signal, timeout]) : timeout;
      let token: string | undefined;
      try {
        token = accessToken ? await accessToken(signal)
          : (await credential?.getToken("https://ai.azure.com/.default", { abortSignal: signal }))?.token;
      } catch {
        throw new Error("gateway.foundry_agent_identity_unavailable");
      }
      if (!token) throw new Error("gateway.foundry_agent_identity_unavailable");
      const agentPath = `${binding.projectEndpoint}/agents/${binding.agentName}`;
      const model = await verifiedModel(deps, binding, agentPath, token, signal);
      // Qualification may expire while identity and version checks are in flight.
      if (!configured(context.tenantId)) throw new Error("gateway.foundry_agent_binding_unqualified");
      return withSpan("foundry.agent.invoke", { kind: SpanKind.CLIENT, attributes: {
        "gen_ai.provider.name": "azure.ai.foundry",
        "gen_ai.operation.name": "invoke_agent",
        "gen_ai.request.model": model,
      } }, async span => {
        const carrier: Record<string, string> = {};
        injectTraceContext(carrier);
        const startedAt = new Date().toISOString();
        context.onFoundryDispatch?.();
        const raw = await foundryRequest(deps.fetch, `${binding.projectEndpoint}/openai/v1/responses`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            ...(carrier.traceparent ? { traceparent: carrier.traceparent } : {}),
            ...(carrier.tracestate ? { tracestate: carrier.tracestate } : {}),
          },
          body: JSON.stringify({
            agent_reference: { type: "agent_reference", name: binding.agentName, version: binding.agentVersion },
            input: [{ role: "user", content: prompt }],
          }),
        }, signal);
        const completedAt = new Date().toISOString();
        const responseAgent = responseAgentSchema.safeParse(raw);
        if (!responseAgent.success || responseAgent.data.agent_reference.name !== binding.agentName ||
            responseAgent.data.agent_reference.version !== binding.agentVersion) {
          throw new Error("gateway.foundry_agent_response_version_mismatch");
        }
        const reference = traceReference(span);
        const responseId = z.object({ id: foundryResponseIdSchema }).safeParse(raw);
        const hasReference = /^[a-f0-9]{32}$/.test(reference.traceId) && !/^0+$/.test(reference.traceId)
          && /^[a-f0-9]{16}$/.test(reference.spanId) && !/^0+$/.test(reference.spanId);
        if (hasReference && responseId.success) context.recordFoundryInvocationLink?.({
          projectEndpoint: binding.projectEndpoint,
          agentName: binding.agentName,
          agentVersion: binding.agentVersion,
          applicationInsightsResourceId: binding.applicationInsightsResourceId,
          traceId: reference.traceId,
          parentSpanId: reference.spanId,
          responseId: responseId.data.id,
          startedAt,
          completedAt,
        });
        const response = responseSchema.safeParse(raw);
        if (!response.success || response.data.output.some(item => !["message", "reasoning"].includes(item.type))) {
          throw new Error("gateway.foundry_agent_response_invalid");
        }
        const text = response.data.output.flatMap(item => item.type === "message" && item.role === "assistant"
          ? item.content?.filter(part => part.type === "output_text").map(part => part.text ?? "") ?? []
          : []).join("\n");
        if (!text) throw new Error("gateway.foundry_agent_response_invalid");
        const inputTokens = response.data.usage?.input_tokens ?? null;
        const outputTokens = response.data.usage?.output_tokens ?? null;
        span.setAttributes({
          ...(inputTokens === null ? {} : { "gen_ai.usage.input_tokens": inputTokens }),
          ...(outputTokens === null ? {} : { "gen_ai.usage.output_tokens": outputTokens }),
        });
        span.setStatus({ code: SpanStatusCode.OK });
        return {
          output: { text },
          provider: "azure_foundry_agents",
          model,
          providerRequestId: null,
          inputTokens,
          outputTokens,
          costUsd: null,
        };
      });
    },
  } satisfies ReturnType<CapabilityAdapterModule["create"]>;
}

export const foundryAgentModule: CapabilityAdapterModule = {
  id: FOUNDRY_AGENT_ADAPTER,
  cloud: "vendor",
  label: "Azure Foundry prompt agent",
  supportedKinds: ["model"],
  enabledByDefault: false,
  connectorTemplate: {
    bindingPattern: FOUNDRY_AGENT_NAME_PATTERN,
    capabilityIds: [FOUNDRY_AGENT_CAPABILITY],
    configEnv: ["FOUNDRY_TRACE_BINDING_JSON", "FOUNDRY_AGENT_MANAGED_IDENTITY_CLIENT_ID"],
    description: "A deployment-qualified, version-pinned Azure Foundry prompt agent with no provider tools.",
  },
  create: createFoundryAgentAdapter,
};
