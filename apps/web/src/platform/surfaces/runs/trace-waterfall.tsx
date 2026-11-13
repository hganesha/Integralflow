import type { Schemas } from "@ehf/ui-contracts";
import { Button, fmtDuration, LocalTimestamp, ToneBadge } from "@ehf/ui-kit";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { runPath } from "./components";
import styles from "./runs.module.css";
import { visibleAttributes } from "./trace-attributes";

type Span = Schemas["TraceSpan"];
type Trace = Schemas["TraceView"];
type FoundryTrace = Schemas["FoundryTraceLink"];

const traceStatus: Record<Exclude<Trace["status"], "available" | undefined>, string> = {
  partial: "Some spans are unavailable.",
  pending: "Waiting for spans to arrive.",
  expired: "This trace is outside the configured retention period.",
  not_sampled: "Sampling skipped this run.",
  unavailable: "The trace store returned no spans for this run.",
};
const foundryStatus: Record<Exclude<FoundryTrace["status"], "available">, string> = {
  partial: "Some Foundry spans are unavailable.",
  pending: "Waiting for Foundry spans to arrive.",
  uncorrelated: "The Foundry response could not be matched to a trace.",
  unavailable: "The Foundry trace source is unavailable.",
  expired: "The Foundry invocation is outside the configured retention period.",
};

export function TraceSpansView({ trace, label, idPrefix = "span" }: { trace: Trace; label: string; idPrefix?: string }) {
  return (
    <>
      {trace.status && trace.status !== "available" ? <p className={styles.muted} role="status">{traceStatus[trace.status]}</p> : null}
      {trace.spans.length ? <TraceWaterfall spans={trace.spans} total={trace.durationMs} label={label} idPrefix={idPrefix} /> : null}
      {trace.foundryPartial ? <p className={styles.muted} role="status">Some Foundry trace links are unavailable.</p> : null}
      {trace.foundry?.map((link, index) => {
        if (!link.spans.length && link.status === "available") return null;
        const prefix = `${idPrefix}-foundry-${index}`;
        return (
          <section key={prefix} className={styles.section} aria-labelledby={`${prefix}-title`}>
            <h3 id={`${prefix}-title`} className={styles.sectionTitle}>
              {link.spans.length ? "Linked Foundry trace" : "Foundry trace"}
            </h3>
            <p className={styles.small}>Invocation span <span className={styles.mono}>{link.parentSpanId}</span></p>
            {link.status !== "available" ? <p className={styles.muted} role="status">{foundryStatus[link.status]}</p> : null}
            {link.spans.length ? (
              <TraceWaterfall spans={link.spans} total={link.durationMs} label="Linked Foundry spans" idPrefix={prefix} />
            ) : null}
          </section>
        );
      })}
    </>
  );
}

/**
 * The PLT-08 span waterfall, shared with the Flight Recorder's Traces tab (ASR-02 AC3).
 * Only allow-listed attributes are shown; credentials, headers and bodies never are.
 */
export function TraceWaterfall({ spans, total, label, idPrefix = "span" }: { spans: readonly Span[]; total: number; label: string; idPrefix?: string }) {
  return (
    <ol className={styles.waterfall} aria-label={label}>
      {spans.map((span) => <SpanRow key={span.spanId} span={span} total={total} idPrefix={idPrefix} />)}
    </ol>
  );
}

function SpanRow({ span, total, idPrefix }: { span: Span; total: number; idPrefix: string }) {
  const [open, setOpen] = useState(false);
  const { shown, hidden } = visibleAttributes(span.tags as Record<string, unknown>);
  const left = total > 0 ? (span.startOffsetMs / total) * 100 : 0;
  const width = total > 0 ? Math.max((span.durationMs / total) * 100, 0.4) : 100;
  const detailsId = `${idPrefix}-${span.spanId}`;
  return (
    <li>
      <div className={styles.span}>
        <span className={styles.spanName} style={{ paddingInlineStart: `calc(${span.depth} * var(--space-4))` }}>
          <Button size="sm" variant="quiet" icon={open ? "chevd" : "chevr"} aria-expanded={open} aria-controls={detailsId} onClick={() => setOpen(!open)}>
            {span.operationName}
          </Button>
          <span className={styles.small}>{span.serviceName} · <span className={styles.mono}>{span.spanId}</span></span>
        </span>
        <span className={styles.spanTrack} aria-hidden="true">
          <span className={styles.spanBar} data-status={span.status} style={{ left: `${left}%`, width: `${Math.min(width, 100 - left)}%` }} />
        </span>
        <span className={styles.spanMeta}>
          <span className={styles.mono}>{fmtDuration(span.durationMs)}</span>
          {span.status === "error" ? <ToneBadge tone="blocking" icon="xcircle">Error</ToneBadge> : <ToneBadge tone="positive" icon="check">OK</ToneBadge>}
        </span>
      </div>
      {open ? (
        <div id={detailsId} className={styles.panel}>
          <p className={styles.small}>Started <LocalTimestamp iso={span.startTime} /> · offset {fmtDuration(span.startOffsetMs)}</p>
          {shown.length ? (
            <dl className={styles.attrs} aria-label={`Attributes of ${span.operationName}`}>
              {shown.map(([key, value]) => (
                <div key={key} className={styles.attrRow}>
                  <dt>{key}</dt>
                  <dd>{key === "ehf.run_id" ? <Link to={runPath(value)}>{value}</Link> : value}</dd>
                </div>
              ))}
            </dl>
          ) : <p className={styles.muted}>No displayable attributes.</p>}
          {hidden ? <p className={styles.small}>{hidden} attribute{hidden === 1 ? "" : "s"} not shown. Only allow-listed attributes are displayed; credentials, headers and bodies never are.</p> : null}
        </div>
      ) : null}
    </li>
  );
}
