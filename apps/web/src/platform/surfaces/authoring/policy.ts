import type { Schemas } from "@ehf/ui-contracts";
import { isRec } from "./model";

export type PolicyCompilation = Schemas["policyCompilation"];
export type PolicyEvaluation = Schemas["policyEvaluation"];

/**
 * A saved policy revision. The revisions response is untyped in the contract (GAP-044), so
 * the fields are read defensively; `authoredBy` (ui-specs §4.11) and `author` are both read.
 */
export type PolicyRevision = {
  revision: number;
  status: string;
  author: string | null;
  approvedBy: string | null;
  files: Record<string, string>;
  compilation: PolicyCompilation | null;
};

export function toRevisions(value: unknown): PolicyRevision[] {
  const list = isRec(value) && Array.isArray(value.revisions) ? value.revisions : [];
  return list.filter(isRec).filter((entry) => typeof entry.revision === "number").map((entry) => ({
    revision: entry.revision as number,
    status: String(entry.status ?? "DRAFT").toUpperCase(),
    author: typeof entry.authoredBy === "string" ? entry.authoredBy : typeof entry.author === "string" ? entry.author : null,
    approvedBy: typeof entry.approvedBy === "string" ? entry.approvedBy : null,
    files: isRec(entry.files) ? Object.fromEntries(Object.entries(entry.files).filter(([, content]) => typeof content === "string")) as Record<string, string> : {},
    compilation: isRec(entry.compilation) && isRec(entry.compilation.manifest) ? entry.compilation as unknown as PolicyCompilation
      : isRec(entry.compiledBundle) ? {manifest:entry.compiledBundle,files:{},productionEligible:Array.isArray(entry.releaseBlockers)&&entry.releaseBlockers.length===0,
          releaseBlockers:Array.isArray(entry.releaseBlockers)?entry.releaseBlockers:[]} as unknown as PolicyCompilation : null,
  }));
}

/** File browser groups (ui-specs §4.11). */
export function fileGroup(path: string): "Policy" | "Decision tables" | "Registries" | "Evaluation corpus" {
  if (path === "policy.yaml") return "Policy";
  if (path.startsWith("catalog/decision-tables/")) return "Decision tables";
  if (path.startsWith("catalog/")) return "Registries";
  return "Evaluation corpus";
}

/** Policy Studio tabs: policy-owner views first, engineering views behind Advanced. */
export const POLICY_TABS = ["business", "products", "explorer", "packs", "rules", "requirements", "approvals", "monitoring", "versions", "advanced"] as const;
export type PolicyTab = (typeof POLICY_TABS)[number];
export const ADVANCED_SECTIONS = ["source", "tests", "bundle", "sources"] as const;
export type AdvancedSection = (typeof ADVANCED_SECTIONS)[number];
export type RulesView = "list" | "flow";

/** Tabs from before the redesign keep working as links. */
const LEGACY_TABS: Record<string, { tab: PolicyTab; section?: AdvancedSection; view?: RulesView }> = {
  composer: { tab: "advanced", section: "source" },
  library: { tab: "advanced", section: "source" },
  tests: { tab: "advanced", section: "tests" },
  bundle: { tab: "advanced", section: "bundle" },
  sources: { tab: "advanced", section: "sources" },
  tree: { tab: "rules", view: "flow" },
  activity: { tab: "versions" },
};

export function resolveStudioTab(tab: string | undefined, section: string | undefined, view: string | undefined): { tab: PolicyTab; section: AdvancedSection; view: RulesView } {
  const legacy = tab ? LEGACY_TABS[tab] : undefined;
  const resolved: PolicyTab = legacy?.tab ?? ((POLICY_TABS as readonly string[]).includes(tab ?? "") ? tab as PolicyTab : "rules");
  const chosenSection = legacy?.section ?? ((ADVANCED_SECTIONS as readonly string[]).includes(section ?? "") ? section as AdvancedSection : "source");
  return { tab: resolved, section: chosenSection, view: legacy?.view ?? (view === "flow" ? "flow" : "list") };
}

/** File groups shown by each Advanced section. */
export const SECTION_GROUPS: Partial<Record<AdvancedSection, ReadonlyArray<ReturnType<typeof fileGroup>>>> = {
  source: ["Policy", "Decision tables", "Registries", "Evaluation corpus"],
  tests: ["Evaluation corpus"],
};
