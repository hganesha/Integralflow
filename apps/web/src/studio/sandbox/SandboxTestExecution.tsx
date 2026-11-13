import type { Schemas } from "@ehf/ui-contracts";
import { usePolled } from "@ehf/ui-client/react";
import { InlineMessage, Tabs, Table } from "@ehf/ui-kit";
import { ConsoleHeader } from "@ehf/ui-shell";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { api } from "../../app/api";
import { SourceViewer } from "../../documents/SourceViewer";
import { ApiErrorView, Region } from "../../platform/common";
import { STUDIO_SANDBOX } from "../navigation";
import { FixtureDebugControls, ForkOrigin } from "./FixtureDebugControls";
import { AdvancedData, InspectorChoice } from "./InspectorControls";
import { duration, reportedCost, RunComparison, type CompareRun } from "./SandboxCompare";
import { humanLabel, inspectorTabs, readable, type InspectorTab } from "./inspection-model";
import { TraceReplay, type ReplayEvent } from "./TraceReplay";
import { type SandboxTestKind } from "./test-run-path";
import styles from "./sandbox.module.css";

type Rehearsal = Schemas["DraftTestRun"];
type DocumentTest = Schemas["DocumentStudioTest"];
type Evaluation = Schemas["WorkspaceEvaluation"];
type TestTab = InspectorTab | "compare";
type Step = { id: string; name: string; status: string };

const available = (tabs: TestTab[]) => [
  ...inspectorTabs.filter(tab => tabs.includes(tab.value)),
  ...tabs.includes("compare") ? [{ value: "compare", label: "Compare" } as const] : [],
];

const statusLabel = (status: string) => humanLabel(readable(status));

export default function SandboxTestExecution({ kind, runId, target }: { kind: SandboxTestKind; runId: string; target?: string }) {
  if (kind === "document") return <DocumentRun runId={runId} />;
  if (!target) return <InlineMessage tone="warn">Open this test from its draft or source workspace.</InlineMessage>;
  return kind === "rehearsal" ? <RehearsalRun runId={runId} draftId={target} /> : <ProbeRun runId={runId} workspaceId={target} />;
}

function TestWorkspace({ title, kind, mode, status, fixture, steps, tabs, actions, panel, defaultNode }: {
  title: string; kind: string; mode: string; status: string; fixture: ReactNode;
  steps: Step[]; tabs: TestTab[]; actions?: ReactNode; defaultNode?: string | undefined;
  panel: (tab: TestTab, step: string | null) => ReactNode;
}) {
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const navigate = useNavigate();
  const current = steps.find(step => step.id === (search.node ?? defaultNode));
  const items = available(tabs);
  const selected = items.find(tab => tab.value === search.tab)?.value ?? "overview";
  const update = (patch: Record<string, unknown>) => void navigate({
    to: ".", replace: true, search: (prior: Record<string, unknown>) => ({ ...prior, ...patch }),
  });
  return <div className={styles.page}>
    <ConsoleHeader title={title} breadcrumb={[{ label: "Process Studio", href: "/studio" }, { label: "Sandbox Runs", href: STUDIO_SANDBOX }, { label: kind }]}
      meta={<span className={styles.row}><strong className={styles.sandboxBadge}>{kind}</strong><span>{mode}</span><span>{statusLabel(status)}</span></span>}
      actions={actions} />
    <section className={styles.panel} aria-label="Test provenance">{fixture}</section>
    <div className={styles.testWorkspace}>
      {steps.length ? <nav className={styles.panel} aria-label="Execution tree"><h2>Execution tree</h2>
        <button type="button" className={styles.step} aria-pressed={!current} onClick={() => update({ node: "" })}>View whole run</button>
        <ul className={styles.steps}>{steps.map(step => <li key={step.id}><button type="button" className={styles.step} aria-pressed={current?.id === step.id}
          onClick={() => update({ node: step.id })}><strong>{step.name}</strong><small>{statusLabel(step.status)}</small></button></li>)}</ul>
      </nav> : null}
      <section className={styles.panel} aria-label="Run inspector">
        <h2>{current?.name ?? "Run inspector"}</h2>
        <Tabs label="Sandbox inspector" items={items} value={selected} onChange={tab => update({ tab })} renderPanel={tab => panel(tab, current?.id ?? null)} />
      </section>
    </div>
  </div>;
}

function RehearsalRun({ runId, draftId }: { runId: string; draftId: string }) {
  const report = usePolled(api, "getAuthoringDraftsDraftIdTestRunsTestRunId", { path: { draftId, testRunId: runId } }, {
    pollWhile: run => !run || run.status === "running",
  });
  return <Region polled={report} label="draft rehearsal">{run => <RehearsalInspector run={run} />}</Region>;
}

const rehearsalMode = (run: Rehearsal) => run.mode === "recorded" ? "Recorded model responses and fixture tools" : "Live model inference and fixture tools";
const draftLink = (draftId: string) => `/studio/drafts/${encodeURIComponent(draftId)}`;
const compareRehearsal = (run: Rehearsal): CompareRun => ({
  label: `Revision ${run.revision} · ${run.mode}`, status: statusLabel(run.status), outcome: run.error,
  calls: run.calls.length, duration: duration(run.createdAt, run.finishedAt), cost: reportedCost(run.calls),
  steps: run.nodes.map(node => ({ id: node.nodeId, name: node.name, status: node.status, input: node.input, output: node.output })),
});

function RehearsalInspector({ run }: { run: Rehearsal }) {
  const steps = run.nodes.map(node => ({ id: node.nodeId, name: node.name, status: node.status }));
  const kind = run.fork?.scope === "step" ? "Capability or step probe" : run.fork ? "Fixture fork" : "Draft rehearsal";
  return <TestWorkspace title={kind} kind={kind} mode={rehearsalMode(run)} status={run.status} steps={steps}
    defaultNode={run.debug?.boundary?.nodeId}
    tabs={["overview", "context", "skills", "capabilities", "policy", "attempts", "compare"]}
    fixture={<><dl className={styles.facts}><dt>Revision</dt><dd>{run.revision}</dd><dt>Plan</dt><dd>{run.planDigest}</dd>
      <dt>Fixture digest</dt><dd>{run.fixtureDigest ?? "Not captured"}</dd><dt>Effects</dt><dd>Case writes suppressed</dd></dl><ForkOrigin run={run} /><FixtureDebugControls run={run} /></>}
    actions={<Link to={draftLink(run.draftId)} search={{ tab: "workflow" }}>Open draft</Link>}
    panel={(tab, id) => {
      const node = run.nodes.find(node => node.nodeId === id);
      if (tab === "compare") return <RehearsalComparison run={run} />;
      if (tab === "capabilities") return <FixtureCalls calls={run.calls.filter(call => !id || call.nodeId === id)} />;
      if (tab === "context") return node?.input != null ? <AdvancedData label="Recorded step input" data={node.input} /> : <p>No step input recorded.</p>;
      if (tab === "skills") return <div className={styles.inspectorStack}>
        {node?.error ? <InlineMessage tone="warn">{node.error}</InlineMessage> : null}
        {node?.input != null ? <AdvancedData label="Input" data={node.input} /> : null}
        {node?.output != null ? <AdvancedData label="Output" data={node.output} /> : <p>No output recorded for this step.</p>}
      </div>;
      if (tab === "attempts") return <RehearsalTrace nodes={run.nodes} />;
      if (tab === "policy") return <FixtureEffects run={run} nodeId={id} />;
      return <div className={styles.inspectorStack}>
        <p>{run.calls.length} capability calls · {run.nodes.filter(step => step.status === "completed").length} completed steps</p>
        {run.error ? <InlineMessage tone="warn">{run.error}</InlineMessage> : null}
        {run.warnings.map(warning => <p key={warning}>{warning}</p>)}
        {run.output != null ? <AdvancedData label="Workflow output" data={run.output} /> : null}
      </div>;
    }} />;
}

function FixtureEffects({ run, nodeId }: { run: Rehearsal; nodeId: string | null }) {
  const rows = run.effects?.filter(item => !nodeId || nodeId === item.nodeId).map((item, index) => ({ ...item, index })) ?? [];
  return rows.length ? <Table caption="Suppressed fixture effects" rows={rows} rowKey={item => String(item.index)} columns={[
    { key: "command", header: "Declared action", render: item => item.command },
    { key: "scope", header: "Scope", render: item => item.conditional ? "Conditional declaration" : "Step declaration" },
    { key: "result", header: "Result", render: () => "Suppressed" },
  ]} /> : <p>No suppressed case effects recorded for this selection. Policy gates require a released run.</p>;
}

function RehearsalTrace({ nodes }: { nodes: Rehearsal["nodes"] }) {
  const navigate = useNavigate();
  const events = nodes.flatMap(node => [
    ...(node.startedAt ? [{ id: `${node.nodeId}:started`, title: `${node.name} started`, at: node.startedAt, nodeId: node.nodeId }] : []),
    ...(node.finishedAt ? [{ id: `${node.nodeId}:finished`, title: `${node.name} · ${node.status}`, at: node.finishedAt, nodeId: node.nodeId }] : []),
  ] satisfies ReplayEvent[]).sort((a, b) => a.at.localeCompare(b.at));
  return <div className={styles.inspectorStack}>
    <TraceReplay events={events} select={event => void navigate({ to: ".", replace: true,
      search: (previous: Record<string, unknown>) => ({ ...previous, node: event.nodeId }) })} />
    <RecordedSteps nodes={nodes} />
  </div>;
}

function RecordedSteps({ nodes }: { nodes: Rehearsal["nodes"] }) {
  const rows = nodes.filter(node => node.startedAt || node.finishedAt);
  return rows.length ? <Table caption="Recorded steps" rows={rows} rowKey={node => node.nodeId} columns={[
    { key: "name", header: "Step", render: node => node.name },
    { key: "status", header: "Status", render: node => statusLabel(node.status) },
    { key: "duration", header: "Elapsed", render: node => { const value = duration(node.startedAt, node.finishedAt); return value === null ? "—" : `${value} ms`; } },
    { key: "error", header: "Reason", render: node => node.error ?? "—" },
  ]} /> : <p>No execution steps recorded.</p>;
}

function FixtureCalls({ calls }: { calls: Rehearsal["calls"] }) {
  const rows = calls.map((call, index) => ({ ...call, index }));
  return rows.length ? <Table caption="Capability calls" rows={rows} rowKey={call => String(call.index)} columns={[
    { key: "capability", header: "Capability", render: call => call.capabilityId },
    { key: "provider", header: "Provider", render: call => call.provider },
    { key: "latency", header: "Latency", render: call => call.latencyMs === undefined ? "—" : `${call.latencyMs} ms` },
    { key: "cost", header: "Cost", render: call => call.costUsd === null ? "—" : `$${call.costUsd.toFixed(4)}` },
  ]} /> : <p>No capability calls recorded for this step.</p>;
}

function RehearsalComparison({ run }: { run: Rehearsal }) {
  const history = usePolled(api, "getAuthoringDraftsDraftIdTestRuns", { path: { draftId: run.draftId } });
  const parent = usePolled(api, "getAuthoringDraftsDraftIdTestRunsTestRunId", {
    path: { draftId: run.draftId, testRunId: run.fork?.parentRunId ?? "" },
  }, { enabled: Boolean(run.fork), pollWhile: data => !data || data.status === "running" });
  const [baselineId, select] = useState("");
  const options = history.data?.items.filter(other => other.testRunId !== run.testRunId
    && other.fixtureDigest && other.fixtureDigest === run.fixtureDigest) ?? [];
  const baseline = options.find(other => other.testRunId === baselineId) ?? options[0];
  if (run.fork) return <Region polled={parent} label="baseline rehearsal">
    {prior => <RunComparison baseline={compareRehearsal(prior)} candidate={compareRehearsal(run)} />}
  </Region>;
  if (history.error) return <ApiErrorView error={history.error} />;
  if (!run.fixtureDigest) return <p>Fixture identity was not recorded for this rehearsal.</p>;
  if (!baseline) return <p>{history.data ? "Run this fixture again to compare results." : "Loading comparable rehearsals…"}</p>;
  return <div className={styles.inspectorStack}>
    <InspectorChoice label="Baseline rehearsal" value={baseline.testRunId} onChange={select}
      items={options.map(other => ({ value: other.testRunId, label: `Revision ${other.revision} · ${new Date(other.createdAt).toLocaleString()}` }))} />
    <RunComparison baseline={compareRehearsal(baseline)} candidate={compareRehearsal(run)} />
  </div>;
}

const documentStages = [
  ["classification", "Catalog classification"],
  ["extraction", "Contract field extraction"],
  ["validity", "Document validity assessment"],
] as const;

function DocumentRun({ runId }: { runId: string }) {
  const report = usePolled(api, "getDocumentStudioTestsTestId", { path: { testId: runId } }, { pollWhile: run => !run || run.status === "running" });
  return <Region polled={report} label="document test">{run => <TestWorkspace title={run.filename} kind="Document test" mode="Live extraction · isolated sample"
    status={run.status} steps={documentStages.map(([id, name]) => ({ id, name, status: run.skillOutputs[id] ? "recorded" : "not captured" }))}
    defaultNode={documentStages[0][0]}
    tabs={["overview", "documents", "skills", "capabilities", "compare"]}
    fixture={<dl className={styles.facts}><dt>Contract</dt><dd>{humanLabel(run.documentType)}</dd><dt>Document version</dt><dd>{run.documentVersion}</dd>
      <dt>Model profile</dt><dd>{run.model.profileId}</dd></dl>}
    panel={(tab, step) => {
      if (tab === "compare") return <DocumentComparison run={run} />;
      if (tab === "documents") return <DocumentCitations key={run.documentVersion} run={run} />;
      if (tab === "skills") return step && run.skillOutputs[step] != null ? <AdvancedData label="Recorded skill output" data={run.skillOutputs[step]} /> : <p>No output recorded for this stage.</p>;
      if (tab === "capabilities") return <dl className={styles.facts}><dt>Provider</dt><dd>{run.model.provider}</dd><dt>Model</dt><dd>{run.model.model}</dd><dt>Reported cost</dt><dd>{run.costUsd === null ? "Unavailable" : `$${run.costUsd.toFixed(4)}`}</dd></dl>;
      return <div className={styles.inspectorStack}>
        <p>{run.stage} · {run.detail?.assertions.length ?? 0} extracted fields</p>
        {run.error ? <InlineMessage tone="warn">{run.error}</InlineMessage> : null}
        {run.validation ? <AdvancedData label="Source validation" data={run.validation} /> : null}
      </div>;
    }} />}</Region>;
}

function compareDocument(run: DocumentTest): CompareRun {
  return {
    label: run.model.model, status: statusLabel(run.status), outcome: run.stage,
    calls: null, duration: duration(run.createdAt, run.finishedAt), cost: run.costUsd,
    steps: documentStages.map(([id, name]) => ({ id, name, status: run.skillOutputs[id] == null ? "Unavailable" : "Recorded", output: run.skillOutputs[id] })),
  };
}

function DocumentComparison({ run }: { run: DocumentTest }) {
  const history = usePolled(api, "getDocumentStudioTests");
  const [selection, select] = useState("");
  const peers = history.data?.items.filter(item => item.testId !== run.testId && item.documentVersion === run.documentVersion && item.documentType === run.documentType) ?? [];
  const baseline = peers.find(item => item.testId === selection) ?? peers[0];
  const detail = usePolled(api, "getDocumentStudioTestsTestId", { path: { testId: baseline?.testId ?? "" } }, {
    enabled: Boolean(baseline), pollWhile: result => !result || result.status === "running",
  });
  if (history.error) return <ApiErrorView error={history.error} />;
  if (!baseline) return <p>{history.data ? "Test this document version against the same contract again to compare." : "Loading comparable document tests…"}</p>;
  return <div className={styles.inspectorStack}>
    <InspectorChoice label="Baseline document test" value={baseline.testId} onChange={select}
      items={peers.map(item => ({ value: item.testId, label: `${item.model.model} · ${new Date(item.createdAt).toLocaleString()}` }))} />
    <Region polled={detail} label="baseline document test">{prior => <RunComparison baseline={compareDocument(prior)} candidate={compareDocument(run)} />}</Region>
  </div>;
}

function DocumentCitations({ run }: { run: DocumentTest }) {
  const [page, setPage] = useState(1);
  const [field, setField] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  if (!run.detail) return <p>No source pages are available for this test.</p>;
  const select = (ref: string | null) => {
    setField(ref);
    const first = run.detail?.assertions.find(assertion => assertion.objectId === ref)?.spans[0];
    if (first) setPage(first.page);
  };
  return <div className={styles.inspectorStack}>
    {run.detail.assertions.length ? <InspectorChoice label="Extracted field" value={field ?? ""} onChange={id => select(id || null)}
      items={[{ value: "", label: "Select a field" }, ...run.detail.assertions.map(item => ({ value: item.objectId, label: humanLabel(item.field) }))]} /> : null}
    <SourceViewer detail={run.detail} content={undefined} page={page} onPage={setPage} selected={field} hovered={hover} onSelect={select} onHover={setHover} />
  </div>;
}

function compareEvaluation(run: Evaluation): CompareRun {
  return {
    label: `Revision ${run.revision}`, status: statusLabel(run.status), outcome: run.error,
    calls: run.cases.reduce((sum, test) => sum + test.receipts.length, 0),
    duration: duration(run.createdAt, run.completedAt), cost: reportedCost(run.cases),
    steps: run.cases.map(test => ({ id: test.id, name: test.id, status: test.status, output: test.actual })),
  };
}

function ProbeRun({ runId, workspaceId }: { runId: string; workspaceId: string }) {
  const view = usePolled(api, "getWorkbenchWorkspace", { path: { workspaceId }, query: {} }, {
    pollWhile: data => !data || data.evaluations.some(run => run.evaluationId === runId && ["queued", "running"].includes(run.status)),
  });
  const [baselineId, select] = useState("");
  return <Region polled={view} label="skill or agent probe">{data => {
    const run = data.evaluations.find(item => item.evaluationId === runId);
    if (!run) return <InlineMessage tone="warn">This evaluation is outside the workspace’s recent history.</InlineMessage>;
    const peers = data.evaluations.filter(item => item.evaluationId !== runId && item.datasetDigest === run.datasetDigest);
    const baseline = peers.find(item => item.evaluationId === baselineId) ?? peers[0];
    return <TestWorkspace title={data.workspace.name} kind={data.workspace.kind === "skill" ? "Skill probe" : "Agent evaluation"}
      mode={run.modelProfileId ? `Model profile ${run.modelProfileId}` : "Isolated code evaluation"} status={run.status}
      steps={run.cases.map(test => ({ id: test.id, name: test.id, status: test.status }))}
      defaultNode={run.cases[0]?.id}
      tabs={["overview", "skills", "capabilities", "compare"]}
      fixture={<dl className={styles.facts}><dt>Dataset</dt><dd>{run.dataset.name} · {run.dataset.version}</dd><dt>Dataset digest</dt><dd>{run.datasetDigest}</dd><dt>Source revision</dt><dd>{run.revision}</dd></dl>}
      panel={(tab, step) => {
        const test = run.cases.find(item => item.id === step);
        if (tab === "compare") return baseline ? <div className={styles.inspectorStack}>
          <InspectorChoice label="Baseline evaluation" value={baseline.evaluationId} onChange={select}
            items={peers.map(item => ({ value: item.evaluationId, label: `Revision ${item.revision} · ${new Date(item.createdAt).toLocaleString()}` }))} />
          <RunComparison baseline={compareEvaluation(baseline)} candidate={compareEvaluation(run)} />
        </div> : <p>Evaluate this dataset again to compare results.</p>;
        if (tab === "skills") return <div className={styles.inspectorStack}>
          {test?.failures.map((failure, index) => <InlineMessage key={index} tone="warn">{failure}</InlineMessage>)}
          {test ? <AdvancedData label="Expected and actual" data={{ expected: test.expected, actual: test.actual }} /> : <p>No test case recorded yet.</p>}
        </div>;
        if (tab === "capabilities") return test?.receipts.length ? <div className={styles.inspectorStack}>
          {test.receipts.map((receipt, index) => <section key={index} className={styles.detailCard}>
            <strong>{receipt.skillId}</strong><span>{receipt.durationMs} ms</span>
            <AdvancedData label="Skill receipt" data={{ input: receipt.input, output: receipt.output }} />
          </section>)}
        </div> : <p>No dependency receipts recorded for this case.</p>;
        return <p>{run.error ?? `${run.cases.filter(item => item.status === "passed").length} of ${run.dataset.cases.length} cases passed`}</p>;
      }} />;
  }}</Region>;
}
