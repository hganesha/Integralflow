import { expect, test } from "@playwright/test";
import { apiCall } from "./authoring-support";
import { expectAccessible } from "./support";
import { become, CASE, caseSequence, decideInSheet, go, openAs } from "./work-support";

// Journeys C and D (BUILD-SPEC v2 §11.3). Each stays in one page load so the in-page mock
// keeps its state across personas; navigation happens inside the SPA.

const OWNERSHIP = `/work/cases/${CASE}/lens/ownership`;
const DESK = `/work/decisions/${CASE}`;

test("Journey C · process corporate KYB: ownership (stale basis) → screening → first and second approval", async ({ page }) => {
  // S1 · cdd_analyst opens the work from My Workspace.
  await openAs(page, "cdd_analyst", "ownership_review", "/work");
  await page.locator('[data-work-item="wi_own_review"]').focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`${OWNERSHIP}$`));
  await expect(caseSequence(page)).toHaveText("14");

  // The analyst starts the review at sequence 14 …
  const intelligence = page.getByRole("complementary", { name: "Case intelligence" });
  await intelligence.getByRole("button", { name: "Decide" }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet.getByText(/deciding on the case as of sequence/)).toContainText("14");
  // … while the contradiction is resolved from their other tab (register value, 14 → 15).
  const resolved = await apiCall(page, "POST", `/v1/cases/${CASE}/commands`, {
    commandType: "ResolveContradiction", commandVersion: "1.0.0",
    payload: { contradictionId: "cf-12", resolution: "ACCEPT_ASSERTION", assertionId: "as-reg", rationale: "The certified register is authoritative." },
    preconditions: { caseSequence: 14 }, idempotencyKey: "journey-c-cf12",
  });
  expect(resolved.body).toMatchObject({ outcome: "ACCEPTED", caseSequence: 15 });

  // Deciding on the old basis is refused; Review again pins 15 and the decision lands.
  await decideInSheet(page, "Accept ownership findings", "Ownership supported; contradiction resolved on the register.");
  await expect(sheet.getByText("The case changed while you were reviewing (sequence 14 → 15).").first()).toBeVisible();
  await sheet.getByRole("button", { name: "Review again" }).click();
  await expect(sheet.getByText(/deciding on the case as of sequence/)).toContainText("15");
  await decideInSheet(page, "Accept ownership findings", "Ownership supported; contradiction resolved on the register.");
  await expect(sheet.getByText("Recorded. This item is complete.").first()).toBeVisible();
  await sheet.getByRole("button", { name: "Close", exact: true }).last().click();
  await expect(page.locator('[aria-current="step"]')).toContainText("Screening");

  // S2 · screening_analyst confirms the false match.
  await become(page, "screening_analyst");
  await go(page, `/work/cases/${CASE}/lens/screening?finding=s-pep`);
  const comparison = page.getByRole("region", { name: /Chen Wei vs list entry/ });
  await comparison.getByRole("button", { name: "Decide" }).click();
  await decideInSheet(page, "Confirm false match", "Name similarity only; DOB and nationality contradict.");
  await expect(sheet.getByText("Recorded. This item is complete.").first()).toBeVisible();
  await sheet.getByRole("button", { name: "Close", exact: true }).last().click();
  await expect(page.locator('[aria-current="step"]')).toContainText("Decision");

  // S3 · compliance_officer gives the first approval.
  await become(page, "compliance_officer");
  await go(page, DESK);
  await page.getByRole("button", { name: "Decide" }).click();
  await decideInSheet(page, "Approve onboarding", "Controls pass; residual risk MEDIUM within appetite.");
  await expect(sheet.getByText("Recorded. 1 of 2 approvals — waiting for more required responses.").first()).toBeVisible();
  await sheet.getByRole("button", { name: "Close", exact: true }).last().click();
  await expect(page.getByTestId("approvals")).toContainText("1 of 2");

  // S4 · second_approver finds it in My Workspace, claims and approves.
  await become(page, "second_approver");
  await go(page, "/work");
  const item = page.locator('[data-group="needs_action"] [data-work-item="wi_decision"]');
  await item.focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`${DESK}$`));
  await page.getByRole("button", { name: "Decide" }).click();
  await sheet.getByRole("button", { name: "Claim to decide" }).click();
  await decideInSheet(page, "Approve onboarding", "Independent second review agrees.");
  await expect(sheet.getByText("Recorded. This item is complete.").first()).toBeVisible();
  await sheet.getByRole("button", { name: "Close", exact: true }).last().click();

  // S5 · approved, with the lineage link.
  await expect(page.getByText("Approved", { exact: true }).first()).toBeVisible();
  await expect(page.getByTestId("approvals")).toContainText("2 of 2");
  await expect(page.getByRole("link", { name: "Open decision lineage" })).toBeVisible();
  await expectAccessible(page);
});

test("Journey D · dual-control conflict: the second approver rejects; an operator who did not decide resolves", async ({ page }) => {
  await openAs(page, "second_approver", "second_approval", `${DESK}#decide`);
  const sheet = page.getByRole("dialog");
  await sheet.getByRole("button", { name: "Claim to decide" }).click();
  await decideInSheet(page, "Decline onboarding", "Geography exposure is outside appetite.");
  await expect(sheet.getByText(/Reviewers disagree/).first()).toBeVisible();
  await sheet.getByRole("button", { name: "Close", exact: true }).last().click();
  await expect(page.getByText("Reviewers disagree (dual-control conflict)")).toBeVisible();

  // The first approver cannot resolve their own disagreement.
  await become(page, "compliance_officer");
  await expect(page.getByRole("button", { name: "Resolve conflict" })).toHaveCount(0);
  await expect(page.getByText("You already decided. A second, different approver is required.").first()).toBeVisible();

  // The operator sees the conflict in the platform queue too (PLT-10-AC1), then resolves it on the desk.
  await become(page, "ops_manager");
  await go(page, `/platform/human-work?item=wi_decision`);
  await expect(page.getByRole("button", { name: "Resolve conflict" })).toBeEnabled();
  await go(page, DESK);
  await page.getByRole("button", { name: "Resolve conflict" }).click();
  await expect(sheet.getByRole("heading", { name: "Resolve conflicting decisions" })).toBeVisible();
  await sheet.getByRole("radio", { name: "Approve" }).click();
  await sheet.getByLabel("Reason code").fill("dual_control.resolved");
  await sheet.getByLabel(/^Rationale/).fill("Risk appetite covers the geography exposure; approving per policy.");
  await sheet.getByRole("checkbox", { name: /I did not decide this item/ }).check();
  await sheet.getByRole("button", { name: "Resolve", exact: true }).click();
  await expect(sheet.getByText("Resolved. The process continues with your outcome.").first()).toBeVisible();
  await sheet.getByRole("button", { name: "Close", exact: true }).last().click();
  await expect(page.getByText("Approved", { exact: true }).first()).toBeVisible();
});
