import { useEffect, useRef, useState } from "react";
import { GlobalWorkerOptions, getDocument, type PDFDocumentProxy } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
GlobalWorkerOptions.workerSrc = workerUrl;
export default function PdfPage({ contentBase64, page, scale, onPages }: { contentBase64: string; page: number; scale: number; onPages: (count: number) => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    setError(""); setPdf(null);
    const task = getDocument({ data: Uint8Array.from(atob(contentBase64), character => character.charCodeAt(0)) });
    void task.promise.then(document => { if (active) { setPdf(document); onPages(document.numPages); } }).catch(() => { if (active) setError("This PDF could not be rendered. Use the text view or download the original."); });
    return () => { active = false; void task.destroy(); };
  }, [contentBase64, onPages]);
  useEffect(() => {
    if (!pdf) return;
    let active = true;
    let rendering: ReturnType<Awaited<ReturnType<PDFDocumentProxy["getPage"]>>["render"]> | undefined;
    void pdf.getPage(page).then(source => {
      const element = canvas.current;
      if (!active || !element) return;
      const viewport = source.getViewport({ scale });
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      element.width = Math.ceil(viewport.width * dpr); element.height = Math.ceil(viewport.height * dpr);
      element.style.width = `${viewport.width}px`; element.style.height = `${viewport.height}px`;
      rendering = source.render({ canvas: element, viewport, transform: dpr === 1 ? undefined : [dpr, 0, 0, dpr, 0, 0] });
      return rendering.promise;
    }).catch(error => { if (active && error?.name !== "RenderingCancelledException") setError("This page could not be rendered. Use the text view."); });
    return () => { active = false; rendering?.cancel(); };
  }, [pdf, page, scale]);
  return error ? <p role="alert">{error}</p> : <canvas ref={canvas} aria-label={`Original document page ${page}`} role="img"/>;
}
