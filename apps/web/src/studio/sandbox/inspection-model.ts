import type { Schemas } from "@ehf/ui-contracts";
import type { Execution } from "../../platform/surfaces/runs/execution-model";
import type { RuntimeEvent } from "../../platform/surfaces/runs/use-run-events";

export const inspectorTabs = [
  { value: "overview", label: "Overview" },
  { value: "context", label: "Context" },
  { value: "documents", label: "Documents & Extractions" },
  { value: "skills", label: "Skills" },
  { value: "capabilities", label: "Capabilities" },
  { value: "policy", label: "Policy & Effects" },
  { value: "attempts", label: "Attempts" },
] as const;

export type InspectorTab = (typeof inspectorTabs)[number]["value"];
export type StepScope = { nodeId: string; attempt: number; epoch?: number };
export type PolicyDecision = Schemas["SandboxPolicyDecision"];

export const readable = (value: string) => value.toLowerCase().replaceAll("_", " ");

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function wholeNumber(value: unknown) {
  if (typeof value !== "number" && (typeof value !== "string" || !/^\d+$/.test(value))) return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : undefined;
}

export function attemptAt(execution: Execution, nodeId: string, occurredAt: string) {
  return execution.attempts.filter(item =>
    item.nodeId === nodeId && item.startedAt && Date.parse(item.startedAt) <= Date.parse(occurredAt))
    .sort((a, b) => b.attempt - a.attempt || b.fencingEpoch - a.fencingEpoch)[0];
}

export function eventScope(event: RuntimeEvent, execution: Execution) {
  if (!event.nodeId) return null;
  const recorded = object(event.values.correlation);
  if (typeof recorded?.attempt === "number" && typeof recorded?.fencingEpoch === "number") {
    return { nodeId: event.nodeId, attempt: recorded.attempt, epoch: recorded.fencingEpoch, inferred: false };
  }
  const attempt = attemptAt(execution, event.nodeId, event.occurredAt);
  return attempt ? { nodeId: event.nodeId, attempt: attempt.attempt, epoch: attempt.fencingEpoch, inferred: true } : null;
}

export function scopedEvents(events: readonly RuntimeEvent[], execution: Execution, scope: StepScope | null) {
  if (!scope) return events;
  return events.filter(event => {
    const observed = eventScope(event, execution);
    return observed?.nodeId === scope.nodeId && observed.attempt === scope.attempt
      && (scope.epoch === undefined || observed.epoch === scope.epoch);
  });
}

export function eventTab(event: RuntimeEvent): InspectorTab {
  if (event.code.startsWith("context.")) return "context";
  if (event.code.startsWith("skill.") || event.code.startsWith("agent.task.")) return "skills";
  if (event.code.startsWith("agent.step.") || event.code.startsWith("capability.")) return "capabilities";
  if (event.code.startsWith("policy.") || event.code.startsWith("case.write.")) return "policy";
  return "attempts";
}

export type TaskCriterion = { nodeId: string; passed: boolean; observed: string; missingFields: string[] };

export function taskCriteria(event: RuntimeEvent): TaskCriterion[] {
  const criteria = event.values.criteria;
  if (!Array.isArray(criteria)) return [];
  return criteria.flatMap(value => {
    const item = object(value);
    if (typeof item?.nodeId !== "string" || typeof item.passed !== "boolean") return [];
    return [{
      nodeId: item.nodeId, passed: item.passed, observed: typeof item.observed === "string" ? item.observed : "Unknown",
      missingFields: Array.isArray(item.missingFields) ? item.missingFields.filter((field): field is string => typeof field === "string") : [],
    }];
  });
}

/** Surface recorded task outcomes before this decision, without treating later events as its inputs. */
export function incompleteTasks(decision: PolicyDecision, events: readonly RuntimeEvent[]) {
  if (!decision.reasonCodes.includes("AGENT_TASK_INCOMPLETE")) return [];
  const latest = new Map<string, RuntimeEvent>();
  for (const event of events) {
    if (event.nodeId && event.code.startsWith("agent.task.") && Date.parse(event.occurredAt) <= Date.parse(decision.evaluatedAt)) {
      latest.set(event.nodeId, event);
    }
  }
  return [...latest.values()].filter(event => !["agent.task.completed", "agent.task.needs_review"].includes(event.code));
}

export function relatedTask(scope: StepScope, events: readonly RuntimeEvent[], execution: Execution) {
  return events.findLast(event => {
    if (!event.code.startsWith("agent.task.") || !taskCriteria(event).some(criterion => criterion.nodeId === scope.nodeId && !criterion.passed)) return false;
    const observed = attemptAt(execution, scope.nodeId, event.occurredAt);
    return observed?.attempt === scope.attempt && (scope.epoch === undefined || observed.fencingEpoch === scope.epoch);
  });
}

export function humanLabel(value: string) {
  const label = value
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[._/-]+/g, " ").replace(/\b(kyc|kyb|cdd|edd|ubo|pep|ocr)\b/gi, acronym => acronym.toUpperCase()).trim();
  return label ? label[0]!.toUpperCase() + label.slice(1) : "Unavailable";
}

export function policyLabel(id: string) {
  const [, , jurisdiction, , product] = id.split(".");
  return id.startsWith("policy.pack.") && jurisdiction && product
    ? `${humanLabel(product)} (${jurisdiction.toUpperCase()})` : humanLabel(id);
}

export const profileLabel = (id: string) => humanLabel(id.replace(/^agent\./, ""));

export function stepLabel(execution: Execution, nodeId: string | null) {
  const node = execution.plan.graph.nodes.find(item => item.id === nodeId);
  if (!nodeId) return "Run";
  const label = node?.name || nodeId;
  return /[._]/.test(label) && !label.includes(" ") ? humanLabel(label) : label;
}

export function latestEventsByStep(events: readonly RuntimeEvent[]) {
  const result = new Map<string, RuntimeEvent>();
  for (const event of events) if (event.nodeId) result.set(event.nodeId, event);
  return [...result.values()].sort((a, b) => b.sequence - a.sequence);
}

export function stringValues(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
