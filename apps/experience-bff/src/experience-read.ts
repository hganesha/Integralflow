import type { Principal } from '@ehf/identity';
import { UpstreamError, type Service, type Upstream } from './upstream.js';

export type Row = Record<string, any>;

/** All compositions use the caller's delegation, including every pagination request. */
export function experienceReader(upstream: Upstream, principal: Principal, headers: Record<string, string>) {
  const call = async (service: Service, path: string, method = 'GET', body?: unknown) => {
    const result = await upstream(service, method, path, principal, body, headers);
    if (result.status >= 400) throw new UpstreamError(result.status, result.body?.error ?? 'bff.upstream_unavailable');
    return result.body;
  };
  const pages = async (service: Service, path: string, key: string, cursorKey = 'cursor') => {
    const rows: Row[] = [];
    const seen = new Set<string>();
    const url = new URL(path, 'http://pagination.invalid');
    url.searchParams.set('limit', '200');
    for (let count = 0; count < 100; count++) {
      const result = await call(service, url.pathname + url.search);
      if (!Array.isArray(result[key])) throw new UpstreamError(502, 'bff.upstream_contract_invalid');
      rows.push(...result[key]);
      if (!result.nextCursor) return rows;
      const next = String(result.nextCursor);
      if (seen.has(next)) throw new UpstreamError(502, 'pagination.cursor_repeated');
      seen.add(next);
      url.searchParams.set(cursorKey, next);
    }
    // Never present a bounded scan as a complete total or chronology.
    throw new UpstreamError(503, 'experience.scan_limit_exceeded');
  };
  const snapshot = async (caseId: string) => {
    const value = await call('case-api', `/v2/cases/${encodeURIComponent(caseId)}/snapshot`);
    if (value.caseId !== caseId || value.tenantId !== principal.tenantId) throw new UpstreamError(403, 'case.authority_mismatch');
    return value as Row;
  };
  return { call, pages, snapshot };
}

export function records(snapshot: Row, kind: string): Row[] {
  return (Object.values(snapshot.data.records ?? {}).flat() as Row[]).filter(row => row.object_type === kind);
}
export const text = (value: unknown): string => typeof value === 'string' ? value : JSON.stringify(value) ?? '';

/** Upload metadata is enough to browse an unparsed document. This projection never
 * creates canonical pages, extracted assertions, or a parsed/verified status. */
export function documentRecords(snapshot: Row): import('@ehf/fincrime-views').CanonicalRecordView[] {
  const rows = Object.values(snapshot.data.records ?? {}).flat() as import('@ehf/fincrime-views').CanonicalRecordView[];
  const result = [...rows];
  for (const evidence of snapshot.data.evidence ?? []) {
    const digest = String(evidence.raw_digest ?? '').replace(/^sha256:/, '');
    if (evidence.evidence_type !== 'DOCUMENT' || evidence.source?.type !== 'UPLOAD' || !/^[a-f0-9]{64}$/.test(digest)) continue;
    if (result.some(row => row.object_type === 'DocumentVersion' && row.data.artifact_hash === digest)) continue;
    result.push({ object_type: 'DocumentVersion', object_id: `doc_${digest.slice(0, 24)}`, data: {
      document_id: `doc_${digest.slice(0, 24)}`, artifact_hash: digest, artifact_ref: evidence.artifact_ref,
      media_type: evidence.media_type ?? 'application/octet-stream', page_count: 0,
      extensions: { 'ehf.connector': { schema_version: '1.0.0', value: { filename: String(evidence.source.dataset ?? '').replace(/^document:/, ''), page_count_basis: 'unparsed_upload' } } },
    } });
  }
  return result;
}
