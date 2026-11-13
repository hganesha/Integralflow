import { describe, expect, it } from "vitest";
import { buildGateway, type GatewayOptions } from "./app.js";
import type { Database } from "@ehf/persistence";

const SERVICE_TOKEN = "edge-service-token-for-tests-0001";
const RUNTIME_TOKEN = "runtime-service-token-for-tests-01";

function stubDatabase(): Database {
  return { query: async () => ({ rowCount: 0, rows: [] }), end: async () => {} } as unknown as Database;
}

function gateway(overrides: Partial<GatewayOptions> = {}) {
  return buildGateway({
    ...overrides,
    db: overrides.db ?? stubDatabase(),
    executionSecret: overrides.executionSecret ?? "test-execution-envelope-secret-value",
    env: { ...overrides.env },
    serviceGrants: overrides.serviceGrants ?? [
      { token: SERVICE_TOKEN, subjectId: "control-surface-edge", roles: ["Edge.Delegate"], tenantId: "tenant_demo" },
      { token: RUNTIME_TOKEN, subjectId: "harness-runtime", roles: ["Capability.Invoke"], tenantId: "tenant_demo" },
    ],
  });
}

const readerHeaders = {
  authorization: `Bearer ${SERVICE_TOKEN}`,
  "x-actor-id": "reader@example.test",
  "x-actor-roles": "Harness.Reader",
};

const authorHeaders = {
  authorization: `Bearer ${SERVICE_TOKEN}`,
  "x-actor-id": "author@example.test",
  "x-actor-roles": "Harness.Author",
};

const adminHeaders = {
  authorization: `Bearer ${SERVICE_TOKEN}`,
  "x-actor-id": "admin@example.test",
  "x-actor-roles": "Platform.Admin",
};

const draftCapability = {
  id: "screening.adverse-media.search.v1",
  kind: "tool",
  effect: "read",
  adapterBindingId: "unconfigured:adverse-media-search",
  inputSchema: { type: "object", properties: {} },
  outputSchema: { type: "object", properties: {} },
  timeoutMs: 15_000,
  maxAttempts: 1,
  idempotent: true,
  description: "Adverse-media search placeholder.",
  owner: "compliance-platform",
  dataClasses: ["pii"],
  status: "draft",
};

describe("capability registration authorization", () => {
  it("allows an administrator to maintain capability definitions when authoring is disabled", async () => {
    const app = gateway({ env: { AUTHORING_MODE: "disabled" } });
    const response = await app.inject({
      method: "POST",
      url: "/v1/capabilities",
      headers: adminHeaders,
      payload: draftCapability,
    });
    expect(response.statusCode).toBe(200);

    const inventory = await app.inject({ method: "GET", url: "/v1/capabilities", headers: readerHeaders });
    expect(inventory.statusCode).toBe(200);
    await app.close();
  });

  it("does not let an author maintain deployed capability definitions in operations-only mode", async () => {
    const app = gateway({ env: { AUTHORING_MODE: "disabled" } });
    const response = await app.inject({
      method: "POST",
      url: "/v1/capabilities",
      headers: authorHeaders,
      payload: draftCapability,
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toBe("authorization.role_missing");
    await app.close();
  });

  it("rejects an unauthenticated registration", async () => {
    const app = gateway();
    // This route previously accepted anonymous writes, and a registered capability is
    // what a compiled plan is allowed to bind to.
    const response = await app.inject({
      method: "POST", url: "/v1/capabilities", payload: { id: "tool.x" },
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("rejects a forged actor header with no edge credential", async () => {
    const app = gateway();
    const response = await app.inject({
      method: "POST", url: "/v1/capabilities",
      headers: { "x-actor-id": "attacker@example.test", "x-actor-roles": "Harness.Author" },
      payload: { id: "tool.x" },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error).toBe("authorization.principal_unauthenticated");
    await app.close();
  });

  it("rejects a reader delegated through the edge", async () => {
    const app = gateway();
    const response = await app.inject({
      method: "POST", url: "/v1/capabilities",
      headers: {
        authorization: `Bearer ${SERVICE_TOKEN}`,
        "x-actor-id": "reader@example.test",
        "x-actor-roles": "Harness.Reader",
      },
      payload: { id: "tool.x" },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toBe("authorization.role_missing");
    await app.close();
  });

  it("will not let a runtime workload token stand in for an author", async () => {
    // Authenticated but not permitted to speak for a person: 403, not 401.
    const app = gateway();
    const response = await app.inject({
      method: "POST", url: "/v1/capabilities",
      headers: {
        authorization: `Bearer ${RUNTIME_TOKEN}`,
        "x-actor-id": "reader@example.test",
        "x-actor-roles": "Harness.Author",
      },
      payload: { id: "tool.x" },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toBe("authorization.delegation_not_permitted");
    await app.close();
  });

  it("accepts an editable draft placeholder but refuses to activate an unconfigured binding", async () => {
    const app = gateway();
    const draftResponse = await app.inject({
      method: "POST",
      url: "/v1/capabilities",
      headers: authorHeaders,
      payload: draftCapability,
    });
    expect(draftResponse.statusCode).toBe(200);

    const activeResponse = await app.inject({
      method: "POST",
      url: "/v1/capabilities",
      headers: authorHeaders,
      payload: { ...draftCapability, status: "active" },
    });
    expect(activeResponse.statusCode).toBe(400);
    expect(activeResponse.body).toContain("capability.active_binding_unconfigured");
    await app.close();
  });

  it("refuses to activate a binding that is not advertised by the adapter registry", async () => {
    const app = gateway();
    const response = await app.inject({
      method: "POST",
      url: "/v1/capabilities",
      headers: authorHeaders,
      payload: {
        id: "screening.legacy-api.search.v1",
        kind: "tool",
        effect: "read",
        adapterBindingId: "api:legacy-screening",
        inputSchema: { type: "object", properties: {} },
        outputSchema: { type: "object", properties: {} },
        timeoutMs: 15_000,
        maxAttempts: 1,
        idempotent: true,
        description: "Unsupported active binding.",
        owner: "compliance-platform",
        dataClasses: [],
        status: "active",
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("gateway.capability_adapter_unsupported");
    await app.close();
  });
});

describe("adapter registry catalog", () => {
  it("requires management authorization", async () => {
    const app = gateway();
    const response = await app.inject({ method: "GET", url: "/v1/adapters" });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("advertises only executable adapters and their supported operations", async () => {
    const app = gateway({ modelProfilesPath: new URL("../../../config/model-profiles.json", import.meta.url).pathname });
    const response = await app.inject({ method: "GET", url: "/v1/adapters", headers: readerHeaders });
    expect(response.statusCode).toBe(200);
    const adapters = response.json().adapters as Array<{ id: string; bindingOptions: Array<{ value: string }> }>;
    expect(adapters.map((adapter) => adapter.id)).toEqual(["simulator", "opensanctions", "wiring", "evidence", "pgvector", "openrouter", "document-model"]);
    expect(adapters.some((adapter) => adapter.id === "api" || adapter.id === "http-operation")).toBe(false);
    expect(adapters.find((adapter) => adapter.id === "opensanctions")?.bindingOptions.map((item) => item.value))
      .toEqual(["pep", "sanctions"]);
    expect(adapters.find((adapter) => adapter.id === "pgvector")?.bindingOptions.map((item) => item.value))
      .toEqual(["knowledge.search"]);
    expect(adapters.find((adapter) => adapter.id === "evidence")?.bindingOptions.map((item) => item.value))
      .toEqual(["prepare", "ingest", "package", "ownership", "resume", "pages"]);
    await app.close();
  });

  it("reports KYC wiring and evidence pipeline readiness without exposing their credentials", async () => {
    const unconfigured = gateway();
    const missing = await unconfigured.inject({ method: "GET", url: "/v1/status", headers: readerHeaders });
    expect(missing.statusCode).toBe(200);
    expect(missing.json()).toMatchObject({ kycWiringState: "Missing", evidencePipelineState: "Missing" });
    await unconfigured.close();

    const configured = gateway({ env: {
      KYC_WIRING_URL: "http://kyc-wiring:8000",
      KYC_WIRING_TOKEN: "wiring-secret-value",
      EVIDENCE_PIPELINE_URL: "http://evidence-pipeline:8080",
      EVIDENCE_PIPELINE_TOKEN: "evidence-secret-value",
    } });
    const ready = await configured.inject({ method: "GET", url: "/v1/status", headers: readerHeaders });
    expect(ready.json()).toMatchObject({ kycWiringState: "Configured", evidencePipelineState: "Configured" });
    expect(ready.body).not.toContain("secret-value");
    await configured.close();
  });
});

describe("capability invocation authorization", () => {
  it("requires a workload credential before looking at the envelope", async () => {
    const app = gateway();
    const response = await app.inject({
      method: "POST", url: "/v1/invoke",
      headers: { "x-execution-envelope": "not-a-token" },
      payload: { invocationId: "INV-1", capabilityId: "tool.x", effect: "read", input: {} },
    });
    // The invoke path reports denials as bounded business outcomes rather than platform
    // failures, so an unauthenticated caller is a recorded 403 denial.
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toBe("authorization.principal_unauthenticated");
    await app.close();
  });

  it("requires an execution envelope even with a valid workload credential", async () => {
    const app = gateway();
    // A workload token proves which service is calling. It says nothing about which run,
    // node or attempt may spend a capability, which is what the envelope carries.
    const response = await app.inject({
      method: "POST", url: "/v1/invoke",
      headers: { authorization: `Bearer ${RUNTIME_TOKEN}` },
      payload: { invocationId: "INV-1", capabilityId: "tool.x", effect: "read", input: {} },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("gateway.execution_envelope_missing");
    await app.close();
  });
});

describe("OpenSanctions provider probe", () => {
  it("requires delegated management authorization", async () => {
    const app = gateway({ env: { OPENSANCTIONS_API_KEY: "test-secret" } });
    const response = await app.inject({
      method: "POST",
      url: "/v1/opensanctions/test",
      payload: { screeningType: "PEP", name: "Example Official" },
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("executes a PEP-scoped match without returning subject details or credentials", async () => {
    let requestedUrl = "";
    let requestedInit: RequestInit | undefined;
    const app = gateway({
      env: {
        OPENSANCTIONS_API_KEY: "test-secret",
        OPENSANCTIONS_API_URL: "https://screening.example",
      },
      fetch: async (url, init) => {
        requestedUrl = String(url);
        requestedInit = init;
        return new Response(JSON.stringify({
          responses: {
            subject: {
              status: 200,
              query: { schema: "Person", properties: { name: ["Example Official"] } },
              results: [{ id: "Q-example", caption: "Example Official", score: 0.98, match: true }],
            },
          },
        }), { status: 200, headers: { "x-request-id": "probe-request-1" } });
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/opensanctions/test",
      headers: readerHeaders,
      payload: { screeningType: "PEP", name: "Example Official", country: "US" },
    });

    expect(response.statusCode).toBe(200);
    expect(new URL(requestedUrl).searchParams.getAll("topics")).toEqual(["role.pep"]);
    expect(new Headers(requestedInit?.headers).get("Authorization")).toBe("ApiKey test-secret");
    expect(response.json()).toMatchObject({
      status: "Ready",
      credentialState: "Configured",
      provider: "opensanctions",
      dataset: "default",
      screeningType: "PEP",
      matchCount: 1,
      acceptedMatchCount: 1,
      providerRequestId: "probe-request-1",
    });
    expect(response.body).not.toContain("Example Official");
    expect(response.body).not.toContain("test-secret");
    await app.close();
  });

  it("rejects malformed probe input before contacting the provider", async () => {
    let providerCalled = false;
    const app = gateway({
      env: { OPENSANCTIONS_API_KEY: "test-secret" },
      fetch: async () => {
        providerCalled = true;
        return new Response("{}", { status: 200 });
      },
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/opensanctions/test",
      headers: readerHeaders,
      payload: { screeningType: "PEP", name: "" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().message).toBe("gateway.opensanctions_probe_invalid");
    expect(providerCalled).toBe(false);
    await app.close();
  });
});


describe("request admission", () => {
  it("bounds requests per peer and rejects forwarding-header spoofing", async () => {
    const app = gateway();
    app.log.level = "silent";
    try {
      for (let i = 0; i < 1000; i++) {
        const response = await app.inject({ method: "GET", url: "/health/live", remoteAddress: "192.0.2.1" });
        expect(response.statusCode).toBe(200);
      }
      const denied = await app.inject({ method: "GET", url: "/health/live", remoteAddress: "192.0.2.1", headers: { "x-forwarded-for": "192.0.2.99" } });
      expect(denied.statusCode).toBe(429);
      expect(Number(denied.headers["retry-after"])).toBeGreaterThan(0);
      expect((await app.inject({ method: "GET", url: "/health/live", remoteAddress: "192.0.2.2" })).statusCode).toBe(200);
    } finally { await app.close(); }
  });
});

describe("connector registry routes", () => {
  const connector = {
    connectorId: "wiring:companies-house:business.registry.lookup", adapterId: "wiring",
    providerId: "companies-house", providerName: "Companies House", capabilityId: "business.registry.lookup.v1",
    operation: "business.registry.lookup", resultFamily: "business", status: "available", demoSupported: true,
    liveBlockers: ["vendor_credentials_missing"], source: { catalog: "data-adapters/api-wiring/vendor/atlas", revision: "abc" },
  };
  function connectorDatabase(calls: Array<{ text: string; values: unknown[] }>): Database {
    return {
      query: async (text: string, values: unknown[] = []) => {
        calls.push({ text, values });
        if (!text.includes("connector_registry")) return { rowCount: 0, rows: [] };
        if (text.includes("connector_id = $1") && values[0] !== connector.connectorId) return { rowCount: 0, rows: [] };
        return { rowCount: 1, rows: [{ connector_id: connector.connectorId, definition: connector, definition_digest: "a".repeat(64), status: "live_ready", created_at: new Date(0), updated_at: new Date(0) }] };
      },
      end: async () => {},
    } as unknown as Database;
  }

  it("lists connectors with filters under the capability-read authority", async () => {
    const calls: Array<{ text: string; values: unknown[] }> = [];
    const app = gateway({ db: connectorDatabase(calls) });
    try {
      expect((await app.inject({ method: "GET", url: "/v1/connectors" })).statusCode).toBe(401);
      const response = await app.inject({
        method: "GET", url: "/v1/connectors?capabilityId=business.registry.lookup.v1&providerId=companies-house&status=available&limit=10",
        headers: readerHeaders,
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as { connectors: Array<{ connector: { connectorId: string; status: string } }>; nextCursor: string | null };
      expect(body.connectors[0]?.connector).toMatchObject({ connectorId: connector.connectorId, status: "live_ready" });
      expect(body.nextCursor).toBeNull();
      const query = calls.find((call) => call.text.includes("connector_registry"));
      expect(query?.values.slice(0, 4)).toEqual(["business.registry.lookup.v1", null, "companies-house", "available"]);
      expect((await app.inject({ method: "GET", url: "/v1/connectors?status=enabled", headers: readerHeaders })).statusCode).toBe(400);
      // v2 canonical routing lookups.
      calls.length = 0;
      const routed = await app.inject({
        method: "GET", url: "/v1/connectors?canonicalCapabilityId=business.registry.intelligence.gb&jurisdiction=gb&bindable=true", headers: readerHeaders,
      });
      expect(routed.statusCode).toBe(200);
      expect(calls.find((call) => call.text.includes("connector_registry"))?.values.slice(6)).toEqual(["gb", "business.registry.intelligence.gb", true]);
      expect((await app.inject({ method: "GET", url: "/v1/connectors?jurisdiction=uk-x", headers: readerHeaders })).json()).toEqual({ error: "connector.jurisdiction_invalid" });
      expect((await app.inject({ method: "GET", url: "/v1/connectors?canonicalCapabilityId=business.registry.lookup.v1", headers: readerHeaders })).statusCode).toBe(400);
      expect((await app.inject({ method: "GET", url: "/v1/connectors?bindable=yes", headers: readerHeaders })).statusCode).toBe(400);
      expect((await app.inject({ method: "GET", url: "/v1/connectors?limit=abc", headers: readerHeaders })).statusCode).toBe(400);
      expect((await app.inject({ method: "GET", url: "/v1/connectors?cursor=nope", headers: readerHeaders })).statusCode).toBe(400);
    } finally { await app.close(); }
  });

  it("reads one connector by its ID and answers 404 for an unknown one", async () => {
    const app = gateway({ db: connectorDatabase([]) });
    try {
      const found = await app.inject({ method: "GET", url: `/v1/connectors/${encodeURIComponent(connector.connectorId)}`, headers: readerHeaders });
      expect(found.statusCode).toBe(200);
      expect((found.json() as { connector: { capabilityId: string } }).connector.capabilityId).toBe("business.registry.lookup.v1");
      const missing = await app.inject({ method: "GET", url: "/v1/connectors/wiring%3Anobody%3Ascreening.pep", headers: readerHeaders });
      expect(missing.statusCode).toBe(404);
    } finally { await app.close(); }
  });
});
