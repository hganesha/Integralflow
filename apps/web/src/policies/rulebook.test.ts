import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { resolveStudioTab } from "../platform/surfaces/authoring/policy";
import { describePath, diligenceFacts, gateFactInputs, nextStep, policyRulebook, predicateClause, ruleCount, setFact } from "./rulebook";
import { policyTreeModel, policyTreeNodes } from "./tree-model";

const read = (path: string) => readFileSync(new URL(`../../../../${path}`, import.meta.url), "utf8");

describe("policy rulebook", () => {
  it("reads the agentic installation policy as gates, policy sets and installation fields", () => {
    const book = policyRulebook({ "policy.yaml": read("domains/kyc-agentic/policy.yaml") });
    expect(book.errors).toEqual([]);
    expect(book).toMatchObject({ kind: "business", title: "policy.kyc-agentic.business.v2", version: "2.0.0" });
    expect(book.sections.map((section) => section.id)).toEqual(["intake-ready", "decision-ready", "disposition"]);
    // The SYNTHETIC checkpoint rules (packages/flow-composer/src/gate-rules.ts).
    expect(ruleCount(book)).toBe(14);
    const [intake] = book.sections;
    expect(intake!.rules[0]).toMatchObject({ id: "synthetic.intake.ready", then: "Decided", reasonCodes: ["SYNTHETIC_INTAKE_READY"] });
    expect(intake!.otherwise).toEqual({ then: "Needs more evidence", reasonCodes: ["BANKING_RELATIONSHIP_MISSING"] });
    expect(book.policySets.map((set) => set.label)).toEqual(["US · individual · card, deposit, payments", "GB · individual · card, deposit, payments"]);
    const us = book.policySets[0]!;
    expect(us.content.filter((field) => field.resolved).map((field) => field.field)).toEqual(expect.arrayContaining(["freshness_seconds", "screening_threshold", "verification_methods", "edd_triggers", "requirements"]));
    // Provider permission is never a placeholder.
    expect(us.content.filter((field) => !field.resolved).map((field) => field.field)).toEqual(["permitted_providers"]);
    // EDD triggers combine the SYNTHETIC placeholders with what the diligence design derives.
    expect(us.content.find((field) => field.field === "edd_triggers")).toMatchObject({ resolved: true, label: "EDD triggers", owner: "installation.policy.owner" });
    expect(us.content.find((field) => field.field === "edd_triggers")!.note).toMatch(/^SYNTHETIC.*diligence design derives\.$/);
    expect(us.settings.find((setting) => setting.key === "pep_scope")).toMatchObject({ label: "PEP scope", value: "foreign" });
    expect(us.settings.some((setting) => setting.key === "content")).toBe(false);
  });

  it("reads archived decision tables row by row, in gate order", () => {
    const book = policyRulebook({
      "catalog/decision-tables/disposition.yaml": read("domains/kyc/policy/catalog/decision-tables/disposition.yaml"),
      "catalog/decision-tables/screening-ready.yaml": read("domains/kyc/policy/catalog/decision-tables/screening-ready.yaml"),
    });
    expect(book.kind).toBe("archived");
    expect(book.sections.map((section) => section.id)).toEqual(["table.kyc.screening-ready.v1", "table.kyc.disposition.v1"]);
    const disposition = book.sections[1]!;
    expect(disposition.order).toBe("Rows are checked in order and the first that matches decides.");
    expect(disposition.rules[0]).toMatchObject({ id: "DP-001", when: { text: "Evaluation is ERROR" }, then: "Stop with an error", reasonCodes: ["POLICY_EVALUATION_ERROR"] });
    expect(disposition.rules[1]!.when.text).toBe("Policy configuration is one of FALSE, UNKNOWN");
  });

  it("words predicates without evaluating them", () => {
    expect(predicateClause({ all: [
      { path: "/facts/selected/risk/jurisdictionRisk", op: "eq", value: "HIGH" },
      { any: [{ path: "/facts/selected/pepCount", op: "gte", value: 1 }, { path: "/observations/adverseMedia", op: "present" }] },
      { some: { path: "/facts/selected/findings", where: { path: "/findingType", op: "in", value: ["PEP_SIGNAL", "ADVERSE_MEDIA"] } } },
      { path: "/facts/selected/verifiedAt", op: "age_lte_seconds", value: 86400 },
      { path: "/facts/selected/score", op: "lte", valueFrom: "/configuration/screening_threshold" },
    ] })).toEqual({ text: "All of these hold", children: [
      { text: "Jurisdiction risk is HIGH", children: [] },
      { text: "Any of these holds", children: [{ text: "PEP count is at least 1", children: [] }, { text: "Adverse media is provided", children: [] }] },
      { text: "At least one entry in findings matches", children: [{ text: "Its finding type is one of PEP_SIGNAL, ADVERSE_MEDIA", children: [] }] },
      { text: "Verified at is no older than 1 day", children: [] },
      { text: "Score is at most the configured screening threshold", children: [] },
    ] });
    expect(describePath("/configuration/content")).toBe("installation policy content");
  });

  it("reports unreadable sources instead of throwing", () => {
    const book = policyRulebook({ "policy.yaml": "kind: BusinessPolicy\ngates: [" });
    expect(book.errors.map((error) => error.path)).toEqual(["policy.yaml"]);
    expect(book.sections).toEqual([]);
  });
});

describe("what-if inputs", () => {
  const source = `kind: BusinessPolicy
gates:
  decision-ready:
    rules:
      - id: r1
        when: { all: [ { path: /facts/selected/risk/jurisdictionRisk, op: eq, value: HIGH }, { path: /facts/selected/risk/jurisdictionRisk, op: in, value: [MEDIUM] }, { path: /facts/selected/ownership, op: present } ] }
      - id: r2
        when: { path: /facts/selected/pepCount, op: gte, value: 1 }
      - id: r3
        when: { path: /configuration/content, op: present }
`;
  it("asks for the facts a gate's rules read, with the values they compare against", () => {
    expect(gateFactInputs({ "policy.yaml": source }, "decision-ready")).toEqual([
      { path: "/facts/selected/risk/jurisdictionRisk", label: "Jurisdiction risk", kind: "choice", options: ["HIGH", "MEDIUM"] },
      { path: "/facts/selected/ownership", label: "Ownership", kind: "presence", options: [] },
      { path: "/facts/selected/pepCount", label: "PEP count", kind: "number", options: [] },
    ]);
    expect(gateFactInputs({ "policy.yaml": source }, "intake-ready")).toEqual([]);
  });
  it("sets facts by pointer without mutating the input", () => {
    const facts = { asOf: "2026-01-01T00:00:00Z" };
    expect(setFact(facts, "/facts/selected/risk/jurisdictionRisk", "HIGH")).toEqual({ asOf: "2026-01-01T00:00:00Z", selected: { risk: { jurisdictionRisk: "HIGH" } } });
    expect(facts).toEqual({ asOf: "2026-01-01T00:00:00Z" });
  });
});

describe("next lifecycle step", () => {
  const all = ["draft.write", "draft.compile", "draft.approve", "draft.publish"];
  const revision = (status: string, author = "author") => ({ revision: 2, status, author });
  it("walks save, compile, approve and publish, keeping separation of duties", () => {
    expect(nextStep({ revision: null, dirty: false, actions: all, subjectId: "author" })).toMatchObject({ id: "save", reason: null });
    expect(nextStep({ revision: revision("COMPILED"), dirty: true, actions: all, subjectId: "author" }).id).toBe("save");
    expect(nextStep({ revision: revision("DRAFT"), dirty: false, actions: all, subjectId: "author" })).toMatchObject({ id: "compile", reason: null });
    expect(nextStep({ revision: revision("COMPILED"), dirty: false, actions: all, subjectId: "author" })).toMatchObject({ id: "approve", reason: "Needs a different approver (separation of duties): you authored revision 2." });
    expect(nextStep({ revision: revision("COMPILED"), dirty: false, actions: all, subjectId: "reviewer" })).toMatchObject({ id: "approve", reason: null });
    expect(nextStep({ revision: revision("APPROVED"), dirty: false, actions: ["draft.write"], subjectId: "reviewer" }).reason).toContain("draft.publish");
    expect(nextStep({ revision: revision("PUBLISHED"), dirty: false, actions: all, subjectId: "reviewer" })).toMatchObject({ id: "done", label: "Published" });
    expect(nextStep({ revision: null, dirty: true, actions: [], subjectId: "x" }).reason).toContain("draft.write");
  });
});

describe("studio tabs", () => {
  it("keeps links to the old tabs working", () => {
    expect(resolveStudioTab(undefined, undefined, undefined)).toEqual({ tab: "rules", section: "source", view: "list" });
    expect(resolveStudioTab("tree", undefined, undefined)).toEqual({ tab: "rules", section: "source", view: "flow" });
    expect(resolveStudioTab("library", undefined, undefined).tab).toBe("advanced");
    expect(resolveStudioTab("sources", undefined, undefined)).toMatchObject({ tab: "advanced", section: "sources" });
    expect(resolveStudioTab("activity", undefined, undefined).tab).toBe("versions");
    expect(resolveStudioTab("advanced", "bundle", undefined)).toMatchObject({ tab: "advanced", section: "bundle" });
    expect(resolveStudioTab("nonsense", "nonsense", "nonsense")).toEqual({ tab: "rules", section: "source", view: "list" });
  });
});

it("projects business gates into the flow view", () => {
  const model = policyTreeModel({ "policy.yaml": read("domains/kyb-agentic/policy.yaml") });
  expect(model.errors).toEqual([]);
  const doc = model.documents[0]!;
  expect(doc.hitPolicy).toBe("first");
  expect(doc.branches.map((branch) => branch.label)).toEqual(["intake-ready", "decision-ready", "disposition"]);
  const nodes = policyTreeNodes(doc.branches[0]!.node);
  // The SYNTHETIC intake rules: a resolved relationship and the required parties, else more evidence.
  expect(nodes.filter((node) => node.kind === "outcome").map((node) => node.title)).toContain("DECIDED");
  expect(nodes.filter((node) => node.kind === "outcome").at(-1)?.description).toBe("BANKING_RELATIONSHIP_MISSING");
});

describe("diligence in the studio", () => {
  it("reads the diligence block and each set's pack controls", async () => {
    const book = policyRulebook({ "policy.yaml": read("domains/kyb-agentic/policy.yaml") });
    const diligence = book.diligence!;
    expect(diligence).toMatchObject({ gateId: "diligence-level", levels: ["SDD", "CDD", "EDD"], simplifiedLevel: "SDD", products: ["deposit", "lending", "merchant_acquiring", "payments"] });
    expect(diligence.matrix.trust).toEqual({ deposit: "CDD", lending: "EDD", merchant_acquiring: "EDD", payments: "EDD" });
    expect(diligence.overlays.find((overlay) => overlay.id === "overlay.high-risk-geography")).toMatchObject({ enabled: true, effect: "Escalate by 1 level" });
    expect(book.policySets.map((set) => set.diligence.mandatoryOverlays)).toEqual([[], ["overlay.high-risk-geography", "overlay.pep"]]);
    expect(book.policySets.every((set) => set.diligence.sddPermitted === false)).toBe(true);
  });

  it("builds what-if facts that make every chosen risk factor fire under the engine's reference evaluation", async () => {
    const { evaluateDiligence, diligenceSourceSchema } = await import("../../../../packages/policy-engine/src/diligence/index");
    for (const flow of ["kyc-agentic", "kyb-agentic"]) {
      const raw = parse(read(`domains/${flow}/policy.yaml`)) as { diligence: unknown; policySets: Array<{ configuration: Record<string, unknown>; scope: { products: string[]; customerTypes: string[] } }> };
      const source = diligenceSourceSchema.parse(raw.diligence);
      const book = policyRulebook({ "policy.yaml": read(`domains/${flow}/policy.yaml`) });
      const diligence = book.diligence!;
      const set = raw.policySets[0]!;
      const party = diligence.partyTypes.find((entry) => set.scope.customerTypes.includes(entry.customerType))!;
      const all = diligence.overlays.map((overlay) => overlay.id);
      // Every product of the set, so overlays scoped to some of them (payments) can fire too.
      const scope = { products: set.scope.products, customerType: party.customerType, legalForm: party.legalForms[0] };
      const configuration = { ...set.configuration, mandatory_overlays: all };
      const quiet = evaluateDiligence(source, { facts: diligenceFacts(diligence, all, [], "2026-11-11T00:00:00Z"), configuration, scope });
      expect(quiet.state, flow).toBe("DECIDED");
      expect(quiet.ruleIds.filter((id) => id.startsWith("overlay."))).toEqual([]);
      for (const overlay of diligence.overlays) {
        expect(overlay.witness, overlay.id).not.toBeNull();
        const fired = evaluateDiligence(source, { facts: diligenceFacts(diligence, all, [overlay.id], "2026-11-11T00:00:00Z"), configuration, scope });
        expect(fired.ruleIds, `${flow} ${overlay.id}`).toContain(overlay.id);
      }
      expect(diligence.overlays.find((overlay) => overlay.id === "overlay.high-transaction-risk")?.scope).toBe("Only for products under PAY");
    }
  });
});

describe("rule sentences", () => {
  it("reads a rule as when, where and what it does", async () => {
    const { ruleSentence, effectText } = await import("./rulebook");
    const rule = { id: "overlay.pep", when: { some: { path: "/facts/selected/policyRecordPEPRelationship", where: { path: "/data/verified", op: "eq", value: true } } },
      appliesTo: { products: ["PAY"], partyTypes: ["company"] },
      effect: { escalateTo: "EDD", addRequirements: ["EVD-SOURCE-OF-FUNDS", "EVD-PUBLIC-SOURCE-RESEARCH"], requireApproval: { role: "Case.Reviewer", quorum: 2, reason: "Senior approval of a PEP." } } };
    const sentence = ruleSentence(rule, [{ id: "company", label: "Company" }]);
    expect(sentence).toMatch(/^When .+, for products under PAY; Company, raise the level to EDD, require EVD-SOURCE-OF-FUNDS and EVD-PUBLIC-SOURCE-RESEARCH and require approval by 2 case reviewers \(Senior approval of a PEP\)\.$/);
    expect(effectText(rule.effect)).toBe("Escalate to EDD · Adds 2 requirements · Approval by 2 case reviewers");
    expect(ruleSentence({ when: { path: "/facts/x", op: "present" }, effect: { escalateBy: 1 } })).toMatch(/, raise the level by 1 step\.$/);
  });
});

it("says who must decide when each approval role has its own quorum", async () => {
  const { requirementText } = await import("./roles");
  expect(requirementText({ roles: ["Case.Reviewer", "KYC.SeniorReviewer"], quorum: 3, roleQuorums: { "Case.Reviewer": 2, "KYC.SeniorReviewer": 1 } })).toBe("2 case reviewers and 1 senior reviewer (3 people)");
  expect(requirementText({ roles: ["Case.Reviewer"], quorum: 2 })).toBe("2 of Case reviewer");
  expect(requirementText({ roles: ["Case.Reviewer", "KYC.SeniorReviewer"], quorum: 4, roleQuorums: { "Case.Reviewer": 2, "KYC.SeniorReviewer": 1 } })).toBe("2 case reviewers and 1 senior reviewer, 4 people in all");
});
