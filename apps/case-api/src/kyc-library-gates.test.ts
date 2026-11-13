import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { caseAggregateSchema, evaluateGate, loadPolicyCatalog, type CaseAggregate } from "@ehf/policy-engine";
import { policyAggregate } from "./policy-evaluator.js";

/**
 * The OPA decision-table gates of domains/archive/kyc-v2-deterministic evaluated over the case the library workflow
 * actually produces (connector evidence and findings, the policy authority, the library
 * recommendation adapter), through the same gate input mapping the evaluator uses
 * (`policyAggregate`). Every input that has no source yet must keep the gate from ALLOW.
 * The reference evaluator is held to the compiled Rego by the kyc-policy corpus conformance.
 */
const catalog = loadPolicyCatalog(resolve(import.meta.dirname, "../../../domains/kyc/policy"));
const capturedAt = "2026-11-07T12:00:00.000Z";
const policySnapshotDigest = "a".repeat(64);

type Data = Record<string, unknown[]>;
const evidence = (id: string, purpose: string, sourceType: string, tier: string, instructionTrust = "UNTRUSTED_EXTERNAL") => ({
  evidence: { evidence_id: id, source: { type: sourceType, retrievedAt: capturedAt }, trust: { tier, instructionTrust }, created_at: capturedAt },
  link: { evidence_id: id, purpose, status: "ACCEPTED", linked_at: capturedAt, policy_snapshot_digest: policySnapshotDigest },
});

/** What the KYC library workflow writes up to decision-ready on a clean run. */
function libraryCase(options: { claim?: boolean; cip?: boolean; findings?: unknown[]; facts?: unknown[]; recommendation?: unknown } = {}): Data {
  const items = [
    evidence("ev_policy", "KYC_POLICY_AUTHORITY", "INTERNAL_SYSTEM", "AUTHORITATIVE_POLICY", "TRUSTED"), // policy-authority
    evidence("ev_identity", "KYC_IDENTITY_VERIFICATION", "TOOL", "VERIFIED_PROVIDER"), // acquire-identity (passed)
    evidence("ev_documents", "KYC_DOCUMENT_EVIDENCE", "TOOL", "VERIFIED_PROVIDER"), // acquire-documents
    evidence("ev_sanctions", "KYC_SANCTIONS_SCREENING", "TOOL", "VERIFIED_PROVIDER"), // acquire-sanctions
    evidence("ev_pep", "KYC_PEP_SCREENING", "TOOL", "VERIFIED_PROVIDER"), // acquire-pep
    evidence("ev_media", "KYC_ADVERSE_MEDIA", "TOOL", "VERIFIED_PROVIDER"), // acquire-adverse-media
  ];
  return {
    subjects: [{
      subject_id: "S-1", display_name: "Ada Lovelace",
      attributes: options.cip === false ? { customerType: "individual" } : {
        customerType: "individual", dateOfBirth: "1990-12-10", address: "1 Main St, Springfield", taxpayerIdentificationNumber: "123-45-6789",
      },
    }],
    evidence: items.map((item) => item.evidence),
    evidenceLinks: items.map((item) => item.link),
    claims: options.claim === false ? [] : [{ claim_id: "claim_policy_RUN", predicate: "applicable_kyc_policy", value: { policySnapshotDigest }, evidence_refs: ["ev_policy"] }],
    findings: options.findings ?? [],
    facts: options.facts ?? [],
    workItems: [],
    contradictions: [],
    decisionRecommendations: options.recommendation ? [options.recommendation] : [],
  };
}

function gate(gateId: string, data: Data, productionReady = false) {
  const snapshot = {
    caseSequence: 9, capturedAt, data,
    policyAuthority: { policyId: "policy.kyc.customer-acceptance.v1", policyVersion: "1.0.0", policySnapshotDigest, policyBundleDigest: "b".repeat(64) },
  };
  const aggregate = caseAggregateSchema.parse(policyAggregate(snapshot as never, productionReady)) as CaseAggregate;
  return evaluateGate(gateId, aggregate, catalog);
}

const riskProfile = { fact_id: "fact_risk", predicate: "kyc_risk_profile", status: "ACTIVE", value: { riskTier: "standard", jurisdictionRisk: "LOW", productRisk: "LOW", pepExposure: false } };
// decision.recommendation.generate's adapter: always REVIEW with requiresHumanReview.
const libraryRecommendation = { recommendation_id: "recommendation_RUN", outcome: "REVIEW", rationale: "Library decision.recommendation.generate returned REVIEW_FOR_ACCEPTANCE", requires_human_review: true, evidence_refs: ["ev_rec"], finding_refs: [], policy_rule_refs: [] };

describe("KYC library workflow under the OPA gates", () => {
  it("screening-ready allows only with the pinned policy authority, its claim and the CIP attributes", () => {
    expect(gate("screening-ready", libraryCase())).toMatchObject({ outcome: "ALLOW", reasonCode: "SCREENING_PRECONDITIONS_SATISFIED" });
    expect(gate("screening-ready", libraryCase({ claim: false }))).toMatchObject({ outcome: "BLOCK", reasonCode: "POLICY_CLAIM_MISSING" });
    expect(gate("screening-ready", libraryCase({ cip: false }))).toMatchObject({ outcome: "BLOCK", reasonCode: "CIP_CORE_ATTRIBUTES_INCOMPLETE" });
  });

  it("decision-ready fails closed on every input the library workflow has no source for yet", () => {
    // No risk profile (no library skill writes kyc_risk_profile): the cohort is undetermined.
    const noRisk = gate("decision-ready", libraryCase());
    expect(noRisk).toMatchObject({ outcome: "REVIEW", reasonCode: "POLICY_UNKNOWN_INPUT" });
    expect(noRisk.conditionValues).toMatchObject({ cohort: "UNKNOWN", screeningCoverage: "COMPLETE", investigationWorkItem: "ABSENT" });
    // With a cohort, the public-source investigation (no registered connector) blocks.
    expect(gate("decision-ready", libraryCase({ facts: [riskProfile] }))).toMatchObject({ outcome: "BLOCK", reasonCode: "INVESTIGATION_INCOMPLETE" });
  });

  it("an incomplete connector screen is never read as coverage", () => {
    const incomplete = gate("decision-ready", libraryCase({ findings: [{ finding_id: "f1", finding_type: "SANCTIONS_SCREEN_INCOMPLETE", status: "OPEN" }] }));
    expect(incomplete.outcome).not.toBe("ALLOW");
    expect(incomplete.conditionValues.screeningCoverage).not.toBe("COMPLETE");
  });

  it("disposition never allows on a library recommendation, and blocks without one", () => {
    const facts = [riskProfile];
    // Candidate bundle: no disposition at all (configuration ERROR escalates to the human approval).
    expect(gate("disposition", libraryCase({ facts, recommendation: libraryRecommendation }))).toMatchObject({ outcome: "ERROR", reasonCode: "PRODUCTION_POLICY_CONFIGURATION_UNRESOLVED" });
    // Even with a production-ready bundle the library recommendation routes to a human.
    expect(gate("disposition", libraryCase({ facts, recommendation: libraryRecommendation }), true)).toMatchObject({ outcome: "REVIEW", reasonCode: "HUMAN_REVIEW_REQUIRED" });
    expect(gate("disposition", libraryCase({ facts }), true)).toMatchObject({ outcome: "BLOCK", reasonCode: "RECOMMENDATION_MISSING" });
    // A provider alert recorded by the connector outranks everything.
    expect(gate("disposition", libraryCase({ facts, recommendation: libraryRecommendation, findings: [{ finding_id: "f2", finding_type: "POSSIBLE_SANCTIONS_MATCH", status: "OPEN" }] }), true))
      .toMatchObject({ outcome: "REVIEW", reasonCode: "POSSIBLE_SANCTIONS_MATCH" });
  });
});
