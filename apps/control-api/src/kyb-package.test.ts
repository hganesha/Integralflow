import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { compilePackage } from "@ehf/compiler";
import { harnessPlanV2Schema, stableDigest, verifyHarnessPlanDigest, type HarnessPlanV2 } from "@ehf/contracts";
import { loadAuthoringTemplates } from "./authoring-templates.js";
import { analyzeAuthoringSources, compileAuthoringDraft, evaluateCompiledPlan } from "./authoring.js";

const run = promisify(execFile);
const root = fileURLToPath(new URL("../../../", import.meta.url));
const domainsPath = join(root, "domains");
const modelProfilesPath = join(root, "config/model-profiles.json");
const readJson = <T>(path: string): T => JSON.parse(readFileSync(join(root, path), "utf8")) as T;

type LibraryStep = { id: string; skill_id: string; parameters: Record<string, unknown>; bindings: Record<string, string>; dependencies: string[]; success_condition: unknown };
type LibraryManifest = { id: string; semver: string; effects: string; optional_context: LibraryManifest["required_context"]; required_context: Array<{ object_type: string; fields: string[]; min_count: number; max_age_seconds: number | null; optional: boolean }> };
const workflow = readJson<{ steps: LibraryStep[] }>("domains/archive/kyb-deterministic/source/kyb-workflow.json");
const library = readJson<{ source: { bundleCodeHash: string }; skills: LibraryManifest[] }>("domains/archive/kyb-deterministic/library/skills.json");
const catalog = readJson<{ connectors: Array<{ connectorId: string; capabilityId: string; status: string }> }>("config/connector-catalog.json");

/** The package compiled straight from its directory, as `make compile` does. */
async function compile(packageDir: string): Promise<HarnessPlanV2> {
  return harnessPlanV2Schema.parse(compilePackage(join(root, packageDir), { modelProfiles: modelProfilesPath }).plan);
}

describe("KYB package on the skill library workflow", async () => {
  const template = (await loadAuthoringTemplates(domainsPath)).find((item) => item.id === "kyb")!;
  const compiled = await compileAuthoringDraft({ ...template, modelProfilesPath, registryCapabilities: [] });
  const plan = compiled.plan as HarnessPlanV2;

  it("compiles from the authoring template with zero errors to the committed plan", async () => {
    expect(analyzeAuthoringSources(template.packageSource, template.workflowSource).diagnostics.filter((item) => item.severity === "error")).toEqual([]);
    expect(compiled.diagnostics.filter((item) => item.severity === "error")).toEqual([]);
    expect(verifyHarnessPlanDigest(plan)).toBe(true);
    expect(evaluateCompiledPlan(plan).checks.filter((check) => !check.passed)).toEqual([]);
    expect(plan.planDigest).toBe(readJson<{ planDigest: string }>("artifacts/archive/kyb.plan.json").planDigest);
    expect((await compile("domains/archive/kyb-deterministic")).planDigest).toBe(plan.planDigest);
  });

  it("keeps every one of the 33 library steps (29 canonical plus four EHF document wrappers) exactly once, in order, with its parameters and bindings", () => {
    expect(workflow.steps).toHaveLength(33);
    for (const step of workflow.steps) {
      const nodes = plan.graph.nodes.filter((node) => node.config.skillId === step.skill_id);
      expect(nodes, step.id).toHaveLength(1);
      expect(nodes[0]!.config).toMatchObject({ libraryStep: step.id, skillParameters: step.parameters });
      if (Object.keys(step.bindings).length) {
        expect(Object.keys(nodes[0]!.config.skillParameterBindings as object)).toEqual(Object.keys(step.bindings));
      }
    }
    const order = plan.graph.nodeOrder.filter((id) => plan.graph.nodes.find((node) => node.id === id)?.config.skillId);
    expect(order.map((id) => plan.graph.nodes.find((node) => node.id === id)!.config.libraryStep)).toEqual(workflow.steps.map((step) => step.id));
    expect(plan.graph.nodes.filter((node) => typeof node.config.skillId === "string")).toHaveLength(33);
  });

  it("binds every skill node to skill.<id>.v<major> on skills:<id>, pinned to its manifest digest", () => {
    for (const manifest of library.skills) {
      const capabilityId = `skill.${manifest.id}.v${manifest.semver.split(".")[0]}`;
      const capability = plan.capabilities.find((item) => item.id === capabilityId)!;
      expect(capability, capabilityId).toMatchObject({ kind: "tool", adapterBindingId: `skills:${manifest.id}`, effect: manifest.effects === "read_only" ? "read" : "reversible" });
      const binding = plan.skillBindings!.find((item) => item.skillId === manifest.id)!;
      expect(binding).toMatchObject({
        semver: manifest.semver, manifestDigest: stableDigest(manifest), bundleDigest: `sha256:${library.source.bundleCodeHash}`,
        candidates: [{ capabilityId, connectorId: `skills:${manifest.id}` }],
      });
      const node = plan.graph.nodes.find((item) => item.config.skillId === manifest.id)!;
      expect(node.config.capabilityId).toBe(capabilityId);
      expect(plan.permissionEnvelopes.find((item) => item.nodeId === node.id)!.capabilities).toEqual([capabilityId]);
    }
  });

  it("never deploys optimistic demonstration facts and creates durable lifecycle work", () => {
    const skills = plan.graph.nodes.filter((n) => n.config.skillId);
    expect(skills.every((n) => n.config.requireBoundParameters === true)).toBe(true);
    const parameters = JSON.stringify(skills.map((n) => n.config.skillParameters));
    expect(parameters).not.toMatch(/Acme|SYN-0001|"target":"acme"|"identity_verified":true|"tier":"LOW"/);
    const ownership = plan.graph.nodes.find((n) => n.id === "ownership-ubo-resolve")!;
    expect(ownership.config.skillParameterBindings).toMatchObject({ target: "acquire-ownership.subjectEntityId" });
    for (const [nodeId, workType] of [["edd-trigger-evaluate", "EDD_REVIEW"], ["monitor-customer-schedule", "PERIODIC_CDD_REVIEW"]]) {
      const writes = plan.graph.nodes.find((n) => n.id === nodeId)!.config.caseWrites as Array<{ commandType: string; payload: { workType?: string } }>;
      expect(writes.some((w) => w.commandType === "ProposeWorkItem" && w.payload.workType === workType)).toBe(true);
    }
  });

  it("uses only skills: capabilities and registered, unquarantined connectors, and no simulator", () => {
    for (const capability of plan.capabilities) {
      expect(capability.adapterBindingId).not.toMatch(/^simulator:/);
      if (capability.adapterBindingId.startsWith("skills:")) {
        expect(capability.id).toBe(`skill.${capability.adapterBindingId.slice("skills:".length)}.v0`);
        continue;
      }
      const connector = catalog.connectors.find((entry) => entry.connectorId === capability.adapterBindingId);
      expect(connector, capability.adapterBindingId).toBeDefined();
      expect(connector!.capabilityId).toBe(capability.id);
      expect(connector!.status).not.toMatch(/quarantined|retired/);
    }
    expect(plan.capabilities.filter((item) => !item.adapterBindingId.startsWith("skills:")).map((item) => item.id).sort()).toEqual([
      "business.officers.lookup.v1", "business.ownership.discover.v1", "business.registry.lookup.v1", "document.evidence.package.v1",
      "reference.identifier.lookup.v1", "screening.adverse_media.v1", "screening.pep.v1", "screening.sanctions.v1",
    ]);
  });

  it("selects each skill's library requirements as record selectors", () => {
    for (const step of workflow.steps) {
      const manifest = library.skills.find((item) => item.id === step.skill_id)!;
      const node = plan.graph.nodes.find((item) => item.config.libraryStep === step.id)!;
      const selectors = node.contextSelectorIds.map((id) => plan.contextSelectors.find((selector) => selector.id === id)!).filter((selector) => selector.record);
      expect(selectors.map((selector) => ({ path: selector.path, required: selector.required, ...selector.record }))).toEqual([...manifest.required_context, ...manifest.optional_context].map((requirement) => ({
        path: `records.${requirement.object_type}`, required: !requirement.optional, objectType: requirement.object_type,
        fields: requirement.fields, minCount: requirement.min_count, maxAgeSeconds: requirement.max_age_seconds,
      })));
      // One purpose per node (envelope rule), and the subjects establish the context envelope.
      expect(new Set(node.contextSelectorIds.map((id) => plan.contextSelectors.find((selector) => selector.id === id)!.purpose)).size).toBe(1);
      expect(node.contextSelectorIds).toContain("kybSubjects");
    }
  });

  it("acquires through connector nodes that write canonical records or an evidence gap, behind allSettled joins", () => {
    const connectors = plan.graph.nodes.filter((node) => node.id.startsWith("acquire-"));
    expect(connectors).toHaveLength(8);
    for (const node of connectors) {
      const writes = node.config.caseWrites as Array<{ commandType: string; when?: string; payload: Record<string, unknown> }>;
      expect(writes.find((write) => write.commandType === "RecordCanonicalRecords")).toMatchObject({ when: "output.records.0", payload: { records: "{{ output.records }}" } });
      expect(writes.find((write) => write.commandType === "RecordScreeningFinding")).toMatchObject({ when: "output.recordGap", payload: { findingType: "EVIDENCE_GAP" } });
      const outgoing = plan.graph.edges.filter((edge) => edge.from === node.id);
      expect(outgoing).toHaveLength(1);
      const join = plan.graph.nodes.find((candidate) => candidate.id === outgoing[0]!.to)!;
      expect(join).toMatchObject({ kind: "join", config: { mode: "allSettled" } });
    }
    // Acquisition precedes the first skill that reasons over it.
    const order = plan.graph.nodeOrder;
    expect(order.indexOf("identity-acquired")).toBeLessThan(order.indexOf("entity-resolve"));
    expect(order.indexOf("screening-acquired")).toBeLessThan(order.indexOf("screening-sanctions-execute"));
  });

  it("routes library success conditions and follows the human-gated skill with a durable approval", () => {
    const routed = (from: string) => plan.graph.edges.filter((edge) => edge.from === from).map((edge) => [edge.kind, edge.to, edge.condition]);
    expect(routed("edd-trigger-evaluate")).toEqual([
      ["control", "case-context-hydrate", "edd-trigger-evaluate.computation.payload.required == false"],
      ["control", "kyb-stopped", "edd-trigger-evaluate.computation.payload.required != false"],
    ]);
    expect(routed("decision-rules-evaluate")[0]).toEqual(["control", "decision-approval-route", "decision-rules-evaluate.computation.payload.outcome == \"PASS\""]);
    expect(plan.graph.nodes.find((node) => node.id === "decision-disposition-record-approval")).toMatchObject({ kind: "approval" });
    expect(routed("decision-disposition-record")).toEqual([["data", "decision-disposition-record-approval", ""]]);
    // Held effects wait for the approval; the release node commits or discards them and routes on the decision.
    expect(routed("decision-disposition-record-approval")).toEqual([["data", "decision-disposition-record-effects", ""]]);
    expect(routed("decision-disposition-record-effects")).toEqual([
      ["control", "monitor-customer-schedule", "decision-disposition-record-effects.decision == \"APPROVE\""],
      ["control", "kyb-stopped", "decision-disposition-record-effects.decision != \"APPROVE\""],
    ]);
    // No OPA gate: the library's decision.rules.evaluate (synthetic policy pack) decides, as labelled in the README.
    expect(plan.graph.nodes.some((node) => node.kind === "gate")).toBe(false);
    expect(plan.policyBundles).toEqual([]);
  });

  it("is what the generator produces from the vendored library snapshot", async () => {
    const { stdout } = await run(process.execPath, [join(root, "scripts/sync-kyb-package.mjs"), "--check"], { cwd: root });
    expect(stdout).toContain("up to date");
  });
});
