import { assertPlatformInvariants, isProductionProfile, MECHANISM_REQUIREMENTS, PlatformConfigError } from "@ehf/identity";
import { initializeTelemetry } from "@ehf/telemetry";
import { buildGateway } from "./app.js";

// Fail to boot rather than serve traffic with a development credential under the
// production profile. A shared HMAC secret and a static service token are development
// conveniences; anywhere else they are an authentication bypass, and a degraded verifier
// is not a state to serve from.
assertPlatformInvariants({
  mechanisms: ["IDENTITY_PROVIDER", "WORKLOAD_AUTH", "ENVELOPE_VERIFIER", "DATABASE_AUTH", "TELEMETRY_EXPORTER"],
  forbidden: ["EXECUTION_ENVELOPE_SECRET", "RUNTIME_SERVICE_TOKEN", "EDGE_SERVICE_TOKEN", "GATEWAY_SERVICE_TOKEN", "SKILL_HOST_GATEWAY_TOKEN", "CONTROL_API_SERVICE_TOKEN"],
  requiredFor: {
    ...MECHANISM_REQUIREMENTS,
    "ENVELOPE_VERIFIER=public_key": ["EXECUTION_ENVELOPE_PUBLIC_KEY_PEM"],
  },
});
// The recorded model fallback is never honoured in production; refuse a configuration
// that asks for it rather than ignoring the request silently.
if (isProductionProfile() && process.env.MODEL_RECORDED_FALLBACK === "allow") {
  throw new PlatformConfigError("platform.production_forbids:MODEL_RECORDED_FALLBACK=allow");
}

const port = Number(process.env.GATEWAY_PORT ?? process.env.PORT ?? 4101);
const telemetry = initializeTelemetry({ serviceName: "harness-capability-gateway" });
const app = buildGateway();
await app.listen({ host: "0.0.0.0", port });
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    void app.close().finally(() => telemetry.shutdown());
  });
}
