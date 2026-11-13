import { expect, test } from "@playwright/test";
import type { Upstream } from "../../apps/experience-bff/src/upstream";
import { expectAccessible } from "./support";

// Run against an HTTP-mode Vite instance. Only provider execution is a fixture;
// browser requests pass through the actual BFF session, CSRF and document projection.
test.skip(!process.env.DOCUMENT_STUDIO_UI_FIXTURE || !process.env.CONTEXT_HTTP_URL, "Requires an HTTP-mode UI for the isolated BFF fixture.");
test("studio links extracted fields to annotated source, inspects schema, and exports the tested version", async ({ page }) => {
  // Keep service implementation files out of the browser suite's TS project.
  const { buildApp } = await import("../../apps/experience-bff/src/" + "app.ts");
  const version = "a".repeat(64);
  const model = { profileId: "model.standard.v1", profileDigest: version, provider: "openrouter", model: "test-provider-fixture" };
  const raw = { testId: "studio_ui_test", documentId: "doc_12345678", documentType: "certificate_of_incorporation", filename: "certificate_of_incorporation.txt", documentVersion: version,
    status: "completed", stage: "Complete", createdAt: "2026-11-10T12:00:00Z", finishedAt: "2026-11-10T12:00:01Z", error: null, model, costUsd: null,
    skillOutputs: { classification: { classifications: [{ document_type: "certificate_of_incorporation" }] } }, validation: { valid: true, issues: [] }, records: [
      { object_type: "DocumentVersion", object_id: "version1", data: { document_id: "doc_12345678", artifact_hash: version, media_type: "text/plain", page_count: 1 } },
      { object_type: "DocumentPage", object_id: "page1", data: { document_version: version, page: 1, text: "📄 Certificate of incorporation\nAcme" } },
      { object_type: "ExtractedAssertion", object_id: "assertion1", version_id: "v1", data: { document_version: version, field: "entity_name", value: "Acme",
        extensions: { "ehf.document": { value: { path: "/extracted_fields/entity_name", source_spans: [{ page_id: "page1", start: 31, end: 35, quote: "Acme" }] } } } } },
    ] };
  const calls: Array<{ method: string; path: string; body: any }> = [];
  let configured = false;
  const upstream: Upstream = async (_service, method, path, _principal, body) => {
    calls.push({ method, path, body });
    if (path.endsWith("/configuration")) return { status: 200, body: configured ? { model, unavailableReason: null } : { model: null, unavailableReason: "document_studio.services_not_configured" } };
    if (method === "POST" && path.endsWith("/tests")) return { status: 200, body: { ...raw, status: "running", stage: "Queued", finishedAt: null, records: [] } };
    if (path.endsWith("/studio_ui_test")) return { status: 200, body: raw };
    return { status: 503, body: { error: "fixture.operation_unavailable" } };
  };
  const app = buildApp({ env: { BFF_PUBLIC_ORIGIN: process.env.CONTEXT_HTTP_URL }, principalResolver: { source: "local", resolve: async () => ({ subjectId: "studio-author", tenantId: "studio-tests", roles: ["Harness.Author"], actorType: "human", source: "local" }) }, upstream });
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/**", async route => {
    const request = route.request();
    const response = await app.inject({ method: request.method() as "GET" | "POST", url: new URL(request.url()).pathname + new URL(request.url()).search,
      headers: await request.allHeaders(), ...(request.postData() ? { payload: request.postData()! } : {}) });
    await route.fulfill({ status: response.statusCode, headers: Object.fromEntries(Object.entries(response.headers).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)])), body: response.body });
  });
  try {
    await page.goto("/platform/document-studio?documentType=certificate_of_incorporation");
    await expect(page.getByLabel(/Document type ·/)).toHaveValue("certificate_of_incorporation");
    expect(await page.getByLabel(/Document type ·/).locator("option").count()).toBeGreaterThan(290);
    await expect(page.getByText("Live document extraction is unavailable.", { exact: false })).toBeVisible();
    await expect(page.getByRole("button", { name: "Run document test", exact: true })).toBeDisabled();
    await page.getByRole("link", { name: "Inspect field contract", exact: true }).click();
    await page.getByRole("link", { name: "Test in Document Studio", exact: false }).click();
    await expect(page).toHaveURL(/document-studio\?documentType=certificate_of_incorporation/);
    configured = true;
    await page.getByRole("button", { name: "Check configuration again", exact: true }).click();
    await expect(page.getByText("test-provider-fixture", { exact: true })).toBeVisible();
    await page.getByRole("radio", { name: "Document text", exact: true }).click();
    await page.getByLabel("Sample document text", { exact: true }).fill("📄 Certificate of incorporation\nAcme");
    await page.getByRole("button", { name: "Run document test", exact: true }).click();
    const fields = page.getByRole("region", { name: "Extracted data", exact: true });
    await expect(fields.getByRole("button", { name: "entity name", exact: true })).toBeVisible();
    await fields.getByRole("button", { name: "entity name", exact: true }).click();
    const source = page.getByRole("region", { name: "Document viewer", exact: true });
    await expect(source.locator('[data-ref="assertion1"]')).toContainText("Acme");
    await expect(fields.getByRole("button", { name: "Mark reviewed", exact: true })).toHaveCount(0);
    await fields.getByRole("radio", { name: "Schema", exact: true }).click();
    await expect(fields.getByRole("table", { name: "Document field contract", exact: true })).toBeVisible();
    await fields.getByRole("radio", { name: "JSON", exact: true }).click();
    await expect(fields).toContainText("Acme");
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export test JSON", exact: true }).click();
    expect((await download).suggestedFilename()).toBe("certificate_of_incorporation.txt.studio.json");
    await expectAccessible(page);
    await fields.getByRole("radio", { name: "Fields", exact: true }).click();
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: "/tmp/ehf-document-studio-desktop.png", fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("radio", { name: "Extracted fields", exact: true }).click();
    await expect(fields).toBeVisible();
    await expectAccessible(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(calls.filter(call => call.method === "POST")).toHaveLength(1);
    expect(calls.find(call => call.method === "POST")?.body).toMatchObject({ documentType: "certificate_of_incorporation", filename: "certificate_of_incorporation.txt" });
    expect(errors).toEqual([]);
  } finally { await app.close(); }
});

test("studio shows the extraction routes side by side and links a field to its citation", async ({ page }) => {
  const { buildApp } = await import("../../apps/experience-bff/src/" + "app.ts");
  const version = "b".repeat(64);
  const model = { profileId: "model.document.v1", profileDigest: version, provider: "openrouter", model: "anthropic/claude-sonnet-5.5" };
  const text = "📄 Passport\nPassport No. P1234567\nSurname EXAMPLE Given names ALEX\nDate of birth 1990-04-01\nDate of issue 2020-04-01";
  // Source spans count Unicode code points, not UTF-16 units (the page starts with an emoji).
  const at = (quote: string) => [...text.slice(0, text.indexOf(quote))].length;
  const candidate = (value: string | null, grounded: boolean, confidence: number | null = null) => ({ value, grounded, confidence, spans: [] });
  const adjudication = {
    document_type: "passport", routes: { azure_di: { status: "valid", issues: [] }, llm: { status: "valid", issues: [] } }, route_errors: {},
    policy: { id: "ehf.default-adjudication", version: "0.1.0", digest: "c".repeat(64) }, inputs_digest: "d".repeat(64), review_required: true,
    counts: { AGREED_GROUNDED: 1, CONFLICT: 1, SINGLE_ROUTE: 1 },
    outcomes: [
      { path: "document_number", field: "document_number", key_field: true, criticality: "critical", outcome: "AGREED_GROUNDED", rule: "R1", review: "standard", comparison: "equivalent",
        selected: { route: "llm", value: "P1234567", spans: [] }, candidates: { azure_di: candidate("P1234567", true, 0.81), llm: candidate("P1234567", true) } },
      { path: "date_of_birth", field: "date_of_birth", key_field: true, criticality: "critical", outcome: "CONFLICT", rule: "R6", review: "required", comparison: "different",
        selected: null, candidates: { azure_di: candidate("2020-04-01", true, 0.42), llm: candidate("1990-04-01", true) } },
      { path: "person_name", field: "person_name", key_field: true, criticality: "critical", outcome: "SINGLE_ROUTE", rule: "R3", review: "required", comparison: null,
        selected: { route: "llm", value: "ALEX EXAMPLE", spans: [] }, candidates: { azure_di: candidate(null, false), llm: candidate("ALEX EXAMPLE", false) } },
    ] };
  const assertion = (field: string, value: string, start: number) => ({ object_type: "ExtractedAssertion", object_id: `studio_routes:/extracted_fields/${field}`, version_id: "v1",
    data: { document_version: version, field, value, extensions: { "ehf.document": { value: { path: `/extracted_fields/${field}`, source_spans: [{ page_id: "page1", start, end: start + value.length, quote: value }] } } } } });
  const raw = { testId: "studio_routes", documentId: "doc_12345678", documentType: "passport", filename: "passport.txt", documentVersion: version,
    status: "completed", stage: "Complete", createdAt: "2026-11-13T12:00:00Z", finishedAt: "2026-11-13T12:00:02Z", error: null, model, costUsd: 0.004,
    skillOutputs: { classification: { classifications: [{ document_type: "passport" }] }, adjudication,
      modelRoute: { provider: "azure_document_intelligence", status: "answered", code: null, model: "prebuilt-idDocument", modelVersion: "2024-11-30", candidates: [] } },
    validation: { valid: true, issues: [] }, records: [
      { object_type: "DocumentVersion", object_id: "version1", data: { document_id: "doc_12345678", artifact_hash: version, media_type: "text/plain", page_count: 1 } },
      { object_type: "DocumentPage", object_id: "page1", data: { document_version: version, page: 1, text } },
      assertion("document_number", "P1234567", at("P1234567")), assertion("date_of_birth", "1990-04-01", at("1990-04-01")),
    ] };
  const upstream: Upstream = async (_service, method, path) => {
    if (path.endsWith("/configuration")) return { status: 200, body: { model, unavailableReason: null } };
    if (method === "POST" && path.endsWith("/tests")) return { status: 200, body: { ...raw, status: "running", stage: "Queued", finishedAt: null, records: [], skillOutputs: {} } };
    if (path.endsWith("/studio_routes")) return { status: 200, body: raw };
    return { status: 503, body: { error: "fixture.operation_unavailable" } };
  };
  const app = buildApp({ env: { BFF_PUBLIC_ORIGIN: process.env.CONTEXT_HTTP_URL }, principalResolver: { source: "local", resolve: async () => ({ subjectId: "studio-author", tenantId: "studio-tests", roles: ["Harness.Author"], actorType: "human", source: "local" }) }, upstream });
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/**", async route => {
    const request = route.request();
    const response = await app.inject({ method: request.method() as "GET" | "POST", url: new URL(request.url()).pathname + new URL(request.url()).search,
      headers: await request.allHeaders(), ...(request.postData() ? { payload: request.postData()! } : {}) });
    await route.fulfill({ status: response.statusCode, headers: Object.fromEntries(Object.entries(response.headers).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)])), body: response.body });
  });
  try {
    await page.goto("/platform/document-studio?documentType=passport");
    await page.getByRole("radio", { name: "Document text", exact: true }).click();
    await page.getByLabel("Sample document text", { exact: true }).fill(text);
    await page.getByRole("button", { name: "Run document test", exact: true }).click();
    const routes = page.getByRole("region", { name: "Extraction routes", exact: true });
    await expect(routes).toBeVisible();
    await expect(routes.getByRole("list", { name: "Routes" })).toContainText("LLM contract extraction · proposed");
    await expect(routes.getByRole("list", { name: "Routes" })).toContainText("Azure prebuilt model · shadow");
    await expect(routes).toContainText("2 fields need review");
    const table = routes.getByRole("table");
    await expect(table.getByRole("row")).toHaveCount(3);
    await expect(table).toContainText("Routes disagree");
    await expect(table).toContainText("2020-04-01");
    await expect(table).not.toContainText("Routes agree");
    await routes.getByRole("radio", { name: "All fields (3)", exact: true }).click();
    await expect(table.getByRole("row")).toHaveCount(4);
    await table.getByRole("button", { name: "date of birth", exact: true }).click();
    await expect(table.getByRole("button", { name: "date of birth", exact: true })).toHaveAttribute("aria-pressed", "true");
    const source = page.getByRole("region", { name: "Document viewer", exact: true });
    await expect(source.locator('[data-ref="studio_routes:/extracted_fields/date_of_birth"]')).toContainText("1990-04-01");
    await expectAccessible(page);
    await routes.scrollIntoViewIfNeeded();
    await page.screenshot({ path: "/tmp/ehf-document-studio-routes.png", fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(routes).toBeVisible();
    await expectAccessible(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: "/tmp/ehf-document-studio-routes-mobile.png", fullPage: true });
    expect(errors).toEqual([]);
  } finally { await app.close(); }
});
