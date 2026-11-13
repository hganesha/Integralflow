import { expect, test } from "@playwright/test";
import { CASE } from "./assurance-support";
import { expectAccessible, mock, signInAs } from "./support";

// Journey E (BUILD-SPEC v2 §11.3): the auditor audits a decided case in one page load.
test("Journey E · audit a decision: recorder → entry → traces → lineage → export package", async ({ page }) => {
  await signInAs(page, "auditor", "/");
  await expect(page.getByRole("heading", { name: "Mission Control", level: 1 })).toBeVisible();
  await mock(page, "PUT", "/mock/scenario", { scenario: "decided" });

  // Mission Control → the case's flight recorder.
  await page.getByRole("navigation", { name: `Assurance views for ${CASE}` }).getByRole("link", { name: "Flight recorder" }).click();
  await expect(page.getByLabel("Recorder summary").getByText("Approved")).toBeVisible();
  await expect(page.getByLabel("Recorder summary").getByText("Verified", { exact: true })).toBeVisible();

  // An entry: the final approval and what the inspector shows for it.
  await page.locator('button[data-ref="human_decision:dec_final_adeyemi:0"]').click();
  const inspector = page.getByRole("complementary", { name: "Event inspector" });
  await expect(inspector.getByRole("heading", { name: "HumanDecision.APPROVE" })).toBeVisible();
  await expect(inspector.getByText("H. Adeyemi (HUMAN · h.adeyemi)")).toBeVisible();

  // Traces for the run behind it.
  await inspector.getByRole("button", { name: /Show trace/ }).click();
  await expect(page.getByRole("tab", { name: /Traces/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("list", { name: /^Spans of trace / })).toBeVisible();
  await expectAccessible(page);

  // Lineage of the decision.
  await page.getByRole("navigation", { name: `Assurance views for ${CASE}` }).getByRole("link", { name: "Decision lineage" }).click();
  await expect(page.getByText("Onboarding APPROVED").first()).toBeVisible();
  await expect(page.locator('[data-node="s1"]')).toHaveAttribute("data-path", "true");
  await expect(page.getByTestId("distinct-actors")).toHaveText("5");

  // Export the package.
  await page.getByRole("navigation", { name: `Assurance views for ${CASE}` }).getByRole("link", { name: "Assurance package" }).click();
  await page.getByLabel(/Purpose/).fill("Journey E audit");
  await page.getByRole("button", { name: "Generate export" }).click();
  await expect(page.getByTestId("export-sequence")).toHaveText("33");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download JSON" }).click();
  expect((await download).suggestedFilename()).toContain(CASE);
});
