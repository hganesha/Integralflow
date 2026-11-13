import { expect, test } from "@playwright/test";
import { expectAccessible, mock, signInAs } from "./support";
const documents = "/work/cases/KYB-1042/lens/documents";
test("document review links source spans, records a correction, and retains the original", async ({ page }) => {
  await signInAs(page, "cdd_analyst", documents);
  await page.getByRole("button", { name: "meridian-shareholder-register.txt", exact: true }).click();
  await expect(page.getByRole("region", { name: "Document viewer", exact: true })).toBeVisible();
  await expect(page).toHaveURL(/document=doc_/);
  const fields = page.getByRole("region", { name: "Extracted data", exact: true });
  await fields.getByRole("button", { name: "entity name", exact: true }).click();
  await expect(page).toHaveURL(/field=extraction/);
  const field = fields.locator("article").filter({ has: page.getByRole("button", { name: "entity name", exact: true }) });
  await field.getByRole("button", { name: "Edit value", exact: true }).click();
  await field.getByLabel("Corrected entity_name").fill("Reviewed Trading Ltd");
  await field.getByRole("button", { name: "Review correction", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Record document review" });
  await sheet.getByLabel("Review rationale").fill("Compared the legal name with the cited source.");
  await sheet.getByRole("button", { name: "Record review", exact: true }).click();
  await expect(sheet).toHaveCount(0);
  await expect(field.getByText("Reviewed Trading Ltd", { exact: true })).toBeVisible();
  await expect(field.getByText("Human correction", { exact: true })).toBeVisible();
  await field.getByText("Original extracted value", { exact: true }).click();
  await expect(field.getByText("Example Trading", { exact: true })).toBeVisible();
  await fields.getByRole("radio", { name: "JSON", exact: true }).click();
  await expect(fields).toContainText("Reviewed Trading Ltd");
  await fields.getByRole("radio", { name: "Schema", exact: true }).click();
  await expect(fields.getByRole("table", { name: "Document field contract", exact: true })).toBeVisible();
  await expectAccessible(page);
});

test("document deep links survive reload and viewers have no review affordances", async ({ page }) => {
  await signInAs(page, "relationship_manager", documents);
  await page.getByRole("button", { name: "meridian-shareholder-register.txt", exact: true }).click();
  await page.getByRole("button", { name: "entity name", exact: true }).click();
  const url = page.url(); await page.reload();
  await expect(page).toHaveURL(url);
  await expect(page.getByRole("region", { name: "Extracted data", exact: true })).toContainText("Example Trading");
  await expect(page.getByRole("button", { name: "Mark reviewed", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Edit value", exact: true })).toHaveCount(0);
  const download = page.waitForEvent("download"); await page.getByRole("button", { name: "Export JSON", exact: true }).click();
  expect((await download).suggestedFilename()).toContain("extraction.json");
  await expectAccessible(page);
});

test("an unsaved correction survives schema loading and field regrouping", async ({ page }) => {
  await signInAs(page, "cdd_analyst", documents);
  await mock(page, "PUT", "/mock/faults", { latencyMs: 2500 });
  await page.getByRole("button", { name: "meridian-shareholder-register.txt", exact: true }).click();
  const fields = page.getByRole("region", { name: "Extracted data", exact: true });
  const field = fields.locator("article").filter({ has: page.getByRole("button", { name: "entity name", exact: true }) });
  await field.getByRole("button", { name: "Edit value", exact: true }).click();
  await field.getByLabel("Corrected entity_name").fill("Unsaved correction survives regrouping");
  await expect(fields.locator("summary").filter({ hasText: /^legal/i })).toBeVisible({ timeout: 10_000 });
  await expect(field.getByLabel("Corrected entity_name")).toHaveValue("Unsaved correction survives regrouping");
  await field.getByRole("button", { name: "Review correction", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Record document review" })).toContainText("Unsaved correction survives regrouping");
});

test("mobile document review switches between source and extracted values", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signInAs(page, "cdd_analyst", documents);
  await page.getByRole("button", { name: "meridian-shareholder-register.txt", exact: true }).click();
  const switcher = page.getByRole("radiogroup", { name: "Review workspace", exact: true });
  await expect(page.getByRole("region", { name: "Document viewer", exact: true })).toBeVisible();
  await switcher.getByRole("radio", { name: "Extracted data", exact: true }).click();
  await expect(page.getByRole("region", { name: "Extracted data", exact: true })).toBeVisible();
  await expectAccessible(page);
});

test("run workflow uses recorded attempts and offers an accessible table", async ({ page }) => {
  await signInAs(page, "ops_manager", "/platform/runs/run_kyb_1042");
  await expect(page.getByRole("combobox", { name: "Execution attempt", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Show as table", exact: true }).click();
  const table = page.getByRole("table", { name: /plan graph: nodes/ });
  await expect(table).toContainText("Completed");
  await expect(table).toContainText("Waiting for a person");
  await table.getByRole("button", { name: "Ownership review", exact: true }).click();
  await expect(page.getByRole("complementary", { name: "Execution step inspector", exact: true })).toContainText("Waiting for a person");
  await expectAccessible(page);
});

test("uploaded PDFs render original pages and preserve multi-page navigation", async ({ page }) => {
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << >> /Contents 5 0 R >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << >> /Contents 6 0 R >>", "<< /Length 0 >>\nstream\n\nendstream", "<< /Length 0 >>\nstream\n\nendstream"];
  let pdf = "%PDF-1.4\n"; const offsets = [0];
  for (const [index, object] of objects.entries()) { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; }
  const start = Buffer.byteLength(pdf); pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  await signInAs(page, "cdd_analyst", documents);
  await page.getByLabel("Add documentary evidence").setInputFiles({ name: "two-page-evidence.pdf", mimeType: "application/pdf", buffer: Buffer.from(pdf) });
  await page.getByRole("button", { name: "two-page-evidence.pdf", exact: true }).click();
  await page.getByRole("button", { name: "View original", exact: true }).click();
  await expect(page.getByRole("img", { name: "Original document page 1", exact: true })).toBeVisible();
  await expect(page.getByLabel("Document page", { exact: true })).toContainText("Page 2 of 2");
  await page.getByRole("button", { name: "Next page", exact: true }).click();
  await expect(page.getByRole("img", { name: "Original document page 2", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Fit document to width", exact: true }).click();
  await expectAccessible(page);
});
test("a route conflict is shown on its field and resolved by keeping one route's reading", async ({ page }) => {
  await signInAs(page, "cdd_analyst", documents);
  await page.getByRole("button", { name: "director-passport.txt", exact: true }).click();
  const fields = page.getByRole("region", { name: "Extracted data", exact: true });
  const work = fields.getByRole("region", { name: "Document work items" });
  await expect(work).toContainText("Route conflict · open");
  await work.getByRole("button", { name: "Go to field", exact: true }).click();
  await expect(page).toHaveURL(/field=extraction%3A.*date_of_birth|field=extraction:.*date_of_birth/);
  const field = fields.locator("article").filter({ has: page.getByRole("button", { name: "date of birth", exact: true }) });
  await expect(field.getByText("Routes disagree", { exact: true })).toBeVisible();
  const readings = field.getByRole("list", { name: "Route readings for date of birth" });
  await expect(readings).toContainText("Document model: \"2030-05-31\" · found in the text");
  await expect(fields.locator("article").filter({ has: page.getByRole("button", { name: "document number", exact: true }) }).getByText("Routes agree", { exact: true })).toBeVisible();
  await expectAccessible(page);
  await readings.getByRole("listitem").filter({ hasText: "LLM extraction" }).getByRole("button", { name: "Keep this reading", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Record document review" });
  await expect(sheet).toContainText("keeps the LLM extraction reading");
  await expect(sheet).toContainText("Resolves 1 route conflict.");
  await sheet.getByLabel("Review rationale").fill("The printed birth date is 1987-04-12; the model read the expiry date.");
  await sheet.getByRole("button", { name: "Record review", exact: true }).click();
  await expect(sheet).toHaveCount(0);
  await expect(work).toContainText("Route conflict · resolved");
  await expect(field.getByText("Route conflict resolved.", { exact: true })).toBeVisible();
  await expect(field.getByText("Reviewed", { exact: true })).toBeVisible();
  await expect(readings.getByRole("button", { name: "Keep this reading" })).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("radio", { name: "Extracted data", exact: true }).click();
  await expectAccessible(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
