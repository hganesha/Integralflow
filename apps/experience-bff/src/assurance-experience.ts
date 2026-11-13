import { actionsForRoles } from '@ehf/identity';
import { validateResponse } from '@ehf/ui-contracts/validate';
import type { FastifyInstance } from 'fastify';
import type { sessionAccess } from './session.js';
import { delegatedHeaders, errorResponse } from './relay.js';
import { experienceReader, records, type Row } from './experience-read.js';
import { UpstreamError, type Upstream } from './upstream.js';

export function lineageView(snapshot: Row, requested?: string) {
  const data = snapshot.data;
  const finals: Row[] = data.finalDispositions ?? [];
  const recommendations: Row[] = data.decisionRecommendations ?? [];
  const selected = requested ? [...finals, ...recommendations].find(row => (row.disposition_id ?? row.recommendation_id) === requested) : finals.at(-1) ?? recommendations.at(-1);
  if (!selected) throw new UpstreamError(404, 'lineage.decision_not_found');
  const nodes: Row[] = [], edges: Row[] = [], gaps: string[] = [];
  const rows = new Map<string, Row>();
  for (const [table, key, column, epistemic] of [
    ['finalDispositions', 'disposition_id', 'decision', 'decision'],
    ['decisionRecommendations', 'recommendation_id', 'decision', 'recommendation'],
    ['gateResults', 'gate_result_id', 'policy_evaluation', 'decision'],
    ['findings', 'finding_id', 'findings', 'finding'],
    ['facts', 'fact_id', 'facts_claims', 'fact'], ['claims', 'claim_id', 'facts_claims', 'claim'],
    ['assumptions', 'assumption_id', 'facts_claims', 'assumption'], ['evidence', 'evidence_id', 'evidence', 'observation'],
  ] as const) for (const row of data[table] ?? []) {
    const id = row[key];
    rows.set(id, row);
    nodes.push({ id, column, epistemic, title: row.predicate ?? row.reason ?? row.outcome ?? row.decision ?? id,
      subtitle: row.rationale ?? row.proposition ?? row.evidence_type ?? null, sourceCommandId: null, corrected: false });
  }
  for (const [kind, column, epistemic] of [['Evidence', 'evidence', 'observation'], ['SourceRecord', 'sources', 'observation'], ['ExtractedAssertion', 'facts_claims', 'assertion']] as const) {
    for (const row of records(snapshot, kind)) {
      if (rows.has(row.object_id)) continue;
      rows.set(row.object_id, row);
      nodes.push({ id: row.object_id, column, epistemic, title: row.data.field ?? row.data.source ?? row.object_id,
        subtitle: kind === 'ExtractedAssertion' ? 'Unverified extracted assertion' : null, sourceCommandId: null, corrected: false });
    }
  }
  const add = (from: string, to: string) => {
    if (!rows.has(from)) { gaps.push(`Supporting record ${from} referenced by ${to} is unavailable.`); return; }
    if (!edges.some(edge => edge.from === from && edge.to === to)) edges.push({ from, to });
  };
  for (const [id, row] of rows) {
    for (const key of ['evidence_refs', 'fact_refs', 'finding_refs', 'basis_refs', 'supporting_refs']) for (const ref of row[key] ?? []) {
      const from = typeof ref === 'string' ? ref : ref.object_id;
      if (from) add(from, id);
    }
    for (const key of ['recommendation_ref', 'gate_result_ref', 'source_claim_id']) if (row[key]) add(row[key], id);
    if (row.data?.source_id) add(row.data.source_id, id);
    for (const ref of row.source_refs ?? []) if (ref.object_id) add(ref.object_id, id);
  }
  for (const edge of data.lineageEdges ?? []) if (rows.has(edge.target_id)) add(edge.source_id, edge.target_id);
  const decisionRef = selected.disposition_id ?? selected.recommendation_id;
  const reachable = new Set<string>([decisionRef]);
  let changed = true;
  while (changed) { changed = false; for (const edge of edges) if (reachable.has(edge.to) && !reachable.has(edge.from)) { reachable.add(edge.from); changed = true; } }
  const visible = nodes.filter(node => reachable.has(node.id));
  const decidedBy = selected.authorized_actor?.principalId ? [selected.authorized_actor.principalId] : [];
  const preparedBy = [...new Set<string>(visible.filter(node => node.epistemic !== 'decision').map(node => rows.get(node.id)?.created_by?.principalId ?? rows.get(node.id)?.asserted_by?.principalId).filter(Boolean))];
  if (!selected.disposition_id) gaps.push('This is a recorded recommendation; no final disposition is recorded.');
  if (!edges.some(edge => edge.to === decisionRef)) gaps.push('No supporting references are recorded for this decision or recommendation.');
  return { caseId: snapshot.caseId, decisionRef, asOf: selected.created_at,
    columns: ['decision', 'policy_evaluation', 'findings', 'facts_claims', 'evidence', 'sources'], nodes: visible,
    edges: edges.filter(edge => reachable.has(edge.from) && reachable.has(edge.to)), gaps: [...new Set(gaps)],
    authority: { decidedBy, preparedBy, distinctActors: new Set([...decidedBy, ...preparedBy]).size } };
}

type Recorded = { entry: Row; raw: Row };
export function recordedChronology(snapshot: Row, events: Row[], runs: { run: Row; events: Row[] }[], queue: Row[]): Recorded[] {
  const recorded: Recorded[] = events.filter(event => event.caseSequence <= snapshot.caseSequence).map(event => ({ raw: event,
    entry: { ref: `case_event:${snapshot.caseId}:${event.caseSequence}`, source: 'case_event', sequence: event.caseSequence, code: event.eventType,
      summary: event.eventType, actor: { type: event.actor.type, principalId: event.actor.principalId, label: event.actor.principalId },
      status: 'Recorded', occurredAt: event.occurredAt, runId: event.execution?.runId ?? null, workItemId: null, traceId: null, interrupt: false } }));
  for (const { run, events: runEvents } of runs) for (const event of runEvents) recorded.push({ raw: event,
    entry: { ref: `run_event:${run.runId}:${event.sequence}`, source: 'run_event', sequence: event.sequence, code: event.code,
      summary: event.message ?? event.code, actor: { type: 'runtime', principalId: event.values?.workerId ?? null, label: event.values?.workerId ?? 'Runtime' },
      status: event.status ?? event.code, occurredAt: event.occurredAt, runId: run.runId, workItemId: event.values?.workItemId ?? null,
      traceId: run.traceId ?? null, interrupt: /human|approval|interrupt/.test(event.code) } });
  for (const item of queue) for (const decision of item.decisions ?? []) recorded.push({ raw: decision,
    entry: { ref: `human_decision:${item.workItem.workItemId}:${decision.decisionId}`, source: 'human_decision', sequence: decision.caseSequence ?? 0,
      code: decision.decision, summary: decision.rationale ?? decision.decision,
      actor: { type: 'HUMAN', principalId: decision.principalId, label: decision.principalId }, status: decision.decision,
      occurredAt: decision.decidedAt ?? decision.occurredAt, runId: item.workItem.constraints?.runId ?? null, workItemId: item.workItem.workItemId, traceId: null, interrupt: true } });
  return recorded.sort((a, b) => a.entry.occurredAt.localeCompare(b.entry.occurredAt) || a.entry.ref.localeCompare(b.entry.ref));
}

/** Causal links come only from recorded identifiers; adjacent timestamps are not causality. */
export function causalGraph(recorded: Recorded[], focus?: string) {
  const selected = focus ?? recorded[0]?.entry.ref ?? '';
  if (focus && !recorded.some(row => row.entry.ref === focus)) throw new UpstreamError(404, 'recorder.entry_not_found');
  const edges: Row[] = [];
  for (const target of recorded) {
    const parent = target.raw.causationId ?? target.raw.payload?.causationId ?? target.raw.values?.causationId;
    if (!parent) continue;
    const source = recorded.find(row => row.raw.eventId === parent || row.raw.commandRef === parent || row.entry.ref === parent);
    if (source && source !== target) edges.push({ from: source.entry.ref, to: target.entry.ref, inFocus: source.entry.ref === selected || target.entry.ref === selected });
  }
  return { focus: selected, lanes: ['business', 'agent_workflow', 'capabilities', 'human', 'technical'],
    nodes: recorded.map(({ entry }) => ({ id: entry.ref, ref: entry.ref, lane: entry.source === 'case_event' ? 'business' : entry.source === 'human_decision' ? 'human' : 'agent_workflow',
      label: entry.summary, sublabel: entry.code, kind: entry.source === 'human_decision' ? 'human' : entry.interrupt ? 'interrupt' : /fail|error/.test(entry.status) ? 'failure' : 'event', at: entry.occurredAt, inFocus: entry.ref === selected })), edges,
    limitations: ['Only explicit recorded causation identifiers create links. Clock order alone does not establish causality.'] };
}

export function registerAssuranceExperience(app: FastifyInstance, access: ReturnType<typeof sessionAccess>, upstream: Upstream, env: NodeJS.ProcessEnv) {
  const routes = [
    ['getFincrimeCasesCaseIdLineage', '/v1/fincrime/cases/:caseId/lineage', 'case.read'],
    ['getFincrimeCasesCaseIdRecorder', '/v1/fincrime/cases/:caseId/recorder', 'event.read'],
    ['getFincrimeCasesCaseIdRecorderCausality', '/v1/fincrime/cases/:caseId/recorder/causality', 'event.read'],
    ['getFincrimeCasesCaseIdRecorderEntriesEntryRef', '/v1/fincrime/cases/:caseId/recorder/entries/:entryRef', 'event.read'],
  ] as const;
  for (const [operation, path, action] of routes) app.get('/api' + path, async (request, reply) => {
    reply.header('cache-control', 'no-store').header('x-correlation-id', request.id);
    try {
      const principal = await access.resolver.resolve(request);
      const actions = actionsForRoles(principal.roles);
      if (principal.actorType !== 'human' || !actions.has(action) || !actions.has('case.read')) throw new UpstreamError(403, 'authorization.role_missing');
      const reader = experienceReader(upstream, principal, delegatedHeaders(request, access, env));
      const { caseId, entryRef } = request.params as Record<string, string>;
      const query = request.query as Record<string, string>;
      const snapshot = await reader.snapshot(caseId!);
      let body: unknown;
      if (operation === 'getFincrimeCasesCaseIdLineage') body = lineageView(snapshot, query.decision);
      else {
        const events = await reader.pages('case-api', `/v1/cases/${encodeURIComponent(caseId!)}/events?after=0`, 'events', 'after');
        const runRows = actions.has('run.read') ? await reader.pages('control-api', '/v1/runs', 'runs') : [];
        const ids = new Set((snapshot.data.executionRefs ?? []).map((row: Row) => row.run_id));
        const matching = runRows.filter(run => run.input?.caseId === caseId || ids.has(run.runId));
        const runs = await Promise.all(matching.map(async run => {
          // A linked run must still belong to this case before its events are disclosed.
          if (run.input?.caseId !== caseId || run.input?.tenantId !== principal.tenantId) throw new UpstreamError(403, 'case.execution_mismatch');
          return { run, events: await reader.pages('control-api', `/v1/runs/${encodeURIComponent(run.runId)}/events?after=0`, 'events', 'after') };
        }));
        const queue = actions.has('human_work.read') ? (await reader.call('control-api', `/v1/operations/human-work?caseId=${encodeURIComponent(caseId!)}&limit=500&includeTerminal=true`)).items : [];
        const recorded = recordedChronology(snapshot, events, runs, queue);
        if (operation === 'getFincrimeCasesCaseIdRecorderCausality') body = causalGraph(recorded, query.focus);
        else if (operation === 'getFincrimeCasesCaseIdRecorderEntriesEntryRef') {
          const record = recorded.find(row => row.entry.ref === entryRef);
          if (!record) throw new UpstreamError(404, 'recorder.entry_not_found');
          const ledger = await reader.call('case-api', `/v1/cases/${encodeURIComponent(caseId!)}/ledger:verify`, 'POST', {});
          body = { ...record, ledger: { verified: ledger.valid, headDigest: ledger.headDigest ?? null, checkedEvents: ledger.checkedEvents, failedSequence: ledger.failedSequence ?? null } };
        } else body = { caseId, historical: false, finalState: snapshot.data.finalDispositions?.length ? snapshot.data.case.status : null,
          counts: { events: recorded.length, interrupts: recorded.filter(row => row.entry.interrupt).length }, entries: recorded.map(row => row.entry),
          traces: matching.filter(run => run.traceId).map(run => ({ traceId: run.traceId, runId: run.runId })),
          limitations: [...(!actions.has('human_work.read') ? ['Human decisions are omitted because your role cannot read the human-work queue.'] : []), ...(queue.length >= 500 ? ['Human-work history is bounded to 500 queue items.'] : [])] };
      }
      if (!validateResponse(operation, 200, body).valid) throw new UpstreamError(502, 'bff.upstream_contract_invalid');
      return body;
    } catch (error) { const failure = errorResponse(error, request); return reply.code(failure.status).send(failure.body); }
  });
}
