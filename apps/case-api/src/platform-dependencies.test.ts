import { expect, it } from "vitest";
import type { CaseStore } from "@ehf/case-store";
import { buildCaseApi } from "./app.js";

const edge = "test-edge-credential-00000000001";
const headers = { authorization: `Bearer ${edge}`, "x-actor-id": "analyst", "x-actor-roles": "Harness.Operator" };
function make(store: Partial<CaseStore>) {
  const app = buildCaseApi({ store: { db: { query: async () => ({ rows: [], rowCount: 0 }) }, ownsDatabase: false, evidenceMaxBytes: 1048576, ...store } as unknown as CaseStore,
    serviceGrants: [{ token: edge, subjectId: "edge", tenantId: "tenant_demo", roles: ["Edge.Delegate"] }], executionSecret: "test-execution-secret-0000000001", env: {} });
  app.log.level = "silent";
  return app;
}
const byId = (body: { components: Array<{ id: string }> }) => Object.fromEntries(body.components.map(item => [item.id, item]));

it("checks the case store and reads from the evidence store without writing to it", async () => {
  const calls: string[] = [];
  const blobs = new Proxy({ immutability: "object_lock" }, { get: (target, name: string) => name in target ? (target as Record<string, unknown>)[name]
    : async (...args: unknown[]) => { calls.push(`${name} ${String(args[0])}`); return { exists: false }; } }) as unknown as NonNullable<CaseStore["evidenceBlobs"]>;
  const app = make({ evidenceBlobs: blobs });
  try {
    const response = await app.inject({ url: "/v1/platform/dependencies", headers });
    expect(response.statusCode).toBe(200);
    const result = byId(response.json());
    expect(result["case-store"]).toMatchObject({ status: "Ready", group: "store" });
    expect(result["evidence-store"]).toMatchObject({ status: "Ready", detail: "Reachable; immutability enforced." });
    expect(calls).toEqual(["head .platform-health"]);
  } finally { await app.close(); }
});

it("reports an evidence store that cannot be reached, and evidence kept in the database as not configured", async () => {
  const unreachable = make({ evidenceBlobs: { immutability: "object_lock", head: async () => { throw new Error("blob.azure_request_failed:403:AuthorizationFailure"); } } as unknown as NonNullable<CaseStore["evidenceBlobs"]> });
  try {
    const result = byId((await unreachable.inject({ url: "/v1/platform/dependencies", headers })).json());
    expect(result["evidence-store"]).toMatchObject({ status: "Unavailable", detail: "The check failed." });
  } finally { await unreachable.close(); }
  const inDatabase = make({});
  try {
    expect(byId((await inDatabase.inject({ url: "/v1/platform/dependencies", headers })).json())["evidence-store"]).toMatchObject({ status: "NotConfigured", latencyMs: null });
    expect((await inDatabase.inject("/v1/platform/dependencies")).statusCode).toBe(401);
  } finally { await inDatabase.close(); }
});
