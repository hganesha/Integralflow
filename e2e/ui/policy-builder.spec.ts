import { expect, test } from "@playwright/test";
import { expectAccessible, signInAs } from "./support";

// Policy Studio builder (plan phase 3): the diligence design edited without YAML, tested with
// the what-if, saved as a revision and compared as matrix and overlay changes.
test("policy owners edit the diligence matrix and overlays, test the result and compare versions", async ({ page }) => {
  await signInAs(page, "agent_architect", "/studio/policies?template=kyb-agentic");
  const matrix = page.getByRole("table", { name: "Base level by party type and product" });
  await expect(matrix).toBeVisible();
  await expectAccessible(page);

  // A cell, an overlay switch and a new overlay, all on the working copy.
  await matrix.getByLabel("Company with deposit", { exact: true }).selectOption("EDD");
  await expect(page.getByText("Modified", { exact: true })).toBeVisible();
  await expect(page.locator("header").getByRole("button", { name: "Save revision" })).toBeEnabled();
  const overlays = page.getByRole("list", { name: "Risk overlays" });
  await overlays.getByRole("switch", { name: "Confirmed adverse media enabled" }).click();
  await expect(overlays.getByRole("switch", { name: "Confirmed adverse media enabled" })).toHaveAttribute("aria-checked", "true");

  await page.getByRole("button", { name: "Add overlay", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Add overlay" });
  await sheet.getByLabel("Name", { exact: true }).fill("Cash-intensive business");
  await sheet.getByLabel("Level", { exact: true }).selectOption({ label: "Escalate by 1 level" });
  await sheet.getByLabel("Case records", { exact: true }).fill("/facts/selected/policyRecordRiskFactor");
  await sheet.getByLabel("Field", { exact: true }).fill("/data/name");
  await sheet.getByLabel("Value", { exact: true }).fill("cash");
  // Effects only add: a requirement and a person's approval, read back as one sentence.
  await sheet.getByLabel("Add a requirement", { exact: true }).fill("EVD-SOURCE-OF-FUNDS");
  await sheet.getByRole("button", { name: "Add requirement" }).click();
  await sheet.getByRole("switch", { name: "Require approval" }).click();
  await sheet.getByLabel("Approver role", { exact: true }).selectOption({ label: "Case reviewer" });
  await sheet.getByLabel("Why", { exact: true }).fill("Cash-heavy businesses need a reviewer's sign-off");
  await sheet.getByLabel("Products", { exact: true }).fill("PAY");
  await expect(sheet.getByRole("region", { name: "This rule reads" }))
    .toContainText("for products under PAY, raise the level by 1 step, require EVD-SOURCE-OF-FUNDS and require approval by 1 case reviewer (Cash-heavy businesses need a reviewer's sign-off).");
  await expectAccessible(page);
  await sheet.getByRole("button", { name: "Apply to working copy" }).click();
  await expect(sheet).toBeHidden();
  const built = overlays.getByRole("listitem").filter({ hasText: "Cash-intensive business" });
  await expect(built).toContainText("Escalate by 1 level · Adds 1 requirement · Approval by 1 case reviewer");
  await expect(built).toContainText("Only for products under PAY");
  // The seeded PEP rule holds disposition for two reviewers.
  await expect(overlays.getByRole("listitem").filter({ hasText: "Politically exposed person" })).toContainText("Approval by 2 case reviewers");

  // An ambiguous legal form is shown as a problem before anything compiles, and can be undone.
  await page.getByRole("button", { name: /^Edit party types/ }).click();
  const parties = page.getByRole("dialog", { name: "Party types" });
  await parties.getByRole("button", { name: "Add party type" }).click();
  await parties.getByLabel("Name", { exact: true }).last().fill("Listed company");
  await parties.getByRole("group", { name: "Listed company legal forms" }).getByRole("checkbox", { name: "corporation" }).check();
  await parties.getByRole("button", { name: "Apply to working copy" }).click();
  await expect(page.getByText("A legal form belongs to more than one party type.")).toBeVisible();
  await page.getByRole("button", { name: /^Edit party types/ }).click();
  await page.getByRole("dialog", { name: "Party types" }).getByRole("button", { name: "Remove Listed company" }).click();
  await page.getByRole("dialog", { name: "Party types" }).getByRole("button", { name: "Apply to working copy" }).click();
  await expect(page.getByText("A legal form belongs to more than one party type.")).toBeHidden();

  // The what-if compiles the edited working copy: a company's deposit is now EDD.
  await page.getByRole("button", { name: "Simulate", exact: true }).click();
  await page.getByLabel("Party type", { exact: true }).selectOption({ label: "Company" });
  for (const name of ["Lending", "Merchant acquiring", "Payments"]) await page.getByRole("checkbox", { name, exact: true }).uncheck();
  await page.getByRole("button", { name: "Run what-if" }).click();
  const outcome = page.getByRole("region", { name: "What-if outcome" });
  await expect(outcome).toContainText("Base for Company with deposit: EDD");
  await outcome.getByRole("button", { name: "View rationale" }).click();
  const rationale = page.getByRole("dialog", { name: "Why EDD" });
  await expect(rationale.getByRole("list", { name: "Contributors" })).toContainText("Base for Company with deposit: EDD");
  await expectAccessible(page);
  await rationale.getByRole("button", { name: "Close" }).click();

  // A PEP rule's approval appears beside the level, and every requirement says where it came from.
  await page.getByRole("checkbox", { name: "Politically exposed person", exact: true }).check();
  await page.getByRole("button", { name: "Run what-if" }).click();
  await expect(outcome).toContainText("2 case reviewers: Senior approval to establish a relationship with a politically exposed person");
  await expect(outcome).toContainText("Held at disposition until they decide");
  await outcome.getByRole("button", { name: "View rationale" }).click();
  await expect(page.getByRole("dialog", { name: "Why EDD" }).getByRole("list", { name: "Requirements and their sources" })).toContainText("EVD-SOURCE-OF-FUNDS — required at EDD");
  await page.getByRole("dialog", { name: "Why EDD" }).getByRole("button", { name: "Close" }).click();
  await page.getByRole("checkbox", { name: "Politically exposed person", exact: true }).uncheck();

  // Saved as a revision and compared as design changes, not YAML.
  await page.locator("header").getByRole("button", { name: "Save revision" }).click();
  await expect(page.getByText("Saved revision 1.")).toBeVisible();
  await page.getByRole("tab", { name: /Versions/ }).click();
  await page.getByLabel("From", { exact: true }).selectOption({ label: "Template" });
  const changes = page.getByRole("list", { name: "Changes" });
  await expect(changes).toContainText("Company × deposit: CDD → EDD");
  await expect(changes).toContainText("Confirmed adverse media switched on");
  await expect(changes).toContainText("Added Cash-intensive business");
  await expectAccessible(page);
  await page.screenshot({ path: test.info().outputPath("policy-builder-versions.png"), fullPage: true });
});

test("policy owners monitor how diligence decisions came out", async ({ page }) => {
  await signInAs(page, "agent_architect", "/studio/policies?template=kyb-agentic&tab=monitoring");
  await expect(page.getByRole("tab", { name: "Monitoring" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("heading", { name: "Diligence decisions" })).toBeVisible();
  await expect(page.getByRole("list", { name: "Decided levels" })).toContainText("EDD");
  const cells = page.getByRole("table", { name: "Decided levels by party type and product" });
  await expect(cells.getByRole("row").filter({ hasText: "Trust or foundation · Payments" })).toContainText("EDD");
  await expect(page.getByRole("table", { name: "How often each overlay fired" })).toContainText("Politically exposed person");
  await expect(page.getByRole("heading", { name: "Why decisions stayed unresolved" })).toBeVisible();
  await expect(page.getByText("DILIGENCE_PARTY_TYPE_UNKNOWN")).toBeVisible();
  await expectAccessible(page);
  await page.screenshot({ path: test.info().outputPath("policy-monitoring.png"), fullPage: true });
});
