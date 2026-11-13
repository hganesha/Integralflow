import type { FastifyInstance, FastifyRequest } from "fastify";
import { actionsForRoles, AuthorizationError, type Principal } from "@ehf/identity";
import { validateResponse, validatorFor } from "@ehf/ui-contracts/validate";
import type { sessionAccess } from "./session.js";
import { UpstreamError, type Upstream } from "./upstream.js";
export function registerContextOntology(app: FastifyInstance, access: ReturnType<typeof sessionAccess>, upstream: Upstream, env: NodeJS.ProcessEnv) {
  const headers = (r: FastifyRequest) => { const auth = access.authorization(r); return auth && env.BFF_IDENTITY_MODE === "delegated" ? { "x-ehf-forwarded-authorization": auth } : {}; };
  const call = async (r: FastifyRequest, p: Principal, service: "control-api" | "case-api", method: "GET" | "POST", path: string, body?: unknown) => {
    const response = await upstream(service, method, path, p, body, headers(r));
    if (response.status >= 400) throw new UpstreamError(response.status, String(response.body?.error ?? "context.upstream_unavailable"));
    return response.body;
  };
  const route = (method: "GET" | "POST", path: string, operation: string, fn: (r: FastifyRequest, p: Principal) => Promise<unknown>) => app.route({ method, url: `/api/v1/fincrime${path}`, bodyLimit: 65536, handler: async (r, reply) => {
    reply.header("cache-control", "no-store");
    try {
      const p = await access.resolver.resolve(r);
      if (p.actorType !== "human" || !actionsForRoles(p.roles).has("draft.read") || (method === "POST" && !actionsForRoles(p.roles).has("case.read"))) throw new UpstreamError(403, "authorization.role_missing");
      if (method !== "GET" && !access.csrf(r)) throw new UpstreamError(403, "csrf.invalid");
      const body = await fn(r, p);
      if (!validateResponse(operation, 200, body).valid) throw new UpstreamError(502, "context.response_invalid");
      return body;
    } catch (e) {
      const status = e instanceof UpstreamError ? e.status : e instanceof AuthorizationError ? e.httpStatus : 503;
      const error = e instanceof UpstreamError ? e.code : e instanceof AuthorizationError ? e.decision.reasonCode : e instanceof Error && e.message.startsWith("context.") ? e.message : "context.upstream_unavailable";
      return reply.code(status).send({ error, status, correlationId: r.id, retryable: status >= 500 });
    }
  } });
  route("POST", "/cases/:caseId/context::traverse", "postFincrimeCasesCaseIdContextTraverse", async (r, p) => {
    if (!validatorFor("CaseTraversalRequest")(r.body)) throw new UpstreamError(400, "context.traversal_request_invalid");
    const input = r.body as { planDigest?: string; nodeId?: string; query?: unknown; sourceContextDigest?: string };
    if (!input?.planDigest || !input.nodeId || !input.query) throw new UpstreamError(400, "context.traversal_request_invalid");
    const target = await call(r, p, "control-api", "POST", "/v1/context/traversal-target", { planDigest: input.planDigest, nodeId: input.nodeId });
    const path = `/v2/cases/${encodeURIComponent((r.params as { caseId: string }).caseId)}/context:traverse`;
    const request = { plan: target.plan, nodeId: input.nodeId, query: input.query };
    let response = await upstream("case-api", "POST", path, p, request, headers(r));
    if (response.status === 403 && response.body?.error === "context.traversal_source_authority_required") {
      if (!input.sourceContextDigest) throw new UpstreamError(409, "context.traversal_source_context_required");
      const { challengeToken, ...challenge } = response.body.details;
      const proof = await call(r, p, "control-api", "POST", "/v1/context/traversal-authority", { ...challenge, sourceContextDigest: input.sourceContextDigest });
      // The challenge pins time and scope. Never retry against a newly captured observation.
      response = await upstream("case-api", "POST", path, p, { ...request, query: { ...input.query as object, ...challenge.query }, sourceProof: proof.proof, challengeToken }, headers(r));
    }
    if (response.status !== 200) throw new UpstreamError(response.status, String(response.body?.error ?? "context.traversal_unavailable"));
    return response.body;
  });
}
