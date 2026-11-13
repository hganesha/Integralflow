import type { Schemas } from "@ehf/ui-contracts";
import { Button, SegmentedControl, Select } from "@ehf/ui-kit";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { highlightRuns, type CitationOffset, type Highlight } from "./highlight";
import styles from "./documents.module.css";
const PdfPage = lazy(() => import("./PdfPage"));
type Detail = Schemas["CaseDocumentDetail"];
type Content = Schemas["DocumentContent"];
export function SourceViewer({ detail, content, page, onPage, selected, citationOffset, hovered, onSelect, onHover }: {
  detail: Detail; content: Content | undefined; page: number; onPage: (page: number) => void; selected: string | null; citationOffset?: CitationOffset; hovered: string | null; onSelect: (id: string | null) => void; onHover: (id: string | null) => void;
}) {
  const [mode, setMode] = useState<"original" | "text">("text");
  const [zoom, setZoom] = useState(1);
  const [annotations, setAnnotations] = useState(true);
  const [nativePages, setNativePages] = useState(0);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const source = detail.pages.find(source => source.page === page);
  const count = Math.max(nativePages, detail.document.pageCount, ...detail.pages.map(source => source.page), 1);
  const region = useRef<HTMLDivElement>(null);
  const onPages = useCallback((count: number) => setNativePages(count), []);
  useEffect(() => {
    if (!content?.mediaType.startsWith("image/")) return;
    const bytes = Uint8Array.from(atob(content.contentBase64), character => character.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: content.mediaType })); setImageUrl(url);
    return () => { URL.revokeObjectURL(url); setImageUrl(null); };
  }, [content]);
  const citationStart = citationOffset?.start;
  const citationEnd = citationOffset?.end;
  const isSelected = (highlight: Highlight) => highlight.ref === selected
    && (citationStart === undefined || (highlight.start === citationStart && highlight.end === citationEnd));
  useEffect(() => {
    if (selected) region.current?.querySelector<HTMLElement>('[data-selected="true"]')?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [selected, citationStart, citationEnd, page, mode, source]);
  const highlights = annotations ? source?.highlights ?? [] : [];
  const pdf = content?.mediaType === "application/pdf";
  const originalAvailable = pdf || Boolean(imageUrl);
  const geometry = source?.geometry;
  const rects = geometry ? highlights.filter(highlight => highlight.rect) : [];
  return <section className={styles.sourcePane} aria-label="Document viewer">
    <div className={styles.viewerToolbar}>
      <Button size="sm" variant="quiet" icon="arrowl" aria-label="Previous page" disabled={page <= 1} onClick={() => onPage(page - 1)}/>
      <Select aria-label="Document page" value={page} onChange={event => onPage(Number(event.target.value))}>{Array.from({ length: count }, (_, index) => <option value={index + 1} key={index}>Page {index + 1} of {count}</option>)}</Select>
      <Button size="sm" variant="quiet" icon="arrowr" aria-label="Next page" disabled={page >= count} onClick={() => onPage(page + 1)}/>
      <Button size="sm" variant="quiet" aria-label="Zoom out" disabled={zoom <= 0.5} onClick={() => setZoom(value => Math.max(0.5, value - 0.1))}>−</Button><Button size="sm" variant="quiet" aria-label="Reset zoom" onClick={() => setZoom(1)}>{Math.round(zoom * 100)}%</Button><Button size="sm" variant="quiet" aria-label="Zoom in" disabled={zoom >= 2} onClick={() => setZoom(value => Math.min(2, value + 0.1))}>+</Button>
      <Button size="sm" variant="quiet" aria-label="Fit document to width" onClick={() => { const element = region.current?.querySelector("canvas,img"); if (mode === "original" && element && region.current) setZoom(Math.max(.1, Math.min(2, (region.current.clientWidth - 32) / (element.getBoundingClientRect().width / zoom)))); else setZoom(1); }}>Fit</Button>
      <Button size="sm" variant="quiet" aria-pressed={annotations} onClick={() => setAnnotations(value => !value)}>Annotations {annotations ? "on" : "off"}</Button>
      {originalAvailable ? <SegmentedControl label="Source representation" size="sm" value={mode} onChange={setMode} options={[{ value: "text", label: "Cited text" }, { value: "original", label: "Original" }]}/> : null}
    </div>
    <div className={styles.pageStage} ref={region} tabIndex={0} role="region" aria-label={`Document page ${page}`}>
      {mode === "original" && originalAvailable ? <>
        <div className={styles.originalPage}>
          {pdf && content ? <Suspense fallback={<p>Rendering original PDF…</p>}><PdfPage contentBase64={content.contentBase64} page={page} scale={zoom} onPages={onPages}/></Suspense> : imageUrl ? <img src={imageUrl} alt={`Original document page ${page}`} style={{ width: `${(geometry?.width ?? 660) * zoom}px`, maxWidth: "none" }}/> : null}
          {geometry ? <div className={styles.overlays}>{rects.map((highlight, index) => <button type="button" key={`${highlight.ref}-${index}`} data-ref={highlight.ref} data-selected={isSelected(highlight) || undefined} data-active={isSelected(highlight) || highlight.ref === hovered || undefined} aria-label={`Source citation for ${highlight.field ?? "evidence"}`} onClick={() => onSelect(highlight.ref)} onMouseEnter={() => onHover(highlight.ref)} onMouseLeave={() => onHover(null)} style={{ left: `${highlight.rect!.x / geometry.width * 100}%`, top: `${highlight.rect!.y / geometry.height * 100}%`, width: `${highlight.rect!.width / geometry.width * 100}%`, height: `${highlight.rect!.height / geometry.height * 100}%` }}/>)}</div> : null}
        </div>
        {annotations ? <p className={styles.viewerNote}>{rects.length ? "Boxes show source regions. Cited text shows the exact extracted spans." : "This extraction has text citations. Use Cited text to inspect their exact spans."}</p> : null}
      </> : source ? <article className={styles.paper} style={{ fontSize: `${zoom}em` }}><div className={styles.paperLabel}>Page {page} · normalized source text · Unicode code-point offsets</div><pre className={styles.citedText}>
        {highlightRuns(source.text, highlights, isSelected).map((run, index) => run.highlight ? <button type="button" key={index} className={styles.citation} data-ref={run.highlight.ref} data-selected={isSelected(run.highlight) || undefined} data-active={isSelected(run.highlight) || run.highlight.ref === hovered || undefined} title={`${run.highlight.field ?? "Evidence"} · offsets ${run.highlight.start}–${run.highlight.end}`} aria-label={`Source citation: ${run.highlight.field ?? "evidence"}`} onClick={() => onSelect(run.highlight!.ref)} onMouseEnter={() => onHover(run.highlight!.ref)} onMouseLeave={() => onHover(null)}>{run.text}</button> : <span key={index}>{run.text}</span>)}
      </pre></article> : <div className={styles.unparsed}><strong>No extracted page text yet</strong><p>The original remains available for download. Start an extraction run to produce version-bound assertions.</p>{originalAvailable ? <Button onClick={() => setMode("original")}>View original</Button> : null}</div>}
    </div>
    <nav className={styles.filmstrip} aria-label="Document pages">{detail.pages.map(source => <button key={source.page} type="button" aria-pressed={page === source.page} onClick={() => onPage(source.page)}><strong>{source.page}</strong><span>{source.highlights.length} citations</span></button>)}</nav>
  </section>;
}
