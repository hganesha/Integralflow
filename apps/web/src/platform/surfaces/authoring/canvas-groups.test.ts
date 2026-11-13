import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { graphNodes, workflowEdges, type Draft } from "./model";
import { groupHeight, groupWorkflow, overviewLayout } from "./canvas-groups";

function flow(nodes: Array<Record<string, unknown>>, edges: Array<Record<string, unknown>>) {
  const draft = { parsedWorkflow: { spec: { nodes, edges } } } as unknown as Draft;
  return groupWorkflow(graphNodes(draft), workflowEdges(draft));
}
const skill = (id: string, agentRef = "agent.a") => ({ id, kind: "tool", name: id, config: { skillId: id, agentRef } });
const agent = (id: string) => ({ id, kind: "agent", name: id, config: { agentRef: "agent.a" } });
const edge = (from: string, to: string, outcome?: string) => ({ id: `${from}-${to}-${outcome ?? "data"}`, from, to, kind: "data", ...(outcome ? { outcome } : {}) });

describe("collapsible workflow projection", () => {
  it.each([["kyc-agentic", 9, 30], ["kyb-agentic", 10, 36]] as const)("folds %s into agent groups without changing execution contracts", (domain, agents, skills) => {
    const parsedWorkflow = parse(readFileSync(resolve(import.meta.dirname, `../../../../../../domains/${domain}/workflow.yaml`), "utf8"));
    const original = structuredClone(parsedWorkflow);
    const draft = { parsedWorkflow } as Draft;
    const nodes = graphNodes(draft), edges = workflowEdges(draft);
    const grouped = groupWorkflow(nodes, edges);
    expect([...grouped.groups.values()].filter(group => group.kind === "agent")).toHaveLength(agents);
    expect([...grouped.groups.values()].reduce((n, group) => n + group.skills, 0)).toBe(skills);
    expect(grouped.nodes.length).toBe(domain === "kyc-agentic" ? 18 : 19);
    for (const group of grouped.groups.values()) {
      if (group.kind === "agent") {
        expect(group.members.at(-1)!.kind).toBe("agent");
        expect(group.members.slice(0, -1).every(node => node.kind === "tool")).toBe(true);
      }
      for (const member of group.members) expect(grouped.representative.get(member.id)).toBe(group.id);
    }
    for (const edge of edges) {
      const from = grouped.representative.get(edge.from), to = grouped.representative.get(edge.to);
      if (from !== to) expect(grouped.edges.some(projected => projected.from === from && projected.to === to && projected.originalEdgeIds.includes(edge.id))).toBe(true);
    }
    // Three pack checkpoints and the diligence gate stay visible as their own steps.
    expect(grouped.nodes.filter(node => node.kind === "gate").map(node => node.id).sort()).toEqual(["diligence-level", "pack-decision-ready", "pack-disposition", "pack-intake-ready"]);
    expect(parsedWorkflow).toEqual(original);
    const expanded = new Set(["document-intelligence-review"]);
    const positions = overviewLayout(grouped, expanded);
    const first = grouped.groups.get("document-intelligence-review")!;
    const following = grouped.edges.find(edge => edge.from === first.id)!;
    expect(positions.get(following.to)!.y).toBeGreaterThanOrEqual(positions.get(first.id)!.y + groupHeight(first, true) + 64);
  });

  it("does not combine distinct uses of the same agent profile or cross a gate", () => {
    const grouped = flow([skill("s1"), agent("a1"), { id: "gate", kind: "gate" }, skill("s2"), agent("a2")], [edge("s1", "a1"), edge("a1", "gate"), edge("gate", "s2"), edge("s2", "a2")]);
    expect(grouped.groups.get("a1")!.members.map(node => node.id)).toEqual(["s1", "a1"]);
    expect(grouped.groups.get("a2")!.members.map(node => node.id)).toEqual(["s2", "a2"]);
    expect(grouped.nodes.map(node => node.id)).toEqual(["a1", "gate", "a2"]);
  });

  it("leaves branching skills visible and retains every outcome when summarizing parallel edges", () => {
    const grouped = flow([skill("branch"), skill("s"), agent("a"), { id: "stop", kind: "output" }], [edge("branch", "s"), edge("branch", "stop", "NEEDS_EVIDENCE"), edge("s", "a"), edge("a", "stop", "NEEDS_HUMAN"), edge("a", "stop", "UNRESOLVED")]);
    expect(grouped.representative.get("branch")).toBe("branch");
    expect(grouped.groups.get("a")!.members.map(node => node.id)).toEqual(["s", "a"]);
    const handoff = grouped.edges.find(edge => edge.from === "a" && edge.to === "stop")!;
    expect(handoff.originalEdgeIds).toHaveLength(2);
    expect(handoff.label).toBe("NEEDS_HUMAN · UNRESOLVED");
  });

  it("keeps loop boundaries and conditional skill paths visible", () => {
    const loop = flow([skill("s"), agent("a")], [edge("s", "a"), edge("a", "s")]);
    expect(loop.groups.get("a")!.members.map(node => node.id)).toEqual(["a"]);
    expect(loop.edges).toHaveLength(2);
    const conditional = flow([skill("s"), agent("a")], [edge("s", "a", "COMPLETED")]);
    expect(conditional.groups.get("a")!.members.map(node => node.id)).toEqual(["a"]);
    expect(conditional.edges[0]!.label).toBe("COMPLETED");
  });

  it("bundles parallel capability calls only when their entry condition and join agree", () => {
    const calls = [{ id: "input", kind: "input" }, { id: "c1", kind: "tool" }, { id: "c2", kind: "tool" }, { id: "join", kind: "join", name: "Identity acquisition barrier" }];
    const grouped = flow(calls, [edge("input", "c1", "DECIDED"), edge("input", "c2", "DECIDED"), edge("c1", "join"), edge("c2", "join")]);
    expect(grouped.groups.get("join")).toMatchObject({ kind: "process", execution: "parallel", label: "Identity evidence acquisition" });
    expect(grouped.groups.get("join")!.members.map(node => node.id)).toEqual(["c1", "c2", "join"]);
    expect(grouped.edges[0]!.label).toBe("DECIDED");
    expect(grouped.edges[0]!.originalEdgeIds).toHaveLength(2);
    const conditional = flow(calls, [edge("input", "c1", "ALLOW"), edge("input", "c2", "REVIEW"), edge("c1", "join"), edge("c2", "join")]);
    expect(conditional.groups.get("join")!.execution).toBe("sequence");
    expect(conditional.groups.get("join")!.members.map(node => node.id)).toEqual(["join"]);
  });

  it("groups an unowned deterministic chain without inventing an agent", () => {
    const grouped = flow([skill("s1", ""), skill("s2", ""), { id: "end", kind: "output" }], [edge("s1", "s2"), edge("s2", "end")]);
    expect(grouped.groups.get("s2")).toMatchObject({ kind: "process", skills: 2 });
    expect(grouped.edges.map(edge => [edge.from, edge.to])).toEqual([["s2", "end"]]);
  });
});
