import { applicationCaseType, applicationDocumentId, applicationPartyEntityId, applicationSubmissionSchema, mapApplicationSubmission, stableDigest, type ApplicationDocumentRegistration } from '@ehf/contracts';
import type { CatalogSnapshot } from '@ehf/fincrime-views';
import { actionsForRoles } from '@ehf/identity';
import type { FastifyInstance } from 'fastify';
import type { sessionAccess } from './session.js';
import { completeCaseCommand, delegatedHeaders, errorResponse, upstreamFailure } from './relay.js';
import { DOCUMENT_RUN_ACTIONS, startDocumentRun } from './document-execution.js';
import { UpstreamError, type Upstream } from './upstream.js';

/** A RecordCanonicalRecords payload holds at most this many records (recordCanonicalRecordsPayloadSchema). */
export const RECORDS_PER_COMMAND = 200;

/**
 * POST /v1/applications (C2 application intake): a submitted application becomes a populated case.
 *
 * 1. control-api selects the released plan and policy pack for the application's scope (a refusal
 *    keeps its status, reason, message and candidates, as opening a case by its scope does);
 * 2. case-api opens the case with the case type of the customer (KYB for a business or trust, KYC
 *    for a person), pinned to that plan and pack;
 * 3. each document the applicant supplied is uploaded to the case (case-api POST
 *    /v1/cases/:caseId/documents: content-addressed case evidence, untrusted until parsed), so the
 *    application's DocumentVersion records can cite the stored artifact;
 * 4. one AddSubject per party, the customer first;
 * 5. RecordCanonicalRecords with the application's records (@ehf/contracts mapApplicationSubmission);
 * 6. each uploaded document's extraction run is started (the configured document-only plan parses the
 *    original into pages and extracts its catalog fields for review). A run that cannot start (no plan
 *    configured, a submitter without run.start, or a refusal) does not undo the case: the response names
 *    it NOT_STARTED with its reason, and the document can be run from the case later.
 *
 * Every upstream call is keyed by the caller's Idempotency-Key, and the records are observed at the
 * case's creation time, so a retried submission replays: it opens no second case and records
 * nothing twice. The same key with a different application is a conflict.
 */
export function registerApplicationIntake(app: FastifyInstance, access: ReturnType<typeof sessionAccess>, upstream: Upstream, env: NodeJS.ProcessEnv, catalog: () => CatalogSnapshot) {
  // Five documents of at most 4 MiB each, base64-encoded, plus the application.
  app.post('/api/v1/applications', { bodyLimit: 32 * 1024 * 1024 }, async (request, reply) => {
    reply.header('cache-control', 'no-store').header('x-correlation-id', request.id);
    try {
      const principal = await access.resolver.resolve(request);
      const actions = actionsForRoles(principal.roles);
      if (principal.actorType !== 'human' || !actions.has('case.write')) throw new UpstreamError(403, 'authorization.role_missing');
      if (!access.csrf(request)) throw new UpstreamError(403, 'csrf.invalid');
      const key = request.headers['idempotency-key'];
      if (typeof key !== 'string' || key.length < 8 || key.length > 300) throw new UpstreamError(400, 'application.idempotency_key_required');
      const parsed = applicationSubmissionSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'application.request_invalid', message: 'The application is not valid.', status: 400, correlationId: request.id, retryable: false,
          details: { issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), code: issue.code, message: issue.message })) } });
      }
      const submission = parsed.data;
      const scope = submission.scope;
      if (submission.documents.length) {
        // Uploading documents is an evidence write too (as the case documents upload is).
        if (!actions.has('evidence.write')) throw new UpstreamError(403, 'authorization.role_missing');
        const known = new Set(catalog().entries.filter((entry) => entry.kind === 'documents' && entry.entryType === 'definition').map((entry) => entry.id));
        const unknown = submission.documents.flatMap((document, index) => known.has(document.documentType) ? [] : [{ path: `documents.${index}.documentType`, code: 'custom', message: 'application.document_type_unknown' }]);
        if (unknown.length) return reply.code(400).send({ error: 'application.request_invalid', message: 'A document type is not in the document field catalog.', status: 400, correlationId: request.id, retryable: false, details: { issues: unknown } });
      }

      // 1. The plan and pack the scope falls under. Selection is read-only, so it carries no idempotency key.
      const selectHeaders = delegatedHeaders(request, access, env); delete selectHeaders['idempotency-key'];
      const selection = await upstream('control-api', 'POST', '/v1/case-plans/select', principal, scope, selectHeaders);
      if (selection.status !== 200) {
        if (selection.status < 500) return upstreamFailure(reply, request, selection);
        throw new UpstreamError(selection.status, selection.body?.error ?? 'case.policy_authority_unavailable');
      }
      const planDigest = String(selection.body.planDigest ?? '').replace(/^sha256:/, '');
      if (!/^[a-f0-9]{64}$/.test(planDigest) || selection.body.pack?.scope?.jurisdiction !== scope.jurisdiction) throw new UpstreamError(409, 'case.plan_selection_changed');
      if (submission.harnessPlanDigest !== undefined && submission.harnessPlanDigest.replace(/^sha256:/, '') !== planDigest) throw new UpstreamError(409, 'case.plan_selection_changed');

      // 2. The case, keyed by the caller's key (the case id derives from it).
      const intakeKey = 'application_' + stableDigest({ tenantId: principal.tenantId, actor: principal.subjectId, key });
      const caseType = applicationCaseType(scope.customerType);
      const created = await upstream('case-api', 'POST', '/v1/cases', principal, {
        tenantId: principal.tenantId, ...caseType, jurisdiction: scope.jurisdiction, harnessPlanDigest: planDigest,
        policySnapshotDigest: selection.body.policySnapshotDigest, policyAuthority: selection.body.policyAuthority, classification: submission.classification,
        ...(submission.externalRef ? { externalRef: submission.externalRef } : {}), actor: { type: 'HUMAN', principalId: principal.subjectId, roles: principal.roles },
      }, { ...delegatedHeaders(request, access, env), 'idempotency-key': intakeKey });
      if (created.status >= 400) return upstreamFailure(reply, request, created);
      const caseRow = created.body?.case;
      const caseId = caseRow?.caseId;
      // The creation time is the same on every replay: the records' observation time, so their versions are too.
      if (typeof caseId !== 'string' || typeof caseRow.createdAt !== 'string') throw new UpstreamError(502, 'bff.upstream_contract_invalid');

      // 3. Documents: registered as case evidence, each keyed (a retry returns the first registration).
      const documents: ApplicationDocumentRegistration[] = [];
      for (const [index, document] of submission.documents.entries()) {
        const uploaded = await upstream('case-api', 'POST', `/v1/cases/${encodeURIComponent(caseId)}/documents`, principal, {
          filename: document.filename, mediaType: document.mediaType, contentBase64: document.contentBase64, documentType: document.documentType,
          subjectRefs: [applicationPartyEntityId(document.relatedParty)],
        }, { ...delegatedHeaders(request, access, env), 'idempotency-key': `${intakeKey}:document:${index}` });
        if (uploaded.status >= 400) return upstreamFailure(reply, request, uploaded);
        const evidence = uploaded.body?.evidence;
        const sha256 = String(evidence?.integrity?.rawDigest ?? '').replace(/^sha256:/, '');
        if (typeof evidence?.evidenceId !== 'string' || typeof evidence.integrity?.artifactRef !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)) throw new UpstreamError(502, 'bff.upstream_contract_invalid');
        documents.push({ evidenceId: evidence.evidenceId, artifactRef: evidence.integrity.artifactRef, sha256 });
      }
      const intake = mapApplicationSubmission(submission, { tenantId: principal.tenantId, observedAt: caseRow.createdAt, documents });

      // 4–5. Subjects, then records, each command keyed and sequenced from the creation (a replay
      // carries the preconditions of the original and returns its original sequence).
      const authority = { caseId, tenantId: principal.tenantId, planDigest, policyAuthority: { policySnapshotDigest: selection.body.policySnapshotDigest } };
      let sequence = 1;
      const command = async (commandType: string, payload: Record<string, unknown>, step: string) => {
        const body = completeCaseCommand({ commandType, commandVersion: '1', payload, preconditions: { caseSequence: sequence }, idempotencyKey: `${intakeKey}:${step}` },
          caseId, { ...authority, caseSequence: sequence }, principal);
        const result = await upstream('case-api', 'POST', `/v1/cases/${encodeURIComponent(caseId)}/commands`, principal, body, delegatedHeaders(request, access, env));
        if (result.status >= 400) return result;
        if (result.body?.outcome !== 'ACCEPTED' || typeof result.body.caseSequence !== 'number') throw new UpstreamError(409, 'application.command_not_accepted');
        sequence = result.body.caseSequence;
        return null;
      };
      for (const [index, subject] of intake.subjects.entries()) {
        const refused = await command('AddSubject', subject, `subject:${index}`);
        if (refused) return upstreamFailure(reply, request, refused);
      }
      for (let start = 0; start < intake.records.length; start += RECORDS_PER_COMMAND) {
        const refused = await command('RecordCanonicalRecords', { records: intake.records.slice(start, start + RECORDS_PER_COMMAND) }, `records:${start / RECORDS_PER_COMMAND}`);
        if (refused) return upstreamFailure(reply, request, refused);
      }
      // 6. Document runs, each keyed from the intake, so a replayed submission starts no second run.
      const runActions = actionsForRoles(principal.roles);
      const mayRun = DOCUMENT_RUN_ACTIONS.every((action) => runActions.has(action as never));
      const documentRuns = [];
      for (const [index, registration] of documents.entries()) {
        const documentId = applicationDocumentId(registration.sha256);
        if (!mayRun) { documentRuns.push({ documentId, status: 'NOT_STARTED', reason: 'authorization.role_missing' }); continue; }
        try {
          const started = await startDocumentRun({ upstream, env, principal, headers: delegatedHeaders(request, access, env), caseId, documentId,
            documentVersion: registration.sha256, key: `${intakeKey}:extract:${index}` });
          documentRuns.push({ documentId, status: 'STARTED', runId: started.runId });
        } catch (error) {
          if (!(error instanceof UpstreamError)) throw error;
          documentRuns.push({ documentId, status: 'NOT_STARTED', reason: error.code });
        }
      }
      // A replay answers as the original did.
      const pack = selection.body.pack;
      return reply.code(201).send({
        caseId, caseType: intake.caseType, planDigest,
        pack: { id: pack.id, scope: { jurisdiction: pack.scope.jurisdiction, institution: pack.scope.institution, ...(pack.scope.productSet ? { productSet: pack.scope.productSet } : {}), products: pack.scope.products, customerTypes: pack.scope.customerTypes } },
        subjectsAdded: intake.subjects.length, recordsRecorded: intake.records.length, documentsUploaded: documents.length, documentRuns,
      });
    } catch (error) { const failure = errorResponse(error, request); return reply.code(failure.status).send(failure.body); }
  });
}
