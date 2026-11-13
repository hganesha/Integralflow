import type { ImpactReport } from "@ehf/policy-engine/impact";
import { Button, Field, InlineMessage, Select, Switch, Table, TextInput, ToneBadge } from "@ehf/ui-kit";
import { useState } from "react";
import { ApiErrorView, useCommand } from "../platform/common";
import type { PolicyRevision } from "../platform/surfaces/authoring/policy";
import { humanize, sentenceCase } from "./rulebook";
import styles from "./studio.module.css";

/**
 * Publishing in the Policy Studio (Product Policy Studio phase F): the impact of the working copy on
 * the institution's regression set, and when each published revision takes effect, with rollback.
 * The server decides both: impact runs the compiled bundles in OPA, and activation is an append-only
 * history the business-policy authority honours.
 */

export type Activation = { activationId: string; revision: number; kind: "PUBLISH" | "SCHEDULE" | "ROLLBACK"; effectiveFrom: string; actor: string; reason: string; createdAt: string };
export type ActivationView = { activations: Activation[]; active: Activation | null; scheduled: Activation[] };

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
export function toActivations(value: unknown): ActivationView {
  const data = isRecord(value) ? value : {};
  const list = (raw: unknown) => (Array.isArray(raw) ? raw : []).filter(isRecord).map((entry) => entry as unknown as Activation);
  return { activations: list(data.activations), active: isRecord(data.active) ? data.active as unknown as Activation : null, scheduled: list(data.scheduled) };
}
const when = (iso: string) => iso.replace("T", " ").slice(0, 16) + " UTC";
const KIND: Record<Activation["kind"], string> = { PUBLISH: "Published", SCHEDULE: "Scheduled", ROLLBACK: "Rolled back to" };
const CHANGE: Record<string, string> = {
  POLICY_SET_CHANGED: "Policy set", STATE_CHANGED: "Outcome", LEVEL_RAISED: "Level raised", LEVEL_LOWERED: "Level lowered",
  REQUIREMENTS_ADDED: "Requirements added", REQUIREMENTS_REMOVED: "Requirements removed", APPROVALS_ADDED: "Approvals added",
  APPROVALS_REMOVED: "Approvals removed", ACTIONS_CHANGED: "What the gate does", RULES_CHANGED: "Rules",
};

/** Run the regression set through a baseline (the revision in effect, another revision or the template) and the working copy. */
export function ImpactPanel({ working, template, revisions, active, gates }: {
  working: Record<string, string>; template: Record<string, string>; revisions: PolicyRevision[]; active: Activation | null;
  /** The gates the policy defines, the diligence gate first. */
  gates: Array<{ id: string; label: string }>;
}) {
  const run = useCommand("postAuthoringPoliciesImpact");
  const published = revisions.filter((entry) => entry.status === "PUBLISHED" || entry.status === "SUPERSEDED");
  const [baseline, setBaseline] = useState<string>(active ? String(active.revision) : "template");
  const [all, setAll] = useState(false);
  const [gateChoice, setGate] = useState<string | null>(null);
  const gateId = gates.find((gate) => gate.id === gateChoice)?.id ?? gates[0]?.id ?? "diligence-level";
  const [result, setResult] = useState<{ report: ImpactReport; digest: string } | null>(null);
  const baselineFiles = baseline === "template" ? template : revisions.find((entry) => String(entry.revision) === baseline)?.files ?? template;
  const go = async () => {
    setResult(null);
    const response = await run.run({ body: { baseline: { files: baselineFiles }, candidate: { files: working }, gateId } });
    if (response) setResult(response as unknown as { report: ImpactReport; digest: string });
  };
  const report = result?.report;
  const rows = report ? report.rows.filter((row) => all || row.changes.length) : [];
  return (
    <section className={styles.section} aria-labelledby="impact-title">
      <div className={styles.sectionHead}>
        <h3 id="impact-title">Impact on the regression set</h3>
        <span className={styles.hint}>Synthetic cases through the baseline and the working copy, in the compiled bundles. Nothing is stored and no case is touched.</span>
      </div>
      <div className={styles.toolbar}>
        <Field label="Compare with">
          <Select value={baseline} onChange={(event) => { setBaseline(event.target.value); setResult(null); }}>
            <option value="template">The template</option>
            {published.map((entry) => <option key={entry.revision} value={String(entry.revision)}>Revision {entry.revision}{active?.revision === entry.revision ? " (in effect)" : ` (${entry.status.toLowerCase()})`}</option>)}
          </Select>
        </Field>
        <Field label="Gate" hint={gateId === "diligence-level" ? "The level each case is given." : "Later gates read each side's own diligence decision."}>
          <Select value={gateId} onChange={(event) => { setGate(event.target.value); setResult(null); }}>
            {gates.map((gate) => <option key={gate.id} value={gate.id}>{gate.label}</option>)}
          </Select>
        </Field>
        <Button icon="play" busy={run.busy} onClick={() => void go()}>Run impact</Button>
      </div>
      {run.error ? <ApiErrorView error={run.error} title="The impact run failed" /> : null}
      {report ? (
        <div className={styles.stack} aria-label="Impact result" role="region">
          <dl className={styles.summary}>
            <div><dt>Cases</dt><dd>{report.summary.cases}</dd></div>
            <div><dt>Changed</dt><dd>{report.summary.changed}</dd></div>
            {Object.entries(report.summary.byChange).filter(([, count]) => count).map(([change, count]) => <div key={change}><dt>{CHANGE[change] ?? humanize(change)}</dt><dd>{count}</dd></div>)}
          </dl>
          <span className={styles.row}>
            <Switch label="Show unchanged cases" checked={all} onChange={setAll} /><span>Show unchanged cases</span>
            <span className={styles.hint}>Regression set {report.regressionSet.id} {report.regressionSet.version} · report <code>{result!.digest.slice(0, 12)}</code></span>
          </span>
          {rows.length ? (
            <Table
              caption="Cases and how their outcome changes"
              columns={[
                { key: "case", header: "Case", render: (row) => row.label },
                { key: "before", header: "Baseline", render: (row) => outcomeText(row.baseline) },
                { key: "after", header: "Working copy", render: (row) => outcomeText(row.candidate) },
                { key: "changes", header: "Changes", render: (row) => row.changes.length ? row.changes.map((change) => CHANGE[change] ?? change).join(", ") : "None" },
              ]}
              rows={rows}
              rowKey={(row) => row.caseId}
            />
          ) : <ToneBadge tone="positive" icon="checkcircle">No case changes</ToneBadge>}
        </div>
      ) : null}
    </section>
  );
}

function outcomeText(outcome: ImpactReport["rows"][number]["baseline"]): string {
  if (outcome.state === "NO_POLICY_SET") return "No policy set";
  if (!outcome.level) {
    // A checkpoint: its outcome and what it would do (approve, decline, ask people, ask for work).
    const doing = (outcome.actions ?? []).map((action) => action.startsWith("human:") ? `asks ${action.slice(6).replace(/ x(\d+)$/, " ($1 people)")}`
      : action === "FinalizeDisposition:APPROVED" ? "approves" : action === "FinalizeDisposition:DECLINED" ? "declines" : humanize(action.replace(":", " ")));
    return [sentenceCase(humanize(outcome.state)), ...doing, ...(outcome.reasonCodes.length && !doing.length ? [outcome.reasonCodes.join(", ")] : [])].join(" · ");
  }
  const parts = [outcome.level];
  if (outcome.approvals.length) parts.push(`${outcome.approvals.length} approval${outcome.approvals.length === 1 ? "" : "s"}`);
  parts.push(`${outcome.requirements.length} requirements`);
  return parts.join(" · ");
}

/** What is in effect, what is scheduled, the history, and rollback to an earlier published revision. */
export function ActivationPanel({ workspaceId, view, revisions, canPublish, onDone }: {
  workspaceId: string; view: ActivationView; revisions: PolicyRevision[]; canPublish: boolean; onDone: () => void;
}) {
  const rollback = useCommand("postAuthoringPoliciesWorkspacesWorkspaceIdRevisionsRevisionRollback", { invalidate: [["getAuthoringPoliciesWorkspacesWorkspaceIdRevisions"]] });
  const latest = Math.max(0, ...revisions.filter((entry) => entry.status === "PUBLISHED").map((entry) => entry.revision));
  const targets = revisions.filter((entry) => entry.status === "PUBLISHED" && entry.revision < latest);
  const [target, setTarget] = useState("");
  const [reason, setReason] = useState("");
  const chosen = target || (targets[0] ? String(targets[0].revision) : "");
  const blocked = !canPublish ? "Your role cannot roll back (needs draft.publish)." : !targets.length ? "No earlier published revision to return to." : reason.trim().length < 3 ? "Say why you are rolling back." : null;
  return (
    <section className={styles.section} aria-labelledby="activation-title">
      <div className={styles.sectionHead}>
        <h3 id="activation-title">Activation</h3>
        <span className={styles.hint}>A published revision decides cases only once it takes effect; rolling back puts an earlier one back in effect with its exact bundle.</span>
      </div>
      <dl className={styles.settings}>
        <dt>In effect</dt><dd>{view.active ? `Revision ${view.active.revision}, since ${when(view.active.effectiveFrom)}` : "No revision is in effect"}</dd>
        <dt>Scheduled</dt><dd>{view.scheduled.length ? view.scheduled.map((entry) => `Revision ${entry.revision} from ${when(entry.effectiveFrom)}`).join("; ") : "Nothing scheduled"}</dd>
      </dl>
      {view.activations.length ? (
        <Table
          caption="Activation history"
          columns={[
            { key: "when", header: "Takes effect", render: (row) => when(row.effectiveFrom) },
            { key: "what", header: "Change", render: (row) => `${KIND[row.kind]} revision ${row.revision}` },
            { key: "who", header: "By", render: (row) => row.actor },
            { key: "why", header: "Reason", render: (row) => row.reason || "—" },
          ]}
          rows={view.activations}
          rowKey={(row) => row.activationId}
        />
      ) : <p className={styles.hint}>Nothing has been published from this workspace yet.</p>}
      <div className={styles.toolbar}>
        <Field label="Roll back to">
          <Select value={chosen} disabled={!targets.length} onChange={(event) => setTarget(event.target.value)}>
            {targets.length ? targets.map((entry) => <option key={entry.revision} value={String(entry.revision)}>Revision {entry.revision}</option>) : <option value="">No earlier revision</option>}
          </Select>
        </Field>
        <Field label="Why roll back"><TextInput value={reason} onChange={(event) => setReason(event.target.value)} /></Field>
        <Button icon="history" busy={rollback.busy} disabled={Boolean(blocked) || rollback.busy} title={blocked ?? undefined}
          onClick={async () => { const done = await rollback.run({ path: { workspaceId, revision: Number(chosen) }, body: { reason: reason.trim() } }); if (done) { setReason(""); onDone(); } }}>Roll back</Button>
      </div>
      {blocked && canPublish && targets.length ? <p className={styles.hint}>{blocked}</p> : null}
      {rollback.error ? <ApiErrorView error={rollback.error} title="The rollback was refused" /> : null}
      {rollback.state === "confirmed" ? <InlineMessage tone="ok">Rolled back. The later revisions are superseded and no longer decide cases.</InlineMessage> : null}
    </section>
  );
}
