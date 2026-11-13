import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import {
  businessSkillCatalogSchema,
  harnessPlanV2Schema,
  librarySkillBundleLock,
  skillBundleRegistryReference,
  skillCapabilityOutputV1Schema,
  skillExecutionRequestV1Schema,
  skillBundleLockDigest,
  stableDigest,
  type SkillQualification,
  type HarnessPlanV2,
} from "@ehf/contracts";
import { mintDelegatedEnvelope, mintExecutionEnvelope, verifyExecutionEnvelope } from "@ehf/execution-auth";
import type { Database } from "@ehf/persistence";
import { buildGateway } from "./app.js";
import type { DelegateEnvelope } from "./adapter-registry.js";

/**
 * A KYB library skill through the gateway's `skills:` adapter, end to end against the registry
 * seed generated from the vendored library catalog: the plan's pinned manifest digest is the
 * registry entry's, the lock built from the same catalog is the one the host serves, and the
 * gateway's pinning checks accept it. Production still refuses an implemented_synthetic skill.
 */
const read = (path: string) => JSON.parse(readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8")) as unknown;
const plan = harnessPlanV2Schema.parse(read("artifacts/archive/kyb.plan.json")) as HarnessPlanV2;
const registry = businessSkillCatalogSchema.parse(read("config/business-skills.json"));
const lock = librarySkillBundleLock(read("config/skill-library/catalog.json") as never, {
  imageDigest: `sha256:${"1".repeat(64)}`, sbomDigest: `sha256:${"2".repeat(64)}`,
});

const SECRET = "test-execution-envelope-secret-value";
const RUNTIME_TOKEN = "runtime-service-token-for-tests-01";
// The gateway has one identity, presented to the skill host as everywhere else.
const HOST_TOKEN = "gateway-service-token-for-tests-0001";
const HOST = "http://library-skill-host.test";
const NODE = "entity-resolve";
const node = plan.graph.nodes.find((item) => item.id === NODE)!;
const skillId = node.config.skillId as string;
const binding = plan.skillBindings!.find((item) => item.skillId === skillId)!;
const capabilityId = binding.candidates[0]!.capabilityId;
const permission = plan.permissionEnvelopes.find((item) => item.nodeId === NODE)!;

const runRow = {
  run_id: "RUN-K", idempotency_key: "k", plan_digest: plan.planDigest, status: "running", terminal_outcome: null, input: {}, output: null,
  attempt: 1, fencing_epoch: 1, latest_checkpoint_id: null, current_node_id: null, error_code: null, trace_id: null, root_span_id: null,
  trace_flags: null, cost_usd: 0, cost_complete: true, model_calls: 0, capability_calls: 0,
  created_at: new Date(), started_at: null, completed_at: null, updated_at: new Date(),
};

const policySection = {
  id: "policy", kind: "policy", trust: "TRUSTED_DATA", classification: "internal", purpose: "onboarding",
  provenance_ref: "policy:none", content_digest: `sha256:${"7".repeat(64)}`, quarantined: false,
  value: { version: "qualified-policy-v1" },
};
const qualification: SkillQualification = {
  schemaVersion: "skill.qualification.v1", skillId, skillVersion: binding.semver,
  manifestDigest: binding.manifestDigest, bundleDigest: lock.bundle_digest, bundleLockDigest: skillBundleLockDigest(lock),
  planDigest: plan.planDigest, policySnapshotRef: "policy:none",
  policyContextDigest: stableDigest([{ id: policySection.id, provenance_ref: policySection.provenance_ref, value: policySection.value }]),
  jurisdictions: ["GB"], purpose: "onboarding", validFrom: "2020-01-01T00:00:00Z", expiresAt: "2099-01-01T00:00:00Z",
  independentReviewer: "reviewer", evidence: {
    reportRef: "evidence:evaluation-v1", reportDigest: "8".repeat(64), datasetDigest: "9".repeat(64), sampleCount: 100,
    scopeDescription: "Evaluated case-bound reference workflow", controlsPassed: true,
    metrics: [{ name: "test-quality", value: 1, comparison: "at_least", threshold: 0.99 }],
  },
};
type RegistryOptions = { verified?: boolean; qualification?: SkillQualification; qualificationStatus?: string };

function database(options: RegistryOptions = {}): Database {
  const receipts = new Set<string>();
  const query = async (text: string, values: unknown[] = []) => {
    if (text.includes("select fencing_epoch")) return { rowCount: 1, rows: [{ fencing_epoch: 1 }] };
    if (text.includes("from harness_control.plans")) return { rowCount: 1, rows: [{ plan }] };
    if (text.includes("insert into harness_gateway.receipts")) {
      if (receipts.has(String(values[0]))) return { rowCount: 0, rows: [] };
      receipts.add(String(values[0]));
      return { rowCount: 1, rows: [{ result: null }] };
    }
    if (text.includes("select receipt_digest from harness_gateway.receipts")) return { rowCount: 0, rows: [] };
    // The registry as migrate.ts seeds it from config/business-skills.json.
    if (text.includes("from harness_control.business_skill_registry")) {
      const entry = registry.skills.find((item) => item.skillId === values[0] && (values[1] === null || item.semver === values[1]));
      return entry ? { rowCount: 1, rows: [{
        skill_id: entry.skillId, semver: entry.semver, manifest: entry.manifest, manifest_digest: entry.manifestDigest, status: entry.status,
        maturity: options.verified ? "integration_verified" : entry.maturity,
        source: entry.source, owner: entry.owner, created_at: new Date(), updated_at: new Date(),
        ...(options.verified ? { status: "active" } : {}),
      }] } : { rowCount: 0, rows: [] };
    }
    if (text.includes("from harness_control.skill_qualifications")) {
      return { rowCount: options.qualification ? 1 : 0, rows: options.qualification ? [{
        digest: stableDigest(options.qualification), qualification: options.qualification,
      }] : [] };
    }
    if (text.includes("from harness_control.artifact_registry")) {
      if (values[1] === "skill-qualification") return { rowCount: 1, rows: [{
        tenant_id: "tenant_demo", artifact_kind: "skill-qualification", digest: stableDigest(options.qualification),
        reference: "skill-qualification:evidence", status: options.qualificationStatus ?? "approved", registered_by: "author",
        approved_by: "reviewer", revoked_by: null, reason_code: null, registered_at: new Date(), approved_at: new Date(), revoked_at: null,
      }] };
      return { rowCount: 1, rows: [{
        tenant_id: "tenant_demo", artifact_kind: "skill-bundle", digest: lock.bundle_digest.slice(7), reference: skillBundleRegistryReference(lock),
        status: "approved", registered_by: "author", approved_by: "approver", revoked_by: null, reason_code: null, registered_at: new Date(),
        approved_at: new Date(), revoked_at: null,
      }] };
    }
    if (text.includes("from harness_runtime.runs")) return { rowCount: 1, rows: [runRow] };
    return { rowCount: 1, rows: [] };
  };
  return { query, connect: async () => ({ query, release: () => {} }), end: async () => {} } as unknown as Database;
}

const executions: unknown[] = [];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
// A library skill host that serves the catalog's lock.
const fetcher = (async (input: string | URL | Request, init: RequestInit = {}) => {
  const url = new URL(String(input));
  if (url.origin === HOST) {
    expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${HOST_TOKEN}`);
    if (url.pathname === "/v1/bundle") return json(lock);
    if (url.pathname === `/v1/skills/${skillId}/executions`) {
      const request = skillExecutionRequestV1Schema.parse(JSON.parse(String(init.body)));
      executions.push(request);
      return json({
        contract_version: "skill.execution.v1", execution_id: request.execution_id, lifecycle: "FAILED_EXECUTION", computation: null,
        error: { code: "CONTEXT_MISSING", retryable: false, detail_ref: null }, trace: { subskill_executions: [] },
      });
    }
    return json({ error: { code: "INPUT_INVALID" } }, 404);
  }
  throw new Error(`unexpected fetch ${url.origin}`);
}) as typeof globalThis.fetch;

// Delegation is in-process; its durable-state checks are covered in skill-delegation.test.ts.
const delegate: DelegateEnvelope = async (_tenant, parentEnvelope, body) => {
  const parent = await verifyExecutionEnvelope(parentEnvelope, SECRET);
  const minted = await mintDelegatedEnvelope({
    secret: SECRET, parent, delegatedTo: `skills:${body.skillId}@${body.skillVersion}`, capabilities: body.capabilities, effects: ["read"],
    deadlineAt: Math.floor(Date.parse(body.deadlineAt) / 1000),
  });
  return { envelope: minted.envelope, expiresAt: new Date(minted.expiresAt * 1000).toISOString(), capabilities: body.capabilities };
};

function gatewayFor(extra: NodeJS.ProcessEnv = {}, registryOptions: RegistryOptions = {}) {
  const gateway = buildGateway({
    db: database(registryOptions), executionSecret: SECRET, fetch: fetcher, delegate,
    env: {
      GATEWAY_ADAPTERS: "default,skills", SKILL_HOST_URL: HOST, SKILL_HOST_GATEWAY_URL: "http://gateway.test",
      GATEWAY_SERVICE_TOKEN: HOST_TOKEN, ...extra,
    },
    serviceGrants: [{ token: RUNTIME_TOKEN, subjectId: "harness-runtime", roles: ["Capability.Invoke"], tenantId: "tenant_demo" }],
  });
  gateway.log.level = "silent";
  return gateway;
}

async function invoke(gateway: ReturnType<typeof gatewayFor>, invocationId: string) {
  const envelope = await mintExecutionEnvelope({
    secret: SECRET, tenantId: "tenant_demo", caseId: "case-1", runId: "RUN-K", nodeId: NODE, attempt: 1,
    planDigest: plan.planDigest, permissionDigest: permission.digest, capabilities: permission.capabilities, effects: permission.effects,
    fencingEpoch: 1, invocationId, workItemId: "work-1", workFencingEpoch: 1,
  });
  const contextHash = "c".repeat(64);
  const input = {
    input: {
      execution_id: "0f6c2b1e-1d2a-8c3b-a4d5-e6f708192a3b", tenant_id: "tenant_demo", case_id: "case-1", subject_refs: ["subject:S-1"],
      parameters: { ...node.config.skillParameters as Record<string, unknown>, name: "Case-bound Example Ltd" }, context_manifest_ref: `context:${contextHash}`, policy_snapshot_ref: "policy:none",
      as_of_time: "2026-11-07T12:00:00Z", purpose: "onboarding", actor_ref: `workload:runtime/${NODE}`, idempotency_key: `RUN-K:${NODE}`, trace_id: "trace-k",
    },
    context: {
      envelope: {
        tenant_id: "tenant_demo", case_id: "case-1", subject_refs: ["subject:S-1"], jurisdiction: "GB", purpose: "KYB_ONBOARDING",
        actor: `workload:runtime/${NODE}`, policy_snapshot_ref: "policy:none", as_of_time: "2026-11-07T12:00:00Z", object_refs: [],
        evidence_refs: [], graph_scope: null, freshness_requirements: {}, permitted_providers: [`skills:${skillId}`],
        redaction_profile: "kyb", token_budget: 4000, correlation_id: "RUN-K", context_hash: contextHash,
      },
      context_hash: contextHash, sections: [policySection], missing: [],
    },
  };
  return gateway.inject({
    method: "POST", url: "/v1/invoke", headers: { authorization: `Bearer ${RUNTIME_TOKEN}`, "x-execution-envelope": envelope },
    payload: {
      invocationId, capabilityId, effect: "read", input,
      skill: { skillId, skillVersion: binding.semver, selectedCapabilityId: capabilityId, selectedConnectorId: `skills:${skillId}`, candidateIndex: 0, reason: "first_candidate" },
    },
  });
}

describe("library skills through the gateway (registry = vendored library catalog)", () => {
  const gateways: Array<ReturnType<typeof gatewayFor>> = [];
  afterAll(async () => { await Promise.all(gateways.map((gateway) => gateway.close())); });

  it("pins every KYB and KYC skill node to its registry entry and the catalog's bundle", () => {
    const kyc = harnessPlanV2Schema.parse(read("artifacts/archive/kyc-v2.plan.json")) as HarnessPlanV2;
    expect(plan.skillBindings).toHaveLength(33);
    expect(kyc.skillBindings).toHaveLength(28);
    for (const pinned of [...plan.skillBindings!, ...kyc.skillBindings!]) {
      const entry = registry.skills.find((item) => item.skillId === pinned.skillId && item.semver === pinned.semver);
      expect(entry, pinned.skillId).toBeDefined();
      expect(pinned.manifestDigest).toBe(entry!.manifestDigest);
      expect(pinned.bundleDigest).toBe(lock.bundle_digest);
      expect(lock.skills.find((item) => item.id === pinned.skillId)?.manifest_digest).toBe(`sha256:${entry!.manifestDigest}`);
    }
  });

  it("accepts the pinned library skill: registry digest, approved lock and effect mode all agree", async () => {
    const gateway = gatewayFor();
    gateways.push(gateway);
    const response = await invoke(gateway, `RUN-K:${NODE}:1`);
    expect(response.statusCode, response.body).toBe(200);
    const output = skillCapabilityOutputV1Schema.parse(response.json().output);
    expect(output).toMatchObject({
      skill_id: skillId, skill_version: binding.semver, bundle_digest: lock.bundle_digest, manifest_digest: binding.manifestDigest,
      effect_mode: "read_only", lifecycle: "FAILED_EXECUTION",
    });
    expect(executions).toHaveLength(1);
    expect(executions[0]).toMatchObject({ skill_id: skillId, skill_version: binding.semver, bundle_digest: lock.bundle_digest });
  });

  it("refuses an implemented_synthetic skill in production before calling the host", async () => {
    const gateway = gatewayFor({ RELEASE_ENVIRONMENT: "production" });
    gateways.push(gateway);
    const before = executions.length;
    const response = await invoke(gateway, `RUN-K:${NODE}:prod`);
    expect(response.json().error).toBe("adapter.skills_maturity_insufficient_denied");
    expect(executions).toHaveLength(before);
  });

  it("does not treat integration verification alone as production qualification", async () => {
    const gateway = gatewayFor({ RELEASE_ENVIRONMENT: "production" }, { verified: true });
    gateways.push(gateway);
    const before = executions.length;
    const response = await invoke(gateway, "RUN-K:unqualified");
    expect(response.json().error).toBe("adapter.skills_qualification_required_denied");
    expect(executions).toHaveLength(before);
  });

  it("records exact approved qualification evidence on a production invocation", async () => {
    const gateway = gatewayFor({ RELEASE_ENVIRONMENT: "production" }, { verified: true, qualification });
    gateways.push(gateway);
    const response = await invoke(gateway, "RUN-K:qualified");
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().output.qualification_digest).toBe(stableDigest(qualification));
  });

  it.each([
    ["revoked", {}, "revoked"],
    ["expired", { expiresAt: "2021-01-01T00:00:00Z" }, "approved"],
    ["changed policy content", { policyContextDigest: "0".repeat(64) }, "approved"],
    ["unsupported jurisdiction", { jurisdictions: ["US"] }, "approved"],
    ["different image/dependency lock", { bundleLockDigest: "0".repeat(64) }, "approved"],
  ])("denies %s qualification before host execution", async (_name, changed, status) => {
    const gateway = gatewayFor({ RELEASE_ENVIRONMENT: "production" }, {
      verified: true, qualification: { ...qualification, ...changed as Partial<SkillQualification> }, qualificationStatus: String(status),
    });
    gateways.push(gateway);
    const before = executions.length;
    const response = await invoke(gateway, `RUN-K:denied:${String(_name)}`);
    expect(response.json().error).toBe("adapter.skills_qualification_required_denied");
    expect(executions).toHaveLength(before);
  });
});
