import { checkDependency, httpHealthCheck, notConfigured, type DependencyComponent } from "@ehf/contracts/platform-health";
import { allowsInsecureEndpoints } from "@ehf/identity";
import { listProviders, type Database } from "@ehf/persistence";
import { credentialFor, kycServiceSettings, kycServiceState } from "./adapters/shared.js";

/**
 * What only the gateway can reach: the hosts its adapters call and the model endpoints of the
 * tenant's provider bindings. Each is called for the report; configuration alone is never
 * reported as health.
 */
type Deps = { db: Database; env: NodeJS.ProcessEnv; fetch: typeof fetch };

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const ANTHROPIC_BASE_URL = "https://api.anthropic.com";

function serviceUrl(raw: string | undefined, path: string, env: NodeJS.ProcessEnv): URL | null {
  if (!raw?.trim()) return null;
  try {
    const url = new URL(raw.trim());
    if (url.username || url.password) return null;
    if (url.protocol !== "https:" && !(url.protocol === "http:" && allowsInsecureEndpoints(env))) return null;
    return new URL(path.replace(/^\//, ""), `${url.toString().replace(/\/$/, "")}/`);
  } catch { return null; }
}

function hostCheck(deps: Deps, component: { id: string; name: string }, raw: string | undefined, configured: boolean): Promise<DependencyComponent> {
  const described = { ...component, group: "endpoint" as const };
  if (!configured) return Promise.resolve(notConfigured(described));
  const url = serviceUrl(raw, "/healthz", deps.env);
  if (!url) return Promise.resolve({ ...described, status: "Unavailable", detail: "Its address is not a valid endpoint for this security profile.", latencyMs: null });
  return checkDependency(described, httpHealthCheck(deps.fetch, url));
}

async function modelProviders(deps: Deps, tenantId: string): Promise<DependencyComponent[]> {
  const providers = (await listProviders(deps.db, tenantId)).map(record => record.provider).filter(provider => provider.status === "active");
  // Before any provider is administered, the deployment's own OpenRouter key is what model calls use.
  const bindings = providers.length ? providers
    : deps.env.OPENROUTER_API_KEY ? [{ id: "openrouter", kind: "openrouter" as const, displayName: "OpenRouter", baseUrl: null, credentialRef: null }] : [];
  if (!bindings.length) return [notConfigured({ id: "model:none", name: "Model provider", group: "endpoint" }, "No active model provider is bound for this tenant.")];
  return Promise.all(bindings.map(provider => {
    const described = { id: `model:${provider.id}`, name: `Model provider: ${provider.displayName}`, group: "endpoint" as const };
    if (provider.kind === "recorded") return notConfigured(described, "Recorded responses; no model endpoint is called.");
    const credential = credentialFor(provider, deps.env) ?? (provider.kind === "openrouter" ? deps.env.OPENROUTER_API_KEY : undefined);
    if (provider.credentialRef && !credential) return { ...described, status: "Degraded" as const, detail: "Its credential is not available to the gateway.", latencyMs: null };
    const anthropic = provider.kind === "anthropic";
    const url = serviceUrl(provider.baseUrl ?? (anthropic ? ANTHROPIC_BASE_URL : OPENROUTER_BASE_URL), anthropic ? "/v1/models" : "/models", deps.env);
    if (!url) return { ...described, status: "Unavailable" as const, detail: "Its address is not a valid endpoint for this security profile.", latencyMs: null };
    const headers: Record<string, string> = !credential ? {} : anthropic ? { "x-api-key": credential, "anthropic-version": "2023-06-01" } : { authorization: `Bearer ${credential}` };
    // Listing models reaches the endpoint and proves the credential without running a model.
    return checkDependency(described, async (signal) => {
      const response = await deps.fetch(url, { headers, redirect: "error", signal });
      await response.arrayBuffer().catch(() => undefined);
      if (response.ok) return { status: "Ready", detail: "Reachable; the credential was accepted." };
      if (response.status === 401 || response.status === 403) return { status: "Degraded", detail: "Reachable, but the credential was refused." };
      if (response.status === 404) return { status: "Degraded", detail: "Reachable, but it does not list models at this address." };
      return { status: "Unavailable", detail: `Answered with HTTP ${response.status}.` };
    }, 10_000);
  }));
}

export async function gatewayDependencies(deps: Deps, tenantId: string): Promise<DependencyComponent[]> {
  const { env } = deps;
  const [hosts, models] = await Promise.all([
    Promise.all([
      hostCheck(deps, { id: "skill-host", name: "Skill runtime (skill host)" }, env.SKILL_HOST_URL, Boolean(env.SKILL_HOST_URL?.trim())),
      hostCheck(deps, { id: "evidence-pipeline", name: "Document intelligence (evidence pipeline)" }, kycServiceSettings(env, "evidence").url, kycServiceState(env, "evidence") === "Configured"),
      hostCheck(deps, { id: "kyc-wiring", name: "KYC provider wiring" }, kycServiceSettings(env, "wiring").url, kycServiceState(env, "wiring") === "Configured"),
    ]),
    modelProviders(deps, tenantId).catch((): DependencyComponent[] => [{ id: "model:registry", name: "Model provider", group: "endpoint", status: "Unknown", detail: "The provider registry could not be read.", latencyMs: null }]),
  ]);
  return [...hosts, ...models];
}
