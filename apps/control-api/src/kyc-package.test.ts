import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { compilePackage } from "@ehf/compiler";
import { harnessPlanV2Schema, SKILL_PROPOSAL_COMMANDS, stableDigest, verifyHarnessPlanDigest, type HarnessPlanV2 } from "@ehf/contracts";
import { loadAuthoringTemplates } from "./authoring-templates.js";
import { analyzeAuthoringSources, compileAuthoringDraft, evaluateCompiledPlan } from "./authoring.js";

const run = promisify(execFile);
const root = fileURLToPath(new URL("../../../", import.meta.url));
const domainsPath = join(root, "domains");
const modelProfilesPath = join(root, "config/model-profiles.json");
const readJson = <T>(path: string): T => JSON.parse(readFileSync(join(root, path), "utf8")) as T;

type LibraryStep = { id: string; skill_id: string; parameters: Record<string, unknown>; bindings: Record<string, string>; dependencies: string[]; success_condition: unknown };
type LibraryManifest = { id: string; semver: string; effects: string; policy_context_fields: string[]; optional_context: LibraryManifest["required_context"]; required_context: Array<{ object_type: string; fields: string[]; min_count: number; max_age_seconds: number | null; optional: boolean }> };
const workflow = readJson<{ steps: LibraryStep[] }>("domains/archive/kyc-v2-deterministic/source/kyc-workflow.json");
const library = readJson<{ source: { bundleCodeHash: string; catalogVersion: string }; skills: LibraryManifest[] }>("domains/archive/kyc-v2-deterministic/library/skills.json");
const kybLibrary = readJson<{ source: { catalogSourceHash: string; catalogVersion: string } }>("domains/archive/kyb-deterministic/library/skills.json");
const catalog = readJson<{ connectors: Array<{ connectorId: string; capabilityId: string; status: string }> }>("config/connector-catalog.json");
const nodeIdOf = (stepId: string) => stepId.replaceAll("_", "-");

/** The package compiled straight from its directory, as `make compile` does. */
async function compile(packageDir: string): Promise<HarnessPlanV2> {
  return harnessPlanV2Schema.parse(compilePackage(join(root, packageDir), { modelProfiles: modelProfilesPath }).plan);
}

describe("KYC v2 package on the skill library", async () => {
  const template = (await loadAuthoringTemplates(domainsPath)).find((item) => item.id === "kyc")!;
  const compiled = await compileAuthoringDraft({ ...template, modelProfilesPath, registryCapabilities: [] });
  const plan = compiled.plan as HarnessPlanV2;
  const node = (id: string) => plan.graph.nodes.find((candidate) => candidate.id === id)!;
  const routed = (from: string) => plan.graph.edges.filter((edge) => edge.from === from).map((edge) => [edge.to, edge.outcome ?? edge.condition]);

  it("compiles from the authoring template with zero errors to the committed plan", async () => {
    expect(analyzeAuthoringSources(template.packageSource, template.workflowSource).diagnostics.filter((item) => item.severity === "error")).toEqual([]);
    expect(compiled.diagnostics.filter((item) => item.severity === "error")).toEqual([]);
    expect(verifyHarnessPlanDigest(plan)).toBe(true);
    expect(evaluateCompiledPlan(plan).checks.filter((check) => !check.passed)).toEqual([]);
    expect(plan.planDigest).toBe(readJson<{ planDigest: string }>("artifacts/archive/kyc-v2.plan.json").planDigest);
    expect((await compile("domains/archive/kyc-v2-deterministic")).planDigest).toBe(plan.planDigest);
  });

  it("uses only library skills, vendored from the same library release as KYB", () => {
    expect(library.source.catalogVersion).toBe(kybLibrary.source.catalogVersion);
    expect(library.skills.map((skill) => skill.id).sort()).toEqual([...new Set(workflow.steps.map((step) => step.skill_id))].sort());
    for (const [index, step] of workflow.steps.entries()) {
      const nodes = plan.graph.nodes.filter((item) => item.config.libraryStep === step.id);
      expect(nodes, step.id).toHaveLength(1);
      expect(nodes[0]).toMatchObject({ id: nodeIdOf(step.id), config: { skillId: step.skill_id, skillParameters: step.parameters, requireBoundParameters: true } });
      expect(step.dependencies).toEqual(index ? [workflow.steps[index - 1]!.id] : []);
    }
    const order = plan.graph.nodeOrder.filter((id) => typeof node(id).config.libraryStep === "string");
    expect(order.map((id) => node(id).config.libraryStep)).toEqual(workflow.steps.map((step) => step.id));
    for (const manifest of library.skills) {
      const capabilityId = `skill.${manifest.id}.v${manifest.semver.split(".")[0]}`;
      expect(plan.capabilities.find((item) => item.id === capabilityId), capabilityId).toMatchObject({ adapterBindingId: `skills:${manifest.id}` });
      expect(plan.skillBindings!.find((item) => item.skillId === manifest.id)).toMatchObject({
        semver: manifest.semver, manifestDigest: stableDigest(manifest), bundleDigest: `sha256:${library.source.bundleCodeHash}`,
      });
    }
  });

  it("acquires through registered, unquarantined connectors only — no simulator, no agent host, no model", () => {
    for (const capability of plan.capabilities) {
      expect(capability.adapterBindingId).not.toMatch(/^(simulator|agents|openrouter):/);
      if (capability.adapterBindingId.startsWith("skills:")) continue;
      const connector = catalog.connectors.find((entry) => entry.connectorId === capability.adapterBindingId);
      expect(connector, capability.adapterBindingId).toBeDefined();
      expect(connector!.capabilityId).toBe(capability.id);
      expect(connector!.status).not.toMatch(/quarantined|retired/);
    }
    expect(plan.agentProfiles).toEqual([]);
    expect(plan.budgets.maxModelCalls).toBe(0);
    expect(plan.graph.nodes.filter((item) => item.id.startsWith("acquire-")).map((item) => item.id)).toEqual([
      "acquire-identity", "acquire-documents", "acquire-sanctions", "acquire-pep", "acquire-adverse-media",
    ]);
  });

  it("selects each skill's library requirements as record selectors, one purpose per node", () => {
    for (const step of workflow.steps) {
      const manifest = library.skills.find((item) => item.id === step.skill_id)!;
      const skillNode = node(nodeIdOf(step.id));
      const selectors = skillNode.contextSelectorIds.map((id) => plan.contextSelectors.find((selector) => selector.id === id)!);
      expect(selectors.filter((selector) => selector.record).map((selector) => selector.record!.objectType)).toEqual([...manifest.required_context, ...manifest.optional_context].map((item) => item.object_type));
      expect(new Set(selectors.map((selector) => selector.purpose))).toEqual(new Set(["KYC_ONBOARDING"]));
    }
  });

  it("projects the pinned policy to every skill's policy_context_fields and names what the bundle cannot supply", () => {
    for (const step of workflow.steps) {
      const manifest = library.skills.find((item) => item.id === step.skill_id)!;
      const policy = node(nodeIdOf(step.id)).config.skillPolicy as { policyRef: string; bundleDigest: string; fields: string[]; values: Record<string, unknown>; computed?: Record<string, unknown>; unresolved: string[] };
      expect(policy).toMatchObject({ policyRef: plan.policyBundles[0]!.policyId, bundleDigest: plan.policyBundles[0]!.bundleDigest });
      expect(policy.fields).toEqual([...manifest.policy_context_fields].sort());
      expect([...Object.keys(policy.values), ...Object.keys(policy.computed ?? {}), ...policy.unresolved].sort()).toEqual(policy.fields);
    }
    const unresolved = (id: string) => (node(id).config.skillPolicy as { unresolved: string[] }).unresolved;
    expect(unresolved("decision-policy-resolve")).toEqual([]);
    expect(unresolved("screening-sanctions-execute")).toEqual([]);
    expect(unresolved("risk-customer-assess")).toEqual(["risk_model_version", "risk_tiers", "risk_weights"]);
    expect(unresolved("decision-recommendation-generate")).toEqual(["recommendations"]);
    expect(Object.keys((node("monitor-customer-schedule").config.skillPolicy as { computed: object }).computed)).toEqual(["review_interval_seconds"]);
  });

  it("guards the stages with the pinned OPA gates: readiness gates continue only on ALLOW", () => {
    expect(plan.policyBundles).toEqual([{ policyId: "policy.kyc.customer-acceptance.v1", bundleDigest: readJson<{ bundleDigest: string }>("artifacts/policy/kyc/manifest.unsigned.json").bundleDigest }]);
    expect(plan.graph.nodes.filter((item) => item.kind === "gate").map((item) => [item.id, item.config.gateId, item.config.policyRef])).toEqual([
      ["screening-ready", "screening-ready", "policy.kyc.customer-acceptance.v1"],
      ["decision-ready", "decision-ready", "policy.kyc.customer-acceptance.v1"],
      ["disposition", "disposition", "policy.kyc.customer-acceptance.v1"],
    ]);
    expect(routed("screening-ready")).toEqual([
      ["acquire-sanctions", "ALLOW"], ["acquire-pep", "ALLOW"], ["acquire-adverse-media", "ALLOW"],
      ["kyc-stopped", "BLOCK"], ["kyc-stopped", "REVIEW"], ["kyc-stopped", "UNKNOWN"], ["kyc-stopped", "ERROR"],
    ]);
    expect(routed("decision-ready")).toEqual([
      ["decision-requirements-compile", "ALLOW"], ["kyc-stopped", "BLOCK"], ["kyc-stopped", "REVIEW"], ["kyc-stopped", "UNKNOWN"], ["kyc-stopped", "ERROR"],
    ]);
    expect(routed("disposition")).toEqual([
      ["decision-disposition-record", "ALLOW"], ["decision-disposition-record", "REVIEW"], ["decision-disposition-record", "ERROR"],
      ["kyc-stopped", "BLOCK"], ["kyc-stopped", "UNKNOWN"],
    ]);
    const order = plan.graph.nodeOrder;
    expect(order.indexOf("policy-authority")).toBeLessThan(order.indexOf("screening-ready"));
    expect(order.indexOf("screening-ready")).toBeLessThan(order.indexOf("acquire-sanctions"));
    expect(order.indexOf("evidence-sufficiency-assess")).toBeLessThan(order.indexOf("decision-ready"));
    expect(order.indexOf("decision-recommendation-generate")).toBeLessThan(order.indexOf("disposition"));
  });

  it("follows the human-gated disposition with dual-control approval, only for a computed proposal", () => {
    expect(node("decision-disposition-record-approval")).toMatchObject({ kind: "approval", config: { dualControlRequired: true } });
    expect(routed("decision-disposition-record")).toEqual([
      ["decision-disposition-record-approval", "decision-disposition-record.lifecycle == \"COMPLETED_EXECUTION\""],
      ["kyc-stopped", "decision-disposition-record.lifecycle != \"COMPLETED_EXECUTION\""],
    ]);
    // The skill's effects are held until the approval; the release node commits or discards them, then routes.
    expect(routed("decision-disposition-record-approval")).toEqual([["decision-disposition-record-effects", ""]]);
    expect(node("decision-disposition-record-effects")).toMatchObject({
      kind: "transform",
      config: { skillEffectRelease: { skillNodeId: "decision-disposition-record", approvalNodeId: "decision-disposition-record-approval" }, caseWrites: [] },
    });
    expect(routed("decision-disposition-record-effects")).toEqual([
      ["monitor-customer-schedule", "decision-disposition-record-effects.decision == \"APPROVE\""],
      ["kyc-stopped", "decision-disposition-record-effects.decision != \"APPROVE\""],
    ]);
  });

  it("pins each skill's registry effects and grants its nodes exactly the commit authority they allow", () => {
    const catalog = JSON.parse(readFileSync(join(root, "config/business-skills.json"), "utf8")) as { skills: Array<{ skillId: string; semver: string; effects: { mode: string; approval: string } }> };
    for (const binding of plan.skillBindings ?? []) {
      const entry = catalog.skills.find((item) => item.skillId === binding.skillId && item.semver === binding.semver)!;
      expect(binding.effects).toMatchObject({ mode: entry.effects.mode, approval: entry.effects.approval });
      const skillNode = plan.graph.nodes.find((item) => item.config.skillId === binding.skillId)!;
      const grants = (skillNode.config.caseWrites as Array<Record<string, unknown>> | undefined ?? []).filter((write) => "skillGrant" in write);
      expect(grants.map((grant) => grant.commandType)).toEqual(entry.effects.mode === "read_only" ? [] : [...SKILL_PROPOSAL_COMMANDS]);
    }
  });

  it("maps the library recommendation to the disposition gate input as REVIEW, never an approval", () => {
    const writes = node("decision-recommendation-generate").config.caseWrites as Array<{ commandType: string; when: string; payload: Record<string, unknown> }>;
    expect(writes.find((write) => write.commandType === "SubmitDecisionRecommendation")).toMatchObject({
      when: "output.computation.payload.recommendation", payload: { outcome: "REVIEW", requiresHumanReview: true },
    });
  });

  it("is what the generator produces from the source workflow and vendored manifests", async () => {
    const { stdout } = await run(process.execPath, [join(root, "scripts/sync-kyc-package.mjs"), "--check"], { cwd: root });
    expect(stdout).toContain("up to date");
  });
});

describe("KYC documentary requirements (domains/kyc/policy/catalog/document-requirements.yaml)", () => {
  const read = (path: string) => readFileSync(join(root, path), "utf8");

  it("name only document-catalog types and only documentary obligations of the policy", async () => {
    const { parse } = await import("yaml");
    const requirements = parse(read("domains/kyc/policy/catalog/document-requirements.yaml")) as { status: string; requirements: Array<{ obligation: string; anyOf: string[] }> };
    const catalog = JSON.parse(read("apps/fincrime-host/src/kyc_documents/resources/catalog.json")) as { document_types: Array<{ id: string }> };
    const obligations = JSON.stringify(parse(read("domains/kyc/policy/catalog/evidence-obligations.yaml")));
    const types = new Set(catalog.document_types.map((item) => item.id));
    expect(requirements.status).toBe("draft_pending_owner_review");
    for (const requirement of requirements.requirements) {
      expect(obligations).toContain(`"id":"${requirement.obligation}"`);
      expect(requirement.anyOf.length).toBeGreaterThan(0);
      for (const type of requirement.anyOf) expect(types.has(type), `${requirement.obligation}: ${type}`).toBe(true);
    }
  });

  it("reach document.requirements.resolve as any-of groups in its pinned policy section", () => {
    const plan = harnessPlanV2Schema.parse(JSON.parse(read("artifacts/archive/kyc-v2.plan.json"))) as HarnessPlanV2;
    const node = plan.graph.nodes.find((item) => item.config.skillId === "document.requirements.resolve")!;
    const policy = node.config.skillPolicy as { values: Record<string, unknown>; unresolved: string[] };
    expect(policy.unresolved).toEqual([]);
    expect(policy.values.required_document_types).toEqual([]);
    const groups = (policy.values.extensions as { "ehf.document": { value: { document_requirements: Array<{ id: string; any_of: string[] }> } } })["ehf.document"].value.document_requirements;
    expect(groups.map((group) => group.id)).toEqual(["EVD-CIP-IDENTITY-DOCUMENT", "EVD-CIP-ADDRESS", "EVD-CIP-TIN"]);
  });
});
