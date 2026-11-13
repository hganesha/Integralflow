import { expect, test, type Page } from "@playwright/test";
import { expectAccessible, mock, signInAs } from "./support";

// End-to-end journeys B, F and G (BUILD-SPEC v2 §11.3). Each journey stays in one page load
// so the in-page mock keeps its state across personas; navigation happens inside the SPA.

// The DRAFT-status fixture draft, so the journey starts at compile.
const DRAFT = "draft_6f1c2c3e-0000-4000-8000-000000000002";
const PLAN = "bcd282f4fea36064672d780fc58478330b105effb706a2727e20794bf82162f8";

async function go(page: Page, path: string): Promise<void> {
  await page.evaluate((to) => {
    window.history.pushState({}, "", to);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, path);
}

async function become(page: Page, personaId: string, displayName: string): Promise<void> {
  await mock(page, "PUT", "/mock/session", { personaId });
  // The name shows in the identity cluster and again inside the collapsed account menu.
  await expect(page.getByRole("banner").getByText(displayName, { exact: true }).first()).toBeVisible();
}

test("Journey B · author and release: the author compiles and evaluates, cannot approve; an approver approves and publishes; an operator activates the release", async ({ page }) => {
  await signInAs(page, "agent_architect", `/studio/drafts/${DRAFT}?tab=release`);
  await page.getByRole("button", { name: "Validate & compile" }).click();
  await expect(page.getByLabel("Lifecycle: COMPILED")).toBeVisible();
  await page.getByRole("button", { name: "Run evaluation gates" }).click();
  await expect(page.getByText("Run evaluation gates completed.")).toBeVisible();
  await expect(page.getByLabel("Lifecycle: EVALUATED")).toBeVisible();
  const approve = page.getByRole("button", { name: "Approve", exact: true });
  await expect(approve).toBeDisabled();
  await expect(page.getByText(/Needs a different approver \(separation of duties\)/).first()).toBeVisible();

  await become(page, "harness_approver", "E. Kowalski");
  await expect(approve).toBeEnabled();
  await approve.click();
  await expect(page.getByText("Approve completed.")).toBeVisible();
  await page.getByRole("button", { name: "Publish immutable plan" }).click();
  await expect(page.getByLabel("Lifecycle: PUBLISHED")).toBeVisible();

  // The approver approves the release candidate; an operator activates it.
  await go(page, "/studio/published");
  await page.getByRole("button", { name: "Approve rel_fincrime_1_1_0" }).click();
  let sheet = page.getByRole("dialog", { name: "Approve rel_fincrime_1_1_0" });
  await sheet.getByRole("checkbox", { name: /I reviewed this release/ }).check();
  await sheet.getByRole("button", { name: "Approve" }).click();
  await expect(sheet.getByText(/is approved at revision 2/).first()).toBeVisible();
  await sheet.getByRole("button", { name: "Close", exact: true }).last().click();

  await become(page, "ops_manager", "A. Ruiz");
  await page.getByRole("button", { name: "Activate rel_fincrime_1_1_0" }).click();
  sheet = page.getByRole("dialog", { name: "Activate rel_fincrime_1_1_0" });
  await sheet.getByRole("checkbox", { name: /I reviewed this release/ }).check();
  await sheet.getByRole("button", { name: "Activate" }).click();
  await expect(sheet.getByText(/is active at revision 3/).first()).toBeVisible();
});

test("Journey F · operate: start a run → cancel it → overview → failed run (cannot cancel a terminal run) → system", async ({ page }) => {
  // The fixture has no failed run, so the journey makes one: start a run, then cancel it
  // (a cancelled run reads as failed with terminalOutcome "cancelled").
  await signInAs(page, "ops_manager", `/platform/plans/${PLAN}`);
  await page.getByRole("button", { name: "Start run" }).click();
  const start = page.getByRole("dialog", { name: "Start run" });
  await start.getByLabel("Run input (JSON)").fill('{"tenantId":"tenant_demo","caseId":"KYB-3001"}');
  await start.getByRole("button", { name: "Start run" }).click();
  await expect(start.getByText(/started\./)).toBeVisible();
  await start.getByRole("link", { name: /^Open run / }).click();
  await expect(page).toHaveURL(/\/platform\/runs\/run_/);
  const runUrl = page.url();

  await page.getByRole("button", { name: "Cancel run" }).click();
  const cancel = page.getByRole("dialog", { name: /^Cancel run / });
  await cancel.getByLabel(/Reason/).fill("journey F cancellation");
  await cancel.getByRole("button", { name: "Cancel run" }).click();
  await expect(page.getByText("Cancellation recorded.", { exact: false })).toBeVisible();

  await go(page, "/platform");
  await expect(page.getByRole("heading", { name: "Overview", level: 1 })).toBeVisible();
  await page.locator('[data-tile="failed"]').click();
  await expect(page).toHaveURL(/\/platform\/runs\?status=failed$/);
  await page.getByRole("table").getByRole("link", { name: new URL(runUrl).pathname.split("/").pop()! }).click();
  await expect(page.getByRole("button", { name: "Cancel run" })).toBeDisabled();
  await expectAccessible(page);

  await go(page, "/platform/system?tab=runtime");
  // An operator holds runtime.admission.write (GAP-050 resolved): the control is offered once the
  // runtime's state has loaded. The stop → start → 409 leg is covered by PLT-05 AC2 and PLT-12 AC1.
  await expect(page.getByRole("button", { name: "Stop admission…" })).toBeEnabled();
  await expect(page.getByText(/Runtime admission needs runtime\.admission\.write/)).toHaveCount(0);
});

test("Journey G · administer: an admin revises and re-activates a model profile; an auditor reads the change", async ({ page }) => {
  await signInAs(page, "platform_admin", "/platform/admin");
  const analysis = page.getByRole("region", { name: "analysis" });
  await analysis.getByLabel("Max output tokens").fill("4800");
  await analysis.getByLabel(/Reason/).fill("journey G budget");
  await analysis.getByRole("button", { name: "Save as new revision" }).click();
  await expect(analysis.getByText("Saved analysis.")).toBeVisible();
  const revisions = page.getByRole("list", { name: "analysis revisions" });
  await expect(revisions.getByText("r3")).toBeVisible();
  // Activate the previous revision again (rollback), with a reason.
  await analysis.getByRole("button", { name: /Make revision 2 of analysis active/ }).click();
  await expect(revisions.getByText("r2")).toBeVisible();

  await become(page, "auditor", "P. Lindgren");
  await page.getByRole("tab", { name: /Change history/ }).click();
  const entry = page.getByRole("list", { name: "Change history" }).getByRole("listitem").filter({ hasText: "journey G budget" }).first();
  await expect(entry).toBeVisible();
  await expect(entry.getByLabel("before digest")).toHaveText(/^[0-9a-f]{12}…$/);
  await expectAccessible(page);
});
