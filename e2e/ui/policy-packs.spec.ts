import { expect, test } from "@playwright/test";
import { switchPersona } from "./authoring-support";
import { expectAccessible, signInAs } from "./support";

// Pack layers in the studio (phase H): an author edits a layer, the tighten-only check runs as they
// type, and a second person approves and publishes it.
test("an author tightens a pack layer and a second person approves and publishes it", async ({ page }) => {
  await signInAs(page, "agent_architect", "/studio/policies?tab=packs");
  const nav = page.getByRole("navigation", { name: "Pack layers" });
  await nav.getByRole("button", { name: /pack\.institution\.bank-synthetic/ }).click();
  await expect(page.getByRole("heading", { name: "pack.institution.bank-synthetic" })).toBeVisible();
  const section = page.getByRole("region", { name: "pack.institution.bank-synthetic" });
  const threshold = page.getByLabel("Screening threshold", { exact: true });
  await expect(threshold).toHaveValue("0.85");
  await expect(page.getByRole("table", { name: "Values of pack.institution.bank-synthetic" })).toContainText("May only go down");

  // Loosening: every pack would refuse it.
  await threshold.fill("0.99");
  await expect(page.getByRole("list", { name: "Pack layer problems" })).toContainText("policy_pack.loosens:pack.institution.bank-synthetic:screening_threshold");
  await expectAccessible(page);

  // Tightening composes everywhere; saved as a draft its author cannot approve.
  await threshold.fill("0.8");
  await expect(page.getByText("Every selected pack composes with this layer.")).toBeVisible();
  await page.getByLabel("Reason", { exact: true }).fill("Tighter possible-match score");
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(section.getByText("Revision 1 · DRAFT")).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve" })).toBeDisabled();

  await switchPersona(page, "harness_approver");
  await nav.getByRole("button", { name: /pack\.institution\.bank-synthetic/ }).click();
  await page.getByLabel("Reason", { exact: true }).fill("Reviewed");
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(section.getByText("Revision 1 · APPROVED")).toBeVisible();
  await page.getByLabel("Reason", { exact: true }).fill("Go live");
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(section.getByText("Published revision 1")).toBeVisible();
  await expect(page.getByLabel("Screening threshold", { exact: true })).toHaveValue("0.8");
  await expectAccessible(page);
});
