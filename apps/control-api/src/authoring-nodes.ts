import { parse, stringify } from "yaml";
import { z } from "zod";
import type { BusinessGateTemplate } from "./authoring-gates.js";

type JsonMap = Record<string, unknown>;

function object(value: unknown): value is JsonMap {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function identifier(value: unknown, code: string): string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9-]*$/.test(value))
    throw new Error(code);
  return value;
}

function uniqueEdgeId(edges: JsonMap[], base: string): string {
  const ids = new Set(
    edges
      .map((edge) => edge.id)
      .filter((id): id is string => typeof id === "string"),
  );
  if (!ids.has(base)) return base;
  let suffix = 2;
  while (ids.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

export type OrchestrationNodeInput =
  | {
      kind: "group";
      id: string;
      name: string;
      memberIds: string[];
      execution: "sequential" | "parallel";
      exit: "serialize" | "aggregate";
    }
  | {
      kind: "subgraph";
      id: string;
      name: string;
      insertAfter: string;
      ref: string;
      inputMap: Record<string, string>;
      outputMap: Record<string, string>;
      checkpointer: "inherit" | "perInvocation" | "perThread" | "stateless";
    };

const positionSchema = z.object({ x: z.number(), y: z.number() }).strict();
const gateSchema = z
  .object({
    policyRef: z.string().trim().min(1).max(200),
    gateId: z.string().trim().min(1).max(200),
  })
  .strict();
const nodeInputSchema = z
  .object({
    id: z.string(),
    kind: z.enum([
      "agent",
      "gate",
      "transform",
      "condition",
      "join",
      "aggregator",
      "approval",
      "fanout",
    ]),
    name: z.string(),
    description: z.string().max(2000).optional(),
    position: positionSchema.optional(),
    agentId: z.string().trim().min(1).optional(),
    gate: gateSchema.optional(),
  })
  .strict()
  .superRefine((node, ctx) => {
    if ((node.kind === "agent") !== Boolean(node.agentId))
      ctx.addIssue({
        code: "custom",
        path: ["agentId"],
        message: "An agent step requires a registered agent.",
      });
    if ((node.kind === "gate") !== Boolean(node.gate))
      ctx.addIssue({
        code: "custom",
        path: ["gate"],
        message: "A policy gate requires a policy reference and gate ID.",
      });
  });

/** Shared runtime validation for every graph request; unknown operations never fall through. */
export const authoringGraphMutationSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("rename-process"),
      name: z.string().trim().min(1).max(200),
    })
    .strict(),
  z
    .object({
      type: z.literal("connect"),
      from: z.string(),
      to: z.string(),
      kind: z.enum(["data", "control"]).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("delete"),
      nodeIds: z.array(z.string()).optional(),
      edgeIds: z.array(z.string()).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("move"),
      nodeId: z.string(),
      position: positionSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("layout"),
      positions: z
        .array(
          z.object({ nodeId: z.string(), position: positionSchema }).strict(),
        )
        .min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal("add"),
      node: nodeInputSchema,
      insertAfter: z.string().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("insert-on-edge"),
      edgeId: z.string(),
      node: nodeInputSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("update-node"),
      nodeId: z.string(),
      name: z.string(),
      description: z.string().max(2000),
      gate: gateSchema.optional(),
      agentId: z.string().trim().min(1).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("update-contract"),
      nodeId: z.string(),
      inputSchema: z.record(z.string(), z.unknown()),
      outputSchema: z.record(z.string(), z.unknown()),
      contextSelectorIds: z.array(z.string()),
      caseWrites: z.array(z.unknown()).optional(),
    })
    .strict(),
]);
export type AuthoringGraphMutation = z.infer<
  typeof authoringGraphMutationSchema
>;

function workflowParts(workflowSource: string): {
  workflow: JsonMap & { spec: JsonMap };
  nodes: JsonMap[];
  edges: JsonMap[];
} {
  const workflow = parse(workflowSource) as JsonMap;
  if (!object(workflow) || !object(workflow.spec))
    throw new Error("authoring.graph_source_invalid");
  const nodes = Array.isArray(workflow.spec.nodes)
    ? (workflow.spec.nodes as JsonMap[])
    : [];
  const edges = Array.isArray(workflow.spec.edges)
    ? (workflow.spec.edges as JsonMap[])
    : [];
  return { workflow: workflow as JsonMap & { spec: JsonMap }, nodes, edges };
}

/** Apply a single canvas edit to canonical workflow YAML. */
export function mutateAuthoringGraph(
  workflowSource: string,
  mutation: AuthoringGraphMutation,
  /** For a business-policy gate: the full gate configuration and where its non-continuing outcomes go. */
  options: { gateTemplate?: (workflow: { nodes: JsonMap[]; edges: JsonMap[] }) => BusinessGateTemplate | null } = {},
): {
  workflowSource: string;
  nodeId?: string;
} {
  const validated = authoringGraphMutationSchema.safeParse(mutation);
  if (!validated.success) throw new Error("authoring.graph_mutation_invalid");
  mutation = validated.data;
  const { workflow, nodes, edges } = workflowParts(workflowSource);
  const template = options.gateTemplate?.({ nodes, edges }) ?? null;
  if (mutation.type === "rename-process") {
    const metadata = object(workflow.metadata) ? workflow.metadata : {};
    workflow.metadata = { ...metadata, title: mutation.name };
  } else if (mutation.type === "connect") {
    const from = identifier(mutation.from, "authoring.edge_from_invalid");
    const to = identifier(mutation.to, "authoring.edge_to_invalid");
    if (
      from === to ||
      !nodes.some((node) => node.id === from) ||
      !nodes.some((node) => node.id === to)
    ) {
      throw new Error("authoring.edge_endpoint_invalid");
    }
    if (!edges.some((edge) => edge.from === from && edge.to === to)) {
      edges.push({
        id: uniqueEdgeId(edges, `edge-${from}-${to}`),
        from,
        to,
        kind: mutation.kind ?? "data",
      });
    }
  } else if (mutation.type === "delete") {
    const requestedNodes = new Set(
      (mutation.nodeIds ?? []).map((id) =>
        identifier(id, "authoring.delete_node_invalid"),
      ),
    );
    for (const node of nodes) {
      if (
        requestedNodes.has(String(node.id)) &&
        (node.kind === "input" || node.kind === "output")
      ) {
        throw new Error("authoring.delete_boundary_node_forbidden");
      }
    }
    const requestedEdges = new Set(mutation.edgeIds ?? []);
    workflow.spec.nodes = nodes.filter(
      (node) => !requestedNodes.has(String(node.id)),
    );
    workflow.spec.edges = edges.filter(
      (edge) =>
        !requestedEdges.has(String(edge.id)) &&
        !requestedNodes.has(String(edge.from)) &&
        !requestedNodes.has(String(edge.to)),
    );
    for (const node of workflow.spec.nodes as JsonMap[]) {
      if (
        node.kind !== "group" ||
        !object(node.config) ||
        !Array.isArray(node.config.members)
      )
        continue;
      node.config.members = node.config.members.filter(
        (id) => typeof id === "string" && !requestedNodes.has(id),
      );
    }
  } else if (mutation.type === "move" || mutation.type === "layout") {
    const positions =
      mutation.type === "move"
        ? [{ nodeId: mutation.nodeId, position: mutation.position }]
        : mutation.positions;
    for (const entry of positions) {
      const nodeId = identifier(entry.nodeId, "authoring.move_node_invalid");
      const node = nodes.find((candidate) => candidate.id === nodeId);
      if (!node) throw new Error("authoring.node_not_found");
      const config = object(node.config) ? node.config : {};
      const ui = object(config.ui) ? config.ui : {};
      node.config = { ...config, ui: { ...ui, position: entry.position } };
    }
  } else if (mutation.type === "update-node") {
    if (mutation.agentId) throw new Error("authoring.agent_registry_required");
    const nodeId = identifier(mutation.nodeId, "authoring.node_id_invalid");
    const node = nodes.find((candidate) => candidate.id === nodeId);
    if (!node) throw new Error("authoring.node_not_found");
    if (!mutation.name.trim()) throw new Error("authoring.node_name_required");
    node.name = mutation.name.trim();
    const config = object(node.config) ? node.config : {};
    if (mutation.gate && node.kind !== "gate")
      throw new Error("authoring.gate_node_required");
    const ui = object(config.ui) ? config.ui : {};
    node.config = {
      ...config,
      ...(mutation.gate ?? {}),
      ...(mutation.gate && template ? template.config : {}),
      ui: { ...ui, description: mutation.description.trim() },
    };
    if (mutation.gate && template) node.contextSelectorIds = template.contextSelectorIds;
  } else if (mutation.type === "add" || mutation.type === "insert-on-edge") {
    if (mutation.node.kind === "agent")
      throw new Error("authoring.agent_registry_required");
    const id = identifier(mutation.node.id, "authoring.node_id_invalid");
    if (nodes.some((node) => node.id === id))
      throw new Error("authoring.node_duplicate");
    const name = mutation.node.name.trim();
    if (!name) throw new Error("authoring.node_name_required");
    const configs: Record<string, JsonMap> = {
      transform: { operation: "select" },
      condition: { expression: "true" },
      join: {},
      aggregator: {},
      approval: {},
      gate: { ...mutation.node.gate, ...(template?.config ?? {}) },
      fanout: {
        itemsPath: "/items",
        bodyRef: "capability:replace-me",
        maxItems: 100,
        maxConcurrency: 5,
        joinMode: "all",
      },
    };
    const ui = {
      ...(mutation.node.position ? { position: mutation.node.position } : {}),
      ...(mutation.node.description !== undefined
        ? { description: mutation.node.description.trim() }
        : {}),
    };
    nodes.push({
      id,
      kind: mutation.node.kind,
      name,
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      contextSelectorIds: mutation.node.kind === "gate" && template ? template.contextSelectorIds : [],
      config: {
        ...configs[mutation.node.kind],
        ...(Object.keys(ui).length ? { ui } : {}),
      },
    });
    if (mutation.type === "insert-on-edge") {
      const edge = edges.find((candidate) => candidate.id === mutation.edgeId);
      if (!edge) throw new Error("authoring.edge_not_found");
      if (
        !nodes.some((node) => node.id === edge.from) ||
        !nodes.some((node) => node.id === edge.to)
      )
        throw new Error("authoring.edge_endpoint_invalid");
      // Keep the branch predicate and metadata on the incoming edge, exactly once.
      const target = edge.to;
      edge.to = id;
      edges.push({
        id: uniqueEdgeId(edges, `edge-${id}-${target}`),
        from: id,
        to: target,
        kind: edge.kind ?? "data",
        // A business gate continues only on a decision; its other outcomes stop where the process's gates do.
        ...(mutation.node.kind === "gate" && template ? { outcome: "DECIDED" } : {}),
      });
      if (mutation.node.kind === "gate" && template?.stops)
        for (const outcome of template.stops.outcomes)
          edges.push({ id: uniqueEdgeId(edges, `edge-${id}-${outcome.toLowerCase()}`), from: id, to: template.stops.target, kind: "data", outcome });
    } else if (mutation.insertAfter) {
      const insertAfter = identifier(
        mutation.insertAfter,
        "authoring.insert_after_invalid",
      );
      if (!nodes.some((node) => node.id === insertAfter))
        throw new Error("authoring.insert_after_invalid");
      for (const edge of edges) if (edge.from === insertAfter) edge.from = id;
      edges.push({
        id: uniqueEdgeId(edges, `edge-${insertAfter}-${id}`),
        from: insertAfter,
        to: id,
        kind: "data",
      });
    }
    workflow.spec.nodes = nodes;
    workflow.spec.edges = edges;
    return {
      workflowSource: stringify(workflow, { lineWidth: 120 }),
      nodeId: id,
    };
  } else {
    const nodeId = identifier(
      mutation.nodeId,
      "authoring.contract_node_invalid",
    );
    const node = nodes.find((candidate) => candidate.id === nodeId);
    if (!node) throw new Error("authoring.node_not_found");
    if (!object(mutation.inputSchema) || !object(mutation.outputSchema))
      throw new Error("authoring.contract_schema_invalid");
    node.inputSchema = mutation.inputSchema;
    node.outputSchema = mutation.outputSchema;
    node.contextSelectorIds = [
      ...new Set(
        mutation.contextSelectorIds.map((id) =>
          identifier(id, "authoring.context_selector_invalid"),
        ),
      ),
    ];
    const config = object(node.config) ? node.config : {};
    node.config = {
      ...config,
      ...(mutation.caseWrites ? { caseWrites: mutation.caseWrites } : {}),
    };
  }

  workflow.spec.nodes = workflow.spec.nodes ?? nodes;
  workflow.spec.edges = workflow.spec.edges ?? edges;
  return { workflowSource: stringify(workflow, { lineWidth: 120 }) };
}

/**
 * Add a native Ladder group or subgraph while preserving a valid graph boundary.
 * Groups wrap existing members by routing external edges through the group. Subgraphs
 * are inserted after an existing node and inherit its former outgoing edges.
 */
export function addOrchestrationNode(
  workflowSource: string,
  raw: OrchestrationNodeInput,
): {
  workflowSource: string;
  nodeId: string;
} {
  const workflow = parse(workflowSource) as JsonMap;
  if (!object(workflow) || !object(workflow.spec))
    throw new Error("authoring.orchestration_source_invalid");
  const nodes = Array.isArray(workflow.spec.nodes)
    ? (workflow.spec.nodes as JsonMap[])
    : [];
  const edges = Array.isArray(workflow.spec.edges)
    ? (workflow.spec.edges as JsonMap[])
    : [];
  const id = identifier(raw.id, "authoring.orchestration_node_id_invalid");
  const name = raw.name.trim();
  if (!name) throw new Error("authoring.orchestration_node_name_required");
  if (nodes.some((node) => node.id === id))
    throw new Error("authoring.orchestration_node_duplicate");

  if (raw.kind === "group") {
    const memberIds = [
      ...new Set(
        raw.memberIds.map((memberId) =>
          identifier(memberId, "authoring.group_member_invalid"),
        ),
      ),
    ];
    if (!memberIds.length) throw new Error("authoring.group_members_required");
    const memberSet = new Set(memberIds);
    for (const memberId of memberIds) {
      const member = nodes.find((node) => node.id === memberId);
      if (!member)
        throw new Error(`authoring.group_member_missing:${memberId}`);
      if (
        member.kind === "group" ||
        member.kind === "input" ||
        member.kind === "output"
      ) {
        throw new Error(`authoring.group_member_kind_invalid:${memberId}`);
      }
    }
    for (const node of nodes) {
      if (
        node.kind !== "group" ||
        !object(node.config) ||
        !Array.isArray(node.config.members)
      )
        continue;
      const overlap = node.config.members.find(
        (memberId) => typeof memberId === "string" && memberSet.has(memberId),
      );
      if (overlap)
        throw new Error(`authoring.group_member_already_grouped:${overlap}`);
    }
    nodes.push({
      id,
      kind: "group",
      name,
      config: { members: memberIds, execution: raw.execution, exit: raw.exit },
    });
    for (const edge of edges) {
      const fromMember =
        typeof edge.from === "string" && memberSet.has(edge.from);
      const toMember = typeof edge.to === "string" && memberSet.has(edge.to);
      if (!fromMember && toMember) edge.to = id;
      if (fromMember && !toMember) edge.from = id;
    }
  } else {
    const insertAfter = identifier(
      raw.insertAfter,
      "authoring.subgraph_insert_after_invalid",
    );
    const selected = nodes.find((node) => node.id === insertAfter);
    if (!selected || selected.kind === "output")
      throw new Error("authoring.subgraph_insert_after_invalid");
    if (!/^(?:ladder:\/\/|host:).+/.test(raw.ref))
      throw new Error("authoring.subgraph_ref_invalid");
    const validMap = (value: Record<string, string>) =>
      Object.keys(value).length > 0 &&
      Object.entries(value).every(
        ([key, path]) =>
          key.trim().length > 0 && /^\/(?:[^/]+(?:\/[^/]+)*)?$/.test(path),
      );
    if (!validMap(raw.inputMap) || !validMap(raw.outputMap))
      throw new Error("authoring.subgraph_state_map_invalid");
    nodes.push({
      id,
      kind: "subgraph",
      name,
      config: {
        subgraph: {
          ref: raw.ref,
          inputMap: raw.inputMap,
          outputMap: raw.outputMap,
          checkpointer: raw.checkpointer,
        },
      },
    });
    for (const edge of edges) {
      if (edge.from === insertAfter) edge.from = id;
    }
    edges.push({
      id: uniqueEdgeId(edges, `edge-${insertAfter}-${id}`),
      from: insertAfter,
      to: id,
      kind: "data",
    });
  }

  workflow.spec.nodes = nodes;
  workflow.spec.edges = edges;
  return {
    workflowSource: stringify(workflow, { lineWidth: 120 }),
    nodeId: id,
  };
}
