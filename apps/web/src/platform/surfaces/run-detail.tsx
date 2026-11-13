import { usePolled } from "@ehf/ui-client/react";
import { Button, DigestValue, Disclosure, EmptyState, Id, InlineMessage, JsonViewer, LocalTimestamp, StatusBadge } from "@ehf/ui-kit";
import { ConsoleHeader } from "@ehf/ui-shell";
import { Link, useParams } from "@tanstack/react-router";
import { lazy, Suspense, useState } from "react";
import { api } from "../../app/api";
import { useSession } from "../../app/session";
import { Freshness, Region } from "../common";
import { CostValue, Duration, KeyValues, planPath, RUNS_PATH } from "./runs/components";
import { CancelRunSheet, HumanWorkForRun, RunAttempts, RunTimeline, TraceBinding } from "./runs/run-parts";
import styles from "./runs/runs.module.css";

const TERMINAL = new Set(["completed", "denied", "failed", "cancelled"]);
const RunWorkflow = lazy(() => import("./runs/RunWorkflow"));

/** PLT-07 · Run detail — `/platform/runs/$runId`. */
export default function RunDetail() {
  const { runId = "" } = useParams({ strict: false }) as { runId?: string };
  const session = useSession();
  const [cancelling, setCancelling] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  const run = usePolled(api, "getRunsRunId", { path: { runId } });
  const detail = run.data;
  const canCancel = session.actions.includes("run.cancel");
  const terminal = detail ? TERMINAL.has(detail.status) || Boolean(detail.terminalOutcome && detail.terminalOutcome !== "manual_review") : false;
  const cancelReason = !canCancel ? "Cancelling needs run.cancel" : terminal ? "This run has finished" : null;

  if (!detail && run.error?.status === 404) {
    return (
      <div className={styles.stack}>
        <ConsoleHeader breadcrumb={[{ label: "Platform", href: "/platform" }, { label: "Runs", href: "/platform/runs" }, { label: runId }]} title="Run not found" />
        <EmptyState icon="search" title={`No run ${runId}`} headingLevel={2} action={<Link to={RUNS_PATH}>Back to runs</Link>}>
          It doesn't exist, or you don't have access to it.
        </EmptyState>
      </div>
    );
  }

  return (
    <div className={styles.stack}>
      <ConsoleHeader
        breadcrumb={[{ label: "Platform", href: "/platform" }, { label: "Runs", href: "/platform/runs" }, { label: runId }]}
        title={<>Run <span className={styles.mono}>{runId}</span></>}
        meta={detail ? (
          <>
            <StatusBadge dimension="RunStatus" value={detail.status} humanize size="lg" />
            {detail.terminalOutcome && detail.terminalOutcome !== detail.status ? <span className={styles.small}>Outcome: <Id>{detail.terminalOutcome}</Id></span> : null}
            <span className={styles.small}><Link to={planPath(detail.planDigest)}>{detail.harnessName}</Link> v{detail.packageVersion}</span>
          </>
        ) : null}
        actions={(
          <>
            <Freshness polled={run} />
            <Button icon="x" disabled={!detail || Boolean(cancelReason)} aria-describedby={cancelReason ? "cancel-reason" : undefined} onClick={() => { setCancelled(false); setCancelling(true); }}>Cancel run</Button>
            {cancelReason && detail ? <span id="cancel-reason" className={styles.small}>{cancelReason}</span> : null}
          </>
        )}
      />
      {cancelled ? <InlineMessage tone="ok">Cancellation recorded. The run shows its state as reported by the server.</InlineMessage> : null}
      <Region polled={run} label="run">
        {(data) => (
          <>
            {data.failureInfo ? (
              <Disclosure tone="blocking" title={data.failureInfo.title} code={data.failureInfo.errorCode}>
                <p>{data.failureInfo.explanation}</p>
                <KeyValues items={[
                  ["Failing node", `${data.failureInfo.failingNodeName} (${data.failureInfo.failingNodeId})`],
                  ["Attempt / epoch", `${data.failureInfo.attempt} / ${data.failureInfo.fencingEpoch}`],
                  ["Last committed checkpoint", <span className={styles.mono}>{data.failureInfo.lastCommittedCheckpoint}</span>],
                  ["External effect occurred", data.failureInfo.externalEffectOccurred ? "Yes" : "No"],
                  ["Retry permitted", data.failureInfo.retryPermitted ? "Yes" : "No"],
                  ["Suggested action", data.failureInfo.suggestedOperatorAction],
                ]} />
              </Disclosure>
            ) : null}

            {data.status === "manual_review" ? (
              <section className={styles.panel} aria-labelledby="human-title">
                <div className={styles.section}>
                  <h2 id="human-title" className={styles.sectionTitle}>Waiting for a human decision</h2>
                  <HumanWorkForRun run={data} canRead={session.actions.includes("human_work.read")} />
                </div>
              </section>
            ) : null}

            <section className={styles.section} aria-labelledby="facts-title">
              <h2 id="facts-title" className="sr-only">Run facts</h2>
              <KeyValues items={[
                ["Plan digest", <DigestValue value={data.planDigest} label="plan digest" />],
                ["Current node", data.currentNodeId ? <span className={styles.mono}>{data.currentNodeId}</span> : <span className={styles.muted}>—</span>],
                ["Attempt / fencing epoch", <span className={styles.mono}>{data.attempt} / {data.fencingEpoch}</span>],
                ["Model / capability calls", <span className={styles.mono}>{data.modelCalls} / {data.capabilityCalls}</span>],
                ["Model tiers", data.modelTiers.length ? data.modelTiers.join(", ") : "None"],
                ["Reported cost", <CostValue cost={data.cost} />],
                ["Duration", <Duration ms={data.durationMs} />],
                ["Started", <LocalTimestamp iso={data.startedAt} />],
                ["Updated", <LocalTimestamp iso={data.updatedAt} />],
                ["Idempotency key", <span className={styles.mono}>{data.idempotencyKey}</span>],
                ["Trace", <TraceBinding runId={data.runId} />],
              ]} />
            </section>

            <section className={styles.section} aria-labelledby="graph-title">
              <h2 id="graph-title" className={styles.sectionTitle}>Position in plan</h2>
              <Suspense fallback={<p>Loading execution workflow…</p>}><RunWorkflow runId={data.runId} label={`${data.harnessName} plan graph`} /></Suspense>
            </section>

            <div className={styles.grid2}>
              <section className={styles.section} aria-labelledby="timeline-title">
                <h2 id="timeline-title" className={styles.sectionTitle}>Events</h2>
                <RunTimeline runId={data.runId} />
              </section>
              <div className={styles.stack}>
                <section className={styles.section} aria-labelledby="attempts-title">
                  <h2 id="attempts-title" className={styles.sectionTitle}>Attempts</h2>
                  <RunAttempts runId={data.runId} attempt={data.attempt} />
                </section>
                <section className={styles.section} aria-labelledby="input-title">
                  <h2 id="input-title" className={styles.sectionTitle}>Input</h2>
                  <JsonViewer data={data.inputPayload} label="Run input" maxHeight={280} />
                </section>
              </div>
            </div>
          </>
        )}
      </Region>
      {detail ? (
        <CancelRunSheet
          open={cancelling}
          onClose={() => setCancelling(false)}
          run={detail}
          onRefresh={run.refresh}
          onDone={() => {
            setCancelling(false);
            setCancelled(true);
          }}
        />
      ) : null}
    </div>
  );
}
