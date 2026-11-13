import { describe, expect, it } from "vitest";
import { mintRuntimeGrant } from "@ehf/execution-auth";
import type { Database } from "@ehf/persistence";
import { applyStateWrite, authorizeStateWrite, parseStateRequest, RuntimeStateAuthorityError } from "./runtime-state-routes.js";

const GRANT_SECRET = "runtime-state-grant-secret-000001";
const run = { runId: "RUN-1", attempt: 2, workerId: "worker-1", fencingEpoch: 4 };

function database(overrides: { status?: string; epoch?: number } = {}): Database {
  return {
    query: async (text: string) => {
      if (text.includes("select fencing_epoch")) {
        return overrides.status && overrides.status !== "running"
          ? { rows: [], rowCount: 0 }
          : { rows: [{ fencing_epoch: overrides.epoch ?? 4 }], rowCount: 1 };
      }
      return {
        rowCount: 1,
        rows: [{
          run_id: "RUN-1", idempotency_key: "k", plan_digest: "a".repeat(64),
          status: overrides.status ?? "running", terminal_outcome: null, input: {}, output: null,
          attempt: 2, fencing_epoch: overrides.epoch ?? 4, latest_checkpoint_id: null,
          current_node_id: null, error_code: null, trace_id: null, root_span_id: null,
          trace_flags: null, cost_usd: 0, cost_complete: true, model_calls: 0, capability_calls: 0,
          created_at: new Date(), started_at: null, completed_at: null, updated_at: new Date(),
        }],
      };
    },
  } as unknown as Database;
}

const grant = (overrides: Partial<{ workerId: string; epoch: number; attempt: number }> = {}) => mintRuntimeGrant({
  secret: GRANT_SECRET, grantId: "INV-1", runId: "RUN-1",
  attempt: overrides.attempt ?? 2, workerId: overrides.workerId ?? "worker-1",
  planDigest: "a".repeat(64), fencingEpoch: overrides.epoch ?? 4, ttlSeconds: 120,
});

describe("runtime state authority", () => {
  it("accepts the worker that still owns the run", async () => {
    await expect(authorizeStateWrite(database(), await grant(), GRANT_SECRET, run)).resolves.toBeUndefined();
  });

  it("refuses a write with no grant", async () => {
    await expect(authorizeStateWrite(database(), undefined, GRANT_SECRET, run))
      .rejects.toThrow("runtime_state.grant_missing");
  });

  it("refuses a worker whose fence has been superseded", async () => {
    // The whole point of the boundary: a runtime that lost its lease keeps a valid grant
    // and must not be able to journal over the attempt that replaced it.
    await expect(authorizeStateWrite(database({ epoch: 9 }), await grant({ epoch: 4 }), GRANT_SECRET, { ...run, fencingEpoch: 4 }))
      .rejects.toThrow("runtime_state.stale_fence");
  });

  it("refuses a grant issued to a different worker", async () => {
    await expect(authorizeStateWrite(database(), await grant({ workerId: "other-worker" }), GRANT_SECRET, run))
      .rejects.toThrow("runtime_state.worker_mismatch");
  });

  it("refuses once the run is no longer running", async () => {
    await expect(authorizeStateWrite(database({ status: "failed" }), await grant(), GRANT_SECRET, run))
      .rejects.toBeInstanceOf(RuntimeStateAuthorityError);
  });

  it("records event correlation from the authorized attempt and fence", async () => {
    let persisted: unknown;
    const db = { connect: async () => ({
      query: async (sql: string, values?: unknown[]) => {
        if (sql.includes("returning event_sequence")) return { rows: [{ event_sequence: 1 }] };
        if (sql.includes("insert into harness_runtime.run_events")) {
          persisted = JSON.parse(String(values?.[6]));
          return { rows: [{ occurred_at: new Date() }] };
        }
        return { rows: [] };
      },
      release: () => {},
    }) } as unknown as Database;
    const parsed = parseStateRequest("events", {
      run, eventKey: "skill:lookup:2", code: "skill.result.needs_evidence", nodeId: "lookup", status: "observed",
      values: { errorCode: "CONTEXT_MISSING", correlation: { attempt: 9, fencingEpoch: 9 } },
    });
    await applyStateWrite(db, "events", parsed.run, parsed.payload);
    expect(persisted).toEqual({ errorCode: "CONTEXT_MISSING", correlation: { attempt: 2, fencingEpoch: 4 } });
  });

  it("separates the fenced run from the operation payload", () => {
    const parsed = parseStateRequest("node-started", { run, nodeId: "lookup", inputDigest: "b".repeat(64) });
    expect(parsed.run).toEqual(run);
    expect(parsed.payload).toEqual({ nodeId: "lookup", inputDigest: "b".repeat(64) });
  });
});

describe("node start with read authority", () => {
  it("issues the case-read envelope through the broker's own checks in the same request", async () => {
    const { buildControlApi } = await import("./app.js");
    const runtimeToken = "runtime-service-token-for-tests-01";
    const base = database();
    const db = { query: async (text: string, values?: unknown[]) => text.includes("harness_control.plans") ? { rows: [], rowCount: 0 } : base.query(text, values) } as unknown as Database;
    const app = buildControlApi({ db, grantSecret: GRANT_SECRET, envelopeSecret: "execution-envelope-secret-000001",
      env: { RUNTIME_SERVICE_TOKEN: runtimeToken } });
    app.log.level = "silent";
    try {
      const headers = { authorization: `Bearer ${runtimeToken}`, "x-runtime-grant": await grant() };
      const body = { run, nodeId: "lookup", inputDigest: "a".repeat(64) };
      expect((await app.inject({ method: "POST", url: "/v1/runtime/state/node-started", headers, payload: body })).statusCode).toBe(204);
      // With the flag the broker runs: here the plan is not admitted, so no envelope is issued.
      const withRead = await app.inject({ method: "POST", url: "/v1/runtime/state/node-started", headers, payload: { ...body, issueCaseReadEnvelope: true } });
      expect(withRead.json().error).toMatch(/^broker\./);
    } finally { await app.close(); }
  });
});
