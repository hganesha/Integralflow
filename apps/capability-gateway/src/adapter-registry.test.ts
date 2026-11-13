import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { CapabilityDefinition } from "@ehf/contracts";
import type { Database } from "@ehf/persistence";
import { KYC_WIRING_BLOCKED_BINDINGS } from "@ehf/adapters";
import {
  REGISTERED_ADAPTER_IDS,
  checkConnectorCatalogConsistency,
  createAdapterRegistry,
  kycServiceState,
  resolveOpenAICompatibleEndpoint,
} from "./adapter-registry.js";
import { recordedFallbackAllowed } from "./adapters/openrouter.js";

const modelProfilesPath = new URL("../../../config/model-profiles.json", import.meta.url).pathname;

function capability(adapterBindingId: string, kind: CapabilityDefinition["kind"] = "tool", id = "screening.test.v1"): CapabilityDefinition {
  return {
    id,
    kind,
    effect: kind === "model" ? "none" : "read",
    adapterBindingId,
    inputSchema: {},
    outputSchema: {},
    timeoutMs: 10_000,
    maxAttempts: 1,
    idempotent: true,
  };
}

describe("adapter registry", () => {
  const db = { query: async () => ({ rowCount: 0, rows: [] }), end: async () => {} } as unknown as Database;
  const registry = createAdapterRegistry({ db, env: {}, fetch: globalThis.fetch, modelProfilesPath });

  it("validates adapter kind and operation independently from capability IDs", async () => {
    await expect(registry.assertSupported(capability("opensanctions:pep"), "tenant_demo")).resolves.toBeUndefined();
    await expect(registry.assertSupported(capability("opensanctions:screening.sanctions.search"), "tenant_demo")).resolves.toBeUndefined();
    await expect(registry.assertSupported(capability("opensanctions:anything"), "tenant_demo"))
      .rejects.toThrow("gateway.capability_adapter_binding_unsupported");
    await expect(registry.assertSupported(capability("opensanctions:pep", "model"), "tenant_demo"))
      .rejects.toThrow("gateway.capability_adapter_kind_unsupported");
  });

  it("binds a wiring operation only to its own capability and refuses corrected or quarantined operations", async () => {
    // v2 canonical model: a list download, an account profile or another provider contract is
    // never a stand-in for the capability a release asked for.
    await expect(registry.assertSupported(capability("wiring:plaid:financial.evidence.retrieve", "tool", "account.ownership.verify.v1"), "tenant_demo"))
      .rejects.toThrow("gateway.wiring_capability_mismatch");
    await expect(registry.assertSupported(capability("wiring:opensanctions:screening.pep", "tool", "screening.sanctions.v1"), "tenant_demo"))
      .rejects.toThrow("gateway.wiring_capability_mismatch");
    await expect(registry.assertSupported(capability("wiring:fincen-boi:business.registry.lookup", "tool", "business.registry.lookup.v1"), "tenant_demo"))
      .rejects.toThrow("gateway.wiring_binding_migration_required");
    await expect(registry.assertSupported(capability("wiring:finantier:account.ownership.verify", "tool", "account.ownership.verify.v1"), "tenant_demo"))
      .rejects.toThrow("gateway.wiring_binding_quarantined");
    await expect(registry.invoke(capability("wiring:digilocker:identity.digital_id.verify", "tool", "identity.digital_id.verify.v1"), {}, { tenantId: "tenant_demo" }))
      .rejects.toThrow("gateway.wiring_binding_migration_required");
    await expect(registry.assertSupported(capability("wiring:plaid:account.ownership.verify", "tool", "account.ownership.verify.v2"), "tenant_demo")).resolves.toBeUndefined();
  });

  it("rejects placeholder and unknown adapters at invocation time", async () => {
    await expect(registry.invoke(capability("unconfigured:screening"), {}, { tenantId: "tenant_demo" }))
      .rejects.toThrow("gateway.capability_adapter_unconfigured");
    await expect(registry.invoke(capability("retired:screening"), {}, { tenantId: "tenant_demo" }))
      .rejects.toThrow("gateway.capability_adapter_unsupported");
  });

  it("accepts any well-formed wiring operation and only the evidence pipeline operations", async () => {
    await expect(registry.assertSupported(capability("wiring:opensanctions:screening.pep", "tool", "screening.pep.v1"), "tenant_demo")).resolves.toBeUndefined();
    await expect(registry.assertSupported(capability("wiring:companies-house:business.registry.lookup", "tool", "business.registry.lookup.v1"), "tenant_demo")).resolves.toBeUndefined();
    await expect(registry.assertSupported(capability("wiring:opensanctions"), "tenant_demo"))
      .rejects.toThrow("gateway.capability_adapter_binding_unsupported");
    await expect(registry.assertSupported(capability("wiring:OpenSanctions:screening.pep"), "tenant_demo"))
      .rejects.toThrow("gateway.capability_adapter_binding_unsupported");
    await expect(registry.assertSupported(capability("wiring:opensanctions:screening.pep", "model", "screening.pep.v1"), "tenant_demo"))
      .rejects.toThrow("gateway.capability_adapter_kind_unsupported");
    for (const operation of ["ingest", "package", "ownership", "resume"]) {
      await expect(registry.assertSupported(capability(`evidence:${operation}`), "tenant_demo")).resolves.toBeUndefined();
    }
    await expect(registry.assertSupported(capability("evidence:erase-case"), "tenant_demo"))
      .rejects.toThrow("gateway.capability_adapter_binding_unsupported");
  });

  it("reports KYC services as missing until both URL and token are set, and requires https under the production profile", async () => {
    expect(kycServiceState({}, "wiring")).toBe("Missing");
    expect(kycServiceState({ KYC_WIRING_URL: "http://kyc-wiring:8000" }, "wiring")).toBe("Missing");
    expect(kycServiceState({ KYC_WIRING_URL: "http://kyc-wiring:8000", KYC_WIRING_TOKEN: "t" }, "wiring")).toBe("Configured");
    expect(kycServiceState({ KYC_WIRING_URL: "not a url", KYC_WIRING_TOKEN: "t" }, "wiring")).toBe("Missing");
    expect(kycServiceState({ EVIDENCE_PIPELINE_URL: "http://evidence:8080", EVIDENCE_PIPELINE_TOKEN: "t" }, "evidence")).toBe("Configured");
    expect(kycServiceState({ SECURITY_PROFILE: "production", EVIDENCE_PIPELINE_URL: "http://evidence:8080", EVIDENCE_PIPELINE_TOKEN: "t" }, "evidence")).toBe("Missing");
    expect(kycServiceState({ SECURITY_PROFILE: "production", EVIDENCE_PIPELINE_URL: "https://evidence.internal", EVIDENCE_PIPELINE_TOKEN: "t" }, "evidence")).toBe("Configured");

    const descriptors = await registry.listDescriptors("tenant_demo");
    expect(descriptors.find((item) => item.id === "wiring")?.credentialState).toBe("Missing");
    await expect(registry.invoke(capability("wiring:opensanctions:screening.pep", "tool", "screening.pep.v1"), { name: "Jane" }, { tenantId: "tenant_demo" }))
      .rejects.toThrow("gateway.kyc_wiring_not_configured");
    await expect(registry.invoke(capability("evidence:package"), { caseId: "c" }, { tenantId: "tenant_demo" }))
      .rejects.toThrow("gateway.evidence_pipeline_not_configured");
  });

  it("invokes the wiring service with the gateway-held token and an invocation-derived idempotency key", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const responses = [
      { check: { id: "chk_1", status: "completed" } },
      { items: [{ assessment: { outcome: "not_checked", reason_codes: [], bank_decision: "not_evaluated" }, execution: { status: "completed" }, warnings: [], extensions: { execution_mode: "simulation" } }] },
    ];
    const fetch = (async (url: URL | string, init: RequestInit = {}) => {
      calls.push({ url: url.toString(), init });
      return new Response(JSON.stringify(responses.shift()), { status: calls.length === 1 ? 202 : 200 });
    }) as typeof globalThis.fetch;
    const wired = createAdapterRegistry({
      db,
      env: { KYC_WIRING_URL: "http://kyc-wiring:8000", KYC_WIRING_TOKEN: "wiring-token", KYC_WIRING_TENANT_ID: "bank-tenant" },
      fetch,
      modelProfilesPath,
    });
    const result = await wired.invoke(capability("wiring:opensanctions:screening.pep", "tool", "screening.pep.v1"), { name: "Jane" }, { tenantId: "tenant_demo", invocationId: "inv_1" });
    expect(result.output).toMatchObject({ outcome: "not_checked", bankDecision: "not_evaluated", providerCheckId: "chk_1" });
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer wiring-token");
    expect(headers["Idempotency-Key"]).toMatch(/^ehf-[0-9a-f]{40}$/);
    expect(JSON.parse(String(calls[0]!.init.body)).request.tenant_id).toBe("bank-tenant");
  });

  it("uses an administered OpenAI-compatible endpoint ahead of the deployment-time fallback", () => {
    const provider = {
      id: "embeddings",
      kind: "openai_compatible" as const,
      displayName: "Administered embeddings",
      baseUrl: "https://administered.example.test/v1",
      credentialRef: null,
      siteUrl: null,
      appName: null,
      status: "active" as const,
    };
    expect(resolveOpenAICompatibleEndpoint(provider, { EMBEDDING_BASE_URL: "https://deployment-default.example.test/v1" }, "EMBEDDING_BASE_URL").hostname)
      .toBe("administered.example.test");
    expect(() => resolveOpenAICompatibleEndpoint({ ...provider, status: "disabled" }, {}, "EMBEDDING_BASE_URL"))
      .toThrow("gateway.embedding_provider_disabled");
    expect(resolveOpenAICompatibleEndpoint(null, { EMBEDDING_BASE_URL: "https://deployment-default.example.test/v1" }, "EMBEDDING_BASE_URL").hostname)
      .toBe("deployment-default.example.test");
    expect(() => resolveOpenAICompatibleEndpoint(null, { SECURITY_PROFILE: "production", EMBEDDING_BASE_URL: "http://embeddings.internal/v1" }, "EMBEDDING_BASE_URL"))
      .toThrow("gateway.embedding_endpoint_invalid");
  });
});

describe("connector catalog consistency", () => {
  const db = { query: async () => ({ rowCount: 0, rows: [] }), end: async () => {} } as unknown as Database;
  const catalog = JSON.parse(readFileSync(new URL("../../../config/connector-catalog.json", import.meta.url), "utf8")) as {
    connectors: Array<{ connectorId: string; adapterId: string }>;
  };
  const profiles = JSON.parse(readFileSync(modelProfilesPath, "utf8")) as { profiles: Array<{ id: string }> };

  it("lists exactly the adapters the registry registers", async () => {
    const registry = createAdapterRegistry({ db, env: {}, fetch: globalThis.fetch, modelProfilesPath });
    expect((await registry.listDescriptors("tenant_demo")).map((descriptor) => descriptor.id)).toEqual([...REGISTERED_ADAPTER_IDS]);
  });

  it("finds every committed connector served by a registered adapter and binding", () => {
    expect(catalog.connectors.length).toBeGreaterThan(800);
    expect(checkConnectorCatalogConsistency(catalog, { modelProfileIds: profiles.profiles.map((profile) => profile.id) })).toEqual([]);
  });

  it("blocks exactly the wiring operations whose v2 disposition is not a plain alias", () => {
    const full = JSON.parse(readFileSync(new URL("../../../config/connector-catalog.json", import.meta.url), "utf8")) as {
      connectors: Array<{ connectorId: string; adapterId: string; canonical: { runtimeDisposition: string } | null }>;
    };
    const expected = Object.fromEntries(full.connectors
      .filter((connector) => connector.adapterId === "wiring" && connector.canonical && connector.canonical.runtimeDisposition !== "alias_pending_approval")
      .map((connector) => [connector.connectorId.slice("wiring:".length), connector.canonical!.runtimeDisposition]));
    expect(Object.keys(expected)).toHaveLength(15);
    expect({ ...KYC_WIRING_BLOCKED_BINDINGS }).toEqual(expected);
  });

  it("reports unregistered adapters and unsupported bindings", () => {
    expect(checkConnectorCatalogConsistency({
      connectors: [
        { connectorId: "retired:orders", adapterId: "retired" },
        { connectorId: "opensanctions:everything", adapterId: "opensanctions" },
        { connectorId: "wiring:Bad Provider:screening.pep", adapterId: "wiring" },
        { connectorId: "openrouter:model.fast.v1", adapterId: "openrouter" },
      ],
    }, { modelProfileIds: [] })).toEqual([
      "retired:orders: adapter_unregistered",
      "opensanctions:everything: binding_unsupported",
      "wiring:Bad Provider:screening.pep: binding_unsupported",
      "openrouter:model.fast.v1: binding_unsupported",
    ]);
  });
});

describe("recorded model fallback", () => {
  it("platform_default allows the recorded adapter in development and denies it in production", () => {
    expect(recordedFallbackAllowed({}, "platform_default")).toBe(true);
    expect(recordedFallbackAllowed({ SECURITY_PROFILE: "production" }, "platform_default")).toBe(false);
    expect(recordedFallbackAllowed({ SECURITY_PROFILE: "production" })).toBe(false);
    expect(recordedFallbackAllowed({}, "deny")).toBe(false);
    expect(recordedFallbackAllowed({}, "allow")).toBe(true);
    expect(recordedFallbackAllowed({ SECURITY_PROFILE: "production" }, "allow")).toBe(false);
    expect(recordedFallbackAllowed({ SECURITY_PROFILE: "production", MODEL_RECORDED_FALLBACK: "allow" })).toBe(false);
  });
});
