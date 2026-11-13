import type { Schemas } from "@ehf/ui-contracts";
import { Button, Id, Table, ToneBadge } from "@ehf/ui-kit";
import type { KeyboardEvent } from "react";
import type { OpenItem } from "./case-model";
import { EvidenceRefs } from "./evidence";
import styles from "./work.module.css";

export type Ownership = Schemas["OwnershipView"];
type Node = Ownership["nodes"][number];
type Edge = Ownership["edges"][number];

export const NODE_W = 196;
export const NODE_H = 76;

const EDGE_TEXT: Record<Edge["status"], string> = {
  verified: "Verified interest",
  candidate: "Candidate / asserted",
  unresolved: "Unresolved path",
  conflict: "Conflicting sources",
};

/** "0.12" → "12%", exact (decimal strings, never floats in the payload). */
export function percent(decimal: string | null): string {
  if (decimal === null) return "—";
  const [whole = "0", fraction = ""] = decimal.split(".");
  const digits = `${whole}${fraction.padEnd(2, "0")}`;
  const integer = digits.slice(0, whole.length + 2).replace(/^0+(?=\d)/, "");
  const rest = digits.slice(whole.length + 2).replace(/0+$/, "");
  return `${integer}${rest ? `.${rest}` : ""}%`;
}

/** Both values on a conflict edge (BIZ-03-AC1): "12% / 22%". */
export function interestText(edge: Edge): string {
  if (edge.status === "conflict" && edge.interestAlternative !== null) return `${percent(edge.interest)} / ${percent(edge.interestAlternative)}`;
  return edge.kind === "control" ? "control" : percent(edge.interest);
}

/**
 * The epistemic glyph for a node. A person is a fact only once verified as a UBO; an
 * unverified person never shows the fact glyph, whatever the node's epistemic field says
 * (BIZ-03-AC2).
 */
export function nodeStanding(node: Node): { glyph: string; text: string } {
  if (node.kind === "person") {
    if (node.uboStatus === "verified") return { glyph: "◆", text: "Verified UBO" };
    return { glyph: "◇", text: node.uboStatus === "candidate" ? "Candidate (unverified)" : "Unverified" };
  }
  if (node.epistemic === "fact") return { glyph: "◆", text: "Registry fact" };
  if (node.epistemic === "assumption") return { glyph: "?", text: "Assumption" };
  return { glyph: "◇", text: "Asserted" };
}

/**
 * What a party card carries beyond its standing: the evidence cited on its relationships and the
 * open items that name it. Both are counted from what is loaded, never inferred.
 */
export function nodeSignals(view: Ownership, openItems: readonly OpenItem[] | undefined): Map<string, { evidence: number; open: number }> {
  const evidence = new Map<string, Set<string>>(view.nodes.map((node) => [node.id, new Set<string>()]));
  for (const edge of view.edges) for (const end of [edge.source, edge.target]) for (const id of edge.evidenceIds) evidence.get(end)?.add(id);
  const byParty = new Map<string, number>();
  for (const item of openItems ?? []) if (item.party) byParty.set(item.party, (byParty.get(item.party) ?? 0) + 1);
  return new Map(view.nodes.map((node) => [node.id, { evidence: evidence.get(node.id)!.size, open: byParty.get(node.label) ?? 0 }]));
}

export type Point = { x: number; y: number };

/**
 * Node positions: the projection's layout when it has one; otherwise rows by distance from
 * the root (owners above what they own, as in the projection's own layouts).
 */
export function positions(view: Ownership): Map<string, Point> {
  const at = new Map<string, Point>();
  if (view.nodes.every((node) => node.layout)) {
    for (const node of view.nodes) at.set(node.id, { x: node.layout!.x, y: node.layout!.y });
    return at;
  }
  const depth = new Map<string, number>(view.nodes.filter((node) => node.isRoot).map((node) => [node.id, 0]));
  for (let pass = 0; pass < view.nodes.length; pass += 1) {
    for (const edge of view.edges) {
      const below = depth.get(edge.target);
      if (below !== undefined && !depth.has(edge.source)) depth.set(edge.source, below + 1);
    }
  }
  const rows = new Map<number, number>();
  for (const node of view.nodes) {
    const row = depth.get(node.id) ?? Math.max(0, ...depth.values()) + 1;
    const column = rows.get(row) ?? 0;
    rows.set(row, column + 1);
    at.set(node.id, { x: 20 + column * (NODE_W + 40), y: 20 + row * (NODE_H + 80) });
  }
  return at;
}

function edgePath(source: Point, target: Point): { d: string; mx: number; my: number } {
  const sx = source.x + NODE_W / 2;
  const tx = target.x + NODE_W / 2;
  const up = source.y > target.y;
  const sy = up ? source.y : source.y + NODE_H;
  const ty = up ? target.y + NODE_H : target.y;
  const my = (sy + ty) / 2;
  return { d: `M ${sx} ${sy} C ${sx} ${my}, ${tx} ${my}, ${tx} ${ty}`, mx: (sx + tx) / 2, my };
}

function summary(view: Ownership): string {
  const label = new Map(view.nodes.map((node) => [node.id, node.label]));
  const parts = view.edges.map((edge) => `${label.get(edge.source)} → ${label.get(edge.target)}: ${interestText(edge)}, ${EDGE_TEXT[edge.status].toLowerCase()}`);
  return `Ownership graph. ${parts.join("; ")}. Use the Table view for a full accessible listing.`;
}

/** The drawn size of the structure, in the same units as node positions. */
export function extent(view: Ownership): { width: number; height: number } {
  const points = [...positions(view).values()];
  return { width: Math.max(...points.map((point) => point.x)) + NODE_W + 40, height: Math.max(...points.map((point) => point.y)) + NODE_H + 40 };
}

/** What the interactive canvas adds to the drawing: selection, emphasis, filtering and the view transform. */
export type CanvasState = {
  visible: { nodes: Set<string>; edges: Set<string> };
  highlight: Set<string>;
  matches: Set<string>;
  selectedNode: string | undefined;
  selectedEdge: string | undefined;
  onSelectNode: (id: string) => void;
  onSelectEdge: (edge: Edge) => void;
  transform: { x: number; y: number; k: number };
};

const activate = (run: () => void) => (event: KeyboardEvent) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  run();
};

/**
 * Ownership & control as a graph. On its own it is a static picture (the Overview preview);
 * given `canvas` every party and relationship is selectable by pointer or keyboard.
 */
export function OwnershipGraph({ view, selectedContradiction, onSelectContradiction, canvas, openItems }: {
  view: Ownership;
  /** The case's open items; a party named by one carries a review marker with the count. */
  openItems?: readonly OpenItem[] | undefined;
  selectedContradiction: string | null;
  onSelectContradiction: (id: string) => void;
  canvas?: CanvasState;
}) {
  const at = positions(view);
  const gaps = new Set(view.gaps.map((gap) => gap.node));
  const signals = nodeSignals(view, openItems);
  const label = new Map(view.nodes.map((node) => [node.id, node.label]));
  const { width, height } = extent(view);
  const edges = canvas ? view.edges.filter((edge) => canvas.visible.edges.has(edge.id)) : view.edges;
  const nodes = canvas ? view.nodes.filter((node) => canvas.visible.nodes.has(node.id)) : view.nodes;
  const emphasis = canvas && (canvas.highlight.size > 0 || canvas.selectedNode !== undefined);
  const lit = new Set<string>(canvas?.selectedNode ? [canvas.selectedNode] : []);
  if (canvas) for (const edge of view.edges) if (canvas.highlight.has(edge.id)) { lit.add(edge.source); lit.add(edge.target); }
  const body = (
    <>
      {edges.map((edge) => {
        const source = at.get(edge.source);
        const target = at.get(edge.target);
        if (!source || !target) return null;
        const { d, mx, my } = edgePath(source, target);
        const select = canvas ? () => canvas.onSelectEdge(edge) : edge.contradictionId ? () => onSelectContradiction(edge.contradictionId!) : undefined;
        const selected = canvas ? canvas.selectedEdge === edge.id || (edge.contradictionId !== null && edge.contradictionId === selectedContradiction && !canvas.selectedEdge && !canvas.selectedNode) : edge.contradictionId !== null && edge.contradictionId === selectedContradiction;
        return (
          <g
            key={edge.id} className={styles.edgeGroup} data-edge={edge.id} data-status={edge.status}
            data-dim={Boolean(emphasis && !canvas!.highlight.has(edge.id))}
            onClick={select} style={select ? { cursor: "pointer" } : undefined}
            {...(canvas ? { tabIndex: 0, role: "button", "aria-pressed": selected, "aria-label": `${label.get(edge.source)} to ${label.get(edge.target)}: ${interestText(edge)}, ${EDGE_TEXT[edge.status].toLowerCase()}`, onKeyDown: activate(select!) } : {})}
          >
            {canvas ? <path d={d} className={styles.edgeHit} /> : null}
            <path d={d} className={styles.edge} data-status={edge.status} data-selected={selected} />
            <text x={mx + 6} y={my} className={styles.edgeLabel}>{interestText(edge)}</text>
          </g>
        );
      })}
      {nodes.map((node) => {
        const standing = nodeStanding(node);
        const point = at.get(node.id)!;
        const signal = signals.get(node.id)!;
        const openText = signal.open ? `${signal.open} open ${signal.open === 1 ? "item" : "items"}` : "";
        const select = canvas ? () => canvas.onSelectNode(node.id) : undefined;
        return (
          <g
            key={node.id} className={styles.node} data-node={node.id} data-root={node.isRoot} data-gap={gaps.has(node.id)} data-glyph={standing.glyph} data-open={signal.open}
            data-selected={canvas?.selectedNode === node.id} data-match={canvas?.matches.has(node.id) ?? false} data-dim={Boolean(emphasis && !lit.has(node.id))}
            transform={`translate(${point.x} ${point.y})`} onClick={select} style={select ? { cursor: "pointer" } : undefined}
            {...(canvas ? { tabIndex: 0, role: "button", "aria-pressed": canvas.selectedNode === node.id, "aria-label": `${node.label}, ${standing.text}${gaps.has(node.id) ? ", unresolved path" : ""}, ${signal.evidence} evidence ${signal.evidence === 1 ? "item" : "items"}${openText ? `, ${openText}` : ""}`, onKeyDown: activate(select!) } : {})}
          >
            <rect width={NODE_W} height={NODE_H} rx={8} />
            <text x={12} y={22} className={styles.nodeLabel}>{node.label}</text>
            <text x={12} y={42} className={styles.nodeSub}><tspan className={styles.nodeGlyph}>{standing.glyph}</tspan> {standing.text}{node.sublabel ? ` · ${node.sublabel}` : ""}</text>
            <line x1={12} x2={NODE_W - 12} y1={52} y2={52} className={styles.nodeRule} />
            <text x={12} y={67} className={styles.nodeMeta}>{signal.evidence ? `${signal.evidence} evidence ${signal.evidence === 1 ? "item" : "items"}` : "No evidence cited"}</text>
            {signal.open ? (
              <g className={styles.nodeOpen} transform={`translate(${NODE_W - 12} 12)`}>
                <title>{openText}</title>
                <circle r={9} />
                <text textAnchor="middle" dy={4}>{signal.open}</text>
              </g>
            ) : null}
          </g>
        );
      })}
    </>
  );
  if (canvas) {
    const { x, y, k } = canvas.transform;
    return (
      <svg className={styles.graphFill} viewBox={`0 0 ${width} ${height}`} role="group" aria-label={`Ownership structure: ${nodes.length} parties and ${edges.length} relationships. Select a party or a relationship to inspect it.`}>
        <rect data-pan="true" x={-width * 4} y={-height * 4} width={width * 9} height={height * 9} fill="transparent" />
        <g transform={`translate(${x} ${y}) scale(${k})`}>{body}</g>
      </svg>
    );
  }
  return (
    <div className={styles.graphWrap}>
      <svg className={styles.graph} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={summary(view)}>{body}</svg>
    </div>
  );
}

export function OwnershipLegend() {
  return (
    <ul className={styles.legend} aria-label="Legend">
      {(Object.keys(EDGE_TEXT) as Edge["status"][]).map((status) => (
        <li key={status}><span className={styles.legendSwatch} data-status={status} aria-hidden="true" />{EDGE_TEXT[status]}</li>
      ))}
      <li>◆ fact · ◇ claim or unverified · ? assumption</li>
      <li><span className={styles.legendOpen} aria-hidden="true" />Open items naming the party</li>
    </ul>
  );
}

/** Every edge as a row (BIZ-03-AC3). */
export function OwnershipTable({ view, onSelectContradiction, selectedEdge, onInspect }: {
  view: Ownership;
  onSelectContradiction: (id: string) => void;
  selectedEdge?: string | undefined;
  /** Inspect a relationship, as selecting it on the canvas does. */
  onInspect?: (edge: Edge) => void;
}) {
  const label = new Map(view.nodes.map((node) => [node.id, node]));
  return (
    <Table<Edge>
      caption="Ownership and control edges"
      rows={view.edges}
      rowKey={(row) => row.id}
      stickyFirstColumn
      columns={[
        { key: "owner", header: "Owner", render: (row) => { const node = label.get(row.source); return node ? <span>{node.label} <span className={styles.muted}>{nodeStanding(node).glyph} {nodeStanding(node).text}</span></span> : row.source; } },
        { key: "owned", header: "Owned", render: (row) => label.get(row.target)?.label ?? row.target },
        { key: "kind", header: "Kind", render: (row) => row.kind },
        { key: "interest", header: "Interest", render: (row) => <span className="num">{interestText(row)}</span> },
        {
          key: "status", header: "Status", render: (row) => (
            <ToneBadge tone={row.status === "verified" ? "positive" : row.status === "conflict" ? "blocking" : row.status === "unresolved" ? "attention" : "neutral"} icon={row.status === "verified" ? "checkcircle" : row.status === "conflict" ? "split" : row.status === "unresolved" ? "help" : "eye"}>
              {EDGE_TEXT[row.status]}
            </ToneBadge>
          ),
        },
        { key: "evidence", header: "Evidence", render: (row) => <EvidenceRefs ids={row.evidenceIds} /> },
        ...(onInspect ? [{ key: "inspect", header: "Inspect", render: (row: Edge) => <Button size="sm" aria-pressed={row.id === selectedEdge} onClick={() => onInspect(row)}>{row.id === selectedEdge ? "Inspecting" : "Inspect"}</Button> }] : []),
        { key: "review", header: "Contradiction", render: (row) => (row.contradictionId ? <Button size="sm" onClick={() => onSelectContradiction(row.contradictionId!)}>Review {row.contradictionId}</Button> : "—") },
      ]}
    />
  );
}
