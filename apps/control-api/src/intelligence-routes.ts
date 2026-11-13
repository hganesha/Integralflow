import { z } from "zod";
import { INTELLIGENCE_ADAPTER_CATALOG, intelligenceAdapterImplemented, intelligenceCheckRequestSchema, intelligenceConfigurationChecks, intelligenceSaveSchema } from "@ehf/contracts";
import { checkIntelligenceCandidate, intelligenceCandidates, IntelligenceError, resolveSettingSection, saveIntelligenceCandidate, type Database } from "@ehf/persistence";
import { isProductionProfile, type PlatformAction, type Principal, type ResourceRef } from "@ehf/identity";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { adminModelProfilesView, adminProvidersView } from "./admin-config.js";

export function registerIntelligenceRoutes(app: FastifyInstance, options: {
  db: Database; env: NodeJS.ProcessEnv;
  authorize: (request: FastifyRequest, action: PlatformAction, resource?: ResourceRef) => Promise<Principal>;
}): void {
  const environment = options.env.EHF_ENVIRONMENT ?? options.env.RELEASE_ENVIRONMENT ?? "local";
  const principal = async (request: FastifyRequest, action: PlatformAction) => {
    const caller = await options.authorize(request, action, { kind: "intelligence" });
    if (caller.actorType !== "human") throw new IntelligenceError("authorization.interactive_user_required", 403);
    return caller;
  };
  const handler = (action: PlatformAction, handle: (request: FastifyRequest, caller: Principal) => Promise<unknown>) => async (request: FastifyRequest, reply: FastifyReply) => {
    reply.header("cache-control", "no-store");
    try { return await handle(request, await principal(request, action)); }
    catch (error) {
      if (error instanceof IntelligenceError) return reply.code(error.status).send({ error: error.message });
      if (error instanceof z.ZodError) return reply.code(400).send({ error: "intelligence.invalid_configuration", details: { issues: error.issues.map(issue => ({ path: issue.path.join("."), message: issue.message })) } });
      throw error;
    }
  };
  app.get("/v1/intelligence", handler("admin.read", async (_request, caller) => {
    const scope = { tenantId: caller.tenantId, environment };
    const [registry, profiles, providers, runtime] = await Promise.all([
      intelligenceCandidates(options.db, scope), adminModelProfilesView(options, caller.tenantId), adminProvidersView(options, caller.tenantId),
      resolveSettingSection(options.db, caller.tenantId, "runtime", options.env),
    ]);
    const deploymentManaged = isProductionProfile(options.env);
    const runtimes: Array<{ id: string; target: string; adapterId: string; endpoint: string | null; auth: string; source: string; deploymentManaged: boolean }> = Object.entries(runtime.value.bindings).map(([id, binding]) => ({
      id, target: `${binding.adapter}:${id}`, adapterId: binding.adapter, endpoint: binding.endpoint, auth: binding.auth,
      source: runtime.source, deploymentManaged,
    }));
    if (!runtimes.some(binding => binding.target === runtime.value.provider)) {
      const adapterId = runtime.value.provider.split(":")[0]!;
      // Only expose actual configured coordinates (the same environment the dispatcher's
      // adapter registry reads). Never guess an endpoint.
      const endpoint = adapterId === "local_http" ? (deploymentManaged ? options.env.RUNTIME_HOSTED_ENDPOINT ?? null : runtime.value.localEndpoint)
        : adapterId === "hosted_http" ? options.env.RUNTIME_HOSTED_ENDPOINT ?? null
        : adapterId === "databricks" ? options.env.DATABRICKS_RUNTIME_ENDPOINT ?? null : null;
      runtimes.unshift({ id: "environment-default", target: runtime.value.provider, adapterId, endpoint,
        auth: adapterId === "databricks" ? "databricks_oauth_m2m" : adapterId === "local_http" || adapterId === "hosted_http" ? "platform_token" : "environment",
        source: runtime.source, deploymentManaged,
      });
    }
    return { ...registry, environment, generatedAt: new Date().toISOString(), profiles: profiles.profiles, providers: providers.providers,
      runtimes, adapters: INTELLIGENCE_ADAPTER_CATALOG, consumerInventoryAvailable: false };
  }));
  app.post("/v1/intelligence/candidates", { bodyLimit: 262_144 }, handler("admin.write", async (request, caller) => {
    const body = intelligenceSaveSchema.parse(request.body);
    return saveIntelligenceCandidate(options.db, { tenantId: caller.tenantId, environment, actor: caller.subjectId, body });
  }));
  app.post("/v1/intelligence/bindings/:bindingId/checks", { bodyLimit: 262_144 }, handler("admin.write", async (request, caller) => {
    const body = intelligenceCheckRequestSchema.parse(request.body);
    return checkIntelligenceCandidate(options.db, { tenantId: caller.tenantId, environment, actor: caller.subjectId,
      bindingId: (request.params as { bindingId: string }).bindingId, expectedRevision: body.expectedRevision,
      evaluate: definition => intelligenceConfigurationChecks(definition, intelligenceAdapterImplemented(definition)),
    });
  }));
}
