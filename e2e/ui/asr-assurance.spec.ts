import { expect, test } from "@playwright/test";
import { forceNextResponse, installForcedResponses } from "./authoring-support";
import { CASE, go, openInScenario } from "./assurance-support";
import { expectAccessible, signInAs } from "./support";

test.describe("ASR-01 · Mission Control", () => {
  test("ASR-01-AC1: KPI definitions and generatedAt are visible; exceptions link to filtered platform lists", async ({ page }) => {
    await signInAs(page, "auditor", "/assurance");
    await expect(page.getByRole("heading", { name: "Mission Control", level: 1 })).toBeVisible();
    const tile = page.locator('[data-kpi="cases_open"]');
    await expect(tile).toContainText("Cases in flight");
    await expect(tile).toContainText("Definition: Cases not in APPROVED, DECLINED or CLOSED");
    await expect(page.getByText(/^Generated /).first()).toBeVisible();
    await expectAccessible(page);
    await page.getByRole("region", { name: "Exceptions" }).getByRole("link", { name: /Run failed: provider timeout/ }).click();
    await expect(page).toHaveURL(/\/platform\/runs\?status=failed$/);
  });

  test("ASR-01: the auditor lands on Mission Control and can open a case's recorder", async ({ page }) => {
    await signInAs(page, "auditor", "/");
    await expect(page).toHaveURL(/\/assurance$/);
    const audit = page.getByRole("region", { name: "Audit a case" });
    const caseViews = audit.getByRole("navigation", { name: `Assurance views for ${CASE}` });
    await expect(caseViews).toBeVisible();
    await page.setViewportSize({ width: 320, height: 900 });
    await expect(caseViews.getByRole("link", { name: "Decision lineage" })).toBeVisible();
    await expect(caseViews.getByRole("link", { name: "Assurance package" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await caseViews.getByRole("link", { name: "Flight recorder" }).click();
    await expect(page).toHaveURL(new RegExp(`/assurance/recorder/${CASE}$`));
    await expect(page.getByRole("heading", { name: CASE, level: 1 })).toBeVisible();
  });
});

test.describe("ASR-02 · Flight Recorder", () => {
  test("ASR-02-AC1: entries are ordered by time with a human decision before the case events it caused, and the rule is stated", async ({ page }) => {
    await openInScenario(page, "auditor", "decided", `/assurance/recorder/${CASE}`);
    await expect(page.getByTestId("ordering-rule")).toContainText("the decision comes first");
    const refs = await page.getByRole("list", { name: "Recorder chronology" }).locator("button[data-ref]").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-ref")));
    expect(refs).toHaveLength(37);
    expect(refs.indexOf("human_decision:dec_own_okafor:0")).toBe(refs.indexOf("case_event:KYB-1042:16") - 1);
    expect(refs.indexOf("human_decision:dec_final_adeyemi:0")).toBeLessThan(refs.indexOf("case_event:KYB-1042:32"));
    expect(refs.indexOf("case_event:KYB-1042:13")).toBeLessThan(refs.indexOf("case_event:KYB-1042:14"));
    await expectAccessible(page);
  });

  test("ASR-02-AC2: interrupts are marked and counted", async ({ page }) => {
    await openInScenario(page, "auditor", "decided", `/assurance/recorder/${CASE}`);
    const summary = page.getByRole("list", { name: "Recorder summary" }).or(page.getByLabel("Recorder summary"));
    await expect(summary).toContainText("Interrupts3");
    await expect(page.getByRole("list", { name: "Recorder chronology" }).locator('button[data-interrupt="true"]')).toHaveCount(3);
    await expect(page.getByRole("list", { name: "Recorder chronology" }).getByText("Interrupt", { exact: true })).toHaveCount(3);
    await expect(summary.getByText("Historical · read only")).toBeVisible();
  });

  test("ASR-02: selecting an entry shows its ledger record, raw JSON and verification in the inspector; causality focuses on it", async ({ page }) => {
    await openInScenario(page, "auditor", "decided", `/assurance/recorder/${CASE}`);
    await page.locator('button[data-ref="case_event:KYB-1042:13"]').click();
    await expect(page).toHaveURL(/entry=case_event/);
    const inspector = page.getByRole("complementary", { name: "Event inspector" });
    await expect(inspector.getByRole("heading", { name: "RequestHumanReview" })).toBeVisible();
    await expect(inspector.getByText("Hash chain verified")).toBeVisible();
    await expect(inspector.getByText(/"sequence": 13/)).toBeVisible();
    await page.getByRole("tab", { name: /Causality/ }).click();
    await expect(page.getByRole("group", { name: "Human lane" }).getByText("Human review requested")).toBeVisible();
    await expect(page.getByRole("table", { name: "Causal links" })).toBeVisible();
    await expectAccessible(page);
  });

  test("ASR-02-AC3: the Traces tab shows the span waterfall and links to the run", async ({ page }) => {
    await openInScenario(page, "auditor", "decided", `/assurance/recorder/${CASE}?tab=traces`);
    await expect(page.getByRole("list", { name: /^Spans of trace / })).toBeVisible();
    await expect(page.getByRole("button", { name: "run.execute" })).toBeVisible();
    await expect(page.getByText("Telemetry is not the audit record")).toBeVisible();
    await expectAccessible(page);
    await page.getByRole("link", { name: "Open run run_kyb_1042" }).click();
    await expect(page).toHaveURL(/\/platform\/runs\/run_kyb_1042$/);
  });

  test("ASR-02-AC4: a ledger verification failure shows the failed sequence and blocks every Verified chip", async ({ page }) => {
    await installForcedResponses(page);
    await openInScenario(page, "auditor", "decided", "/assurance");
    await forceNextResponse(page, "/ledger:verify", 200, { verified: false, checkedEvents: 12, headDigest: null, failedSequence: 12 });
    await go(page, `/assurance/recorder/${CASE}?entry=case_event:KYB-1042:13`);
    const summary = page.getByLabel("Recorder summary");
    await expect(summary.getByText("Verification failed at sequence 12")).toBeVisible();
    await expect(summary.getByText("Verified", { exact: true })).toHaveCount(0);
    const inspector = page.getByRole("complementary", { name: "Event inspector" });
    await expect(inspector.getByText("Not verified: the chain breaks at sequence 12")).toBeVisible();
    await expect(inspector.getByText("Hash chain verified")).toHaveCount(0);

    // Verifying again against the intact ledger restores the chip.
    await summary.getByRole("button", { name: "Verify again" }).click();
    await expect(summary.getByText("Verified", { exact: true })).toBeVisible();
    await expect(inspector.getByText("Hash chain verified")).toBeVisible();
  });
});

test.describe("ASR-03 · Decision lineage", () => {
  test("ASR-03-AC1: highlighting backwards from the decision reaches the sources; distinct actors are counted", async ({ page }) => {
    await openInScenario(page, "auditor", "decided", `/assurance/lineage/${CASE}`);
    await expect(page.locator('[data-node="d"]')).toHaveAttribute("aria-pressed", "true");
    for (const id of ["p", "f1", "f2", "f3", "c1", "c2", "e1", "e2", "e3", "s1", "s2"]) {
      await expect(page.locator(`[data-node="${id}"]`)).toHaveAttribute("data-path", "true");
    }
    await expect(page.getByTestId("distinct-actors")).toHaveText("5");
    await expect(page.getByText("Watchlist coverage incomplete")).toBeVisible();
    await expectAccessible(page);

    // Tracing from the PEP finding reaches only its own evidence and source.
    await page.locator('[data-node="f2"]').click();
    await expect(page).toHaveURL(/node=f2/);
    for (const id of ["f2", "e3", "s2"]) await expect(page.locator(`[data-node="${id}"]`)).toHaveAttribute("data-path", "true");
    for (const id of ["d", "p", "f1", "e1", "s1"]) await expect(page.locator(`[data-node="${id}"]`)).toHaveAttribute("data-path", "false");
    await expect(page.getByRole("complementary", { name: "Lineage inspector" }).getByRole("heading", { name: "PEP candidate is a false match" })).toBeVisible();
  });

  test("ASR-03-AC2: before S5 the lineage says no decision is recorded yet", async ({ page }) => {
    await openInScenario(page, "auditor", "ownership_review", `/assurance/lineage/${CASE}`);
    await expect(page.getByRole("heading", { name: "No decision recorded yet" })).toBeVisible();
    await expectAccessible(page);
  });
});

test.describe("ASR-05 · Assurance packages", () => {
  test("ASR-05-AC1: generating needs a purpose; the result lists digest and case sequence and downloads JSON", async ({ page }) => {
    await openInScenario(page, "auditor", "decided", `/assurance/packages?case=${CASE}`);
    const generate = page.getByRole("button", { name: "Generate export" });
    await expect(generate).toBeDisabled();
    await expect(page.getByText(/Kept on this screen only/)).toBeVisible();
    await page.getByLabel(/Purpose/).fill("Annual audit sample");
    await generate.click();
    await expect(page.getByRole("heading", { name: "Export ready" })).toBeVisible();
    await expect(page.getByTestId("export-sequence")).toHaveText("33");
    await expect(page.getByLabel("export digest").first()).toBeVisible();
    await expect(page.getByText("Verified", { exact: true })).toBeVisible();
    await expectAccessible(page);
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download JSON" }).click();
    expect((await download).suggestedFilename()).toMatch(/^KYB-1042-audit-[0-9a-f]{12}\.json$/);
    await expect(page.getByText("Saved the JSON export.")).toBeVisible();
  });
});
