import { expect, test } from "@playwright/test";
import { switchPersona } from "./authoring-support";
import { expectAccessible, signInAs } from "./support";

// Product Policy Studio phase B: the institution's business profile and product catalog, edited
// in the studio, saved as a revision and approved and published by a second person.
test("an author maps a new offering to a canonical product and a second person approves and publishes it", async ({ page }) => {
  await signInAs(page, "agent_architect", "/studio/policies?tab=business");
  await expect(page.getByRole("table", { name: "Legal entities and the regimes that regulate them" })).toContainText("Synthetic Bank N.A.");
  await expect(page.getByText("Repository seed (never saved)")).toBeVisible();
  await expectAccessible(page);

  // Business: a new business line, scoped to a taxonomy class.
  await page.getByRole("button", { name: "Add business line" }).click();
  const line = page.getByRole("dialog", { name: "Add business line" });
  await line.getByLabel("Name", { exact: true }).fill("Wealth");
  await line.getByLabel("Product scope", { exact: true }).fill("WLT.PRIVATE_BANKING");
  await line.getByRole("button", { name: "Add to scope" }).click();
  await expect(line.getByRole("list", { name: "Products in scope" })).toContainText("WLT.PRIVATE_BANKING");
  await line.getByRole("button", { name: "Apply to working copy" }).click();
  await expect(page.getByRole("table", { name: "Business lines and the products they may offer" })).toContainText("Wealth");

  // Products: an offering within that business line, mapped to a canonical product.
  await page.getByRole("tab", { name: "Products" }).click();
  await expect(page.getByRole("table", { name: "Case product types and the canonical products they resolve to" })).toContainText("PAY.CARDS.DEBIT");
  await page.getByRole("button", { name: "Add offering" }).click();
  const offering = page.getByRole("dialog", { name: "Add offering" });
  await offering.getByLabel("Name", { exact: true }).fill("Private Client Account");
  await offering.getByLabel("Business line", { exact: true }).selectOption({ label: "Wealth" });
  await offering.getByLabel("Canonical product", { exact: true }).selectOption("WLT.PRIVATE_BANKING");
  await expectAccessible(page);
  await offering.getByRole("button", { name: "Apply to working copy" }).click();
  const offerings = page.getByRole("table", { name: "Offerings and their canonical products" });
  await expect(offerings).toContainText("Private Client Account");
  await expect(page.getByText("Modified", { exact: true })).toBeVisible();

  // Saved as a draft; its author cannot approve it.
  await page.getByLabel("Reason", { exact: true }).fill("Add private banking");
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByText("Revision 1 · DRAFT")).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve" })).toBeDisabled();

  // A second person approves and publishes.
  await switchPersona(page, "harness_approver");
  await page.getByLabel("Reason", { exact: true }).fill("Reviewed the new offering");
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByText("Revision 1 · APPROVED")).toBeVisible();
  await page.getByLabel("Reason", { exact: true }).fill("Go live");
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(page.getByText("Revision 1 · PUBLISHED")).toBeVisible();
  await expect(page.getByRole("table", { name: "Offerings and their canonical products" })).toContainText("Private Client Account");
  await expectAccessible(page);
});

test("problems block approval and are explained in plain language", async ({ page }) => {
  await signInAs(page, "agent_architect", "/studio/policies?tab=business");
  await expect(page.getByRole("table", { name: "Business lines and the products they may offer" })).toBeVisible();
  await page.getByRole("button", { name: "Remove Business banking" }).click();
  await expect(page.getByText(/problems? to resolve before approval/)).toBeVisible();
  await page.getByText(/problems? to resolve before approval/).click();
  await expect(page.getByText("business-checking names business line business-banking, which does not exist")).toBeVisible();
  await page.getByRole("button", { name: "Discard edits" }).click();
  await expect(page.getByText(/problems? to resolve before approval/)).toBeHidden();
});

test("an author creates an institution with no seed and a second person approves and publishes it", async ({ page }) => {
  await signInAs(page, "agent_architect", "/studio/policies?tab=business");
  await expect(page.getByRole("table", { name: "Business lines and the products they may offer" })).toBeVisible();
  await page.getByRole("button", { name: "New institution" }).click();
  const sheet = page.getByRole("dialog", { name: "New institution" });
  await sheet.getByLabel("Name", { exact: true }).fill("Harbour Credit Union");
  await sheet.getByLabel("Institution id", { exact: true }).fill("harbour-cu.synthetic");
  await sheet.getByLabel("Jurisdictions", { exact: true }).fill("US");
  await sheet.getByLabel("First legal entity", { exact: true }).fill("Harbour Credit Union Inc");
  await sheet.getByLabel("First business line", { exact: true }).fill("Members");
  // Nothing is created until every part is there.
  await sheet.getByRole("button", { name: "Create working copy" }).click();
  await expect(sheet.getByRole("alert")).toContainText("Choose at least one product domain");
  await sheet.getByRole("group", { name: "Product domains the business line may offer" }).getByRole("checkbox", { name: /\(DEP\)/ }).check();
  await sheet.getByRole("button", { name: "Create working copy" }).click();
  await expect(page.getByText("New institution (never saved)")).toBeVisible();
  await expect(page.getByLabel("Institution", { exact: true })).toHaveValue("harbour-cu.synthetic");
  await expect(page.getByRole("table", { name: "Legal entities and the regimes that regulate them" })).toContainText("Harbour Credit Union Inc");
  await expectAccessible(page);

  // Saved as revision 1; a second person approves and publishes it.
  await page.getByLabel("Reason", { exact: true }).fill("Onboard a new institution");
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByText("Revision 1 · DRAFT")).toBeVisible();
  await switchPersona(page, "harness_approver");
  await page.getByLabel("Reason", { exact: true }).fill("Reviewed the profile");
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByText("Revision 1 · APPROVED")).toBeVisible();
  await page.getByLabel("Reason", { exact: true }).fill("Go live");
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(page.getByText("Revision 1 · PUBLISHED")).toBeVisible();
  await expect(page.getByLabel("Institution", { exact: true }).locator("option", { hasText: "Harbour Credit Union" })).toHaveCount(1);
});

test("an author sets an offering's variant attributes and bundle, with the catalog's checks", async ({ page }) => {
  await signInAs(page, "agent_architect", "/studio/policies?tab=products");
  const offerings = page.getByRole("table", { name: "Offerings and their canonical products" });
  await expect(offerings).toContainText("Debit Card");
  await page.getByRole("button", { name: "Edit Debit Card details" }).click();
  const sheet = page.getByRole("dialog", { name: "Debit Card details" });
  // Only offering-level attributes can be added, each with an input of its type.
  await sheet.getByLabel("Add attribute", { exact: true }).selectOption({ label: "Access channels (Channel)" });
  await sheet.getByRole("button", { name: "Add", exact: true }).click();
  await sheet.getByRole("group", { name: "Access channels" }).getByRole("checkbox", { name: "Digital" }).check();
  await sheet.getByLabel("Add attribute", { exact: true }).selectOption({ label: "Non-face-to-face onboarding (Channel)" });
  await sheet.getByRole("button", { name: "Add", exact: true }).click();
  await sheet.getByRole("switch", { name: "Non-face-to-face onboarding" }).click();
  await sheet.getByRole("group", { name: "Sold or serviced with" }).getByRole("checkbox", { name: "Everyday Checking" }).check();
  await expect(sheet.getByRole("alert")).toHaveCount(0);
  await expectAccessible(page);
  await sheet.getByRole("button", { name: "Apply to working copy" }).click();
  const row = offerings.getByRole("row", { name: /Debit Card/ });
  await expect(row).toContainText("Access channels: DIGITAL");
  await expect(row).toContainText("With Everyday Checking");
  await expect(page.getByText("Modified")).toBeVisible();
});
