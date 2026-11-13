import { routePath } from './relay.js';
import { OPERATIONS, type OperationMeta } from "@ehf/ui-contracts";
import { validateResponse } from "@ehf/ui-contracts/validate";
import { actionsForRoles, AuthorizationError } from "@ehf/identity";
import type { FastifyInstance } from "fastify";
import type { sessionAccess } from "./session.js";
import { UpstreamError, type Upstream } from "./upstream.js";

/** The contract supplies the allow-list; no request can select an arbitrary service URL. */
export function registerSourcePolicyExperience(app: FastifyInstance, access: ReturnType<typeof sessionAccess>, upstream: Upstream, env: NodeJS.ProcessEnv) {
  for (const meta of OPERATIONS as readonly OperationMeta[]) {
    const sourcePolicy = meta.path.startsWith("/v1/source-policies/") || meta.path.startsWith("/v1/authoring/source-policies/");
    const startRun = meta.path === "/v1/runs" && meta.method === "POST";
    const policyHuman=meta.path.startsWith("/v1/operations/human-work") || meta.operationId==="getCasesCaseIdBusinessDecisionsDecisionId";
    if (!sourcePolicy && !startRun && !policyHuman && !meta.path.startsWith("/v1/authoring/policies")) continue;
    const target = meta.xUpstream;
    if (!target || !["control-api","case-api"].includes(target.service??"") || !target.path || meta.mockOnly) continue;
    app.route({ method: meta.method, url: routePath(meta), handler: async (request, reply) => {
      reply.header("cache-control", "no-store");
      const fail = (status: number, error: string) => reply.code(status).send({ error, status, correlationId: request.id, retryable: status >= 500 });
      try {
        const principal = await access.resolver.resolve(request);
        if (principal.actorType !== "human") return fail(403, "authorization.interactive_user_required");
        const action = meta.xAction?.match(/[a-z_]+\.[a-z_.]+/)?.[0];
        if (action && !actionsForRoles(principal.roles).has(action as never)) return fail(403, "authorization.role_missing");
        if (meta.method !== "GET" && !access.csrf(request)) return fail(403, "csrf.invalid");
        const key = request.headers["idempotency-key"];
        if (startRun && (typeof key !== "string" || !key)) return fail(400, "run.idempotency_key_required");
        const path = target.path!.replace(/:([A-Za-z]+)/g, (_, name) => {
          const value = (request.params as Record<string, string>)[name];
          if (!value) throw new UpstreamError(400, "request.path_invalid");
          return encodeURIComponent(value);
        });
        const query = new URLSearchParams(request.query as Record<string, string>).toString();
        const authorization = access.authorization(request);
        const result = await upstream(target.service as "control-api"|"case-api", meta.method, path + (query ? `?${query}` : ""), principal, request.body, {
          ...(typeof key === "string" ? { "idempotency-key": key } : {}),
          ...(authorization && env.BFF_IDENTITY_MODE === "delegated" ? { "x-ehf-forwarded-authorization": authorization } : {}),
        });
        if (result.status >= 400) return fail(result.status, String(result.body?.error ?? "bff.upstream_failed"));
        const status = startRun ? result.body.created ? 201 : 200 : result.status;
        const body = startRun ? result.body.run
          : meta.operationId==="postOperationsHumanWorkWorkItemIdClaim" ? result.body.workItem ?? result.body : result.body;
        if (!validateResponse(meta.operationId, status, body).valid) return fail(502, "bff.upstream_contract_invalid");
        return reply.code(status).send(body);
      } catch (error) {
        return fail(error instanceof UpstreamError ? error.status : error instanceof AuthorizationError ? error.httpStatus : 503,
          error instanceof UpstreamError ? error.code : error instanceof AuthorizationError ? error.decision.reasonCode : "bff.upstream_unavailable");
      }
    } });
  }
}
