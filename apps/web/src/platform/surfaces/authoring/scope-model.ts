import type { Schemas } from "@ehf/ui-contracts";
import { isRec, type Rec } from "./model";

/**
 * Process scope view model (customer type, trigger, due diligence, jurisdictions, products). Pure
 * functions over the contract: what a gate's pinned packs say, and the recommendation a scope
 * preview explains, grouped for the author.
 */

export type ProcessScope = Schemas["ProcessScope"];
export type ScopePreview = Schemas["ScopePreview"];
export type ScopeOptions = Schemas["ScopeOptions"];
export type CompositionDecision = Schemas["CompositionDecision"];
export type DueDiligence = NonNullable<ProcessScope["dueDiligence"]>;

export const CUSTOMER_TYPE_LABEL: Record<string, string> = { individual: "Individual", corporate: "Corporate", trust: "Trust" };
export const TRIGGER_LABEL: Record<string, string> = { onboarding: "Onboarding", periodic_review: "Periodic review", event_review: "Event-driven review" };
export const DUE_DILIGENCE_LABEL: Record<string, string> = { simplified: "Simplified (SDD)", standard: "Standard (CDD)", enhanced: "Enhanced (EDD)" };
export const PRODUCT_LABEL = (product: string) => product.replaceAll("_", " ");
/** "ownership_change" → "Ownership change". */
export const EVENT_LABEL = (event: string) => { const text = event.replaceAll("_", " "); return text[0]!.toUpperCase() + text.slice(1); };

type PinnedPack = { id?: unknown; scope?: { jurisdiction?: unknown; institution?: unknown; products?: unknown; customerTypes?: unknown } };
const packsOf = (node: Rec): PinnedPack[] => {
  const config = isRec(node.config) ? node.config : {};
  return Array.isArray(config.policyPacks) ? config.policyPacks.filter(isRec) as PinnedPack[] : [];
};

/** A policy gate whose pinned packs carry a process scope (a composed KYC/KYB process). */
export function isScopeGate(node: Rec): boolean {
  return node.kind === "gate" && packsOf(node).some((pack) => isRec(pack.scope));
}

/** What a gate's pinned packs say about the scope; the trigger is onboarding until a pack says otherwise. */
export function packScope(node: Rec): ProcessScope | null {
  const packs = packsOf(node).filter((pack) => isRec(pack.scope));
  if (!packs.length) return null;
  const customerTypes = [...new Set(packs.flatMap((pack) => Array.isArray(pack.scope!.customerTypes) ? pack.scope!.customerTypes.map(String) : []))];
  if (customerTypes.length !== 1 || !(customerTypes[0] === "individual" || customerTypes[0] === "corporate")) return null;
  const first = packs[0]!.scope!;
  return {
    customerType: customerTypes[0], trigger: "onboarding",
    jurisdictions: packs.map((pack) => String(pack.scope!.jurisdiction ?? "")).filter(Boolean),
    products: Array.isArray(first.products) ? first.products.map(String) : [],
    ...(typeof first.institution === "string" ? { institution: first.institution } : {}),
  };
}

export const dueDiligenceOf = (scope: ProcessScope): DueDiligence => scope.dueDiligence ?? "standard";

/** Two scopes ask for the same process (order of jurisdictions and products does not matter). */
export function sameScope(a: ProcessScope, b: ProcessScope): boolean {
  const set = (values: readonly string[]) => [...values].sort().join(",");
  return a.customerType === b.customerType && a.trigger === b.trigger && dueDiligenceOf(a) === dueDiligenceOf(b)
    && (a.event ?? "") === (b.event ?? "") && set(a.jurisdictions) === set(b.jurisdictions) && set(a.products) === set(b.products) && (a.institution ?? "") === (b.institution ?? "");
}

const show = (value: unknown): string => Array.isArray(value) ? value.map(show).join(", ") : value === undefined || value === null ? "" : String(value);

/** Why a decision was made, in one line: "pack screening_roles includes director (layer pack.product.lending)". */
export function basisText(basis: CompositionDecision["basis"]): string {
  const value = show(basis.value);
  if (basis.source === "pack") return `pack ${basis.field} includes ${value}${basis.layer ? ` (layer ${basis.layer})` : basis.packId ? ` (${basis.packId})` : ""}`;
  if (basis.source === "roster") return `agent roster ${basis.field}: ${value}`;
  return `scope ${basis.field}: ${value}`;
}

export type RecommendationItem = { id: string; label: string; change: "added" | "removed"; reason: string; basis: string | null };
export type RecommendationGroup = { key: "agents" | "skills" | "connectors" | "packs"; title: string; items: RecommendationItem[] };
const GROUPS: Array<{ key: RecommendationGroup["key"]; title: string; kind: CompositionDecision["kind"] }> = [
  { key: "agents", title: "Agents", kind: "agent" },
  { key: "skills", title: "Process steps", kind: "skill" },
  { key: "connectors", title: "Data acquisition", kind: "connector" },
  { key: "packs", title: "Policy packs", kind: "pack" },
];

/** The preview's additions and removals by kind, each with the decision that explains it. */
export function recommendation(preview: ScopePreview): RecommendationGroup[] {
  const names = new Map([...preview.changes.nodes.added, ...preview.changes.nodes.removed].map((node) => [node.id, node.name]));
  return GROUPS.map(({ key, title, kind }) => {
    const item = (id: string, change: RecommendationItem["change"]): RecommendationItem => {
      const decision = preview.decisions.find((entry) => entry.kind === kind && entry.id === id && entry.action === (change === "added" ? "include" : "exclude"))
        ?? preview.decisions.find((entry) => entry.kind === kind && entry.id === id);
      const fallback = change === "removed" ? (kind === "pack" ? "Replaced: the new scope pins a different pack." : "No longer part of the process for this scope.") : "Required by the new scope.";
      return { id, change, label: kind === "connector" ? names.get(id) ?? id : id, reason: decision?.reason ?? fallback, basis: decision ? basisText(decision.basis) : null };
    };
    const change = preview.changes[key];
    return { key, title, items: [...change.added.map((id) => item(id, "added")), ...change.removed.map((id) => item(id, "removed"))] };
  }).filter((group) => group.items.length > 0);
}

/** A one-line summary of a recommendation, for the apply confirmation. */
export function changeSummary(preview: ScopePreview): string {
  const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const { agents, skills, connectors, packs } = preview.changes;
  const parts = [
    agents.added.length || agents.removed.length ? `agents +${agents.added.length}/−${agents.removed.length}` : "",
    skills.added.length || skills.removed.length ? `steps +${skills.added.length}/−${skills.removed.length}` : "",
    connectors.added.length || connectors.removed.length ? `data sources +${connectors.added.length}/−${connectors.removed.length}` : "",
    packs.added.length ? count(packs.added.length, "pack") + " pinned" : "",
  ].filter(Boolean);
  return parts.join(" · ") || "no structural change";
}
