import { expect, it } from "vitest";
import { currentReport, formErrors, newDefinition, suggestedProfile, type Index } from "./model";

it("does not assign judge to XHigh and leaves newly created tiers unqualified", () => {
  const index = { profiles: [{ profile: { id: "model.judge.v1" } }] } as Index;
  expect(suggestedProfile(index, "xhigh")).toBeUndefined();
  expect(newDefinition("reasoning", "Platform", "xhigh")).toMatchObject({ id: "reasoning.xhigh", configuration: { profileId: null, nativeEffort: "provider_default" } });
});
it("requires exact revision evidence even when a later proposal reverts to an earlier digest", () => {
  const definition = newDefinition("reasoning", "Platform");
  const candidate = { definition, revision: 3, digest: "a".repeat(64), createdAt: "2026-11-08T12:00:00Z", createdBy: "author", reason: "Revert" };
  const index = { reports: [{ bindingId: definition.id, revision: 1, digest: candidate.digest }] } as Index;
  expect(currentReport(index, candidate)).toBeUndefined();
});
it("validates inference namespaces, score ordering and safe connection references", () => {
  const definition = newDefinition("inference", "Platform");
  if (definition.serviceClass !== "inference") throw new Error("Expected inference defaults");
  definition.id = "ml.customer_risk";
  definition.name = "Customer risk";
  expect(formErrors(definition, "Test configuration")).toEqual([]);
  definition.configuration.scoreMax = 0;
  expect(formErrors(definition, "Test configuration")).toContain("Score maximum must exceed its minimum.");
  definition.connection.auth.credentialRef = "sk-secret-value";
  expect(formErrors(definition, "Test configuration")).toContain("Credential and certificate fields accept environment variable names only.");
});
it("creates separate document and System 1 contracts with stable namespaces", () => {
  const document = newDefinition("document", "Platform");
  document.id = "document.identity"; document.name = "Identity extraction";
  expect(formErrors(document, "Add processor")).toEqual([]);
  expect(document.connection.adapterId).toBe("private_document");
  if (document.serviceClass !== "document") throw new Error("Expected document defaults");
  document.configuration.maxPages = 0;
  expect(formErrors(document, "Add processor").join(" ")).toContain("Page limit");
  const decision = newDefinition("decision", "Platform");
  decision.id = "decision.screening_route"; decision.name = "Screening judgment";
  expect(formErrors(decision, "Add System 1")).toEqual([]);
  expect(decision.connection.adapterId).toBe("jev");
  if (decision.serviceClass !== "decision") throw new Error("Expected decision defaults");
  decision.configuration.options = ["duplicate", "duplicate"];
  expect(formErrors(decision, "Add System 1").join(" ")).toContain("unique");
  decision.configuration.minConfidence = 0.9;
  expect(formErrors(decision, "Add System 1")).toContain("A confidence threshold requires a declared confidence source.");
});
it("registers bounded MCP tools and validates catalog pins and exact tool names", () => {
  const definition = newDefinition("mcp", "Platform");
  definition.id = "mcp.customer_lookup"; definition.name = "Customer tools";
  expect(formErrors(definition, "Register server")).toEqual([]);
  if (definition.serviceClass !== "mcp") throw new Error("Expected MCP defaults");
  expect(definition.connection.adapterId).toBe("mcp_gateway");
  definition.configuration.catalogDigest = "not-a-digest";
  definition.configuration.tools = [{ name: "*", capabilityId: "mcp.customer.lookup.v1", inputSchemaRef: "", outputSchemaRef: "", effect: "read", approval: "always" }];
  expect(formErrors(definition, "Register server").join(" ")).toContain("wildcards");
  expect(formErrors(definition, "Register server").join(" ")).toContain("Catalog digest");
});
