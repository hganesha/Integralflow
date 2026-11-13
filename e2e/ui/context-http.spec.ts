import { expect, test } from "@playwright/test";
import { expectAccessible } from "./support";
// Run against the HTTP-mode app and migrated service database. Never uses MSW fixtures.
test.skip(
  !process.env.CONTEXT_HTTP_URL,
  "Requires the HTTP-mode app with context source services.",
);
test("HTTP context setup: map, reject a row, repair visually, and retain exact tested revisions", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(
    `${process.env.CONTEXT_HTTP_URL}/context/connections?product=party360`,
  );
  await expect(
    page.getByRole("heading", { name: "Data sources", exact: true }),
  ).toBeVisible();
  const id = `browser-${Date.now()}`;
  await page.getByRole("button", { name: "Explore PostgreSQL", exact: true }).click();
  await page.getByRole("dialog", { name: "PostgreSQL", exact: true }).getByRole("button", { name: /^(Configure|View setup for) PostgreSQL$/ }).click();
  await page.getByText("Create shared connection", { exact: true }).click();
  await page.getByLabel("Connection / mapping ID", { exact: true }).fill(id);
  await page
    .getByLabel("Registered connector ID", { exact: true })
    .fill(`context-postgres:${id}`);
  await page
    .getByRole("button", { name: "Save connection", exact: true })
    .click();
  await expect(
    page.getByLabel("Shared connection", { exact: true }),
  ).toHaveValue(id);
  await page
    .getByRole("button", { name: "Save source draft", exact: true })
    .click();
  await expect(
    page.getByRole("button", {
      name: "Create Entity / Party mapping",
      exact: true,
    }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "Create Entity / Party mapping", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "Canonical mapping editor" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Save mapping revision", exact: true })
    .click();
  await expect(
    page.getByRole("heading", {
      name: "Test a bounded sample",
      exact: true,
    }),
  ).toBeVisible();
  const rows = [
    {
      customer_key: "001",
      legal_name: "Example One",
      kind: "individual",
      identifiers: ["crm:001"],
      role: "customer",
      customer_type: "retail",
      profile: {},
    },
    {
      customer_key: "002",
      legal_name: "Example Two",
      kind: "X",
      identifiers: ["crm:002"],
      role: "customer",
      customer_type: "corporate",
      profile: {},
    },
  ];
  await page.getByText("Inspect or edit sample JSON", { exact: true }).click();
  await page
    .getByLabel("Source rows (JSON array, up to 100 rows)", { exact: true })
    .fill(JSON.stringify(rows));
  await page
    .getByLabel("Sample observation timestamp with timezone", { exact: true })
    .fill("2026-11-09T12:00:00Z");
  await page.getByRole("button", { name: "Run sample", exact: true }).click();
  await expect(page.getByText(/1 of 2 input rows accepted/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Enable tested binding", exact: true }),
  ).toBeDisabled();
  const entityType = page.getByLabel("Entity.entity_type · Schema required", {
    exact: true,
  });
  await entityType.selectOption("lookup");
  await page
    .getByLabel("Entity.entity_type · Schema required source field", {
      exact: true,
    })
    .selectOption("kind");
  for (const [from, to] of [
    ["individual", "individual"],
    ["X", "company"],
  ]) {
    await page.getByLabel("Source enum value", { exact: true }).fill(from!);
    await page.getByLabel("Canonical enum value", { exact: true }).fill(to!);
    await page
      .getByRole("button", { name: "Add approved value", exact: true })
      .click();
  }
  await page.getByRole("tab", { name: "Code", exact: true }).click();
  await expect(
    page.getByLabel("Canonical mapping code (JSON)", { exact: true }),
  ).toHaveValue(/"lookup"/);
  await page.getByRole("tab", { name: "Relationship graph", exact: true }).click();
  await expect(page.getByTestId("context-mapping-canvas")).toBeVisible();
  await page.getByLabel("Canonical target field", { exact: true }).selectOption("0:entity_type");
  await expect(page.getByRole("region", { name: "Selected mapping rule" })).toContainText("Entity.entity_type");
  await page.getByRole("button", { name: "Apply mapping rule", exact: true }).click();
  await page.getByRole("tab", { name: "Code", exact: true }).click();
  await expect(page.getByLabel("Canonical mapping code (JSON)", { exact: true })).toHaveValue(/"lookup"/);
  await page.getByRole("tab", { name: "Visual", exact: true }).click();
  await page
    .getByRole("button", { name: "Save mapping revision", exact: true })
    .click();
  await page.getByRole("button", { name: "Run sample", exact: true }).click();
  await expect(page.getByText(/2 of 2 input rows accepted/)).toBeVisible();
  await expect(
    page.getByText("Sample validated within the stated scope.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Enable tested binding", exact: true }),
  ).toBeDisabled();
  await expectAccessible(page);
  await page.screenshot({
    path: "/tmp/ehf-context-alignment-http.png",
    fullPage: true,
  });
  expect(errors).toEqual([]);
});
