import { Button } from "@ehf/ui-kit";
import { useEffect, useState } from "react";
import styles from "./sandbox.module.css";

export type ReplayEvent = { id: string; title: string; at: string; nodeId?: string };

export function TraceReplay({ events, select }: { events: ReplayEvent[]; select: (event: ReplayEvent) => void }) {
  const [cursor, setCursor] = useState(-1);
  const [playing, play] = useState(false);
  const move = (index: number) => {
    const next = Math.max(0, Math.min(index, events.length - 1));
    const event = events[next];
    if (event) {
      setCursor(next);
      select(event);
    }
    if (next === events.length - 1) play(false);
  };
  const toggle = () => {
    if (playing) play(false);
    else if (cursor < 0 || cursor === events.length - 1) {
      move(0);
      play(events.length > 1);
    } else play(true);
  };
  useEffect(() => {
    if (!playing || cursor >= events.length - 1) return;
    const timer = setTimeout(() => move(cursor + 1), 850);
    return () => clearTimeout(timer);
  });
  if (!events.length) return null;
  return <section className={styles.inspectorStack} aria-label="Replay recorded trace" onKeyDown={event => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      play(false);
      move(cursor + (event.key === "ArrowLeft" ? -1 : 1));
    }
  }}>
    <div className={styles.row}>
      <Button size="sm" disabled={cursor <= 0} onClick={() => { play(false); move(cursor - 1); }}>Previous event</Button>
      <Button size="sm" onClick={toggle}>{playing ? "Pause playback" : "Play recorded trace"}</Button>
      <Button size="sm" disabled={cursor >= events.length - 1} onClick={() => { play(false); move(cursor + 1); }}>Next event</Button>
    </div>
    <p role="status">{cursor < 0 ? `${events.length} recorded events` : `Event ${cursor + 1} of ${events.length} · ${events[cursor]?.title ?? ""}`}</p>
  </section>;
}
