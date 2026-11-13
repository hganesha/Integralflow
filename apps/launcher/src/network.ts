import { readFile } from "node:fs/promises";
import { secretReference } from "@ehf/contracts/deployment";
import { ManagedIdentityCredential } from "@azure/identity";
import { supportsS256Pkce } from "@ehf/identity";

/** Egress origins are deployment controlled, never expanded by a submitted profile. */
export function allowedOrigins(env: NodeJS.ProcessEnv): string[] {
  return (env.ONBOARDING_ALLOWED_ORIGINS ?? "https://openrouter.ai,https://api.openai.com").split(",").map(item => item.trim()).filter(Boolean);
}
export function trustedUrl(value: string, env: NodeJS.ProcessEnv): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.hash || !allowedOrigins(env).includes(url.origin)) throw new Error("endpoint.origin_not_allowed");
  return url;
}

export async function referenceValue(reference: string, env: NodeJS.ProcessEnv): Promise<string> {
  secretReference.parse(reference);
  if (reference.startsWith("env:")) {
    const allowed = new Set((env.ONBOARDING_SECRET_NAMES ?? "MODEL_PROVIDER_TOKEN,OIDC_CLIENT_SECRET").split(",").map(value => value.trim()));
    if (!allowed.has(reference.slice(4))) throw new Error("credential.reference_not_allowed");
  }
  let value = reference.startsWith("env:") ? env[reference.slice(4)] : await readFile(reference.slice(5), "utf8");
  if ((!value || (env.ONBOARDING_VAULT_REFERENCES ?? "").split(",").includes(reference)) && reference.startsWith("env:") && env.ONBOARDING_VAULT_URI && env.ONBOARDING_SECRET_PREFIX) {
    const aliases: Record<string, string> = { DATABASE_MIGRATOR_PASSWORD: "database-migrator-password", OBJECT_STORAGE_CREDENTIAL: "object-storage-credential", MODEL_PROVIDER_TOKEN: "model-provider-token", DOCUMENT_INTELLIGENCE_TOKEN: "document-intelligence-token", OIDC_CLIENT_SECRET: "oidc-client-secret" };
    const name = aliases[reference.slice(4)];
    const vault = new URL(env.ONBOARDING_VAULT_URI);
    if (!name || !/^[a-z][a-z0-9-]{1,39}$/.test(env.ONBOARDING_SECRET_PREFIX) || !/^https:\/\/[a-z0-9-]+\.vault\.azure\.net\/$/.test(vault.href)) throw new Error("credential.reference_not_allowed");
    const credential = new ManagedIdentityCredential(env.AZURE_CLIENT_ID ? { clientId: env.AZURE_CLIENT_ID } : {});
    const token = await credential.getToken("https://vault.azure.net/.default");
    const response = await fetch(new URL(`secrets/${env.ONBOARDING_SECRET_PREFIX}-${name}?api-version=7.4`, vault), { headers: { authorization: `Bearer ${token.token}` }, redirect: "error", signal: AbortSignal.timeout(10000) });
    value = (await boundedJson(response)).value;
  }
  if (!value?.trim() || value.length > 65536) throw new Error("credential.reference_unavailable");
  return value.trim();
}

export async function boundedJson(response: Response): Promise<any> {
  if (!response.ok || !response.body) throw new Error("endpoint.request_failed");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 2_000_000) throw new Error("endpoint.response_too_large");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally { await reader.cancel().catch(() => undefined); }
}

export async function discoverOidc(issuer: string, env: NodeJS.ProcessEnv, fetcher: typeof fetch) {
  const url = trustedUrl(`${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`, env);
  const document = await boundedJson(await fetcher(url, { redirect: "error", signal: AbortSignal.timeout(10_000) }));
  if (document.issuer !== issuer || !supportsS256Pkce(issuer, document)) throw new Error("identity.discovery_invalid");
  for (const field of ["authorization_endpoint", "token_endpoint", "jwks_uri"]) {
    if (typeof document[field] !== "string") throw new Error("identity.discovery_invalid");
    trustedUrl(document[field], env);
  }
  return document as { issuer: string; authorization_endpoint: string; token_endpoint: string; jwks_uri: string; token_endpoint_auth_methods_supported?: string[] };
}
