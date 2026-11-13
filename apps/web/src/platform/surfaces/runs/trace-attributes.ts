/**
 * Span attributes the trace view may render (PLT-08 AC2). Everything else is hidden, and
 * anything that looks like a credential or a payload is hidden even if it were listed, so a
 * new upstream attribute never leaks by default.
 */
export const ALLOWED_ATTRIBUTES: readonly string[] = [
  "span.kind",
  "otel.status_code",
  "otel.status_description",
  "error",
  "error.type",
  "http.request.method",
  "http.route",
  "http.response.status_code",
  "rpc.system",
  "rpc.method",
  "db.system",
  "ehf.run_id",
  "ehf.node_id",
  "ehf.attempt",
  "ehf.fencing_epoch",
  "ehf.capability_id",
  "ehf.model_tier",
  "ehf.plan_digest",
  "ehf.reason_code",
];

const ALLOWED = new Set(ALLOWED_ATTRIBUTES);
const GEN_AI_COUNTERS = new Set(["gen_ai.usage.input_tokens", "gen_ai.usage.output_tokens"]);
const GEN_AI_PROVIDERS = new Set(["azure.ai.foundry", "azure.ai.openai"]);
const NEVER = /cookie|authori[sz]ation|body|token|secret|password|api[-_.]?key|credential|set-cookie/i;

export type VisibleAttributes = { shown: Array<[string, string]>; hidden: number };

function display(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function visibleAttributes(tags: Record<string, unknown> | null | undefined): VisibleAttributes {
  const shown: Array<[string, string]> = [];
  let hidden = 0;
  for (const [key, value] of Object.entries(tags ?? {})) {
    const counter = GEN_AI_COUNTERS.has(key) && typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
    const provider = key === "gen_ai.provider.name" && typeof value === "string" && GEN_AI_PROVIDERS.has(value);
    if (counter || provider || ALLOWED.has(key) && !NEVER.test(key)) shown.push([key, display(value)]);
    else hidden += 1;
  }
  shown.sort(([a], [b]) => a.localeCompare(b));
  return { shown, hidden };
}
