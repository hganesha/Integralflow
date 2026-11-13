import { describe, expect, it } from "vitest";
import { buildApp, servedOperations } from "./app.js";
import { routePath } from './relay.js';
import { UNAVAILABLE } from './availability.js';

describe("experience-bff", () => {
  it("answers health probes", async () => {
    const app = buildApp();
    expect((await app.inject({ method: "GET", url: "/health/live" })).json()).toEqual({ status: "live" });
    expect((await app.inject({ method: "GET", url: "/health/ready" })).statusCode).toBe(200);
  });

  it("registers every supported non-mock operation at the actual client URL", async () => {
    const app=buildApp();await app.ready();
    const served = servedOperations();
    const missing=served.filter(op=>!app.hasRoute({method:op.method,url:routePath(op)})).map(op=>op.operationId);
    expect(missing).toEqual([]);
    expect(UNAVAILABLE).toEqual({});
    const health=(await app.inject('/health/ready')).json();
    expect(health.registeredOperations).toBe(served.length);
    expect(health.upstreamHealth).toBe('not_probed');
    await app.close();
  });
});
