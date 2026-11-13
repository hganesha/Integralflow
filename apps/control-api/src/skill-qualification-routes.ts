import type { FastifyInstance, FastifyRequest } from "fastify";
import { skillQualificationSchema } from "@ehf/contracts";
import { approveSkillQualification, getBusinessSkill, getPlan, listSkillQualifications, registerSkillQualification, type Database } from "@ehf/persistence";
import type { PlatformAction, Principal, ResourceRef } from "@ehf/identity";

type Authorize = (request: FastifyRequest, action: PlatformAction, resource?: ResourceRef) => Promise<Principal>;

export function registerSkillQualificationRoutes(app: FastifyInstance, options: { db: Database; authorize: Authorize }): void {
  app.get("/v1/registry/skill-qualifications", async (request) => {
    const principal = await options.authorize(request, "capability.read", { kind: "skill-qualification" });
    return { qualifications: await listSkillQualifications(options.db, principal.tenantId) };
  });
  app.post("/v1/registry/skill-qualifications", async (request, reply) => {
    const principal = await options.authorize(request, "release.create", { kind: "skill-qualification" });
    const parsed = skillQualificationSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "skill_qualification.invalid", issues: parsed.error.issues.slice(0, 20) });
    const q = parsed.data;
    const skill = await getBusinessSkill(options.db, q.skillId, q.skillVersion);
    if (!skill || skill.manifestDigest !== q.manifestDigest) return reply.code(409).send({ error: "skill_qualification.manifest_mismatch" });
    if (skill.maturity === "implemented_synthetic" || skill.maturity === "catalogued" || skill.maturity === "designed") {
      return reply.code(409).send({ error: "skill_qualification.integration_required" });
    }
    const plan = await getPlan(options.db, q.planDigest, principal.tenantId);
    const binding = plan?.skillBindings?.find((item) => item.skillId === q.skillId && item.semver === q.skillVersion);
    if (!binding || binding.manifestDigest !== q.manifestDigest || binding.bundleDigest !== q.bundleDigest) {
      return reply.code(409).send({ error: "skill_qualification.plan_mismatch" });
    }
    try {
      return reply.code(201).send(await registerSkillQualification(options.db, { tenantId: principal.tenantId, actor: principal.subjectId, qualification: q }));
    } catch (error) {
      const code = error instanceof Error ? error.message : "skill_qualification.registration_failed";
      return reply.code(code === "artifact.separation_of_duties" ? 403 : 400).send({ error: code });
    }
  });
  app.post<{ Params: { digest: string } }>("/v1/registry/skill-qualifications/:digest/approve", async (request, reply) => {
    const principal = await options.authorize(request, "release.approve", { kind: "skill-qualification", id: request.params.digest });
    try {
      return await approveSkillQualification(options.db, { tenantId: principal.tenantId, actor: principal.subjectId, digest: request.params.digest });
    } catch (error) {
      const code = error instanceof Error ? error.message : "skill_qualification.approval_failed";
      return reply.code(code === "artifact.not_registered" ? 404 : code.includes("duties") || code.includes("reviewer") ? 403 : 400).send({ error: code });
    }
  });
}
