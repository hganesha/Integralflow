import { expect, test } from "@playwright/test";
import { expectAccessible } from "./support";
const base = process.env.WORKBENCH_HTTP_URL;
test.skip(!base, "Requires isolated HTTP services.");
const shots = "../../docs/audits/2026-11-09-ui/navigation/screenshots";
test("new mapping offers all connector families and opens the full warehouse forms", async ({
  page,
}) => {
  for (const [provider, label, endpoint] of [
    ["databricks", "Databricks SQL", "https://workspace.example.com"],
    ["fabric", "Microsoft Fabric", "tds://fabric.example.com:1433/customers"],
  ] as const) {
    await page.goto(base + "/context/connections?product=party360");
    const vendor =
      provider === "databricks" ? "Databricks" : "Microsoft Fabric";
    await page
      .getByRole("button", { name: `Explore ${vendor}`, exact: true })
      .click();
    await page
      .getByRole("dialog", { name: vendor, exact: true })
      .getByRole("button", {
        name: new RegExp(`^(Configure|View setup for) ${vendor}$`),
      })
      .click();
    const sheet = page.getByRole("dialog", {
      name: "Add enterprise connection",
      exact: true,
    });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByLabel("Connector", { exact: true })).toHaveValue(
      provider,
    );
    await expect(page).toHaveURL(new RegExp("productId=party360"));
    const id = "navigation-" + provider + "-" + Date.now();
    const name = label + " navigation check " + id;
    await sheet.getByLabel("Connection ID", { exact: true }).fill(id);
    await sheet.getByLabel("Connection name", { exact: true }).fill(name);
    await sheet.getByLabel("Endpoint", { exact: true }).fill(endpoint);
    await sheet.getByLabel("Database", { exact: true }).fill("customers");
    await sheet.getByLabel("Object", { exact: true }).fill("customer_view");
    await sheet.getByLabel("Warehouse", { exact: true }).fill("test-warehouse");
    const savedResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/v1/context-sources/connections") &&
        response.request().method() === "POST",
    );
    await sheet
      .getByRole("button", { name: "Save connection", exact: true })
      .click();
    const saved = await savedResponse;
    expect(saved.status(), await saved.text()).toBe(201);
    await expect(sheet).toBeHidden();
    await expect(page).not.toHaveURL(/provider=/);
    await expect(
      page
        .getByRole("table", { name: "Enterprise connections", exact: true })
        .getByRole("row")
        .filter({ hasText: name }),
    ).toContainText(label);
    await page.reload();
    await expect(
      page
        .getByRole("table", { name: "Enterprise connections", exact: true })
        .getByRole("row")
        .filter({ hasText: name }),
    ).toBeVisible();
    await page
      .getByRole("tab", { name: "Product bindings", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Add product binding", exact: true })
      .click();
    const binding = page.getByRole("dialog", {
      name: "Map a context source",
      exact: true,
    });
    await expect(binding).toBeVisible();
    await expect(
      binding
        .getByLabel("Connection revision", { exact: true })
        .locator("option")
        .filter({ hasText: name }),
    ).toHaveCount(1);
    await binding.getByRole("button", { name: "Cancel", exact: true }).click();
    await expectAccessible(page);
  }
  await page.screenshot({
    path: shots + "/mapping-connectors-desktop.png",
    fullPage: true,
  });
});
test("Process Studio owns drafts, releases and separate agent and skill workspaces", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(base + "/studio");
  await expect(page).toHaveURL(/\/studio\/drafts$/);
  const top = page.getByRole("navigation", { name: "Experiences" });
  await expect(
    top.getByRole("link", { name: "Process Studio", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await expect(
    top.getByRole("link", { name: "Agent Studio", exact: true }),
  ).toHaveCount(0);
  const studio = page.getByRole("navigation", {
    name: "Process Studio",
    exact: true,
  });
  await expect(
    studio.getByRole("link", { name: "Draft processes", exact: true }),
  ).toBeVisible();
  await studio
    .getByRole("link", { name: "Published processes", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Published processes", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Register manifest", exact: true }),
  ).toBeVisible();
  await studio.getByRole("link", { name: "Agents", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Agent Studio", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", {
      name: "Create an agent workspace",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page
      .getByLabel("Source", { exact: true })
      .locator("option")
      .filter({ hasText: "Normalize screening name" }),
  ).toHaveCount(0);
  await studio.getByRole("link", { name: "Skills", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Skill Studio", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", {
      name: "Create a skill workspace",
      exact: true,
    }),
  ).toBeVisible();
  await expectAccessible(page);
  await page.screenshot({
    path: shots + "/skills-desktop.png",
    fullPage: true,
  });
  await studio
    .getByRole("link", { name: "Draft processes", exact: true })
    .click();
  await page.getByRole("button", { name: "New process", exact: true }).click();
  await expect(page).toHaveURL(/\/studio\/drafts\/[^/?]+$/);
  await expect(
    page.getByRole("heading", { name: "New process", level: 1, exact: true }),
  ).toBeVisible();
  const url = page.url();
  await expect(
    page.getByRole("tablist", { name: "Authoring sections" }),
  ).toBeVisible();
  await page.reload();
  await expect(page).toHaveURL(url);
  await expect(
    page.getByRole("tablist", { name: "Authoring sections" }),
  ).toBeVisible();
  await expectAccessible(page);
  await page.screenshot({ path: shots + "/draft-desktop.png", fullPage: true });
  expect(errors).toEqual([]);
});
test("one data source workspace preserves source configuration, product bindings and operational views", async ({
  page,
}) => {
  await page.goto(base + "/platform/data-sources");
  const platform = page.getByRole("navigation", {
    name: "Platform",
    exact: true,
  });
  await expect(
    platform.getByRole("link", { name: "Data sources", exact: true }),
  ).toHaveCount(1);
  for (const name of [
    "Context sources",
    "Data connectors",
    "Skills & agents",
    "Drafts",
    "Releases",
  ])
    await expect(platform.getByRole("link", { name, exact: true })).toHaveCount(
      0,
    );
  const sections = page.getByRole("tablist", { name: "Data source sections" });
  await expect(sections.getByRole("tab")).toHaveText([
    "Connections",
    "Mappings",
    "Product bindings",
    "Status",
    "Calls",
    "Refresh",
  ]);
  await page
    .getByRole("button", { name: "Explore PostgreSQL", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "PostgreSQL", exact: true })
    .getByRole("button", { name: /^(Configure|View setup for) PostgreSQL$/ })
    .click();
  await page.getByText("Create shared connection", { exact: true }).click();
  await page
    .getByLabel("Connection / mapping ID", { exact: true })
    .fill("retained-local-edit");
  await sections.getByRole("tab", { name: "Mappings", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Choose a mapping", exact: true }),
  ).toBeVisible();
  await sections.getByRole("tab", { name: "Connections", exact: true }).click();
  await expect(
    page.getByLabel("Connection / mapping ID", { exact: true }),
  ).toHaveValue("retained-local-edit");
  await page
    .getByRole("tab", { name: "Product source connections", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Add connection", exact: true }),
  ).toBeVisible();
  await sections
    .getByRole("tab", { name: "Product bindings", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Add product binding", exact: true }),
  ).toBeVisible();
  await sections.getByRole("tab", { name: "Status", exact: true }).click();
  await expect(
    page.getByRole("table", { name: "Shared data connections", exact: true }),
  ).toBeVisible();
  await sections.getByRole("tab", { name: "Calls", exact: true }).click();
  await expect(
    page.getByRole("table", { name: "Source call receipts", exact: true }),
  ).toBeVisible();
  await sections.getByRole("tab", { name: "Refresh", exact: true }).click();
  await expect(
    page.getByText("Product binding refresh operations.", { exact: true }),
  ).toBeVisible();
  await expectAccessible(page);
  await page.screenshot({
    path: shots + "/data-sources-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: shots + "/data-sources-mobile.png",
    fullPage: true,
  });
});
test("old draft, release, agent and source links preserve their targets and filters", async ({
  page,
}) => {
  for (const [from, to] of [
    ["/platform/drafts", "/studio/drafts"],
    ["/platform/releases", "/studio/published"],
    ["/agents", "/studio/agents/mandates"],
    [
      "/platform/workbench?source=screening.name.normalize",
      "/studio/skills?source=screening.name.normalize",
    ],
    [
      "/platform/context-sources?productId=identity.intelligence",
      "/platform/data-sources?productId=identity.intelligence&tab=bindings",
    ],
    [
      "/platform/data-connectors?tab=calls&run=example-run",
      "/platform/data-sources?tab=calls&run=example-run",
    ],
    [
      "/context/mappings/example-map?product=party360",
      "/platform/data-sources?product=party360&tab=mappings&mapping=example-map",
    ],
  ] as const) {
    await page.goto(base + from);
    await expect(page).toHaveURL(base + to);
  }
});
