import { describe, expect, it } from "vitest";
import { edgesAlong, highlighted, matching, multiplyDecimals, pathInterest, pathsToRoot, visibleFor, type Ownership } from "./ownership-model";

const node = (id: string, extra: object = {}) => ({ id, label: id, sublabel: null, kind: "entity", isRoot: false, epistemic: "fact", uboStatus: null, ...extra });
const edge = (id: string, source: string, target: string, extra: object = {}) => ({ id, source, target, kind: "equity", interest: "0.5", interestAlternative: null, status: "verified", evidenceIds: [], contradictionId: null, ...extra });
const view = {
  nodes: [node("acme", { isRoot: true }), node("alice", { kind: "person", uboStatus: "verified" }), node("holdco"), node("bram", { kind: "person", uboStatus: "candidate" }), node("nominee", { epistemic: "assumption" }), node("chen", { kind: "person", uboStatus: "candidate", label: "Chen Wei" })],
  edges: [
    edge("e1", "alice", "acme", { interest: "0.33" }),
    edge("e2", "holdco", "acme", { interest: "0.45" }),
    edge("e3", "bram", "acme", { status: "conflict", interest: "0.12", interestAlternative: "0.22", contradictionId: "cf-12" }),
    edge("e4", "nominee", "holdco", { interest: "0.6", status: "unresolved" }),
    edge("e5", "chen", "nominee", { interest: "1", status: "candidate" }),
  ],
  gaps: [{ node: "chen", reason: "No declaration", path: ["chen", "nominee", "holdco", "acme"], interest: "0.27" }],
} as unknown as Ownership;

describe("filters", () => {
  it("keeps everything by default and hides nothing", () => {
    expect(visibleFor(view, "all")).toMatchObject({ hiddenNodes: 0, hiddenEdges: 0 });
  });
  it("keeps only conflicts, their parties and the customer, and counts what it hides", () => {
    const shown = visibleFor(view, "conflict");
    expect([...shown.edges]).toEqual(["e3"]);
    expect([...shown.nodes].sort()).toEqual(["acme", "bram"]);
    expect(shown).toMatchObject({ hiddenNodes: 4, hiddenEdges: 4 });
  });
  it("treats every relationship on a gap path as unresolved", () => {
    expect([...visibleFor(view, "unresolved").edges].sort()).toEqual(["e2", "e3", "e4", "e5"]);
  });
  it("keeps relationships that touch an unverified party", () => {
    expect([...visibleFor(view, "unverified").edges].sort()).toEqual(["e3", "e4", "e5"]);
  });
});

describe("paths and calculation", () => {
  it("multiplies decimals exactly", () => {
    expect(multiplyDecimals(["0.4", "0.7"])).toBe("0.28");
    expect(multiplyDecimals(["1", "0.6", "0.45"])).toBe("0.27");
    expect(multiplyDecimals(["0.1", "0.2"])).toBe("0.02");
  });
  it("finds the path to the customer and shows the arithmetic", () => {
    const { paths, circular } = pathsToRoot(view, "chen");
    expect(paths.map((path) => path.map((item) => item.id))).toEqual([["e5", "e4", "e2"]]);
    expect(circular).toBe(false);
    expect(pathInterest(paths[0]!)).toEqual({ state: "calculated", value: "0.27", terms: ["1", "0.6", "0.45"] });
  });
  it("does not calculate across a conflict, an unknown interest or a control relationship", () => {
    expect(pathInterest(pathsToRoot(view, "bram").paths[0]!)).toMatchObject({ state: "unable", reason: expect.stringContaining("disagree") });
    expect(pathInterest([edge("x", "a", "b", { interest: null })] as never)).toMatchObject({ state: "unable", reason: expect.stringContaining("unknown") });
    expect(pathInterest([edge("x", "a", "b", { kind: "control" })] as never)).toMatchObject({ state: "unable", reason: expect.stringContaining("control") });
  });
  it("ends circular holdings instead of looping, and says so", () => {
    const loop = { ...view, edges: [...view.edges, edge("e6", "holdco", "nominee")] } as unknown as Ownership;
    const result = pathsToRoot(loop, "chen");
    expect(result.circular).toBe(true);
    expect(result.paths).toHaveLength(1);
  });
  it("reports several paths separately", () => {
    const two = { ...view, edges: [...view.edges, edge("e7", "chen", "acme", { interest: "0.05" })] } as unknown as Ownership;
    expect(pathsToRoot(two, "chen").paths).toHaveLength(2);
  });
});

describe("selection", () => {
  it("highlights a party's whole path, a single relationship, or a contradiction's relationship", () => {
    expect([...highlighted(view, { node: "chen" })].sort()).toEqual(["e2", "e4", "e5"]);
    expect([...highlighted(view, { edge: "e1" })]).toEqual(["e1"]);
    expect([...highlighted(view, { contradiction: "cf-12" })]).toEqual(["e3"]);
    expect(edgesAlong(view, ["chen", "nominee", "holdco", "acme"]).map((item) => item.id)).toEqual(["e5", "e4", "e2"]);
  });
  it("finds parties by name", () => {
    expect(matching(view, " chen ")).toEqual(["chen"]);
    expect(matching(view, "")).toEqual([]);
  });
});
