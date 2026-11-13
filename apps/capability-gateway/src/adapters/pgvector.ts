import { createContextStore, searchKnowledge, type ContextStore } from "@ehf/context-store";
import { getProvider } from "@ehf/persistence";
import { createEmbeddingClient, embeddingSettings, inputText, resolveOpenAICompatibleEndpoint } from "./shared.js";
import type { CapabilityAdapterModule } from "./types.js";

/**
 * Tenant-scoped similarity search over the context store's retrieval index (ehf_context,
 * context.knowledge_chunks), with the query embedded by the administered OpenAI-compatible
 * embedding endpoint. The gateway has no access to the case database.
 */
export const pgvectorModule: CapabilityAdapterModule = {
  id: "pgvector",
  cloud: "any",
  label: "PostgreSQL vector search",
  supportedKinds: ["tool"],
  enabledByDefault: true,
  create: (deps) => {
    const { db, env } = deps;
    const embeddings = createEmbeddingClient(deps);
    let contextStore: ContextStore | undefined;
    return {
      descriptor: async (tenantId) => {
        const provider = await getProvider(db, tenantId, embeddingSettings(env).providerId);
        let endpointConfigured = true;
        try { resolveOpenAICompatibleEndpoint(provider, env, "EMBEDDING_BASE_URL"); } catch { endpointConfigured = false; }
        return {
          id: "pgvector", label: "PostgreSQL vector search", supportedKinds: ["tool"],
          credentialState: env.CONTEXT_DATABASE_URL && endpointConfigured ? "Configured" : "Missing",
          bindingOptions: [{ value: "knowledge.search", label: "Knowledge similarity search", description: "Embeds the query with the administered embedding endpoint and searches tenant-scoped case knowledge." }],
        };
      },
      invoke: async (_bindingName, _capability, input, context) => {
        const connectionString = env.CONTEXT_DATABASE_URL;
        if (!connectionString) throw new Error("gateway.vector_database_missing");
        contextStore ??= createContextStore({ connectionString });
        const query = inputText(input).trim();
        if (!query || query.length > 8_000) throw new Error("gateway.vector_query_invalid");
        const record = input && typeof input === "object" ? input as Record<string, unknown> : {};
        const topK = typeof record.topK === "number" && Number.isInteger(record.topK) ? Math.min(20, Math.max(1, record.topK)) : 5;
        const vector = await embeddings.embedding(query, context.tenantId);
        const matches = await searchKnowledge(contextStore, context.tenantId, vector, topK);
        return { output: { query, matches: matches.map((match) => ({ chunkId: match.chunkId, sourceUri: match.sourceRef, sourceKind: match.sourceKind, title: match.title, content: match.content, metadata: match.metadata, similarity: match.similarity })) }, provider: "postgresql", model: embeddingSettings(env).model, providerRequestId: null, inputTokens: null, outputTokens: null, costUsd: null };
      },
    };
  },
};
