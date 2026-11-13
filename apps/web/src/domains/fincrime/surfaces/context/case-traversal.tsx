import type { Schemas } from "@ehf/ui-contracts";
import { Button, DigestValue, Field, Id, InspectorSection, Select, TextInput } from "@ehf/ui-kit";
import { Link } from "@tanstack/react-router";
import { lazy, Suspense, useRef, useState } from "react";
import { api } from "../../../../app/api";
import { ApiErrorView, useSearchParam } from "../../../../platform/common";
import { StudioFrame } from "../../../../shell/studio-frame";
import { CONTEXT_PATH } from "../../context/links";
import common from "../../context/context.module.css";
import styles from "../../context/ontology/ontology.module.css";
const Canvas = lazy(() => import("../../context/ontology/CaseTraversalCanvas"));
type Graph = Schemas["CaseTraversalGraph"];
type Request = Schemas["CaseTraversalRequest"];
export default function CaseTraversal() {
  const [caseId, setCaseId] = useSearchParam("case");
  const [planDigest, setPlanDigest] = useSearchParam("plan");
  const [nodeId, setNodeId] = useSearchParam("node");
  const [sourceContext, setSourceContext] = useSearchParam("sourceContext");
  const [rootType, setRootType] = useState("Entity"), [rootId, setRootId] = useState(""), [rootVersion, setRootVersion] = useState("");
  const [subjects, setSubjects] = useState(""), [asOf, setAsOf] = useState(""), [cutoff, setCutoff] = useState("");
  const [depth, setDepth] = useState(1), [direction, setDirection] = useState<"both" | "incoming" | "outgoing">("both"), [pageSize, setPageSize] = useState(25);
  const [result, setResult] = useState<{ graph: Graph; request: Request; caseId: string } | null>(null);
  const [error, setError] = useState<unknown>(null), [busy, setBusy] = useState(false), [list, setList] = useState(false), [selected, setSelected] = useState<string | null>(null);
  const generation = useRef(0);
  const run = async (request: Request, selectedCase: string, append = false) => {
    const current = ++generation.current; setBusy(true); setError(null);
    if (!append) { setResult(null); setSelected(null); }
    try {
      const response = await api.call("postFincrimeCasesCaseIdContextTraverse", { path: { caseId: selectedCase }, body: request });
      if (!response.data || current !== generation.current) return;
      const data = response.data;
      setResult(previous => {
        const graph = append && previous ? { ...data,
          truncated: previous.graph.truncated || data.truncated,
          complete: data.complete && !previous.graph.truncated,
          nodes: [...new Map([...previous.graph.nodes, ...data.nodes].map(n => [n.key, n])).values()],
          edges: [...new Map([...previous.graph.edges, ...data.edges].map(e => [e.id, e])).values()],
          unresolved: [...previous.graph.unresolved, ...data.unresolved] } : data;
        return { graph, caseId: selectedCase, request: { ...request, query: { ...request.query, asOf: data.asOf, knowledgeCutoff: data.knowledgeCutoff } } };
      });
    } catch (caught) { if (current === generation.current) setError(caught); }
    finally { if (current === generation.current) setBusy(false); }
  };
  const query = (): Request => ({ planDigest: planDigest!, nodeId: nodeId!, ...(sourceContext ? { sourceContextDigest: sourceContext } : {}), query: {
    direction, maxDepth: depth, pageSize, ...(rootId ? { root: { objectType: rootType, objectId: rootId, ...(rootVersion ? { versionId: rootVersion } : {}) } } : {}),
    ...(subjects.trim() ? { subjects: subjects.split(",").map(s => s.trim()).filter(Boolean) } : {}), ...(asOf ? { asOf } : {}), ...(cutoff ? { knowledgeCutoff: cutoff } : {}),
  } });
  const selectedRecord = result?.graph.nodes.find(n => n.key === selected);
  const pivot = () => {
    if (!result || !selectedRecord) return;
    const root = { objectType: selectedRecord.objectType, objectId: selectedRecord.objectId, versionId: selectedRecord.versionId };
    setRootType(root.objectType); setRootId(root.objectId); setRootVersion(root.versionId);
    void run({ ...result.request, query: { ...result.request.query, cursor: undefined, root } }, result.caseId);
  };
  return <StudioFrame labels={{ inspector: "Case record inspector" }} inspector={selectedRecord ? <div className={common.inspector}>
    <header><div className="t-engraved">Authorized case record</div><h2 className={common.inspectorTitle}>{selectedRecord.objectType}</h2><Id>{selectedRecord.objectId}</Id></header>
    <Button disabled={busy} onClick={pivot}>Explore from this record</Button>
    <InspectorSection title="Exact version and time" defaultOpen><p className={styles.caption}>Version {selectedRecord.versionId}<br />Observed {selectedRecord.observedAt}<br />Recorded {selectedRecord.recordedAt}<br />Valid from {selectedRecord.validFrom ?? "unbounded"}<br />Valid to {selectedRecord.validTo ?? "unbounded"}<br />Classification {selectedRecord.classification}</p></InspectorSection>
    <InspectorSection title="Projected attributes" defaultOpen><pre className={common.codeBlock}>{JSON.stringify(selectedRecord.data, null, 2)}</pre></InspectorSection>
    <InspectorSection title="Unresolved references" defaultOpen>{result!.graph.unresolved.filter(u => u.source === selectedRecord.key).map((u, i) => <p className={styles.caption} key={i}>{u.field}: {u.reason.replaceAll("_", " ")}</p>)}</InspectorSection>
  </div> : undefined}>
    <div className={`${common.page} ${styles.boardPage}`}>
      <header className={common.header}><div><div className="t-engraved">FinCrime context · CXT-07</div><h1 className={common.title}>Case relationships</h1><p className={styles.caption}>Explore the case records authorized by a pinned plan and step, beyond a single context packet.</p></div><Link to={CONTEXT_PATH}>Back to Contextboard</Link></header>
      <section className={common.panel} aria-label="Case traversal scope"><div className={common.selectorGrid}>
        <Field label="Case ID"><TextInput value={caseId ?? ""} onChange={e => setCaseId(e.target.value || undefined)} /></Field>
        <Field label="Pinned plan digest"><TextInput mono value={planDigest ?? ""} onChange={e => setPlanDigest(e.target.value || undefined)} /></Field>
        <Field label="Plan step / node ID"><TextInput value={nodeId ?? ""} onChange={e => setNodeId(e.target.value || undefined)} /></Field>
        <Field label="Approved source context digest"><TextInput mono value={sourceContext ?? ""} onChange={e => setSourceContext(e.target.value || undefined)} /></Field>
      </div><details><summary>Root, subjects and time</summary><div className={common.selectorGrid}>
        <Field label="Root object type"><TextInput value={rootType} onChange={e => setRootType(e.target.value)} /></Field><Field label="Root object ID"><TextInput value={rootId} onChange={e => setRootId(e.target.value)} placeholder="Automatic if empty" /></Field><Field label="Exact root version (optional)"><TextInput value={rootVersion} onChange={e => setRootVersion(e.target.value)} /></Field>
        <Field label="Subjects (comma separated)"><TextInput value={subjects} onChange={e => setSubjects(e.target.value)} placeholder="All authorized case subjects" /></Field>
        <Field label="Business valid time (ISO)"><TextInput value={asOf} onChange={e => setAsOf(e.target.value)} placeholder="Current time" /></Field><Field label="Knowledge cutoff (ISO)"><TextInput value={cutoff} onChange={e => setCutoff(e.target.value)} placeholder="Current time" /></Field>
      </div></details><div className={common.selectorGrid}>
        <Field label="Relationship direction"><Select value={direction} onChange={e => setDirection(e.target.value as typeof direction)}><option value="both">Both directions</option><option value="outgoing">Outgoing</option><option value="incoming">Incoming</option></Select></Field>
        <Field label="Traversal depth"><Select value={depth} onChange={e => setDepth(Number(e.target.value))}>{[0,1,2,3,4].map(n => <option key={n}>{n}</option>)}</Select></Field>
        <Field label="Records per page"><Select value={pageSize} onChange={e => setPageSize(Number(e.target.value))}>{[10,25,50].map(n => <option key={n}>{n}</option>)}</Select></Field>
      </div><Button variant="primary" busy={busy} disabled={!caseId || !planDigest || !nodeId} onClick={() => void run(query(), caseId!)}>Explore case</Button></section>
      {error ? <ApiErrorView error={error} /> : null}
      {result ? <section className={styles.workspace} aria-label="Case relationship results">
        <p className={styles.caption}>{result.graph.nodes.length} loaded record versions · {result.graph.edges.length} relationships · {result.graph.unresolved.length} unresolved references. {result.graph.truncated ? "Graph limit reached; narrow the scope." : result.graph.nextCursor ? "More records available." : "Requested neighborhood loaded."}</p>
        <p className={styles.caption}>Purpose {result.graph.purpose} · as of {result.graph.asOf} · known by {result.graph.knowledgeCutoff} · snapshot <DigestValue value={result.graph.snapshotDigest} /></p>
        <div className={common.row}><Button size="sm" aria-pressed={list} onClick={() => setList(v => !v)}>{list ? "Show graph" : "Show record list"}</Button>{result.graph.nextCursor ? <Button disabled={busy || Boolean(error)} onClick={() => void run({ ...result.request, query: { ...result.request.query, cursor: result.graph.nextCursor! } }, result.caseId, true)}>Load more relationships</Button> : null}</div>
        {!result.graph.nodes.length ? <p>No records are visible in this authorized scope.</p> : list ? <ul className={styles.relations}>{result.graph.nodes.map(n => <li key={n.key}><button className={styles.link} type="button" onClick={() => setSelected(n.key)}>{n.objectType} · {n.objectId}</button><small>Version {n.versionId}</small></li>)}</ul> : <Suspense fallback={<p role="status">Loading graph…</p>}><Canvas graph={result.graph} onSelect={setSelected} /></Suspense>}
        <details><summary>Scope and completeness</summary><ul>{result.graph.limitations.map(l => <li key={l}>{l}</li>)}</ul></details>
      </section> : <p className={styles.caption}>Choose a case and its pinned plan step. Traversal performs no execution or case mutation.</p>}
    </div>
  </StudioFrame>;
}
