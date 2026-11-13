import type { Schemas } from "@ehf/ui-contracts";
import { usePolled } from "@ehf/ui-client/react";
import { Button, DigestValue, Disclosure, EmptyState, EpistemicMarker, Id, LocalTimestamp, StatusBadge, Table, ToneBadge } from "@ehf/ui-kit";
import { Link, useParams, useRouterState } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { api } from "../../../../app/api";
import { Freshness, Region } from "../../../../platform/common";
import { useOpenItems } from "../../work/case-findings";
import { CaseFrame, isPendingHuman, type CaseRoom } from "../../work/case-frame";
import { sourceNotices } from "../../work/case-model";
import { useDecisionSheet } from "../../work/decision-host";
import { EvidenceRefs } from "../../work/evidence";
import { ApprovalCount, inConflict } from "../../work/human-step";
import { casePath, lineagePath } from "../../work/paths";
import { RiskAttribution } from "../../work/risk";
import styles from "../../work/work.module.css";

type Desk = Schemas["DecisionDesk"];
type Control = NonNullable<Desk["policyEvaluation"]>["controls"][number];
type QaCheck = Desk["qa"][number];

const FINAL = new Set(["APPROVED", "DECLINED", "CLOSED"]);

/** What the decision is being made on: the case sequence, snapshot and policy it reads. */
function Basis({ desk }: { desk: Desk }) {
  return (
    <p className={styles.meta}>
      <span>Basis: sequence <strong className="num" data-testid="desk-sequence">{desk.basis.caseSequence}</strong></span>
      {desk.policyEvaluation ? <span>Policy <Id>{`${desk.policyEvaluation.policyId}@${desk.policyEvaluation.policyVersion}`}</Id></span> : null}
      <span className={styles.muted}>snapshot <DigestValue value={desk.basis.snapshotDigest} label="snapshot digest" /></span>
      {FINAL.has(desk.status) ? <Link to={lineagePath(desk.caseId)}>Open decision lineage</Link> : null}
    </p>
  );
}

type Blocker = { key: string; tone: "blocking" | "attention"; text: string; href?: string; link?: string };

/** What stands between the case and a decision, each with the place to deal with it. */
function Outstanding({ desk, room }: { desk: Desk; room: CaseRoom }) {
  const { items, sources } = useOpenItems(desk.caseId, room);
  const blockers: Blocker[] = [];
  if (desk.humanWork && inConflict(desk.humanWork)) blockers.push({ key: "conflict", tone: "blocking", text: "Reviewers disagree. The decision stays open until someone who did not decide resolves it." });
  for (const control of desk.policyEvaluation?.controls ?? []) {
    if (control.outcome === "PASS") continue;
    blockers.push({ key: `control:${control.requirementId}`, tone: control.outcome === "FAIL" ? "blocking" : "attention", text: `Policy control "${control.label}" is ${control.outcome.toLowerCase()}${control.note ? ` — ${control.note}` : ""}.`, href: "#controls-title", link: "See controls" });
  }
  if (!desk.policyEvaluation) blockers.push({ key: "policy", tone: "attention", text: "No control-level policy evaluation is recorded for this case." });
  if (!desk.risk) blockers.push({ key: "risk", tone: "attention", text: "No risk assessment is recorded for this case." });
  if (items.length) blockers.push({ key: "items", tone: "attention", text: `${items.length} open ${items.length === 1 ? "item remains" : "items remain"} on the case.`, href: casePath(desk.caseId, "findings"), link: "Open findings" });
  for (const notice of sourceNotices(sources)) if (notice.tone === "attention") blockers.push({ key: `source:${notice.source}`, tone: "attention", text: notice.text });
  const waiting = desk.requirements.requiredApprovals - desk.requirements.decided.length;
  if (desk.humanWork && waiting > 0 && !FINAL.has(desk.status)) blockers.push({ key: "approvals", tone: "attention", text: `${waiting} ${waiting === 1 ? "approval is" : "approvals are"} still needed (${desk.requirements.decided.length} of ${desk.requirements.requiredApprovals} recorded).` });
  return (
    <section aria-labelledby="outstanding-title" className={styles.card}>
      <h3 id="outstanding-title" className={styles.subTitle}>{FINAL.has(desk.status) ? "Recorded with the decision" : "Before you decide"}</h3>
      {blockers.length ? (
        <ul className={styles.plainList}>
          {blockers.map((blocker) => (
            <li key={blocker.key} className={styles.row}>
              <ToneBadge tone={blocker.tone} icon={blocker.tone === "blocking" ? "xcircle" : "alert"}>{blocker.tone === "blocking" ? "Blocking" : "Check"}</ToneBadge>
              <span>{blocker.text}</span>
              {blocker.href ? (blocker.href.startsWith("#") ? <a href={blocker.href}>{blocker.link}</a> : <Link to={blocker.href}>{blocker.link}</Link>) : null}
            </li>
          ))}
        </ul>
      ) : <p className={styles.muted}>Nothing outstanding is reported by the policy evaluation or the case projections.</p>}
    </section>
  );
}

/** Before the decision stage: what the case still has to get through, instead of a dead end. */
function NotYet({ caseId, room }: { caseId: string; room: CaseRoom }) {
  const { items } = useOpenItems(caseId, room);
  const remaining = room.stages.filter((stage) => stage.status !== "done");
  const waiting = room.humanWork.filter(isPendingHuman);
  return (
    <div className={styles.stack}>
      <EmptyState icon="gavel" title="No decision is prepared for this case yet" headingLevel={3}>
        The decision opens when the case reaches its decision stage. Nothing can be decided here before then.
      </EmptyState>
      <section aria-labelledby="remaining-title" className={styles.card}>
        <h3 id="remaining-title" className={styles.subTitle}>What the case is waiting on</h3>
        <ul className={styles.plainList}>
          {remaining.map((stage) => <li key={stage.taskId}><strong>{stage.label}</strong> <span className={styles.muted}>· {stage.status.replace(/_/g, " ")}</span></li>)}
          {waiting.map((item) => <li key={item.workItem.workItemId}>A person is asked to: <strong>{item.workItem.objective}</strong></li>)}
          {items.length ? <li>{items.length} open {items.length === 1 ? "item" : "items"} · <Link to={casePath(caseId, "findings")}>Open findings</Link></li> : null}
          {!remaining.length && !waiting.length && !items.length ? <li className={styles.muted}>Nothing is reported as waiting.</li> : null}
        </ul>
      </section>
    </div>
  );
}

/** Recommendation · policy evaluation · human decisions, never merged into one verdict. */
function ThreeObjects({ desk }: { desk: Desk }) {
  const decided = desk.requirements.decided;
  return (
    <div className={styles.three}>
      <section aria-labelledby="obj-rec" className={styles.card}>
        <div className={styles.row}><h3 id="obj-rec" className={styles.subTitle}>Recommendation</h3><EpistemicMarker kind="recommendation" /></div>
        {desk.recommendation ? (
          <>
            <p><strong>{desk.recommendation.disposition}</strong> — {desk.recommendation.rationale}</p>
            <p className={styles.muted}>By <Id>{desk.recommendation.agentId}</Id> · command <Id>{desk.recommendation.commandId}</Id>. A recommendation is not a decision.</p>
          </>
        ) : <p className={styles.muted}>No recommendation recorded.</p>}
      </section>
      <section aria-labelledby="obj-policy" className={styles.card}>
        <h3 id="obj-policy" className={styles.subTitle}>Policy evaluation</h3>
        {desk.policyEvaluation ? (
          <StatusBadge dimension="PolicyDecision" value={desk.policyEvaluation.decision} showDimension="Policy" humanize />
        ) : <ToneBadge tone="attention" icon="help">Not evaluated</ToneBadge>}
        {desk.policyEvaluation?.decision === "REVIEW" ? <p className={styles.muted}>REVIEW means a person must decide. It is not a pass.</p> : null}
        <ul className={styles.plainList} aria-label="Gates">
          {desk.gates.map((gate) => (
            <li key={gate.gateId}><Id>{gate.gateId}</Id> <StatusBadge dimension="PolicyDecision" value={gate.result} humanize /> <span className={styles.muted}><LocalTimestamp iso={gate.at} compact /></span></li>
          ))}
        </ul>
      </section>
      <section aria-labelledby="obj-human" className={styles.card}>
        <h3 id="obj-human" className={styles.subTitle}>Human decisions</h3>
        <p data-testid="approvals"><ApprovalCount have={decided.length} need={desk.requirements.requiredApprovals} /></p>
        {decided.length ? (
          <ul className={styles.plainList}>
            {decided.map((decision) => (
              <li key={decision.decisionId}>
                <StatusBadge dimension="HumanDecision" value={decision.decision} /> by <Id>{decision.principalId}</Id>{" "}
                <span className={styles.muted}><LocalTimestamp iso={decision.decidedAt} compact /> · <code>{decision.reasonCode}</code></span>
              </li>
            ))}
          </ul>
        ) : <p className={styles.muted}>No one has decided yet.</p>}
        {desk.humanWork && inConflict(desk.humanWork) ? (
          <Disclosure tone="blocking" title="Reviewers disagree (dual-control conflict)">
            The decisions differ, so the item stays waiting. An operator with human_work.resolve who did not decide resolves it.
          </Disclosure>
        ) : null}
      </section>
    </div>
  );
}

function Controls({ desk }: { desk: Desk }) {
  const controls = desk.policyEvaluation?.controls ?? [];
  return (
    <div className={styles.split}>
      <section aria-labelledby="controls-title" className={styles.section}>
        <h3 id="controls-title" className={styles.subTitle}>Policy controls</h3>
        <Table<Control>
          caption="Policy controls"
          captionHidden
          rows={controls}
          rowKey={(row) => row.requirementId}
          empty="No controls evaluated."
          columns={[
            { key: "label", header: "Requirement", render: (row) => <span>{row.label}{row.note ? <span className={styles.muted}> · {row.note}</span> : null}</span> },
            { key: "outcome", header: "Outcome", render: (row) => <StatusBadge dimension="Outcome" value={row.outcome} humanize /> },
            { key: "evidence", header: "Evidence", render: (row) => <EvidenceRefs ids={row.evidenceIds} empty="none" /> },
          ]}
        />
        {controls.some((control) => control.outcome === "UNKNOWN") ? <p className={styles.muted}>UNKNOWN is shown as needing attention. It never counts as a pass.</p> : null}
      </section>
      <div className={styles.stack}>
        {desk.risk ? <RiskAttribution risk={desk.risk} /> : <Disclosure tone="attention" title="Risk not assessed">There is no risk assessment on this case yet.</Disclosure>}
        <section aria-labelledby="qa-title" className={styles.section}>
          <h3 id="qa-title" className={styles.subTitle}>Quality assurance</h3>
          <Table<QaCheck>
            caption="QA checks"
            captionHidden
            rows={desk.qa}
            rowKey={(row) => row.check}
            empty="No QA checks recorded."
            columns={[
              { key: "check", header: "Check", render: (row) => row.check },
              { key: "outcome", header: "Outcome", render: (row) => <StatusBadge dimension="Outcome" value={row.outcome} humanize /> },
              { key: "by", header: "By", render: (row) => <Id>{row.by.principalId}</Id> },
            ]}
          />
        </section>
      </div>
    </div>
  );
}

function Requirements({ desk }: { desk: Desk }) {
  const openSheet = useDecisionSheet();
  const item = desk.humanWork;
  const { youMay, reasonIfNot, options } = desk.requirements;
  const conflict = item ? inConflict(item) : false;
  const canOpenDecide = Boolean(item) && !conflict && (youMay.decide || youMay.claim) && !reasonIfNot;
  const hash = useRouterState({ select: (state) => state.location.hash });
  const autoOpened = useRef(false);

  useEffect(() => {
    // `#decide` deep-links straight into the decision (§8.3), once per visit.
    if (hash === "decide" && item && canOpenDecide && !autoOpened.current) {
      autoOpened.current = true;
      openSheet({ mode: "decide", item, options });
    }
  }, [hash, item, canOpenDecide, openSheet, options]);

  return (
    <div className={styles.inspector}>
      <div className="t-engraved">Requirements</div>
      <dl className={styles.kv}>
        <dt>Approvals</dt><dd><ApprovalCount have={desk.requirements.decided.length} need={desk.requirements.requiredApprovals} /></dd>
        <dt>You may claim</dt><dd>{youMay.claim ? "Yes" : "No"}</dd>
        <dt>You may decide</dt><dd>{youMay.decide ? "Yes" : youMay.claim && !reasonIfNot ? "After you claim it" : "No"}</dd>
        <dt>You may resolve</dt><dd>{youMay.resolve ? "Yes" : "No"}</dd>
        {item ? (<><dt>Claimed by</dt><dd>{item.assignedTo.length ? item.assignedTo.join(", ") : "Unclaimed"}</dd></>) : null}
      </dl>
      {reasonIfNot ? <p className={styles.muted} id="decide-why">{reasonIfNot}</p> : null}
      <div className={styles.actions} id="decide">
        {conflict ? (
          youMay.resolve ? <Button variant="primary" icon="scale" onClick={() => openSheet({ mode: "resolve", item: item!, options: null })}>Resolve conflict</Button> : null
        ) : (
          <Button variant="primary" icon="gavel" disabled={!canOpenDecide} aria-describedby={reasonIfNot ? "decide-why" : undefined} onClick={() => openSheet({ mode: "decide", item: item!, options })}>Decide</Button>
        )}
      </div>
      <section aria-labelledby="options-title" className={styles.section}>
        <h2 id="options-title" className={styles.eyebrow}>Options and consequences</h2>
        <ul className={styles.plainList}>
          {options.map((option) => <li key={option.decision}><strong>{option.label}</strong> <span className={styles.muted}>— {option.consequence}</span></li>)}
        </ul>
      </section>
    </div>
  );
}

function DeskBody({ caseId, room }: { caseId: string; room: CaseRoom }) {
  const desk = usePolled(api, "getFincrimeCasesCaseIdDecision", { path: { caseId } });
  if (!desk.data && desk.error?.reason === "fincrime.not_available") return <NotYet caseId={caseId} room={room} />;
  return (
    <Region polled={desk} label="decision desk">
      {(current) => (
        <div className={styles.stack}>
          <div className={styles.sectionHead}><Basis desk={current} /><Freshness polled={desk} /></div>
          <Outstanding desk={current} room={room} />
          <ThreeObjects desk={current} />
          <Controls desk={current} />
          <section aria-labelledby="limits-title" className={styles.section}>
            <h3 id="limits-title" className={styles.subTitle}>Limitations</h3>
            <ul className={styles.plainList}>
              {current.limitations.map((limit) => <li key={limit.kind + limit.text}><Id>{limit.kind}</Id> {limit.text}</li>)}
            </ul>
          </section>
        </div>
      )}
    </Region>
  );
}

function DeskInspector({ caseId }: { caseId: string }) {
  const desk = usePolled(api, "getFincrimeCasesCaseIdDecision", { path: { caseId } });
  return desk.data ? <Requirements desk={desk.data} /> : null;
}

/** BIZ-07 · Decision: the three objects, what is outstanding, the controls and risk, and the trusted decision — inside the case frame. */
export default function DecisionDeskSurface() {
  const { caseId = "" } = useParams({ strict: false }) as { caseId?: string };
  return (
    <CaseFrame caseId={caseId} location={{ lens: "decision" }} title="Decision" ownAction inspectorExtra={() => <DeskInspector caseId={caseId} />}>
      {(room) => <DeskBody caseId={caseId} room={room} />}
    </CaseFrame>
  );
}
