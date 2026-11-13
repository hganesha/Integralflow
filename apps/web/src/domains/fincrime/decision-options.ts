import type { Schemas } from "@ehf/ui-contracts";

type DecisionOption = Schemas["DecisionOption"];
type Key = { workType?: string | null; gate?: string | null; taskId?: string | null };

const reasons = (...pairs: Array<[string, string]>) => pairs.map(([code, label]) => ({ code, label }));

const SCREENING_REASONS = reasons(["kyc.screening.false_match", "False match"], ["kyc.screening.potential_true_match", "Potential true match"]);
const ONBOARDING_REASONS = reasons(["kyc.onboarding.approve", "Within risk appetite"], ["kyc.onboarding.decline", "Outside risk appetite"], ["kyc.onboarding.rework", "Needs rework"]);
const OWNERSHIP_REASONS = reasons(["kyc.ownership.supported", "Findings supported by evidence"], ["kyc.ownership.unsupported", "Findings not supported"], ["kyc.ownership.more_evidence", "More evidence needed"]);

const option = (decision: DecisionOption["decision"], label: string, consequence: string, reasonCodes: DecisionOption["reasonCodes"]): DecisionOption => ({
  decision, label, consequence, requiresRationale: true, reasonCodes, form: null,
});

/**
 * FinCrime decision labels keyed by task (and gate), G8 (BUILD-SPEC v2 §5.6). The screening
 * and onboarding rows repeat what the FinCrime projections return in `options`; ownership
 * review has no projection that carries options, so its labels live only here (GAP-071).
 */
const TABLE: ReadonlyArray<{ match: (key: Key) => boolean; options: DecisionOption[] }> = [
  {
    match: (key) => key.taskId === "task.screening",
    options: [
      option("APPROVE", "Confirm false match", "The candidate is recorded as a false match; risk assessment starts.", SCREENING_REASONS),
      option("REJECT", "Treat as potential true match", "The match stands; the case escalates to EDD.", SCREENING_REASONS),
      option("RETURN", "Return for more evidence", "Screening re-runs after more identifiers are collected.", SCREENING_REASONS),
    ],
  },
  {
    match: (key) => key.taskId === "task.decision_support" || key.gate === "decision.consequential",
    options: [
      option("APPROVE", "Approve onboarding", "With two distinct approvals the case is APPROVED and the run completes.", ONBOARDING_REASONS),
      option("REJECT", "Decline onboarding", "With two distinct rejections the case is DECLINED.", ONBOARDING_REASONS),
      option("RETURN", "Return to analyst", "The recommendation is withdrawn for rework.", ONBOARDING_REASONS),
    ],
  },
  {
    match: (key) => key.taskId === "task.identity_ownership",
    options: [
      option("APPROVE", "Accept ownership findings", "The ownership review is recorded and screening starts.", OWNERSHIP_REASONS),
      option("REJECT", "Reject ownership findings", "The findings are rejected; the case follows its rejection path.", OWNERSHIP_REASONS),
      option("RETURN", "Request further evidence", "A rework item goes back to the identity & ownership agent.", OWNERSHIP_REASONS),
    ],
  },
];

/** Options for a work item described by its task and gate; null → platform defaults. */
export function optionsFor(key: Key): DecisionOption[] | null {
  return TABLE.find((row) => row.match(key))?.options ?? null;
}

/** DomainModule.decisionOptions: the human-work item's constraints carry task and gate. */
export function decisionOptions(item: Schemas["HumanQueueItem"]): DecisionOption[] | null {
  const constraints = (item.workItem.constraints ?? {}) as Record<string, unknown>;
  return optionsFor({
    workType: item.workItem.workType,
    gate: typeof constraints.gate === "string" ? constraints.gate : null,
    taskId: typeof constraints.taskId === "string" ? constraints.taskId : null,
  });
}
