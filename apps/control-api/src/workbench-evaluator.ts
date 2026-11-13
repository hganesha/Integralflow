import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { FastifyInstance } from "fastify";
import {
  stableDigest,
  type EvaluationCase,
  type WorkbenchDataset,
  type WorkspaceRevision,
  type ToolReceipt,
} from "@ehf/contracts";
import {
  claimWorkspaceEvaluation,
  finishWorkspaceEvaluation,
  getWorkspace,
  type Database,
} from "@ehf/persistence";
import { createWorkloadTokenProvider, platformTenantId } from "@ehf/identity";

const exec = promisify(execFile);
export type SourceExecution = {
  actual: unknown;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  traceId: string | null;
};
export function assertionFailures(
  test: WorkbenchDataset["cases"][number],
  actual: unknown,
): string[] {
  const failures: string[] = [];
  if (
    test.expected !== undefined &&
    stableDigest(test.expected) !== stableDigest(actual)
  )
    failures.push("Output differs from the expected result.");
  for (const assertion of test.assertions) {
    const parts =
      assertion.path === ""
        ? []
        : assertion.path.startsWith("/")
          ? assertion.path
              .slice(1)
              .split("/")
              .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
          : assertion.path.split(".");
    let value: unknown = actual;
    for (const part of parts)
      value =
        value !== null &&
        typeof value === "object" &&
        Object.hasOwn(value, part)
          ? (value as Record<string, unknown>)[part]
          : undefined;
    const pass =
      assertion.operator === "exists"
        ? value !== undefined
        : assertion.operator === "equals"
          ? value !== undefined &&
            stableDigest(value) === stableDigest(assertion.value ?? null)
          : typeof value === "string"
            ? value.includes(String(assertion.value))
            : Array.isArray(value) &&
              value.some(
                (item) =>
                  stableDigest(item) === stableDigest(assertion.value ?? null),
              );
    if (!pass)
      failures.push(
        `${assertion.path || "/"}: ${assertion.operator} assertion failed.`,
      );
  }
  return failures;
}

/** The API never loads edited modules. A disposable container receives source and fixture
 * input, with no network, platform credentials, Docker socket or writeable source mount. */
export async function executeSourceCase(
  source: WorkspaceRevision,
  input: unknown,
  env: NodeJS.ProcessEnv,
): Promise<SourceExecution> {
  const temporary = await mkdtemp(join(tmpdir(), "ehf-eval-"));
  const name = "ehf-eval-" + randomUUID();
  try {
    for (const [path, content] of Object.entries(source.files)) {
      const target = join(temporary, "source", path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, { mode: 0o644 });
    }
    await writeFile(
      join(temporary, "input.json"),
      JSON.stringify({ config: source.config, input }),
      { mode: 0o644 },
    );
    // The temp parent is traversable by the container's unprivileged UID.
    const { chmod } = await import("node:fs/promises");
    await chmod(temporary, 0o755);
    const { stdout } = await exec(
      env.WORKBENCH_DOCKER_BIN ?? "docker",
      [
        "run",
        "--rm",
        "--name",
        name,
        "--network",
        "none",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--pids-limit",
        "64",
        "--memory",
        "512m",
        "--cpus",
        "1",
        "--user",
        "65534:65534",
        "--tmpfs",
        "/tmp:rw,noexec,nosuid,size=64m",
        "--mount",
        `type=bind,src=${temporary},dst=/evaluation,readonly`,
        env.WORKBENCH_EVALUATOR_IMAGE ?? "ehf-workbench-evaluator:local",
      ],
      {
        timeout: 15_000,
        maxBuffer: 512_000,
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          ...(process.env.DOCKER_HOST
            ? { DOCKER_HOST: process.env.DOCKER_HOST }
            : {}),
          ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
        },
      },
    );
    const result = JSON.parse(stdout.trim()) as {
      actual: unknown;
      error?: string;
    };
    if (result.error) throw new Error(result.error);
    return {
      actual: result.actual,
      inputTokens: null,
      outputTokens: null,
      costUsd: 0,
      traceId: null,
    };
  } finally {
    await exec(env.WORKBENCH_DOCKER_BIN ?? "docker", ["rm", "-f", name], {
      timeout: 5000,
    }).catch(() => undefined);
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function executeConfiguredSourceCase(
  source: WorkspaceRevision,
  input: unknown,
  env: NodeJS.ProcessEnv,
): Promise<SourceExecution> {
  if (env.WORKBENCH_EVALUATOR_BACKEND === "docker")
    return executeSourceCase(source, input, env);
  if (env.WORKBENCH_EVALUATOR_BACKEND === "azure_jobs")
    return (await import("./workbench-azure.js")).executeAzureSourceCase(
      source,
      input,
      env,
    );
  if (
    env.WORKBENCH_EVALUATOR_BACKEND !== "http" ||
    !env.WORKBENCH_EVALUATOR_URL
  )
    throw new Error("workbench.evaluator_not_configured");
  const credential = createWorkloadTokenProvider(
    { staticTokenEnv: "CONTROL_API_SERVICE_TOKEN" },
    env,
  );
  const response = await fetch(env.WORKBENCH_EVALUATOR_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${await credential()}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ source, input }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error("workbench.source_execution_failed");
  const result = (await response.json()) as SourceExecution & {
    sourceDigest?: string;
  };
  if (result.sourceDigest !== source.digest || !Object.hasOwn(result, "actual"))
    throw new Error("workbench.evaluator_result_binding_invalid");
  return {
    actual: result.actual,
    inputTokens: result.inputTokens ?? null,
    outputTokens: result.outputTokens ?? null,
    costUsd: result.costUsd ?? null,
    traceId: result.traceId ?? null,
  };
}

async function validateAgentValue(
  source: WorkspaceRevision,
  schema: Record<string, unknown>,
  value: unknown,
  env: NodeJS.ProcessEnv,
) {
  const files = { "validate.py": "def run(data):\n    return data\n" };
  await executeConfiguredSourceCase(
    {
      ...source,
      files,
      digest: stableDigest(files),
      config: {
        ...source.config,
        kind: "skill",
        engine: "python",
        entrypoint: "validate:run",
        inputSchema: schema,
        outputSchema: schema,
        modelProfileId: null,
        skillRefs: [],
      },
    },
    value,
    env,
  );
}

export function startWorkbenchEvaluator(
  app: FastifyInstance,
  db: Database,
  env: NodeJS.ProcessEnv,
) {
  const owner = "workbench:" + randomUUID();
  let busy = false;
  let stopped = false;
  let running: Promise<void> | null = null;
  const credential = createWorkloadTokenProvider(
    { staticTokenEnv: "CONTROL_API_SERVICE_TOKEN" },
    env,
  );
  const tick = async () => {
    if (busy || stopped) return;
    busy = true;
    try {
      const job = await claimWorkspaceEvaluation(
        db,
        owner,
        platformTenantId(env),
      );
      if (!job) return;
      const { report, tenantId } = job;
      const cases: EvaluationCase[] = [];
      let reportBytes = 0;
      let receiptBytes = 0;
      const jobStarted = Date.now();
      const lease = setInterval(() => {
        void db
          .query(
            "update harness_control.workspace_evaluations set lease_until=now()+interval '10 minutes' where tenant_id=$1 and evaluation_id=$2 and owner=$3 and status='running'",
            [tenantId, report.evaluationId, owner],
          )
          .catch(() => undefined);
      }, 30_000);
      lease.unref();
      try {
        const { source } = await getWorkspace(
          db,
          tenantId,
          report.workspaceId,
          report.revision,
        );
        if (source.digest !== report.sourceDigest)
          throw new Error("workbench.source_digest_mismatch");
        for (let index = 0; index < report.dataset.cases.length; index++) {
          if (Date.now() - jobStarted > 15 * 60_000)
            throw new Error("workbench.evaluation_deadline");
          const test = report.dataset.cases[index]!;
          const started = Date.now();
          const receipts: ToolReceipt[] = [];
          try {
            const active = await db.query(
              "update harness_control.workspace_evaluations set lease_until=now()+interval '10 minutes' where tenant_id=$1 and evaluation_id=$2 and owner=$3 and status='running' and cancellation_requested=false returning evaluation_id",
              [tenantId, report.evaluationId, owner],
            );
            if (!active.rowCount) {
              await finishWorkspaceEvaluation(db, {
                tenantId,
                id: report.evaluationId,
                owner,
                status: "cancelled",
                cases,
                error: null,
              });
              return;
            }
            let result: SourceExecution;
            if (source.config.engine === "agent") {
              await validateAgentValue(
                source,
                source.config.inputSchema,
                test.input,
                env,
              );
              const base =
                env.CAPABILITY_GATEWAY_URL ?? "http://capability-gateway:4101";
              let final: SourceExecution | null = null;
              let inputTokens: number | null = 0;
              let outputTokens: number | null = 0;
              let costUsd: number | null = 0;
              for (let step = 0; step < 8; step++) {
                const response = await fetch(
                  new URL(
                    `/v1/workbench/evaluations/${encodeURIComponent(report.evaluationId)}/model/${index}/${step}`,
                    base,
                  ),
                  {
                    method: "POST",
                    headers: {
                      authorization: `Bearer ${await credential()}`,
                      "x-tenant-id": tenantId,
                    },
                    signal: AbortSignal.timeout(120_000),
                  },
                );
                if (!response.ok) {
                  const problem = (await response.json().catch(() => null)) as {
                    error?: string;
                  } | null;
                  throw new Error(
                    problem?.error?.startsWith("workbench.")
                      ? problem.error
                      : "workbench.model_execution_failed",
                  );
                }
                const answer = (await response.json()) as SourceExecution;
                inputTokens =
                  inputTokens === null || answer.inputTokens === null
                    ? null
                    : inputTokens + answer.inputTokens;
                outputTokens =
                  outputTokens === null || answer.outputTokens === null
                    ? null
                    : outputTokens + answer.outputTokens;
                costUsd =
                  costUsd === null || answer.costUsd === null
                    ? null
                    : costUsd + answer.costUsd;
                const action = answer.actual as {
                  action?: string;
                  skillId?: string;
                  input?: unknown;
                  output?: unknown;
                };
                if (action?.action === "final") {
                  final = {
                    ...answer,
                    actual: action.output,
                    inputTokens,
                    outputTokens,
                    costUsd,
                  };
                  break;
                }
                if (action?.action !== "skill" || !action.skillId)
                  throw new Error("workbench.agent_action_invalid");
                const pin = source.config.skillRefs.find(
                  (ref) => ref.id === action.skillId,
                );
                if (!pin) throw new Error("workbench.skill_not_attached");
                const revision = (
                  await db.query(
                    "select revision from harness_control.workspace_revisions where tenant_id=$1 and workspace_id=$2 and digest=$3 order by revision desc limit 1",
                    [tenantId, pin.id, pin.digest],
                  )
                ).rows[0];
                if (!revision)
                  throw new Error("workbench.skill_revision_missing");
                const skill = (
                  await getWorkspace(db, tenantId, pin.id, revision.revision)
                ).source;
                if (
                  skill.config.kind !== "skill" ||
                  skill.config.engine === "agent"
                )
                  throw new Error("workbench.skill_engine_invalid");
                const started = Date.now();
                const output = await executeConfiguredSourceCase(
                  skill,
                  action.input,
                  env,
                );
                const receipt: ToolReceipt = {
                  skillId: pin.id,
                  sourceDigest: pin.digest,
                  input: action.input,
                  output: output.actual,
                  durationMs: Date.now() - started,
                };
                receiptBytes += Buffer.byteLength(JSON.stringify(receipt));
                if (receiptBytes > 1_000_000)
                  throw new Error("workbench.result_limit_exceeded");
                receipts.push(receipt);
                await db.query(
                  "insert into harness_control.workspace_tool_receipts(tenant_id,evaluation_id,case_index,step_index,receipt) values($1,$2,$3,$4,$5::jsonb)",
                  [
                    tenantId,
                    report.evaluationId,
                    index,
                    step,
                    JSON.stringify(receipt),
                  ],
                );
              }
              if (!final) throw new Error("workbench.agent_step_limit");
              result = final;
            } else
              result = await executeConfiguredSourceCase(
                source,
                test.input,
                env,
              );
            if (source.config.engine === "agent")
              await validateAgentValue(
                source,
                source.config.outputSchema,
                result.actual,
                env,
              );
            const failures = assertionFailures(test, result.actual);
            const caseResult: EvaluationCase = {
              id: test.id,
              status: failures.length ? "failed" : "passed",
              ...result,
              expected: test.expected ?? null,
              receipts,
              failures,
              durationMs: Date.now() - started,
            };
            reportBytes += Buffer.byteLength(JSON.stringify(caseResult));
            if (reportBytes > 1_000_000)
              throw new Error("workbench.result_limit_exceeded");
            cases.push(caseResult);
          } catch (error) {
            const resultLimit =
              error instanceof Error &&
              error.message === "workbench.result_limit_exceeded";
            cases.push({
              id: test.id,
              status: "error",
              actual: null,
              expected: resultLimit ? null : (test.expected ?? null),
              receipts: resultLimit ? [] : receipts,
              failures: [
                error instanceof Error && error.message.startsWith("workbench.")
                  ? error.message
                  : "Execution failed or exceeded its limits.",
              ],
              durationMs: Date.now() - started,
              inputTokens: null,
              outputTokens: null,
              costUsd: null,
              traceId: null,
            });
            if (resultLimit) break;
          }
        }
        await finishWorkspaceEvaluation(db, {
          tenantId,
          id: report.evaluationId,
          owner,
          status: cases.some((row) => row.status === "error")
            ? "error"
            : cases.some((row) => row.status === "failed")
              ? "failed"
              : "passed",
          cases,
          error: null,
        });
      } catch {
        await finishWorkspaceEvaluation(db, {
          tenantId,
          id: report.evaluationId,
          owner,
          status: "error",
          cases,
          error: "workbench.evaluation_failed",
        });
      } finally {
        clearInterval(lease);
      }
    } catch (error) {
      app.log.error(
        { code: "workbench.worker_failed" },
        "Evaluation queue could not be processed",
      );
    } finally {
      busy = false;
    }
  };
  let timer: ReturnType<typeof setInterval>;
  app.addHook("onReady", async () => {
    timer = setInterval(() => {
      if (!busy && !stopped) running = tick();
    }, 1000);
    timer.unref();
  });
  app.addHook("onClose", async () => {
    stopped = true;
    clearInterval(timer);
    await running;
  });
}
