import type { Schemas } from "@ehf/ui-contracts";
import type { IconName } from "@ehf/ui-kit";

type Comparison = Schemas["DocumentRouteComparison"];
type Field = Schemas["DocumentRouteField"];
type Tone = "positive" | "attention" | "blocking" | "info" | "neutral";

/** Plain labels for the adjudicator's outcomes (document factory plan §6.2). Agreement is never shown as verification. */
export const OUTCOMES: Record<Field["outcome"], { label: string; tone: Tone; icon: IconName; detail: string }> = {
  AGREED_GROUNDED: { label: "Routes agree", tone: "positive", icon: "check", detail: "Both routes read the same value and cite it on the page. Agreement is not verification." },
  SELECTED_GROUNDED: { label: "One reading cited", tone: "attention", icon: "alert", detail: "The routes read different values; only one is cited on the page." },
  SINGLE_ROUTE: { label: "One route only", tone: "attention", icon: "alert", detail: "Only one route found a value it could cite." },
  UNGROUNDED: { label: "Not on the page", tone: "blocking", icon: "xcircle", detail: "No route's value appears in its cited text." },
  CONFLICT: { label: "Routes disagree", tone: "blocking", icon: "split", detail: "Both routes cite different values, or the values could not be compared." },
  VALIDATION_FAILED: { label: "Fails a date check", tone: "blocking", icon: "xcircle", detail: "The selected value fails a policy check, such as an issue date before birth." },
  NOT_PRESENT: { label: "Not found", tone: "neutral", icon: "minus", detail: "No route found a value." },
  OCR_DISAGREEMENT: { label: "Image and text differ", tone: "blocking", icon: "eye", detail: "A reading of the page image differs from the text routes." },
};

export const REVIEW_LABELS: Record<Field["review"], string> = { light: "Light review", standard: "Standard review", required: "Review required" };

export const ROUTE_STATUS: Record<Schemas["DocumentRouteStatus"]["status"], { label: string; tone: Tone; icon: IconName }> = {
  valid: { label: "Answer usable", tone: "neutral", icon: "check" },
  not_run: { label: "Did not run", tone: "attention", icon: "minus" },
  integrity_failure: { label: "Failed validation", tone: "blocking", icon: "xcircle" },
};

/** `accounts/0/closing_balance` → `accounts › row 1 › closing balance`. */
export function fieldLabel(path: string): string {
  return path.split("/").map(part => /^\d+$/.test(part) ? `row ${Number(part) + 1}` : part.replaceAll("_", " ")).join(" › ");
}

/** The fields to show: those needing review first (key fields before others), then everything else in contract order. */
export function visibleFields(comparison: Comparison, filter: "review" | "all"): Field[] {
  const fields = filter === "review" ? comparison.fields.filter(field => field.review === "required") : [...comparison.fields];
  const order = new Map(comparison.fields.map((field, index) => [field.path, index]));
  const rank = (field: Field) => (field.review === "required" ? 0 : 2) + (field.keyField ? 0 : 1);
  return fields.sort((a, b) => rank(a) - rank(b) || order.get(a.path)! - order.get(b.path)!);
}

/** The outcome counts as `label: n`, worst first. */
export function outcomeSummary(comparison: Comparison): Array<{ outcome: Field["outcome"]; label: string; count: number; tone: Tone }> {
  const severity: Record<Tone, number> = { blocking: 0, attention: 1, neutral: 2, info: 3, positive: 4 };
  return Object.entries(comparison.counts)
    .filter(([outcome, count]) => outcome in OUTCOMES && count > 0)
    .map(([outcome, count]) => ({ outcome: outcome as Field["outcome"], label: OUTCOMES[outcome as Field["outcome"]].label, count, tone: OUTCOMES[outcome as Field["outcome"]].tone }))
    .sort((a, b) => severity[a.tone] - severity[b.tone] || a.label.localeCompare(b.label));
}

/** Route order for columns: the proposed route first. */
export function routeOrder(comparison: Comparison): string[] {
  return [...comparison.routes.map(route => route.route)].sort((a, b) => (a === comparison.proposedRoute ? -1 : b === comparison.proposedRoute ? 1 : a.localeCompare(b)));
}
