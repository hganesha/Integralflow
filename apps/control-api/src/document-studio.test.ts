import Fastify from "fastify";
import { expect, it, vi } from "vitest";
import type { Database } from "@ehf/persistence";
import { documentModelProviderFromEnv, invokeDocumentFieldsModel, layoutProviderFromEnv, prepareDocument } from "@ehf/adapters";
import { registerDocumentStudio, executeDocumentStudio, type StudioRun } from "./document-studio.js";

// Admission tests inject execution/configuration and must not initialize DB/provider transports.
vi.mock("@ehf/persistence", () => ({ getProvider: vi.fn(), listRegisteredCapabilities: vi.fn(), resolveModelProfile: vi.fn() }));
vi.mock("@ehf/adapters", () => ({ invokeDocumentFieldsModel: vi.fn(), prepareDocument: vi.fn(), layoutProviderFromEnv: vi.fn(() => null), documentModelProviderFromEnv: vi.fn(() => null), loadModelProfiles: vi.fn() }));

const payload = { documentType: "passport", filename: "sample.txt", mediaType: "text/plain", contentBase64: Buffer.from("Passport Sample").toString("base64") };
const model = { profileId: "model.standard.v1", profileDigest: "a".repeat(64), provider: "openrouter", model: "test-model" };
const configuration = async () => ({ public: model, profile: { id: model.profileId, provider: "openrouter", model: model.model, maxOutputTokens: 2000, timeoutMs: 10000, maxConcurrency: 1 }, provider: null, apiKey: "test-only" });

it("isolates sample tests by tenant and actor, preserves idempotency, and rejects changed retries", async () => {
  const app = Fastify();
  const authorization = vi.fn(async (request: any) => ({ tenantId: String(request.headers["x-tenant"] ?? "tenant-a"), subjectId: String(request.headers["x-actor"] ?? "author"), roles: ["Harness.Author"], actorType: "human" as const, source: "local" as const }));
  const execute = vi.fn<typeof executeDocumentStudio>(async (_input, run) => { run.status = "completed"; run.stage = "Complete"; });
  registerDocumentStudio(app, { db: {} as Database, env: {}, authorize: authorization, configuration, execute });
  try {
    const post = (input = payload, key = "sample-1") => app.inject({ method: "POST", url: "/v1/document-studio/tests", headers: { "idempotency-key": key }, payload: input });
    const response = await post();
    expect(response.statusCode, response.body).toBe(200);
    const run = response.json();
    expect(run.model).toEqual(model);
    expect(authorization.mock.calls.map(call => (call as unknown[])[1])).toEqual(["evidence.read", "draft.evaluate"]);
    expect((await post()).json().testId).toBe(run.testId);
    expect(execute).toHaveBeenCalledTimes(1);
    expect((await post({ ...payload, filename: "other.txt" })).statusCode).toBe(409);
    const url = `/v1/document-studio/tests/${run.testId}`;
    expect((await app.inject({ url })).json().status).toBe("completed");
    expect((await app.inject({ url, headers: { "x-tenant": "tenant-b" } })).statusCode).toBe(404);
    expect((await app.inject({ url, headers: { "x-actor": "another-author" } })).statusCode).toBe(404);
    const history = "/v1/document-studio/tests";
    const list = await app.inject({ url: history });
    expect(list.headers["cache-control"]).toBe("private, no-store");
    expect(list.json().items).toEqual([{
      testId: run.testId, documentVersion: run.documentVersion, documentType: "passport",
      filename: "sample.txt", status: "completed", createdAt: run.createdAt, model,
    }]);
    expect((await app.inject({ url: history, headers: { "x-tenant": "tenant-b" } })).json()).toEqual({ items: [] });
    expect((await app.inject({ url: history, headers: { "x-actor": "another-author" } })).json()).toEqual({ items: [] });
    expect((await app.inject({ method: "POST", url: "/v1/document-studio/tests", payload })).statusCode).toBe(400);
    expect((await post({ ...payload, contentBase64: "!!!" }, "bad-base64")).statusCode).toBe(400);
  } finally { await app.close(); }
});

it("reports missing configuration without admitting inference or retaining credentials", async () => {
  const app = Fastify();
  const execute = vi.fn();
  registerDocumentStudio(app, { db: {} as Database, env: {}, authorize: async () => ({ tenantId: "tenant-a", subjectId: "author", roles: ["Harness.Author"], actorType: "human", source: "local" }),
    configuration: async () => { throw new Error("document_studio.live_model_unavailable"); }, execute });
  try {
    expect((await app.inject({ url: "/v1/document-studio/configuration" })).json()).toEqual({ model: null, unavailableReason: "document_studio.live_model_unavailable" });
    expect((await app.inject({ method: "POST", url: "/v1/document-studio/tests", headers: { "idempotency-key": "test" }, payload })).statusCode).toBe(409);
    expect(execute).not.toHaveBeenCalled();
  } finally { await app.close(); }
});

it("binds preparation and live extraction to the sample version and renders only validated assertions", async () => {
  const version = "a".repeat(64);
  const pages = [{ object_type: "DocumentPage", object_id: "p1", data: { page: 1, document_version: version, text: "📄 Alice" } }];
  const adapter = { provider: "test-fixture", model: "test-model", providerRequestId: null, inputTokens: null, outputTokens: null, costUsd: null };
  vi.mocked(prepareDocument).mockResolvedValue({ ...adapter, output: { records: pages } });
  vi.mocked(invokeDocumentFieldsModel).mockResolvedValue({ ...adapter, output: { observations: [{ path: "/extracted_fields/name", confidence: 0.9 }] } });
  const request = { document_type: "passport", pages: [{ page_id: "p1", text: "📄 Alice", document_version: version }] };
  const validated = { path: "/extracted_fields/name", value: "Alice", contract_hash: version, source_spans: [{ page_id: "p1", start: 2, end: 7, quote: "Alice" }] };
  let valid = true;
  const host = vi.fn<typeof fetch>(async url => new Response(JSON.stringify(String(url).endsWith("/prepare") ? { request, classification: { classifications: [] } } : {
    classification: { classifications: [] }, extraction: {}, validity: {}, validation: { valid, candidate_assertions: valid ? [validated] : [], issues: valid ? [] : [{ code: "SOURCE_SPAN_MISMATCH" }] },
  }), { status: 200, headers: { "content-type": "application/json" } }));
  const fresh = (): StudioRun => ({ testId: "studio_test", documentId: "doc_" + version, documentVersion: version, documentType: "passport", filename: "sample.txt", model,
    status: "running", stage: "Queued", createdAt: new Date().toISOString(), finishedAt: null, error: null, records: [], skillOutputs: {}, validation: null, costUsd: null });
  const env = { EVIDENCE_PIPELINE_URL: "http://parser.test", EVIDENCE_PIPELINE_TOKEN: "test-parser-token", DOCUMENT_STUDIO_SKILL_HOST_URL: "http://skills.test", DOCUMENT_STUDIO_SKILL_HOST_TOKEN: "test-host-token" };
  const run = fresh();
  await executeDocumentStudio(payload, run, await configuration(), env, AbortSignal.timeout(10000), host);
  expect(run.status).toBe("completed");
  expect(vi.mocked(prepareDocument).mock.calls.at(-1)?.[0]).toMatchObject({ input: { caseId: run.testId, documentVersion: version, contentBase64: payload.contentBase64 } });
  // Without DOCUMENT_LAYOUT_REMOTE_ALLOWED the environment binds no layout provider.
  expect(vi.mocked(layoutProviderFromEnv).mock.calls.at(-1)?.[0]).toBe(env);
  expect(vi.mocked(prepareDocument).mock.calls.at(-1)?.[1]).toBeNull();
  expect(vi.mocked(invokeDocumentFieldsModel).mock.calls.at(-1)?.[0].input).toEqual(request);
  expect(run.records.at(-1)).toMatchObject({ object_type: "ExtractedAssertion", data: { field: "name", value: "Alice", extensions: { "ehf.document": { value: { source_spans: validated.source_spans, confidence: 0.9 } } } } });
  valid = false;
  const rejected = fresh();
  // The real adapter produces fresh normalization records for every test.
  vi.mocked(prepareDocument).mockResolvedValue({ ...adapter, output: { records: pages.slice(0, 1) } });
  await executeDocumentStudio(payload, rejected, await configuration(), env, AbortSignal.timeout(10000), host);
  expect(rejected.status).toBe("failed");
  expect(rejected.records.filter(row => row.object_type === "ExtractedAssertion")).toHaveLength(0);
  expect(rejected.validation?.issues).toEqual([{ code: "SOURCE_SPAN_MISMATCH" }]);
});

it("runs the model route in shadow beside the LLM route and records each field's outcome on its assertion", async () => {
  const version = "b".repeat(64);
  const pages = [{ object_type: "DocumentPage", object_id: "p1", data: { page: 1, document_version: version, text: "P123" } }];
  const adapter = { provider: "test-fixture", model: "test-model", providerRequestId: null, inputTokens: null, outputTokens: null, costUsd: null };
  vi.mocked(prepareDocument).mockResolvedValue({ ...adapter, output: { records: pages } });
  vi.mocked(invokeDocumentFieldsModel).mockResolvedValue({ ...adapter, output: { observations: [] } });
  const candidates = { contract: "document.model_fields.v1" as const, provider: "azure_document_intelligence", model: "prebuilt-idDocument", model_version: "2024-11-30",
    document_type: "passport", source_sha256: version, provider_document_type: null, provider_document_confidence: null, fields: [] };
  const extract = vi.fn(async (_content: Uint8Array, _documentType: string) => candidates);
  vi.mocked(documentModelProviderFromEnv).mockReturnValue({ id: "azure_document_intelligence", supports: type => type === "passport", extract });
  const validated = { path: "/extracted_fields/document_number", value: "P123", contract_hash: version, source_spans: [{ page_id: "p1", start: 0, end: 4, quote: "P123" }] };
  const adjudication = { routes: {}, route_errors: {}, policy: { digest: "c".repeat(64) }, inputs_digest: "d".repeat(64), outcomes: [{ path: "document_number", outcome: "AGREED_GROUNDED",
    rule: "R1", review: "standard", criticality: "critical", comparison: "equivalent", selected: { route: "llm" },
    candidates: { llm: { value: "P123", grounded: true, confidence: null, spans: [] }, azure_di: { value: "P123", grounded: true, confidence: 0.8 } } }] };
  const bodies: unknown[] = [];
  const host = vi.fn<typeof fetch>(async (url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify(String(url).endsWith("/prepare") ? { request: {}, classification: { classifications: [] } } : {
      classification: { classifications: [] }, extraction: { extractions: [{ adjudication }] }, validity: {}, validation: { valid: true, candidate_assertions: [validated], issues: [] },
    }), { status: 200, headers: { "content-type": "application/json" } });
  });
  const run: StudioRun = { testId: "studio_shadow", documentId: "doc_" + version, documentVersion: version, documentType: "passport", filename: "sample.txt", model,
    status: "running", stage: "Queued", createdAt: new Date().toISOString(), finishedAt: null, error: null, records: [], skillOutputs: {}, validation: null, costUsd: null };
  const env = { EVIDENCE_PIPELINE_URL: "http://parser.test", EVIDENCE_PIPELINE_TOKEN: "t", DOCUMENT_STUDIO_SKILL_HOST_URL: "http://skills.test", DOCUMENT_STUDIO_SKILL_HOST_TOKEN: "t" };
  await executeDocumentStudio(payload, run, await configuration(), env, AbortSignal.timeout(10000), host);
  expect(run.status).toBe("completed");
  expect(extract).toHaveBeenCalledWith(Uint8Array.from(Buffer.from(payload.contentBase64, "base64")), "passport");
  expect(bodies.at(-1)).toMatchObject({ modelRoute: { status: "answered", candidates } });
  expect(run.skillOutputs).toMatchObject({ modelRoute: { provider: "azure_document_intelligence", status: "answered", model: "prebuilt-idDocument" }, adjudication });
  expect(run.records.at(-1)).toMatchObject({ data: { value: "P123", extensions: { "ehf.document.adjudication": { value: {
    outcome: "AGREED_GROUNDED", proposed_route: "llm", candidates: { azure_di: { value: "P123", grounded: true, confidence: 0.8 } } } } } } });

  // A model route that fails is reported to the library as not answering; the test still completes.
  extract.mockRejectedValueOnce(new Error("adapter.document_layout_http_429"));
  const failed: StudioRun = { ...run, testId: "studio_shadow_2", status: "running", records: [], skillOutputs: {} };
  await executeDocumentStudio(payload, failed, await configuration(), env, AbortSignal.timeout(10000), host);
  expect(failed.status).toBe("completed");
  expect(bodies.at(-1)).toMatchObject({ modelRoute: { status: "failed", code: "adapter.document_layout_http_429" } });
});
