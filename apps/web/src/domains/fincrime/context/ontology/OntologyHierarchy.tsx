import type { OntologyObject, OntologyRelation, OntologyView } from "@ehf/fincrime-views";
import { bankName } from "../model";
import { ontologyLanes } from "./model";
import type { OntologySelection } from "./selection";
import styles from "./ontology.module.css";
/** Containment hierarchy, not a fabricated relationship tree: cross-links stay explicit. */
export function OntologyHierarchy({ view, objects, relations, expanded, onToggle, onSelect, selection }: {
  view: OntologyView; objects: OntologyObject[]; relations: OntologyRelation[]; expanded: Set<string>; onToggle: (id: string) => void; onSelect: (s: OntologySelection) => void; selection: OntologySelection;
}) {
  const lanes = ontologyLanes(objects, view.products.map(p => p.id));
  return <section className={styles.hierarchy} aria-label="Ontology hierarchy" data-testid="context-ontology-hierarchy">
    <p className={styles.caption}>Lane → product → object → fields. Relationships are cross-links between canonical types.</p>
    {lanes.map(lane => <details key={lane.id} className={styles.treeLane} open>
      <summary>{lane.name} <span>{lane.objects.length} object types</span></summary>
      <ul>{[...new Set(lane.objects.map(o => o.productIds[0] ?? "Other types"))].map(product => <li key={product}>
        <details open><summary>{bankName(product)}</summary><ul>{lane.objects.filter(o => (o.productIds[0] ?? "Other types") === product).map(object => <li key={object.id}>
          <details open={expanded.has(object.id)} onToggle={e => { if (e.target === e.currentTarget && e.currentTarget.open !== expanded.has(object.id)) onToggle(object.id); }} data-selected={selection?.kind === "object" && selection.id === object.id}>
            <summary>{object.id} <span>{object.fields.filter(f => f.depth === 0).length} fields</span></summary>
            <button type="button" className={styles.link} onClick={() => onSelect({ kind: "object", id: object.id })}>Inspect {object.id}</button>
            <ul aria-label={`${object.id} fields`}>{object.fields.map(field => <li key={field.path}><button type="button" className={styles.link} onClick={() => onSelect({ kind: "object", id: object.id, field: field.path })}>{field.path}{field.required ? " *" : ""}</button><small>{field.type}</small></li>)}</ul>
            <ul aria-label={`${object.id} relationships`}>{relations.filter(r => r.source === object.id).map(r => <li key={r.id}><button type="button" className={styles.link} onClick={() => onSelect({ kind: "relation", id: r.id })}>{r.field} → {r.target}</button><small>{r.label}{r.multiple ? " · many" : ""}</small></li>)}</ul>
          </details>
        </li>)}</ul></details>
      </li>)}</ul>
    </details>)}
  </section>;
}
