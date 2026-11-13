import { Background, Controls, Handle, Position, ReactFlow, ReactFlowProvider, type Node, type NodeProps } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { PolicyTreeNode } from "./tree-model";
import styles from "./policy-tree.module.css";
type Card = Node<{ item: PolicyTreeNode; active: boolean }, "policyCard">;
function PolicyCard({ data }: NodeProps<Card>) {
  const node = data.item;
  return <div className={styles.card} data-kind={node.kind} data-selected={data.active || undefined}>
    {node.kind !== "policy" ? <Handle type="target" position={Position.Left}/> : null}
    <span className={styles.kind}>{node.kind === "all" ? "AND" : node.kind === "any" ? "OR" : node.kind}</span><strong>{node.title}</strong>{node.description ? <span className={styles.description}>{node.description}</span> : null}
    {node.children.length ? <Handle type="source" position={Position.Right}/> : null}
  </div>;
}
const NODE_TYPES = { policyCard: PolicyCard };
export default function PolicyGraph({ root, selected, onSelect }: { root: PolicyTreeNode; selected: string; onSelect: (id: string) => void }) {
  const nodes: Card[] = [], edges: Array<{ id: string; source: string; target: string; label: string; type: string }> = [];
  let leaf = 0;
  const visit = (item: PolicyTreeNode, depth: number): number => {
    const childPositions = item.children.map(child => { edges.push({ id: `${item.id}:${child.node.id}`, source: item.id, target: child.node.id, label: child.label, type: "smoothstep" }); return visit(child.node, depth + 1); });
    const y = childPositions.length ? (childPositions[0]! + childPositions.at(-1)!) / 2 : leaf++ * 180;
    nodes.push({ id: item.id, type: "policyCard", position: { x: depth * 340, y }, data: { item, active: selected === item.id }, ariaLabel: `${item.kind}: ${item.title}`, selected: selected === item.id });
    return y;
  };
  visit(root, 0);
  return <div className={styles.canvas} role="region" aria-label="Policy rule tree"><ReactFlowProvider><ReactFlow<Card> nodes={nodes} edges={edges} nodeTypes={NODE_TYPES} onNodeClick={(_, node) => onSelect(node.id)} nodesDraggable={false} nodesConnectable={false} edgesReconnectable={false} deleteKeyCode={null} fitView fitViewOptions={{ padding: .2, maxZoom: 1 }} proOptions={{ hideAttribution: true }}><Background gap={20}/><Controls showInteractive={false}/></ReactFlow></ReactFlowProvider></div>;
}
