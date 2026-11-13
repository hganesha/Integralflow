import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import type { Schemas } from "@ehf/ui-contracts";
import { Button, Field, Id, SegmentedControl, Sheet, StaleDataBanner, TextArea, ToneBadge } from "@ehf/ui-kit";
import { useState, type CSSProperties } from "react";
import { api } from "../app/api";
import { useSession } from "../app/session";
import { SourceViewer } from "./SourceViewer";
import { ExtractionPanel, routeName, type DataTab, type ReviewEntry } from "./ExtractionPanel";
import { downloadFile, extractionCsv, extractionExport } from "./export";
import styles from "./documents.module.css";

type Detail = Schemas["CaseDocumentDetail"];
export function DocumentWorkspace({ caseId, detail, documents, onClose, stale, onRefresh }: { caseId: string; detail: Detail; documents: Schemas["CaseDocumentSummary"][]; onClose: () => void; stale: boolean; onRefresh: () => void }) {
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const navigate = useNavigate(); const cache = useQueryClient(); const session = useSession();
  const [hovered, setHovered] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(true);
  const [width, setWidth] = useState(440); const [mobile, setMobile] = useState<"document" | "data">("document");
  const [review, setReview] = useState<{ entries: ReviewEntry[]; resolves: string[]; key: string; sequence: number } | null>(null);
  const [rationale, setRationale] = useState(""); const [message, say] = useState("");
  const [rerunKey, setRerunKey] = useState(() => crypto.randomUUID()); const [runId, setRunId] = useState<string | null>(null);
  const update = (patch: Record<string, unknown>, replace = true) => void navigate({ replace, search: (previous: Record<string, unknown>) => { const next = { ...previous, ...patch }; for (const key of Object.keys(next)) if (next[key] === undefined || next[key] === null) delete next[key]; return next; } } as never);
  const selected = typeof search.field === "string" ? search.field : null;
  const start = search.citationStart;
  const end = search.citationEnd;
  const citationOffset = typeof start === "number" && Number.isInteger(start) && start >= 0
    && typeof end === "number" && Number.isInteger(end) && end > start ? { start, end } : undefined;
  const requestedPage = Number(search.page);
  const page = Number.isFinite(requestedPage) ? Math.max(1, Math.floor(requestedPage)) : 1;
  const tab: DataTab = ["form", "json", "schema"].includes(String(search.view)) ? search.view as DataTab : "form";
  const canReview = session.actions.includes("case.review") && detail.caseSequence !== undefined && !stale;
  const content = useQuery({ queryKey: ["document-content", caseId, detail.document.documentId, detail.document.documentVersion], queryFn: () => api.getFincrimeCasesCaseIdDocumentsDocumentIdContent({ path: { caseId, documentId: detail.document.documentId }, query: { version: detail.document.documentVersion } }), staleTime: Infinity, retry: false });
  const catalog = useQuery({ queryKey: ["document-contract", detail.document.documentType], enabled: Boolean(detail.document.documentType), queryFn: () => api.getCatalogsKindEntryId({ path: { kind: "documents", entryId: detail.document.documentType! } }) });
  const refresh = async () => { await Promise.all([cache.invalidateQueries({ queryKey: ["documents", caseId] }), cache.invalidateQueries({ queryKey: ["document", caseId, detail.document.documentId] }), cache.invalidateQueries({ queryKey: ["getFincrimeCasesCaseIdRoom"] })]); };
  const save = useMutation({ mutationFn: () => api.postFincrimeCasesCaseIdDocumentsDocumentIdReviews({ path: { caseId, documentId: detail.document.documentId }, body: { documentVersion: detail.document.documentVersion, expectedCaseSequence: review!.sequence, entries: review!.entries, ...(review!.resolves.length ? { resolvedWorkItems: review!.resolves } : {}), rationale, idempotencyKey: review!.key } }), onSuccess: async receipt => { if (receipt.outcome !== "ACCEPTED") { say(`Review was ${receipt.outcome.toLowerCase()}. Refresh before retrying.`); await refresh(); return; } await refresh(); setReview(null); say("Review recorded. Extracted assertions remain separate from accepted facts."); }, onError: async () => { await refresh(); } });
  const rerun = useMutation({ mutationFn: () => api.postFincrimeCasesCaseIdDocumentsDocumentIdRerun({ path: { caseId, documentId: detail.document.documentId }, body: { documentVersion: detail.document.documentVersion }, idempotencyKey: rerunKey }), onSuccess: result => { setRunId(result.runId); setRerunKey(crypto.randomUUID()); say("Extraction run admitted. Existing assertions and human reviews are retained."); } });
  const select = (id: string | null) => { const assertion = detail.assertions.find(assertion => assertion.objectId === id); update({ field: id, citationStart: undefined, citationEnd: undefined, page: assertion?.spans[0]?.page ?? page, view: "form" }); if (id) setMobile("data"); };
  const beginReview = (entries: ReviewEntry[], resolves: string[] = []) => { setRationale(""); save.reset(); say(""); setReview({ entries, resolves, key: crypto.randomUUID(), sequence: detail.caseSequence! }); };
  const original = () => { if (!content.data || content.data.documentVersion !== detail.document.documentVersion) return; const bytes = Uint8Array.from(atob(content.data.contentBase64), character => character.charCodeAt(0)); downloadFile(content.data.filename, new Blob([bytes], { type: content.data.mediaType })); };
  const jsonExport = () => downloadFile(`${detail.document.filename ?? detail.document.documentId}.extraction.json`, JSON.stringify(extractionExport(detail), null, 2));
  return <div className={styles.documentWorkspace}>
    {stale ? <StaleDataBanner lastValidAt={null} reason="Document refresh failed. Review actions are paused until the latest version is loaded." onRetry={onRefresh}/> : null}
    <header className={styles.documentHeader}><Button size="sm" variant="quiet" icon="arrowl" onClick={onClose}>All case documents</Button><div className={styles.documentIdentity}><h2>{detail.document.filename ?? detail.document.documentId}</h2><span>{detail.document.mediaType} · {detail.document.pageCount || "Unknown"} pages · <Id>{detail.document.documentVersion.slice(0, 12)}</Id></span></div><ToneBadge tone="attention" icon="eye">Extracted assertions</ToneBadge></header>
    <div className={styles.documentActions}>
      <Button size="sm" className={styles.panelToggle} aria-pressed={panelOpen} onClick={() => setPanelOpen(value => !value)}>{panelOpen ? "Hide extracted data" : "Show extracted data"}</Button>
      <Button size="sm" icon="download" disabled={!content.data} onClick={original}>Download original</Button><Button size="sm" onClick={jsonExport}>Export JSON</Button><Button size="sm" onClick={() => downloadFile(`${detail.document.documentId}.csv`, extractionCsv(detail), "text/csv")}>Export CSV</Button><Button size="sm" onClick={async () => { try { await navigator.clipboard.writeText(JSON.stringify(extractionExport(detail), null, 2)); say("Extraction copied with citations and review provenance."); } catch { say("Clipboard access is unavailable. Use Export JSON."); } }}>Copy JSON</Button><Button size="sm" icon="link" onClick={async () => { try { await navigator.clipboard.writeText(window.location.href); say("Document review link copied."); } catch { say("Clipboard access is unavailable. Copy the address from your browser."); } }}>Share link</Button>
      {session.actions.includes("run.start") && session.actions.includes("case.review") ? <Button size="sm" icon="refresh" busy={rerun.isPending} disabled={stale} onClick={() => rerun.mutate()}>Re-run extraction</Button> : null}
      {detail.document.documentType ? <Link to={"/catalogs/documents" as string} search={{ selected: detail.document.documentType }}>Document type contract</Link> : null}
    </div>
    <p className={styles.workspaceMessage} role="status">{message}{runId ? <> <Link to={`/platform/runs/${encodeURIComponent(runId)}` as string}>Follow extraction run</Link></> : null}</p>
    {rerun.isError ? <p role="alert">Extraction could not start: {rerun.error.message}</p> : null}
    {content.isError ? <p className={styles.viewerNote}>The original file is unavailable: {content.error.message}. Extracted text and citations remain available.</p> : null}
    <div className={styles.mobileSwitch}><SegmentedControl label="Review workspace" value={mobile} onChange={setMobile} options={[{ value: "document", label: "Document" }, { value: "data", label: "Extracted data" }]}/></div>
    <div className={styles.reviewWorkspace} style={{ "--extraction-width": `${width}px` } as CSSProperties} data-mobile={mobile} data-panel={panelOpen ? "open" : "closed"} inert={Boolean(review) || undefined}>
      <nav className={styles.documentList} aria-label="Case document selection">{documents.map(document => <button key={document.documentId} type="button" aria-pressed={document.documentId === detail.document.documentId} onClick={() => update({ document: document.documentId, version: undefined, field: undefined, citationStart: undefined, citationEnd: undefined, page: 1 }, false)}><strong>{document.filename ?? document.documentId}</strong><span>{document.reviewPending} awaiting review</span></button>)}</nav>
      <SourceViewer detail={detail} content={content.data?.documentVersion === detail.document.documentVersion ? content.data : undefined} page={page} onPage={page => update({ page, citationStart: undefined, citationEnd: undefined })} selected={selected} citationOffset={citationOffset} hovered={hovered} onSelect={select} onHover={setHovered}/>
      <div role="separator" aria-label="Resize extraction panel" aria-orientation="vertical" aria-valuemin={320} aria-valuemax={650} aria-valuenow={width} tabIndex={0} className={styles.resizeHandle} onKeyDown={event => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); setWidth(value => Math.min(650, Math.max(320, value + (event.key === "ArrowLeft" ? 20 : -20)))); } }} onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); }} onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId) && event.buttons) setWidth(value => Math.max(320, Math.min(650, value - event.movementX))); }} onPointerUp={event => event.currentTarget.releasePointerCapture(event.pointerId)}/>
      <ExtractionPanel detail={detail} selected={selected} hovered={hovered} onSelect={select} onHover={setHovered} tab={tab} onTab={view => update({ view })} catalog={catalog.data} canReview={canReview} onReview={beginReview} onExport={jsonExport}/>
    </div>
    <Sheet open={Boolean(review)} title="Record document review" description="This records your review and any correction. It does not promote extracted values to accepted facts." onClose={() => { if (!save.isPending) setReview(null); }}>
      {review ? <form className={styles.reviewForm} onSubmit={event => { event.preventDefault(); if (rationale.trim()) save.mutate(); }}><p>{review.entries.length} {review.entries.length === 1 ? "decision" : "decisions"} · based on case sequence {review.sequence}</p><ul>{review.entries.map(entry => <li key={entry.assertionId ?? "document"}>{entry.assertionId ? detail.assertions.find(assertion => assertion.objectId === entry.assertionId)?.field ?? entry.assertionId : "Whole document"}: {entry.outcome}{entry.selectedRoute ? ` · keeps the ${entry.selectedRoute === "manual" ? "reviewer's own value" : `${routeName(entry.selectedRoute)} reading`}` : ""}{entry.outcome === "CORRECTED" ? <pre>{JSON.stringify(entry.correctedValue, null, 2)}</pre> : null}</li>)}</ul>{review.resolves.length ? <p>Resolves {review.resolves.length} route {review.resolves.length === 1 ? "conflict" : "conflicts"}. The decision is also kept as review feedback; it is never used as training data.</p> : null}<Field label="Review rationale"><TextArea required maxLength={4000} rows={4} value={rationale} disabled={save.isPending} onChange={event => setRationale(event.target.value)}/></Field>{save.isError ? <p role="alert">Review was not saved: {save.error.message}. Your decisions are retained.</p> : null}{detail.caseSequence !== review.sequence ? <Button disabled={save.isPending} onClick={() => { save.reset(); setReview({ ...review, key: crypto.randomUUID(), sequence: detail.caseSequence! }); }}>Use latest case sequence {detail.caseSequence}</Button> : null}<Button type="submit" variant="primary" busy={save.isPending} disabled={!rationale.trim() || detail.caseSequence !== review.sequence}>Record review</Button></form> : null}
    </Sheet>
  </div>;
}
