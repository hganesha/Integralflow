import { describe, expect, it } from "vitest";
import { highlightRuns } from "./highlight";

describe("page highlight runs", () => {
  it("cuts by code points, so a span after an astral character still quotes the right text", () => {
    const runs = highlightRuns("𝐀 Name: Acme Ltd", [{ start: 8, end: 12, kind: "assertion", field: "entity_name", ref: "a1" }]);
    expect(runs.map((run) => run.text)).toEqual(["𝐀 Name: ", "Acme", " Ltd"]);
    expect(runs[1]!.highlight?.field).toBe("entity_name");
  });

  it("never repeats text when spans overlap", () => {
    const runs = highlightRuns("abcdefgh", [
      { start: 1, end: 5, kind: "assertion", field: "x", ref: "a" },
      { start: 3, end: 7, kind: "evidence", field: null, ref: "e" },
    ]);
    expect(runs.map((run) => run.text).join("")).toBe("abcdefgh");
    expect(runs.map((run) => run.text)).toEqual(["a", "bcde", "fg", "h"]);
  });
  it("gives a selected citation its entire quote even within another highlight", () => {
    const runs = highlightRuns("abcdefgh", [
      { start: 1, end: 7, kind: "evidence", field: null, ref: "e" },
      { start: 2, end: 5, kind: "assertion", field: "x", ref: "a" },
    ], highlight => highlight.ref === "a");
    expect(runs.map(run => run.text).join("")).toBe("abcdefgh");
    expect(runs.find(run => run.highlight?.ref === "a")?.text).toBe("cde");
  });

});
