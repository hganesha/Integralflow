import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { DeploymentCatalog, SetupDocument } from "@ehf/contracts/deployment";
import { createDeploymentPlan } from "@ehf/contracts/deployment-plan";
import type { SetupState, SetupStore, StoredSession } from "./store.js";

import { provisioningInProgress } from "./resource-provisioning.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
/** The executor reports these in order; a deployment succeeds only when every one passed. */
// "migrate" also provisions service logins and publishes the curated model profiles: the
// migration job applies that configuration in the same image, so it is one step.
export const DEPLOYMENT_STEPS = ["validate", "migrate", "deploy", "verify"] as const;
export type DeploymentJob = {
  id: string; revision: number; planHash: string; phase: "queued" | "running" | "succeeded" | "failed";
  requestedBy: string; createdAt: string; updatedAt: string;
  document: SetupDocument; catalog: DeploymentCatalog; image: string;
  leaseHash?: string; leaseUntil?: number;
  steps: Array<{ name: string; status: "running" | "passed" | "failed" }>;
  message?: string; applicationUrl?: string; failureCode?: string; resourceId?: string;
};
export function planDigest(document: SetupDocument, catalog: DeploymentCatalog, image: string | null) {
  return hash(JSON.stringify({ revision: document.revision, profile: document.profile, catalog, image }));
}
const view = (job: DeploymentJob | undefined) => job ? { id: job.id, revision: job.revision, phase: job.phase, leaseExpired: job.phase === "running" && (job.leaseUntil ?? 0) < Date.now(), createdAt: job.createdAt, updatedAt: job.updatedAt, steps: job.steps, message: job.message, applicationUrl: job.applicationUrl, failureCode: job.failureCode, resourceId: job.resourceId } : null;
function fail(statusCode: number, code: string): never { throw Object.assign(new Error(code), { statusCode }); }
export function deploymentInProgress(state: SetupState) { return state.deployment?.phase === "queued" || state.deployment?.phase === "running"; }

export function registerDeploymentJobs(app: FastifyInstance, options: {
  store: SetupStore; env: NodeJS.ProcessEnv; catalog: () => Promise<DeploymentCatalog>;
  session: (request: FastifyRequest) => Promise<StoredSession>;
  mutation: (request: FastifyRequest) => Promise<StoredSession>;
  assertSession: (state: SetupState, session: StoredSession) => void;
}) {
  const { store, env, catalog } = options;
  const image = env.IMAGE_REFERENCE ?? null;
  const executor = (request: FastifyRequest) => {
    const authorization = String(request.headers.authorization ?? "");
    if (!/^Bearer [A-Za-z0-9_-]{32,256}$/.test(authorization)) fail(401, "deployment.executor_unauthorized");
    const supplied = hash(authorization.slice(7));
    const expected = env.ONBOARDING_EXECUTOR_SHA256 ?? "";
    if (!/^[a-f0-9]{64}$/.test(expected) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) fail(401, "deployment.executor_unauthorized");
  };
  app.get("/api/onboarding/deployment", async request => {
    await options.session(request);
    const state = await store.read();
    const digest = planDigest(state.document, await catalog(), image);
    return { enabled: Boolean(env.ONBOARDING_EXECUTOR_SHA256), planHash: digest, job: view(state.deployment), runtimeReady: state.deployment?.phase === "succeeded" && state.deployment.planHash === digest };
  });
  app.post("/api/onboarding/deployment", async (request, reply) => {
    const held = await options.mutation(request);
    const body = z.object({ environmentId: z.string(), planHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(request.body);
    const curated = await catalog();
    const job = await store.update(state => {
      options.assertSession(state, held);
      if (held.method !== "oidc" || !state.identityVerified) fail(403, "deployment.verified_administrator_required");
      if (!env.ONBOARDING_EXECUTOR_SHA256) fail(503, "deployment.executor_not_configured");
      if (env.ONBOARDING_CLOUD_EXECUTOR === "true" && !state.provisioning?.configuration) fail(400, "deployment.resource_configuration_required");
      if (deploymentInProgress(state) || provisioningInProgress(state)) fail(409, "deployment.already_in_progress");
      if (request.headers["if-match"] !== `"${state.document.revision}"` || body.environmentId !== state.document.profile.environmentId || body.planHash !== planDigest(state.document, curated, image)) fail(409, "deployment.review_changed");
      const plan = createDeploymentPlan({ document: state.document, catalog: curated, image, identityVerified: true });
      if (plan.gates.some(gate => !["database", "runtime"].includes(gate.id) && !gate.passed)) fail(400, "deployment.launch_requirements_unmet");
      if (!state.document.profile.foundation.database.host || !state.document.profile.foundation.database.credentialRef) fail(400, "deployment.database_configuration_required");
      const now = new Date().toISOString();
      state.deployment = { id: randomUUID(), revision: state.document.revision, planHash: body.planHash, phase: "queued", requestedBy: held.subject, createdAt: now, updatedAt: now, document: structuredClone(state.document), catalog: curated, image: image!, steps: [] };
      state.events.push({ at: now, action: "deployment.requested", revision: state.document.revision, subject: held.subject });
      return view(state.deployment);
    });
    return reply.code(202).send(job);
  });
  // The operator executor has provisioning authority; it never receives browser cookies
  // or resolved secrets. Its private token is created by bootstrap and stored locally.
  app.post("/api/deployment/lease", async request => {
    executor(request);
    const expected = z.object({ image: z.string().optional(), scopeId: z.string().optional() }).strict().parse(request.body ?? {});
    if ((expected.image && expected.image !== image) || (expected.scopeId && expected.scopeId.toLowerCase() !== (env.DEPLOYMENT_SCOPE ?? "local").toLowerCase())) fail(409, "deployment.executor_bootstrap_changed");
    const pending = await store.read();
    if (pending.deployment?.phase !== "queued") return { job: null };
    return store.update(state => {
      const job = state.deployment;
      if (!job || job.phase !== "queued") return { job: null };
      const leaseToken = randomBytes(32).toString("hex");
      job.phase = "running"; job.leaseHash = hash(leaseToken); job.leaseUntil = Date.now() + 120_000; job.updatedAt = new Date().toISOString();
      return { job: { ...job, leaseHash: undefined }, leaseToken };
    });
  });
  app.post("/api/deployment/report", async request => {
    executor(request);
    const body = z.object({ id: z.string().uuid(), leaseToken: z.string().regex(/^[a-f0-9]{64}$/), phase: z.enum(["running", "succeeded", "failed"]), steps: z.array(z.object({ name: z.enum(DEPLOYMENT_STEPS), status: z.enum(["running", "passed", "failed"]) }).strict()).max(DEPLOYMENT_STEPS.length), failureCode: z.string().regex(/^(deployment|database|migration)\.[a-z_]{1,100}$/).optional(), resourceId: z.string().max(1000).optional(), applicationUrl: z.string().url().optional() }).strict().parse(request.body);
    return store.update(state => {
      const job = state.deployment;
      if (!job || job.id !== body.id || job.phase !== "running" || hash(body.leaseToken) !== job.leaseHash) fail(409, "deployment.lease_invalid");
      if (body.resourceId && (!body.resourceId.toLowerCase().startsWith(`${env.DEPLOYMENT_SCOPE}/providers/Microsoft.App/jobs/`.toLowerCase()) || !/^[a-z0-9-]{2,32}$/.test(body.resourceId.split("/").at(-1)!))) fail(400, "deployment.resource_scope_mismatch");
      if (body.resourceId) job.resourceId = body.resourceId;
      if (body.failureCode) job.failureCode = body.failureCode;
      if (body.applicationUrl && (!body.applicationUrl.startsWith("https://") || new URL(body.applicationUrl).username || new URL(body.applicationUrl).password)) fail(400, "deployment.application_url_invalid");
      if (body.applicationUrl && env.ONBOARDING_APPLICATION_ORIGIN && body.applicationUrl !== env.ONBOARDING_APPLICATION_ORIGIN) fail(400, "deployment.application_url_scope_mismatch");
      if (body.phase === "succeeded" && !DEPLOYMENT_STEPS.every(name => body.steps.some(step => step.name === name && step.status === "passed"))) fail(400, "deployment.verification_incomplete");
      state.executorSeenAt = Date.now();
      job.phase = body.phase; job.steps = body.steps; job.updatedAt = new Date().toISOString(); job.leaseUntil = Date.now() + 120_000;
      if (body.applicationUrl) job.applicationUrl = body.applicationUrl;
      if (body.phase !== "running") {
        delete job.leaseHash;
        job.message = body.phase === "succeeded" ? "Runtime services deployed and verified. Governed connection bindings require their plan-specific mappings before activation." : `Deployment stopped at ${body.steps.find(step => step.status === "failed")?.name ?? "validation"}${body.failureCode ? ` (${body.failureCode})` : ""}. Inspect the Azure operator job and its execution logs, then review and retry. Existing resources were retained.`;
        state.events.push({ at: job.updatedAt, action: `deployment.${body.phase}`, revision: job.revision, subject: job.requestedBy });
      }
      return { ok: true };
    });
  });
  app.post("/api/onboarding/deployment/recover", async request => {
    const held = await options.mutation(request);
    return store.update(state => {
      if (held.method !== "oidc" || !state.identityVerified) fail(403, "deployment.verified_administrator_required");
      options.assertSession(state, held);
      const job = state.deployment;
      if (!job || job.phase !== "running" || (job.leaseUntil ?? 0) > Date.now()) fail(409, "deployment.executor_lease_active");
      // No automatic replay: the operator must stop the old executor before recovery.
      const body = z.object({ acknowledgeExecutorStopped: z.literal(true), jobId: z.string().uuid() }).strict().parse(request.body);
      if (body.jobId !== job.id) fail(409, "deployment.review_changed");
      job.phase = "failed"; delete job.leaseHash; job.updatedAt = new Date().toISOString(); job.message = "Executor recovery acknowledged. Review existing resources before retrying.";
      return { ok: true };
    });
  });
}
