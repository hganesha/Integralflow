import { expect, test } from "@playwright/test";
import { apiCall, DRAFT_B, draftRevision } from "./authoring-support";
import { expectAccessible, signInAs } from "./support";

// Journey A · configure context (BUILD-SPEC v2 §11.3). One page load, so the in-page mock
// keeps the journey's edits. The "second tab" is a direct API call made by the same persona
// from inside the page, exactly what another browser tab would send.

test("Journey A · configure context: Play for agent.screening → Tune a draft → save → a concurrent save shows the conflict view and keeps the edit", async ({ page }) => {
  await signInAs(page, "context_architect", "/context?view=banks");
  await expect(page.getByRole("heading", { level: 1, name: "Contextboard" })).toBeVisible();

  // Play: the screening agent's perspective restricts the banks to its subscriptions.
  await page.getByRole("button", { name: /^agent\.screening/ }).click();
  await expect(page.locator('[data-bank="transaction.intelligence"]')).toHaveAttribute("data-status", "not_subscribed");
  await expect(page.locator('[data-bank="screening.intelligence"]')).not.toHaveAttribute("data-status", "not_subscribed");
  await page.locator('[data-bank="screening.intelligence"]').click();
  await expect(page).toHaveURL(/agent=agent\.screening.*product=screening\.intelligence|product=screening\.intelligence.*agent=agent\.screening/);

  // Tune: pick a draft and add a selector.
  await page.getByRole("tab", { name: "Tune" }).click();
  await expect(page.getByText("Focused on Screening intelligence")).toBeVisible();
  await page.getByLabel("Draft").selectOption(DRAFT_B);
  const selectors = page.getByRole("region", { name: "Context selectors" });
  await expect(selectors).toBeVisible();
  const start = await draftRevision(page, DRAFT_B);
  await selectors.getByRole("button", { name: "Add selector" }).click();
  await selectors.getByLabel("ID").fill("screening-subject");
  await selectors.getByLabel("Path").fill("case.subject.name");
  await selectors.getByRole("button", { name: "Save selectors" }).click();
  await expect(selectors.getByText("Saved 1 selector to the draft.")).toBeVisible();
  expect(await draftRevision(page, DRAFT_B)).toBe(start + 1);

  // Edit again locally…
  await selectors.getByLabel("Purpose").fill("KYC_SCREENING_REVIEW");
  // …while a second tab saves a different change on the same revision.
  const other = await apiCall(page, "PUT", `/v1/authoring/drafts/${DRAFT_B}/context-selectors`, {
    expectedRevision: start + 1,
    contextSelectors: [{ id: "screening-subject", source: "case", path: "case.subject.legalName", purpose: "KYC_SCREENING", classification: "CONFIDENTIAL", required: true }],
  });
  expect(other.status).toBe(200);

  await selectors.getByRole("button", { name: "Save selectors" }).click();
  const conflict = selectors.getByRole("region", { name: `Changed since you opened it (rev ${start + 1} → ${start + 2})` });
  await expect(conflict).toBeVisible();
  await expect(conflict.getByText("authoring.revision_conflict_or_published")).toBeVisible();
  await expect(conflict.getByLabel(`Context selectors · revision ${start + 2} (server)`)).toHaveValue(/case\.subject\.legalName/);
  await expect(conflict.getByLabel(`Context selectors · your edit (based on revision ${start + 1})`)).toHaveValue(/KYC_SCREENING_REVIEW/);
  // The local edit is kept, never merged.
  await expect(selectors.getByLabel("Purpose")).toHaveValue("KYC_SCREENING_REVIEW");
  await expect(selectors.getByLabel("Path")).toHaveValue("case.subject.name");
  await expectAccessible(page);

  // Re-apply on the new revision by hand: keep my edit, then save.
  await conflict.getByRole("button", { name: `Keep my edit on revision ${start + 2}` }).click();
  await selectors.getByRole("button", { name: "Save selectors" }).click();
  await expect(selectors.getByText("Saved 1 selector to the draft.")).toBeVisible();
  const saved = await apiCall<{ revision: number; parsedPackage: { contextSelectors: Array<{ path: string; purpose: string }> } }>(page, "GET", `/v1/authoring/drafts/${DRAFT_B}`);
  expect(saved.body.revision).toBe(start + 3);
  expect(saved.body.parsedPackage.contextSelectors).toEqual([expect.objectContaining({ path: "case.subject.name", purpose: "KYC_SCREENING_REVIEW" })]);

  // Production readiness (Play) does not change from a Tune edit.
  await page.getByRole("tab", { name: "Play" }).click();
  await expect(page.locator('[data-bank="screening.intelligence"]')).not.toHaveAttribute("data-status", "not_subscribed");
});
