import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { connectorCatalogSchema, externalConnectionSaveSchema, externalProviderDraftSchema, type ExternalProviderDraft } from "@ehf/contracts";
import { createExternalProvider, ExternalProviderError, listExternalProviders, saveExternalConnection, type Database } from "@ehf/persistence";
import type { PlatformAction, Principal, ResourceRef } from "@ehf/identity";
import type { FastifyInstance, FastifyRequest } from "fastify";

type Sources = { providers: ExternalProviderDraft[]; quarantined?: string[]; templates: Array<{ adapterId: string; bindingPattern: string; capabilityIds: string[] }> };
let cached: Sources | undefined;
export function externalProviderSources(): Sources {
  if (cached) return cached;
  // Bundled services run in /app with config copied beside server.mjs. The source fallback
  // also supports pnpm's package working directory; tools/ is not shipped to production.
  const path = process.env.CONNECTOR_CATALOG_PATH ?? (existsSync(resolve("config/connector-catalog.json"))
    ? resolve("config/connector-catalog.json") : fileURLToPath(new URL("../../../config/connector-catalog.json", import.meta.url)));
  const catalog = connectorCatalogSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  const registered = new Map<string, ExternalProviderDraft>();
  for (const connector of catalog.connectors) if (connector.providerId && !registered.has(connector.providerId)) registered.set(connector.providerId, { id: connector.providerId, name: connector.providerName ?? connector.providerId, description: "" });
  return cached = { providers: [...registered.values()], quarantined: catalog.connectors.filter(connector => connector.status === "quarantined").flatMap(connector => connector.providerId ? [connector.providerId] : []), templates: catalog.connectorTemplates };
}

export function registerExternalProviderRoutes(app: FastifyInstance, options: {
  db: Database; authorize: (request: FastifyRequest, action: PlatformAction, resource?: ResourceRef) => Promise<Principal>;
  sources?: () => Sources;
}): void {
  const sources = options.sources ?? externalProviderSources;
  app.get("/v1/external-providers", async request => {
    const principal = await options.authorize(request, "capability.read", { kind: "external-provider" });
    return { providers: await listExternalProviders(options.db, principal.tenantId) };
  });
  app.post("/v1/external-providers", async (request, reply) => {
    const principal = await options.authorize(request, "admin.write", { kind: "external-provider" });
    const parsed = externalProviderDraftSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "external_provider.invalid" });
    if (sources().providers.some(provider => provider.id === parsed.data.id)) return reply.code(409).send({ error: "external_provider.already_exists" });
    try {
      await createExternalProvider(options.db, { tenantId: principal.tenantId, actor: principal.subjectId, provider: parsed.data });
      return reply.code(201).send({ id: parsed.data.id });
    } catch (error) {
      if (error instanceof ExternalProviderError) return reply.code(error.status).send({ error: error.message });
      throw error;
    }
  });
  app.post<{ Params: { providerId: string } }>("/v1/external-providers/:providerId/connections", async (request, reply) => {
    const principal = await options.authorize(request, "admin.write", { kind: "external-provider", id: request.params.providerId });
    const parsed = externalConnectionSaveSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "external_provider.connection_invalid" });
    const { connection, expectedRevision } = parsed.data;
    const source = sources();
    if (source.quarantined?.includes(request.params.providerId)) return reply.code(409).send({ error: "external_provider.quarantined" });
    if (connection.adapterId) {
      const template = source.templates.find(template => template.adapterId === connection.adapterId);
      if (!template) return reply.code(400).send({ error: "external_provider.adapter_unsupported" });
      if (connection.binding && !new RegExp(template.bindingPattern).test(connection.binding)) return reply.code(400).send({ error: "external_provider.binding_invalid" });
      if (connection.capabilityIds.some(id => !template.capabilityIds.includes(id))) return reply.code(400).send({ error: "external_provider.capability_incompatible" });
    } else if (connection.binding || connection.capabilityIds.length) {
      return reply.code(400).send({ error: "external_provider.adapter_required" });
    }
    try {
      const result = await saveExternalConnection(options.db, { tenantId: principal.tenantId, actor: principal.subjectId, providerId: request.params.providerId,
        catalogProvider: source.providers.find(provider => provider.id === request.params.providerId) ?? null, connection, expectedRevision });
      return reply.code(expectedRevision === null ? 201 : 200).send(result);
    } catch (error) {
      if (error instanceof ExternalProviderError) return reply.code(error.status).send({ error: error.message });
      throw error;
    }
  });
}
