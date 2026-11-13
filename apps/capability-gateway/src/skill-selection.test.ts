import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { mintExecutionEnvelope } from "@ehf/execution-auth";
import type { EffectClass } from "@ehf/contracts";
import type { Database } from "@ehf/persistence";
import { buildGateway } from "./app.js";

const SECRET = "test-execution-envelope-secret-value";
const RUNTIME_TOKEN = "runtime-service-token-for-tests-01";
const plan = JSON.parse(readFileSync(new URL("../../../packages/contracts/test-fixtures/skill-bound.plan.json", import.meta.url), "utf8")) as {
  planDigest: string; permissionEnvelopes: Array<{ nodeId: string; digest: string; capabilities: string[]; effects: EffectClass[] }>;
};
const envelope = plan.permissionEnvelopes.find((item) => item.nodeId === "sanctions-screen")!;

const runRow = {
  run_id: "RUN-1", idempotency_key: "k", plan_digest: plan.planDigest, status: "running", terminal_outcome: null, input: {}, output: null,
  attempt: 1, fencing_epoch: 1, latest_checkpoint_id: null, current_node_id: null, error_code: null, trace_id: null, root_span_id: null,
  trace_flags: null, cost_usd: 0, cost_complete: true, model_calls: 0, capability_calls: 0,
  created_at: new Date(), started_at: null, completed_at: null, updated_at: new Date(),
};

function database(receipts: unknown[][]): Database {
  const query = async (text: string, values: unknown[] = []) => {
    if (text.includes("select fencing_epoch")) return { rowCount: 1, rows: [{ fencing_epoch: 1 }] };
    if (text.includes("from harness_control.plans")) return { rowCount: 1, rows: [{ plan }] };
    if (text.includes("insert into harness_gateway.receipts")) {
      receipts.push(values);
      return { rowCount: 1, rows: [{ result: null }] };
    }
    if (text.includes("from harness_runtime.runs")) return { rowCount: 1, rows: [runRow] };
    return { rowCount: 1, rows: [] };
  };
  return { query, connect: async () => ({ query, release: () => {} }), end: async () => {} } as unknown as Database;
}

const FRESH = new Date(Date.now() - 3_600_000).toISOString();
/** What the operator attests for this tenant: the wiring OpenSanctions connectors, US and GB, a fresh list. */
const COVERAGE = {
  "wiring:opensanctions:*": { entitled: true, jurisdictions: ["US", "GB"], lists: { mode: "snapshot", items: [{ id: "us-ofac-sdn", asOf: FRESH, maxAgeHours: 24 }] } },
};

/** `coverage: null` leaves the setting unconfigured. */
async function invoke(skill: Record<string, unknown> | undefined, receipts: unknown[][], coverage: unknown = COVERAGE, extraEnv: Record<string, string> = {}) {
  const app = buildGateway({
    db: database(receipts),
    executionSecret: SECRET,
    env: { ...(coverage === null ? {} : { CONNECTOR_COVERAGE_JSON: JSON.stringify(coverage) }), ...extraEnv },
    serviceGrants: [{ token: RUNTIME_TOKEN, subjectId: "harness-runtime", roles: ["Capability.Invoke"], tenantId: "tenant_demo" }],
  });
  app.log.level = "silent";
  const invocationId = "RUN-1:sanctions-screen:skill";
  const token = await mintExecutionEnvelope({
    secret: SECRET, tenantId: "tenant_demo", caseId: "case-1", runId: "RUN-1", nodeId: "sanctions-screen", attempt: 1,
    planDigest: plan.planDigest, permissionDigest: envelope.digest, capabilities: envelope.capabilities, effects: envelope.effects,
    fencingEpoch: 1, invocationId,
  });
  try {
    return await app.inject({
      method: "POST", url: "/v1/invoke",
      headers: { authorization: `Bearer ${RUNTIME_TOKEN}`, "x-execution-envelope": token },
      payload: { invocationId, capabilityId: "screening.sanctions.v1", effect: "read", input: { name: "Acme" }, ...(skill ? { skill } : {}) },
    });
  } finally {
    await app.close();
  }
}

const selection = {
  skillId: "screening.sanctions.execute", skillVersion: "0.1.0", selectedCapabilityId: "screening.sanctions.v1",
  selectedConnectorId: "wiring:opensanctions:screening.sanctions", candidateIndex: 2, reason: "fallback_after_timeout:candidate_0",
  jurisdiction: "US",
};

describe("skill selection at the gateway", () => {
  it("refuses a selection that is not a pinned candidate of the admitted plan", async () => {
    for (const forged of [
      { ...selection, candidateIndex: 5 },
      { ...selection, selectedConnectorId: "wiring:lseg-world-check:screening.sanctions" },
      { ...selection, skillVersion: "9.9.9" },
      { ...selection, skillId: "screening.pep.execute" },
    ]) {
      const receipts: unknown[][] = [];
      const response = await invoke(forged, receipts);
      expect(response.statusCode).toBe(403);
      expect(response.json().error).toBe("gateway.skill_selection_denied");
      expect(receipts).toHaveLength(0);
    }
  });

  it("records the selection on the receipt and calls the candidate's pinned connector", async () => {
    const receipts: unknown[][] = [];
    const response = await invoke(selection, receipts);
    expect(receipts).toHaveLength(1);
    expect(JSON.parse(receipts[0]!.at(-1) as string)).toEqual(selection);
    // The pinned wiring connector, not the capability's default OpenSanctions binding, was
    // called; this gateway has no wiring service configured, so the adapter refuses.
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("gateway.kyc_wiring_not_configured");
  });

  it("refuses a candidate call that names no selection", async () => {
    const receipts: unknown[][] = [];
    const response = await invoke(undefined, receipts);
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toBe("gateway.skill_selection_denied");
    expect(receipts).toHaveLength(0);
  });

  it("refuses a connector the operator has not attested for the policy, before any receipt or provider call", async () => {
    const stale = new Date(Date.now() - 72 * 3_600_000).toISOString();
    const entry = COVERAGE["wiring:opensanctions:*"];
    for (const [coverage, skill, reason] of [
      [null, selection, "coverage_unregistered"],
      [{}, selection, "coverage_unregistered"],
      [{ "opensanctions:*": entry }, selection, "coverage_unregistered"],
      [{ "wiring:opensanctions:*": { ...entry, entitled: false } }, selection, "entitlement_missing"],
      [COVERAGE, { ...selection, jurisdiction: undefined }, "jurisdiction_unknown"],
      [COVERAGE, { ...selection, jurisdiction: "DE" }, "jurisdiction_not_covered"],
      [{ "wiring:opensanctions:*": { ...entry, lists: null } }, selection, "list_freshness_unknown"],
      [{ "wiring:opensanctions:*": { ...entry, lists: { mode: "snapshot", items: [{ id: "us-ofac-sdn", asOf: stale, maxAgeHours: 24 }] } } }, selection, "list_stale"],
    ] as const) {
      const receipts: unknown[][] = [];
      const response = await invoke(skill, receipts, coverage);
      expect(response.statusCode, reason).toBe(403);
      expect(response.json().error).toBe(`gateway.skill_coverage_denied:${reason}`);
      expect(receipts).toHaveLength(0);
    }
  });

  it("accepts an exact connector entry over a prefix, any-jurisdiction claims and provider-hosted lists", async () => {
    const receipts: unknown[][] = [];
    const response = await invoke({ ...selection, jurisdiction: "DE" }, receipts, {
      "wiring:opensanctions:*": { entitled: false, jurisdictions: [], lists: null },
      "wiring:opensanctions:screening.sanctions": { entitled: true, jurisdictions: ["*"], lists: { mode: "provider_hosted", attestedBy: "vendor contract 2026-01" } },
    });
    expect(receipts).toHaveLength(1);
    expect(response.json().error).toBe("gateway.kyc_wiring_not_configured");
  });

  it("falls back to the shipped coverage file, which a setting replaces entirely, and refuses an invalid file at start", async () => {
    const sandbox = { CONNECTOR_COVERAGE_PATH: fileURLToPath(new URL("../../../config/connector-coverage.sandbox.json", import.meta.url)) };
    const allowed: unknown[][] = [];
    await invoke(selection, allowed, null, sandbox);
    expect(allowed).toHaveLength(1);
    const unlicensed = await invoke({ ...selection, candidateIndex: 1, selectedConnectorId: "wiring:dow-jones-risk-compliance:screening.sanctions" }, [], null, sandbox);
    expect(unlicensed.json().error).toBe("gateway.skill_coverage_denied:entitlement_missing");
    const replaced = await invoke(selection, [], {}, sandbox);
    expect(replaced.json().error).toBe("gateway.skill_coverage_denied:coverage_unregistered");
    const invalid = join(mkdtempSync(join(tmpdir(), "coverage-")), "coverage.json");
    writeFileSync(invalid, JSON.stringify({ "x:y": { entitled: "yes", jurisdictions: [] } }));
    expect(() => buildGateway({ db: database([]), executionSecret: SECRET, env: { CONNECTOR_COVERAGE_PATH: invalid } }))
      .toThrow("gateway.connector_coverage_file_invalid:x:y.entitled");
  });
});
