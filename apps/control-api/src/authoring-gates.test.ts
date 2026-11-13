import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { businessGateTemplate, businessPolicyGates } from "./authoring-gates.js";
import { mutateAuthoringGraph } from "./authoring-nodes.js";

const root = new URL("../../../domains/kyc-agentic/", import.meta.url);
const read = (name: string) => readFileSync(new URL(name, root), "utf8");
const sourceFiles = { "policy.yaml": read("policy.yaml") };
const packageDocument = parse(read("package.yaml")) as Record<string, unknown>;
const workflowSource = read("workflow.yaml");
const policyRef = "policy.kyc-agentic.business.v2";

describe("business-policy gates in authoring", () => {
  it("lists the policy's authored gates and its diligence gate", () => {
    expect(businessPolicyGates(sourceFiles)).toEqual([expect.objectContaining({ path: "policy.yaml", policyId: policyRef,
      gates: [
        { gateId: "intake-ready", inputProfile: "canonical.onboarding.v2", diligence: false },
        { gateId: "decision-ready", inputProfile: "canonical.onboarding.v2", diligence: false },
        { gateId: "disposition", inputProfile: "canonical.onboarding.v2", diligence: false },
        { gateId: "diligence-level", inputProfile: "canonical.onboarding.v2", diligence: true },
      ] })]);
  });

  it("completes an inserted diligence gate so it evaluates, continues on a decision and stops otherwise", () => {
    const edgeId = (parse(workflowSource) as { spec: { edges: Array<{ id: string; from: string; to: string }> } }).spec.edges
      .find((edge) => edge.from === "party-product-profile")!.id;
    const gate = { policyRef, gateId: "diligence-level" };
    const result = mutateAuthoringGraph(workflowSource, { type: "insert-on-edge", edgeId, node: { id: "diligence-recheck", kind: "gate", name: "Diligence recheck", gate } },
      { gateTemplate: ({ nodes, edges }) => businessGateTemplate({ sourceFiles, packageDocument, workflowNodes: nodes, workflowEdges: edges, gate }) });
    const workflow = parse(result.workflowSource) as { spec: { nodes: Array<Record<string, any>>; edges: Array<Record<string, any>> } };
    const node = workflow.spec.nodes.find((entry) => entry.id === "diligence-recheck")!;
    const sibling = workflow.spec.nodes.find((entry) => entry.id === "pack-intake-ready")!;
    expect(node.config).toMatchObject({ businessDecision: "v2", inputProfile: "canonical.onboarding.v2", scopeSelectorId: "packRelationship", gateId: "diligence-level", policyRef });
    expect(node.config.effectivePolicySetDigests).toHaveLength(2);
    expect(node.contextSelectorIds).toEqual(sibling.contextSelectorIds);
    expect(workflow.spec.edges.filter((edge) => edge.from === "diligence-recheck").map((edge) => [edge.to, edge.outcome])).toEqual([
      ["party-expected-behavior-model", "DECIDED"], ["stopped", "UNRESOLVED"]]);
  });

  it("refuses a gate the policy does not define, and leaves a non-business policy's gate as authored", () => {
    expect(() => businessGateTemplate({ sourceFiles, packageDocument, workflowNodes: [], workflowEdges: [], gate: { policyRef, gateId: "nonexistent" } }))
      .toThrow("authoring.gate_unknown");
    expect(businessGateTemplate({ sourceFiles, packageDocument, workflowNodes: [], workflowEdges: [], gate: { policyRef: "policy.other", gateId: "x" } })).toBeNull();
  });
});
