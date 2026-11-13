import { describe, expect, it } from "vitest";
import { dependencyStages, requirementCounts, requirementStatus, type FieldRequirementRow, type TaskStepView } from "./model";

const step = (id: string, dependencies: string[], parallelGroup: number | null): TaskStepView => ({
  id, dependencies, parallelGroup, requiresHumanDecision: false, acceptedStatuses: ["COMPLETED"], requiredPayloadFields: [],
  skill: { skill_id: id, version: "0.2.0", business_outcome: "", domain: "d", execution_mode: "code", effects: [], context_object_types: [], agent_ids: [], task_ids: [] },
});

describe("dependencyStages", () => {
  it("AGT-03-AC1: identity & ownership is entity ∥ registry → UBO resolve → UBO verify", () => {
    const stages = dependencyStages([
      step("entity_resolve", [], 0),
      step("registry_company_verify", [], 0),
      step("ownership_ubo_resolve", ["entity_resolve", "registry_company_verify"], null),
      step("ownership_ubo_verify", ["ownership_ubo_resolve"], null),
    ]);
    expect(stages.map((stage) => stage.lanes.map((lane) => lane.steps.map((entry) => entry.id)))).toEqual([
      [["entity_resolve", "registry_company_verify"]],
      [["ownership_ubo_resolve"]],
      [["ownership_ubo_verify"]],
    ]);
    expect(stages[0]!.lanes[0]!.parallelGroup).toBe(0);
  });

  it("gives ungrouped steps of one rank a lane each and does not loop on a cycle", () => {
    const stages = dependencyStages([step("a", [], null), step("b", [], null), step("c", ["d"], null), step("d", ["c"], null)]);
    expect(stages[0]!.lanes.length).toBeGreaterThanOrEqual(2);
    expect(stages.flatMap((stage) => stage.lanes.flatMap((lane) => lane.steps))).toHaveLength(4);
  });
});

describe("requirementStatus (AGT-05)", () => {
  const ceilings = { context_fields: { Entity: ["name"], OwnershipInterest: ["owner"] }, policy_fields: ["jurisdiction"] };
  const row = (object_type: string, field: string, freshness_policy: string | null): FieldRequirementRow => ({
    object_type, field, freshness_policy, required: true, min_count: 1, on_missing: "NEEDS_EVIDENCE", temporal: null, skill_id: "s",
  });

  it("AGT-05-AC1: met, outside agent ceiling and needs runtime check", () => {
    expect(requirementStatus(row("Policy", "jurisdiction", null), ceilings)).toBe("met");
    expect(requirementStatus(row("Policy", "permissions", null), ceilings)).toBe("outside_ceiling");
    expect(requirementStatus(row("Entity", "name", "tenant_policy.freshness_seconds"), ceilings)).toBe("runtime_check");
    expect(requirementStatus(row("Entity", "identifiers", "tenant_policy.freshness_seconds"), ceilings)).toBe("outside_ceiling");
    expect(requirementStatus(row("Document", "document_type", null), ceilings)).toBe("outside_ceiling");
  });

  it("counts by status without a ratio", () => {
    expect(requirementCounts([row("Policy", "jurisdiction", null), row("Entity", "name", "f"), row("X", "y", null)], ceilings))
      .toEqual({ met: 1, outside_ceiling: 1, runtime_check: 1 });
  });
});
