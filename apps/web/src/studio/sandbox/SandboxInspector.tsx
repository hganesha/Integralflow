import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type { ApiError } from "@ehf/ui-client";
import type { Schemas } from "@ehf/ui-contracts";
import { canReadCatalog } from "@ehf/ui-contracts";
import { Button, Field, LocalTimestamp, Tabs, TextInput } from "@ehf/ui-kit";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { api } from "../../app/api";
import { useSession } from "../../app/session";
import { ApiErrorView } from "../../platform/common";
import { nodeExecution, type Execution } from "../../platform/surfaces/runs/execution-model";
import type { RuntimeEvent } from "../../platform/surfaces/runs/use-run-events";
import { eventScope, humanLabel, incompleteTasks, inspectorTabs, latestEventsByStep, policyLabel, profileLabel, readable, relatedTask, scopedEvents, stepLabel, taskCriteria, type InspectorTab, type PolicyDecision, type StepScope } from "./inspection-model";
import { AdvancedData, InspectorChoice } from "./InspectorControls";
import { ContextObservations, SandboxDocuments, SkillObservations } from "./SandboxObservations";
import styles from "./sandbox.module.css";

type SandboxRun = Schemas["SandboxRunHistoryItem"];
type Inspect = (nodeId: string, tab: InspectorTab, at?: RuntimeEvent) => void;

type Props = {
  record: SandboxRun; execution: Execution; events: readonly RuntimeEvent[]; eventsLoading: boolean; settled: boolean;
  scope: StepScope | null; tab: InspectorTab; event?: RuntimeEvent; callId?: string; decisionId?: string;
  setTab: (tab: InspectorTab) => void; inspect: Inspect; clearScope: () => void;
  contextPack?: string;
  openContext: (nodeId: string, attempt: number, epoch: number, digest: string) => void;
  document: { id: string; version: string } | null;
  selectDocument: (selection: { id: string; version: string } | null) => void;
  inspectCall: (nodeId: string, attempt: number, epoch: number, callId: string) => void;
  selectCall: (id: string | undefined) => void; selectDecision: (decision: PolicyDecision) => void;
};

export function SandboxInspector(props: Props) {
  const { record, execution, scope, tab, setTab, clearScope, events, eventsLoading, settled } = props;
  const session = useSession();
  const canReadCase = session.actions.includes("case.read");
  const canReadEvents = session.actions.includes("event.read");
  const node = execution.plan.graph.nodes.find(item => item.id === scope?.nodeId);
  const policy = useQuery({
    queryKey: ["getAuthoringSandboxRunsRunIdPolicy", record.runId],
    queryFn: ({ signal }) => api.getAuthoringSandboxRunsRunIdPolicy({ path: { runId: record.runId }, signal }),
    enabled: canReadCase && (tab === "overview" || tab === "policy"),
    refetchInterval: settled ? false : 5000,
  });
  const caseStatus = useQuery({
    queryKey: ["getCasesCaseId", "sandbox-inspector", record.caseId],
    queryFn: async ({ signal }) => {
      const view = await api.getCasesCaseId({ path: { caseId: record.caseId }, signal });
      return {
        status: view.case.status,
        periodicReviews: view.graph.nodes.filter(node => node.category === "workItems" && node.data?.work_type === "PERIODIC_CDD_REVIEW").length,
      };
    },
    enabled: canReadCase && (tab === "overview" || tab === "policy"),
    refetchInterval: settled ? false : 5000,
  });
  const decisions = policy.data?.decisions ?? [];
  const lastDecision = decisions.at(-1);
  const contextHistory = events.filter(item => item.code.startsWith("context."));
  const contextEvent = scope ? scopedEvents(contextHistory, execution, scope).at(-1) : undefined;
  const profile = typeof contextEvent?.values.agentId === "string" ? contextEvent.values.agentId
    : typeof node?.config.agentRef === "string" ? node.config.agentRef : undefined;
  const selectedEvents = scopedEvents(events, execution, scope);
  const canReadReceipts = session.actions.includes("receipt.read");

  return <aside className={`${styles.panel} ${styles.inspector}`} aria-labelledby="sandbox-inspector">
    <div className={styles.heading}>
      <h2 id="sandbox-inspector" tabIndex={-1}>{scope ? "Step inspector" : "Run inspector"}</h2>
      {scope ? <Button size="sm" variant="quiet" onClick={clearScope}>View whole run</Button> : null}
    </div>
    {node && scope ? <div className={styles.inspectorStack}>
      <h3>{stepLabel(execution, node.id)}</h3>
      <p className={styles.status}>{node.kind} · Attempt {scope.attempt}{scope.epoch !== undefined ? ` · Epoch ${scope.epoch}` : ""}</p>
    </div> : null}
    {props.event && tab !== "attempts" ? <p className={styles.eventSelection}>
      {humanLabel(props.event.code)} · Event #{props.event.sequence}
      {eventScope(props.event, execution)?.inferred ? " · Historical attempt inferred" : ""}
    </p> : null}
    <Tabs label="Sandbox inspector" items={inspectorTabs} value={tab} onChange={setTab} renderPanel={active => {
      if (active === "overview") return <div className={styles.inspectorStack}>
        <dl className={styles.facts}>
          <dt>Runtime</dt><dd>{readable(execution.run.status)}</dd>
          <dt>Run policy pack</dt><dd>{policyLabel(record.policyPack)}</dd>
          {profile ? <><dt>Agent profile</dt><dd>{profileLabel(profile)}</dd></> : null}
          {scope ? <><dt>Step status</dt><dd>{humanLabel(readable(nodeExecution(execution, scope.nodeId, scope.attempt).state))}</dd></> : null}
          <dt>Current case status</dt><dd>{canReadCase ? caseStatus.data ? readable(caseStatus.data.status) : caseStatus.isError ? "Unavailable" : "Loading…" : "Restricted"}</dd>
          <dt>Latest policy outcome</dt><dd>{canReadCase ? lastDecision ? readable(lastDecision.state) : policy.isPending ? "Loading…" : policy.isError ? "Unavailable" : "No decision recorded" : "Restricted"}</dd>
        </dl>
        {lastDecision ? <DecisionCard decision={lastDecision} select={() => props.selectDecision(lastDecision)} /> : null}
        {policy.error ? <ApiErrorView error={policy.error as ApiError} /> : null}
        {caseStatus.error ? <ApiErrorView error={caseStatus.error as ApiError} /> : null}
        {node?.summary ? <p>{node.summary}</p> : null}
        <p>{record.documents} source documents loaded{record.documentsSkipped ? ` · ${record.documentsSkipped} skipped` : ""}. <button type="button" className={styles.textButton} onClick={() => setTab("documents")}>Inspect documents</button></p>
      </div>;
      if (active === "capabilities") return canReadReceipts
        ? <Capabilities key={`${scope?.nodeId ?? "run"}:${scope?.attempt ?? ""}:${scope?.epoch ?? ""}`} {...props} />
        : <p>Restricted. Capability receipts require receipt access.</p>;
      if (active === "policy") {
        if (!canReadCase) return <p>Restricted. Policy decisions require case access.</p>;
        if (policy.error) return <ApiErrorView error={policy.error as ApiError} />;
        const matching = scope ? decisions.filter(item => item.nodeId === scope.nodeId) : decisions;
        return <div className={styles.inspectorStack}>
          <PolicySummary decisions={matching} decisionId={props.decisionId} events={events} eventsLoading={eventsLoading}
            canReadEvents={canReadEvents} execution={execution} inspect={props.inspect} pending={policy.isPending} />
          {scope ? selectedEvents.filter(event => event.code.startsWith("case.write.")).map(event =>
            <p key={event.sequence}>{event.code}{typeof event.values.commandType === "string" ? ` · ${event.values.commandType}` : ""}</p>) : null}
          <dl className={styles.facts}>
            <dt>Current case periodic review items</dt>
            <dd>{caseStatus.data?.periodicReviews ?? (caseStatus.isError ? "Unavailable" : "Loading…")}</dd>
          </dl>
          {caseStatus.error ? <ApiErrorView error={caseStatus.error as ApiError} /> : null}
          {!canReadEvents ? <p>Restricted. Evidence task links require event access.</p> : null}
        </div>;
      }

      if (active === "context") {
        const options = latestEventsByStep(contextHistory);
        const pinnedEvent = props.event?.code.startsWith("context.") ? props.event : contextEvent;
        const context = pinnedEvent ?? (scope ? undefined : options.find(item => item.nodeId === execution.run.currentNodeId) ?? options[0]);
        const contextScope = scope ?? (context ? eventScope(context, execution) : null);
        const step = contextScope?.nodeId ?? context?.nodeId ?? null;
        return <div className={styles.inspectorStack}>
          <StepChoice label="Context step" execution={execution} options={options} selected={step} tab="context" inspect={props.inspect} />
          <ContextObservations key={`${step ?? ""}:${contextScope?.attempt ?? ""}:${contextScope?.epoch ?? ""}:${props.contextPack ?? ""}`}
            runId={record.runId} scope={contextScope} settled={settled} step={stepLabel(execution, step)}
            event={context} profile={profile} policy={record.policyPack}
            packDigest={props.contextPack ?? (typeof context?.values.packDigest === "string" ? context.values.packDigest : undefined)} />
        </div>;
      }
      if (active === "documents") {
        const pipelineFailure = execution.attempts.findLast(item => item.errorCode?.startsWith("adapter.evidence_pipeline"));
        const extractionNodeId = execution.plan.graph.nodes.find(node => node.config.skillId === "document.fields.contract_extract")?.id;
        const extraction = events.findLast(item => item.nodeId === extractionNodeId && item.code.startsWith("skill.result."));
        return <div className={styles.inspectorStack}>
          <SandboxDocuments runId={record.runId} caseId={record.caseId} scope={scope} settled={settled}
            extractionNodeId={extractionNodeId} documents={record.documents} skipped={record.documentsSkipped}
            selection={props.document} select={props.selectDocument} inspectCall={props.inspectCall} />
          {record.documents === 0 && pipelineFailure ? <section className={styles.detailCard}>
            <strong>No source documents loaded for this run</strong>
            <p>{pipelineFailure.errorCode}</p>
            <button type="button" className={styles.textButton} onClick={() => props.inspect(pipelineFailure.nodeId, "attempts",
              events.findLast(event => event.nodeId === pipelineFailure.nodeId && event.code === "node.failed"))}>Inspect evidence pipeline failure</button>
          </section> : null}
          {extraction?.nodeId ? <button type="button" className={styles.textButton} onClick={() => props.inspect(extraction.nodeId!, "skills", extraction)}>
            Extraction step · {humanLabel(readable(String(extraction.values.status ?? extraction.status)))}
          </button> : null}
        </div>;
      }
      if (active === "skills") return <Skills {...props} selectedEvents={selectedEvents} />;
      return <Attempts {...props} selectedEvents={selectedEvents} />;
    }} />
  </aside>;
}

function StepChoice({ label, execution, options, selected, tab, inspect }: {
  label: string; execution: Execution; options: RuntimeEvent[]; selected: string | null; tab: InspectorTab; inspect: Inspect;
}) {
  if (!options.length || options.length === 1 && options[0]?.nodeId === selected) return null;
  const items = options.flatMap(item => item.nodeId ? [{ value: item.nodeId, label: stepLabel(execution, item.nodeId) }] : []);
  if (!items.some(item => item.value === selected)) items.unshift({ value: "", label: "Choose a recorded step" });
  return <InspectorChoice label={label} value={items.some(item => item.value === selected) ? selected! : ""} items={items} onChange={id => {
    const event = options.find(item => item.nodeId === id);
    if (event) inspect(id, tab, event);
  }} />;
}

function DecisionCard({ decision, select }: { decision: PolicyDecision; select?: () => void }) {
  return <section className={styles.detailCard} aria-label={`${decision.gateId} policy decision`}>
    <strong>{humanLabel(readable(decision.state))} · {humanLabel(decision.gateId)}</strong>
    {decision.reasonCodes.length ? <p>{decision.reasonCodes.map(code => humanLabel(code.toLowerCase())).join(", ")}</p> : null}
    <LocalTimestamp iso={decision.evaluatedAt} />
    {decision.actions.length ? <p>Proposed actions {decision.actions.map(humanLabel).join(", ")}</p> : <p>No policy actions recorded.</p>}
    {select ? <Button size="sm" onClick={select}>Inspect policy decision</Button>
      : <AdvancedData label="Policy decision" data={decision} />}
  </section>;
}

function PolicySummary({ decisions, decisionId, events, eventsLoading, canReadEvents, execution, inspect, pending }: {
  decisions: PolicyDecision[]; decisionId?: string; events: readonly RuntimeEvent[]; eventsLoading: boolean; canReadEvents: boolean;
  execution: Execution; inspect: Inspect; pending: boolean;
}) {
  const [selection, setSelection] = useState("");
  const [taskSelection, setTaskSelection] = useState("");
  const decision = decisions.find(item => item.decisionId === selection) ?? decisions.find(item => item.decisionId === decisionId) ?? decisions.at(-1);
  if (!decision) return <p>{pending ? "Loading policy decisions…" : "No policy decision recorded for this selection."}</p>;
  const tasks = canReadEvents ? incompleteTasks(decision, events) : [];
  const task = tasks.find(item => String(item.sequence) === taskSelection) ?? tasks[0];
  return <>
    {decisions.length > 1 ? <InspectorChoice label="Policy gate" value={decision.decisionId} onChange={setSelection}
      items={decisions.map(item => ({ value: item.decisionId, label: `${humanLabel(item.gateId)} · ${humanLabel(readable(item.state))}` }))} /> : null}
    <DecisionCard key={decision.decisionId} decision={decision} />
    {canReadEvents && decision.reasonCodes.includes("AGENT_TASK_INCOMPLETE")
      ? eventsLoading ? <p>Loading task outcomes…</p> : task ? <details className={styles.advanced}>
        <summary>{tasks.length} incomplete {tasks.length === 1 ? "task" : "tasks"}</summary>
        {tasks.length > 1 ? <InspectorChoice label="Incomplete task" value={String(task.sequence)} onChange={setTaskSelection}
          items={tasks.map(item => ({ value: String(item.sequence), label: stepLabel(execution, item.nodeId) }))} /> : null}
        <EvidenceTask task={task} inspect={inspect} execution={execution} />
      </details> : null : null}
  </>;
}

function EvidenceTask({ task, inspect, execution }: { task: RuntimeEvent; inspect: Inspect; execution: Execution }) {
  const criteria = taskCriteria(task).filter(criterion => !criterion.passed);
  return <section className={styles.detailCard}>
    <strong>{stepLabel(execution, task.nodeId)}</strong>
    {criteria.length ? <ul className={`${styles.compactList} ${styles.boundedList}`}>
      {criteria.map(criterion => <li key={criterion.nodeId}>
        <button type="button" className={styles.textButton} onClick={() => inspect(criterion.nodeId, "skills", task)}>{stepLabel(execution, criterion.nodeId)}</button>
        <span> · {humanLabel(readable(criterion.observed))}</span>
        {criterion.missingFields.length ? <p>Missing {criterion.missingFields.length} {criterion.missingFields.length === 1 ? "field" : "fields"}</p> : null}
      </li>)}
    </ul> : null}
    {task.nodeId ? <button type="button" className={styles.textButton} onClick={() => inspect(task.nodeId!, "capabilities", task)}>Inspect reporting agent calls</button> : null}
    <AdvancedData key={task.sequence} label="Task outcome" data={task.values} />
  </section>;
}

function Skills({ record, execution, scope, events, selectedEvents, inspect, inspectCall, openContext, settled }: Props & { selectedEvents: readonly RuntimeEvent[] }) {
  const session = useSession();
  const skillEvent = (item: RuntimeEvent) => item.code.startsWith("skill.result.") || item.code.startsWith("agent.task.");
  const options = latestEventsByStep(events.filter(skillEvent));
  const current = scope ? selectedEvents.findLast(skillEvent) : options[0];
  const skillScope = scope ?? (current ? eventScope(current, execution) : null);
  const node = execution.plan.graph.nodes.find(item => item.id === skillScope?.nodeId);
  const related = skillScope ? relatedTask(skillScope, events, execution) : undefined;
  return <div className={styles.inspectorStack}>
    <StepChoice label="Skill or task step" execution={execution} options={options} selected={node?.id ?? null} tab="skills" inspect={inspect} />
    {typeof node?.config.skillId === "string" && canReadCatalog(session.actions, "skills") ?
      <Link to={"/catalogs/skills" as string} search={{ selected: node.config.skillId }}>Open skill contract</Link> : null}
    {current?.code.startsWith("agent.task.") ? <EvidenceTask task={current} inspect={inspect} execution={execution} /> : current
      ? <section className={styles.detailCard}>
        <strong>{stepLabel(execution, current.nodeId)}</strong>
        <p>{humanLabel(readable(String(current.values.status ?? current.status)))}
          {typeof current.values.errorCode === "string" ? ` · ${humanLabel(current.values.errorCode.toLowerCase())}` : ""}</p>
        {current.values.skillCalled === false ? <p>The skill stopped before calling the gateway.</p> : null}
        {current.nodeId ? <button type="button" className={styles.textButton} onClick={() => inspect(current.nodeId!, "capabilities", current)}>Inspect calls for this step</button> : null}
        <AdvancedData key={current.sequence} label="Skill result" data={current.values} />
      </section> : null}
    {related?.nodeId ? <Button size="sm" onClick={() => inspect(related.nodeId!, "capabilities", related)}>Inspect reporting agent calls</Button> : null}
    <SkillObservations key={`${skillScope?.nodeId ?? ""}:${skillScope?.attempt ?? ""}`}
      runId={record.runId} scope={skillScope} settled={settled} inspectCall={inspectCall} openContext={openContext} />
  </div>;
}

function Capabilities({ record, scope, callId, selectCall, settled, events, execution, inspect }: Props) {
  const [filter, setFilter] = useState("");
  const session = useSession();
  const queryScope = { runId: record.runId, ...(scope ? { nodeId: scope.nodeId, attempt: scope.attempt, fencingEpoch: scope.epoch } : {}) };
  const calls = useInfiniteQuery({
    queryKey: ["getGatewayDecisions", "sandbox-inspector", record.runId, scope],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ signal, pageParam }) => api.getGatewayDecisions({
      query: { ...queryScope, limit: 100, cursor: pageParam },
      signal,
    }),
    getNextPageParam: page => page.nextCursor ?? undefined,
    refetchInterval: settled ? false : 5000,
  });
  const rows = calls.data?.pages.flatMap(page => page.items) ?? [];
  const pinnedCall = useQuery({
    queryKey: ["getGatewayDecisions", "sandbox-call", queryScope, callId],
    queryFn: async ({ signal }) => (await api.getGatewayDecisions({
      query: { ...queryScope, invocationId: callId, limit: 1 }, signal,
    })).items[0] ?? null,
    enabled: !!callId && !calls.isPending && !rows.some(row => row.receiptId === callId),
  });
  const extraCall = pinnedCall.data;
  if (extraCall && !rows.some(row => row.receiptId === extraCall.receiptId)) rows.unshift(extraCall);
  const visible = rows.filter(call => call.receiptId === callId || `${call.capabilityId} ${call.nodeId} ${call.provider ?? ""}`.toLowerCase().includes(filter.trim().toLowerCase()));
  const call = callId ? visible.find(item => item.receiptId === callId) : visible[0];
  const related = scope ? relatedTask(scope, events, execution) : undefined;
  return <div className={styles.inspectorStack}>
    <Field label="Filter calls"><TextInput value={filter} onChange={event => setFilter(event.target.value)} placeholder="Capability, step, or provider…" /></Field>
    {calls.error ? <ApiErrorView error={calls.error as ApiError} /> : null}
    {pinnedCall.error ? <ApiErrorView error={pinnedCall.error as ApiError} /> : null}
    {callId && pinnedCall.isFetching ? <p>Looking up selected call…</p> : null}
    {callId && pinnedCall.data === null ? <p>The selected call is unavailable in this scope.</p> : null}
    {calls.isPending ? <p>Loading capability calls…</p> : !calls.isError && !visible.length ? <p>{filter ? "No loaded calls match the filter." : "No gateway calls recorded for this selection."}</p> : null}
    {visible.length > 1 ? <InspectorChoice label="Recorded call" value={call?.receiptId ?? ""} onChange={selectCall}
      items={visible.map(item => ({ value: item.receiptId, label: `${humanLabel(item.capabilityId)} · ${humanLabel(item.resultStatus ?? item.decision)}` }))} /> : null}
    {call ? <section className={styles.detailCard}>
      <strong>{humanLabel(call.capabilityId)}</strong>
      <dl className={styles.facts}>
        <dt>Step</dt><dd>{stepLabel(execution, call.nodeId)}</dd>
        <dt>Result</dt><dd>{humanLabel(call.resultStatus ?? call.decision)}</dd>
        {call.provider ? <><dt>Provider</dt><dd>{call.provider}</dd></> : null}
        {call.model ? <><dt>Model</dt><dd>{call.model}</dd></> : null}
        {call.latencyMs != null ? <><dt>Latency</dt><dd>{call.latencyMs} ms</dd></> : null}
        {call.errorCode ? <><dt>Result reason</dt><dd>{humanLabel(call.errorCode)}</dd></> : null}
        {call.usage?.costUsd != null ? <><dt>Reported cost</dt><dd>${call.usage.costUsd.toFixed(4)}</dd></> : null}
      </dl>
      {call.traceId && session.actions.includes("telemetry.read") ? <Link to={`/platform/traces/${encodeURIComponent(call.traceId)}` as string}>Inspect trace</Link> : null}
      <AdvancedData key={call.receiptId} label="Gateway receipt" data={call} />
    </section> : null}
    {calls.hasNextPage ? <Button size="sm" onClick={() => void calls.fetchNextPage()} busy={calls.isFetchingNextPage}>Load older calls</Button> : null}
    {related?.nodeId ? <Button size="sm" onClick={() => inspect(related.nodeId!, "capabilities", related)}>Inspect reporting agent calls</Button> : null}
  </div>;
}

function Attempts({ execution, scope, event, selectedEvents }: Props & { selectedEvents: readonly RuntimeEvent[] }) {
  const node = execution.plan.graph.nodes.find(item => item.id === scope?.nodeId);
  const attempt = scope && node ? nodeExecution(execution, node.id, scope.attempt).record : null;
  const session = useSession();
  return <div className={styles.inspectorStack}>
    {attempt ? <dl className={styles.facts}>
      <dt>Attempt / epoch</dt><dd>{attempt.attempt} / {attempt.fencingEpoch}</dd>
      <dt>Status</dt><dd>{attempt.status}</dd>
      {attempt.startedAt ? <><dt>Started</dt><dd><LocalTimestamp iso={attempt.startedAt} /></dd></> : null}
      {attempt.completedAt ? <><dt>Completed</dt><dd><LocalTimestamp iso={attempt.completedAt} /></dd></> : null}
      {attempt.errorCode ? <><dt>Error</dt><dd>{attempt.errorCode}</dd></> : null}
      {attempt.traceId && session.actions.includes("telemetry.read") ? <><dt>Trace</dt><dd><Link to={`/platform/traces/${encodeURIComponent(attempt.traceId)}` as string}>Inspect trace</Link></dd></> : null}
    </dl> : <p>{scope ? "No attempt recorded for this step." : "Select a step to inspect its attempts and digests."}</p>}
    {node || attempt ? <AdvancedData key={node?.id} label="Step and attempt data" data={{ configuration: node?.config, attempt }} /> : null}
    {event ? <section className={styles.detailCard} aria-label="Selected runtime event">
      <strong>{humanLabel(event.code)} · Event #{event.sequence}</strong>
      {eventScope(event, execution)?.inferred ? <p>Historical attempt inferred from the recorded step timestamps.</p> : null}
      <AdvancedData key={event.sequence} label="Event data" data={event.values} />
    </section> : <p>{selectedEvents.length} recorded events in this selection.</p>}
  </div>;
}
