import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { graphNodes, nodeCategory, nodeDisplayKind, type Draft } from "./model";
import { stepKindLabel } from "./StepTypes";

function node(kind: string, config: Record<string, unknown> = {}) {
  return graphNodes({ parsedWorkflow: { spec: { nodes: [{ id: "step", kind, config }] } } } as unknown as Draft)[0]!;
}

describe("workflow step identity", () => {
  it("keeps an agent-owned deterministic skill separate from an agent review", () => {
    const skill = node("tool", { skillId: "party.profile.build", agentRef: "agent.intake_profile" });
    expect(stepKindLabel(skill)).toBe("Skill");
    expect(nodeDisplayKind(skill.raw)).toBe("skill");
    expect(skill.category).toBe("Capabilities");
    expect(stepKindLabel(node("agent", { agentRef: "agent.intake_profile" }))).toBe("Agent");
  });

  it("preserves legacy attached agents without reclassifying tools and gates by ownership", () => {
    expect(stepKindLabel(node("evaluate", { agentRef: "registered.agent" }))).toBe("Agent");
    expect(nodeCategory({ kind: "evaluate", agentRef: "registered.agent" })).toBe("Intelligence");
    expect(stepKindLabel(node("tool", { agentRef: "registered.agent" }))).toBe("Capability");
    expect(nodeCategory({ kind: "gate", config: { agentRef: "registered.agent" } })).toBe("Policy gates");
    expect(nodeCategory({ kind: "model" })).toBe("Intelligence");
    expect(nodeCategory({ kind: "approval" })).toBe("Human review");
  });

  it.each([["kyc-agentic", 9], ["kyb-agentic", 10]] as const)("shows only the actual agent reviews as agents in %s", (domain, agents) => {
    const parsedWorkflow = parse(readFileSync(resolve(import.meta.dirname, `../../../../../../domains/${domain}/workflow.yaml`), "utf8"));
    const nodes = graphNodes({ parsedWorkflow } as Draft);
    expect(nodes.filter(n => stepKindLabel(n) === "Agent")).toHaveLength(agents);
    const skills = nodes.filter(n => n.kind === "tool" && typeof (n.raw.config as Record<string, unknown>)?.skillId === "string");
    expect(skills.length).toBeGreaterThan(20);
    expect(skills.every(n => stepKindLabel(n) === "Skill" && n.category === "Capabilities")).toBe(true);
    expect(nodes.filter(n => stepKindLabel(n) === "Policy gate")).toHaveLength(4);
    expect(nodes.filter(n => stepKindLabel(n) === "Capability").length).toBeGreaterThan(0);
  });
});
