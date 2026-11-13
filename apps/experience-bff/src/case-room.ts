/**
 * What the case room derives from the tenant snapshot and the event log. Pure, so the rules
 * are testable. Nothing here is stored, and nothing is listed that the case does not record.
 */
import { CASE_STAGES, SUPPORTING_TASKS, type CaseStageDefinition } from '@ehf/fincrime-views';

type Row = Record<string, any>;

export type RoomStage = { taskId: string; label: string; agentId: string; status: 'done' | 'current' | 'pending' | 'blocked' | 'needs_review' | 'needs_evidence' };
export type RoomEvent = { sequence: number; commandType: string; summary: string; actor: unknown; occurredAt: string };

const sentence = (value: string): string => {
  const text = value.replace(/^(task|agent)\./, '').replace(/[._]+/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').trim().toLowerCase();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : value;
};

const STOPPED = new Set(['BLOCKED', 'FAILED', 'EXPIRED', 'SUSPENDED']);
const HUMAN = new Set(['HUMAN_REQUIRED', 'WAITING_HUMAN']);
const CLOSED = new Set(['COMPLETED', 'CANCELLED']);

function stageStatus(items: Row[]): RoomStage['status'] {
  const statuses = items.map(item => String(item.status));
  const outcomes = items.map(item => item.outcome?.status);
  if (statuses.some(status => STOPPED.has(status))) return 'blocked';
  if (statuses.some(status => HUMAN.has(status))) return 'needs_review';
  if (outcomes.includes('NEEDS_EVIDENCE')) return 'needs_evidence';
  if (outcomes.some(outcome => outcome === 'NEEDS_REVIEW' || outcome === 'PARTIAL')) return 'needs_review';
  if (statuses.every(status => CLOSED.has(status)) && statuses.includes('COMPLETED')) return 'done';
  return 'current';
}

/**
 * Stages in the domain's order (CASE_STAGES): each listed stage takes its status from the
 * case's work items for that task, and is `pending` when the case has none yet. A task with
 * work that is neither a stage nor a supporting task is appended, so nothing recorded is hidden.
 */
export function roomStages(workItems: Row[], agentTitle: (agentId: string) => string | undefined = () => undefined, order: readonly CaseStageDefinition[] = CASE_STAGES): RoomStage[] {
  const byTask = new Map<string, Row[]>();
  for (const item of workItems) {
    const taskId = item.constraints?.taskId;
    if (typeof taskId !== 'string' || !taskId) continue;
    byTask.set(taskId, [...(byTask.get(taskId) ?? []), item]);
  }
  const listed = new Set(order.map(stage => stage.taskId));
  const stages: RoomStage[] = order.map(stage => {
    const items = byTask.get(stage.taskId);
    return { taskId: stage.taskId, label: stage.label, agentId: stage.agentId, status: items ? stageStatus(items) : 'pending' };
  });
  for (const [taskId, items] of byTask) {
    if (listed.has(taskId) || SUPPORTING_TASKS.includes(taskId)) continue;
    const agentId = items.map(item => item.constraints?.agentId).find(value => typeof value === 'string' && value) ?? '';
    stages.push({ taskId, label: (agentId && agentTitle(agentId)) || sentence(taskId), agentId, status: stageStatus(items) });
  }
  return stages;
}

/** How many of the latest events the room carries. */
export const ROOM_EVENTS = 6;

/** The latest ledger events, newest first, in the room's row shape. */
export function roomEvents(events: Row[]): RoomEvent[] {
  return events
    .filter(event => Number.isInteger(event.caseSequence) && typeof event.eventType === 'string' && (event.occurredAt ?? event.recordedAt) && event.actor)
    .sort((a, b) => b.caseSequence - a.caseSequence)
    .slice(0, ROOM_EVENTS)
    .map(event => ({ sequence: event.caseSequence, commandType: event.eventType, summary: sentence(event.eventType), actor: event.actor, occurredAt: event.occurredAt ?? event.recordedAt }));
}

const STATEMENTS: ReadonlyArray<[table: string, key: string]> = [['claims', 'claim_id'], ['facts', 'fact_id'], ['assumptions', 'assumption_id'], ['contradictions', 'contradiction_id'], ['findings', 'finding_id']];

/**
 * Every evidence item registered on the case, with the statements that cite it and the case
 * document it holds, if any. Rows the snapshot cannot identify, date or attribute are left out
 * rather than filled in.
 */
export function caseEvidence(data: Row, documents: ReadonlyArray<{ documentId: string; evidenceId?: string | null }> = []) {
  const citedBy = new Map<string, string[]>();
  for (const [table, key] of STATEMENTS) {
    for (const row of (data[table] ?? []) as Row[]) {
      for (const ref of (row.evidence_refs ?? []) as unknown[]) {
        if (typeof ref !== 'string' || typeof row[key] !== 'string') continue;
        citedBy.set(ref, [...(citedBy.get(ref) ?? []), row[key]]);
      }
    }
  }
  const text = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);
  const instant = (value: unknown): string | null => {
    const date = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : null;
    return date && !Number.isNaN(date.getTime()) ? date.toISOString() : null;
  };
  return ((data.evidence ?? []) as Row[]).flatMap(row => {
    const evidenceId = text(row.evidence_id);
    const addedAt = instant(row.created_at);
    const retrievedAt = instant(row.source?.retrievedAt);
    const sourceType = text(row.source?.type);
    if (!evidenceId || !addedAt || !retrievedAt || !sourceType || !row.created_by) return [];
    return [{
      evidenceId, evidenceType: text(row.evidence_type) ?? 'Not recorded',
      source: { type: sourceType, dataset: text(row.source.dataset), datasetVersion: text(row.source.datasetVersion), capability: text(row.source.capability), retrievedAt, sourceEffectiveAt: instant(row.source.sourceEffectiveAt) },
      subjectRefs: ((row.subject_refs ?? []) as unknown[]).filter((ref): ref is string => typeof ref === 'string'),
      addedBy: row.created_by, addedAt,
      integrity: text(row.verification_status) ?? 'Not recorded', scanStatus: text(row.scan_status) ?? 'Not recorded', classification: text(row.classification) ?? 'Not recorded',
      documentId: documents.find(document => document.evidenceId === evidenceId)?.documentId ?? null,
      citedBy: citedBy.get(evidenceId) ?? [],
    }];
  });
}

const OPEN_CONTRADICTION = new Set(['OPEN', 'UNDER_INVESTIGATION']);

/**
 * The findings registry: every contradiction and finding the case store holds, under the id the
 * store gave it, with what has been recorded against it (reviews of it; a contradiction's
 * resolution). A projection only. Severity is what was recorded, never inferred, and a finding
 * is `dispositioned` only when a review of it exists.
 */
export function caseFindings(data: Row, canReview = false) {
  // Where a finding is dispositioned. Contradictions and screening findings have their own
  // accountable paths; this one is only for the findings that have none.
  const disposition = (kind: 'contradiction' | 'finding', state: string, findingType: string | null): { allowed: boolean; reason: string | null } => {
    if (kind === 'contradiction') return { allowed: false, reason: 'A contradiction is closed by resolving it where its sources are compared.' };
    if (state !== 'open') return { allowed: false, reason: 'This finding already has a disposition recorded.' };
    if (findingType === 'SCREENING') return { allowed: false, reason: 'A screening finding is dispositioned in the screening workspace, through its human step.' };
    if (!canReview) return { allowed: false, reason: 'Recording a disposition needs the reviewer role (case.review).' };
    return { allowed: true, reason: null };
  };
  const text = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);
  const instant = (value: unknown): string | null => {
    const date = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : null;
    return date && !Number.isNaN(date.getTime()) ? date.toISOString() : null;
  };
  const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []);
  const reviewsOf = (id: string) => ((data.reviews ?? []) as Row[]).flatMap(review => {
    const at = instant(review.created_at);
    const reviewId = text(review.review_id);
    if (review.object_ref !== id || !at || !reviewId) return [];
    return [{ id: reviewId, source: 'review' as const, outcome: text(review.outcome) ?? 'Not recorded', rationale: text(review.rationale), by: review.reviewer ?? null, at }];
  });
  const byTime = <T extends { at: string }>(rows: T[]) => rows.sort((a, b) => a.at.localeCompare(b.at));

  const contradictions = ((data.contradictions ?? []) as Row[]).flatMap(row => {
    const findingId = text(row.contradiction_id);
    const raisedAt = instant(row.created_at);
    const status = text(row.status);
    if (!findingId || !raisedAt || !status || !row.created_by) return [];
    const open = OPEN_CONTRADICTION.has(status);
    const resolvedAt = instant(row.updated_at);
    const resolution = !open && resolvedAt ? [{ id: `${findingId}:resolution`, source: 'resolution' as const, outcome: status, rationale: text(row.resolution?.rationale), by: null, at: resolvedAt }] : [];
    return [{
      findingId, kind: 'contradiction' as const, findingType: null, title: text(row.description) ?? 'Contradiction', subjectRefs: strings(row.object_refs),
      severity: text(row.materiality), state: open ? 'open' as const : 'resolved' as const, recordedStatus: status,
      evidenceIds: strings(row.evidence_refs), raisedBy: row.created_by, raisedAt, dispositions: byTime([...resolution, ...reviewsOf(findingId)]),
      disposition: disposition('contradiction', open ? 'open' : 'resolved', null),
    }];
  });
  const findings = ((data.findings ?? []) as Row[]).flatMap(row => {
    const findingId = text(row.finding_id);
    const raisedAt = instant(row.created_at);
    const status = text(row.status);
    if (!findingId || !raisedAt || !status || !row.created_by) return [];
    const dispositions = byTime(reviewsOf(findingId));
    const state = dispositions.length ? 'dispositioned' as const : status === 'ACTIVE' ? 'open' as const : 'resolved' as const;
    return [{
      findingId, kind: 'finding' as const, findingType: text(row.finding_type), title: text(row.reason) ?? 'Finding', subjectRefs: text(row.subject_ref) ? [row.subject_ref as string] : [],
      severity: text(row.policy_relevance), state, recordedStatus: status,
      evidenceIds: strings(row.evidence_refs), raisedBy: row.created_by, raisedAt, dispositions,
      disposition: disposition('finding', state, text(row.finding_type)),
    }];
  });
  return [...contradictions, ...findings];
}
