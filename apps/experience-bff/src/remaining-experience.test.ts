import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { buildApp } from './app.js';
import { ownershipView, screeningView, contradictionView } from './evidence-experience.js';
import { lineageView, recordedChronology, causalGraph } from './assurance-experience.js';
import { jaegerTrace } from './trace-experience.js';
import { documentRecords, experienceReader, type Row } from './experience-read.js';
import type { Upstream } from './upstream.js';

const at = '2026-11-10T12:00:00Z';
const digest = 'a'.repeat(64);
const principal = { subjectId: 'reviewer', tenantId: 'tenant-test', actorType: 'human' as const, roles: ['Harness.Operator', 'Case.Reviewer'], source: 'local' as const };
const canonical = (object_type: string, object_id: string, data: Row) => ({ object_type, object_id, version_id: 'v1', data, observed_at: at, recorded_at: at });
function snapshot(): Row {
  return { tenantId: principal.tenantId, caseId: 'case-test', caseSequence: 4, capturedAt: at, snapshotDigest: digest, planDigest: digest,
    policyAuthority: { policyId: 'policy', policyVersion: '1.0.0', policySnapshotDigest: digest, policyBundleDigest: digest },
    data: { case: { caseType: 'kyc_onboarding', jurisdiction: 'US', status: 'INTAKE' }, subjects: [], evidence: [], reviews: [],
      records: { Entity: [canonical('Entity', 'subject', { name: 'Example', entity_type: 'company', identifiers: ['ID-1'] })],
        WatchlistEntry: [canonical('WatchlistEntry', 'entry', { name: 'Example', identifiers: ['ID-2'], list_type: 'sanctions', list_version: 'list-v1', coverage: { complete: true } })],
        ScreeningHit: [canonical('ScreeningHit', 'hit', { entity_id: 'subject', entry_id: 'entry', features: { identifier_conflict: true } })],
        ScreeningExecution: [canonical('ScreeningExecution', 'execution', { screening_type: 'sanctions', dataset_versions: ['list-v1'], status: 'PARTIAL', truncated: true, limitations: ['Partial source'] })] },
      contradictions: [], claims: [], facts: [], findings: [], executionRefs: [], workItems: [], finalDispositions: [], decisionRecommendations: [] } };
}
const event = { eventId: 'event-1', caseSequence: 1, eventType: 'claim.recorded', occurredAt: at, actor: { type: 'HUMAN', principalId: 'author' }, payload: {} };

describe('record-backed projections', () => {
  it('keeps an uploaded original browsable without inventing parsed pages or assertions', () => {
    const value = snapshot();
    value.data.evidence = [{ evidence_type: 'DOCUMENT', evidence_id: 'upload', raw_digest: digest, source: { type: 'UPLOAD', dataset: 'document:sample.pdf' } }];
    const uploaded = documentRecords(value).filter(row => row.object_type === 'DocumentVersion');
    expect(uploaded).toHaveLength(1);
    expect(uploaded[0]!.data.page_count).toBe(0);
    expect(documentRecords(value).filter(row => row.object_type === 'DocumentPage')).toEqual([]);
  });
  it('does not invent ownership completeness, thresholds, verification or screening freshness', () => {
    const value = snapshot();
    expect(ownershipView(value)).toMatchObject({ complete: false, threshold: null, nodes: [], edges: [] });
    const view = screeningView(value);
    expect(view.universalClearance).toBe(false);
    expect(view.coverage[0]).toMatchObject({ complete: false, stale: null });
    expect(view.findings[0]).toMatchObject({ findingId: 'hit', disposition: null, status: 'open' });
  });
  it('discloses missing watchlist entries instead of fabricating comparisons', () => {
    const value = snapshot(); value.data.records.WatchlistEntry = [];
    expect(screeningView(value).findings).toEqual([]);
    expect(screeningView(value).limitations[0]).toContain('unavailable watchlist entry');
  });
  it('preserves an unresolved contradiction with fewer than two readable assertions', () => {
    const value = snapshot();
    value.data.contradictions = [{ contradiction_id: 'conflict', description: 'Sources conflict', status: 'UNDER_INVESTIGATION', object_refs: ['missing'] }];
    expect(contradictionView(value, 'conflict')).toMatchObject({ status: 'OPEN', assertions: [], commands: [] });
    expect(contradictionView(value, 'conflict').limitations).toHaveLength(1);
  });
  it('traces explicit support and keeps recommendations distinct from dispositions', () => {
    const value = snapshot();
    value.data.claims = [{ claim_id: 'claim', predicate: 'Name', evidence_refs: ['evidence-missing'] }];
    value.data.decisionRecommendations = [{ recommendation_id: 'recommendation', outcome: 'APPROVE', created_at: at, supporting_refs: ['claim'] }];
    const graph = lineageView(value);
    expect(graph.authority.decidedBy).toEqual([]);
    expect(graph.nodes.find(node => node.id === 'recommendation')?.epistemic).toBe('recommendation');
    expect(graph.edges).toContainEqual({ from: 'claim', to: 'recommendation' });
    expect(graph.gaps.some(gap => gap.includes('evidence-missing'))).toBe(true);
    expect(() => lineageView(value, 'foreign')).toThrow('lineage.decision_not_found');
  });
  it('does not substitute a later case event or infer causality from timestamps', () => {
    const rows = recordedChronology(snapshot(), [event, { ...event, eventId: 'future', caseSequence: 5 }], [], []);
    expect(rows).toHaveLength(1);
    expect(causalGraph(rows, rows[0]!.entry.ref).edges).toEqual([]);
    expect(() => causalGraph(rows, 'foreign')).toThrow('recorder.entry_not_found');
  });
  it('fails repeated pagination cursors rather than reporting partial totals', async () => {
    const upstream = vi.fn<Upstream>(async () => ({ status: 200, body: { runs: [], nextCursor: 'same' } }));
    await expect(experienceReader(upstream, principal, {}).pages('control-api', '/v1/runs', 'runs')).rejects.toThrow('pagination.cursor_repeated');
  });
});

describe('remaining Experience API routes', () => {
  function appFor(value = snapshot(), roles = principal.roles) {
    const upstream = vi.fn<Upstream>(async (_service, method, path) => {
      if (path.startsWith('/v2/cases/')) return { status: 200, body: value };
      if (path.includes('/events?')) return { status: 200, body: { events: [event], nextCursor: null } };
      if (path.includes('/ledger:verify')) return { status: 200, body: { valid: false, headDigest: digest, checkedEvents: 1, failedSequence: 1 } };
      if (path.startsWith('/v1/runs?')) return { status: 200, body: { runs: [], nextCursor: null } };
      if (path.startsWith('/v1/plan-records?')) return { status: 200, body: { records: [], nextCursor: null } };
      if (path.startsWith('/v1/operations/human-work')) return { status: 200, body: { items: [] } };
      if (path.startsWith('/v1/registry/artifacts/')) return { status: 200, body: { status: 'revoked' } };
      if (method === 'GET' && path === '/health/ready') return { status: 200, body: { status: 'ready' } };
      return { status: 404, body: { error: 'resource.not_found' } };
    });
    return { upstream, app: buildApp({ env: {}, principalResolver: { source: 'local', resolve: async () => ({ ...principal, roles }) }, upstream }) };
  }
  it('serves screening, ownership, recorder, health and aggregates without fixture successes', async () => {
    const { app, upstream } = appFor();
    try {
      for (const path of ['/v1/fincrime/cases/case-test/ownership', '/v1/fincrime/cases/case-test/screening', '/v1/fincrime/cases/case-test/screening/hit',
        '/v1/fincrime/cases/case-test/recorder', '/v1/fincrime/cases/case-test/recorder/causality?focus=case_event%3Acase-test%3A1',
        '/v1/overview', '/v1/fincrime/assurance/mission-control']) {
        const response = await app.inject('/api' + path);
        expect(response.statusCode, path + ': ' + response.body).toBe(200);
      }
      const detail = await app.inject('/api/v1/fincrime/cases/case-test/recorder/entries/case_event%3Acase-test%3A1');
      expect(detail.statusCode, detail.body).toBe(200);
      expect(detail.json().ledger).toMatchObject({ verified: false, failedSequence: 1 });
      const session = await app.inject('/api/v1/session');
      const verification = await app.inject({ method: 'POST', url: '/api/v1/cases/case-test/ledger:verify', headers: { cookie: session.headers['set-cookie'] as string, origin: 'http://localhost:80', 'x-csrf-token': session.json().csrfToken }, payload: {} });
      expect(verification.statusCode, verification.body).toBe(200);
      expect(verification.json()).toMatchObject({ verified: false, failedSequence: 1 });
      const revocation = await app.inject({ method: 'POST', url: `/api/v1/registry/artifacts/policy-bundle/${digest}/revoke`, headers: { cookie: session.headers['set-cookie'] as string, origin: 'http://localhost:80', 'x-csrf-token': session.json().csrfToken }, payload: { reasonCode: 'policy.withdrawn' } });
      expect(revocation.statusCode, revocation.body).toBe(200);
      expect(upstream.mock.calls.find(call => call[2].startsWith('/v1/registry/artifacts/'))?.[4]).toEqual({ reasonCode: 'policy.withdrawn' });
      expect(upstream.mock.calls.every(call => call[3].tenantId === principal.tenantId)).toBe(true);
      for (const path of ['/v1/presentation/catalog', '/v1/fincrime/cases/case-test/surfaces']) expect((await app.inject('/api' + path)).statusCode).toBe(404);
    } finally { await app.close(); }
  });
  it('does not disclose another tenant snapshot, or the case recorder to a role lacking event permission', async () => {
    const value = snapshot(); value.tenantId = 'other-tenant';
    const { app } = appFor(value);
    try { expect((await app.inject('/api/v1/fincrime/cases/case-test/screening')).statusCode).toBe(403); }
    finally { await app.close(); }
    // Case roles hold event.read; a hold officer reads cases but not their event log.
    const holdOfficer = appFor(snapshot(), ['Legal.HoldOfficer']);
    try {
      expect((await holdOfficer.app.inject('/api/v1/fincrime/cases/case-test/recorder')).statusCode).toBe(403);
      expect(holdOfficer.upstream).not.toHaveBeenCalled();
    } finally { await holdOfficer.app.close(); }
    const analyst = appFor(snapshot(), ['Case.Analyst']);
    try {
      const overview = (await analyst.app.inject('/api/v1/overview')).json();
      expect(overview.admittedHarnessesCount).toBeNull();
      expect(overview.staleLeaseCount).toBeNull();
    } finally { await analyst.app.close(); }
  });
});

describe('trace store boundary', () => {
  const traceId = 'b'.repeat(32);
  const raw = { traceID: traceId, processes: { p: { serviceName: 'case-api' } }, spans: [
    { traceID: traceId, spanID: '1'.repeat(16), operationName: 'case.read', processID: 'p', startTime: 1000000, duration: 2000, references: [], tags: [{ key: 'authorization', value: 'must-not-leak' }] },
  ] };
  it('uses microsecond timing and excludes credential tags', () => {
    expect(jaegerTrace(raw, traceId)).toMatchObject({ durationMs: 2, spanCount: 1, spans: [{ durationMs: 2, tags: {} }] });
  });
  it('checks trace ownership before contacting the reader', async () => {
    const traceFetch = vi.fn<typeof fetch>();
    const upstream = vi.fn<Upstream>(async () => ({ status: 404, body: { error: 'trace.not_found' } }));
    const app = buildApp({ env: { BFF_JAEGER_QUERY_URL: 'http://localhost:16686' }, traceFetch,
      upstream, principalResolver: { source: 'local', resolve: async () => principal } });
    try {
      expect((await app.inject('/api/v1/traces/' + traceId)).statusCode).toBe(404);
      expect(traceFetch).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
  it('reads an authorized trace through the configured reader', async () => {
    const traceFetch = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ data: [raw] })));
    const upstream = vi.fn<Upstream>(async () => ({ status: 200, body: { traceId } }));
    const app = buildApp({ env: { BFF_JAEGER_QUERY_URL: 'http://localhost:16686' }, traceFetch,
      upstream, principalResolver: { source: 'local', resolve: async () => principal } });
    try {
      const result = await app.inject('/api/v1/traces/' + traceId);
      expect(result.statusCode, result.body).toBe(200);
      expect(result.json().spanCount).toBe(1);
    } finally { await app.close(); }
  });
});

describe('document-only extraction admission', () => {
  it('binds the verified document bytes and actor, then records authorization before starting a run', async () => {
    const docs = JSON.parse(readFileSync(new URL('../../../packages/fincrime-views/src/fixtures/documents.kyb-1042.json', import.meta.url), 'utf8'));
    const value = snapshot();
    value.data.records = docs.records.reduce((groups: Row, row: Row) => { (groups[row.object_type] ??= []).push(row); return groups; }, {});
    const document = docs.records.find((row: Row) => row.object_type === 'DocumentVersion');
    const version = document.data.artifact_hash;
    const documentId = document.data.document_id;
    value.data.evidence = [{ evidence_id: 'evidence-doc', evidence_type: 'DOCUMENT', raw_digest: version, source: { dataset: 'document:test.txt' } }];
    const plan = JSON.parse(readFileSync(new URL('../../../artifacts/document-extraction.plan.json', import.meta.url), 'utf8'));
    const upstream = vi.fn<Upstream>(async (_service, _method, path, _principal, body) => {
      if (path.startsWith('/v2/cases/')) return { status: 200, body: value };
      if (path.startsWith('/v1/plans/')) return { status: 200, body: plan };
      if (path.includes('/content')) return { status: 200, body: { caseId: 'case-test', rawDigest: version, contentBase64: 'aGVsbG8=' } };
      if (path.endsWith('/commands')) {
        const command = body as Row;
        value.data.reviews.push({ review_type: command.payload.reviewType, details: { requestKey: command.payload.documentRunAuthorization.requestKey, authorization: command.payload.documentRunAuthorization } });
        return { status: 200, body: { outcome: 'ACCEPTED', caseSequence: 5 } };
      }
      if (path === '/v1/runs') return { status: 202, body: { run: { runId: 'run-doc', input: (body as Row).input }, created: true } };
      return { status: 404, body: {} };
    });
    const app = buildApp({ env: { BFF_DOCUMENT_PLAN_DIGEST: plan.planDigest }, upstream, principalResolver: { source: 'local', resolve: async () => principal } });
    try {
      const session = await app.inject('/api/v1/session');
      const headers = { cookie: session.headers['set-cookie'] as string, origin: 'http://localhost:80', 'x-csrf-token': session.json().csrfToken, 'idempotency-key': 'document-intent' };
      const path = `/api/v1/fincrime/cases/case-test/documents/${documentId}/rerun`;
      expect((await app.inject({ method: 'POST', url: path, payload: { documentVersion: version } })).statusCode).toBe(403);
      const conflict = await app.inject({ method: 'POST', url: path, headers, payload: { documentVersion: digest } });
      expect(conflict.statusCode, conflict.body).toBe(409);
      const result = await app.inject({ method: 'POST', url: path, headers, payload: { documentVersion: version, actor: 'spoof' } });
      expect(result.statusCode, result.body).toBe(200);
      const command = upstream.mock.calls.find(call => call[2].endsWith('/commands'))![4] as Row;
      expect(command.actor.principalId).toBe(principal.subjectId);
      expect(command.payload.documentRunAuthorization.documentVersion).toBe(version);
      const run = upstream.mock.calls.find(call => call[2] === '/v1/runs')!;
      expect((run[4] as Row).input).toMatchObject({ tenantId: principal.tenantId, caseId: 'case-test', documentVersion: version, contentBase64: 'aGVsbG8=' });
      expect(run[5]?.['idempotency-key']).toBe(command.payload.documentRunAuthorization.requestKey);
      const retry = await app.inject({ method: 'POST', url: path, headers, payload: { documentVersion: version } });
      expect(retry.json()).toEqual(result.json());
      expect(upstream.mock.calls.filter(call => call[2].endsWith('/commands'))).toHaveLength(1);
    } finally { await app.close(); }
  });
});
