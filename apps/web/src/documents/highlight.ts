/**
 * Splitting page text into plain and highlighted runs. Span offsets are Unicode code points (the
 * library's offset basis), so the text is cut as an array of code points, never with String.slice.
 */
export type Highlight = { start: number; end: number; kind: "assertion" | "evidence"; field: string | null; ref: string };
export type Run = { text: string; highlight: Highlight | null };

export type CitationOffset = { start: number; end: number };

export function highlightRuns(text: string, highlights: Highlight[], preferred?: (highlight: Highlight) => boolean): Run[] {
  const points = Array.from(text);
  const runs: Run[] = [];
  let cursor = 0;
  const primary = preferred ? highlights.filter(preferred) : [];
  const segments = highlights.flatMap(highlight => {
    let ranges = [{ start: highlight.start, end: highlight.end }];
    if (!primary.includes(highlight)) {
      for (const active of primary) {
        ranges = ranges.flatMap(range => active.start >= range.end || active.end <= range.start ? [range] : [
          ...(range.start < active.start ? [{ start: range.start, end: active.start }] : []),
          ...(active.end < range.end ? [{ start: active.end, end: range.end }] : []),
        ]);
      }
    }
    return ranges.map(range => ({ ...range, highlight }));
  });
  // Selected citations own their full range. The earliest span wins among other overlaps.
  for (const segment of segments.sort((a, b) => a.start - b.start || b.end - a.end)) {
    const start = Math.max(segment.start, cursor);
    const end = Math.min(segment.end, points.length);
    if (start >= end) continue;
    if (start > cursor) runs.push({ text: points.slice(cursor, start).join(""), highlight: null });
    runs.push({ text: points.slice(start, end).join(""), highlight: segment.highlight });
    cursor = end;
  }
  if (cursor < points.length) runs.push({ text: points.slice(cursor).join(""), highlight: null });
  return runs;
}
