import type { Schemas } from "@ehf/ui-contracts";

/**
 * What the ownership canvas derives from the ownership projection: which parts a filter
 * keeps, the paths from a party to the customer, and the arithmetic along one path. Pure.
 * A calculation is shown only where plain multiplication is valid; otherwise it says why not.
 */
export type Ownership = Schemas["OwnershipView"];
type Node = Ownership["nodes"][number];
type Edge = Ownership["edges"][number];

export type OwnershipFilter = "all" | "conflict" | "unresolved" | "unverified";
export const FILTERS: ReadonlyArray<{ value: OwnershipFilter; label: string }> = [
  { value: "all", label: "Everything" },
  { value: "conflict", label: "Conflicts" },
  { value: "unresolved", label: "Unresolved" },
  { value: "unverified", label: "Unverified" },
];
export const asFilter = (value: string | undefined): OwnershipFilter => (FILTERS.some((entry) => entry.value === value) ? (value as OwnershipFilter) : "all");

/** The edges along a list of node ids (owner first), where the projection has them. */
export function edgesAlong(view: Ownership, path: readonly string[]): Edge[] {
  const edges: Edge[] = [];
  for (let index = 0; index < path.length - 1; index += 1) {
    const edge = view.edges.find((candidate) => candidate.source === path[index] && candidate.target === path[index + 1]);
    if (edge) edges.push(edge);
  }
  return edges;
}

const unverified = (node: Node | undefined): boolean => Boolean(node) && (node!.kind === "person" ? node!.uboStatus !== "verified" : node!.epistemic !== "fact");

export type Visible = { nodes: Set<string>; edges: Set<string>; hiddenNodes: number; hiddenEdges: number };

/** What a filter keeps: the matching relationships, the parties on them, and the customer. */
export function visibleFor(view: Ownership, filter: OwnershipFilter): Visible {
  const byId = new Map(view.nodes.map((node) => [node.id, node]));
  const gapEdges = new Set(view.gaps.flatMap((gap) => edgesAlong(view, gap.path).map((edge) => edge.id)));
  const keep = (edge: Edge): boolean => {
    if (filter === "conflict") return edge.status === "conflict";
    if (filter === "unresolved") return edge.status === "unresolved" || edge.status === "conflict" || gapEdges.has(edge.id);
    if (filter === "unverified") return edge.status !== "verified" || unverified(byId.get(edge.source)) || unverified(byId.get(edge.target));
    return true;
  };
  const edges = new Set(view.edges.filter(keep).map((edge) => edge.id));
  const nodes = new Set<string>(filter === "all" ? view.nodes.map((node) => node.id) : view.nodes.filter((node) => node.isRoot).map((node) => node.id));
  for (const edge of view.edges) if (edges.has(edge.id)) { nodes.add(edge.source); nodes.add(edge.target); }
  return { nodes, edges, hiddenNodes: view.nodes.length - nodes.size, hiddenEdges: view.edges.length - edges.size };
}

const MAX_PATHS = 12;

/**
 * Every path from a party down to the customer, as edges (owner first). A path never visits a
 * party twice, so circular holdings end instead of looping; `circular` reports that one was cut.
 */
export function pathsToRoot(view: Ownership, nodeId: string): { paths: Edge[][]; circular: boolean; truncated: boolean } {
  const roots = new Set(view.nodes.filter((node) => node.isRoot).map((node) => node.id));
  const paths: Edge[][] = [];
  let circular = false;
  let truncated = false;
  const walk = (at: string, trail: Edge[], seen: Set<string>) => {
    if (roots.has(at)) { if (trail.length) paths.push(trail); return; }
    for (const edge of view.edges) {
      if (edge.source !== at) continue;
      if (seen.has(edge.target)) { circular = true; continue; }
      if (paths.length >= MAX_PATHS) { truncated = true; return; }
      walk(edge.target, [...trail, edge], new Set([...seen, edge.target]));
    }
  };
  walk(nodeId, [], new Set([nodeId]));
  return { paths, circular, truncated };
}

/** Exact product of decimal strings ("0.4" × "0.7" → "0.28"); payload values are never floats. */
export function multiplyDecimals(values: readonly string[]): string {
  let digits = 1n;
  let scale = 0;
  for (const value of values) {
    const [whole = "0", fraction = ""] = value.split(".");
    digits *= BigInt(`${whole}${fraction}`);
    scale += fraction.length;
  }
  const text = digits.toString().padStart(scale + 1, "0");
  const result = scale ? `${text.slice(0, -scale)}.${text.slice(-scale)}`.replace(/\.?0+$/, "") : text;
  return result || "0";
}

export type PathInterest = { state: "calculated"; value: string; terms: string[] } | { state: "unable"; reason: string };

/**
 * The indirect economic interest along one path. Multiplication is used only when every
 * relationship on the path is an equity interest with one agreed value.
 */
export function pathInterest(path: readonly Edge[]): PathInterest {
  if (!path.length) return { state: "unable", reason: "There is no path to the customer." };
  if (path.some((edge) => edge.kind === "control")) return { state: "unable", reason: "The path includes a control relationship, which carries no percentage." };
  if (path.some((edge) => edge.status === "conflict")) return { state: "unable", reason: "Sources disagree on an interest along this path." };
  if (path.some((edge) => edge.interest === null)) return { state: "unable", reason: "An interest along this path is unknown." };
  const terms = path.map((edge) => edge.interest!);
  if (terms.some((term) => !/^\d+(\.\d+)?$/.test(term))) return { state: "unable", reason: "An interest along this path is not a plain number." };
  return { state: "calculated", value: multiplyDecimals(terms), terms };
}

export type Selection = { node?: string | undefined; edge?: string | undefined; contradiction?: string | null | undefined };

/** The relationships to emphasise for a selection: an edge, a contradiction's edge, or a party's paths and gaps. */
export function highlighted(view: Ownership, selection: Selection): Set<string> {
  const ids = new Set<string>();
  if (selection.edge) ids.add(selection.edge);
  if (selection.node) {
    for (const path of pathsToRoot(view, selection.node).paths) for (const edge of path) ids.add(edge.id);
    for (const gap of view.gaps) if (gap.node === selection.node) for (const edge of edgesAlong(view, gap.path)) ids.add(edge.id);
  }
  if (!selection.edge && !selection.node && selection.contradiction) {
    for (const edge of view.edges) if (edge.contradictionId === selection.contradiction) ids.add(edge.id);
  }
  return ids;
}

/** Parties whose name or sublabel contains the query. */
export function matching(view: Ownership, query: string): string[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  return view.nodes.filter((node) => `${node.label} ${node.sublabel ?? ""}`.toLowerCase().includes(needle)).map((node) => node.id);
}
