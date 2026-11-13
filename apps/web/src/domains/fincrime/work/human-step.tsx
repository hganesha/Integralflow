import type { Schemas } from "@ehf/ui-contracts";
import { Button, Id, LocalTimestamp, StatusBadge, ToneBadge } from "@ehf/ui-kit";
import { useSession } from "../../../app/session";
import { decisionOptions } from "../decision-options";
import { useDecisionSheet } from "./decision-host";
import styles from "./work.module.css";

type QueueItem = Schemas["HumanQueueItem"];
type DecisionOption = Schemas["DecisionOption"];

export function gateOf(item: QueueItem): string {
  const gate = (item.workItem.constraints as Record<string, unknown> | null | undefined)?.gate;
  return typeof gate === "string" && gate ? gate : item.workItem.workType;
}

export function inConflict(item: QueueItem): boolean {
  return item.workItem.reasonCode === "workflow.human_decision_conflict" || new Set(item.decisions.map((decision) => decision.decision)).size > 1;
}

/** Why the caller can't decide (or resolve) this item now, or null. */
export function decideBlocker(item: QueueItem, subject: string, actions: readonly string[]): string | null {
  const conflict = inConflict(item);
  if (conflict) {
    if (!actions.includes("human_work.resolve")) return "Reviewers disagree. An operator with human_work.resolve who did not decide resolves it.";
    if (item.decisions.some((decision) => decision.principalId === subject)) return "You decided this item, so someone who did not decide must resolve it.";
    return null;
  }
  if (!actions.includes("human_work.decide")) return "Your role doesn't permit deciding this step. It needs human_work.decide.";
  if (item.decisions.some((decision) => decision.principalId === subject)) return "You've already decided. A second, different approver is required.";
  return null;
}

/** "1 of 2" as filled and empty pips plus text (never colour alone). */
export function ApprovalCount({ have, need }: { have: number; need: number }) {
  return <span><span className="num">{have}</span> of <span className="num">{need}</span> {need > 1 ? "approvals (dual control)" : "approval"}</span>;
}

/**
 * The accountable human step on a case (BIZ-02 "Human action"): what the person is asked to
 * do, who holds it, the approvals so far, and the Decide control. Deciding always happens in
 * the TrustedDecisionSheet (N7).
 */
export function HumanStep({ item, options, title = "Human action" }: {
  item: QueueItem;
  /** Domain options when the projection carries them; else the module table. */
  options?: DecisionOption[] | null;
  title?: string;
}) {
  const session = useSession();
  const openSheet = useDecisionSheet();
  const subject = session.subject.subjectId;
  const conflict = inConflict(item);
  const blocker = decideBlocker(item, subject, session.actions);
  const pending = item.workItem.status === "WAITING_HUMAN" || item.workItem.status === "HUMAN_REQUIRED";
  const choices = options?.length ? options : decisionOptions(item);
  const headingId = `step-${item.workItem.workItemId}`;

  return (
    <section className={styles.humanStep} aria-labelledby={headingId}>
      <div>
        <div className={styles.eyebrow}>{title}</div>
        <h3 id={headingId} className={styles.subTitle}>{item.workItem.objective}</h3>
      </div>
      <dl className={styles.kv}>
        <dt>Work item</dt><dd><Id>{item.workItem.workItemId}</Id></dd>
        <dt>Gate</dt><dd><Id>{gateOf(item)}</Id></dd>
        <dt>Status</dt><dd><StatusBadge dimension="WorkItemStatus" value={item.workItem.status} humanize /></dd>
        <dt>Claimed by</dt><dd>{item.assignedTo.length ? item.assignedTo.join(", ") : "Unclaimed"}</dd>
        <dt>Approvals</dt><dd><ApprovalCount have={item.decisions.length} need={item.requiredApprovals} /></dd>
        <dt>Deadline</dt><dd>{item.workItem.deadlineAt ? <LocalTimestamp iso={item.workItem.deadlineAt} /> : "None"}</dd>
      </dl>
      {conflict ? <ToneBadge tone="blocking" icon="scale">Reviewers disagree</ToneBadge> : null}
      {item.decisions.length ? (
        <ul className={styles.plainList} aria-label="Decisions so far">
          {item.decisions.map((decision) => (
            <li key={decision.decisionId}>
              <StatusBadge dimension="HumanDecision" value={decision.decision} /> by <Id>{decision.principalId}</Id>{" "}
              <span className={styles.muted}><LocalTimestamp iso={decision.decidedAt} compact /></span>
            </li>
          ))}
        </ul>
      ) : null}
      {choices ? (
        <div>
          <div className={styles.eyebrow}>Options</div>
          <ul className={styles.plainList}>
            {choices.map((choice) => <li key={choice.decision}><strong>{choice.label}</strong> <span className={styles.muted}>— {choice.consequence}</span></li>)}
          </ul>
        </div>
      ) : null}
      {pending ? (
        <div className={styles.actions}>
          <Button
            variant="primary"
            icon={conflict ? "scale" : "gavel"}
            disabled={Boolean(blocker)}
            aria-describedby={blocker ? `${headingId}-why` : undefined}
            onClick={() => openSheet({ mode: conflict ? "resolve" : "decide", item, options: conflict ? null : choices })}
          >
            {conflict ? "Resolve conflict" : "Decide"}
          </Button>
        </div>
      ) : null}
      {pending && blocker ? <p id={`${headingId}-why`} className={styles.muted}>{blocker}</p> : null}
    </section>
  );
}
