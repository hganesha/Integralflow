import { buildReferenceSkillHost } from "./app.js";

// Reference skill host (Compose profile `skills`). Local bearer authentication only; it holds
// no provider credentials and reaches nothing but the gateway URL each request names.
const token = process.env.SKILL_HOST_AUTH_TOKEN;
if (!token) throw new Error("skill_host.auth_token_required");
// Development-only: refuse every security profile but development, including unknown ones.
if ((process.env.SECURITY_PROFILE ?? "development") !== "development") throw new Error("skill_host.reference_host_is_development_only");

const app = buildReferenceSkillHost({
  token,
  ...(process.env.SKILL_HOST_GATEWAY_TOKEN ? { gatewayToken: process.env.SKILL_HOST_GATEWAY_TOKEN } : {}),
  ...(process.env.SKILL_HOST_SYNC_WAIT_MS ? { syncWaitMs: Number(process.env.SKILL_HOST_SYNC_WAIT_MS) } : {}),
  logger: true,
});
const port = Number(process.env.SKILL_HOST_PORT ?? 8090);
await app.listen({ host: "0.0.0.0", port });
