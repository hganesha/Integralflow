import { expect, it } from "vitest";
import type { ContextStore } from "@ehf/context-store";
import type { Database } from "@ehf/persistence";
import { buildControlApi } from "./app.js";

const token = "test-edge-credential-00000000001";
const headers = { authorization: `Bearer ${token}`, "x-actor-id": "operator", "x-actor-roles": "Harness.Operator" };
const working = { query: async () => ({ rows: [], rowCount: 0 }) } as unknown as Database;
const failing = { query: async () => { throw new Error("connection refused"); } } as unknown as Database;
function make(options: { db?: Database; contextStore?: ContextStore | null; env?: NodeJS.ProcessEnv; runtime?: number | Error }) {
  const calls: string[] = [];
  const app = buildControlApi({ db: options.db ?? working, contextStore: options.contextStore ?? null, env: options.env ?? {},
    serviceGrants: [{ token, subjectId: "edge", roles: ["Edge.Delegate"], tenantId: "tenant_demo" }],
    fetch: (async (url: URL) => { calls.push(url.toString()); if (options.runtime instanceof Error) throw options.runtime; return new Response("{}", { status: options.runtime ?? 200 }); }) as unknown as typeof fetch });
  app.log.level = "silent";
  return { app, calls };
}
const byId = (body: { components: Array<{ id: string }> }) => Object.fromEntries(body.components.map(item => [item.id, item]));

it("checks the control store, the context store and the runtime host it is configured for", async () => {
  const { app, calls } = make({ contextStore: { db: working } as unknown as ContextStore, env: { RUNTIME_PROVIDER: "hosted_http", RUNTIME_HOSTED_ENDPOINT: "https://runtime.internal.test/invocations" } });
  try {
    const response = await app.inject({ url: "/v1/platform/dependencies", headers });
    expect(response.statusCode).toBe(200);
    const result = byId(response.json());
    expect(result["control-store"]).toMatchObject({ status: "Ready", group: "store" });
    expect(result["context-store"]).toMatchObject({ status: "Ready", group: "store" });
    expect(result["runtime-host"]).toMatchObject({ status: "Ready", group: "runtime" });
    expect(calls).toEqual(["https://runtime.internal.test/health/ready"]);
    expect(response.body).not.toContain("runtime.internal.test");
  } finally { await app.close(); }
});

it("reports a store that does not answer, an unconfigured context store and an unreachable runtime", async () => {
  const down = make({ contextStore: { db: failing } as unknown as ContextStore, runtime: new Error("ENOTFOUND") });
  try {
    const result = byId((await down.app.inject({ url: "/v1/platform/dependencies", headers })).json());
    expect(result["context-store"]).toMatchObject({ status: "Unavailable", detail: "The check failed." });
    expect(result["runtime-host"]).toMatchObject({ status: "Unavailable" });
  } finally { await down.app.close(); }
  const absent = make({ env: { RUNTIME_PROVIDER: "databricks" } });
  try {
    const result = byId((await absent.app.inject({ url: "/v1/platform/dependencies", headers })).json());
    expect(result["context-store"]).toMatchObject({ status: "NotConfigured", latencyMs: null });
    expect(result["runtime-host"]).toMatchObject({ status: "Unknown" });
    expect(absent.calls).toEqual([]);
  } finally { await absent.app.close(); }
});

it("refuses a caller without a platform identity", async () => {
  const { app } = make({});
  try { expect((await app.inject("/v1/platform/dependencies")).statusCode).toBe(401); } finally { await app.close(); }
});
