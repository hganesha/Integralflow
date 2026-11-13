import type { ContextDefinitionRevision } from "@ehf/contracts";
import type { OntologyView } from "@ehf/fincrime-views";
import { DigestValue, EmptyState, Id, InspectorSection, TextInput } from "@ehf/ui-kit";
import { Link, useSearch } from "@tanstack/react-router";
import { useState } from "react";
import { bankName } from "../model";
import { CONTEXT_PATH, CONTEXT_SETUP_PATH, skillPath } from "../links";
import { consumerFields } from "./model";
import type { OntologySelection } from "./selection";
import common from "../context.module.css";
import styles from "./ontology.module.css";

export function OntologyInspector({ view, selection, onSelect, agentId, definitions }: {
  view: OntologyView; selection: OntologySelection; onSelect: (s: OntologySelection) => void; agentId: string | null; definitions: ContextDefinitionRevision[] | undefined;
}) {
  const [filter, setFilter] = useState("");
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  if (!selection) return <EmptyState icon="graph" title="Explore your context model" headingLevel={2}>Select an object, field or relationship to inspect its contract, consumers and source mappings.</EmptyState>;
  const relation = selection.kind === "relation" ? view.edges.find(e => e.id === selection.id) : undefined;
  const object = view.nodes.find(n => n.id === (selection.kind === "object" ? selection.id : relation?.source));
  if (!object || (selection.kind === "relation" && !relation)) return <EmptyState icon="graph" title="Selection no longer available" headingLevel={2}>The selected definition is absent from this catalog revision. Select an object in the graph.</EmptyState>;
  const selectedField = selection.kind === "object" ? selection.field : relation?.field;
  const setupScope = { ...search, object: object.id, field: selectedField, relation: undefined, product: object.productIds[0], ...(agentId ? { agent: agentId } : {}) };
  const fields = object.fields.filter(f => (!selectedField || f.path === selectedField || f.path.startsWith(`${selectedField}.`) || f.path.startsWith(`${selectedField}[]`)) && (!filter || `${f.path} ${f.type}`.toLowerCase().includes(filter.toLowerCase())));
  const consumers = consumerFields(view, agentId, object);
  const mappings = definitions?.filter(d => d.definition.kind === "mapping" && d.definition.outputs.some(o => o.objectType === object.id));
  const relationships = view.edges.filter(e => e.source === object.id || e.target === object.id);
  return <div className={common.inspector}>
    <header><div className="t-engraved">{relation ? "Canonical relationship" : selectedField ? "Canonical field" : "Canonical object"}</div><h2 className={common.inspectorTitle}>{relation ? relation.label : object.id}</h2>{selectedField && <Id>{`${object.id}.${selectedField}`}</Id>}</header>
    {relation ? <InspectorSection title="Relationship definition" defaultOpen>
      <p><button type="button" className={styles.link} onClick={() => onSelect({ kind: "object", id: relation.source })}>{relation.source}</button> → <button type="button" className={styles.link} onClick={() => onSelect({ kind: "object", id: relation.target })}>{relation.target}</button></p>
      <p className={styles.caption}>{relation.description}</p><dl className={styles.fields}><div><dt>Representation</dt><dd>{relation.representation.replaceAll("_", " ")}</dd></div><div><dt>Source field</dt><dd>{relation.multiple ? "Multiple references" : "Single reference"} · {relation.optional ? "Optional" : "Required"}</dd></div><div><dt>Target cardinality</dt><dd>{relation.targetCardinality ?? "Not constrained by the canonical schema"}</dd></div><div><dt>Resolution</dt><dd>{relation.resolution.replaceAll("_", " ")}</dd></div></dl>
    </InspectorSection> : null}
    <InspectorSection title="Context products" defaultOpen><div className={common.chips}>{object.productIds.map(p => <Link key={p} to={CONTEXT_PATH} search={{ ...search, product: p, object: object.id, relation: undefined, field: undefined }}>{bankName(p)}</Link>)}</div></InspectorSection>
    <InspectorSection title={selectedField ? "Field contract" : "Fields"} count={object.fields.length} defaultOpen>
      <TextInput aria-label="Filter inspected fields" placeholder="Filter fields…" value={filter} onChange={e => setFilter(e.target.value)} />
      {selectedField && !object.fields.some(f => f.path === selectedField) ? <p role="status">This field no longer exists in the current schema.</p> : null}
      <dl className={styles.fields}>{fields.map(f => <div key={f.path}><dt><button type="button" className={styles.link} onClick={() => onSelect({ kind: "object", id: object.id, field: f.path })}>{f.path}</button></dt><dd>{f.type} · {f.required ? "Schema required" : "Optional"}{f.depth ? " in parent object" : ""}{f.nullable ? " · Nullable" : ""}</dd>{f.values.length ? <dd>Values: {f.values.join(", ")}</dd> : null}{f.constraints.map(c => <dd key={c}>{c}</dd>)}{f.description && <dd>{f.description}</dd>}{consumers.required.has(f.root) && <dd>{consumers.ceiling && !consumers.ceiling.has(f.root) ? "Required by consumer · Outside agent ceiling" : "Required by consumer"}</dd>}{consumers.ceiling?.has(f.root) && <dd>Within agent field ceiling</dd>}</div>)}</dl>
      {selectedField && <button type="button" className={styles.link} onClick={() => onSelect({ kind: "object", id: object.id })}>Show all {object.id} fields</button>}
    </InspectorSection>
    <InspectorSection title="Relationships" count={relationships.length} defaultOpen><ul className={styles.relations}>{relationships.map(e => <li key={e.id}><button type="button" className={styles.link} onClick={() => onSelect({ kind: "relation", id: e.id })}>{e.source}.{e.field} → {e.target}</button><small>{e.label} · {e.representation.replaceAll("_", " ")}</small></li>)}</ul>{!relationships.length && <p className={styles.caption}>No typed relationships are declared for this object. Shared value types and untyped IDs do not imply links.</p>}</InspectorSection>
    <InspectorSection title="Consumer requirements" count={consumers.requirements.length}><p className={styles.caption}>Access coverage describes the agent ceiling. Live records, freshness and task readiness require case assessment.</p><ul className={styles.relations}>{consumers.requirements.filter(r => !selectedField || r.field === selectedField.split(".")[0]).map((r, i) => <li key={`${r.skill_id}:${r.field}:${i}`}><Link to={skillPath(r.skill_id)}>{r.skill_id}</Link><small>{r.field} · {r.required ? "Required" : "Optional"} · min {r.min_count} · {r.freshness_policy ?? "No fixed freshness limit"}</small></li>)}</ul></InspectorSection>
    <InspectorSection title="Source mappings" count={mappings?.length} defaultOpen>{mappings === undefined ? <p>Source inventory unavailable.</p> : !mappings.length ? <p className={styles.caption}>No source mapping supplies this object.</p> : mappings.map(m => <div key={m.digest}><Link to={(`/context/mappings/${encodeURIComponent(m.definition.id)}` as string)} search={setupScope}>{m.definition.kind === "mapping" ? m.definition.name : m.definition.id}</Link><p className={styles.caption}>Revision {m.revision} · inspect sample qualification in setup</p></div>)}<Link to={CONTEXT_SETUP_PATH} search={{ ...setupScope, tab: "mappings" }}>View field sources and mappings</Link><Link to={CONTEXT_SETUP_PATH} search={{ ...setupScope, tab: "connections" }}>Connect source / Edit mappings</Link></InspectorSection>
    <InspectorSection title="Schema provenance"><dl className={styles.fields}><div><dt>Schema</dt><dd>{view.schemaVersion}</dd></div><div><dt>Ontology digest</dt><dd><DigestValue value={view.ontologyDigest} /></dd></div><div><dt>Relationship catalog</dt><dd>{view.relationshipVersion}</dd></div><div><dt>Projection digest</dt><dd><DigestValue value={view.projectionDigest} /></dd></div></dl></InspectorSection>
  </div>;
}
