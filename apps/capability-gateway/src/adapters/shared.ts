import type { ProviderRecord } from "@ehf/contracts";
import { allowsInsecureEndpoints } from "@ehf/identity";
import { getProvider } from "@ehf/persistence";
import { SpanKind, withSpan } from "@ehf/telemetry";
import type { AdapterModuleDeps } from "./types.js";

export type KycService = "wiring" | "evidence";

export function kycServiceSettings(env: NodeJS.ProcessEnv, service: KycService) {
  return service === "wiring"
    ? { url: env.KYC_WIRING_URL?.trim() ?? "", token: env.KYC_WIRING_TOKEN?.trim() ?? "" }
    : { url: env.EVIDENCE_PIPELINE_URL?.trim() ?? "", token: env.EVIDENCE_PIPELINE_TOKEN?.trim() ?? "" };
}

/**
 * Whether a KYC service is usable from this gateway. Its URL and token exist only in the
 * gateway's environment; the production profile accepts only an https endpoint.
 */
export function kycServiceState(env: NodeJS.ProcessEnv, service: KycService): "Configured" | "Missing" {
  const { url, token } = kycServiceSettings(env, service);
  if (!url || !token) return "Missing";
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) return "Missing";
    if (!allowsInsecureEndpoints(env) && parsed.protocol !== "https:") return "Missing";
  } catch {
    return "Missing";
  }
  return "Configured";
}

export function credentialFor(provider: { credentialRef: string | null } | null | undefined, env: NodeJS.ProcessEnv) {
  if (!provider?.credentialRef) return undefined;
  const value = env[provider.credentialRef];
  return value && value.trim() ? value : undefined;
}

/**
 * Base URL of an OpenAI-compatible endpoint: the administered provider binding, else the
 * deployment fallback. Any OpenAI-compatible server works -- a hosted API, a cloud model
 * service in its OpenAI-compatible mode, or a self-hosted vLLM/TEI/Ollama instance.
 */
export function resolveOpenAICompatibleEndpoint(
  provider: ProviderRecord | null | undefined,
  env: NodeJS.ProcessEnv,
  fallbackEnv: string,
): URL {
  if (provider && provider.kind !== "openai_compatible" && provider.kind !== "openrouter") throw new Error("gateway.embedding_provider_kind_invalid");
  if (provider?.status === "disabled") throw new Error("gateway.embedding_provider_disabled");
  const value = provider?.baseUrl ?? env[fallbackEnv];
  if (!value) throw new Error("gateway.embedding_endpoint_missing");
  let endpoint: URL;
  try { endpoint = new URL(value); } catch { throw new Error("gateway.embedding_endpoint_invalid"); }
  const local = allowsInsecureEndpoints(env) && endpoint.protocol === "http:";
  if ((!local && endpoint.protocol !== "https:") || endpoint.username || endpoint.password || endpoint.hash) {
    throw new Error("gateway.embedding_endpoint_invalid");
  }
  return endpoint;
}

export function inputText(input: unknown) {
  const record = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const value = record.query ?? record.prompt ?? record.input ?? input;
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** The embedding model and provider binding the `pgvector` adapter embeds queries with. */
export function embeddingSettings(env: NodeJS.ProcessEnv) {
  return { model: env.EMBEDDING_MODEL ?? "text-embedding-3-small", providerId: env.EMBEDDING_PROVIDER ?? "embeddings" };
}

/**
 * Query embeddings from any OpenAI-compatible `/embeddings` endpoint, used by `pgvector`.
 * The provider binding is the live authority; `EMBEDDING_BASE_URL` is the deployment-time
 * fallback for a freshly migrated store. A key is sent when the binding names one; a
 * private endpoint inside the platform's network may need none.
 */
export function createEmbeddingClient(deps: Pick<AdapterModuleDeps, "db" | "env" | "fetch">) {
  const { db, env, fetch } = deps;
  const embedding = async (text: string, tenantId: string): Promise<number[]> => {
    const { model, providerId } = embeddingSettings(env);
    const provider = await getProvider(db, tenantId, providerId);
    return withSpan(`embeddings ${model}`, {
      kind: SpanKind.CLIENT,
      attributes: {
        "gen_ai.operation.name": "embeddings",
        "gen_ai.provider.name": "openai_compatible",
        "gen_ai.request.model": model,
      },
    }, async (span) => {
      const base = resolveOpenAICompatibleEndpoint(provider, env, "EMBEDDING_BASE_URL");
      const endpoint = new URL("embeddings", `${base.toString().replace(/\/$/, "")}/`);
      const key = credentialFor(provider, env) ?? (provider ? undefined : env.EMBEDDING_API_KEY?.trim() || undefined);
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), "content-type": "application/json" },
        body: JSON.stringify({ model, input: text }),
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error(`gateway.embedding_http_${response.status}`);
      const payload = await response.json() as { data?: Array<{ embedding?: unknown }> };
      const vector = payload.data?.[0]?.embedding;
      if (!Array.isArray(vector) || vector.length !== 1536 || vector.some((value) => typeof value !== "number")) throw new Error("gateway.embedding_invalid");
      span.setAttribute("harness.outcome", "SUCCEEDED");
      return vector as number[];
    });
  };
  return { embedding };
}
