import { actionsForRoles } from '@ehf/identity';
import { validateResponse } from '@ehf/ui-contracts/validate';
import type { FastifyInstance } from 'fastify';
import type { sessionAccess } from './session.js';
import { delegatedHeaders, errorResponse } from './relay.js';
import { UpstreamError, type Upstream } from './upstream.js';
import { experienceReader, records, text, type Row } from './experience-read.js';

const refId = (ref: unknown): string => typeof ref === 'string' ? ref : (ref as Row)?.object_id ?? '';
const provenance = (record?: Row) => ({ agentId: record?.created_by?.principalId ?? null, skillId: record?.producer?.skillId ?? null, workItemId: record?.work_item_id ?? null });

export function ownershipView(snapshot: Row) {
  const graph = records(snapshot, 'OwnershipGraph').at(-1);
  const entities = records(snapshot, 'Entity');
  const graphData = graph?.data;
  const interests = records(snapshot, 'OwnershipInterest').filter(row => !graphData || graphData.edge_refs.some((ref: Row) => refId(ref) === row.object_id && (!ref.version_id || ref.version_id === row.version_id)));
  const ids = new Set<string>(graphData?.nodes ?? interests.flatMap(row => [row.data.owner, row.data.owned]));
  const owners = records(snapshot, 'BeneficialOwner');
  const gaps = (graphData?.unresolved ?? []).map((gap: Row) => ({ node: gap.node, reason: gap.reason, path: gap.path ?? [], interest: gap.interest ?? null }));
  for (const id of ids) if (!entities.some(row => row.object_id === id)) gaps.push({ node: id, reason: 'Referenced entity record is unavailable.', path: [id], interest: null });
  for (const ref of graphData?.edge_refs ?? []) if (!interests.some(row => row.object_id === refId(ref) && (!ref.version_id || row.version_id === ref.version_id))) gaps.push({ node: refId(ref), reason: 'Pinned ownership interest version is unavailable.', path: [], interest: null });
  if (!graph) gaps.push({ node: snapshot.caseId, reason: 'No ownership graph has been recorded. Completeness and threshold are not established.', path: [], interest: null });
  return {
    complete: graphData?.complete === true && !gaps.length, threshold: null, mode: 'direct', asOf: graph?.observed_at ?? graph?.recorded_at ?? snapshot.capturedAt,
    nodes: [...ids].map(id => {
      const entity = entities.find(row => row.object_id === id);
      const owner = owners.find(row => row.data.entity_id === id);
      const kind = entity?.data.entity_type;
      return { id, entityId: entity?.object_id ?? null, kind: kind === 'individual' ? 'person' : ['company', 'trust', 'fund'].includes(kind) ? kind : 'unknown',
        label: entity?.data.name ?? id, sublabel: entity ? null : 'Entity record unavailable', isRoot: id === graphData?.root_entity_id,
        epistemic: 'assertion', effectiveInterest: owner?.data.interest ?? null, uboStatus: owner ? 'candidate' : null, layout: null };
    }),
    edges: interests.map(row => {
      const contradiction = (snapshot.data.contradictions ?? []).find((item: Row) => (item.object_refs ?? []).some((ref: unknown) => refId(ref) === row.object_id));
      return { id: row.object_id, source: row.data.owner, target: row.data.owned, kind: 'equity', interest: row.data.interest,
        interestAlternative: null, status: contradiction && ['OPEN', 'UNDER_INVESTIGATION'].includes(contradiction.status) ? 'conflict' : 'candidate',
        evidenceIds: [], contradictionId: contradiction?.contradiction_id ?? null, label: row.data.share_class ?? 'Recorded ownership assertion' };
    }),
    gaps, producedBy: provenance(graph),
  };
}

function screeningData(snapshot: Row) {
  const entities = records(snapshot, 'Entity');
  const entries = records(snapshot, 'WatchlistEntry');
  const executions = records(snapshot, 'ScreeningExecution');
  const coverage = executions.map(row => ({ list: row.data.screening_type, version: row.data.dataset_versions.join(', ') || 'Not reported',
    complete: row.data.status === 'COMPLETED' && row.data.truncated === false && row.data.dataset_versions.length > 0,
    stale: null, limitations: [...row.data.limitations, 'Freshness against the installed policy has not been evaluated by this view.'] }));
  const hits = records(snapshot, 'ScreeningHit').map(row => {
    const entry = entries.find(item => item.object_id === row.data.entry_id);
    const entity = entities.find(item => item.object_id === row.data.entity_id);
    return { row, entry, entity };
  });
  return { coverage, hits };
}

export function screeningView(snapshot: Row) {
  const { coverage, hits } = screeningData(snapshot);
  return { findings: hits.filter(hit => hit.entry).map(({ row, entry, entity }) => ({ findingId: row.object_id, listType: entry!.data.list_type,
    subjectName: entity?.data.name ?? row.data.entity_id, entryName: entry!.data.name, listVersion: entry!.data.list_version,
    disposition: null, status: 'open', workItemId: null })), coverage, universalClearance: false,
    limitations: hits.filter(hit => !hit.entry).map(hit => `Candidate ${hit.row.object_id} references an unavailable watchlist entry; its list type and comparison cannot be established.`) };
}

export function screeningComparison(snapshot: Row, findingId: string, queue: Row[]) {
  const { hits, coverage } = screeningData(snapshot);
  const hit = hits.find(item => item.row.object_id === findingId);
  if (!hit) throw new UpstreamError(404, 'screening.finding_not_found');
  if (!hit.entry) throw new UpstreamError(409, 'screening.entry_unavailable');
  const { row, entry, entity } = hit;
  const fields = [
    { field: 'Name', subjectValue: entity?.data.name ?? null, entryValue: entry.data.name },
    { field: 'Identifiers', subjectValue: entity ? entity.data.identifiers.join(', ') || null : null, entryValue: entry.data.identifiers.join(', ') || null },
  ];
  return { findingId, listType: entry.data.list_type, entryId: entry.object_id, listVersion: entry.data.list_version,
    subject: { name: entity?.data.name ?? row.data.entity_id, exposure: 'No accepted exposure assessment is projected.' },
    rows: fields.map(field => ({ ...field, result: !field.subjectValue || !field.entryValue ? 'missing' : field.subjectValue === field.entryValue ? 'agree' : field.field === 'Identifiers' && row.data.features.identifier_conflict ? 'contradict' : 'partial' })),
    recommendation: null, coverage, humanWork: queue.find(item => item.workItem.constraints?.findingId === findingId) ?? null, options: [] };
}

export function contradictionView(snapshot: Row, contradictionId: string) {
  const row = (snapshot.data.contradictions ?? []).find((item: Row) => item.contradiction_id === contradictionId);
  if (!row) throw new UpstreamError(404, 'contradiction.not_found');
  const refs = new Set<string>((row.object_refs ?? []).map(refId));
  const canonical = records(snapshot, 'ExtractedAssertion').filter(item => refs.has(item.object_id));
  const claims = (snapshot.data.claims ?? []).filter((item: Row) => refs.has(item.claim_id));
  const assertions = [...canonical.map(item => {
    const metadata = item.data.extensions?.['ehf.document']?.value;
    const span = metadata?.source_spans?.[0];
    return { assertionId: item.object_id, value: text(item.data.value), claim: item.data.field,
      source: { kind: 'document', id: item.data.document_version, authority: 'derived' },
      observedAt: item.observed_at ?? item.recorded_at ?? snapshot.capturedAt, effectiveAt: null,
      span: span ? { documentVersion: item.data.document_version, page: Number(span.page ?? /:(\d+)$/.exec(span.page_id)?.[1] ?? 1), quote: span.quote } : null, evidenceId: null };
  }), ...claims.map((item: Row) => ({ assertionId: item.claim_id, value: text(item.value), claim: item.predicate,
    source: { kind: 'internal', id: item.claim_id, authority: 'derived' }, observedAt: item.created_at, effectiveAt: null, span: null, evidenceId: item.evidence_refs?.[0] ?? null }))];
  return { contradictionId, status: row.status === 'OPEN' || row.status === 'UNDER_INVESTIGATION' ? 'OPEN' : 'RESOLVED',
    subjectLabel: row.subject_ref ?? snapshot.caseId, field: assertions[0]?.claim ?? 'Not recorded', assertions,
    whyItMatters: row.description, reconciliation: [], producedBy: { agentId: row.created_by?.principalId ?? null, skillId: null, workItemId: null }, commands: [],
    limitations: assertions.length < 2 ? ['The contradiction does not resolve to two readable assertions. Inspect its original evidence before resolving it.'] : [] };
}

export function registerEvidenceExperience(app: FastifyInstance, access: ReturnType<typeof sessionAccess>, upstream: Upstream, env: NodeJS.ProcessEnv) {
  const routes = [
    ['getFincrimeCasesCaseIdOwnership', '/v1/fincrime/cases/:caseId/ownership'],
    ['getFincrimeCasesCaseIdContradictionsContradictionId', '/v1/fincrime/cases/:caseId/contradictions/:contradictionId'],
    ['getFincrimeCasesCaseIdScreening', '/v1/fincrime/cases/:caseId/screening'],
    ['getFincrimeCasesCaseIdScreeningFindingId', '/v1/fincrime/cases/:caseId/screening/:findingId'],
  ] as const;
  for (const [operation, path] of routes) app.get('/api' + path, async (request, reply) => {
    reply.header('cache-control', 'no-store').header('x-correlation-id', request.id);
    try {
      const principal = await access.resolver.resolve(request);
      const actions = actionsForRoles(principal.roles);
      if (principal.actorType !== 'human' || !actions.has('case.read')) throw new UpstreamError(403, 'authorization.role_missing');
      const reader = experienceReader(upstream, principal, delegatedHeaders(request, access, env));
      const { caseId, contradictionId, findingId } = request.params as Record<string, string>;
      const snapshot = await reader.snapshot(caseId!);
      let body: unknown;
      if (operation === 'getFincrimeCasesCaseIdOwnership') body = ownershipView(snapshot);
      else if (operation === 'getFincrimeCasesCaseIdContradictionsContradictionId') body = contradictionView(snapshot, contradictionId!);
      else if (operation === 'getFincrimeCasesCaseIdScreening') body = screeningView(snapshot);
      else {
        const queue = actions.has('human_work.read') ? (await reader.call('control-api', `/v1/operations/human-work?caseId=${encodeURIComponent(caseId!)}`)).items : [];
        body = screeningComparison(snapshot, findingId!, queue);
      }
      if (!validateResponse(operation, 200, body).valid) throw new UpstreamError(502, 'bff.upstream_contract_invalid');
      return body;
    } catch (error) { const failure = errorResponse(error, request); return reply.code(failure.status).send(failure.body); }
  });
}
