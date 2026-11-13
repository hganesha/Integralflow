import { isRec, nodeDisplayKind, type GraphNode, type WorkflowEdge } from "./model";
import { isScopeGate } from "./scope-model";

export type CanvasGroup = {
  id: string;
  kind: "agent" | "process";
  execution: "sequence" | "parallel";
  label: string;
  members: GraphNode[];
  skills: number;
};
export type GroupedEdge = WorkflowEdge & { originalEdgeIds: string[] };
export type GroupedWorkflow = {
  nodes: GraphNode[];
  edges: GroupedEdge[];
  groups: Map<string, CanvasGroup>;
  representative: Map<string, string>;
};
const owner = (node: GraphNode) => {
  const config = isRec(node.raw.config) ? node.raw.config : {};
  return typeof config.agentRef === "string" ? config.agentRef : typeof node.raw.agentRef === "string" ? node.raw.agentRef : "";
};
const sequential = (edge: WorkflowEdge) => /^(data|control)$/.test(edge.label);
const skill = (node: GraphNode) => nodeDisplayKind(node.raw) === "skill";
const deterministic = (node: GraphNode) => ["skill", "capability", "transform"].includes(nodeDisplayKind(node.raw));

/** A view projection only. Contract IDs, execution edges and authored positions stay untouched. */
export function groupWorkflow(nodes: GraphNode[], edges: WorkflowEdge[]): GroupedWorkflow {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const incoming = new Map(nodes.map(node => [node.id, [] as WorkflowEdge[]]));
  const outgoing = new Map(nodes.map(node => [node.id, [] as WorkflowEdge[]]));
  for (const edge of edges) {
    incoming.get(edge.to)?.push(edge);
    outgoing.get(edge.from)?.push(edge);
  }
  const groups = new Map<string, CanvasGroup>();
  const representative = new Map(nodes.map(node => [node.id, node.id]));
  const claimed = new Set<string>();
  const add = (members: GraphNode[], kind: CanvasGroup["kind"], execution: CanvasGroup["execution"] = "sequence", label?: string) => {
    const last = members.at(-1)!;
    groups.set(last.id, { id: last.id, kind, execution, members, skills: members.filter(skill).length,
      label: label ?? (kind === "agent" ? last.label.replace(/\s*\(review\)\s*$/i, "") : members.length === 1 ? last.label : "Standalone skill process") });
    for (const node of members) { claimed.add(node.id); representative.set(node.id, last.id); }
  };
  // Only contract a linear chain into its actual review. Reused agent profiles,
  // intervening gates, joins, branching skills and external dependencies stay distinct.
  for (const review of nodes.filter(node => nodeDisplayKind(node.raw) === "agent")) {
    const members = [review];
    let current = review;
    while (incoming.get(current.id)?.length === 1 && sequential(incoming.get(current.id)![0]!)) {
      const previous = byId.get(incoming.get(current.id)![0]!.from);
      if (!previous || claimed.has(previous.id) || members.includes(previous) || !skill(previous) || !owner(review) || owner(previous) !== owner(review) || outgoing.get(previous.id)?.length !== 1) break;
      members.unshift(previous);
      current = previous;
    }
    const loopsBack = outgoing.get(review.id)?.some(edge => members.some(member => member.id === edge.to));
    add(loopsBack ? [review] : members, "agent");
  }
  // Fold a closed parallel acquisition region into one deterministic process.
  // All calls must share the same entry condition and converge at this exact join.
  for (const join of nodes.filter(node => node.kind === "join" && !claimed.has(node.id))) {
    const branches = incoming.get(join.id) ?? [];
    if (branches.length < 2 || branches.some(edge => !sequential(edge))) continue;
    const calls = branches.map(edge => byId.get(edge.from));
    if (calls.some(call => !call || claimed.has(call.id) || !deterministic(call) || incoming.get(call.id)?.length !== 1 || outgoing.get(call.id)?.length !== 1)) continue;
    const entries = calls.map(call => incoming.get(call!.id)![0]!);
    if (new Set(entries.map(edge => JSON.stringify([edge.from, edge.label]))).size !== 1) continue;
    const members = nodes.filter(node => calls.some(call => call!.id === node.id));
    if (entries.some(edge => members.some(member => member.id === edge.from)) || outgoing.get(join.id)?.some(edge => members.some(member => member.id === edge.to))) continue;
    add([...members, join], "process", "parallel", join.label.replace(/acquisition barrier/i, "evidence acquisition"));
  }
  // Standalone deterministic chains can also be folded without inventing an agent.
  const remaining = nodes.filter(node => deterministic(node) && !claimed.has(node.id));
  const starts = remaining.filter(node => !incoming.get(node.id)?.some(edge => {
    const previous = byId.get(edge.from);
    return sequential(edge) && incoming.get(node.id)?.length === 1 && previous && deterministic(previous) && !claimed.has(previous.id) && owner(previous) === owner(node) && outgoing.get(previous.id)?.length === 1;
  }));
  for (const start of starts) {
    const members = [start];
    let current = start;
    while (outgoing.get(current.id)?.length === 1 && sequential(outgoing.get(current.id)![0]!)) {
      const next = byId.get(outgoing.get(current.id)![0]!.to);
      if (!next || claimed.has(next.id) || members.includes(next) || !deterministic(next) || owner(next) !== owner(start) || incoming.get(next.id)?.length !== 1) break;
      members.push(next); current = next;
    }
    if (members.length > 1) add(members, "process");
  }
  // Every remaining standalone capability, skill or policy check is a process step,
  // never a separate "tool" concept in the overview. Singletons retain their boundary.
  for (const node of nodes) if (!claimed.has(node.id) && !["input", "output", "agent", "model", "approval"].includes(nodeDisplayKind(node.raw))) add([node], "process");
  const projected: GroupedEdge[] = [];
  const pairs = new Map<string, GroupedEdge>();
  for (const edge of edges) {
    const from = representative.get(edge.from) ?? edge.from;
    const to = representative.get(edge.to) ?? edge.to;
    if (from === to) continue;
    const key = JSON.stringify([from, to]);
    const existing = pairs.get(key);
    if (existing) {
      existing.originalEdgeIds.push(edge.id);
      const labels = new Set([...existing.label.split(" · "), edge.label]);
      existing.label = [...labels].join(" · ");
    } else {
      const projectedEdge = { ...edge, from, to, originalEdgeIds: [edge.id] };
      pairs.set(key, projectedEdge); projected.push(projectedEdge);
    }
  }
  // Emit a group at its first member's position in the outline.
  const visible: GraphNode[] = [];
  const emitted = new Set<string>();
  for (const node of nodes) {
    const id = representative.get(node.id)!;
    if (emitted.has(id)) continue;
    emitted.add(id); visible.push(byId.get(id)!);
  }
  return { nodes: visible, edges: projected, groups, representative };
}

export const GROUP_WIDTH = 320;
/** A policy gate that pins the process scope shows its scope chips under the title. */
export const SCOPE_STRIP_HEIGHT = 72;
export const isScopeGroup = (group: CanvasGroup) => group.members.length === 1 && isScopeGate(group.members[0]!.raw);
export function groupHeight(group: CanvasGroup, expanded: boolean): number {
  return (expanded ? 106 + group.members.length * 64 : 108) + (isScopeGroup(group) ? SCOPE_STRIP_HEIGHT : 0);
}

/** Top-to-bottom overview with enough room for expanded skill stacks at each rank. */
export function overviewLayout(graph: GroupedWorkflow, expanded: ReadonlySet<string>) {
  const incoming = new Map(graph.nodes.map(node => [node.id, 0]));
  const rank = new Map(graph.nodes.map(node => [node.id, 0]));
  for (const edge of graph.edges) if (incoming.has(edge.from) && incoming.has(edge.to)) incoming.set(edge.to, incoming.get(edge.to)! + 1);
  const queue = graph.nodes.filter(node => incoming.get(node.id) === 0).map(node => node.id);
  for (const id of queue) for (const edge of graph.edges.filter(edge => edge.from === id)) {
    if (!incoming.has(edge.to)) continue;
    rank.set(edge.to, Math.max(rank.get(edge.to)!, rank.get(id)! + 1));
    incoming.set(edge.to, incoming.get(edge.to)! - 1);
    if (incoming.get(edge.to) === 0) queue.push(edge.to);
  }
  const heights = new Map<number, number>();
  for (const node of graph.nodes) {
    const group = graph.groups.get(node.id);
    const height = group ? groupHeight(group, expanded.has(group.id)) : 108;
    const row = rank.get(node.id)!;
    heights.set(row, Math.max(heights.get(row) ?? 0, height));
  }
  const top = new Map<number, number>();
  let y = 36;
  for (const row of [...heights.keys()].sort((a, b) => a - b)) {
    top.set(row, y); y += heights.get(row)! + 64;
  }
  const columns = new Map<number, number>();
  return new Map(graph.nodes.map(node => {
    const row = rank.get(node.id)!;
    const column = columns.get(row) ?? 0;
    columns.set(row, column + 1);
    return [node.id, { x: 48 + column * (GROUP_WIDTH + 56), y: top.get(row)! }];
  }));
}
