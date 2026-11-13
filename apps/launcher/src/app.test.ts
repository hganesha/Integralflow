import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { buildLauncher } from "./app.js";

const origin = "https://setup.example.com";
const token = "first-administrator-claim-token-at-least-32-characters";
const catalog = { revision: "test-v1", models: [{ id: "approved-model", name: "Approved model", publisher: "Example", family: "frontier" as const, providers: { openrouter: "provider/model" } }] };
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture(fetcher?: typeof fetch, providerCatalog = catalog, allowedOrigins = "https://id.example.com,https://openrouter.ai", extraEnv: NodeJS.ProcessEnv = {}) {
  const directory = await mkdtemp(join(tmpdir(), "integralflow-setup-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const env = { ONBOARDING_STATE_DIR: directory, ONBOARDING_PUBLIC_ORIGIN: origin, ONBOARDING_BOOTSTRAP_SHA256: createHash("sha256").update(token).digest("hex"), ONBOARDING_ALLOWED_ORIGINS: allowedOrigins, ONBOARDING_SECRET_NAMES: "MODEL_TOKEN", MODEL_TOKEN: "secret-only-in-server-environment", ...extraEnv };
  const app = buildLauncher({ env, catalog: providerCatalog, ...(fetcher ? { fetch: fetcher } : {}) });
  cleanup.push(() => app.close());
  const claim = await app.inject({ method: "POST", url: "/api/onboarding/claim", headers: { origin }, payload: { token } });
  expect(claim.statusCode).toBe(200);
  const cookie = String(claim.headers["set-cookie"]).split(";")[0]!;
  const headers = { origin, cookie, "x-csrf-token": claim.json().csrfToken, "if-match": '"0"' };
  const document = (await app.inject({ url: "/api/onboarding", headers })).json();
  return { app, directory, env, headers, document };
}

describe("onboarding authority and durable state", () => {
  it("seeds the Azure observability binding and records Collector reachability by revision", async () => {
    const scope = "/subscriptions/11111111-1111-4111-8111-111111111111/resourceGroups/ehf";
    const component = `${scope}/providers/Microsoft.Insights/components/traces`;
    const collector = "https://collector.internal.example";
    const seen: string[] = [];
    const f = await fixture(async (url, init) => {
      seen.push(String(url));
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({ resourceSpans: [] });
      return new Response(null, { status: 200 });
    }, catalog, undefined, {
      DEPLOYMENT_PROVIDER: "azure",
      DEPLOYMENT_SCOPE: scope,
      DEPLOYMENT_REGION: "centralus",
      DEPLOYMENT_RECIPE: "azure-container-apps-bootstrap-v1",
      ONBOARDING_AZURE_TRACE_COMPONENT_ID: component,
      ONBOARDING_AZURE_TRACE_COLLECTOR_ENDPOINT: collector,
    });
    expect(f.document.profile.foundation).toMatchObject({
      telemetryEndpoint: collector,
      observability: { backend: "azure_monitor", applicationInsightsResourceId: component },
    });
    const verified = await f.app.inject({ method: "POST", url: "/api/onboarding/test", headers: f.headers, payload: { kind: "telemetry" } });
    expect(verified.statusCode, verified.body).toBe(200);
    expect(verified.json()).toMatchObject({ kind: "telemetry", status: "passed", revision: 0 });
    expect(seen).toEqual([`${collector}/v1/traces`]);
    expect((await f.app.inject({ url: "/api/onboarding", headers: f.headers })).json().tests).toContainEqual(verified.json());
  });

  it("persists the selected ADLS provider and exports the container protection plan", async () => {
    const f = await fixture();
    const profile = structuredClone(f.document.profile);
    profile.foundation.objectStore = { provider: "adls_gen2", endpoint: "https://testaccount.dfs.core.windows.net", bucket: "evidence", credentialRef: "env:ADLS_CREDENTIAL" };
    expect((await f.app.inject({ method: "PUT", url: "/api/onboarding", headers: f.headers, payload: profile })).statusCode).toBe(200);
    const exported = (await f.app.inject({ url: "/api/onboarding/export", headers: f.headers })).json();
    expect(exported.profile.foundation.objectStore).toEqual(profile.foundation.objectStore);
    expect(exported.plan.resources.find((resource: { id: string }) => resource.id === "objects")).toMatchObject({ service: "Azure Data Lake Storage Gen2", detail: expect.stringContaining("entire filesystem") });
    expect(exported.runtimeReady).toBe(false);
  });
  it("persists document intelligence references and exports its proposed adapter binding", async () => {
    const f = await fixture();
    const profile = structuredClone(f.document.profile);
    profile.intelligence.documentIntelligence = { endpoint: "https://documents.example.com", credentialRef: "env:DOCUMENT_TOKEN" };
    expect((await f.app.inject({ method: "PUT", url: "/api/onboarding", headers: f.headers, payload: profile })).statusCode).toBe(200);
    const exported = (await f.app.inject({ url: "/api/onboarding/export", headers: f.headers })).json();
    expect(exported.profile.intelligence.documentIntelligence).toEqual(profile.intelligence.documentIntelligence);
    expect(exported.plan.documentIntelligence).toMatchObject({ adapter: "evidence", state: "proposed", qualified: false });
    expect((await f.app.inject({ url: "/api/onboarding/review", headers: f.headers })).json().findings.some((finding: { path: string }) => finding.path === "intelligence.documentIntelligence")).toBe(true);
  });
  it("consumes the claim once, keeps it out of storage, and requires the session for profile reads", async () => {
    const f = await fixture();
    expect((await f.app.inject({ url: "/api/onboarding" })).statusCode).toBe(401);
    const reused = await f.app.inject({ method: "POST", url: "/api/onboarding/claim", headers: { origin }, payload: { token } });
    expect(reused.statusCode).toBe(409);
    const stored = await readFile(join(f.directory, "setup.json"), "utf8");
    expect(stored).not.toContain(token);
    expect(stored).not.toContain(f.headers.cookie.split("=")[1]);
    expect(f.headers.cookie).toContain("integralflow_setup=");
    const status = (await f.app.inject({ url: "/api/onboarding/status" })).json();
    expect(status).toMatchObject({ authenticated: false, claimed: true });
    expect(status).not.toHaveProperty("csrfToken");
  });

  it("rejects cross-origin and missing-CSRF writes", async () => {
    const f = await fixture();
    for (const headers of [{ ...f.headers, origin: "https://attacker.example" }, { ...f.headers, "x-csrf-token": "" }]) {
      const response = await f.app.inject({ method: "PUT", url: "/api/onboarding", headers, payload: f.document.profile });
      expect(response.statusCode).toBe(403);
    }
  });

  it("preserves revisions over restart and prevents concurrent stale overwrites", async () => {
    const f = await fixture();
    // Both writes are based on revision 0. Which one reaches the serialized store first
    // depends on I/O timing, so assert on the winner rather than on request order.
    const names = ["First", "Second"];
    const responses = await Promise.all(names.map(displayName => f.app.inject({ method: "PUT", url: "/api/onboarding", headers: f.headers, payload: { ...f.document.profile, displayName } })));
    expect(responses.map(response => response.statusCode).sort()).toEqual([200, 409]);
    const winner = names[responses.findIndex(response => response.statusCode === 200)];
    expect(responses.find(response => response.statusCode === 409)!.json()).toEqual({ error: "setup.revision_conflict" });
    const restarted = buildLauncher({ env: f.env, catalog }); cleanup.push(() => restarted.close());
    const stored = (await restarted.inject({ url: "/api/onboarding", headers: f.headers })).json();
    expect(stored.revision).toBe(1);
    expect(stored.profile.displayName).toBe(winner);
  });

  it("serializes writes from overlapping console processes sharing the same volume", async () => {
    const f = await fixture();
    const other = buildLauncher({ env: f.env, catalog }); cleanup.push(() => other.close());
    const responses = await Promise.all([f.app, other].map((app, index) => app.inject({ method: "PUT", url: "/api/onboarding", headers: f.headers, payload: { ...f.document.profile, displayName: `Writer ${index}` } })));
    expect(responses.map(response => response.statusCode).sort()).toEqual([200, 409]);
    expect((await f.app.inject({ url: "/api/onboarding", headers: f.headers })).json().revision).toBe(1);
  });

  it("rejects arbitrary model IDs, credentials in endpoints, plaintext secrets, enabled schedules and target changes", async () => {
    const f = await fixture(); const profile = f.document.profile;
    const bodies = [
      { ...profile, intelligence: { ...profile.intelligence, models: { ...profile.intelligence.models, low: "invented-model" } } },
      { ...profile, intelligence: { ...profile.intelligence, endpoint: "https://user:password@openrouter.ai" } },
      { ...profile, access: { ...profile.access, clientSecret: "do-not-save-this" } },
      { ...profile, target: { ...profile.target, scopeId: "another-account" } },
      { ...profile, schedules: [{ id: "schedule", connectionId: "missing", intervalMinutes: 30, timezone: "UTC", overlap: "skip", enabled: true }] },
    ];
    for (const payload of bodies) expect((await f.app.inject({ method: "PUT", url: "/api/onboarding", headers: f.headers, payload })).statusCode).toBe(400);
  });

  it("exports references only and never claims an undeployed runtime is ready", async () => {
    const f = await fixture();
    const exported = await f.app.inject({ url: "/api/onboarding/export", headers: f.headers });
    expect(exported.json()).toMatchObject({ apiVersion: "integralflow/deployment-bundle-v1", runtimeReady: false, revision: 0 });
    expect(exported.body).not.toContain(f.env.MODEL_TOKEN);
    const configured = await f.app.inject({ method: "POST", url: "/api/onboarding/configure", headers: f.headers, payload: { environmentId: "integralflow", catalogRevision: "test-v1" } });
    expect(configured.json()).toMatchObject({ phase: "configured", runtimeReady: false });
    expect((await f.app.inject({ url: "/health/ready" })).json()).toMatchObject({ status: "ready", component: "onboarding", runtimeReady: false });
  });
});

describe("real endpoint verification", () => {
  it("discovers Foundry base models, qualifies distinct deployment aliases and exports those exact bindings", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const foundryCatalog = { ...catalog, models: catalog.models.map(model => ({ ...model, providers: { ...model.providers, azure_foundry: "gpt-4.1-mini" } })) };
    const f = await fixture(async (url, init) => {
      calls.push({ url: String(url), init });
      return String(url).endsWith("/models") ? Response.json({ data: [{ id: "gpt-4.1-mini" }] }) : Response.json({ choices: [{ message: { content: "private-provider-response" } }] });
    }, foundryCatalog, "https://test.services.ai.azure.com");
    const profile = structuredClone(f.document.profile);
    profile.intelligence = { ...profile.intelligence, provider: "azure_foundry", endpoint: "https://test.services.ai.azure.com/openai/v1/", credentialRef: "env:MODEL_TOKEN", models: { low: "approved-model", med: "", high: "approved-model", xhigh: "" }, deployments: { low: "ehf-low", high: "ehf-high" } };
    expect((await f.app.inject({ method: "PUT", url: "/api/onboarding", headers: f.headers, payload: profile })).statusCode).toBe(200);
    const headers = { ...f.headers, "if-match": '"1"' };
    expect((await f.app.inject({ method: "POST", url: "/api/onboarding/test", headers, payload: { kind: "models" } })).json()).toMatchObject({ status: "passed", message: expect.stringContaining("base models") });
    expect((await f.app.inject({ method: "POST", url: "/api/onboarding/test", headers, payload: { kind: "inference" } })).json()).toMatchObject({ status: "passed" });
    expect(calls.map(call => call.url)).toEqual(["https://test.services.ai.azure.com/openai/v1/models", "https://test.services.ai.azure.com/openai/v1/chat/completions", "https://test.services.ai.azure.com/openai/v1/chat/completions"]);
    expect(calls.slice(1).map(call => JSON.parse(String(call.init?.body)).model).sort()).toEqual(["ehf-high", "ehf-low"]);
    for (const call of calls) expect(call.init).toMatchObject({ headers: { authorization: `Bearer ${f.env.MODEL_TOKEN}` }, redirect: "error" });
    const exported = (await f.app.inject({ url: "/api/onboarding/export", headers })).json();
    expect(exported.plan.modelBindings.map((binding: { model: string }) => binding.model).sort()).toEqual(["ehf-high", "ehf-low"]);
    expect(exported.profile.intelligence.deployments).toEqual({ low: "ehf-low", high: "ehf-high" });
    const stored = await readFile(join(f.directory, "setup.json"), "utf8");
    expect(stored).not.toContain(f.env.MODEL_TOKEN);
    expect(stored).not.toContain("private-provider-response");
  });
  it("qualifies each distinct curated model once without storing provider output or credentials", async () => {
    const calls: Array<{ url: string; body: any }> = [];
    const f = await fixture(async (url, init) => { calls.push({ url: String(url), body: JSON.parse(String(init?.body)) }); return Response.json({ choices: [{ message: { content: "provider-output-must-not-be-stored" } }] }); });
    const profile = structuredClone(f.document.profile);
    profile.intelligence.credentialRef = "env:MODEL_TOKEN";
    profile.intelligence.models.low = "approved-model"; profile.intelligence.models.high = "approved-model";
    await f.app.inject({ method: "PUT", url: "/api/onboarding", headers: f.headers, payload: profile });
    const response = await f.app.inject({ method: "POST", url: "/api/onboarding/test", headers: { ...f.headers, "if-match": '"1"' }, payload: { kind: "inference" } });
    expect(response.json()).toMatchObject({ status: "passed", revision: 1, catalogRevision: catalog.revision });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: "https://openrouter.ai/api/v1/chat/completions", body: { model: "provider/model", max_tokens: 8, stream: false } });
    const stored = await readFile(join(f.directory, "setup.json"), "utf8");
    expect(stored).not.toContain("provider-output-must-not-be-stored"); expect(stored).not.toContain(f.env.MODEL_TOKEN);
    const plan = await f.app.inject({ url: "/api/onboarding/plan", headers: f.headers });
    expect(plan.json().gates.find((gate: any) => gate.id === "inference").passed).toBe(true);
    expect((await f.app.inject({ url: "/api/onboarding/plan" })).statusCode).toBe(401);
  });
  it("fails inference qualification when discovery-style responses contain no completion", async () => {
    const f = await fixture(async () => Response.json({ data: [{ id: "provider/model" }] }));
    const profile = structuredClone(f.document.profile);
    profile.intelligence.credentialRef = "env:MODEL_TOKEN"; profile.intelligence.models.low = "approved-model";
    await f.app.inject({ method: "PUT", url: "/api/onboarding", headers: f.headers, payload: profile });
    const result = await f.app.inject({ method: "POST", url: "/api/onboarding/test", headers: { ...f.headers, "if-match": '"1"' }, payload: { kind: "inference" } });
    expect(result.json().status).toBe("failed");
  });
  it("checks advertised curated model IDs with a server-resolved credential", async () => {
    let authorization = "";
    const f = await fixture(async (_url, init) => { authorization = (init?.headers as Record<string, string>).authorization ?? ""; return Response.json({ data: [{ id: "provider/model" }] }); });
    const profile = structuredClone(f.document.profile);
    profile.intelligence.credentialRef = "env:MODEL_TOKEN"; profile.intelligence.models.low = "approved-model";
    expect((await f.app.inject({ method: "PUT", url: "/api/onboarding", headers: f.headers, payload: profile })).statusCode).toBe(200);
    const result = await f.app.inject({ method: "POST", url: "/api/onboarding/test", headers: { ...f.headers, "if-match": '"1"' }, payload: { kind: "models" } });
    expect(result.json()).toMatchObject({ status: "passed", revision: 1 });
    expect(authorization).toBe(`Bearer ${f.env.MODEL_TOKEN}`);
    expect(await readFile(join(f.directory, "setup.json"), "utf8")).not.toContain(f.env.MODEL_TOKEN);
  });

  it("never fetches an endpoint outside the deployment-controlled allowlist", async () => {
    let calls = 0;
    const f = await fixture(async () => { calls++; return Response.json({ status: "ready" }); });
    const profile = { ...f.document.profile, intelligence: { ...f.document.profile.intelligence, runtimeEndpoint: "https://169.254.169.254/metadata" } };
    await f.app.inject({ method: "PUT", url: "/api/onboarding", headers: f.headers, payload: profile });
    const result = await f.app.inject({ method: "POST", url: "/api/onboarding/test", headers: { ...f.headers, "if-match": '"1"' }, payload: { kind: "runtime" } });
    expect(result.json().status).toBe("failed"); expect(calls).toBe(0);
  });

  it("does not attach verification results to a changed revision", async () => {
    let entered!: () => void; let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const f = await fixture(async () => { entered(); await gate; return Response.json({ status: "ready" }); });
    const profile = { ...f.document.profile, intelligence: { ...f.document.profile.intelligence, runtimeEndpoint: "https://openrouter.ai/runtime" } };
    await f.app.inject({ method: "PUT", url: "/api/onboarding", headers: f.headers, payload: profile });
    const testing = f.app.inject({ method: "POST", url: "/api/onboarding/test", headers: { ...f.headers, "if-match": '"1"' }, payload: { kind: "runtime" } }).then(value => value);
    await started;
    await f.app.inject({ method: "PUT", url: "/api/onboarding", headers: { ...f.headers, "if-match": '"1"' }, payload: { ...profile, displayName: "Changed" } });
    release(); expect((await testing).statusCode).toBe(409);
    expect((await f.app.inject({ url: "/api/onboarding", headers: f.headers })).json().tests).toEqual([]);
  });
});

describe("OIDC owner handoff", () => {
  it("validates state, nonce, signature and mapped group before retiring bootstrap", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const jwk = { ...await exportJWK(publicKey), kid: "test-key", alg: "RS256" };
    let nonce = "";
    let groups = ["environment-admins"];
    const fetcher: typeof fetch = async url => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith("openid-configuration")) return Response.json({ issuer: "https://id.example.com", authorization_endpoint: "https://id.example.com/authorize", token_endpoint: "https://id.example.com/token", jwks_uri: "https://id.example.com/jwks", code_challenge_methods_supported: ["S256"] });
      if (path === "/jwks") return Response.json({ keys: [jwk] });
      if (path === "/token") return Response.json({ id_token: await new SignJWT({ nonce, groups }).setProtectedHeader({ alg: "RS256", kid: "test-key" }).setIssuer("https://id.example.com").setAudience("setup-client").setSubject("owner").setIssuedAt().setExpirationTime("10m").sign(privateKey) });
      throw new Error("unexpected_url");
    };
    const f = await fixture(fetcher);
    const profile = { ...f.document.profile, access: { ...f.document.profile.access, issuer: "https://id.example.com", clientId: "setup-client", mappings: [{ group: "environment-admins", role: "Platform.Admin" }] } };
    await f.app.inject({ method: "PUT", url: "/api/onboarding", headers: f.headers, payload: profile });
    const begin = await f.app.inject({ url: "/auth/setup/login" });
    expect(begin.statusCode).toBe(302);
    const authorize = new URL(String(begin.headers.location)); nonce = authorize.searchParams.get("nonce")!;
    const flowCookie = String(begin.headers["set-cookie"]).split(";")[0]!;
    const callback = `/auth/setup/callback?code=authorization-code&state=${authorize.searchParams.get("state")}`;
    expect((await f.app.inject({ url: callback, headers: { cookie: "integralflow_oidc=wrong" } })).statusCode).toBe(403);
    const verified = await f.app.inject({ url: callback, headers: { cookie: flowCookie } });
    expect(verified.statusCode).toBe(302);
    expect((await f.app.inject({ url: "/api/onboarding", headers: f.headers })).statusCode).toBe(401);
    const ownerCookie = String((verified.headers["set-cookie"] as string[])[0]).split(";")[0]!;
    expect((await f.app.inject({ url: "/api/onboarding/status", headers: { cookie: ownerCookie } })).json()).toMatchObject({ authenticated: true, identityVerified: true, subject: "owner" });
    groups = ["unrelated-group"];
    const deniedBegin = await f.app.inject({ url: "/auth/setup/login" });
    const deniedUrl = new URL(String(deniedBegin.headers.location)); nonce = deniedUrl.searchParams.get("nonce")!;
    const denied = await f.app.inject({ url: `/auth/setup/callback?code=code&state=${deniedUrl.searchParams.get("state")}`, headers: { cookie: String(deniedBegin.headers["set-cookie"]).split(";")[0]! } });
    expect(denied.statusCode).toBe(403);
    expect((await f.app.inject({ url: callback, headers: { cookie: flowCookie } })).statusCode).toBe(401);
    const ownerStatus = (await f.app.inject({ url: "/api/onboarding/status", headers: { cookie: ownerCookie } })).json();
    const changed = await f.app.inject({ method: "PUT", url: "/api/onboarding", headers: { cookie: ownerCookie, origin, "x-csrf-token": ownerStatus.csrfToken, "if-match": '"1"' }, payload: { ...profile, access: { ...profile.access, mappings: [{ group: "replacement-admins", role: "Platform.Admin" }] } } });
    expect(changed.statusCode).toBe(200);
    expect((await f.app.inject({ url: "/api/onboarding/status", headers: { cookie: ownerCookie } })).json()).toMatchObject({ authenticated: true, identityVerified: false });
    groups = ["replacement-admins"];
    const replacementBegin = await f.app.inject({ url: "/auth/setup/login" });
    const replacementUrl = new URL(String(replacementBegin.headers.location)); nonce = replacementUrl.searchParams.get("nonce")!;
    const replacement = await f.app.inject({ url: `/auth/setup/callback?code=new-owner&state=${replacementUrl.searchParams.get("state")}`, headers: { cookie: String(replacementBegin.headers["set-cookie"]).split(";")[0]! } });
    expect(replacement.statusCode).toBe(302);
    expect((await f.app.inject({ url: "/api/onboarding", headers: { cookie: ownerCookie } })).statusCode).toBe(401);
    const replacementCookie = String((replacement.headers["set-cookie"] as string[])[0]).split(";")[0]!;
    expect((await f.app.inject({ url: "/api/onboarding/status", headers: { cookie: replacementCookie } })).json()).toMatchObject({ authenticated: true, identityVerified: true });
  });
});
