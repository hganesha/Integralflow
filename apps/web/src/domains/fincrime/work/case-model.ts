import type { Schemas } from "@ehf/ui-contracts";
import { casePath, lensPath } from "./paths";

/**
 * What the case screen derives from the projections it already reads: the open items an
 * analyst has to judge, the readiness line and the briefing. Pure, so it is easy to test.
 * Nothing here is stored and nothing is inferred beyond what a projection states (G11).
 */

type Room = Schemas["CaseRoom"];
type Ownership = Schemas["OwnershipView"];
type Screening = Schemas["ScreeningView"];
type Findings = Schemas["CaseFindingsView"];
export type RecordedFinding = Findings["items"][number];

/** The part of the case documents view the open-item list needs. */
export type DocumentsInput = {
  documents: ReadonlyArray<{ documentId: string; filename?: string | null; reviewPending: number; conflicts: number }>;
  requirements: ReadonlyArray<{ id: string; description?: string | null; anyOf: readonly string[]; satisfied: boolean }>;
};

/**
 * One projection as the case screen sees it. `not_started` means the stage that produces it
 * has not run; `unavailable` means the read failed. Neither is ever shown as "nothing found".
 */
export type Source<T> =
  | { state: "ready"; data: T; stale: boolean }
  | { state: "loading" }
  | { state: "not_started" }
  | { state: "unavailable"; reason: string };

export type Sources = { ownership: Source<Ownership>; screening: Source<Screening>; documents: Source<DocumentsInput>; findings: Source<Findings> };
export type SourceName = keyof Sources;

export const SOURCE_LABEL: Record<SourceName, string> = { ownership: "Ownership", screening: "Screening", documents: "Documents", findings: "Recorded findings" };

export type OpenItemKind = "conflict" | "review" | "missing";

export type OpenItem = {
  id: string;
  kind: OpenItemKind;
  source: SourceName;
  title: string;
  /** The person or entity the item is about, when the projection names one. */
  party: string | null;
  why: string;
  next: string;
  href: string;
  /**
   * `recorded`: a contradiction or finding the case store holds under a stable id, which can
   * carry a disposition. `derived`: read off a projection (a gap, a missing document); it has
   * no id of its own and nothing can be recorded against it.
   */
  origin: "recorded" | "derived";
  /** The stored id, for a recorded item. */
  findingId?: string;
  /** Severity as recorded on the finding, never inferred. */
  severity?: string | null;
};

export const KIND_TEXT: Record<OpenItemKind, { label: string; tone: "blocking" | "attention"; icon: "split" | "eye" | "file" }> = {
  conflict: { label: "Conflict", tone: "blocking", icon: "split" },
  review: { label: "Needs review", tone: "attention", icon: "eye" },
  missing: { label: "Missing", tone: "attention", icon: "file" },
};

/** Conflicting records first, then items waiting for review, then missing evidence. */
export const OPEN_ITEM_ORDER = "Conflicting records first, then items waiting for review, then missing evidence.";
const RANK: Record<OpenItemKind, number> = { conflict: 0, review: 1, missing: 2 };

/** "0.12" → "12%". Decimal strings stay exact; a missing value reads "Unknown". */
function share(decimal: string | null | undefined): string {
  if (decimal === null || decimal === undefined) return "Unknown";
  const value = Number(decimal) * 100;
  return Number.isFinite(value) ? `${Number(value.toFixed(4))}%` : "Unknown";
}

const words = (value: string): string => value.replace(/[_.]+/g, " ").trim();

function ownershipItems(caseId: string, view: Ownership): OpenItem[] {
  const label = new Map(view.nodes.map((node) => [node.id, node.label]));
  const name = (id: string) => label.get(id) ?? id;
  const seen = new Set<string>();
  const items: OpenItem[] = [];
  for (const edge of view.edges) {
    if (edge.status !== "conflict" || !edge.contradictionId || seen.has(edge.contradictionId)) continue;
    seen.add(edge.contradictionId);
    items.push({
      id: `contradiction:${edge.contradictionId}`,
      kind: "conflict",
      source: "ownership",
      origin: "derived",
      findingId: edge.contradictionId,
      title: `Sources disagree on ${name(edge.source)}'s interest in ${name(edge.target)}`,
      party: name(edge.source),
      why: edge.interestAlternative !== null ? `One source reports ${share(edge.interest)}, another ${share(edge.interestAlternative)}.` : "The sources report different values.",
      next: "Compare the sources",
      href: `${lensPath(caseId, "ownership")}?contradiction=${encodeURIComponent(edge.contradictionId)}`,
    });
  }
  for (const gap of view.gaps) {
    items.push({
      id: `gap:${gap.node}`,
      kind: "review",
      source: "ownership",
      origin: "derived",
      title: gap.reason,
      party: name(gap.node),
      why: `Path ${gap.path.map(name).join(" → ")} · interest ${share(gap.interest)}.`,
      next: "Review the ownership path",
      href: lensPath(caseId, "ownership"),
    });
  }
  return items;
}

function screeningItems(caseId: string, view: Screening): OpenItem[] {
  return view.findings
    .filter((finding) => finding.status === "open" && Boolean(finding.entryName) && finding.entryName !== "—")
    .map((finding) => ({
      id: `screening:${finding.findingId}`,
      kind: "review" as const,
      source: "screening" as const,
      origin: "derived" as const,
      findingId: finding.findingId,
      title: `Possible ${words(finding.listType)} match: ${finding.entryName}`,
      party: finding.subjectName,
      why: "A candidate was returned and needs a disposition. A candidate is not a confirmed match.",
      next: "Compare with the list entry",
      href: lensPath(caseId, "screening", finding.findingId),
    }));
}

function documentItems(caseId: string, view: DocumentsInput): OpenItem[] {
  const open = (documentId: string) => `${lensPath(caseId, "documents")}?document=${encodeURIComponent(documentId)}`;
  const items: OpenItem[] = [];
  for (const document of view.documents) {
    const title = document.filename ?? document.documentId;
    if (document.conflicts > 0) {
      items.push({ id: `document-conflict:${document.documentId}`, kind: "conflict", source: "documents", origin: "derived", title: `Conflicting values in ${title}`, party: null,
        why: `${document.conflicts} extracted ${document.conflicts === 1 ? "value conflicts" : "values conflict"} with another source.`, next: "Review the document", href: open(document.documentId) });
    }
    if (document.reviewPending > 0) {
      items.push({ id: `document-review:${document.documentId}`, kind: "review", source: "documents", origin: "derived", title: `Extracted values to check in ${title}`, party: null,
        why: `${document.reviewPending} extracted ${document.reviewPending === 1 ? "value is" : "values are"} unverified. An extracted value is an assertion until a person checks it.`, next: "Check against the source", href: open(document.documentId) });
    }
  }
  for (const requirement of view.requirements) {
    if (requirement.satisfied) continue;
    items.push({ id: `requirement:${requirement.id}`, kind: "missing", source: "documents", origin: "derived", title: `No document for: ${requirement.description ?? requirement.id}`, party: null,
      why: requirement.anyOf.length ? `Accepted: ${requirement.anyOf.map(words).join(", ")}.` : "No accepted document type is listed.", next: "Open documents", href: lensPath(caseId, "documents") });
  }
  return items;
}

function recordedItem(caseId: string, finding: RecordedFinding): OpenItem {
  const contradiction = finding.kind === "contradiction";
  const screening = finding.findingType === "SCREENING";
  return {
    id: `${contradiction ? "contradiction" : screening ? "screening" : "finding"}:${finding.findingId}`,
    kind: contradiction ? "conflict" : "review",
    source: "findings",
    origin: "recorded",
    findingId: finding.findingId,
    severity: finding.severity,
    title: finding.title,
    party: null,
    why: finding.severity ? `Recorded severity: ${words(finding.severity)}. Nothing has been recorded against it yet.` : "Recorded on the case. Nothing has been recorded against it yet.",
    next: contradiction ? "Compare the sources" : screening ? "Compare with the list entry" : "Review the finding",
    href: contradiction ? `${lensPath(caseId, "ownership")}?contradiction=${encodeURIComponent(finding.findingId)}` : screening ? lensPath(caseId, "screening", finding.findingId) : `${casePath(caseId, "findings")}?item=${encodeURIComponent(`finding:${finding.findingId}`)}`,
  };
}

/**
 * Every open item, in the disclosed order. The findings registry is the authority for
 * contradictions and findings: an item a view derives is tied to its stored id, dropped when
 * the registry says it is closed, and anything recorded that no view shows is still listed.
 */
export function openItems(caseId: string, sources: Sources): OpenItem[] {
  const derived = [
    ...(sources.ownership.state === "ready" ? ownershipItems(caseId, sources.ownership.data) : []),
    ...(sources.screening.state === "ready" ? screeningItems(caseId, sources.screening.data) : []),
    ...(sources.documents.state === "ready" ? documentItems(caseId, sources.documents.data) : []),
  ];
  const registry = new Map((sources.findings.state === "ready" ? sources.findings.data.items : []).map((finding) => [finding.findingId, finding]));
  const seen = new Set<string>();
  const items: OpenItem[] = [];
  for (const item of derived) {
    const finding = item.findingId ? registry.get(item.findingId) : undefined;
    if (!finding) { items.push(item); continue; }
    seen.add(finding.findingId);
    if (finding.state === "open") items.push({ ...item, origin: "recorded", severity: finding.severity });
  }
  for (const finding of registry.values()) if (finding.state === "open" && !seen.has(finding.findingId)) items.push(recordedItem(caseId, finding));
  return items.map((item, index) => ({ item, index })).sort((a, b) => RANK[a.item.kind] - RANK[b.item.kind] || a.index - b.index).map(({ item }) => item);
}

/** Recorded findings that are no longer open, most recently dispositioned first. */
export function closedFindings(sources: Sources): RecordedFinding[] {
  if (sources.findings.state !== "ready") return [];
  const last = (finding: RecordedFinding) => finding.dispositions.at(-1)?.at ?? finding.raisedAt;
  return sources.findings.data.items.filter((finding) => finding.state !== "open").sort((a, b) => last(b).localeCompare(last(a)));
}

export type SourceNotice = { source: SourceName; tone: "info" | "attention"; text: string };

/** What the list cannot show, said out loud: a failed or pending read is never an empty result. */
export function sourceNotices(sources: Sources): SourceNotice[] {
  const notices: SourceNotice[] = [];
  for (const source of Object.keys(SOURCE_LABEL) as SourceName[]) {
    const entry = sources[source];
    const label = SOURCE_LABEL[source];
    if (entry.state === "not_started") notices.push({ source, tone: "info", text: `${label} has not started on this case, so it has no items to list yet.` });
    else if (entry.state === "unavailable") notices.push({ source, tone: "attention", text: `${label} could not be loaded (${entry.reason}). Items from it may be missing here.` });
    else if (entry.state === "ready" && entry.stale) notices.push({ source, tone: "attention", text: `${label} shows the last loaded state; the latest refresh failed.` });
  }
  return notices;
}

export const isPendingStep = (item: Room["humanWork"][number]): boolean => item.workItem.status === "WAITING_HUMAN" || item.workItem.status === "HUMAN_REQUIRED";

const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

export type Readiness = { text: string; tone: "attention" | "neutral"; parts: string[] };

/**
 * The readiness line: what still needs attention, as concrete counts, never a percentage.
 * It does not count stages: a share of stages done reads like progress toward approval, which
 * it is not. The stage row shows each stage and its state instead.
 */
export function readiness(room: Pick<Room, "stages" | "humanWork">, items: readonly OpenItem[], sources: Sources): Readiness {
  const parts: string[] = [];
  const current = room.stages.find((stage) => stage.status !== "done" && stage.status !== "pending");
  if (current) parts.push(`${current.label}: ${words(current.status)}`);
  const waiting = room.humanWork.filter(isPendingStep).length;
  if (waiting) parts.push(`${plural(waiting, "step waits", "steps wait")} on a person`);
  if (items.length) parts.push(plural(items.length, "open item", "open items"));
  const unknown = (Object.keys(SOURCE_LABEL) as SourceName[]).filter((source) => sources[source].state === "unavailable" || sources[source].state === "loading");
  if (unknown.length) parts.push(`${unknown.map((source) => SOURCE_LABEL[source].toLowerCase()).join(" and ")} not loaded`);
  if (!parts.length) return { text: "Nothing is reported as waiting on this case", tone: "neutral", parts };
  return { text: parts.join(" · "), tone: "attention", parts };
}

export type BriefingLine = { label: "Case" | "Established" | "Unresolved" | "Next"; text: string; href?: string };

/**
 * The briefing: four plain statements assembled from the case room and the open items. It is
 * derived text, not generated text, and each line says only what a projection reports.
 */
export function briefing(room: Room, items: readonly OpenItem[], sources: Sources): BriefingLine[] {
  const lines: BriefingLine[] = [];
  const kind = room.subject.kind && room.subject.kind !== "Not recorded" ? `${words(room.subject.kind)}, ` : "";
  lines.push({ label: "Case", text: `${room.caseType} case for ${room.subject.name} (${kind}${room.jurisdiction}). The case is ${words(room.status).toLowerCase()}.` });

  const done = room.stages.filter((stage) => stage.status === "done").map((stage) => stage.label);
  const established = [
    done.length ? `${done.join(", ")} ${done.length === 1 ? "is" : "are"} complete` : room.stages.length ? "No stage is complete yet" : null,
    `${plural(room.counts.facts, "accepted fact", "accepted facts")} and ${plural(room.counts.evidence, "evidence item", "evidence items")} are on file`,
  ].filter(Boolean).join("; ");
  lines.push({ label: "Established", text: `${established}.`, href: casePath(room.caseId, "claims") });

  const notLoaded = (Object.keys(SOURCE_LABEL) as SourceName[]).filter((source) => sources[source].state === "unavailable");
  if (items.length) {
    const [first, second] = items;
    const named = [first!.title, second?.title].filter(Boolean).join("; ");
    const more = items.length > 2 ? `, and ${items.length - 2} more` : "";
    lines.push({ label: "Unresolved", text: `${plural(items.length, "open item", "open items")}: ${named}${more}.`, href: casePath(room.caseId, "findings") });
  } else if (notLoaded.length) {
    lines.push({ label: "Unresolved", text: `Unknown: ${notLoaded.map((source) => SOURCE_LABEL[source].toLowerCase()).join(" and ")} could not be loaded.`, href: casePath(room.caseId, "findings") });
  } else {
    lines.push({ label: "Unresolved", text: "The loaded projections report no open items. That is not a clearance: stages that have not run report nothing." });
  }

  const pending = room.humanWork.filter(isPendingStep);
  const current = room.stages.find((stage) => stage.status !== "done");
  if (pending.length) {
    const step = pending[0]!;
    const holder = step.assignedTo.length ? `claimed by ${step.assignedTo.join(", ")}` : "unclaimed";
    lines.push({ label: "Next", text: `A person is asked to: ${step.workItem.objective} (${holder}${pending.length > 1 ? `; ${pending.length - 1} more waiting` : ""}).` });
  } else if (current) {
    lines.push({ label: "Next", text: `No step is waiting on a person. The current stage is ${current.label}.` });
  } else {
    lines.push({ label: "Next", text: "No step is waiting on a person." });
  }
  return lines;
}

/** "agent.identity_ownership" → "Identity ownership agent". The id stays available as a tooltip. */
export function agentLabel(agentId: string): string {
  const bare = words(agentId.replace(/^agent\./, ""));
  return bare ? `${bare.charAt(0).toUpperCase()}${bare.slice(1)} agent` : agentId;
}

/** "service:case-api" → "Case service"; "agent.x" → agent label; people keep their id. */
export function actorLabel(actor: { principalId: string; type?: string }): string {
  if (actor.principalId.startsWith("agent.")) return agentLabel(actor.principalId);
  if (actor.principalId.startsWith("service:") || actor.type === "SERVICE") return "Platform service";
  return actor.principalId;
}
