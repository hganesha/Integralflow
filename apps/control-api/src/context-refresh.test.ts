import { describe, it, expect } from "vitest";
import type { HarnessPlanV2 } from "@ehf/contracts";
import type { ContextRefreshSchedule } from "@ehf/contracts/context-refresh";
import { assertRefreshPlan } from "./context-refresh.js";
const schedule = {
  nodeId: "fetch",
  mappingId: "customers",
} as ContextRefreshSchedule;
const plan = {
  capabilities: [
    {
      id: "context.records.fetch.v1",
      adapterBindingId: "context-postgres:customers",
    },
  ],
  graph: {
    nodes: [
      { id: "input", kind: "input", config: {} },
      {
        id: "subjects",
        kind: "transform",
        config: { operation: "project", fields: ["subjects"] },
      },
      {
        id: "fetch",
        kind: "tool",
        config: {
          capabilityId: "context.records.fetch.v1",
          usePredecessorInput: true,
          caseWrites: [
            {
              commandType: "RecordCanonicalRecords",
              payload: { records: "{{output.records}}" },
            },
          ],
        },
      },
      { id: "output", kind: "output", config: {} },
    ],
    edges: [
      { from: "input", to: "subjects", kind: "data" },
      { from: "subjects", to: "fetch", kind: "data" },
      { from: "fetch", to: "output", kind: "data" },
    ],
  },
} as HarnessPlanV2;
describe("refresh plan admission", () => {
  it("requires bounded subject projection and an unconditional acquisition/commit path", () => {
    expect(() => assertRefreshPlan(plan, schedule)).not.toThrow();
    for (const change of [
      (p: HarnessPlanV2) => {
        p.graph.edges[1]!.condition = "input.enabled";
      },
      (p: HarnessPlanV2) => {
        p.graph.nodes[1]!.config.fields = ["otherSubjects"];
      },
      (p: HarnessPlanV2) => {
        p.graph.nodes[2]!.config.caseWrites = [];
      },
      (p: HarnessPlanV2) => {
        p.graph.nodes[2]!.config.usePredecessorInput = false;
      },
    ]) {
      const changed = structuredClone(plan);
      change(changed);
      expect(() => assertRefreshPlan(changed, schedule)).toThrow(
        "refresh_plan_invalid",
      );
    }
  });
});
