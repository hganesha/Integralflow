import type { Schemas } from "@ehf/ui-contracts";

export type AgentCardView = Schemas["AgentCard"];
export type AgentDetailView = Schemas["AgentDetail"];
export type TaskCompositionView = Schemas["TaskComposition"];
export type TaskStepView = TaskCompositionView["steps"][number];
export type FieldRequirementRow = Schemas["FieldRequirement"];
export type Ceilings = AgentDetailView["ceilings"];

/** Typed cross-links (BUILD-SPEC v2 §8.4). */
export const agentPath = (agentId: string) => `/studio/agents/mandates/${encodeURIComponent(agentId)}`;
export const taskPath = (agentId: string, taskId: string) => `${agentPath(agentId)}/tasks/${encodeURIComponent(taskId)}`;
export const skillPath = (skillId: string) => `/studio/skills/definitions/${encodeURIComponent(skillId)}`;
export const contextPreviewPath = (agentId: string, taskId: string) =>
  `/context/preview?agent=${encodeURIComponent(agentId)}&task=${encodeURIComponent(taskId)}`;
export const contextProductPath = (productId: string) => `/context?product=${encodeURIComponent(productId)}`;

/** One column of the dependency map: steps that can start once every earlier column is done. */
export type Stage = { index: number; lanes: Array<{ parallelGroup: number | null; steps: TaskStepView[] }> };

/**
 * Lay steps out by dependency rank (longest path from a root), then group the steps of one
 * rank into lanes by `parallelGroup`. Steps without a group get a lane each. Order inside a
 * rank follows the task's own step order, so the layout is stable across reloads. A cycle
 * (which catalog validation forbids) falls back to rank 0 rather than looping.
 */
export function dependencyStages(steps: readonly TaskStepView[]): Stage[] {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const rank = new Map<string, number>();
  const visiting = new Set<string>();
  const rankOf = (id: string): number => {
    const known = rank.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const deps = (byId.get(id)?.dependencies ?? []).filter((dep) => byId.has(dep));
    const value = deps.length ? Math.max(...deps.map(rankOf)) + 1 : 0;
    visiting.delete(id);
    rank.set(id, value);
    return value;
  };
  const stages: Stage[] = [];
  for (const step of steps) {
    const index = rankOf(step.id);
    while (stages.length <= index) stages.push({ index: stages.length, lanes: [] });
    const stage = stages[index]!;
    const lane = step.parallelGroup === null ? undefined : stage.lanes.find((candidate) => candidate.parallelGroup === step.parallelGroup);
    if (lane) lane.steps.push(step);
    else stage.lanes.push({ parallelGroup: step.parallelGroup, steps: [step] });
  }
  return stages;
}

export type RequirementStatus = "met" | "outside_ceiling" | "runtime_check";

export const REQUIREMENT_LABEL: Record<RequirementStatus, string> = {
  met: "Met",
  outside_ceiling: "Outside agent ceiling",
  runtime_check: "Needs runtime check",
};

/**
 * AGT-05 handshake for one field requirement against the agent's ceiling. The contract has no
 * per-requirement status (GAP-090), so the UI derives it from catalog data only:
 * - outside the agent's `context_fields` (or `policy_fields` for `Policy`) → outside agent ceiling;
 * - inside the ceiling but bound by a freshness policy → needs runtime check (only case data
 *   at run time can show the value is fresh enough);
 * - otherwise → met.
 * Never aggregated into a percentage.
 */
export function requirementStatus(row: FieldRequirementRow, ceilings: Ceilings): RequirementStatus {
  const allowed = row.object_type === "Policy"
    ? ceilings.policy_fields.includes(row.field)
    : (ceilings.context_fields[row.object_type] ?? []).includes(row.field);
  if (!allowed) return "outside_ceiling";
  return row.freshness_policy ? "runtime_check" : "met";
}

/** Counts per status for a summary line (counts, never a ratio). */
export function requirementCounts(rows: readonly FieldRequirementRow[], ceilings: Ceilings): Record<RequirementStatus, number> {
  const counts: Record<RequirementStatus, number> = { met: 0, outside_ceiling: 0, runtime_check: 0 };
  for (const row of rows) counts[requirementStatus(row, ceilings)] += 1;
  return counts;
}

/** `AgentCard.readiness` is not a stateMap dimension, so its tone is fixed here. */
export const AGENT_READINESS: Record<AgentCardView["readiness"], { tone: "positive" | "attention" | "blocking"; icon: "checkcircle" | "alert" | "xcircle"; label: string }> = {
  ready: { tone: "positive", icon: "checkcircle", label: "Context ready" },
  gaps: { tone: "attention", icon: "alert", label: "Context gaps" },
  blocked: { tone: "blocking", icon: "xcircle", label: "Context blocked" },
};
