import { ontologyNeighborhood, type OntologyView } from "@ehf/fincrime-views";
import { Button, EmptyState, Field, TextInput } from "@ehf/ui-kit";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { bankName } from "../model";
import { OntologyHierarchy } from "./OntologyHierarchy";
import { PRODUCT_COLORS } from "./model";
import type { OntologySelection } from "./selection";
import styles from "./ontology.module.css";
const Canvas = lazy(() => import("./OntologyCanvas"));
export function OntologyBoard({ view, productId, agentId, presentation, selection, onSelect }: {
  view: OntologyView; productId: string | undefined; agentId: string | null; presentation: string; selection: OntologySelection; onSelect: (s: OntologySelection) => void;
}) {
  const workspace = useRef<HTMLDivElement>(null);
  const [hierarchy, setHierarchy] = useState(() => window.innerWidth <= 680);
  useEffect(() => {
    const element = workspace.current; if (!element) return;
    const update = () => setHierarchy(window.innerWidth <= 680 || element.clientWidth < 480);
    update(); const observer = new ResizeObserver(update); observer.observe(element);
    window.addEventListener("resize", update);
    return () => { observer.disconnect(); window.removeEventListener("resize", update); };
  }, []);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState(new Set<string>());
  const toggle = useCallback((id: string) => setExpanded(prev => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; }), []);
  const relation = selection?.kind === "relation" ? view.edges.find(e => e.id === selection.id) : undefined;
  const focus = selection?.kind === "object" ? selection.id : relation?.source;
  const neighborhood = useMemo(() => ontologyNeighborhood(view, productId, query, focus), [view, productId, query, focus]);
  const products = view.products.filter(p => neighborhood.nodes.some(n => n.productIds.includes(p.id)));
  return <div ref={workspace} className={styles.workspace}>
    <div className={styles.toolbar}>
      <Field label="Search ontology"><TextInput value={query} onChange={e => setQuery(e.target.value)} placeholder="Object, field or relationship…" /></Field>
      <Button size="sm" onClick={() => setExpanded(new Set(neighborhood.nodes.map(n => n.id)))}>Expand fields</Button>
      <Button size="sm" onClick={() => setExpanded(new Set())}>Collapse fields</Button>
    </div>
    <p className={styles.caption}><b>{productId ? bankName(productId) : "Complete ontology"}</b> · {neighborhood.nodes.length} of {view.nodes.length} object types · {neighborhood.edges.length} relationships. Schema definitions; open Case relationships to traverse authorized records.</p>
    {!neighborhood.nodes.length ? <EmptyState icon="graph" title="No matching objects" headingLevel={2}>Try another field or object name, or select another context product.</EmptyState> : presentation === "list" ? <div className={styles.list}>
      {neighborhood.nodes.map(n => <section key={n.id} className={styles.listItem} style={{ "--object-color": PRODUCT_COLORS[n.productIds[0]!] } as CSSProperties}>
        <h3><button type="button" className={styles.link} onClick={() => onSelect({ kind: "object", id: n.id })}>{n.id}</button></h3>
        <p className={styles.caption}>{n.productIds.map(bankName).join(", ")}{!neighborhood.seeds.has(n.id) ? " · Related type" : ""}</p>
        <details open={expanded.has(n.id)} onToggle={e => { if (e.currentTarget.open !== expanded.has(n.id)) toggle(n.id); }}><summary>{n.fields.filter(f => f.depth === 0).length} fields</summary>
          {n.fields.map(f => <div key={f.path}><button type="button" className={styles.link} onClick={() => onSelect({ kind: "object", id: n.id, field: f.path })}>{f.path}{f.required ? " *" : ""} · {f.type}</button></div>)}
        </details>
        <ul className={styles.relations}>{neighborhood.edges.filter(e => e.source === n.id).map(e => <li key={e.id}><button type="button" className={styles.link} onClick={() => onSelect({ kind: "relation", id: e.id })}>{e.field} → {e.target}</button><small>{e.label}</small></li>)}</ul>
      </section>)}
    </div> : hierarchy ? <OntologyHierarchy view={view} objects={neighborhood.nodes} relations={neighborhood.edges} expanded={expanded} onToggle={toggle} onSelect={onSelect} selection={selection} /> : <Suspense fallback={<p role="status">Loading ontology canvas…</p>}><Canvas view={view} objects={neighborhood.nodes} relations={neighborhood.edges} seeds={neighborhood.seeds} selection={selection} onSelect={onSelect} agentId={agentId} expanded={expanded} onToggle={toggle} /></Suspense>}
    <div className={styles.legend} aria-label="Ontology legend">{products.map(p => <span key={p.id} style={{ "--object-color": PRODUCT_COLORS[p.id] } as CSSProperties}><i className={styles.dot} />{bankName(p.id)}</span>)}<span>* Schema required</span><span>Dashed border: related type outside focus</span></div>
  </div>;
}
