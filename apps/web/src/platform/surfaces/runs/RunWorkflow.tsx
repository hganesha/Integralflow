import { canReadCatalog } from "@ehf/ui-contracts";
import { useSession } from "../../../app/session";
import { usePolled } from "@ehf/ui-client/react";
import { Button, Id, JsonViewer, LocalTimestamp, Select, Table, ToneBadge, type IconName } from "@ehf/ui-kit";
import { Link } from "@tanstack/react-router";
import { Background, Controls, Handle, Position, ReactFlow, ReactFlowProvider, useNodesInitialized, useReactFlow, type Node, type NodeProps } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useEffect, useState } from "react";
import { api } from "../../../app/api";
import { Region } from "../../common";
import { nodeExecution, type Execution, type NodeState } from "./execution-model";
import styles from "./workflow.module.css";

const STATUS: Record<NodeState, { text: string; tone: "neutral" | "running" | "positive" | "blocking" | "attention"; icon: IconName }> = {
  not_observed: { text: "Not observed", tone: "neutral", icon: "minus" }, running: { text: "Running", tone: "running", icon: "activity" }, completed: { text: "Completed", tone: "positive", icon: "check" },
  failed: { text: "Failed", tone: "blocking", icon: "xcircle" }, cancelled: { text: "Cancelled", tone: "neutral", icon: "x" }, waiting_human: { text: "Waiting for a person", tone: "attention", icon: "hand" }, unknown: { text: "Unknown", tone: "neutral", icon: "help" },
};
type Step = Node<{ title: string; kind: string; state: NodeState; current: boolean }, "execution">;
function ExecutionNode({ data, selected }: NodeProps<Step>) {
  const status = STATUS[data.state];
  return <div className={styles.node} data-selected={selected || undefined} data-current={data.current || undefined} aria-current={data.current ? "step" : undefined}>
    {data.kind !== "input" ? <Handle type="target" position={Position.Left} /> : null}
    <span className={styles.kind}>{data.kind}</span><strong>{data.title}</strong><ToneBadge tone={status.tone} icon={status.icon}>{status.text}</ToneBadge>
    {data.kind !== "output" ? <Handle type="source" position={Position.Right} /> : null}
  </div>;
}
const NODE_TYPES = { execution: ExecutionNode };
function FocusSelectedStep({ nodeId }: { nodeId: string | null }) {
  const ready = useNodesInitialized();
  const { fitView } = useReactFlow<Step>();
  useEffect(() => {
    if (ready && nodeId) void fitView({ nodes: [{ id: nodeId }], maxZoom: 1, padding: 0.4, duration: 180 });
  }, [fitView, nodeId, ready]);
  return null;
}

export default function RunWorkflow({ runId, label }: { runId: string; label: string }) {
  const execution = usePolled(api, "getRunsRunIdExecution", { path: { runId } });
  return <Region polled={execution} label="workflow execution">{data => <Workflow key={runId} execution={data} label={label} />}</Region>;
}
export function Workflow({ execution, label, selection }: {
  execution: Execution;
  label: string;
  selection?: { nodeId: string | null; attempt: number; selectNode: (id: string) => void; selectAttempt: (attempt: number) => void };
}) {
  const session = useSession();
  const [localId, selectLocal] = useState<string | null>(null);
  const [attemptChoice, setAttempt] = useState<number | null>(null);
  const [view, setView] = useState<"graph" | "table">("graph");
  const selectedId = selection ? selection.nodeId : localId;
  const select = selection?.selectNode ?? selectLocal;
  const attempt = selection?.attempt ?? attemptChoice ?? execution.run.attempt;
  const nodes = execution.plan.graph.nodes;
  const selected = nodes.find(node => node.id === selectedId);
  const record = selected ? nodeExecution(execution, selected.id, attempt) : null;
  const attempts = [...new Set([execution.run.attempt, ...execution.attempts.map(record => record.attempt)])].sort((a, b) => b - a);
  // Rank-based layout follows dependencies, so parallel nodes share a column.
  const ranks = new Map(nodes.map(node => [node.id, 0]));
  const incoming = new Map(nodes.map(node => [node.id, execution.plan.graph.edges.filter(edge => edge.to === node.id).length]));
  const queue = nodes.filter(node => !incoming.get(node.id)).map(node => node.id);
  for (let i = 0; i < queue.length; i++) for (const edge of execution.plan.graph.edges.filter(edge => edge.from === queue[i])) { ranks.set(edge.to, Math.max(ranks.get(edge.to) ?? 0, (ranks.get(edge.from) ?? 0) + 1)); incoming.set(edge.to, (incoming.get(edge.to) ?? 1) - 1); if (!incoming.get(edge.to)) queue.push(edge.to); }
  const focusId = execution.run.currentNodeId ?? nodes[0]?.id;
  const focusIds = new Set([focusId, ...execution.plan.graph.edges.filter(edge => edge.from === focusId || edge.to === focusId).flatMap(edge => [edge.from, edge.to])].filter((id): id is string => Boolean(id)));
  const rows = new Map<number, number>();
  const flowNodes: Step[] = nodes.map(node => { const rank = ranks.get(node.id) ?? 0, row = rows.get(rank) ?? 0; rows.set(rank, row + 1); return { id: node.id, type: "execution", position: { x: rank * 300, y: row * 180 }, data: { title: node.name || node.id, kind: node.kind, current: attempt === execution.run.attempt && node.id === execution.run.currentNodeId, state: nodeExecution(execution, node.id, attempt).state }, selected: node.id === selectedId, ariaLabel: `${node.name || node.id}: ${STATUS[nodeExecution(execution, node.id, attempt).state].text}` }; });
  return <div className={styles.workspace} data-sandbox={selection ? true : undefined}>
    <div className={styles.toolbar}><span>{nodes.length} steps · source plan <Id>{execution.run.planDigest.slice(0, 12)}</Id></span><Select aria-label="Execution attempt" value={attempt} onChange={event => (selection?.selectAttempt ?? setAttempt)(Number(event.target.value))}>{attempts.map(value => <option key={value} value={value}>Attempt {value}{value === execution.run.attempt ? " · current" : ""}</option>)}</Select><Button size="sm" icon={view === "graph" ? "table" : "graph"} onClick={() => setView(view === "graph" ? "table" : "graph")}>{view === "graph" ? "Show as table" : "Show as graph"}</Button></div>
    <p className={styles.note}>States come from recorded node attempts. An unobserved step has no reported outcome.</p>
    <div className={styles.body}>
      {view === "graph" ? <div className={styles.canvas} role="region" aria-label={label}><ReactFlowProvider><ReactFlow<Step> nodes={flowNodes} edges={execution.plan.graph.edges.map(edge => ({ id: edge.id, source: edge.from, target: edge.to, label: edge.condition || undefined, type: "smoothstep" }))} nodeTypes={NODE_TYPES} nodesDraggable={false} nodesConnectable={false} edgesReconnectable={false} deleteKeyCode={null} onNodeClick={(_, node) => select(node.id)} fitView fitViewOptions={{ maxZoom: 1, padding: 0.25, nodes: [...focusIds].map(id => ({ id })) }} proOptions={{ hideAttribution: true }}><Background gap={20}/><Controls showInteractive={false}/>{selection ? <FocusSelectedStep nodeId={selectedId} /> : null}</ReactFlow></ReactFlowProvider></div> : <Table caption={`${label}: nodes`} columns={[
        { key: "node", header: "Step", render: node => <button className={styles.link} onClick={() => select(node.id)}>{node.name || node.id}</button> },
        { key: "kind", header: "Kind", render: node => node.kind },
        { key: "state", header: "Recorded state", render: node => { const status = STATUS[nodeExecution(execution, node.id, attempt).state]; return <ToneBadge tone={status.tone} icon={status.icon}>{status.text}</ToneBadge>; } },
      ]} rows={nodes} rowKey={node => node.id}/>} 
      {!selection && selected && record ? <aside className={styles.inspector} aria-label="Execution step inspector"><Button size="sm" variant="quiet" icon="x" aria-label="Close execution step" onClick={() => selectLocal(null)}/><span className={styles.kind}>{selected.kind}</span><h3>{selected.name || selected.id}</h3><Id>{selected.id}</Id><ToneBadge tone={STATUS[record.state].tone} icon={STATUS[record.state].icon}>{STATUS[record.state].text}</ToneBadge>
        {typeof selected.config.agentRef === "string" && canReadCatalog(session.actions, "agents") ? <Link to={"/catalogs/agents" as string} search={{ selected: selected.config.agentRef }}>Open agent profile</Link> : null}
        {typeof selected.config.skillId === "string" && canReadCatalog(session.actions, "skills") ? <Link to={"/catalogs/skills" as string} search={{ selected: selected.config.skillId }}>Open skill contract</Link> : null}
        {record.record ? <dl><dt>Attempt / epoch</dt><dd>{record.record.attempt} / {record.record.fencingEpoch}</dd><dt>Started</dt><dd>{record.record.startedAt ? <LocalTimestamp iso={record.record.startedAt}/> : "Not reported"}</dd><dt>Completed</dt><dd>{record.record.completedAt ? <LocalTimestamp iso={record.record.completedAt}/> : "Not reported"}</dd>{record.record.errorCode ? <><dt>Error</dt><dd>{record.record.errorCode}</dd></> : null}{record.record.traceId ? <><dt>Trace</dt><dd><Link to={`/platform/traces/${record.record.traceId}` as string}>Inspect trace</Link></dd></> : null}</dl> : <p>No node attempt is recorded for this selection.</p>}
        {record.record?.humanReview ? <JsonViewer label="Human review" data={record.record.humanReview}/> : null}<JsonViewer label="Step configuration" data={selected.config}/>
      </aside> : null}
    </div>
  </div>;
}
