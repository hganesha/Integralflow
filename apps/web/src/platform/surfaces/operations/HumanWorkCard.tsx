import type { Schemas } from "@ehf/ui-contracts";
import { Button, Id, LocalTimestamp, StatusBadge, ToneBadge } from "@ehf/ui-kit";
import { Link } from "@tanstack/react-router";
import { useSession } from "../../../app/session";
import styles from "./operations.module.css";

type QueueItem = Schemas["HumanQueueItem"];

/** A conflict: reviewers disagree, or control-api has marked the item (PLT-10 AC1). */
export function inConflict(item: QueueItem): boolean {
  return item.workItem.reasonCode === "workflow.human_decision_conflict" || new Set(item.decisions.map((decision) => decision.decision)).size > 1;
}

/** Overdue and escalated as glyph plus text, never colour alone (PLT-10 AC2). */
export function QueueFlags({ item }: { item: QueueItem }) {
  if (!item.overdue && !item.escalated) return <span className={styles.muted}>—</span>;
  return (
    <span className={styles.flags}>
      {item.overdue ? <ToneBadge tone="attention" icon="clock">Overdue</ToneBadge> : null}
      {item.escalated ? <ToneBadge tone="blocking" icon="flag">Escalated</ToneBadge> : null}
    </span>
  );
}

/** The inspector for one human-work item: facts, decisions so far, and what the caller may do. */
export function HumanWorkCard({ item, onDecide, onResolve }: { item: QueueItem; onDecide: () => void; onResolve: () => void }) {
  const session = useSession();
  const subject = session.subject.subjectId;
  const work = item.workItem;
  const decided = item.decisions.some((decision) => decision.principalId === subject);
  const conflict = inConflict(item);
  const canDecide = session.actions.includes("human_work.decide");
  const canResolve = session.actions.includes("human_work.resolve");

  return (
    <aside className={styles.inspector} aria-labelledby="hw-card-title">
      <div>
        <div className={styles.eyebrow}>Human work</div>
        <h2 id="hw-card-title" className={styles.inspectorTitle}>{work.objective}</h2>
      </div>
      <dl className={styles.kv}>
        <dt>Work item</dt><dd><Id>{work.workItemId}</Id></dd>
        <dt>Case</dt><dd><Link to={`/platform/cases/${encodeURIComponent(work.caseId)}` as string}>{work.caseId}</Link></dd>
        <dt>Gate</dt><dd><Id>{work.workType}</Id></dd>
        <dt>Status</dt><dd><StatusBadge dimension="WorkItemStatus" value={work.status} humanize /></dd>
        <dt>Deadline</dt><dd>{work.deadlineAt ? <LocalTimestamp iso={work.deadlineAt} /> : "None"}</dd>
        <dt>Flags</dt><dd><QueueFlags item={item} /></dd>
        <dt>Claimed by</dt><dd>{item.assignedTo.length ? item.assignedTo.join(", ") : "Unclaimed"}</dd>
        <dt>Approvals</dt><dd><span className="num">{item.decisions.length}</span> of <span className="num">{item.requiredApprovals}</span> required</dd>
        {work.reasonCode ? (<><dt>Reason</dt><dd><code>{work.reasonCode}</code></dd></>) : null}
      </dl>
      {item.decisions.length ? (
        <section className={styles.section} aria-label="Decisions so far">
          <div className={styles.eyebrow}>Decisions</div>
          <ul className={styles.plainList}>
            {item.decisions.map((decision) => (
              <li key={decision.decisionId}>
                <StatusBadge dimension="HumanDecision" value={decision.decision} /> by <Id>{decision.principalId}</Id>{" "}
                <span className={styles.muted}><LocalTimestamp iso={decision.decidedAt} compact /> · <code>{decision.reasonCode}</code></span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <div className={styles.actions}>
        {conflict ? (
          canResolve ? (
            <Button variant="primary" icon="scale" onClick={onResolve} disabled={decided}>Resolve conflict</Button>
          ) : null
        ) : canDecide ? (
          <Button variant="primary" icon="gavel" onClick={onDecide} disabled={decided}>Decide</Button>
        ) : null}
      </div>
      {conflict && canResolve && decided ? <p className={styles.muted}>You decided this item, so someone who did not decide must resolve it.</p> : null}
      {conflict && !canResolve ? <p className={styles.muted}>Reviewers disagree. An operator with human_work.resolve who did not decide resolves it.</p> : null}
      {!conflict && canDecide && decided ? <p className={styles.muted}>You decided this item. A second, different approver is required.</p> : null}
      {!conflict && !canDecide ? <p className={styles.muted}>Deciding needs human_work.decide.</p> : null}
    </aside>
  );
}
