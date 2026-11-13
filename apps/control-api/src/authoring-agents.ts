import { parse, stringify } from "yaml";
import type { AgentRegistration, CapabilityRegistration, SkillRegistration } from "@ehf/contracts";

type JsonMap = Record<string, unknown>;
function object(value: unknown): value is JsonMap { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }

const V2_PACKAGE = "harness.factory/domain-package-v2";

function nodeSelectorIds(node: JsonMap): string[] {
  const config = object(node.config) ? node.config : {};
  const ids = Array.isArray(node.contextSelectorIds) ? node.contextSelectorIds : Array.isArray(config.contextSelectorIds) ? config.contextSelectorIds : [];
  return ids.filter((id): id is string => typeof id === "string");
}

/**
 * What the nodes running as `agentId` read and run: the purposes of their context
 * selectors and the business skills they are bound to (at the package binding's semver).
 * A profile assembled from a registration is granted exactly these, nothing wider.
 */
function profileGrants(pkg: JsonMap, nodes: JsonMap[], agentId: string): { purposes: string[]; allowedSkills: Array<{ skillId: string; semver: string }> } {
  const selectors = new Map((Array.isArray(pkg.contextSelectors) ? pkg.contextSelectors : [])
    .filter(object).map((selector) => [String(selector.id), String(selector.purpose)]));
  const bindings = new Map((Array.isArray(pkg.skillBindings) ? pkg.skillBindings : [])
    .filter(object).map((binding) => [String(binding.skillId), String(binding.semver)]));
  const purposes = new Set<string>();
  const skills = new Map<string, string>();
  for (const node of nodes) {
    const config = object(node.config) ? node.config : {};
    if (config.agentRef !== agentId) continue;
    for (const id of nodeSelectorIds(node)) {
      const purpose = selectors.get(id);
      if (purpose) purposes.add(purpose);
    }
    const semver = typeof config.skillId === "string" ? bindings.get(config.skillId) : undefined;
    if (typeof config.skillId === "string" && semver) skills.set(config.skillId, semver);
  }
  return {
    purposes: [...purposes].sort(),
    allowedSkills: [...skills].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)).map(([skillId, semver]) => ({ skillId, semver })),
  };
}

/**
 * An agent profile assembled from a registered agent and its registered instructions
 * (the registry's playbooks, folded in as `instructions` in the agent's order).
 * `allowedCapabilities` is left to harnessc, which computes it.
 */
function agentProfileFrom(agent: AgentRegistration, instructions: SkillRegistration[], grants: ReturnType<typeof profileGrants>): JsonMap {
  return {
    id: agent.id, version: agent.version, name: agent.name, description: agent.description, role: agent.role, prompt: agent.prompt,
    modelProfileId: agent.modelProfileId, runtimeTarget: agent.runtimeTarget, caseWrites: agent.caseWrites,
    ...(agent.primaryCapabilityId ? { primaryCapabilityId: agent.primaryCapabilityId } : {}),
    purposes: grants.purposes, allowedSkills: grants.allowedSkills,
    instructions: instructions.map((instruction) => ({
      id: instruction.id, version: instruction.version, name: instruction.name, description: instruction.description,
      text: instruction.instructions, allowedCapabilityIds: instruction.allowedCapabilityIds,
    })),
    inputSchema: agent.inputSchema, outputSchema: agent.outputSchema,
  };
}

function registeredInstructions(agent: AgentRegistration, registry: SkillRegistration[]): SkillRegistration[] {
  return agent.skillIds.map((skillId) => {
    const instruction = registry.find((candidate) => candidate.id === skillId);
    if (!instruction) throw new Error(`authoring.agent_instruction_not_registered:${skillId}`);
    return instruction;
  });
}

/// A registry capability becomes part of the package the compiler sees, so the plan
/// embeds the exact capability contract it was compiled against rather than a name that
/// the gateway registry could later redefine underneath an admitted plan.
function compiledCapability(capability: CapabilityRegistration): JsonMap {
  const { description: _description, owner: _owner, dataClasses: _classes, status: _status, ...contract } = capability;
  return contract;
}

function withoutSkillRefs(config: JsonMap): JsonMap {
  const { skillRefs: _skillRefs, ...rest } = config;
  return rest;
}

function upsertById(items: JsonMap[], additions: JsonMap[]): JsonMap[] {
  const additionIds = new Set(additions.map((item) => item.id));
  return [...items.filter((item) => !additionIds.has(item.id)), ...additions];
}

function registerAgentReads(pkg: JsonMap, agent: AgentRegistration): string[] {
  const reads = agent.caseReads ?? [];
  if (!reads.length) return [];
  if (new Set(reads.map(read => read.id)).size !== reads.length || new Set(reads.map(read => read.purpose)).size > 1)
    throw new Error("authoring.agent_case_reads_invalid");
  const selectors = Array.isArray(pkg.contextSelectors) ? pkg.contextSelectors.filter(object) : [];
  // A reusable agent must never redefine a process's existing grant under the same ID.
  const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => object(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
  for (const read of reads) {
    const existing = selectors.find(selector => selector.id === read.id);
    if (existing && canonical(existing) !== canonical(read)) throw new Error(`authoring.agent_case_read_conflict:${read.id}`);
    if (!existing) selectors.push(read);
  }
  pkg.contextSelectors = selectors;
  return reads.map(read => read.id);
}

export function applyAgentToAuthoringSources(input: {
  packageSource: string; workflowSource: string; agent: AgentRegistration; skills: SkillRegistration[]; nodeId: string;
  mode: "replace" | "insert-after"; newNodeId?: string;
}): { packageSource: string; workflowSource: string; attachedNodeId: string } {
  const pkg = parse(input.packageSource) as JsonMap;
  const workflow = parse(input.workflowSource) as JsonMap;
  if (!object(pkg) || !object(workflow) || !object(workflow.spec)) throw new Error("authoring.agent_source_invalid");
  const nodes = Array.isArray(workflow.spec.nodes) ? workflow.spec.nodes as JsonMap[] : [];
  const edges = Array.isArray(workflow.spec.edges) ? workflow.spec.edges as JsonMap[] : [];
  const selectedIndex = nodes.findIndex((node) => node.id === input.nodeId);
  if (selectedIndex < 0) throw new Error("authoring.agent_node_not_found");
  const selected = nodes[selectedIndex]!;
  if (selected.kind === "input" && input.mode === "replace" || selected.kind === "output") throw new Error("authoring.agent_node_kind_protected");
  // Agent profiles are the only agent contract; a package of another version is refused.
  if (pkg.apiVersion !== V2_PACKAGE) throw new Error("authoring.package_contract_unsupported");
  const attachedNodeId = input.mode === "replace" ? input.nodeId : (input.newNodeId?.trim() || `${input.nodeId}-${input.agent.name}`).toLowerCase().replace(/[^a-z0-9-]+/g, "-").split("-").filter(Boolean).join("-");
  if (!attachedNodeId || input.mode === "insert-after" && nodes.some((node) => node.id === attachedNodeId)) throw new Error("authoring.agent_node_id_invalid");
  const priorConfig = input.mode === "replace" && object(selected.config) ? selected.config : {};
  const caseReadIds = registerAgentReads(pkg, input.agent);
  const agentNode: JsonMap = {
    ...(input.mode === "replace" ? selected : {}), id: attachedNodeId, kind: "evaluate", name: input.agent.name,
    summary: input.agent.description, role: input.agent.role, prompt: input.agent.prompt,
    inputSchema: input.agent.inputSchema, outputSchema: input.agent.outputSchema,
    ...(input.agent.caseReads !== undefined ? { contextSelectorIds: caseReadIds } : {}),
    // The node's instructions come from its agent profile, so it carries no skillRefs.
    config: { caseWrites: input.agent.caseWrites, ...withoutSkillRefs(priorConfig), agentRef: input.agent.id, agentVersion: input.agent.version, modelProfileId: input.agent.modelProfileId, runtimeTarget: input.agent.runtimeTarget },
  };
  if (input.mode === "replace") nodes[selectedIndex] = agentNode;
  else {
    nodes.splice(selectedIndex + 1, 0, agentNode);
    const outgoing = edges.filter((edge) => edge.from === input.nodeId);
    outgoing.forEach((edge) => { edge.from = attachedNodeId; });
    edges.push({ id: `edge-${input.nodeId}-${attachedNodeId}`, from: input.nodeId, to: attachedNodeId, kind: "data" });
  }
  const modelProfiles = Array.isArray(pkg.modelProfiles) ? pkg.modelProfiles as unknown[] : [];
  if (!modelProfiles.includes(input.agent.modelProfileId)) pkg.modelProfiles = [...modelProfiles, input.agent.modelProfileId];
  if (pkg.skills !== undefined || pkg.agents !== undefined) throw new Error("authoring.agent_profiles_required");
  const profiles = Array.isArray(pkg.agentProfiles) ? pkg.agentProfiles as JsonMap[] : [];
  const instructions = registeredInstructions(input.agent, input.skills);
  pkg.agentProfiles = upsertById(profiles, [agentProfileFrom(input.agent, instructions, profileGrants(pkg, nodes, input.agent.id))]);
  if (input.agent.primaryCapabilityId) {
    const bindings = object(pkg.bindings) ? pkg.bindings : {};
    if (["__proto__", "constructor", "prototype"].includes(attachedNodeId)) throw new Error("authoring.agent_node_id_invalid");
    pkg.bindings = Object.fromEntries([...Object.entries(bindings), [attachedNodeId, input.agent.primaryCapabilityId]]);
  }
  return { packageSource: stringify(pkg, { lineWidth: 120 }), workflowSource: stringify(workflow, { lineWidth: 120 }), attachedNodeId };
}

export function materializeRegisteredContracts(input: {
  packageSource: string; workflowSource: string; agents: AgentRegistration[]; skills: SkillRegistration[];
  capabilities: CapabilityRegistration[];
}): { packageSource: string; workflowSource: string; materialized: boolean } {
  const pkg = parse(input.packageSource) as JsonMap;
  const workflow = parse(input.workflowSource) as JsonMap;
  if (!object(pkg) || !object(workflow) || !object(workflow.spec)) throw new Error("authoring.agent_source_invalid");
  const nodes = Array.isArray(workflow.spec.nodes) ? workflow.spec.nodes as JsonMap[] : [];
  // A package of another version is left alone: authoring analysis and the compiler refuse it.
  if (pkg.apiVersion !== V2_PACKAGE) {
    return { packageSource: input.packageSource, workflowSource: input.workflowSource, materialized: false };
  }
  const packageProfiles = Array.isArray(pkg.agentProfiles) ? pkg.agentProfiles as JsonMap[] : [];
  // A package that still declares skills/agents is left alone: the compiler refuses it
  // with package.agent_profiles_required, and the author folds them into agentProfiles.
  const retiredKeys = pkg.skills !== undefined || pkg.agents !== undefined;
  const embeddedAgentIds = new Set(packageProfiles.map((agent) => agent.id).filter((id): id is string => typeof id === "string"));
  const registryAgents = new Map(input.agents.map((agent) => [agent.id, agent]));
  const missingAgentIds = new Set<string>();

  for (const node of nodes) {
    const config = object(node.config) ? node.config : {};
    const agentRef = typeof config.agentRef === "string" ? config.agentRef : null;
    if (agentRef && !embeddedAgentIds.has(agentRef) && !retiredKeys) missingAgentIds.add(agentRef);
  }

  const agents = [...missingAgentIds].flatMap((agentId) => {
    const agent = registryAgents.get(agentId);
    return agent ? [agent] : [];
  });
  const contractsMaterialized = agents.length > 0;
  if (contractsMaterialized) materializeAgentContracts();

  // Bindings are settled by now, so inline every bound capability the package does not
  // already carry. The compiler only sees the package, and a plan that named a registry
  // capability without embedding its contract could be re-pointed by a later registry
  // edit without changing the plan digest.
  const settledBindings = object(pkg.bindings) ? pkg.bindings : {};
  const packageCapabilities = Array.isArray(pkg.capabilities) ? pkg.capabilities as JsonMap[] : [];
  const embeddedCapabilityIds = new Set(packageCapabilities.map((capability) => capability.id).filter((id): id is string => typeof id === "string"));
  const registryCapabilities = new Map(input.capabilities.map((capability) => [capability.id, capability]));
  const missingCapabilities = [...new Set(Object.values(settledBindings).filter((id): id is string => typeof id === "string"))]
    .filter((id) => !embeddedCapabilityIds.has(id))
    .flatMap((id) => {
      const capability = registryCapabilities.get(id);
      return capability ? [capability] : [];
    });
  if (missingCapabilities.length) pkg.capabilities = upsertById(packageCapabilities, missingCapabilities.map(compiledCapability));

  if (!contractsMaterialized && !missingCapabilities.length) {
    return { packageSource: input.packageSource, workflowSource: input.workflowSource, materialized: false };
  }
  return {
    packageSource: stringify(pkg, { lineWidth: 120 }),
    workflowSource: stringify(workflow, { lineWidth: 120 }),
    materialized: true,
  };

  function materializeAgentContracts(): void {
    for (const agent of agents) {
      const ids = registerAgentReads(pkg, agent);
      for (const node of nodes) if (object(node.config) && node.config.agentRef === agent.id && node.contextSelectorIds === undefined && agent.caseReads !== undefined) node.contextSelectorIds = ids;
    }
    // Registered agents and their registered instructions become agent profiles.
    pkg.agentProfiles = upsertById(packageProfiles, agents.map((agent) =>
      agentProfileFrom(agent, registeredInstructions(agent, input.skills), profileGrants(pkg, nodes, agent.id))));
    const modelProfiles = Array.isArray(pkg.modelProfiles) ? pkg.modelProfiles as unknown[] : [];
    pkg.modelProfiles = [...new Set([...modelProfiles, ...agents.map((agent) => agent.modelProfileId)])];
    const bindings = object(pkg.bindings) ? pkg.bindings : {};
    for (const node of nodes) {
      const config = object(node.config) ? node.config : {};
      const agentRef = typeof config.agentRef === "string" ? config.agentRef : null;
      const agent = agentRef ? agents.find((candidate) => candidate.id === agentRef) : undefined;
      if (!agent) continue;
      node.inputSchema = object(node.inputSchema) ? node.inputSchema : agent.inputSchema;
      node.outputSchema = object(node.outputSchema) ? node.outputSchema : agent.outputSchema;
      node.role = typeof node.role === "string" ? node.role : agent.role;
      node.prompt = typeof node.prompt === "string" ? node.prompt : agent.prompt;
      node.config = {
        ...config,
        caseWrites: Array.isArray(config.caseWrites) ? config.caseWrites : agent.caseWrites,
        modelProfileId: typeof config.modelProfileId === "string" ? config.modelProfileId : agent.modelProfileId,
        runtimeTarget: typeof config.runtimeTarget === "string" ? config.runtimeTarget : agent.runtimeTarget,
      };
      if (agent.primaryCapabilityId && typeof bindings[String(node.id)] !== "string") bindings[String(node.id)] = agent.primaryCapabilityId;
    }
    pkg.bindings = bindings;
  }
}

export function updateNodeCaseWrites(workflowSource: string, nodeId: string, caseWrites: unknown[]): string {
  const workflow = parse(workflowSource) as JsonMap;
  if (!object(workflow) || !object(workflow.spec)) throw new Error("authoring.agent_source_invalid");
  const nodes = Array.isArray(workflow.spec.nodes) ? workflow.spec.nodes as JsonMap[] : [];
  const node = nodes.find((candidate) => candidate.id === nodeId);
  if (!node) throw new Error("authoring.agent_node_not_found");
  const config = object(node.config) ? node.config : {};
  node.config = { ...config, caseWrites };
  return stringify(workflow, { lineWidth: 120 });
}
