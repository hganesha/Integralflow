import type { Schemas } from "@ehf/ui-contracts";

/**
 * A new case's scope (who, why, how much due diligence, where, for which products) and the released
 * process and policy pack the catalogue selects for it. Pure functions over the contract; the form
 * lives in cases.tsx.
 */

export type CaseScope = Schemas["CaseScope"];
export type CasePlanSelection = Schemas["CasePlanSelection"];
export type ScopeOptions = Schemas["ScopeOptions"];
type CustomerType = CaseScope["customerType"];
type DueDiligence = NonNullable<CaseScope["dueDiligence"]>;

/** What the form holds; `event` and `jurisdiction` are "" until chosen. */
export type CaseScopeForm = { customerType: CustomerType; trigger: CaseScope["trigger"]; event: string; dueDiligence: DueDiligence; jurisdiction: string; products: string[] };

export const CUSTOMER_TYPE_LABEL: Record<string, string> = { individual: "Individual", corporate: "Business (corporate)", trust: "Trust" };
export const TRIGGER_LABEL: Record<string, string> = { onboarding: "Onboarding", periodic_review: "Periodic review", event_review: "Event-driven review" };
export const DUE_DILIGENCE_LABEL: Record<string, string> = { simplified: "Simplified (SDD)", standard: "Standard (CDD)", enhanced: "Enhanced (EDD)" };
export const PRODUCT_LABEL = (product: string) => product.replaceAll("_", " ");
/** "ownership_change" → "Ownership change". */
export const EVENT_LABEL = (event: string) => { const text = event.replaceAll("_", " "); return text[0]!.toUpperCase() + text.slice(1); };
const PLURAL: Record<string, string> = { individual: "individuals", corporate: "businesses", trust: "trusts" };

export function initialForm(options: ScopeOptions): CaseScopeForm {
  const customerType = options.customerTypes.find((item) => item.available)?.value ?? "individual";
  const trigger = options.triggers.find((item) => item.available)?.value ?? "onboarding";
  return { customerType, trigger, event: "", dueDiligence: "standard", jurisdiction: "", products: [] };
}

/** A due-diligence level the customer type can use; otherwise why not ("Not for trusts"). */
export function dueDiligenceIneligibility(level: ScopeOptions["dueDiligence"][number], customerType: string): string | null {
  if (!level.available) return "Not available yet";
  return level.customerTypes.includes(customerType as CustomerType) ? null : `Not for ${PLURAL[customerType] ?? customerType}`;
}

/** Apply a change, then drop what no longer applies: an ineligible level falls back to standard, an event to none. */
export function updateForm(form: CaseScopeForm, patch: Partial<CaseScopeForm>, options: ScopeOptions): CaseScopeForm {
  const next = { ...form, ...patch };
  const level = options.dueDiligence.find((item) => item.value === next.dueDiligence);
  if (level && dueDiligenceIneligibility(level, next.customerType)) next.dueDiligence = "standard";
  if (next.trigger !== "event_review" || !options.events.some((item) => item.value === next.event && item.customerTypes.includes(next.customerType))) next.event = "";
  return next;
}

/** What the form still needs before a selection can be asked for, or null when it is complete. */
export function missing(form: CaseScopeForm): string | null {
  if (form.trigger === "event_review" && !form.event) return "Choose the event that triggers the review.";
  if (!form.jurisdiction) return "Choose the policy jurisdiction.";
  if (!form.products.length) return "Choose at least one product.";
  return null;
}

/** The scope a complete form asks for: an event only for an event review, products sorted. */
export function scopeOf(form: CaseScopeForm): CaseScope | null {
  if (missing(form)) return null;
  return {
    customerType: form.customerType, trigger: form.trigger, dueDiligence: form.dueDiligence, jurisdiction: form.jurisdiction,
    products: [...new Set(form.products)].sort(),
    ...(form.trigger === "event_review" && form.event ? { event: form.event as NonNullable<CaseScope["event"]> } : {}),
  };
}

/** The process a selection names, as the composer titles it: "Agentic KYB (EDD): business onboarding". */
export function processTitle(scope: CasePlanSelection["scope"]): string {
  const individual = scope.customerType === "individual";
  const level = { simplified: "SDD", standard: "", enhanced: "EDD" }[scope.dueDiligence];
  const what = scope.trigger === "onboarding" ? "onboarding" : scope.trigger === "periodic_review" ? "periodic review" : `${String(scope.event ?? "event").replaceAll("_", " ")} review`;
  return `Agentic ${individual ? "KYC" : "KYB"}${level ? ` (${level})` : ""}: ${individual ? "individual" : scope.customerType === "trust" ? "trust" : "business"} ${what}`;
}

/** One line for a selection: the process and the pack the case is pinned to. */
export const selectionSummary = (selection: CasePlanSelection) => `${processTitle(selection.scope)} · ${selection.pack.id}`;

/** A refused selection in the creator's terms: what happened and what to do. */
export function refusalCopy(reason: string): { title: string; remedy: string } {
  switch (reason) {
    case "case.plan_no_plan": return { title: "No released process for this case", remedy: "Choose another trigger or due-diligence level, or ask a process author to release a process for this scope." };
    case "case.plan_no_pack": return { title: "No policy pack covers this case", remedy: "Choose a jurisdiction and products a released process pins a pack for, or ask a policy author to release one." };
    case "case.plan_ambiguous_plan": return { title: "More than one released process covers this case", remedy: "Nothing is chosen by default. Ask a release manager to retire one of the processes." };
    case "case.plan_ambiguous_pack": return { title: "More than one policy pack covers this case", remedy: "Nothing is chosen by default. Ask a policy author to narrow the packs' product sets." };
    case "case.plan_context_incomplete": return { title: "The case scope is incomplete", remedy: "Choose a customer type, trigger, jurisdiction and at least one product." };
    case "case.plan_selection_changed": return { title: "The released process for this scope changed", remedy: "Review the new selection, then create the case again." };
    default: return { title: "The case cannot be opened for this scope", remedy: "Change the scope, or try again." };
  }
}
