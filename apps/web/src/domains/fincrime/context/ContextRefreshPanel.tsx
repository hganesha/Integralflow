import { useState } from "react";
import { usePolled } from "@ehf/ui-client/react";
import { Button, Field, TextInput } from "@ehf/ui-kit";
import { canUse } from "@ehf/ui-shell";
import { api } from "../../../app/api";
import { useSession } from "../../../app/session";
import styles from "./context.module.css";
type Enabled = {
  revision: number;
  paused: boolean;
  authority: { planDigest: string; contextDigest: string };
};
type Schedule = {
  id: string;
  revision: number;
  definition: {
    enabled: boolean;
    intervalMinutes: number;
    [key: string]: unknown;
  };
  next_due: string;
  completed_through: string | null;
  last_success_at: string | null;
  history?: Array<{
    revision: number;
    slot: string;
    attempt: number;
    status: string;
    run_id: string | null;
    error_code: string | null;
  }>;
  latest_batch: {
    status: string;
    run_id: string | null;
    error_code: string | null;
    attempt: number;
  } | null;
};
export function ContextRefreshPanel({
  mappingId,
  mappingDigest,
  enablement,
}: {
  mappingId: string;
  mappingDigest: string;
  enablement?: Enabled | undefined;
}) {
  const session = useSession();
  const schedules = usePolled(api, "getContextRefreshSchedules", {
    query: { mappingId },
  });
  const rows = (schedules.data?.schedules ?? []) as unknown as Schedule[];
  const [caseId, setCaseId] = useState(""),
    [nodeId, setNodeId] = useState(""),
    [subjects, setSubjects] = useState(""),
    [interval, setInterval] = useState("60");
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const perform = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setMessage("");
    try {
      await fn();
      schedules.refresh();
      setMessage("Refresh operation saved.");
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Refresh operation failed.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className={styles.panel} aria-label="Scheduled context refresh">
      <h2>Scheduled refresh and checkpoints</h2>
      <p>
        Each refresh reads the selected subjects through a released acquisition
        plan. The checkpoint advances after its record commit. It records
        completed schedule slots; source observation times remain on the
        records.
      </p>
      {schedules.error ? <p role="alert">{schedules.error.message}</p> : null}
      {rows.map((row) => (
        <section key={row.id} className={styles.panel}>
          <h3>
            {row.id} · revision {row.revision}
          </h3>
          <p>
            {row.definition.enabled ? "Scheduled" : "Paused"} · every{" "}
            {row.definition.intervalMinutes} minutes ·{" "}
            {row.latest_batch?.status ?? "No batch yet"}
          </p>
          <p>
            Next due: {row.next_due}. Completed through:{" "}
            {row.completed_through ?? "No completed checkpoint"}. Last success:{" "}
            {row.last_success_at ?? "None"}.
          </p>
          {row.latest_batch?.error_code ? (
            <p role="status">
              Quarantined: {row.latest_batch.error_code} · attempt{" "}
              {row.latest_batch.attempt}
            </p>
          ) : null}
          <details>
            <summary>Recent batch history</summary>
            {(row.history ?? []).map((batch) => (
              <p key={`${batch.revision}:${batch.slot}:${batch.attempt}`}>
                Revision {batch.revision} · {batch.slot} · attempt{" "}
                {batch.attempt} · {batch.status}
                {batch.error_code ? ` · ${batch.error_code}` : ""}
                {batch.run_id ? ` · ${batch.run_id}` : ""}
              </p>
            ))}
          </details>
          <div className={styles.row}>
            <Button
              disabled={busy || !canUse(session, ["run.start"])}
              onClick={() =>
                void perform(() =>
                  api.call("postContextRefreshSchedulesIdTick", {
                    path: { id: row.id },
                  }),
                )
              }
            >
              Check / fetch when due
            </Button>
            <Button
              disabled={
                busy ||
                !canUse(session, ["run.retry"]) ||
                row.latest_batch?.status !== "QUARANTINED"
              }
              onClick={() =>
                void perform(() =>
                  api.call("postContextRefreshSchedulesIdRetry", {
                    path: { id: row.id },
                    body: { expectedRevision: row.revision },
                  }),
                )
              }
            >
              Retry failed batch
            </Button>
            <Button
              disabled={
                busy ||
                !canUse(session, ["release.activate"]) ||
                !row.definition.enabled
              }
              onClick={() =>
                void perform(() =>
                  api.call("postContextRefreshSchedules", {
                    body: {
                      schedule: { ...row.definition, enabled: false },
                      expectedRevision: row.revision,
                      reason: "Pause scheduled refresh",
                    } as never,
                  }),
                )
              }
            >
              Pause schedule
            </Button>
          </div>
        </section>
      ))}
      <div className={styles.selectorGrid}>
        <Field label="Refresh case ID">
          <TextInput
            value={caseId}
            onChange={(e) => setCaseId(e.target.value)}
          />
        </Field>
        <Field label="Acquisition node ID">
          <TextInput
            value={nodeId}
            onChange={(e) => setNodeId(e.target.value)}
          />
        </Field>
        <Field label="Refresh source subject keys (comma separated)">
          <TextInput
            value={subjects}
            onChange={(e) => setSubjects(e.target.value)}
          />
        </Field>
        <Field label="Refresh interval (minutes)">
          <TextInput
            type="number"
            min={5}
            max={43200}
            value={interval}
            onChange={(e) => setInterval(e.target.value)}
          />
        </Field>
      </div>
      <Button
        disabled={
          busy ||
          !enablement ||
          enablement.paused ||
          !caseId ||
          !nodeId ||
          !subjects ||
          !canUse(session, ["release.activate"])
        }
        onClick={() =>
          void perform(async () => {
            if (!enablement) return;
            await api.call("postContextRefreshSchedules", {
              body: {
                schedule: {
                  id: `${mappingId}-refresh`,
                  mappingId,
                  mappingDigest,
                  enablementRevision: enablement.revision,
                  caseId,
                  nodeId,
                  planDigest: enablement.authority.planDigest.replace(
                    /^sha256:/,
                    "",
                  ),
                  sourceContextDigest: enablement.authority.contextDigest,
                  subjects: subjects
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean),
                  intervalMinutes: Number(interval),
                  startsAt: new Date().toISOString(),
                  maxAttempts: 3,
                  enabled: true,
                },
                expectedRevision:
                  rows.find((r) => r.id === `${mappingId}-refresh`)?.revision ??
                  0,
                reason: "Configure bounded context refresh",
              } as never,
            });
          })
        }
      >
        Save refresh schedule
      </Button>
      <p>
        Schedules use the tested service connection and pinned enablement. A
        worker processes due slots; missed intervals coalesce into one bounded
        refresh. Failed batches stay quarantined until retried or reconfigured.
      </p>
      {message ? <p role="status">{message}</p> : null}
    </section>
  );
}
