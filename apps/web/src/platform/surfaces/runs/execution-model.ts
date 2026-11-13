import type { Schemas } from "@ehf/ui-contracts";
export type Execution = Schemas["RunExecutionView"];
export type Attempt = Schemas["RunNodeExecution"];
export type NodeState = "not_observed" | "running" | "completed" | "failed" | "cancelled" | "waiting_human" | "unknown";
export function nodeExecution(execution: Execution, nodeId: string, attempt: number): { state: NodeState; record: Attempt | null } {
  const records = execution.attempts.filter(record => record.nodeId === nodeId && record.attempt === attempt).sort((a, b) => b.fencingEpoch - a.fencingEpoch || (b.startedAt ?? "").localeCompare(a.startedAt ?? ""));
  const record = records[0] ?? null;
  if (attempt === execution.run.attempt && nodeId === execution.run.currentNodeId && execution.run.status === "manual_review") return { state: "waiting_human", record };
  if (!record) return { state: "not_observed", record };
  if (record.status === "running" && attempt === execution.run.attempt && execution.run.status === "cancelled") return { state: "cancelled", record };
  return { state: ["running", "completed", "failed", "cancelled"].includes(record.status) ? record.status as NodeState : "unknown", record };
}
