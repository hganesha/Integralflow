import type { Schemas } from "@ehf/ui-contracts";
type Draft = Schemas["ExternalConnectionDraft"];

export function newConnection(): Draft {
  return { id: "", name: "", environment: "sandbox", adapterId: null, binding: null, endpoint: null, authentication: "workload_identity", credentialRef: null, capabilityIds: [], jurisdiction: "unresolved", coverageNote: "" };
}
export function connectionErrors(draft: Draft, adapters: Schemas["ExternalAdapterView"][]): Partial<Record<keyof Draft, string>> {
  const errors: Partial<Record<keyof Draft, string>> = {};
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(draft.id)) errors.id = "Use lower-case letters, digits, dots, dashes or underscores.";
  if (!draft.name.trim()) errors.name = "Enter a connection name.";
  if (draft.credentialRef && !/^[A-Z][A-Z0-9_]{2,64}$/.test(draft.credentialRef)) errors.credentialRef = "Enter a variable name such as PROVIDER_API_KEY, never a secret.";
  if (draft.endpoint) {
    try { const url = new URL(draft.endpoint); if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error(); }
    catch { errors.endpoint = "Use HTTPS without credentials, a query or a fragment."; }
  }
  const adapter = adapters.find(adapter => adapter.id === draft.adapterId);
  if (draft.binding && adapter && !new RegExp(adapter.bindingPattern).test(draft.binding)) errors.binding = "This operation does not match the adapter's binding format.";
  if (!/^([a-z]{2}(_[a-z0-9]+)?|global|unresolved)$/.test(draft.jurisdiction)) errors.jurisdiction = "Use a jurisdiction token such as gb, us, us_de, global or unresolved.";
  return errors;
}
export function providerState(provider: Schemas["ExternalProviderView"], gatewayAvailable: boolean): "quarantined" | "draft" | "gateway" | "catalogued" {
  if (provider.quarantined) return "quarantined";
  if (provider.connections.length || provider.origin === "custom") return "draft";
  if (gatewayAvailable && provider.gatewayBindings.some(binding => binding.status === "live_ready" && !binding.blockers.length)) return "gateway";
  return "catalogued";
}
export const PROVIDER_STATES = { catalogued: "Needs setup", draft: "Draft", gateway: "Gateway marked ready", quarantined: "Quarantined" } as const;
