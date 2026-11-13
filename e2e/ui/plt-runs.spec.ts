import { expect, test, type Page } from "@playwright/test";
import { expectAccessible, mock, signInAs } from "./support";

// Platform overview, plans, runs, run detail and trace (BUILD-SPEC v2 §10, PLT-01 and PLT-05…08).

const PLAN = "bcd282f4fea36064672d780fc58478330b105effb706a2727e20794bf82162f8";
const RUN = "run_kyb_1042";
const TRACE = "2bc3e2d0bf178f646b13c35b25ee0ddb";

/** Navigate inside the SPA (no reload), so the in-page mock keeps runs started in this test. */
async function go(page: Page, path: string): Promise<void> {
  await page.evaluate((to) => {
    window.history.pushState({}, "", to);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, path);
}

test.describe("PLT-01 Overview", () => {
  test("PLT-01-AC1: every KPI tile links to its filtered list", async ({ page }) => {
    await signInAs(page, "ops_manager", "/platform");
    await expect(page.getByRole("heading", { name: "Overview", level: 1 })).toBeVisible();
    const expected: Record<string, string> = {
      admitted: "/platform/plans",
      active: "/platform/runs?active=1",
      queued: "/platform/runs?status=queued",
      running: "/platform/runs?status=running",
      retrying: "/platform/runs?status=retrying",
      attention: "/platform/runs?attention=1",
      failed: "/platform/runs?status=failed",
      denied: "/platform/runs?status=denied",
      stale: "/platform/runs?status=retrying",
      cost: "/platform/runs",
    };
    for (const [key, href] of Object.entries(expected)) {
      await expect(page.locator(`[data-tile="${key}"]`)).toHaveAttribute("href", href);
    }
    await expectAccessible(page);
    await page.locator('[data-tile="failed"]').click();
    await expect(page).toHaveURL(/\/platform\/runs\?status=failed$/);
    await expect(page.getByLabel("Status", { exact: true })).toHaveValue("failed");
  });

  test("PLT-01-AC2: reported cost says incomplete when cost data is incomplete", async ({ page }) => {
    await signInAs(page, "auditor", "/platform");
    const tile = page.locator('[data-tile="cost"]');
    await expect(tile).toContainText("Reported cost · 24 h");
    await expect(tile).toContainText("$0.0000");
    await expect(tile.getByText("incomplete")).toBeVisible();
  });
});

test.describe("PLT-05 Plans", () => {
  test("list shows shape, tiers, completion and timing; a reader cannot admit", async ({ page }) => {
    await signInAs(page, "auditor", "/platform/plans");
    const row = page.getByRole("row", { name: /fincrime-kyb/ });
    await expect(row).toContainText("29 / 34");
    await expect(row).toContainText("41/48");
    await expect(page.getByRole("button", { name: "Admit plan" })).toBeDisabled();
    await expect(page.getByText("Admitting needs plan.admit")).toBeVisible();
    await page.getByLabel("Name or digest").fill("nothing-matches");
    await page.getByRole("search", { name: "Filter plans" }).getByRole("button", { name: "Apply" }).click();
    await expect(page).toHaveURL(/q=nothing-matches/);
    await expect(page.getByText("No plans match these filters")).toBeVisible();
    await expectAccessible(page);
  });

  test("detail: graph preview has a table alternative; budgets, dependencies and runs show; input is validated", async ({ page }) => {
    await signInAs(page, "ops_manager", `/platform/plans/${PLAN}`);
    await expect(page.getByRole("img", { name: /fincrime-kyb plan graph/ })).toBeVisible();
    await page.getByRole("button", { name: "Show as table" }).click();
    await expect(page.getByRole("table", { name: "fincrime-kyb plan graph: nodes" }).getByRole("row")).toHaveCount(10);
    await expect(page.getByText("Max model calls")).toBeVisible();
    await expect(page.getByRole("cell", { name: "policy:kyc" })).toBeVisible();
    await expect(page.getByRole("link", { name: RUN })).toBeVisible();
    await expectAccessible(page);

    await page.getByRole("button", { name: "Start run" }).click();
    const sheet = page.getByRole("dialog", { name: "Start run" });
    let started = 0;
    page.on("request", (request) => { if (request.method() === "POST" && request.url().endsWith("/v1/runs")) started += 1; });
    await sheet.getByLabel("Run input (JSON)").fill('{"tenantId":"tenant_demo","priority":"high"}');
    await sheet.getByRole("button", { name: "Start run" }).click();
    await expect(sheet.getByRole("list", { name: "Input problems" })).toContainText("caseId");
    expect(started).toBe(0);
    await expectAccessible(page);
  });

  test("PLT-05-AC1: the same Idempotency-Key returns the same run, and the UI links to it", async ({ page }) => {
    await signInAs(page, "ops_manager", `/platform/plans/${PLAN}`);
    const keys: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "POST" && request.url().endsWith("/v1/runs")) keys.push(request.headers()["idempotency-key"] ?? "");
    });
    await page.getByRole("button", { name: "Start run" }).click();
    const sheet = page.getByRole("dialog", { name: "Start run" });
    await sheet.getByLabel("Run input (JSON)").fill('{"tenantId":"tenant_demo","caseId":"KYB-2001"}');
    await sheet.getByRole("button", { name: "Start run" }).click();
    const first = sheet.getByRole("link", { name: /^Open run / });
    await expect(sheet.getByText(/started\./)).toBeVisible();
    const runId = (await first.textContent())!.replace("Open run ", "").trim();

    await sheet.getByRole("button", { name: "Start run" }).click();
    await expect(sheet.getByText(`This request already started run`)).toBeVisible();
    await expect(sheet.getByText("No duplicate was created.")).toBeVisible();
    await expect(sheet.getByRole("link", { name: `Open run ${runId}` })).toBeVisible();
    expect(keys).toHaveLength(2);
    expect(keys[0]).toMatch(/^web-/);
    expect(keys[1]).toBe(keys[0]);

    await sheet.getByRole("button", { name: "Close" }).first().click();
    const runsOfPlan = page.getByRole("table", { name: "Runs of this plan" });
    await expect(runsOfPlan.getByRole("link", { name: runId })).toHaveCount(1);
    await expect(runsOfPlan.getByRole("row")).toHaveCount(3);

    // The started run has no trace yet (PLT-07 AC4), and can be cancelled with a reason.
    await runsOfPlan.getByRole("link", { name: runId }).click();
    await expect(page).toHaveURL(new RegExp(`/platform/runs/${runId}$`));
    await expect(page.getByText("No trace bound to this run")).toBeVisible();
    await page.getByRole("button", { name: "Cancel run" }).click();
    const cancel = page.getByRole("dialog", { name: `Cancel run ${runId}` });
    await expect(cancel.getByRole("button", { name: "Cancel run" })).toBeDisabled();
    await cancel.getByLabel("Reason").fill("Started by mistake");
    await cancel.getByRole("button", { name: "Cancel run" }).click();
    await expect(page.getByText("Cancellation recorded.")).toBeVisible();
    await expect(page.getByText("Cancelled", { exact: true }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Cancel run" })).toBeDisabled();
  });

  test("PLT-05-AC2: when admission is stopped, start → 409 and the copy points to the runtime tab", async ({ page }) => {
    await signInAs(page, "ops_manager", `/platform/plans/${PLAN}`);
    await page.getByRole("button", { name: "Start run" }).click();
    const sheet = page.getByRole("dialog", { name: "Start run" });
    await sheet.getByLabel("Run input (JSON)").fill('{"tenantId":"tenant_demo","caseId":"KYB-2002"}');
    // No persona holds postAdminRuntime's action (deployment.execute) in the mock, so inject the
    // mock's own refusal. Sticky, so a background poll cannot consume it first; cleared after.
    await mock(page, "PUT", "/mock/faults", { failNext: { status: 409, error: "runtime.admission_stopped" }, sticky: ["failNext"] });
    await sheet.getByRole("button", { name: "Start run" }).click();
    await expect(sheet.getByText("Run admission is stopped in this environment")).toBeVisible();
    await mock(page, "PUT", "/mock/faults", { failNext: null, sticky: [] });
    const link = sheet.getByRole("link", { name: "Open Health › Runtime" });
    await expect(link).toHaveAttribute("href", "/platform/system?tab=runtime");
    await expect(sheet.getByText(/started\./)).toHaveCount(0);
    await expectAccessible(page);
  });
});

test.describe("PLT-06/07 Runs and run detail", () => {
  test("runs list filters by status in the URL; reader sees cancel disabled with a reason", async ({ page }) => {
    await signInAs(page, "auditor", "/platform/runs");
    await expect(page.getByRole("link", { name: RUN })).toBeVisible();
    await page.getByLabel("Status", { exact: true }).selectOption("completed");
    await expect(page).toHaveURL(/status=completed/);
    await expect(page.getByText("No runs match these filters")).toBeVisible();
    await page.getByLabel("Status", { exact: true }).selectOption("manual_review");
    await expect(page.getByRole("link", { name: RUN })).toBeVisible();
    await expectAccessible(page);
    await page.getByRole("link", { name: RUN }).click();
    await expect(page.getByRole("button", { name: "Cancel run" })).toBeDisabled();
    await expect(page.getByText("Cancelling needs run.cancel")).toBeVisible();
  });

  test("PLT-07-AC1: events are appended with after = last sequence, ordered, without duplicates", async ({ page }) => {
    await signInAs(page, "ops_manager", "/platform");
    const afters: number[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname === `/api/v1/runs/${RUN}/events`) afters.push(Number(url.searchParams.get("after")));
    });
    await go(page, `/platform/runs/${RUN}`);
    const timeline = page.getByRole("list", { name: "Run events" });
    await expect(timeline.getByRole("listitem")).toHaveCount(7);
    // The run moves on: screening adds events 8–11.
    await mock(page, "PUT", "/mock/scenario", { scenario: "screening_review" });
    await expect(timeline.getByRole("listitem")).toHaveCount(11, { timeout: 15_000 });
    const sequences = await timeline.getByRole("listitem").evaluateAll((items) => items.map((item) => Number(item.getAttribute("data-sequence"))));
    expect(sequences).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(afters[0]).toBe(0);
    expect(afters).toContain(7);
    expect(afters.every((after) => after === 0 || after === 7 || after === 11)).toBe(true);
    await expect(page.getByText("11 events · through sequence 11")).toBeVisible();
    await expectAccessible(page);
  });

  test("PLT-07-AC2: a manual_review run links to its human-work item", async ({ page }) => {
    await signInAs(page, "ops_manager", `/platform/runs/${RUN}`);
    const panel = page.getByRole("region", { name: "Waiting for a human decision" });
    const link = panel.getByRole("link", { name: "wi_own_review" });
    await expect(link).toHaveAttribute("href", "/platform/human-work?item=wi_own_review&case=KYB-1042");
    await expect(page.locator('[data-current="true"]')).toContainText("Ownership review");
    await expectAccessible(page);
  });

  test("PLT-07-AC3: cancelling a run that has become terminal → 409 run.already_terminal inline with its state", async ({ page }) => {
    await signInAs(page, "ops_manager", `/platform/runs/${RUN}`);
    await page.getByRole("button", { name: "Cancel run" }).click();
    const sheet = page.getByRole("dialog", { name: `Cancel run ${RUN}` });
    await sheet.getByLabel("Reason").fill("Customer withdrew");
    // Meanwhile the run completes (the case is decided).
    await mock(page, "PUT", "/mock/scenario", { scenario: "decided" });
    await sheet.getByRole("button", { name: "Cancel run" }).click();
    const alert = sheet.getByRole("alert");
    await expect(alert).toContainText("This run has already finished, so it cannot be cancelled.");
    await expect(alert).toContainText("run.already_terminal");
    await expect(alert).toContainText("Current state:");
    await expect(alert).toContainText("Completed");
    await expectAccessible(page);
  });

  test("PLT-07-AC4: the trace link opens PLT-08", async ({ page }) => {
    await signInAs(page, "ops_manager", `/platform/runs/${RUN}`);
    await page.getByRole("link", { name: "Open trace" }).click();
    await expect(page).toHaveURL(new RegExp(`/platform/traces/${TRACE}$`));
    await expect(page.getByRole("heading", { level: 1, name: /Trace/ })).toBeVisible();
  });
});

test.describe("PLT-08 Trace", () => {
  test("PLT-08-AC1: an unknown or unauthorised trace renders as not found", async ({ page }) => {
    await signInAs(page, "auditor", "/platform/traces/0000000000000000ffffffffffffffff");
    await expect(page.getByRole("heading", { level: 1, name: "Trace not found" })).toBeVisible();
    const copy = "It doesn't exist, or you don't have access to it.";
    await expect(page.getByText(copy)).toBeVisible();
    await expectAccessible(page);

    // An authorisation refusal is indistinguishable from absence.
    await go(page, "/platform/runs");
    await expect(page.getByRole("link", { name: RUN })).toBeVisible();
    await mock(page, "PUT", "/mock/faults", { failNext: { status: 403, error: "authorization.resource_denied" }, sticky: ["failNext"] });
    await go(page, `/platform/traces/${TRACE}`);
    await expect(page.getByRole("heading", { level: 1, name: "Trace not found" })).toBeVisible();
    await expect(page.getByText(copy)).toBeVisible();
    await expect(page.getByText("authorization.resource_denied")).toHaveCount(0);
    await mock(page, "PUT", "/mock/faults", { failNext: null, sticky: [] });
  });

  test("PLT-08-AC2: span attributes are allow-listed; cookie, authorization and body never render", async ({ page }) => {
    await signInAs(page, "auditor", `/platform/traces/${TRACE}`);
    const spans = page.getByRole("list", { name: "Span waterfall" });
    await expect(spans.getByRole("listitem")).toHaveCount(3);
    for (const name of ["run.execute", "node.execute identity_ownership", "capability.invoke registry.lookup"]) {
      await spans.getByRole("button", { name }).click();
    }
    const first = page.getByLabel("Attributes of run.execute");
    await expect(first).toContainText("http.route");
    await expect(first).toContainText("/v1/runs");
    await expect(page.getByLabel("Attributes of capability.invoke registry.lookup")).toContainText("registry.lookup");
    await expect(page.getByRole("link", { name: "run_kyb_1042" }).first()).toHaveAttribute("href", `/platform/runs/${RUN}`);
    const text = await page.locator("main").innerText();
    expect(text).not.toMatch(/SYNTHETIC-SECRET|cookie|authorization|request\.body/i);
    await expect(page.getByText(/attributes not shown/).first()).toBeVisible();
    await expectAccessible(page);
  });
});
