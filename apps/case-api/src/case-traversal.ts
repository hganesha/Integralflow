import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { caseTraversalQuerySchema, harnessPlanV2Schema, stableDigest, canonicalRecordObjectType, type CanonicalRecord, type CaseTraversalQuery, type CaseTraversalGraph } from "@ehf/contracts";
import { getCaseTraversalSnapshot, projectCanonicalCaseSnapshot, CaseStoreError, type CaseStore } from "@ehf/case-store";
import { admitHarnessPlanV2, sourceDecisionIdsForSelection } from "@ehf/runtime-core";
import { canonicalRelationships } from "@ehf/library-contracts";
import { traverseCaseRecords } from "@ehf/context-plane";
import { verifyCaseTraversalProof } from "@ehf/execution-auth";
import type { PlatformAction, Principal, ResourceRef } from "@ehf/identity";

const bodySchema = z.object({ plan: harnessPlanV2Schema, nodeId: z.string().min(1).max(128), query: caseTraversalQuerySchema,
  sourceProof: z.string().max(20000).optional(), challengeToken: z.string().min(1).max(4096).optional() }).strict();
type Scope = { kind: "cursor"; tenant: string; actor: string; caseId: string; planDigest: string; nodeId: string; query: CaseTraversalQuery; snapshotDigest: string; offset: number; expires: number; limited: boolean };
export function registerCaseTraversal(app: FastifyInstance, o: { store: CaseStore; env: NodeJS.ProcessEnv; authorize: (r: FastifyRequest, a: PlatformAction, resource: ResourceRef) => Promise<Principal> }) {
  const secret = o.env.CONTEXT_TRAVERSAL_CURSOR_SECRET ?? randomBytes(32).toString("hex");
  if (secret.length < 24) throw new Error("context.traversal_cursor_secret_invalid");
  const sign = (scope: object) => { const payload = Buffer.from(JSON.stringify(scope)).toString("base64url"); return `${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`; };
  const decode = (cursor: string): Record<string, unknown> => {
    try {
      const [payload, signature, extra] = cursor.split("."); if (!payload || !signature || extra) throw new Error();
      const expected = createHmac("sha256", secret).update(payload).digest(); const actual = Buffer.from(signature, "base64url");
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error();
      const value = JSON.parse(Buffer.from(payload, "base64url").toString()) as Record<string, unknown>;
      if (typeof value.expires !== "number" || value.expires <= Date.now()) throw new Error();
      return value;
    } catch { throw new CaseStoreError("context.traversal_cursor_invalid", 409); }
  };
  const read = (cursor: string): Scope => {
    const value = decode(cursor);
    if (value.kind !== "cursor" || !Number.isInteger(value.offset) || Number(value.offset) < 1 || Number(value.offset) > 500) throw new CaseStoreError("context.traversal_cursor_invalid", 409);
    return value as Scope;
  };
  // Escape the literal colon so this route coexists with context:preview.
  app.post("/v2/cases/:caseId/context::traverse", { bodyLimit: 2 * 1024 * 1024 }, async (r, reply) => {
    reply.header("cache-control", "no-store");
    const caseId = (r.params as { caseId: string }).caseId;
    const principal = await o.authorize(r, "case.read", { kind: "case", id: caseId });
    await o.authorize(r, "draft.read", { kind: "case-context" });
    if (principal.actorType !== "human") throw new CaseStoreError("context.traversal_interactive_required", 403);
    try {
      const body = bodySchema.parse(r.body);
      const plan = admitHarnessPlanV2(body.plan);
      const target = plan.graph.nodes.find(n => n.id === body.nodeId);
      if (!target || !plan.permissionEnvelopes.some(e => e.nodeId === target.id)) throw new CaseStoreError("context.traversal_target_denied", 403);
      const selectors = plan.contextSelectors.filter(s => target.contextSelectorIds.includes(s.id) && canonicalRecordObjectType(s));
      const purposes = [...new Set(selectors.map(s => s.purpose))];
      if (!selectors.length || purposes.length !== 1) throw new CaseStoreError("context.traversal_scope_ambiguous", 403);
      const cursor = body.query.cursor ? read(body.query.cursor) : undefined;
      const { cursor: _cursor, ...supplied } = body.query;
      const normalized = { ...supplied, asOf: supplied.asOf ?? cursor?.query.asOf ?? new Date().toISOString(), knowledgeCutoff: supplied.knowledgeCutoff ?? cursor?.query.knowledgeCutoff ?? new Date().toISOString() };
      if (cursor && (cursor.tenant !== principal.tenantId || cursor.actor !== principal.subjectId || cursor.caseId !== caseId || cursor.planDigest !== plan.planDigest || cursor.nodeId !== target.id || stableDigest(cursor.query) !== stableDigest(normalized))) throw new CaseStoreError("context.traversal_cursor_scope_denied", 403);
      if (Date.parse(normalized.asOf) > Date.now() || Date.parse(normalized.knowledgeCutoff) > Date.now()) throw new CaseStoreError("context.traversal_time_invalid", 400);
      const classifications = plan.contextClassificationPolicies.filter(p => p.action === "allow").map(p => p.classification);
      const snapshot = await getCaseTraversalSnapshot(o.store, principal.tenantId, caseId, { purpose: purposes[0]!, selectors, classifications,
        ...(normalized.subjects ? { subjects: normalized.subjects } : {}), asOf: normalized.asOf, knowledgeCutoff: normalized.knowledgeCutoff });
      if (!snapshot) throw new CaseStoreError("case.not_found", 404);
      if (snapshot.tenantId !== principal.tenantId || snapshot.caseId !== caseId || snapshot.planDigest.replace(/^sha256:/, "") !== plan.planDigest.replace(/^sha256:/, "")) throw new CaseStoreError("context.traversal_plan_mismatch", 403);
      const projected = projectCanonicalCaseSnapshot(snapshot, selectors, plan.contextClassificationPolicies);
      const rules = canonicalRelationships();
      const snapshotDigest = stableDigest({ snapshot: projected.snapshotDigest, relationshipDigest: rules.digest });
      if (cursor && cursor.snapshotDigest !== snapshotDigest) throw new CaseStoreError("context.traversal_snapshot_changed", 409);
      // No metadata, count, node, or cursor leaves the service until source use is reauthorized.
      const decisionIds = sourceDecisionIdsForSelection(projected.data.records ?? {});
      if (decisionIds.length > 300 || decisionIds.some(id => id.length > 200)) throw new CaseStoreError("context.traversal_scope_too_large", 413);
      const requestDigest = stableDigest({ tenantId: principal.tenantId, actor: principal.subjectId, caseId, planDigest: plan.planDigest, nodeId: target.id, snapshotDigest, query: normalized, offset: cursor?.offset ?? 0, decisionIds });
      if (decisionIds.length) {
        const verificationKey = o.env.CONTEXT_TRAVERSAL_PUBLIC_KEY_PEM ?? o.env.EXECUTION_ENVELOPE_PUBLIC_KEY_PEM ?? o.env.CONTEXT_TRAVERSAL_SECRET ?? o.env.EXECUTION_ENVELOPE_SECRET;
        if (!verificationKey) throw new CaseStoreError("context.traversal_authority_unavailable", 503);
        if (!body.sourceProof || !body.challengeToken) {
          // Stateless signed challenges can be retried on any replica sharing the cursor key.
          const challengeToken = sign({ kind: "challenge", tenant: principal.tenantId, actor: principal.subjectId, digest: requestDigest, expires: Date.now() + 30000 });
          return reply.code(403).send({ error: "context.traversal_source_authority_required", details: { caseId, planDigest: plan.planDigest, nodeId: target.id, snapshotDigest, query: normalized, offset: cursor?.offset ?? 0, decisionIds, challengeToken } });
        }
        const held = decode(body.challengeToken);
        if (held.kind !== "challenge" || held.tenant !== principal.tenantId || held.actor !== principal.subjectId || held.digest !== requestDigest) throw new CaseStoreError("context.traversal_challenge_expired", 409);
        await verifyCaseTraversalProof(body.sourceProof, verificationKey, { tenantId: principal.tenantId, actor: principal.subjectId, requestDigest });
      }
      const records = Object.values(projected.data.records ?? {}).flat().filter((v): v is CanonicalRecord => Boolean(v && typeof v === "object" && "object_id" in v)) as CanonicalRecord[];
      const graph = traverseCaseRecords(records, rules.relationships, normalized, cursor?.offset ?? 0);
      const scope: Scope = { kind: "cursor", tenant: principal.tenantId, actor: principal.subjectId, caseId, planDigest: plan.planDigest, nodeId: target.id, query: normalized, snapshotDigest, offset: graph.offset, limited: graph.truncated || Boolean(cursor?.limited), expires: cursor?.expires ?? Date.now() + 5 * 60 * 1000 };
      const response: CaseTraversalGraph = { scope: "authorized_case", snapshotDigest, relationshipDigest: rules.digest, asOf: normalized.asOf, knowledgeCutoff: normalized.knowledgeCutoff,
        purpose: purposes[0]!, subjects: (snapshot.data.subjects as Array<{ subject_id: string }>).map(s => s.subject_id), root: graph.root,
        nodes: graph.nodes, edges: graph.edges, unresolved: graph.unresolved, nextCursor: graph.hasMore ? sign(scope) : null, complete: !graph.hasMore && !scope.limited, truncated: scope.limited,
        limitations: ["Scope is the pinned node's record selectors and allowed classifications, purpose and subjects; context-packet budgets do not limit traversal.", "Missing or inaccessible endpoints are indistinguishable. Exact references never resolve to a substitute version.", "Completeness applies only to the requested depth and direction in this authorized projection."] };
      return response;
    } catch (e) {
      if (e instanceof CaseStoreError) throw e;
      if (e instanceof z.ZodError) return reply.code(400).send({ error: "context.traversal_request_invalid" });
      if (e instanceof Error && ["context.traversal_root_unavailable", "context.traversal_record_too_large"].includes(e.message)) return reply.code(e.message.endsWith("too_large") ? 413 : 404).send({ error: e.message });
      return reply.code(403).send({ error: "context.traversal_authority_denied" });
    }
  });
}
