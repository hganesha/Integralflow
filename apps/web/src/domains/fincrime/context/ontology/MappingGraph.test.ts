import { expect, it } from "vitest";
import { expressionSourcePaths } from "./MappingGraph";
import type { MappingExpression } from "@ehf/contracts";
it("shows source dependencies in advanced rules without interpreting literal source data as mapping code", () => {
  const rule: MappingExpression = { op: "object", fields: {
    name: { op: "concat", separator: " ", values: [{ op: "trim", value: { op: "field", path: "first_name" } }, { op: "field", path: "last_name" }] },
    identity: { op: "coalesce", values: [{ op: "field", path: "crm_key" }, { op: "field", path: "registry_key" }] },
    metadata: { op: "literal", value: { op: "field", path: "not-a-dependency" } },
  } };
  const before = JSON.stringify(rule);
  expect(expressionSourcePaths(rule)).toEqual(["first_name", "last_name", "crm_key", "registry_key"]);
  expect(JSON.stringify(rule)).toBe(before);
  expect(expressionSourcePaths(JSON.parse(before))).toEqual(expressionSourcePaths(rule));
});
