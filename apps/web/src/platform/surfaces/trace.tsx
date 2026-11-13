import { ApiError } from "@ehf/ui-client";
import { usePolled } from "@ehf/ui-client/react";
import { EmptyState, fmtDuration, LocalTimestamp } from "@ehf/ui-kit";
import { ConsoleHeader } from "@ehf/ui-shell";
import { Link, useParams } from "@tanstack/react-router";
import { api } from "../../app/api";
import { Region } from "../common";
import { KeyValues, RUNS_PATH } from "./runs/components";
import styles from "./runs/runs.module.css";
import { TraceSpansView } from "./runs/trace-waterfall";

/** Unknown and unauthorised traces look the same (PLT-08 AC1): no existence leak. */
function isNotFound(error: ApiError | null): boolean {
  return error instanceof ApiError && (error.status === 404 || error.status === 403);
}

/** PLT-08 · Trace — `/platform/traces/$traceId`. */
export default function Trace() {
  const { traceId = "" } = useParams({ strict: false }) as { traceId?: string };
  const trace = usePolled(api, "getTracesTraceId", { path: { traceId } });
  const breadcrumb = [{ label: "Platform", href: "/platform" }, { label: "Runs", href: "/platform/runs" }, { label: "Trace" }];

  if (!trace.data && isNotFound(trace.error)) {
    return (
      <div className={styles.stack}>
        <ConsoleHeader breadcrumb={breadcrumb} title="Trace not found" />
        <EmptyState icon="search" title="Trace not found" headingLevel={2} action={<Link to={RUNS_PATH}>Back to runs</Link>}>
          It doesn't exist, or you don't have access to it. Open traces from a run you can see.
        </EmptyState>
      </div>
    );
  }

  const data = trace.data;
  return (
    <div className={styles.stack}>
      <ConsoleHeader
        breadcrumb={breadcrumb}
        title={<>Trace <span className={styles.mono}>{traceId}</span></>}
        meta={data ? <span className={styles.small}>{data.spanCount} spans · {fmtDuration(data.durationMs)} · {data.services.join(", ")}</span> : null}
        actions={data?.rawViewerUrl ? <a href={data.rawViewerUrl} target="_blank" rel="noreferrer">Open in trace viewer</a> : null}
      />
      <Region polled={trace} label="trace">
        {(view) => (
          <>
            <KeyValues items={[
              ["Started", <LocalTimestamp iso={view.startedAt} />],
              ["Duration", <span className={styles.mono}>{fmtDuration(view.durationMs)}</span>],
              ["Spans", String(view.spanCount)],
              ["Services", view.services.join(", ")],
              ["Generated", <LocalTimestamp iso={view.generatedAt} />],
              ...(view.backend ? [["Backend", view.backend === "azure_monitor" ? "Azure Monitor" : "Jaeger"] satisfies [string, string]] : []),
            ]} />
            <section className={styles.section} aria-labelledby="waterfall-title">
              <h2 id="waterfall-title" className={styles.sectionTitle}>Spans</h2>
              <TraceSpansView trace={view} label="Span waterfall" />
            </section>
          </>
        )}
      </Region>
    </div>
  );
}
