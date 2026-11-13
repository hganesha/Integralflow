import { entraDirectorySubject, entraTenantFromIssuer, resolveSecretRef } from "@ehf/identity";
import { UpstreamError } from "./upstream.js";

export type DirectoryConfiguration = { provider: "entra" | null; label: string; configured: boolean; reason: string | null };
export type DirectoryPerson = { id: string; displayName: string; email: string | null; principalName: string; enabled: boolean };
export type IdentityDirectory = {
  configuration: DirectoryConfiguration;
  subjectId: (id: string) => string;
  search: (query: string) => Promise<{ items: DirectoryPerson[]; hasMore: boolean }>;
  get: (id: string) => Promise<DirectoryPerson>;
};
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const FIELDS = "id,displayName,mail,userPrincipalName,accountEnabled";

/** Entra directory access stays server-side; the browser receives basic profiles only. */
export function entraDirectoryFromEnv(env: NodeJS.ProcessEnv, transport: typeof fetch = fetch): IdentityDirectory {
  const tenant = entraTenantFromIssuer(env.OIDC_ISSUER ?? "");
  const clientId = env.IDENTITY_DIRECTORY_CLIENT_ID?.trim() || env.OIDC_AUDIENCE?.trim();
  const secretRef = env.IDENTITY_DIRECTORY_CLIENT_SECRET_REF?.trim();
  const explicitProvider = env.IDENTITY_DIRECTORY_PROVIDER?.trim();
  const configured = Boolean(tenant && clientId && (secretRef || env.BFF_OIDC_CLIENT_SECRET) && (!explicitProvider || explicitProvider === "entra"));
  const configuration: DirectoryConfiguration = {
    provider: tenant || explicitProvider === "entra" ? "entra" : null,
    label: tenant || explicitProvider === "entra" ? "Microsoft Entra ID" : "Identity provider",
    configured,
    reason: configured ? null : "identity_directory.not_configured",
  };
  let cached: { value: string; expires: number } | undefined;
  let pending: Promise<string> | undefined;
  const token = async (): Promise<string> => {
    if (!configured) throw new UpstreamError(503, "identity_directory.not_configured");
    if (cached && cached.expires > Date.now() + 60_000) return cached.value;
    pending ??= (async () => {
      try {
        const secret = secretRef ? await resolveSecretRef(secretRef, env, { minLength: 1 }) : env.BFF_OIDC_CLIENT_SECRET!;
        const response = await transport(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
          method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000), headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
          body: new URLSearchParams({ grant_type: "client_credentials", client_id: clientId!, client_secret: secret, scope: "https://graph.microsoft.com/.default" }).toString(),
        });
        if (!response.ok) throw new UpstreamError(503, "identity_directory.authentication_failed");
        const body = await response.json() as Record<string, unknown>;
        if (typeof body.access_token !== "string" || !body.access_token || typeof body.expires_in !== "number" || body.expires_in <= 0) throw new UpstreamError(502, "identity_directory.response_invalid");
        cached = { value: body.access_token, expires: Date.now() + Math.min(body.expires_in, 86_400) * 1000 };
        return cached.value;
      } catch (error) {
        if (error instanceof UpstreamError) throw error;
        throw new UpstreamError(503, "identity_directory.authentication_failed");
      }
    })();
    try { return await pending; } finally { pending = undefined; }
  };
  const graph = async (path: string): Promise<Record<string, unknown>> => {
    try {
      const response = await transport(`https://graph.microsoft.com/v1.0/${path}`, {
        redirect: "error", signal: AbortSignal.timeout(15_000),
        headers: { authorization: `Bearer ${await token()}`, accept: "application/json", ConsistencyLevel: "eventual" },
      });
      if (response.status === 401) { cached = undefined; throw new UpstreamError(503, "identity_directory.authentication_failed"); }
      if (response.status === 403) throw new UpstreamError(503, "identity_directory.permission_required");
      if (response.status === 404) throw new UpstreamError(404, "identity_directory.user_not_found");
      if (response.status === 429) throw new UpstreamError(429, "identity_directory.rate_limited");
      if (!response.ok) throw new UpstreamError(503, "identity_directory.unavailable");
      return await response.json() as Record<string, unknown>;
    } catch (error) {
      if (error instanceof UpstreamError) throw error;
      throw new UpstreamError(503, "identity_directory.unavailable");
    }
  };
  const person = (value: unknown): DirectoryPerson => {
    const row = value as Record<string, unknown> | null;
    if (!row || typeof row.id !== "string" || !GUID.test(row.id) || typeof row.displayName !== "string" || !row.displayName.trim() || typeof row.accountEnabled !== "boolean") throw new UpstreamError(502, "identity_directory.response_invalid");
    const principalName = typeof row.userPrincipalName === "string" ? row.userPrincipalName : "";
    const email = typeof row.mail === "string" && EMAIL.test(row.mail) ? row.mail : EMAIL.test(principalName) ? principalName : null;
    return { id: row.id.toLowerCase(), displayName: row.displayName, email: email?.toLowerCase() ?? null, principalName, enabled: row.accountEnabled };
  };
  return {
    configuration,
    subjectId: id => { if (!tenant) throw new UpstreamError(503, "identity_directory.not_configured"); return entraDirectorySubject(tenant, id); },
    async search(query) {
      const trimmed = query.trim();
      if (trimmed.length < 2 || trimmed.length > 100 || /[\u0000-\u001f\u007f]/.test(trimmed)) throw new UpstreamError(400, "identity_directory.query_invalid");
      const literal = trimmed.replaceAll("'", "''");
      const params = new URLSearchParams({ $select: FIELDS, $top: "25", $count: "true", $orderby: "displayName", $filter: ["displayName", "mail", "userPrincipalName"].map(field => `startsWith(${field},'${literal}')`).join(" or ") });
      const result = await graph(`users?${params}`);
      if (!Array.isArray(result.value)) throw new UpstreamError(502, "identity_directory.response_invalid");
      return { items: result.value.slice(0, 25).map(person), hasMore: typeof result["@odata.nextLink"] === "string" };
    },
    async get(id) {
      if (!GUID.test(id)) throw new UpstreamError(400, "identity_directory.user_invalid");
      const user = person(await graph(`users/${encodeURIComponent(id)}?${new URLSearchParams({ $select: FIELDS })}`));
      if (user.id !== id.toLowerCase()) throw new UpstreamError(502, "identity_directory.response_invalid");
      if (!user.enabled) throw new UpstreamError(409, "identity_directory.user_disabled");
      if (!user.email) throw new UpstreamError(409, "identity_directory.email_missing");
      return user;
    },
  };
}
