import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { CapabilityDefinition } from "@ehf/contracts";
import type { Database } from "@ehf/persistence";
import {
  ADAPTER_MODULE_IDS,
  REGISTERED_ADAPTER_IDS,
  checkConnectorCatalogConsistency,
  createAdapterRegistry,
  moduleConnectorTemplates,
  resolveEnabledAdapterIds,
} from "./adapter-registry.js";
import { buildGateway } from "./app.js";

const modelProfilesPath = new URL("../../../config/model-profiles.json", import.meta.url).pathname;
const db = { query: async () => ({ rowCount: 0, rows: [] }), end: async () => {} } as unknown as Database;
const CLIENT_SECRET = "databricks-client-secret-value";

function capability(adapterBindingId: string, kind: CapabilityDefinition["kind"] = "tool", effect: CapabilityDefinition["effect"] = "read"): CapabilityDefinition {
  return { id: "knowledge.vector.search.v1", kind, effect, adapterBindingId, inputSchema: {}, outputSchema: {}, timeoutMs: 10_000, maxAttempts: 1, idempotent: true };
}

type Call = { url: URL; init: RequestInit; body: unknown };
function fakeFetch(responder: (call: Call) => { status?: number; body?: unknown }) {
  const calls: Call[] = [];
  const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const raw = typeof init.body === "string" ? init.body : undefined;
    let body: unknown = raw;
    try { body = raw ? JSON.parse(raw) : undefined; } catch { /* form-encoded */ }
    const call = { url: new URL(String(input)), init, body };
    calls.push(call);
    const reply = responder(call);
    return new Response(reply.body === undefined ? "" : JSON.stringify(reply.body), { status: reply.status ?? 200, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}
const header = (call: Call, name: string) => new Headers(call.init.headers).get(name);

const WORKLOAD_TOKEN = "gateway-workload-identity-token";

function registry(env: NodeJS.ProcessEnv, fetch: typeof globalThis.fetch = globalThis.fetch) {
  return createAdapterRegistry({
    db, env: { ...env }, fetch, modelProfilesPath,
    workloadToken: async () => WORKLOAD_TOKEN,
  });
}

describe("adapter module enablement", () => {
  it("enables the configuration-free adapters by default and cloud adapters only on request", () => {
    expect([...REGISTERED_ADAPTER_IDS]).toEqual(["simulator", "opensanctions", "wiring", "evidence", "pgvector", "openrouter", "document-model"]);
    expect(ADAPTER_MODULE_IDS).toEqual([...REGISTERED_ADAPTER_IDS, "foundry-agent", "databricks-serving", "databricks-vector", "databricks-uc", "http-operation", "skills", "corpus", "context-postgres", "context-salesforce", "context-fenergo", "context-documents", "context-source", "decisions"]);
    expect(resolveEnabledAdapterIds({})).toEqual([...REGISTERED_ADAPTER_IDS]);
    expect(resolveEnabledAdapterIds({ GATEWAY_ADAPTERS: " default , databricks-serving" })).toEqual([...REGISTERED_ADAPTER_IDS, "databricks-serving"]);
    expect(resolveEnabledAdapterIds({ GATEWAY_ADAPTERS: "http-operation,simulator" })).toEqual(["simulator", "http-operation"]);
    expect(() => resolveEnabledAdapterIds({ GATEWAY_ADAPTERS: "simulator,snowflake" })).toThrow("gateway.adapter_module_unknown: snowflake");
    expect(() => resolveEnabledAdapterIds({ GATEWAY_ADAPTERS: " , " })).toThrow("gateway.adapter_modules_empty");
  });

  it("fails gateway startup on an unknown adapter ID", () => {
    expect(() => buildGateway({ db, env: { GATEWAY_ADAPTERS: "default,not-an-adapter" } })).toThrow("gateway.adapter_module_unknown");
  });

  it("registers only enabled adapters and reports every module's cloud and enabled state", async () => {
    const enabled = registry({ GATEWAY_ADAPTERS: "simulator,databricks-vector,http-operation" });
    expect((await enabled.listDescriptors("tenant_demo")).map((item) => [item.id, item.cloud, item.enabled])).toEqual([
      ["simulator", "local", true], ["databricks-vector", "databricks", true], ["http-operation", "any", true],
    ]);
    const modules = enabled.listModules();
    expect(modules.find((item) => item.id === "opensanctions")).toMatchObject({ cloud: "vendor", enabled: false, enabledByDefault: true, connectorTemplate: null });
    expect(modules.find((item) => item.id === "databricks-vector")).toMatchObject({ cloud: "databricks", enabled: true, enabledByDefault: false, connectorTemplate: { capabilityIds: ["knowledge.vector.search.v1"] } });
    await expect(enabled.assertSupported(capability("opensanctions:pep"), "tenant_demo")).rejects.toThrow("gateway.capability_adapter_unsupported");
    await expect(enabled.assertSupported(capability("databricks-vector:main.kyc.idx"), "tenant_demo")).resolves.toBeUndefined();
  });

  it("publishes exactly the connector templates the committed catalog lists", () => {
    const catalog = JSON.parse(readFileSync(new URL("../../../config/connector-catalog.json", import.meta.url), "utf8")) as {
      connectors: Array<{ connectorId: string; adapterId: string }>;
      connectorTemplates: ReturnType<typeof moduleConnectorTemplates>;
    };
    expect(catalog.connectorTemplates).toEqual(moduleConnectorTemplates());
    expect(checkConnectorCatalogConsistency({ connectors: [], connectorTemplates: catalog.connectorTemplates }, { modelProfileIds: [] })).toEqual([]);
    const drifted = catalog.connectorTemplates.map((item) => (item.adapterId === "http-operation" ? { ...item, bindingPattern: "^.*$" } : item));
    expect(checkConnectorCatalogConsistency({ connectors: [], connectorTemplates: [...drifted, { ...drifted[0]!, adapterId: "snowflake" }] }, { modelProfileIds: [] }))
      .toEqual(["template http-operation: template_mismatch", "template snowflake: adapter_unregistered"]);
  });
});

describe("Databricks adapters through the registry", () => {
  const databricksEnv = {
    GATEWAY_ADAPTERS: "databricks-serving,databricks-vector,databricks-uc",
    DATABRICKS_HOST: "https://dbc-123.cloud.databricks.com",
    DATABRICKS_CLIENT_ID: "sp-client-id",
    DATABRICKS_CLIENT_SECRET: CLIENT_SECRET,
    DATABRICKS_WAREHOUSE_ID: "abc123",
  };

  it("reports Missing until configured and refuses to invoke", async () => {
    const unconfigured = registry({ GATEWAY_ADAPTERS: "databricks-serving,databricks-uc" });
    const states = Object.fromEntries((await unconfigured.listDescriptors("t")).map((item) => [item.id, item.credentialState]));
    expect(states).toEqual({ "databricks-serving": "Missing", "databricks-uc": "Missing" });
    await expect(unconfigured.invoke(capability("databricks-serving:kyc-llm", "model", "paid"), { prompt: "x" }, { tenantId: "t" }))
      .rejects.toThrow("gateway.databricks_host_invalid");
    const noWarehouse = registry({ ...databricksEnv, DATABRICKS_WAREHOUSE_ID: "" });
    expect((await noWarehouse.listDescriptors("t")).find((item) => item.id === "databricks-uc")!.credentialState).toBe("Missing");
    const wrongHost = registry({ ...databricksEnv, DATABRICKS_HOST: "https://databricks.evil.example" });
    expect((await wrongHost.listDescriptors("t")).every((item) => item.credentialState === "Missing")).toBe(true);
  });

  it("shares one cached OAuth token across Databricks adapters and invokes each with it", async () => {
    let tokenRequests = 0;
    const { fetch, calls } = fakeFetch((call) => {
      if (call.url.pathname === "/oidc/v1/token") { tokenRequests += 1; return { body: { access_token: "dbx-oauth-token", expires_in: 3600 } }; }
      if (call.url.pathname.startsWith("/serving-endpoints/")) return { body: { choices: [{ message: { content: "{\"ok\":true}" } }], usage: { prompt_tokens: 3, completion_tokens: 2 } } };
      if (call.url.pathname.startsWith("/api/2.0/vector-search/")) return { body: { manifest: { columns: [{ name: "id" }, { name: "text" }, { name: "score" }] }, result: { data_array: [["d1", "t", 0.8]] } } };
      return { body: { statement_id: "st-1", status: { state: "SUCCEEDED" }, manifest: { schema: { columns: [{ name: "result" }] } }, result: { data_array: [["7"]] } } };
    });
    const dbx = registry(databricksEnv, fetch);
    expect((await dbx.listDescriptors("t")).map((item) => item.credentialState)).toEqual(["Configured", "Configured", "Configured"]);
    const served = await dbx.invoke(capability("databricks-serving:kyc-llm", "model", "paid"), { prompt: "x" }, { tenantId: "t" });
    expect(served).toMatchObject({ output: { ok: true }, provider: "databricks", inputTokens: 3, outputTokens: 2 });
    await dbx.invoke(capability("databricks-vector:main.kyc.policy_idx"), { query: "q" }, { tenantId: "t" });
    const hostile = "1); DROP TABLE main.kyc.customers; --";
    await dbx.invoke(capability("databricks-uc:main.kyc.risk_score"), { arguments: [hostile] }, { tenantId: "t" });
    expect(tokenRequests).toBe(1);
    for (const call of calls.filter((item) => item.url.pathname !== "/oidc/v1/token")) {
      expect(header(call, "authorization")).toBe("Bearer dbx-oauth-token");
      expect(call.init.redirect).toBe("error");
    }
    const statement = calls.find((call) => call.url.pathname === "/api/2.0/sql/statements")!.body as { statement: string; parameters: unknown[] };
    expect(statement.statement).toBe("SELECT `main`.`kyc`.`risk_score`(:p1) AS result");
    expect(statement.parameters).toEqual([{ name: "p1", value: hostile, type: "STRING" }]);
    await expect(dbx.assertSupported(capability("databricks-uc:main.kyc.fn;drop"), "t")).rejects.toThrow("gateway.capability_adapter_binding_unsupported");
    await expect(dbx.assertSupported(capability("databricks-vector:main.kyc.idx", "model"), "t")).rejects.toThrow("gateway.capability_adapter_kind_unsupported");
  });

  it("never surfaces credentials in errors and refuses removed auth modes", async () => {
    const local = registry({ ...databricksEnv, GATEWAY_ADAPTERS: "databricks-serving" }, fakeFetch(() => ({ status: 401, body: { error: CLIENT_SECRET } })).fetch);
    const tokenError = await local.invoke(capability("databricks-serving:kyc-llm", "model", "paid"), { prompt: "x" }, { tenantId: "t" }).catch((caught: Error) => caught);
    expect((tokenError as Error).message).toBe("adapter.databricks_token_http_401");
    expect((tokenError as Error).message).not.toContain(CLIENT_SECRET);
    const removedMode = registry({ GATEWAY_ADAPTERS: "databricks-serving", DATABRICKS_HOST: "https://dbc-1.cloud.databricks.com", DATABRICKS_AUTH: "azure_msi" });
    expect((await removedMode.listDescriptors("t"))[0]!.credentialState).toBe("Missing");
  });
});

describe("HTTP operation adapter through the registry", () => {
  it("advertises and accepts only allowlisted operations and presents the gateway's workload identity", async () => {
    const operations = JSON.stringify({ getCustomer: { method: "GET", path: "/customers/{id}" } });
    const { fetch, calls } = fakeFetch(() => ({ body: { id: "c1" } }));
    const http = registry({ GATEWAY_ADAPTERS: "http-operation", HTTP_OPERATIONS_BASE_URL: "https://api.example.test/core", HTTP_OPERATIONS_JSON: operations }, fetch);
    const [descriptor] = await http.listDescriptors("t");
    expect(descriptor).toMatchObject({ credentialState: "Configured", bindingOptions: [{ value: "getCustomer", description: "GET /customers/{id}" }] });
    await expect(http.assertSupported(capability("http-operation:deleteCustomer"), "t")).rejects.toThrow("gateway.capability_adapter_binding_unsupported");
    await http.invoke(capability("http-operation:getCustomer"), { pathParams: { id: "c 1" } }, { tenantId: "t" });
    expect(calls[0]!.url.pathname).toBe("/core/customers/c%201");
    expect(header(calls[0]!, "authorization")).toBe(`Bearer ${WORKLOAD_TOKEN}`);
  });

  it("refuses a static key without a workload identity under the production profile", async () => {
    const operations = JSON.stringify({ getCustomer: { method: "GET", path: "/customers/{id}" } });
    const keyOnly = registry({ SECURITY_PROFILE: "production", GATEWAY_ADAPTERS: "http-operation", HTTP_OPERATIONS_BASE_URL: "https://api.example.test", HTTP_OPERATIONS_JSON: operations, HTTP_OPERATIONS_AUTH: "api_key", HTTP_OPERATIONS_API_KEY: "static" });
    expect((await keyOnly.listDescriptors("t"))[0]!.credentialState).toBe("Missing");
    const keyed = fakeFetch(() => ({ body: { id: "c1" } }));
    const both = registry({ GATEWAY_ADAPTERS: "http-operation", HTTP_OPERATIONS_BASE_URL: "https://api.example.test", HTTP_OPERATIONS_JSON: operations, HTTP_OPERATIONS_API_KEY: "partner-key", HTTP_OPERATIONS_API_KEY_HEADER: "x-partner-key" }, keyed.fetch);
    await both.invoke(capability("http-operation:getCustomer"), { pathParams: { id: "1" } }, { tenantId: "t" });
    expect(header(keyed.calls[0]!, "x-partner-key")).toBe("partner-key");
    expect(header(keyed.calls[0]!, "authorization")).toBe(`Bearer ${WORKLOAD_TOKEN}`);
  });
});

describe("POST /v1/connectors", () => {
  const SERVICE_TOKEN = "edge-service-token-for-tests-0001";
  const headers = (roles: string) => ({ authorization: `Bearer ${SERVICE_TOKEN}`, "x-actor-id": "someone@example.test", "x-actor-roles": roles });
  function app(env: NodeJS.ProcessEnv, calls: Array<{ text: string; values: unknown[] }> = []) {
    const database = {
      query: async (text: string, values: unknown[] = []) => {
        calls.push({ text, values });
        if (!text.includes("connector_registry")) return { rowCount: 0, rows: [] };
        return { rowCount: 1, rows: [{ definition: JSON.parse(String(values[4])), definition_digest: values[5], status: values[6], created_at: new Date(0), updated_at: new Date(0), inserted: true }] };
      },
      end: async () => {},
    } as unknown as Database;
    return buildGateway({
      db: database,
      executionSecret: "test-execution-envelope-secret-value",
      modelProfilesPath,
      env: { ...env },
      serviceGrants: [{ token: SERVICE_TOKEN, subjectId: "control-surface-edge", roles: ["Edge.Delegate"], tenantId: "tenant_demo" }],
    });
  }
  const payload = { adapterId: "databricks-serving", binding: "kyc-llm:responses", capabilityId: "model.general.inference.v1" };

  it("registers a connector from an enabled template under the capability-registration authority", async () => {
    const calls: Array<{ text: string; values: unknown[] }> = [];
    const gateway = app({ GATEWAY_ADAPTERS: "default,databricks-serving" }, calls);
    try {
      expect((await gateway.inject({ method: "POST", url: "/v1/connectors", payload })).statusCode).toBe(401);
      expect((await gateway.inject({ method: "POST", url: "/v1/connectors", headers: headers("Harness.Reader"), payload })).statusCode).toBe(403);
      const created = await gateway.inject({ method: "POST", url: "/v1/connectors", headers: headers("Harness.Author"), payload });
      expect(created.statusCode).toBe(201);
      expect(created.json()).toMatchObject({ connector: {
        connectorId: "databricks-serving:kyc-llm:responses", adapterId: "databricks-serving", providerId: "databricks", capabilityId: "model.general.inference.v1",
        operation: "kyc-llm:responses", status: "available", source: { catalog: "ehfconcept/platform", revision: "connector-template:databricks-serving" },
      } });
      expect(calls.find((call) => call.text.includes("connector_registry"))?.values[0]).toBe("databricks-serving:kyc-llm:responses");

      const adapters = await gateway.inject({ method: "GET", url: "/v1/adapters", headers: headers("Harness.Reader") });
      const body = adapters.json() as { adapters: Array<{ id: string; cloud: string }>; modules: Array<{ id: string; cloud: string; enabled: boolean }> };
      expect(body.adapters.map((item) => item.id)).toContain("databricks-serving");
      expect(body.modules.find((item) => item.id === "databricks-serving")).toMatchObject({ cloud: "databricks", enabled: true });
      expect(body.modules.find((item) => item.id === "http-operation")).toMatchObject({ cloud: "any", enabled: false });
    } finally { await gateway.close(); }
  });

  it("rejects a disabled adapter, a binding outside the pattern, an unserved capability and a non-template adapter", async () => {
    const gateway = app({ GATEWAY_ADAPTERS: "default,databricks-serving" });
    const post = (body: unknown) => gateway.inject({ method: "POST", url: "/v1/connectors", headers: headers("Platform.Admin"), payload: body as Record<string, unknown> });
    try {
      expect((await post({ ...payload, adapterId: "http-operation", binding: "getCustomer", capabilityId: "integration.http.operation.v1" })).json()).toEqual({ error: "gateway.connector_adapter_disabled" });
      expect((await post({ ...payload, adapterId: "http-operation", binding: "getCustomer", capabilityId: "integration.http.operation.v1" })).statusCode).toBe(409);
      expect((await post({ ...payload, binding: "kyc-llm:shell" })).json()).toEqual({ error: "gateway.connector_binding_mismatch" });
      expect((await post({ ...payload, capabilityId: "knowledge.vector.search.v1" })).json()).toEqual({ error: "gateway.connector_capability_unsupported" });
      expect((await post({ ...payload, adapterId: "opensanctions", binding: "pep" })).json()).toEqual({ error: "gateway.connector_template_unknown" });
      expect((await post({ ...payload, binding: "../x" })).json()).toEqual({ error: "gateway.connector_registration_invalid" });
      expect((await post({ ...payload, status: "quarantined" })).statusCode).toBe(400);
    } finally { await gateway.close(); }
  });
});
