import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { updateAuthoringContextClassificationPolicies, updateAuthoringContextSelectors } from "./authoring-context.js";

describe("case-read authoring contracts", () => {
  const packageSource = `apiVersion: harness.factory/domain-package-v2
kind: DomainPackage
metadata: {name: test, version: 0.1.0, domain: test, objective: Test reads}
workflow: workflow.yaml
budgets: {maxDurationMs: 1000, maxCostUsd: 1, maxModelCalls: 1, maxCapabilityCalls: 1}
`;

  it("persists a normalized package selector set without touching other package fields", () => {
    const source = updateAuthoringContextSelectors(packageSource, [{
      id: "case-id", source: "case", path: "case.caseId", purpose: "KYC_SCREENING", classification: "CONFIDENTIAL", required: true,
    }]);
    const parsed = parse(source) as Record<string, unknown>;
    expect(parsed.metadata).toEqual({ name: "test", version: "0.1.0", domain: "test", objective: "Test reads" });
    expect(parsed.contextSelectors).toEqual([{ id: "case-id", source: "case", path: "case.caseId", purpose: "KYC_SCREENING", classification: "CONFIDENTIAL", required: true }]);
  });

  it("rejects invalid or duplicate selector contracts", () => {
    const selector = { id: "case-id", source: "case", path: "case.caseId", purpose: "KYC_SCREENING", classification: "CONFIDENTIAL", required: true };
    expect(() => updateAuthoringContextSelectors(packageSource, [selector, selector])).toThrow("authoring.context_selector_duplicate");
    expect(() => updateAuthoringContextSelectors(packageSource, [{ ...selector, source: "not-a-source" }])).toThrow("authoring.context_selector_invalid:0");
  });

  it("persists explicit masking behavior and rejects incomplete policies", () => {
    const source = updateAuthoringContextClassificationPolicies(packageSource, [{
      classification: "PII", action: "mask", transform: { kind: "partial", visiblePrefix: 0, visibleSuffix: 4, replacement: "*" },
    }]);
    expect((parse(source) as Record<string, unknown>).contextClassificationPolicies).toEqual([{
      classification: "PII", action: "mask", transform: { kind: "partial", visiblePrefix: 0, visibleSuffix: 4, replacement: "*" },
    }]);
    expect(() => updateAuthoringContextClassificationPolicies(packageSource, [{ classification: "PII", action: "mask" }]))
      .toThrow("authoring.context_classification_policy_invalid:0");
  });
});
