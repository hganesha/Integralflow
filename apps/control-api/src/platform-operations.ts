import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  changeRuntimeAdmission,
  getPlatformQueueState,
  getWorkerHealth,
  getRuntimeAdmission,
  type Database,
} from "@ehf/persistence";
import {
  checkDependency,
  httpHealthCheck,
  notConfigured,
} from "@ehf/contracts/platform-health";
import type { PlatformAction, Principal, ResourceRef } from "@ehf/identity";

export async function workerDependencies(
  env: NodeJS.ProcessEnv,
  fetcher: typeof fetch,
  db: Database,
) {
  const snapshots = await getWorkerHealth(db).catch(() => []);
  const workers = ["runtime-worker", "integration-worker"].map((kind) => {
    const row = snapshots.find((item) => item.kind === kind);
    return {
      id: kind,
      name:
        kind === "runtime-worker" ? "Runtime dispatcher" : "Integration worker",
      group: "service" as const,
      status: !row
        ? ("Unknown" as const)
        : row.ready > 0
          ? row.stale > 0 || row.draining > 0
            ? ("Degraded" as const)
            : ("Ready" as const)
          : row.draining > 0
            ? ("Degraded" as const)
            : ("Unavailable" as const),
      detail: !row
        ? "No worker heartbeat has been recorded."
        : `${row.ready} healthy, ${row.draining} draining, ${row.stale} stale replicas; ${row.in_flight} in flight, ${row.concurrency} slots.`,
      latencyMs: null,
    };
  });
  const collector = {
    id: "telemetry",
    name: "Telemetry receiver",
    group: "service" as const,
  };
  const raw =
    env.TELEMETRY_HEALTH_URL ??
    env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ??
    env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const telemetry = await (async () => {
    if (!raw)
      return notConfigured(collector, "No telemetry endpoint is configured.");
    if (env.OTEL_EXPORTER_OTLP_PROTOCOL === "grpc" && !env.TELEMETRY_HEALTH_URL)
      return {
        ...collector,
        status: "Unknown" as const,
        detail: "Configure a collector health URL for gRPC telemetry.",
        latencyMs: null,
      };
    try {
      const url = new URL(raw);
      if (
        !["https:", "http:"].includes(url.protocol) ||
        url.username ||
        url.password
      )
        throw new Error("invalid");
      if (env.TELEMETRY_HEALTH_URL)
        return checkDependency(collector, httpHealthCheck(fetcher, url));
      if (!env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT)
        url.pathname = url.pathname.replace(/\/$/, "") + "/v1/traces";
      // An empty OTLP export tests the configured ingestion path without case content.
      return checkDependency(collector, async (signal) => {
        const headers: Record<string, string> = {
          "content-type": "application/json",
        };
        for (const part of (env.OTEL_EXPORTER_OTLP_HEADERS ?? "").split(",")) {
          const split = part.indexOf("=");
          if (split > 0)
            headers[part.slice(0, split).trim()] = decodeURIComponent(
              part.slice(split + 1).trim(),
            );
        }
        const response = await fetcher(url, {
          method: "POST",
          headers,
          body: '{"resourceSpans":[]}',
          signal,
          redirect: "error",
        });
        await response.arrayBuffer();
        return response.ok
          ? {
              status: "Ready",
              detail: "The telemetry receiver accepted an empty export.",
            }
          : {
              status:
                response.status === 401 || response.status === 403
                  ? "Degraded"
                  : "Unavailable",
              detail: "The telemetry receiver refused the probe.",
            };
      });
    } catch {
      return {
        ...collector,
        status: "Unavailable" as const,
        detail: "The telemetry endpoint configuration is invalid.",
        latencyMs: null,
      };
    }
  })();
  return [...workers, telemetry];
}

export function registerPlatformOperations(
  app: FastifyInstance,
  options: {
    db: Database;
    env: NodeJS.ProcessEnv;
    fetch: typeof fetch;
    authorize: (
      request: FastifyRequest,
      action: PlatformAction,
      resource?: ResourceRef,
    ) => Promise<Principal>;
  },
) {
  app.get("/v1/deployment/runtime", async (request) => {
    const principal = await options.authorize(request, "capability.read", {
      kind: "runtime-admission",
    });
    return getRuntimeAdmission(options.db, principal.tenantId);
  });
  app.post("/v1/deployment/runtime", async (request, reply) => {
    const principal = await options.authorize(
      request,
      "runtime.admission.write",
      { kind: "runtime-admission" },
    );
    if (principal.actorType !== "human")
      return reply.code(403).send({ error: "authorization.human_required" });
    const parsed = z
      .object({
        operation: z.enum(["stop", "resume"]),
        activeRunPolicy: z.enum(["drain", "cancel"]).default("drain"),
        expectedRevision: z.number().int().nonnegative(),
        reason: z.string().trim().min(3).max(500),
      })
      .strict()
      .safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({
        error: "runtime.admission_request_invalid",
        issues: parsed.error.issues,
      });
    try {
      return await changeRuntimeAdmission(options.db, {
        ...parsed.data,
        tenantId: principal.tenantId,
        actor: principal.subjectId,
      });
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "runtime.admission_revision_conflict"
      )
        return reply.code(409).send({ error: error.message });
      throw error;
    }
  });
  app.get("/v1/platform/operations", async (request) => {
    const principal = await options.authorize(request, "capability.read", {
      kind: "platform-operations",
    });
    const [queue, workers, migrations, admission, replicas] = await Promise.all(
      [
        getPlatformQueueState(options.db, principal.tenantId),
        workerDependencies(options.env, options.fetch, options.db),
        options.db.query<{ version: string | null }>(
          "select max(name) as version from harness_control.schema_migrations",
        ),
        getRuntimeAdmission(options.db, principal.tenantId),
        getWorkerHealth(options.db),
      ],
    );
    return {
      queue,
      workers,
      admission,
      activeWorkers: replicas.length
        ? replicas.reduce((count, row) => count + row.ready, 0)
        : null,
      databaseMigrationVersion: migrations.rows[0]?.version ?? "Not reported",
      generatedAt: new Date().toISOString(),
      runtimeProvider: options.env.RUNTIME_PROVIDER ?? "local_http",
      runtimeMode:
        options.env.MODEL_RESPONSE_MODE === "recorded"
          ? "Recorded"
          : options.env.MODEL_RESPONSE_MODE === "live"
            ? "Live"
            : "Unknown",
      build: {
        apiVersion: options.env.API_VERSION ?? "Not reported",
        uiVersion: options.env.UI_VERSION ?? "Not reported",
        runtimeVersion: options.env.RUNTIME_VERSION ?? "Not reported",
        compilerVersion: options.env.COMPILER_VERSION ?? "Not reported",
        adapterBundleVersion:
          options.env.ADAPTER_BUNDLE_VERSION ?? "Not reported",
        commitSha: options.env.BUILD_COMMIT ?? "Not reported",
        builtAt: options.env.BUILD_TIMESTAMP ?? null,
      },
    };
  });
}
