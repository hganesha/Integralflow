import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  describeProblem, diligenceDiff, diligenceProblems, draftFromOverlay, overlaySource, removeOverlay, requirementAdditions, setMatrixCell,
  setOverlayEnabled, setPartyTypes, setRequirementAdditions, upsertOverlay, type OverlayDraft,
} from "./edit";
import { policyRulebook } from "./rulebook";

const kyb = readFileSync(new URL("../../../../domains/kyb-agentic/policy.yaml", import.meta.url), "utf8");
const commented = `# Reviewed by the policy owner\n${kyb}`;
const block = (source: string) => (parse(source) as { diligence: Record<string, any> }).diligence;

describe("diligence edits", () => {
  it("changes one cell and keeps comments and the rest of the source", () => {
    const next = setMatrixCell(commented, "company", "payments", "EDD");
    expect(next.startsWith("# Reviewed by the policy owner")).toBe(true);
    expect(block(next).matrix.company.payments).toBe("EDD");
    const { diligence: _a, ...before } = parse(commented) as Record<string, unknown>;
    const { diligence: _b, ...after } = parse(next) as Record<string, unknown>;
    expect(after).toEqual(before);
    expect(diligenceProblems(next)).toEqual([]);
  });

  it("switches an overlay, and writes, reads back and removes a built overlay", () => {
    expect(block(setOverlayEnabled(kyb, "overlay.adverse-media", true)).overlays.find((o: any) => o.id === "overlay.adverse-media").enabled).toBe(true);
    const draft: OverlayDraft = { id: "overlay.cash-intensive", label: "Cash-intensive business", description: "", enabled: true,
      condition: { kind: "some", list: "/facts/selected/policyRecordRiskFactor", field: "/data/name", op: "in", value: "cash, atm" }, effect: { escalateBy: 1 } };
    const added = upsertOverlay(kyb, draft);
    const raw = overlaySource(added, "overlay.cash-intensive")!;
    expect(raw).toEqual({ id: "overlay.cash-intensive", label: "Cash-intensive business", enabled: true, requires: ["/facts/selected/policyRecordRiskFactor"],
      when: { some: { path: "/facts/selected/policyRecordRiskFactor", where: { path: "/data/name", op: "in", value: ["cash", "atm"] } } }, effect: { escalateBy: 1 } });
    expect(draftFromOverlay(raw)).toEqual(draft);
    expect(diligenceProblems(added)).toEqual([]);
    expect(() => upsertOverlay(added, { ...draft, id: "overlay.pep" })).toThrow("already exists");
    const renamed = upsertOverlay(added, { ...draft, id: "overlay.cash", label: "Cash" }, "overlay.cash-intensive");
    expect(block(renamed).overlays.map((o: any) => o.id)).toContain("overlay.cash");
    expect(block(removeOverlay(renamed, "overlay.cash")).overlays.map((o: any) => o.id)).not.toContain("overlay.cash");
  });

  it("keeps an overlay's scope when the builder edits it", () => {
    const scoped = overlaySource(kyb, "overlay.high-transaction-risk")!;
    expect(scoped.appliesTo).toEqual({ products: ["PAY"] });
    const edited = upsertOverlay(kyb, { ...draftFromOverlay(scoped), label: "Transactional risk" }, "overlay.high-transaction-risk");
    expect(overlaySource(edited, "overlay.high-transaction-risk")).toMatchObject({ label: "Transactional risk", appliesTo: { products: ["PAY"] } });
    expect(diligenceProblems(edited)).toEqual([]);
  });

  it("writes and reads back a rule with every effect and a scope", () => {
    const draft: OverlayDraft = { id: "overlay.pep-approval", label: "PEP approval", description: "", enabled: true,
      condition: { kind: "count", list: "/facts/selected/policyRecordPEPRelationship", count: 1 },
      effect: { escalateTo: "EDD", addRequirements: ["EVD-SOURCE-OF-FUNDS", "EVD-PUBLIC-SOURCE-RESEARCH"], requireApproval: { role: "Case.Reviewer", quorum: 2, reason: "Senior approval." } },
      appliesTo: { products: ["PAY"], partyTypes: ["company"], jurisdictions: [] } };
    const added = upsertOverlay(kyb, draft);
    const raw = overlaySource(added, "overlay.pep-approval")!;
    expect(raw).toMatchObject({ appliesTo: { products: ["PAY"], partyTypes: ["company"] }, effect: draft.effect });
    expect(raw.appliesTo).not.toHaveProperty("jurisdictions");
    expect(draftFromOverlay(raw)).toEqual({ ...draft, appliesTo: { products: ["PAY"], partyTypes: ["company"] } });
    expect(diligenceProblems(added)).toEqual([]);
    // Clearing the scope and the escalation writes neither.
    const cleared = upsertOverlay(added, { ...draft, appliesTo: {}, effect: { addRequirements: ["EVD-SOURCE-OF-FUNDS"] } }, "overlay.pep-approval");
    expect(overlaySource(cleared, "overlay.pep-approval")).not.toHaveProperty("appliesTo");
    expect(overlaySource(cleared, "overlay.pep-approval")!.effect).toEqual({ addRequirements: ["EVD-SOURCE-OF-FUNDS"] });
  });

  it("reads each committed overlay into the builder or keeps it as authored", () => {
    const overlays = block(kyb).overlays as Array<Record<string, unknown>>;
    expect(overlays.map((overlay) => draftFromOverlay(overlay).condition.kind)).toEqual(["custom", "some", "count", "some", "custom", "custom"]);
    expect(draftFromOverlay(overlays[1]!).condition).toEqual({ kind: "some", list: "/facts/selected/policyRecordGeographyExposure", field: "/data/country", op: "in", value: "IR, KP, MM" });
  });

  it("adds a party type with a CDD row, removes one with its row, and flags an ambiguous legal form", () => {
    const parties = block(kyb).partyTypes as Array<{ id: string; label: string; customerType: "corporate"; legalForms: string[] }>;
    const added = setPartyTypes(kyb, [...parties.filter((party) => party.id !== "fund"), { id: "listed_company", label: "Listed company", customerType: "corporate", legalForms: ["unknown"] }]);
    expect(block(added).matrix.listed_company).toEqual({ deposit: "CDD", lending: "CDD", merchant_acquiring: "CDD", payments: "CDD" });
    expect(block(added).matrix.fund).toBeUndefined();
    expect(diligenceProblems(added)).toEqual([]);
    const ambiguous = setPartyTypes(kyb, [...parties, { id: "other", label: "Other", customerType: "corporate", legalForms: ["corporation"] }]);
    expect(diligenceProblems(ambiguous).map(describeProblem)).toEqual(["A legal form belongs to more than one party type."]);
    const uncovered = setPartyTypes(kyb, []);
    expect(diligenceProblems(uncovered).length).toBeGreaterThan(0);
  });

  it("keeps requirements cumulative whatever level is edited", () => {
    const book = policyRulebook({ "policy.yaml": kyb });
    const additions = requirementAdditions(book.diligence!);
    expect(additions.SDD).toEqual(["EVD-CIP-IDENTITY-DOCUMENT", "EVD-SANCTIONS-SCREENING"]);
    const next = setRequirementAdditions(kyb, { ...additions, SDD: [...additions.SDD!, "EVD-CIP-TIN"] });
    expect(block(next).requirements.CDD).toContain("EVD-CIP-TIN");
    expect(block(next).requirements.EDD).toContain("EVD-CIP-TIN");
    expect(diligenceProblems(next)).toEqual([]);
  });
});

describe("version diff", () => {
  it("reads as matrix, overlay, party and requirement changes", () => {
    let next = setMatrixCell(kyb, "trust", "deposit", "EDD");
    next = setOverlayEnabled(next, "overlay.adverse-media", true);
    next = removeOverlay(next, "overlay.high-transaction-risk");
    const parties = block(next).partyTypes;
    next = setPartyTypes(next, parties.filter((party: { id: string }) => party.id !== "government"));
    const book = policyRulebook({ "policy.yaml": next });
    next = setRequirementAdditions(next, { ...requirementAdditions(book.diligence!), EDD: [...requirementAdditions(book.diligence!).EDD!, "EVD-PUBLIC-SOURCE-RESEARCH"] });
    expect(diligenceDiff({ "policy.yaml": kyb }, { "policy.yaml": next })).toEqual([
      { area: "Matrix", text: "Trust or foundation × deposit: CDD → EDD" },
      { area: "Party types", text: "Removed Government body" },
      { area: "Overlays", text: "Confirmed adverse media switched on" },
      { area: "Overlays", text: "Removed High transactional risk" },
      { area: "Requirements", text: "EDD now requires EVD-PUBLIC-SOURCE-RESEARCH" },
    ]);
    expect(diligenceDiff({ "policy.yaml": kyb }, { "policy.yaml": kyb })).toEqual([]);
    expect(diligenceDiff({ "policy.yaml": kyb }, { "policy.yaml": kyb.replace("decisionTtlSeconds: 60", "decisionTtlSeconds: 90") }).map((change) => change.area)).toEqual(["Policy"]);
  });
});
