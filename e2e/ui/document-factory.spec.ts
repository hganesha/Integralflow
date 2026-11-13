import { expect, test, type Page } from "@playwright/test";
import { expectAccessible, mock, signInAs } from "./support";

const NAMES: Record<string, string> = { ops_manager: "A. Ruiz", harness_approver: "E. Kowalski" };

/** Switch persona and navigate in place: the in-browser mock keeps the Factory's state between people. */
async function as(page: Page, personaId: string, path: string) {
  await mock(page, "PUT", "/mock/session", { personaId });
  await expect(page.getByRole("banner").getByText(NAMES[personaId]!, { exact: true }).first()).toBeVisible();
  await page.evaluate(to => { window.history.pushState({}, "", to); window.dispatchEvent(new PopStateEvent("popstate")); }, path);
}

test("PLT-23: a release is planned, its spend approved, approved and activated by three different people", async ({ page }) => {
  await signInAs(page, "agent_architect", "/platform/document-factory");
  await expect(page.getByRole("heading", { name: "Document Factory", level: 1 })).toBeVisible();

  // New release: select, check readiness, plan.
  await page.getByRole("button", { name: "New release", exact: true }).click();
  for (const type of ["w9", "passport", "utility bill"]) await page.getByRole("checkbox", { name: new RegExp(`^${type} \\(`) }).check();
  await page.getByRole("button", { name: "Check readiness", exact: true }).click();
  const readiness = page.getByRole("region", { name: "Readiness and plan" });
  await expect(readiness).toContainText("Sealed test documents: 6 of 10 required.");
  await expect(readiness).toContainText("Prebuilt model");
  await expect(page.getByRole("region", { name: "Estimate" })).toContainText("Template and classifier training free");
  await expectAccessible(page);
  await page.getByRole("button", { name: "Plan release job", exact: true }).click();
  await expect(page).toHaveURL(/tab=jobs/);
  await expect(page.getByText("awaiting approval · approval")).toBeVisible();
  const approveSpend = page.getByRole("button", { name: /^Approve spend for / });
  await expect(approveSpend).toBeDisabled(); // the planner holds no factory.train

  // An operator approves the spend; the synthetic worker completes the job.
  await as(page, "ops_manager", "/platform/document-factory?tab=jobs");
  await page.getByRole("button", { name: /^Approve spend for / }).click();
  await expect(page.getByText("completed · report")).toBeVisible();
  await page.getByRole("button", { name: /^job_/ }).first().click();
  await expect(page.getByRole("region", { name: "Evaluation report" })).toContainText("Gates met");
  await expect(page.getByRole("button", { name: /^Activate rel-/ })).toHaveCount(0);

  // An approver approves the release; the operator activates it.
  await as(page, "harness_approver", "/platform/document-factory");
  await page.getByRole("button", { name: /^Approve rel-/ }).click();
  await expect(page.getByText("Release approved.")).toBeVisible();
  await as(page, "ops_manager", "/platform/document-factory");
  await page.getByRole("button", { name: /^Activate rel-/ }).click();
  await page.getByLabel("Reason (required)").fill("First pilot release");
  await page.getByRole("button", { name: "Activate", exact: true }).click();
  const environments = page.getByRole("region", { name: /Release in effect per environment/ });
  await expect(environments).toContainText("test");
  await expect(page.getByRole("button", { name: "Roll back test" })).toBeEnabled();
  await expectAccessible(page);
  await page.screenshot({ path: "/tmp/ehf-document-factory-releases.png", fullPage: true });
  await page.getByRole("tab", { name: "Datasets" }).click();
  await expect(page.getByRole("region", { name: "Datasets" })).toContainText("certificate of incorporation");
  await page.setViewportSize({ width: 390, height: 844 });
  await expectAccessible(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
