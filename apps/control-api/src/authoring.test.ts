import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { COMPILER_IDENTITY } from "@ehf/compiler";
import { verifyHarnessPlanDigest } from "@ehf/contracts";
import { analyzeAuthoringSources, compileAuthoringDraft, evaluateCompiledPlan } from "./authoring.js";

/** The checked-in conformance package: one simulator tool with case reads and case writes. */
async function fixtureSources() {
  const root = new URL("../../../packages/contracts/test-fixtures/conformance/", import.meta.url);
  return {
    packageSource: await readFile(new URL("package.yaml", root), "utf8"),
    workflowSource: await readFile(new URL("workflow.yaml", root), "utf8"),
  };
}

const V2_PACKAGE_HEADER = `apiVersion: harness.factory/domain-package-v2
kind: DomainPackage`;

describe("authoring compiler", () => {
  it("compiles a package into the runtime plan contract", async () => {
    const { packageSource, workflowSource } = await fixtureSources();
    const result = await compileAuthoringDraft({
      packageSource,
      workflowSource,
      registryCapabilities: [],
      modelProfilesPath: new URL("../../../config/model-profiles.json", import.meta.url).pathname,
    });
    expect(result.diagnostics.filter((item) => item.severity === "error")).toEqual([]);
    expect(result.plan?.apiVersion).toBe("harness.factory/plan-v2");
    expect(result.plan?.graph.nodes).toHaveLength(3);
    expect(result.plan?.permissionEnvelopes.map((envelope) => envelope.nodeId)).toEqual(["lookup"]);
    expect(result.plan?.graph.nodes.find((node) => node.id === "lookup")?.contextSelectorIds).toEqual(["case-id"]);
    expect(
      result.plan?.graph.nodes.find((node) => node.id === "lookup")?.config.caseWrites,
    ).toHaveLength(2);
    expect(result.plan && evaluateCompiledPlan(result.plan).passed).toBe(true);
  });

  it("emits plans through the pinned compiler of record", async () => {
    const { packageSource, workflowSource } = await fixtureSources();
    const result = await compileAuthoringDraft({
      packageSource,
      workflowSource,
      registryCapabilities: [],
      modelProfilesPath: new URL("../../../config/model-profiles.json", import.meta.url).pathname,
    });
    // The author plane used to build its own plans while stamping them with an lgir-core
    // revision it never executed. Every plan comes from the compiler of record, which
    // records its own identity.
    expect(result.plan?.compiler).toMatchObject({ name: COMPILER_IDENTITY.name, version: COMPILER_IDENTITY.version, lgirCoreRevision: COMPILER_IDENTITY.lgirCoreRevision });
    expect(result.plan && verifyHarnessPlanDigest(result.plan)).toBe(true);
    expect(result.diagnostics.some((item) => item.code === "compiler.plan_emitted")).toBe(true);
  });

  it("fails evaluation when compiled case-write authority is malformed or escalated", async () => {
    const { packageSource, workflowSource } = await fixtureSources();
    const result = await compileAuthoringDraft({
      packageSource,
      workflowSource,
      registryCapabilities: [],
      modelProfilesPath: new URL("../../../config/model-profiles.json", import.meta.url).pathname,
    });
    expect(result.plan).not.toBeNull();
    const plan = structuredClone(result.plan!);
    // Gate and disposition authority is withheld from agent nodes.
    const agent = plan.graph.nodes.find((node) => node.id === "lookup")!;
    agent.kind = "agent";
    agent.config.caseWrites = [{
      commandType: "FinalizeDisposition",
      when: "success",
      payload: {},
      payloadSchema: { type: "object" },
    }];
    const report = evaluateCompiledPlan(plan);
    expect(report.passed).toBe(false);
    expect(report.checks.find((check) => check.id === "case-writes.authority")?.passed).toBe(false);

    agent.config.caseWrites = [{ commandType: "LinkEvidence", payload: {} }];
    const malformed = evaluateCompiledPlan(plan);
    expect(malformed.passed).toBe(false);
    expect(malformed.checks.find((check) => check.id === "case-writes.schema")?.passed).toBe(false);
  });

  it("fails closed with the compiler's diagnostic when the compiler refuses the package", async () => {
    const { packageSource, workflowSource } = await fixtureSources();
    // A policy binding whose source is not part of the package: only the compiler checks it.
    const result = await compileAuthoringDraft({
      packageSource: packageSource.replace("allowedRegions: [US]", `policies:\n  - {policyId: policy.test, policyVersion: 1.0.0, source: policy.yaml, digest: ${"a".repeat(64)}}\nallowedRegions: [US]`),
      workflowSource,
      registryCapabilities: [],
      modelProfilesPath: new URL("../../../config/model-profiles.json", import.meta.url).pathname,
    });
    expect(result.plan).toBeNull();
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "compiler.refused", message: "package.dependency_missing:policy.yaml" }));
  });

  it("compiles against an administered model profile registry", async () => {
    const sources = await fixtureSources();
    const packageSource = sources.packageSource.replace("modelProfiles: []", "modelProfiles: [model.fast.v1]");
    const { workflowSource } = sources;
    const modelProfilesPath = new URL("../../../config/model-profiles.json", import.meta.url).pathname;
    const fromFile = await compileAuthoringDraft({ packageSource, workflowSource, registryCapabilities: [], modelProfilesPath });
    const registry = JSON.parse(await readFile(modelProfilesPath, "utf8")) as { profiles: Array<Record<string, unknown>> };
    const administered = { ...registry, profiles: registry.profiles.map((profile) => ({ ...profile, maxOutputTokens: 4096 })) };
    const result = await compileAuthoringDraft({ packageSource, workflowSource, registryCapabilities: [], modelProfilesPath, modelProfileRegistry: administered });
    expect(result.plan?.modelProfiles.map((profile) => profile.id)).toEqual(["model.fast.v1"]);
    expect(fromFile.plan?.modelProfiles.map((profile) => profile.id)).toEqual(["model.fast.v1"]);
    expect(result.plan?.modelProfiles[0]?.digest).not.toBe(fromFile.plan?.modelProfiles[0]?.digest);
  });

  it("rejects cyclic graphs and invalid case-write commands", () => {
    const packageSource = `
${V2_PACKAGE_HEADER}
metadata: { name: bad, version: 0.1.0, domain: test, objective: Test }
workflow: workflow.yaml
budgets: { maxDurationMs: 1000, maxCostUsd: 0, maxModelCalls: 0, maxCapabilityCalls: 0 }
capabilities: []
bindings: {}
`;
    const workflowSource = `
apiVersion: ladder.dev/v1alpha1
kind: Workflow
metadata: { name: bad }
spec:
  inputs: { type: object }
  outputs: { type: object }
  nodes:
    - { id: input, kind: input, config: { caseWrites: [{ commandType: DirectSqlWrite, payload: {}, payloadSchema: { type: object } }] } }
    - { id: output, kind: output }
  edges:
    - { id: a, from: input, to: output, kind: data }
    - { id: b, from: output, to: input, kind: data }
`;
    const analysis = analyzeAuthoringSources(packageSource, workflowSource);
    expect(analysis.diagnostics.map((item) => item.code)).toContain("author.graph_cycle");
    expect(analysis.diagnostics.map((item) => item.code)).toContain("author.case_write_command_invalid");
  });

  it("returns diagnostics for structurally empty YAML instead of crashing the editor", () => {
    const analysis = analyzeAuthoringSources("null\n", "null\n");
    expect(analysis.diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining([
        "author.package_contract_unsupported",
        "author.package_metadata_required",
        "author.workflow_contract_unsupported",
        "author.input_missing",
        "author.output_missing",
      ]),
    );
  });

  it("accepts the complete deterministic transform, aggregator, and join profile", () => {
    const packageSource = `
${V2_PACKAGE_HEADER}
metadata: { name: primitives, version: 0.1.0, domain: test, objective: Test }
workflow: workflow.yaml
budgets: { maxDurationMs: 1000, maxCostUsd: 0, maxModelCalls: 0, maxCapabilityCalls: 0 }
capabilities: []
bindings: {}
`;
    const workflowSource = `
apiVersion: ladder.dev/v1alpha1
kind: Workflow
metadata: { name: primitives }
spec:
  inputs: { type: object }
  outputs: { type: object }
  nodes:
    - { id: input, kind: input }
    - { id: dedupe, kind: transform, config: { operation: deduplicate } }
    - { id: aggregate, kind: aggregator, config: { operation: vote } }
    - { id: settled, kind: join, config: { mode: allSettled } }
    - { id: output, kind: output }
  edges:
    - { id: a, from: input, to: dedupe, kind: data }
    - { id: b, from: dedupe, to: aggregate, kind: data }
    - { id: c, from: aggregate, to: settled, kind: data }
    - { id: d, from: settled, to: output, kind: data }
`;
    expect(analyzeAuthoringSources(packageSource, workflowSource).diagnostics.filter((item) => item.severity === "error")).toEqual([]);
  });

  it("rejects unsupported deterministic primitive modes during authoring", () => {
    const packageSource = `
${V2_PACKAGE_HEADER}
metadata: { name: primitives, version: 0.1.0, domain: test, objective: Test }
workflow: workflow.yaml
budgets: { maxDurationMs: 1000, maxCostUsd: 0, maxModelCalls: 0, maxCapabilityCalls: 0 }
capabilities: []
bindings: {}
`;
    const workflowSource = `
apiVersion: ladder.dev/v1alpha1
kind: Workflow
metadata: { name: primitives }
spec:
  inputs: { type: object }
  outputs: { type: object }
  nodes:
    - { id: input, kind: input }
    - { id: bad-transform, kind: transform, config: { operation: execute-javascript } }
    - { id: bad-aggregate, kind: aggregator, config: { operation: average } }
    - { id: bad-join, kind: join, config: { mode: first } }
    - { id: output, kind: output }
  edges:
    - { id: a, from: input, to: bad-transform, kind: data }
    - { id: b, from: bad-transform, to: bad-aggregate, kind: data }
    - { id: c, from: bad-aggregate, to: bad-join, kind: data }
    - { id: d, from: bad-join, to: output, kind: data }
`;
    expect(analyzeAuthoringSources(packageSource, workflowSource).diagnostics.map((item) => item.code)).toEqual(expect.arrayContaining([
      "author.transform_operation_unsupported", "author.aggregator_operation_unsupported", "author.join_mode_unsupported",
    ]));
  });

  it("refuses a removed v1 package with its own diagnostic", () => {
    const packageSource = `apiVersion: harness.factory/domain-package-v1
kind: DomainPackage
metadata: { name: old, version: 0.1.0, domain: test, objective: Test }
workflow: workflow.yaml
budgets: { maxDurationMs: 1000, maxCostUsd: 0, maxModelCalls: 0, maxCapabilityCalls: 0 }
`;
    const workflowSource = `apiVersion: ladder.dev/v1alpha1
kind: Workflow
metadata: { name: old }
spec:
  nodes: [{ id: input, kind: input }, { id: output, kind: output }]
  edges: [{ id: a, from: input, to: output, kind: data }]
`;
    const codes = analyzeAuthoringSources(packageSource, workflowSource).diagnostics.map((item) => item.code);
    expect(codes).toContain("author.package_v1_removed");
    expect(codes).not.toContain("author.package_contract_unsupported");
  });

  it("places nodes on different runtimes, since plans dispatch node by node", () => {
    const packageSource = `
${V2_PACKAGE_HEADER}
metadata: { name: mixed, version: 0.1.0, domain: test, objective: Test }
workflow: workflow.yaml
budgets: { maxDurationMs: 1000, maxCostUsd: 0, maxModelCalls: 0, maxCapabilityCalls: 0 }
capabilities: []
bindings: {}
`;
    const workflowSource = `
apiVersion: ladder.dev/v1alpha1
kind: Workflow
metadata: { name: mixed }
spec:
  inputs: { type: object }
  outputs: { type: object }
  nodes:
    - { id: input, kind: input }
    - { id: local, kind: agent, config: { runtimeTarget: local_http } }
    - { id: hosted, kind: agent, config: { runtimeTarget: hosted_http } }
    - { id: output, kind: output }
  edges:
    - { id: a, from: input, to: local, kind: data }
    - { id: b, from: local, to: hosted, kind: data }
    - { id: c, from: hosted, to: output, kind: data }
`;
    const codes = analyzeAuthoringSources(packageSource, workflowSource).diagnostics.map((item) => item.code);
    expect(codes).not.toContain("author.runtime_target_invalid");
    expect(codes.some((code) => code.startsWith("author.runtime_target"))).toBe(false);
  });
});
