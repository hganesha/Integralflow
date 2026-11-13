import { ApiError } from "@ehf/ui-client";
import { usePolled } from "@ehf/ui-client/react";
import { fmtDuration, LocalTimestamp } from "@ehf/ui-kit";
import { Link } from "@tanstack/react-router";
import { api } from "../../../app/api";
import { Region } from "../../../platform/common";
import { KeyValues, runPath, tracePath } from "../../../platform/surfaces/runs/components";
import runStyles from "../../../platform/surfaces/runs/runs.module.css";
import { TraceSpansView } from "../../../platform/surfaces/runs/trace-waterfall";
import styles from "./assurance.module.css";

/**
 * One trace's span waterfall inside the Flight Recorder (ASR-02 AC3). It uses the PLT-08
 * span waterfall, and links to the run and to the full trace view.
 * Telemetry is not the audit record: missing spans stay missing.
 */
export function TraceSpans({ traceId, runId }: { traceId: string; runId: string }) {
  const trace = usePolled(api, "getTracesTraceId", { path: { traceId } });
  const missing = !trace.data && trace.error instanceof ApiError && (trace.error.status === 404 || trace.error.status === 403);
  return (
    <section className={styles.section} aria-labelledby={`trace-${traceId}`}>
      <div className={styles.header}>
        <h3 id={`trace-${traceId}`} className={styles.sectionTitle}>Trace <span className={styles.mono}>{traceId}</span></h3>
        <span className={styles.inline}>
          <Link to={runPath(runId)}>Open run {runId}</Link>
          <Link to={tracePath(traceId)}>Open in trace view</Link>
        </span>
      </div>
      {missing ? (
        <p className={styles.muted}>This trace isn't available to you, or it was not retained. The ledger events above are complete; trace gaps are not filled in.</p>
      ) : (
        <Region polled={trace} label={`trace ${traceId}`} skeletonHeight={160}>
          {(view) => (
            <>
              <KeyValues items={[
                ["Started", <LocalTimestamp iso={view.startedAt} />],
                ["Duration", <span className={runStyles.mono}>{fmtDuration(view.durationMs)}</span>],
                ["Spans", String(view.spanCount)],
                ["Services", view.services.join(", ")],
              ]} />
              <TraceSpansView trace={view} label={`Spans of trace ${traceId}`} idPrefix={`asr-${traceId}`} />
            </>
          )}
        </Region>
      )}
    </section>
  );
}
