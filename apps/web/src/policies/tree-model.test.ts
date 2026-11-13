import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { policyTreeModel, policyTreeNodes } from "./tree-model";
it("projects canonical decision-table rows in source order, including default and condition definitions", () => {
  const source = readFileSync(new URL("../../../../domains/kyc/policy/catalog/decision-tables/screening-ready.yaml", import.meta.url), "utf8");
  const model = policyTreeModel({ "catalog/decision-tables/screening-ready.yaml": source });
  expect(model.errors).toEqual([]);
  const doc = model.documents[0]!;
  expect(doc.hitPolicy).toBe("first");
  expect(doc.branches[0]!.label).toBe("1. SR-001");
  expect(doc.branches.at(-1)!.label).toBe("Default");
  const nodes = policyTreeNodes(doc.branches[0]!.node);
  expect(new Set(nodes.map(node => node.id)).size).toBe(nodes.length);
  expect(nodes.find(node => node.kind === "condition")).toMatchObject({ title: "evaluation = ERROR", raw: { token: "ERROR", definition: { extractor: { kind: "evaluationStatus" } } } });
  expect(nodes.find(node => node.kind === "outcome")?.title).toBe("ERROR");
  expect(source).toContain("hitPolicy: first");
});
it("retains nested ALL/ANY assertions and declared failure outcomes without evaluating them", () => {
  const source = { kind: "Policy", metadata: { id: "example" }, spec: { gates: { readiness: { requirements: [{ id: "r1", assert: { all: [{ path: "$.ready", operator: "eq", value: true }, { any: [{ path: "$.a", operator: "notEmpty" }, { path: "$.b", operator: "notEmpty" }] }] }, onFailure: { outcome: "REVIEW", reasonCode: "MISSING" } }], onPass: { outcome: "ALLOW" } } } } };
  const before = JSON.stringify(source);
  const doc = policyTreeModel({ "policy.yaml": source }).documents[0]!;
  const nodes = policyTreeNodes(doc.branches[0]!.node);
  expect(nodes.filter(node => ["all", "any"].includes(node.kind)).map(node => node.kind)).toEqual(["all", "any"]);
  expect(nodes.filter(node => node.kind === "outcome").map(node => node.title)).toEqual(["REVIEW", "ALLOW"]);
  expect(JSON.stringify(source)).toBe(before);
});
it("keeps table references intact and reports malformed or cyclic YAML", () => {
  const model = policyTreeModel({ "policy.yaml": { kind: "Policy", spec: { gates: { screening: { table: "catalog/decision-tables/screening.yaml" } } } }, "bad.yaml": "kind: Policy\nspec: [", "cycle.yaml": "kind: Policy\nspec: &x { gates: *x }" });
  expect(model.documents[0]!.branches[0]!.node.children[0]!.node).toMatchObject({ kind: "reference", raw: "catalog/decision-tables/screening.yaml" });
  expect(model.errors.map(error => error.path)).toEqual(["bad.yaml", "cycle.yaml"]);
});
