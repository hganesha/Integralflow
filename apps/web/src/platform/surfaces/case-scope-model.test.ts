import { describe, expect, it } from "vitest";
import { dueDiligenceIneligibility, initialForm, missing, processTitle, refusalCopy, scopeOf, selectionSummary, updateForm, type CasePlanSelection, type ScopeOptions } from "./case-scope-model";

const OPTIONS: ScopeOptions = {
  customerTypes: [{ value: "individual", available: true }, { value: "corporate", available: true }, { value: "trust", available: true }],
  triggers: [{ value: "onboarding", available: true }, { value: "periodic_review", available: true }, { value: "event_review", available: true }],
  events: [{ value: "ownership_change", customerTypes: ["corporate", "trust"] }, { value: "person_name_change", customerTypes: ["individual"] }],
  dueDiligence: [
    { value: "simplified", available: true, customerTypes: ["corporate"], description: "SDD" },
    { value: "standard", available: true, customerTypes: ["individual", "corporate", "trust"], description: "CDD" },
    { value: "enhanced", available: true, customerTypes: ["individual", "corporate", "trust"], description: "EDD" },
  ],
  jurisdictions: [{ code: "AU", available: true }, { code: "GB", available: true }], products: ["card", "deposit", "payments"], institutions: [],
};

describe("case scope form", () => {
  it("starts with nothing chosen for where and what, and says what is missing", () => {
    const form = initialForm(OPTIONS);
    expect(form).toEqual({ customerType: "individual", trigger: "onboarding", event: "", dueDiligence: "standard", jurisdiction: "", products: [] });
    expect(missing(form)).toBe("Choose the policy jurisdiction.");
    expect(scopeOf(form)).toBeNull();
    expect(missing({ ...form, jurisdiction: "GB" })).toBe("Choose at least one product.");
    expect(missing({ ...form, trigger: "event_review", jurisdiction: "GB", products: ["card"] })).toBe("Choose the event that triggers the review.");
  });

  it("asks for a sorted scope, with an event only for an event review", () => {
    const form = { ...initialForm(OPTIONS), customerType: "corporate" as const, jurisdiction: "GB", products: ["payments", "deposit"] };
    expect(scopeOf(form)).toEqual({ customerType: "corporate", trigger: "onboarding", dueDiligence: "standard", jurisdiction: "GB", products: ["deposit", "payments"] });
    expect(scopeOf({ ...form, trigger: "event_review", event: "ownership_change" })).toMatchObject({ event: "ownership_change" });
  });

  it("disables due diligence a customer type cannot use and drops what no longer applies", () => {
    const simplified = OPTIONS.dueDiligence[0]!;
    expect(dueDiligenceIneligibility(simplified, "trust")).toBe("Not for trusts");
    expect(dueDiligenceIneligibility(simplified, "corporate")).toBeNull();
    const corporate = updateForm(initialForm(OPTIONS), { customerType: "corporate", dueDiligence: "simplified", trigger: "event_review", event: "ownership_change" }, OPTIONS);
    expect(corporate).toMatchObject({ dueDiligence: "simplified", event: "ownership_change" });
    expect(updateForm(corporate, { customerType: "trust" }, OPTIONS)).toMatchObject({ dueDiligence: "standard", event: "ownership_change" });
    expect(updateForm(corporate, { customerType: "individual" }, OPTIONS)).toMatchObject({ dueDiligence: "standard", event: "" });
    expect(updateForm(corporate, { trigger: "onboarding" }, OPTIONS).event).toBe("");
  });

  it("names the selected process and pack as the composer titles them, and explains refusals", () => {
    const selection = {
      planDigest: "a".repeat(64), policySnapshotDigest: "b".repeat(64), policyAuthority: { policyId: "p", policyVersion: "1", policyBundleDigest: "c", dependencyDigest: "d" },
      scope: { customerType: "corporate", trigger: "onboarding", dueDiligence: "enhanced", jurisdictions: ["GB"], products: ["deposit"], institution: "bank.synthetic" },
      pack: { id: "policy.pack.gb.bank-synthetic.business-banking", scope: { jurisdiction: "GB", institution: "bank.synthetic", productSet: "business-banking", products: ["deposit"], customerTypes: ["corporate"] } },
    } satisfies CasePlanSelection;
    expect(selectionSummary(selection)).toBe("Agentic KYB (EDD): business onboarding · policy.pack.gb.bank-synthetic.business-banking");
    expect(processTitle({ ...selection.scope, customerType: "individual", dueDiligence: "standard" })).toBe("Agentic KYC: individual onboarding");
    expect(processTitle({ ...selection.scope, customerType: "trust", dueDiligence: "standard", trigger: "event_review", event: "trust_party_change" })).toBe("Agentic KYB: trust trust party change review");
    expect(refusalCopy("case.plan_no_pack").title).toBe("No policy pack covers this case");
    expect(refusalCopy("case.plan_no_plan").title).toBe("No released process for this case");
  });
});
