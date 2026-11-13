import { expect, test, type Page } from "@playwright/test";
import { expectAccessible } from "./support";
import { become, CASE, decideInSheet, go, openAs } from "./work-support";

const SCREENING = `/work/cases/${CASE}/lens/screening`;
const DESK = `/work/decisions/${CASE}`;

/**
 * No match percentage or probability (BIZ-06-AC1): the comparison table and the proposal
 * carry attribute results in words. (Ownership exposure, e.g. "27.0% effective owner", is an
 * interest, not a match score.)
 */
async function expectNoMatchScores(page: Page) {
  const comparison = page.getByRole("region", { name: /vs list entry/ });
  const texts = [await comparison.getByRole("table", { name: "Attribute comparison" }).innerText(), await comparison.getByText(/^Agent proposes/).locator("..").innerText()];
  for (const text of texts) expect(text).not.toMatch(/\d+(\.\d+)?\s*%|probab|confidence|score/i);
}

test.describe("BIZ-06 · Screening", () => {
  test("BIZ-06-AC1/AC2/AC4: no match percentages; no-candidate rows carry the negative-search disclosure; incomplete coverage is flagged", async ({ page }) => {
    await openAs(page, "screening_analyst", "screening_review", `${SCREENING}?finding=s-pep`);
    const findings = page.getByRole("table", { name: "Screening findings" });
    await expect(findings.getByRole("row")).toHaveCount(1 + 3);
    await expect(findings.getByRole("row").filter({ hasText: "watchlist" })).toContainText("Coverage incomplete");
    await expect(findings.getByRole("row").filter({ hasText: "sanctions" })).toContainText("No candidates — within the checked scope, not a clearance");
    await expect(page.getByText(/It is not a legal clearance/).first()).toBeVisible();
    await expect(page.getByText(/\bcleared?\b/i)).toHaveCount(0);
    const comparison = page.getByRole("region", { name: /Chen Wei vs list entry/ });
    await expect(comparison.getByRole("table", { name: "Attribute comparison" })).toContainText("Contradicts");
    await expectNoMatchScores(page);
    await expectAccessible(page);
  });

  test("BIZ-06-AC3: as screening_analyst in S2, Confirm false match in the trusted sheet moves the case to S3", async ({ page }) => {
    await openAs(page, "screening_analyst", "screening_review", `${SCREENING}?finding=s-pep`);
    const step = page.getByRole("region", { name: /Chen Wei vs list entry/ }).getByRole("region", { name: /Review the screening|Disposition|screening/i }).first();
    await step.getByRole("button", { name: "Decide" }).click();
    const sheet = page.getByRole("dialog");
    await expect(sheet.getByText("Platform-verified action · not agent-composed")).toBeVisible();
    await decideInSheet(page, "Confirm false match", "DOB and nationality contradict; name similarity only.");
    await expect(sheet.getByText("Recorded. This item is complete.").first()).toBeVisible();
    await sheet.getByRole("button", { name: "Close", exact: true }).last().click();
    await expect(page.locator('[aria-current="step"]')).toContainText("Decision");
  });
});

test.describe("BIZ-07 · Decision desk", () => {
  test("BIZ-07-AC1/AC5/AC6: the trusted button exists only inside the sheet; UNKNOWN and REVIEW are never pass; risk bars use share", async ({ page }) => {
    await openAs(page, "compliance_officer", "decision_pending", DESK);
    await expect(page.getByRole("heading", { level: 2, name: "Decision", exact: true })).toBeVisible();
    await expect(page.locator(".btn--trusted, [data-trusted]")).toHaveCount(0);
    await expect(page.getByText("REVIEW means a person must decide. It is not a pass.")).toBeVisible();
    const watchlist = page.getByRole("table", { name: "Policy controls" }).getByRole("row").filter({ hasText: "Watchlist coverage complete" });
    await expect(watchlist).toContainText(/unknown/i);
    await expect(watchlist).not.toContainText(/pass/i);
    await expect(page.locator('[data-factor="Geography"]')).toHaveAttribute("data-share", "0.65");
    await expect(page.locator('[data-factor="Geography"]')).toContainText("65% of score");
    await expectAccessible(page);

    await page.getByRole("button", { name: "Decide" }).click();
    const sheet = page.getByRole("dialog");
    await expect(sheet.getByRole("button", { name: "Decide", exact: true })).toBeVisible();
    // The trusted commit button is rendered by the sheet and nowhere else.
    const outside = await page.evaluate(() => Array.from(document.querySelectorAll("button")).filter((button) => /trusted/i.test(button.className) && !button.closest('[role="dialog"]')).length);
    expect(outside).toBe(0);
    await expectAccessible(page);
  });

  test("Decision: before the decision stage the desk says what the case is waiting on; at the stage it lists what is outstanding", async ({ page }) => {
    await openAs(page, "cdd_analyst", "ownership_review", DESK);
    await expect(page.getByRole("heading", { name: "No decision is prepared for this case yet" })).toBeVisible();
    const waiting = page.getByRole("region", { name: "What the case is waiting on" });
    await expect(waiting.getByText("Identity & ownership")).toBeVisible();
    await expect(waiting.getByRole("link", { name: "Open findings" })).toHaveAttribute("href", `/work/cases/${CASE}/findings`);
    await expect(page.getByRole("navigation", { name: "Case sections" })).toBeVisible();
    await expectAccessible(page);

    await openAs(page, "compliance_officer", "decision_pending", DESK);
    const outstanding = page.getByRole("region", { name: "Before you decide" });
    await expect(outstanding.getByText(/Policy control "Watchlist coverage complete" is unknown/)).toBeVisible();
    // The decision lives inside the case frame, with one Decide control.
    await expect(page.getByRole("navigation", { name: "Case sections" }).getByRole("link", { name: /^Decision/ }).first()).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("button", { name: "Decide" })).toHaveCount(1);
  });

  test("BIZ-07-AC2: S3 as s.varga APPROVE → S4; the sheet shows 1 of 2; reopening is read-only", async ({ page }) => {
    await openAs(page, "compliance_officer", "decision_pending", DESK);
    await page.getByRole("button", { name: "Decide" }).click();
    const sheet = await decideInSheet(page, "Approve onboarding", "Controls passed; residual risk within appetite.");
    await expect(sheet.getByText("Recorded. 1 of 2 approvals — waiting for more required responses.").first()).toBeVisible();
    await sheet.getByRole("button", { name: "Close", exact: true }).last().click();
    await expect(page.getByTestId("approvals")).toContainText("1 of 2");
    await expect(page.getByText("You already decided. A second, different approver is required.").first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Decide" })).toBeDisabled();
  });

  test("BIZ-07-AC3: S4 as h.adeyemi the sheet asks to claim first; APPROVE → S5 and the lineage link appears", async ({ page }) => {
    await openAs(page, "second_approver", "second_approval", `${DESK}#decide`);
    const sheet = page.getByRole("dialog");
    await expect(sheet.getByText(/Claimed by s\.varga\. Claim it too/)).toBeVisible();
    await sheet.getByRole("button", { name: "Claim to decide" }).click();
    await decideInSheet(page, "Approve onboarding", "Independent review agrees.");
    await expect(sheet.getByText("Recorded. This item is complete.").first()).toBeVisible();
    await sheet.getByRole("button", { name: "Close", exact: true }).last().click();
    await expect(page.getByText("Approved", { exact: true }).first()).toBeVisible();
    await expect(page.getByRole("link", { name: "Open decision lineage" })).toHaveAttribute("href", `/assurance/lineage/${CASE}`);
  });

  test("BIZ-07-AC4: S4 REJECT by h.adeyemi leaves the item in conflict; ops_manager may resolve, s.varga may not", async ({ page }) => {
    await openAs(page, "second_approver", "second_approval", `${DESK}#decide`);
    const sheet = page.getByRole("dialog");
    await sheet.getByRole("button", { name: "Claim to decide" }).click();
    await decideInSheet(page, "Decline onboarding", "Geography exposure is outside appetite.");
    await expect(sheet.getByText(/Reviewers disagree/).first()).toBeVisible();
    await sheet.getByRole("button", { name: "Close", exact: true }).last().click();
    await expect(page.getByText("Reviewers disagree (dual-control conflict)")).toBeVisible();

    await become(page, "compliance_officer");
    await expect(page.getByRole("button", { name: "Resolve conflict" })).toHaveCount(0);
    await become(page, "ops_manager");
    await expect(page.getByRole("button", { name: "Resolve conflict" })).toBeEnabled();
    await expectAccessible(page);
  });

  test("BIZ-07-AC7: the risk lens shows the attribution read-only at full width", async ({ page }) => {
    await openAs(page, "compliance_officer", "decision_pending", `/work/cases/${CASE}/lens/risk`);
    await expect(page.getByRole("heading", { level: 3, name: "Risk attribution" })).toBeVisible();
    await expect(page.locator('[data-factor="Ownership complexity"]')).toContainText("35% of score");
    await expect(page.getByRole("region", { name: "Risk attribution" }).getByRole("button")).toHaveCount(0);
    await expectAccessible(page);
    await go(page, DESK);
    await expect(page.getByRole("heading", { level: 2, name: "Decision", exact: true })).toBeVisible();
  });
});
