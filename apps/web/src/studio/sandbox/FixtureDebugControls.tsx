import type { Schemas } from "@ehf/ui-contracts";
import { Button, Field, InlineMessage, TextArea } from "@ehf/ui-kit";
import { Link, useNavigate } from "@tanstack/react-router";
import { useRef, useState } from "react";
import { useSession } from "../../app/session";
import { ApiErrorView, useCommand } from "../../platform/common";
import { InspectorChoice } from "./InspectorControls";
import { sandboxPath, sandboxTestSearch } from "./test-run-path";
import styles from "./sandbox.module.css";

type Run = Schemas["DraftTestRun"];
type Action = Schemas["DraftTestControl"]["action"];
const readKeys = [["getAuthoringDraftsDraftIdTestRuns"], ["getAuthoringDraftsDraftIdTestRunsTestRunId"]] as const;

export function FixtureDebugControls({ run }: { run: Run }) {
  const { debug } = run;
  const session = useSession();
  const control = useCommand("postAuthoringDraftsDraftIdTestRunsTestRunIdControl", { invalidate: readKeys });
  const cancel = useCommand("postAuthoringDraftsDraftIdTestRunsTestRunIdCancel", { invalidate: readKeys });
  if (!debug || !session.actions.includes("draft.evaluate")) return null;
  const path = { draftId: run.draftId, testRunId: run.testRunId };
  const boundary = debug.boundary;
  const step = run.nodes.find(node => node.nodeId === boundary?.nodeId);
  const submit = (action: Action) => {
    if (control.busy || run.status !== "running" || (action !== "pause" && !boundary) || (action === "pause" && boundary)) return;
    void control.run({ path, body: { action, ...(boundary ? { boundary: boundary.sequence } : {}) } });
  };
  return <section className={styles.inspectorStack} aria-label="Fixture execution controls" onKeyDown={event => {
    if (event.repeat || event.altKey || event.ctrlKey || event.metaKey || event.target instanceof HTMLInputElement
      || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement) return;
    const action = event.key === "F8" ? (boundary ? "continue" : "pause") : event.key === "F10" ? "step_over"
      : event.key === "F11" ? (event.shiftKey ? "step_out" : "step_into") : null;
    if (action && run.status === "running") { event.preventDefault(); submit(action); }
  }}>
    <p role="status">{boundary ? `Paused before ${boundary.capabilityId ?? step?.name ?? boundary.nodeId} · ${boundary.reason}`
      : run.status === "running" ? "Fixture execution running" : "Fixture execution finished"}</p>
    {run.status === "running" ? <div className={styles.row}>
      <Button size="sm" disabled={control.busy} onClick={() => submit(boundary ? "continue" : "pause")} title="F8">{boundary ? "Continue" : "Pause at next step"}</Button>
      <Button size="sm" disabled={!boundary || control.busy} onClick={() => submit("step_over")} title="F10">Step over</Button>
      <Button size="sm" disabled={!boundary || control.busy} onClick={() => submit("step_into")} title="F11">Step into</Button>
      <Button size="sm" disabled={!boundary?.capabilityId || control.busy} onClick={() => submit("step_out")} title="Shift+F11">Step out</Button>
      <Button size="sm" disabled={cancel.busy} onClick={() => void cancel.run({ path })}>Cancel test</Button>
    </div> : null}
    {control.error ? <ApiErrorView error={control.error} /> : null}
    {cancel.error ? <ApiErrorView error={cancel.error} /> : null}
    {debug.checkpoints.length && session.actions.includes("draft.compile") ? <FixtureFork run={run} /> : null}
  </section>;
}

function FixtureFork({ run }: { run: Run }) {
  const [selection, select] = useState("");
  const [text, setText] = useState("{}");
  const [error, setError] = useState<string | null>(null);
  const key = useRef<string | null>(null);
  const navigate = useNavigate();
  const fork = useCommand("postAuthoringDraftsDraftIdTestRunsTestRunIdFork", { invalidate: readKeys });
  const checkpoints = run.debug!.checkpoints;
  const checkpoint = checkpoints.find(item => item.id === selection)
    ?? checkpoints.findLast(item => item.nodeId === run.debug?.boundary?.nodeId) ?? checkpoints.at(-1)!;
  const node = run.nodes.find(node => node.nodeId === checkpoint.nodeId);
  const submit = async (scope: "step" | "downstream") => {
    let overrides: Schemas["DraftTestFork"]["overrides"];
    try {
      overrides = JSON.parse(text);
      if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) throw new Error("Use a JSON object for overrides.");
    } catch { setError("Enter overrides as a JSON object."); return; }
    setError(null);
    const requestKey = key.current ??= crypto.randomUUID();
    const result = await fork.run({ path: { draftId: run.draftId, testRunId: run.testRunId },
      body: { checkpointId: checkpoint.id, scope, overrides }, idempotencyKey: `${requestKey}-${scope}` });
    if (result) {
      key.current = null;
      void navigate({ to: sandboxPath(result.testRunId), search: { ...sandboxTestSearch("rehearsal", run.draftId), tab: "compare" } });
    }
  };
  return <details className={styles.advanced}>
    <summary>Fork fixture checkpoint</summary>
    <div className={styles.inspectorStack}>
      <InspectorChoice label="Checkpoint" value={checkpoint.id} onChange={id => { select(id); key.current = null; }}
        items={checkpoints.map(item => ({ value: item.id, label: `${run.nodes.find(node => node.nodeId === item.nodeId)?.name ?? item.nodeId} · ${item.id.slice(0, 8)}` }))} />
      <Field label="Fixture overrides" hint="Optional JSON patches for input, context or capabilityOutputs.">
        <TextArea mono rows={4} value={text} disabled={fork.busy} onChange={event => { setText(event.target.value); key.current = null; }} />
      </Field>
      <p>Checkpoint available until {new Date(run.debug!.expiresAt).toLocaleTimeString()} while this worker is available.</p>
      <div className={styles.row}>
        <Button size="sm" disabled={fork.busy || node?.kind === "approval"} onClick={() => void submit("step")}>Rerun step</Button>
        <Button size="sm" disabled={fork.busy} onClick={() => void submit("downstream")}>Rerun downstream</Button>
      </div>
      {error ? <InlineMessage tone="warn">{error}</InlineMessage> : null}
      {fork.error ? <ApiErrorView error={fork.error} /> : null}
    </div>
  </details>;
}

export function ForkOrigin({ run }: { run: Run }) {
  if (!run.fork) return null;
  return <p>{run.fork.scope === "step" ? "Isolated step probe" : "Downstream fixture fork"} · {run.fork.nodeId} ·{" "}
    <Link to={sandboxPath(run.fork.parentRunId)} search={sandboxTestSearch("rehearsal", run.draftId)}>Open baseline</Link>
    {run.fork.overrideKeys.length ? ` · Overrides ${run.fork.overrideKeys.join(", ")}` : null}
  </p>;
}
