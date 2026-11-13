import { describe, expect, it } from "vitest";
import { parseRunInput, templateFor, type InputSchema } from "./run-input";

const schema: InputSchema = {
  type: "object",
  required: ["tenantId", "caseId"],
  properties: { tenantId: { type: "string" }, caseId: { type: "string" }, priority: { type: "integer" }, lane: { type: "string", enum: ["standard", "edd"] } },
};

describe("parseRunInput", () => {
  it("accepts input that satisfies the schema", () => {
    expect(parseRunInput('{"tenantId":"t","caseId":"KYB-1042","priority":2}', schema)).toEqual({ ok: true, value: { tenantId: "t", caseId: "KYB-1042", priority: 2 } });
  });

  it("reports missing required keys, wrong types and enum violations", () => {
    const result = parseRunInput('{"tenantId":"t","priority":"high","lane":"fast"}', schema);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.issues.map((issue) => issue.path)).toEqual(["caseId", "priority", "lane"]);
  });

  it("refuses non-objects and invalid JSON", () => {
    expect(parseRunInput("[1]", schema)).toMatchObject({ ok: false, issues: [{ path: "$" }] });
    expect(parseRunInput("{", schema)).toMatchObject({ ok: false });
  });

  it("builds a template from required keys", () => {
    expect(JSON.parse(templateFor(schema))).toEqual({ tenantId: "", caseId: "" });
  });
});
