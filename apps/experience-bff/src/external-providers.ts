import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { actionsForRoles, AuthorizationError, type Principal } from "@ehf/identity";
import { externalProviderIndex, type CatalogSnapshot, type GatewayProviderSource } from "@ehf/fincrime-views";
import type { Schemas } from "@ehf/ui-contracts";
import type { sessionAccess } from "./session.js";
import { UpstreamError, type Service, type Upstream } from "./upstream.js";

export function registerExternalProviderExperience(app: FastifyInstance, access: ReturnType<typeof sessionAccess>, upstream: Upstream, loadSnapshot: (request: FastifyRequest, principal: Principal) => CatalogSnapshot | Promise<CatalogSnapshot>, env: NodeJS.ProcessEnv): void {
  const call = async (request: FastifyRequest, principal: Principal, service: Service, method: string, path: string, body?: unknown) => {
    const authorization = access.authorization(request);
    const result = await upstream(service, method, path, principal, body, authorization && env.BFF_IDENTITY_MODE === "delegated" ? { "x-ehf-forwarded-authorization": authorization } : {});
    if (result.status >= 400) throw new UpstreamError(result.status, String(result.body?.error ?? "bff.upstream_failed"));
    return result;
  };
  const route = (method: "GET" | "POST", path: string, handle: (request: FastifyRequest, principal: Principal, reply: FastifyReply) => Promise<unknown>) => app.route({ method, url: `/api/v1${path}`, handler: async (request, reply) => {
    reply.header("cache-control", "no-store");
    try {
      const principal = await access.resolver.resolve(request);
      if (principal.actorType !== "human" || !actionsForRoles(principal.roles).has(method === "GET" && !path.startsWith("/external-capability-bindings/") ? "capability.read" : "admin.write")) throw new UpstreamError(403, "authorization.role_missing");
      if (method !== "GET" && !access.csrf(request)) throw new UpstreamError(403, "csrf.invalid");
      return await handle(request, principal, reply);
    } catch (error) {
      const status = error instanceof UpstreamError ? error.status : error instanceof AuthorizationError ? error.httpStatus : 503;
      return reply.code(status).send({ error: error instanceof UpstreamError ? error.code : error instanceof AuthorizationError ? error.decision.reasonCode : "bff.upstream_unavailable", status, correlationId: request.id, retryable: status >= 500 });
    }
  } });
  for (const method of ["GET", "POST"] as const) route(method, "/external-capability-bindings/:bindingId", async (request, principal, reply) => {
    const id = (request.params as { bindingId: string }).bindingId;
    const result = await call(request, principal, "control-api", method, `/v1/external-capability-bindings/${encodeURIComponent(id)}`, method === "POST" ? request.body : undefined);
    return reply.code(result.status).send(result.body);
  });
  route("GET", "/external-providers", async (request, principal) => {
    const gateway = async (): Promise<GatewayProviderSource | null> => {
      try {
        const [descriptors, connectors] = await Promise.all([
          call(request, principal, "capability-gateway", "GET", "/v1/adapters"),
          (async () => {
            const connectors: GatewayProviderSource["connectors"] = [];
            let cursor: string | null = null;
            const seen = new Set<string>();
            do {
              const result = await call(request, principal, "capability-gateway", "GET", `/v1/connectors?limit=500${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
              if (!Array.isArray(result.body?.connectors)) throw new UpstreamError(503, "external_provider.gateway_inventory_invalid");
              connectors.push(...result.body.connectors);
              cursor = result.body.nextCursor ?? null;
              if (cursor && seen.has(cursor)) throw new UpstreamError(503, "external_provider.gateway_pagination_invalid");
              if (cursor) seen.add(cursor);
              if (seen.size > 100) throw new UpstreamError(503, "external_provider.gateway_inventory_too_large");
            } while (cursor);
            return connectors;
          })(),
        ]);
        if (!Array.isArray(descriptors.body?.adapters) || !Array.isArray(descriptors.body?.modules)) throw new UpstreamError(503, "external_provider.gateway_descriptors_invalid");
        return { adapters: descriptors.body.adapters, modules: descriptors.body.modules, connectors };
      } catch (error) {
        if (error instanceof UpstreamError && error.status < 500) throw error;
        return null;
      }
    };
    const [registry, runtime, snapshot] = await Promise.all([call(request, principal, "control-api", "GET", "/v1/external-providers"), gateway(), loadSnapshot(request, principal)]);
    return externalProviderIndex(snapshot, registry.body.providers as Schemas["ExternalProviderRecord"][], runtime, new Date().toISOString());
  });
  route("POST", "/external-providers", async (request, principal, reply) => {
    const result = await call(request, principal, "control-api", "POST", "/v1/external-providers", request.body);
    return reply.code(result.status).send(result.body);
  });
  route("POST", "/external-providers/:providerId/connections", async (request, principal, reply) => {
    const id = (request.params as { providerId: string }).providerId;
    const result = await call(request, principal, "control-api", "POST", `/v1/external-providers/${encodeURIComponent(id)}/connections`, request.body);
    return reply.code(result.status).send(result.body);
  });
}
