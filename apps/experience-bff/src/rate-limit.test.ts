import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";

describe("public edge rate limiting", () => {
  it("limits each client per minute, separately per session, and never limits health probes", async () => {
    const app = buildApp({ env: { ...process.env, RATE_LIMIT_PER_MINUTE: "2" } });
    try {
      const call = (cookie?: string) => app.inject({ url: "/api/v1/catalogs/unknown", headers: cookie ? { cookie } : {} });
      expect((await call("ehf_session=one")).statusCode).not.toBe(429);
      expect((await call("ehf_session=one")).statusCode).not.toBe(429);
      const limited = await call("ehf_session=one");
      expect(limited.statusCode).toBe(429);
      expect(limited.headers["retry-after"]).toBeDefined();
      expect((await call("ehf_session=two")).statusCode).not.toBe(429);
      for (let i = 0; i < 5; i += 1) expect((await app.inject({ url: "/health/ready" })).statusCode).toBe(200);
    } finally { await app.close(); }
  });
});
