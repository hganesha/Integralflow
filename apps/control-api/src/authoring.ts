import { readFile } from "node:fs/promises";
import { parse, stringify } from "yaml";
import {
  businessCommandTypeSchema,
  caseReadGrantSchema,
  contextClassificationPolicySchema,
  capabilityDefinitionSchema,
  caseWriteEntrySchema,
  isSkillCaseWriteGrant,
  skillCaseWriteGrantSchema,
  integrationContractsSchema,
  packageAgentProfileSchema,
  stableDigest,
  type CapabilityDefinition,
  type CapabilityRegistration,
  type EvaluationReport,
  type HarnessPlanV2,
  runtimeTargetSchema,
} from "@ehf/contracts";
import type { ModelProfileRegistry } from "@ehf/compiler";
import type { AuthoringDiagnostic } from "@ehf/persistence";
import { compileWithHarnessc, HarnessCompilerError } from "./harnessc.js";

type JsonMap = Record<string, unknown>;
type PackageSource = {
  apiVersion: string;
  kind: string;
  metadata: { name: string; version: string; domain: string; objective: string };
  workflow: string;
  budgets: { maxDurationMs: number; maxCostUsd: number; maxModelCalls: number; maxCapabilityCalls: number };
  modelProfiles?: string[];
  /** Retired keys, read only to refuse them: agent profiles replaced them. */
  skills?: unknown[];
  agents?: unknown[];
  /** Agent profiles (docs/implementation/agent-profiles.md). */
  agentProfiles?: unknown[];
  capabilities?: unknown[];
  bindings?: Record<string, string>;
  contextSelectors?: unknown[];
  contextClassificationPolicies?: unknown[];
  integrations?: unknown;
};
type WorkflowNode = {
  id: string; kind: string; name?: string; summary?: string; prompt?: string;
  inputSchema?: JsonMap | null; outputSchema?: JsonMap | null; config?: JsonMap;
  contextSelectorIds?: unknown;
};
type WorkflowEdge = { id: string; from: string; to: string; kind: string; condition?: string; sourcePath?: string; targetPath?: string };
type WorkflowSource = {
  apiVersion: string; kind: string;
  metadata: { name: string; title?: string; description?: string; version?: string };
  spec: { objective?: string; inputs?: JsonMap; outputs?: JsonMap; policies?: { maxConcurrency?: number }; nodes: WorkflowNode[]; edges: WorkflowEdge[] };
};

const PACKAGE_API_VERSION = "harness.factory/domain-package-v2";
/** The removed v1 package contract; refused with its own diagnostic so an author knows to migrate. */
const RETIRED_PACKAGE_API_VERSION = "harness.factory/domain-package-v1";

const nodeKinds = new Set(["input", "output", "agent", "tool", "transform", "condition", "evaluate", "join", "aggregator", "group", "subgraph", "gate", "fanout", "approval"]);
const transformOperations = new Set(["identity", "select", "project", "merge", "deduplicate", "sort", "slice"]);
const aggregatorOperations = new Set(["collect", "merge", "concat", "vote"]);
const joinModes = new Set(["all", "allSettled"]);

function diagnostic(code: string, path: string, message: string, severity: AuthoringDiagnostic["severity"] = "error"): AuthoringDiagnostic {
  return { code, path, message, severity };
}

function object(value: unknown): value is JsonMap {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function topologicalOrder(nodes: WorkflowNode[], edges: WorkflowEdge[]): string[] {
  const incoming = new Map(nodes.map((node) => [node.id, 0]));
  const outgoing = new Map(nodes.map((node) => [node.id, [] as string[]]));
  for (const edge of edges) {
    if (!incoming.has(edge.to) || !outgoing.has(edge.from)) continue;
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
    outgoing.get(edge.from)?.push(edge.to);
  }
  const queue = nodes.filter((node) => incoming.get(node.id) === 0).map((node) => node.id);
  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift();
    if (!id) break;
    order.push(id);
    for (const target of outgoing.get(id) ?? []) {
      incoming.set(target, (incoming.get(target) ?? 1) - 1);
      if (incoming.get(target) === 0) queue.push(target);
    }
  }
  return order;
}

function validateCaseWrites(node: WorkflowNode, diagnostics: AuthoringDiagnostic[]) {
  const writes = node.config?.caseWrites;
  if (writes === undefined) return;
  if (!Array.isArray(writes)) {
    diagnostics.push(diagnostic("author.case_writes_array_required", `workflow.nodes.${node.id}.config.caseWrites`, "caseWrites must be an array."));
    return;
  }
  writes.forEach((entry, index) => {
    if (!object(entry)) {
      diagnostics.push(diagnostic("author.case_write_invalid", `workflow.nodes.${node.id}.config.caseWrites.${index}`, "Case write must be an object."));
      return;
    }
    if (isSkillCaseWriteGrant(entry)) {
      // A skill grant authorizes committing a hosted skill's output; harnessc checks it against the binding.
      if (!skillCaseWriteGrantSchema.safeParse(entry).success) diagnostics.push(diagnostic("author.case_write_skill_grant_invalid", `workflow.nodes.${node.id}.config.caseWrites.${index}`, "A skill grant names a canonical command and a grant kind (proposal, effect, held, release)."));
      return;
    }
    const command = businessCommandTypeSchema.safeParse(entry.commandType);
    if (!command.success) diagnostics.push(diagnostic("author.case_write_command_invalid", `workflow.nodes.${node.id}.config.caseWrites.${index}.commandType`, "Use a supported canonical case command."));
    if (!object(entry.payload)) diagnostics.push(diagnostic("author.case_write_payload_required", `workflow.nodes.${node.id}.config.caseWrites.${index}.payload`, "An executable payload mapping is required for each case write."));
    if (!object(entry.payloadSchema)) diagnostics.push(diagnostic("author.case_write_schema_required", `workflow.nodes.${node.id}.config.caseWrites.${index}.payloadSchema`, "A JSON Schema object is required for each case write."));
  });
}

function validateContextSelectors(pkg: unknown, nodes: WorkflowNode[], diagnostics: AuthoringDiagnostic[]) {
  if (!object(pkg) || pkg.contextSelectors === undefined) return;
  if (!Array.isArray(pkg.contextSelectors)) {
    diagnostics.push(diagnostic("author.context_selectors_array_required", "package.contextSelectors", "Context selectors must be an array."));
    return;
  }
  const selectors = new Map<string, string>();
  pkg.contextSelectors.forEach((value, index) => {
    const parsed = caseReadGrantSchema.safeParse(value);
    if (!parsed.success) {
      diagnostics.push(diagnostic("author.context_selector_invalid", `package.contextSelectors.${index}`, parsed.error.issues[0]?.message ?? "Invalid context selector."));
      return;
    }
    if (selectors.has(parsed.data.id)) {
      diagnostics.push(diagnostic("author.context_selector_duplicate", `package.contextSelectors.${index}.id`, `Context selector ${parsed.data.id} is duplicated.`));
      return;
    }
    selectors.set(parsed.data.id, parsed.data.purpose);
  });
  nodes.forEach((node, index) => {
    if (node.contextSelectorIds === undefined) return;
    if (!Array.isArray(node.contextSelectorIds) || node.contextSelectorIds.some((id) => typeof id !== "string" || !id.trim())) {
      diagnostics.push(diagnostic("author.context_selector_ids_invalid", `workflow.spec.nodes.${index}.contextSelectorIds`, "Context selector IDs must be a non-empty string array."));
      return;
    }
    const purposes = new Set<string>();
    node.contextSelectorIds.forEach((id) => {
      const purpose = selectors.get(id);
      if (!purpose) diagnostics.push(diagnostic("author.context_selector_unresolved", `workflow.spec.nodes.${index}.contextSelectorIds`, `Node ${node.id} references unknown context selector ${id}.`));
      else purposes.add(purpose);
    });
    if (purposes.size > 1) {
      diagnostics.push(diagnostic("author.context_selector_purpose_ambiguous", `workflow.spec.nodes.${index}.contextSelectorIds`, "A node may read context for only one declared purpose."));
    }
  });
}

function validateIntegrations(pkg: unknown, diagnostics: AuthoringDiagnostic[]) {
  if (!object(pkg) || pkg.integrations === undefined) return;
  const parsed = integrationContractsSchema.safeParse(pkg.integrations);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      diagnostics.push(diagnostic(
        "author.integration_contract_invalid",
        `package.integrations${issue.path.length ? `.${issue.path.join(".")}` : ""}`,
        issue.message,
      ));
    }
  }
}

function validateContextClassificationPolicies(pkg: unknown, diagnostics: AuthoringDiagnostic[]) {
  if (!object(pkg) || pkg.apiVersion !== "harness.factory/domain-package-v2") return;
  const selectorValues = Array.isArray(pkg.contextSelectors) ? pkg.contextSelectors : [];
  const selectorClassifications = selectorValues.flatMap((value) => {
    const parsed = caseReadGrantSchema.safeParse(value);
    return parsed.success ? [parsed.data.classification] : [];
  });
  const rawPolicies = pkg.contextClassificationPolicies;
  if (rawPolicies === undefined) {
    if (selectorClassifications.length) diagnostics.push(diagnostic(
      "author.context_classification_policies_required",
      "package.contextClassificationPolicies",
      "Every V2 case-read classification requires a configured treatment.",
    ));
    return;
  }
  if (!Array.isArray(rawPolicies)) {
    diagnostics.push(diagnostic("author.context_classification_policies_array_required", "package.contextClassificationPolicies", "Classification policies must be an array."));
    return;
  }
  const policies = new Map<string, "allow" | "mask" | "deny">();
  rawPolicies.forEach((value, index) => {
    const parsed = contextClassificationPolicySchema.safeParse(value);
    if (!parsed.success) {
      diagnostics.push(diagnostic("author.context_classification_policy_invalid", `package.contextClassificationPolicies.${index}`, parsed.error.issues[0]?.message ?? "Invalid classification policy."));
      return;
    }
    if (policies.has(parsed.data.classification)) {
      diagnostics.push(diagnostic("author.context_classification_policy_duplicate", `package.contextClassificationPolicies.${index}.classification`, `Classification ${parsed.data.classification} is duplicated.`));
      return;
    }
    policies.set(parsed.data.classification, parsed.data.action);
  });
  for (const classification of new Set(selectorClassifications)) {
    const action = policies.get(classification);
    if (!action) diagnostics.push(diagnostic("author.context_classification_policy_missing", "package.contextClassificationPolicies", `Classification ${classification} has case-read selectors but no treatment.`));
    if (action === "deny") diagnostics.push(diagnostic("author.context_classification_denied", "package.contextClassificationPolicies", `Classification ${classification} is denied, so its selectors cannot be granted to a node.`));
  }
}

function validatePrimitiveConfig(node: WorkflowNode, index: number, diagnostics: AuthoringDiagnostic[]) {
  const operation = String(node.config?.operation ?? (node.kind === "aggregator" ? "collect" : "identity"));
  if (node.kind === "transform" && !transformOperations.has(operation)) {
    diagnostics.push(diagnostic("author.transform_operation_unsupported", `workflow.spec.nodes.${index}.config.operation`, `Unsupported transform operation: ${operation}.`));
  }
  if (node.kind === "aggregator" && !aggregatorOperations.has(operation)) {
    diagnostics.push(diagnostic("author.aggregator_operation_unsupported", `workflow.spec.nodes.${index}.config.operation`, `Unsupported aggregator operation: ${operation}.`));
  }
  if (node.kind === "join") {
    const mode = String(node.config?.mode ?? node.config?.operation ?? "all");
    if (!joinModes.has(mode)) diagnostics.push(diagnostic("author.join_mode_unsupported", `workflow.spec.nodes.${index}.config.mode`, `Unsupported join mode: ${mode}.`));
  }
  if (node.kind === "group") {
    const members = node.config?.members;
    if (!Array.isArray(members) || members.length === 0 || members.some((member) => typeof member !== "string" || !member)) {
      diagnostics.push(diagnostic("author.group_members_required", `workflow.spec.nodes.${index}.config.members`, "Groups require at least one member node ID."));
    }
    if (!new Set(["sequential", "parallel"]).has(String(node.config?.execution))) {
      diagnostics.push(diagnostic("author.group_execution_invalid", `workflow.spec.nodes.${index}.config.execution`, "Group execution must be sequential or parallel."));
    }
    if (!new Set(["serialize", "aggregate"]).has(String(node.config?.exit))) {
      diagnostics.push(diagnostic("author.group_exit_invalid", `workflow.spec.nodes.${index}.config.exit`, "Group exit must serialize or aggregate member outputs."));
    }
  }
  if (node.kind === "subgraph") {
    const subgraph = object(node.config?.subgraph) ? node.config.subgraph : {};
    if (typeof subgraph.ref !== "string" || !/^(?:ladder:\/\/|host:).+/.test(subgraph.ref)) {
      diagnostics.push(diagnostic("author.subgraph_ref_invalid", `workflow.spec.nodes.${index}.config.subgraph.ref`, "Subgraph ref must use ladder:// or host:."));
    }
    for (const field of ["inputMap", "outputMap"] as const) {
      const mapping = subgraph[field];
      if (!object(mapping) || Object.keys(mapping).length === 0 || Object.values(mapping).some((path) => typeof path !== "string" || !path.startsWith("/"))) {
        diagnostics.push(diagnostic(`author.subgraph_${field}_invalid`, `workflow.spec.nodes.${index}.config.subgraph.${field}`, `${field} must contain at least one JSON Pointer mapping.`));
      }
    }
    if (!new Set(["inherit", "perInvocation", "perThread", "stateless"]).has(String(subgraph.checkpointer))) {
      diagnostics.push(diagnostic("author.subgraph_checkpointer_invalid", `workflow.spec.nodes.${index}.config.subgraph.checkpointer`, "Use inherit, perInvocation, perThread, or stateless."));
    }
  }
}

/**
 * One `agentProfiles` contract replaced `skills` and `agents`. The compiler enforces the
 * full rule set; these diagnostics point the editor at the source.
 */
function validateAgentProfiles(pkg: PackageSource, nodes: WorkflowNode[], diagnostics: AuthoringDiagnostic[]) {
  for (const key of ["skills", "agents"] as const) {
    if (pkg[key] !== undefined) diagnostics.push(diagnostic("author.agent_profiles_required", `package.${key}`, `A v2 package declares agentProfiles instead of ${key}; fold each agent and its instructions into one agent profile.`));
  }
  if (pkg.agentProfiles !== undefined && !Array.isArray(pkg.agentProfiles)) {
    diagnostics.push(diagnostic("author.agent_profiles_array_required", "package.agentProfiles", "Agent profiles must be an array."));
    return;
  }
  const profiles = new Map<string, string>();
  (pkg.agentProfiles ?? []).forEach((profile, index) => {
    const parsed = packageAgentProfileSchema.safeParse(profile);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      diagnostics.push(diagnostic("author.agent_profile_invalid", `package.agentProfiles.${index}${issue?.path.length ? `.${issue.path.join(".")}` : ""}`, issue?.message ?? "Invalid agent profile."));
      return;
    }
    if (profiles.has(parsed.data.id)) {
      diagnostics.push(diagnostic("author.agent_profile_duplicate", `package.agentProfiles.${index}.id`, `Agent profile ${parsed.data.id} is duplicated.`));
      return;
    }
    profiles.set(parsed.data.id, parsed.data.version);
    const instructionIds = new Set<string>();
    parsed.data.instructions.forEach((instruction, position) => {
      if (instructionIds.has(instruction.id)) diagnostics.push(diagnostic("author.agent_instruction_duplicate", `package.agentProfiles.${index}.instructions.${position}.id`, `Instruction ${instruction.id} is duplicated in agent profile ${parsed.data.id}.`));
      instructionIds.add(instruction.id);
    });
  });
  nodes.forEach((node, index) => {
    if (node.config?.skillRefs !== undefined) {
      diagnostics.push(diagnostic("author.skill_refs_retired", `workflow.spec.nodes.${index}.config.skillRefs`, `Node ${node.id} declares skillRefs; in a v2 package its instructions come from its agent profile.`));
    }
    const agentRef = node.config?.agentRef;
    if (agentRef === undefined) return;
    const version = typeof agentRef === "string" ? profiles.get(agentRef) : undefined;
    if (version === undefined) {
      diagnostics.push(diagnostic("author.node_agent_profile_missing", `workflow.spec.nodes.${index}.config.agentRef`, `Node ${node.id} references missing agent profile ${String(agentRef)}.`));
    } else if (node.config?.agentVersion !== undefined && node.config.agentVersion !== version) {
      diagnostics.push(diagnostic("author.node_agent_profile_version_mismatch", `workflow.spec.nodes.${index}.config.agentVersion`, `Node ${node.id} pins ${String(agentRef)}@${String(node.config.agentVersion)}, but the package declares version ${version}.`));
    }
  });
}

export function analyzeAuthoringSources(packageSource: string, workflowSource: string): {
  parsedPackage: JsonMap;
  parsedWorkflow: JsonMap;
  diagnostics: AuthoringDiagnostic[];
  metadata: { name: string; domain: string; version: string };
} {
  const diagnostics: AuthoringDiagnostic[] = [];
  let pkg: PackageSource;
  let workflow: WorkflowSource;
  try {
    pkg = parse(packageSource) as PackageSource;
  } catch (error) {
    throw new Error(`authoring.package_yaml_invalid: ${error instanceof Error ? error.message : "parse failed"}`);
  }
  try {
    workflow = parse(workflowSource) as WorkflowSource;
  } catch (error) {
    throw new Error(`authoring.workflow_yaml_invalid: ${error instanceof Error ? error.message : "parse failed"}`);
  }
  if (object(pkg) && pkg.apiVersion === RETIRED_PACKAGE_API_VERSION) {
    diagnostics.push(diagnostic("author.package_v1_removed", "package.apiVersion", `${RETIRED_PACKAGE_API_VERSION} packages are no longer supported; migrate the package to ${PACKAGE_API_VERSION}.`));
  } else if (!object(pkg) || pkg.apiVersion !== PACKAGE_API_VERSION || pkg.kind !== "DomainPackage") {
    diagnostics.push(diagnostic("author.package_contract_unsupported", "package", `Expected a ${PACKAGE_API_VERSION} DomainPackage.`));
  }
  if (!object(pkg?.metadata) || !pkg.metadata.name || !pkg.metadata.domain || !pkg.metadata.version || !pkg.metadata.objective) {
    diagnostics.push(diagnostic("author.package_metadata_required", "package.metadata", "Name, domain, version, and objective are required."));
  }
  if (!object(workflow) || workflow.apiVersion !== "ladder.dev/v1alpha1" || workflow.kind !== "Workflow") {
    diagnostics.push(diagnostic("author.workflow_contract_unsupported", "workflow", "Expected ladder.dev/v1alpha1 Workflow."));
  }
  const nodes = Array.isArray(workflow?.spec?.nodes) ? workflow.spec.nodes : [];
  const edges = Array.isArray(workflow?.spec?.edges) ? workflow.spec.edges : [];
  validateContextSelectors(pkg, nodes, diagnostics);
  validateContextClassificationPolicies(pkg, diagnostics);
  validateIntegrations(pkg, diagnostics);
  const ids = new Set<string>();
  for (const [index, node] of nodes.entries()) {
    if (!node.id || ids.has(node.id)) diagnostics.push(diagnostic("author.node_id_invalid", `workflow.spec.nodes.${index}.id`, "Node IDs must be non-empty and unique."));
    ids.add(node.id);
    if (!nodeKinds.has(node.kind)) diagnostics.push(diagnostic("author.node_kind_unsupported", `workflow.spec.nodes.${index}.kind`, `Unsupported primitive: ${node.kind}.`));
    validatePrimitiveConfig(node, index, diagnostics);
    validateCaseWrites(node, diagnostics);
  }
  const groupMembership = new Map<string, string>();
  for (const [index, node] of nodes.entries()) {
    if (node.kind !== "group" || !Array.isArray(node.config?.members)) continue;
    for (const memberId of node.config.members) {
      if (typeof memberId !== "string") continue;
      const member = nodes.find((candidate) => candidate.id === memberId);
      if (!member) diagnostics.push(diagnostic("author.group_member_missing", `workflow.spec.nodes.${index}.config.members`, `Group references missing member ${memberId}.`));
      else if (member.kind === "group" || member.kind === "input" || member.kind === "output" || member.id === node.id) {
        diagnostics.push(diagnostic("author.group_member_kind_invalid", `workflow.spec.nodes.${index}.config.members`, `Node ${memberId} cannot be nested in a group.`));
      }
      const existing = groupMembership.get(memberId);
      if (existing && existing !== node.id) diagnostics.push(diagnostic("author.group_member_duplicate", `workflow.spec.nodes.${index}.config.members`, `Node ${memberId} already belongs to group ${existing}.`));
      groupMembership.set(memberId, node.id);
    }
  }
  for (const [index, edge] of edges.entries()) {
    if (!ids.has(edge.from) || !ids.has(edge.to)) diagnostics.push(diagnostic("author.edge_reference_missing", `workflow.spec.edges.${index}`, `Edge ${edge.id} references a missing node.`));
    if (edge.from === edge.to) diagnostics.push(diagnostic("author.edge_self_reference", `workflow.spec.edges.${index}`, "Self-referencing edges are not executable."));
  }
  // Plans dispatch node by node, so nodes may run on different runtimes.
  for (const [index, node] of nodes.entries()) {
    const target = node.config?.runtimeTarget;
    if (target === undefined) continue;
    if (!runtimeTargetSchema.safeParse(target).success) diagnostics.push(diagnostic("author.runtime_target_invalid", `workflow.spec.nodes.${index}.config.runtimeTarget`, "Runtime target must be <adapter> or <adapter>:<binding>, e.g. local_http, hosted_http or databricks:kyc-investigator."));
  }
  const order = topologicalOrder(nodes, edges);
  if (nodes.length > 0 && order.length !== nodes.length) diagnostics.push(diagnostic("author.graph_cycle", "workflow.spec.edges", "The executable graph must be acyclic."));
  if (!nodes.some((node) => node.kind === "input")) diagnostics.push(diagnostic("author.input_missing", "workflow.spec.nodes", "At least one input node is required."));
  if (!nodes.some((node) => node.kind === "output")) diagnostics.push(diagnostic("author.output_missing", "workflow.spec.nodes", "At least one output node is required."));
  const capabilities = Array.isArray(pkg?.capabilities) ? pkg.capabilities : [];
  capabilities.forEach((capability, index) => {
    const parsed = capabilityDefinitionSchema.safeParse(capability);
    if (!parsed.success) diagnostics.push(diagnostic("author.capability_invalid", `package.capabilities.${index}`, parsed.error.issues[0]?.message ?? "Invalid capability definition."));
  });
  if (object(pkg)) validateAgentProfiles(pkg, nodes, diagnostics);
  for (const [nodeId, capabilityId] of Object.entries(pkg?.bindings ?? {})) {
    if (!ids.has(nodeId)) diagnostics.push(diagnostic("author.binding_node_missing", `package.bindings.${nodeId}`, "Binding references a missing node."));
    if (![...capabilities].some((candidate) => object(candidate) && candidate.id === capabilityId)) {
      diagnostics.push(diagnostic("author.binding_capability_external", `package.bindings.${nodeId}`, `Capability ${capabilityId} must resolve from the gateway registry before compile.`, "warning"));
    }
  }
  return {
    parsedPackage: object(pkg) ? (pkg as unknown as JsonMap) : {},
    parsedWorkflow: object(workflow) ? (workflow as unknown as JsonMap) : {},
    diagnostics,
    metadata: {
      name: typeof workflow?.metadata?.title === "string" && workflow.metadata.title.trim() ? workflow.metadata.title.trim() : pkg?.metadata?.name ?? "untitled-domain",
      domain: pkg?.metadata?.domain ?? "unassigned",
      version: pkg?.metadata?.version ?? "0.1.0",
    },
  };
}

/**
 * Compile a draft into an immutable plan.
 *
 * Plan emission belongs to the plan compiler (`@ehf/compiler`, harnessc) and nowhere else.
 * This function resolves and validates the authoring surface -- which is what the editor
 * needs rich diagnostics for -- and then hands the sources to the compiler. It deliberately
 * does not build a plan itself: a second implementation drifts, and the previous one
 * stamped every plan with an `lgirCoreRevision` it had never run while silently producing a
 * different dependency manifest and package digest than the compiler of record.
 *
 * `modelProfileRegistry`, when given, is the registry the plan is compiled against (the
 * tenant's administered profiles); otherwise the registry file at `modelProfilesPath`.
 */
export async function compileAuthoringDraft(input: {
  packageSource: string;
  workflowSource: string;
  registryCapabilities: CapabilityRegistration[];
  modelProfilesPath: string;
  modelProfileRegistry?: ModelProfileRegistry;
  sourceFiles?: Record<string, string>;
}): Promise<{ plan: HarnessPlanV2 | null; diagnostics: AuthoringDiagnostic[] }> {
  const analysis = analyzeAuthoringSources(input.packageSource, input.workflowSource);
  const pkg = analysis.parsedPackage as unknown as PackageSource;
  const diagnostics = [...analysis.diagnostics];
  const embedded = (pkg.capabilities ?? []).flatMap((capability) => {
    const parsed = capabilityDefinitionSchema.safeParse(capability);
    return parsed.success ? [parsed.data] : [];
  });
  const registry = input.registryCapabilities.map(({ description: _description, owner: _owner, dataClasses: _classes, status: _status, ...capability }) => capability);
  const capabilityMap = new Map<string, CapabilityDefinition>([...registry, ...embedded].map((capability) => [capability.id, capability]));
  const agentProfiles = (pkg.agentProfiles ?? []).flatMap((profile) => {
    const parsed = packageAgentProfileSchema.safeParse(profile);
    return parsed.success ? [parsed.data] : [];
  });
  const bindings = pkg.bindings ?? {};
  for (const [nodeId, capabilityId] of Object.entries(bindings)) {
    if (!capabilityMap.has(capabilityId)) diagnostics.push(diagnostic("compiler.capability_unresolved", `package.bindings.${nodeId}`, `Capability ${capabilityId} is neither embedded nor registered in the gateway.`));
    else if (!embedded.some((capability) => capability.id === capabilityId)) {
      diagnostics.push(diagnostic("compiler.capability_not_embedded", `package.bindings.${nodeId}`, `Capability ${capabilityId} must be materialized into the package before compilation.`));
    }
  }
  agentProfiles.forEach((profile, index) => {
    const declared = [...profile.instructions.flatMap((instruction) => instruction.allowedCapabilityIds), ...(profile.primaryCapabilityId ? [profile.primaryCapabilityId] : [])];
    for (const capabilityId of new Set(declared)) {
      if (!capabilityMap.has(capabilityId)) diagnostics.push(diagnostic("compiler.agent_profile_capability_unresolved", `package.agentProfiles.${index}`, `Agent profile ${profile.id} references unresolved capability ${capabilityId}.`));
    }
  });

  const modelProfileRegistry = input.modelProfileRegistry
    ?? JSON.parse(await readFile(input.modelProfilesPath, "utf8")) as ModelProfileRegistry;
  for (const id of pkg.modelProfiles ?? []) {
    if (!modelProfileRegistry.profiles.some((candidate) => (candidate as JsonMap | null)?.id === id)) {
      diagnostics.push(diagnostic("compiler.model_profile_missing", `package.modelProfiles.${id}`, `Model profile ${id} is not configured.`));
    }
  }
  if (diagnostics.some((item) => item.severity === "error")) return { plan: null, diagnostics };

  try {
    const plan = await compileWithHarnessc({
      packageSource: input.packageSource,
      workflowSource: input.workflowSource,
      ...(input.sourceFiles ? { sourceFiles: input.sourceFiles } : {}),
      workflowFileName: pkg.workflow || "workflow.yaml",
      modelProfiles: modelProfileRegistry,
    });
    diagnostics.push(diagnostic(
      "compiler.plan_emitted",
      "plan",
      `Immutable plan ${plan.planDigest.slice(0, 12)} emitted by ${plan.compiler.name} ${plan.compiler.version} (LGIR ${plan.compiler.lgirCoreRevision.slice(0, 8)}).`,
      "info",
    ));
    return { plan, diagnostics };
  } catch (error) {
    if (error instanceof HarnessCompilerError) {
      diagnostics.push(diagnostic(error.message, "plan", error.detail));
      return { plan: null, diagnostics };
    }
    throw error;
  }
}

/**
 * Every node that names an agent profile resolves to it at the pinned version,
 * and the node stays inside the profile: its bound capability and loop tools are allowed
 * capabilities, its business skill is an allowed skill, its context purposes are allowed
 * purposes and its loop is within the profile's limits.
 */
function agentProfilesCheck(plan: HarnessPlanV2) {
  const profiles = new Map(plan.agentProfiles.map((profile) => [profile.id, profile]));
  const selectors = new Map(plan.contextSelectors.map((selector) => [selector.id, selector.purpose]));
  const bound = plan.graph.nodes.filter((node) => node.config.agentRef !== undefined);
  const failures = bound.flatMap((node) => {
    const profile = typeof node.config.agentRef === "string" ? profiles.get(node.config.agentRef) : undefined;
    if (!profile) return [`${node.id}: agent profile ${String(node.config.agentRef)} is not embedded`];
    const problems: string[] = [];
    if (node.config.agentVersion !== undefined && node.config.agentVersion !== profile.version) problems.push(`${node.id}: pins version ${String(node.config.agentVersion)}`);
    if (node.config.skillRefs !== undefined) problems.push(`${node.id}: declares retired skillRefs`);
    const allowed = new Set(profile.allowedCapabilities);
    const loop = node.config.loop as { tools?: unknown; maxSteps?: unknown; maxObservationChars?: unknown } | undefined;
    const tools = Array.isArray(loop?.tools) ? loop.tools : [];
    for (const capabilityId of [node.config.capabilityId, ...tools]) {
      if (typeof capabilityId === "string" && !allowed.has(capabilityId)) problems.push(`${node.id}: ${capabilityId} is not allowed`);
    }
    if (typeof node.config.skillId === "string") {
      const binding = (plan.skillBindings ?? []).find((item) => item.skillId === node.config.skillId);
      if (!profile.allowedSkills.some((skill) => skill.skillId === node.config.skillId && skill.semver === binding?.semver)) problems.push(`${node.id}: skill ${node.config.skillId} is not allowed`);
    }
    for (const id of node.contextSelectorIds) {
      const purpose = selectors.get(id);
      if (purpose && !profile.purposes.includes(purpose)) problems.push(`${node.id}: purpose ${purpose} is not allowed`);
    }
    if (typeof loop?.maxSteps === "number" && loop.maxSteps > profile.limits.maxSteps) problems.push(`${node.id}: maxSteps exceeds the profile`);
    if (typeof loop?.maxObservationChars === "number" && loop.maxObservationChars > profile.limits.maxObservationChars) problems.push(`${node.id}: maxObservationChars exceeds the profile`);
    return problems;
  });
  const agentNodes = plan.graph.nodes.filter((node) => node.kind === "agent" || node.kind === "evaluate");
  return {
    id: "agent-profiles.embedded",
    label: "Embedded agent profiles",
    passed: failures.length === 0,
    detail: failures.length
      ? failures.slice(0, 5).join("; ")
      : `${bound.length} of ${agentNodes.length} agent nodes run as one of ${plan.agentProfiles.length} embedded agent profiles, within their allowed capabilities, skills, purposes and limits.`,
  };
}

export function evaluateCompiledPlan(plan: HarnessPlanV2): EvaluationReport {
  const boundNodes = plan.graph.nodes.filter((node) => typeof node.config.capabilityId === "string");
  const capabilityIds = new Set(plan.capabilities.map((capability) => capability.id));
  const permissionsByNode = new Map(plan.permissionEnvelopes.map((permission) => [permission.nodeId, permission]));
  const capabilityAuthorityValid = boundNodes.every((node) => {
    const capabilityId = String(node.config.capabilityId);
    const permission = permissionsByNode.get(node.id);
    if (!capabilityIds.has(capabilityId) || !permission) return false;
    const capability = plan.capabilities.find((candidate) => candidate.id === capabilityId);
    if (!capability || !permission.capabilities.includes(capabilityId) || !permission.effects.includes(capability.effect)) return false;
    return permission.digest === stableDigest({ nodeId: node.id, capabilities: permission.capabilities, effects: permission.effects });
  }) && plan.permissionEnvelopes.every((permission) => {
    if (boundNodes.some((node) => node.id === permission.nodeId)) return true;
    // Intrinsic nodes carry read/write authority without calling a capability.
    return plan.graph.nodes.some((node) => node.id === permission.nodeId)
      && permission.capabilities.length === 0 && permission.effects.length === 0
      && permission.digest === stableDigest({ nodeId: permission.nodeId, capabilities: [], effects: [] });
  });
  const caseWrites = plan.graph.nodes.flatMap((node) => {
    const writes = Array.isArray(node.config.caseWrites) ? node.config.caseWrites : [];
    return writes.map((write) => ({ node, write }));
  });
  const caseWriteSchemasValid = caseWrites.every(({ write }) => caseWriteEntrySchema.safeParse(write).success);
  const agentAuthorityValid = caseWrites.every(({ node, write }) => {
    if (node.kind !== "agent" && node.kind !== "evaluate") return true;
    if (!write || typeof write !== "object" || Array.isArray(write)) return false;
    const commandType = String((write as Record<string, unknown>).commandType ?? "");
    return commandType !== "FinalizeDisposition" && commandType !== "RecordGateResult";
  });
  const checks = [
    { id: "graph.connected", label: "Executable topology", passed: plan.graph.nodeOrder.length === plan.graph.nodes.length, detail: `${plan.graph.nodes.length} nodes ordered without a cycle.` },
    { id: "authority.bound", label: "Capability authority", passed: capabilityAuthorityValid, detail: `${plan.permissionEnvelopes.length} node permission envelopes match compiled capability effects and canonical digests.` },
    agentProfilesCheck(plan),
    { id: "case-writes.schema", label: "Case-write contracts", passed: caseWriteSchemasValid, detail: `${caseWrites.length} case-write contracts were parsed against the canonical schema.` },
    { id: "case-writes.authority", label: "Case-write authority", passed: agentAuthorityValid, detail: agentAuthorityValid ? "Agent nodes cannot record gate authority or finalize a disposition." : "An agent node declares a gate-only or human-only command." },
    { id: "budgets.bounded", label: "Execution budgets", passed: plan.budgets.maxDurationMs > 0 && plan.budgets.maxCapabilityCalls >= plan.capabilities.length, detail: `Duration ${plan.budgets.maxDurationMs}ms; ${plan.budgets.maxCapabilityCalls} capability calls.` },
    { id: "runtime.compatible", label: "Runtime profile", passed: plan.execution.engine.adapterVersion === "harness-runtime-v2" && plan.execution.engine.kind === "harness-runtime", detail: plan.execution.engine.adapterVersion },
  ];
  return { passed: checks.every((check) => check.passed), evaluatedAt: new Date().toISOString(), planDigest: plan.planDigest, checks };
}

/**
 * The starting package and workflow a new draft is seeded with.
 *
 * `budgets` used to be a literal here, which meant an installation could not change what
 * a new harness is allowed to spend without a code change. It now takes the administered
 * value, and falls back to the same literal when none is supplied so the authoring tests
 * and the offline path keep their fixed starting point.
 */
export function defaultAuthoringSources(budgets?: {
  maxDurationMs: number; maxCostUsd: number; maxModelCalls: number; maxCapabilityCalls: number;
}) {
  const workflow = {
    apiVersion: "ladder.dev/v1alpha1",
    kind: "Workflow",
    metadata: { name: "new-process", title: "New process", description: "Author a governed process.", version: "0.1.0" },
    spec: {
      objective: "Produce a governed domain outcome.",
      inputs: { type: "object", properties: {} }, outputs: { type: "object" },
      policies: { maxConcurrency: 2, onFailure: "stop", requireApprovalFor: [] },
      nodes: [
        { id: "intake", kind: "input", name: "Domain intake", config: { caseWrites: [] } },
        { id: "result", kind: "output", name: "Domain outcome", config: { caseWrites: [] } },
      ],
      edges: [{ id: "e1", from: "intake", to: "result", kind: "data" }],
    },
  };
  const pkg = {
    apiVersion: PACKAGE_API_VERSION, kind: "DomainPackage",
    metadata: {
      name: "new-process", version: "0.1.0", domain: "new_domain", objective: "Produce a governed domain outcome.",
      owners: ["unassigned"], riskClass: "low",
    },
    workflow: "workflow.yaml",
    coordinationMode: "caseStore",
    budgets: budgets ?? { maxDurationMs: 120000, maxCostUsd: 0.25, maxModelCalls: 2, maxCapabilityCalls: 4 },
    modelProfiles: ["model.standard.v1"], agentProfiles: [], capabilities: [], bindings: {},
    allowedRegions: ["US"],
  };
  return { packageSource: stringify(pkg, { lineWidth: 110 }), workflowSource: stringify(workflow, { lineWidth: 110 }) };
}
