import { describe, it, expect } from "vitest";
import type { HarnessPlanV2 } from "@ehf/contracts";
import { executionOrder, nodeIsReachable } from "./v2-execution.js";
function graph(edges: unknown[], order = ["c", "b", "a"]): HarnessPlanV2 {
  return { graph: { nodeOrder: order, edges, nodes: order.map((id) => ({ id, kind: "transform", config: {} })) } } as HarnessPlanV2;
}
describe("durable V2 routing", () => {
  it("derives topological order even when the presentation order differs", () => {
    expect(executionOrder(graph([{ from: "a", to: "b" }, { from: "b", to: "c" }]))).toEqual(["a", "b", "c"]);
    expect(() => executionOrder(graph([{ from: "a", to: "b" }, { from: "b", to: "a" }]))).toThrow("graph_not_acyclic");
  });
  it("routes only committed outcomes and propagates skipped branches", () => {
    const plan = graph([{ from: "a", to: "b", outcome: "ALLOW" }]);
    expect(nodeIsReachable(plan, "b", { a: { outcome: "BLOCK" } })).toBe(false);
    expect(nodeIsReachable(plan, "b", { a: { outcome: "ALLOW" } })).toBe(true);
    expect(nodeIsReachable(plan, "b", { a: { __workflowSkipped: true, outcome: "ALLOW" } })).toBe(false);
  });
  it("routes a condition on a committed node output (a library success condition, a release node's decision)", () => {
    const plan = graph([
      { from: "a", to: "b", kind: "control", condition: 'a.decision == "APPROVE"' },
      { from: "a", to: "c", kind: "control", condition: 'a.decision != "APPROVE"' },
    ]);
    expect(nodeIsReachable(plan, "b", { a: { decision: "APPROVE" } })).toBe(true);
    expect(nodeIsReachable(plan, "c", { a: { decision: "APPROVE" } })).toBe(false);
    expect(nodeIsReachable(plan, "c", { a: { decision: "REJECT" } })).toBe(true);
    expect(nodeIsReachable(plan, "b", { a: { __workflowSkipped: true, decision: "APPROVE" } })).toBe(false);
    // A condition on anything but a node's committed output (the run input, say) is not a durable branch.
    expect(() => nodeIsReachable(graph([{ from: "a", to: "b", condition: 'input.tier == "LOW"' }]), "b", { a: {} })).toThrow("runtime.v2.durable_condition_requires_outcome");
  });
  it("orders group members before the aggregate boundary", () => {
    const plan = { graph: {
      nodeOrder: ["output", "checks", "right", "left", "input"],
      nodes: [
        { id: "input", kind: "input", config: {} },
        { id: "left", kind: "transform", config: {} },
        { id: "right", kind: "transform", config: {} },
        { id: "checks", kind: "group", config: { members: ["left", "right"], execution: "parallel", exit: "aggregate" } },
        { id: "output", kind: "output", config: {} },
      ],
      edges: [{ id: "e1", from: "input", to: "checks", kind: "data" }, { id: "e2", from: "checks", to: "output", kind: "data" }],
    } } as HarnessPlanV2;
    expect(executionOrder(plan)).toEqual(["input", "right", "left", "checks", "output"]);
  });
});
