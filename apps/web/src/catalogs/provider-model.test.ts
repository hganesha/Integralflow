import { expect, it } from "vitest";
import type { Schemas } from "@ehf/ui-contracts";
import { connectionErrors, newConnection, providerState } from "./provider-model";

it("keeps imported placeholders and unavailable gateway status out of ready counts", () => {
  const provider: Schemas["ExternalProviderView"] = { id: "acme", name: "Acme", description: "", origin: "catalog", quarantined: false, domains: [], capabilities: [], connections: [], activity: [], gatewayBindings: [{ id: "wiring:acme:lookup", capabilityId: "business.registry.lookup.v1", adapterId: "wiring", status: "available", blockers: [] }] };
  expect(providerState(provider, true)).toBe("catalogued");
  provider.gatewayBindings[0]!.status = "live_ready";
  expect(providerState(provider, false)).toBe("catalogued");
  expect(providerState(provider, true)).toBe("gateway");
  provider.gatewayBindings[0]!.blockers = ["acceptance_missing"];
  expect(providerState(provider, true)).toBe("catalogued");
  provider.quarantined = true;
  expect(providerState(provider, true)).toBe("quarantined");
});
it("permits incomplete drafts while refusing secret-bearing URLs and credential values", () => {
  const draft = { ...newConnection(), id: "acme-sandbox", name: "Acme sandbox" };
  expect(connectionErrors(draft, [])).toEqual({});
  expect(connectionErrors({ ...draft, endpoint: "https://api.example.com?api_key=secret", credentialRef: "sk-secret" }, [])).toHaveProperty("endpoint");
  expect(connectionErrors({ ...draft, credentialRef: "sk-secret" }, [])).toHaveProperty("credentialRef");
});
