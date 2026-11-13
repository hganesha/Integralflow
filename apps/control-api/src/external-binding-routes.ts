import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { externalBindingSaveSchema, externalBindingError, type ExternalBindingCatalog } from "@ehf/contracts";
import { externalBindingHistory, listExternalBindingRevisions, saveExternalBindingRevision, ExternalProviderError, type Database } from "@ehf/persistence";
import type { PlatformAction, Principal, ResourceRef } from "@ehf/identity";
import type { FastifyInstance, FastifyRequest } from "fastify";

let source: ExternalBindingCatalog | undefined;
export function externalBindingCatalog(): ExternalBindingCatalog {
  if (source) return source;
  const path = process.env.EXTERNAL_BINDING_CATALOG_PATH ?? (existsSync(resolve("config/external-capability-bindings.json")) ? resolve("config/external-capability-bindings.json") : fileURLToPath(new URL("../../../config/external-capability-bindings.json", import.meta.url)));
  return source = JSON.parse(readFileSync(path, "utf8")) as ExternalBindingCatalog;
}
export function registerExternalBindingRoutes(app: FastifyInstance, options: { db: Database; authorize: (request: FastifyRequest, action: PlatformAction, resource?: ResourceRef) => Promise<Principal> }): void {
  app.get("/v1/external-capability-bindings", async request => {
    const principal = await options.authorize(request, "capability.read", { kind: "external-capability-binding" });
    return { items: await listExternalBindingRevisions(options.db, principal.tenantId) };
  });
  app.get<{ Params: { bindingId: string } }>("/v1/external-capability-bindings/:bindingId", async (request, reply) => {
    const principal = await options.authorize(request, "admin.write", { kind: "external-capability-binding", id: request.params.bindingId });
    const catalog = externalBindingCatalog();
    const binding = catalog.bindings.find(item => item.bindingId === request.params.bindingId);
    if (!binding) return reply.code(404).send({ error: "external_binding.not_found" });
    const history = await externalBindingHistory(options.db, principal.tenantId, binding.bindingId);
    const latest = history[0];
    return { ...binding, definition: latest?.definition ?? binding.definition, revision: latest?.revision ?? 0, sourceChanged: Boolean(latest && latest.sourceDigest !== binding.sourceDigest), history, definitions: catalog.definitions, jurisdictions: catalog.jurisdictions };
  });
  app.post<{ Params: { bindingId: string } }>("/v1/external-capability-bindings/:bindingId", async (request, reply) => {
    const principal = await options.authorize(request, "admin.write", { kind: "external-capability-binding", id: request.params.bindingId });
    const parsed = externalBindingSaveSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "external_binding.invalid" });
    const catalog = externalBindingCatalog();
    const binding = catalog.bindings.find(item => item.bindingId === request.params.bindingId);
    if (!binding) return reply.code(404).send({ error: "external_binding.not_found" });
    if (binding.sourceDigest !== parsed.data.sourceDigest) return reply.code(409).send({ error: "external_binding.source_changed" });
    const error = externalBindingError(parsed.data.definition, catalog);
    if (error) return reply.code(400).send({ error });
    try {
      return await saveExternalBindingRevision(options.db, { ...parsed.data, bindingId: binding.bindingId, tenantId: principal.tenantId, actor: principal.subjectId });
    } catch (error) {
      if (error instanceof ExternalProviderError) return reply.code(error.status).send({ error: error.message });
      throw error;
    }
  });
}
