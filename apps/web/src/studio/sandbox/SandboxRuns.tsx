import { usePolled } from "@ehf/ui-client/react";
import { Button, EmptyState, Field, InlineMessage, LocalTimestamp, Select, Table, Tabs } from "@ehf/ui-kit";
import { ConsoleHeader } from "@ehf/ui-shell";
import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { lazy, Suspense, useRef, useState } from "react";
import { api } from "../../app/api";
import { useSession } from "../../app/session";
import { ApiErrorView, Region, useCommand, useSearchParam } from "../../platform/common";
import { draftTitle } from "../../platform/surfaces/authoring/model";
import { STUDIO_SANDBOX } from "../navigation";
import { humanLabel } from "./inspection-model";
import { SandboxHistoryFilters } from "./SandboxHistoryFilters";
import SandboxTestHistory from "./SandboxTestHistory";
import { sandboxPath } from "./test-run-path";
import styles from "./sandbox.module.css";

const Run = lazy(() => import("./SandboxExecution"));
const Test = lazy(() => import("./SandboxTestExecution"));
const SCOPED_SAMPLES = [
  { party: "H03", customerType: "individual", jurisdiction: "US", products: ["custody", "private_banking"] },
  { party: "H05", customerType: "corporate", jurisdiction: "US", products: ["payments", "trade_finance"] },
  { party: "H06", customerType: "corporate", jurisdiction: "US", products: ["correspondent", "custody", "payments"] },
  { party: "H12", customerType: "trust", jurisdiction: "US", products: ["custody", "private_banking"] },
] as const;
const SANDBOX_READS = [["getAuthoringSandboxRuns"], ["getRuns"], ["getAuthoringDraftsDraftIdSandbox"]] as const;

export default function SandboxRuns() {
  const { runId } = useParams({ strict: false }) as { runId?: string };
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const { kind, target } = search;
  return runId
    ? <Suspense fallback={<p>Loading sandbox run…</p>}>{kind === "rehearsal" || kind === "probe" || kind === "document"
      ? <Test key={`${kind}:${runId}`} kind={kind} runId={runId} target={typeof target === "string" ? target : undefined} />
      : <Run key={runId} runId={runId} />}</Suspense>
    : <SandboxHome />;
}

function SandboxHome() {
  const session = useSession();
  const navigate = useNavigate();
  const history = usePolled(api, "getAuthoringSandboxRuns");
  const canLaunch = ["draft.read", "draft.evaluate", "draft.compile"].every(action => session.actions.includes(action));
  const [draftId, setDraftId] = useSearchParam("draft");
  const [party] = useSearchParam("party");
  const [mode, setMode] = useSearchParam("kind");
  const modes = [{ value: "live", label: "Live process runs" }, ...(session.actions.includes("draft.read") ? [
    { value: "rehearsal", label: "Draft rehearsals" }, { value: "probe", label: "Skill and agent probes" },
    ...(session.actions.includes("evidence.read") ? [{ value: "document", label: "Document tests" }] : []),
  ] : [])];
  const activeMode = modes.some(item => item.value === mode) ? mode! : "live";
  const choose = (id: string | undefined, sampleParty?: string) => {
    if (!party && !sampleParty) return setDraftId(id);
    void navigate({ to: STUDIO_SANDBOX as string, replace: true, search: { draft: id, party: sampleParty } });
  };
  return (
    <div className={styles.page}>
      <ConsoleHeader breadcrumb={[{ label: "Process Studio", href: "/studio" }, { label: "Sandbox Runs" }]} title="Sandbox Runs" />
      <Tabs label="Run type" items={modes} value={activeMode} onChange={setMode} renderPanel={kind => kind === "rehearsal" || kind === "probe" || kind === "document"
        ? <SandboxTestHistory key={kind} kind={kind} draftId={draftId} /> : <>
      {canLaunch && history.error?.reason !== "sandbox.not_available" ? (
        <LaunchSetup draftId={draftId ?? ""} initialParty={party} chooseDraft={choose} onStarted={runId => void navigate({ to: sandboxPath(runId) })} />
      ) : null}
      {history.error?.reason === "sandbox.not_available" ? <InlineMessage tone="warn">Sandbox runs are unavailable in this environment.</InlineMessage> : (
        <Region polled={history} label="sandbox run history">
          {page => page.items.length ? <SandboxHistoryFilters rows={page.items} filters={[
            { key: "process", label: "Process", value: run => run.processName },
            { key: "revision", label: "Revision", value: run => String(run.revision) },
            { key: "party", label: "Test party", value: run => run.party },
            { key: "status", label: "Status", value: run => run.status, format: humanLabel },
            { key: "outcome", label: "Runtime outcome", value: run => run.outcome ?? "", format: humanLabel },
          ]}>{rows => <Table caption="Recent sandbox runs" rows={rows} rowKey={run => run.runId} columns={[
            { key: "process", header: "Process", render: run => <Link to={sandboxPath(run.runId)}>{run.processName}</Link> },
            { key: "revision", header: "Revision", render: run => run.revision },
            { key: "party", header: "Test party", render: run => run.party },
            { key: "status", header: "Status", render: run => humanLabel(run.status) },
            { key: "outcome", header: "Runtime outcome", render: run => run.outcome ? humanLabel(run.outcome) : "—" },
            { key: "started", header: "Started", render: run => <LocalTimestamp iso={run.createdAt} /> },
          ]} />}</SandboxHistoryFilters> : <EmptyState icon="workflow" title="No sandbox runs yet" headingLevel={2}>Choose a process and a synthetic test party to start a rehearsal.</EmptyState>}
        </Region>
      )}
      </>} />
    </div>
  );
}

function LaunchSetup({ draftId, initialParty, chooseDraft, onStarted }: {
  draftId: string;
  initialParty: string | undefined;
  chooseDraft: (id: string | undefined, party?: string) => void;
  onStarted: (id: string) => void;
}) {
  const session = useSession();
  const drafts = usePolled(api, "getAuthoringDrafts");
  const templates = usePolled(api, "getAuthoringTemplates", undefined, { enabled: session.actions.includes("draft.write") });
  const create = useCommand("postAuthoringDrafts", { invalidate: [["getAuthoringDrafts"]] });
  const applyScope = useCommand("postAuthoringDraftsDraftIdScopeApply", { invalidate: [["getAuthoringDrafts"]] });
  const [preset, setPreset] = useState("");
  const sample = SCOPED_SAMPLES.find(item => item.party === preset);
  const preparing = create.busy || applyScope.busy;
  const sampleTemplates = templates.data?.items.filter(template => ["kyc-agentic", "kyb-agentic"].includes(template.id)) ?? [];
  return (
    <section className={styles.panel} aria-labelledby="launch-title">
      <h2 id="launch-title">New sandbox run</h2>
      <Region polled={drafts} label="process drafts">
        {page => <Field label="Process draft">
          <Select value={draftId} onChange={event => chooseDraft(event.target.value || undefined)}>
            <option value="">Select a saved draft</option>
            {page.items.map(draft => <option key={draft.draftId} value={draft.draftId}>{draftTitle(draft)} · revision {draft.revision}</option>)}
            {draftId && !page.items.some(draft => draft.draftId === draftId) ? <option value={draftId}>{draftId}</option> : null}
          </Select>
        </Field>}
      </Region>
      {sampleTemplates.length ? <div className={styles.row}>
        {sampleTemplates.map(template => <Button key={template.id} icon="plus" busy={create.busy} disabled={preparing} onClick={async () => {
          const draft = await create.run({ body: { packageSource: template.packageSource, workflowSource: template.workflowSource, sourceFiles: template.sourceFiles } });
          if (draft) chooseDraft(draft.draftId);
        }}>Create {template.id === "kyc-agentic" ? "KYC" : "KYB"} sample draft</Button>)}
      </div> : null}
      {sampleTemplates.length === 2 ? <div className={styles.row}>
        <Field label="Create a draft for a specific corpus party">
          <Select value={preset} disabled={preparing} onChange={event => setPreset(event.target.value)}>
            <option value="">Select a scoped sample</option>
            {SCOPED_SAMPLES.map(item => <option key={item.party} value={item.party}>
              {item.party} · {item.jurisdiction} · {item.products.map(product => product.replaceAll("_", " ")).join(", ")}
            </option>)}
          </Select>
        </Field>
        <Button icon="plus" disabled={!sample || preparing} busy={preparing} onClick={async () => {
          if (!sample) return;
          const template = sampleTemplates.find(item => item.id === (sample.customerType === "individual" ? "kyc-agentic" : "kyb-agentic"));
          if (!template) return;
          const draft = await create.run({ body: { packageSource: template.packageSource, workflowSource: template.workflowSource, sourceFiles: template.sourceFiles } });
          if (!draft) return;
          const scoped = await applyScope.run({ path: { draftId: draft.draftId }, body: {
            expectedRevision: draft.revision,
            scope: { customerType: sample.customerType, trigger: "onboarding", jurisdictions: [sample.jurisdiction],
              institution: "bank.synthetic", products: [...sample.products] },
          } });
          chooseDraft(draft.draftId, scoped ? sample.party : undefined);
        }}>Create scoped sample draft</Button>
      </div> : null}
      {applyScope.error ? <ApiErrorView error={applyScope.error} title="Could not apply the sample policy scope" /> : null}
      {create.error ? <ApiErrorView error={create.error} /> : null}
      {draftId ? <LaunchForm key={draftId} draftId={draftId} initialParty={initialParty} onStarted={onStarted} /> : null}
    </section>
  );
}

function LaunchForm({ draftId, initialParty, onStarted }: { draftId: string; initialParty: string | undefined; onStarted: (id: string) => void }) {
  const options = usePolled(api, "getAuthoringDraftsDraftIdSandbox", { path: { draftId } });
  const draft = usePolled(api, "getAuthoringDraftsDraftId", { path: { draftId } });
  const start = useCommand("postAuthoringDraftsDraftIdSandboxRuns", { invalidate: SANDBOX_READS });
  const [chosenParty, setParty] = useState(initialParty ?? "");
  const request = useRef<{ revision: number; party: string; key: string } | null>(null);
  return <Region polled={options} label="sandbox options">{data => {
    if (!data.available) return <InlineMessage tone="warn">{data.reason ?? "Sandbox runs are unavailable."}</InlineMessage>;
    const domain = draft.data?.domain;
    const kind = domain === "kyc" ? "individual" : domain === "kyb" ? "business" : null;
    const parties = data.parties.filter(party => !kind || party.customerType === kind);
    const party = parties.some(item => item.id === chosenParty) ? chosenParty : "";
    return <form className={styles.stack} aria-label="Run in sandbox" onSubmit={async event => {
      event.preventDefault();
      if (!party || start.busy) return;
      if (request.current?.revision !== data.revision || request.current.party !== party) {
        request.current = { revision: data.revision, party, key: crypto.randomUUID() };
      }
      const result = await start.run({
        path: { draftId }, body: { expectedRevision: data.revision, party }, idempotencyKey: request.current.key,
      });
      if (result) onStarted(result.runId);
    }}>
      <Field label="Synthetic test party" hint={`The run will use saved revision ${data.revision} and create a fresh case.`}>
        <Select value={party} disabled={start.busy} required onChange={event => setParty(event.target.value)}>
          <option value="">Select a test party</option>
          {parties.map(item => <option key={item.id} value={item.id}>{item.id} · {item.name} · {item.customerType}</option>)}
        </Select>
      </Field>
      <p>Skills, policy checkpoints, and configured models execute on the real runtime. Model calls may incur charges.</p>
      <div><Button type="submit" variant="primary" icon="play" busy={start.busy} disabled={!party || start.busy}>Run in sandbox</Button></div>
      {start.busy ? <p role="status">Compiling the saved revision and preparing the synthetic case…</p> : null}
      {start.error ? <ApiErrorView error={start.error} /> : null}
    </form>;
  }}</Region>;
}
