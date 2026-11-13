import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { businessSkillCatalogSchema, librarySkillBundleLock, skillBundleRegistryReference } from "@ehf/contracts";
import type { Database } from "@ehf/persistence";
import { buildControlApi } from "./app.js";

const read = (path: string) => JSON.parse(readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8")) as unknown;
const registry = businessSkillCatalogSchema.parse(read("config/business-skills.json"));
const catalog = read("config/skill-library/catalog.json") as { version: string; bundle_code_hash: string; skills: unknown[] };
const lock = librarySkillBundleLock(catalog, { imageDigest: `sha256:${"1".repeat(64)}`, sbomDigest: `sha256:${"2".repeat(64)}` });

it("registers the bundle lock of the vendored library catalog against the registry seeded from it", async () => {
  const edge = "edge-test-credential-000000000004";
  const lookups: string[] = [];
  const query = vi.fn(async (text: string, values: unknown[] = []) => {
    if (text.includes("from harness_control.business_skill_registry")) {
      lookups.push(`${String(values[0])}@${String(values[1])}`);
      const entry = registry.skills.find((item) => item.skillId === values[0] && item.semver === values[1]);
      return entry ? { rowCount: 1, rows: [{
        skill_id: entry.skillId, semver: entry.semver, manifest: entry.manifest, manifest_digest: entry.manifestDigest, status: entry.status,
        maturity: entry.maturity, source: entry.source, owner: entry.owner, created_at: new Date(), updated_at: new Date(),
      }] } : { rowCount: 0, rows: [] };
    }
    if (text.includes("insert into harness_control.artifact_registry(")) {
      return { rowCount: 1, rows: [{
        tenant_id: values[0], artifact_kind: values[1], digest: values[2], reference: values[3], status: "registered", registered_by: values[4],
        approved_by: null, revoked_by: null, reason_code: null, registered_at: new Date(), approved_at: null, revoked_at: null,
      }] };
    }
    return { rowCount: 1, rows: [] };
  });
  const app = buildControlApi({ db: { query, connect: async () => ({ query, release: () => undefined }) } as unknown as Database, env: { EDGE_SERVICE_TOKEN: edge } });
  app.log.level = "silent";
  const headers = { authorization: `Bearer ${edge}`, "x-actor-id": "author", "x-actor-roles": "Harness.Author" };
  try {
    expect(lock.skills).toHaveLength(registry.skills.length);
    const created = await app.inject({ method: "POST", url: "/v1/registry/skill-bundles", headers, payload: { lock } });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json().entry).toMatchObject({
      kind: "skill-bundle", digest: catalog.bundle_code_hash, status: "registered", reference: skillBundleRegistryReference(lock),
    });
    // Every (id, version) of the lock was found in the registry, under the same manifest digest.
    expect(lookups.sort()).toEqual(lock.skills.map((skill) => `${skill.id}@${skill.version}`).sort());
    for (const skill of lock.skills) {
      expect(skill.manifest_digest).toBe(`sha256:${registry.skills.find((entry) => entry.skillId === skill.id)!.manifestDigest}`);
      expect(skill.effects).toBe(registry.skills.find((entry) => entry.skillId === skill.id)!.effects.mode);
    }

    const refuse = async (changed: Record<string, unknown>) => {
      const skills = lock.skills.map((skill) => (skill.id === "decision.disposition.record" ? { ...skill, ...changed } : skill));
      const response = await app.inject({ method: "POST", url: "/v1/registry/skill-bundles", headers, payload: { lock: { ...lock, skills } } });
      expect(response.statusCode).toBe(409);
      return response.json().error as string;
    };
    expect(await refuse({ manifest_digest: `sha256:${"f".repeat(64)}` })).toBe(`skill_bundle.manifest_digest_mismatch:decision.disposition.record@${lock.skills.find((skill) => skill.id === "decision.disposition.record")!.version}`);
    // A human-gated skill's lock entry must not drop to read-only or widen to an external write.
    expect(await refuse({ effects: "external_write" })).toBe(`skill_bundle.effect_mode_mismatch:decision.disposition.record@${lock.skills.find((skill) => skill.id === "decision.disposition.record")!.version}`);
    expect(await refuse({ version: "0.1.0" })).toBe("skill_bundle.skill_unregistered:decision.disposition.record@0.1.0");
  } finally { await app.close(); }
});
