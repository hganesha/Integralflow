import { caseDocumentDetail, type CanonicalRecordView, type DocumentSkillOutputs } from "@ehf/fincrime-views";
import { actionsForRoles } from "@ehf/identity";
import type { FastifyInstance } from "fastify";
import type { sessionAccess } from "./session.js";
import { delegatedHeaders, errorResponse } from "./relay.js";
import { UpstreamError, type Upstream } from "./upstream.js";

const ROUTE_LABELS: Record<string, string> = { llm: "LLM contract extraction", azure_di: "Azure prebuilt model" };
const display = (value: unknown): string | null => value === null || value === undefined ? null : typeof value === "string" ? value : JSON.stringify(value);

/**
 * The routes side by side, from the adjudicating wrapper's shadow output: each route's status, and per field
 * every route's reading with the deterministic outcome. Null when only the LLM route ran.
 */
export function routeComparison(run: Record<string, any>, assertions: Array<{ objectId: string; path: string }>) {
  const adjudication = run.skillOutputs?.adjudication;
  if (!adjudication || !Array.isArray(adjudication.outcomes)) return null;
  const modelRoute = run.skillOutputs.modelRoute ?? {};
  const errors: Record<string, string> = adjudication.route_errors ?? {};
  const byPath = new Map(assertions.map(assertion => [assertion.path, assertion.objectId]));
  return {
    mode: "shadow" as const, proposedRoute: "llm",
    routes: Object.entries(adjudication.routes ?? {}).map(([route, value]: [string, any]) => ({
      route, label: ROUTE_LABELS[route] ?? route,
      provider: route === "llm" ? run.model?.provider ?? null : modelRoute.provider ?? null,
      model: route === "llm" ? run.model?.model ?? null : modelRoute.model ?? null,
      status: value.status, error: errors[route] ?? (route !== "llm" && modelRoute.status === "failed" ? modelRoute.code ?? null : null),
      issues: Array.isArray(value.issues) ? value.issues.map(String) : [],
    })),
    policy: { id: String(adjudication.policy?.id ?? ""), version: String(adjudication.policy?.version ?? ""), digest: String(adjudication.policy?.digest ?? "") },
    counts: adjudication.counts ?? {}, reviewRequired: adjudication.review_required !== false,
    fields: adjudication.outcomes.map((outcome: any) => ({
      path: String(outcome.path), field: String(outcome.field), keyField: outcome.key_field === true, criticality: outcome.criticality,
      outcome: outcome.outcome, rule: String(outcome.rule), review: outcome.review, comparison: outcome.comparison ?? null,
      selectedRoute: outcome.selected?.route ?? null, assertionId: byPath.get(`/extracted_fields/${outcome.path}`) ?? null,
      candidates: Object.entries(outcome.candidates ?? {}).map(([route, candidate]: [string, any]) => ({
        route, value: display(candidate?.value), grounded: candidate?.grounded === true,
        confidence: typeof candidate?.confidence === "number" ? candidate.confidence : null,
      })),
    })),
  };
}

export function studioView(run: Record<string, any>) {
  const outputs: DocumentSkillOutputs = { extractions: run.skillOutputs.extraction?.extractions ?? [], validity: run.skillOutputs.validity?.assessments ?? [] };
  const detail = caseDocumentDetail(run.documentId, run.records as CanonicalRecordView[], outputs);
  if (detail) detail.document.documentType = run.documentType;
  return { testId: run.testId, documentId: run.documentId, documentVersion: run.documentVersion, documentType: run.documentType, filename: run.filename,
    status: run.status, stage: run.stage, createdAt: run.createdAt, finishedAt: run.finishedAt, error: run.error,
    model: run.model, costUsd: run.costUsd, skillOutputs: run.skillOutputs, validation: run.validation, detail,
    routes: routeComparison(run, detail?.assertions ?? []) };
}

export function registerDocumentStudioExperience(app: FastifyInstance, access: ReturnType<typeof sessionAccess>, upstream: Upstream, env: NodeJS.ProcessEnv) {
  for (const route of [
    { method: "GET" as const, path: "/v1/document-studio/configuration" },
    { method: "GET" as const, path: "/v1/document-studio/tests" },
    { method: "POST" as const, path: "/v1/document-studio/tests" },
    { method: "GET" as const, path: "/v1/document-studio/tests/:testId" },
  ]) app.route({ method: route.method, url: "/api" + route.path, bodyLimit: 13 * 1024 * 1024, handler: async (request, reply) => {
    reply.header("cache-control", "no-store").header("x-correlation-id", request.id);
    try {
      const principal = await access.resolver.resolve(request);
      const actions = actionsForRoles(principal.roles);
      if (principal.actorType !== "human" || !actions.has("evidence.read") || !actions.has(route.method === "POST" ? "draft.evaluate" : "draft.read")) throw new UpstreamError(403, "authorization.role_missing");
      if (route.method === "POST" && !access.csrf(request)) throw new UpstreamError(403, "csrf.invalid");
      const path = route.path.replace(":testId", encodeURIComponent((request.params as { testId?: string }).testId ?? ""));
      const result = await upstream("control-api", route.method, path, principal, request.body, delegatedHeaders(request, access, env));
      if (result.status >= 400) throw new UpstreamError(result.status, result.body?.error ?? "document_studio.unavailable");
      const list = route.method === "GET" && route.path.endsWith("/tests");
      return list || route.path.endsWith("configuration") ? result.body : studioView(result.body);
    } catch (error) { const failure = errorResponse(error, request); return reply.code(failure.status).send(failure.body); }
  } });
}
