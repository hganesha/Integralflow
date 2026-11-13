import { expect, test } from "@playwright/test";
import { expectAccessible, signInAs } from "./support";

// Product Policy Studio phase E: the guided steps and the three-pane explorer. A policy owner enables
// a product, overrides a rule for it, sees the inspector change and simulates the result.
test("enable a product, override a rule for it, inspect where it comes from and simulate", async ({ page }) => {
  await signInAs(page, "agent_architect", "/studio/policies?tab=products");
  const steps = page.getByRole("navigation", { name: "Policy steps" });
  await expect(steps.getByRole("button", { name: /Products/ })).toHaveAttribute("aria-current", "step");

  // Enable: a new card offering mapped to the canonical product.
  await page.getByRole("button", { name: "Add offering" }).click();
  const offering = page.getByRole("dialog", { name: "Add offering" });
  await offering.getByLabel("Name", { exact: true }).fill("Travel Card");
  await offering.getByLabel("Canonical product", { exact: true }).selectOption("PAY.CARDS.PREPAID");
  await offering.getByRole("button", { name: "Apply to working copy" }).click();
  await expect(page.getByRole("table", { name: "Offerings and their canonical products" })).toContainText("Travel Card");

  // Policies: the explorer places the set's products on the taxonomy, with the offerings beneath.
  await steps.getByRole("button", { name: /Policies/ }).click();
  const tree = page.getByRole("navigation", { name: "Products" });
  await expect(tree).toContainText("Payments & money movement");
  await expect(tree).toContainText("Offered as Debit Card");
  await expect(tree).toContainText("Offered as Travel Card");
  await tree.getByRole("button", { name: /Cards/ }).click();
  await expect(tree.getByRole("button", { name: /Cards/ })).toContainText("1 override");
  const inspector = page.getByRole("complementary", { name: "Effective policy inspector" });
  await expect(inspector.getByRole("list", { name: "Inheritance trail" })).toContainText("Regulatory (US)");
  await expect(inspector.getByRole("list", { name: "Inheritance trail" })).toContainText("Payments & money movement");
  await expectAccessible(page);

  // Inspect an inherited control: the payments family sets who is screened.
  await page.getByRole("button", { name: "Inspect Screening roles" }).click();
  await expect(inspector).toContainText("pack.product.family.pay");
  await expect(inspector).toContainText("Inherited");

  // Override: a rule for cards only.
  await page.getByRole("button", { name: "Add a rule for Cards" }).click();
  const sheet = page.getByRole("dialog", { name: "Add overlay" });
  await expect(sheet.getByLabel("Products", { exact: true })).toHaveValue("card");
  await sheet.getByLabel("Name", { exact: true }).fill("Card fraud signal");
  await sheet.getByLabel("Case records", { exact: true }).fill("/facts/selected/policyRecordRiskFactor");
  await sheet.getByLabel("Field", { exact: true }).fill("/data/name");
  await sheet.getByLabel("Value", { exact: true }).fill("card_fraud");
  await sheet.getByLabel("Level", { exact: true }).selectOption({ label: "Escalate to EDD" });
  await sheet.getByRole("button", { name: "Apply to working copy" }).click();
  await expect(tree.getByRole("button", { name: /Cards/ })).toContainText("2 overrides");
  await page.getByRole("button", { name: "Inspect Card fraud signal" }).click();
  await expect(inspector).toContainText("Conditional");
  await expect(inspector).toContainText("for products under card, raise the level to EDD");

  // The same rule does not apply to deposits, and the inspector says why.
  await tree.getByRole("button", { name: /Deposits/ }).click();
  await page.getByRole("button", { name: "Inspect Card fraud signal" }).click();
  await expect(inspector).toContainText("Scoped to other products");

  // Override the base level for cards, then simulate it.
  await tree.getByRole("button", { name: /Cards/ }).click();
  await page.getByLabel("Individual base level for Cards", { exact: true }).selectOption("EDD");
  await page.getByRole("button", { name: "Inspect Base level for Individual" }).click();
  await expect(inspector).toContainText("Override");
  await page.getByRole("button", { name: "Run what-if" }).click();
  await expect(page.getByRole("region", { name: "What-if outcome" })).toContainText("Base for Individual with card: EDD");
  await expectAccessible(page);

  // An offering is evaluated as itself: the debit card offering is PAY.CARDS.DEBIT, which takes the
  // card column just overridden.
  await tree.getByRole("button", { name: /Offered as Debit Card/ }).click();
  await expect(page.getByText("The offering Debit Card, evaluated as its canonical product")).toBeVisible();
  await expect(inspector.getByRole("list", { name: "Inheritance trail" })).toContainText("Cards");
  await expect(page.getByRole("heading", { name: "Simulate Debit Card" })).toBeVisible();
  await page.getByRole("button", { name: "Run what-if" }).click();
  await expect(page.getByRole("region", { name: "What-if outcome" })).toContainText("Base for Individual with card: EDD");
  await expectAccessible(page);
  await tree.getByRole("button", { name: /Cards/ }).first().click();

  // Coverage: controls by product, with the new rule switched on for deposits too.
  await page.getByRole("radio", { name: "Coverage" }).click();
  const coverage = page.getByRole("table", { name: "Controls by product" });
  await expect(coverage).toContainText("Screening roles");
  const ruleRow = coverage.getByRole("row", { name: /Card fraud signal/ });
  await expect(ruleRow.getByRole("checkbox")).toHaveCount(3);
  await ruleRow.getByRole("checkbox").nth(1).check();
  await expect(ruleRow.getByRole("checkbox").nth(1)).toBeChecked();
  await expectAccessible(page);
});

// The securities firm's policy (phase G, finished): its products are taxonomy nodes and its pack has
// its own institution and product family layers.
test("explore the securities firm's policy on brokerage, custody and wealth", async ({ page }) => {
  await signInAs(page, "agent_architect", "/studio/policies?tab=explorer&template=securities-agentic");
  await expect(page.getByLabel("Policy", { exact: true })).toHaveValue("securities-agentic");
  const tree = page.getByRole("navigation", { name: "Products" });
  await expect(tree).toContainText("Securities brokerage & trading");
  await expect(tree).toContainText("Custody, clearing & settlement");
  await expect(tree).toContainText("Wealth & private banking");
  await tree.getByRole("button", { name: /Securities brokerage/ }).first().click();
  await page.getByRole("button", { name: "Inspect Screening roles" }).click();
  const inspector = page.getByRole("complementary", { name: "Effective policy inspector" });
  await expect(inspector).toContainText("pack.product.family.brk");
  await expectAccessible(page);
});
