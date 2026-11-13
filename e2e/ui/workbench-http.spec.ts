import { expect, test } from "@playwright/test";
import { expectAccessible } from "./support";
const base = process.env.WORKBENCH_HTTP_URL;
test.skip(!base, "Requires isolated real HTTP workbench stack.");
const shots = "../../docs/audits/2026-11-09-ui/platform-workbench/screenshots";
test("source editing, recovery, dataset evaluation and independent publication over real HTTP", async ({
  page,
  browser,
}) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(base + "/platform/workbench");
  await expect(
    page.getByRole("heading", { name: "Skill Studio", exact: true }),
  ).toBeVisible();
  await page
    .getByLabel("Name", { exact: true })
    .fill("Browser normalization " + Date.now());
  await page
    .getByRole("button", { name: "Create workspace", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Save new revision", exact: true }),
  ).toBeVisible();
  const url = page.url();
  await page.getByRole("button", { name: "main.py", exact: true }).click();
  await page
    .getByLabel("main.py", { exact: true })
    .fill(
      'def run(data):\n    return {"normalized": data["name"].strip().lower()}\n',
    );
  await page
    .getByLabel("File or folder path", { exact: true })
    .fill("notes/review.md");
  await page.getByRole("button", { name: "New file", exact: true }).click();
  await page
    .getByLabel("notes/review.md", { exact: true })
    .fill(
      "# Reviewed source\n\nLocal recovery preserves this note.\n\n[Read skill](../SKILL.md)",
    );
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Reviewed source", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Read skill", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: /Browser normalization/ }),
  ).toHaveCount(2);
  await page.getByLabel("Find a file", { exact: true }).fill("review.md");
  await page.getByRole("button", { name: "review.md", exact: true }).click();
  await page.getByLabel("File or folder path", { exact: true }).fill("docs");
  await page
    .getByRole("button", { name: "Rename folder", exact: true })
    .click();
  await expect(
    page.getByText("docs/review.md", { exact: true }).first(),
  ).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await page.reload();
  await expect(
    page.getByText(/Unsaved changes · based on revision 1/),
  ).toBeVisible();
  await page.getByRole("button", { name: "main.py", exact: true }).click();
  await expect(page.getByLabel("main.py", { exact: true })).toHaveValue(
    /strip\(\).lower\(\)/,
  );
  await page
    .getByLabel("Revision message", { exact: true })
    .fill("Normalize names and document review");
  await page
    .getByRole("button", { name: "Save new revision", exact: true })
    .click();
  await expect(page.getByText(/source revision 2/)).toBeVisible();
  await page
    .getByRole("tab", { name: "Dataset evaluations", exact: true })
    .click();
  const dataset = JSON.stringify({
    name: "Browser names",
    version: "1",
    cases: [
      {
        id: "trim",
        input: { name: " Alice " },
        expected: { normalized: "alice" },
      },
    ],
  });
  await page.getByLabel("Dataset (JSON)", { exact: true }).fill(dataset);
  await page.getByRole("tab", { name: "Source files", exact: true }).click();
  await page
    .getByRole("tab", { name: "Dataset evaluations", exact: true })
    .click();
  await expect(page.getByLabel("Dataset (JSON)", { exact: true })).toHaveValue(
    dataset,
  );
  await page
    .getByRole("button", { name: "Run dataset evaluation", exact: true })
    .click();
  await expect(
    page.locator("summary").filter({ hasText: /Revision 2.*passed/ }),
  ).toBeVisible({ timeout: 30_000 });
  await page
    .locator("summary")
    .filter({ hasText: /Revision 2.*passed/ })
    .click();
  await expect(page.getByText(/Source code/)).toBeVisible();
  await expectAccessible(page);
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({
    path: shots + "/evaluation-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({
    path: shots + "/evaluation-mobile.png",
    fullPage: true,
  });
  const context = await browser.newContext({
    extraHTTPHeaders: {
      "x-workbench-user": "workbench-reviewer",
      "x-workbench-roles": "Harness.Approver",
    },
  });
  const reviewer = await context.newPage();
  await reviewer.goto(url);
  await reviewer
    .getByRole("tab", { name: "Revisions & publication", exact: true })
    .click();
  await reviewer
    .getByLabel("Review reason", { exact: true })
    .fill("Reviewed exact browser dataset and source revision");
  await reviewer
    .getByRole("button", { name: "Approve revision", exact: true })
    .click();
  await expect(
    reviewer.getByRole("button", {
      name: "Publish source bundle",
      exact: true,
    }),
  ).toBeEnabled();
  await reviewer
    .getByRole("button", { name: "Publish source bundle", exact: true })
    .click();
  await expect(
    reviewer.getByText("Published", { exact: true }).first(),
  ).toBeVisible();
  await context.close();
  expect(errors).toEqual([]);
});
test("canonical repository read access and real platform dependencies", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.setExtraHTTPHeaders({
    "x-workbench-user": "workbench-reader",
    "x-workbench-roles": "Harness.Reader",
  });
  await page.goto(base + "/platform/workbench?source=screening.name.normalize&tab=source");
  await expect(
    page.getByRole("region", { name: "Source repository" }),
  ).toBeVisible();
  await page.getByLabel("Find a file", { exact: true }).fill("screening.py");
  await page.getByRole("button", { name: "screening.py", exact: true }).click();
  await expect(
    page.getByLabel("src/financial_crime/skills/screening.py", { exact: true }),
  ).toHaveValue(/def name_normalize/);
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({
    path: shots + "/repository-desktop.png",
    fullPage: true,
  });
  await page.goto(base + "/platform/system?tab=services");
  await expect(
    page.getByText("Telemetry receiver", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Runtime dispatcher", { exact: true }),
  ).toBeVisible();
  await expectAccessible(page);
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({
    path: shots + "/services-desktop.png",
    fullPage: true,
  });
});

test("operator stops and resumes admission with persisted reason and audit revision", async ({
  page,
}) => {
  await page.goto(base + "/platform/system?tab=runtime");
  await expect(
    page.getByText(
      /^(Stopped · new runs are refused|Running · new runs are admitted)$/,
    ),
  ).toBeVisible();
  if (
    await page
      .getByRole("button", { name: "Resume admission", exact: true })
      .isVisible()
  ) {
    await page
      .getByLabel("Reason for resuming", { exact: true })
      .fill("Reset isolated acceptance state");
    await page
      .getByRole("button", { name: "Resume admission", exact: true })
      .click();
  }
  await page
    .getByRole("button", { name: "Stop admission…", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Stop runtime admission",
    exact: true,
  });
  await dialog
    .getByLabel("Reason", { exact: true })
    .fill("Browser runtime admission acceptance");
  await dialog.getByRole("checkbox").check();
  await dialog
    .getByRole("button", { name: "Stop admission", exact: true })
    .click();
  await expect(dialog.getByRole("status")).toHaveText(
    "Admission stopped. Active runs are draining.",
  );
  await dialog
    .getByRole("button", { name: "Close", exact: true })
    .last()
    .click();
  await expect(
    page.getByText("Stopped · new runs are refused", { exact: true }),
  ).toBeVisible();
  await page
    .getByLabel("Reason for resuming", { exact: true })
    .fill("Browser admission test completed");
  await page
    .getByRole("button", { name: "Resume admission", exact: true })
    .click();
  await expect(
    page.getByText("Running · new runs are admitted", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByText("Running · new runs are admitted", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Browser admission test completed", { exact: true }),
  ).toBeVisible();
  await expectAccessible(page);
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({
    path: shots + "/runtime-desktop.png",
    fullPage: true,
  });
});

test("concurrent source revisions preserve local edits and untouched server files", async ({
  page,
  browser,
}) => {
  await page.goto(base + "/platform/workbench");
  await page
    .getByLabel("Name", { exact: true })
    .fill("Concurrent source " + Date.now());
  await page
    .getByRole("button", { name: "Create workspace", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Save new revision", exact: true }),
  ).toBeVisible();
  const id = new URL(page.url()).searchParams.get("workspace")!;
  await page.getByRole("button", { name: "main.py", exact: true }).click();
  await page
    .getByLabel("main.py", { exact: true })
    .fill('def run(data):\n    return {"edited": True}\n');
  const other = await browser.newContext({
    extraHTTPHeaders: {
      "x-workbench-user": "concurrent-author",
      "x-workbench-roles": "Harness.Author",
    },
  });
  const session = await (
    await other.request.get(base + "/api/v1/session")
  ).json();
  const view = await (
    await other.request.get(base + "/api/v1/workbench/workspaces/" + id)
  ).json();
  const saved = await other.request.put(
    base + "/api/v1/workbench/workspaces/" + id,
    {
      headers: { origin: base!, "x-csrf-token": session.csrfToken },
      data: {
        expectedRevision: 1,
        message: "Concurrent documentation",
        files: {
          ...view.source.files,
          "server-only.md": "Keep the other author’s file",
        },
      },
    },
  );
  expect(saved.status()).toBe(200);
  await page.getByRole("button", { name: "Refresh now", exact: true }).click();
  await expect(
    page.getByRole("button", {
      name: "Apply my changed files to revision 2",
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByLabel("main.py", { exact: true })).toHaveValue(
    /edited/,
  );
  await page
    .getByRole("button", {
      name: "Apply my changed files to revision 2",
      exact: true,
    })
    .click();
  await page
    .getByLabel("Revision message", { exact: true })
    .fill("Rebase my changed source");
  await page
    .getByRole("button", { name: "Save new revision", exact: true })
    .click();
  await expect(page.getByText(/source revision 3/)).toBeVisible();
  const final = await (
    await other.request.get(base + "/api/v1/workbench/workspaces/" + id)
  ).json();
  expect(final.source.files["server-only.md"]).toBe(
    "Keep the other author’s file",
  );
  expect(final.source.files["main.py"]).toContain("edited");
  await other.close();
});
