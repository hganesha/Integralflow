import { z } from "zod";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import {
  sourceArtifactSchema, sourceArtifactKindSchema, sourceContextSchema, sourceBindingSchema, sourceAccessSchema,
  jurisdictionSourcePolicySchema, sourceUseRequestSchema, stableDigest,
} from "@ehf/contracts";
import { compileJurisdictionSourcePolicy, evaluateSourceAuthorizationWithOpa } from "@ehf/policy-engine";
import {
  approveSourceArtifact, getSourceDecision, getPlan, getRun, getSourceArtifact,
  listSourceArtifacts, listSourceDecisions, loadSourceAuthority, registerSourceArtifact, revokeArtifactEntry,
  type Database,
} from "@ehf/persistence";
import type { PlatformAction, Principal, ResourceRef } from "@ehf/identity";

type Authorize = (request: FastifyRequest, action: PlatformAction, resource?: ResourceRef) => Promise<Principal>;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const ref = z.string().min(1).max(200);
const simulationSchema = z.object({
  context: sourceContextSchema.nullable(), policies: z.array(jurisdictionSourcePolicySchema).max(32),
  binding: sourceBindingSchema.nullable(), access: sourceAccessSchema.nullable(),
  capabilityId: ref, connectorId: ref, connectorDigest: digest.nullable(),
  request: sourceUseRequestSchema, evaluatedAt: z.iso.datetime(),
}).strict();

export function registerSourcePolicyRoutes(app: FastifyInstance, options: { db: Database; authorize: Authorize }) {
  const resource = { kind: "source-policy" };
  const handle = (action: PlatformAction, body: (request: FastifyRequest, reply: FastifyReply, principal: Principal) => Promise<unknown>) => async (request: FastifyRequest, reply: FastifyReply) => {
    const principal = await options.authorize(request, action, resource);
    try { return await body(request, reply, principal); }
    catch (error) {
      if (error instanceof z.ZodError) return reply.code(400).send({ error: "source_policy.request_invalid", issues: error.issues.map(({ path, code }) => ({ path, code })).slice(0, 20) });
      const message = error instanceof Error ? error.message : "";
      const code = /^(source_policy|artifact)\.[a-z_]+(?::[a-z-]+)?$/.test(message) ? message : "source_policy.operation_failed";
      if (code === "source_policy.operation_failed") return reply.code(503).send({ error: "source_policy.authority_unavailable" });
      return reply.code(code.includes("denied") || code.includes("duties") || code.includes("revoked") ? 403 : code.includes("missing") || code.includes("not_registered") ? 404 : 400).send({ error: code });
    }
  };

  app.get("/v1/source-policies/artifacts", handle("capability.read", async (request, _reply, principal) => {
    const query = z.object({ kind: sourceArtifactKindSchema.optional() }).strict().parse(request.query);
    return { artifacts: await listSourceArtifacts(options.db, principal.tenantId, query.kind) };
  }));
  app.post("/v1/authoring/source-policies/compile", handle("draft.compile", async (request, _reply, principal) => {
    const { artifact: raw } = z.object({ artifact: sourceArtifactSchema }).strict().parse(request.body);
    if (raw.kind === "source-context" && raw.tenantId !== principal.tenantId) throw new Error("source_policy.tenant_denied");
    const compiled = raw.kind === "source-policy" ? compileJurisdictionSourcePolicy(raw) : { artifact: raw, digest: stableDigest(raw) };
    return { artifact: raw, digest: compiled.digest, status: "candidate", evaluator: "opa.source.v2" };
  }));
  app.post("/v1/source-policies/artifacts", handle("release.create", async (request, reply, principal) => {
    const body = z.object({ artifact: sourceArtifactSchema, expectedDigest: digest }).strict().parse(request.body);
    return reply.code(201).send(await registerSourceArtifact(options.db, { ...body, tenantId: principal.tenantId, actor: principal.subjectId }));
  }));
  app.post("/v1/source-policies/artifacts/:kind/:digest/approve", handle("release.approve", async (request, _reply, principal) => {
    const params = z.object({ kind: sourceArtifactKindSchema, digest }).parse(request.params);
    return approveSourceArtifact(options.db, { ...params, tenantId: principal.tenantId, actor: principal.subjectId });
  }));
  app.post("/v1/source-policies/artifacts/:kind/:digest/revoke", handle("release.revoke", async (request, _reply, principal) => {
    const params = z.object({ kind: sourceArtifactKindSchema, digest }).parse(request.params);
    const body = z.object({ reasonCode: ref }).strict().parse(request.body);
    return revokeArtifactEntry(options.db, { ...params, ...body, tenantId: principal.tenantId, actor: principal.subjectId });
  }));
  app.post("/v1/authoring/source-policies/simulate", handle("draft.evaluate", async (request, _reply, principal) => {
    const input = simulationSchema.parse(request.body);
    if (input.context && input.context.tenantId !== principal.tenantId) throw new Error("source_policy.tenant_denied");
    return { simulation: true, decision: await evaluateSourceAuthorizationWithOpa(input) };
  }));
  app.post("/v1/source-policies/eligibility", handle("capability.read", async (request, _reply, principal) => {
    const input = z.object({ runId: ref, capabilityId: ref, connectorId: ref, evidenceDecisionId: ref.optional(), recipientId: ref.optional(), redistribute: z.boolean().optional() }).strict().parse(request.body);
    await options.authorize(request, "run.read", { kind: "run", id: input.runId });
    const run = await getRun(options.db, input.runId, principal.tenantId);
    if (!run?.sourceContextDigest) throw new Error("source_policy.context_missing");
    const plan = await getPlan(options.db, run.planDigest, principal.tenantId);
    if (!plan) throw new Error("source_policy.plan_missing");
    const context = await getSourceArtifact(options.db, principal.tenantId, "source-context", run.sourceContextDigest);
    if (context.kind !== "source-context") throw new Error("source_policy.context_missing");
    const authority = await loadSourceAuthority(options.db, { tenantId: principal.tenantId, caseId: context.caseId,
      plan, contextDigest: run.sourceContextDigest, capabilityId: input.capabilityId, connectorId: input.connectorId });
    const evidence = input.evidenceDecisionId ? await getSourceDecision(options.db, principal.tenantId, input.evidenceDecisionId) : null;
    if (evidence && (evidence.stage !== "use" || evidence.decision.outcome !== "ALLOW" || evidence.decision.bindingDigest !== stableDigest(authority.binding)
      || evidence.capabilityId !== input.capabilityId || evidence.connectorId !== input.connectorId)) throw new Error("source_policy.evidence_scope_denied");
    const decision = await evaluateSourceAuthorizationWithOpa({ ...authority, capabilityId: input.capabilityId, connectorId: input.connectorId, evaluatedAt: new Date().toISOString(),
      request: { stage: evidence ? "use" : "acquire", recipientId: input.recipientId ?? principal.tenantId, redistribute: input.redistribute ?? false,
        ...(evidence?.observation ? { observation: evidence.observation } : {}) } });
    return { simulation: false, stage: evidence ? "use" : "acquire", decision, authorized: decision.outcome === "ALLOW",
      evidenceSufficient: evidence ? decision.outcome === "ALLOW" : null };
  }));
  app.get("/v1/source-policies/decisions/:runId", handle("run.read", async (request, _reply, principal) => {
    const { runId } = z.object({ runId: ref }).parse(request.params);
    return { decisions: await listSourceDecisions(options.db, principal.tenantId, runId) };
  }));
}
