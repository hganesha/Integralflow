import { expect, test } from "@playwright/test";
import { switchPersona } from "./authoring-support";
import { expectAccessible, signInAs } from "./support";

// Product Policy Studio phase F: impact over the regression set, then publish, schedule and roll back.
test("a policy change is simulated on the regression set, published, scheduled and rolled back", async ({ page }) => {
  await signInAs(page, "agent_architect", "/studio/policies?template=kyb-agentic&set=policy.pack.us.bank-synthetic.business-banking.v2");
  const matrix = page.getByRole("table", { name: "Base level by party type and product" });
  await matrix.getByLabel("Trust or foundation with payments", { exact: true }).selectOption("CDD");

  // Impact: the working copy against the template, case by case.
  await page.getByRole("navigation", { name: "Policy steps" }).getByRole("button", { name: /Publish/ }).click();
  const approvals = page.getByRole("tabpanel", { name: "Approvals" });
  await approvals.getByRole("button", { name: "Run impact" }).click();
  const impact = approvals.getByRole("region", { name: "Impact result" });
  await expect(impact.getByRole("table", { name: "Cases and how their outcome changes" })).toContainText("US trust using payments");
  await expect(impact).toContainText("Level lowered");
  await expect(impact).toContainText("Regression set regression.bank-synthetic 1.0.0");
  await expectAccessible(page);

  // Impact at a later gate: disposition reads each side's own diligence decision. Lowering the trust's
  // level does not change what disposition does for any case here.
  await approvals.getByLabel("Gate", { exact: true }).selectOption({ label: "Disposition" });
  await approvals.getByRole("button", { name: "Run impact" }).click();
  await expect(impact.getByText("No case changes")).toBeVisible();
  await impact.getByRole("switch", { name: "Show unchanged cases" }).click();
  await expect(impact.getByRole("table", { name: "Cases and how their outcome changes" })).toContainText("Needs human · asks Case.Reviewer (2 people)");
  await expect(impact.getByRole("table", { name: "Cases and how their outcome changes" })).toContainText("Decided · approves");
  await approvals.getByLabel("Gate", { exact: true }).selectOption({ label: "Diligence level" });

  // Publish revision 1 now (author saves and compiles; a second person approves and publishes).
  const lifecycle = approvals;
  await lifecycle.getByRole("button", { name: "Save new revision" }).click();
  await expect(page.getByText("Saved revision 1.")).toBeVisible();
  await lifecycle.getByRole("button", { name: "Compile saved revision" }).click();
  await expect(page.getByText(/Revision 1: COMPILED/)).toBeVisible();
  await switchPersona(page, "harness_approver");
  await lifecycle.getByRole("button", { name: "Approve revision" }).click();
  await expect(page.getByText(/Revision 1: APPROVED/)).toBeVisible();
  await lifecycle.getByRole("button", { name: "Publish approved revision" }).click();
  await expect(page.getByText(/Revision 1: PUBLISHED/)).toBeVisible();
  const activation = approvals.getByRole("region", { name: "Activation", exact: true });
  await expect(activation).toContainText("Revision 1, since");

  // Revision 2, scheduled for next year: published, but revision 1 stays in effect.
  await switchPersona(page, "agent_architect");
  await page.getByRole("tab", { name: "Rules" }).click();
  await matrix.getByLabel("Trust or foundation with lending", { exact: true }).selectOption("CDD");
  await page.getByRole("tab", { name: "Approvals" }).click();
  await lifecycle.getByRole("button", { name: "Save new revision" }).click();
  await expect(page.getByText("Saved revision 2.")).toBeVisible();
  await lifecycle.getByRole("button", { name: "Compile saved revision" }).click();
  await expect(page.getByText(/Revision 2: COMPILED/)).toBeVisible();
  await switchPersona(page, "harness_approver");
  await lifecycle.getByRole("button", { name: "Approve revision" }).click();
  await expect(page.getByText(/Revision 2: APPROVED/)).toBeVisible();
  const next = `${new Date().getUTCFullYear() + 1}-01-15T09:00`;
  await lifecycle.getByLabel("Takes effect", { exact: true }).fill(next);
  await lifecycle.getByRole("button", { name: "Schedule approved revision" }).click();
  await expect(activation).toContainText("Revision 2 from");
  await expect(activation).toContainText("Revision 1, since");
  await expect(activation.getByRole("table", { name: "Activation history" })).toContainText("Scheduled revision 2");

  // Roll back: revision 1 is put back in effect, and the scheduled revision is superseded.
  await activation.getByLabel("Why roll back", { exact: true }).fill("Trust lending change withdrawn");
  await activation.getByRole("button", { name: "Roll back" }).click();
  await expect(activation.getByRole("table", { name: "Activation history" })).toContainText("Rolled back to revision 1");
  await expect(activation).toContainText("Nothing scheduled");
  await expectAccessible(page);
});

test("the what-if takes an assessed risk tier and shows the full trace", async ({ page }) => {
  await signInAs(page, "agent_architect", "/studio/policies?template=kyb-agentic");
  await page.getByRole("button", { name: "Simulate", exact: true }).click();
  await page.getByLabel("Party type", { exact: true }).selectOption({ label: "Company" });
  await page.getByLabel("Assessed risk", { exact: true }).selectOption("HIGH");
  await page.getByRole("button", { name: "Run what-if" }).click();
  const outcome = page.getByRole("region", { name: "What-if outcome" });
  await outcome.getByRole("button", { name: "View rationale" }).click();
  const trace = page.getByRole("region", { name: "Decision trace" });
  await expect(trace).toContainText("assessed risk high");
  await expect(trace).toContainText("policy.kyb-agentic.business.v2");
  await expect(trace).toContainText("pack.product.family.pay");
  await expectAccessible(page);
});
