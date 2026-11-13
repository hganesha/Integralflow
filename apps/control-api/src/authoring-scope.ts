import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { PlatformAction, ResourceRef } from "@ehf/identity";
import {
  CUSTOMER_TYPES, DUE_DILIGENCE, DUE_DILIGENCE_RULES, REVIEW_EVENTS, ScopeError, TRIGGERS, composeForScope, inferScope, loadComposerRepository, previewScopeChange, withPublishedLayers,
  type ComposerRepository, type ProcessScope,
} from "@ehf/flow-composer";
import { getAuthoringDraft, listPackLayerRevisionHeads, updateAuthoringSources, type Database } from "@ehf/persistence";
import { policyPackLayerSchema } from "@ehf/policy-engine";
import { analyzeAuthoringSources } from "./authoring.js";

/**
 * A process's scope (customer type, trigger, jurisdictions, products) as a first-class authoring
 * operation: preview what a scope change adds and removes, and why; apply it as one revisioned edit
 * that recomposes the draft's package, workflow and business policy (@ehf/flow-composer). Nothing is
 * released by applying: the recomposed draft still compiles, evaluates and is approved as any other.
 */
export const processScopeSchema = z.object({
  customerType: z.enum(CUSTOMER_TYPES),
  trigger: z.enum(TRIGGERS),
  jurisdictions: z.array(z.string().regex(/^[A-Z]{2}$/)).min(1).max(20),
  products: z.array(z.string().regex(/^[a-z][a-z_]{0,63}$/)).min(1).max(20),
  institution: z.string().regex(/^[a-z0-9][a-z0-9.-]*$/).max(120).optional(),
  dueDiligence: z.enum(DUE_DILIGENCE).optional(),
  event: z.enum(Object.keys(REVIEW_EVENTS) as [keyof typeof REVIEW_EVENTS, ...Array<keyof typeof REVIEW_EVENTS>]).optional(),
}).strict();

type Authorize = (request: FastifyRequest, action: PlatformAction, resource?: ResourceRef) => Promise<{ tenantId: string; subjectId: string }>;

export function registerAuthoringScopeRoutes(app: FastifyInstance, options: { db: Database; authorize: Authorize; domainsPath: string; configPath: string }) {
  let repository: ComposerRepository | null = null;
  // Loaded once per process from the image's domains/ and config/ (the same inputs the generators read).
  const repo = () => (repository ??= loadComposerRepository({ domains: options.domainsPath, config: options.configPath }));
  /** The repository as one tenant composes with it: its published pack layer revisions in place (phase H). */
  const tenantRepo = async (tenantId: string) => withPublishedLayers(repo(), (await listPackLayerRevisionHeads(options.db, tenantId))
    .flatMap((head) => head.published ? [policyPackLayerSchema.parse(head.published.layer)] : []));
  const refusal = (error: unknown) => error instanceof ScopeError
    ? { status: 422, body: { error: error.code, message: error.message, ...(error.remedy ? { remedy: error.remedy } : {}) } }
    : { status: 400, body: { error: error instanceof Error ? error.message : "authoring.scope_failed" } };

  app.get("/v1/authoring/scope-options", async (request) => {
    // Process authors (draft.read) and case creators (case.write, choosing a new case's scope) read them.
    try { await options.authorize(request, "draft.read"); } catch { await options.authorize(request, "case.write"); }
    const layers = repo().layers.filter((layer) => layer.metadata.status !== "RETIRED");
    const institutions = layers.filter((layer) => layer.metadata.layer === "institution");
    // A jurisdiction is available where it has its own layer and an institution layer covers it.
    const jurisdictions = layers.filter((layer) => layer.metadata.layer === "jurisdiction")
      .flatMap((layer) => layer.metadata.appliesTo.jurisdictions ?? [])
      .map((code) => ({ code, available: institutions.some((layer) => !layer.metadata.appliesTo.jurisdictions || layer.metadata.appliesTo.jurisdictions.includes(code)) }));
    const products = [...new Set(layers.filter((layer) => layer.metadata.layer === "product").flatMap((layer) => layer.metadata.appliesTo.products ?? []))].sort();
    return {
      customerTypes: CUSTOMER_TYPES.map((value) => ({ value, available: true })),
      triggers: TRIGGERS.map((value) => ({ value, available: true })),
      // The events an event review names, with the customer types each occurs for.
      events: Object.entries(REVIEW_EVENTS).map(([value, rule]) => ({ value, customerTypes: [...rule.customerTypes] })),
      // SDD / CDD / EDD, with the customer types each applies to.
      dueDiligence: DUE_DILIGENCE.map((value) => ({ value, available: true, customerTypes: DUE_DILIGENCE_RULES[value].customerTypes, description: DUE_DILIGENCE_RULES[value].reason })),
      jurisdictions: [...new Map(jurisdictions.map((item) => [item.code, item])).values()].sort((a, b) => a.code.localeCompare(b.code)),
      products,
      institutions: institutions.map((layer) => ({ id: layer.metadata.id, appliesTo: layer.metadata.appliesTo.institutions ?? [] })),
    };
  });

  app.get<{ Params: { draftId: string } }>("/v1/authoring/drafts/:draftId/scope", async (request, reply) => {
    const principal = await options.authorize(request, "draft.read", { kind: "draft", id: request.params.draftId });
    const draft = await getAuthoringDraft(options.db, request.params.draftId, principal.tenantId);
    if (!draft) return reply.code(404).send({ error: "authoring.draft_not_found" });
    const scope = inferScope(draft.parsedWorkflow, draft.sourceFiles);
    if (!scope) return reply.code(422).send({ error: "authoring.scope_unsupported_draft", message: "this draft is not a composed KYC/KYB process" });
    return { scope };
  });

  app.post<{ Params: { draftId: string } }>("/v1/authoring/drafts/:draftId/scope/preview", async (request, reply) => {
    const principal = await options.authorize(request, "draft.read", { kind: "draft", id: request.params.draftId });
    const parsed = z.object({ scope: processScopeSchema }).strict().safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "authoring.scope_invalid" });
    const draft = await getAuthoringDraft(options.db, request.params.draftId, principal.tenantId);
    if (!draft) return reply.code(404).send({ error: "authoring.draft_not_found" });
    if (!inferScope(draft.parsedWorkflow, draft.sourceFiles)) return reply.code(422).send({ error: "authoring.scope_unsupported_draft", message: "this draft is not a composed KYC/KYB process" });
    try {
      return { preview: previewScopeChange({ workflow: draft.parsedWorkflow, sourceFiles: draft.sourceFiles, scope: parsed.data.scope as ProcessScope, repository: await tenantRepo(principal.tenantId) }).preview };
    } catch (error) {
      const { status, body } = refusal(error);
      return reply.code(status).send(body);
    }
  });

  app.post<{ Params: { draftId: string } }>("/v1/authoring/drafts/:draftId/scope/apply", async (request, reply) => {
    const principal = await options.authorize(request, "draft.write", { kind: "draft", id: request.params.draftId });
    const parsed = z.object({ scope: processScopeSchema, expectedRevision: z.number().int().nonnegative() }).strict().safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "authoring.scope_invalid" });
    const draft = await getAuthoringDraft(options.db, request.params.draftId, principal.tenantId);
    if (!draft) return reply.code(404).send({ error: "authoring.draft_not_found" });
    if (!inferScope(draft.parsedWorkflow, draft.sourceFiles)) return reply.code(422).send({ error: "authoring.scope_unsupported_draft", message: "this draft is not a composed KYC/KYB process" });
    try {
      const scope = parsed.data.scope as ProcessScope;
      const repository = await tenantRepo(principal.tenantId);
      const { preview } = previewScopeChange({ workflow: draft.parsedWorkflow, sourceFiles: draft.sourceFiles, scope, repository });
      const composed = composeForScope(scope, repository);
      const analysis = analyzeAuthoringSources(composed.sources.packageSource, composed.sources.workflowSource);
      const updated = await updateAuthoringSources(options.db, draft.draftId, {
        expectedRevision: parsed.data.expectedRevision,
        packageSource: composed.sources.packageSource, workflowSource: composed.sources.workflowSource,
        sourceFiles: { ...draft.sourceFiles, ...composed.sources.sourceFiles },
        parsedPackage: analysis.parsedPackage, parsedWorkflow: analysis.parsedWorkflow, ...analysis.metadata,
        diagnostics: analysis.diagnostics, actor: principal.subjectId,
      });
      return { draft: updated, preview };
    } catch (error) {
      if (error instanceof Error && error.message.includes("revision_conflict")) return reply.code(409).send({ error: error.message });
      const { status, body } = refusal(error);
      return reply.code(status).send(body);
    }
  });
}
