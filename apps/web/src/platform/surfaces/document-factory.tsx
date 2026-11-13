import type { Schemas } from "@ehf/ui-contracts";
import { usePolled } from "@ehf/ui-client/react";
import { Button, DigestValue, EmptyState, Field, InlineMessage, LocalTimestamp, Select, Sheet, Table, Tabs, TextArea, TextInput, ToneBadge, type IconName } from "@ehf/ui-kit";
import { ConsoleHeader } from "@ehf/ui-shell";
import { useState } from "react";
import { api } from "../../app/api";
import { useSession } from "../../app/session";
import { Freshness, Region, useCommand } from "../common";
import { useSearchParam } from "../common/search-params";
import { CommandFeedback, GatedButton } from "./admin/shared";
import styles from "./operations/operations.module.css";

type Overview = Schemas["FactoryOverview"];
type Job = Schemas["FactoryReleaseJob"];
type Release = Schemas["FactoryRelease"];
type Plan = Schemas["FactoryReleasePlan"];
type Tone = "positive" | "attention" | "blocking" | "info" | "neutral" | "running";
const TABS = [{ value: "releases" as const, label: "Releases" }, { value: "jobs" as const, label: "Jobs" }, { value: "datasets" as const, label: "Datasets" }];
const INVALIDATE = [["getDocumentFactory"], ["getDocumentFactoryReleases"]] as const;
const label = (type: string) => type.replaceAll("_", " ");
const usd = (value: number) => `$${value.toFixed(2)}`;

const JOB_TONE: Record<Job["status"], [Tone, IconName]> = {
  planned: ["neutral", "clock"], awaiting_approval: ["attention", "clock"], queued: ["info", "clock"], running: ["running", "activity"],
  cancelling: ["attention", "x"], cancelled: ["neutral", "x"], failed: ["blocking", "alert"], completed: ["positive", "check"],
};
const ACTION_TONE: Record<Schemas["FactoryPlanType"]["action"], [Tone, string]> = {
  train: ["info", "Train"], reuse: ["neutral", "Reuse model"], prebuilt: ["neutral", "Prebuilt model"], llm_only: ["neutral", "LLM only"], blocked: ["blocking", "Blocked"],
};
const RELEASE_TONE: Record<Release["status"], [Tone, IconName]> = { registered: ["attention", "clock"], approved: ["positive", "check"], revoked: ["blocking", "block"] };

/** PLT-23 · Document Factory: train, evaluate and release document models per catalog type (document factory plan §7.4). */
export default function DocumentFactory() {
  const overview = usePolled(api, "getDocumentFactory");
  const [tabParam, setTab] = useSearchParam("tab");
  const tab = TABS.some(t => t.value === tabParam) ? tabParam as (typeof TABS)[number]["value"] : "releases";
  const [jobId, setJobId] = useSearchParam("job");
  return <>
    <ConsoleHeader breadcrumb={[{ label: "Platform", href: "/platform" }, { label: "Document Factory" }]} title="Document Factory" meta={<Freshness polled={overview} />} />
    <p className={styles.muted}>Train, evaluate and release document extraction models per catalog type. A release is planned by one person, its spend approved by another, approved by a third, and activated per environment; the LLM route keeps running for every type.</p>
    <Region polled={overview} label="Document Factory">
      {data => <Tabs label="Document Factory" items={TABS} value={tab} onChange={value => setTab(value === "releases" ? undefined : value)} renderPanel={value =>
        value === "jobs" ? <Jobs data={data} selected={jobId} onSelect={setJobId} />
          : value === "datasets" ? <Datasets data={data} />
            : <Releases data={data} onPlanned={id => { setJobId(id); setTab("jobs"); }} />} />}
    </Region>
  </>;
}

// ------------------------------------------------------------------ releases

function Releases({ data, onPlanned }: { data: Overview; onPlanned: (jobId: string) => void }) {
  const session = useSession();
  const [planning, setPlanning] = useState(false);
  const [activating, setActivating] = useState<Release | null>(null);
  const [rollingBack, setRollingBack] = useState<string | null>(null);
  const approve = useCommand("postDocumentFactoryReleasesDigestApprove", { invalidate: INVALIDATE });
  const inEffect = new Map(data.environments.map(env => [env.inEffect, env.environment]));
  return <div className={styles.stack}>
    <section className={styles.section} aria-labelledby="factory-environments">
      <div className={styles.sectionHead}>
        <h2 id="factory-environments" className={styles.sectionTitle}>In effect</h2>
        <GatedButton allowed={session.actions.includes("release.create")} hint="Requires release.create" icon="plus" variant="primary" onClick={() => setPlanning(true)}>New release</GatedButton>
      </div>
      <Table caption="Release in effect per environment" captionHidden rows={data.environments} rowKey={env => env.environment}
        empty={<EmptyState icon="send" title="No release is active" headingLevel={3}>Every type extracts with the LLM route, plus prebuilt models where they apply, until a release is activated.</EmptyState>}
        columns={[
          { key: "environment", header: "Environment", render: env => <strong>{env.environment}</strong> },
          { key: "release", header: "Release in effect", render: env => env.inEffect ? <>{data.releases.find(r => r.digest === env.inEffect)?.releaseId ?? "—"} <DigestValue value={env.inEffect} label="release digest" /></> : <span className={styles.muted}>None</span> },
          { key: "scheduled", header: "Scheduled", render: env => env.scheduled.length ? env.scheduled.map(s => <span key={s.activationId}><LocalTimestamp iso={s.effectiveFrom} compact /> </span>) : <span className={styles.muted}>—</span> },
          { key: "rollback", header: "Rollback", render: env => <GatedButton allowed={session.actions.includes("release.activate")} hint="Requires release.activate" size="sm" disabled={!env.inEffect} onClick={() => setRollingBack(env.environment)} aria-label={`Roll back ${env.environment}`}>Roll back</GatedButton> },
        ]} />
    </section>
    <section className={styles.section} aria-labelledby="factory-releases">
      <h2 id="factory-releases" className={styles.sectionTitle}>Releases</h2>
      <CommandFeedback state={approve.state} error={approve.error} okText="Release approved." />
      <Table caption="Document model releases" captionHidden rows={data.releases} rowKey={r => r.digest} stickyFirstColumn
        empty={<EmptyState icon="package" title="No releases yet" headingLevel={3}>Plan a release to train and evaluate models for the types with data.</EmptyState>}
        columns={[
          { key: "release", header: "Release", render: r => <div className={styles.section}><strong>{r.releaseId}</strong><DigestValue value={r.digest} label="release digest" /></div> },
          { key: "status", header: "Approval", render: r => { const [tone, icon] = RELEASE_TONE[r.status]; return <ToneBadge tone={tone} icon={icon}>{r.status === "registered" ? "Awaiting approval" : r.status}</ToneBadge>; } },
          { key: "types", header: "Types", render: r => <span>{r.manifest.types.map(t => `${label(t.documentType)} (${t.route}, ${t.mode})`).join(" · ")}</span> },
          { key: "who", header: "Planned by / approved by", render: r => <span>{r.registeredBy} / {r.approvedBy ?? "—"}</span> },
          { key: "effect", header: "In effect", render: r => inEffect.get(r.digest) ? <ToneBadge tone="positive" icon="check">{inEffect.get(r.digest)!}</ToneBadge> : <span className={styles.muted}>—</span> },
          { key: "actions", header: "Actions", render: r => <span className={styles.actions}>
            {r.status === "registered" ? <GatedButton allowed={session.actions.includes("release.approve")} hint="Requires release.approve" size="sm" busy={approve.busy} onClick={() => void approve.run({ path: { digest: r.digest } })} aria-label={`Approve ${r.releaseId}`}>Approve</GatedButton> : null}
            {r.status === "approved" ? <GatedButton allowed={session.actions.includes("release.activate")} hint="Requires release.activate" size="sm" onClick={() => setActivating(r)} aria-label={`Activate ${r.releaseId}`}>Activate</GatedButton> : null}
          </span> },
        ]} />
    </section>
    <NewRelease open={planning} data={data} onClose={() => setPlanning(false)} onPlanned={id => { setPlanning(false); onPlanned(id); }} />
    {activating ? <Activate release={activating} onClose={() => setActivating(null)} /> : null}
    {rollingBack ? <Rollback environment={rollingBack} onClose={() => setRollingBack(null)} /> : null}
  </div>;
}

/** New release, steps 1–3: select, readiness and plan; recording the job hands it to spend approval. */
function NewRelease({ open, data, onClose, onPlanned }: { open: boolean; data: Overview; onClose: () => void; onPlanned: (jobId: string) => void }) {
  const [changed, setChanged] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [key] = useState(() => crypto.randomUUID());
  const preview = useCommand("postDocumentFactoryReleasePlan");
  const create = useCommand("postDocumentFactoryReleaseJobs", { invalidate: INVALIDATE });
  const selection = changed ? "changed_since_active" as const : selected;
  const toggle = (type: string) => { setPlan(null); setSelected(current => current.includes(type) ? current.filter(t => t !== type) : [...current, type]); };
  const check = async () => setPlan(await preview.run({ body: { selection } }));
  const submit = async () => { const job = await create.run({ body: { selection }, idempotencyKey: key }); if (job) onPlanned(job.jobId); };
  return <Sheet open={open} onClose={onClose} title="New release" description="Choose types, check readiness and the estimate, then plan the job. Training starts only after someone else approves the spend."
    footer={<div className={styles.actions}>
      <Button variant="quiet" onClick={onClose}>Cancel</Button>
      <Button onClick={() => void check()} busy={preview.busy} disabled={!changed && !selected.length}>Check readiness</Button>
      <Button variant="primary" icon="play" busy={create.busy} disabled={!plan || !plan.plan.some(p => p.action !== "blocked")} onClick={() => void submit()}>Plan release job</Button>
    </div>}>
    <div className={styles.form}>
      <fieldset className={styles.section}>
        <legend className={styles.eyebrow}>1 · Types</legend>
        <label><input type="checkbox" checked={changed} onChange={event => { setPlan(null); setChanged(event.target.checked); }} /> Everything with new data since the active release</label>
        {!changed ? data.datasets.map(d => <label key={d.documentType}><input type="checkbox" checked={selected.includes(d.documentType)} onChange={() => toggle(d.documentType)} /> {label(d.documentType)} <span className={styles.muted}>({d.counts.train} train · {d.counts.validation} validation · {d.counts.test} sealed test)</span></label>) : null}
      </fieldset>
      <CommandFeedback state={preview.state === "confirmed" ? "idle" : preview.state} error={preview.error} okText="" />
      {plan ? <>
        <section className={styles.section} aria-label="Readiness and plan">
          <span className={styles.eyebrow}>2 · Readiness and plan</span>
          <ul className={styles.plainList}>
            {plan.plan.map(item => { const [tone, text] = ACTION_TONE[item.action]; return <li key={item.documentType}>
              <ToneBadge tone={tone} icon={item.action === "blocked" ? "alert" : "check"}>{text}</ToneBadge> <strong>{label(item.documentType)}</strong> <span className={styles.muted}>{item.strategy.replaceAll("_", " ")}</span>
              {item.blockers.length ? <div className={styles.muted}>{item.blockers.join(" ")}</div> : null}
            </li>; })}
          </ul>
        </section>
        <section className={styles.section} aria-label="Estimate">
          <span className={styles.eyebrow}>3 · Estimate</span>
          <dl className={styles.kv}>
            <dt>Neural training</dt><dd>{plan.estimate.neuralTrainingHours} h · {usd(plan.estimate.trainingCostUsd)}</dd>
            <dt>Layout and evaluation</dt><dd>{plan.estimate.layoutPages} pages · {usd(plan.estimate.evaluationCostUsd)}</dd>
            <dt>Duration</dt><dd>about {Math.round(plan.estimate.durationMinutes)} minutes</dd>
          </dl>
          <p className={styles.muted}>{plan.estimate.basis}</p>
          {plan.overBudget ? <InlineMessage tone="warn">Over the {usd(plan.budgetLimitUsd)} budget limit: a budget owner must approve the spend as well.</InlineMessage> : null}
        </section>
      </> : null}
      <CommandFeedback state={create.state === "confirmed" ? "idle" : create.state} error={create.error} okText="" />
    </div>
  </Sheet>;
}

function Activate({ release, onClose }: { release: Release; onClose: () => void }) {
  const [environment, setEnvironment] = useState("test");
  const [when, setWhen] = useState("");
  const [reason, setReason] = useState("");
  const activate = useCommand("postDocumentFactoryReleasesDigestActivate", { invalidate: INVALIDATE });
  const run = async () => {
    const body = { environment, reason, ...(when ? { effectiveFrom: new Date(when).toISOString() } : {}) };
    if (await activate.run({ path: { digest: release.digest }, body })) onClose();
  };
  return <Sheet open onClose={onClose} title={`Activate ${release.releaseId}`} description="Activation points the environment's document model route at this release. Changed types start in shadow."
    footer={<div className={styles.actions}><Button variant="quiet" onClick={onClose}>Cancel</Button><Button variant="primary" busy={activate.busy} disabled={reason.trim().length < 3 || !environment} onClick={() => void run()}>Activate</Button></div>}>
    <div className={styles.form}>
      <Field label="Environment"><TextInput value={environment} onChange={event => setEnvironment(event.target.value)} /></Field>
      <Field label="Takes effect" hint="Leave empty for now, or choose a future date and time."><TextInput type="datetime-local" value={when} onChange={event => setWhen(event.target.value)} /></Field>
      <Field label="Reason (required)"><TextArea rows={3} value={reason} maxLength={500} onChange={event => setReason(event.target.value)} /></Field>
      <CommandFeedback state={activate.state} error={activate.error} okText="Activated." />
    </div>
  </Sheet>;
}

function Rollback({ environment, onClose }: { environment: string; onClose: () => void }) {
  const [reason, setReason] = useState("");
  const rollback = useCommand("postDocumentFactoryEnvironmentsEnvironmentRollback", { invalidate: INVALIDATE });
  return <Sheet open onClose={onClose} title={`Roll back ${environment}`} description="The release in effect before the current one takes effect again, now."
    footer={<div className={styles.actions}><Button variant="quiet" onClick={onClose}>Cancel</Button><Button variant="primary" icon="history" busy={rollback.busy} disabled={reason.trim().length < 3}
      onClick={() => void rollback.run({ path: { environment }, body: { reason } }).then(done => { if (done) onClose(); })}>Roll back</Button></div>}>
    <div className={styles.form}>
      <Field label="Reason (required)"><TextArea rows={3} value={reason} maxLength={500} onChange={event => setReason(event.target.value)} /></Field>
      <CommandFeedback state={rollback.state} error={rollback.error} okText="Rolled back." />
    </div>
  </Sheet>;
}

// ------------------------------------------------------------------ jobs

function Jobs({ data, selected, onSelect }: { data: Overview; selected: string | undefined; onSelect: (jobId: string | undefined) => void }) {
  const session = useSession();
  const approve = useCommand("postDocumentFactoryReleaseJobsJobIdApproveSpend", { invalidate: INVALIDATE });
  const cancel = useCommand("postDocumentFactoryReleaseJobsJobIdCancel", { invalidate: INVALIDATE });
  return <div className={styles.split}>
    <section className={styles.section} aria-label="Release jobs">
      <CommandFeedback state={approve.state} error={approve.error} okText="Spend approved." />
      <CommandFeedback state={cancel.state} error={cancel.error} okText="Cancellation requested." />
      <Table caption="Release jobs" captionHidden rows={data.jobs} rowKey={job => job.jobId} stickyFirstColumn
        empty={<EmptyState icon="workflow" title="No release jobs" headingLevel={3}>Plan a release from the Releases tab.</EmptyState>}
        columns={[
          { key: "job", header: "Job", render: job => <button type="button" className={styles.rowButton} aria-current={selected === job.jobId} onClick={() => onSelect(job.jobId)}>{job.jobId}</button> },
          { key: "status", header: "Status", render: job => { const [tone, icon] = JOB_TONE[job.status]; return <ToneBadge tone={tone} icon={icon}>{job.status.replaceAll("_", " ")} · {job.stage}</ToneBadge>; } },
          { key: "types", header: "Types", render: job => <span>{job.plan.filter(p => p.action !== "blocked").length} of {job.selection.length}</span> },
          { key: "estimate", header: "Estimate", render: job => <span className="num">{usd(job.estimate.trainingCostUsd + job.estimate.evaluationCostUsd)}</span> },
          { key: "who", header: "Planned by / spend approved by", render: job => <span>{job.createdBy} / {job.spendApprovedBy ?? "—"}{job.budgetOwnerApprovedBy ? ` + ${job.budgetOwnerApprovedBy}` : ""}</span> },
          { key: "actions", header: "Actions", render: job => <span className={styles.actions}>
            {job.status === "awaiting_approval" ? <GatedButton allowed={session.actions.includes("factory.train")} hint="Requires factory.train" size="sm" busy={approve.busy}
              onClick={() => void approve.run({ path: { jobId: job.jobId } })} aria-label={`Approve spend for ${job.jobId}`}>Approve spend</GatedButton> : null}
            {["awaiting_approval", "queued", "running"].includes(job.status) ? <Button size="sm" variant="quiet" busy={cancel.busy} onClick={() => void cancel.run({ path: { jobId: job.jobId } })} aria-label={`Cancel ${job.jobId}`}>Cancel</Button> : null}
          </span> },
        ]} />
    </section>
    {selected ? <JobInspector jobId={selected} /> : <aside className={styles.inspector}><p className={styles.muted}>Select a job to see its progress, report and gates.</p></aside>}
  </div>;
}

function JobInspector({ jobId }: { jobId: string }) {
  const job = usePolled(api, "getDocumentFactoryReleaseJobsJobId", { path: { jobId } });
  const digest = job.data?.reportDigest ?? null;
  const report = usePolled(api, "getDocumentFactoryReportsDigest", { path: { digest: digest ?? "0".repeat(64) } }, { enabled: Boolean(digest) });
  return <aside className={styles.inspector} aria-label={`Job ${jobId}`}>
    <Region polled={job} label="release job">{data => <>
      <h2 className={styles.inspectorTitle}>{data.jobId}</h2>
      {data.error ? <InlineMessage tone="warn">{data.error}</InlineMessage> : null}
      <ul className={styles.plainList} aria-label="Progress per type">
        {Object.entries(data.progress).map(([type, progress]) => <li key={type}><strong>{label(type)}</strong> · {progress.status}{progress.detail ? <div className={styles.muted}>{progress.detail}</div> : null}</li>)}
      </ul>
      {digest && report.data ? <section className={styles.section} aria-label="Evaluation report">
        <span className={styles.eyebrow}>Evaluation on sealed test documents</span>
        {report.data.types.map(t => <div key={t.documentType} className={styles.card}>
          <strong>{label(t.documentType)} · {t.route}</strong>
          <ToneBadge tone={t.gatesMet ? "positive" : "blocking"} icon={t.gatesMet ? "check" : "alert"}>{t.gatesMet ? "Gates met" : "Gates not met"}</ToneBadge>
          <dl className={styles.kv}>
            <dt>Documents</dt><dd>{t.release.documents} ({t.release.allKeyFieldsCorrect} with every key field correct)</dd>
            <dt>Key precision / recall</dt><dd>{t.release.keyPrecision ?? "—"} / {t.release.keyRecall ?? "—"}</dd>
            <dt>Wrong key values</dt><dd>{t.release.wrongKeyValues}</dd>
          </dl>
          <ul className={styles.plainList}>{t.gates.filter(g => !g.met).map(g => <li key={g.gate}>{g.gate.replaceAll("_", " ")}: {g.value ?? "—"} (threshold {g.threshold})</li>)}</ul>
        </div>)}
        <DigestValue value={digest} label="report digest" />
      </section> : null}
      <details><summary>History</summary><ul className={styles.plainList}>{data.events.map(e => <li key={e.eventId}><LocalTimestamp iso={e.createdAt} compact /> {e.kind} · {e.actor}</li>)}</ul></details>
    </>}</Region>
  </aside>;
}

// ------------------------------------------------------------------ datasets

function Datasets({ data }: { data: Overview }) {
  const strategy = new Map(data.strategies.map(s => [s.documentType, s]));
  const [type, setType] = useState("");
  const rows = data.datasets.filter(d => !type || d.documentType === type);
  return <section className={styles.section} aria-label="Datasets">
    <div className={styles.toolbar}>
      <Field label="Type"><Select value={type} onChange={event => setType(event.target.value)}><option value="">All types</option>{data.datasets.map(d => <option key={d.documentType} value={d.documentType}>{label(d.documentType)}</option>)}</Select></Field>
    </div>
    <Table caption="Current dataset version per type" captionHidden rows={rows} rowKey={d => d.datasetDigest} stickyFirstColumn
      empty={<EmptyState icon="database" title="No datasets registered" headingLevel={3}>The Factory worker registers each type's dataset version from the dataset store.</EmptyState>}
      columns={[
        { key: "type", header: "Type", render: d => <strong>{label(d.documentType)}</strong> },
        { key: "strategy", header: "Strategy", render: d => <span>{strategy.get(d.documentType)?.strategy.replaceAll("_", " ") ?? "None registered"}</span> },
        { key: "counts", header: "Train · validation · sealed test", render: d => <span className="num">{d.counts.train} · {d.counts.validation} · {d.counts.test}</span> },
        { key: "readiness", header: "Readiness", render: d => <span className={styles.flags}>
          {(["train", "validation", "test_pipeline_proof", "test_qualification"] as const).map(key => <ToneBadge key={key} tone={d.readiness[key] ? "positive" : "attention"} icon={d.readiness[key] ? "check" : "alert"}>{key.replaceAll("_", " ")}</ToneBadge>)}
        </span> },
        { key: "digest", header: "Dataset", render: d => <DigestValue value={d.datasetDigest} label="dataset digest" /> },
        { key: "registered", header: "Registered", render: d => <LocalTimestamp iso={d.registeredAt} compact /> },
      ]} />
  </section>;
}
