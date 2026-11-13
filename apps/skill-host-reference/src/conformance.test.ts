import type { AddressInfo } from "node:net";
import { afterAll, describe, expect, it } from "vitest";
import { platformSkillManifestSchema, skillBundleLockSchema, stableDigest } from "@ehf/contracts";
import { REFERENCE_HOST_FIXTURES, runSkillHostConformance } from "@ehf/skill-conformance";
import { buildBundleLock, buildReferenceSkillHost, SAMPLE_SKILLS } from "./app.js";

const TOKEN = "reference-skill-host-token-for-tests";
const GATEWAY_TOKEN = "reference-skill-host-gateway-token";

describe("reference skill host", () => {
  let host = buildReferenceSkillHost({ token: TOKEN, gatewayToken: GATEWAY_TOKEN, syncWaitMs: 300 });
  let port = 0;
  afterAll(async () => { await host.close(); });

  it("serves a deterministic bundle lock whose manifest digests are the registry digests", () => {
    const lock = buildBundleLock(SAMPLE_SKILLS);
    expect(skillBundleLockSchema.parse(lock)).toEqual(lock);
    expect(buildBundleLock(SAMPLE_SKILLS).bundle_digest).toBe(lock.bundle_digest);
    for (const skill of SAMPLE_SKILLS) {
      const entry = lock.skills.find((item) => item.id === skill.manifest.id)!;
      expect(entry.manifest_digest).toBe(`sha256:${stableDigest(platformSkillManifestSchema.parse(skill.manifest))}`);
    }
  });

  it("passes the skill.execution.v1 conformance suite (§11 checks 1-9)", async () => {
    await host.listen({ host: "127.0.0.1", port: 0 });
    port = (host.server.address() as AddressInfo).port;
    const report = await runSkillHostConformance({
      baseUrl: `http://127.0.0.1:${port}`,
      token: TOKEN,
      fixtures: REFERENCE_HOST_FIXTURES,
      gatewayWorkloadToken: GATEWAY_TOKEN,
      pollTimeoutMs: 10_000,
      restart: async () => {
        await host.close();
        host = buildReferenceSkillHost({ token: TOKEN, gatewayToken: GATEWAY_TOKEN, syncWaitMs: 300 });
        await host.listen({ host: "127.0.0.1", port });
      },
    });
    const failed = report.checks.filter((check) => check.status !== "passed");
    expect(failed, JSON.stringify(failed, null, 2)).toEqual([]);
    expect(report.checks.map((check) => check.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(report.passed).toBe(true);
  }, 60_000);

  it("fails a host that reports a pass without its required context", async () => {
    const broken = SAMPLE_SKILLS.map((skill) => skill.manifest.id !== "sample.evidence.check" ? skill : {
      ...skill,
      execute: async (parameters: Record<string, unknown>) => ({
        business_status: "COMPLETED" as const, payload: { subject_ref: String(parameters.subject_ref), has_display_name: true },
      }),
    });
    const app = buildReferenceSkillHost({ token: TOKEN, skills: broken, syncWaitMs: 300 });
    await app.listen({ host: "127.0.0.1", port: 0 });
    try {
      const report = await runSkillHostConformance({
        baseUrl: `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`, token: TOKEN, fixtures: REFERENCE_HOST_FIXTURES, pollTimeoutMs: 10_000,
      });
      expect(report.passed).toBe(false);
      expect(report.checks.find((check) => check.id === 4)).toMatchObject({ status: "failed", details: expect.arrayContaining(["missing required context yielded COMPLETED"]) });
      expect(report.checks.find((check) => check.id === 7)?.details).toContain("restart: skipped (no restart hook)");
    } finally {
      await app.close();
    }
  }, 60_000);

  it("fails a host whose implemented_synthetic skill proposes a non-synthetic canonical record", async () => {
    const broken = SAMPLE_SKILLS.map((skill) => skill.manifest.id !== "sample.registry.verify" ? skill : {
      ...skill,
      execute: async (parameters: Record<string, unknown>, services: Parameters<typeof skill.execute>[1]) => {
        const result = await services.capabilities.invoke("business.registry.lookup.v1", { name: String(parameters.company_name) }, { idempotencyKey: "registry-lookup" });
        services.records.propose({
          record_type: "CanonicalRecord", local_ref: "registry-record",
          body: { object_type: "RegistryRecord", object_id: "registry:x", version_id: "v1", data: { status: "ACTIVE" }, observed_at: services.clock.now(),
            source_refs: [], classification: "CONFIDENTIAL", synthetic: false },
          evidence: result.receiptDigest ? [{ receipt_digest: result.receiptDigest }] : [],
        });
        return { business_status: "COMPLETED" as const, payload: { company_name: String(parameters.company_name), registered: true, active: true } };
      },
    });
    const app = buildReferenceSkillHost({ token: TOKEN, skills: broken, syncWaitMs: 300 });
    await app.listen({ host: "127.0.0.1", port: 0 });
    try {
      const report = await runSkillHostConformance({
        baseUrl: `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`, token: TOKEN, fixtures: REFERENCE_HOST_FIXTURES, pollTimeoutMs: 10_000,
      });
      expect(report.checks.find((check) => check.id === 6)).toMatchObject({
        status: "failed", details: expect.arrayContaining(["sample.registry.verify proposed CanonicalRecord registry-record: record_synthetic_required"]),
      });
    } finally {
      await app.close();
    }
  }, 60_000);

  it("refuses unauthenticated callers and unknown fields", async () => {
    const app = buildReferenceSkillHost({ token: TOKEN });
    expect((await app.inject({ method: "GET", url: "/v1/bundle" })).statusCode).toBe(401);
    const response = await app.inject({
      method: "POST", url: "/v1/skills/sample.evidence.check/executions",
      headers: { authorization: `Bearer ${TOKEN}`, "idempotency-key": "x" },
      payload: { contract_version: "skill.execution.v1", unexpected: true },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: { code: "INPUT_INVALID", retryable: false, detail_ref: null } });
    await app.close();
  });
});
