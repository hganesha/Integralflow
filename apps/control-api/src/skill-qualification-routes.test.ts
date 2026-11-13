import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { businessSkillCatalogSchema, harnessPlanV2Schema, librarySkillBundleLock, skillBundleLockDigest, type SkillQualification } from "@ehf/contracts";
import { admitPlan, createDatabase, getBusinessSkill, upsertBusinessSkill, type Database } from "@ehf/persistence";
import { buildControlApi } from "./app.js";

const edge = "qualification-route-test-credential-0000001";
const headers = (actor: string, role = "Harness.Author", tenantId = "tenant_demo") => ({
  authorization: `Bearer ${edge}`, "x-actor-id": actor, "x-actor-roles": role, "x-tenant-id": tenantId,
});

it("uses release authority and validates qualification bodies before persistence", async () => {
  const db = { query: async () => ({ rows: [], rowCount: 0 }) } as unknown as Database;
  const app = buildControlApi({ db, env: { EDGE_SERVICE_TOKEN: edge } });
  app.log.level = "silent";
  try {
    const reader = await app.inject({ method: "POST", url: "/v1/registry/skill-qualifications", headers: headers("reader", "Harness.Reader"), payload: {} });
    expect(reader.statusCode).toBe(403);
    const author = await app.inject({ method: "POST", url: "/v1/registry/skill-qualifications", headers: headers("author"), payload: {} });
    expect(author.statusCode).toBe(400);
    expect(author.json().error).toBe("skill_qualification.invalid");
  } finally { await app.close(); }
});

describe.skipIf(!process.env.EHF_TEST_DATABASE_URL)("qualification routes against PostgreSQL", () => {
  it("registers exact admitted scope, requires named independent approval and isolates tenant reads", async () => {
    const read = (path: string) => JSON.parse(readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8"));
    const registry = businessSkillCatalogSchema.parse(read("config/business-skills.json"));
    const plan = harnessPlanV2Schema.parse(read("artifacts/archive/kyb.plan.json"));
    const binding = plan.skillBindings!.find((item) => item.skillId === "entity.resolve")!;
    const entry = registry.skills.find((item) => item.skillId === binding.skillId)!;
    const lock = librarySkillBundleLock(read("config/skill-library/catalog.json"), {
      imageDigest: `sha256:${"1".repeat(64)}`, sbomDigest: `sha256:${"2".repeat(64)}`,
    });
    const tenantId = `qualification-route-${randomUUID()}`;
    const db = createDatabase(process.env.EHF_TEST_DATABASE_URL);
    const app = buildControlApi({ db, env: { EDGE_SERVICE_TOKEN: edge },
      serviceGrants: [{ token: edge, subjectId: "qualification-test-edge", roles: ["Edge.Delegate"], tenantId }],
    });
    app.log.level = "silent";
    const q: SkillQualification = {
      schemaVersion: "skill.qualification.v1", skillId: binding.skillId, skillVersion: binding.semver,
      manifestDigest: binding.manifestDigest, bundleDigest: binding.bundleDigest!, bundleLockDigest: skillBundleLockDigest(lock),
      planDigest: plan.planDigest, policySnapshotRef: "policy:v1", policyContextDigest: "3".repeat(64),
      jurisdictions: ["US"], purpose: "onboarding", validFrom: "2020-01-01T00:00:00Z", expiresAt: "2099-01-01T00:00:00Z",
      independentReviewer: "qualification-reviewer", evidence: {
        reportRef: "test-fixture:report", reportDigest: "4".repeat(64), datasetDigest: "5".repeat(64), sampleCount: 10,
        scopeDescription: "Isolated qualification API test fixture, not production evidence", controlsPassed: true,
        metrics: [{ name: "fixture", value: 1, comparison: "at_least", threshold: 1 }],
      },
    };
    const submit = (body: unknown) => app.inject({ method: "POST", url: "/v1/registry/skill-qualifications", headers: headers("qualification-author", "Harness.Author", tenantId), payload: body as Record<string, unknown> });
    const previous = await getBusinessSkill(db, entry.skillId, entry.semver);
    try {
      await admitPlan(db, plan, tenantId);
      expect((await submit(q)).json().error).toBe("skill_qualification.integration_required");
      // Fixture promotion only in this disposable test database.
      await upsertBusinessSkill(db, { manifest: entry.manifest, source: entry.source, status: "active", maturity: "integration_verified" });
      expect((await submit({ ...q, planDigest: "0".repeat(64) })).json().error).toBe("skill_qualification.plan_mismatch");
      expect((await submit({ ...q, independentReviewer: "qualification-author" })).statusCode).toBe(403);
      const registered = await submit(q);
      expect(registered.statusCode, registered.body).toBe(201);
      const digest = registered.json().digest as string;
      const approve = (actor: string) => app.inject({ method: "POST", url: `/v1/registry/skill-qualifications/${digest}/approve`, headers: headers(actor, "Harness.Approver", tenantId) });
      expect((await approve("different-reviewer")).statusCode).toBe(403);
      expect((await approve("qualification-reviewer")).statusCode).toBe(200);
      const listed = await app.inject({ url: "/v1/registry/skill-qualifications", headers: headers("reader", "Harness.Reader", tenantId) });
      expect(listed.json().qualifications).toMatchObject([{ digest, status: "approved" }]);
      const other = await app.inject({ url: "/v1/registry/skill-qualifications", headers: headers("reader", "Harness.Reader", tenantId + "-other") });
      expect(other.statusCode).toBe(403);
    } finally {
      if (previous) await upsertBusinessSkill(db, { manifest: previous.manifest, source: previous.source, status: previous.status, maturity: previous.maturity });
      await app.close(); await db.end();
    }
  });
});
