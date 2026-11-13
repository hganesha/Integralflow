/** Typed cross-links inside the KYC Workspace (BUILD-SPEC v2 §8.3, §8.4). */
export type CaseSection = "overview" | "findings" | "evidence" | "claims" | "work" | "decisions" | "history" | "activity";
export type CaseLens = "ownership" | "documents" | "screening" | "risk" | "edd" | "aml" | "qa";

/** Sections of the case room. Overview is the landing; the others keep their URLs. */
export const CASE_SECTIONS: ReadonlyArray<{ id: CaseSection; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "findings", label: "Findings" },
  { id: "evidence", label: "Evidence" },
  { id: "claims", label: "Claims" },
  { id: "work", label: "Work items" },
  { id: "decisions", label: "Decisions recorded" },
  { id: "history", label: "History" },
  { id: "activity", label: "Activity" },
];

const enc = encodeURIComponent;

export const workspacePath: string = "/work";
export const casePath = (caseId: string, section?: CaseSection): string => `/work/cases/${enc(caseId)}${section && section !== "overview" ? `/${section}` : ""}`;
export const lensPath = (caseId: string, lens: CaseLens, finding?: string): string => `/work/cases/${enc(caseId)}/lens/${lens}${finding ? `?finding=${enc(finding)}` : ""}`;
export const decisionPath = (caseId: string): string => `/work/decisions/${enc(caseId)}`;
export const lineagePath = (caseId: string): string => `/assurance/lineage/${enc(caseId)}`;
export const recorderPath = (caseId: string, entry?: string): string => `/assurance/recorder/${enc(caseId)}${entry ? `?entry=${enc(entry)}` : ""}`;
export const runPath = (runId: string): string => `/platform/runs/${enc(runId)}`;

/**
 * Where an attention item opens. `AttentionItem.route` is a plain string; the fixtures carry
 * the v1 scheme `/cases/{id}/{lens}` (GAP-070), so it is mapped onto the v2 route table.
 * Anything unrecognised opens the case room.
 */
export function workRoute(item: { route: string; caseId: string }): string {
  const route = item.route.split("#")[0]!;
  if (route.startsWith("/work/")) return route;
  const match = /^\/cases\/([^/?]+)(?:\/([a-z]+))?/.exec(route);
  const caseId = match ? decodeURIComponent(match[1]!) : item.caseId;
  const leaf = match?.[2];
  if (leaf === "decision") return decisionPath(caseId);
  if (leaf === "ownership" || leaf === "documents" || leaf === "screening" || leaf === "risk" || leaf === "edd" || leaf === "aml" || leaf === "qa") return lensPath(caseId, leaf);
  return casePath(caseId);
}
