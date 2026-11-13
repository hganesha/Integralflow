import { randomUUID } from "node:crypto";
import { z } from "zod";
import { stableDigest } from "@ehf/contracts";
import {
  createReleaseJobRequestSchema, DEFAULT_FACTORY_GATES, DEFAULT_FACTORY_PRICES, factoryGatesSchema, planReleaseJob, RELEASE_JOB_STAGES, type ReleaseJob,
} from "@ehf/contracts/document-factory";
import {
  activateFactoryRelease, approveFactoryRelease, approveReleaseSpend, cancelReleaseJob, claimReleaseJob, createReleaseJob, FactoryError, getEvaluationReport,
  getReleaseJob, listClassifierVersions, listDatasetVersions, listFactoryEvents, listFactoryReleases, listModelVersions, listReleaseJobs, listTypeStrategies,
  recordEvaluationReport, registerDatasetVersion, registerFactoryRelease, rollbackFactoryRelease, saveClassifierVersion, saveModelVersion, saveTypeStrategy, updateReleaseJob,
  type Database,
} from "@ehf/persistence";
import type { PlatformAction, Principal, ResourceRef } from "@ehf/identity";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

type Authorize = (request: FastifyRequest, action: PlatformAction, resource?: ResourceRef) => Promise<Principal>;
const documentType = z.string().regex(/^[a-z][a-z0-9_]{0,99}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const reason = z.string().trim().min(3).max(500);

/**
 * Document Factory API (document factory plan §7.4). People plan, approve, review, approve and activate releases;
 * the Factory worker (workload `Factory.Worker`) claims approved jobs and reports progress and results under its lease.
 * Planning is computed here from the registry, never taken from the request.
 */
export function registerDocumentFactoryRoutes(app: FastifyInstance, options: { db: Database; env: NodeJS.ProcessEnv; authorize: Authorize; workload: Authorize }): void {
  const { db, env } = options;
  const budgetLimitUsd = Number(env.FACTORY_BUDGET_LIMIT_USD ?? 25);
  const send = async (reply: FastifyReply, work: () => Promise<unknown>) => {
    reply.header("cache-control", "no-store");
    try { return await work(); }
    catch (error) {
      if (error instanceof FactoryError) return reply.code(error.status).send({ error: error.message });
      if (error instanceof z.ZodError) return reply.code(400).send({ error: "factory.request_invalid", details: { issues: error.issues.map(issue => ({ path: issue.path.join("."), message: issue.message })) } });
      throw error;
    }
  };
  const human = (action: PlatformAction, handle: (request: FastifyRequest, caller: Principal) => Promise<unknown>) => async (request: FastifyRequest, reply: FastifyReply) =>
    send(reply, async () => {
      const caller = await options.authorize(request, action, { kind: "document-factory" });
      if (caller.actorType !== "human") throw new FactoryError("authorization.interactive_user_required", 403);
      return handle(request, caller);
    });
  const worker = (handle: (request: FastifyRequest, caller: Principal) => Promise<unknown>) => async (request: FastifyRequest, reply: FastifyReply) =>
    send(reply, async () => handle(request, await options.workload(request, "factory.work", { kind: "document-factory" })));
  const params = (request: FastifyRequest) => request.params as Record<string, string>;

  // ------------------------------------------------------------ people
  app.get("/v1/document-factory", human("dataset.read", async (_request, caller) => {
    const [strategies, datasets, models, classifiers, jobs, releases] = await Promise.all([
      listTypeStrategies(db, caller.tenantId), listDatasetVersions(db, caller.tenantId), listModelVersions(db, caller.tenantId),
      listClassifierVersions(db, caller.tenantId), listReleaseJobs(db, caller.tenantId, 20), listFactoryReleases(db, caller.tenantId),
    ]);
    return { strategies, datasets, models, classifiers, jobs, ...releases, budgetLimitUsd, defaultGates: DEFAULT_FACTORY_GATES };
  }));

  app.get("/v1/document-factory/datasets/:documentType", human("dataset.read", async (request, caller) =>
    ({ versions: await listDatasetVersions(db, caller.tenantId, documentType.parse(params(request).documentType)) })));

  app.put("/v1/document-factory/strategies/:documentType", human("dataset.curate", async (request, caller) => {
    const body = z.object({ contractHash: digest, strategy: z.string(), modelFamily: z.string().nullable(), rationale: z.string() }).strict().parse(request.body);
    return saveTypeStrategy(db, { tenantId: caller.tenantId, actor: caller.subjectId, body: { ...body, documentType: documentType.parse(params(request).documentType), owner: caller.subjectId } });
  }));

  /** Steps 1–3 of New release: the selection resolved against the registry, readiness per type, and the estimate. */
  const preview = async (tenantId: string, raw: unknown) => {
    const body = createReleaseJobRequestSchema.parse(raw);
    const gates = factoryGatesSchema.parse({ ...DEFAULT_FACTORY_GATES, ...(body.gates ?? {}) });
    const [strategies, datasets, models, releases] = await Promise.all([listTypeStrategies(db, tenantId), listDatasetVersions(db, tenantId),
      listModelVersions(db, tenantId), listFactoryReleases(db, tenantId)]);
    let selection: string[];
    if (body.selection === "changed_since_active") {
      const active = new Set(releases.environments.flatMap(env => releases.releases.find(r => r.digest === env.inEffect)?.manifest.types.map(t => `${t.documentType}:${t.datasetDigest}`) ?? []));
      selection = datasets.filter(dataset => !active.has(`${dataset.documentType}:${dataset.datasetDigest}`)).map(dataset => dataset.documentType);
      if (!selection.length) throw new FactoryError("factory.nothing_changed", 409);
    } else selection = body.selection;
    const { plan, estimate } = planReleaseJob({ selection, gates, strategies, datasets, models, prices: DEFAULT_FACTORY_PRICES });
    return { body, gates, plan, estimate, overBudget: estimate.trainingCostUsd + estimate.evaluationCostUsd > budgetLimitUsd, budgetLimitUsd };
  };

  app.post("/v1/document-factory/release-plan", human("release.create", async (request, caller) => {
    const { body: _body, ...planned } = await preview(caller.tenantId, request.body);
    return planned;
  }));

  // New release, steps 1–3 recorded: the job waits for spend approval (step 4).
  app.post("/v1/document-factory/release-jobs", human("release.create", async (request, caller) => {
    const key = request.headers["idempotency-key"];
    if (typeof key !== "string" || !key.trim() || key.length > 200) throw new FactoryError("factory.idempotency_key_required");
    const { body, gates, plan, estimate } = await preview(caller.tenantId, request.body);
    if (!plan.some(item => item.action !== "blocked")) throw new FactoryError("factory.every_type_blocked", 409);
    const now = new Date().toISOString();
    const job: ReleaseJob = {
      jobId: `job_${randomUUID().replaceAll("-", "").slice(0, 24)}`, status: "awaiting_approval", stage: "approval", selection: plan.map(item => item.documentType),
      plan, estimate, gates, createdBy: caller.subjectId, createdAt: now, spendApprovedBy: null, spendApprovedAt: null, budgetOwnerApprovedBy: null,
      progress: Object.fromEntries(plan.map(item => [item.documentType, { status: item.action === "blocked" ? "excluded" as const : "pending" as const, detail: item.blockers.join(" ") || null }])),
      reportDigest: null, releaseDigest: null, error: null, updatedAt: now,
    };
    const result = await createReleaseJob(db, { tenantId: caller.tenantId, actor: caller.subjectId, idempotencyKey: key, requestDigest: stableDigest(body), job });
    return { ...result.job, overBudget: estimate.trainingCostUsd + estimate.evaluationCostUsd > budgetLimitUsd, budgetLimitUsd };
  }));

  app.get("/v1/document-factory/release-jobs/:jobId", human("dataset.read", async (request, caller) => {
    const job = await getReleaseJob(db, caller.tenantId, params(request).jobId!);
    if (!job) throw new FactoryError("factory.job_not_found", 404);
    return { ...job, events: await listFactoryEvents(db, caller.tenantId, job.jobId, 50) };
  }));

  app.post("/v1/document-factory/release-jobs/:jobId/approve-spend", human("factory.train", async (request, caller) =>
    approveReleaseSpend(db, { tenantId: caller.tenantId, actor: caller.subjectId, jobId: params(request).jobId!, budgetLimitUsd })));

  app.post("/v1/document-factory/release-jobs/:jobId/cancel", human("release.create", async (request, caller) =>
    cancelReleaseJob(db, { tenantId: caller.tenantId, actor: caller.subjectId, jobId: params(request).jobId! })));

  app.get("/v1/document-factory/reports/:digest", human("dataset.read", async (request, caller) => {
    const report = await getEvaluationReport(db, caller.tenantId, digest.parse(params(request).digest));
    if (!report) throw new FactoryError("factory.report_not_found", 404);
    return report;
  }));

  app.get("/v1/document-factory/releases", human("release.read", async (_request, caller) => listFactoryReleases(db, caller.tenantId)));

  app.post("/v1/document-factory/releases/:digest/approve", human("release.approve", async (request, caller) =>
    approveFactoryRelease(db, { tenantId: caller.tenantId, actor: caller.subjectId, digest: digest.parse(params(request).digest) })));

  app.post("/v1/document-factory/releases/:digest/activate", human("release.activate", async (request, caller) => {
    const body = z.object({ environment: z.string(), effectiveFrom: z.string().datetime().optional(), reason }).strict().parse(request.body);
    return activateFactoryRelease(db, { tenantId: caller.tenantId, actor: caller.subjectId, digest: digest.parse(params(request).digest), ...body });
  }));

  app.post("/v1/document-factory/environments/:environment/rollback", human("release.activate", async (request, caller) => {
    const body = z.object({ reason }).strict().parse(request.body);
    return rollbackFactoryRelease(db, { tenantId: caller.tenantId, actor: caller.subjectId, environment: params(request).environment!, reason: body.reason });
  }));

  // ------------------------------------------------------------ the Factory worker
  app.post("/v1/document-factory/worker/claim", worker(async (request, caller) => {
    const owner = z.object({ owner: z.string().min(1).max(200) }).strict().parse(request.body).owner;
    return { job: await claimReleaseJob(db, { tenantId: caller.tenantId, owner }) };
  }));

  app.post("/v1/document-factory/worker/jobs/:jobId/progress", worker(async (request, caller) => {
    const body = z.object({
      owner: z.string().min(1), stage: z.enum(RELEASE_JOB_STAGES).optional(), status: z.enum(["running", "failed", "completed", "cancelled"]).optional(),
      progress: z.record(z.string(), z.object({ status: z.enum(["pending", "running", "done", "failed", "excluded", "skipped"]), detail: z.string().max(500).nullable() }).strict()).optional(),
      error: z.string().max(500).nullable().optional(), reportDigest: digest.nullable().optional(), releaseDigest: digest.nullable().optional(),
    }).strict().parse(request.body);
    const { owner, ...patch } = body;
    return updateReleaseJob(db, { tenantId: caller.tenantId, owner, jobId: params(request).jobId!, patch });
  }));

  app.get("/v1/document-factory/worker/ready", worker(async () => ({ status: "ready" })));

  app.get("/v1/document-factory/worker/registry", worker(async (_request, caller) => {
    const [strategies, datasets, models, classifiers] = await Promise.all([listTypeStrategies(db, caller.tenantId), listDatasetVersions(db, caller.tenantId),
      listModelVersions(db, caller.tenantId), listClassifierVersions(db, caller.tenantId)]);
    return { strategies, datasets, models, classifiers };
  }));

  app.post("/v1/document-factory/worker/strategies", worker(async (request, caller) =>
    saveTypeStrategy(db, { tenantId: caller.tenantId, actor: caller.subjectId, body: request.body })));
  app.post("/v1/document-factory/worker/datasets", worker(async (request, caller) =>
    registerDatasetVersion(db, { tenantId: caller.tenantId, actor: caller.subjectId, body: request.body })));
  app.post("/v1/document-factory/worker/models", worker(async (request, caller) =>
    saveModelVersion(db, { tenantId: caller.tenantId, actor: caller.subjectId, body: request.body })));
  app.post("/v1/document-factory/worker/classifiers", worker(async (request, caller) =>
    saveClassifierVersion(db, { tenantId: caller.tenantId, actor: caller.subjectId, body: request.body })));
  app.post("/v1/document-factory/worker/reports", worker(async (request, caller) =>
    recordEvaluationReport(db, { tenantId: caller.tenantId, actor: caller.subjectId, report: request.body })));

  // The worker composes the release; its registrant is the person who planned the job, so that person cannot approve it.
  app.post("/v1/document-factory/worker/jobs/:jobId/release", worker(async (request, caller) => {
    const job = await getReleaseJob(db, caller.tenantId, params(request).jobId!);
    if (!job) throw new FactoryError("factory.job_not_found", 404);
    return registerFactoryRelease(db, { tenantId: caller.tenantId, registrant: job.createdBy, jobId: job.jobId, manifest: request.body });
  }));
}
