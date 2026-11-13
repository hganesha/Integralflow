import { lazy, Suspense, useMemo, useState } from "react";
import { Button, Id, JsonViewer, SegmentedControl, Select, ToneBadge } from "@ehf/ui-kit";
import { policyTreeModel, policyTreeNodes, type PolicyTreeNode } from "./tree-model";
import styles from "./policy-tree.module.css";
const PolicyGraph = lazy(() => import("./PolicyGraph"));

function Outline({ node, selected, onSelect }: { node: PolicyTreeNode; selected: string; onSelect: (id: string) => void }) {
  return <li><button type="button" aria-pressed={selected === node.id} onClick={() => onSelect(node.id)}><span>{node.kind}</span><strong>{node.title}</strong></button>{node.children.length ? <ul>{node.children.map(child => <li key={child.node.id}><span className={styles.relationship}>{child.label}</span><ul><Outline node={child.node} selected={selected} onSelect={onSelect}/></ul></li>)}</ul> : null}</li>;
}

/** Facet-inspired policy cards and branches, projected from EHF's canonical sources. */
export default function PolicyTree({ sources, compact = false, onOpenSource }: { sources: Record<string, unknown>; compact?: boolean; onOpenSource?: (path: string) => void }) {
  const model = useMemo(() => policyTreeModel(sources), [sources]);
  const [documentPath, setDocument] = useState("");
  const [branchId, setBranch] = useState("");
  const [selectedId, select] = useState("");
  const [view, setView] = useState<"tree" | "outline">(compact ? "outline" : "tree");
  const document = model.documents.find(document => document.path === documentPath) ?? model.documents[0];
  const branch = document?.branches.find(branch => branch.id === branchId) ?? document?.branches[0];
  const root = useMemo<PolicyTreeNode | null>(() => document && branch ? { id: `${document.path}#document`, kind: "policy", title: document.title, description: document.description, sourcePath: "/", raw: document.raw, children: [{ label: document.hitPolicy ? `Hit policy: ${document.hitPolicy}` : "Gate", node: branch.node }] } : null, [document, branch]);
  const nodes = root ? policyTreeNodes(root) : [];
  const selected = nodes.find(node => node.id === selectedId) ?? branch?.node;
  const referenced = selected?.kind === "reference" && typeof selected.raw === "string" ? selected.raw : null;
  return <section className={styles.viewer} aria-label="Policy tree viewer" data-compact={compact || undefined}>
    <header className={styles.header}><div><h3>Policy tree</h3><p>Read the declared conditions and outcomes. Evaluation results come from the policy engine.</p></div><ToneBadge tone="neutral" icon="eye">Read only</ToneBadge></header>
    {model.errors.map(error => <p role="alert" key={error.path}><Id>{error.path}</Id>: {error.message}</p>)}
    {document ? <>
      <div className={styles.toolbar}><Select aria-label="Policy source" value={document.path} onChange={event => { setDocument(event.target.value); setBranch(""); select(""); }}>{model.documents.map(document => <option key={document.path} value={document.path}>{document.id}</option>)}</Select><SegmentedControl label="Policy representation" value={view} onChange={setView} options={[{ value: "tree", label: "Tree" }, { value: "outline", label: "Outline" }]}/>{onOpenSource ? <Button size="sm" onClick={() => onOpenSource(document.path)}>Open source</Button> : null}</div>
      <p className={styles.order}>{document.hitPolicy === "first" ? "The first matching row wins. Rows below retain their source order." : document.hitPolicy ? `Declared hit policy: ${document.hitPolicy}.` : "Gate structure and table references follow the source."} No rule has been evaluated in this viewer.</p>
      <div className={styles.body}>
        <nav className={styles.branches} aria-label="Policy gates and rows">{document.branches.map(entry => <button type="button" key={entry.id} aria-pressed={entry.id === branch?.id} onClick={() => { setBranch(entry.id); select(""); }}><strong>{entry.label}</strong><span>{entry.description}</span></button>)}</nav>
        <div className={styles.content}>{root ? view === "tree" ? <Suspense fallback={<p>Loading policy tree…</p>}><PolicyGraph key={root.children[0]!.node.id} root={root} selected={selected?.id ?? ""} onSelect={select}/></Suspense> : <div className={styles.outline} role="region" aria-label="Policy outline" tabIndex={0}><ul><Outline node={root} selected={selected?.id ?? ""} onSelect={select}/></ul></div> : <p>No gates or rows are declared in this source.</p>}</div>
      </div>
      {selected ? <section className={styles.inspector} aria-label="Policy node details"><div><span className={styles.kind}>{selected.kind}</span><h4>{selected.title}</h4>{selected.description ? <p>{selected.description}</p> : null}<Id>{`${document.path}#${selected.sourcePath}`}</Id></div>{referenced && model.documents.some(document => document.path === referenced) ? <Button size="sm" onClick={() => { setDocument(referenced); setBranch(""); select(""); }}>Follow decision table</Button> : null}<JsonViewer label="Declared node source" data={selected.raw} maxHeight={280}/></section> : null}
    </> : <p>No Policy or DecisionTable source is available here. The source contract remains available in its original view.</p>}
  </section>;
}
