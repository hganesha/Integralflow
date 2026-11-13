import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { stableDigest, type HarnessPlanV2 } from "@ehf/contracts";
import { mintDelegatedEnvelope, mintExecutionEnvelope, verifyExecutionEnvelope } from "@ehf/execution-auth";
import { admitPlan, createDatabase, createRun, getSourceDecision, listSourceDecisions, registerSourceArtifact, approveSourceArtifact, revokeArtifactEntry, upsertCapabilityConnector as upsertConnector } from "@ehf/persistence";
import { buildGateway } from "./app.js";
import { createSourceTransport, sourceEndpointAllowed, sourceNativeEndpointAllowed } from "./source-policy.js";

const fixture = JSON.parse(readFileSync(new URL("../../../packages/contracts/test-fixtures/source-policy.json", import.meta.url), "utf8"));
const planFixture = JSON.parse(readFileSync(new URL("../../../packages/contracts/test-fixtures/skill-bound.plan.json", import.meta.url), "utf8"));
const SECRET = "source-policy-test-signing-secret-value";
const TOKEN = "source-policy-test-workload-token";

describe("source transport isolation", () => {
  it("pins endpoint origin and path and refuses encoded path escapes", () => {
    const endpoints = ["https://source.test/api"];
    expect(sourceEndpointAllowed(new URL("https://source.test/api/match?limit=1"), endpoints)).toBe(true);
    for (const url of ["https://source.test/api-other", "https://source.test.evil/api", "http://source.test/api", "https://source.test/api/a%2fb", "https://user@source.test/api", "https://source.test/api#x"]) expect(sourceEndpointAllowed(new URL(url), endpoints)).toBe(false);
  });
  it("keeps concurrent scopes isolated and forces redirect refusal", async () => {
    const fetched: string[] = [];
    const transport = createSourceTransport(async (url, init) => { fetched.push(String(url)); expect(init?.redirect).toBe("error"); return new Response("{}"); }, true);
    await expect(transport.fetch("https://source.test/api")).rejects.toThrow("context_missing");
    const check = async (url: URL) => { await Promise.resolve(); if (url.hostname !== "source.test") throw new Error("endpoint_denied"); };
    const results = await Promise.allSettled([
      transport.run(check, () => transport.fetch("https://source.test/api")),
      transport.run(check, () => transport.fetch("https://other.test/api")),
    ]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
    expect(fetched).toEqual(["https://source.test/api"]);
  });
});

describe.skipIf(!process.env.EHF_TEST_DATABASE_URL)("source policy at the real gateway/database boundary", () => {
  async function setup(mode: "direct" | "selected" | "delegated", options: { primary?: boolean; endpoint?: string } = {}) {
    const db = createDatabase(process.env.EHF_TEST_DATABASE_URL);
    const tenantId = `gateway-source-${randomUUID()}`;
    const binding = options.primary ? fixture.binding : { ...fixture.binding, evidenceRoles: ["processing"], fields: [] };
    const access = { ...fixture.access, bindingDigest: stableDigest(binding), datasetIds: binding.datasetIds };
    const policy = { ...fixture.policy, rules: [{ ...fixture.policy.rules[0], recipientIds: [tenantId], evidenceRoles: binding.evidenceRoles,
      datasetIds: options.primary ? binding.datasetIds : [], requiredFields: binding.fields, maxAgeSeconds: options.primary ? 86400 : null }] };
    const register = async (artifact: any) => {
      const record = await registerSourceArtifact(db, { tenantId, actor: "author", artifact, expectedDigest: stableDigest(artifact) });
      await approveSourceArtifact(db, { tenantId, actor: "reviewer", kind: artifact.kind, digest: record.digest });
      return record.digest;
    };
    await upsertConnector(db, fixture.connector);
    const bindingDigest = await register(binding), accessDigest = await register(access), policyDigest = await register(policy);
    const plan = structuredClone(planFixture) as HarnessPlanV2;
    if (mode !== "selected") {
      for (const node of plan.graph.nodes) { delete node.config.skillId; delete node.config.skillVersion; }
      delete plan.skillBindings;
    }
    plan.sourceAuthorization = { policyDigests: [policyDigest], bindings: [{ capabilityId: binding.capabilityId, connectorId: binding.connectorId, bindingDigest, accessDigest }] };
    const { planId: _id, planDigest: _digest, ...content } = plan;
    plan.planDigest = stableDigest(content);
    await admitPlan(db, plan, tenantId);
    const sourceContextDigest = await register({ ...fixture.context, tenantId, planDigest: plan.planDigest });
    const { run } = await createRun(db, { tenantId, planDigest: plan.planDigest, sourceContextDigest, runInput: { tenantId, caseId: "case-1" }, idempotencyKey: randomUUID() });
    await db.query("update harness_runtime.runs set status='running',started_at=now() where run_id=$1", [run.runId]);
    const permission = plan.permissionEnvelopes.find((item) => item.nodeId === "sanctions-screen")!;
    const parentId = `${run.runId}:sanctions-screen:query`;
    const parent = await mintExecutionEnvelope({ secret: SECRET, tenantId, caseId: "case-1", runId: run.runId, nodeId: "sanctions-screen", attempt: 1,
      planDigest: plan.planDigest, permissionDigest: permission.digest, capabilities: permission.capabilities, effects: permission.effects,
      fencingEpoch: run.fencingEpoch, invocationId: parentId });
    const token = mode === "delegated" ? (await mintDelegatedEnvelope({ secret: SECRET, parent: await verifyExecutionEnvelope(parent, SECRET),
      delegatedTo: "skills:screening.sanctions.execute@0.1.0", capabilities: permission.capabilities, effects: permission.effects, deadlineAt: Math.floor(Date.now() / 1000) + 60 })).envelope : parent;
    const invocationId = mode === "delegated" ? `${parentId}:dependency` : parentId;
    const selected = plan.skillBindings?.find((item) => item.skillId === "screening.sanctions.execute");
    const payload = { invocationId, capabilityId: binding.capabilityId, effect: "read", input: { name: "Synthetic example" }, ...(selected ? { skill: {
      skillId: selected.skillId, skillVersion: selected.semver, selectedCapabilityId: binding.capabilityId, selectedConnectorId: binding.connectorId,
      candidateIndex: 0, reason: "selected", jurisdiction: "JP",
    } } : {}) };
    let calls = 0;
    const app = buildGateway({ db, executionSecret: SECRET, env: { RELEASE_ENVIRONMENT: "production", OPENSANCTIONS_API_KEY: "synthetic-key",
      OPENSANCTIONS_API_URL: options.endpoint ?? "https://sources.example.test/v1", OPENSANCTIONS_DATASET: "synthetic-us-list" },
      serviceGrants: [{ token: TOKEN, tenantId, subjectId: "test-runtime", roles: [mode === "delegated" ? "Skill.Host" : "Capability.Invoke"] }],
      fetch: async (_input, init) => { calls++; expect(init?.redirect).toBe("error"); return new Response(JSON.stringify({ responses: { subject: { status: 200, results: [] } } }), { headers: { "content-type": "application/json" } }); },
    });
    app.log.level = "silent";
    const invoke = () => app.inject({ method: "POST", url: "/v1/invoke", headers: { authorization: `Bearer ${TOKEN}`, "x-execution-envelope": token }, payload });
    return { db, app, tenantId, run, payload, token, policyDigest, invoke, calls: () => calls, close: async () => { await app.close(); await db.end(); } };
  }

  it.each(["direct", "selected", "delegated"] as const)("authorizes %s calls from the approved context and blocks revoked policy before further egress", async (mode) => {
    const test = await setup(mode);
    try {
      const first = await test.invoke();
      expect(first.statusCode, first.body).toBe(200);
      expect(first.json().status).toBe("succeeded");
      expect(test.calls()).toBe(1);
      const replay = await test.invoke();
      expect(replay.statusCode, replay.body).toBe(200);
      expect(test.calls()).toBe(1);
      const audit = await listSourceDecisions(test.db, test.tenantId, test.run.runId);
      expect(audit.some((record) => record.stage === "transport")).toBe(true);
      expect((await getSourceDecision(test.db, test.tenantId, first.json().evidenceUseDecisionId)).observation?.role).toBe("processing");
      const reuse = () => test.app.inject({ method: "POST", url: "/v1/evidence/use", headers: { authorization: `Bearer ${TOKEN}`, "x-execution-envelope": test.token },
        payload: { decisionIds: [first.json().evidenceUseDecisionId] } });
      expect((await reuse()).statusCode).toBe(mode === "delegated" ? 403 : 200);
      await revokeArtifactEntry(test.db, { tenantId: test.tenantId, actor: "reviewer", kind: "source-policy", digest: test.policyDigest, reasonCode: "source_revoked" });
      expect((await test.invoke()).statusCode).toBe(403);
      expect((await reuse()).statusCode).toBe(403);
      expect(test.calls()).toBe(1);
      expect((await listSourceDecisions(test.db, test.tenantId, test.run.runId)).some((record) => record.decision.reasonCodes.includes("source_policy.artifact_revoked"))).toBe(true);
    } finally { await test.close(); }
  });

  it("refuses an endpoint change before the injected provider transport is reached", async () => {
    const test = await setup("direct", { endpoint: "https://unapproved.example.test/v1" });
    try {
      const response = await test.invoke();
      expect(response.statusCode).toBeGreaterThanOrEqual(400);
      expect(test.calls()).toBe(0);
      expect((await listSourceDecisions(test.db, test.tenantId, test.run.runId)).some((item) => item.decision.reasonCodes.includes("source_policy.endpoint_denied"))).toBe(true);
    } finally { await test.close(); }
  });

  it("withholds a technically successful response without required evidence and never repeats that effect on replay", async () => {
    const test = await setup("direct", { primary: true });
    try {
      const response = await test.invoke();
      expect(response.statusCode, response.body).toBe(403);
      expect(response.json().output).toBeNull();
      expect(response.json().errorCode).toContain("evidence_incomplete");
      expect(test.calls()).toBe(1);
      await test.invoke();
      expect(test.calls()).toBe(1);
    } finally { await test.close(); }
  });
});

it("authorizes native database endpoints by exact protocol, host, port and database",()=>{
  const approved=["postgresql://db.example.test:5432/governed","tds://warehouse.example.test:1433/risk"];
  expect(sourceNativeEndpointAllowed(new URL(approved[0]!),approved)).toBe(true);
  expect(sourceNativeEndpointAllowed(new URL(approved[1]!),approved)).toBe(true);
  for(const value of ["postgresql://db.example.test:5432/other","postgresql://db.example.test:5433/governed","postgresql://user:password@db.example.test:5432/governed","tds://db.example.test:5432/governed","postgresql://db.example.test:5432/governed?host=evil"]){expect(sourceNativeEndpointAllowed(new URL(value),approved)).toBe(false);}
});
