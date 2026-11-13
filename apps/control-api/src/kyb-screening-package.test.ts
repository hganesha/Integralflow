import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compilePackage } from "@ehf/compiler";
import { harnessPlanV2Schema, verifyHarnessPlanDigest, type HarnessPlanV2 } from "@ehf/contracts";
import { loadAuthoringTemplates } from "./authoring-templates.js";
import { analyzeAuthoringSources, compileAuthoringDraft, evaluateCompiledPlan } from "./authoring.js";

// Production slice 1 (docs/implementation/production-slice-1.md): what the plan may and may not do.
const root = fileURLToPath(new URL("../../../", import.meta.url));
const domainsPath = join(root, "domains");
const modelProfilesPath = join(root, "config/model-profiles.json");
const readJson = <T>(path: string): T => JSON.parse(readFileSync(join(root, path), "utf8")) as T;
const workflow = readJson<{ steps: Array<{ id: string; skill_id: string }> }>("domains/kyb-screening/source/workflow.json");
const policyDigest = createHash("sha256").update(readFileSync(join(root, "domains/kyb-screening/policy/slice-policy.json"))).digest("hex");

const LOOP_SKILLS: Record<string, string[]> = {
  "ownership-review": ["ownership.circular.detect", "ownership.control.resolve", "ownership.nominee.detect"],
  "screening-review": ["screening.pep.relationship.resolve", "screening.sanctions.control.evaluate"],
};
const SKILL_PROFILE: Record<string, string> = {
  "decision.policy.resolve": "agent.decision_support", "decision.human.review": "agent.decision_support",
  "entity.resolve": "agent.identity_ownership", "registry.company.verify": "agent.identity_ownership", "ownership.graph.build": "agent.identity_ownership",
  "ownership.interest.calculate": "agent.identity_ownership", "ownership.ubo.resolve": "agent.identity_ownership", "ownership.ubo.verify": "agent.identity_ownership",
  "screening.name.normalize": "agent.screening", "screening.sanctions.execute": "agent.screening", "screening.pep.execute": "agent.screening",
  "screening.match.disambiguate": "agent.screening", "screening.sanctions.ownership.evaluate": "agent.screening",
};

describe("KYB screening and ownership slice", async () => {
  const template = (await loadAuthoringTemplates(domainsPath)).find((item) => item.id === "kyb-screening")!;
  const compiled = await compileAuthoringDraft({ ...template, modelProfilesPath, registryCapabilities: [] });
  const plan = compiled.plan as HarnessPlanV2;
  const node = (id: string) => plan.graph.nodes.find((item) => item.id === id)!;
  const skillNodes = plan.graph.nodes.filter((item) => typeof item.config.skillId === "string");

  it("compiles from the authoring template with zero errors to the committed plan", () => {
    expect(analyzeAuthoringSources(template.packageSource, template.workflowSource).diagnostics.filter((item) => item.severity === "error")).toEqual([]);
    expect(compiled.diagnostics.filter((item) => item.severity === "error")).toEqual([]);
    expect(verifyHarnessPlanDigest(plan)).toBe(true);
    expect(evaluateCompiledPlan(plan).checks.filter((check) => !check.passed)).toEqual([]);
    expect(plan.planDigest).toBe(readJson<{ planDigest: string }>("artifacts/kyb-screening.plan.json").planDigest);
    expect(harnessPlanV2Schema.parse(compilePackage(join(root, "domains/kyb-screening"), { modelProfiles: modelProfilesPath }).plan).planDigest).toBe(plan.planDigest);
  });

  it("runs exactly the slice's 13 skills, in order, each as its agent profile", () => {
    const order = plan.graph.nodeOrder.map((id) => node(id)).filter((item) => typeof item.config.skillId === "string").map((item) => item.config.skillId);
    expect(order).toEqual(workflow.steps.map((step) => step.skill_id));
    for (const item of skillNodes) {
      const profileId = SKILL_PROFILE[item.config.skillId as string];
      expect(item.config.agentRef, item.id).toBe(profileId);
      const profile = plan.agentProfiles!.find((entry) => entry.id === profileId)!;
      expect(profile.allowedSkills.map((skill) => skill.skillId)).toContain(item.config.skillId);
      expect(profile.allowedCapabilities).toContain(item.config.capabilityId);
    }
    // No profile may run a skill outside the slice: its workflow skills and its review loops' skills.
    const allowed = plan.agentProfiles!.flatMap((profile) => profile.allowedSkills.map((skill) => skill.skillId)).sort();
    expect(allowed).toEqual([...Object.keys(SKILL_PROFILE), ...Object.values(LOOP_SKILLS).flat()].sort());
  });

  it("pins the candidate slice policy into every policy-reading skill and resolves every field", () => {
    for (const item of skillNodes) {
      const policy = item.config.skillPolicy as { policyRef: string; bundleDigest: string; unresolved: string[]; values: Record<string, unknown> } | undefined;
      expect(policy, item.id).toBeDefined();
      expect(policy).toMatchObject({ policyRef: "policy.kyb.screening-ownership.us", bundleDigest: policyDigest, unresolved: [] });
    }
    expect((node("ownership-ubo-resolve").config.skillPolicy as { values: Record<string, unknown> }).values.ownership_threshold).toBe("0.25");
    expect((node("screening-sanctions-ownership-evaluate").config.skillPolicy as { values: Record<string, unknown> }).values.sanctions_ownership)
      .toEqual({ rule: "ofac_50_percent", threshold: "0.5" });
  });

  it("takes the OFAC 50 percent designated set from the sanctions skill's confirmed hits, never an authored list", () => {
    const ofac = node("screening-sanctions-ownership-evaluate");
    expect(ofac.config.skillParameterBindings).toEqual({ blocked_ids: "screening-sanctions-execute.payload.hits[*].entity_id", target: "acquire-ownership.subjectEntityId" });
    expect(ofac.config.requireBoundParameters).toBe(true);
    expect(plan.graph.nodeOrder.indexOf("screening-sanctions-execute")).toBeLessThan(plan.graph.nodeOrder.indexOf(ofac.id));
  });

  it("limits the two review agents to read-only connectors and a link to their own agent-derived evidence", () => {
    for (const id of ["ownership-review", "screening-review"]) {
      const agent = node(id);
      expect(agent.kind).toBe("agent");
      const capability = plan.capabilities.find((item) => item.id === agent.config.capabilityId)!;
      expect(capability).toMatchObject({ kind: "model", adapterBindingId: "openrouter:model.standard.v1" });
      const tools = (agent.config.loop as { tools: string[]; maxSteps: number }).tools;
      for (const tool of tools) expect(plan.capabilities.find((item) => item.id === tool)!.effect, tool).toBe("read");
      expect((agent.config.loop as { maxSteps: number }).maxSteps).toBeLessThanOrEqual(6);
      // The model, its read-only lookups, and the candidates of its read-only loop skills; nothing else.
      const loop = agent.config.loop as { skills: Array<{ skillId: string; skillPolicy?: { unresolved: string[] } }> };
      expect(loop.skills.map((skill) => skill.skillId)).toEqual(LOOP_SKILLS[id]);
      const skillCandidates = loop.skills.map((skill) => plan.skillBindings!.find((binding) => binding.skillId === skill.skillId)!);
      for (const binding of skillCandidates) expect(binding.effects?.mode ?? "read_only", binding.skillId).toBe("read_only");
      for (const skill of loop.skills) expect(skill.skillPolicy?.unresolved ?? [], skill.skillId).toEqual([]);
      expect(plan.permissionEnvelopes.find((item) => item.nodeId === id)!.capabilities.sort())
        .toEqual([capability.id, ...tools, ...skillCandidates.flatMap((binding) => binding.candidates.map((candidate) => candidate.capabilityId))].sort());
      // Completion is the runtime's judgment over this agent's own skill nodes.
      const completion = agent.config.completion as { criteria: Array<{ nodeId: string }> };
      for (const criterion of completion.criteria) expect(node(criterion.nodeId).config.agentRef).toBe(agent.config.agentRef);
      expect((agent.config.caseWrites as Array<{ commandType: string }>).map((write) => write.commandType)).toEqual(["LinkEvidence"]);
      expect(agent.config.evidenceCapture).toMatchObject({ trustTier: "AGENT_DERIVED", instructionTrust: "UNTRUSTED_DATA" });
      // The agent never decides: its schema demands a human review, and screening proposals are never final.
      const profile = plan.agentProfiles!.find((entry) => entry.id === agent.config.agentRef)!;
      expect((profile.outputSchema as { properties: { requiresHumanReview: unknown } }).properties.requiresHumanReview).toEqual({ const: true });
    }
    const proposals = (plan.agentProfiles!.find((entry) => entry.id === "agent.screening")!.outputSchema as { properties: { proposals: { items: { properties: { final: unknown } } } } });
    expect(proposals.properties.proposals.items.properties.final).toEqual({ const: false });
    expect(plan.budgets.maxModelCalls).toBe(14);
  });

  it("ends at a dual-control human review: no skill or agent records a disposition", () => {
    expect(plan.graph.nodes.some((item) => item.config.skillId === "decision.disposition.record")).toBe(false);
    expect(node("decision-human-review-approval")).toMatchObject({ kind: "approval", config: { dualControlRequired: true } });
    const writes = plan.graph.nodes.flatMap((item) => ((item.config.caseWrites ?? []) as Array<{ commandType: string }>).map((write) => write.commandType));
    expect(writes).not.toContain("FinalizeDisposition");
    expect(writes).not.toContain("SubmitDecisionRecommendation");
    // The result is reachable only through an approved review; everything else stops for handoff.
    expect(plan.graph.edges.filter((edge) => edge.to === "result").map((edge) => [edge.from, edge.condition]))
      .toEqual([["decision-human-review-effects", 'decision-human-review-effects.decision == "APPROVE"']]);
  });

  it("acquires only the slice's sources: registry, LEI, officers, ownership, sanctions and PEP", () => {
    const acquisitions = plan.graph.nodes.filter((item) => item.id.startsWith("acquire-")).map((item) => item.id).sort();
    expect(acquisitions).toEqual(["acquire-lei", "acquire-officers", "acquire-ownership", "acquire-pep", "acquire-registry", "acquire-sanctions"]);
  });
});
