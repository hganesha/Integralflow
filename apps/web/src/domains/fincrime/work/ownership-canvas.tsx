import { Button, TextInput } from "@ehf/ui-kit";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import type { OpenItem } from "./case-model";
import { extent, NODE_H, NODE_W, OwnershipGraph, positions, type CanvasState, type Ownership } from "./ownership-graph";
import { matching, type Visible } from "./ownership-model";
import styles from "./work.module.css";

type Transform = { x: number; y: number; k: number };
const FIT: Transform = { x: 0, y: 0, k: 1 };
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 3;

/**
 * Pan and zoom per case, kept for the session so the view is the same after opening evidence,
 * another workspace or a finding and coming back (selection and filters live in the URL).
 */
const VIEWS = new Map<string, Transform>();

const clamp = (value: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value));

/**
 * The ownership structure as a working canvas: pan (drag or arrow keys), zoom (buttons, + and −,
 * or Ctrl/⌘ + wheel), fit, find a party, and select any party or relationship.
 */
export function OwnershipCanvas({ storeKey, view, visible, highlight, selectedNode, selectedEdge, selectedContradiction, onSelectNode, onSelectEdge, expanded, onToggleExpanded, openItems }: {
  openItems?: readonly OpenItem[] | undefined;
  storeKey: string;
  view: Ownership;
  visible: Visible;
  highlight: Set<string>;
  selectedNode: string | undefined;
  selectedEdge: string | undefined;
  selectedContradiction: string | null;
  onSelectNode: (id: string) => void;
  onSelectEdge: CanvasState["onSelectEdge"];
  expanded: boolean;
  onToggleExpanded: () => void;
}) {
  const [transform, setTransformState] = useState<Transform>(() => VIEWS.get(storeKey) ?? FIT);
  const [query, setQuery] = useState("");
  const frame = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; origin: Transform } | null>(null);
  const size = extent(view);

  const setTransform = useCallback((next: Transform | ((current: Transform) => Transform)) => {
    setTransformState((current) => {
      const value = typeof next === "function" ? next(current) : next;
      VIEWS.set(storeKey, value);
      return value;
    });
  }, [storeKey]);

  /** Zoom about the centre of the drawing so the middle of the view stays put. */
  const zoomBy = useCallback((factor: number) => setTransform((current) => {
    const k = clamp(current.k * factor);
    const ratio = k / current.k;
    return { k, x: size.width / 2 - (size.width / 2 - current.x) * ratio, y: size.height / 2 - (size.height / 2 - current.y) * ratio };
  }), [setTransform, size.width, size.height]);

  // Ctrl/⌘ + wheel zooms; a plain wheel keeps scrolling the page. Needs a non-passive listener.
  useEffect(() => {
    const element = frame.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      zoomBy(event.deltaY < 0 ? 1.1 : 1 / 1.1);
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [zoomBy]);

  /** Drawing units per CSS pixel, so a drag moves the structure with the pointer. */
  const unitsPerPixel = () => {
    const box = frame.current?.getBoundingClientRect();
    if (!box || !box.width || !box.height) return 1;
    return Math.max(size.width / box.width, size.height / box.height);
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!(event.target as Element).hasAttribute("data-pan")) return;
    drag.current = { x: event.clientX, y: event.clientY, origin: transform };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const start = drag.current;
    if (!start) return;
    const scale = unitsPerPixel();
    setTransform({ k: start.origin.k, x: start.origin.x + (event.clientX - start.x) * scale, y: start.origin.y + (event.clientY - start.y) * scale });
  };
  const endDrag = () => { drag.current = null; };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if ((event.target as Element).tagName === "INPUT") return;
    const step = 48;
    const pan = (dx: number, dy: number) => { event.preventDefault(); setTransform((current) => ({ ...current, x: current.x + dx, y: current.y + dy })); };
    if (event.key === "ArrowLeft") pan(step, 0);
    else if (event.key === "ArrowRight") pan(-step, 0);
    else if (event.key === "ArrowUp") pan(0, step);
    else if (event.key === "ArrowDown") pan(0, -step);
    else if (event.key === "+" || event.key === "=") { event.preventDefault(); zoomBy(1.25); }
    else if (event.key === "-") { event.preventDefault(); zoomBy(0.8); }
    else if (event.key === "0") { event.preventDefault(); setTransform(FIT); }
  };

  const matches = matching(view, query).filter((id) => visible.nodes.has(id));
  const hiddenMatches = matching(view, query).length - matches.length;
  const focusFirst = () => {
    const id = matches[0];
    if (!id) return;
    const point = positions(view).get(id)!;
    const k = Math.max(transform.k, 1.5);
    setTransform({ k, x: size.width / 2 - (point.x + NODE_W / 2) * k, y: size.height / 2 - (point.y + NODE_H / 2) * k });
    onSelectNode(id);
  };

  return (
    <div className={styles.canvas} data-expanded={expanded}>
      <div className={styles.canvasTools}>
        <form className={styles.row} role="search" aria-label="Find a party" onSubmit={(event) => { event.preventDefault(); focusFirst(); }}>
          <TextInput aria-label="Find a party" placeholder="Find a party" value={query} onChange={(event) => setQuery(event.target.value)} />
          <Button size="sm" type="submit" disabled={!matches.length}>Go to</Button>
          <span className={styles.muted} role="status">
            {query.trim() ? `${matches.length} ${matches.length === 1 ? "match" : "matches"}${hiddenMatches ? ` · ${hiddenMatches} hidden by the filter` : ""}` : ""}
          </span>
        </form>
        <div className={styles.row} role="group" aria-label="View">
          <Button size="sm" aria-label="Zoom out" disabled={transform.k <= MIN_ZOOM} onClick={() => zoomBy(0.8)}>−</Button>
          <span className={`${styles.muted} num`} aria-label="Zoom level">{Math.round(transform.k * 100)}%</span>
          <Button size="sm" aria-label="Zoom in" disabled={transform.k >= MAX_ZOOM} onClick={() => zoomBy(1.25)}>+</Button>
          <Button size="sm" onClick={() => setTransform(FIT)}>Fit</Button>
          <Button size="sm" aria-pressed={expanded} onClick={onToggleExpanded}>{expanded ? "Show side panels" : "Expand"}</Button>
        </div>
      </div>
      <div
        ref={frame} className={styles.canvasFrame} tabIndex={0} role="region"
        aria-label="Ownership canvas. Drag or use the arrow keys to pan, plus and minus to zoom, zero to fit."
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={endDrag} onPointerCancel={endDrag} onKeyDown={onKeyDown}
      >
        <OwnershipGraph
          view={view} openItems={openItems} selectedContradiction={selectedContradiction} onSelectContradiction={() => undefined}
          canvas={{ visible, highlight, matches: new Set(matches), selectedNode, selectedEdge, onSelectNode, onSelectEdge, transform }}
        />
      </div>
    </div>
  );
}
