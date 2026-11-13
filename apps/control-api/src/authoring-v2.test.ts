import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { agentRegistrationSchema, skillRegistrationSchema, stableDigest, verifyHarnessPlanDigest } from "@ehf/contracts";
import { applyAgentToAuthoringSources, materializeRegisteredContracts } from "./authoring-agents.js";
import { analyzeAuthoringSources, compileAuthoringDraft, evaluateCompiledPlan } from "./authoring.js";
import { validateSourceFiles } from "./harnessc.js";

const modelProfilesPath = fileURLToPath(new URL("../../../config/model-profiles.json", import.meta.url));

// The pre-library KYC v2 package (two agent profiles) is the agent-profile authoring fixture;
// domains/archive/kyc-v2-deterministic itself now runs library skills and has no agent profile.
const fixturePath = fileURLToPath(new URL("../../../packages/contracts/test-fixtures/agent-profiles/", import.meta.url));
function agentProfileFixture() {
  const read = (file: string) => readFileSync(`${fixturePath}${file}`, "utf8");
  return { id: "agent-profile-fixture", name: "KYC agent-profile fixture", packageSource: read("package.yaml"), workflowSource: read("workflow.yaml"), sourceFiles: { "policy-binding.yaml": read("policy-binding.yaml") } };
}

describe("agent-profile authoring on the pre-library KYC fixture", () => {
  it("loads, compiles and evaluates the investigation loop and advisory agent with its policy dependency", async () => {
    const template = agentProfileFixture();
    expect(template.name).toBe("KYC agent-profile fixture");
    const analysis = analyzeAuthoringSources(template.packageSource, template.workflowSource);
    expect(analysis.diagnostics.filter((item) => item.severity === "error")).toEqual([]);
    const result = await compileAuthoringDraft({ ...template, modelProfilesPath, registryCapabilities: [] });
    expect(result.diagnostics.filter((item) => item.severity === "error")).toEqual([]);
    const plan = result.plan!;
    expect(plan.apiVersion).toBe("harness.factory/plan-v2");
    expect(verifyHarnessPlanDigest(plan)).toBe(true);
    if (plan.apiVersion !== "harness.factory/plan-v2") throw new Error("expected a v2 plan");
    expect(plan.agentProfiles.map((profile) => profile.id)).toEqual(["agent.kyc.investigation.v1", "agent.kyc.case-assessment.v2"]);
    expect(plan.agentProfiles[0]!.instructions.map((instruction) => instruction.id)).toEqual(["skill.kyc.investigation.v1"]);
    // One assessment call plus up to eight loop steps and one repair.
    expect(plan.budgets.maxModelCalls).toBe(10);
    const loop = plan.graph.nodes.find((node) => node.id === "kyc-investigation")!;
    expect(loop.config).toMatchObject({ agentRef: "agent.kyc.investigation.v1", loop: { maxSteps: 8 } });
    // The compiler puts every loop tool in the node's permission envelope, and nothing else.
    const envelope = plan.permissionEnvelopes.find((entry) => entry.nodeId === "kyc-investigation")!;
    expect(envelope.capabilities).toEqual(["model.kyc.investigation.v1", ...(loop.config.loop as { tools: string[] }).tools]);
    // Every wired capability is a registered canonical capability, and its binding is a
    // registered connector for that capability (model tasks share model-profile connectors).
    const catalog = JSON.parse(readFileSync(new URL("../../../config/connector-catalog.json", import.meta.url), "utf8")) as {
      capabilities: Array<{ capabilityId: string }>; connectors: Array<{ connectorId: string; capabilityId: string; status: string }>;
    };
    for (const capability of plan.capabilities) {
      expect(capability.id).toMatch(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+\.v[0-9]+$/);
      expect(catalog.capabilities.map((entry) => entry.capabilityId)).toContain(capability.id);
      const connector = catalog.connectors.find((entry) => entry.connectorId === capability.adapterBindingId);
      expect(connector, capability.adapterBindingId).toBeDefined();
      expect(connector!.status).not.toMatch(/quarantined|retired/);
      expect(connector!.capabilityId).toBe(capability.kind === "model" ? "model.general.inference.v1" : capability.id);
    }
    expect(plan.graph.nodes.find((node) => node.id === "case-assessment")?.config).toMatchObject({ agentRef: "agent.kyc.case-assessment.v2" });
    expect(plan.graph.nodes.find((node) => node.id === "case-assessment")?.config).not.toHaveProperty("skillRefs");
    expect(plan.dependencyManifest).toContainEqual(expect.objectContaining({ id: "policy-binding.yaml", digest: createHash("sha256").update(template.sourceFiles["policy-binding.yaml"]!).digest("hex") }));
    expect(evaluateCompiledPlan(plan).checks.filter((check) => !check.passed)).toEqual([]);
    expect(evaluateCompiledPlan(plan).checks.map((check) => check.id)).toContain("agent-profiles.embedded");
    const widened = structuredClone(plan);
    widened.agentProfiles[1]!.allowedCapabilities = [];
    expect(evaluateCompiledPlan(widened).checks.find((check) => check.id === "agent-profiles.embedded")).toMatchObject({ passed: false });

    const missingDependency = await compileAuthoringDraft({ ...template, sourceFiles: {}, modelProfilesPath, registryCapabilities: [] });
    expect(missingDependency.plan).toBeNull();
    expect(missingDependency.diagnostics.some((item) => item.message.includes("package.dependency_missing"))).toBe(true);

    const tampered = structuredClone(plan);
    const intrinsic = tampered.permissionEnvelopes.find((entry) => entry.capabilities.length === 0)!;
    intrinsic.effects = ["external"];
    intrinsic.digest = stableDigest({ nodeId: intrinsic.nodeId, capabilities: [], effects: ["external"] });
    expect(evaluateCompiledPlan(tampered).checks.find((check) => check.id === "authority.bound")?.passed).toBe(false);
  });

  it("refuses v2 sources that still declare skills, agents or node skillRefs", async () => {
    const template = agentProfileFixture();
    const legacyPackage = template.packageSource.replace("agentProfiles:\n", "skills: []\nagents: []\nagentProfiles:\n");
    const legacyWorkflow = template.workflowSource.replace("        agentRef: agent.kyc.case-assessment.v2\n", "        agentRef: agent.kyc.case-assessment.v2\n        skillRefs: [skill.kyc.case-assessment.v2]\n");
    const codes = analyzeAuthoringSources(legacyPackage, legacyWorkflow).diagnostics.map((item) => item.code);
    expect(codes).toEqual(expect.arrayContaining(["author.agent_profiles_required", "author.skill_refs_retired"]));
    expect(codes.filter((code) => code === "author.agent_profiles_required")).toHaveLength(2);
    const dangling = template.workflowSource.replace("        agentRef: agent.kyc.case-assessment.v2\n", "        agentRef: agent.kyc.unknown.v1\n");
    expect(analyzeAuthoringSources(template.packageSource, dangling).diagnostics.map((item) => item.code)).toContain("author.node_agent_profile_missing");
    const authoredCapabilities = template.packageSource.replace("    purposes: [KYC_DECISION_SUPPORT]\n", "    purposes: [KYC_DECISION_SUPPORT]\n    allowedCapabilities: [model.kyc.case_assessment.v2]\n");
    expect(analyzeAuthoringSources(authoredCapabilities, template.workflowSource).diagnostics.map((item) => item.code)).toContain("author.agent_profile_invalid");
    // The compiler of record refuses the same sources with its own codes.
    const compiled = await compileAuthoringDraft({ ...template, packageSource: template.packageSource.replace("agentProfiles:\n", "skills: []\nagentProfiles:\n"), modelProfilesPath, registryCapabilities: [] });
    expect(compiled.plan).toBeNull();
  });

  // A registered agent and its registered instructions (the registry still stores them as
  // agent and skill registrations) become one agent profile in a v2 package.
  const reviewer = agentRegistrationSchema.parse({
    id: "agent.kyc.case-review.v1", name: "KYC case reviewer", description: "Reviews the canonical case.", role: "KYC reviewer",
    prompt: "Review the canonical case and recommend an outcome.", modelProfileId: "model.standard.v1", runtimeTarget: "hosted_http",
    skillIds: ["instruction.kyc.case-review.v1"], primaryCapabilityId: "model.kyc.case_assessment.v2", version: "1.0.0",
    outputSchema: { type: "object", required: ["outcome", "rationale", "requiresHumanReview", "policyRuleRefs", "evidenceRefs"] },
  });
  const reviewInstruction = skillRegistrationSchema.parse({
    id: "instruction.kyc.case-review.v1", name: "Case review", description: "Review the case evidence.", version: "1.0.0",
    instructions: "Cite the policy, evidence and finding ids for every claim.", allowedCapabilityIds: ["model.kyc.case_assessment.v2"],
  });

  it("assembles an agent profile from a registered agent and its instructions when attaching it to a v2 node", async () => {
    const template = agentProfileFixture();
    const attached = applyAgentToAuthoringSources({
      packageSource: template.packageSource, workflowSource: template.workflowSource, agent: reviewer, skills: [reviewInstruction],
      nodeId: "case-assessment", mode: "replace",
    });
    const pkg = parse(attached.packageSource);
    expect(pkg).not.toHaveProperty("skills");
    expect(pkg).not.toHaveProperty("agents");
    const profile = pkg.agentProfiles.find((candidate: { id: string }) => candidate.id === reviewer.id);
    expect(profile).toMatchObject({
      version: "1.0.0", primaryCapabilityId: "model.kyc.case_assessment.v2", purposes: ["KYC_DECISION_SUPPORT"], allowedSkills: [],
      instructions: [{ id: reviewInstruction.id, text: reviewInstruction.instructions, allowedCapabilityIds: ["model.kyc.case_assessment.v2"] }],
    });
    expect(profile).not.toHaveProperty("allowedCapabilities");
    const node = parse(attached.workflowSource).spec.nodes.find((candidate: { id: string }) => candidate.id === "case-assessment");
    expect(node.config).toMatchObject({ agentRef: reviewer.id, agentVersion: "1.0.0" });
    expect(node.config).not.toHaveProperty("skillRefs");
    expect(analyzeAuthoringSources(attached.packageSource, attached.workflowSource).diagnostics.filter((item) => item.severity === "error")).toEqual([]);
    const result = await compileAuthoringDraft({ ...template, ...attached, modelProfilesPath, registryCapabilities: [] });
    expect(result.diagnostics.filter((item) => item.severity === "error")).toEqual([]);
    if (result.plan?.apiVersion !== "harness.factory/plan-v2") throw new Error("expected a v2 plan");
    expect(result.plan.agentProfiles.find((candidate) => candidate.id === reviewer.id)?.allowedCapabilities).toEqual(["model.kyc.case_assessment.v2"]);
    expect(evaluateCompiledPlan(result.plan).passed).toBe(true);
  });

  it("materializes a registered agent referenced by a v2 node as an agent profile", async () => {
    const template = agentProfileFixture();
    const workflowSource = template.workflowSource.replace("        agentRef: agent.kyc.case-assessment.v2\n", `        agentRef: ${reviewer.id}\n`);
    const materialized = materializeRegisteredContracts({
      packageSource: template.packageSource, workflowSource, agents: [reviewer], skills: [reviewInstruction], capabilities: [],
    });
    expect(materialized.materialized).toBe(true);
    const pkg = parse(materialized.packageSource);
    expect(pkg.agentProfiles.map((candidate: { id: string }) => candidate.id)).toContain(reviewer.id);
    expect(pkg).not.toHaveProperty("skills");
    const node = parse(materialized.workflowSource).spec.nodes.find((candidate: { id: string }) => candidate.id === "case-assessment");
    expect(node.config).not.toHaveProperty("skillRefs");
    const result = await compileAuthoringDraft({ ...template, ...materialized, modelProfilesPath, registryCapabilities: [] });
    expect(result.diagnostics.filter((item) => item.severity === "error")).toEqual([]);
    // A missing registered instruction fails closed instead of compiling a profile without it.
    expect(() => materializeRegisteredContracts({ packageSource: template.packageSource, workflowSource, agents: [reviewer], skills: [], capabilities: [] }))
      .toThrow("authoring.agent_instruction_not_registered:instruction.kyc.case-review.v1");
  });

  it.each(["../secret", "/secret", "nested/../../secret", "package.yaml", "workflow.yaml", "nested//secret", "a\\b"])("rejects unsafe or reserved dependency path %s", (path) => {
    expect(() => validateSourceFiles({ [path]: "content" })).toThrow();
  });
});
