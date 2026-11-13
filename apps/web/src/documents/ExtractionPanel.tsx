import type { Schemas } from "@ehf/ui-contracts";
import { Button, Field, Id, JsonViewer, SegmentedControl, Table, TextArea, TextInput, ToneBadge } from "@ehf/ui-kit";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { extractionExport } from "./export";
import styles from "./documents.module.css";
type Detail = Schemas["CaseDocumentDetail"];
export type ReviewEntry = Schemas["DocumentReviewEntry"];
type Assertion = Detail["assertions"][number];
type CorrectionDraft = { editing: boolean; value: string; error: string };
const EMPTY_DRAFT: CorrectionDraft = { editing: false, value: "", error: "" };
export type DataTab = "form" | "json" | "schema";
type WorkItem = NonNullable<Detail["workItems"]>[number];
/** Record review entries; `resolves` names the route-conflict work items this decision settles. */
export type OnReview = (entries: ReviewEntry[], resolves?: string[]) => void;
const ROUTE_OUTCOME: Record<string, string> = { AGREED_GROUNDED: "Routes agree", SELECTED_GROUNDED: "One route grounded", SINGLE_ROUTE: "One route only", UNGROUNDED: "Not grounded in the text",
  CONFLICT: "Routes disagree", VALIDATION_FAILED: "Failed validation", NOT_PRESENT: "Not found", OCR_DISAGREEMENT: "Text and image readings differ" };
export const routeName = (route: string) => route === "llm" ? "LLM extraction" : route === "azure_di" ? "Document model" : route.replaceAll("_", " ");
const WORK_TYPE: Record<string, string> = { DOCUMENT_FIELD_CONFLICT: "Route conflict", DOCUMENT_FIELD_REVIEW: "Field review", DOCUMENT_EVIDENCE_GAP: "Missing key field", DOCUMENT_CLASSIFICATION: "Classification" };
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
/** How the routes compared on one value, and, while its conflict is open, a choice between their readings. */
function RouteOutcome({ assertion, conflict, canReview, onReview }: { assertion: Assertion; conflict: WorkItem | undefined; canReview: boolean; onReview: OnReview }) {
  const routes = assertion.routes;
  if (!routes) return null;
  const disputed = ["CONFLICT", "VALIDATION_FAILED", "OCR_DISAGREEMENT"].includes(routes.outcome);
  const keep = (route: string, value: unknown) => {
    const base = { assertionId: assertion.objectId, assertionVersion: assertion.versionId ?? "", selectedRoute: route };
    onReview([same(value, assertion.value) ? { ...base, outcome: "CHECKED" } : { ...base, outcome: "CORRECTED", correctedValue: value }], conflict ? [conflict.workItemId] : []);
  };
  return <div className={styles.routeOutcome} data-disputed={disputed || undefined}>
    <ToneBadge tone={disputed ? "blocking" : routes.outcome === "AGREED_GROUNDED" ? "neutral" : "attention"} icon={disputed ? "alert" : "check"}>{ROUTE_OUTCOME[routes.outcome] ?? routes.outcome}</ToneBadge>
    <span>{routes.routeMode} · proposed by {routeName(routes.proposedRoute)} · rule {routes.rule}</span>
    {disputed || routes.outcome !== "AGREED_GROUNDED" ? <ul aria-label={`Route readings for ${assertion.field.replaceAll("_", " ")}`}>{routes.candidates.map(candidate => <li key={candidate.route}>
      <strong>{routeName(candidate.route)}</strong>: {candidate.value === null || candidate.value === undefined ? "nothing read" : JSON.stringify(candidate.value)}{candidate.grounded ? " · found in the text" : " · not found in the text"}
      {canReview && conflict?.status === "OPEN" && candidate.value !== null && candidate.value !== undefined ? <Button size="sm" variant="quiet" onClick={() => keep(candidate.route, candidate.value)}>Keep this reading</Button> : null}
    </li>)}</ul> : null}
    {conflict ? <p>{conflict.status === "OPEN" ? "Open route conflict: check the source, then keep one reading or edit the value." : "Route conflict resolved."}</p> : null}
  </div>;
}
export function reviewLabel(assertion: Assertion) { return assertion.review?.outcome === "CHECKED" ? "Reviewed" : assertion.review?.outcome === "CORRECTED" ? "Human correction" : assertion.review?.outcome === "REJECTED" ? "Rejected" : "Awaiting review"; }
function StructuredValue({ value }: { value: unknown }) {
  if (Array.isArray(value) && value.length && value.every(row => row && typeof row === "object" && !Array.isArray(row))) {
    const keys = [...new Set(value.flatMap(row => Object.keys(row)))];
    return <div className={styles.nestedTable}><Table caption="Extracted rows" columns={keys.map(key => ({ key, header: key.replaceAll("_", " "), render: (item: { row: Record<string, unknown>; id: number }) => typeof item.row[key] === "object" ? JSON.stringify(item.row[key]) : String(item.row[key] ?? "") }))} rows={value.map((row, id) => ({ row, id }))} rowKey={item => String(item.id)}/></div>;
  }
  return <pre className={styles.fieldValue}>{typeof value === "string" ? value : JSON.stringify(value, null, 2)}</pre>;
}
function AssertionRow({ assertion, selected, onSelect, onHover, canReview, onReview, draft, onDraft, conflict }: { assertion: Assertion; selected: boolean; onSelect: () => void; onHover: (id: string | null) => void; canReview: boolean; onReview: OnReview; draft: CorrectionDraft; onDraft: (patch: Partial<CorrectionDraft>) => void; conflict: WorkItem | undefined }) {
  const { editing, value, error } = draft;
  const setEditing = (editing: boolean) => onDraft({ editing });
  const setValue = (value: string) => onDraft({ value });
  const setError = (error: string) => onDraft({ error });
  const current = assertion.review?.outcome === "CORRECTED" ? assertion.review.correctedValue : assertion.value;
  const entry = (outcome: ReviewEntry["outcome"]): ReviewEntry => ({ assertionId: assertion.objectId, assertionVersion: assertion.versionId ?? "", outcome });
  // A decision on a value with an open route conflict settles that conflict too.
  const resolves = (outcome: ReviewEntry["outcome"]) => conflict?.status === "OPEN" && outcome !== "RESET" ? [conflict.workItemId] : [];
  return <article className={styles.fieldRow} data-selected={selected || undefined} data-assertion={assertion.objectId} onMouseEnter={() => onHover(assertion.objectId)} onMouseLeave={() => onHover(null)}>
    <div className={styles.fieldHeading}><button type="button" className={styles.fieldSelect} onClick={onSelect} aria-pressed={selected}>{assertion.field.replaceAll("_", " ")}</button><ToneBadge tone={assertion.review?.outcome === "REJECTED" ? "blocking" : assertion.review && assertion.review.outcome !== "RESET" ? "neutral" : "attention"} icon={assertion.review && assertion.review.outcome !== "RESET" ? "check" : "eye"}>{reviewLabel(assertion)}</ToneBadge></div>
    <StructuredValue value={current}/>
    {assertion.review?.outcome === "CORRECTED" ? <details><summary>Original extracted value</summary><StructuredValue value={assertion.value}/></details> : null}
    <RouteOutcome assertion={assertion} conflict={conflict} canReview={canReview} onReview={onReview}/>
    <div className={styles.fieldMeta}><span>{assertion.spans.length ? `Page ${[...new Set(assertion.spans.map(span => span.page))].join(", ")}` : "No citation"}</span>{assertion.confidence !== undefined && assertion.confidence !== null ? <span>Model confidence {Math.round(assertion.confidence * 100)}%</span> : <span>Confidence not reported</span>}<Id>{assertion.path}</Id></div>
    {assertion.review ? <p className={styles.reviewBy}>{assertion.review.actor} · {assertion.review.rationale}</p> : null}
    {canReview ? <div className={styles.fieldActions}><Button size="sm" variant="quiet" disabled={assertion.review?.outcome === "CORRECTED" || assertion.review?.outcome === "CHECKED"} onClick={() => onReview([entry("CHECKED")], resolves("CHECKED"))}>Mark reviewed</Button><Button size="sm" variant="quiet" onClick={() => { setValue(typeof current === "string" ? current : JSON.stringify(current, null, 2)); setError(""); setEditing(!editing); }}>{editing ? "Cancel edit" : "Edit value"}</Button><Button size="sm" variant="quiet" onClick={() => onReview([entry("REJECTED")], resolves("REJECTED"))}>Reject</Button>{assertion.review && assertion.review.outcome !== "RESET" ? <Button size="sm" variant="quiet" onClick={() => onReview([entry("RESET")])}>Reset review</Button> : null}</div> : null}
    {editing ? <div className={styles.valueEditor}><Field label={`Corrected ${assertion.field}`} hint={typeof assertion.value === "string" ? "Your correction is stored separately from the extraction." : "Edit JSON, including complete nested rows."}><TextArea value={value} rows={Array.isArray(current) ? 8 : 3} onChange={event => setValue(event.target.value)}/></Field>{error ? <p role="alert">{error}</p> : null}<Button size="sm" onClick={() => { let correctedValue: unknown = value; if (typeof assertion.value !== "string") { try { correctedValue = JSON.parse(value); } catch { setError("Enter valid JSON for this structured value."); return; } } onReview([{ ...entry("CORRECTED"), correctedValue, ...(conflict?.status === "OPEN" ? { selectedRoute: "manual" } : {}) }], resolves("CORRECTED")); setEditing(false); }}>Review correction</Button></div> : null}
  </article>;
}
export function ExtractionPanel({ detail, selected, hovered, onSelect, onHover, tab, onTab, catalog, canReview, onReview, onExport, preview = false }: {
  detail: Detail; selected: string | null; hovered: string | null; onSelect: (id: string) => void; onHover: (id: string | null) => void; tab: DataTab; onTab: (tab: DataTab) => void;
  catalog: Schemas["CatalogEntry"] | undefined; canReview: boolean; onReview: OnReview; onExport: () => void; preview?: boolean;
}) {
  const workItems = detail.workItems ?? [];
  const conflictOf = (assertion: Assertion) => workItems.find(item => item.workType === "DOCUMENT_FIELD_CONFLICT" && item.assertionId === assertion.objectId && item.status === "OPEN")
    ?? workItems.find(item => item.workType === "DOCUMENT_FIELD_CONFLICT" && item.assertionId === assertion.objectId);
  const openWork = workItems.filter(item => item.status === "OPEN");
  const [query, setQuery] = useState(""); const [reviewOnly, setReviewOnly] = useState(false);
  // Schema loading may move a field into another group. Keep unsaved edits by assertion
  // version above the groups, rather than in rows that regrouping can unmount.
  const [drafts, setDrafts] = useState<Record<string, CorrectionDraft>>({});
  const scroll = useRef<HTMLDivElement>(null);
  useEffect(() => { if (selected && tab === "form") scroll.current?.querySelector<HTMLElement>(`[data-assertion="${CSS.escape(selected)}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" }); }, [selected, tab]);
  const shown = detail.assertions.filter(assertion => `${assertion.field} ${JSON.stringify(assertion.value)}`.toLowerCase().includes(query.toLowerCase()) && (!reviewOnly || !assertion.review || ["REJECTED", "RESET"].includes(assertion.review.outcome)));
  const pendingVisible = shown.filter(assertion => !assertion.review || assertion.review.outcome === "RESET");
  const pendingBatch = pendingVisible.slice(0, 200);
  const fields = catalog?.contract.field_definitions as Array<{ name: string; section?: string; value_type?: string }> | undefined;
  const sectionOf = (assertion: Assertion) => fields?.find(field => field.name === assertion.field)?.section ?? (assertion.field.split(".").slice(0, -1).join(".") || "Extracted fields");
  const groups = [...new Set(shown.map(sectionOf))];
  return <section className={styles.dataPane} aria-label="Extracted data">
    <div className={styles.extractionHeader}><div><h3>Extracted data</h3><span>{detail.assertions.length} assertions · {detail.document.reviewPending} awaiting review</span></div><Button size="sm" variant="quiet" icon="download" aria-label="Export extracted data" onClick={onExport}/></div>
    <SegmentedControl label="Extraction view" value={tab} onChange={onTab} options={[{ value: "form", label: "Fields" }, { value: "json", label: "JSON" }, { value: "schema", label: "Schema" }]}/>
    <div className={styles.dataScroll} ref={scroll}>
      {tab === "form" ? <>
        {workItems.length ? <section className={styles.workItems} aria-label="Document work items"><h4>Work items · {openWork.length} open</h4><ul>{workItems.map(item => <li key={item.workItemId}>
          <ToneBadge tone={item.status === "OPEN" ? item.workType === "DOCUMENT_FIELD_CONFLICT" ? "blocking" : "attention" : "neutral"} icon={item.status === "OPEN" ? "alert" : "check"}>{WORK_TYPE[item.workType] ?? item.workType} · {item.status === "OPEN" ? "open" : "resolved"}</ToneBadge>
          <span>{item.description ?? item.workType}</span>
          {item.assertionId ? <Button size="sm" variant="quiet" onClick={() => onSelect(item.assertionId!)}>Go to field</Button> : null}
        </li>)}</ul></section> : null}
        <TextInput aria-label="Find extracted field" placeholder="Find a field or value…" value={query} onChange={event => setQuery(event.target.value)}/>
        <div className={styles.fieldActions}><Button size="sm" aria-pressed={reviewOnly} onClick={() => setReviewOnly(!reviewOnly)}>Needs review</Button>{canReview ? <Button size="sm" variant="quiet" disabled={!pendingVisible.length} onClick={() => onReview(pendingBatch.map(assertion => ({ assertionId: assertion.objectId, assertionVersion: assertion.versionId ?? "", outcome: "CHECKED" })))}>Review visible fields ({pendingBatch.length})</Button> : null}</div>
        {groups.map(group => <details open key={group} className={styles.fieldGroup}><summary>{group.replaceAll("_", " ")} · {shown.filter(assertion => sectionOf(assertion) === group).length}</summary>{shown.filter(assertion => sectionOf(assertion) === group).map(assertion => <div key={`${assertion.objectId}:${assertion.versionId}`} data-hovered={hovered === assertion.objectId || undefined}><AssertionRow conflict={conflictOf(assertion)} draft={drafts[`${assertion.objectId}:${assertion.versionId}`] ?? EMPTY_DRAFT} onDraft={patch => setDrafts(previous => { const key = `${assertion.objectId}:${assertion.versionId}`; return { ...previous, [key]: { ...EMPTY_DRAFT, ...previous[key], ...patch } }; })} assertion={assertion} selected={assertion.objectId === selected} onSelect={() => onSelect(assertion.objectId)} onHover={onHover} canReview={canReview} onReview={onReview}/></div>)}</details>)}
        {!shown.length ? <p>No extracted fields match this view.</p> : null}
        {detail.conflicts.length ? <section className={styles.conflictPanel}><h4>Cross-document conflicts</h4>{detail.conflicts.map(conflict => <div key={conflict.field}><strong>{conflict.field}</strong><ul>{conflict.values.map((value, index) => <li key={index}>{JSON.stringify(value.value)} · <Id>{value.documentVersion.slice(0, 12)}</Id></li>)}</ul></div>)}</section> : null}
      </> : tab === "json" ? <JsonViewer label="Extraction with source citations and human reviews" data={extractionExport(detail)} maxHeight={700}/> : <>
        <h4>{catalog?.title ?? detail.document.documentType ?? "Document field contract"}</h4>
        {catalog ? <><p>{catalog.description}</p><Table caption="Document field contract" columns={[{ key: "name", header: "Field", render: field => <Id>{field.name}</Id> }, { key: "description", header: "Contract", render: field => field.description }, { key: "key", header: "Key field", render: field => field.key ? "Required for completeness" : "" }]} rows={catalog.fields} rowKey={field => field.name}/><JsonViewer label="Source field contract" data={catalog.contract}/></> : <p>The catalog contract is unavailable for this document type.</p>}
        {detail.document.documentType ? <Link to={"/catalogs/documents" as string} search={{ selected: detail.document.documentType }}>Open document type in catalog</Link> : null}
      </>}
    </div>
    <div className={styles.reviewFooter}>{preview ? <p>Studio preview · unverified test assertions. Review and acceptance take place in a case.</p> : <><p>Review records remain separate from accepted case facts.</p>{canReview ? <Button variant="primary" disabled={!detail.assertions.length || detail.document.reviewPending > 0} onClick={() => onReview([{ assertionId: null, assertionVersion: null, outcome: "CHECKED" }])}>{detail.review?.outcome === "CHECKED" ? "Review completed" : "Complete document review"}</Button> : <p>Recording reviews needs case.review.</p>}</>}</div>
  </section>;
}
