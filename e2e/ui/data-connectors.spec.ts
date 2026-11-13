import { expect, test, type Page } from "@playwright/test";
import { expectAccessible, signInAs } from "./support";

// Override reads before client initialization; MSW requests cannot be intercepted by page.route.
async function sourceResponses(page: Page, responses: Record<string, unknown>) {
  await page.addInitScript(responses => {
    const original = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const url = new URL(request.url, location.href);
      const body = responses[url.pathname];
      if (request.method === "GET" && body !== undefined) return Promise.resolve(new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } }));
      return original(input, init);
    };
  }, responses);
}

test("Context editing is reachable from the experience, product catalog, and Platform", async ({ page }) => {
  await signInAs(page, "context_architect", "/catalogs/context");
  await page.getByRole("navigation", { name: "Experiences" }).getByRole("link", { name: "Context", exact: true }).click();
  await expect(page).toHaveURL(/\/context$/);
  await expect(page.getByRole("navigation", { name: "Experiences" }).getByRole("link", { name: "Context", exact: true })).toHaveAttribute("aria-current", "page");
  await page.locator("header").getByRole("link", { name: "Edit context", exact: true }).click();
  await expect(page).toHaveURL(/\/platform\/data-sources\?product=party360/);
  await expect(page.getByRole("heading", { name: "Data sources", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Choose a source connector", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Explore Salesforce / FSC", exact: true }).click();
  await page.getByRole("dialog", { name: "Salesforce / FSC", exact: true }).getByRole("button", { name: /^(Configure|View setup for) Salesforce \/ FSC$/ }).click();
  await expect(page.getByRole("heading", { name: "Bank API sources" })).toBeVisible();
  await page.getByRole("tablist",{name:"Data source sections"}).getByRole("tab",{name:"Status",exact:true}).click();
  await expect(page.getByRole("navigation", { name: "Platform", exact: true }).getByRole("link", { name: "Data sources" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("table", { name: "Shared data connections" })).toContainText("No source connections configured");
  await expectAccessible(page);
  await page.goto("/catalogs/context");
  await page.getByRole("link", { name: "Edit context · Connections and mappings" }).click();
  await expect(page.getByRole("heading", { name: "Data sources", exact: true })).toBeVisible();
});

test("Platform renders saved source configuration and identifies an outdated enabled mapping", async ({ page }) => {
  const digest = "a".repeat(64);
  const revision = (definition: unknown) => ({ definition, digest, revision: 2, createdAt: "2026-11-09T12:00:00Z", createdBy: "test" });
  await sourceResponses(page, {
    "/api/v1/context/definitions": { items: [
      revision({ kind: "connection", id: "crm", name: "Customer CRM", connectorId: "context-postgres:crm", identityMode: "service" }),
      revision({ kind: "resource", id: "customers", connectionId: "crm", schema: "public", table: "customer_view", schemaFingerprint: digest }),
      revision({ kind: "mapping", id: "customer-party", name: "Customer to Party", resourceId: "customers" }),
    ] },
    "/api/v1/context/mappings/customer-party/enablement": { enablement: { paused: false, mappingDigest: "b".repeat(64), revision: 1 } },
  });
  await signInAs(page, "context_architect", "/platform/data-connectors");
  await expect(page.getByRole("table", { name: "Shared data connections" })).toContainText("Customer CRM");
  await expect(page.getByRole("table", { name: "Source resources", exact: true })).toContainText("public.customer_view");
  await expect(page.getByRole("region", { name: "Mapping status" })).toContainText("Saved revision differs from enabled revision");
  await expect(page.getByRole("link", { name: "Edit mapping and inspect qualification" })).toHaveAttribute("href", "/context/mappings/customer-party");
  await expectAccessible(page);
});

test("Calls show only context acquisition receipts with latency, results and run links", async ({ page }) => {
  const receipt = { receiptId: "source-call", occurredAt: "2026-11-09T12:00:00Z", runId: "run-source", capabilityId: "context.records.fetch.v1", adapterBindingId: "crm", decision: "allowed", resultStatus: "failed", latencyMs: 87, reasonCode: "provider.timeout" };
  await sourceResponses(page, { "/api/v1/gateway/decisions": { items: [receipt, { ...receipt, receiptId: "model-call", capabilityId: "model.general.inference.v1", adapterBindingId: "unrelated-model" }], nextCursor: "older-page" } });
  await signInAs(page, "auditor", "/platform/data-connectors?tab=calls");
  const table = page.getByRole("table", { name: "Source call receipts" });
  await expect(table).toContainText("87 ms");
  await expect(table).toContainText("failed");
  await expect(table).not.toContainText("unrelated-model");
  await expect(table.getByRole("link", { name: "run-source" })).toHaveAttribute("href", "/platform/runs/run-source");
  await page.getByRole("button", { name: "Older receipts" }).click();
  await expect(page).toHaveURL(/cursor=older-page/);
  await page.getByRole("searchbox", { name: "Run ID" }).fill("run-source");
  await expect(page).toHaveURL(/run=run-source/);
  await expect(page).not.toHaveURL(/cursor=/);
  await expectAccessible(page);
});

test("Refresh history exposes quarantine and committed checkpoints", async ({ page }) => {
  await sourceResponses(page, { "/api/v1/context/refresh-schedules": { schedules: [{
    id: "hourly-crm", revision: 1, definition: { enabled: true, mappingId: "customer-party", intervalMinutes: 60 },
    next_due: "2026-11-09T13:00:00Z", completed_through: "2026-11-09T11:00:00Z", last_success_at: "2026-11-09T11:01:00Z",
    latest_batch: { status: "QUARANTINED" }, history: [{ revision: 1, slot: "2026-11-09T12:00:00Z", attempt: 2, status: "QUARANTINED", error_code: "context.schema_changed", run_id: "run-refresh" }],
  }] } });
  await signInAs(page, "context_architect", "/platform/data-connectors?tab=refresh");
  const history = page.getByRole("region", { name: "Refresh hourly-crm", exact: true });
  await expect(history).toContainText("Completed through");
  await expect(history).toContainText("context.schema_changed");
  await expect(history.getByRole("link", { name: "run-refresh" })).toHaveAttribute("href", "/platform/runs/run-refresh");
  await expectAccessible(page);
});

test("Source configuration remains hidden from roles without draft.read", async ({ page }) => {
  await signInAs(page, "cdd_analyst", "/platform/runs");
  await expect(page.getByRole("navigation", { name: "Experiences" }).getByRole("link", { name: "Context", exact: true })).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "Platform", exact: true }).getByRole("link", { name: "Data connectors" })).toHaveCount(0);
  await page.goto("/platform/data-connectors");
  await expect(page.getByRole("heading", { name: "Data connectors is not available to you" })).toBeVisible();
});
