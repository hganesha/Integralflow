import { foundryTraceBindingSchema, isFoundryTraceBindingQualified } from "@ehf/contracts/foundry";
import { isProductionProfile } from "@ehf/identity";
import { applicationInsightsResourceId, type ApplicationInsightsQuery } from "./azure-trace-query.js";
import { UpstreamError } from "./upstream.js";

const DAY = 86400000;
const CLOCK_MARGIN_MS = 60000;
const PENDING_MS = 10 * CLOCK_MARGIN_MS;
const MAX_SPANS = 5000;
export const isTraceId = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{32}$/.test(value) && !/^0+$/.test(value);
const isSpanId = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{16}$/.test(value) && !/^0+$/.test(value);
const isResponseId = (value: unknown): value is string =>
  typeof value === "string" && /^resp_[0-9A-Za-z_-]{1,191}$/.test(value);

type Root = { runId: string; spanId: string; sampled: boolean; startedAt: number; completedAt: number | null };
type FoundryLink = {
  parentSpanId: string;
  applicationInsightsResourceId: string;
  projectEndpoint: string;
  agentName: string;
  agentVersion: string;
  responseId: string;
  startedAt: number;
  completedAt: number;
};
export type TraceAuthority = { roots: Root[]; foundry: FoundryLink[]; foundryPartial: boolean };
type Span = {
  spanId: string;
  parentSpanId: string | null;
  operationName: string;
  serviceName: string;
  startTime: string;
  durationMs: number;
  status: "ok" | "error";
  tags: Record<string, string | number | boolean>;
  source?: "platform" | "foundry";
};
type SpanRow = {
  operationId: string;
  nativeAgentLabel: unknown;
  nativeOperation: unknown;
  responseId: unknown;
  startedAt: number;
  span: Span;
};
type FoundryTraceView = {
  parentSpanId: string;
  status: "available" | "partial" | "pending" | "uncorrelated" | "unavailable" | "expired";
  traceId: string | null;
  durationMs: number;
  spans: ReturnType<typeof waterfall>["spans"];
};

const PLATFORM_SERVICES = new Set([
  "harness-control-api", "harness-case-service", "harness-case-api", "harness-runtime-dispatcher",
  "harness-runtime-host", "harness-capability-gateway", "harness-integration-worker",
  "harness-experience-bff", "harness-workbench",
]);
const PLATFORM_OPERATIONS = new Set([
  "harness.run", "workflow.transition", "runtime.invoke", "capability.request", "capability.invoke",
  "authorization.evaluate", "model.inference", "tool.execution", "foundry.agent.invoke",
  "workbench.agent.evaluate", "case.list",
  "case.read", "case.create", "case.command", "case.apply",
]);

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function timestamp(value: unknown): number {
  return typeof value === "string" ? Date.parse(value) : NaN;
}

export function azureTraceAuthority(value: unknown): TraceAuthority {
  const authority = object(value);
  if (!Array.isArray(authority.roots) || authority.roots.length === 0 || authority.roots.length > 256) {
    throw new UpstreamError(502, "trace.authority_invalid");
  }
  const roots = authority.roots.map(entry => {
    const root = object(entry);
    const startedAt = timestamp(root.startedAt);
    const completedAt = root.completedAt === null ? null : timestamp(root.completedAt);
    if (typeof root.runId !== "string" || !isSpanId(root.spanId) || typeof root.sampled !== "boolean" ||
        !Number.isFinite(startedAt) || completedAt !== null && (!Number.isFinite(completedAt) || completedAt < startedAt)) {
      throw new UpstreamError(502, "trace.authority_invalid");
    }
    return { runId: root.runId, spanId: root.spanId, sampled: root.sampled, startedAt, completedAt };
  });
  const candidates = Array.isArray(authority.foundry) ? authority.foundry : [];
  const foundry: FoundryLink[] = [];
  let foundryPartial = authority.foundryPartial === true || candidates.length > 16;
  for (const entry of candidates.slice(0, 16)) {
    const row = object(entry);
    const startedAt = timestamp(row.startedAt);
    const completedAt = timestamp(row.completedAt);
    if (!isSpanId(row.parentSpanId) || !applicationInsightsResourceId(row.applicationInsightsResourceId) ||
        typeof row.projectEndpoint !== "string" || typeof row.agentName !== "string" || typeof row.agentVersion !== "string" ||
        !isResponseId(row.responseId) || !Number.isFinite(startedAt) || !Number.isFinite(completedAt) || completedAt < startedAt) {
      foundryPartial = true;
      continue;
    }
    foundry.push({
      parentSpanId: row.parentSpanId,
      applicationInsightsResourceId: row.applicationInsightsResourceId,
      projectEndpoint: row.projectEndpoint,
      agentName: row.agentName,
      agentVersion: row.agentVersion,
      responseId: row.responseId,
      startedAt,
      completedAt,
    });
  }
  return { roots, foundry, foundryPartial };
}

function spanQuery(traceId: string, responseIds: string[] = [], nativeAgentLabel?: string): string {
  if (!isTraceId(traceId) || responseIds.some(id => !isResponseId(id)) ||
      nativeAgentLabel && !/^invoke_agent [A-Za-z0-9-]{1,63}:[1-9][0-9]{0,19}$/.test(nativeAgentLabel)) {
    throw new UpstreamError(502, "trace.query_bounds_invalid");
  }
  const scope = `operation_Id == "${traceId}"`;
  const names = nativeAgentLabel
    ? `iff(name == "${nativeAgentLabel}", name, "")`
    : `iff(name in (${[...PLATFORM_OPERATIONS].map(name => `"${name}"`).join(", ")}), name, "")`;
  const responseProjection = nativeAgentLabel ? ',\n    ResponseId=tostring(customDimensions["gen_ai.response.id"])' : "";
  const projection = `
| project OperationId=operation_Id, SpanId=id, ParentSpanId=operation_ParentId,
    StartedAt=timestamp, DurationMs=duration, Success=tobool(success),
    Role=iff(cloud_RoleName in (${[...PLATFORM_SERVICES, "responsesapi"].map(name => `"${name}"`).join(", ")}), cloud_RoleName, ""),
    Name=${names}, Operation=tostring(customDimensions["gen_ai.operation.name"])${responseProjection},
    Provider=tostring(customDimensions["gen_ai.provider.name"]),
    InputTokens=coalesce(tolong(customDimensions["gen_ai.usage.input_tokens"]), tolong(customMeasurements["gen_ai.usage.input_tokens"])),
    OutputTokens=coalesce(tolong(customDimensions["gen_ai.usage.output_tokens"]), tolong(customMeasurements["gen_ai.usage.output_tokens"]))`;
  const table = "union isfuzzy=true requests, dependencies";
  if (!responseIds.length) return `${table}\n| where ${scope}${projection}\n| take ${MAX_SPANS + 1}`;
  return `let operations = (${table}\n| where ${scope} or tostring(customDimensions["gen_ai.response.id"]) in (${responseIds.map(id => `"${id}"`).join(", ")})\n| distinct operation_Id);
${table}
| where operation_Id in (operations)${projection}
| take ${MAX_SPANS + 1}`;
}

function durationMs(value: unknown) {
  if (typeof value === "number") return value;
  if (typeof value !== "string") return NaN;
  const match = /^(?:(\d{1,3})\.)?(\d{2}):(\d{2}):(\d{2}(?:\.\d{1,7})?)$/.exec(value);
  if (!match) return NaN;
  return (Number(match[1] ?? 0) * 86400 + Number(match[2]) * 3600 + Number(match[3]) * 60 + Number(match[4])) * 1000;
}

function normalizedRows(
  rows: Record<string, unknown>[],
  source: "platform" | "foundry",
  window: { start: number; end: number },
  traceId?: string,
) {
  const byOperation = new Map<string, Map<string, SpanRow>>();
  let partial = rows.length > MAX_SPANS;
  for (const row of rows.slice(0, MAX_SPANS)) {
    const startedAt = timestamp(row.StartedAt);
    const duration = durationMs(row.DurationMs);
    if (!isTraceId(row.OperationId) || traceId && row.OperationId !== traceId || !isSpanId(row.SpanId) ||
        !Number.isFinite(startedAt) || startedAt < window.start || startedAt > window.end ||
        !Number.isFinite(duration) || duration < 0 || duration > 731 * DAY) {
      partial = true;
      continue;
    }
    const provider = row.Provider === "azure.ai.foundry" || row.Provider === "azure.ai.openai" ? row.Provider : null;
    const tags: Span["tags"] = {};
    if (provider) tags["gen_ai.provider.name"] = provider;
    if (typeof row.InputTokens === "number" && Number.isSafeInteger(row.InputTokens) && row.InputTokens >= 0) {
      tags["gen_ai.usage.input_tokens"] = row.InputTokens;
    }
    if (typeof row.OutputTokens === "number" && Number.isSafeInteger(row.OutputTokens) && row.OutputTokens >= 0) {
      tags["gen_ai.usage.output_tokens"] = row.OutputTokens;
    }
    const operationName = source === "foundry"
      ? row.Operation === "invoke_agent" ? "Foundry agent invocation" : row.Operation === "chat" ? "Foundry model call" : row.Operation === "execute_tool" ? "Foundry tool call" : "Foundry operation"
      : row.Name === "foundry.agent.invoke" ? "Foundry agent request"
        : provider ? "Foundry model call"
          : typeof row.Name === "string" && PLATFORM_OPERATIONS.has(row.Name) ? row.Name : "Platform operation";
    const span: Span = {
      spanId: row.SpanId,
      parentSpanId: isSpanId(row.ParentSpanId) ? row.ParentSpanId : null,
      operationName,
      serviceName: source === "foundry" ? "Microsoft Foundry" : typeof row.Role === "string" && PLATFORM_SERVICES.has(row.Role) ? row.Role : "Platform",
      startTime: new Date(startedAt).toISOString(),
      durationMs: duration,
      status: row.Success === false || row.Success === "False" ? "error" : "ok",
      tags,
      source,
    };
    const rowsForOperation = byOperation.get(row.OperationId) ?? new Map<string, SpanRow>();
    const next = { operationId: row.OperationId, nativeAgentLabel: row.Name, nativeOperation: row.Operation, responseId: row.ResponseId, startedAt, span };
    const duplicate = rowsForOperation.get(span.spanId);
    if (duplicate && JSON.stringify(duplicate) !== JSON.stringify(next)) {
      throw new UpstreamError(502, "trace.span_conflict");
    }
    rowsForOperation.set(span.spanId, next);
    byOperation.set(row.OperationId, rowsForOperation);
  }
  return { byOperation, partial };
}

function subtree(rows: Map<string, SpanRow>, roots: string[]) {
  const children = new Map<string, string[]>();
  for (const row of rows.values()) {
    if (!row.span.parentSpanId) continue;
    const linked = children.get(row.span.parentSpanId) ?? [];
    linked.push(row.span.spanId);
    children.set(row.span.parentSpanId, linked);
  }
  const queue = [...new Set(roots)];
  const visited = new Set<string>();
  const scoped = new Map<string, Span>();
  for (let index = 0; index < queue.length; index++) {
    const id = queue[index]!;
    if (visited.has(id)) continue;
    visited.add(id);
    const row = rows.get(id);
    if (row) scoped.set(id, row.span);
    queue.push(...(children.get(id) ?? []));
  }
  return scoped;
}

export function waterfall(spans: Iterable<Span>, fallbackStart = Date.now()) {
  const list = [...spans];
  let start = list.length ? Infinity : fallbackStart;
  let end = list.length ? -Infinity : fallbackStart;
  const parents = new Map<string, string | null>();
  for (const span of list) {
    const time = Date.parse(span.startTime);
    start = Math.min(start, time);
    end = Math.max(end, time + span.durationMs);
    parents.set(span.spanId, span.parentSpanId);
  }
  const depths = new Map<string, number>();
  function getDepth(id: string) {
    const path: string[] = [];
    const seen = new Set<string>();
    let next: string | null = id;
    while (next && parents.has(next) && !depths.has(next)) {
      if (seen.has(next)) throw new UpstreamError(502, "trace.parent_cycle");
      path.push(next);
      seen.add(next);
      next = parents.get(next) ?? null;
    }
    let depth = next && depths.has(next) ? depths.get(next)! + 1 : 0;
    for (const spanId of path.reverse()) depths.set(spanId, depth++);
    return depths.get(id) ?? 0;
  }
  return {
    startedAt: new Date(start).toISOString(),
    durationMs: end - start,
    spanCount: list.length,
    services: [...new Set(list.map(span => span.serviceName))],
    spans: list.map(span => ({
      ...span,
      startOffsetMs: Date.parse(span.startTime) - start,
      depth: getDepth(span.spanId),
    })).sort((a, b) => a.startOffsetMs - b.startOffsetMs || a.spanId.localeCompare(b.spanId)),
  };
}

function foundryBinding(env: NodeJS.ProcessEnv, now: number) {
  if (!env.FOUNDRY_TRACE_BINDING_JSON) return null;
  try {
    const parsed = foundryTraceBindingSchema.safeParse(JSON.parse(env.FOUNDRY_TRACE_BINDING_JSON));
    return parsed.success && isFoundryTraceBindingQualified(parsed.data, isProductionProfile(env), now) ? parsed.data : null;
  } catch {
    return null;
  }
}
function linkView(link: FoundryLink, status: FoundryTraceView["status"]): FoundryTraceView {
  return { parentSpanId: link.parentSpanId, traceId: null, status, durationMs: 0, spans: [] };
}
function timeWindow(start: number, end: number) {
  return { startTime: new Date(start).toISOString(), endTime: new Date(end).toISOString() };
}

async function linkFoundry(
  traceId: string,
  tenantId: string,
  authority: TraceAuthority,
  spans: Map<string, Span>,
  env: NodeJS.ProcessEnv,
  query: ApplicationInsightsQuery,
  now: number,
  cutoff: number,
) {
  const links = authority.foundry.filter(link => spans.has(link.parentSpanId));
  if (!links.length) return [];
  const binding = foundryBinding(env, now);
  const allowed = links.filter(link =>
    binding?.tenantId === tenantId && binding.projectEndpoint === link.projectEndpoint &&
    binding.agentName === link.agentName && binding.agentVersion === link.agentVersion &&
    binding.applicationInsightsResourceId.toLowerCase() === link.applicationInsightsResourceId.toLowerCase());
  const active = allowed.filter(link => link.completedAt + CLOCK_MARGIN_MS > cutoff && link.startedAt <= now);
  const unavailable = links.filter(link => !active.includes(link)).map(link =>
    linkView(link, allowed.includes(link) && link.completedAt + CLOCK_MARGIN_MS <= cutoff ? "expired" : "unavailable"));
  if (!active.length || !binding) return unavailable;
  const start = Math.max(cutoff, Math.min(...active.map(link => link.startedAt)) - CLOCK_MARGIN_MS);
  const end = Math.min(now + CLOCK_MARGIN_MS, Math.max(...active.map(link => link.completedAt)) + CLOCK_MARGIN_MS);
  if (start >= end) return [...unavailable, ...active.map(link => linkView(link, "pending"))];
  try {
    const responseIds = [...new Set(active.map(link => link.responseId))];
    const expectedLabel = `invoke_agent ${binding.agentName}:${binding.agentVersion}`;
    const result = await query(binding.applicationInsightsResourceId, spanQuery(traceId, responseIds, expectedLabel), timeWindow(start, end));
    const { byOperation, partial } = normalizedRows(result.rows, "foundry", { start, end });
    const linked: FoundryTraceView[] = [];
    const additional = new Map<string, Span>();
    for (const link of active) {
      const anchors = [...byOperation.values()].flatMap(operation => [...operation.values()].filter(row =>
        row.nativeOperation === "invoke_agent" &&
        row.nativeAgentLabel === expectedLabel &&
        row.startedAt >= link.startedAt - CLOCK_MARGIN_MS &&
        row.startedAt <= link.completedAt + CLOCK_MARGIN_MS &&
        (row.responseId === link.responseId ||
          row.operationId === traceId && row.span.parentSpanId === link.parentSpanId && !row.responseId)));
      if (anchors.length !== 1) {
        linked.push(linkView(link, anchors.length ? "uncorrelated" : result.partial || partial ? "partial" : now - link.completedAt < PENDING_MS ? "pending" : "uncorrelated"));
        continue;
      }
      const anchor = anchors[0]!;
      const native = subtree(byOperation.get(anchor.operationId)!, [anchor.span.spanId]);
      const view = waterfall(native.values());
      const sameParent = anchor.operationId === traceId && anchor.span.parentSpanId === link.parentSpanId;
      if (sameParent) {
        for (const span of native.values()) {
          if (spans.has(span.spanId) || additional.has(span.spanId)) throw new UpstreamError(502, "trace.span_conflict");
          additional.set(span.spanId, span);
        }
      }
      linked.push({
        parentSpanId: link.parentSpanId,
        status: result.partial || partial ? "partial" : "available",
        traceId: anchor.operationId,
        durationMs: view.durationMs,
        spans: sameParent ? [] : view.spans,
      });
    }
    // Validate the complete graph before publishing the native merge.
    waterfall([...spans.values(), ...additional.values()]);
    for (const [id, span] of additional) spans.set(id, span);
    return [...unavailable, ...linked];
  } catch {
    return [...unavailable, ...active.map(link => linkView(link, "unavailable"))];
  }
}

export async function readAzureTrace(
  traceId: string,
  tenantId: string,
  authority: TraceAuthority,
  env: NodeJS.ProcessEnv,
  query: ApplicationInsightsQuery,
  now = Date.now(),
) {
  const resourceId = env.BFF_TRACE_APP_INSIGHTS_RESOURCE_ID;
  const retention = Number(env.BFF_TRACE_RETENTION_DAYS ?? 30);
  if (!applicationInsightsResourceId(resourceId) || !Number.isInteger(retention) || retention < 1 || retention > 730) {
    throw new UpstreamError(503, "trace.reader_configuration_invalid");
  }
  const { roots } = authority;
  const firstStart = Math.min(...roots.map(root => root.startedAt));
  const lastEnd = Math.max(...roots.map(root => root.completedAt ?? now));
  const cutoff = now - retention * DAY;
  const start = Math.max(cutoff, firstStart - CLOCK_MARGIN_MS);
  const end = Math.min(now + CLOCK_MARGIN_MS, lastEnd + CLOCK_MARGIN_MS);
  const base = {
    generatedAt: new Date(now).toISOString(),
    traceId,
    backend: "azure_monitor" as const,
    rawViewerUrl: null,
    foundryPartial: authority.foundryPartial,
    foundry: [] as FoundryTraceView[],
  };
  if (end <= cutoff) return { ...base, status: "expired" as const, ...waterfall([], firstStart) };
  if (!roots.some(root => root.sampled)) return { ...base, status: "not_sampled" as const, ...waterfall([], firstStart) };
  if (start >= end) return { ...base, status: "pending" as const, ...waterfall([], firstStart) };
  const result = await query(resourceId, spanQuery(traceId), timeWindow(start, end));
  const { byOperation, partial } = normalizedRows(result.rows, "platform", { start, end }, traceId);
  const rows = byOperation.get(traceId) ?? new Map<string, SpanRow>();
  const sampled = roots.filter(root => root.sampled);
  const spans = subtree(rows, sampled.map(root => root.spanId));
  const complete = !result.partial && !partial && sampled.every(root => spans.has(root.spanId));
  const foundry = await linkFoundry(traceId, tenantId, authority, spans, env, query, now, cutoff);
  const status = spans.size ? complete ? "available" : "partial"
    : result.partial || partial || rows.size ? "partial"
    : now - lastEnd < PENDING_MS ? "pending" : "unavailable";
  return { ...base, status, ...waterfall(spans.values(), firstStart), foundry };
}
