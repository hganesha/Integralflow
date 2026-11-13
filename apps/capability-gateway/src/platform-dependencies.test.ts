import { describe, expect, it } from "vitest";
import type { Database } from "@ehf/persistence";
import { gatewayDependencies } from "./platform-dependencies.js";

const provider = (id: string, extra: Record<string, unknown> = {}) => ({ definition: { id, kind: "openai_compatible", displayName: id, baseUrl: `https://${id}.example.test/openai/v1`, credentialRef: "MODEL_TOKEN", siteUrl: null, appName: null, status: "active", ...extra },
  definition_digest: "d", created_at: new Date(0), updated_at: new Date(0), updated_by: "test" });
const database = (rows: unknown[]) => ({ query: async () => ({ rows, rowCount: rows.length }) }) as unknown as Database;
function recording(answer: (url: URL) => number | Error) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetcher = (async (url: URL, init: { headers: Record<string, string> }) => {
    calls.push({ url: url.toString(), headers: init.headers });
    const result = answer(new URL(url));
    if (result instanceof Error) throw result;
    return new Response("{}", { status: result });
  }) as unknown as typeof fetch;
  return { calls, fetcher };
}
const byId = (components: Array<{ id: string }>) => Object.fromEntries(components.map(item => [item.id, item]));

describe("gateway dependency checks", () => {
  it("calls each configured host and each bound model endpoint, and reports what is not configured", async () => {
    const { calls, fetcher } = recording(url => url.host === "skills.internal.test" ? 200 : url.host === "foundry.example.test" ? 200 : 401);
    const env = { SECURITY_PROFILE: "production", SKILL_HOST_URL: "https://skills.internal.test", MODEL_TOKEN: "private-model-token" };
    const result = byId(await gatewayDependencies({ db: database([provider("foundry"), provider("other"), provider("off", { status: "disabled" }), provider("canned", { kind: "recorded", baseUrl: null, credentialRef: null })]), env, fetch: fetcher }, "tenant"));
    expect(result["skill-host"]).toMatchObject({ status: "Ready", group: "endpoint" });
    expect(result["evidence-pipeline"]).toMatchObject({ status: "NotConfigured", latencyMs: null });
    expect(result["kyc-wiring"]).toMatchObject({ status: "NotConfigured" });
    expect(result["model:foundry"]).toMatchObject({ status: "Ready", detail: "Reachable; the credential was accepted." });
    expect(result["model:other"]).toMatchObject({ status: "Degraded", detail: "Reachable, but the credential was refused." });
    expect(result["model:canned"]).toMatchObject({ status: "NotConfigured" });
    expect(result["model:off"]).toBeUndefined();
    expect(calls.map(call => call.url).sort()).toEqual(["https://foundry.example.test/openai/v1/models", "https://other.example.test/openai/v1/models", "https://skills.internal.test/healthz"]);
    expect(calls.find(call => call.url.includes("foundry"))!.headers.authorization).toBe("Bearer private-model-token");
    expect(calls.find(call => call.url.includes("healthz"))!.headers).toEqual({});
    expect(JSON.stringify(result)).not.toMatch(/private-model-token|example\.test|internal\.test/);
  });

  it("reports an unreachable host, a missing credential and an insecure address without calling out", async () => {
    const { calls, fetcher } = recording(() => new Error("getaddrinfo ENOTFOUND skills.internal.test"));
    const env = { SECURITY_PROFILE: "production", SKILL_HOST_URL: "https://skills.internal.test", EVIDENCE_PIPELINE_URL: "https://documents.internal.test", EVIDENCE_PIPELINE_TOKEN: "token-value-000000" };
    const result = byId(await gatewayDependencies({ db: database([provider("foundry"), provider("plain", { baseUrl: "http://plain.example.test/v1", credentialRef: null })]), env, fetch: fetcher }, "tenant"));
    expect(result["skill-host"]).toMatchObject({ status: "Unavailable", detail: "The check failed." });
    expect(result["evidence-pipeline"]).toMatchObject({ status: "Unavailable" });
    expect(result["model:foundry"]).toMatchObject({ status: "Degraded", detail: "Its credential is not available to the gateway.", latencyMs: null });
    expect(result["model:plain"]).toMatchObject({ status: "Unavailable", latencyMs: null });
    expect(calls.map(call => new URL(call.url).host).sort()).toEqual(["documents.internal.test", "skills.internal.test"]);
  });

  it("uses the deployment's own key before any provider is administered, and says when there is none", async () => {
    const { calls, fetcher } = recording(() => 200);
    const fallback = byId(await gatewayDependencies({ db: database([]), env: { OPENROUTER_API_KEY: "key" }, fetch: fetcher }, "tenant"));
    expect(fallback["model:openrouter"]).toMatchObject({ status: "Ready" });
    expect(calls[0]!.url).toBe("https://openrouter.ai/api/v1/models");
    expect(byId(await gatewayDependencies({ db: database([]), env: {}, fetch: fetcher }, "tenant"))["model:none"]).toMatchObject({ status: "NotConfigured" });
    const broken = { query: async () => { throw new Error("relation does not exist"); } } as unknown as Database;
    expect(byId(await gatewayDependencies({ db: broken, env: {}, fetch: fetcher }, "tenant"))["model:registry"]).toMatchObject({ status: "Unknown" });
  });
});
