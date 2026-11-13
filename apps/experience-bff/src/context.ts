import { routePath } from "./relay.js";
import {
  contextCatalogViews,
  contextOntologyView, type OntologyMetadata, type RelationshipCatalog,
  type ContextCatalogSource,
} from "@ehf/fincrime-views";
import {
  actionsForRoles,
  AuthorizationError,
  type Principal,
} from "@ehf/identity";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { OPERATIONS, type OperationMeta } from "@ehf/ui-contracts";
import { validateResponse } from "@ehf/ui-contracts/validate";
import type { sessionAccess } from "./session.js";
import { UpstreamError, type Upstream } from "./upstream.js";
import { platformRelayView } from "./platform-relay-views.js";
export function registerContextExperience(
  app: FastifyInstance,
  access: ReturnType<typeof sessionAccess>,
  upstream: Upstream,
  env: NodeJS.ProcessEnv,
) {
  const authorize = async (r: FastifyRequest, action: string) => {
    const p = await access.resolver.resolve(r);
    if (
      p.actorType !== "human" ||
      !actionsForRoles(p.roles).has(action as never)
    )
      throw new UpstreamError(403, "authorization.role_missing");
    if (r.method !== "GET" && !access.csrf(r))
      throw new UpstreamError(403, "csrf.invalid");
    return p;
  };
  const headers = (r: FastifyRequest) => {
    const auth = access.authorization(r);
    return auth && env.BFF_IDENTITY_MODE === "delegated"
      ? { "x-ehf-forwarded-authorization": auth }
      : {};
  };
  const call = async (
    r: FastifyRequest,
    p: Principal,
    service: Parameters<Upstream>[0],
    path: string,
  ) => {
    const result = await upstream(
      service,
      r.method,
      path,
      p,
      r.method === "GET" ? undefined : r.body,
      headers(r),
    );
    if (result.status >= 400)
      throw new UpstreamError(
        result.status,
        String(result.body?.error ?? "bff.upstream_unavailable"),
      );
    return result;
  };
  for (const meta of OPERATIONS as readonly OperationMeta[]) {
    const context = meta.path.startsWith("/v1/context/");
    const catalog = [
      "/v1/fincrime/catalog",
      "/v1/fincrime/context/products",
      "/v1/fincrime/context/products/{productId}",
      "/v1/fincrime/context/readiness",
      "/v1/fincrime/context/ontology",
    ].includes(meta.path);
    const preview = meta.path === "/v1/fincrime/context/packets:preview";
    const dependency =
      ["/v1/gateway/registry", "/v1/gateway/adapters"].includes(meta.path) &&
      meta.method === "GET";
    const authoring =
      meta.path.startsWith("/v1/authoring/drafts") &&
      ["GET", "PUT"].includes(meta.method);
    if (!context && !catalog && !preview && !dependency && !authoring) continue;
    app.route({
      method: meta.method,
      url: routePath(meta),
      bodyLimit: 1048576,
      handler: async (r, reply) => {
        reply.header("cache-control", "no-store");
        try {
          const action =
            meta.xAction?.match(/[a-z_]+\.[a-z_.]+/)?.[0] ?? "draft.read";
          const p = await authorize(r, action);
          if (preview) {
            const input = r.body as {
              agentId?: string;
              taskId?: string;
              caseId?: string;
              planDigest?: string;
              nodeId?: string;
              sourceContextDigest?: string;
            };
            if (!input?.planDigest || !input.nodeId)
              throw new UpstreamError(409, "context.preview_target_required");
            const target = await upstream(
              "control-api",
              "POST",
              "/v1/context/preview-target",
              p,
              {
                planDigest: input.planDigest,
                nodeId: input.nodeId,
                agentId: input.agentId,
                taskId: input.taskId,
              },
              headers(r),
            );
            if (target.status !== 200)
              throw new UpstreamError(
                target.status,
                String(
                  target.body?.error ?? "context.preview_target_unavailable",
                ),
              );
            const path = `/v2/cases/${encodeURIComponent(input.caseId ?? "")}/context:preview`;
            const request = { plan: target.body.plan, nodeId: input.nodeId };
            let result = await upstream(
              "case-api",
              "POST",
              path,
              p,
              request,
              headers(r),
            );
            if (
              result.status === 403 &&
              result.body?.error === "context.preview_source_authority_required"
            ) {
              if (!input.sourceContextDigest)
                throw new UpstreamError(
                  409,
                  "context.preview_source_context_required",
                );
              const {
                requestDigest: _digest,
                previewToken,
                ...challenge
              } = result.body.details;
              const authorized = await upstream(
                "control-api",
                "POST",
                "/v1/context/preview-authority",
                p,
                {
                  ...challenge,
                  sourceContextDigest: input.sourceContextDigest,
                },
                headers(r),
              );
              if (authorized.status !== 200)
                throw new UpstreamError(
                  authorized.status,
                  String(
                    authorized.body?.error ??
                      "context.preview_source_use_denied",
                  ),
                );
              result = await upstream(
                "case-api",
                "POST",
                path,
                p,
                {
                  ...request,
                  sourceProof: authorized.body.proof,
                  previewToken,
                },
                headers(r),
              );
            }
            if (result.status !== 200)
              throw new UpstreamError(
                result.status,
                String(result.body?.error ?? "context.preview_unavailable"),
              );
            if (!validateResponse(meta.operationId, 200, result.body).valid)
              throw new UpstreamError(502, "bff.upstream_contract_invalid");
            return result.body;
          }
          let body: unknown;
          if (catalog) {
            const source = await upstream(
              "control-api",
              "GET",
              "/v1/context/catalog",
              p,
              undefined,
              headers(r),
            );
            if (source.status !== 200)
              throw new UpstreamError(
                source.status >= 400 ? source.status : 502,
                String(source.body?.error ?? "context.catalog_unavailable"),
              );
            const views = contextCatalogViews(
              source.body as ContextCatalogSource,
            );
            if (meta.path.endsWith("/ontology")) {
              const [schema, relationships] = await Promise.all([
                call(r, p, "control-api", "/v1/context/schema"),
                call(r, p, "control-api", "/v1/context/relationships"),
              ]);
              try {
                body = await contextOntologyView(source.body as ContextCatalogSource, schema.body as OntologyMetadata, relationships.body as RelationshipCatalog);
              } catch (error) {
                throw new UpstreamError(409, error instanceof Error && error.message.startsWith("context.") ? error.message : "context.ontology_invalid");
              }
            }
            else if (meta.path.endsWith("/catalog")) body = views.catalog;
            else if (meta.path.endsWith("/products")) body = views.products;
            else if (meta.path.endsWith("/readiness")) {
              const agent = (r.query as { agentId?: string }).agentId;
              body = agent
                ? {
                    ...views.readiness,
                    agents: views.readiness.agents.filter((a) => a === agent),
                    cells: views.readiness.cells.filter(
                      (c) => c.agentId === agent,
                    ),
                  }
                : views.readiness;
            } else {
              body = views.productView(
                (r.params as { productId: string }).productId,
              );
              if (!body)
                throw new UpstreamError(404, "context.product_not_found");
            }
          } else {
            const target = context && !meta.path.startsWith("/v1/context/documents/")
              ? { service: "control-api" as const, path: meta.path }
              : meta.xUpstream;
            if (!target?.service || !target.path || target.service === "bff")
              throw new UpstreamError(503, "context.operation_unavailable");
            const path = target.path.replace(
              /\{([^}]+)\}|:([A-Za-z][A-Za-z0-9]*)/g,
              (_m, a, b) =>
                encodeURIComponent(
                  (r.params as Record<string, string>)[a ?? b] ?? "",
                ),
            );
            const query = new URLSearchParams(
              r.query as Record<string, string>,
            ).toString();
            const result = await call(
              r,
              p,
              target.service as Parameters<Upstream>[0],
              path + (query ? `?${query}` : ""),
            );
            body = dependency
              ? {
                  items: result.body.capabilities ?? result.body.adapters ?? [],
                  nextCursor: null,
                }
              : authoring ? platformRelayView(meta.operationId, result.body) : result.body;
          }
          if (!validateResponse(meta.operationId, 200, body).valid)
            throw new UpstreamError(502, "bff.upstream_contract_invalid");
          return body;
        } catch (e) {
          const status =
            e instanceof UpstreamError
              ? e.status
              : e instanceof AuthorizationError
                ? e.httpStatus
                : 503;
          const code =
            e instanceof UpstreamError
              ? e.code
              : e instanceof AuthorizationError
                ? e.decision.reasonCode
                : "bff.upstream_unavailable";
          return reply
            .code(status)
            .send({
              error:
                code === "bridge.preview_unavailable"
                  ? "bff.upstream_unavailable"
                  : code,
              status,
              correlationId: r.id,
              retryable: status >= 500,
              ...(code === "bridge.preview_unavailable"
                ? { details: { blockers: ["bridge.preview_unavailable"] } }
                : {}),
            });
        }
      },
    });
  }
}
