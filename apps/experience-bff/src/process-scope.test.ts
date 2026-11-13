import { expect, it, vi } from "vitest";
import { buildApp } from "./app.js";
import type { Upstream } from "./upstream.js";

const SCOPE = { customerType: "corporate", trigger: "event_review", event: "ownership_change", jurisdictions: ["US", "GB"], products: ["deposit", "lending"], dueDiligence: "enhanced" };
const PREVIEW = {
  scope: SCOPE, previous: { ...SCOPE, customerType: "individual", institution: "bank.synthetic" }, unchanged: false,
  decisions: [{ kind: "connector", id: "acquire-officers", action: "include", reason: "Directors are screened.", basis: { source: "pack", field: "screening_roles", value: "director", packId: "policy.pack.us.bank-synthetic.business-banking", layer: "pack.product.lending" } }],
  changes: { agents: { added: ["agent.identity_ownership"], removed: [] }, skills: { added: [], removed: [] }, connectors: { added: ["acquire-officers"], removed: [] }, packs: { added: [], removed: [] }, nodes: { added: [{ id: "acquire-officers", kind: "tool", name: "Officers lookup" }], removed: [] } },
};

it("relays process scope previews with their decisions and keeps the remedy of a refusal", async () => {
  const principal = { subjectId: "author", tenantId: "tenant-scope", actorType: "human" as const, roles: ["Harness.Author"], source: "local" as const };
  const upstream = vi.fn<Upstream>(async () => ({ status: 200, body: { preview: PREVIEW } }));
  const app = buildApp({ env: { BFF_PUBLIC_ORIGIN: "http://ui.test", BFF_IDENTITY_MODE: "delegated" }, principalResolver: { source: "local", resolve: async () => principal }, upstream });
  try {
    const session = await app.inject({ url: "/api/v1/session", headers: { authorization: "Bearer author-session" } });
    const headers = { cookie: String(session.headers["set-cookie"]).split(";")[0]!, origin: "http://ui.test", "x-csrf-token": session.json().csrfToken };
    const url = "/api/v1/authoring/drafts/draft-1/scope/preview";
    const response = await app.inject({ method: "POST", url, payload: { scope: SCOPE }, headers });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().preview.decisions[0].basis.layer).toBe("pack.product.lending");
    expect(upstream.mock.calls.at(-1)?.slice(0, 4)).toEqual(["control-api", "POST", "/v1/authoring/drafts/draft-1/scope/preview", principal]);
    upstream.mockResolvedValueOnce({ status: 422, body: { error: "scope.pack_layer_missing", message: "scope.pack_layer_missing: policy_pack.layer_missing:jurisdiction:DE", remedy: "Author a jurisdiction policy pack layer for DE (domains/policy/packs)." } });
    const refused = await app.inject({ method: "POST", url, payload: { scope: { ...SCOPE, jurisdictions: ["DE"] } }, headers });
    expect(refused.statusCode).toBe(422);
    expect(refused.json()).toMatchObject({ error: "scope.pack_layer_missing", remedy: expect.stringContaining("DE") });
    upstream.mockResolvedValueOnce({ status: 200, body: { customerTypes: [{ value: "individual", available: true }], triggers: [{ value: "event_review", available: true }], events: [{ value: "ownership_change", customerTypes: ["corporate"] }], dueDiligence: [{ value: "enhanced", available: true, customerTypes: ["individual", "corporate"], description: "EDD" }], jurisdictions: [{ code: "AU", available: true }], products: ["deposit"], institutions: [] } });
    const options = await app.inject({ url: "/api/v1/authoring/scope-options", headers });
    expect(options.statusCode, options.body).toBe(200);
    principal.roles = ["Harness.Reader"];
    upstream.mockClear();
    expect((await app.inject({ method: "POST", url: "/api/v1/authoring/drafts/draft-1/scope/apply", payload: { scope: SCOPE, expectedRevision: 4 }, headers })).statusCode).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  } finally { await app.close(); }
});
