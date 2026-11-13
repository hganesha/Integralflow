import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { RESOURCE_KINDS, RESOURCE_FAILURES, bindResourceOutput, resourceConfigurationSchema, type ResourceConfiguration, type ResourceRunView } from "@ehf/contracts/resource-provisioning";
import { azureDocumentAccountId, applicationInsightsResourceId, deploymentProfileSchema } from "@ehf/contracts/deployment";
import { deploymentInProgress } from "./deployment-jobs.js";
import type { SetupStore, SetupState, StoredSession } from "./store.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export type ResourceRun = ResourceRunView & { revision: number; configuration: ResourceConfiguration; profile: SetupState["document"]["profile"]; image: string; scopeId: string; leaseHash?: string; leaseUntil?: number };
export const provisioningInProgress = (state: SetupState) => ["queued", "running"].includes(state.provisioning?.run?.phase ?? "");
function fail(statusCode: number, code: string): never { throw Object.assign(new Error(code), { statusCode }); }
const publicRun = (run?: ResourceRun) => run ? { id: run.id, phase: run.phase, createdAt: run.createdAt, updatedAt: run.updatedAt, resources: run.resources, leaseExpired: run.phase === "running" && (run.leaseUntil ?? 0) < Date.now() } : null;
export function registerResourceProvisioning(app: FastifyInstance, options: {
  store: SetupStore; env: NodeJS.ProcessEnv;
  session: (request: FastifyRequest) => Promise<StoredSession>;
  mutation: (request: FastifyRequest) => Promise<StoredSession>;
  assertSession: (state: SetupState, session: StoredSession) => void;
}) {
  const { store, env } = options;
  const enabled = env.DEPLOYMENT_PROVIDER === "azure" && Boolean(env.ONBOARDING_EXECUTOR_SHA256);
  const digest = (state: SetupState) => hash(JSON.stringify({ revision: state.document.revision, profile: state.document.profile, configuration: state.provisioning?.configuration, image: env.IMAGE_REFERENCE, scope: env.DEPLOYMENT_SCOPE }));
  const executor = (request: FastifyRequest) => {
    const authorization = String(request.headers.authorization ?? "");
    const expected = env.ONBOARDING_EXECUTOR_SHA256 ?? "";
    if (!/^Bearer [a-f0-9]{64}$/.test(authorization) || !/^[a-f0-9]{64}$/.test(expected) || !timingSafeEqual(Buffer.from(hash(authorization.slice(7))), Buffer.from(expected))) fail(401, "deployment.executor_unauthorized");
  };
  const check = (request: FastifyRequest, state: SetupState, held: StoredSession) => {
    options.assertSession(state, held);
    if (request.headers["if-match"] !== `"${state.document.revision}"`) fail(409, "deployment.review_changed");
    if (deploymentInProgress(state) || provisioningInProgress(state)) fail(409, "deployment.already_in_progress");
  };
  app.get("/api/onboarding/resources", async request => {
    await options.session(request);
    const state = await store.read();
    return { executorSeenAt: state.executorSeenAt ? new Date(state.executorSeenAt).toISOString() : null, inventory: state.provisioning?.inventory ?? {}, enabled, executor: env.ONBOARDING_CLOUD_EXECUTOR === "true" ? "cloud" : "operator", configuration: state.provisioning?.configuration ?? null, run: publicRun(state.provisioning?.run), revision: state.document.revision, planHash: digest(state), vaultUri: env.ONBOARDING_VAULT_URI ?? null, tenantId: env.AZURE_TENANT_ID ?? null };
  });
  app.put("/api/onboarding/resources", async request => {
    const held = await options.mutation(request);
    const configuration = resourceConfigurationSchema.parse(request.body);
    return store.update(state => {
      check(request, state, held);
      if (!enabled) fail(503, "deployment.executor_not_configured");
      if (env.AZURE_TENANT_ID && configuration.tenantId && configuration.tenantId !== env.AZURE_TENANT_ID) fail(400, "deployment.tenant_scope_mismatch");
      for (const [kind, item] of Object.entries(configuration.resources)) {
        if (item.resourceId && kind !== "oidc" && !item.resourceId.toLowerCase().startsWith(`${env.DEPLOYMENT_SCOPE}/providers/`.toLowerCase())) fail(400, "deployment.resource_scope_mismatch");
        if (kind === "oidc" && item.resourceId && !z.string().uuid().safeParse(item.resourceId).success) fail(400, "deployment.oidc_client_id_invalid");
      }
      state.provisioning = { ...state.provisioning, configuration };
      // The resource review and application profile share a single optimistic revision.
      state.document.revision++; state.document.tests = []; state.document.phase = "draft";
      return { revision: state.document.revision, planHash: digest(state) };
    });
  });
  app.post("/api/onboarding/resources", async (request, reply) => {
    const held = await options.mutation(request);
    const body = z.object({ environmentId: z.string(), planHash: z.string() }).strict().parse(request.body);
    const result = await store.update(state => {
      check(request, state, held);
      if (!enabled) fail(503, "deployment.executor_not_configured");
      if (body.environmentId !== state.document.profile.environmentId || body.planHash !== digest(state)) fail(409, "deployment.review_changed");
      const configuration = state.provisioning?.configuration;
      if (!configuration) fail(400, "deployment.resource_configuration_required");
      if (!z.string().uuid().safeParse(configuration.tenantId).success || (configuration.resources.oidc.mode === "create" && !z.string().uuid().safeParse(configuration.administratorObjectId).success)) fail(400, "deployment.tenant_and_administrator_required");
      if (configuration.resources.evidence.mode === "create" && !configuration.acknowledgeRetentionLock) fail(400, "deployment.retention_lock_approval_required");
      if (configuration.resources.postgres.mode === "create" && !configuration.allowAzureDatabaseAccess) fail(400, "deployment.database_network_approval_required");
      if (configuration.resources.foundry.mode === "create" && (state.document.profile.intelligence.provider !== "azure_foundry" || Object.values(state.document.profile.intelligence.models).some(model => !model))) fail(400, "deployment.foundry_models_required");
      const now = new Date().toISOString();
      const run: ResourceRun = { id: randomUUID(), phase: "queued", revision: state.document.revision, configuration: structuredClone(configuration), profile: structuredClone(state.document.profile), image: env.IMAGE_REFERENCE ?? "", scopeId: env.DEPLOYMENT_SCOPE ?? "", createdAt: now, updatedAt: now, resources: RESOURCE_KINDS.map(kind => ({ kind, status: "queued", message: "Waiting for executor", updatedAt: now })) };
      state.provisioning!.run = run;
      state.events.push({ at: now, action: "resources.requested", revision: state.document.revision, subject: held.subject });
      return publicRun(run);
    });
    return reply.code(202).send(result);
  });
  app.post("/api/onboarding/resources/recover", async request => {
    const held = await options.mutation(request);
    const body = z.object({ jobId: z.string().uuid(), acknowledgeExecutorStopped: z.literal(true) }).strict().parse(request.body);
    return store.update(state => {
      options.assertSession(state, held);
      const run = state.provisioning?.run;
      if (!run || run.id !== body.jobId || run.phase !== "running" || (run.leaseUntil ?? 0) > Date.now()) fail(409, "deployment.executor_lease_active");
      run.phase = "failed"; delete run.leaseHash; run.updatedAt = new Date().toISOString();
      return { ok: true };
    });
  });
  app.post("/api/provisioning/lease", async request => {
    executor(request);
    const expected = z.object({ scopeId: z.string(), image: z.string() }).strict().parse(request.body);
    if (expected.scopeId.toLowerCase() !== env.DEPLOYMENT_SCOPE?.toLowerCase() || expected.image !== env.IMAGE_REFERENCE) fail(409, "deployment.executor_bootstrap_changed");
    if ((await store.read()).provisioning?.run?.phase !== "queued") return { job: null };
    return store.update(state => {
      const run = state.provisioning?.run;
      if (run?.phase !== "queued") return { job: null };
      const leaseToken = randomBytes(32).toString("hex");
      state.executorSeenAt = Date.now();
      run.phase = "running"; run.leaseHash = hash(leaseToken); run.leaseUntil = Date.now() + 120000;
      return { job: { ...run, leaseHash: undefined }, leaseToken };
    });
  });
  app.post("/api/provisioning/context", async request => {
    executor(request);
    const expected = z.object({ scopeId: z.string(), image: z.string() }).strict().parse(request.body);
    if (expected.scopeId.toLowerCase() !== env.DEPLOYMENT_SCOPE?.toLowerCase() || expected.image !== env.IMAGE_REFERENCE) fail(409, "deployment.executor_bootstrap_changed");
    let state = await store.read();
    if (Date.now() - (state.executorSeenAt ?? 0) > 30000) { await store.update(current => { current.executorSeenAt = Date.now(); }); state = await store.read(); }
    return { profile: state.deployment?.phase === "queued" ? state.deployment.document.profile : state.document.profile, configuration: state.provisioning?.configuration ?? null, deploymentQueued: state.deployment?.phase === "queued" };
  });
  const output = z.object({ documentAccountId: azureDocumentAccountId.optional(), resourceId: z.string().max(1000).optional(), endpoint: z.string().url().max(2048).optional(), hostname: z.string().regex(/^[a-z0-9.-]+$/).optional(), clientId: z.string().uuid().optional(), credentialRef: z.enum(["env:DATABASE_MIGRATOR_PASSWORD", "env:OBJECT_STORAGE_CREDENTIAL", "env:MODEL_PROVIDER_TOKEN", "env:DOCUMENT_INTELLIGENCE_TOKEN", "env:OIDC_CLIENT_SECRET"]).optional(), container: z.string().regex(/^[a-z0-9-]+$/).optional(), vaultUri: z.string().url().optional(), applicationInsightsResourceId: applicationInsightsResourceId.optional() }).strict();
  app.post("/api/provisioning/report", async request => {
    executor(request);
    const body = z.object({ id: z.string().uuid(), leaseToken: z.string(), phase: z.enum(["running", "succeeded", "failed"]), resource: z.object({ kind: z.enum(RESOURCE_KINDS), status: z.enum(["running", "passed", "failed", "waiting"]), message: z.enum(["Creating or reconciling resource", "Resource verified", "Permission required; follow the manual instructions or grant the executor access", "Resource operation failed; existing resources retained", "Waiting for a required resource"]), code: z.enum(Object.keys(RESOURCE_FAILURES) as [keyof typeof RESOURCE_FAILURES, ...(keyof typeof RESOURCE_FAILURES)[]]).optional(), output: output.optional() }).strict().optional() }).strict().parse(request.body);
    return store.update(state => {
      const run = state.provisioning?.run;
      if (!run || run.id !== body.id || run.phase !== "running" || hash(body.leaseToken) !== run.leaseHash) fail(409, "deployment.lease_invalid");
      state.executorSeenAt = Date.now();
      const now = new Date().toISOString();
      if (body.resource) {
        const result = body.resource;
        for (const value of [result.output?.endpoint, result.output?.vaultUri].filter(Boolean) as string[]) { const url = new URL(value); if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) fail(400, "deployment.resource_output_invalid"); }
        for (const id of [result.output?.resourceId, result.output?.documentAccountId, result.output?.applicationInsightsResourceId]) {
          if (id && !id.toLowerCase().startsWith(`${run.scopeId}/providers/`.toLowerCase())) fail(400, "deployment.resource_scope_mismatch");
        }
        if (result.status === "passed" && result.output) {
          const inventory = state.provisioning!.inventory ??= {};
          const previous = inventory[result.kind];
          const sameResource = (previous?.resourceId && previous.resourceId === result.output.resourceId) || (previous?.clientId && previous.clientId === result.output.clientId);
          inventory[result.kind] = { ...(sameResource ? previous : {}), ...result.output };
        }
        run.resources = run.resources.map(item => item.kind === result.kind ? { ...result, updatedAt: now } : item);
      }
      if (body.phase === "succeeded" && run.resources.some(item => item.status !== "passed")) fail(400, "deployment.verification_incomplete");
      run.updatedAt = now; run.leaseUntil = Date.now() + 120000; run.phase = body.phase;
      if (body.phase !== "running") {
        const profile = structuredClone(state.document.profile);
        for (const item of run.resources) {
          if (item.status === "passed" && item.output && (item.kind === "telemetry" || item.output.documentAccountId || run.configuration.resources[item.kind].mode === "create")) bindResourceOutput(profile, item.kind, item.output);
        }
        deploymentProfileSchema.parse(profile);
        if (JSON.stringify(profile.access) !== JSON.stringify(state.document.profile.access)) state.identityVerified = false;
        state.document = { revision: state.document.revision + 1, profile, phase: "draft", tests: [], updatedAt: now };
        delete run.leaseHash;
        state.events.push({ at: now, action: `resources.${body.phase}`, revision: state.document.revision, subject: "scoped-executor" });
      }
      return { ok: true };
    });
  });
}
