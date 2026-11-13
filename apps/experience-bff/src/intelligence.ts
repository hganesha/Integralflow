import type { FastifyInstance } from "fastify";
import { actionsForRoles, AuthorizationError } from "@ehf/identity";
import { validatorFor } from "@ehf/ui-contracts/validate";
import type { sessionAccess } from "./session.js";
import { UpstreamError, type Upstream } from "./upstream.js";

export function registerIntelligenceExperience(app: FastifyInstance, access: ReturnType<typeof sessionAccess>, upstream: Upstream, env: NodeJS.ProcessEnv): void {
  for (const [method, path, controlPath] of [
    ["GET", "/intelligence", "/v1/intelligence"],
    ["POST", "/intelligence/candidates", "/v1/intelligence/candidates"],
    ["POST", "/intelligence/bindings/:bindingId/checks", "/v1/intelligence/bindings/:bindingId/checks"],
  ] as const) app.route({ method, url: `/api/v1${path}`, bodyLimit: 262_144, handler: async (request, reply) => {
    reply.header("cache-control", "no-store");
    try {
      const principal = await access.resolver.resolve(request);
      if (principal.actorType !== "human" || !actionsForRoles(principal.roles).has(method === "GET" ? "admin.read" : "admin.write")) throw new UpstreamError(403, "authorization.role_missing");
      if (method !== "GET" && !access.csrf(request)) throw new UpstreamError(403, "csrf.invalid");
      if (method === "POST" && !validatorFor(path.endsWith("/candidates") ? "IntelligenceSave" : "IntelligenceCheckRequest")(request.body)) throw new UpstreamError(400, "intelligence.invalid_configuration");
      const authorization = access.authorization(request);
      const headers = authorization && env.BFF_IDENTITY_MODE === "delegated" ? { "x-ehf-forwarded-authorization": authorization } : {};
      const result = await upstream("control-api", method, controlPath.replace(":bindingId", encodeURIComponent((request.params as { bindingId?: string }).bindingId ?? "")), principal, request.body, headers);
      if (result.status >= 400) throw new UpstreamError(result.status, String(result.body?.error ?? "intelligence.upstream_failed"));
      if (method !== "GET") return reply.code(result.status).send(result.body);
      let gatewayAvailable = false;
      let gatewayAdapters: string[] = [];
      try {
        const gateway = await upstream("capability-gateway", "GET", "/v1/adapters", principal, undefined, headers);
        if (gateway.status === 401 || gateway.status === 403) throw new UpstreamError(gateway.status, "authorization.role_missing");
        if (gateway.status < 400 && Array.isArray(gateway.body?.adapters) && gateway.body.adapters.every((item: { id?: unknown }) => typeof item.id === "string")) {
          gatewayAvailable = true;
          gatewayAdapters = gateway.body.adapters.map((adapter: { id: string }) => adapter.id);
        }
      } catch (error) { if (error instanceof UpstreamError && error.status < 500) throw error; }
      const body = { ...result.body, gatewayAvailable, gatewayAdapters };
      if (!validatorFor("IntelligenceIndex")(body)) throw new UpstreamError(503, "intelligence.inventory_invalid");
      return body;
    } catch (error) {
      const status = error instanceof UpstreamError ? error.status : error instanceof AuthorizationError ? error.httpStatus : 503;
      return reply.code(status).send({ error: error instanceof UpstreamError ? error.code : error instanceof AuthorizationError ? error.decision.reasonCode : "intelligence.upstream_unavailable", status, correlationId: request.id, retryable: status >= 500 });
    }
  } });
}
