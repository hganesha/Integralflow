import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { addOrchestrationNode, authoringGraphMutationSchema, mutateAuthoringGraph } from "./authoring-nodes.js";
import { analyzeAuthoringSources, compileAuthoringDraft, defaultAuthoringSources } from "./authoring.js";

function workflowWithSteps() {
  const sources = defaultAuthoringSources();
  const workflow = parse(sources.workflowSource);
  workflow.spec.nodes.splice(1, 0,
    { id: "screen", kind: "transform", name: "Screen", config: { operation: "select" } },
    { id: "review", kind: "transform", name: "Review", config: { operation: "select" } },
  );
  workflow.spec.edges = [
    { id: "e1", from: "intake", to: "screen", kind: "data" },
    { id: "e2", from: "screen", to: "review", kind: "data" },
    { id: "e3", from: "review", to: "result", kind: "data" },
  ];
  return { ...sources, workflowSource: JSON.stringify(workflow) };
}

describe("orchestration node authoring", () => {
  it("renames the process display title without changing package or workflow identifiers",()=>{
    const sources=defaultAuthoringSources();
    const before=parse(sources.workflowSource);
    const result=mutateAuthoringGraph(sources.workflowSource,{type:"rename-process",name:" Customer onboarding "});
    const after=parse(result.workflowSource);
    expect(after).toEqual({...before,metadata:{...before.metadata,title:"Customer onboarding"}});
    expect(analyzeAuthoringSources(sources.packageSource,result.workflowSource).metadata.name).toBe("Customer onboarding");
  });

  it("inserts a policy gate with its real binding and preserves execution settings when renamed",()=>{
    const sources=workflowWithSteps();
    const gate={policyRef:"policy.test",gateId:"eligibility"};
    const added=mutateAuthoringGraph(sources.workflowSource,{type:"insert-on-edge",edgeId:"e2",node:{id:"policy-review",kind:"gate",name:"Eligibility",gate}});
    const before=parse(added.workflowSource).spec.nodes.find((node:{id:string})=>node.id==="policy-review");
    expect(before.config).toMatchObject(gate);
    const edited=mutateAuthoringGraph(added.workflowSource,{type:"update-node",nodeId:"policy-review",name:"Risk gate",description:"Check policy",gate:{...gate,gateId:"risk"}});
    expect(parse(edited.workflowSource).spec.nodes.find((node:{id:string})=>node.id==="policy-review")).toMatchObject({...before,name:"Risk gate",config:{policyRef:"policy.test",gateId:"risk",ui:{description:"Check policy"}}});
    expect(()=>mutateAuthoringGraph(sources.workflowSource,{type:"update-node",nodeId:"screen",name:"Screen",description:"",gate})).toThrow("authoring.gate_node_required");
  });

  it("requires registry materialization before an agent can enter the graph",()=>{
    const sources=workflowWithSteps();
    expect(()=>mutateAuthoringGraph(sources.workflowSource,{type:"insert-on-edge",edgeId:"e2",node:{id:"agent-review",kind:"agent",name:"Review",agentId:"agent.review"}})).toThrow("authoring.agent_registry_required");
  });
  it("inserts on exactly one branch, retaining its condition and the sibling path", () => {
    const sources = workflowWithSteps();
    const workflow = parse(sources.workflowSource);
    workflow.spec.edges.push({ id: "review-fallback", from: "screen", to: "result", kind: "control", condition: "needs_review == false" });
    const selected = workflow.spec.edges.find((edge: { id: string }) => edge.id === "e2");
    selected.condition = "needs_review == true";
    selected.contract = "review-contract";
    const sibling = structuredClone(workflow.spec.edges.at(-1));
    const result = mutateAuthoringGraph(JSON.stringify(workflow), {
      type: "insert-on-edge", edgeId: "e2", node: { id: "manual-check", name: "Manual check", kind: "approval", position: { x: 650, y: 300 } },
    });
    const updated = parse(result.workflowSource);
    expect(result.nodeId).toBe("manual-check");
    expect(updated.spec.edges).toHaveLength(workflow.spec.edges.length + 1);
    expect(updated.spec.edges).toContainEqual({ ...selected, to: "manual-check" });
    expect(updated.spec.edges).toContainEqual(sibling);
    expect(updated.spec.edges).toContainEqual({ id: "edge-manual-check-review", from: "manual-check", to: "review", kind: "data" });
    expect(updated.spec.nodes.find((node: { id: string }) => node.id === "manual-check").config.ui.position).toEqual({ x: 650, y: 300 });
  });

  it("rejects a missing selected edge without returning partially changed sources", () => {
    const sources = workflowWithSteps();
    expect(() => mutateAuthoringGraph(sources.workflowSource, {
      type: "insert-on-edge", edgeId: "removed-edge", node: { id: "manual-check", name: "Check", kind: "approval" },
    })).toThrow("authoring.edge_not_found");
    expect(parse(sources.workflowSource).spec.nodes.some((node: { id: string }) => node.id === "manual-check")).toBe(false);
  });

  it("saves names and author notes without replacing execution settings or contracts", () => {
    const sources = workflowWithSteps();
    const before = parse(sources.workflowSource).spec.nodes.find((node: { id: string }) => node.id === "screen");
    const result = mutateAuthoringGraph(sources.workflowSource, { type: "update-node", nodeId: "screen", name: " Screen evidence ", description: " Read the source first. " });
    expect(parse(result.workflowSource).spec.nodes.find((node: { id: string }) => node.id === "screen")).toEqual({
      ...before, name: "Screen evidence", config: { ...before.config, ui: { description: "Read the source first." } },
    });
  });

  it("commits all buffered node positions in one workflow update", () => {
    const sources = workflowWithSteps();
    const updated = mutateAuthoringGraph(sources.workflowSource, { type: "layout", positions: [
      { nodeId: "screen", position: { x: 320, y: 80 } }, { nodeId: "review", position: { x: 640, y: 80 } },
    ] });
    const nodes = parse(updated.workflowSource).spec.nodes;
    expect(nodes.find((node: { id: string }) => node.id === "screen").config.ui.position).toEqual({ x: 320, y: 80 });
    expect(nodes.find((node: { id: string }) => node.id === "review").config.ui.position).toEqual({ x: 640, y: 80 });
    expect(() => mutateAuthoringGraph(sources.workflowSource, { type: "layout", positions: [{ nodeId: "missing", position: { x: 0, y: 0 } }] })).toThrow("authoring.node_not_found");
  });

  it.each([
    { type: "unknown" }, { type: "layout", positions: [] },
    { type: "move", nodeId: "screen", position: { x: Number.NaN, y: 0 } },
    { type: "update-node", nodeId: "screen", name: "Screen", description: "", kind: "tool" },
    { type: "insert-on-edge", edgeId: "e2", node: { id: "fake-agent", name: "Fake agent", kind: "agent" } },
  ])("refuses malformed operations before editing the sources: %j", (mutation) => {
    expect(authoringGraphMutationSchema.safeParse(mutation).success).toBe(false);
  });

  it("persists canvas connections, positions, contracts, and deletions in workflow YAML", () => {
    const sources = workflowWithSteps();
    const added = mutateAuthoringGraph(sources.workflowSource, {
      type: "add", node: { id: "manual-review", kind: "approval", name: "Manual review" }, insertAfter: "review",
    });
    const moved = mutateAuthoringGraph(added.workflowSource, { type: "move", nodeId: "manual-review", position: { x: 420, y: 180 } });
    const contracted = mutateAuthoringGraph(moved.workflowSource, {
      type: "update-contract", nodeId: "manual-review", inputSchema: { type: "object", required: ["caseId"] },
      outputSchema: { type: "object" }, contextSelectorIds: [], caseWrites: [],
    });
    const deleted = mutateAuthoringGraph(contracted.workflowSource, { type: "delete", nodeIds: ["screen"] });
    const workflow = parse(deleted.workflowSource);
    expect(workflow.spec.nodes.find((node: { id: string }) => node.id === "manual-review")).toMatchObject({
      kind: "approval", inputSchema: { type: "object", required: ["caseId"] },
      config: { ui: { position: { x: 420, y: 180 } }, caseWrites: [] },
    });
    expect(workflow.spec.nodes.some((node: { id: string }) => node.id === "screen")).toBe(false);
    expect(workflow.spec.edges).toEqual(expect.arrayContaining([expect.objectContaining({ from: "review", to: "manual-review" })]));
  });

  it("wraps group members behind a native group boundary", () => {
    const sources = workflowWithSteps();
    const result = addOrchestrationNode(sources.workflowSource, {
      kind: "group", id: "screening-group", name: "Screening group",
      memberIds: ["screen", "review"], execution: "sequential", exit: "serialize",
    });
    const workflow = parse(result.workflowSource);
    expect(workflow.spec.nodes).toContainEqual(expect.objectContaining({
      id: "screening-group", kind: "group",
      config: { members: ["screen", "review"], execution: "sequential", exit: "serialize" },
    }));
    expect(workflow.spec.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: "intake", to: "screening-group" }),
      expect.objectContaining({ from: "screen", to: "review" }),
      expect.objectContaining({ from: "screening-group", to: "result" }),
    ]));
    expect(analyzeAuthoringSources(sources.packageSource, result.workflowSource).diagnostics.filter((item) => item.severity === "error")).toEqual([]);
  });

  it("inserts a state-mapped native subgraph into the selected path", () => {
    const sources = defaultAuthoringSources();
    const result = addOrchestrationNode(sources.workflowSource, {
      kind: "subgraph", id: "verification-phase", name: "Verification phase", insertAfter: "intake",
      ref: "ladder://workflows/verification", inputMap: { request: "/input" }, outputMap: { result: "/output" },
      checkpointer: "perInvocation",
    });
    const workflow = parse(result.workflowSource);
    expect(workflow.spec.nodes).toContainEqual(expect.objectContaining({
      id: "verification-phase", kind: "subgraph",
      config: { subgraph: expect.objectContaining({ ref: "ladder://workflows/verification", checkpointer: "perInvocation" }) },
    }));
    expect(workflow.spec.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: "intake", to: "verification-phase" }),
      expect.objectContaining({ from: "verification-phase", to: "result" }),
    ]));
    expect(analyzeAuthoringSources(sources.packageSource, result.workflowSource).diagnostics.filter((item) => item.severity === "error")).toEqual([]);
  });

  it("compiles the canvas-authored group and subgraph as native plan nodes", async () => {
    const sources = workflowWithSteps();
    const grouped = addOrchestrationNode(sources.workflowSource, {
      kind: "group", id: "review-group", name: "Review group",
      memberIds: ["screen", "review"], execution: "sequential", exit: "serialize",
    });
    const nested = addOrchestrationNode(grouped.workflowSource, {
      kind: "subgraph", id: "verification-phase", name: "Verification phase", insertAfter: "review-group",
      ref: "ladder://workflows/verification", inputMap: { request: "/input" }, outputMap: { result: "/output" },
      checkpointer: "inherit",
    });
    const result = await compileAuthoringDraft({
      packageSource: sources.packageSource,
      workflowSource: nested.workflowSource,
      registryCapabilities: [],
      modelProfilesPath: new URL("../../../config/model-profiles.json", import.meta.url).pathname,
    });
    expect(result.diagnostics.filter((item) => item.severity === "error")).toEqual([]);
    expect(result.plan?.graph.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "review-group", kind: "group" }),
      expect.objectContaining({ id: "verification-phase", kind: "subgraph" }),
    ]));
  });
});
