import { assertPlatformInvariants, MECHANISM_REQUIREMENTS } from "@ehf/identity";
import { buildControlApi } from "./app.js";

// Refuse to start with an unknown or production-forbidden mechanism, a shared secret or
// static token under the production profile, or a password-bearing database URL, rather
// than serving traffic that silently accepts them.
assertPlatformInvariants({
  mechanisms: ["IDENTITY_PROVIDER", "WORKLOAD_AUTH", "ENVELOPE_SIGNER", "ENVELOPE_VERIFIER", "DATABASE_AUTH", "TELEMETRY_EXPORTER"],
  forbidden: ["EDGE_SERVICE_TOKEN", "RUNTIME_SERVICE_TOKEN", "INTEGRATION_SERVICE_TOKEN", "GATEWAY_SERVICE_TOKEN", "CASE_API_SERVICE_TOKEN",
    "CONTROL_API_SERVICE_TOKEN", "EXECUTION_ENVELOPE_SECRET", "CONTEXT_TRAVERSAL_SECRET", "INTEGRATION_ENVELOPE_SECRET", "RUNTIME_GRANT_SECRET"],
  required: ["METERED_MONTHLY_LIMIT_USD"],
  requiredFor: {
    ...MECHANISM_REQUIREMENTS,
    "ENVELOPE_SIGNER=private_key": ["EXECUTION_ENVELOPE_PRIVATE_KEY_FILE", "EXECUTION_ENVELOPE_KEY_ID"],
    "ENVELOPE_VERIFIER=public_key": ["INTEGRATION_ENVELOPE_PUBLIC_KEY_PEM", "RUNTIME_GRANT_PUBLIC_KEY_PEM"],
  },
});

await buildControlApi().listen({ host: "0.0.0.0", port: Number(process.env.CONTROL_API_PORT ?? process.env.PORT ?? 4100) });
