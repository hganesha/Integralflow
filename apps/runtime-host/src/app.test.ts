import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { harnessPlanV2Schema } from "@ehf/contracts";
import { buildRuntimeHost } from "./app.js";

/** A schema-valid invocation built on the checked-in compiled plan. */
function invocationPayload() {
  const plan = harnessPlanV2Schema.parse(JSON.parse(readFileSync(
    new URL("../../../packages/contracts/test-fixtures/conformance.plan.json", import.meta.url),
    "utf8",
  )));
  return {
    contractVersion: "runtime.invocation.v2",
    invocationId: "INV-1",
    runId: "RUN-1",
    attempt: 1,
    workerId: "worker-1",
    leaseId: "RUN-1:1:1",
    fencingEpoch: 1,
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    planDigest: plan.planDigest,
    executionProfileDigest: "a".repeat(64),
    executionGrant: "grant-token",
    plan,
    input: {},
  };
}

describe("runtime host", () => {
  it("serves only the platform's own health routes", async () => {
    const app = buildRuntimeHost({ authToken: "secret", execute: async () => ({}) });
    expect((await app.inject({ method: "GET", url: "/health/ready" })).statusCode).toBe(503);
    expect((await app.inject({ method: "GET", url: "/readiness" })).statusCode).toBe(404);
    await app.close();
  });

  it("rejects unauthenticated invocation", async () => {
    const app = buildRuntimeHost({ authToken: "secret", execute: async () => ({}) });
    const response = await app.inject({ method: "POST", url: "/invocations", payload: {} });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("supports an asynchronous workload-identity verifier", async () => {
    const app = buildRuntimeHost({
      authorize: async (authorization) => authorization === "Bearer workload-token",
      execute: async () => ({}),
    });
    expect((await app.inject({ method: "GET", url: "/invocations/INV-1" })).statusCode).toBe(401);
    expect((await app.inject({
      method: "GET", url: "/invocations/INV-1", headers: { authorization: "Bearer workload-token" },
    })).statusCode).toBe(200);
    await app.close();
  });

  it("trusts the Databricks Apps proxy identity only for the configured dispatcher principals", async () => {
    expect(() => buildRuntimeHost({ databricksApp: { allowedPrincipals: [] }, execute: async () => ({}) })).toThrow("runtime_host.databricks_principals_missing");
    expect(() => buildRuntimeHost({ databricksApp: { allowedPrincipals: ["sp"] }, authToken: "secret", execute: async () => ({}) })).toThrow("runtime_host.authorization_ambiguous");
    const app = buildRuntimeHost({ databricksApp: { allowedPrincipals: ["0f1e-dispatcher-sp"] }, execute: async () => ({}) });
    // A bearer alone is not identity here: the Apps proxy has already consumed it.
    expect((await app.inject({ method: "GET", url: "/invocations/INV-1", headers: { authorization: "Bearer anything" } })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/invocations/INV-1", headers: { "x-forwarded-user": "someone-else" } })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/invocations/INV-1", headers: { "x-forwarded-user": "0F1E-dispatcher-sp" } })).statusCode).toBe(200);
    await app.close();
  });

  it("rejects malformed invocation before execution", async () => {
    let called = false;
    const app = buildRuntimeHost({ authToken: "secret", execute: async () => { called = true; } });
    const response = await app.inject({
      method: "POST",
      url: "/invocations",
      headers: { authorization: "Bearer secret" },
      payload: { contractVersion: "runtime.invocation.v2" },
    });
    expect(response.statusCode).toBe(400);
    expect(called).toBe(false);
    await app.close();
  });

  it("accepts the bare invocation and returns the bare result", async () => {
    const invocation = invocationPayload();
    const app = buildRuntimeHost({
      authToken: "secret",
      execute: async () => ({
        contractVersion: "runtime.result.v1",
        invocationId: invocation.invocationId,
        runId: invocation.runId,
        status: "completed",
        output: { ok: true },
        errorCode: null,
        checkpointId: null,
        providerMetadata: {},
      }),
    });
    const response = await app.inject({
      method: "POST", url: "/invocations",
      headers: { authorization: "Bearer secret" },
      payload: invocation,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "completed", output: { ok: true }, providerMetadata: { host: "local_http" } });
    // The vendor-specific wrapped form is gone: a wrapped body is not an invocation.
    const wrapped = await app.inject({ method: "POST", url: "/invocations", headers: { authorization: "Bearer secret" }, payload: { message: invocation } });
    expect(wrapped.statusCode).toBe(400);
    await app.close();
  });
});

describe("invocation lifecycle", () => {
  it("reports an unseen invocation as unknown", async () => {
    const app = buildRuntimeHost({ authToken: "secret", execute: async () => ({}) });
    const response = await app.inject({
      method: "GET", url: "/invocations/INV-unseen", headers: { authorization: "Bearer secret" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().state).toBe("unknown");
    await app.close();
  });

  it("refuses status and cancellation without the host credential", async () => {
    const app = buildRuntimeHost({ authToken: "secret", execute: async () => ({}) });
    expect((await app.inject({ method: "GET", url: "/invocations/INV-1" })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/invocations/INV-1/cancel" })).statusCode).toBe(401);
    await app.close();
  });

  it("cancels an in-flight invocation through its signal", async () => {
    let observed: AbortSignal | undefined;
    let signalStarted = (): void => {};
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    const app = buildRuntimeHost({
      authToken: "secret",
      execute: async (request, signal) => {
        observed = signal;
        signalStarted();
        await new Promise((resolve) => signal?.addEventListener("abort", resolve, { once: true }));
        return {
          contractVersion: "runtime.result.v1",
          invocationId: (request as { invocationId: string }).invocationId,
          runId: (request as { runId: string }).runId,
          status: "failed", output: null, errorCode: "runtime.cancelled",
          checkpointId: null, providerMetadata: {},
        };
      },
    });
    const invocation = app.inject({
      method: "POST", url: "/invocations",
      headers: { authorization: "Bearer secret" },
      payload: invocationPayload(),
    });
    await started;
    const cancelled = await app.inject({
      method: "POST", url: "/invocations/INV-1/cancel", headers: { authorization: "Bearer secret" },
    });
    expect(cancelled.statusCode).toBe(202);
    expect(observed?.aborted).toBe(true);
    expect((await invocation).json().errorCode).toBe("runtime.cancelled");
    await app.close();
  });

  it("deduplicates an invocation ID and rejects a conflicting reuse", async () => {
    const request = invocationPayload();
    let calls = 0;
    let finish = (): void => {};
    const released = new Promise<void>((resolve) => { finish = resolve; });
    const app = buildRuntimeHost({
      authToken: "secret",
      execute: async () => {
        calls += 1;
        await released;
        return {
          contractVersion: "runtime.result.v1",
          invocationId: request.invocationId,
          runId: request.runId,
          status: "completed",
          output: { ok: true },
          errorCode: null,
          checkpointId: null,
          providerMetadata: {},
        };
      },
    });
    const options = {
      method: "POST" as const,
      url: "/invocations",
      headers: { authorization: "Bearer secret" },
      payload: request,
    };
    const first = app.inject(options);
    const duplicate = app.inject(options);
    await vi.waitFor(() => expect(calls).toBe(1));
    finish();
    expect((await first).statusCode).toBe(200);
    expect((await duplicate).statusCode).toBe(200);
    expect(calls).toBe(1);

    const conflict = await app.inject({ ...options, payload: { ...request, input: { changed: true } } });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error).toBe("runtime_host.invocation_conflict");
    expect(calls).toBe(1);
    await app.close();
  });

});


describe("request admission", () => {
  it("bounds requests per peer and rejects forwarding-header spoofing", async () => {
    const app = buildRuntimeHost({ authToken: "secret", execute: async () => ({}),readiness:async()=>({status:"ready",checks:[]}) });
    app.log.level = "silent";
    try {
      for (let i = 0; i < 1000; i++) {
        const response = await app.inject({ method: "GET", url: "/health/ready", remoteAddress: "192.0.2.1" });
        expect(response.statusCode).toBe(200);
      }
      const denied = await app.inject({ method: "GET", url: "/health/ready", remoteAddress: "192.0.2.1", headers: { "x-forwarded-for": "192.0.2.99" } });
      expect(denied.statusCode).toBe(429);
      expect(Number(denied.headers["retry-after"])).toBeGreaterThan(0);
      expect((await app.inject({ method: "GET", url: "/health/ready", remoteAddress: "192.0.2.2" })).statusCode).toBe(200);
    } finally { await app.close(); }
  });
});
