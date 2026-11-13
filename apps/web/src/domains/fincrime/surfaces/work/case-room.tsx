import { CaseContextPulls } from "../../../../platform/common/CaseContextPulls";
import type { Schemas } from "@ehf/ui-contracts";
import { usePolled } from "@ehf/ui-client/react";
import { Button, Disclosure, Id, LocalTimestamp, StatusBadge, Table } from "@ehf/ui-kit";
import { Link, useParams } from "@tanstack/react-router";
import { useState } from "react";
import { api } from "../../../../app/api";
import { useSession } from "../../../../app/session";
import { Region } from "../../../../platform/common";
import { CaseFrame, useCaseRead, type CaseRoom } from "../../work/case-frame";
import { ClaimsTable } from "../../work/claims";
import { CommandSheet, NOT_AFFORDANCES, type CommandDraft } from "../../work/command-sheet";
import { useOpenItems } from "../../work/case-findings";
import { actorLabel } from "../../work/case-model";
import { EvidenceRef } from "../../work/evidence";
import { Overview, Findings } from "../../work/overview";
import { CASE_SECTIONS, lensPath, recorderPath, type CaseSection } from "../../work/paths";
import styles from "../../work/work.module.css";

type WorkRow = CaseRoom["workItems"][number];
type HumanAction = Schemas["integrationHumanAction"];
type EvidenceItem = Schemas["CaseEvidenceItem"];
const SOURCE_TEXT: Record<string, string> = { TOOL: "Retrieved by a tool", UPLOAD: "Uploaded", INTERNAL_SYSTEM: "Internal system", HUMAN: "Entered by a person", DERIVED: "Derived on the case" };
const sentence = (value: string): string => { const text = value.replace(/_/g, " ").toLowerCase(); return text.charAt(0).toUpperCase() + text.slice(1); };
type CaseEvent = { sequence?: number; commandType?: string; summary?: string; occurredAt?: string; actor?: { principalId?: string; type?: string } };

const SECTION_IDS = new Set(CASE_SECTIONS.map((section) => section.id));

function Activity({ room }: { room: CaseRoom }) {
  return (
    <div className={styles.stack}>
      <section aria-labelledby="activity-events" className={styles.section}>
        <h3 id="activity-events" className={styles.subTitle}>Latest case events</h3>
        <ul className={styles.plainList}>
          {room.recentEvents.map((event) => (
            <li key={event.sequence}>
              <span className="num">{event.sequence}</span> <Id>{event.commandType}</Id> {event.summary}{" "}
              <span className={styles.muted}>· {event.actor.principalId} · <LocalTimestamp iso={event.occurredAt} compact /></span>
            </li>
          ))}
        </ul>
      </section>
      <WorkTable rows={room.workItems} />
    </div>
  );
}

function WorkTable({ rows }: { rows: readonly WorkRow[] }) {
  return (
    <Table<WorkRow>
      caption="Work items on this case"
      rows={rows}
      rowKey={(row) => row.workItemId}
      columns={[
        { key: "objective", header: "Objective", render: (row) => row.objective },
        { key: "agent", header: "Agent", render: (row) => (row.agentId ? <Id>{row.agentId}</Id> : <span className={styles.muted}>human</span>) },
        { key: "step", header: "Step", render: (row) => (row.stepId ? <Id>{row.stepId}</Id> : "—") },
        { key: "status", header: "Status", render: (row) => <StatusBadge dimension="WorkItemStatus" value={row.status} humanize /> },
        { key: "skill", header: "Work product", render: (row) => (row.skillStatus ? <StatusBadge dimension="SkillStatus" value={row.skillStatus} humanize /> : "—") },
        { key: "updated", header: "Updated", render: (row) => <LocalTimestamp iso={row.updatedAt} compact /> },
      ]}
    />
  );
}

function Claims({ caseId, room }: { caseId: string; room: CaseRoom }) {
  const claims = useCaseRead("getFincrimeCasesCaseIdClaims", { path: { caseId }, query: {} }, room.caseSequence);
  return <Region polled={claims} label="claims">{(data) => <ClaimsTable items={data.items} />}</Region>;
}

/** Evidence: the case's documents and every evidence reference its statements cite. */
function Evidence({ caseId, room }: { caseId: string; room: CaseRoom }) {
  const evidence = useCaseRead("getFincrimeCasesCaseIdEvidence", { path: { caseId } }, room.caseSequence);
  const { sources } = useOpenItems(caseId, room);
  const documents = sources.documents;
  return (
    <div className={styles.stack}>
      <section aria-labelledby="evidence-documents" className={styles.section}>
        <div className={styles.sectionHead}>
          <h3 id="evidence-documents" className={styles.subTitle}>Documents</h3>
          <Link to={lensPath(caseId, "documents")} className={styles.linkButton}>Open documents</Link>
        </div>
        {documents.state === "ready" ? (
          <Table<(typeof documents.data.documents)[number]>
            caption="Case documents"
            captionHidden
            rows={documents.data.documents}
            rowKey={(row) => row.documentId}
            empty="No documents have been added to this case."
            columns={[
              { key: "name", header: "Document", render: (row) => <Link to={lensPath(caseId, "documents")} search={{ document: row.documentId } as never}>{row.filename ?? row.documentId}</Link> },
              { key: "review", header: "Unverified values", render: (row) => <span className="num">{row.reviewPending}</span> },
              { key: "conflicts", header: "Conflicts", render: (row) => <span className="num">{row.conflicts}</span> },
            ]}
          />
        ) : <p className={styles.muted}>{documents.state === "loading" ? "Loading documents…" : documents.state === "not_started" ? "Documents have not been prepared for this case yet." : `Documents could not be loaded (${documents.reason}).`}</p>}
      </section>
      <section aria-labelledby="evidence-registered" className={styles.section}>
        <h3 id="evidence-registered" className={styles.subTitle}>Registered evidence</h3>
        <p className={styles.muted}>Everything registered on the case. Being on file is not acceptance: select a reference to see what cites it and what was recorded from it.</p>
        <Region polled={evidence} label="case evidence">
          {(data) => (
            <Table<EvidenceItem>
              caption="Registered evidence"
              captionHidden
              rows={data.items}
              rowKey={(row) => row.evidenceId}
              empty="No evidence is registered on this case yet."
              columns={[
                { key: "id", header: "Evidence", render: (row) => <EvidenceRef id={row.evidenceId} /> },
                { key: "type", header: "Type", render: (row) => sentence(row.evidenceType) },
                { key: "source", header: "Source", render: (row) => <span>{SOURCE_TEXT[row.source.type] ?? sentence(row.source.type)}{row.source.dataset ? <span className={styles.muted}> · {row.source.dataset}</span> : null}</span> },
                { key: "added", header: "Added", render: (row) => <span><span title={row.addedBy.principalId}>{actorLabel(row.addedBy)}</span> <span className={styles.muted}>· <LocalTimestamp iso={row.addedAt} compact /></span></span> },
                { key: "cited", header: "Cited by", render: (row) => (row.citedBy.length ? <span className="num">{row.citedBy.length} {row.citedBy.length === 1 ? "statement" : "statements"}</span> : <span className={styles.muted}>not cited</span>) },
                { key: "document", header: "Document", render: (row) => (row.documentId ? <Link to={lensPath(caseId, "documents")} search={{ document: row.documentId } as never}>Open</Link> : <span className={styles.muted}>—</span>) },
              ]}
            />
          )}
        </Region>
      </section>
    </div>
  );
}

function Decisions({ room }: { room: CaseRoom }) {
  const decisions = room.humanWork.flatMap((item) => item.decisions.map((decision) => ({ ...decision, objective: item.workItem.objective })));
  return (
    <Table<(typeof decisions)[number]>
      caption="Human decisions on this case"
      rows={decisions}
      rowKey={(row) => row.decisionId}
      empty="No human decisions on the open work items."
      columns={[
        { key: "objective", header: "Step", render: (row) => row.objective },
        { key: "decision", header: "Decision", render: (row) => <StatusBadge dimension="HumanDecision" value={row.decision} /> },
        { key: "by", header: "By", render: (row) => <Id>{row.principalId}</Id> },
        { key: "reason", header: "Reason", render: (row) => <code>{row.reasonCode}</code> },
        { key: "at", header: "When", render: (row) => <LocalTimestamp iso={row.decidedAt} compact /> },
      ]}
    />
  );
}

function History({ caseId, room }: { caseId: string; room: CaseRoom }) {
  const session = useSession();
  const canRead = session.actions.includes("event.read");
  const events = useCaseRead("getCasesCaseIdEvents", { path: { caseId }, query: {} }, room.caseSequence, { enabled: canRead });
  if (!canRead) {
    return (
      <div className={styles.stack}>
        <Disclosure tone="info" title="The full case ledger needs event.read">
          Your role reads the case, not its event log (GAP-075). These are the latest events the case room carries.
        </Disclosure>
        <ul className={styles.plainList} aria-label="Latest case events">
          {room.recentEvents.map((event) => <li key={event.sequence}><span className="num">{event.sequence}</span> <Id>{event.commandType}</Id> {event.summary}</li>)}
        </ul>
      </div>
    );
  }
  return (
    <Region polled={events} label="case history">
      {(data) => (
        <Table<CaseEvent>
          caption="Case events (hash-chained ledger)"
          rows={(data.events as CaseEvent[]).slice().reverse()}
          rowKey={(row) => String(row.sequence)}
          columns={[
            { key: "seq", header: "Seq", render: (row) => <Link to={recorderPath(caseId, `case_event:${row.sequence}`)} className="num">{row.sequence}</Link> },
            { key: "type", header: "Command", render: (row) => <Id>{row.commandType ?? "event"}</Id> },
            { key: "summary", header: "Summary", render: (row) => row.summary ?? "—" },
            { key: "actor", header: "Actor", render: (row) => row.actor?.principalId ?? "—" },
            { key: "at", header: "When", render: (row) => <LocalTimestamp iso={row.occurredAt} compact /> },
          ]}
        />
      )}
    </Region>
  );
}

/** Integration-declared human actions on this case, offered as L1 commands (§9.4). */
function CaseActions({ caseId, room }: { caseId: string; room: CaseRoom }) {
  const session = useSession();
  const actions = usePolled(api, "getIntegrationsHumanCasesCaseIdActions", { path: { caseId } });
  const [draft, setDraft] = useState<CommandDraft | null>(null);
  return (
    <section aria-labelledby="case-actions" className={styles.section}>
      <h3 id="case-actions" className={styles.subTitle}>Case actions</h3>
      <Region polled={actions} label="case actions">
        {(data) => {
          const offered = data.items.filter((action: HumanAction) => !NOT_AFFORDANCES.has(action.commandType));
          if (!offered.length) return <p className={styles.muted}>No integration declares a human action for this case.</p>;
          return (
            <ul className={styles.plainList}>
              {offered.map((action) => {
                const statusOk = action.allowedCaseStatuses.includes(room.status as HumanAction["allowedCaseStatuses"][number]);
                const roleOk = action.allowedRoles.some((role) => session.roles.includes(role));
                const reason = !statusOk ? `Not offered while the case is ${room.status}.` : !roleOk ? `Needs one of: ${action.allowedRoles.join(", ")}.` : null;
                return (
                  <li key={action.id} className={styles.row}>
                    <Button size="sm" disabled={Boolean(reason)} onClick={() => setDraft({ commandType: action.commandType, label: action.label, payloadTemplate: action.payload })}>{action.label}</Button>
                    <span className={styles.muted}>{reason ?? action.description}</span>
                  </li>
                );
              })}
            </ul>
          );
        }}
      </Region>
      <CommandSheet caseId={caseId} caseSequence={room.caseSequence} draft={draft} onClose={() => setDraft(null)} />
    </section>
  );
}

/** BIZ-02 · Case room: the case in its sections, inside the CaseRoom frame. */
export default function CaseRoomSurface() {
  const { caseId = "", section: raw } = useParams({ strict: false }) as { caseId?: string; section?: string };
  const section: CaseSection = raw && SECTION_IDS.has(raw as CaseSection) ? (raw as CaseSection) : "overview";
  const label = CASE_SECTIONS.find((entry) => entry.id === section)!.label;
  return (
    <CaseFrame caseId={caseId} location={{ section }} title={label}>
      {(room) => (
        <>
          {raw && !SECTION_IDS.has(raw as CaseSection) ? <Disclosure tone="attention" title={`There is no "${raw}" section`}>Showing the Overview instead.</Disclosure> : null}
          {section === "overview" ? <Overview caseId={caseId} room={room} /> : null}
          {section === "findings" ? <Findings caseId={caseId} room={room} /> : null}
          {section === "activity" ? <><Activity room={room} /><CaseContextPulls key={caseId} caseId={caseId} /><CaseActions caseId={caseId} room={room} /></> : null}
          {section === "evidence" ? <Evidence caseId={caseId} room={room} /> : null}
          {section === "claims" ? <Claims caseId={caseId} room={room} /> : null}
          {section === "work" ? <WorkTable rows={room.workItems} /> : null}
          {section === "decisions" ? <Decisions room={room} /> : null}
          {section === "history" ? <History caseId={caseId} room={room} /> : null}
        </>
      )}
    </CaseFrame>
  );
}
