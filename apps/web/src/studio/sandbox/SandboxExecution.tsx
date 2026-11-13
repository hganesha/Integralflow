import type { Schemas } from "@ehf/ui-contracts";
import { usePolled } from "@ehf/ui-client/react";
import { Button, DigestValue, Field, InlineMessage, LocalTimestamp, TextInput } from "@ehf/ui-kit";
import { ConsoleHeader } from "@ehf/ui-shell";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { api } from "../../app/api";
import { useSession } from "../../app/session";
import { ApiErrorView, Region } from "../../platform/common";
import { Workflow } from "../../platform/surfaces/runs/RunWorkflow";
import { nodeExecution } from "../../platform/surfaces/runs/execution-model";
import { CancelRunSheet } from "../../platform/surfaces/runs/run-parts";
import { useRunEvents, type RuntimeEvent } from "../../platform/surfaces/runs/use-run-events";
import { STUDIO_SANDBOX } from "../navigation";
import { InspectorChoice } from "./InspectorControls";
import { duration, RunComparison, type CompareRun } from "./SandboxCompare";
import { TraceReplay } from "./TraceReplay";
import { SandboxInspector } from "./SandboxInspector";
import { attemptAt, eventScope, eventTab, inspectorTabs, wholeNumber, type InspectorTab, type StepScope } from "./inspection-model";
import styles from "./sandbox.module.css";

type Execution = Schemas["RunExecutionView"];
type SandboxRun = Schemas["SandboxRunHistoryItem"];
const statusLabel = (value: string) => value.replaceAll("_", " ");
/** A run in one of these states never changes again, so nothing about it needs polling. */
const terminal = new Set(["completed", "denied", "failed", "cancelled"]);
/**
 * At rest: final, or stopped for a person. A run in manual review goes back to the queue when the
 * review is resolved, so it is offered what a finished run is (compare, replay) but is still polled.
 */
const atRest = (status: string) => terminal.has(status) || status === "manual_review";

export default function SandboxExecution({ runId }: { runId: string }) {
  const provenance = usePolled(api, "getAuthoringSandboxRunsRunId", { path: { runId } }, { pollWhile: data => !data || !terminal.has(data.status) });
  return <Region polled={provenance} label="sandbox run">
    {record => <RunWorkspace record={record} onRefresh={provenance.refresh} />}
  </Region>;
}

function RunWorkspace({ record, onRefresh }: { record: SandboxRun; onRefresh: () => void }) {
  const { runId } = record;
  const session = useSession();
  const execution = usePolled(api, "getRunsRunIdExecution", { path: { runId } }, { pollWhile: data => !data || !terminal.has(data.run.status) });
  const [cancel, setCancel] = useState(false);
  const run = execution.data?.run;
  const finished = atRest(run?.status ?? record.status);
  const details = <div className={styles.runDetails}>
    <div className={styles.runFacts}>
      <span><strong>Policy pack</strong> {record.policyPack}</span>
      <span><strong>Corpus</strong> {record.records} records · {record.documents} documents loaded{record.documentsSkipped ? ` · ${record.documentsSkipped} skipped` : ""}</span>
      <span><strong>Plan</strong> <DigestValue value={record.planDigest} label="pinned plan digest" /></span>
      {run ? <><span>{run.modelCalls} model calls · {run.capabilityCalls} capability calls</span>
        <span><strong>Reported cost</strong> {run.costComplete || run.costUsd > 0 ? `$${run.costUsd.toFixed(4)}${run.costComplete ? "" : " (partial)"}` : "Unavailable"}</span>
        {run.terminalOutcome ? <span><strong>Outcome</strong> <span className={styles.status}>{run.terminalOutcome}</span></span> : null}
      </> : null}
    </div>
    {run?.errorCode ? <InlineMessage tone="error">{run.errorCode}{run.currentNodeId ? ` · ${run.currentNodeId}` : ""}</InlineMessage> : null}
    {record.policyBlockers ? <InlineMessage tone="warn">{record.policyBlockers} unresolved policy blockers were accepted for this rehearsal.</InlineMessage> : null}
  </div>;
  return <div className={styles.page}>
    <ConsoleHeader
      breadcrumb={[{ label: "Process Studio", href: "/studio" }, { label: "Sandbox Runs", href: STUDIO_SANDBOX }, { label: runId }]}
      title={record.processName}
      meta={<span className={styles.row}><strong className={styles.sandboxBadge}>Sandbox</strong>
        <span>Revision {record.revision} · {record.party}</span><span className={styles.status}>{statusLabel(run?.status ?? record.status)}</span>
      </span>}
      actions={<span className={styles.row}>
        {run ? <a href="#sandbox-inspector">View inspector</a> : null}
        <Link to={STUDIO_SANDBOX as string} search={{ draft: record.draftId, party: record.party }}>New run</Link>
        {session.actions.includes("case.read") ? <Link to={`/platform/cases/${encodeURIComponent(record.caseId)}` as string}>Open case</Link> : null}
        {session.actions.includes("run.cancel") ? <Button size="sm" disabled={!run || finished || record.status === "cancelling"} onClick={() => setCancel(true)}>Cancel run</Button> : null}
      </span>}
    />
    {!run ? details : null}
    <Region polled={execution} label="recorded workflow">
      {data => <Debugger record={record} execution={data} details={details} />}
    </Region>
    {run && cancel ? <CancelRunSheet open onClose={() => setCancel(false)} run={run}
      onRefresh={execution.refresh} onDone={() => { setCancel(false); execution.refresh(); onRefresh(); }} /> : null}
  </div>;
}

function Debugger({ record, execution, details }: { record: SandboxRun; execution: Execution; details: ReactNode }) {
  const { run, plan } = execution;
  const session = useSession();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const settled = terminal.has(run.status);
  const resting = atRest(run.status);
  const canReadEvents = session.actions.includes("event.read");
  const feed = useRunEvents(run.runId, { enabled: canReadEvents, poll: !settled });
  const [filter, setFilter] = useState("");
  const [compareOpen, setCompareOpen] = useState(false);
  const attempt = wholeNumber(search.attempt) ?? run.attempt;
  const epoch = wholeNumber(search.epoch);
  const scope: StepScope | null = typeof search.node === "string" && plan.graph.nodes.some(item => item.id === search.node)
    ? { nodeId: search.node, attempt, epoch } : null;
  const tab = inspectorTabs.find(item => item.value === search.tab)?.value ?? "overview";
  const selectedEvent = feed.events.find(item => item.sequence === wholeNumber(search.event));
  const nodeId = scope?.nodeId ?? run.currentNodeId ?? execution.attempts.findLast(item => item.attempt === attempt)?.nodeId ?? null;
  const callId = typeof search.call === "string" ? search.call : undefined;
  const decisionId = typeof search.decision === "string" ? search.decision : undefined;
  const update = (patch: Record<string, unknown>) => void navigate({
    to: ".", replace: true, search: previous => ({ ...previous, ...patch }),
  });
  const inspect = (id: string, nextTab: InspectorTab, at?: RuntimeEvent) => {
    const eventSelection = at && at.nodeId === id ? eventScope(at, execution) : null;
    const observed = at ? attemptAt(execution, id, at.occurredAt) : nodeExecution(execution, id, attempt).record;
    const nextAttempt = eventSelection?.attempt ?? observed?.attempt ?? attempt;
    update({
      node: id, attempt: nextAttempt, epoch: eventSelection?.epoch ?? observed?.fencingEpoch,
      event: at?.nodeId === id ? at.sequence : undefined, tab: nextTab, call: undefined, decision: undefined, pack: undefined,
    });
  };
  const selectNode = (id: string) => inspect(id, tab === "policy" ? "attempts" : tab);
  const clearScope = () => update({ node: undefined, attempt: undefined, epoch: undefined, event: undefined, call: undefined, decision: undefined, pack: undefined });
  const visibleNodes = plan.graph.nodes.filter(item => `${item.name} ${item.id} ${item.kind}`.toLowerCase().includes(filter.trim().toLowerCase()));
  return <div className={styles.workspace}>
    <SandboxInspector record={record} execution={execution} events={canReadEvents ? feed.events : []} eventsLoading={canReadEvents && feed.loading} settled={settled}
      scope={scope} tab={tab} event={selectedEvent} callId={callId} decisionId={decisionId}
      setTab={next => update({ tab: next })} inspect={inspect} clearScope={clearScope}
      contextPack={typeof search.pack === "string" ? search.pack : undefined}
      openContext={(node, selectedAttempt, selectedEpoch, pack) => update({
        tab: "context", node, attempt: selectedAttempt, epoch: selectedEpoch, pack, call: undefined, event: undefined, decision: undefined,
      })}
      selectCall={call => update({ call })}
      document={typeof search.document === "string" && typeof search.version === "string" ? { id: search.document, version: search.version } : null}
      selectDocument={selection => update({ document: selection?.id, version: selection?.version })}
      inspectCall={(node, selectedAttempt, selectedEpoch, call) => update({
        tab: "capabilities", node, attempt: selectedAttempt, epoch: selectedEpoch, call, event: undefined, decision: undefined,
      })}
      selectDecision={decision => {
        const observed = attemptAt(execution, decision.nodeId, decision.evaluatedAt);
        update({ tab: "policy", node: decision.nodeId, attempt: observed?.attempt ?? attempt, epoch: observed?.fencingEpoch,
          decision: decision.decisionId, event: undefined, call: undefined });
      }} />
    {details}
    <nav className={`${styles.panel} ${styles.tree}`} aria-label="Execution tree">
      <h2>Execution tree</h2>
      <TextInput aria-label="Filter steps" placeholder="Filter steps…" value={filter} onChange={event => setFilter(event.target.value)} />
      <ul className={styles.steps}>{visibleNodes.map(item => {
        const step = nodeExecution(execution, item.id, attempt);
        return <li key={item.id}><button type="button" className={styles.step} aria-pressed={nodeId === item.id} onClick={() => selectNode(item.id)}>
          <strong>{item.name || item.id}</strong><small className={styles.status}>{statusLabel(step.state)}</small>
        </button></li>;
      })}</ul>
      {!visibleNodes.length ? <p>No steps match.</p> : null}
    </nav>
    <div className={styles.center}>
      <section className={styles.panel} aria-labelledby="sandbox-graph">
        <div className={styles.heading}><h2 id="sandbox-graph">Process graph</h2>
          <div className={styles.row}>
            <a className={styles.graphInspectorLink} href="#sandbox-inspector">View inspector</a>
            <Button size="sm" variant={scope || search.attempt !== undefined ? "quiet" : "primary"} onClick={clearScope}>Follow live</Button>
          </div>
        </div>
        <Workflow execution={execution} label="Sandbox process graph" selection={{
          nodeId, attempt, selectNode, selectAttempt: next => {
            const observed = nodeId ? nodeExecution(execution, nodeId, next).record : null;
            update({ node: nodeId ?? undefined, attempt: next, epoch: observed?.fencingEpoch, event: undefined, call: undefined, decision: undefined, pack: undefined });
          },
        }} />
      </section>
      {resting ? <details className={styles.panel} onToggle={event => setCompareOpen(event.currentTarget.open)}>
        <summary>Compare with another run of {record.party}</summary>
        {compareOpen ? <LiveComparison record={record} execution={execution} /> : null}
      </details> : null}
      {canReadEvents ? <Timeline feed={feed} replay={resting} selected={selectedEvent?.sequence} selectEvent={event => {
        if (event.nodeId) inspect(event.nodeId, eventTab(event), event);
        else update({ node: undefined, attempt: undefined, epoch: undefined, tab: "attempts", event: event.sequence, call: undefined, decision: undefined });
      }} /> : null}
    </div>
  </div>;
}

function Timeline({ feed, replay, selected, selectEvent }: { feed: ReturnType<typeof useRunEvents>; replay: boolean; selected?: number; selectEvent: (event: RuntimeEvent) => void }) {
  const [filter, setFilter] = useState("");
  const shown = feed.events.filter(event => `${event.code} ${event.nodeId ?? ""} ${event.status}`.toLowerCase().includes(filter.trim().toLowerCase()));
  return <section className={styles.panel} aria-labelledby="sandbox-events">
    <div className={styles.heading}><h2 id="sandbox-events">Trace timeline</h2>
      {replay ? <TraceReplay events={feed.events.map(event => ({ id: String(event.sequence), title: event.code, at: event.occurredAt }))}
        select={selected => { const event = feed.events.find(event => String(event.sequence) === selected.id); if (event) selectEvent(event); }} /> : null}
      <Field label="Filter events"><TextInput value={filter} onChange={event => setFilter(event.target.value)} placeholder="Event, step, or status…" /></Field>
    </div>
    {feed.error ? <ApiErrorView error={feed.error} action={<Button size="sm" onClick={feed.refresh}>Retry</Button>} /> : null}
    {shown.length ? <ol className={styles.events} aria-label="Recorded events">{shown.map(event => <li key={event.sequence}>
      <button type="button" className={styles.event} aria-pressed={selected === event.sequence} onClick={() => selectEvent(event)}>
        <small>#{event.sequence} <LocalTimestamp iso={event.occurredAt} compact /></small>
        <strong>{event.code}</strong><small>{event.nodeId ?? "Run"} · {event.status}</small>
      </button>
    </li>)}</ol> : <p>{feed.loading ? "Loading events…" : filter ? "No matching events." : "No events recorded yet."}</p>}
  </section>;
}

function compareLive(record: SandboxRun, execution: Execution): CompareRun {
  return {
    label: `Revision ${record.revision} · ${record.runId.slice(4, 12)}`,
    status: statusLabel(execution.run.status), outcome: record.outcome ?? execution.run.terminalOutcome,
    duration: duration(execution.run.startedAt ?? null, execution.run.completedAt ?? null),
    calls: execution.run.capabilityCalls,
    cost: execution.run.costComplete ? execution.run.costUsd : null,
    steps: execution.plan.graph.nodes.map(node => {
      const step = nodeExecution(execution, node.id, execution.run.attempt);
      return { id: node.id, name: node.name || node.id, status: step.state, input: step.record?.inputDigest, output: step.record?.outputDigest };
    }),
  };
}

function LiveComparison({ record, execution }: { record: SandboxRun; execution: Execution }) {
  const history = usePolled(api, "getAuthoringSandboxRuns");
  const [baselineId, select] = useState("");
  const options = history.data?.items.filter(item => item.party === record.party && item.runId !== record.runId) ?? [];
  const baseline = options.find(item => item.runId === baselineId);
  const other = usePolled(api, "getRunsRunIdExecution", { path: { runId: baselineId } }, {
    enabled: Boolean(baseline), pollWhile: result => !result || !terminal.has(result.run.status),
  });
  if (history.error) return <ApiErrorView error={history.error} />;
  if (!options.length) return <p>{history.data ? "Run this synthetic party again to compare outcomes." : "Loading run history…"}</p>;
  return <div className={styles.inspectorStack}>
    <InspectorChoice label="Baseline run" value={baselineId} onChange={select}
      items={[{ value: "", label: "Select a baseline" }, ...options.map(item => ({ value: item.runId, label: `Revision ${item.revision} · ${new Date(item.createdAt).toLocaleString()}` }))]} />
    {baseline ? <Region polled={other} label="baseline execution">{data => <RunComparison baseline={compareLive(baseline, data)} candidate={compareLive(record, execution)} />}</Region> : null}
  </div>;
}
