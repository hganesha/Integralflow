import type { FastifyInstance, FastifyRequest } from "fastify";
import { businessSkillEffects, skillBundleLockSchema, type SkillBundleLock } from "@ehf/contracts";
import type { PlatformAction, Principal, ResourceRef } from "@ehf/identity";
import { approveSkillBundle, getBusinessSkill, registerSkillBundle, type Database } from "@ehf/persistence";

type Authorize = (request: FastifyRequest, action: PlatformAction, resource?: ResourceRef) => Promise<Principal>;

/**
 * Every skill a lock serves must be the exact business-skill version the platform ingested:
 * the lock's `manifest_digest` is the registry's manifest digest (businessSkillManifestDigest:
 * sha256 over the canonical JSON of the catalog entry) and its `effects` the registry's effect
 * mode (CR-5). A lock naming a skill the registry does not hold, a different manifest or a
 * wider effect mode cannot be registered.
 */
async function checkLockAgainstRegistry(db: Database, lock: SkillBundleLock): Promise<string | null> {
  for (const skill of lock.skills) {
    const record = await getBusinessSkill(db, skill.id, skill.version);
    if (!record) return `skill_bundle.skill_unregistered:${skill.id}@${skill.version}`;
    if (`sha256:${record.manifestDigest}` !== skill.manifest_digest) return `skill_bundle.manifest_digest_mismatch:${skill.id}@${skill.version}`;
    if (businessSkillEffects(record.manifest).mode !== skill.effects) return `skill_bundle.effect_mode_mismatch:${skill.id}@${skill.version}`;
  }
  return null;
}

/**
 * Skill-host bundles in the artifact registry (skill.execution.v1 §8).
 *
 * Registration records the lock's `bundle_digest` as a `skill-bundle` artifact whose reference
 * pins the exact lock content; it takes `release.create` (an author ships a bundle like a
 * release). Approval takes `release.approve` and, as for every registry artifact, must be a
 * different person from the registrant. Revocation is the generic
 * `POST /v1/registry/artifacts/skill-bundle/:digest/revoke`; listing is
 * `GET /v1/registry/artifacts?kind=skill-bundle`.
 */
export function registerSkillBundleRoutes(app: FastifyInstance, options: { db: Database; authorize: Authorize }): void {
  app.post("/v1/registry/skill-bundles", { bodyLimit: 2 * 1024 * 1024 }, async (request, reply) => {
    const principal = await options.authorize(request, "release.create", { kind: "skill-bundle" });
    const body = request.body && typeof request.body === "object" && !Array.isArray(request.body) ? request.body as Record<string, unknown> : {};
    const parsed = skillBundleLockSchema.safeParse("lock" in body ? body.lock : body);
    if (!parsed.success) return reply.code(400).send({ error: "skill_bundle.lock_invalid", issues: parsed.error.issues.slice(0, 20) });
    const problem = await checkLockAgainstRegistry(options.db, parsed.data);
    if (problem) return reply.code(409).send({ error: problem });
    try {
      const result = await registerSkillBundle(options.db, { tenantId: principal.tenantId, lock: parsed.data, actor: principal.subjectId });
      // Idempotent: re-registering the same lock returns the existing entry, whatever its status.
      return reply.code(result.entry.status === "registered" ? 201 : 200).send(result);
    } catch (error) {
      const code = error instanceof Error ? error.message : "skill_bundle.registration_failed";
      if (code === "artifact.registry_conflict") return reply.code(409).send({ error: code });
      return reply.code(400).send({ error: code });
    }
  });

  app.post<{ Params: { digest: string } }>("/v1/registry/skill-bundles/:digest/approve", async (request, reply) => {
    const principal = await options.authorize(request, "release.approve", { kind: "skill-bundle", id: request.params.digest });
    if (!/^(sha256:)?[a-f0-9]{64}$/.test(request.params.digest)) return reply.code(400).send({ error: "artifact.digest_invalid" });
    try {
      return await approveSkillBundle(options.db, { tenantId: principal.tenantId, bundleDigest: request.params.digest, actor: principal.subjectId });
    } catch (error) {
      const code = error instanceof Error ? error.message : "skill_bundle.approval_failed";
      if (code === "artifact.separation_of_duties") return reply.code(403).send({ error: code });
      if (code === "artifact.not_registered") return reply.code(404).send({ error: code });
      if (code === "artifact.revoked") return reply.code(409).send({ error: code });
      return reply.code(400).send({ error: code });
    }
  });
}
