/** Local acceptance stack. Only loopback test stores are accepted; never shipped in the web bundle. */
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { createDatabase } from "../../../packages/persistence/src/index.js";
import { createCaseStore } from "../../../packages/case-store/src/index.js";
import { createContextStore } from "../../../packages/context-store/src/index.js";
import { buildControlApi } from "../../../apps/control-api/src/app.js";
import { buildGateway } from "../../../apps/capability-gateway/src/app.js";
import { buildCaseApi } from "../../../apps/case-api/src/app.js";
import { buildApp } from "../../../apps/experience-bff/src/app.js";

const root = resolve(import.meta.dirname, "../../..");
const database = process.env.WORKBENCH_TEST_DATABASE_URL;
if (
  process.env.SECURITY_PROFILE !== "development" ||
  !database ||
  !["localhost", "127.0.0.1"].includes(new URL(database).hostname)
)
  throw new Error("workbench.loopback_test_database_required");
const base = Number(process.env.WORKBENCH_HTTP_BASE_PORT ?? 5310);
const endpoint = (offset: number) => `http://127.0.0.1:${base + offset}`;
const db = createDatabase(database);
const caseUrl = new URL(database);
caseUrl.pathname = "/ehf_case";
const contextUrl = new URL(database);
contextUrl.pathname = "/ehf_context";
const store = createCaseStore({ connectionString: caseUrl.toString() });
const context = createContextStore({ connectionString: contextUrl.toString() });
const env: NodeJS.ProcessEnv = {
  ...Object.fromEntries(
    ["PATH", "HOME", "TMPDIR", "DOCKER_HOST"].flatMap((key) =>
      process.env[key] ? [[key, process.env[key]]] : [],
    ),
  ),
  SECURITY_PROFILE: "development",
  PLATFORM_TENANT_ID: "tenant_demo",
  DATABASE_URL: database,
  CASE_DATABASE_URL: caseUrl.toString(),
  CONTEXT_DATABASE_URL: contextUrl.toString(),
  EXECUTION_DATABASE_URL: database,
  EDGE_SERVICE_TOKEN: "workbench-local-edge-token-0000001",
  CONTROL_API_SERVICE_TOKEN: "workbench-local-control-token-0001",
  RUNTIME_SERVICE_TOKEN: "workbench-local-runtime-token-0001",
  CASE_API_SERVICE_TOKEN: "workbench-local-case-token-0000001",
  INTEGRATION_SERVICE_TOKEN: "workbench-local-integration-token-1",
  EXECUTION_ENVELOPE_SECRET: "workbench-local-execution-secret-1",
  INTEGRATION_ENVELOPE_SECRET: "workbench-local-integration-secret",
  RUNTIME_GRANT_SECRET: "workbench-local-runtime-grant-secret",
  RUNTIME_HOST_AUTH_TOKEN: "workbench-local-host-token-00000001",
  METERED_MONTHLY_LIMIT_USD: "10",
  WORKBENCH_EVALUATOR_BACKEND: "docker",
  WORKBENCH_EVALUATOR_IMAGE: "ehf-workbench-evaluator:local",
  CONTROL_API_URL: endpoint(0),
  CASE_API_URL: endpoint(2),
  CAPABILITY_GATEWAY_URL: endpoint(1),
  ENVELOPE_BROKER_URL: endpoint(0),
  CONTROL_API_INTERNAL_URL: endpoint(0),
  CASE_API_INTERNAL_URL: endpoint(2),
  CAPABILITY_GATEWAY_INTERNAL_URL: endpoint(1),
  RUNTIME_PROVIDER: "local_http",
  RUNTIME_LOCAL_ENDPOINT: endpoint(3) + "/invocations",
  RUNTIME_CHECKPOINT_BACKEND: "postgres",
  RUNTIME_CHECKPOINT_DATABASE_URL: database,
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT:
    process.env.WORKBENCH_TELEMETRY_URL ?? "http://127.0.0.1:5320/v1/traces",
  WORKER_METRICS_PORT: String(base + 6),
  INTEGRATION_WORKER_PORT: String(base + 7),
  OUTBOX_SINK: "log",
  BFF_PUBLIC_ORIGIN: endpoint(4),
  WEB_ROOT: resolve(root, "apps/web/dist"),
};
const control = buildControlApi({ db, contextStore: context, env });
control.log.level = "warn";
const gateway = buildGateway({ db, env });
gateway.log.level = "warn";
const cases = buildCaseApi({ store, contextStore: context, env });
cases.log.level = "warn";
await control.listen({ host: "127.0.0.1", port: base });
await gateway.listen({ host: "127.0.0.1", port: base + 1 });
await cases.listen({ host: "127.0.0.1", port: base + 2 });
const edge = buildApp({
  env,
  principalResolver: {
    source: "local",
    resolve: async (request) => ({
      source: "local",
      actorType: "human",
      subjectId: String(
        request.headers["x-workbench-user"] ?? "workbench-author",
      ),
      tenantId: "tenant_demo",
      roles: String(
        request.headers["x-workbench-roles"] ??
          "Harness.Author,Harness.Operator,Platform.Admin",
      ).split(","),
    }),
  },
});
edge.log.level = "warn";
await edge.listen({ host: "127.0.0.1", port: base + 4 });
const runtimeEnv = { ...env };
delete runtimeEnv.EXECUTION_ENVELOPE_SECRET;
delete runtimeEnv.RUNTIME_GRANT_SECRET;
const children = [
  spawn(
    process.execPath,
    ["--import", "tsx", "apps/runtime-host/src/server.ts"],
    {
      cwd: root,
      env: {
        ...runtimeEnv,
        RUNTIME_HOST_PORT: String(base + 3),
        PORT: String(base + 3),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  ),
  spawn(
    process.execPath,
    ["--import", "tsx", "apps/runtime-worker/src/worker.ts"],
    { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] },
  ),
  spawn(
    process.execPath,
    ["--import", "tsx", "apps/integration-worker/src/worker.ts"],
    { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] },
  ),
];
for (const child of children) {
  child.stdout?.resume();
  child.stderr?.on("data", (chunk) => process.stderr.write(chunk));
  child.on("exit", (code) => {
    if (code) process.stderr.write(`workbench.child_exited:${code}\n`);
  });
}
console.log(
  `Workbench HTTP acceptance stack: ${endpoint(4)}/platform/workbench`,
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    void (async () => {
      for (const child of children) child.kill("SIGTERM");
      await Promise.all(
        children.map((child) =>
          child.exitCode !== null
            ? Promise.resolve()
            : new Promise((resolve) => child.once("exit", resolve)),
        ),
      );
      await Promise.allSettled([
        edge.close(),
        control.close(),
        gateway.close(),
        cases.close(),
      ]);
      await Promise.allSettled([db.end(), context.db.end(), store.db.end()]);
      process.exit(0);
    })();
  });
