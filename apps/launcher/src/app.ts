import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import Fastify, { LogController, type FastifyRequest, type FastifyReply } from "fastify";
import { browserOidcClient } from "@ehf/identity";
import { z } from "zod";
import { defaultDeploymentProfile, deploymentFindings, deploymentModelName, deploymentProfileSchema, type DeploymentCatalog, type DeploymentProfile } from "@ehf/contracts/deployment";
import { SetupStore, type SetupState, type StoredSession } from "./store.js";
import { allowedOrigins, boundedJson, discoverOidc, referenceValue, trustedUrl } from "./network.js";
import { createDeploymentPlan } from "@ehf/contracts/deployment-plan";
import { deploymentInProgress, planDigest, registerDeploymentJobs } from "./deployment-jobs.js";
import { webAsset } from "@ehf/web-static";
import { rateLimitRequests } from "@ehf/rate-limit";

import { registerResourceProvisioning, provisioningInProgress } from "./resource-provisioning.js";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const random = () => randomBytes(32).toString("hex");
const equal = (a: string, b: string) => a.length === b.length && a.length > 0 && timingSafeEqual(Buffer.from(a), Buffer.from(b));
class SetupError extends Error { constructor(readonly status: number, code: string) { super(code); } }
type Options = { env?: NodeJS.ProcessEnv; store?: SetupStore; catalog?: DeploymentCatalog; fetch?: typeof fetch; logger?: boolean };

export function buildLauncher(options: Options = {}) {
  const env = options.env ?? process.env;
  const origin = new URL(env.ONBOARDING_PUBLIC_ORIGIN ?? "http://localhost:4300").origin;
  if (!origin.startsWith("https:") && !["localhost", "127.0.0.1"].includes(new URL(origin).hostname)) throw new Error("setup.https_required");
  if (!/^[a-f0-9]{64}$/.test(env.ONBOARDING_BOOTSTRAP_SHA256 ?? "")) throw new Error("setup.bootstrap_hash_required");
  const target: DeploymentProfile["target"] = {
    provider: z.enum(["azure", "aws", "gcp", "kubernetes", "container"]).parse(env.DEPLOYMENT_PROVIDER ?? "container"),
    scopeId: env.DEPLOYMENT_SCOPE ?? "local", region: env.DEPLOYMENT_REGION ?? "local", recipe: env.DEPLOYMENT_RECIPE ?? "container-bootstrap-v1",
  };
  const initial = (): SetupState => {
    const profile = defaultDeploymentProfile(target);
    if (target.provider === "azure" && env.ONBOARDING_AZURE_TRACE_COMPONENT_ID && env.ONBOARDING_AZURE_TRACE_COLLECTOR_ENDPOINT) {
      profile.foundation.observability = { backend: "azure_monitor", applicationInsightsResourceId: env.ONBOARDING_AZURE_TRACE_COMPONENT_ID };
      profile.foundation.telemetryEndpoint = env.ONBOARDING_AZURE_TRACE_COLLECTOR_ENDPOINT;
      deploymentProfileSchema.parse(profile);
    }
    return { document: { revision: 0, phase: "draft", profile, updatedAt: new Date().toISOString(), tests: [] }, claimed: false, sessions: [], identityVerified: false, events: [] };
  };
  const store = options.store ?? new SetupStore(env.ONBOARDING_STATE_DIR ?? ".integralflow/setup", initial);
  const fetcher = options.fetch ?? fetch;
  const catalog = async (): Promise<DeploymentCatalog> => {
    const value: DeploymentCatalog = options.catalog ?? JSON.parse(await readFile(env.ONBOARDING_CATALOG_PATH ?? "config/onboarding-models.json", "utf8"));
    return z.object({ revision: z.string().min(1), models: z.array(z.object({ id: z.string().min(1), name: z.string(), publisher: z.string(), family: z.enum(["frontier", "open-weight"]), providers: z.record(z.string(), z.string()) })) }).parse(value);
  };
  const app = Fastify({ logger: options.logger ? { redact: ["req.headers.cookie", "req.headers.authorization", "req.body", "req.url", "res.headers.set-cookie"] } : false, logController: new LogController({ disableRequestLogging: true }), bodyLimit: 128_000, trustProxy: false });
  // Every route, including the executor's; claim and sign-in also keep their stricter limit.
  rateLimitRequests(app, { max: Number(env.RATE_LIMIT_PER_MINUTE ?? 120), windowMs: 60_000, sessionCookie: "integralflow_setup", error: "setup.retry_later" });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof SetupError) return reply.code(error.status).send({ error: error.message });
    if (error instanceof z.ZodError) return reply.code(400).send({ error: "setup.invalid_profile", issues: error.issues.map(item => ({ path: item.path.join("."), message: item.message })) });
    if (error instanceof Error && /^deployment\.[a-z_]+$/.test(error.message)) return reply.code((error as Error & { statusCode?: number }).statusCode ?? 503).send({ error: error.message });
    const status = (error as { statusCode?: number }).statusCode;
    return reply.code(status && status >= 400 && status < 500 ? status : 503).send({ error: "setup.request_failed" });
  });
  app.addHook("onSend", async (_request, reply) => {
    reply.header("x-integralflow-launcher", "true");
    reply.header("cache-control", "no-store").header("x-content-type-options", "nosniff").header("referrer-policy", "no-referrer").header("x-frame-options", "DENY");
    reply.header("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    if (origin.startsWith("https:")) reply.header("strict-transport-security", "max-age=31536000");
  });
  const cookie = (name: string, value: string, maxAge: number) => `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${origin.startsWith("https:") ? "; Secure" : ""}`;
  const cookieValue = (request: FastifyRequest, name: string) => String(request.headers.cookie ?? "").split(";").map(part => part.trim()).find(part => part.startsWith(`${name}=`))?.slice(name.length + 1) ?? "";
  const session = async (request: FastifyRequest): Promise<StoredSession> => {
    const hash = sha(cookieValue(request, "integralflow_setup"));
    const found = (await store.read()).sessions.find(item => item.expires > Date.now() && equal(item.hash, hash));
    if (!found) throw new SetupError(401, "setup.sign_in_required");
    return found;
  };
  const mutation = async (request: FastifyRequest) => {
    const held = await session(request);
    if (request.headers.origin !== origin || !equal(String(request.headers["x-csrf-token"] ?? ""), held.csrf)) throw new SetupError(403, "setup.csrf_invalid");
    return held;
  };
  const assertSession = (state: SetupState, held: StoredSession) => {
    if (!state.sessions.some(current => current.hash === held.hash && current.expires > Date.now())) throw new SetupError(401, "setup.sign_in_required");
  };
  const revision = (request: FastifyRequest, state: SetupState) => {
    if (request.headers["if-match"] !== `"${state.document.revision}"`) throw new SetupError(409, "setup.revision_conflict");
  };
  const record = (state: SetupState, action: string, subject: string) => {
    state.events.push({ at: new Date().toISOString(), action, revision: state.document.revision, subject });
    state.events = state.events.slice(-500);
  };
  const createSession = (state: SetupState, subject: string, method: StoredSession["method"]) => {
    const token = random();
    const held: StoredSession = { hash: sha(token), csrf: random(), expires: Date.now() + 12 * 60 * 60_000, subject, method };
    state.sessions = state.sessions.filter(item => item.expires > Date.now()).slice(-19);
    state.sessions.push(held);
    return { token, held };
  };
  const rateLimits = new Map<string, { count: number; until: number }>();
  const limit = (request: FastifyRequest) => {
    const now = Date.now();
    for (const [key, value] of rateLimits) if (value.until < now) rateLimits.delete(key);
    if (rateLimits.size > 1000) throw new SetupError(429, "setup.retry_later");
    const value = rateLimits.get(request.ip) ?? { count: 0, until: now + 60_000 };
    value.count += 1; rateLimits.set(request.ip, value);
    if (value.count > 10) throw new SetupError(429, "setup.retry_later");
  };

  app.get("/health/live", async () => ({ status: "live", component: "onboarding" }));
  app.get("/health/ready", async () => { await store.read(); await catalog(); if (env.ONBOARDING_WEB_ROOT) await readFile(resolve(env.ONBOARDING_WEB_ROOT, "index.html")); return { status: "ready", component: "onboarding", runtimeReady: false }; });
  app.get("/api/onboarding/status", async (request) => {
    const state = await store.read();
    let held: StoredSession | undefined;
    try { held = await session(request); } catch { /* No environment configuration is disclosed. */ }
    return { enabled: true, claimed: state.claimed, authenticated: Boolean(held), phase: state.document.phase, identityVerified: state.identityVerified, ...(held ? { csrfToken: held.csrf, expiresAt: new Date(held.expires).toISOString(), subject: held.subject } : {}) };
  });
  app.post("/api/onboarding/claim", async (request, reply) => {
    limit(request);
    if (request.headers.origin !== origin) throw new SetupError(403, "setup.origin_invalid");
    const { token } = z.object({ token: z.string().min(32).max(256) }).strict().parse(request.body);
    const created = await store.update(state => {
      if (state.claimed) throw new SetupError(409, "setup.already_claimed");
      if (!equal(sha(token), env.ONBOARDING_BOOTSTRAP_SHA256!)) throw new SetupError(401, "setup.claim_invalid");
      state.claimed = true;
      const value = createSession(state, "bootstrap-administrator", "bootstrap");
      record(state, "administrator.claimed", value.held.subject);
      return value;
    });
    return reply.header("set-cookie", cookie("integralflow_setup", created.token, 43200)).send({ csrfToken: created.held.csrf });
  });
  app.get("/api/onboarding", async request => {
    await session(request);
    const state = await store.read();
    return { ...state.document, catalog: await catalog(), events: state.events, identityVerified: state.identityVerified, bootstrapTarget: target, applicationOrigin: env.ONBOARDING_APPLICATION_ORIGIN ?? null, image: env.IMAGE_REFERENCE ?? "local development", capabilities: { bootstrap: true, configuration: true, runtimeProvisioning: Boolean(env.ONBOARDING_EXECUTOR_SHA256), scheduling: false } };
  });
  app.put("/api/onboarding", async request => {
    const held = await mutation(request);
    const profile = deploymentProfileSchema.parse(request.body);
    if (JSON.stringify(profile.target) !== JSON.stringify(target)) throw new SetupError(400, "setup.bootstrap_target_immutable");
    const errors = deploymentFindings(profile, await catalog()).filter(item => item.severity === "error" && item.message !== "Selected models require a provider endpoint and credential reference.");
    if (errors.length) throw new SetupError(400, "setup.catalog_selection_invalid");
    return store.update(state => {
      assertSession(state, held);
      revision(request, state);
      if (deploymentInProgress(state) || provisioningInProgress(state)) throw new SetupError(409, "deployment.profile_locked_during_apply");
      if (state.provisioning?.inventory && profile.environmentId !== state.document.profile.environmentId) throw new SetupError(409, "deployment.provisioned_environment_id_immutable");
      if (JSON.stringify(state.document.profile.access) !== JSON.stringify(profile.access)) {
        state.identityVerified = false;
        state.sessions = state.sessions.filter(item => item.method === "bootstrap" || item.hash === held.hash);
      }
      state.document = { revision: state.document.revision + 1, phase: "draft", profile, updatedAt: new Date().toISOString(), tests: [] };
      record(state, "profile.saved", held.subject);
      return state.document;
    });
  });
  app.post("/api/onboarding/test", async request => {
    const held = await mutation(request);
    const { kind } = z.object({ kind: z.enum(["models", "inference", "identity", "runtime", "telemetry"]) }).strict().parse(request.body);
    const state = await store.read(); revision(request, state);
    const { profile } = state.document;
    const verificationEnv = await resourceEnvironment();
    const testCatalog = await catalog();
    if (kind === "inference" || kind === "telemetry") limit(request);
    let status: "passed" | "failed" = "passed";
    let message = "";
    try {
      if (kind === "identity") {
        await discoverOidc(profile.access.issuer, verificationEnv, fetcher);
        if (!profile.access.clientId) throw new Error("identity.client_required");
        message = "OIDC discovery and PKCE endpoints verified. Complete an administrator sign-in to verify access.";
      } else if (kind === "models") {
        const url = trustedUrl(`${profile.intelligence.endpoint.replace(/\/$/, "")}/models`, verificationEnv);
        const token = await referenceValue(profile.intelligence.credentialRef, verificationEnv);
        const body = await boundedJson(await fetcher(url, { headers: { authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(15_000) }));
        const available = new Set(Array.isArray(body.data) ? body.data.map((item: { id?: unknown }) => item.id) : []);
        const curated = testCatalog;
        const selected = Object.values(profile.intelligence.models).filter(Boolean);
        if (!selected.length || selected.some(id => !available.has(curated.models.find(item => item.id === id)?.providers[profile.intelligence.provider]))) throw new Error("model.not_advertised");
        message = profile.intelligence.provider === "azure_foundry" ? "Selected base models are advertised by Foundry. Test model inference to verify the configured deployment names." : "Selected models are advertised by this provider. Inference qualification remains a runtime check.";
      } else if (kind === "inference") {
        const url = trustedUrl(`${profile.intelligence.endpoint.replace(/\/$/, "")}/chat/completions`, verificationEnv);
        const token = await referenceValue(profile.intelligence.credentialRef, verificationEnv);
        const curated = testCatalog;
        const models = [...new Set(Object.entries(profile.intelligence.models).filter(([, id]) => id).map(([tier]) => deploymentModelName(profile, curated, tier)))];
        if (!models.length || models.some(model => !model)) throw new Error("model.selection_required");
        await Promise.all(models.map(async model => {
          const body = await boundedJson(await fetcher(url, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
            body: JSON.stringify({ model, messages: [{ role: "user", content: "Reply with OK." }], max_tokens: 8, stream: false }), redirect: "error", signal: AbortSignal.timeout(15_000) }));
          if (!Array.isArray(body.choices) || typeof body.choices[0]?.message?.content !== "string" || !body.choices[0].message.content.trim() || body.error) throw new Error("model.inference_failed");
        }));
        message = `Inference qualified for ${models.length} distinct selected model(s) at this revision. Provider output is discarded; runtime bindings still require activation.`;
      } else if (kind === "telemetry") {
        const base = profile.foundation.telemetryEndpoint.replace(/\/$/, "");
        if (!base) throw new Error("telemetry.endpoint_required");
        const endpoint = trustedUrl(base.endsWith("/v1/traces") ? base : `${base}/v1/traces`, verificationEnv);
        const response = await fetcher(endpoint, { method: "POST", headers: { "content-type": "application/json" },
          body: '{"resourceSpans":[]}', redirect: "error", signal: AbortSignal.timeout(5000) });
        await response.body?.cancel();
        if (!response.ok) throw new Error("telemetry.receiver_unavailable");
        message = "The Collector accepted a reachability check. Verify export and read access after deployment.";
      } else {
        const response = await fetcher(trustedUrl(`${profile.intelligence.runtimeEndpoint.replace(/\/$/, "")}/health/ready`, verificationEnv), { redirect: "error", signal: AbortSignal.timeout(10_000) });
        const body = await boundedJson(response);
        if (body.status !== "ready") throw new Error("runtime.not_ready");
        message = "Runtime readiness endpoint responded. Invocation, callback and identity conformance remain runtime checks.";
      }
    } catch {
      status = "failed";
      message = "Verification failed. Check the endpoint, mounted credential reference and deployment egress allowlist. No provider response or credential is retained.";
    }
    return store.update(current => {
      assertSession(current, held);
      revision(request, current);
      const test = { kind, catalogRevision: testCatalog.revision, revision: current.document.revision, checkedAt: new Date().toISOString(), status, message };
      current.document.tests = [...current.document.tests.filter(item => item.kind !== kind), test];
      record(current, `verification.${kind}.${status}`, held.subject);
      return test;
    });
  });
  async function resourceEnvironment(): Promise<NodeJS.ProcessEnv> {
    const state = await store.read();
    const inventory = state.provisioning?.inventory;
    const bootstrapOrigin = env.ONBOARDING_AZURE_TRACE_COLLECTOR_ENDPOINT ? new URL(env.ONBOARDING_AZURE_TRACE_COLLECTOR_ENDPOINT).origin : undefined;
    const approvedOrigins = [env.ONBOARDING_ALLOWED_ORIGINS, bootstrapOrigin].filter(Boolean).join(",");
    if (!inventory) return { ...env, ONBOARDING_ALLOWED_ORIGINS: approvedOrigins };
    const origins = Object.values(inventory).flatMap(item => item?.endpoint ? [new URL(item.endpoint).origin] : []);
    return { ...env, ONBOARDING_ALLOWED_ORIGINS: [approvedOrigins, ...origins].filter(Boolean).join(","), ONBOARDING_SECRET_PREFIX: state.provisioning?.run?.profile.environmentId, ONBOARDING_VAULT_REFERENCES: Object.values(inventory).flatMap(item => item?.credentialRef ? [item.credentialRef] : []).join(","), ONBOARDING_SECRET_NAMES: [env.ONBOARDING_SECRET_NAMES, "DATABASE_MIGRATOR_PASSWORD,OBJECT_STORAGE_CREDENTIAL,MODEL_PROVIDER_TOKEN,DOCUMENT_INTELLIGENCE_TOKEN,OIDC_CLIENT_SECRET"].filter(Boolean).join(",") };
  }
  const deploymentVerified = (state: SetupState, curated: DeploymentCatalog) => state.deployment?.phase === "succeeded" && state.deployment.planHash === planDigest(state.document, curated, env.IMAGE_REFERENCE ?? null);
  app.get("/api/onboarding/review", async request => {
    await session(request);
    const state = await store.read();
    const curated = await catalog();
    return { revision: state.document.revision, catalogRevision: curated.revision, findings: deploymentFindings(state.document.profile, curated).filter(finding => !deploymentVerified(state, curated) || ["connections", "schedules", "intelligence.documentIntelligence"].includes(finding.path)), runtimeReady: deploymentVerified(state, curated), nextAction: "Review the resource plan, prepare the databases using the image's migrate entrypoint, then apply a qualified runtime hosting recipe." };
  });
  app.get("/api/onboarding/plan", async (request, reply) => {
    await session(request);
    const state = await store.read();
    const curated = await catalog();
    const plan = createDeploymentPlan({ document: state.document, catalog: curated, identityVerified: state.identityVerified, image: env.IMAGE_REFERENCE ?? null, deploymentVerified: deploymentVerified(state, curated) });
    if ((request.query as Record<string, unknown>).download === "true") reply.header("content-disposition", `attachment; filename="${state.document.profile.environmentId}-plan.json"`);
    return plan;
  });
  app.post("/api/onboarding/configure", async request => {
    const held = await mutation(request);
    const body = z.object({ environmentId: z.string(), catalogRevision: z.string() }).strict().parse(request.body);
    const curated = await catalog();
    return store.update(state => {
      assertSession(state, held);
      revision(request, state);
      if (body.environmentId !== state.document.profile.environmentId || body.catalogRevision !== curated.revision) throw new SetupError(409, "setup.review_changed");
      if (deploymentFindings(state.document.profile, curated).some(item => item.severity === "error")) throw new SetupError(400, "setup.profile_invalid");
      state.document.phase = "configured";
      state.document.configuredAt = new Date().toISOString();
      record(state, "configuration.prepared", held.subject);
      return { phase: "configured", runtimeReady: false, message: "Configuration prepared. Runtime deployment and connector activation are pending." };
    });
  });
  app.get("/api/onboarding/export", async (request, reply) => {
    await session(request);
    const state = await store.read();
    const curated = await catalog();
    return reply.header("content-disposition", `attachment; filename="${state.document.profile.environmentId}-deployment.json"`).send({
      apiVersion: "integralflow/deployment-bundle-v1", image: env.IMAGE_REFERENCE ?? null, catalogRevision: curated.revision,
      ...state.document, runtimeReady: deploymentVerified(state, curated), findings: deploymentFindings(state.document.profile, curated),
      resourceInventory: state.provisioning?.inventory ?? {}, resourceConfiguration: state.provisioning?.configuration ?? null,
      bootstrap: { recipe: target.recipe, scopeId: target.scopeId },
      plan: createDeploymentPlan({ document: state.document, catalog: curated, identityVerified: state.identityVerified, image: env.IMAGE_REFERENCE ?? null, deploymentVerified: deploymentVerified(state, curated) }),
    });
  });

  registerResourceProvisioning(app, { store, env, session, mutation, assertSession });
  registerDeploymentJobs(app, { store, env, catalog, session, mutation, assertSession });
  // Sign-in uses the shared PKCE client. Its configuration is the profile being edited, so
  // it is read per flow, and a flow started under an older revision is refused before the
  // code is exchanged.
  const setupLogin = browserOidcClient<{ revision: number }>(async meta => {
    const state = await store.read();
    if (meta && state.document.revision !== meta.revision) throw new SetupError(409, "setup.revision_conflict");
    const access = state.document.profile.access;
    const verificationEnv = await resourceEnvironment();
    return { issuer: access.issuer, clientId: access.clientId, clientSecret: access.clientSecretRef ? await referenceValue(access.clientSecretRef, verificationEnv) : undefined, redirectUri: `${origin}/auth/setup/callback`, allowedOrigins: allowedOrigins(verificationEnv) };
  }, fetcher);
  const loginError = (error: unknown): never => {
    if (error instanceof SetupError) throw error;
    const code = error instanceof Error ? error.message : "";
    if (code === "identity.state_invalid") throw new SetupError(403, code);
    if (code === "identity.flow_capacity") throw new SetupError(429, "setup.retry_later");
    if (code === "identity.flow_expired" || code.startsWith("identity.token_") || code === "identity.id_token_required" || (error as { code?: string })?.code?.startsWith("ERR_J")) throw new SetupError(401, code.startsWith("identity.") ? code : "identity.claims_invalid");
    throw error;
  };
  app.get("/auth/setup/login", async (request, reply) => {
    limit(request);
    const state = await store.read();
    if (!state.claimed) throw new SetupError(403, "setup.claim_required");
    const access = state.document.profile.access;
    if (!access.clientId || !access.mappings.some(item => item.role === "Platform.Admin")) throw new SetupError(400, "identity.admin_mapping_required");
    const flow = await setupLogin.start({ revision: state.document.revision }).catch(loginError);
    return reply.header("set-cookie", cookie("integralflow_oidc", flow.state, 600)).redirect(flow.url);
  });
  app.get("/auth/setup/callback", async (request, reply) => {
    const query = z.object({ code: z.string().min(1).max(4096), state: z.string().min(32).max(256) }).parse(request.query);
    const { claims: payload, meta } = await setupLogin.finish(query.code, query.state, cookieValue(request, "integralflow_oidc")).catch(loginError);
    const flow = meta!;
    if (!payload.sub || payload.sub.length > 320) throw new SetupError(401, "identity.claims_invalid");
    const access = (await store.read()).document.profile.access;
    const groups = access.rolesClaim.split(".").reduce<unknown>((value, key) => value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined, payload);
    if (!Array.isArray(groups) || !access.mappings.some(item => item.role === "Platform.Admin" && groups.includes(item.group))) throw new SetupError(403, "identity.administrator_required");
    const created = await store.update(state => {
      if (state.document.revision !== flow.revision) throw new SetupError(409, "setup.revision_conflict");
      // A changed access policy may retain the acting session for repair while
      // unverified. Retire those old grants once its new administrator proves access.
      state.sessions = state.identityVerified ? state.sessions.filter(item => item.method !== "bootstrap") : [];
      state.identityVerified = true;
      const value = createSession(state, payload.sub!, "oidc");
      record(state, "identity.owner_verified", value.held.subject);
      return value;
    });
    return reply.header("set-cookie", [cookie("integralflow_setup", created.token, 43200), cookie("integralflow_oidc", "", 0)]).redirect("/onboarding");
  });
  app.post("/auth/setup/logout", async (request, reply) => {
    const held = await mutation(request);
    await store.update(state => { state.sessions = state.sessions.filter(item => item.hash !== held.hash); });
    return reply.header("set-cookie", cookie("integralflow_setup", "", 0)).send({ ok: true });
  });

  if (env.ONBOARDING_WEB_ROOT) {
    const root = env.ONBOARDING_WEB_ROOT;
    app.get("/*", async (request, reply: FastifyReply) => {
      const asset = await webAsset(root, request.url);
      // Security and no-store headers come from the onSend hook above.
      return asset ? reply.type(asset.type).send(asset.content) : reply.code(404).send({ error: "route.not_found" });
    });
  }
  return app;
}
