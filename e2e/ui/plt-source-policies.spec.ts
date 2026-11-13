import { expect, test } from "@playwright/test";
import { expectAccessible, signInAs } from "./support";

test("jurisdiction source policies expose authoring and contextual eligibility without synthetic approvals", async ({ page }) => {
  await signInAs(page, "agent_architect", "/studio/policies?tab=sources");
  await expect(page.getByRole("heading", { name: "Jurisdiction source policies", exact: true })).toBeVisible();
  await expect(page.getByRole("table", { name: "Source authorization matrix", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Register candidate", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Check eligibility", exact: true })).toBeDisabled();
  await expectAccessible(page);
  await page.getByLabel("Candidate artifact JSON", { exact: true }).fill("{");
  await page.getByRole("button", { name: "Validate candidate", exact: true }).click();
  await expect(page.getByText("Enter valid JSON before validating the candidate.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Register candidate", exact: true })).toBeDisabled();
  // Keep the capture with the test results; an absolute host path only exists on some machines.
  await page.screenshot({ path: test.info().outputPath("jurisdiction-source-policies.png"), fullPage: true });
});

test("source policy controls remain usable at laptop width", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 900 });
  await signInAs(page, "agent_architect", "/studio/policies?tab=sources");
  await expect(page.getByLabel("Candidate artifact JSON", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Run simulation", exact: true })).toBeDisabled();
  await expectAccessible(page);
});
