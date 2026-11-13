import { expect, it } from "vitest";
import type { Database } from "@ehf/persistence";
import { buildControlApi } from "./app.js";

it("rate limits requests before database or authorization work", async () => {
  const app = buildControlApi({ env: { EDGE_SERVICE_TOKEN: "test".repeat(8) }, db: { query: async () => ({ rows: [] }) } as unknown as Database });
  app.log.level = "silent";
  try {
    for (let i = 0; i < 1000; i++) expect((await app.inject("/health/live")).statusCode).toBe(200);
    const response = await app.inject({ method: "GET", url: "/health/live", headers: { "x-forwarded-for": "192.0.2.99" } });
    expect(response.statusCode).toBe(429);
    expect(response.json()).toEqual({ error: "request.rate_limit_exceeded" });
    expect(Number(response.headers["retry-after"])).toBeGreaterThan(0);
  } finally { await app.close(); }
});
