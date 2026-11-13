import { expect, it, vi } from "vitest";
import { validateResponse } from "@ehf/ui-contracts/validate";
import { buildApp } from "./app.js";
import type { Upstream } from "./upstream.js";

it("protects studio mutations and composes exact source annotations without case writes", async () => {
  const principal = { subjectId: "author", tenantId: "tenant-tests", actorType: "human" as const, roles: ["Harness.Author"], source: "local" as const };
  const version = "a".repeat(64);
  const raw = { testId: "studio-test", documentId: "doc_12345678", documentType: "passport", filename: "sample.txt", documentVersion: version,
    status: "completed", stage: "Complete", createdAt: "2026-11-10T12:00:00Z", finishedAt: "2026-11-10T12:00:01Z", error: null,
    model: { profileId: "model.standard.v1", profileDigest: version, provider: "openrouter", model: "configured-model" }, costUsd: 0.001,
    skillOutputs: {}, validation: { valid: true, candidate_assertions: [] }, records: [
      { object_type: "DocumentVersion", object_id: "version1", data: { document_id: "doc_12345678", artifact_hash: version, media_type: "text/plain", page_count: 1 } },
      { object_type: "DocumentPage", object_id: "page1", data: { document_version: version, page: 1, text: "📄 Passport Alice" } },
      { object_type: "ExtractedAssertion", object_id: "assertion1", version_id: "v1", data: { document_version: version, field: "name", value: "Alice",
        extensions: { "ehf.document": { value: { path: "/extracted_fields/name", source_spans: [{ page_id: "page1", start: 11, end: 16, quote: "Alice" }] } } } } },
    ] };
  const summary = { testId: raw.testId, documentVersion: version, documentType: raw.documentType,
    filename: raw.filename, status: raw.status, createdAt: raw.createdAt, model: raw.model };
  const upstream = vi.fn<Upstream>(async (_service, method, path) => ({
    status: 200, body: method === "GET" && path.endsWith("/tests") ? { items: [summary] } : raw,
  }));
  const app = buildApp({ env: { BFF_PUBLIC_ORIGIN: "http://ui.test", BFF_IDENTITY_MODE: "delegated" }, principalResolver: { source: "local", resolve: async () => principal }, upstream });
  try {
    const session = await app.inject({ url: "/api/v1/session", headers: { authorization: "Bearer author-session" } });
    const headers = { cookie: String(session.headers["set-cookie"]).split(";")[0]!, origin: "http://ui.test", "x-csrf-token": session.json().csrfToken, "idempotency-key": "studio-key" };
    const url = "/api/v1/document-studio/tests";
    const payload = { documentType: "passport", filename: "sample.txt", mediaType: "text/plain", contentBase64: "UGFzc3BvcnQ=" };
    expect((await app.inject({ method: "POST", url, payload })).statusCode).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
    const response = await app.inject({ method: "POST", url, payload, headers });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json();
    expect(validateResponse("postDocumentStudioTests", 200, body)).toMatchObject({ valid: true });
    expect(body.detail.document.documentType).toBe("passport");
    expect(body.detail.pages[0].highlights).toContainEqual({ start: 11, end: 16, kind: "assertion", field: "name", ref: "assertion1" });
    expect(body.detail.assertions[0]).toMatchObject({ verification: "UNVERIFIED", review: null });
    expect(body.records).toBeUndefined();
    expect(upstream.mock.calls[0]?.slice(0, 3)).toEqual(["control-api", "POST", "/v1/document-studio/tests"]);
    expect(upstream.mock.calls[0]?.[5]).toMatchObject({ "idempotency-key": "studio-key", "x-ehf-forwarded-authorization": "Bearer author-session" });
    principal.roles = ["Harness.Reader"];
    expect((await app.inject({ method: "POST", url, payload, headers })).statusCode).toBe(403);
    expect((await app.inject({ url: url + "/studio-test", headers })).statusCode).toBe(200);
    const list = await app.inject({ url, headers });
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json()).toEqual({ items: [summary] });
    expect(validateResponse("getDocumentStudioTests", 200, list.json())).toMatchObject({ valid: true });
    expect(upstream.mock.calls.every(call => call[0] === "control-api")).toBe(true);
  } finally { await app.close(); }
});

it("shows the extraction routes side by side, linked to the proposed assertions", async () => {
  const { routeComparison, studioView } = await import("./document-studio.js");
  const version = "b".repeat(64);
  const adjudication = { routes: { azure_di: { status: "valid", issues: [] }, llm: { status: "valid", issues: [] } }, route_errors: {},
    policy: { id: "ehf.default-adjudication", version: "0.1.0", digest: "c".repeat(64) }, counts: { AGREED_GROUNDED: 1, CONFLICT: 1 }, review_required: true,
    outcomes: [
      { path: "document_number", field: "document_number", key_field: true, criticality: "critical", outcome: "AGREED_GROUNDED", rule: "R1", review: "standard", comparison: "equivalent",
        selected: { route: "llm", value: "P123", spans: [] }, candidates: { llm: { value: "P123", grounded: true, confidence: null }, azure_di: { value: "P123", grounded: true, confidence: 0.8 } } },
      { path: "accounts/0/closing_balance", field: "accounts", key_field: true, criticality: "critical", outcome: "CONFLICT", rule: "R6", review: "required", comparison: "different",
        selected: null, candidates: { llm: { value: "10.00", grounded: true }, azure_di: { value: 10, grounded: true, confidence: 0.4 } } },
    ] };
  const run = { testId: "t", documentId: "doc_12345678", documentType: "passport", filename: "p.txt", documentVersion: version, status: "completed", stage: "Complete",
    createdAt: "2026-11-13T12:00:00Z", finishedAt: "2026-11-13T12:00:01Z", error: null, costUsd: null, validation: null,
    model: { profileId: "model.document.v1", profileDigest: version, provider: "openrouter", model: "anthropic/claude-sonnet-5.5" },
    skillOutputs: { adjudication, modelRoute: { provider: "azure_document_intelligence", status: "answered", code: null, model: "prebuilt-idDocument" } },
    records: [
      { object_type: "DocumentVersion", object_id: "v", data: { document_id: "doc_12345678", artifact_hash: version, media_type: "text/plain", page_count: 1 } },
      { object_type: "DocumentPage", object_id: "p1", data: { document_version: version, page: 1, text: "Passport P123" } },
      { object_type: "ExtractedAssertion", object_id: "t:/extracted_fields/document_number", version_id: "v1", data: { document_version: version, field: "document_number", value: "P123",
        extensions: { "ehf.document": { value: { path: "/extracted_fields/document_number", source_spans: [{ page_id: "p1", start: 9, end: 13, quote: "P123" }] } } } } },
    ] };
  const view = studioView(run);
  expect(validateResponse("getDocumentStudioTestsTestId", 200, view)).toMatchObject({ valid: true });
  expect(view.routes?.routes).toEqual([
    { route: "azure_di", label: "Azure prebuilt model", provider: "azure_document_intelligence", model: "prebuilt-idDocument", status: "valid", error: null, issues: [] },
    { route: "llm", label: "LLM contract extraction", provider: "openrouter", model: "anthropic/claude-sonnet-5.5", status: "valid", error: null, issues: [] },
  ]);
  expect(view.routes?.fields[0]).toMatchObject({ outcome: "AGREED_GROUNDED", assertionId: "t:/extracted_fields/document_number", selectedRoute: "llm" });
  expect(view.routes?.fields[1]).toMatchObject({ outcome: "CONFLICT", assertionId: null, candidates: [{ route: "llm", value: "10.00", confidence: null }, { route: "azure_di", value: "10", confidence: 0.4 }] });
  const failed = routeComparison({ ...run, skillOutputs: { adjudication: { ...adjudication, routes: { ...adjudication.routes, azure_di: { status: "not_run", issues: [] } }, route_errors: { azure_di: "adapter.document_layout_http_429" } },
    modelRoute: { provider: "azure_document_intelligence", status: "failed", code: "adapter.document_layout_http_429", model: null } } }, []);
  expect(failed?.routes[0]).toMatchObject({ status: "not_run", error: "adapter.document_layout_http_429" });
  expect(studioView({ ...run, skillOutputs: {} }).routes).toBeNull();
});
