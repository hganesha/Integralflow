import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  harnessPlanV2Schema,
  skillBundleRegistryReference,
  skillCapabilityOutputV1Schema,
  stableDigest,
  type BusinessSkillManifest,
  type HarnessPlanV2,
  type SkillExecutionRequestV1,
} from "@ehf/contracts";
import { mintDelegatedEnvelope, mintExecutionEnvelope, verifyExecutionEnvelope } from "@ehf/execution-auth";
import type { Database } from "@ehf/persistence";
import { buildBundleLock, buildReferenceSkillHost, SAMPLE_SKILLS } from "@ehf/skill-host-reference";
import { buildGateway } from "./app.js";
import type { DelegateEnvelope } from "./adapter-registry.js";
import { checkComputation } from "./adapters/skills.js";

const SECRET = "test-execution-envelope-secret-value";
const RUNTIME_TOKEN = "runtime-service-token-for-tests-01";
// The gateway has one identity: the skill host verifies the same token the gateway presents everywhere.
const GATEWAY_TOKEN = "gateway-service-token-for-tests-0001";
const SKILL_HOST_OUTBOUND = "skill-host-gateway-token-for-tests";

const plan = harnessPlanV2Schema.parse(JSON.parse(readFileSync(
  new URL("../../../packages/contracts/test-fixtures/skill-hosted.plan.json", import.meta.url), "utf8"))) as HarnessPlanV2;
const lock = buildBundleLock(SAMPLE_SKILLS);
const registryVerify = SAMPLE_SKILLS.find((skill) => skill.manifest.id === "sample.registry.verify")!;
const permission = plan.permissionEnvelopes.find((item) => item.nodeId === "registry-verify")!;

type State = {
  receipts: Map<string, { runId: string; reasonCode: string; digest: string | null }>;
  bundleStatus: "approved" | "registered" | "revoked" | "missing";
  bundleReference: string;
  brokerCalls: number;
  tamperManifest?: boolean;
};

const runRow = {
  run_id: "RUN-1", idempotency_key: "k", plan_digest: plan.planDigest, status: "running", terminal_outcome: null, input: {}, output: null,
  attempt: 1, fencing_epoch: 1, latest_checkpoint_id: null, current_node_id: null, error_code: null, trace_id: null, root_span_id: null,
  trace_flags: null, cost_usd: 0, cost_complete: true, model_calls: 0, capability_calls: 0,
  created_at: new Date(), started_at: null, completed_at: null, updated_at: new Date(),
};

function skillRow(manifest: BusinessSkillManifest) {
  return {
    skill_id: manifest.id, semver: manifest.semver, manifest, manifest_digest: stableDigest(manifest), status: "active",
    maturity: "implemented_synthetic", source: { path: "apps/skill-host-reference", revision: "r1" }, owner: manifest.owner,
    created_at: new Date(), updated_at: new Date(),
  };
}

function database(state: State): Database {
  const query = async (text: string, values: unknown[] = []) => {
    if (text.includes("select fencing_epoch")) return { rowCount: 1, rows: [{ fencing_epoch: 1 }] };
    if (text.includes("from harness_control.plans")) return { rowCount: 1, rows: [{ plan }] };
    if (text.includes("insert into harness_gateway.receipts")) {
      const invocationId = String(values[0]);
      if (state.receipts.has(invocationId)) return { rowCount: 0, rows: [] };
      state.receipts.set(invocationId, { runId: String(values[1]), reasonCode: String(values[10]), digest: null });
      return { rowCount: 1, rows: [{ result: null }] };
    }
    if (text.includes("update harness_gateway.receipts")) {
      const receipt = state.receipts.get(String(values[0]));
      if (receipt) receipt.digest = String(values[2]);
      return { rowCount: 1, rows: [] };
    }
    if (text.includes("delete from harness_gateway.receipts")) {
      state.receipts.delete(String(values[0]));
      return { rowCount: 1, rows: [] };
    }
    if (text.includes("select receipt_digest from harness_gateway.receipts")) {
      const prefix = String(values[1]);
      return { rowCount: 1, rows: [...state.receipts.entries()].filter(([id, receipt]) => id.startsWith(prefix) && receipt.digest)
        .map(([, receipt]) => ({ receipt_digest: receipt.digest })) };
    }
    if (text.includes("from harness_control.business_skill_registry")) {
      const skill = SAMPLE_SKILLS.find((item) => item.manifest.id === values[0]);
      const row = skill ? skillRow(skill.manifest) : null;
      // A registry row edited in place: the manifest changed, its stored digest did not.
      if (row && state.tamperManifest) row.manifest = { ...row.manifest, description: "edited in place" };
      return { rowCount: row ? 1 : 0, rows: row ? [row] : [] };
    }
    if (text.includes("from harness_control.artifact_registry")) {
      if (state.bundleStatus === "missing") return { rowCount: 0, rows: [] };
      return { rowCount: 1, rows: [{
        tenant_id: "tenant_demo", artifact_kind: "skill-bundle", digest: lock.bundle_digest.slice(7), reference: state.bundleReference,
        status: state.bundleStatus, registered_by: "author", approved_by: state.bundleStatus === "registered" ? null : "approver",
        revoked_by: state.bundleStatus === "revoked" ? "operator" : null, reason_code: null, registered_at: new Date(),
        approved_at: state.bundleStatus === "registered" ? null : new Date(), revoked_at: state.bundleStatus === "revoked" ? new Date() : null,
      }] };
    }
    if (text.includes("from harness_runtime.runs")) return { rowCount: 1, rows: [runRow] };
    return { rowCount: 1, rows: [] };
  };
  return { query, connect: async () => ({ query, release: () => {} }), end: async () => {} } as unknown as Database;
}

function skillInput(overrides: { tenant?: string; missingRequired?: boolean } = {}) {
  const contextHash = "c".repeat(64);
  return {
    input: {
      execution_id: "0f6c2b1e-1d2a-8c3b-a4d5-e6f708192a3b", tenant_id: overrides.tenant ?? "tenant_demo", case_id: "case-1",
      subject_refs: ["party:P-1"], parameters: { company_name: "Sample Holdings Ltd" }, context_manifest_ref: `context:${contextHash}`,
      policy_snapshot_ref: "policy:kyc@1", as_of_time: "2026-11-07T12:00:00Z", purpose: "onboarding", actor_ref: "agent:registry-verify",
      idempotency_key: "RUN-1:registry-verify", trace_id: "trace-1",
    },
    context: {
      envelope: {
        tenant_id: "tenant_demo", case_id: "case-1", subject_refs: ["party:P-1"], jurisdiction: "GB", purpose: "KYC_ONBOARDING",
        actor: "agent:registry-verify", policy_snapshot_ref: "policy:kyc@1", as_of_time: "2026-11-07T12:00:00Z", object_refs: [],
        evidence_refs: [], graph_scope: null, freshness_requirements: {}, permitted_providers: ["skills:sample.registry.verify"],
        redaction_profile: "kyc-standard", token_budget: 4000, correlation_id: "RUN-1", context_hash: contextHash,
      },
      context_hash: contextHash,
      sections: [{
        id: "subject", kind: "case", trust: "TRUSTED_DATA", classification: "PII", purpose: "KYC_ONBOARDING",
        provenance_ref: "case:case-1@3/case:subjects.0", content_digest: `sha256:${stableDigest({ display_name: "Sample Holdings Ltd" })}`,
        quarantined: false, value: { display_name: "Sample Holdings Ltd" },
      }],
      missing: overrides.missingRequired ? [{ selector: "registrations", code: "CONTEXT_MISSING", required: true }] : [],
    },
  };
}

function nodeEnvelope(invocationId: string, capabilities = permission.capabilities) {
  return mintExecutionEnvelope({
    secret: SECRET, tenantId: "tenant_demo", caseId: "case-1", runId: "RUN-1", nodeId: "registry-verify", attempt: 1,
    planDigest: plan.planDigest, permissionDigest: permission.digest, capabilities, effects: permission.effects,
    fencingEpoch: 1, invocationId, workItemId: "work-1", workFencingEpoch: 1,
  });
}

describe("skills gateway adapter (skill.execution.v1)", () => {
  const state: State = { receipts: new Map(), bundleStatus: "approved", bundleReference: skillBundleRegistryReference(lock), brokerCalls: 0 };
  const env: NodeJS.ProcessEnv = {
    GATEWAY_ADAPTERS: "default,skills",
    GATEWAY_SERVICE_TOKEN: GATEWAY_TOKEN,
  };
  // Delegation is in-process; the durable-state checks behind it are covered in
  // skill-delegation.test.ts. Here it verifies the parent and mints, and counts its calls.
  const delegate: DelegateEnvelope = async (_tenant, parentEnvelope, body) => {
    state.brokerCalls += 1;
    const parent = await verifyExecutionEnvelope(parentEnvelope, SECRET);
    const minted = await mintDelegatedEnvelope({
      secret: SECRET, parent, delegatedTo: `skills:${body.skillId}@${body.skillVersion}`, capabilities: body.capabilities, effects: ["read"],
      deadlineAt: Math.floor(Date.parse(body.deadlineAt) / 1000),
    });
    return { envelope: minted.envelope, expiresAt: new Date(minted.expiresAt * 1000).toISOString(), capabilities: body.capabilities };
  };
  const gateway = buildGateway({
    db: database(state), executionSecret: SECRET, env, delegate,
    serviceGrants: [
      { token: RUNTIME_TOKEN, subjectId: "harness-runtime", roles: ["Capability.Invoke"], tenantId: "tenant_demo" },
      { token: SKILL_HOST_OUTBOUND, subjectId: "skill-host", roles: ["Skill.Host"], tenantId: "tenant_demo" },
    ],
  });
  gateway.log.level = "silent";
  const host = buildReferenceSkillHost({ token: GATEWAY_TOKEN, gatewayToken: SKILL_HOST_OUTBOUND, syncWaitMs: 2_000 });

  beforeAll(async () => {
    await gateway.listen({ host: "127.0.0.1", port: 0 });
    await host.listen({ host: "127.0.0.1", port: 0 });
    env.SKILL_HOST_GATEWAY_URL = `http://127.0.0.1:${(gateway.server.address() as AddressInfo).port}`;
    env.SKILL_HOST_URL = `http://127.0.0.1:${(host.server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await host.close();
    await gateway.close();
  });

  // The runtime names the pinned candidate it serves; the gateway refuses a candidate call without one.
  const SELECTION = {
    skillId: "sample.registry.verify", skillVersion: "0.1.0", selectedCapabilityId: "skill.sample.registry.verify.v1",
    selectedConnectorId: "skills:sample.registry.verify", candidateIndex: 0, reason: "first_candidate",
  };

  async function invoke(invocationId: string, input: unknown = skillInput(), headers: Record<string, string> = {}) {
    return gateway.inject({
      method: "POST", url: "/v1/invoke",
      headers: { authorization: `Bearer ${RUNTIME_TOKEN}`, "x-execution-envelope": await nodeEnvelope(invocationId), ...headers },
      payload: { invocationId, capabilityId: "skill.sample.registry.verify.v1", effect: "read", input, skill: SELECTION },
    });
  }

  it("runs a pinned skill end to end with a delegated envelope for its dependency", async () => {
    const response = await invoke("RUN-1:registry-verify:1");
    expect(response.statusCode, response.body).toBe(200);
    const output = skillCapabilityOutputV1Schema.parse(response.json().output);
    expect(output).toMatchObject({
      skill_id: "sample.registry.verify", skill_version: "0.1.0", bundle_digest: lock.bundle_digest, effect_mode: "proposal",
      lifecycle: "COMPLETED_EXECUTION", execution_id: "RUN-1:registry-verify:1",
    });
    expect(output.computation?.business_status).toBe("COMPLETED");
    expect(output.computation?.payload).toEqual({ company_name: "Sample Holdings Ltd", registered: true, active: true });
    // The dependency call went through this gateway under the delegated envelope, with its own receipt...
    const dependency = state.receipts.get("RUN-1:registry-verify:1:registry-lookup");
    expect(dependency?.reasonCode).toBe("permission.delegated_envelope_allowed:skills:sample.registry.verify@0.1.0");
    expect(output.dependency_receipts).toEqual([dependency?.digest]);
    // ...and the proposed record cites exactly that receipt.
    expect(output.computation?.proposed_records[0]?.evidence).toEqual([{ receipt_digest: dependency?.digest, path: "$.output" }]);
    // The registry entry also comes back as a synthetic RegistryRecord (CanonicalRecord amendment), checked by the gateway.
    expect(output.computation?.proposed_records.map((record) => [record.record_type, (record.body as { object_type?: string }).object_type ?? null])).toEqual([["Finding", null], ["CanonicalRecord", "RegistryRecord"]]);
    expect(response.json().provider).toBe(`skill-host:${lock.bundle_id}`);
  });

  it("refuses an unapproved, revoked or different bundle before calling the host", async () => {
    for (const [status, reference, expected] of [
      ["registered", skillBundleRegistryReference(lock), "adapter.skills_bundle_not_approved_denied"],
      ["revoked", skillBundleRegistryReference(lock), "adapter.skills_bundle_revoked_denied"],
      ["missing", skillBundleRegistryReference(lock), "adapter.skills_bundle_not_approved_denied"],
      ["approved", `skill-bundle:${lock.bundle_id}@${lock.bundle_version};lock=${"e".repeat(64)}`, "adapter.skills_integrity_bundle_lock_mismatch"],
    ] as const) {
      state.bundleStatus = status;
      state.bundleReference = reference;
      const brokerCalls = state.brokerCalls;
      const response = await invoke(`RUN-1:registry-verify:bundle-${status}-${reference.length}`);
      expect(response.json().error).toBe(expected);
      expect(state.brokerCalls).toBe(brokerCalls);
    }
    state.bundleStatus = "approved";
    state.bundleReference = skillBundleRegistryReference(lock);
  });

  it("refuses a registry manifest whose content no longer matches its stored digest", async () => {
    state.tamperManifest = true;
    const brokerCalls = state.brokerCalls;
    expect((await invoke("RUN-1:registry-verify:tampered")).json().error).toBe("adapter.skills_integrity_manifest_tampered");
    expect(state.brokerCalls).toBe(brokerCalls);
    state.tamperManifest = false;
  });

  it("refuses input for another tenant and required context that is missing", async () => {
    expect((await invoke("RUN-1:registry-verify:tenant", skillInput({ tenant: "tenant_other" }))).json().error).toBe("adapter.skills_tenant_scope_denied");
    expect((await invoke("RUN-1:registry-verify:missing", skillInput({ missingRequired: true }))).json().error).toBe("adapter.skills_context_missing");
    expect((await invoke("RUN-1:registry-verify:shape", { input: {} })).json().error).toBe("adapter.skills_input_invalid");
  });

  it("accepts a delegated envelope only from a skill host, only for its narrowed capabilities, never for a skill", async () => {
    const parent = await verifyExecutionEnvelope(await nodeEnvelope("RUN-1:registry-verify:d"), SECRET);
    const delegated = await mintDelegatedEnvelope({
      secret: SECRET, parent, delegatedTo: "skills:sample.registry.verify@0.1.0", capabilities: ["business.registry.lookup.v1"],
      effects: ["read"], deadlineAt: Math.floor(Date.now() / 1000) + 30,
    });
    const call = (token: string, envelope: string, capabilityId: string, invocationId: string) => gateway.inject({
      method: "POST", url: "/v1/invoke", headers: { authorization: `Bearer ${token}`, "x-execution-envelope": envelope },
      payload: { invocationId, capabilityId, effect: "read", input: { name: "Sample Holdings Ltd" } },
    });
    const allowed = await call(SKILL_HOST_OUTBOUND, delegated.envelope, "business.registry.lookup.v1", "RUN-1:registry-verify:d:lookup");
    expect(allowed.statusCode, allowed.body).toBe(200);
    expect((await call(RUNTIME_TOKEN, delegated.envelope, "business.registry.lookup.v1", "RUN-1:registry-verify:d:runtime")).json().error)
      .toBe("gateway.delegated_envelope_caller_denied");
    expect((await call(SKILL_HOST_OUTBOUND, delegated.envelope, "screening.sanctions.v1", "RUN-1:registry-verify:d:sanctions")).json().error)
      .toBe("gateway.capability_denied");
    expect((await call(SKILL_HOST_OUTBOUND, delegated.envelope, "business.registry.lookup.v1", "RUN-1:other:lookup")).json().error)
      .toBe("gateway.invocation_mismatch");
    expect((await call(SKILL_HOST_OUTBOUND, await nodeEnvelope("RUN-1:registry-verify:n"), "business.registry.lookup.v1", "RUN-1:registry-verify:n")).json().error)
      .toBe("gateway.skill_host_envelope_denied");
    // Even a delegated envelope that (wrongly) names a skill capability cannot recurse through the gateway.
    const recursive = await mintDelegatedEnvelope({
      secret: SECRET, parent, delegatedTo: "skills:sample.registry.verify@0.1.0", capabilities: ["skill.sample.registry.verify.v1"],
      effects: ["read"], deadlineAt: Math.floor(Date.now() / 1000) + 30,
    });
    expect((await call(SKILL_HOST_OUTBOUND, recursive.envelope, "skill.sample.registry.verify.v1", "RUN-1:registry-verify:d:recurse")).json().error)
      .toBe("gateway.delegated_skill_call_denied");
  });
});

describe("skill computation checks (§4.2, §6.3)", () => {
  const manifest = registryVerify.manifest;
  const request = {
    context: {
      sections: [{ id: "subject", content_digest: `sha256:${"a".repeat(64)}` }],
      missing: [] as Array<{ selector: string; code: string; required: boolean }>,
    },
  } as unknown as SkillExecutionRequestV1;
  const computation = (overrides: Record<string, unknown> = {}) => ({
    business_status: "COMPLETED" as const,
    payload: { company_name: "X", registered: true, active: true },
    proposed_records: [], unresolved_items: [], negative_searches: [], requested_effects: [],
    metrics: { duration_ms: 1, capability_calls: 1, model_calls: 0 },
    ...overrides,
  });
  const { produces: _produces, ...packageWithout } = manifest.package!;
  const run = (value: ReturnType<typeof computation>, mode: "read_only" | "proposal" | "internal_write" | "external_write" = "proposal", extra: {
    caseWrites?: string[]; heldCaseWrites?: string[]; receipts?: string[]; missing?: boolean; permissions?: string[]; produces?: string[] | null; maturity?: string;
  } = {}) => checkComputation({
    computation: value as never, mode,
    manifest: { ...manifest, package: { ...packageWithout, authorization: { required_permissions: extra.permissions ?? [] }, ...(extra.produces === null ? {} : { produces: extra.produces ?? ["RegistryRecord"] }) } },
    request: extra.missing ? { ...request, context: { ...request.context, missing: [{ selector: "x", code: "CONTEXT_MISSING", required: true }] } } as never : request,
    caseWrites: extra.caseWrites ?? [], heldCaseWrites: extra.heldCaseWrites ?? [], receiptDigests: new Set(extra.receipts ?? []),
    ...(extra.maturity ? { maturity: extra.maturity } : {}),
  });
  const finding = (evidence: unknown[]) => [{ record_type: "Finding", local_ref: "f1", body: { finding_type: "COMPANY_REGISTERED_ACTIVE", reason: "registered" }, evidence }];
  const effect = (type: "case_command" | "external_action") => [type === "case_command"
    ? { type, command_type: "RequestHumanReview", idempotency_key: "k", payload: {}, justification_refs: [] }
    : { type, action: "regulatory.filing.submit", idempotency_key: "k", payload: {}, justification_refs: [] }];

  it("enforces the output schema and effect modes", () => {
    expect(() => run(computation())).not.toThrow();
    expect(() => run(computation({ payload: { company_name: 1 } }))).toThrow("adapter.skills_integrity_payload_schema_invalid");
    // A skill that outputs proposed_records has them lifted out of its payload by the host (§6.2).
    const lifting = { ...manifest.output_schema, required: [...((manifest.output_schema as { required?: string[] }).required ?? []), "proposed_records"],
      properties: { ...(manifest.output_schema as { properties: object }).properties, proposed_records: { type: "array" } } };
    expect(() => checkComputation({ computation: computation() as never, mode: "proposal", manifest: { ...manifest, output_schema: lifting, package: { ...packageWithout, authorization: { required_permissions: [] }, produces: ["RegistryRecord"] } } as never,
      request, caseWrites: [], heldCaseWrites: [], receiptDigests: new Set() })).not.toThrow();
    expect(() => run(computation({ proposed_records: finding([]) }), "read_only")).toThrow("adapter.skills_integrity_read_only_violated");
    expect(() => run(computation({ requested_effects: effect("case_command") }), "proposal")).toThrow("adapter.skills_integrity_effects_not_permitted");
    expect(() => run(computation({ requested_effects: effect("external_action") }), "internal_write")).toThrow("adapter.skills_integrity_external_action_not_permitted");
    expect(() => run(computation({ requested_effects: effect("case_command") }), "internal_write", { caseWrites: ["RequestHumanReview"] }))
      .toThrow("adapter.skills_integrity_case_command_undeclared");
    expect(() => run(computation({ requested_effects: effect("case_command") }), "internal_write", { permissions: ["RequestHumanReview"] }))
      .toThrow("adapter.skills_integrity_case_command_not_granted");
    expect(() => run(computation({ requested_effects: effect("case_command") }), "internal_write", { permissions: ["case_command:RequestHumanReview"], caseWrites: ["RequestHumanReview"] }))
      .not.toThrow();
    expect(() => run(computation({ requested_effects: effect("external_action") }), "external_write")).not.toThrow();
  });

  it("traces evidence to this request's sections or this execution's receipts, and never passes missing context", () => {
    expect(() => run(computation({ proposed_records: finding([{ section_id: "subject", content_digest: `sha256:${"a".repeat(64)}` }]) }))).not.toThrow();
    expect(() => run(computation({ proposed_records: finding([{ section_id: "subject", content_digest: `sha256:${"b".repeat(64)}` }]) })))
      .toThrow("adapter.skills_integrity_evidence_untraceable");
    expect(() => run(computation({ proposed_records: finding([{ receipt_digest: "d".repeat(64) }]) }), "proposal", { receipts: ["d".repeat(64)] })).not.toThrow();
    expect(() => run(computation({ proposed_records: finding([{ receipt_digest: `sha256:${"e".repeat(64)}` }]) }), "proposal", { receipts: ["d".repeat(64)] }))
      .toThrow("adapter.skills_integrity_evidence_untraceable");
    expect(() => run(computation(), "proposal", { missing: true })).toThrow("adapter.skills_integrity_completed_without_required_context");
    expect(() => run(computation({ business_status: "NEEDS_EVIDENCE", payload: { company_name: "X", registered: null, active: null } }), "proposal", { missing: true }))
      .not.toThrow();
 
    // A gap found inside the skill (stale or missing context) comes back without a payload: it is a
    // gap with its reason, not an integrity failure, and never an unexplained empty answer.
    const reason = [{ code: "CONTEXT_STALE", subject_ref: "", explanation: "stale" }];
    expect(() => run(computation({ business_status: "NEEDS_EVIDENCE", payload: {}, unresolved_items: reason }))).not.toThrow();
    expect(() => run(computation({ business_status: "BLOCKED", payload: null, unresolved_items: reason }))).not.toThrow();
    expect(() => run(computation({ business_status: "NEEDS_EVIDENCE", payload: {} }))).toThrow("adapter.skills_integrity_gap_unexplained");
    expect(() => run(computation({ business_status: "COMPLETED", payload: {}, unresolved_items: reason }))).toThrow("adapter.skills_integrity_payload_schema_invalid");
    expect(() => run(computation({ business_status: "NEEDS_EVIDENCE", payload: { company_name: 1 }, unresolved_items: reason })))
      .toThrow("adapter.skills_integrity_payload_schema_invalid");
  });

  const canonical = (body: Record<string, unknown> = {}, localRef = "r1") => ({
    record_type: "CanonicalRecord", local_ref: localRef,
    body: {
      object_type: "RegistryRecord", object_id: "registry:sample:1", version_id: "v-1",
      data: { registration_id: "01234567", status: "ACTIVE", coverage: { complete: false, jurisdictions: ["GB"] }, name: "Sample Holdings Ltd" },
      observed_at: "2026-11-07T12:00:00Z", source_refs: [], classification: "CONFIDENTIAL", synthetic: true,
      ...body,
    },
    evidence: [{ receipt_digest: "d".repeat(64) }],
  });
  const traced = { receipts: ["d".repeat(64)] };

  it("checks CanonicalRecord proposals: effect mode, declared object types, the synthetic flag and the record shape", () => {
    expect(() => run(computation({ proposed_records: [canonical()] }), "proposal", traced)).not.toThrow();
    expect(() => run(computation({ proposed_records: [canonical()] }), "internal_write", traced)).not.toThrow();
    // Proposal mode or higher: a read-only skill proposes nothing.
    expect(() => run(computation({ proposed_records: [canonical()] }), "read_only", traced)).toThrow("adapter.skills_integrity_read_only_violated");
    // The manifest says it produces RegistryRecord, so nothing else; a manifest that says nothing allows any ontology type.
    expect(() => run(computation({ proposed_records: [canonical({ object_type: "BeneficialOwner" })] }), "proposal", traced))
      .toThrow("adapter.skills_integrity_record_object_type_not_declared");
    expect(() => run(computation({ proposed_records: [canonical({ object_type: "BeneficialOwner", data: { entity_id: "entity:A", evidence_ids: [] } })] }), "proposal", { ...traced, produces: null })).not.toThrow();
    // `data` meets the same closed contract as connector records (library context 2.0.0).
    expect(() => run(computation({ proposed_records: [canonical({ data: { registration_id: "01234567", status: "ACTIVE", coverage: { status: "sample_registry" }, name: "x" } })] }), "proposal", traced))
      .toThrow("adapter.skills_integrity_record_data_invalid");
    expect(() => run(computation({ proposed_records: [canonical({ object_type: "MadeUpType", data: {} })] }), "proposal", { ...traced, produces: null }))
      .toThrow("adapter.skills_integrity_record_data_invalid");
    // An implemented_synthetic skill only proposes synthetic records.
    expect(() => run(computation({ proposed_records: [canonical({ synthetic: false })] }), "proposal", traced)).toThrow("adapter.skills_integrity_record_synthetic_required");
    expect(() => run(computation({ proposed_records: [canonical({ synthetic: false })] }), "proposal", { ...traced, maturity: "integration_verified" })).not.toThrow();
    // Store-set fields (provenance, tenant, recorded time, digest) and malformed types are refused.
    for (const body of [{ provenance: { method: "platform" } }, { tenant_id: "t" }, { recorded_at: "2026-11-07T12:00:00Z" }, { record_digest: "a".repeat(64) },
      { object_type: "registry_record" }, { observed_at: "yesterday" }, { valid_from: "2026-11-08T00:00:00Z", valid_to: "2026-11-07T00:00:00Z" }]) {
      expect(() => run(computation({ proposed_records: [canonical(body)] }), "proposal", traced)).toThrow("adapter.skills_integrity_record_body_invalid");
    }
    expect(() => run(computation({ proposed_records: [canonical(), canonical({}, "r1")] }), "proposal", traced)).toThrow("adapter.skills_integrity_local_ref_duplicate");
    // Evidence attribution applies as to any record.
    expect(() => run(computation({ proposed_records: [canonical()] }), "proposal")).toThrow("adapter.skills_integrity_evidence_untraceable");
  });

  it("checks every §6.2 record body", () => {
    const record = (record_type: string, body: Record<string, unknown>) => ({ record_type, local_ref: record_type, body, evidence: [] });
    const valid = [
      record("Assertion", { predicate: "registered_name", value: "Sample Holdings Ltd" }),
      record("Fact", { predicate: "registered", value: true, verification_criteria: ["registry receipt names the company"] }),
      record("RiskIndicator", { finding_type: "HIGH_RISK_JURISDICTION", reason: "Incorporated in a listed jurisdiction." }),
      record("Conflict", { object_refs: ["entity:A", "entity:B"], description: "Names differ.", materiality: "HIGH" }),
      record("UnresolvedQuestion", { question: "Who controls the trust?" }),
      record("Hypothesis", { anything: true }),
    ];
    expect(() => run(computation({ proposed_records: valid }), "proposal")).not.toThrow();
    for (const invalid of [
      record("Fact", { predicate: "registered", value: true }),
      record("Finding", { finding_type: "lowercase", reason: "x" }),
      record("Conflict", { object_refs: ["entity:A"], description: "x", materiality: "HIGH" }),
      record("UnresolvedQuestion", {}),
    ]) {
      expect(() => run(computation({ proposed_records: [invalid] }), "proposal")).toThrow("adapter.skills_integrity_record_body_invalid");
    }
  });

  it("never lets a skill request a decision, disposition, review or approval, and accepts a held grant for an approval-required skill", () => {
    const command = (command_type: string, key = "k") => ({ type: "case_command", command_type, idempotency_key: key, payload: {}, justification_refs: [] });
    for (const forbidden of ["FinalizeDisposition", "RecordReview", "RecordQAResult", "RecordGateResult", "AcceptClaimAsFact"]) {
      expect(() => run(computation({ requested_effects: [command(forbidden)] }), "internal_write", { permissions: [`case_command:${forbidden}`], caseWrites: [forbidden] }))
        .toThrow("adapter.skills_integrity_case_command_forbidden");
    }
    expect(() => run(computation({ requested_effects: [command("TransitionCaseStatus")] }), "internal_write", { permissions: ["case_command:TransitionCaseStatus"], heldCaseWrites: ["TransitionCaseStatus"] }))
      .not.toThrow();
    expect(() => run(computation({ requested_effects: [command("RequestHumanReview"), command("RequestHumanReview")] }), "internal_write", { permissions: ["case_command:RequestHumanReview"], caseWrites: ["RequestHumanReview"] }))
      .toThrow("adapter.skills_integrity_effect_key_duplicate");
  });
});
