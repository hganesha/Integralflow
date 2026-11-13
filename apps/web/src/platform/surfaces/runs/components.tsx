import type { Schemas } from "@ehf/ui-contracts";
import { Button, DigestValue, fmtCost, fmtDuration, LocalTimestamp, StatusBadge, Table, ToneBadge, type Column } from "@ehf/ui-kit";
import { Link } from "@tanstack/react-router";
import { useId, useMemo, useState, type ReactNode } from "react";
import styles from "./runs.module.css";

type CostView = Schemas["CostView"];
type RunSummary = Schemas["RunSummary"];
type PlanNode = { id: string; name: string; primitive: string; x?: number; y?: number };
type PlanEdge = { from: string; to: string; conditionLabel?: string };

/** Route paths as plain strings (routes are registered from data, so `to` is untyped). */
export const runPath = (runId: string): string => `/platform/runs/${encodeURIComponent(runId)}`;
export const planPath = (planDigest: string): string => `/platform/plans/${encodeURIComponent(planDigest.replace(/^sha256:/, ""))}`;
export const tracePath = (traceId: string): string => `/platform/traces/${encodeURIComponent(traceId)}`;
export const SYSTEM_PATH: string = "/platform/system";
export const HUMAN_WORK_PATH: string = "/platform/human-work";
export const RUNS_PATH: string = "/platform/runs";
export const PLANS_PATH: string = "/platform/plans";

/** Reported cost, 4 decimals; marked incomplete when any run lacked cost data (PLT-01 AC2). */
export function CostValue({ cost }: { cost: CostView }) {
  return (
    <span className={styles.cost}>
      <span>{fmtCost(cost.reportedUsd, true)}</span>
      {!cost.complete ? <ToneBadge tone="attention" icon="alert">incomplete</ToneBadge> : null}
    </span>
  );
}

/** "Not reported" rather than a fabricated zero. */
export function Duration({ ms }: { ms: number | null | undefined }) {
  return ms === null || ms === undefined ? <span className={styles.muted}>Not reported</span> : <span className={styles.mono}>{fmtDuration(ms)}</span>;
}

export function KeyValues({ items }: { items: ReadonlyArray<[string, ReactNode]> }) {
  return (
    <dl className={styles.kv}>
      {items.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Runs table shared by the runs list, plan detail and overview. */
export function RunsTable({ runs, caption, empty, compact = false }: { runs: readonly RunSummary[]; caption: string; empty?: ReactNode; compact?: boolean }) {
  const columns: Column<RunSummary>[] = [
    { key: "run", header: "Run", render: (run) => <Link to={runPath(run.runId)} className={styles.mono}>{run.runId}</Link> },
    { key: "harness", header: "Process flow", render: (run) => (
      <span>
        {run.harnessName} <span className={styles.muted}>v{run.packageVersion}</span>
        <br />
        <DigestValue value={run.planDigest} label="plan digest" />
      </span>
    ) },
    { key: "status", header: "Status", render: (run) => (
      <span>
        <StatusBadge dimension="RunStatus" value={run.status} humanize />
        {run.terminalOutcome && run.terminalOutcome !== run.status ? <><br /><span className={styles.small}>Outcome: {run.terminalOutcome}</span></> : null}
      </span>
    ) },
    { key: "node", header: "Current node", render: (run) => run.currentNodeId ? <span className={styles.mono}>{run.currentNodeId}</span> : <span className={styles.muted}>—</span> },
    ...(compact ? [] : [
      { key: "tiers", header: "Model tiers", render: (run: RunSummary) => run.modelTiers.length ? <span className={styles.mono}>{run.modelTiers.join(", ")}</span> : <span className={styles.muted}>None</span> },
      { key: "calls", header: "Model / capability calls", align: "end" as const, render: (run: RunSummary) => <span className={styles.mono}>{run.modelCalls} / {run.capabilityCalls}</span> },
    ]),
    { key: "cost", header: "Reported cost", align: "end", render: (run) => <CostValue cost={run.cost} /> },
    { key: "duration", header: "Duration", align: "end", render: (run) => <Duration ms={run.durationMs} /> },
    ...(compact ? [] : [{ key: "started", header: "Started", render: (run: RunSummary) => <LocalTimestamp iso={run.startedAt} /> }]),
    { key: "updated", header: "Updated", render: (run) => <LocalTimestamp iso={run.updatedAt} /> },
  ];
  return <Table caption={caption} captionHidden columns={columns} rows={runs} rowKey={(run) => run.runId} stickyFirstColumn empty={empty ?? "No runs"} />;
}

/** Longest-path layering; nodes in a cycle keep the column they reached. */
function layout(nodes: readonly PlanNode[], edges: readonly PlanEdge[]) {
  const incoming = new Map(nodes.map((node) => [node.id, 0]));
  const outgoing = new Map(nodes.map((node) => [node.id, [] as string[]]));
  for (const edge of edges) {
    if (!incoming.has(edge.from) || !incoming.has(edge.to) || edge.from === edge.to) continue;
    incoming.set(edge.to, incoming.get(edge.to)! + 1);
    outgoing.get(edge.from)!.push(edge.to);
  }
  const rank = new Map(nodes.map((node) => [node.id, 0]));
  const queue = nodes.filter((node) => incoming.get(node.id) === 0).map((node) => node.id);
  for (let index = 0; index < queue.length; index++) {
    const id = queue[index]!;
    for (const target of outgoing.get(id) ?? []) {
      rank.set(target, Math.max(rank.get(target)!, rank.get(id)! + 1));
      incoming.set(target, incoming.get(target)! - 1);
      if (incoming.get(target) === 0) queue.push(target);
    }
  }
  const columns = new Map<number, string[]>();
  for (const node of nodes) columns.set(rank.get(node.id)!, [...(columns.get(rank.get(node.id)!) ?? []), node.id]);
  const tallest = Math.max(1, ...[...columns.values()].map((ids) => ids.length));
  const COLUMN = 200, ROW = 64, PAD_X = 16, PAD_Y = 16, WIDTH = 168, HEIGHT = 44;
  const height = PAD_Y * 2 + tallest * ROW - (ROW - HEIGHT);
  const positions = new Map<string, { x: number; y: number }>();
  for (const [column, ids] of columns) {
    const offset = (height - (ids.length * ROW - (ROW - HEIGHT))) / 2;
    ids.forEach((id, row) => positions.set(id, { x: PAD_X + column * COLUMN, y: offset + row * ROW }));
  }
  const lastColumn = Math.max(0, ...columns.keys());
  return { positions, width: PAD_X * 2 + lastColumn * COLUMN + WIDTH, height, WIDTH, HEIGHT };
}

/**
 * Read-only plan graph (PLT-05 preview, PLT-07 run position) with a table alternative (N10).
 * Primitives are text, never colour; the current node gets a heavier outline and a label.
 */
export function PlanGraph({ nodes, edges, currentNodeId, label }: { nodes: readonly PlanNode[]; edges: readonly PlanEdge[]; currentNodeId?: string | null; label: string }) {
  const [view, setView] = useState<"graph" | "table">("graph");
  const titleId = useId();
  const descId = useId();
  const { positions, width, height, WIDTH, HEIGHT } = useMemo(() => layout(nodes, edges), [nodes, edges]);
  const names = new Map(nodes.map((node) => [node.id, node.name]));
  return (
    <div className={styles.section}>
      <div className={styles.toolbar}>
        <Button size="sm" icon={view === "graph" ? "table" : "graph"} aria-pressed={view === "table"} onClick={() => setView(view === "graph" ? "table" : "graph")}>
          {view === "graph" ? "Show as table" : "Show as graph"}
        </Button>
        <span className={styles.small}>{nodes.length} nodes · {edges.length} edges</span>
      </div>
      {view === "graph" ? (
        <div className={styles.graphFrame} tabIndex={0} role="region" aria-label={`${label} (scrollable)`}>
          <svg width={width} height={height} role="img" aria-labelledby={`${titleId} ${descId}`}>
            <title id={titleId}>{label}</title>
            <desc id={descId}>
              {nodes.length} nodes and {edges.length} edges.{currentNodeId ? ` Current node: ${names.get(currentNodeId) ?? currentNodeId}.` : ""} Use “Show as table” for the full list.
            </desc>
            <defs>
              <marker id={`${titleId}-arrow`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
                <path d="M0,0 L8,4 L0,8 z" className={styles.graphArrow} />
              </marker>
            </defs>
            {edges.map((edge, index) => {
              const from = positions.get(edge.from);
              const to = positions.get(edge.to);
              if (!from || !to) return null;
              const x1 = from.x + WIDTH, y1 = from.y + HEIGHT / 2, x2 = to.x, y2 = to.y + HEIGHT / 2;
              const mid = (x1 + x2) / 2;
              return <path key={`${edge.from}-${edge.to}-${index}`} className={styles.graphEdge} d={`M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}`} markerEnd={`url(#${titleId}-arrow)`} />;
            })}
            {nodes.map((node) => {
              const at = positions.get(node.id)!;
              const current = node.id === currentNodeId;
              return (
                <g key={node.id} className={styles.graphNode} data-current={current} transform={`translate(${at.x},${at.y})`}>
                  <rect width={WIDTH} height={HEIGHT} rx="8" />
                  <text x="10" y="18">{node.name.length > 22 ? `${node.name.slice(0, 21)}…` : node.name}</text>
                  <text x="10" y="34" className={styles.graphKind}>{current ? `${node.primitive} · current` : node.primitive}</text>
                </g>
              );
            })}
          </svg>
        </div>
      ) : (
        <>
          <Table
            caption={`${label}: nodes`}
            columns={[
              { key: "id", header: "Node", render: (node: PlanNode) => <span className={styles.mono}>{node.id}</span> },
              { key: "name", header: "Name", render: (node: PlanNode) => node.name },
              { key: "primitive", header: "Primitive", render: (node: PlanNode) => node.primitive },
              { key: "state", header: "Position", render: (node: PlanNode) => (node.id === currentNodeId ? "Current node" : "") },
            ]}
            rows={nodes}
            rowKey={(node) => node.id}
          />
          <Table
            caption={`${label}: edges`}
            columns={[
              { key: "from", header: "From", render: (edge: PlanEdge) => names.get(edge.from) ?? edge.from },
              { key: "to", header: "To", render: (edge: PlanEdge) => names.get(edge.to) ?? edge.to },
              { key: "condition", header: "Condition", render: (edge: PlanEdge) => edge.conditionLabel ?? "" },
            ]}
            rows={edges}
            rowKey={(edge) => `${edge.from}->${edge.to}`}
          />
        </>
      )}
    </div>
  );
}
