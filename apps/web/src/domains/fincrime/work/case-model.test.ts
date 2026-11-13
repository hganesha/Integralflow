import { describe, expect, it } from "vitest";
import { actorLabel, agentLabel, briefing, closedFindings, openItems, readiness, sourceNotices, type Sources } from "./case-model";

const ownership = {
  nodes: [{ id: "acme", label: "Acme Trading Ltd" }, { id: "bram", label: "Bram Okoro" }, { id: "chen", label: "Chen Wei" }],
  edges: [
    { id: "e1", source: "bram", target: "acme", status: "conflict", interest: "0.12", interestAlternative: "0.22", contradictionId: "cf-12" },
    { id: "e2", source: "chen", target: "acme", status: "verified", interest: "0.3", interestAlternative: null, contradictionId: null },
  ],
  gaps: [{ node: "chen", reason: "Indirect path lacks a declaration", path: ["chen", "acme"], interest: "0.27" }],
};
const documents = {
  documents: [{ documentId: "d1", filename: "passport.txt", reviewPending: 4, conflicts: 0 }],
  requirements: [{ id: "r1", description: "Proof of address", anyOf: ["utility_bill"], satisfied: false }, { id: "r2", description: "Register", anyOf: [], satisfied: true }],
};
const sources = (over: Partial<Sources> = {}): Sources => ({
  ownership: { state: "ready", data: ownership as never, stale: false },
  screening: { state: "not_started" },
  documents: { state: "ready", data: documents, stale: false },
  findings: { state: "not_started" },
  ...over,
});
const room = {
  caseId: "KYB-1", caseType: "KYB", jurisdiction: "US", status: "INVESTIGATING", caseSequence: 14,
  subject: { subjectId: "s", name: "Acme Trading Ltd", kind: "company", identifiers: [] },
  stages: [{ taskId: "a", label: "Intake", status: "done" }, { taskId: "b", label: "Ownership", status: "needs_review" }],
  humanWork: [{ workItem: { workItemId: "w", objective: "Accept ownership findings", status: "WAITING_HUMAN" }, assignedTo: [], decisions: [], requiredApprovals: 1 }],
  counts: { facts: 2, evidence: 9, claims: 6, assumptions: 1, openContradictions: 1, screeningFindings: 0 },
} as never;

describe("open items", () => {
  it("lists conflicts first, then reviews, then missing evidence", () => {
    const items = openItems("KYB-1", sources());
    expect(items.map((item) => item.kind)).toEqual(["conflict", "review", "review", "missing"]);
    expect(items[0]).toMatchObject({ id: "contradiction:cf-12", party: "Bram Okoro", why: "One source reports 12%, another 22%." });
    expect(items[0]!.href).toBe("/work/cases/KYB-1/lens/ownership?contradiction=cf-12");
    expect(items[1]!.why).toContain("Chen Wei → Acme Trading Ltd");
  });

  it("never treats a screening candidate as a confirmed match, and skips negative searches", () => {
    const screening = { findings: [
      { findingId: "f1", status: "open", entryName: "B. Okoro", subjectName: "Bram Okoro", listType: "sanctions" },
      { findingId: "f2", status: "open", entryName: "—", subjectName: "Chen Wei", listType: "pep" },
    ] };
    const items = openItems("KYB-1", sources({ ownership: { state: "not_started" }, documents: { state: "not_started" }, screening: { state: "ready", data: screening as never, stale: false } }));
    expect(items).toHaveLength(1);
    expect(items[0]!.why).toContain("not a confirmed match");
  });

  it("says what it cannot show instead of showing nothing", () => {
    const notices = sourceNotices(sources({ ownership: { state: "unavailable", reason: "The service did not answer" } }));
    expect(notices.map((notice) => `${notice.source}:${notice.tone}`)).toEqual(["ownership:attention", "screening:info", "findings:info"]);
  });

  const finding = (findingId: string, state: string, extra: object = {}) => ({ findingId, kind: "contradiction", findingType: null, title: `Recorded ${findingId}`, subjectRefs: [], severity: "HIGH", state, recordedStatus: "OPEN", evidenceIds: [], raisedBy: { principalId: "a", type: "AGENT" }, raisedAt: "2026-11-08T09:00:00Z", dispositions: [], ...extra });
  const registry = (...items: object[]): Sources["findings"] => ({ state: "ready", data: { caseSequence: 14, items } as never, stale: false });

  it("ties a derived conflict to its recorded finding and keeps the richer description", () => {
    const items = openItems("KYB-1", sources({ findings: registry(finding("cf-12", "open")) }));
    expect(items[0]).toMatchObject({ id: "contradiction:cf-12", origin: "recorded", findingId: "cf-12", severity: "HIGH", party: "Bram Okoro" });
    expect(items.filter((item) => item.findingId === "cf-12")).toHaveLength(1);
    expect(items.find((item) => item.id === "gap:chen")).toMatchObject({ origin: "derived" });
  });

  it("drops an item the registry says is closed, and lists it as closed with its history", () => {
    const resolved = finding("cf-12", "resolved", { dispositions: [{ id: "cf-12:resolution", source: "resolution", outcome: "RESOLVED", rationale: null, by: null, at: "2026-11-08T10:00:00Z" }] });
    const withRegistry = sources({ findings: registry(resolved) });
    expect(openItems("KYB-1", withRegistry).some((item) => item.findingId === "cf-12")).toBe(false);
    expect(closedFindings(withRegistry).map((entry) => entry.findingId)).toEqual(["cf-12"]);
  });

  it("lists a recorded finding that no view shows", () => {
    const other = finding("f-9", "open", { kind: "finding", findingType: "ADVERSE_MEDIA", severity: null });
    const items = openItems("KYB-1", sources({ findings: registry(other) }));
    expect(items.find((item) => item.findingId === "f-9")).toMatchObject({ id: "finding:f-9", origin: "recorded", source: "findings", kind: "review", href: "/work/cases/KYB-1/findings?item=finding%3Af-9" });
  });
});

describe("readiness", () => {
  it("states what needs attention as counts, never a percentage or a stage total", () => {
    const items = openItems("KYB-1", sources());
    const line = readiness(room, items, sources());
    expect(line.text).toBe("Ownership: needs review · 1 step waits on a person · 4 open items");
    expect(line.tone).toBe("attention");
    expect(line.text).not.toMatch(/%| of \d/);
  });

  it("does not read as settled while a projection failed to load", () => {
    const failed = sources({ ownership: { state: "unavailable", reason: "x" }, documents: { state: "not_started" } });
    const line = readiness({ stages: [{ taskId: "a", label: "Intake", status: "done" }], humanWork: [] } as never, [], failed);
    expect(line.tone).toBe("attention");
    expect(line.text).toContain("ownership not loaded");
  });

  it("never claims completion, because unstarted stages are not reported", () => {
    const none = sources({ ownership: { state: "not_started" }, documents: { state: "not_started" } });
    const line = readiness({ stages: [{ taskId: "a", label: "Intake", status: "done" }], humanWork: [] } as never, [], none);
    expect(line).toMatchObject({ text: "Nothing is reported as waiting on this case", tone: "neutral" });
  });
});

describe("briefing", () => {
  it("states the case, what is established, what is unresolved and the next step", () => {
    const lines = briefing(room, openItems("KYB-1", sources()), sources());
    expect(lines.map((line) => line.label)).toEqual(["Case", "Established", "Unresolved", "Next"]);
    expect(lines[0]!.text).toBe("KYB case for Acme Trading Ltd (company, US). The case is investigating.");
    expect(lines[2]!.text).toContain("4 open items");
    expect(lines[3]!.text).toContain("Accept ownership findings (unclaimed)");
  });

  it("does not present an empty list as a clearance", () => {
    const none = sources({ ownership: { state: "not_started" }, documents: { state: "not_started" } });
    expect(briefing(room, [], none)[2]!.text).toContain("not a clearance");
  });
});

describe("labels", () => {
  it("names agents and services in words", () => {
    expect(agentLabel("agent.identity_ownership")).toBe("Identity ownership agent");
    expect(actorLabel({ principalId: "service:case-api" })).toBe("Platform service");
    expect(actorLabel({ principalId: "r.okafor", type: "HUMAN" })).toBe("r.okafor");
  });
});
