import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { harnessPlanV2Schema, skillBundleRegistryReference, stableDigest, type HarnessPlanV2 } from "@ehf/contracts";
import { EnvelopeAuthorityError, issueDelegatedEnvelope, mintDelegatedEnvelope, mintExecutionEnvelope, verifyExecutionEnvelope } from "@ehf/execution-auth";
import type { BusinessSkillRecord, Database } from "@ehf/persistence";
import { SAMPLE_SKILLS } from "@ehf/skill-host-reference";

const SECRET = "broker-envelope-secret-for-tests-01";
const plan = harnessPlanV2Schema.parse(JSON.parse(readFileSync(
  new URL("../../../packages/contracts/test-fixtures/skill-hosted.plan.json", import.meta.url), "utf8"))) as HarnessPlanV2;
const permission = plan.permissionEnvelopes.find((item) => item.nodeId === "registry-verify")!;
const manifest = SAMPLE_SKILLS.find((skill) => skill.manifest.id === "sample.registry.verify")!.manifest;
const db = { query: async () => ({ rows: [], rowCount: 0 }) } as unknown as Database;

type World = { status?: string; epoch?: number; releaseOk?: boolean; leaseUntil?: string; manifestDigest?: string; workNode?: string };

function reads(world: World = {}) {
  return {
    getRun: async () => ({ runId: "RUN-1", attempt: 1, status: world.status ?? "running", planDigest: plan.planDigest }) as never,
    currentFencingEpoch: async () => world.epoch ?? 2,
    getPlan: async () => plan,
    requireExecutableRelease: async () => {
      if (world.releaseOk === false) throw new Error("release.executable_authority_missing");
      return {} as never;
    },
    getExecutionWorkItem: async () => ({
      status: "RUNNING",
      lease: { fencingEpoch: 5, owner: "worker-1", leaseUntil: world.leaseUntil ?? new Date(Date.now() + 60_000).toISOString(), executionId: "x", attemptNumber: 1 },
      constraints: { nodeId: world.workNode ?? "registry-verify", runId: "RUN-1" },
    }) as never,
    getBusinessSkill: async () => ({ manifest, manifestDigest: world.manifestDigest ?? stableDigest(manifest) }) as unknown as BusinessSkillRecord,
  };
}

function parent(overrides: { capabilities?: string[] } = {}) {
  return mintExecutionEnvelope({
    secret: SECRET, tenantId: "tenant_demo", caseId: "case-1", runId: "RUN-1", nodeId: "registry-verify", attempt: 1,
    planDigest: plan.planDigest, permissionDigest: permission.digest, capabilities: overrides.capabilities ?? permission.capabilities,
    effects: permission.effects, caseWrites: ["ProposeClaim"], fencingEpoch: 2, invocationId: "RUN-1:registry-verify:1",
    workItemId: "work-1", workFencingEpoch: 5,
  });
}

const request = (overrides: Record<string, unknown> = {}) => ({
  skillId: "sample.registry.verify", skillVersion: "0.1.0", capabilities: ["business.registry.lookup.v1"],
  deadlineAt: new Date(Date.now() + 20_000).toISOString(), ...overrides,
});

async function delegate(world: World = {}, body: Record<string, unknown> = request(), token?: string, tenant = "tenant_demo") {
  return issueDelegatedEnvelope({ db, envelopeSecret: SECRET, envelopeVerifier: SECRET, reads: reads(world) }, tenant, token ?? await parent(), body);
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "issued";
  } catch (error) {
    return error instanceof EnvelopeAuthorityError ? error.code : String(error);
  }
}

// The gateway issues delegated envelopes in-process (skill.execution.v1 §6.1); these are the
// rules it applies before signing one.
describe("delegated envelope issuance", () => {
  it("narrows the node envelope to the skill's declared dependencies", async () => {
    const issued = await delegate();
    const claims = await verifyExecutionEnvelope(issued.envelope, SECRET);
    expect(claims).toMatchObject({
      delegated_to: "skills:sample.registry.verify@0.1.0", parent_jti: "RUN-1:registry-verify:1", jti: "dlg:RUN-1:registry-verify:1",
      run_id: "RUN-1", node_id: "registry-verify", attempt: 1, fencing_epoch: 2, work_item_id: "work-1", work_fencing_epoch: 5,
      plan_digest: plan.planDigest, permission_digest: permission.digest,
      capabilities: ["business.registry.lookup.v1"], effects: ["read"], case_writes: [], case_reads: [],
    });
    expect(claims.exp * 1000).toBeLessThanOrEqual(Date.now() + 20_000);
    expect(issued.capabilities).toEqual(["business.registry.lookup.v1"]);
  });

  it("re-checks durable state and refuses anything the node, the skill or the fence does not allow", async () => {
    expect(await refusal(delegate({ epoch: 3 }))).toBe("broker.stale_fence");
    expect(await refusal(delegate({ status: "cancelled" }))).toBe("broker.run_not_running");
    expect(await refusal(delegate({ releaseOk: false }))).toBe("broker.release_not_executable");
    expect(await refusal(delegate({ leaseUntil: new Date(Date.now() - 1_000).toISOString() }))).toBe("broker.work_authority_expired");
    expect(await refusal(delegate({ workNode: "sanctions-screen" }))).toBe("broker.work_authority_expired");
    expect(await refusal(delegate({ manifestDigest: "f".repeat(64) }))).toBe("broker.delegation_skill_unregistered");
    expect(await refusal(delegate({}, request({ skillVersion: "0.2.0" })))).toBe("broker.delegation_skill_mismatch");
    expect(await refusal(delegate({}, request({ skillId: "sample.evidence.check" })))).toBe("broker.delegation_skill_mismatch");
    // Not a declared dependency, and not in the node's envelope.
    expect(await refusal(delegate({}, request({ capabilities: ["screening.sanctions.v1"] })))).toBe("broker.delegation_capability_denied");
    // The skill itself is never delegated: no recursion through the gateway.
    expect(await refusal(delegate({}, request({ capabilities: ["skill.sample.registry.verify.v1"] })))).toBe("broker.delegation_capability_denied");
    // A parent that was already narrowed below the dependency cannot be widened.
    expect(await refusal(delegate({}, request(), await parent({ capabilities: ["skill.sample.registry.verify.v1"] })))).toBe("broker.delegation_capability_denied");
    expect(await refusal(delegate({}, request(), undefined, "tenant_other"))).toBe("broker.tenant_mismatch");
    expect(await refusal(delegate({}, request({ deadlineAt: new Date(Date.now() - 5_000).toISOString() })))).toBe("broker.delegation_expired");
    expect(await refusal(delegate({}, request(), "not-a-jwt"))).toBe("broker.parent_envelope_invalid");
  });

  it("never delegates a delegated envelope", async () => {
    const issued = await delegate();
    expect(await refusal(delegate({}, request(), issued.envelope))).toBe("broker.delegation_chain_refused");
    const claims = await verifyExecutionEnvelope(await parent(), SECRET);
    const direct = await mintDelegatedEnvelope({
      secret: SECRET, parent: claims, delegatedTo: "skills:sample.registry.verify@0.1.0", capabilities: [], effects: [], deadlineAt: Math.floor(Date.now() / 1000) + 10,
    });
    expect(await refusal(delegate({}, request(), direct.envelope))).toBe("broker.delegation_chain_refused");
  });
});


// CR-8 (delivery plan wave 1): a library manifest declares its provider capability by library name
// (`document.fields`); the plan, the node's envelope and the connector use the platform id.
describe("delegation to a library skill's provider capability", () => {
  const agentic = harnessPlanV2Schema.parse(JSON.parse(readFileSync(new URL("../../../artifacts/kyb-agentic.plan.json", import.meta.url), "utf8"))) as HarnessPlanV2;
  const nodeId = "document-fields-adjudicated-extract";
  const nodePermission = agentic.permissionEnvelopes.find((item) => item.nodeId === nodeId)!;
  const binding = agentic.skillBindings!.find((item) => item.skillId === "document.fields.adjudicated_extract")!;
  const entry = (JSON.parse(readFileSync(new URL("../../../config/business-skills.json", import.meta.url), "utf8")) as { skills: Array<{ skillId: string; semver: string; manifest: unknown; manifestDigest: string }> })
    .skills.find((item) => item.skillId === binding.skillId && item.semver === binding.semver)!;
  const agenticReads = {
    ...reads(),
    getPlan: async () => agentic,
    getRun: async () => ({ runId: "RUN-1", attempt: 1, status: "running", planDigest: agentic.planDigest }) as never,
    getExecutionWorkItem: async () => ({
      status: "RUNNING", lease: { fencingEpoch: 5, owner: "worker-1", leaseUntil: new Date(Date.now() + 60_000).toISOString(), executionId: "x", attemptNumber: 1 },
      constraints: { nodeId, runId: "RUN-1" },
    }) as never,
    getBusinessSkill: async () => ({ manifest: entry.manifest, manifestDigest: entry.manifestDigest }) as unknown as BusinessSkillRecord,
  };
  const token = () => mintExecutionEnvelope({
    secret: SECRET, tenantId: "tenant_demo", caseId: "case-1", runId: "RUN-1", nodeId, attempt: 1,
    planDigest: agentic.planDigest, permissionDigest: nodePermission.digest, capabilities: nodePermission.capabilities,
    effects: nodePermission.effects, caseWrites: [], fencingEpoch: 2, invocationId: `RUN-1:${nodeId}:1`, workItemId: "work-1", workFencingEpoch: 5,
  });
  const ask = async (capabilities: string[]) => issueDelegatedEnvelope({ db, envelopeSecret: SECRET, envelopeVerifier: SECRET, reads: agenticReads }, "tenant_demo", await token(),
    { skillId: binding.skillId, skillVersion: binding.semver, capabilities, deadlineAt: new Date(Date.now() + 20_000).toISOString() });

  it("the manifest names the library capability, the plan admits the platform one", () => {
    expect(JSON.stringify(entry.manifest)).toContain('"document.fields"');
    expect(binding.dependencyCapabilities).toEqual(["document.fields.extract.v1"]);
    expect(nodePermission.capabilities).toContain("document.fields.extract.v1");
  });

  it("delegates the platform capability, and nothing the skill does not declare", async () => {
    expect((await ask(["document.fields.extract.v1"])).capabilities).toEqual(["document.fields.extract.v1"]);
    expect(await refusal(ask(["document.ocr.extract.v1"]))).toBe("broker.delegation_capability_denied");
    expect(await refusal(ask(["document.fields"]))).toBe("broker.delegation_capability_denied");
  });
});
