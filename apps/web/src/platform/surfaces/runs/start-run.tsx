import { ApiError } from "@ehf/ui-client";
import type { Schemas } from "@ehf/ui-contracts";
import { Button, Disclosure, Field, Id, InlineMessage, Sheet, TextArea, TextInput } from "@ehf/ui-kit";
import { Link } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { ApiErrorView, useCommand } from "../../common";
import { runPath, SYSTEM_PATH } from "./components";
import { newRequestKey, parseRunInput, templateFor, type InputIssue, type InputSchema } from "./run-input";
import styles from "./runs.module.css";

type RunRecord = Schemas["runRecord"];

/** Upstream answers run.environment_stopped; the mock answers runtime.admission_stopped (GAP-031). */
const ADMISSION_STOPPED = new Set(["runtime.admission_stopped", "run.environment_stopped"]);

type Outcome = { runId: string; replayed: boolean };

/**
 * Start a run of an admitted plan (`run.start`). Each request carries an Idempotency-Key that
 * stays the same until the input changes or "New request" is pressed, so a retry or a double
 * submit returns the run already started and the UI links to it (PLT-05 AC1).
 */
export function StartRunSheet({ open, onClose, planDigest, inputSchema }: { open: boolean; onClose: () => void; planDigest: string; inputSchema: InputSchema }) {
  const [text, setText] = useState(() => templateFor(inputSchema));
  const [sourceContextDigest, setSourceContextDigest] = useState("");
  const [issues, setIssues] = useState<InputIssue[]>([]);
  const [requestKey, setRequestKey] = useState(newRequestKey);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const started = useRef(new Map<string, string>());
  const start = useCommand("postRuns", { invalidate: [["getPlansPlanDigestRuns"], ["getRuns"], ["getOverview"]] });

  const newRequest = () => {
    setRequestKey(newRequestKey());
    setOutcome(null);
    start.reset();
  };
  const edit = (value: string) => {
    setText(value);
    setIssues([]);
    // Different input is a different request: never reuse the key for it.
    if (outcome || start.state !== "idle") newRequest();
  };
  const close = () => {
    setIssues([]);
    onClose();
  };
  const submit = async () => {
    const parsed = parseRunInput(text, inputSchema);
    if (!parsed.ok) {
      setIssues(parsed.issues);
      return;
    }
    setIssues([]);
    if (sourceContextDigest.trim() && !/^[a-f0-9]{64}$/.test(sourceContextDigest.trim())) {
      setIssues([{ path: "sourceContextDigest", message: "Enter the 64-character digest of an approved source context." }]);
      return;
    }
    const response = await start.run({ body: { planDigest, input: parsed.value as Record<string, never>, ...(sourceContextDigest.trim() ? { sourceContextDigest: sourceContextDigest.trim() } : {}) }, idempotencyKey: requestKey });
    if (!response) return;
    // Contract: runRecord with 201. Upstream: { created, run } with 202 / 200 on replay (GAP-030).
    const loose = response as RunRecord | { created?: boolean; run?: RunRecord };
    const run = "run" in loose && loose.run ? loose.run : (loose as RunRecord);
    const replayed = ("created" in loose && loose.created === false) || started.current.get(requestKey) === run.runId;
    started.current.set(requestKey, run.runId);
    setOutcome({ runId: run.runId, replayed });
  };

  const stopped = start.error instanceof ApiError && ADMISSION_STOPPED.has(start.error.reason);

  return (
    <Sheet
      open={open}
      onClose={close}
      title="Start run"
      description="The input is checked against the plan's input schema here, and again by the server."
      footer={(
        <>
          <Button onClick={close}>Close</Button>
          <Button variant="primary" icon="play" busy={start.busy} disabled={start.busy} onClick={() => void submit()}>
            {start.busy ? "Starting…" : "Start run"}
          </Button>
        </>
      )}
    >
      <div className={styles.section}>
        <Field label="Run input (JSON)" hint={`Required: ${(inputSchema.required ?? []).join(", ") || "none"}`} error={issues.length ? `${issues.length} problem${issues.length === 1 ? "" : "s"} with the input` : undefined}>
          <TextArea mono rows={10} value={text} readOnly={start.busy} onChange={(event) => edit(event.target.value)} spellCheck={false} />
        </Field>
        <Field label="Jurisdiction source context digest" hint="Required for governed and production runs. Use an independently approved source context for this case and plan.">
          <TextInput mono value={sourceContextDigest} readOnly={start.busy} onChange={(event) => { setSourceContextDigest(event.target.value); setIssues([]); if (outcome || start.state !== "idle") newRequest(); }} />
        </Field>
        {issues.length ? (
          <ul className={styles.issues} aria-label="Input problems">
            {issues.map((issue) => (
              <li key={`${issue.path}-${issue.message}`} className={styles.issue}>
                <span className={styles.mono}>{issue.path}</span>
                <span className={styles.small}>{issue.message}</span>
              </li>
            ))}
          </ul>
        ) : null}
        <div className={styles.toolbar}>
          <span className={styles.small}>Request key <Id>{requestKey}</Id></span>
          <Button size="sm" icon="refresh" onClick={newRequest}>New request</Button>
        </div>
        {stopped ? (
          <Disclosure tone="blocking" title="Run admission is stopped in this environment" code={start.error!.reason}>
            No new runs are admitted until an operator resumes admission. <Link to={SYSTEM_PATH} search={{ tab: "runtime" }}>Open Health › Runtime</Link>
          </Disclosure>
        ) : start.error ? <ApiErrorView error={start.error} /> : null}
        {start.state === "confirmed" && outcome ? (
          outcome.replayed ? (
            <InlineMessage tone="warn">
              This request already started run <Id>{outcome.runId}</Id>. No duplicate was created. <Link to={runPath(outcome.runId)}>Open run {outcome.runId}</Link>
            </InlineMessage>
          ) : (
            <InlineMessage tone="ok">
              Run <Id>{outcome.runId}</Id> started. <Link to={runPath(outcome.runId)}>Open run {outcome.runId}</Link>
            </InlineMessage>
          )
        ) : null}
      </div>
    </Sheet>
  );
}
