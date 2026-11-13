import { contextDatasetId } from "@ehf/contracts/context-setup";
import type { CanonicalMapping, ContextResourceBinding, MappingExpression } from "@ehf/contracts";
import { Button, Field, Select } from "@ehf/ui-kit";
import { Background, Controls, Handle, MarkerType, Position, ReactFlow, ReactFlowProvider, type Edge, type Node, type NodeProps } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useMemo, useState } from "react";
import { ExpressionEditor } from "../ExpressionEditor";
import common from "../context.module.css";
import styles from "./ontology.module.css";

type Target = { index: number; field: string };
type MappingNode = Node<{ name: string; rows: string[]; source: boolean; required: string[]; mapped: Set<string>; inspect: (field: string) => void }, "mapping">;
function MappingCard({ data: d }: NodeProps<MappingNode>) {
  return <div className={styles.node} style={{ borderTopColor: d.source ? "var(--context-product-policy)" : "var(--context-product-party360)" }}>
    <div className={styles.nodeHead}><div className={styles.nodeMeta}>{d.source ? "Source columns" : "Canonical output"}</div><strong>{d.name}</strong></div>
    {d.rows.map(row => <div key={row} style={{ position: "relative" }}>
      <button type="button" className={`${styles.fieldRow} nodrag nopan`} onClick={() => d.inspect(row)}><span>{row}{d.required.includes(row) ? " *" : ""}</span><span>{d.source ? "source" : d.mapped.has(row) ? "mapped" : "unmapped"}</span></button>
      <Handle type={d.source ? "source" : "target"} position={d.source ? Position.Right : Position.Left} id={row} style={{ top: "50%" }} />
    </div>)}
  </div>;
}
const NODE_TYPES = { mapping: MappingCard };
/** Reads precisely the expression tree used by the visual/code editor, never another mapping model. */
export function expressionSourcePaths(e: MappingExpression): string[] {
  if (e.op === "field") return [e.path];
  if (e.op === "literal") return [];
  if (e.op === "object") return Object.values(e.fields).flatMap(expressionSourcePaths);
  if (e.op === "array") return e.items.flatMap(expressionSourcePaths);
  if (e.op === "coalesce" || e.op === "concat") return e.values.flatMap(expressionSourcePaths);
  return "value" in e ? expressionSourcePaths(e.value) : [];
}
export function MappingGraph({ mapping, resource, schema, onChange }: {
  mapping: CanonicalMapping; resource: ContextResourceBinding;
  schema: { definitions: Record<string, { properties?: Record<string, unknown>; required?: string[] }> };
  onChange: (m: CanonicalMapping) => void;
}) {
  const [target, setTarget] = useState<Target | null>(null);
  const [pending, setPending] = useState<MappingExpression | null>(null);
  const [source, setSource] = useState(resource.columns[0] ?? "");
  const inspect = (next: Target) => { setTarget(next); setPending(null); };
  const nodes = useMemo((): MappingNode[] => {
    let y = 0;
    return [{ id: "source", type: "mapping", position: { x: 0, y: 0 }, data: { name: contextDatasetId(resource), rows: resource.columns, source: true, required: [], mapped: new Set(), inspect: setSource } },
      ...mapping.outputs.map((o, index): MappingNode => {
        const model = schema.definitions[o.objectType];
        const rows = [...new Set([...Object.keys(model?.properties ?? {}), ...Object.keys(o.fields)])].sort();
        const n: MappingNode = { id: `output-${index}`, type: "mapping", position: { x: 560, y }, data: { name: o.objectType, rows, source: false, required: model?.required ?? [], mapped: new Set(Object.keys(o.fields)), inspect: field => inspect({ index, field }) } };
        y += 130 + rows.length * 32; return n;
      })];
  }, [mapping, resource, schema]);
  const edges = useMemo((): Edge[] => mapping.outputs.flatMap((o, index) => Object.entries(o.fields).flatMap(([field, expr]) => [...new Set(expressionSourcePaths(expr))].filter(path => resource.columns.includes(path)).map(path => ({
    id: `${index}:${field}:${path}`, source: "source", sourceHandle: path, target: `output-${index}`, targetHandle: field,
    label: expr.op === "field" ? "maps to" : expr.op, markerEnd: { type: MarkerType.ArrowClosed },
    ariaLabel: `${path} maps to ${o.objectType}.${field}`, data: { index, field },
  })))), [mapping, resource.columns]);
  const output = target ? mapping.outputs[target.index] : undefined;
  const expression = pending ?? (target && output?.fields[target.field]) ?? { op: "field" as const, path: source || resource.columns[0] || "source" };
  const selectTarget = (value: string) => { const [index, field] = value.split(":"); if (field) inspect({ index: Number(index), field }); };
  return <div className={styles.workspace}>
    <p className={styles.caption}>Source mapping · drag a column to a canonical field, or choose a target below. Review the rule and apply it before saving and retesting this revision. Canonical relationships remain read-only.</p>
    <div className={styles.canvas} data-testid="context-mapping-canvas"><ReactFlowProvider><ReactFlow<MappingNode> nodes={nodes} edges={edges} nodeTypes={NODE_TYPES} nodesDraggable={false} deleteKeyCode={null} fitView fitViewOptions={{ maxZoom: 1, padding: .2 }} minZoom={.05} onEdgeClick={(_, edge) => { if (edge.data) inspect({ index: Number(edge.data.index), field: String(edge.data.field) }); }} onConnect={c => {
      if (c.source !== "source" || !c.sourceHandle || !resource.columns.includes(c.sourceHandle) || !c.target?.startsWith("output-") || !c.targetHandle) return;
      const index = Number(c.target.slice(7)); const field = c.targetHandle;
      if (!Object.hasOwn(schema.definitions[mapping.outputs[index]?.objectType ?? ""]?.properties ?? {}, field)) return;
      setTarget({ index, field }); setPending({ op: "field", path: c.sourceHandle });
    }} proOptions={{ hideAttribution: true }}><Background gap={22} /><Controls showInteractive={false} /></ReactFlow></ReactFlowProvider></div>
    <div className={common.pair}><Field label="Source column"><Select value={source} onChange={e => setSource(e.target.value)}>{resource.columns.map(c => <option key={c}>{c}</option>)}</Select></Field>
      <Field label="Canonical target field"><Select value={target ? `${target.index}:${target.field}` : ""} onChange={e => selectTarget(e.target.value)}><option value="">Choose a target…</option>{mapping.outputs.flatMap((o, i) => [...new Set([...Object.keys(schema.definitions[o.objectType]?.properties ?? {}), ...Object.keys(o.fields)])].sort().map(f => <option key={`${i}:${f}`} value={`${i}:${f}`}>{o.objectType}.{f}</option>))}</Select></Field></div>
    {target && output ? <section className={common.panel} aria-label="Selected mapping rule"><h3>{output.objectType}.{target.field}</h3><p className={styles.caption}>{pending ? "Proposed rule; apply to update this draft." : "Current rule. Changes here remain pending until applied."}</p>
      <ExpressionEditor key={`${target.index}:${target.field}:${pending?.op ?? "current"}`} label={`${output.objectType}.${target.field}`} value={expression} columns={resource.columns} onChange={setPending} />
      <div className={common.row}><Button onClick={() => setPending({ op: "field", path: source })} disabled={!source}>Use selected source column</Button><Button variant="primary" onClick={() => { onChange({ ...mapping, outputs: mapping.outputs.map((o, i) => i === target.index ? { ...o, fields: { ...o.fields, [target.field]: expression } } : o) }); setPending(null); }}>Apply mapping rule</Button>{pending && <Button onClick={() => setPending(null)}>Discard rule change</Button>}</div>
    </section> : <p className={styles.caption}>Select a mapping edge or target field to inspect its expression.</p>}
  </div>;
}
