import { expect, it } from "vitest";
import type { Schemas } from "@ehf/ui-contracts";
import { OUTCOMES, fieldLabel, outcomeSummary, routeOrder, visibleFields } from "./route-comparison-model";

const field = (path: string, outcome: Schemas["DocumentRouteField"]["outcome"], review: Schemas["DocumentRouteField"]["review"], keyField = true): Schemas["DocumentRouteField"] =>
  ({ path, field: path.split("/")[0]!, keyField, criticality: "critical", outcome, rule: "R1", review, comparison: null, selectedRoute: null, assertionId: null, candidates: [] });
const comparison: Schemas["DocumentRouteComparison"] = {
  mode: "shadow", proposedRoute: "llm", reviewRequired: true, policy: { id: "p", version: "1", digest: "d" },
  routes: [{ route: "azure_di", label: "Azure prebuilt model", provider: null, model: null, status: "valid", error: null, issues: [] },
    { route: "llm", label: "LLM contract extraction", provider: null, model: null, status: "valid", error: null, issues: [] }],
  counts: { AGREED_GROUNDED: 2, CONFLICT: 1, NOT_PRESENT: 1 },
  fields: [field("document_number", "AGREED_GROUNDED", "standard"), field("place_of_birth", "SINGLE_ROUTE", "required", false),
    field("date_of_birth", "CONFLICT", "required"), field("issue_date", "AGREED_GROUNDED", "standard", false)],
};

it("lists fields needing review first, key fields before others, then everything in contract order", () => {
  expect(visibleFields(comparison, "review").map(f => f.path)).toEqual(["date_of_birth", "place_of_birth"]);
  expect(visibleFields(comparison, "all").map(f => f.path)).toEqual(["date_of_birth", "place_of_birth", "document_number", "issue_date"]);
});

it("puts the proposed route first and summarizes outcomes worst first", () => {
  expect(routeOrder(comparison)).toEqual(["llm", "azure_di"]);
  expect(outcomeSummary(comparison).map(item => `${item.label}: ${item.count}`)).toEqual(["Routes disagree: 1", "Not found: 1", "Routes agree: 2"]);
});

it("labels every outcome and never presents agreement as verification", () => {
  expect(Object.keys(OUTCOMES)).toHaveLength(8);
  expect(OUTCOMES.AGREED_GROUNDED.detail).toContain("not verification");
  expect(fieldLabel("accounts/0/closing_balance")).toBe("accounts › row 1 › closing balance");
});
