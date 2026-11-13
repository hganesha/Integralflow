/**
 * Pure rules for the Administration and Integrations surfaces (ui-specs §5,
 * BUILD-SPEC §10 PLT-14/15). Kept free of React so they are unit-tested directly.
 *
 * "Managed configuration" (`Session.environment.managedConfiguration`) means the
 * environment's deployment pipeline owns provider bindings, model routing and the
 * infrastructure settings sections; the console may then only change operational values,
 * and every write must say why (ui-specs §5.7).
 */

/** A credential reference names an environment variable; it is never a secret (ui-specs §5.3). */
export const CREDENTIAL_REF_PATTERN = /^[A-Z][A-Z0-9_]{2,64}$/;

export function credentialRefError(value: string): string | undefined {
  if (value === "") return undefined;
  if (CREDENTIAL_REF_PATTERN.test(value)) return undefined;
  return "Use the name of an environment variable, e.g. OPENROUTER_API_KEY (capitals, digits, underscores). Secrets are never accepted here.";
}

/**
 * Integration connector rules (packages/contracts integrationConnectorSchema): inbound
 * requests are verified by the platform, so they must be HMAC-signed; an outbound
 * destination may instead use OAuth 2.0 client credentials from any token endpoint, which
 * needs an https token URL, a client id and the audience requested as the token's scope.
 */
export type ConnectorAuthFields = {
  channel: "inbound_http" | "outbound_webhook";
  endpoint: string;
  kind: "hmac" | "oauth2_client_credentials";
  tokenUrl: string;
  clientId: string;
  audience: string;
};

function isHttps(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

export function connectorFieldErrors(draft: ConnectorAuthFields): Partial<Record<"endpoint" | "kind" | "tokenUrl" | "clientId" | "audience", string>> {
  const errors: Partial<Record<"endpoint" | "kind" | "tokenUrl" | "clientId" | "audience", string>> = {};
  const endpoint = draft.endpoint.trim();
  if (draft.channel === "outbound_webhook" && endpoint && !isHttps(endpoint)) errors.endpoint = "Outbound endpoints must use https.";
  if (draft.channel === "inbound_http" && draft.kind !== "hmac") errors.kind = "Inbound connectors must be HMAC-signed.";
  if (draft.kind === "oauth2_client_credentials") {
    if (!isHttps(draft.tokenUrl.trim())) errors.tokenUrl = "Enter the https token endpoint of the destination's OAuth 2.0 server.";
    if (!draft.clientId.trim()) errors.clientId = "Enter the OAuth 2.0 client id.";
    if (!draft.audience.trim()) errors.audience = "Enter the audience (requested as the token's scope).";
  }
  return errors;
}

export const WRITE_ROLE_HINT = "Requires Platform.Admin";
export const DEPLOYMENT_MANAGED_HINT = "Deployment configuration — change via deployment";

/** Under managed configuration every admin write must carry a reason (ui-specs §5.7). */
export function reasonError(reason: string, managedConfiguration: boolean): string | undefined {
  if (reason.length > 500) return "Keep the reason under 500 characters.";
  if (managedConfiguration && reason.trim() === "") return "A reason is required for every change in this environment.";
  return undefined;
}

/** The reason sent upstream: what the user typed, or a default outside managed configuration. */
export function reasonFor(reason: string, fallback: string): string {
  return reason.trim() || fallback;
}

/** Provider fields that are deployment configuration (ui-specs §5.7). */
export const PROVIDER_BINDING_FIELDS = ["kind", "baseUrl", "credentialRef"] as const;

export function providerFieldLocked(field: string, deploymentManaged: boolean | undefined, managedConfiguration: boolean): boolean {
  return (deploymentManaged === true || managedConfiguration) && (PROVIDER_BINDING_FIELDS as readonly string[]).includes(field);
}

/** Under managed configuration a model profile's provider and model are deployment configuration. */
export function profileFieldLocked(field: string, managedConfiguration: boolean): boolean {
  return managedConfiguration && (field === "provider" || field === "model");
}

/** Settings sections that cannot be written under managed configuration. */
export const MANAGED_IMMUTABLE_SECTIONS: ReadonlySet<string> = new Set(["runtime", "observability"]);

export function settingsSectionLocked(section: string, deploymentManaged: boolean | undefined, managedConfiguration: boolean): boolean {
  return deploymentManaged === true || (managedConfiguration && MANAGED_IMMUTABLE_SECTIONS.has(section));
}

// ---- Settings values by dot path -----------------------------------------------------

export function valueAt(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, key) => (current && typeof current === "object" ? (current as Record<string, unknown>)[key] : undefined), value);
}

export function withValueAt<T extends Record<string, unknown>>(value: T, path: string, next: unknown): T {
  const [head, ...rest] = path.split(".");
  if (!head) return value;
  if (rest.length === 0) return { ...value, [head]: next };
  const child = value[head] && typeof value[head] === "object" ? (value[head] as Record<string, unknown>) : {};
  return { ...value, [head]: withValueAt(child, rest.join("."), next) };
}

/**
 * Turn a field's text into the value sent upstream. A number that does not parse is sent as
 * its raw text so the server rejects it naming the field, never silently 0 or NaN.
 */
export function coerceSetting(kind: string, raw: string, nullable: boolean | undefined): unknown {
  if (raw === "" && nullable) return null;
  if (kind === "number") {
    if (raw.trim() === "") return raw;
    const number = Number(raw);
    return Number.isFinite(number) ? number : raw;
  }
  if (kind === "boolean") return raw === "true";
  return raw;
}

export function displaySetting(value: unknown): string {
  if (value === null || value === undefined) return "";
  return typeof value === "string" ? value : String(value);
}

export function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Parse a JSON object field; errors are returned rather than thrown. */
export function parseJsonObject(text: string): { value: Record<string, unknown> } | { error: string } {
  try {
    const value = JSON.parse(text) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return { error: "Enter a JSON object, e.g. {\"type\": \"object\"}." };
    return { value: value as Record<string, unknown> };
  } catch (error) {
    return { error: `Not valid JSON: ${(error as Error).message}` };
  }
}

/** Positive integer within a range; returns an error message or undefined. */
export function intError(raw: string, min: number, max: number): string | undefined {
  const number = Number(raw);
  if (raw.trim() === "" || !Number.isInteger(number)) return "Enter a whole number.";
  if (number < min || number > max) return `Use a value from ${min.toLocaleString()} to ${max.toLocaleString()}.`;
  return undefined;
}

// ---- Change history ------------------------------------------------------------------

export type JsonDiffRow = { path: string; before: unknown; after: unknown; kind: "added" | "removed" | "changed" };

/** Flat diff of two JSON documents by dot path, for the change-history drawer. */
export function jsonDiff(before: unknown, after: unknown, prefix = ""): JsonDiffRow[] {
  const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
  if (isObject(before) && isObject(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    return keys.flatMap((key) => {
      const path = prefix ? `${prefix}.${key}` : key;
      if (!(key in before)) return [{ path, before: undefined, after: after[key], kind: "added" as const }];
      if (!(key in after)) return [{ path, before: before[key], after: undefined, kind: "removed" as const }];
      return jsonDiff(before[key], after[key], path);
    });
  }
  if (sameJson(before, after)) return [];
  const path = prefix || "(document)";
  if (before === undefined || before === null) return [{ path, before, after, kind: "added" }];
  if (after === undefined || after === null) return [{ path, before, after, kind: "removed" }];
  return [{ path, before, after, kind: "changed" }];
}

export function shortDigest(digest: string | null | undefined): string {
  return digest ? `${digest.slice(0, 12)}…` : "—";
}
