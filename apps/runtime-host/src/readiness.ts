import {
  checkDependency,
  httpHealthCheck,
} from "@ehf/contracts/platform-health";

export function runtimeReadiness(options: {
  checkpointBackend: string;
  checkpoints: () => Promise<unknown>;
  journal: () => Promise<unknown>;
  gatewayUrl: string;
  caseApiUrl: string;
  fetch?: typeof fetch;
}) {
  return async () => {
    const checks = await Promise.all([
      checkDependency(
        { id: "checkpoints", name: "Checkpoint storage", group: "store" },
        async () => {
          await options.checkpoints();
          return options.checkpointBackend === "memory"
            ? {
                status: "Degraded",
                detail:
                  "In-memory checkpoints; restart recovery is unavailable.",
              }
            : {
                status: "Ready",
                detail: "Checkpoint storage and schema are readable.",
              };
        },
      ),
      checkDependency(
        {
          id: "control",
          name: "Control plane and invocation journal",
          group: "service",
        },
        async () => {
          await options.journal();
        },
      ),
      checkDependency(
        { id: "gateway", name: "Capability gateway", group: "service" },
        httpHealthCheck(
          options.fetch ?? fetch,
          new URL("/health/ready", options.gatewayUrl),
        ),
      ),
      checkDependency(
        { id: "cases", name: "Case API", group: "service" },
        httpHealthCheck(
          options.fetch ?? fetch,
          new URL("/health/ready", options.caseApiUrl),
        ),
      ),
    ]);
    return {
      status: checks.some((row) => row.status === "Unavailable")
        ? ("unavailable" as const)
        : checks.some((row) => row.status !== "Ready")
          ? ("degraded" as const)
          : ("ready" as const),
      checks: checks.map((row) => ({
        name: row.name,
        status: row.status,
        detail: row.detail,
      })),
    };
  };
}
