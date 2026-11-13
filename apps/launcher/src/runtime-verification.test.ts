import { expect, it, vi } from "vitest";
import { checkServiceReadiness, verifyRuntime } from "./runtime-verification.js";

const runtime = new URL("https://runtime.example.com");
const health = { status: "degraded", checks: [
  { name: "Checkpoint storage", status: "Degraded" },
  { name: "Control plane and invocation journal", status: "Ready" },
  { name: "Capability gateway", status: "Ready" },
  { name: "Case API", status: "Ready" },
] };
const endpoints = ["web", "control", "case", "gateway", "runtime", "dispatch", "integration"].map(service => `https://${service}.example.com`);
const env = { DEPLOYMENT_VERIFY_TARGETS: JSON.stringify(endpoints), DEPLOYMENT_RUNTIME_ENDPOINT: runtime.href, DEPLOYMENT_RUNTIME_CHECKPOINT_BACKEND: "memory", DEPLOYMENT_JOB_ID: "test" };

it("retains an explicit durability warning only for the configured runtime memory backend", () => {
  expect(checkServiceReadiness(health, runtime, runtime, "memory")).toBe("runtime.in_memory_checkpoints_restart_recovery_unavailable");
  for (const [body, endpoint, backend] of [
    [health, runtime, undefined], [health, runtime, "postgres"], [health, new URL(endpoints[0]!), "memory"],
    [{ ...health, checks: [...health.checks, { name: "Database", status: "Unavailable" }] }, runtime, "memory"],
    [{ ...health, checks: [{ name: "Checkpoint storage", status: "Degraded" }] }, runtime, "memory"],
    [{ status: "unavailable" }, runtime, "memory"], [{ status: "degraded" }, runtime, "memory"],
  ] as const) expect(() => checkServiceReadiness(body, endpoint, runtime, backend)).toThrow("verification.service_not_ready");
});

it("checks every service, hosted health, anonymous denial and the authenticated runtime round trip", async () => {
  const transport = vi.fn<typeof fetch>(async (url, init) => {
    const target = new URL(String(url));
    if (target.pathname === "/health/ready") return Response.json(target.origin === runtime.origin ? health : { status: "ready" });
    if (target.pathname === "/healthz") return new Response("ok");
    return init?.headers ? Response.json({ contractVersion: "runtime.status.v1", state: "unknown" }) : new Response(null, { status: 401 });
  });
  const result = await verifyRuntime({ ...env, DEPLOYMENT_VERIFY_HOSTS: '["https://skills.example.com"]' }, async () => "private-token", transport);
  expect(result).toMatchObject({ status: "passed", services: 7, hostedServices: 1, runtimeControlPlaneRoundTrip: "verified", warnings: ["runtime.in_memory_checkpoints_restart_recovery_unavailable"] });
  expect(transport).toHaveBeenCalledTimes(10);
  expect(transport.mock.calls.at(-1)?.[1]?.headers).toEqual({ authorization: "Bearer private-token" });
  expect(JSON.stringify(result)).not.toContain("private-token");
});

it.each(["anonymous", "contract", "unavailable", "http", "hosted"])("rejects a failed %s check", async failure => {
  const transport: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path === "/health/ready") return failure === "http" ? new Response(null, { status: 503 }) : Response.json({ status: failure === "unavailable" ? "unavailable" : "ready" });
    if (path === "/healthz") return new Response(null, { status: failure === "hosted" ? 503 : 200 });
    return init?.headers ? Response.json({ contractVersion: failure === "contract" ? "invalid" : "runtime.status.v1", state: "unknown" }) : new Response(null, { status: failure === "anonymous" ? 200 : 403 });
  };
  await expect(verifyRuntime({ ...env, DEPLOYMENT_VERIFY_HOSTS: '["https://skills.example.com"]' }, async () => "private-token", transport)).rejects.toThrow();
});


it("requires the authenticated Studio probe only when document services are enabled", async () => {
  let healthy = true;
  const transport = vi.fn<typeof fetch>(async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path === "/health/ready") return Response.json({ status: "ready" });
    if (path === "/internal/deployment/document-studio/verify") {
      expect(init).toMatchObject({ method: "POST", headers: { authorization: "Bearer projected" } });
      return Response.json({ status: healthy ? "ready" : "unavailable" }, { status: healthy ? 200 : 503 });
    }
    return init?.headers ? Response.json({ contractVersion: "runtime.status.v1", state: "unknown" }) : new Response(null, { status: 403 });
  });
  const configured = { ...env, DEPLOYMENT_VERIFY_DOCUMENT_STUDIO: "https://control.example.com" };
  await expect(verifyRuntime(configured, async () => "projected", transport)).resolves.toMatchObject({ status: "passed" });
  healthy = false;
  await expect(verifyRuntime(configured, async () => "projected", transport)).rejects.toThrow("deployment.document_studio_verification_failed");
});
