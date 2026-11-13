import { afterEach, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { validateResponse } from "@ehf/ui-contracts/validate";
const apps: ReturnType<typeof buildApp>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
function make(receipts: unknown[]) {
  const app = buildApp({
    env: { BFF_PUBLIC_ORIGIN: "http://test.local" },
    principalResolver: {
      source: "local",
      resolve: async () => ({
        actorType: "human",
        subjectId: "reader",
        roles: ["Harness.Reader"],
        tenantId: "tenant-test",
        source: "local",
      }),
    },
    upstream: async (service, method, path, principal) => {
      expect(service).toBe("control-api");
      expect(method).toBe("GET");
      expect(path).toBe("/v1/gateway/receipts");
      expect(principal.tenantId).toBe("tenant-test");
      return { status: 200, body: { receipts, nextCursor: null } };
    },
  });
  apps.push(app);
  return app;
}
it("projects persisted receipt metadata and preserves unknown evidence as null", async () => {
  const row = {
    invocationId: "receipt-1",
    runId: "run-1",
    nodeId: "node-1",
    attempt: 1,
    fencingEpoch: 2,
    planDigest: "p",
    permissionDigest: "permission-digest",
    capabilityId: "context.records.fetch.v1",
    effect: "read",
    decision: "allowed",
    reasonCode: "allowed",
    requestDigest: "request-digest",
    result: {
      status: "succeeded",
      latencyMs: 37,
      provider: "openrouter",
      model: "test-model",
      errorCode: null,
      usage: { inputTokens: 21, outputTokens: 8, costUsd: 0.01, private: "omitted" },
      output: { private: "not a browser field" },
    },
    receiptDigest: "result-digest",
    traceId: null,
    spanId: null,
    createdAt: "2026-11-09T12:00:00Z",
    completedAt: "2026-11-09T12:00:01Z",
  };
  const response = await make([
    row,
    { ...row, invocationId: "pending", result: null, receiptDigest: null },
  ]).inject("/api/v1/gateway/decisions");
  expect(response.statusCode, response.body).toBe(200);
  expect(
    validateResponse("getGatewayDecisions", 200, response.json()).valid,
  ).toBe(true);
  expect(response.json().items[0]).toMatchObject({
    receiptId: "receipt-1",
    latencyMs: 37,
    resultStatus: "succeeded",
    provider: "openrouter",
    model: "test-model",
    usage: { inputTokens: 21, outputTokens: 8, costUsd: 0.01 },
    resultDigest: "result-digest",
    envelopeDigest: null,
    idempotencyKey: null,
    adapterBindingId: null,
  });
  expect(response.json().items[1]).toMatchObject({
    latencyMs: null,
    resultStatus: null,
    resultDigest: null,
  });
  expect(response.body).not.toContain("private");
  expect(response.body).not.toContain("permission-digest");
});
it("returns a contract-valid empty receipt page", async () => {
  const response = await make([]).inject("/api/v1/gateway/decisions");
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json()).toMatchObject({ items: [], nextCursor: null });
});
