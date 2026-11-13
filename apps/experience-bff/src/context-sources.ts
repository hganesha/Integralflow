import type { FastifyInstance } from "fastify";
import { actionsForRoles, AuthorizationError } from "@ehf/identity";
import { validatorFor } from "@ehf/ui-contracts/validate";
import type { sessionAccess } from "./session.js";
import { UpstreamError, type Upstream } from "./upstream.js";

export function registerContextSourceExperience(
  app: FastifyInstance,
  access: ReturnType<typeof sessionAccess>,
  upstream: Upstream,
  env: NodeJS.ProcessEnv,
): void {
  const routes = [
    ["GET", "/context-sources", "control-api", null, "ContextSourceIndex"],
    [
      "POST",
      "/context-sources/connections",
      "control-api",
      "ContextConnectionSave",
      "ContextConnectionRevision",
    ],
    [
      "POST",
      "/context-sources/bindings",
      "control-api",
      "ContextBindingSave",
      "ContextBindingRevision",
    ],
    [
      "POST",
      "/context-sources/bindings/:bindingId/checks",
      "capability-gateway",
      "ContextCheckRequest",
      "ContextSourceCheck",
    ],
    [
      "POST",
      "/context-sources/bindings/:bindingId/activation",
      "control-api",
      "ContextSourceActivation",
      "ContextSourceActivationResult",
    ],
    [
      "POST",
      "/context-sources/bindings/:bindingId/refresh",
      "control-api",
      "ContextRefreshSave",
      "ContextSourceActivationResult",
    ],
  ] as const;
  for (const [method, path, service, requestSchema, responseSchema] of routes)
    app.route({
      method,
      url: `/api/v1${path}`,
      bodyLimit: 65536,
      handler: async (request, reply) => {
        reply.header("cache-control", "no-store");
        try {
          const principal = await access.resolver.resolve(request);
          if (
            principal.actorType !== "human" ||
            !actionsForRoles(principal.roles).has(
              method === "GET" ? "capability.read" : "admin.write",
            )
          )
            throw new UpstreamError(403, "authorization.role_missing");
          if (method !== "GET" && !access.csrf(request))
            throw new UpstreamError(403, "csrf.invalid");
          if (requestSchema && !validatorFor(requestSchema)(request.body))
            throw new UpstreamError(
              400,
              "context_source.configuration_invalid",
            );
          const authorization = access.authorization(request);
          const result = await upstream(
            service,
            method,
            `/v1${path.replace(":bindingId", encodeURIComponent((request.params as { bindingId?: string }).bindingId ?? ""))}`,
            principal,
            request.body,
            authorization && env.BFF_IDENTITY_MODE === "delegated"
              ? { "x-ehf-forwarded-authorization": authorization }
              : {},
          );
          if (result.status >= 400)
            throw new UpstreamError(
              result.status,
              String(result.body?.error ?? "context_source.upstream_failed"),
            );
          if (!validatorFor(responseSchema)(result.body))
            throw new UpstreamError(503, "context_source.response_invalid");
          return reply.code(result.status).send(result.body);
        } catch (error) {
          const status =
            error instanceof UpstreamError
              ? error.status
              : error instanceof AuthorizationError
                ? error.httpStatus
                : 503;
          return reply
            .code(status)
            .send({
              error:
                error instanceof UpstreamError
                  ? error.code
                  : error instanceof AuthorizationError
                    ? error.decision.reasonCode
                    : "context_source.upstream_unavailable",
              status,
              correlationId: request.id,
              retryable: status >= 500,
            });
        }
      },
    });
}
