import { ManagedIdentityCredential } from "@azure/identity";
import { UpstreamError } from "./upstream.js";

const APP_INSIGHTS_ID = /^\/subscriptions\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\/resourceGroups\/[a-z0-9_.()-]{1,90}\/providers\/Microsoft\.Insights\/components\/[a-z0-9_.()-]{1,260}$/i;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const MAX_ROWS = 5001;
const MAX_COLUMNS = 32;

export function applicationInsightsResourceId(value: unknown): value is string {
  return typeof value === "string" && APP_INSIGHTS_ID.test(value) &&
    !value.split("/").some(segment => segment === "." || segment === "..");
}

export async function boundedTraceJson(response: Response, maxBytes = 4 * 1024 * 1024): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new UpstreamError(502, "trace.response_invalid");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes) throw new UpstreamError(502, "trace.response_too_large");
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new UpstreamError(502, "trace.response_invalid");
  }
}

export type TraceQueryWindow = { startTime: string; endTime: string };
export type ApplicationInsightsQuery = (
  resourceId: string,
  query: string,
  window: TraceQueryWindow,
) => Promise<{ rows: Record<string, unknown>[]; partial: boolean }>;

function parseQueryResult(value: unknown) {
  if (!value || typeof value !== "object") throw new UpstreamError(502, "trace.response_invalid");
  const result = value as { error?: { code?: string }; tables?: unknown[] };
  if (!Array.isArray(result.tables) || result.tables.length !== 1 || result.error && result.error.code !== "PartialError") {
    throw new UpstreamError(502, "trace.response_invalid");
  }
  const table = result.tables[0] as { columns?: { name?: string }[]; rows?: unknown[][] } | null;
  if (!Array.isArray(table?.columns) || table.columns.length === 0 || table.columns.length > MAX_COLUMNS ||
      !Array.isArray(table.rows) || table.rows.length > MAX_ROWS) {
    throw new UpstreamError(502, "trace.response_invalid");
  }
  const names = table.columns.map(column => column?.name);
  if (names.some(name => typeof name !== "string" || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name)) ||
      new Set(names).size !== names.length) {
    throw new UpstreamError(502, "trace.response_invalid");
  }
  return {
    partial: Boolean(result.error),
    rows: table.rows.map(row => {
      if (!Array.isArray(row) || row.length !== names.length) throw new UpstreamError(502, "trace.response_invalid");
      return Object.fromEntries(names.map((name, index) => [name!, row[index]]));
    }),
  };
}

/** Resource-context queries against a deployed component, with an explicit managed identity. */
export function createApplicationInsightsQuery(
  env: NodeJS.ProcessEnv,
  fetch: typeof globalThis.fetch = globalThis.fetch,
): ApplicationInsightsQuery {
  let credential: ManagedIdentityCredential | undefined;
  let inFlight = 0;
  return async (resourceId, query, window) => {
    const clientId = env.BFF_TRACE_MANAGED_IDENTITY_CLIENT_ID;
    if (!applicationInsightsResourceId(resourceId) || !clientId || !UUID.test(clientId)) {
      throw new UpstreamError(503, "trace.reader_configuration_invalid");
    }
    const start = Date.parse(window.startTime);
    const end = Date.parse(window.endTime);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end || end - start > 731 * 86400000 ||
        query.length > 16000) {
      throw new UpstreamError(502, "trace.query_bounds_invalid");
    }
    if (inFlight >= 8) throw new UpstreamError(503, "trace.reader_busy");
    inFlight++;
    try {
      const signal = AbortSignal.timeout(10000);
      credential ??= new ManagedIdentityCredential({ clientId });
      const token = await credential.getToken("https://api.loganalytics.io/.default", { abortSignal: signal });
      if (!token) throw new UpstreamError(503, "trace.reader_unavailable");
      const path = resourceId.split("/").map(segment => encodeURIComponent(segment)).join("/");
      const response = await fetch(`https://api.loganalytics.azure.com/v1${path}/query`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token.token}`,
          "content-type": "application/json",
          accept: "application/json",
          prefer: "wait=7",
        },
        body: JSON.stringify({ query, timespan: `${new Date(start).toISOString()}/${new Date(end).toISOString()}` }),
        redirect: "error",
        signal,
      });
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 429) throw new UpstreamError(503, "trace.reader_busy");
        if (response.status === 403 || response.status === 401) throw new UpstreamError(503, "trace.reader_access_denied");
        throw new UpstreamError(503, "trace.reader_unavailable");
      }
      return parseQueryResult(await boundedTraceJson(response));
    } catch (error) {
      if (error instanceof UpstreamError) throw error;
      throw new UpstreamError(503, "trace.reader_unavailable");
    } finally {
      inFlight--;
    }
  };
}
