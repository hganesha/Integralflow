import { BaseEdge, Background, Controls, EdgeLabelRenderer, Handle, MarkerType, MiniMap, Position, ReactFlow, ReactFlowProvider, useNodesState, useReactFlow, type Edge, type EdgeProps, type Node, type NodeProps } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Button } from "@ehf/ui-kit";
import type { OntologyObject, OntologyRelation, OntologyView } from "@ehf/fincrime-views";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { bankName } from "../model";
import type { OntologySelection } from "./selection";
import { consumerFields, ontologyLayout, sizeKey, PRODUCT_COLORS, type CardSize } from "./model";
import styles from "./ontology.module.css";

type ObjectNode = Node<{ object: OntologyObject; expanded: boolean; boundary: boolean; dim: boolean; required: Set<string>; ceiling: Set<string> | null; select: (s: OntologySelection) => void; toggle: (id: string) => void; measure: (key: string, size: CardSize) => void }, "object">;
type LaneNode = Node<{ name: string; count: number }, "lane">;
type GraphNode = ObjectNode | LaneNode;
type RelationEdge = Edge<{ relation: OntologyRelation; routeY?: number; sameLane: boolean; labelX: number; active: boolean }>;
function ObjectCard({ data: d, selected }: NodeProps<ObjectNode>) {
  const element = useRef<HTMLDivElement>(null);
  const measurementKey = sizeKey(d.object.id, d.expanded);
  useLayoutEffect(() => {
    const card = element.current; if (!card) return;
    const report = () => d.measure(measurementKey, { width: card.offsetWidth, height: card.offsetHeight });
    report(); const observer = new ResizeObserver(report); observer.observe(card);
    return () => observer.disconnect();
  }, [measurementKey, d.measure]);
  const roots = d.object.fields.filter(f => f.depth === 0);
  return <div ref={element} className={styles.node} data-selected={selected} data-boundary={d.boundary} data-dim={d.dim} style={{ "--object-color": PRODUCT_COLORS[d.object.productIds[0]!] ?? "var(--ink-3)" } as CSSProperties}>
    {[Position.Left, Position.Right].map(position => <span key={position}><Handle id={`target-${position}`} type="target" position={position} isConnectable={false} /><Handle id={`source-${position}`} type="source" position={position} isConnectable={false} /></span>)}
    <div className={styles.nodeHead}>
      <div className={styles.nodeMeta}><span><i className={styles.dot} />{bankName(d.object.productIds[0] ?? "Context")}</span><span>{d.boundary ? "Related type" : "Canonical"}</span></div>
      <div className={styles.nodeTitle}><strong>{d.object.id}</strong><Button className="nodrag nopan" size="sm" variant="quiet" icon={d.expanded ? "minus" : "plus"} aria-label={`${d.expanded ? "Collapse" : "Expand"} ${d.object.id} fields`} aria-expanded={d.expanded} onClick={e => { e.stopPropagation(); d.toggle(d.object.id); }} /></div>
    </div>
    {d.expanded && roots.slice(0, 8).map(f => <button key={f.path} type="button" className={`${styles.fieldRow} nodrag nopan`} data-gap={d.required.has(f.root) && d.ceiling !== null && !d.ceiling.has(f.root)} onClick={e => { e.stopPropagation(); d.select({ kind: "object", id: d.object.id, field: f.path }); }}><span>{f.path}{f.required ? " *" : ""}</span><span>{f.type}</span></button>)}
    <div className={styles.nodeFoot}><span>{roots.length} fields · {roots.filter(f => f.required).length} required</span><span>{d.required.size ? `${d.required.size} consumer fields` : "Schema"}</span></div>
  </div>;
}
function Lane({ data }: NodeProps<LaneNode>) {
  return <div className={styles.lane}><strong>{data.name}</strong><span>{data.count} object types</span></div>;
}
function RelationshipEdge(props: EdgeProps<RelationEdge>) {
  const right = props.sourcePosition === Position.Right;
  const exit = props.sourceX + (right ? 20 : -20);
  const entry = props.targetX + (props.targetPosition === Position.Right ? 20 : -20);
  const route = props.data?.routeY ?? props.sourceY;
  const path = props.data?.sameLane
    ? `M ${props.sourceX} ${props.sourceY} L ${exit} ${props.sourceY} L ${exit} ${props.targetY} L ${props.targetX} ${props.targetY}`
    : `M ${props.sourceX} ${props.sourceY} L ${exit} ${props.sourceY} L ${exit} ${route} L ${entry} ${route} L ${entry} ${props.targetY} L ${props.targetX} ${props.targetY}`;
  const x = props.data?.sameLane ? props.data.labelX : (exit + entry) / 2;
  const y = route;
  const r = props.data?.relation;
  return <><BaseEdge id={props.id} path={path} markerEnd={props.markerEnd} interactionWidth={24} />{r && (props.data?.active || props.selected) && <EdgeLabelRenderer><span aria-hidden="true" className={styles.edgeLabel} style={{ pointerEvents: "none", transform: `translate(-50%,-50%) translate(${x}px,${y}px)` }}>{r.label}{r.multiple ? " · many" : ""}</span></EdgeLabelRenderer>}</>;
}
const NODE_TYPES = { object: ObjectCard, lane: Lane };
const EDGE_TYPES = { relation: RelationshipEdge };
function Canvas({ view, objects, relations, seeds, selection, onSelect, agentId, expanded, onToggle }: {
  view: OntologyView; objects: OntologyObject[]; relations: OntologyRelation[]; seeds: Set<string>; selection: OntologySelection; onSelect: (s: OntologySelection) => void;
  agentId: string | null; expanded: Set<string>; onToggle: (id: string) => void;
}) {
  const { fitView, setViewport, getViewport } = useReactFlow();
  const container = useRef<HTMLDivElement>(null);
  const [measured, setMeasured] = useState(new Map<string, CardSize>());
  const measure = useCallback((key: string, size: CardSize) => setMeasured(previous => {
    if (!size.width || !size.height || previous.get(key)?.width === size.width && previous.get(key)?.height === size.height) return previous;
    const next = new Map(previous); next.set(key, size); return next;
  }), []);
  const [hoveredEdge, setHoveredEdge] = useState<string | null>(null);
  const selectedEdge = selection?.kind === "relation" ? relations.find(r => r.id === selection.id) : undefined;
  const focus = selection?.kind === "object" ? selection.id : undefined;
  const neighborhood = useMemo(() => new Set(relations.filter(r => r.source === focus || r.target === focus).flatMap(r => [r.source, r.target])), [focus, relations]);
  const structure = objects.map(n => n.id).join("|");
  const layout = useMemo(() => ontologyLayout(objects, view.products.map(p => p.id), expanded, measured, relations), [objects, view.products, expanded, measured, relations]);
  const build = useMemo((): GraphNode[] => [
    ...layout.lanes.map(lane => ({ id: `lane:${lane.id}`, type: "lane" as const, position: { x: lane.x, y: lane.y }, style: { width: lane.width, height: lane.height }, data: { name: lane.name, count: lane.objects.length }, selectable: false, focusable: false, draggable: false, zIndex: -1 })),
    ...objects.map(object => {
      const f = consumerFields(view, agentId, object);
      const rect = layout.rectangles.get(object.id)!;
      return { id: object.id, type: "object" as const, position: { x: rect.x, y: rect.y }, selected: object.id === focus || object.id === selectedEdge?.source || object.id === selectedEdge?.target,
        ariaLabel: `${object.id}, ${bankName(object.productIds[0] ?? "context")}, canonical object`,
        data: { object, expanded: expanded.has(object.id), boundary: !seeds.has(object.id), dim: Boolean(focus && object.id !== focus && !neighborhood.has(object.id)), required: f.required, ceiling: f.ceiling, select: onSelect, toggle: onToggle, measure } };
    }),
  ], [objects, layout, view, agentId, expanded, seeds, focus, selectedEdge, neighborhood, onSelect, onToggle, measure]);
  const [nodes, setNodes, onNodesChange] = useNodesState<GraphNode>(build);
  useLayoutEffect(() => setNodes(build), [build, setNodes]);
  const edges: RelationEdge[] = useMemo(() => relations.map(r => {
    const source = layout.rectangles.get(r.source)!, target = layout.rectangles.get(r.target)!;
    const sameLane = source.lane === target.lane;
    return { id: r.id, source: r.source, target: r.target, sourceHandle: source.lane <= target.lane ? "source-right" : "source-left", targetHandle: sameLane || source.lane > target.lane ? "target-right" : "target-left", type: "relation", selected: selection?.kind === "relation" && selection.id === r.id,
      data: { relation: r, ...(layout.routes.has(r.id) ? { routeY: layout.routes.get(r.id)! } : {}), sameLane, labelX: source.x + source.width / 2, active: hoveredEdge === r.id }, markerEnd: { type: MarkerType.ArrowClosed }, ariaLabel: `${r.source}.${r.field} ${r.label} ${r.target}` };
  }), [relations, layout, selection, hoveredEdge]);
  const readable = useCallback((laneX = 0) => {
    const width = container.current?.clientWidth ?? 800;
    const zoom = Math.min(1, Math.max(.8, (width - 48) / Math.max(1, layout.width)));
    void setViewport({ x: 16 - laneX * zoom, y: 16, zoom });
  }, [layout.width, setViewport]);
  useEffect(() => { readable(); }, [structure, readable]);
  return <>
    <div className={styles.switch}><Button size="sm" onClick={() => readable()}>Readable view</Button><Button size="sm" onClick={() => void fitView({ nodes: nodes.filter(n => n.type === "object"), padding: .15, maxZoom: 1 })}>Fit graph</Button><span className={styles.caption}>Fixed lanes · pan or zoom to explore · select a relationship to inspect it</span></div>
    <nav className={styles.laneNav} aria-label="Graph lanes">{layout.lanes.map(lane => <Button key={lane.id} size="sm" onClick={() => { const zoom = Math.max(.8, getViewport().zoom); void setViewport({ x: 16 - lane.x * zoom, y: 16, zoom }); }}>{lane.name} · {lane.objects.length}</Button>)}</nav>
    <div ref={container} className={styles.canvas} data-testid="context-ontology-canvas"><ReactFlow<GraphNode, RelationEdge> nodes={nodes} edges={edges} nodeTypes={NODE_TYPES} edgeTypes={EDGE_TYPES} onNodesChange={changes => { onNodesChange(changes); const selected = changes.find(c => c.type === "select" && c.selected); if (selected?.type === "select" && !selected.id.startsWith("lane:")) onSelect({ kind: "object", id: selected.id }); }}
      onEdgesChange={changes => { const selected = changes.find(c => c.type === "select" && c.selected); if (selected?.type === "select") onSelect({ kind: "relation", id: selected.id }); }} onEdgeMouseEnter={(_, e) => setHoveredEdge(e.id)} onEdgeMouseLeave={() => setHoveredEdge(null)}
      onNodeClick={(_, n) => { if (n.type === "object") onSelect({ kind: "object", id: n.id }); }} onNodeDoubleClick={(_, n) => { if (n.type === "object") onToggle(n.id); }} onEdgeClick={(_, e) => onSelect({ kind: "relation", id: e.id })}
      onPaneClick={() => onSelect(null)} nodesConnectable={false} nodesDraggable={false} nodesFocusable edgesFocusable deleteKeyCode={null} multiSelectionKeyCode={null} selectionKeyCode={null} zoomOnDoubleClick={false}
      minZoom={.03} maxZoom={1.8} proOptions={{ hideAttribution: true }}>
      <Background gap={22} size={1} color="var(--line-2)" /><Controls showInteractive={false} /><MiniMap<GraphNode> nodeColor={n => n.type === "object" ? PRODUCT_COLORS[n.data.object.productIds[0]!] ?? "var(--ink-3)" : "var(--surface-well)"} maskColor="var(--surface-well)" pannable zoomable style={{ background: "var(--surface-panel)", width: 140, height: 90 }} />
    </ReactFlow></div>
  </>;
}
export default function OntologyCanvas(props: Parameters<typeof Canvas>[0]) { return <ReactFlowProvider><Canvas {...props} /></ReactFlowProvider>; }
