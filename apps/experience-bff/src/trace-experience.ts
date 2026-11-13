import { readFile } from 'node:fs/promises';
import { actionsForRoles, isProductionProfile } from '@ehf/identity';
import { validateResponse } from '@ehf/ui-contracts/validate';
import type { FastifyInstance } from 'fastify';
import type { sessionAccess } from './session.js';
import { delegatedHeaders, errorResponse } from './relay.js';
import { experienceReader, type Row } from './experience-read.js';
import { UpstreamError, type Upstream } from './upstream.js';
import { boundedTraceJson, createApplicationInsightsQuery } from './azure-trace-query.js';
import { azureTraceAuthority, isTraceId, readAzureTrace, waterfall } from './azure-trace-reader.js';

export type TraceFetch = typeof globalThis.fetch;

export function jaegerTrace(trace: Row, traceId: string, viewer?: string) {
  if (trace.traceID !== traceId || !Array.isArray(trace.spans) || !trace.spans.length) throw new UpstreamError(404, 'trace.not_found');
  const raw = trace.spans as Row[];
  if (raw.length > 10000 || raw.some(span => span.traceID !== traceId || !Number.isFinite(span.startTime) || !Number.isFinite(span.duration) || span.duration < 0)) throw new UpstreamError(502, 'trace.response_invalid');
  const start = Math.min(...raw.map(span => span.startTime));
  const end = Math.max(...raw.map(span => span.startTime + span.duration));
  const parents = new Map<string, string | null>(raw.map(span => [span.spanID, span.references?.find((ref: Row) => ref.refType === 'CHILD_OF' && ref.traceID === traceId)?.spanID ?? null]));
  const depth = (id: string) => { const seen = new Set([id]); let parent = parents.get(id), value = 0; while (parent && parents.has(parent)) { if (seen.has(parent)) throw new UpstreamError(502, 'trace.parent_cycle'); seen.add(parent); value++; parent = parents.get(parent); } return value; };
  const spans = raw.map(span => {
    const tags = Object.fromEntries((span.tags ?? []).filter((tag: Row) => !/authorization|cookie|token|secret|password/i.test(tag.key)).map((tag: Row) => [tag.key, tag.value]));
    return { spanId: span.spanID, parentSpanId: parents.get(span.spanID) ?? null, operationName: span.operationName,
      serviceName: trace.processes?.[span.processID]?.serviceName ?? 'Not reported', startTime: new Date(span.startTime / 1000).toISOString(),
      startOffsetMs: (span.startTime - start) / 1000, durationMs: span.duration / 1000, depth: depth(span.spanID),
      status: tags.error === true || tags['otel.status_code'] === 'ERROR' ? 'error' as const : 'ok' as const, tags };
  }).sort((a, b) => a.startOffsetMs - b.startOffsetMs || a.spanId.localeCompare(b.spanId));
  return { generatedAt: new Date().toISOString(), traceId, startedAt: new Date(start / 1000).toISOString(), durationMs: (end - start) / 1000,
    spanCount: spans.length, services: [...new Set(spans.map(span => span.serviceName))], rawViewerUrl: viewer ? new URL(`trace/${traceId}`, viewer.endsWith('/') ? viewer : viewer + '/').toString() : null, spans };
}

function configuredTraceUrl(raw: string, production: boolean, code: string) {
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
        url.search || url.hash || production && url.protocol !== 'https:') throw new Error();
    return url;
  } catch {
    throw new UpstreamError(503, code);
  }
}

async function readJaegerTrace(traceId: string, env: NodeJS.ProcessEnv, fetch: TraceFetch, history = false) {
  if (!env.BFF_JAEGER_QUERY_URL) throw new UpstreamError(409, 'trace.reader_not_configured');
  const production = isProductionProfile(env);
  const base = configuredTraceUrl(env.BFF_JAEGER_QUERY_URL, production, 'trace.reader_configuration_invalid');
  const headers: Record<string, string> = { accept: 'application/json' };
  if (env.BFF_TRACE_TOKEN_FILE) headers.authorization = `Bearer ${(await readFile(env.BFF_TRACE_TOKEN_FILE, 'utf8')).trim()}`;
  const response = await fetch(new URL(`api/traces/${traceId}`, base.href.endsWith('/') ? base.href : base.href + '/'), {
    headers, redirect: 'error', signal: AbortSignal.timeout(10000),
  });
  if (response.status === 404) throw new UpstreamError(404, 'trace.not_found');
  if (!response.ok) throw new UpstreamError(503, 'trace.reader_unavailable');
  const result = await boundedTraceJson(response) as Row;
  const trace = Array.isArray(result?.data) ? result.data.find((item: Row) => item.traceID === traceId) : undefined;
  if (!trace) throw new UpstreamError(404, 'trace.not_found');
  const viewer = !history && env.BFF_TRACE_VIEWER_URL
    ? configuredTraceUrl(env.BFF_TRACE_VIEWER_URL, production, 'trace.viewer_configuration_invalid').href
    : undefined;
  return jaegerTrace(trace, traceId, viewer);
}

function historyView(
  result: Awaited<ReturnType<typeof readJaegerTrace>>,
  roots: ReturnType<typeof azureTraceAuthority>["roots"],
) {
  const parents = new Map(result.spans.map(span => [span.spanId, span.parentSpanId]));
  const known = new Set(roots.map(root => root.spanId));
  const scoped = new Map<string, boolean>();
  function belongs(id: string) {
    const path: string[] = [];
    let next: string | null = id;
    while (next && parents.has(next) && !known.has(next) && !scoped.has(next)) {
      path.push(next);
      next = parents.get(next) ?? null;
    }
    const result = Boolean(next && (known.has(next) || scoped.get(next)));
    for (const item of path) scoped.set(item, result);
    return result;
  }
  return result.spans.filter(span => belongs(span.spanId)).map(span => ({
    ...span,
    // Historical readers expose the same metadata boundary as Azure. The stored Jaeger
    // name, process attributes and arbitrary tag values can contain provider content.
    operationName: "Platform operation",
    serviceName: "Platform",
    tags: {},
  }));
}

export function registerTraceExperience(
  app: FastifyInstance,
  access: ReturnType<typeof sessionAccess>,
  upstream: Upstream,
  env: NodeJS.ProcessEnv,
  fetch: TraceFetch = globalThis.fetch,
) {
  const query = createApplicationInsightsQuery(env, fetch);
  app.get('/api/v1/traces/:traceId', async (request, reply) => {
    reply.header('cache-control', 'no-store').header('x-correlation-id', request.id);
    try {
      const principal = await access.resolver.resolve(request);
      if (principal.actorType !== 'human' || !actionsForRoles(principal.roles).has('telemetry.read')) {
        throw new UpstreamError(404, 'trace.not_found');
      }
      const { traceId } = request.params as { traceId: string };
      const backend = env.BFF_TRACE_BACKEND ?? 'jaeger';
      if (backend !== 'azure_monitor' && backend !== 'jaeger') throw new UpstreamError(503, 'trace.reader_configuration_invalid');
      const now = Date.now();
      const cutover = Date.parse(env.BFF_TRACE_CUTOVER_AT ?? '');
      const until = Date.parse(env.BFF_TRACE_PREVIOUS_READER_UNTIL ?? '');
      const legacyWindow = Boolean(env.BFF_JAEGER_QUERY_URL && now < until && until > cutover);
      if (!/^[a-f0-9]{16,32}$/.test(traceId) ||
          backend === 'azure_monitor' && (/^0+$/.test(traceId) || !legacyWindow && !isTraceId(traceId))) {
        throw new UpstreamError(404, 'trace.not_found');
      }
      const reader = experienceReader(upstream, principal, delegatedHeaders(request, access, env));
      let authority: Row;
      try {
        authority = await reader.call('control-api', `/v1/traces/${traceId}/authority`);
      } catch (error) {
        if (error instanceof UpstreamError && (error.status === 403 || error.status === 404)) {
          throw new UpstreamError(404, 'trace.not_found');
        }
        throw error;
      }
      if (authority?.traceId !== traceId) throw new UpstreamError(404, 'trace.not_found');

      let body;
      if (backend === 'azure_monitor') {
        const bindings = azureTraceAuthority(authority);
        const canReadHistory = legacyWindow && bindings.roots.some(root => root.sampled && root.startedAt < cutover);
        if (!isTraceId(traceId) && !canReadHistory) throw new UpstreamError(404, 'trace.not_found');
        const past = canReadHistory && bindings.roots.every(root => root.completedAt !== null && root.completedAt < cutover);
        let history: Awaited<ReturnType<typeof readJaegerTrace>> | null = null;
        if (canReadHistory) {
          try {
            history = await readJaegerTrace(traceId, env, fetch, true);
          } catch (error) {
            if (!(error instanceof UpstreamError && error.status === 404)) request.log.warn('Historical trace reader unavailable');
          }
        }
        const historicalSpans = history ? historyView(history, bindings.roots) : [];
        if ((past || !isTraceId(traceId)) && historicalSpans.length) {
          body = { traceId, generatedAt: new Date(now).toISOString(), rawViewerUrl: null,
            backend: 'jaeger', status: 'available', ...waterfall(historicalSpans) };
        } else {
          if (!isTraceId(traceId)) throw new UpstreamError(404, 'trace.not_found');
          const azure = await readAzureTrace(traceId, principal.tenantId, bindings, env, query, now).catch((error: unknown) => {
            if (!historicalSpans.length) throw error;
            request.log.warn('Azure trace reader unavailable');
            return {
              traceId, generatedAt: new Date(now).toISOString(), rawViewerUrl: null,
              backend: 'azure_monitor', status: 'partial', ...waterfall([]),
            };
          });
          if (historicalSpans.length) {
            const combined = new Map(historicalSpans.map(span => [span.spanId, span]));
            for (const span of azure.spans) combined.set(span.spanId, span);
            body = { ...azure, ...waterfall(combined.values()), status: azure.status === 'available' ? 'available' : 'partial' };
          } else {
            body = azure;
          }
        }
      } else {
        body = { ...await readJaegerTrace(traceId, env, fetch), backend: 'jaeger', status: 'available' };
      }
      if (!validateResponse('getTracesTraceId', 200, body).valid) throw new UpstreamError(502, 'trace.response_invalid');
      return body;
    } catch (error) {
      const failure = errorResponse(error, request);
      return reply.code(failure.status).send(failure.body);
    }
  });
}
