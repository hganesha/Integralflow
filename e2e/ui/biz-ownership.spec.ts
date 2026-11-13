import { expect, test } from "@playwright/test";
import { apiCall } from "./authoring-support";
import { expectAccessible } from "./support";
import { CASE, caseSequence, decideInSheet, go, openAs } from "./work-support";

const LENS = `/work/cases/${CASE}/lens/ownership`;

test.describe("BIZ-03 · Ownership workbench", () => {
  test("BIZ-03-AC1/AC2/AC3: the conflict edge shows both values; unverified persons never show the fact glyph; the table lists every edge", async ({ page }) => {
    await openAs(page, "cdd_analyst", "ownership_review", LENS);
    await expect(page.locator('[data-edge="e3"]')).toHaveAttribute("data-status", "conflict");
    await expect(page.locator('[data-edge="e3"]')).toContainText("12% / 22%");
    // Chen Wei is a candidate UBO (unverified): never ◆, whatever the node's epistemic field says.
    await expect(page.locator('[data-node="chen"]')).not.toHaveAttribute("data-glyph", "◆");
    await expect(page.locator('[data-node="bram"]')).not.toHaveAttribute("data-glyph", "◆");
    await expect(page.locator('[data-node="alice"]')).toHaveAttribute("data-glyph", "◆");
    await expectAccessible(page);

    await page.getByRole("radio", { name: "Table" }).click();
    const table = page.getByRole("table", { name: "Ownership and control edges" });
    await expect(table.getByRole("row")).toHaveCount(1 + 5);
    await expect(table.getByRole("row").filter({ hasText: "Bram Okoro" })).toContainText("12% / 22%");
    await expectAccessible(page);
  });

  test("BIZ-03 canvas: a selected party shows its path and calculation; filters say what they hide; the view survives leaving and returning", async ({ page }) => {
    await openAs(page, "cdd_analyst", "ownership_review", LENS);
    const inspector = page.getByRole("complementary", { name: "Case intelligence" });

    // Select a party: its path to the customer is emphasised and the arithmetic is shown.
    await page.locator('[data-node="chen"]').click();
    await expect(page).toHaveURL(/node=chen/);
    const party = inspector.getByRole("region", { name: "Chen Wei" });
    await expect(party.getByText("100% × 60% × 45% = 27%")).toBeVisible();
    await expect(page.locator('[data-edge="e5"]')).toHaveAttribute("data-dim", "false");
    await expect(page.locator('[data-edge="e1"]')).toHaveAttribute("data-dim", "true");
    // A conflicting interest is never multiplied through.
    await page.locator('[data-node="bram"]').click();
    await expect(inspector.getByRole("region", { name: "Bram Okoro" }).getByText(/Unable to determine\./)).toBeVisible();

    // A filter states what it hides.
    await page.getByRole("radio", { name: "Conflicts" }).click();
    await expect(page.getByText("4 parties and 4 relationships hidden by this filter.")).toBeVisible();
    await expect(page.locator('[data-node="alice"]')).toHaveCount(0);

    // Keyboard: a relationship is selectable with Enter.
    await page.locator('[data-edge="e3"]').focus();
    await page.keyboard.press("Enter");
    await expect(inspector.getByRole("region", { name: "Bram Okoro → Acme Trading Ltd" })).toBeVisible();
    await expectAccessible(page);

    // Zoom, leave for another workspace, come back: filter, selection and zoom are as they were.
    await page.getByRole("button", { name: "Zoom in" }).click();
    await expect(page.getByLabel("Zoom level")).toHaveText("125%");
    await page.getByRole("navigation", { name: "Case sections" }).getByRole("link", { name: /^Overview/ }).click();
    await expect(page.getByRole("heading", { level: 2, name: "Overview" })).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(/show=conflict/);
    await expect(page).toHaveURL(/edge=e3/);
    await expect(page.getByLabel("Zoom level")).toHaveText("125%");
    await expect(page.getByRole("radio", { name: "Conflicts" })).toBeChecked();

    // The table carries the same selection.
    await page.getByRole("radio", { name: "Table" }).click();
    await expect(page.getByRole("table", { name: "Ownership and control edges" }).getByRole("button", { name: "Inspecting" })).toBeVisible();
  });

  test("Evidence: a reference opens its recorded passage in the inspector and keeps the page's selection", async ({ page }) => {
    await openAs(page, "cdd_analyst", "ownership_review", `${LENS}?node=bram`);
    const inspector = page.getByRole("complementary", { name: "Case intelligence" });
    const panel = page.getByRole("region", { name: /Contradiction cf-12/ });
    await panel.getByRole("button", { name: "Inspect evidence ev-decl-acme" }).click();
    const evidence = inspector.getByRole("region", { name: "ev-decl-acme" });
    await expect(evidence.getByText(/B\. Okoro — 22% ordinary/)).toBeVisible();
    await expect(evidence.getByText(/page 2/)).toBeVisible();
    // A reference with no linked document is never presented as an inspected source.
    await expect(evidence.getByText("Source not available here")).toBeVisible();
    // The originating selection is untouched.
    await expect(page).toHaveURL(/node=bram/);
    await expect(inspector.getByRole("region", { name: "Bram Okoro", exact: true })).toBeVisible();
    await expectAccessible(page);
    await evidence.getByRole("button", { name: "Close evidence" }).click();
    await expect(evidence).toHaveCount(0);
    await expect(page).toHaveURL(/node=bram/);
  });

  test("BIZ-03-AC4: accepting the register value previews ResolveContradiction, submits, and the case moves 14 → 15", async ({ page }) => {
    await openAs(page, "cdd_analyst", "ownership_review", LENS);
    await expect(caseSequence(page)).toHaveText("14");
    const panel = page.getByRole("region", { name: /Contradiction cf-12/ });
    await expect(panel.getByText("Open", { exact: true })).toBeVisible();
    await panel.getByRole("button", { name: "Accept register value (12%)" }).click();

    const sheet = page.getByRole("dialog", { name: "Accept register value (12%)" });
    await sheet.getByLabel("Rationale (required)").fill("The certified register is authoritative.");
    await sheet.getByRole("button", { name: "Preview" }).click();
    const preview = sheet.getByRole("region", { name: "Command preview" });
    await expect(preview.getByText("ResolveContradiction").first()).toBeVisible();
    await expect(preview.getByRole("row").filter({ hasText: "contradictions.cf-12.status" })).toContainText("RESOLVED");
    await expectAccessible(page);
    await sheet.getByRole("button", { name: "Submit command" }).click();
    await expect(sheet.getByText("ACCEPTED")).toBeVisible();
    await expect(sheet.getByText("Recorded. The case now reads sequence 15.")).toBeVisible();
    await sheet.getByRole("button", { name: "Close", exact: true }).last().click();

    await expect(caseSequence(page)).toHaveText("15");
    await expect(panel.getByText("Resolved", { exact: true })).toBeVisible();
    await expect(page.locator('[data-edge="e3"]')).toHaveAttribute("data-status", "verified");
    await expect(page.locator('[data-edge="e3"]')).toContainText("12%");
    await expect(page.locator('[data-edge="e3"]')).not.toContainText("22%");
  });

  test("BIZ-03-AC5: a decision on basis 14 after the case moved is refused as stale; Review again reloads basis 15 and the decision lands (→ S2)", async ({ page }) => {
    await openAs(page, "cdd_analyst", "ownership_review", LENS);
    const step = page.getByRole("complementary", { name: "Case intelligence" }).getByRole("region", { name: "Accept supported ownership findings or request further evidence" });
    await step.getByRole("button", { name: "Decide" }).click();
    const sheet = page.getByRole("dialog");
    await expect(sheet.getByText(/deciding on the case as of sequence/)).toContainText("14");

    // While the sheet is open the case moves on (the contradiction is resolved, 14 → 15).
    const command = await apiCall(page, "POST", `/v1/cases/${CASE}/commands`, {
      commandType: "ResolveContradiction", commandVersion: "1.0.0",
      payload: { contradictionId: "cf-12", resolution: "ACCEPT_ASSERTION", assertionId: "as-reg", rationale: "Register is authoritative." },
      preconditions: { caseSequence: 14 }, idempotencyKey: "biz03-ac5",
    });
    expect(command.body).toMatchObject({ outcome: "ACCEPTED", caseSequence: 15 });

    await decideInSheet(page, "Accept ownership findings");
    await expect(sheet.getByText("The case changed while you were reviewing (sequence 14 → 15).").first()).toBeVisible();
    // Case roles read the event log, so the sheet lists what changed since the basis.
    await expect(sheet.getByRole("heading", { name: "What changed since sequence 14" })).toBeVisible();
    await sheet.getByRole("button", { name: "Review again" }).click();
    await expect(sheet.getByText(/deciding on the case as of sequence/)).toContainText("15");
    await decideInSheet(page, "Accept ownership findings");
    await expect(sheet.getByText("Recorded. This item is complete.").first()).toBeVisible();
    await sheet.getByRole("button", { name: "Close", exact: true }).last().click();
    await expect(page.locator('[aria-current="step"]')).toContainText("Screening");
  });

  test("BIZ-03-AC6: as relationship_manager the human step is visible but Decide is disabled with the reason", async ({ page }) => {
    await openAs(page, "relationship_manager", "ownership_review", LENS);
    const step = page.getByRole("complementary", { name: "Case intelligence" }).getByRole("region", { name: "Accept supported ownership findings or request further evidence" });
    await expect(step).toBeVisible();
    await expect(step.getByRole("button", { name: "Decide" })).toBeDisabled();
    await expect(step.getByText("Your role doesn't permit deciding this step. It needs human_work.decide.")).toBeVisible();
    await expectAccessible(page);
  });

  test("BIZ-03-AC7: RETURN creates the rework item and the case appears under Prepared by agents", async ({ page }) => {
    await openAs(page, "cdd_analyst", "ownership_review", LENS);
    const step = page.getByRole("complementary", { name: "Case intelligence" }).getByRole("region", { name: "Accept supported ownership findings or request further evidence" });
    await step.getByRole("button", { name: "Decide" }).click();
    const sheet = await decideInSheet(page, "Request further evidence", "Need the certified share register for Meridian.");
    await expect(sheet.getByText("Recorded. This item is complete.").first()).toBeVisible();
    await sheet.getByRole("button", { name: "Close", exact: true }).last().click();
    await go(page, "/work");
    const prepared = page.locator('[data-group="prepared_by_agents"]');
    await expect(prepared.locator('[data-work-item="wi_own_rework"]')).toBeVisible();
    await expect(prepared).toContainText("Rework ownership findings");
  });
});
