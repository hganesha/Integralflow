import { ApiError } from "@ehf/ui-client";
import { usePolled } from "@ehf/ui-client/react";
import type { Schemas } from "@ehf/ui-contracts";
import { Button, DigestValue, Field, Id, InlineMessage, LocalTimestamp, Sheet, Skeleton, StatusBadge, Table, TextArea, ToneBadge, type IconName } from "@ehf/ui-kit";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { api } from "../../../app/api";
import { ApiErrorView, reasonCopy, useCommand } from "../../common";
import { HUMAN_WORK_PATH, tracePath } from "./components";
import styles from "./runs.module.css";
import { useRunEvents, type RuntimeEvent } from "./use-run-events";

type RunDetail = Schemas["RunDetail"];
type HumanQueueItem = Schemas["HumanQueueItem"];
type Attempt = { attempt: number; fencingEpoch?: number; status?: string; startedAt?: string | null };

const bareDigest = (digest: string | null | undefined) => (digest ?? "").replace(/^sha256:/, "");

const EVENT_STATUS: Record<RuntimeEvent["status"], { tone: "neutral" | "positive" | "blocking"; icon: IconName; label: string }> = {
  observed: { tone: "neutral", icon: "eye", label: "Observed" },
  passed: { tone: "positive", icon: "check", label: "Passed" },
  failed: { tone: "blocking", icon: "xcircle", label: "Failed" },
  denied: { tone: "blocking", icon: "block", label: "Denied" },
};

/** Incremental timeline (PLT-07 AC1): appended by `after = last sequence`, ordered, no duplicates. */
export function RunTimeline({ runId }: { runId: string }) {
  const feed = useRunEvents(runId);
  if (feed.loading && feed.events.length === 0) return <Skeleton height={200} label="Loading run events" />;
  return (
    <div className={styles.section}>
      {feed.error ? (
        <ApiErrorView error={feed.error} title={`Events could not be refreshed: ${reasonCopy(feed.error)}`} action={<Button size="sm" onClick={feed.refresh}>Retry</Button>} />
      ) : null}
      <p className={styles.small} aria-live="polite">
        {feed.events.length} event{feed.events.length === 1 ? "" : "s"}{feed.events.length ? <> · through sequence <span className={styles.mono}>{feed.events.at(-1)!.sequence}</span></> : null}
      </p>
      {feed.events.length ? (
        <ol className={styles.timeline} aria-label="Run events">
          {feed.events.map((event) => {
            const status = EVENT_STATUS[event.status] ?? EVENT_STATUS.observed;
            const values = Object.entries(event.values ?? {});
            return (
              <li key={event.sequence} className={styles.event} data-sequence={event.sequence}>
                <span className={styles.mono}>#{event.sequence}</span>
                <span className={styles.small}><LocalTimestamp iso={event.occurredAt} compact /></span>
                <span className={styles.eventBody}>
                  <span className={styles.eventCode}>{event.code}{event.nodeId ? <> · <span className={styles.muted}>{event.nodeId}</span></> : null}</span>
                  {values.length ? (
                    <span className={styles.small}>
                      {values.slice(0, 4).map(([key, value]) => `${key}: ${typeof value === "object" ? JSON.stringify(value) : String(value)}`).join(" · ")}
                    </span>
                  ) : null}
                </span>
                <ToneBadge tone={status.tone} icon={status.icon}>{status.label}</ToneBadge>
              </li>
            );
          })}
        </ol>
      ) : <p className={styles.muted}>No events recorded yet.</p>}
    </div>
  );
}

/** PLT-07 AC4: link to PLT-08, or say plainly that no trace is bound. */
export function TraceBinding({ runId }: { runId: string }) {
  const trace = usePolled(api, "getRunsRunIdTrace", { path: { runId } });
  if (trace.data) {
    return (
      <span className={styles.inline}>
        <Link to={tracePath(trace.data.traceId)}>Open trace</Link>
        <DigestValue value={trace.data.traceId} label="trace id" />
      </span>
    );
  }
  if (trace.error instanceof ApiError && (trace.error.reason === "trace.not_bound" || trace.error.status === 404)) {
    return <span className={styles.muted}>No trace bound to this run</span>;
  }
  if (trace.error) return <span className={styles.muted}>Trace unavailable ({trace.error.reason})</span>;
  return <span className={styles.muted}>Checking…</span>;
}

/**
 * PLT-07 AC2: the human-work items behind a manual_review run. Work items carry no runId, so
 * they are matched by the run's case and plan digest (GAP-032).
 */
export function HumanWorkForRun({ run, canRead }: { run: RunDetail; canRead: boolean }) {
  const caseId = typeof run.inputPayload.caseId === "string" ? run.inputPayload.caseId : undefined;
  const work = usePolled(api, "getOperationsHumanWork", { query: { ...(caseId ? { caseId } : {}), limit: 50 } }, { enabled: canRead && Boolean(caseId) });
  if (!canRead) return <p className={styles.small}>This run is waiting for a human decision. Viewing the work item needs human_work.read.</p>;
  if (!caseId) return <p className={styles.small}>This run is waiting for a human decision. Its input names no case, so the work item can't be located. <Link to={HUMAN_WORK_PATH}>Open human work</Link></p>;
  if (!work.data) return work.error ? <ApiErrorView error={work.error} /> : <Skeleton height={60} label="Loading human work" />;
  const items = work.data.items.filter((item) => bareDigest(item.workItem.planDigest) === bareDigest(run.planDigest));
  if (!items.length) return <p className={styles.small}>No open human-work item was found for case {caseId}. <Link to={HUMAN_WORK_PATH} search={{ case: caseId }}>Open human work</Link></p>;
  return (
    <Table
      caption="Human work for this run"
      captionHidden
      columns={[
        { key: "item", header: "Work item", render: (item: HumanQueueItem) => (
          <Link to={HUMAN_WORK_PATH} search={{ item: item.workItem.workItemId, case: item.workItem.caseId }}>{item.workItem.workItemId}</Link>
        ) },
        { key: "objective", header: "Objective", render: (item: HumanQueueItem) => item.workItem.objective },
        { key: "status", header: "Status", render: (item: HumanQueueItem) => <StatusBadge dimension="WorkItemStatus" value={item.workItem.status} humanize /> },
        { key: "approvals", header: "Approvals", align: "end", render: (item: HumanQueueItem) => <span className={styles.mono}>{item.decisions.length} / {item.requiredApprovals}</span> },
        { key: "deadline", header: "Deadline", render: (item: HumanQueueItem) => <LocalTimestamp iso={item.workItem.deadlineAt} /> },
      ]}
      rows={items}
      rowKey={(item) => item.workItem.workItemId}
    />
  );
}

export function RunAttempts({ runId, attempt }: { runId: string; attempt: number }) {
  const attempts = usePolled(api, "getRunsRunIdAttempts", { path: { runId } });
  const { refresh } = attempts;
  const seen = useRef(attempt);
  // Not polled by contract: refetch when the run reports a new attempt.
  useEffect(() => {
    if (seen.current !== attempt) {
      seen.current = attempt;
      refresh();
    }
  }, [attempt, refresh]);
  if (!attempts.data) return attempts.error ? <ApiErrorView error={attempts.error} /> : <Skeleton height={60} label="Loading attempts" />;
  const rows = ((attempts.data as { attempts?: Attempt[] }).attempts ?? []).slice().sort((a, b) => a.attempt - b.attempt);
  return (
    <Table
      caption="Attempts"
      captionHidden
      columns={[
        { key: "attempt", header: "Attempt", render: (row: Attempt) => <span className={styles.mono}>{row.attempt}</span> },
        { key: "epoch", header: "Fencing epoch", align: "end", render: (row: Attempt) => <span className={styles.mono}>{row.fencingEpoch ?? "—"}</span> },
        { key: "status", header: "Status", render: (row: Attempt) => <StatusBadge dimension="RunStatus" value={row.status} humanize /> },
        { key: "started", header: "Started", render: (row: Attempt) => <LocalTimestamp iso={row.startedAt ?? null} /> },
      ]}
      rows={rows}
      rowKey={(row) => String(row.attempt)}
      empty="No attempts recorded"
    />
  );
}

/**
 * Cancel with a required reason (`run.cancel`). Never optimistic: "Cancelling…" until the
 * response and the refetch of the run arrive. A 409 run.already_terminal is shown inline
 * together with the run's current state (PLT-07 AC3).
 */
export function CancelRunSheet({ open, onClose, run, onDone, onRefresh }: { open: boolean; onClose: () => void; run: Pick<Schemas["runRecord"], "runId" | "status" | "terminalOutcome">; onDone: () => void; onRefresh: () => void }) {
  const [reason, setReason] = useState("");
  const cancel = useCommand("postRunsRunIdCancel", { invalidate: [["getRunsRunId"], ["getRuns"], ["getRunsRunIdAttempts"], ["getOverview"], ["getPlansPlanDigestRuns"]] });
  const close = () => {
    cancel.reset();
    setReason("");
    onClose();
  };
  const submit = async () => {
    const result = await cancel.run({ path: { runId: run.runId }, body: { reason: reason.trim() } });
    if (result) {
      setReason("");
      cancel.reset();
      onDone();
    } else {
      // A refusal means our view of the run is out of date: fetch its current state to show.
      onRefresh();
    }
  };
  const terminal = cancel.error?.reason === "run.already_terminal";
  return (
    <Sheet
      open={open}
      onClose={close}
      title={`Cancel run ${run.runId}`}
      description="Cancelling stops the run at its next checkpoint. The reason is recorded with the cancellation."
      footer={(
        <>
          <Button onClick={close}>Keep running</Button>
          <Button variant="primary" icon="x" busy={cancel.busy} disabled={!reason.trim() || cancel.busy} onClick={() => void submit()}>
            {cancel.busy ? "Cancelling…" : "Cancel run"}
          </Button>
        </>
      )}
    >
      <div className={styles.section}>
        <Field label="Reason" hint="Required">
          <TextArea rows={4} value={reason} onChange={(event) => setReason(event.target.value)} required />
        </Field>
        {terminal ? (
          <div role="alert" className={styles.section}>
            <InlineMessage tone="error">
              {reasonCopy(cancel.error!)} <span className={styles.mono}>({cancel.error!.reason})</span>
            </InlineMessage>
            <span className={styles.small}>
              Current state: <StatusBadge dimension="RunStatus" value={run.status} humanize />
              {run.terminalOutcome ? <> · outcome <Id>{run.terminalOutcome}</Id></> : null}
            </span>
          </div>
        ) : cancel.error ? <ApiErrorView error={cancel.error} /> : null}
      </div>
    </Sheet>
  );
}
