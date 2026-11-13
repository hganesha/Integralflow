import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { harnessPlanV2Schema, skillBundleRegistryReference, stableDigest, type HarnessPlanV2 } from "@ehf/contracts";
import { mintDelegatedEnvelope, mintExecutionEnvelope, verifyExecutionEnvelope } from "@ehf/execution-auth";
import type { BusinessSkillRecord, Database } from "@ehf/persistence";
import { buildBundleLock, SAMPLE_SKILLS } from "@ehf/skill-host-reference";
import { buildControlApi } from "./app.js";

const SECRET = "broker-envelope-secret-for-tests-01";
const plan = harnessPlanV2Schema.parse(JSON.parse(readFileSync(
  new URL("../../../packages/contracts/test-fixtures/skill-hosted.plan.json", import.meta.url), "utf8"))) as HarnessPlanV2;
const permission = plan.permissionEnvelopes.find((item) => item.nodeId === "registry-verify")!;
const manifest = SAMPLE_SKILLS.find((skill) => skill.manifest.id === "sample.registry.verify")!.manifest;
const db = { query: async () => ({ rows: [], rowCount: 0 }) } as unknown as Database;



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



describe("delegation and skill-bundle routes", () => {
  const edge = "edge-test-credential-000000000003";
  const runtimeToken = "runtime-service-token-000000001";
  const lock = buildBundleLock(SAMPLE_SKILLS);

  function app(query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>) {
    const client = { query, release: () => undefined };
    const instance = buildControlApi({
      db: { query, connect: async () => client } as unknown as Database,
      env: { EDGE_SERVICE_TOKEN: edge, RUNTIME_SERVICE_TOKEN: runtimeToken, EXECUTION_ENVELOPE_SECRET: SECRET },
    });
    instance.log.level = "silent";
    return instance;
  }

  it("no longer serves delegation: the gateway issues delegated envelopes itself", async () => {
    const instance = app(async () => ({ rows: [], rowCount: 0 }));
    try {
      const response = await instance.inject({ method: "POST", url: "/v1/runtime/envelopes/delegate", headers: { authorization: `Bearer ${runtimeToken}`, "x-execution-envelope": await parent() }, payload: request() });
      expect(response.statusCode).toBe(404);
    } finally { await instance.close(); }
  });

  it("registers a bundle lock under release.create and approves it under release.approve by someone else", async () => {
    const registered = new Map<string, Record<string, unknown>>();
    const query = vi.fn(async (text: string, values: unknown[] = []) => {
      if (text.includes("from harness_control.business_skill_registry")) {
        const skill = SAMPLE_SKILLS.find((item) => item.manifest.id === values[0] && (values[1] === null || item.manifest.semver === values[1]));
        return skill ? { rowCount: 1, rows: [{
          skill_id: skill.manifest.id, semver: skill.manifest.semver, manifest: skill.manifest, manifest_digest: stableDigest(skill.manifest),
          status: "active", maturity: "implemented_synthetic", source: { path: "x", revision: "y" }, owner: "o", created_at: new Date(), updated_at: new Date(),
        }] } : { rowCount: 0, rows: [] };
      }
      if (text.includes("insert into harness_control.artifact_registry(")) {
        const row = { tenant_id: values[0], artifact_kind: values[1], digest: values[2], reference: values[3], status: "registered", registered_by: values[4],
          approved_by: null, revoked_by: null, reason_code: null, registered_at: new Date(), approved_at: null, revoked_at: null };
        registered.set(String(values[2]), row);
        return { rowCount: 1, rows: [row] };
      }
      if (text.includes("from harness_control.artifact_registry") && text.includes("for update")) {
        const row = registered.get(String(values[2]));
        return { rowCount: row ? 1 : 0, rows: row ? [row] : [] };
      }
      if (text.includes("update harness_control.artifact_registry")) {
        const row = { ...registered.get(String(values[2]))!, status: "approved", approved_by: values[3], approved_at: new Date() };
        registered.set(String(values[2]), row);
        return { rowCount: 1, rows: [row] };
      }
      return { rowCount: 1, rows: [] };
    });
    const instance = app(query);
    const as = (actor: string, roles: string) => ({ authorization: `Bearer ${edge}`, "x-actor-id": actor, "x-actor-roles": roles });
    try {
      expect((await instance.inject({ method: "POST", url: "/v1/registry/skill-bundles", headers: as("reader", "Harness.Reader"), payload: { lock } })).statusCode).toBe(403);
      const created = await instance.inject({ method: "POST", url: "/v1/registry/skill-bundles", headers: as("author", "Harness.Author"), payload: { lock } });
      expect(created.statusCode, created.body).toBe(201);
      expect(created.json().entry).toMatchObject({ kind: "skill-bundle", digest: lock.bundle_digest.slice(7), status: "registered", reference: skillBundleRegistryReference(lock) });
      const self = await instance.inject({ method: "POST", url: `/v1/registry/skill-bundles/${lock.bundle_digest}/approve`, headers: as("author", "Harness.Author,Harness.Approver") });
      expect(self.statusCode).toBe(403);
      const approved = await instance.inject({ method: "POST", url: `/v1/registry/skill-bundles/${lock.bundle_digest}/approve`, headers: as("approver", "Harness.Approver") });
      expect(approved.statusCode, approved.body).toBe(200);
      expect(approved.json()).toMatchObject({ status: "approved", approvedBy: "approver" });

      // A lock naming a skill version the registry does not hold cannot be registered.
      const foreign = { ...lock, skills: [{ ...lock.skills[0]!, version: "9.9.9" }] };
      const refused = await instance.inject({ method: "POST", url: "/v1/registry/skill-bundles", headers: as("author", "Harness.Author"), payload: { lock: foreign } });
      expect(refused.statusCode).toBe(409);
      expect(refused.json().error).toMatch(/^skill_bundle\.skill_unregistered:/);
      const invalid = await instance.inject({ method: "POST", url: "/v1/registry/skill-bundles", headers: as("author", "Harness.Author"), payload: { lock: { ...lock, extra: 1 } } });
      expect(invalid.statusCode).toBe(400);
    } finally { await instance.close(); }
  });
});
