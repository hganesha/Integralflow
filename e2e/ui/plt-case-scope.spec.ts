import { expect, test, type Locator, type Page } from "@playwright/test";
import { expectAccessible, signInAs } from "./support";

// PLT-09 · A new case is opened by its scope: customer type, trigger, due diligence, policy
// jurisdiction and products select the one released process and policy pack (ui-mock case-plans.ts:
// standard KYC/KYB for US and GB; KYC EDD, KYB EDD and KYB SDD for US, GB and AU).

async function openNewCase(page: Page): Promise<Locator> {
  await signInAs(page, "cdd_analyst", "/platform/cases");
  await expect(page.getByRole("heading", { name: "Cases", level: 1 })).toBeVisible();
  await page.getByRole("button", { name: "New case" }).click();
  const sheet = page.getByRole("dialog", { name: "New case" });
  await expect(sheet.getByLabel("Customer type", { exact: true })).toHaveValue("individual");
  return sheet;
}

const selection = (sheet: Locator) => sheet.getByTestId("case-plan-selection");
const tile = (page: Page, label: string) => page.locator("span", { hasText: new RegExp(`^${label}$`) }).locator("xpath=following-sibling::span[1]");

test("a GB business case for deposit and payments is pinned to the KYB process and the GB business-banking pack", async ({ page }) => {
  const sheet = await openNewCase(page);
  await sheet.getByLabel("Customer type", { exact: true }).selectOption("corporate");
  await sheet.getByLabel("Policy jurisdiction").selectOption("GB");
  await sheet.getByRole("checkbox", { name: "deposit", exact: true }).check();
  // Keyboard: a product is a checkbox Space toggles.
  await sheet.getByRole("checkbox", { name: "payments", exact: true }).focus();
  await page.keyboard.press("Space");
  await expect(sheet.getByRole("checkbox", { name: "payments", exact: true })).toBeChecked();

  await expect(selection(sheet)).toContainText("Agentic KYB: business onboarding · policy.pack.gb.bank-synthetic.business-banking");
  await expect(selection(sheet)).toContainText("GB · deposit, lending, merchant acquiring, payments");
  await expectAccessible(page);

  await sheet.getByLabel("External reference").fill("ACME-GB-1");
  await sheet.getByRole("button", { name: "Create case" }).click();
  await expect(page).toHaveURL(/\/platform\/cases\/KYB-2001$/);
  await expect(page.getByText("ACME-GB-1").first()).toBeVisible();
  await expect(tile(page, "Jurisdiction")).toHaveText("GB");
});

test("an individual enhanced-due-diligence case in AU is pinned to the KYC EDD process and the AU personal-banking pack", async ({ page }) => {
  const sheet = await openNewCase(page);
  await sheet.getByLabel("Due diligence").selectOption("enhanced");
  await sheet.getByLabel("Policy jurisdiction").selectOption("AU");
  await sheet.getByRole("checkbox", { name: "card", exact: true }).check();
  await expect(selection(sheet)).toContainText("Agentic KYC (EDD): individual onboarding · policy.pack.au.bank-synthetic.personal-banking");
  await sheet.getByRole("button", { name: "Create case" }).click();
  await expect(page).toHaveURL(/\/platform\/cases\/KYB-2001$/);
  await expect(tile(page, "Jurisdiction")).toHaveText("AU");
});

test("an individual standard case in AU is refused: no released policy pack covers it", async ({ page }) => {
  const sheet = await openNewCase(page);
  await sheet.getByLabel("Policy jurisdiction").selectOption("AU");
  await sheet.getByRole("checkbox", { name: "card", exact: true }).check();
  const refusal = sheet.getByTestId("case-plan-refusal");
  await expect(refusal).toContainText("No policy pack covers this case");
  await expect(refusal).toContainText("no released plan pins a pack for AU covering card");
  await expect(refusal).toContainText("case.plan_no_pack");
  await expect(refusal).toContainText("What to do:");
  await expect(selection(sheet)).toHaveCount(0);
  await expect(sheet.getByRole("button", { name: "Create case" })).toBeDisabled();
  await expectAccessible(page);

  // Changing the scope to one a pack covers clears the refusal.
  await sheet.getByLabel("Policy jurisdiction").selectOption("GB");
  await expect(selection(sheet)).toContainText("policy.pack.gb.bank-synthetic.personal-banking");
  await expect(sheet.getByRole("button", { name: "Create case" })).toBeEnabled();
});

test("a trust cannot use simplified due diligence and is offered the trust review events", async ({ page }) => {
  const sheet = await openNewCase(page);
  const dueDiligence = sheet.getByLabel("Due diligence");
  await expect(dueDiligence.locator("option[value=simplified]")).toBeDisabled();
  await sheet.getByLabel("Customer type", { exact: true }).selectOption("corporate");
  await expect(dueDiligence.locator("option[value=simplified]")).toBeEnabled();
  await dueDiligence.selectOption("simplified");

  await sheet.getByLabel("Customer type", { exact: true }).selectOption("trust");
  await expect(dueDiligence.locator("option[value=simplified]")).toBeDisabled();
  await expect(dueDiligence.locator("option[value=simplified]")).toHaveText("Simplified (SDD) · Not for trusts");
  // The level the trust cannot use falls back to standard.
  await expect(dueDiligence).toHaveValue("standard");

  await sheet.getByLabel("Trigger").selectOption("event_review");
  const event = sheet.getByLabel("Review event");
  await expect(event.locator("option")).toContainText(["Trust party change"]);
  await expect(event.locator("option", { hasText: "Person name change" })).toHaveCount(0);
  await expect(sheet.getByText("Choose the event that triggers the review.")).toBeVisible();
  await expectAccessible(page);

  await event.selectOption("trust_party_change");
  await sheet.getByLabel("Policy jurisdiction").selectOption("US");
  await sheet.getByRole("checkbox", { name: "deposit", exact: true }).check();
  await expect(sheet.getByTestId("case-plan-refusal")).toContainText("No released process for this case");
  await expect(sheet.getByTestId("case-plan-refusal")).toContainText("case.plan_no_plan");
});
