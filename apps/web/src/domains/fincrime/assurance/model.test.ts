import { describe, expect, it } from "vitest";
import { orderChronology, splitRoute, supportingSet, type LineageGraph, type RecorderEntry } from "./model";

const entry = (ref: string, source: RecorderEntry["source"], sequence: number, occurredAt: string): RecorderEntry => ({
  ref, source, sequence, occurredAt, code: ref, summary: ref, status: "recorded", interrupt: false,
  actor: { type: "HUMAN", principalId: null, label: "x" }, runId: null, workItemId: null, traceId: null,
});

describe("orderChronology (ASR-02 AC1)", () => {
  it("orders by time, puts a human decision before the case events it caused, and keeps ledger sequence", () => {
    const ordered = orderChronology([
      entry("case:16", "case_event", 16, "2026-11-07T11:34:17Z"),
      entry("case:15", "case_event", 15, "2026-11-07T11:31:02Z"),
      entry("decision", "human_decision", 0, "2026-11-07T11:34:17Z"),
      entry("case:18", "case_event", 18, "2026-11-07T11:40:00Z"),
      entry("case:17", "case_event", 17, "2026-11-07T11:40:00Z"),
    ]);
    expect(ordered.map((item) => item.ref)).toEqual(["case:15", "decision", "case:16", "case:17", "case:18"]);
  });
});

describe("supportingSet (ASR-03 AC1)", () => {
  const graph = {
    caseId: "K", decisionRef: "d", asOf: "2026-11-08T00:00:00Z", columns: ["decision", "policy_evaluation", "evidence", "sources"],
    nodes: [], gaps: [], authority: { decidedBy: [], preparedBy: [], distinctActors: 0 },
    edges: [{ from: "p", to: "d" }, { from: "e", to: "p" }, { from: "s", to: "e" }, { from: "x", to: "y" }],
  } as unknown as LineageGraph;
  it("walks backwards from the decision to the sources", () => {
    expect([...supportingSet(graph, "d")].sort()).toEqual(["d", "e", "p", "s"]);
  });
  it("from an intermediate node reaches only its supports", () => {
    expect([...supportingSet(graph, "e")].sort()).toEqual(["e", "s"]);
  });
});

describe("splitRoute", () => {
  it("separates path and search for platform links", () => {
    expect(splitRoute("/platform/runs?status=failed")).toEqual({ to: "/platform/runs", search: { status: "failed" } });
  });
});
