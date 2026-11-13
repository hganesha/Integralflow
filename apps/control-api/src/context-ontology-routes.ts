import { z } from "zod";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { getPlan, getSourceDecision, getSourceArtifact, loadSourceAuthority, type Database } from "@ehf/persistence";
import { evaluateSourceAuthorization } from "@ehf/policy-engine";
import { caseTraversalQuerySchema, stableDigest } from "@ehf/contracts";
import { signCaseTraversalProof, type JwtSigner } from "@ehf/execution-auth";
import type { PlatformAction, Principal, ResourceRef } from "@ehf/identity";

export function registerContextOntologyRoutes(app: FastifyInstance, o: { db: Database; env: NodeJS.ProcessEnv; signer?: JwtSigner; authorize: (r: FastifyRequest, a: PlatformAction, resource?: ResourceRef) => Promise<Principal> }) {
  app.post("/v1/context/traversal-target", { bodyLimit: 4096 }, async (r, reply) => {
    reply.header("cache-control", "no-store");
    const p = await o.authorize(r, "draft.read", { kind: "case-context" });
    const parsed = z.object({ planDigest: z.string().regex(/^(sha256:)?[a-f0-9]{64}$/), nodeId: z.string().min(1).max(128) }).strict().safeParse(r.body);
    if (!parsed.success) return reply.code(400).send({ error: "context.traversal_target_invalid" });
    const plan = await getPlan(o.db, parsed.data.planDigest, p.tenantId);
    if (!plan || !plan.graph.nodes.some(n => n.id === parsed.data.nodeId)) return reply.code(404).send({ error: "context.traversal_target_unavailable" });
    return { plan };
  });
  app.post("/v1/context/traversal-authority", { bodyLimit: 131072 }, async (r, reply) => {
    reply.header("cache-control", "no-store");
    const p = await o.authorize(r, "case.read", { kind: "case-context" });
    try {
      const scope = z.object({ caseId: z.string().min(1).max(512), planDigest: z.string().min(1), nodeId: z.string().min(1), snapshotDigest: z.string().regex(/^[a-f0-9]{64}$/), query: caseTraversalQuerySchema, offset: z.number().int().min(0).max(500), decisionIds: z.array(z.string().min(1).max(200)).min(1).max(300), sourceContextDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(r.body);
      const plan = await getPlan(o.db, scope.planDigest, p.tenantId);
      if (!plan || !plan.graph.nodes.some(n => n.id === scope.nodeId)) throw new Error();
      let expiresAt = new Date(Date.now() + 30000).toISOString();
      for (const id of [...new Set(scope.decisionIds)].sort()) {
        const prior = await getSourceDecision(o.db, p.tenantId, id);
        if (prior.stage !== "use" || prior.decision.outcome !== "ALLOW" || !prior.decision.contextDigest) throw new Error();
        const priorContext = await getSourceArtifact(o.db, p.tenantId, "source-context", prior.decision.contextDigest, false);
        if (priorContext.kind !== "source-context" || priorContext.caseId !== scope.caseId) throw new Error();
        const authority = await loadSourceAuthority(o.db, { tenantId: p.tenantId, caseId: scope.caseId, plan, contextDigest: scope.sourceContextDigest, capabilityId: prior.capabilityId, connectorId: prior.connectorId });
        if (stableDigest(authority.binding) !== prior.decision.bindingDigest) throw new Error();
        const decision = evaluateSourceAuthorization({ ...authority, capabilityId: prior.capabilityId, connectorId: prior.connectorId, evaluatedAt: new Date().toISOString(), request: { stage: "use", recipientId: p.tenantId, redistribute: false, ...(prior.observation ? { observation: prior.observation } : {}) } });
        if (decision.outcome !== "ALLOW") throw new Error();
        expiresAt = new Date(Math.min(Date.parse(expiresAt), Date.parse(decision.validUntil))).toISOString();
      }
      const secret = o.env.CONTEXT_TRAVERSAL_PRIVATE_KEY_PEM ?? o.env.CONTEXT_TRAVERSAL_SECRET ?? o.env.EXECUTION_ENVELOPE_SECRET;
      if (!secret && !o.signer) return reply.code(503).send({ error: "context.traversal_authority_unavailable" });
      const { sourceContextDigest: _, ...bound } = scope;
      return { proof: await signCaseTraversalProof({ ...(o.signer ? { signer: o.signer } : { secret: secret! }), tenantId: p.tenantId, actor: p.subjectId, requestDigest: stableDigest({ tenantId: p.tenantId, actor: p.subjectId, ...bound }), expiresAt }) };
    } catch (e) { return reply.code(e instanceof z.ZodError ? 400 : 403).send({ error: "context.traversal_source_use_denied" }); }
  });
}
