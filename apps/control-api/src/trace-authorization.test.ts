import { expect, it, vi } from "vitest";
import type { Database } from "@ehf/persistence";
import { buildControlApi } from "./app.js";

it("authorizes trace roles and all linked run tenants before disclosure", async () => {
  const edge = "edge-test-credential-000000000001";
  const query = vi.fn(async (): Promise<{ rows: Record<string, unknown>[] }> => ({ rows: [{ tenant_id: "tenant_other" }] }));
  const app = buildControlApi({ db: { query } as unknown as Database, env: { EDGE_SERVICE_TOKEN: edge } });
  app.log.level = "silent";
  // Startup housekeeping may query the database; count only what the requests below do.
  await app.ready();
  query.mockClear();
  const url = `/v1/traces/${"a".repeat(32)}/authority`;
  const headers = { authorization: `Bearer ${edge}`, "x-actor-id": "operator", "x-actor-roles": "Case.Analyst" };
  try {
    expect((await app.inject({ url, headers })).statusCode).toBe(403);
    expect(query).not.toHaveBeenCalled();
    headers["x-actor-roles"] = "Harness.Operator";
    expect((await app.inject({ url, headers })).statusCode).toBe(404);
    query.mockResolvedValue({ rows: [{ tenant_id: "tenant_demo" }, { tenant_id: "tenant_other" }] });
    expect((await app.inject({ url, headers })).statusCode).toBe(404);
    const runRoot = {
      tenant_id: "tenant_demo", run_id: "run-1", root_span_id: "b".repeat(16), trace_flags: 1,
      started_at: new Date("2026-11-12T20:29:45.000Z"), completed_at: new Date("2026-11-12T20:29:50.000Z"),
    };
    query.mockResolvedValue({ rows: [runRoot] });
    const allowed = await app.inject({ url, headers });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json()).toEqual({
      traceId: "a".repeat(32),
      roots: [{ runId: "run-1", spanId: "b".repeat(16), sampled: true,
        startedAt: runRoot.started_at.toISOString(), completedAt: runRoot.completed_at.toISOString() }],
    });
  } finally { await app.close(); }
});
