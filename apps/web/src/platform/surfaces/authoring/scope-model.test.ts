import { describe, expect, it } from "vitest";
import { basisText, changeSummary, isScopeGate, packScope, recommendation, sameScope, type ProcessScope, type ScopePreview } from "./scope-model";

const PERSONAL: ProcessScope = { customerType: "individual", trigger: "onboarding", jurisdictions: ["US", "GB"], products: ["card", "deposit", "payments"], institution: "bank.synthetic" };
const pack = (jurisdiction: string, customerTypes = ["individual"]) => ({ id: `policy.pack.${jurisdiction.toLowerCase()}.bank-synthetic.personal-banking`, scope: { jurisdiction, institution: "bank.synthetic", products: ["card", "deposit", "payments"], customerTypes } });
const gate = (packs: unknown[]) => ({ id: "intake-ready", kind: "gate", config: { policyRef: "kyc-agentic.business", gateId: "intake-ready", policyPacks: packs } });

const PREVIEW: ScopePreview = {
  scope: { ...PERSONAL, customerType: "corporate", products: ["deposit", "lending"] }, previous: PERSONAL, unchanged: false,
  decisions: [
    { kind: "agent", id: "agent.identity_ownership", action: "include", reason: "Ownership and control agent serves corporate customers.", basis: { source: "roster", field: "customerTypes", value: ["corporate"] } },
    { kind: "connector", id: "acquire-officers", action: "include", reason: "Directors are screened, so the entity's officers are acquired.", basis: { source: "pack", field: "screening_roles", value: "director", packId: "policy.pack.us.bank-synthetic.business-banking", layer: "pack.product.lending" } },
    { kind: "pack", id: "policy.pack.us.bank-synthetic.business-banking", action: "include", reason: "The US business-banking pack covers exactly these products.", basis: { source: "scope", field: "jurisdictions", value: "US" } },
  ],
  changes: {
    agents: { added: ["agent.identity_ownership"], removed: [] }, skills: { added: [], removed: [] },
    connectors: { added: ["acquire-officers"], removed: [] },
    packs: { added: ["policy.pack.us.bank-synthetic.business-banking"], removed: ["policy.pack.us.bank-synthetic.personal-banking"] },
    nodes: { added: [{ id: "acquire-officers", kind: "tool", name: "Officers lookup" }], removed: [] },
  },
};

describe("process scope view model", () => {
  it("reads a gate's pinned packs as the process scope", () => {
    expect(isScopeGate(gate([pack("US"), pack("GB")]))).toBe(true);
    expect(isScopeGate({ id: "x", kind: "gate", config: { policyRef: "p", gateId: "g" } })).toBe(false);
    expect(packScope(gate([pack("US"), pack("GB")]))).toEqual(PERSONAL);
    expect(packScope(gate([pack("US"), pack("GB", ["corporate"])]))).toBeNull();
  });

  it("treats standard due diligence as the default and ignores ordering", () => {
    expect(sameScope(PERSONAL, { ...PERSONAL, dueDiligence: "standard", jurisdictions: ["GB", "US"] })).toBe(true);
    expect(sameScope(PERSONAL, { ...PERSONAL, dueDiligence: "enhanced" })).toBe(false);
    expect(sameScope(PERSONAL, { ...PERSONAL, trigger: "event_review", event: "address_change" })).toBe(false);
  });

  it("groups the recommendation by kind with each item's reason and basis", () => {
    const groups = recommendation(PREVIEW);
    expect(groups.map((group) => group.title)).toEqual(["Agents", "Data acquisition", "Policy packs"]);
    expect(groups[1]!.items[0]).toEqual({ id: "acquire-officers", label: "Officers lookup", change: "added", reason: "Directors are screened, so the entity's officers are acquired.", basis: "pack screening_roles includes director (layer pack.product.lending)" });
    expect(groups[2]!.items.find((item) => item.change === "removed")).toMatchObject({ reason: "Replaced: the new scope pins a different pack.", basis: null });
    expect(basisText({ source: "roster", field: "customerTypes", value: ["individual", "corporate"] })).toBe("agent roster customerTypes: individual, corporate");
    expect(changeSummary(PREVIEW)).toBe("agents +1/−0 · data sources +1/−0 · 1 pack pinned");
  });
});
