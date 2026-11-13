import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { stableDigest } from "@ehf/contracts";
import { DEFAULT_FACTORY_GATES, evaluateGates } from "@ehf/contracts/document-factory";
import { createDatabase, type Database } from "@ehf/persistence";
import { buildControlApi } from "./app.js";

const edge = "factory-edge-test-token-0123456789";
const workerToken = "factory-worker-test-token-0123456789";
const sha = (seed: string) => stableDigest({ seed });
const person = (subject: string, role: string, tenant: string) => ({ authorization: `Bearer ${edge}`, "x-actor-id": subject, "x-actor-type": "human", "x-actor-roles": role, "x-tenant-id": tenant });

it("authorizes every Factory route before touching persistence", async () => {
  const db = { query: async () => { throw new Error("unexpected database access"); }, connect: async () => { throw new Error("unexpected database access"); } } as unknown as Database;
  const app = buildControlApi({ db, env: { EDGE_SERVICE_TOKEN: edge } });
  try {
    expect((await app.inject("/v1/document-factory")).statusCode).toBe(401);
    expect((await app.inject({ url: "/v1/document-factory", headers: person("reader", "Harness.Reader", "tenant_demo") })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/v1/document-factory/release-jobs/job_1/approve-spend", headers: person("author", "Harness.Author", "tenant_demo") })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/v1/document-factory/worker/claim", headers: person("operator", "Harness.Operator", "tenant_demo"), payload: { owner: "x" } })).statusCode).toBe(403);
  } finally { await app.close(); }
});

describe.skipIf(!process.env.EHF_TEST_DATABASE_URL)("Document Factory API in PostgreSQL", () => {
  it("runs New release from plan to rollback with the worker reporting under its lease", async () => {
    const db = createDatabase(process.env.EHF_TEST_DATABASE_URL);
    const tenant = `factory-route-${randomUUID()}`;
    const app = buildControlApi({ db, env: { EDGE_SERVICE_TOKEN: edge, FACTORY_BUDGET_LIMIT_USD: "25" }, serviceGrants: [
      { token: edge, subjectId: "edge", roles: ["Edge.Delegate"], tenantId: tenant },
      { token: workerToken, subjectId: "document-factory-worker", roles: ["Factory.Worker"], tenantId: tenant },
    ] });
    const worker = { authorization: `Bearer ${workerToken}` };
    const call = async (method: "GET" | "POST" | "PUT", url: string, headers: Record<string, string>, payload?: unknown, status = 200) => {
      const response = await app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });
      expect(response.statusCode, `${method} ${url}: ${response.body}`).toBe(status);
      return response.json();
    };
    try {
      const author = person("author", "Harness.Author", tenant), operator = person("operator", "Harness.Operator", tenant), approver = person("approver", "Harness.Approver", tenant);
      // The worker seeds the registry from the dataset store.
      await call("POST", "/v1/document-factory/worker/strategies", worker, { documentType: "w9", contractHash: sha("w9"), strategy: "azure_template", modelFamily: null, rationale: "Fixed IRS form", owner: "manifest" });
      await call("POST", "/v1/document-factory/worker/datasets", worker, { datasetDigest: sha("w9-data"), documentType: "w9", contractHash: sha("w9"), previousDigest: null,
        counts: { train: 20, validation: 5, test: 12 }, groups: { train: 10, validation: 3, test: 6 }, labelSetDigest: sha("labels"),
        readiness: { train: true, validation: true, test_pipeline_proof: true, test_qualification: false }, storageRef: "datasets/w9/v1", excluded: 0,
        registeredAt: new Date().toISOString(), registeredBy: "worker" });

      // Preview, then plan; a blocked type is reported with what is missing.
      const previewed = await call("POST", "/v1/document-factory/release-plan", author, { selection: ["w9", "annual_return"] });
      expect(previewed.plan.find((item: { documentType: string }) => item.documentType === "annual_return")).toMatchObject({ action: "blocked" });
      expect((await app.inject({ method: "POST", url: "/v1/document-factory/release-jobs", headers: author, payload: { selection: ["w9"] } })).statusCode).toBe(400);
      const job = await call("POST", "/v1/document-factory/release-jobs", { ...author, "idempotency-key": "plan-1" }, { selection: ["w9", "annual_return"] });
      expect(job).toMatchObject({ status: "awaiting_approval", progress: { w9: { status: "pending" }, annual_return: { status: "excluded" } } });

      // Nothing to claim until an operator other than the planner approves the spend.
      expect((await call("POST", "/v1/document-factory/worker/claim", worker, { owner: "w1" })).job).toBeNull();
      await call("POST", `/v1/document-factory/release-jobs/${job.jobId}/approve-spend`, person("author", "Harness.Operator", tenant), undefined, 403);
      await call("POST", `/v1/document-factory/release-jobs/${job.jobId}/approve-spend`, operator);
      const claimed = (await call("POST", "/v1/document-factory/worker/claim", worker, { owner: "w1" })).job;
      expect(claimed.jobId).toBe(job.jobId);

      // The worker trains, evaluates and registers; the planner is the release's registrant.
      await call("POST", "/v1/document-factory/worker/models", worker, { modelVersionId: "w9-1", documentType: "w9", kind: "template", providerModelId: "ehf-w9-1",
        datasetDigest: sha("w9-data"), contractHash: sha("w9"), trainingJobId: job.jobId, trainingHours: null, costUsd: 0, status: "ready", createdAt: new Date().toISOString() });
      const release = { documents: 12, allKeyFieldsCorrect: 12, keyPrecision: 1, keyRecall: 0.97, wrongKeyValues: 0, integrityFailures: 0 };
      const gates = evaluateGates(DEFAULT_FACTORY_GATES, release);
      const reportBody = { jobId: job.jobId, gates: DEFAULT_FACTORY_GATES, classification: { documents: 12, correct: 12, otherRecall: null }, regressions: [], createdAt: new Date().toISOString(),
        types: [{ documentType: "w9", datasetDigest: sha("w9-data"), route: "custom", release, baseline: null, activeRelease: null, gates, gatesMet: true }] };
      const reportDigest = stableDigest(reportBody);
      await call("POST", "/v1/document-factory/worker/reports", worker, { ...reportBody, reportDigest });
      const registered = await call("POST", `/v1/document-factory/worker/jobs/${job.jobId}/release`, worker, {
        apiVersion: "document-factory/v1", kind: "DocumentModelRelease", releaseId: "rel-1", provider: "azure_document_intelligence",
        classifier: { classifierVersionId: "cls-1", providerClassifierId: "ehf-cls-1" }, composedModelId: "ehf-rel-1",
        types: [{ documentType: "w9", route: "custom", mode: "shadow", modelVersionId: "w9-1", providerModelId: "ehf-w9-1", datasetDigest: sha("w9-data"), evaluationDigest: reportDigest, gatesMet: true }],
        routePolicyDigest: sha("routes"), adjudicationPolicyDigest: sha("adjudication"), evaluationReportDigest: reportDigest, previousReleaseDigest: null, createdAt: new Date().toISOString() });
      await call("POST", `/v1/document-factory/worker/jobs/${job.jobId}/progress`, worker, { owner: "w2", status: "completed" }, 409);
      expect((await call("POST", `/v1/document-factory/worker/jobs/${job.jobId}/progress`, worker, { owner: "w1", stage: "report", status: "completed", reportDigest, releaseDigest: registered.digest })).job.status).toBe("completed");

      // Approve (not by the planner), activate, and see it in effect.
      await call("POST", `/v1/document-factory/releases/${registered.digest}/approve`, person("author", "Harness.Approver", tenant), undefined, 403);
      await call("POST", `/v1/document-factory/releases/${registered.digest}/approve`, approver);
      await call("POST", `/v1/document-factory/releases/${registered.digest}/activate`, operator, { environment: "test", reason: "First pilot release" });
      const overview = await call("GET", "/v1/document-factory", approver);
      expect(overview.environments).toEqual([expect.objectContaining({ environment: "test", inEffect: registered.digest })]);
      expect(overview.jobs[0]).toMatchObject({ jobId: job.jobId, status: "completed", releaseDigest: registered.digest });
      await call("POST", "/v1/document-factory/environments/test/rollback", operator, { reason: "Nothing earlier" }, 409);
      expect((await call("GET", `/v1/document-factory/release-jobs/${job.jobId}`, author)).events.map((e: { kind: string }) => e.kind)).toEqual(expect.arrayContaining(["job.created", "job.spend_approved", "job.completed"]));
    } finally { await app.close(); await db.end(); }
  });
});
