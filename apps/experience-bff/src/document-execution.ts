import { DOCUMENT_EXTRACTION_REVIEW, isDocumentExtractionPlan, stableDigest, type HarnessPlanV2 } from '@ehf/contracts';
import { actionsForRoles, type Principal } from '@ehf/identity';
import { caseDocumentDetail } from '@ehf/fincrime-views';
import type { FastifyInstance } from 'fastify';
import type { sessionAccess } from './session.js';
import { completeCaseCommand, delegatedHeaders, errorResponse } from './relay.js';
import { documentRecords, experienceReader, type Row } from './experience-read.js';
import { UpstreamError, type Upstream } from './upstream.js';

/** The roles a person needs to authorize and start a document-only extraction run. */
export const DOCUMENT_RUN_ACTIONS = ['case.read', 'case.review', 'evidence.read', 'run.start'] as const;

export type DocumentRunContext = {
  upstream: Upstream; env: NodeJS.ProcessEnv; principal: Principal; headers: Record<string, string>;
  caseId: string; documentId: string; documentVersion: string; key: string;
};

/**
 * Authorize and start the configured document-only extraction run over one immutable case document:
 * the verified original bytes are parsed into pages and the catalog fields extracted for human review.
 * The authorization is a RecordReview keyed by the request, so a retry starts no second run.
 */
export async function startDocumentRun({ upstream, env, principal, headers, caseId, documentId, documentVersion, key }: DocumentRunContext): Promise<{ runId: string }> {
  const planDigest = env.BFF_DOCUMENT_PLAN_DIGEST?.replace(/^sha256:/, '');
  if (!planDigest || !/^[a-f0-9]{64}$/.test(planDigest)) throw new UpstreamError(409, 'document.extraction_plan_not_configured');
  const reader = experienceReader(upstream, principal, headers);
  const snapshot = await reader.snapshot(caseId);
  const version = documentVersion.replace(/^sha256:/, '');
  const detail = caseDocumentDetail(documentId, documentRecords(snapshot), {}, { evidence: snapshot.data.evidence ?? [], reviews: snapshot.data.reviews ?? [] });
  if (!detail) throw new UpstreamError(404, 'document.not_found');
  if (detail.document.documentVersion.replace(/^sha256:/, '') !== version || !detail.document.evidenceId) throw new UpstreamError(409, 'document.version_conflict');
  const original = await reader.call('case-api', `/v1/evidence/${encodeURIComponent(detail.document.evidenceId)}/content`);
  if (original.caseId !== caseId || original.rawDigest?.replace(/^sha256:/, '') !== version || typeof original.contentBase64 !== 'string') throw new UpstreamError(409, 'document.version_conflict');
  const plan = await reader.call('control-api', `/v1/plans/${planDigest}`) as HarnessPlanV2;
  if (plan.planDigest !== planDigest || !isDocumentExtractionPlan(plan)) throw new UpstreamError(409, 'document.extraction_plan_invalid');
  const requestKey = 'document_' + stableDigest({ key, tenantId: principal.tenantId, actor: principal.subjectId, caseId });
  const authorization = { documentId, documentVersion: version, evidenceId: detail.document.evidenceId, planDigest, requestKey };
  const existing = (snapshot.data.reviews ?? []).find((review: Row) => review.review_type === DOCUMENT_EXTRACTION_REVIEW && review.details?.requestKey === requestKey);
  if (existing && stableDigest(existing.details.authorization) !== stableDigest(authorization)) throw new UpstreamError(409, 'run.idempotency_conflict');
  if (!existing) {
    const command = completeCaseCommand({ commandType: 'RecordReview', commandVersion: '1.0.0',
      payload: { reviewType: DOCUMENT_EXTRACTION_REVIEW, outcome: 'AUTHORIZED', objectRef: documentId,
        rationale: 'Authorize extraction of this document version with the configured document-only plan.', documentRunAuthorization: authorization },
      preconditions: { caseSequence: snapshot.caseSequence }, idempotencyKey: requestKey + ':authorize' }, caseId, snapshot, principal);
    const receipt = await reader.call('case-api', `/v1/cases/${encodeURIComponent(caseId)}/commands`, 'POST', command);
    if (receipt.outcome !== 'ACCEPTED') throw new UpstreamError(409, 'document.authorization_not_accepted');
  }
  const result = await upstream('control-api', 'POST', '/v1/runs', principal, {
    planDigest, input: { tenantId: principal.tenantId, caseId, documentId, documentVersion: version, evidenceId: authorization.evidenceId, filename: detail.document.filename ?? documentId, contentBase64: original.contentBase64 },
    ...(env.BFF_DOCUMENT_SOURCE_CONTEXT_DIGEST ? { sourceContextDigest: env.BFF_DOCUMENT_SOURCE_CONTEXT_DIGEST } : {}),
  }, { ...headers, 'idempotency-key': requestKey });
  if (result.status >= 400) throw new UpstreamError(result.status, result.body?.error ?? 'document.run_not_admitted');
  if (!result.body.run?.runId) throw new UpstreamError(502, 'bff.upstream_contract_invalid');
  return { runId: result.body.run.runId };
}

export function registerDocumentExecution(app: FastifyInstance, access: ReturnType<typeof sessionAccess>, upstream: Upstream, env: NodeJS.ProcessEnv) {
  app.post('/api/v1/fincrime/cases/:caseId/documents/:documentId/rerun', async (request, reply) => {
    reply.header('cache-control', 'no-store').header('x-correlation-id', request.id);
    try {
      const principal = await access.resolver.resolve(request);
      const actions = actionsForRoles(principal.roles);
      if (principal.actorType !== 'human' || !DOCUMENT_RUN_ACTIONS.every(action => actions.has(action as never))) throw new UpstreamError(403, 'authorization.role_missing');
      if (!access.csrf(request)) throw new UpstreamError(403, 'csrf.invalid');
      const key = request.headers['idempotency-key'];
      const input = request.body as Row;
      if (typeof key !== 'string' || !key || key.length > 300) throw new UpstreamError(400, 'run.idempotency_key_required');
      if (!input || !/^(sha256:)?[a-f0-9]{64}$/.test(input.documentVersion)) throw new UpstreamError(400, 'document.version_required');
      const { caseId, documentId } = request.params as { caseId: string; documentId: string };
      const started = await startDocumentRun({ upstream, env, principal, headers: delegatedHeaders(request, access, env), caseId, documentId, documentVersion: input.documentVersion, key });
      return reply.code(200).send(started);
    } catch (error) { const failure = errorResponse(error, request); return reply.code(failure.status).send(failure.body); }
  });
}
