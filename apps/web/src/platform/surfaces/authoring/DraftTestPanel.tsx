import type { Schemas } from "@ehf/ui-contracts";
import { usePolled } from "@ehf/ui-client/react";
import { Button, Field, InlineMessage, JsonViewer, Select, TextArea, TextInput } from "@ehf/ui-kit";
import { Link, useNavigate } from "@tanstack/react-router";
import { sandboxPath, sandboxTestSearch } from "../../../studio/sandbox/test-run-path";
import { useRef, useState } from "react";
import { api } from "../../../app/api";
import { ApiErrorView, Region, useCommand } from "../../common";
import { workflowNodes } from "./model";
import { useWorkspace } from "./context";
import styles from "./authoring.module.css";

export type DraftTestRun = Schemas["DraftTestRun"];
export type DraftTestNode = Schemas["DraftTestNode"];
const LABEL: Record<DraftTestNode["status"], string> = { pending: "Pending", running: "Running", completed: "Completed", failed: "Failed", skipped: "Skipped", blocked: "Blocked" };
const newKey = () => `draft-test-${crypto.randomUUID()}`;

export function DraftTestPanel({ run, runId, onRun, disabledReason }: { run: DraftTestRun | undefined; runId: string | undefined; onRun(id: string): void; disabledReason: string | null }) {
  const { draft, selectedNodeId, selectNode, actions } = useWorkspace();
  const samples = usePolled(api, "getAuthoringDraftsDraftIdTestSamples", { path: { draftId: draft.draftId } });
  const history = usePolled(api, "getAuthoringDraftsDraftIdTestRuns", { path: { draftId: draft.draftId } });
  const cancel = useCommand("postAuthoringDraftsDraftIdTestRunsTestRunIdCancel", { invalidate: [["getAuthoringDraftsDraftIdTestRuns"], ["getAuthoringDraftsDraftIdTestRunsTestRunId"]] });
  const selected = run?.nodes.find(node => node.nodeId === selectedNodeId);
  return <div className={styles.stack}>
    <p className={styles.muted}>Test the saved flow with sample data. Tool calls use sample responses; case writes are suppressed.</p>
    <Region polled={samples} label="test samples">{data => <TestInput samples={data.items} disabledReason={disabledReason} onRun={onRun} running={run?.status === "running"} />}</Region>
    <Field label="Test history">
      <Select value={runId ?? ""} onChange={event => { if (event.target.value) onRun(event.target.value); }}>
        <option value="">Select a test run</option>
        {history.data?.items.map(item => <option key={item.testRunId} value={item.testRunId}>Revision {item.revision} · {item.status} · {new Date(item.createdAt).toLocaleTimeString()}</option>)}
      </Select>
    </Field>
    {history.error ? <ApiErrorView error={history.error} /> : null}
    {run ? <section aria-label="Draft test results" className={styles.stack}>
      <div className={styles.cardHead}><strong>Test {run.status}</strong><span>Revision {run.revision}</span>
        <Link to={sandboxPath(run.testRunId)} search={sandboxTestSearch("rehearsal", draft.draftId)}>Inspect in Sandbox Studio</Link>
      </div>
      {run.revision !== draft.revision ? <InlineMessage tone="warn">This test used revision {run.revision}. The canvas is now revision {draft.revision}; run it again to test the changes.</InlineMessage> : null}
      <p className={styles.muted}>{run.mode === "recorded" ? "Recorded model responses" : "Configured model inference"} · {run.calls.length} capability calls</p>
      {run.warnings.map(warning => <p className={styles.muted} key={warning}>{warning}</p>)}
      {run.error ? <InlineMessage tone={run.status === "blocked" ? "warn" : "error"}>{run.error}</InlineMessage> : null}
      {run.status === "running" && actions.includes("draft.evaluate") ? <Button size="sm" busy={cancel.busy} onClick={() => void cancel.run({ path: { draftId: draft.draftId, testRunId: run.testRunId } })}>Cancel test</Button> : null}
      {cancel.error ? <ApiErrorView error={cancel.error} /> : null}
      <ul className={styles.testNodes} aria-label="Test node results">
        {run.nodes.map(node => <li key={node.nodeId}><button className={styles.testNode} type="button" aria-pressed={node.nodeId === selectedNodeId} onClick={() => selectNode(node.nodeId)}><span>{node.name}</span><span data-test-status={node.status}>{LABEL[node.status]}</span></button></li>)}
      </ul>
      {selected ? <section className={styles.stack} aria-label={`Test result for ${selected.name}`}>
        <h3 className={styles.panelTitle}>{selected.name} · {LABEL[selected.status]}</h3>
        {selected.error ? <InlineMessage tone="error">{selected.error}</InlineMessage> : null}
        <JsonViewer label="Node input" data={selected.input} />
        <JsonViewer label="Node output" data={selected.output} />
      </section> : <p className={styles.muted}>Select a node here or on the canvas to inspect its input and output.</p>}
      {run.status === "completed" ? <JsonViewer label="Flow output" data={run.output} /> : null}
      {run.calls.length ? <JsonViewer label="Model and tool calls" data={run.calls} /> : null}
    </section> : null}
  </div>;
}

function TestInput({ samples, onRun, disabledReason, running }: { samples: Schemas["DraftTestSample"][]; onRun(id: string): void; disabledReason: string | null; running: boolean }) {
  const { draft } = useWorkspace();
  const navigate = useNavigate();
  const first = samples[0];
  const [sampleId, setSampleId] = useState(first?.id ?? "");
  const [text, setText] = useState(() => JSON.stringify(first ? { input: first.input, context: first.context, capabilityOutputs: first.capabilityOutputs } : { input: {}, context: {}, capabilityOutputs: {} }, null, 2));
  const [mode, setMode] = useState<"recorded" | "models">("recorded");
  const [debug, setDebug] = useState(false);
  const [breakpoint, setBreakpoint] = useState("");
  const [condition, setCondition] = useState<"step" | "nodeKind" | "capabilityId">("step");
  const [equals, setEquals] = useState("");
  const [error, setError] = useState<string | null>(null);
  const key = useRef(newKey());
  const start = useCommand("postAuthoringDraftsDraftIdTestRuns", { invalidate: [["getAuthoringDraftsDraftIdTestRuns"]] });
  const disabled = disabledReason ?? (running ? "Wait for the current test or cancel it." : null);
  const submit = async () => {
    let values: { input: Record<string, never>; context: Record<string, never>; capabilityOutputs: Record<string, never> };
    try {
      values = JSON.parse(text);
      if (!values || [values.input, values.context, values.capabilityOutputs].some(value => !value || typeof value !== "object" || Array.isArray(value))) throw new Error("Provide input, context and capabilityOutputs as JSON objects.");
    } catch (e) { setError(e instanceof Error ? e.message : "Enter valid JSON."); return; }
    if (debug && breakpoint && condition !== "step" && !equals.trim()) { setError("Enter a breakpoint value."); return; }
    setError(null);
    const breakpointConfig = breakpoint ? [{ nodeId: breakpoint, ...(condition === "step" ? {} : { when: { field: condition, equals: equals.trim() } }) }] : [];
    const result = await start.run({ path: { draftId: draft.draftId }, body: { expectedRevision: draft.revision, mode, input: values.input, context: values.context, capabilityOutputs: values.capabilityOutputs,
      ...(debug && mode === "recorded" ? { debug: { pauseAtStart: !breakpoint, breakpoints: breakpointConfig } } : {}) }, idempotencyKey: `${key.current}-r${draft.revision}` });
    if (result) {
      onRun(result.testRunId);
      key.current = newKey();
      if (result.debug) void navigate({ to: sandboxPath(result.testRunId), search: sandboxTestSearch("rehearsal", draft.draftId) });
    }
  };
  return <form className={styles.stack} aria-label="Test draft" onSubmit={event => { event.preventDefault(); void submit(); }}>
    <Field label="Sample data"><Select value={sampleId} disabled={start.busy} onChange={event => {
      const sample = samples.find(item => item.id === event.target.value);
      if (!sample) return;
      setSampleId(sample.id); setText(JSON.stringify({ input: sample.input, context: sample.context, capabilityOutputs: sample.capabilityOutputs }, null, 2)); setError(null); key.current = newKey(); start.reset();
    }}>{samples.map(sample => <option key={sample.id} value={sample.id}>{sample.name}</option>)}</Select></Field>
    <p className={styles.muted}>{samples.find(sample => sample.id === sampleId)?.description}</p>
    <Field label="Model execution"><Select value={mode} disabled={start.busy} onChange={event => { setMode(event.target.value as "recorded" | "models"); key.current = newKey(); start.reset(); }}>
      <option value="recorded">Recorded responses · no provider calls</option><option value="models">Configured models · live inference</option>
    </Select></Field>
    {mode === "models" ? <InlineMessage tone="warn">Sample data will be sent to the configured model provider. Provider charges may apply.</InlineMessage> : null}
    {mode === "recorded" ? <div className={styles.stack}>
      <label><input type="checkbox" checked={debug} disabled={start.busy} onChange={event => { setDebug(event.target.checked); key.current = newKey(); }} /> Debug in Sandbox Studio</label>
      {debug ? <>
        <Field label="Breakpoint step"><Select value={breakpoint} disabled={start.busy} onChange={event => { setBreakpoint(event.target.value); key.current = newKey(); }}>
          <option value="">Pause at the first step</option>
          {workflowNodes(draft).map(node => <option key={node.id} value={node.id}>{node.name || node.id}</option>)}
        </Select></Field>
        {breakpoint ? <Field label="Breakpoint condition"><Select value={condition} disabled={start.busy} onChange={event => {
          setCondition(event.target.value as typeof condition); key.current = newKey();
        }}><option value="step">Before the step</option><option value="nodeKind">Node kind equals</option><option value="capabilityId">Capability ID equals</option></Select></Field> : null}
        {breakpoint && condition !== "step" ? <Field label="Breakpoint value"><TextInput value={equals} disabled={start.busy} onChange={event => { setEquals(event.target.value); key.current = newKey(); }} /></Field> : null}
      </> : null}
    </div> : null}
    <Field label="Test data (JSON)" hint="input: workflow input; context: sample case fields; capabilityOutputs: tool responses keyed by capability ID." error={error ?? undefined}>
      <TextArea mono rows={12} value={text} readOnly={start.busy} onChange={event => { setText(event.target.value); setError(null); key.current = newKey(); start.reset(); }} spellCheck={false} />
    </Field>
    {disabled ? <p className={styles.muted}>{disabled}</p> : null}
    {start.error ? <ApiErrorView error={start.error} /> : null}
    <Button type="submit" variant="primary" icon="play" busy={start.busy} disabled={Boolean(disabled) || start.busy}>Run draft test</Button>
  </form>;
}
