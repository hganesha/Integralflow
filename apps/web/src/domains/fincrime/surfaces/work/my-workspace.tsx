import type { Schemas } from "@ehf/ui-contracts";
import { usePolled } from "@ehf/ui-client/react";
import { Button, EmptyState, Id, LocalTimestamp, StatusBadge, ToneBadge } from "@ehf/ui-kit";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { api } from "../../../../app/api";
import { useSession } from "../../../../app/session";
import { Freshness, Region, useSearchParam } from "../../../../platform/common";
import { StudioFrame } from "../../../../shell/studio-frame";
import { optionsFor } from "../../decision-options";
import { workRoute } from "../../work/paths";
import { assignmentText } from "../../work/case-assignment";

/** Why an item is in the caller's queue. Oversight needs no label: the scope line says it. */
const STANDING_TEXT: Record<string, string> = { assigned: "assigned to you", team: "your team", unassigned: "open to everyone until it is assigned" };
/** What the queue contains, said once at the top so an empty queue is not mistaken for no work anywhere. */
const SCOPE_TEXT: Record<string, string> = {
  standing: "Work on cases assigned to you, to your teams, or not yet assigned to anyone.",
  all: "All case work in the tenant. You oversee case work.",
};
import styles from "../../work/work.module.css";

type Queue = Schemas["AttentionQueue"];
type Item = Queue["groups"][number]["items"][number];
type Group = Queue["groups"][number];

const idsOf = (queue: Queue): string[] => queue.groups.flatMap((group) => group.items.map((item) => `${group.group}:${item.workItemId}`));

/**
 * Freeze the order while the person works in the list (§9.5): values update in place, but
 * arrivals and moves wait behind an "N new items" pill until they choose to apply them.
 */
function useStableQueue(latest: Queue | undefined, frozen: boolean) {
  const [shown, setShown] = useState<Queue | undefined>(latest);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- adopt the latest when not frozen
    if (latest && (!shown || !frozen)) setShown(latest);
  }, [latest, frozen, shown]);
  const view = useMemo<Queue | undefined>(() => {
    if (!shown || !latest) return shown ?? latest;
    // Same shape as shown, values from the latest read where the item still exists.
    const byId = new Map(latest.groups.flatMap((group) => group.items.map((item) => [item.workItemId, item] as const)));
    return { ...latest, groups: shown.groups.map((group) => ({ ...group, items: group.items.map((item) => byId.get(item.workItemId) ?? item) })) };
  }, [shown, latest]);
  const pending = useMemo(() => {
    if (!shown || !latest) return 0;
    const before = new Set(idsOf(shown));
    const after = idsOf(latest);
    const added = after.filter((id) => !before.has(id)).length;
    const changed = added || after.length !== before.size || after.some((id, index) => idsOf(shown)[index] !== id);
    return changed ? Math.max(added, 1) : 0;
  }, [shown, latest]);
  return { view, pending, apply: () => setShown(latest) };
}

function claimText(item: Item, subject: string): string {
  if (item.claim.mine) return "Claimed by you";
  if (item.claim.assignedTo.length) return `Claimed by ${item.claim.assignedTo.filter((principal) => principal !== subject).join(", ")}`;
  return item.claim.claimable ? "Unclaimed · you can claim" : "Unclaimed";
}

function Row({ item, subject, selected, onSelect, onOpen, onMove }: {
  item: Item; subject: string; selected: boolean;
  onSelect: () => void; onOpen: () => void; onMove: (delta: number, from: HTMLElement) => void;
}) {
  const onKeyDown = (event: KeyboardEvent<HTMLLIElement>) => {
    if (event.key === "Enter") { event.preventDefault(); onOpen(); }
    else if (event.key === " ") { event.preventDefault(); onSelect(); }
    else if (event.key === "ArrowDown") { event.preventDefault(); onMove(1, event.currentTarget); }
    else if (event.key === "ArrowUp") { event.preventDefault(); onMove(-1, event.currentTarget); }
  };
  const label = `${item.caseId} ${item.subject.name}: ${item.objective}. ${item.decisionsSoFar} of ${item.requiredApprovals} approvals. ${claimText(item, subject)}.`;
  return (
    <li
      role="option"
      tabIndex={0}
      aria-selected={selected}
      aria-label={label}
      className={styles.item}
      data-work-item={item.workItemId}
      onClick={onSelect}
      onDoubleClick={onOpen}
      onFocus={onSelect}
      onKeyDown={onKeyDown}
    >
      <div className={styles.itemCase}>
        <strong className="num">{item.caseId}</strong>
        <span className={styles.muted}>{item.subject.name}</span>
      </div>
      <div className={styles.itemMain}>
        <span>{item.objective}</span>
        <span className={styles.row}>
          {item.gate ? <span className={styles.muted}>Gate <Id>{item.gate}</Id></span> : null}
          {item.agentId ? <span className={styles.muted}>· <Id>{item.agentId}</Id></span> : null}
        </span>
      </div>
      <div className={styles.itemMain}>
        <StatusBadge dimension="WorkItemStatus" value={item.workStatus} humanize />
        <span className={styles.muted}>{claimText(item, subject)}</span>
        <span className={styles.muted}>Case assigned to: {assignmentText(item.assignment)}{item.standing && STANDING_TEXT[item.standing] ? ` · ${STANDING_TEXT[item.standing]}` : ""}</span>
      </div>
      <div className={styles.itemSide}>
        <span><span className="num">{item.decisionsSoFar}</span>/<span className="num">{item.requiredApprovals}</span> approvals</span>
        {item.deadlineAt ? <span className={styles.muted}>Due <LocalTimestamp iso={item.deadlineAt} compact /></span> : null}
        <span className={styles.row}>
          {item.overdue ? <ToneBadge tone="attention" icon="clock">Overdue</ToneBadge> : null}
          {item.escalated ? <ToneBadge tone="blocking" icon="flag">Escalated</ToneBadge> : null}
        </span>
      </div>
    </li>
  );
}

function Inspector({ item, onOpen }: { item: Item | undefined; onOpen: (item: Item) => void }) {
  if (!item) return <p className={styles.muted}>Select an item to see the accountable human step.</p>;
  const options = optionsFor({ gate: item.gate, taskId: item.taskId });
  return (
    <div className={styles.inspector}>
      <div>
        <div className="t-engraved">Accountable human step</div>
        <h2 className={styles.subTitle}>{item.objective}</h2>
      </div>
      <dl className={styles.kv}>
        <dt>Case</dt><dd><Id>{item.caseId}</Id> · {item.subject.name}</dd>
        <dt>Case status</dt><dd><StatusBadge dimension="KycCaseStatus" value={item.caseStatus} humanize /></dd>
        <dt>Gate</dt><dd>{item.gate ? <Id>{item.gate}</Id> : "None"}</dd>
        <dt>Expected work product</dt><dd>{item.taskId ? <>Output of <Id>{item.taskId}</Id>{item.agentId ? <> prepared by <Id>{item.agentId}</Id></> : null}</> : "A recorded human decision"}</dd>
        <dt>Approvals</dt><dd><span className="num">{item.decisionsSoFar}</span> of <span className="num">{item.requiredApprovals}</span></dd>
        <dt>Claim</dt><dd>{item.claim.assignedTo.length ? item.claim.assignedTo.join(", ") : "Unclaimed"}</dd>
      </dl>
      {options ? (
        <section aria-labelledby="options-title" className={styles.section}>
          <h3 id="options-title" className={styles.eyebrow}>Options when you decide</h3>
          <ul className={styles.plainList}>
            {options.map((option) => <li key={option.decision}><strong>{option.label}</strong> <span className={styles.muted}>— {option.consequence}</span></li>)}
          </ul>
        </section>
      ) : null}
      <div className={styles.actions}><Button variant="primary" icon="arrowr" onClick={() => onOpen(item)}>Open</Button></div>
    </div>
  );
}

/** BIZ-01 · My Workspace: what needs the person's attention, grouped, without reordering under them. */
export default function MyWorkspace() {
  const session = useSession();
  const navigate = useNavigate();
  const work = usePolled(api, "getFincrimeWork");
  const [selectedId, setSelected] = useSearchParam("item");
  const [focused, setFocused] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const { view, pending, apply } = useStableQueue(work.data, focused || Boolean(selectedId));
  const items = view?.groups.flatMap((group) => group.items) ?? [];
  const selected = items.find((item) => item.workItemId === selectedId);
  const open = (item: Item) => void navigate({ to: workRoute(item) });

  const move = (delta: number, from: HTMLElement) => {
    const rows = Array.from(listRef.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? []);
    rows[rows.indexOf(from) + delta]?.focus();
  };

  return (
    <StudioFrame inspector={selected?<Inspector item={selected} onOpen={open} />:undefined} labels={{ inspector: "Selected work item" }}>
      <div className={styles.stack}>
        <header className={styles.headerTop}>
          <div>
            <div className="t-engraved">KYC Workspace · what needs your attention</div>
            <h1 className={styles.title}>My Workspace</h1>
            <p className={styles.muted}>{session.subject.displayName}</p>
          </div>
          <Freshness polled={work} />
        </header>
        <Region polled={work} label="your work">
          {() => (
            <>
              <section aria-label="Work summary" className={styles.tiles}>
                {view!.kpis.map((kpi) => (
                  <div key={kpi.key} className={styles.tile} data-emphasis={kpi.emphasis} data-kpi={kpi.key}>
                    <span className={styles.tileLabel}>{kpi.label}</span>
                    <span className={styles.tileValue}>{kpi.value}</span>
                  </div>
                ))}
              </section>
              <p className={styles.muted}>Computed <LocalTimestamp iso={view!.generatedAt} /> from the human-work queue and case summaries.</p>
              {view!.scope ? <p className={styles.muted} data-testid="queue-scope">{SCOPE_TEXT[view!.scope]}</p> : null}
              {pending ? (
                <button type="button" className={styles.pill} onClick={() => { apply(); setSelected(undefined); }}>
                  {pending} new item{pending === 1 ? "" : "s"} — show (the list doesn't reorder while you work)
                </button>
              ) : null}
              <div
                ref={listRef}
                className={styles.stack}
                onFocus={() => setFocused(true)}
                onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false); }}
              >
                {view!.groups.length === 0 ? (
                  <EmptyState icon="inbox" title="Nothing needs your attention" headingLevel={2}>When a case reaches a step you are accountable for, it appears here.</EmptyState>
                ) : view!.groups.map((group: Group) => (
                  <section key={group.group} className={styles.group} aria-labelledby={`group-${group.group}`} data-group={group.group}>
                    <h2 id={`group-${group.group}`} className={styles.groupHead}>{group.label} <span className="num">{group.items.length}</span></h2>
                    <ul role="listbox" aria-labelledby={`group-${group.group}`} className={styles.items}>
                      {group.items.map((item) => (
                        <Row
                          key={item.workItemId}
                          item={item}
                          subject={session.subject.subjectId}
                          selected={item.workItemId === selectedId}
                          onSelect={() => { if (item.workItemId !== selectedId) setSelected(item.workItemId); }}
                          onOpen={() => open(item)}
                          onMove={move}
                        />
                      ))}
                    </ul>
                  </section>
                ))}
              </div>
            </>
          )}
        </Region>
      </div>
    </StudioFrame>
  );
}
