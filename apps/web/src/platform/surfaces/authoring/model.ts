import type { Schemas } from "@ehf/ui-contracts";
import { ApiError } from "@ehf/ui-client";
import type { Diagnostic, LifecycleStage } from "@ehf/ui-kit";

/**
 * Authoring view model helpers (ui-specs §4.2–4.10, BUILD-SPEC v2 §10 PLT-02…04). Pure
 * functions only: everything here derives from contract fields, nothing is invented (N3).
 */

export type Draft = Schemas["AuthoringDraftView"];
export type DraftEvent = Schemas["AuthoringEvent"];
export type ContextSelector = Schemas["contextSelector"];
export type ClassificationPolicy = Schemas["contextClassificationPolicy"];
export type CommandType = Schemas["businessCommandType"];
export type Rec = Record<string, unknown>;

export const TABS = ["workflow", "agents", "sources", "capabilities", "models", "integrations", "release"] as const;
export type TabId = (typeof TABS)[number];

export const COMMAND_TYPES: readonly CommandType[] = [
  "AddSubject", "LinkEvidence", "ProposeClaim", "AcceptClaimAsFact", "RecordScreeningFinding", "RecordAssumption", "RaiseContradiction",
  "ResolveContradiction", "ProposeWorkItem", "CompleteWorkItem", "LinkExecution", "SubmitDecisionRecommendation", "RecordGateResult",
  "RecordPolicyEvaluation", "RecordQAResult", "RecordReview", "RequestHumanReview", "TransitionCaseStatus", "FinalizeDisposition",
  "RecordCanonicalRecords", "RecordFinancialCrimeOutcome",
];

export const isRec = (value: unknown): value is Rec => typeof value === "object" && value !== null && !Array.isArray(value);
export function draftTitle(draft: Draft): string {
  const metadata = draft.parsedWorkflow.metadata;
  const title = isRec(metadata) && typeof metadata.title === "string" && metadata.title.trim() ? metadata.title : draft.name;
  // Align untouched drafts created from the previous blank template with the current copy.
  return draft.revision === 1 && draft.status === "DRAFT" && draft.name === "new-domain-harness" && title === "New domain harness" ? "New process" : title;
}
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const asString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

// ---- Lifecycle and separation of duties --------------------------------------------------

/** Event types whose actors may not approve or publish the draft (ui-specs §1.6). */
const AUTHOR_EVENTS = new Set(["draft.created", "draft.updated", "draft.compiled"]);

export function authorsOf(draft: Draft): Set<string> {
  return new Set((draft.events ?? []).filter((event) => AUTHOR_EVENTS.has(event.eventType)).map((event) => event.actor));
}

export type Gate = { allowed: boolean; reason?: string };

export const SEPARATION_COPY = "Needs a different approver (separation of duties)";

/** Approve/publish: needs the action and must not be an author (PLT-03 delta 7). */
export function approvalGate(draft: Draft, subjectId: string, actions: readonly string[], action: "draft.approve" | "draft.publish"): Gate {
  if (authorsOf(draft).has(subjectId)) return { allowed: false, reason: `${SEPARATION_COPY}: you edited or compiled this draft.` };
  if (!actions.includes(action)) return { allowed: false, reason: `${SEPARATION_COPY}: your role does not hold ${action}.` };
  return { allowed: true };
}

const STAGE_EVENT: Record<string, LifecycleStage> = {
  "draft.compiled": "COMPILED", "draft.evaluated": "EVALUATED", "draft.approved": "APPROVED", "draft.published": "PUBLISHED",
};

/** Who reached each lifecycle stage, newest event per stage since the last edit. */
export function lifecycleEvents(draft: Draft): Array<{ stage: LifecycleStage; actor: string; at: string }> {
  const out: Array<{ stage: LifecycleStage; actor: string; at: string }> = [];
  for (const event of draft.events ?? []) {
    if (event.eventType === "draft.updated" || event.eventType === "draft.created") {
      if (!out.some((entry) => entry.stage === "DRAFT")) out.push({ stage: "DRAFT", actor: event.actor, at: event.occurredAt });
      break;
    }
    const stage = STAGE_EVENT[event.eventType];
    if (stage && !out.some((entry) => entry.stage === stage)) out.push({ stage, actor: event.actor, at: event.occurredAt });
  }
  return out;
}

export function errorCount(diagnostics: readonly { severity: string }[]): number {
  return diagnostics.filter((entry) => entry.severity === "error").length;
}

export function toDiagnostics(value: unknown): Diagnostic[] {
  return asArray(value).filter(isRec).map((entry) => ({
    code: String(entry.code ?? "unknown"),
    severity: entry.severity === "warning" || entry.severity === "info" ? entry.severity : "error",
    path: String(entry.path ?? ""),
    message: String(entry.message ?? ""),
  }));
}

/** Diagnostics carried by a 422 (compile, evaluate, orchestration-nodes; delta 5). */
export function errorDiagnostics(error: ApiError | null): Diagnostic[] {
  return error ? toDiagnostics(error.body.details?.diagnostics) : [];
}

// ---- Workflow graph (ui-specs §4.3.1, §4.4) -----------------------------------------------

export type WorkflowNode = Rec & { id: string; name?: string; kind?: string };
export type WorkflowEdge = { id: string; from: string; to: string; label: string };

export type GraphNode = {
  id: string;
  label: string;
  description: string;
  kind: string;
  category: string;
  caseWrites: number;
  position: { x: number; y: number } | null;
  raw: WorkflowNode;
};

export const CATEGORY_ORDER = ["Input", "Groups", "Subgraphs", "Orchestration", "Intelligence", "Capabilities", "Policy gates", "Human review", "Output"] as const;

/** Agent ownership on a tool authorizes its call; it does not make the tool an agent loop. */
export function nodeDisplayKind(node: Rec): string {
  const kind = asString(node.kind) ?? asString(node.primitive) ?? "transform";
  const config = isRec(node.config) ? node.config : {};
  if (kind === "tool") return typeof config.skillId === "string" && config.skillId.trim() ? "skill" : "capability";
  // Registered agents attached in the authoring UI use the legacy evaluate kind.
  const agentRef = asString(config.agentRef) ?? asString(node.agentRef);
  if (kind === "evaluate" && agentRef?.trim()) return "agent";
  return kind;
}

export function nodeCategory(node: Rec): string {
  const kind = nodeDisplayKind(node);
  if (kind === "agent" || kind === "model") return "Intelligence";
  if (kind === "input") return "Input";
  if (kind === "output") return "Output";
  if (kind === "capability" || kind === "skill") return "Capabilities";
  if (kind === "condition" || kind === "evaluate" || kind === "gate") return "Policy gates";
  if (kind === "approval") return "Human review";
  if (kind === "group") return "Groups";
  if (kind === "subgraph") return "Subgraphs";
  return "Orchestration";
}

export function workflowNodes(draft: Draft): WorkflowNode[] {
  const spec = isRec(draft.parsedWorkflow.spec) ? draft.parsedWorkflow.spec : {};
  return asArray(spec.nodes).filter(isRec).filter((node): node is WorkflowNode => typeof node.id === "string");
}

export function workflowEdges(draft: Draft): WorkflowEdge[] {
  const spec = isRec(draft.parsedWorkflow.spec) ? draft.parsedWorkflow.spec : {};
  return asArray(spec.edges).filter(isRec).map((edge, index) => ({
    id: asString(edge.id) ?? `edge-${index}`,
    from: String(edge.from ?? ""),
    to: String(edge.to ?? ""),
    label: asString(edge.outcome) ?? asString(edge.condition) ?? asString(edge.kind) ?? "data",
  }));
}

export function caseWritesOf(node: Rec): Rec[] {
  const config = isRec(node.config) ? node.config : {};
  return asArray(config.caseWrites).filter(isRec);
}

function savedPosition(node: Rec): { x: number; y: number } | null {
  const config = isRec(node.config) ? node.config : {};
  const ui = isRec(config.ui) ? config.ui : {};
  const position = isRec(ui.position) ? ui.position : null;
  return position && Number.isFinite(position.x) && Number.isFinite(position.y) ? { x: Number(position.x), y: Number(position.y) } : null;
}

export function graphNodes(draft: Draft): GraphNode[] {
  return workflowNodes(draft).map((node) => ({
    id: node.id,
    label: asString(node.name) ?? node.id,
    description: asString(isRec(node.config) && isRec(node.config.ui) ? node.config.ui.description : undefined) ?? asString(node.summary) ?? "",
    kind: asString(node.kind) ?? "transform",
    category: nodeCategory(node),
    caseWrites: caseWritesOf(node).length,
    position: savedPosition(node),
    raw: node,
  }));
}

/** Saved position, else Kahn rank layout: x = 48 + rank·300, y = 60 + row·160 (§4.4). */
export function layout(nodes: readonly GraphNode[], edges: readonly WorkflowEdge[]): Map<string, { x: number; y: number }> {
  const indegree = new Map(nodes.map((node) => [node.id, 0]));
  for (const edge of edges) if (indegree.has(edge.to) && indegree.has(edge.from)) indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
  const rank = new Map<string, number>();
  const queue = nodes.filter((node) => indegree.get(node.id) === 0).map((node) => node.id);
  for (const id of queue) rank.set(id, 0);
  while (queue.length) {
    const id = queue.shift()!;
    for (const edge of edges.filter((entry) => entry.from === id)) {
      if (!indegree.has(edge.to)) continue;
      rank.set(edge.to, Math.max(rank.get(edge.to) ?? 0, (rank.get(id) ?? 0) + 1));
      indegree.set(edge.to, (indegree.get(edge.to) ?? 1) - 1);
      if (indegree.get(edge.to) === 0) queue.push(edge.to);
    }
  }
  const rows = new Map<number, number>();
  const out = new Map<string, { x: number; y: number }>();
  for (const node of nodes) {
    if (node.position) {
      out.set(node.id, node.position);
      continue;
    }
    const r = rank.get(node.id) ?? 0;
    const row = rows.get(r) ?? 0;
    rows.set(r, row + 1);
    out.set(node.id, { x: 48 + r * 300, y: 60 + row * 160 });
  }
  return out;
}

// ---- Package documents ------------------------------------------------------------------

export function selectorsOf(draft: Draft): ContextSelector[] {
  return asArray(draft.parsedPackage.contextSelectors).filter(isRec) as unknown as ContextSelector[];
}

export function classificationPoliciesOf(draft: Draft): ClassificationPolicy[] {
  return asArray(draft.parsedPackage.contextClassificationPolicies).filter(isRec) as unknown as ClassificationPolicy[];
}

export function integrationsOf(draft: Draft): Rec {
  return isRec(draft.parsedPackage.integrations) ? draft.parsedPackage.integrations : { triggers: [], humanActions: [], publications: [] };
}

// ---- Source location (PLT-03 AC5) -------------------------------------------------------

/** Which editor a diagnostic path belongs to: `package.…` or `workflow.…`. */
export function sourceOfPath(path: string): "package" | "workflow" {
  return path.startsWith("package") ? "package" : "workflow";
}

/**
 * Line (0-based) in `source` that best matches a dotted diagnostic path such as
 * `workflow.spec.nodes.3.id`. Resolves the value at the path in the parsed document and
 * finds the line declaring it; falls back to the deepest key name found in the text.
 */
export function lineForPath(source: string, parsed: unknown, path: string): number {
  const lines = source.split("\n");
  const segments = path.split(".").slice(1);
  let value: unknown = parsed;
  for (const segment of segments) {
    if (Array.isArray(value)) value = value[Number(segment)];
    else if (isRec(value)) value = value[segment];
    else {
      value = undefined;
      break;
    }
  }
  const keys = segments.filter((segment) => !/^\d+$/.test(segment));
  const key = keys[keys.length - 1];
  if (key && (typeof value === "string" || typeof value === "number")) {
    const text = String(value);
    const hit = lines.findIndex((line) => new RegExp(`["']?${escape(key)}["']?\\s*:\\s*["']?${escape(text)}["']?`).test(line));
    if (hit >= 0) return hit;
    const loose = lines.findIndex((line) => line.includes(text));
    if (loose >= 0) return loose;
  }
  for (const name of [...keys].reverse()) {
    const hit = lines.findIndex((line) => new RegExp(`["']?${escape(name)}["']?\\s*:`).test(line));
    if (hit >= 0) return hit;
  }
  return 0;
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Character offsets of a line, for selecting it in a textarea. */
export function lineRange(source: string, line: number): [number, number] {
  const lines = source.split("\n");
  const start = lines.slice(0, line).reduce((sum, entry) => sum + entry.length + 1, 0);
  return [start, start + (lines[line]?.length ?? 0)];
}

export function parseJsonObject(text: string): Rec | null {
  try {
    const value = JSON.parse(text);
    return isRec(value) ? value : null;
  } catch {
    return null;
  }
}

/** Concrete app paths (route params are not typed in the dynamic route tree). */
export const draftPath = (draftId: string): string => `/studio/drafts/${encodeURIComponent(draftId)}`;
export const policiesPath = (draftId: string): string => `${draftPath(draftId)}/policies`;
export const planPath = (digest: string): string => `/platform/plans/${encodeURIComponent(digest)}`;

export const pretty = (value: unknown) => JSON.stringify(value, null, 2);

/** Revision info from a 409 conflict message ("rev 3 → 4") or the refreshed draft. */
export function isConflict(error: ApiError | null): boolean {
  return error?.reason === "authoring.revision_conflict_or_published";
}
