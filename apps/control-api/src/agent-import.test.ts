import { afterEach, describe, expect, it, vi } from "vitest";
import { parse, stringify } from "yaml";
import { buildAgentBundleFromFiles, importAgentBundle, parseGithubRepository } from "./agent-import.js";
import { applyAgentToAuthoringSources, materializeRegisteredContracts, updateNodeCaseWrites } from "./authoring-agents.js";
import { analyzeAuthoringSources, defaultAuthoringSources } from "./authoring.js";

describe("agent authoring", () => {
  it("imports a manifest and SKILL.md into provider-neutral registry contracts", () => {
    const bundle = buildAgentBundleFromFiles({ owner: "acme", repo: "evidence-reviewer" }, "main", [
      { path: "agent.yaml", content: "name: Evidence Reviewer\nrole: KYC analyst\ndescription: Reviews evidence\nmodel: anthropic/claude\nprompt: Return a recommendation.\n" },
      { path: "skills/screening/SKILL.md", content: "---\nname: Screening review\ndescription: Interpret screening results\n---\nCheck evidence provenance before deciding.\n" },
    ]);
    expect(bundle.agent.modelProfileId).toBe("model.standard.v1");
    expect(bundle.agent.skillIds).toEqual([bundle.skills[0]?.id]);
    expect(bundle.skills[0]?.source.type).toBe("github");
  });

  it("attaches an agent by updating portable workflow YAML", () => {
    const sources = defaultAuthoringSources();
    const bundle = buildAgentBundleFromFiles({ owner: "acme", repo: "reviewer" }, "main", [
      { path: "agent.yaml", content: "name: Reviewer\nrole: Analyst\ndescription: Reviews risk\nprompt: Review risk.\ninputSchema:\n  type: object\n  properties:\n    evidenceId: { type: string }\noutputSchema:\n  type: object\n  properties:\n    outcome: { type: string }\ncaseWrites:\n  - commandType: SubmitDecisionRecommendation\n    when: success\n    payload: {}\n    payloadSchema:\n      type: object\n      properties:\n        outcome: { type: string }\n" },
    ]);
    const attached = applyAgentToAuthoringSources({ ...sources, agent: bundle.agent, skills: bundle.skills, nodeId: "intake", mode: "insert-after", newNodeId: "review" });
    const pkg = parse(attached.packageSource);
    const workflow = parse(attached.workflowSource);
    const node = workflow.spec.nodes.find((candidate: { id: string }) => candidate.id === "review");
    expect(node.config.agentRef).toBe(bundle.agent.id);
    expect(node.config.modelProfileId).toBe("model.standard.v1");
    expect(node.config.runtimeTarget).toBe("local_http");
    expect(node.config.caseWrites).toEqual([expect.objectContaining({ commandType: "SubmitDecisionRecommendation", when: "success" })]);
    expect(node.inputSchema.properties).toHaveProperty("evidenceId");
    expect(node.outputSchema.properties).toHaveProperty("outcome");
    expect(node.config.caseWrites[0].payloadSchema.properties).toHaveProperty("outcome");
    expect(node.prompt).toBe("Review risk.");
    expect(node.config).not.toHaveProperty("skillRefs");
    expect(pkg.agents).toBeUndefined();
    expect(pkg.agentProfiles).toEqual([expect.objectContaining({ id: bundle.agent.id, instructions: [] })]);
    expect(pkg.agentProfiles[0]).not.toHaveProperty("source");
    expect(pkg.agentProfiles[0]).not.toHaveProperty("status");
    expect(analyzeAuthoringSources(attached.packageSource, attached.workflowSource).diagnostics.filter((item) => item.severity === "error")).toEqual([]);
  });

  it("folds registered instructions into the agent profile and preserves case writes when replacing a node", () => {
    const sources = defaultAuthoringSources();
    const workflow = parse(sources.workflowSource);
    workflow.spec.nodes.splice(1, 0, {
      id: "review", kind: "transform", name: "Review",
      config: { caseWrites: [{ commandType: "SubmitDecisionRecommendation", payload: { outcome: "{{ output.outcome }}" }, payloadSchema: { type: "object" } }] },
    });
    workflow.spec.edges = [
      { id: "e1", from: "intake", to: "review", kind: "data" },
      { id: "e2", from: "review", to: "result", kind: "data" },
    ];
    const bundle = buildAgentBundleFromFiles({ owner: "acme", repo: "reviewer" }, "main", [
      { path: "agent.yaml", content: "name: Reviewer\nrole: Analyst\ndescription: Reviews risk\nprompt: Review risk.\n" },
      { path: "skills/review/SKILL.md", content: "---\nname: Risk review\ndescription: Review risk evidence\n---\nCheck the evidence.\n" },
    ]);
    const attached = applyAgentToAuthoringSources({
      packageSource: sources.packageSource, workflowSource: JSON.stringify(workflow), agent: bundle.agent, skills: bundle.skills,
      nodeId: "review", mode: "replace",
    });
    const pkg = parse(attached.packageSource);
    const replaced = parse(attached.workflowSource).spec.nodes.find((candidate: { id: string }) => candidate.id === "review");
    expect(pkg.skills).toBeUndefined();
    expect(pkg.agentProfiles).toEqual([expect.objectContaining({
      id: bundle.agent.id,
      instructions: [expect.objectContaining({ id: bundle.skills[0]?.id, text: "Check the evidence." })],
    })]);
    expect(replaced.config.caseWrites).toHaveLength(1);
    expect(analyzeAuthoringSources(attached.packageSource, attached.workflowSource).diagnostics.filter((item) => item.severity === "error")).toEqual([]);
  });

  it("updates case-write contracts directly on a canvas node", () => {
    const sources = defaultAuthoringSources();
    const workflowSource = updateNodeCaseWrites(sources.workflowSource, "intake", [{
      commandType: "LinkEvidence", when: "success", payload: { evidenceId: "{{ output.id }}" }, payloadSchema: { type: "object" },
    }]);
    const workflow = parse(workflowSource);
    expect(workflow.spec.nodes[0].config.caseWrites).toEqual([expect.objectContaining({ commandType: "LinkEvidence" })]);
    expect(analyzeAuthoringSources(sources.packageSource, workflowSource).diagnostics.filter((item) => item.severity === "error")).toEqual([]);
  });

  it("materializes registry agent references as agent profiles before compilation", () => {
    const sources = defaultAuthoringSources();
    const bundle = buildAgentBundleFromFiles({ owner: "acme", repo: "reviewer" }, "main", [
      { path: "agent.yaml", content: "id: domain-agent1\nname: Reviewer\nrole: Analyst\ndescription: Reviews risk\nprompt: Review risk.\ncaseWrites:\n  - commandType: LinkEvidence\n    payload: {}\n    payloadSchema: { type: object }\n" },
      { path: "skills/review/SKILL.md", content: "---\nname: Risk review\ndescription: Review risk evidence\n---\nCheck the evidence.\n" },
    ]);
    const workflow = parse(sources.workflowSource);
    workflow.spec.nodes.splice(1, 0, {
      id: "review", kind: "evaluate", name: "Reviewer",
      config: { agentRef: bundle.agent.id },
    });
    workflow.spec.edges = [
      { id: "e1", from: "intake", to: "review", kind: "data" },
      { id: "e2", from: "review", to: "result", kind: "data" },
    ];
    const materialized = materializeRegisteredContracts({
      packageSource: sources.packageSource, workflowSource: JSON.stringify(workflow), agents: [bundle.agent], skills: bundle.skills, capabilities: [],
    });
    const pkg = parse(materialized.packageSource);
    const node = parse(materialized.workflowSource).spec.nodes.find((candidate: { id: string }) => candidate.id === "review");
    expect(materialized.materialized).toBe(true);
    expect(pkg.agentProfiles).toEqual([expect.objectContaining({
      id: bundle.agent.id, instructions: [expect.objectContaining({ id: bundle.skills[0]?.id })],
    })]);
    expect(node.config.caseWrites).toEqual([expect.objectContaining({ commandType: "LinkEvidence" })]);
    expect(analyzeAuthoringSources(materialized.packageSource, materialized.workflowSource).diagnostics.filter((item) => item.severity === "error")).toEqual([]);
  });

  it("materializes an active catalog capability bound to a workflow node", () => {
    const sources = defaultAuthoringSources();
    const pkg = parse(sources.packageSource);
    pkg.bindings = { intake: "identity.ocr.extract.v1" };
    const capability = {
      id: "identity.ocr.extract.v1",
      kind: "tool" as const,
      effect: "read" as const,
      adapterBindingId: "vendor:identity-ocr-extract",
      inputSchema: { type: "object", properties: {} },
      outputSchema: { type: "object", properties: {} },
      timeoutMs: 15_000,
      maxAttempts: 1,
      idempotent: true,
      description: "Extract identity document fields.",
      owner: "identity-platform",
      dataClasses: ["identity", "pii"],
      status: "active" as const,
    };
    const materialized = materializeRegisteredContracts({
      packageSource: JSON.stringify(pkg),
      workflowSource: sources.workflowSource,
      agents: [],
      skills: [],
      capabilities: [capability],
    });
    const materializedPackage = parse(materialized.packageSource);

    expect(materialized.materialized).toBe(true);
    expect(materializedPackage.capabilities).toContainEqual(expect.objectContaining({
      id: capability.id,
      adapterBindingId: capability.adapterBindingId,
    }));
  });
});


describe("GitHub import boundary", () => {
  afterEach(() => vi.unstubAllGlobals());
  it.each(["https://evil.example/acme/repo", "https://github.com:444/acme/repo", "https://name:password@github.com/acme/repo", "http://github.com/acme/repo", "https://github.com/acme/repo%2f..", "https://github.com/acme/repo%3fref=evil"])("rejects unsafe repository URL %s", (url) => {
    expect(() => parseGithubRepository(url)).toThrow();
  });
  it("encodes each path segment and refuses redirects on every request", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      requests.push({ url, init });
      if (requests.length === 1) return Response.json({ default_branch: "feature/review" });
      if (requests.length === 2) return Response.json({ tree: [{ path: "skills/a#b/SKILL.md", type: "blob", size: 10 }] });
      return new Response("---\nname: Review\ndescription: Test skill\n---\nReview evidence.");
    }));
    await importAgentBundle("acme/reviewer");
    expect(requests.map((entry) => entry.url)).toEqual([
      "https://api.github.com/repos/acme/reviewer",
      "https://api.github.com/repos/acme/reviewer/git/trees/feature%2Freview?recursive=1",
      "https://raw.githubusercontent.com/acme/reviewer/feature%2Freview/skills/a%23b/SKILL.md",
    ]);
    for (const entry of requests) {
      expect(entry.init.redirect).toBe("error");
      expect(entry.init.signal).toBeInstanceOf(AbortSignal);
    }
  });
});

it("pins selected agent case reads into node grants and refuses conflicting process definitions", () => {
  const sources = defaultAuthoringSources();
  const bundle = buildAgentBundleFromFiles({ owner: "acme", repo: "reader" }, "main", [{ path: "agent.yaml", content: "name: Reader\nrole: Analyst\ndescription: Reads identity\nprompt: Read identity.\n" }]);
  const read = { id: "case-identity", source: "case" as const, path: "case.caseId", purpose: "REVIEW", classification: "CONFIDENTIAL", required: true };
  const agent = { ...bundle.agent, caseReads: [read] };
  const attached = applyAgentToAuthoringSources({ ...sources, agent, skills: [], nodeId: "intake", mode: "insert-after", newNodeId: "reader" });
  const pkg = parse(attached.packageSource);
  const node = parse(attached.workflowSource).spec.nodes.find((node: { id: string }) => node.id === "reader");
  expect(pkg.contextSelectors).toEqual([read]);
  expect(node.contextSelectorIds).toEqual([read.id]);
  expect(pkg.agentProfiles[0].purposes).toEqual(["REVIEW"]);
  pkg.contextSelectors[0].path = "subjects";
  expect(() => applyAgentToAuthoringSources({ ...sources, packageSource: stringify(pkg), agent, skills: [], nodeId: "intake", mode: "insert-after", newNodeId: "reader" })).toThrow("authoring.agent_case_read_conflict:case-identity");
  expect(() => applyAgentToAuthoringSources({ ...sources, agent: { ...agent, caseReads: [read, { ...read, id: "other", purpose: "OTHER" }] }, skills: [], nodeId: "intake", mode: "insert-after", newNodeId: "reader" })).toThrow("authoring.agent_case_reads_invalid");
});
