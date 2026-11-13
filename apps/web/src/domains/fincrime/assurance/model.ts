import type { Schemas } from "@ehf/ui-contracts";

export type RecorderEntry = Schemas["RecorderEntry"];
export type LineageGraph = Schemas["LineageGraph"];
type LineageNode = LineageGraph["nodes"][number];

/** Typed cross-links into the Assurance studio (BUILD-SPEC v2 §8.4). */
export const recorderPath = (caseId: string): string => `/assurance/recorder/${encodeURIComponent(caseId)}`;
export const lineagePath = (caseId: string): string => `/assurance/lineage/${encodeURIComponent(caseId)}`;
export const PACKAGES_PATH: string = "/assurance/packages";
export const MISSION_CONTROL_PATH: string = "/assurance";

/** The rule the chronology is ordered by, stated on screen (ASR-02 AC1). */
export const ORDERING_RULE =
  "Ordered by time. When a human decision and the case events it caused share a timestamp, the decision comes first; case events keep their ledger sequence.";

const sourceRank = (entry: RecorderEntry): number => (entry.source === "human_decision" ? 0 : 1);

/**
 * Order the merged chronology (ASR-02 AC1): by occurredAt; at the same instant a human decision
 * precedes the case events it caused; case events then follow ledger sequence; anything else
 * keeps the order the server sent.
 */
export function orderChronology(entries: readonly RecorderEntry[]): RecorderEntry[] {
  return entries
    .map((entry, index) => ({ entry, index, at: Date.parse(entry.occurredAt) }))
    .sort((a, b) => {
      if (a.at !== b.at) return a.at - b.at;
      const rank = sourceRank(a.entry) - sourceRank(b.entry);
      if (rank !== 0) return rank;
      if (a.entry.source === "case_event" && b.entry.source === "case_event") return a.entry.sequence - b.entry.sequence;
      return a.index - b.index;
    })
    .map(({ entry }) => entry);
}

/** The node the lineage view starts from: the requested one, else the decision. */
export function lineageStart(graph: LineageGraph, requested: string | undefined): LineageNode | undefined {
  return graph.nodes.find((node) => node.id === requested) ?? graph.nodes.find((node) => node.column === "decision") ?? graph.nodes[0];
}

/**
 * Everything that supports `nodeId`, walking edges backwards (edge.from supports edge.to), so
 * highlighting from the decision reaches the sources (ASR-03 AC1). Includes the node itself.
 */
export function supportingSet(graph: LineageGraph, nodeId: string): Set<string> {
  const reached = new Set<string>([nodeId]);
  const pending = [nodeId];
  while (pending.length) {
    const current = pending.pop()!;
    for (const edge of graph.edges) {
      if (edge.to === current && !reached.has(edge.from)) {
        reached.add(edge.from);
        pending.push(edge.from);
      }
    }
  }
  return reached;
}

/** Split a platform route such as `/platform/runs?status=failed` for a typed Link. */
export function splitRoute(route: string): { to: string; search: Record<string, string> } {
  const url = new URL(route, "http://route.invalid");
  return { to: url.pathname, search: Object.fromEntries(url.searchParams.entries()) };
}
