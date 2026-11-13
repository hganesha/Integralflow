import { describe, expect, it } from "vitest";
import { nodeExecution, type Execution, type Attempt } from "./execution-model";
const execution = (attempts: Partial<Attempt>[], status = "running") => ({ run: { attempt: 2, currentNodeId: "review", status }, attempts: attempts.map(record => ({ nodeId: "extract", attempt: 2, fencingEpoch: 1, status: "running", ...record })) }) as Execution;
describe("recorded workflow states", () => {
  it("selects the latest fenced execution within the selected attempt", () => {
    const view = execution([{ attempt: 1, fencingEpoch: 9, status: "completed" }, { fencingEpoch: 2, status: "failed" }, { fencingEpoch: 1, status: "completed" }]);
    expect(nodeExecution(view, "extract", 2).state).toBe("failed");
    expect(nodeExecution(view, "extract", 1).state).toBe("completed");
    expect(nodeExecution(view, "unreported", 2).state).toBe("not_observed");
  });
  it("only identifies the authoritative current human handoff", () => {
    const view = execution([], "manual_review");
    expect(nodeExecution(view, "review", 2).state).toBe("waiting_human");
    expect(nodeExecution(view, "review", 1).state).toBe("not_observed");
    expect(nodeExecution(view, "extract", 2).state).toBe("not_observed");
  });
  it("retains completed outcomes after cancellation and exposes unknown states", () => {
    const view = execution([{ nodeId: "done", status: "completed" }, {}, { nodeId: "future", status: "new_server_state" }], "cancelled");
    expect(nodeExecution(view, "done", 2).state).toBe("completed");
    expect(nodeExecution(view, "extract", 2).state).toBe("cancelled");
    expect(nodeExecution(view, "future", 2).state).toBe("unknown");
  });
});
