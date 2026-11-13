/**
 * Client-side check of run input against the plan's input schema (PLT-05). A courtesy only:
 * the server validates authoritatively. Supports what CompiledHarnessPlan.inputSchema can
 * express: required keys, primitive types and enums.
 */
export type InputSchema = {
  type: "object";
  required?: string[];
  properties: Record<string, { type: string; enum?: string[]; title?: string; description?: string; default?: unknown }>;
};

export type InputIssue = { path: string; message: string };

export type ParsedInput = { ok: true; value: Record<string, unknown> } | { ok: false; issues: InputIssue[] };

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

function matchesType(expected: string, value: unknown): boolean {
  const actual = typeOf(value);
  if (expected === "number") return actual === "number" || actual === "integer";
  return actual === expected;
}

export function parseRunInput(text: string, schema: InputSchema): ParsedInput {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { ok: false, issues: [{ path: "$", message: `Not valid JSON: ${(error as Error).message}` }] };
  }
  if (typeOf(value) !== "object") return { ok: false, issues: [{ path: "$", message: "Run input must be a JSON object." }] };
  const input = value as Record<string, unknown>;
  const issues: InputIssue[] = [];
  for (const key of schema.required ?? []) {
    if (input[key] === undefined || input[key] === "") issues.push({ path: key, message: "Required by the plan's input schema." });
  }
  for (const [key, property] of Object.entries(schema.properties ?? {})) {
    if (input[key] === undefined) continue;
    if (property.type && !matchesType(property.type, input[key])) issues.push({ path: key, message: `Expected ${property.type}, got ${typeOf(input[key])}.` });
    if (property.enum && !property.enum.includes(String(input[key]))) issues.push({ path: key, message: `Must be one of ${property.enum.join(", ")}.` });
  }
  return issues.length ? { ok: false, issues } : { ok: true, value: input };
}

/** A starting document: required keys with defaults or empty values of the right type. */
export function templateFor(schema: InputSchema): string {
  const draft: Record<string, unknown> = {};
  for (const key of schema.required ?? Object.keys(schema.properties ?? {})) {
    const property = schema.properties?.[key];
    draft[key] = property?.default ?? (property?.type === "number" || property?.type === "integer" ? 0 : property?.type === "boolean" ? false : property?.type === "object" ? {} : property?.type === "array" ? [] : "");
  }
  return JSON.stringify(draft, null, 2);
}

/** A fresh Idempotency-Key for one start request; reused when the same request is retried. */
export function newRequestKey(): string {
  return `web-${crypto.randomUUID()}`;
}
