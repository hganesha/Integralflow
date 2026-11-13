import type { Schemas } from "@ehf/ui-contracts";
import { Background, Controls, MarkerType, ReactFlow, ReactFlowProvider, useNodesInitialized, useReactFlow, type Node, type Edge } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useEffect, useMemo } from "react";
import styles from "./ontology.module.css";
type Graph = Schemas["CaseTraversalGraph"];
function FitLoadedRecords({ count }: { count: number }) {
  const initialized = useNodesInitialized();
  const { fitView } = useReactFlow();
  useEffect(() => { if (initialized) void fitView({ padding: .2, maxZoom: 1 }); }, [initialized, count, fitView]);
  return null;
}
export default function CaseTraversalCanvas({ graph, onSelect }: { graph: Graph; onSelect: (key: string) => void }) {
  const nodes: Node[] = useMemo(() => graph.nodes.map((n, i) => ({ id: n.key, position: { x: Math.floor(i / 5) * 360, y: i % 5 * 150 },
    data: { label: `${n.objectType}\n${n.objectId}\n${n.versionId}` }, ariaLabel: `${n.objectType} ${n.objectId}, version ${n.versionId}`,
    style: { background: "var(--surface-raised)", color: "var(--ink-1)", border: "1px solid var(--line-2)", borderRadius: 8, width: 270, whiteSpace: "pre-line", overflowWrap: "anywhere", fontSize: 13 } })), [graph.nodes]);
  const edges: Edge[] = useMemo(() => graph.edges.map(e => ({ ...e, label: e.label, markerEnd: { type: MarkerType.ArrowClosed }, ariaLabel: `${e.field}, ${e.label}`, labelStyle: { fill: "var(--ink-1)" }, labelBgStyle: { fill: "var(--surface-raised)" } })), [graph.edges]);
  return <div className={styles.canvas} data-testid="case-traversal-canvas"><ReactFlowProvider><ReactFlow nodes={nodes} edges={edges} nodesConnectable={false} nodesDraggable={false} deleteKeyCode={null}
    onNodeClick={(_, n) => onSelect(n.id)} onNodesChange={changes => { const n = changes.find(c => c.type === "select" && c.selected); if (n?.type === "select") onSelect(n.id); }}
    fitView fitViewOptions={{ padding: .2, maxZoom: 1 }} minZoom={.08} proOptions={{ hideAttribution: true }}><FitLoadedRecords count={graph.nodes.length} /><Background gap={22} /><Controls showInteractive={false} /></ReactFlow></ReactFlowProvider></div>;
}
