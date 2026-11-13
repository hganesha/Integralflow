import { Button, DigestValue, Disclosure, Icon, Id, LocalTimestamp, Sheet, Skeleton, StatusBadge, SyntheticPill, ToneBadge } from "@ehf/ui-kit";
import { Link, useSearch } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { ApiErrorView, Freshness, Region, useSearchParam } from "../../../platform/common";
import { StudioFrame } from "../../../shell/studio-frame";
import { AssignmentPanel, assignmentText } from "./case-assignment";
import { OpenItemDetail, useOpenItems } from "./case-findings";
import { EvidenceDetail } from "./evidence";
import { FindingDispositionSheet } from "./finding-disposition";
import { useSearchText } from "./search";
import { actorLabel, agentLabel, isPendingStep, KIND_TEXT, readiness as readinessOf, type OpenItem, type Readiness, type RecordedFinding } from "./case-model";
import { useCaseRoom, type CaseRoom } from "./case-reads";
import { DecisionHost } from "./decision-host";
import { HumanStep } from "./human-step";
import { casePath, decisionPath, lensPath, workspacePath, type CaseLens, type CaseSection } from "./paths";
import styles from "./work.module.css";

export { useCaseRead, useCaseRoom, useFollowSequence, type CaseRoom } from "./case-reads";

type Stage = CaseRoom["stages"][number];
type Lens = CaseRoom["lenses"][number];

export type CaseLocation = { section: CaseSection } | { lens: CaseLens | "decision" };

const STAGE_TEXT: Record<Stage["status"], { label: string; tone: "positive" | "attention" | "blocking" | "neutral" | "info"; icon: "checkcircle" | "eye" | "clock" | "minus" | "alert" | "file" }> = {
  done: { label: "Done", tone: "positive", icon: "checkcircle" },
  current: { label: "Current", tone: "info", icon: "clock" },
  pending: { label: "Not started", tone: "neutral", icon: "minus" },
  blocked: { label: "Blocked", tone: "blocking", icon: "alert" },
  needs_review: { label: "Needs review", tone: "attention", icon: "eye" },
  needs_evidence: { label: "Needs evidence", tone: "attention", icon: "file" },
};

export const isPendingHuman = isPendingStep;

/** The current stage: the first that is not done (derived, never stored). */
export function currentStage(stages: readonly Stage[]): Stage | undefined {
  return stages.find((stage) => stage.status !== "done");
}

/**
 * Stages derived from work items × the catalog's task order (BIZ-02-AC1), as one compact row
 * in the case header so the current stage is visible from every workspace.
 */
export function StageTrack({ stages }: { stages: readonly Stage[] }) {
  const current = currentStage(stages);
  if (!stages.length) return null;
  return (
    <ol className={styles.stageRow} aria-label="Stages">
      {stages.map((stage) => {
        const text = STAGE_TEXT[stage.status];
        return (
          <li key={stage.taskId} className={styles.stageChip} aria-current={stage === current ? "step" : undefined} data-stage={stage.taskId} data-tone={text.tone}>
            <Icon name={text.icon} size="sm" />
            <span>{stage.label}</span>
            <span className={styles.stageState}>{text.label}</span>
          </li>
        );
      })}
    </ol>
  );
}

/** What the frame knows about a case beyond the room: its open items and the readiness line. */
type CaseState = { items: OpenItem[]; readiness: Readiness; itemsLoading: boolean };

type NavEntry = { key: string; label: string; to: string; active: boolean; count?: number | undefined; badge?: string | null | undefined; unavailable?: boolean; children?: NavEntry[] };

function NavRow({ entry, nested = false }: { entry: NavEntry; nested?: boolean }) {
  return (
    <li>
      {entry.unavailable ? (
        <span className={`${styles.navLink} ${styles.navDisabled} ${nested ? styles.navNested : ""}`}>
          <span>{entry.label}</span><span className={styles.muted}>not yet</span>
        </span>
      ) : (
        <Link to={entry.to} className={`${styles.navLink} ${nested ? styles.navNested : ""}`} activeOptions={{ exact: true, includeSearch: false }} aria-current={entry.active ? "page" : undefined}>
          <span>{entry.label}</span>
          {entry.badge ? <span className={styles.badge}>{entry.badge}</span> : entry.count !== undefined ? <span className="num">{entry.count}</span> : null}
        </Link>
      )}
      {entry.children?.length ? <ul className={styles.navList}>{entry.children.map((child) => <NavRow key={child.key} entry={child} nested />)}</ul> : null}
    </li>
  );
}

const KNOWN_LENSES = new Set(["ownership", "documents", "screening", "risk", "decision"]);

/** The five workspaces, with the existing sections and lenses under the one they belong to. */
function workspaces(room: CaseRoom, location: CaseLocation, state: CaseState): { main: NavEntry[]; record: NavEntry[]; more: NavEntry[] } {
  const lenses = new Map<string, Lens>(room.lenses.map((lens) => [lens.lens, lens]));
  const section = (id: CaseSection) => "section" in location && location.section === id;
  const onLens = (id: string) => "lens" in location && location.lens === id;
  const lens = (id: CaseLens | "decision", label: string): NavEntry => {
    const entry = lenses.get(id);
    return { key: `lens:${id}`, label, to: id === "decision" ? decisionPath(room.caseId) : lensPath(room.caseId, id), active: onLens(id), badge: entry?.badge, unavailable: !entry?.available };
  };
  const decisions = room.humanWork.reduce((total, item) => total + item.decisions.length, 0);
  return {
    main: [
      { key: "overview", label: "Overview", to: casePath(room.caseId), active: section("overview") },
      lens("ownership", "Ownership & parties"),
      { key: "findings", label: "Findings", to: casePath(room.caseId, "findings"), active: section("findings"), count: state.itemsLoading ? undefined : state.items.length, children: [lens("screening", "Screening")] },
      { key: "evidence", label: "Evidence", to: casePath(room.caseId, "evidence"), active: section("evidence"), count: room.counts.evidence, children: [
        lens("documents", "Documents"),
        { key: "claims", label: "Claims and facts", to: casePath(room.caseId, "claims"), active: section("claims"), count: room.counts.claims },
      ] },
      { ...lens("decision", "Decision"), children: [
        lens("risk", "Risk"),
        { key: "decisions", label: "Decisions recorded", to: casePath(room.caseId, "decisions"), active: section("decisions"), count: decisions },
      ] },
    ],
    record: [
      { key: "work", label: "Work items", to: casePath(room.caseId, "work"), active: section("work"), count: room.workItems.length },
      { key: "activity", label: "Activity and actions", to: casePath(room.caseId, "activity"), active: section("activity") },
      { key: "history", label: "History", to: casePath(room.caseId, "history"), active: section("history") },
    ],
    more: room.lenses.filter((entry) => !KNOWN_LENSES.has(entry.lens)).map((entry) => ({
      key: `lens:${entry.lens}`, label: entry.label, to: lensPath(room.caseId, entry.lens as CaseLens), active: onLens(entry.lens), badge: entry.badge, unavailable: !entry.available,
    })),
  };
}

function Orientation({ room, location, state }: { room: CaseRoom; location: CaseLocation; state: CaseState }) {
  const nav = workspaces(room, location, state);
  return (
    <div className={styles.orient}>
      <Link to={workspacePath} className={styles.backLink}>← My Workspace</Link>
      <AssignmentPanel room={room} />
      <nav aria-label="Case sections">
        <div className="t-engraved">Case</div>
        <ul className={styles.navList}>{nav.main.map((entry) => <NavRow key={entry.key} entry={entry} />)}</ul>
      </nav>
      <nav aria-label="Case record">
        <div className="t-engraved">Record</div>
        <ul className={styles.navList}>{nav.record.map((entry) => <NavRow key={entry.key} entry={entry} />)}</ul>
      </nav>
      {nav.more.length ? (
        <nav aria-label="More lenses">
          <div className="t-engraved">More</div>
          <ul className={styles.navList}>{nav.more.map((entry) => <NavRow key={entry.key} entry={entry} />)}</ul>
        </nav>
      ) : null}
    </div>
  );
}

const PRIORITY_ITEMS = 3;

/**
 * Where the case stands, first: the readiness line as a headline, then the open items that come
 * first in the disclosed order. A statement of what is waiting, never a score.
 */
function Verdict({ room, state, selected, onSelect }: { room: CaseRoom; state: CaseState; selected: OpenItem | undefined; onSelect: (id: string) => void }) {
  const { readiness, items } = state;
  const top = items.slice(0, PRIORITY_ITEMS);
  return (
    <section aria-labelledby="ci-verdict" className={styles.verdict} data-tone={readiness.tone}>
      <h2 id="ci-verdict" className={styles.verdictTitle}><span className={styles.verdictDot} aria-hidden="true" />{readiness.tone === "attention" ? "Work remains" : "Nothing waiting"}</h2>
      <p className={styles.verdictText}>{readiness.text}</p>
      {top.length ? (
        <>
          <div className="t-engraved">Priority items</div>
          <ol className={styles.priority} aria-label="Priority items">
            {top.map((item, index) => (
              <li key={item.id}>
                <button type="button" className={styles.priorityItem} aria-pressed={selected?.id === item.id} onClick={() => onSelect(item.id)}>
                  <span className={`${styles.muted} num`} aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
                  <span>
                    <strong>{item.title}</strong>
                    <span className={styles.muted}>{KIND_TEXT[item.kind].label}{item.party ? ` · ${item.party}` : ""}</span>
                  </span>
                </button>
              </li>
            ))}
          </ol>
          <Link to={casePath(room.caseId, "findings")}>{items.length > top.length ? `View all ${items.length} open items →` : "Open the findings queue →"}</Link>
        </>
      ) : state.itemsLoading ? <p className={styles.muted}>Loading open items…</p> : null}
    </section>
  );
}

/** Case Intelligence (BIZ-02 inspector): where the case stands, the human action, the selected item, and what is on file. */
function Intelligence({ room, state, selected, finding, onRecord, onSelect, onClear, extra, ownAction }: { room: CaseRoom; state: CaseState; selected: OpenItem | undefined; finding: RecordedFinding | undefined; onRecord: (finding: RecordedFinding) => void; onSelect: (id: string) => void; onClear: () => void; extra?: ReactNode; ownAction: boolean }) {
  const prepared = room.workItems.filter((item) => item.skillStatus);
  // A surface that carries its own human action (the decision) shows it instead of the generic step.
  const pending = ownAction ? [] : room.humanWork.filter(isPendingHuman);
  const evidenceId = useSearchText()("evidence");
  return (
    <div className={styles.inspector}>
      <div className="t-engraved">Case intelligence</div>
      <Verdict room={room} state={state} selected={selected} onSelect={onSelect} />
      {pending.map((item) => <HumanStep key={item.workItem.workItemId} item={item} />)}
      {extra}
      {evidenceId ? <EvidenceDetail caseId={room.caseId} room={room} evidenceId={evidenceId} /> : null}
      {selected ? <OpenItemDetail item={selected} finding={finding} onRecord={onRecord} onClear={onClear} /> : null}
      <section aria-labelledby="ci-findings" className={styles.section}>
        <h2 id="ci-findings" className={styles.subTitle}>Prepared by agents</h2>
        {prepared.length ? (
          <ul className={styles.plainList}>
            {prepared.map((item) => (
              <li key={item.workItemId}>
                <StatusBadge dimension="SkillStatus" value={item.skillStatus!} humanize /> {item.objective}{" "}
                {item.agentId ? <span className={styles.muted} title={item.agentId}>· {agentLabel(item.agentId)}</span> : null}
              </li>
            ))}
          </ul>
        ) : <p className={styles.muted}>No agent work products yet.</p>}
      </section>
      <section aria-labelledby="ci-uncertainty" className={styles.section}>
        <h2 id="ci-uncertainty" className={styles.subTitle}>On file</h2>
        <dl className={styles.kv}>
          <dt>Accepted facts</dt><dd className="num">{room.counts.facts}</dd>
          <dt>Evidence items</dt><dd className="num">{room.counts.evidence}</dd>
          <dt>Assumptions</dt><dd className="num">{room.counts.assumptions}</dd>
          <dt>Open contradictions</dt><dd className="num">{room.counts.openContradictions}</dd>
        </dl>
      </section>
      <section aria-labelledby="ci-policy" className={styles.section}>
        <h2 id="ci-policy" className={styles.subTitle}>Policy basis</h2>
        <dl className={styles.kv}>
          <dt>Policy</dt><dd><Id>{`${room.policyAuthority.policyId}@${room.policyAuthority.policyVersion}`}</Id></dd>
        </dl>
        <details className={styles.recordDetails}>
          <summary>Record identifiers</summary>
          <dl className={styles.kv}>
            <dt>Policy snapshot</dt><dd><DigestValue value={room.policyAuthority.policySnapshotDigest} label="policy snapshot digest" /></dd>
            <dt>Policy bundle</dt><dd><DigestValue value={room.policyAuthority.policyBundleDigest} label="policy bundle digest" /></dd>
            <dt>Case snapshot</dt><dd><DigestValue value={room.snapshotDigest} label="snapshot digest" /></dd>
          </dl>
        </details>
      </section>
    </div>
  );
}

/** The persistent bar: where the case stands and the valid next moves. Never a percentage. */
function DecisionBar({ room, state }: { room: CaseRoom; state: CaseState }) {
  const decision = room.lenses.find((lens) => lens.lens === "decision");
  const { readiness } = state;
  return (
    <div className={styles.decisionBar} role="region" aria-label="Case readiness and next actions">
      <div className={styles.decisionBarStatus}>
        <ToneBadge tone={readiness.tone} icon={readiness.tone === "attention" ? "alert" : "minus"}>{readiness.tone === "attention" ? "Work remains" : "Nothing waiting"}</ToneBadge>
        <span className={styles.decisionBarText}>{readiness.text}</span>
      </div>
      <div className={styles.actions}>
        <Link to={casePath(room.caseId, "findings")} className={styles.linkButton}>Open items{state.itemsLoading ? "" : ` (${state.items.length})`}</Link>
        {decision?.available ? (
          <Link to={decisionPath(room.caseId)} className={`${styles.linkButton} ${styles.linkPrimary}`}>Open decision</Link>
        ) : (
          <span className={styles.row}>
            <Button size="sm" variant="primary" icon="gavel" disabled aria-describedby="decision-bar-why">Open decision</Button>
            <span id="decision-bar-why" className={styles.muted}>Opens at the decision stage</span>
          </span>
        )}
      </div>
    </div>
  );
}

function Timeline({ room, open, onClose }: { room: CaseRoom; open: boolean; onClose: () => void }) {
  return (
    <Sheet open={open} onClose={onClose} title="Case timeline" description="The latest recorded events on this case, newest first.">
      {room.recentEvents.length ? (
        <ol className={styles.timeline} aria-label="Latest case events">
          {room.recentEvents.map((event) => (
            <li key={event.sequence}>
              <span className="num">{event.sequence}</span>
              <span>
                <strong>{event.summary}</strong>
                <span className={styles.muted} title={`${event.commandType} · ${event.actor.principalId}`}> · {actorLabel(event.actor)} · <LocalTimestamp iso={event.occurredAt} compact /></span>
              </span>
            </li>
          ))}
        </ol>
      ) : <p className={styles.muted}>No recent events are reported for this case. The full ledger is in History.</p>}
      <p><Link to={casePath(room.caseId, "history")} onClick={onClose}>Open the full history</Link></p>
    </Sheet>
  );
}

function Header({ room, state, focused, freshness, onTimeline }: { room: CaseRoom; state: CaseState; focused: boolean; freshness: ReactNode; onTimeline: () => void }) {
  const identifiers = room.subject.identifiers ?? [];
  const stage = currentStage(room.stages);
  const facts: [string, ReactNode][] = [
    ["Customer type", room.subject.kind.replace(/_/g, " ").replace(/^./, (first) => first.toUpperCase())],
    ["Jurisdiction", room.jurisdiction],
    ...(identifiers.length ? [["Identifier", identifiers.join(", ")] as [string, ReactNode]] : []),
    ["Stage", stage ? stage.label : room.stages.length ? "All stages done" : "Not reported"],
    ["Assigned to", assignmentText(room.assignment)],
  ];
  const deadlines = room.humanWork.filter(isPendingHuman).map((item) => item.workItem.deadlineAt).filter((value): value is string => Boolean(value)).sort();
  return (
    <header className={`${styles.caseHeader} ${focused ? styles.focusHeader : ""}`} data-focus={focused}>
      <div className={styles.headerTop}>
        <div>
          <div className="t-engraved">{room.caseType} case · <Id>{room.caseId}</Id></div>
          <h1 className={styles.title}>{room.subject.name}</h1>
        </div>
        <div className={styles.row}>
          {freshness}
          <Button size="sm" icon="clock" onClick={onTimeline}>Timeline</Button>
        </div>
      </div>
      {focused ? null : (
        <dl className={styles.facts} aria-label="Case facts">
          {facts.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
        </dl>
      )}
      <div className={styles.meta}>
        <StatusBadge dimension="KycCaseStatus" value={room.status} showDimension="Case" humanize size="lg" />
        <span className={styles.readiness} data-tone={state.readiness.tone} data-testid="case-readiness">{state.readiness.text}</span>
        {deadlines[0] ? <span>Due <LocalTimestamp iso={deadlines[0]} /></span> : null}
        <span className={styles.muted} title="Every decision is recorded against the case sequence it was made on.">Sequence <strong className="num" data-testid="case-sequence">{room.caseSequence}</strong></span>
        {room.synthetic ? <SyntheticPill /> : null}
      </div>
      <StageTrack stages={room.stages} />
    </header>
  );
}

function Frame({ room, polled, location, title, inspectorExtra, ownAction = false, children }: {
  room: CaseRoom;
  polled: ReturnType<typeof useCaseRoom>;
  location: CaseLocation;
  title: string;
  inspectorExtra?: ((room: CaseRoom) => ReactNode) | undefined;
  ownAction?: boolean | undefined;
  children: (room: CaseRoom) => ReactNode;
}) {
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  // A detailed review surface takes the full width: one document, or the expanded ownership canvas.
  const focusedDocument = "lens" in location && ((location.lens === "documents" && typeof search.document === "string") || (location.lens === "ownership" && String(search.expand) === "1"));
  const [timeline, setTimeline] = useState(false);
  // The finding being dispositioned is held here, not in the inspector: once recorded it leaves
  // the open queue, and the sheet must stay up to confirm the record.
  const [recording, setRecording] = useState<RecordedFinding | null>(null);
  const [focus, setFocus] = useSearchParam("item");
  const { sources, items } = useOpenItems(room.caseId, room);
  const state: CaseState = {
    items,
    readiness: readinessOf(room, items, sources),
    itemsLoading: Object.values(sources).some((source) => source.state === "loading"),
  };
  const selected = items.find((item) => item.id === focus);
  const finding = selected?.findingId && sources.findings.state === "ready" ? sources.findings.data.items.find((entry) => entry.findingId === selected.findingId) : undefined;
  return (
    <DecisionHost liveItems={room.humanWork}>
      <StudioFrame
        focusMain={focusedDocument}
        orient={<Orientation room={room} location={location} state={state} />}
        inspector={<Intelligence room={room} state={state} onSelect={setFocus} selected={selected} finding={finding} onRecord={setRecording} onClear={() => setFocus(undefined)} extra={inspectorExtra?.(room)} ownAction={ownAction} />}
        rail={<DecisionBar room={room} state={state} />}
        labels={{ orient: "Case navigation", inspector: "Case intelligence", rail: "Case readiness" }}
      >
        <Region polled={polled} label="case room">
          {(current) => (
            <div className={styles.stack}>
              <Header room={current} state={state} focused={focusedDocument} freshness={<Freshness polled={polled} />} onTimeline={() => setTimeline(true)} />
              <h2 className={styles.sectionTitle}>{title}</h2>
              {children(current)}
            </div>
          )}
        </Region>
        <Timeline room={room} open={timeline} onClose={() => setTimeline(false)} />
        {recording ? <FindingDispositionSheet caseId={room.caseId} caseSequence={room.caseSequence} finding={recording} open onClose={() => setRecording(null)} /> : null}
      </StudioFrame>
    </DecisionHost>
  );
}

/**
 * The CaseRoom template (§8.2): case navigation by workspace, the compact case header with the
 * readiness line, the surface body, the Case Intelligence inspector and the readiness bar.
 * Every BIZ case surface renders inside it so region positions never move.
 */
export function CaseFrame({ caseId, location, title, inspectorExtra, ownAction, children }: {
  caseId: string;
  location: CaseLocation;
  /** The surface's own heading under the case header. */
  title: string;
  inspectorExtra?: (room: CaseRoom) => ReactNode;
  /** The surface shows the human action itself, so the inspector does not repeat the generic step. */
  ownAction?: boolean;
  children: (room: CaseRoom) => ReactNode;
}) {
  const room = useCaseRoom(caseId);
  if (!room.data) {
    return (
      <StudioFrame>
        <h1 className={styles.title}>{title} · {caseId}</h1>
        {room.error ? <ApiErrorView error={room.error} /> : <Skeleton height={320} label="Loading the case room" />}
      </StudioFrame>
    );
  }
  return <Frame room={room.data} polled={room} location={location} title={title} inspectorExtra={inspectorExtra} ownAction={ownAction}>{children}</Frame>;
}

/** A lens that has no data contract yet renders the frame plus a disclosure (G11). */
export function FrameOnly({ what }: { what: string }) {
  return <Disclosure tone="info" title={`${what} is not available yet`}>This lens renders its frame only until the upstream projection exists (G11). No data is fabricated.</Disclosure>;
}
