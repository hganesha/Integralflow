import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { usePolled } from "@ehf/ui-client/react";
import { Button, Id, LocalTimestamp } from "@ehf/ui-kit";
import { canUse } from "@ehf/ui-shell";
import { api } from "../../app/api";
import { useSession } from "../../app/session";
import styles from "../surfaces/operations/operations.module.css";
type Binding = {
  digest: string;
  definition: {
    id: string;
    caseId: string;
    mappingId: string;
    enabled: boolean;
    subjects: string[];
  };
};
type Pull = {
  runId: string;
  bindingId: string;
  status: string;
  committed: boolean;
  errorCode: string | null;
  createdAt: string;
  completedAt: string | null;
};
export function CaseContextPulls({ caseId }: { caseId: string }) {
  const session = useSession(),
    client = useQueryClient();
  const bindings = usePolled(api, "getContextCasesCaseIdBindings", {
    path: { caseId },
  });
  const pulls = usePolled(api, "getContextCasesCaseIdPulls", {
    path: { caseId },
  });
  const rows = ((bindings.data?.items ?? []) as unknown as Binding[]).filter(
    (b) => b.definition.caseId === caseId,
  );
  const runs = (pulls.data?.items ?? []) as unknown as Pull[];
  const [busy, setBusy] = useState<string | null>(null),
    [message, setMessage] = useState("");
  const completed = runs.find((r) => r.committed)?.runId;
  const refreshed = useRef<string | null>(null);
  useEffect(() => {
    if (!completed || refreshed.current === completed) return;
    refreshed.current = completed;
    void client.invalidateQueries({
      predicate: (q) =>
        !String(q.queryKey[0]).startsWith("getContextCases") &&
        JSON.stringify(q.queryKey).includes(caseId),
    });
  }, [completed, caseId, client]);
  const pull = async (b: Binding) => {
    setBusy(b.definition.id);
    setMessage("");
    try {
      await api.call("postContextCasesCaseIdPulls", {
        path: { caseId },
        body: {
          bindingId: b.definition.id,
          expectedBindingDigest: b.digest,
          subjects: b.definition.subjects,
          idempotencyKey: crypto.randomUUID(),
        },
      });
      setMessage(
        "Pull queued. Context becomes available after validation and case commit.",
      );
      pulls.refresh();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Context pull failed.");
    } finally {
      setBusy(null);
    }
  };
  return (
    <section className={styles.section} aria-label="Case source context">
      <h2 className={styles.sectionTitle}>Source context</h2>
      <p>
        Pull approved customer records into this case. Viewing the case makes no
        source calls. Each task keeps its captured snapshot.
      </p>
      {bindings.error || pulls.error ? (
        <p role="alert">{bindings.error?.message ?? pulls.error?.message}</p>
      ) : null}
      {!bindings.error && bindings.data && !rows.length ? (
        <p>No approved source bindings for this case.</p>
      ) : null}
      {rows.map((b) => {
        const last = runs.find((r) => r.bindingId === b.definition.id),
          pending =
            last && ["queued", "running", "retrying"].includes(last.status);
        return (
          <div key={b.definition.id} className={styles.section}>
            <h3>
              <Id>{b.definition.mappingId}</Id>
            </h3>
            <p>
              {b.definition.subjects.length} approved subjects ·{" "}
              {b.definition.enabled ? "Enabled" : "Paused"}
            </p>
            {last ? (
              <p role="status">
                {last.committed ? "Committed to case" : last.status} ·{" "}
                <LocalTimestamp iso={last.completedAt ?? last.createdAt} />
                {last.errorCode ? ` · ${last.errorCode}` : ""}
              </p>
            ) : (
              <p>No pull recorded.</p>
            )}
            <Button
              busy={busy === b.definition.id}
              disabled={
                Boolean(busy) ||
                Boolean(pending) ||
                !b.definition.enabled ||
                !canUse(session, ["run.start"]) ||
                Boolean(bindings.error)
              }
              onClick={() => void pull(b)}
            >
              {last?.status === "failed"
                ? "Retry context pull"
                : "Pull context"}
            </Button>
          </div>
        );
      })}
      <Button
        onClick={() => {
          bindings.refresh();
          pulls.refresh();
        }}
      >
        Refresh pull status
      </Button>
      {message ? <p role="status">{message}</p> : null}
    </section>
  );
}
