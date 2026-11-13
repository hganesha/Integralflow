import { createCaseStore } from "@ehf/case-store";
import { IntegrationControlPlaneOutboxSink, LoggingOutboxSink, startOutboxRelay } from "@ehf/case-store/outbox-relay";
import { assertPlatformInvariants, createWorkloadAuthorization, MECHANISM_REQUIREMENTS } from "@ehf/identity";
import { initializeTelemetry } from "@ehf/telemetry";
import { buildCaseApi } from "./app.js";

assertPlatformInvariants({
  mechanisms: ["IDENTITY_PROVIDER", "WORKLOAD_AUTH", "ENVELOPE_VERIFIER", "DATABASE_AUTH", "TELEMETRY_EXPORTER"],
  forbidden: ["EDGE_SERVICE_TOKEN", "RUNTIME_SERVICE_TOKEN", "INTEGRATION_SERVICE_TOKEN", "CASE_API_SERVICE_TOKEN", "EXECUTION_ENVELOPE_SECRET", "CONTEXT_TRAVERSAL_SECRET", "INTEGRATION_ENVELOPE_SECRET"],
  requiredFor: {
    ...MECHANISM_REQUIREMENTS,
    "ENVELOPE_VERIFIER=public_key": ["EXECUTION_ENVELOPE_PUBLIC_KEY_PEM", "INTEGRATION_ENVELOPE_PUBLIC_KEY_PEM"],
  },
});

const port = Number(process.env.CASE_API_PORT ?? process.env.PORT ?? 4102);
const telemetry = initializeTelemetry({ serviceName: "harness-case-service" });
const store = createCaseStore();
const app = buildCaseApi({ store });

// Every case transaction writes an outbox row and nothing ever read them, so the tables
// grew without bound and the "transactional outbox" was decorative. The sink is
// replaceable; what matters is that events leave the table and published rows age out.
const sink = process.env.OUTBOX_SINK === "log"
  ? new LoggingOutboxSink()
  : new IntegrationControlPlaneOutboxSink({
      endpoint: process.env.CONTROL_API_URL ?? "http://control-api:4100",
      // The case API publishes as itself, not as the integration worker.
      authorization: createWorkloadAuthorization({ staticTokenEnv: "CASE_API_SERVICE_TOKEN" }),
    });
const relay = startOutboxRelay(store, sink, {
  ...(process.env.OUTBOX_INTERVAL_MS ? { intervalMs: Number(process.env.OUTBOX_INTERVAL_MS) } : {}),
  retentionDays: Number(process.env.OUTBOX_RETENTION_DAYS ?? 7),
  onError: (error) => app.log.warn({ err: error }, "outbox relay drain failed"),
});

await app.listen({ host: "0.0.0.0", port });
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    relay.stop();
    void app.close().finally(() => telemetry.shutdown());
  });
}
