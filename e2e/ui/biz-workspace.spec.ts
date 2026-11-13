import { expect, test } from "@playwright/test";
import { apiCall } from "./authoring-support";
import { expectAccessible, mock } from "./support";
import { become, CASE, caseSequence, go, openAs } from "./work-support";

const ROOM = `/work/cases/${CASE}`;

test.describe("BIZ-01 · My Workspace", () => {
  test("BIZ-01-AC2: in S4 the decision waits on a second approver for s.varga and needs h.adeyemi's decision", async ({ page }) => {
    await openAs(page, "compliance_officer", "second_approval", "/work");
    await expect(page.getByRole("heading", { level: 1, name: "My Workspace" })).toBeVisible();
    const waiting = page.locator('[data-group="waiting_on_others"]');
    await expect(waiting.locator('[data-work-item="wi_decision"]')).toBeVisible();
    await expect(waiting.locator('[data-work-item="wi_decision"]')).toContainText("1/2 approvals");
    await expect(page.locator('[data-group="needs_action"]')).toHaveCount(0);
    await expectAccessible(page);

    await become(page, "second_approver");
    await expect(page.locator('[data-group="needs_action"] [data-work-item="wi_decision"]')).toBeVisible();
    await expect(page.locator('[data-group="waiting_on_others"]')).toHaveCount(0);
  });

  test("BIZ-01-AC3: Enter on an item opens its route; the inspector previews the human step", async ({ page }) => {
    await openAs(page, "cdd_analyst", "ownership_review", "/work");
    const row = page.locator('[data-work-item="wi_own_review"]');
    await row.focus();
    const inspector = page.getByRole("complementary", { name: "Selected work item" });
    await expect(inspector.getByText("Accountable human step")).toBeVisible();
    await expect(inspector.getByText("Accept ownership findings")).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new RegExp(`${ROOM}/lens/ownership$`));
    await expect(page.getByRole("heading", { level: 2, name: "Ownership & control" })).toBeVisible();
  });

  test("BIZ-01-AC1: while an item is selected the list does not reorder; the new-items pill applies the change", async ({ page }) => {
    await openAs(page, "cdd_analyst", "ownership_review", "/work");
    await page.locator('[data-work-item="wi_own_review"]').click();
    await expect(page).toHaveURL(/item=wi_own_review/);
    // The case moves on underneath (another reviewer decides): the queue changes shape.
    await mock(page, "PUT", "/mock/scenario", { scenario: "screening_review" });
    const pill = page.getByRole("button", { name: /new item.* — show/ });
    await expect(pill).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-work-item="wi_own_review"]')).toBeVisible();
    await pill.click();
    await expect(pill).toBeHidden();
    await expect(page.locator('[data-work-item="wi_own_review"]')).toHaveCount(0);
  });
});

test.describe("BIZ-02 · Case room", () => {
  test("BIZ-02-AC1: stages are labelled derived and the current stage follows S1 → S2 → S3", async ({ page }) => {
    await openAs(page, "cdd_analyst", "ownership_review", ROOM);
    await expect(page.getByText("derived from work items and the task order; not stored")).toBeVisible();
    const current = page.locator('[aria-current="step"]');
    await expect(current).toContainText("Identity & ownership");
    await expectAccessible(page);
    await mock(page, "PUT", "/mock/scenario", { scenario: "screening_review" });
    await expect(current).toContainText("Screening", { timeout: 15_000 });
    await mock(page, "PUT", "/mock/scenario", { scenario: "decision_pending" });
    await expect(current).toContainText("Decision", { timeout: 15_000 });
  });

  test("BIZ-02-AC2: a new sequence updates the header in place", async ({ page }) => {
    await openAs(page, "cdd_analyst", "ownership_review", ROOM);
    await expect(caseSequence(page)).toHaveText("14");
    const heading = await page.getByRole("heading", { level: 1 }).elementHandle();
    const command = await apiCall(page, "POST", `/v1/cases/${CASE}/commands`, {
      commandType: "ResolveContradiction", commandVersion: "1.0.0",
      payload: { contradictionId: "cf-12", resolution: "ACCEPT_ASSERTION", assertionId: "as-reg", rationale: "Register is authoritative." },
      preconditions: { caseSequence: 14 }, idempotencyKey: "biz02-ac2",
    });
    expect(command.status).toBe(200);
    await expect(caseSequence(page)).toHaveText("15", { timeout: 15_000 });
    // Same element: updated in place, not re-mounted.
    expect(await heading!.evaluate((element) => element.isConnected)).toBe(true);
  });

  test("BIZ-02-AC3: claims carry epistemic markers; accepted facts show who accepted them", async ({ page }) => {
    await openAs(page, "cdd_analyst", "ownership_review", `${ROOM}/claims`);
    const table = page.getByRole("table", { name: "Claims and facts" });
    await expect(table.getByText("Fact", { exact: true }).first()).toBeVisible();
    await expect(table.getByText("Assumption", { exact: true }).first()).toBeVisible();
    await expect(table.getByText("Contradiction · open")).toBeVisible();
    await expectAccessible(page);
    await apiCall(page, "POST", `/v1/cases/${CASE}/commands`, {
      commandType: "ResolveContradiction", commandVersion: "1.0.0",
      payload: { contradictionId: "cf-12", resolution: "ACCEPT_ASSERTION", assertionId: "as-reg", rationale: "Register is authoritative." },
      preconditions: { caseSequence: 14 }, idempotencyKey: "biz02-ac3",
    });
    const bram = table.getByRole("row").filter({ hasText: "bram" });
    await expect(bram).toContainText("Contradiction · resolved", { timeout: 15_000 });
    await expect(bram).toContainText("r.okafor (human)");
  });

  test("BIZ-02 evidence: every registered item is listed, matches the count, and opens in the inspector", async ({ page }) => {
    await openAs(page, "cdd_analyst", "ownership_review", `${ROOM}/evidence`);
    const table = page.getByRole("table", { name: "Registered evidence" });
    // The list carries as many items as the navigation counts.
    await expect(table.getByRole("row")).toHaveCount(1 + 9);
    await expect(page.getByRole("navigation", { name: "Case sections" }).getByRole("link", { name: /^Evidence/ })).toContainText("9");
    const register = table.getByRole("row").filter({ hasText: "ev-register-acme" });
    await expect(register).toContainText("Retrieved by a tool");
    await expect(register).toContainText("2 statements");
    await expect(table.getByRole("row").filter({ hasText: "ev-intake-form" })).toContainText("not cited");
    await register.getByRole("button", { name: "Inspect evidence ev-register-acme" }).click();
    const detail = page.getByRole("complementary", { name: "Case intelligence" }).getByRole("region", { name: "ev-register-acme" });
    await expect(detail.getByText("an integrity check, not a review of the content")).toBeVisible();
    await expect(detail.getByText(/legal_status/)).toBeVisible();
    await expectAccessible(page);
  });

  test("BIZ-02 findings: recorded findings carry their stored id, derived items say so, and a closed finding moves to its history", async ({ page }) => {
    await openAs(page, "cdd_analyst", "ownership_review", `${ROOM}/findings`);
    const queue = page.getByRole("list", { name: "Open items" });
    await expect(queue.getByRole("listitem").filter({ hasText: "Sources disagree on Bram Okoro" })).toContainText("Recorded finding cf-12");
    await expect(queue.getByRole("listitem").filter({ hasText: "Indirect path via nominee" })).toContainText("Derived from ownership");
    await expect(page.getByRole("region", { name: "Closed findings" }).getByText("No recorded finding has been resolved or dispositioned yet.")).toBeVisible();
    await expectAccessible(page);

    // Once the contradiction is resolved it leaves the queue and appears in the history.
    await mock(page, "PUT", "/mock/scenario", { scenario: "screening_review" });
    const closed = page.getByRole("table", { name: "Closed findings" });
    await expect(closed.getByRole("row").filter({ hasText: "cf-12" })).toContainText("Resolved", { timeout: 15_000 });
    await expect(queue.getByRole("listitem").filter({ hasText: "Sources disagree on Bram Okoro" })).toHaveCount(0);
  });

  test("BIZ-02 disposition: a reviewer records a disposition with a rationale; an analyst is told why they cannot", async ({ page }) => {
    const title = "Operating account statement is dated more than 90 days before onboarding";
    const inspector = page.getByRole("complementary", { name: "Case intelligence" });

    // An analyst sees the finding and the reason, but no action.
    await openAs(page, "relationship_manager", "ownership_review", `${ROOM}/findings`);
    await page.getByRole("list", { name: "Open items" }).getByRole("button", { name: new RegExp(title) }).click();
    const selected = inspector.getByRole("region", { name: title });
    await expect(selected.getByText("Recording a disposition needs the reviewer role (case.review).")).toBeVisible();
    await expect(selected.getByRole("button", { name: "Record disposition" })).toHaveCount(0);

    // A reviewer records it: nothing is pre-selected and the rationale is required.
    await become(page, "compliance_officer");
    await go(page, `${ROOM}/findings`);
    await page.getByRole("list", { name: "Open items" }).getByRole("button", { name: new RegExp(title) }).click();
    await selected.getByRole("button", { name: "Record disposition" }).click();
    const sheet = page.getByRole("dialog", { name: "Record a disposition" });
    const record = sheet.getByRole("button", { name: "Record disposition" });
    await expect(record).toBeDisabled();
    await expect(sheet.getByRole("checkbox", { name: "ev-account-statement" })).not.toBeChecked();
    await sheet.getByRole("radio", { name: /^Not substantiated/ }).check();
    await expect(record).toBeDisabled();
    await sheet.getByLabel("Rationale (required)").fill("The statement is within the accepted window for this product.");
    await sheet.getByRole("checkbox", { name: "ev-account-statement" }).check();
    await expectAccessible(page);
    await record.click();
    await expect(sheet.getByText(/Recorded\. The case now reads sequence/)).toBeVisible();
    await sheet.getByRole("button", { name: "Done" }).click();

    // It leaves the queue and its history shows who concluded what, and why.
    await expect(page.getByRole("list", { name: "Open items" }).getByRole("button", { name: new RegExp(title) })).toHaveCount(0);
    const closed = page.getByRole("table", { name: "Closed findings" }).getByRole("row").filter({ hasText: "fd-21" });
    await expect(closed).toContainText("Dispositioned");
    await expect(closed).toContainText("not substantiated");
    await expect(closed).toContainText("The statement is within the accepted window for this product.");
  });

  test("Assignment: everyone sees who the case is assigned to; only a case manager can reassign it", async ({ page }) => {
    // An analyst sees the assignment and has no way to change it.
    await openAs(page, "cdd_analyst", "ownership_review", ROOM);
    const panel = page.getByRole("region", { name: "Assigned to" });
    await expect(panel).toContainText("KYB onboarding");
    await expect(panel).toContainText("r.okafor");
    await expect(panel.getByRole("button", { name: "Reassign" })).toHaveCount(0);

    // A manager reassigns: people are named within the chosen team, and a reason is required.
    await become(page, "case_manager");
    await go(page, ROOM);
    await panel.getByRole("button", { name: "Reassign" }).click();
    const sheet = page.getByRole("dialog", { name: "Reassign the case" });
    const submit = sheet.getByRole("button", { name: "Reassign" });
    await sheet.getByLabel("Team").selectOption("compliance-review");
    await expect(sheet.getByRole("checkbox", { name: "r.okafor" })).toHaveCount(0);
    await sheet.getByRole("checkbox", { name: "s.varga" }).check();
    await expect(submit).toBeDisabled();
    await sheet.getByLabel("Reason (required)").fill("Escalated to compliance for the ownership conflict.");
    await expectAccessible(page);
    await submit.click();
    await expect(sheet.getByText(/Assigned\. The case now reads sequence/)).toBeVisible();
    await sheet.getByRole("button", { name: "Done" }).click();
    await expect(panel).toContainText("Compliance review");
    await expect(panel).toContainText("s.varga");

    // The manager oversees but does not decide.
    const step = page.getByRole("complementary", { name: "Case intelligence" }).getByRole("region", { name: "Accept supported ownership findings or request further evidence" });
    await expect(step.getByRole("button", { name: "Decide" })).toBeDisabled();

    // The manager's queue is everything, and shows the new assignment.
    await go(page, "/work");
    await expect(page.getByTestId("queue-scope")).toHaveText("All case work in the tenant. You oversee case work.");
    await expect(page.getByText("Case assigned to: Compliance review · s.varga").first()).toBeVisible();

    // The named reviewer sees it as theirs; the analyst whose team no longer holds the case does not see it at all.
    await become(page, "compliance_officer");
    await go(page, "/work");
    await expect(page.getByTestId("queue-scope")).toHaveText("Work on cases assigned to you, to your teams, or not yet assigned to anyone.");
    await expect(page.getByText("Case assigned to: Compliance review · s.varga · assigned to you").first()).toBeVisible();
    await become(page, "cdd_analyst");
    await go(page, "/work");
    await expect(page.locator(`[data-work-item]`)).toHaveCount(0);
  });

  test("BIZ-02: every section renders accessibly", async ({ page }) => {
    await openAs(page, "cdd_analyst", "ownership_review", ROOM);
    for (const section of ["evidence", "work", "decisions", "history"]) {
      await go(page, `${ROOM}/${section}`);
      await expect(page.getByRole("navigation", { name: /^Case (sections|record)$/ }).getByRole("link", { name: new RegExp(`^${section}`, "i") })).toHaveAttribute("aria-current", "page");
      await expectAccessible(page);
    }
  });
});
