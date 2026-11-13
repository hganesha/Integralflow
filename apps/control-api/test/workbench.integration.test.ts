import { afterAll, beforeAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  createDatabase,
  createRun,
  type Database,
  recordWorkerHeartbeat,
} from "@ehf/persistence";
import { buildControlApi } from "../src/app.js";
import { buildApp } from "../../experience-bff/src/app.js";
import { workspaceTemplate } from "../src/workbench-sources.js";
import { workspaceConfig } from "@ehf/contracts/workbench";

const database = process.env.WORKBENCH_TEST_DATABASE_URL;
const run = database ? it : it.skip;
let db: Database;
let serviceDb: Database;
let control: FastifyInstance;
let edge: FastifyInstance;
let origin: string;
const tenant = "workbench-" + randomUUID();
const token = "workbench-test-edge-000000000000001";
type Session = { cookie: string; csrf: string };
beforeAll(async () => {
  if (!database) return;
  db = createDatabase(database);
  const serviceUrl = new URL(database);
  serviceUrl.searchParams.set("options", "-c role=ehf_svc_control_api");
  serviceDb = createDatabase(serviceUrl.toString());
  control = buildControlApi({
    db: serviceDb,
    env: {
      EDGE_SERVICE_TOKEN: token,
      PLATFORM_TENANT_ID: tenant,
      WORKBENCH_EVALUATOR_BACKEND: "docker",
    },
    contextStore: null,
    serviceGrants: [
      { token, subjectId: "edge", roles: ["Edge.Delegate"], tenantId: tenant },
    ],
  });
  control.log.level = "silent";
  const controlOrigin = await control.listen({ host: "127.0.0.1", port: 0 });
  edge = buildApp({
    env: {
      CONTROL_API_INTERNAL_URL: controlOrigin,
      EDGE_SERVICE_TOKEN: token,
      PLATFORM_TENANT_ID: tenant,
      BFF_PUBLIC_ORIGIN: "http://workbench.test",
      CASE_API_INTERNAL_URL: "http://127.0.0.1:1",
      CAPABILITY_GATEWAY_INTERNAL_URL: "http://127.0.0.1:1",
    },
    principalResolver: {
      source: "local",
      resolve: async (request) => ({
        subjectId: String(request.headers["x-test-user"] ?? "author"),
        tenantId: String(request.headers["x-test-tenant"] ?? tenant),
        actorType: "human",
        roles: String(
          request.headers["x-test-roles"] ?? "Harness.Author",
        ).split(","),
        source: "local",
      }),
    },
  });
  edge.log.level = "silent";
  origin = await edge.listen({ host: "127.0.0.1", port: 0 });
});
afterAll(async () => {
  await edge?.close();
  await control?.close();
  await serviceDb?.end();
  if (db)
    await db.query(
      "delete from observability.worker_heartbeats where worker_id=$1",
      ["workbench-test-worker-" + tenant],
    );
  await db?.end();
});
async function session(
  user = "author",
  roles = "Harness.Author",
  scope = tenant,
): Promise<Session> {
  const response = await fetch(origin + "/api/v1/session", {
    headers: {
      "x-test-user": user,
      "x-test-roles": roles,
      "x-test-tenant": scope,
    },
  });
  expect(response.status).toBe(200);
  return {
    cookie: response.headers.get("set-cookie")!.split(";")[0]!,
    csrf: ((await response.json()) as any).csrfToken,
  };
}
async function request(
  s: Session,
  path: string,
  method = "GET",
  body?: unknown,
) {
  const response = await fetch(origin + "/api/v1" + path, {
    method,
    headers: {
      cookie: s.cookie,
      origin: "http://workbench.test",
      "x-csrf-token": s.csrf,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: (await response.json()) as any };
}
async function waitEvaluation(s: Session, id: string, evaluationId: string) {
  for (let retry = 0; retry < 60; retry++) {
    const view = await request(s, "/workbench/workspaces/" + id);
    expect(view.status).toBe(200);
    const report = view.body.evaluations.find(
      (item: any) => item.evaluationId === evaluationId,
    );
    if (report && !["queued", "running"].includes(report.status)) return report;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error("Evaluation did not complete");
}

run(
  "executes edited source through HTTP, PostgreSQL and a disposable container; pins evidence and rejects stale revisions and self approval",
  async () => {
    const author = await session();
    const reviewer = await session("reviewer", "Harness.Approver");
    const created = await request(author, "/workbench/workspaces", "POST", {
      kind: "skill",
      name: "Evidence normalization",
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body.workspace.workspaceId;
    const files = {
      ...created.body.source.files,
      "main.py":
        'def run(data):\n    return {"normalized": data["name"].strip().lower()}\n',
    };
    files["workbench.json"] = JSON.stringify({
      ...workspaceConfig(files),
      inputSchema: {
        type: "object",
        required: ["name"],
        properties: { name: { type: "string" } },
      },
      outputSchema: {
        type: "object",
        required: ["normalized"],
        properties: { normalized: { type: "string" } },
      },
    });
    const saved = await request(author, "/workbench/workspaces/" + id, "PUT", {
      expectedRevision: 1,
      message: "Implement normalization",
      files,
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.source.revision).toBe(2);
    expect(
      (
        await request(author, "/workbench/workspaces/" + id, "PUT", {
          expectedRevision: 1,
          message: "Stale edit",
          files,
        })
      ).status,
    ).toBe(409);
    const queued = await request(
      author,
      "/workbench/workspaces/" + id + "/evaluations",
      "POST",
      {
        revision: 2,
        dataset: {
          name: "Names",
          version: "1",
          cases: [
            {
              id: "spaces",
              input: { name: " Alice " },
              expected: { normalized: "alice" },
            },
          ],
        },
      },
    );
    expect(queued.status, JSON.stringify(queued.body)).toBe(202);
    const report = await waitEvaluation(author, id, queued.body.evaluationId);
    expect(report.status, JSON.stringify(report)).toBe("passed");
    expect(report.cases[0].actual).toEqual({ normalized: "alice" });
    expect(report.sourceDigest).toBe(saved.body.source.digest);
    expect(report.datasetDigest).toMatch(/^[a-f0-9]{64}$/);
    const promotion = {
      revision: 2,
      operation: "approve",
      evaluationId: report.evaluationId,
      reason: "Reviewed behavior against the dataset",
    };
    const self = await session("author", "Harness.Author,Harness.Approver");
    expect(
      (
        await request(
          self,
          "/workbench/workspaces/" + id + "/promotions",
          "POST",
          promotion,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await request(
          reviewer,
          "/workbench/workspaces/" + id + "/promotions",
          "POST",
          promotion,
        )
      ).status,
    ).toBe(200);
    const published = await request(
      reviewer,
      "/workbench/workspaces/" + id + "/promotions",
      "POST",
      { ...promotion, operation: "publish" },
    );
    expect(published.status, JSON.stringify(published.body)).toBe(200);
    expect(published.body.workspace.publishedRevision).toBe(2);
    const next = await request(author, "/workbench/workspaces/" + id, "PUT", {
      expectedRevision: 2,
      message: "Begin next revision",
      files: { ...files, "notes.md": "Next revision" },
    });
    expect(next.body.workspace.publishedRevision).toBe(2);
    expect(next.body.source.revision).toBe(3);
    const old = await request(
      author,
      "/workbench/workspaces/" + id + "?revision=2",
    );
    expect(old.body.source.digest).toBe(saved.body.source.digest);
    expect(old.body.source.files["notes.md"]).toBeUndefined();
    const exported = await request(
      author,
      "/workbench/workspaces/" + id + "/export?revision=2",
    );
    expect(exported.body.source.digest).toBe(saved.body.source.digest);
    const other = await session("other", "Harness.Author", "other-" + tenant);
    expect((await request(other, "/workbench/workspaces/" + id)).status).toBe(
      403,
    );
  },
  40_000,
);

run(
  "grades failures, imports full canonical skill source, and rejects traversal and malformed datasets",
  async () => {
    const author = await session();
    const imported = await request(author, "/workbench/workspaces", "POST", {
      kind: "skill",
      name: "Name normalization",
      sourceId: "screening.name.normalize",
    });
    expect(imported.status, JSON.stringify(imported.body)).toBe(201);
    expect(Object.keys(imported.body.source.files).length).toBeGreaterThan(
      1000,
    );
    expect(
      imported.body.source.files["src/financial_crime/skills/screening.py"],
    ).toContain("def name_normalize");
    const id = imported.body.workspace.workspaceId;
    const queued = await request(
      author,
      "/workbench/workspaces/" + id + "/evaluations",
      "POST",
      {
        revision: 1,
        dataset: {
          name: "Intentional mismatch",
          version: "1",
          cases: [
            {
              id: "mismatch",
              input: { name: " Alice " },
              expected: { normalized: "WRONG", original: " Alice " },
            },
          ],
        },
      },
    );
    expect(queued.status).toBe(202);
    const report = await waitEvaluation(author, id, queued.body.evaluationId);
    expect(report.status).toBe("failed");
    expect(report.cases[0].actual.normalized).toBe("alice");
    expect(
      (
        await request(
          author,
          "/workbench/workspaces/" + id + "/evaluations",
          "POST",
          {
            revision: 1,
            dataset: {
              name: "No oracle",
              version: "1",
              cases: [{ id: "bad", input: {} }],
            },
          },
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await request(author, "/workbench/workspaces/" + id, "PUT", {
          expectedRevision: 1,
          message: "Bad path",
          files: {
            ...workspaceTemplate("skill", "Bad"),
            "../escape.py": "bad",
          },
        })
      ).status,
    ).toBe(400);
    const reader = await session("reader", "Harness.Reader");
    expect(
      (
        await request(reader, "/workbench/workspaces", "POST", {
          kind: "skill",
          name: "Unauthorized",
        })
      ).status,
    ).toBe(403);
  },
  40_000,
);

run(
  "reports live queues and worker replicas and persists tenant-scoped admission decisions with revision conflicts",
  async () => {
    const operator = await session("operator", "Harness.Operator");
    await recordWorkerHeartbeat(db, {
      id: "workbench-test-worker-" + tenant,
      kind: "runtime-worker",
      concurrency: 2,
      inFlight: 0,
      lastSuccessAt: new Date(),
    });
    const services = await request(operator, "/system");
    expect(services.status, JSON.stringify(services.body)).toBe(200);
    expect(services.body.queueWorkState.activeWorkers).toBeGreaterThan(0);
    expect(services.body.queueWorkState.ready).toBe(0);
    const admission = await request(operator, "/admin/runtime");
    expect(admission.status).toBe(200);
    const stopped = await request(operator, "/admin/runtime", "POST", {
      operation: "stop",
      activeRunPolicy: "drain",
      expectedRevision: 0,
      reason: "Exercise admission controls",
    });
    expect(stopped.status, JSON.stringify(stopped.body)).toBe(200);
    expect(stopped.body.state).toBe("stopped");
    await expect(
      createRun(serviceDb, {
        tenantId: tenant,
        planDigest: "f".repeat(64),
        runInput: {},
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toThrow("run.environment_stopped");
    expect(
      (
        await request(operator, "/admin/runtime", "POST", {
          operation: "resume",
          expectedRevision: 0,
          reason: "Stale request",
        })
      ).status,
    ).toBe(409);
    const resumed = await request(operator, "/admin/runtime", "POST", {
      operation: "resume",
      expectedRevision: 1,
      reason: "Verified admission test complete",
    });
    expect(resumed.body.state).toBe("running");
    expect(
      (
        await db.query(
          "select * from harness_control.runtime_admission_events where tenant_id=$1 order by revision",
          [tenant],
        )
      ).rows,
    ).toHaveLength(2);
    const digest = randomUUID().replaceAll("-", "").repeat(2);
    await db.query(
      "insert into harness_control.plans(tenant_id,plan_digest,plan_id,name,domain,version,plan) values($1,$2,'admission-test','Admission test','test','1','{}')",
      [tenant, digest],
    );
    const queuedRun = await createRun(serviceDb, {
      tenantId: tenant,
      planDigest: digest,
      runInput: {},
      idempotencyKey: randomUUID(),
    });
    const runningRun = await createRun(serviceDb, {
      tenantId: tenant,
      planDigest: digest,
      runInput: {},
      idempotencyKey: randomUUID(),
    });
    await db.query(
      "update harness_runtime.runs set status='running',lease_owner='admission-test',lease_expires_at=now()+interval '1 minute' where run_id=$1",
      [runningRun.run.runId],
    );
    const cancelAll = await request(operator, "/admin/runtime", "POST", {
      operation: "stop",
      activeRunPolicy: "cancel",
      expectedRevision: 2,
      reason: "Cancel acceptance runs",
    });
    expect(cancelAll.status, JSON.stringify(cancelAll.body)).toBe(200);
    expect(cancelAll.body.cancellationRequests).toBe(2);
    const outcomes = (
      await db.query(
        "select run_id,status,fencing_epoch,cancellation_requested_at from harness_runtime.runs where tenant_id=$1",
        [tenant],
      )
    ).rows;
    expect(
      outcomes.find((row) => row.run_id === queuedRun.run.runId),
    ).toMatchObject({ status: "cancelled", fencing_epoch: "1" });
    expect(
      outcomes.find((row) => row.run_id === runningRun.run.runId),
    ).toMatchObject({ status: "running", fencing_epoch: "1" });
    expect(outcomes.every((row) => row.cancellation_requested_at)).toBe(true);
    await request(operator, "/admin/runtime", "POST", {
      operation: "resume",
      expectedRevision: 3,
      reason: "Admission acceptance complete",
    });
    const author = await session();
    expect(
      (
        await request(author, "/admin/runtime", "POST", {
          operation: "stop",
          expectedRevision: 2,
          reason: "No operator role",
        })
      ).status,
    ).toBe(403);
  },
  15_000,
);

run(
  "cancels queued or running source evaluations with a bodyless BFF command",
  async () => {
    const author = await session();
    const created = await request(author, "/workbench/workspaces", "POST", {
      kind: "skill",
      name: "Cancellation",
    });
    const id = created.body.workspace.workspaceId;
    const queued = await request(
      author,
      "/workbench/workspaces/" + id + "/evaluations",
      "POST",
      {
        revision: 1,
        dataset: {
          name: "Cancellation",
          version: "1",
          cases: [{ id: "one", input: {}, expected: {} }],
        },
      },
    );
    expect(queued.status).toBe(202);
    const cancelled = await request(
      author,
      "/workbench/evaluations/" + queued.body.evaluationId + "/cancel",
      "POST",
    );
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
    const report = await waitEvaluation(author, id, queued.body.evaluationId);
    expect(report.status).toBe("cancelled");
  },
  20_000,
);

run(
  "bounds retained outputs across a dataset instead of expanding untrusted results without limit",
  async () => {
    const author = await session();
    const files = workspaceTemplate("skill", "Bounded output");
    files["main.py"] = 'def run(data):\n    return {"large": "x" * 350000}\n';
    const created = await request(author, "/workbench/workspaces", "POST", {
      kind: "skill",
      name: "Bounded output",
      files,
    });
    const id = created.body.workspace.workspaceId;
    const queued = await request(
      author,
      "/workbench/workspaces/" + id + "/evaluations",
      "POST",
      {
        revision: 1,
        dataset: {
          name: "Bounded report",
          version: "1",
          cases: [1, 2, 3].map((n) => ({
            id: String(n),
            input: {},
            assertions: [{ path: "/large", operator: "exists" }],
          })),
        },
      },
    );
    expect(queued.status).toBe(202);
    const report = await waitEvaluation(author, id, queued.body.evaluationId);
    expect(report.status).toBe("error");
    expect(report.cases.at(-1).failures).toContain(
      "workbench.result_limit_exceeded",
    );
    expect(JSON.stringify(report.cases).length).toBeLessThan(1_000_000);
  },
  30_000,
);
