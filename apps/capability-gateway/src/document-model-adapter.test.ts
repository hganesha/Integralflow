import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { documentModelModule, documentOfRun } from "./adapters/document-model.js";

const release = vi.hoisted(() => ({ value: null as null | Record<string, unknown> }));
vi.mock("@ehf/persistence", () => ({ releasedDocumentModel: vi.fn(async () => release.value) }));
vi.mock("@ehf/contracts", async (actual) => ({
  ...await actual<typeof import("@ehf/contracts")>(),
  documentExtractionVariant: (plan: { variant?: string }) => plan.variant ?? null,
}));

const content = Buffer.from("%PDF-1.4 passport");
const version = createHash("sha256").update(content).digest("hex");
const runInput = { tenantId: "t", caseId: "c", documentId: "d", documentVersion: version, evidenceId: "e", filename: "passport.pdf", contentBase64: content.toString("base64") };
const adjudicated = { variant: "adjudicated" } as never;
const env = { DOCUMENT_MODEL_PROVIDER: "azure_document_intelligence", DOCUMENT_MODEL_REMOTE_ALLOWED: "true", AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT: "https://diexample.cognitiveservices.azure.com",
  AZURE_DOCUMENT_INTELLIGENCE_AUTH: "key", AZURE_DOCUMENT_INTELLIGENCE_KEY: "proxy-injected" };
const capability = { id: "document.model.extract.v1" } as never;
const request = { document_type: "passport", artifact_ref: `case-document:${version}`, artifact_hash: version, media_type: "application/pdf" };

function azure(models: string[]) {
  return (async (url: string, init: RequestInit) => {
    const model = new URL(url).pathname.split("/")[3]!.split(":")[0]!;
    if (init.method === "POST") {
      models.push(model);
      expect(JSON.parse(String(init.body)).base64Source).toBe(content.toString("base64"));
      return new Response(null, { status: 202, headers: { "operation-location": `https://diexample.cognitiveservices.azure.com/documentintelligence/documentModels/${model}/analyzeResults/1` } });
    }
    const fields = model.startsWith("prebuilt-")
      ? { DocumentNumber: { type: "string", valueString: "X1234567", content: "X1234567", confidence: 0.99, boundingRegions: [{ pageNumber: 1 }] } }
      : { document_number: { type: "string", valueString: "X1234567", content: "X1234567", confidence: 0.97 } };
    return Response.json({ status: "succeeded", analyzeResult: { modelId: model, apiVersion: "2024-11-30", documents: [{ docType: "x", fields }] } });
  }) as unknown as typeof globalThis.fetch;
}
const adapter = (fetch: typeof globalThis.fetch, extra: NodeJS.ProcessEnv = {}) =>
  documentModelModule.create({ env: { ...env, ...extra }, fetch, db: {} as never, modelProfilesPath: "", workloadToken: (() => { throw new Error("unused"); }) as never, delegate: (() => { throw new Error("unused"); }) as never });

describe("document-model connector", () => {
  it("reads only the original of an adjudicated document run, checked against its version", () => {
    expect(documentOfRun(adjudicated, runInput)).toMatchObject({ documentVersion: version, filename: "passport.pdf" });
    expect(() => documentOfRun({ variant: "contract" } as never, runInput)).toThrow("gateway.document_model_plan_denied");
    expect(() => documentOfRun({} as never, runInput)).toThrow("gateway.document_model_plan_denied");
    expect(() => documentOfRun(adjudicated, { ...runInput, contentBase64: Buffer.from("other").toString("base64") })).toThrow("gateway.document_model_source_denied");
    expect(() => documentOfRun(adjudicated, { ...runInput, contentBase64: undefined })).toThrow("gateway.document_model_source_denied");
  });

  it("uses the prebuilt route without a release, and refuses another document or a call without the run's original", async () => {
    release.value = null;
    const models: string[] = [];
    const runDocument = documentOfRun(adjudicated, runInput);
    const result = await adapter(azure(models)).invoke("azure_document_intelligence", capability, request, { tenantId: "t", runDocument });
    expect(models).toEqual(["prebuilt-idDocument"]);
    expect(result.output).toMatchObject({ contract: "document.model_fields.v1", document_type: "passport", source_sha256: version,
      fields: [expect.objectContaining({ path: "/extracted_fields/document_number", value: "X1234567" })] });
    expect(result.costUsd).toBe(0.01);
    await expect(adapter(azure(models)).invoke("azure_document_intelligence", capability, { ...request, artifact_hash: "f".repeat(64) }, { tenantId: "t", runDocument })).rejects.toThrow("gateway.document_model_source_denied");
    await expect(adapter(azure(models)).invoke("azure_document_intelligence", capability, request, { tenantId: "t" })).rejects.toThrow("gateway.document_model_source_denied");
    await expect(adapter(azure(models)).invoke("azure_document_intelligence", capability, { ...request, document_type: "certificate_of_incorporation" }, { tenantId: "t", runDocument }))
      .rejects.toThrow("adapter.document_model_route_unsupported");
    await expect(adapter(azure(models), { DOCUMENT_MODEL_REMOTE_ALLOWED: "false" }).invoke("azure_document_intelligence", capability, request, { tenantId: "t", runDocument }))
      .rejects.toThrow("gateway.document_model_not_configured");
  });

  it("uses the model of the release in effect for the type when an environment is configured", async () => {
    release.value = { releaseDigest: "a".repeat(64), releaseId: "rel-1", route: "custom", mode: "shadow", providerModelId: "ehf-release-0123" };
    const models: string[] = [];
    const runDocument = documentOfRun(adjudicated, runInput);
    const result = await adapter(azure(models), { DOCUMENT_MODEL_RELEASE_ENVIRONMENT: "test" }).invoke("azure_document_intelligence", capability, request, { tenantId: "t", runDocument });
    expect(models).toEqual(["ehf-release-0123"]);
    expect((result.output as { fields: unknown }).fields).toEqual([expect.objectContaining({ path: "/extracted_fields/document_number", provider_field: "document_number" })]);
    expect(result.costUsd).toBe(0.03);
    release.value = { releaseDigest: "a".repeat(64), releaseId: "rel-1", route: "llm_only", mode: "shadow", providerModelId: null };
    await expect(adapter(azure(models), { DOCUMENT_MODEL_RELEASE_ENVIRONMENT: "test" }).invoke("azure_document_intelligence", capability, request, { tenantId: "t", runDocument }))
      .rejects.toThrow("adapter.document_model_route_unsupported");
  });
});
