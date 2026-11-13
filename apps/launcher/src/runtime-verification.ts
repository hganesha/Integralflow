import { boundedJson } from "./network.js";

/** Verify reachability without hiding the test recipe's explicit durability limit. */
export function checkServiceReadiness(body: any, endpoint: URL, runtime: URL, checkpointBackend?: string): string | null {
  if (body.status === "ready") return null;
  const checks = body.checks;
  if (body.status === "degraded" && endpoint.origin === runtime.origin && checkpointBackend === "memory" &&
      Array.isArray(checks) && checks.length > 1 &&
      checks.filter(row => row?.name === "Checkpoint storage" && row.status === "Degraded").length === 1 &&
      checks.every(row => row?.name === "Checkpoint storage" ? row.status === "Degraded" : row?.status === "Ready")) {
    return "runtime.in_memory_checkpoints_restart_recovery_unavailable";
  }
  throw new Error("verification.service_not_ready");
}

function target(value: string, code = "verification.target_invalid"): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error(code);
  return url;
}

export async function verifyRuntime(env: NodeJS.ProcessEnv, token: () => Promise<string>, fetcher: typeof fetch = fetch) {
  const endpoints: string[] = JSON.parse(env.DEPLOYMENT_VERIFY_TARGETS ?? "[]");
  if (!Array.isArray(endpoints) || endpoints.length < 6 || endpoints.length > 8) throw new Error("verification.targets_invalid");
  const runtime = target(env.DEPLOYMENT_RUNTIME_ENDPOINT!, "verification.runtime_invalid");
  const warnings: string[] = [];
  for (const endpoint of endpoints) {
    const url = target(endpoint);
    const body = await boundedJson(await fetcher(new URL("/health/ready", url), { redirect: "error", signal: AbortSignal.timeout(15000) }));
    const warning = checkServiceReadiness(body, url, runtime, env.DEPLOYMENT_RUNTIME_CHECKPOINT_BACKEND);
    if (warning) warnings.push(warning);
  }
  const hosts: string[] = JSON.parse(env.DEPLOYMENT_VERIFY_HOSTS ?? "[]");
  if (!Array.isArray(hosts) || hosts.length > 5) throw new Error("verification.targets_invalid");
  for (const host of hosts) {
    const response = await fetcher(new URL("/healthz", target(host)), { redirect: "error", signal: AbortSignal.timeout(15000) });
    await response.body?.cancel();
    if (!response.ok) throw new Error("verification.service_not_ready");
  }
  const statusUrl = new URL(`/invocations/onboarding-${env.DEPLOYMENT_JOB_ID}`, runtime);
  const anonymous = await fetcher(statusUrl, { redirect: "error", signal: AbortSignal.timeout(15000) });
  await anonymous.body?.cancel();
  if (anonymous.status !== 401 && anonymous.status !== 403) throw new Error("verification.runtime_accepts_anonymous");
  const body = await boundedJson(await fetcher(statusUrl, { headers: { authorization: `Bearer ${await token()}` }, redirect: "error", signal: AbortSignal.timeout(15000) }));
  if (body.contractVersion !== "runtime.status.v1" || body.state !== "unknown") throw new Error("verification.runtime_contract_failed");
  if (env.DEPLOYMENT_VERIFY_DOCUMENT_STUDIO) {
    const control = target(env.DEPLOYMENT_VERIFY_DOCUMENT_STUDIO);
    const response = await fetcher(new URL("/internal/deployment/document-studio/verify", control), {
      method: "POST", headers: { authorization: `Bearer ${await token()}` }, redirect: "error", signal: AbortSignal.timeout(420_000),
    });
    if (!response.ok || (await boundedJson(response)).status !== "ready") throw new Error("deployment.document_studio_verification_failed");
  }
  return { status: "passed", services: endpoints.length, hostedServices: hosts.length, warnings, workloadAuthorization: "verified", runtimeControlPlaneRoundTrip: "verified", businessProcessExecution: "requires-published-process-flow" };
}
