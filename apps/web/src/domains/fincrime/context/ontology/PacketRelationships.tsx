import type { Schemas } from "@ehf/ui-contracts";
import { DigestValue, Button } from "@ehf/ui-kit";
import { Background, Controls, MarkerType, ReactFlow, ReactFlowProvider, type Node, type Edge } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useMemo, useState } from "react";
import styles from "./ontology.module.css";
type Graph = Schemas["ContextRecordGraph"];
export default function PacketRelationships({ graph }: { graph: Graph }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [list, setList] = useState(false);
  const nodes: Node[] = useMemo(() => graph.nodes.map((n, i) => ({ id: n.key, position: { x: Math.floor(i / 6) * 370, y: (i % 6) * 145 }, data: { label: `${n.objectType}\n${n.objectId}\n${n.versionId}` }, ariaLabel: `${n.objectType} ${n.objectId}, version ${n.versionId}`, style: { background: "var(--surface-raised)", color: "var(--ink-1)", border: "1px solid var(--line-2)", borderRadius: 8, width: 270, fontSize: 12, overflowWrap: "anywhere", whiteSpace: "pre-line" } })), [graph]);
  const edges: Edge[] = useMemo(() => graph.edges.map(e => ({ id: e.id, source: e.source, target: e.target, label: e.label, markerEnd: { type: MarkerType.ArrowClosed }, ariaLabel: `${e.field}, ${e.label}`, labelStyle: { fill: "var(--ink-1)" }, labelBgStyle: { fill: "var(--surface-raised)" } })), [graph]);
  const record = graph.nodes.find(n => n.key === selected);
  return <section className={styles.workspace} aria-label="Packet relationships">
    <h3>Case relationships in this packet</h3><p className={styles.caption}>{graph.nodes.length} authorized record versions · {graph.edges.length} resolved relationships · {graph.unresolved.length} unresolved references. This is the selected task packet, not the complete case graph.{graph.truncated ? " Display limit reached." : ""} No additional records are fetched.</p>
    <p className={styles.caption}>As of {graph.asOfTime ?? "unspecified"} · Snapshot <DigestValue value={graph.snapshotDigest} /></p>
    <Button size="sm" onClick={() => setList(v => !v)}>{list ? "Show relationship graph" : "Show record list"}</Button>
    {!graph.nodes.length ? <p>No canonical record sections were admitted into this packet.</p> : list ? <ul className={styles.relations}>{graph.nodes.map(n => <li key={n.key}><button type="button" className={styles.link} onClick={() => setSelected(n.key)}>{n.objectType} · {n.objectId}</button><small>Version {n.versionId} · fields: {n.fields.join(", ")}</small></li>)}</ul> : <div className={styles.canvas}><ReactFlowProvider><ReactFlow nodes={nodes} edges={edges} nodesConnectable={false} nodesDraggable={false} deleteKeyCode={null} onNodeClick={(_, node) => setSelected(node.id)} fitView fitViewOptions={{ maxZoom: 1, padding: .2 }} minZoom={.05} proOptions={{ hideAttribution: true }}><Background gap={22} /><Controls showInteractive={false} /></ReactFlow></ReactFlowProvider></div>}
    {record && <div className={styles.notice}><strong>{record.objectType} · {record.objectId}</strong><p>Exact version: {record.versionId}<br />Observed: {record.observedAt}<br />Projected fields: {record.fields.join(", ")}</p><ul className={styles.relations}>{graph.edges.filter(e => e.source === record.key || e.target === record.key).map(e => <li key={e.id}>{e.label} → {graph.nodes.find(n => n.key === (e.source === record.key ? e.target : e.source))?.objectId}</li>)}</ul>{graph.unresolved.filter(u => u.source === record.key).map((u, i) => <p key={i}>{u.field}: {u.reason.replaceAll("_", " ")}. The target was not resolved within this authorized packet.</p>)}</div>}
  </section>;
}
