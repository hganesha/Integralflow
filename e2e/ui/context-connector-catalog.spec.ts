import { expect, test } from "@playwright/test";
import { expectAccessible, signInAs } from "./support";

test("connector catalog is searchable, keyboard accessible, and exposes SQL Server setup", async ({
  page,
}) => {
  await signInAs(
    page,
    "context_architect",
    "/platform/data-sources?object=Entity&field=name&product=identity.intelligence&draft=test-draft",
  );
  for (const vendor of [
    "Databricks",
    "Microsoft Fabric",
    "Snowflake",
    "SQL Server",
    "REST API",
  ])
    await expect(
      page.getByRole("heading", { name: vendor, exact: true }),
    ).toBeVisible();
  await page
    .getByRole("button", { name: "Explore SQL Server", exact: true })
    .click();
  const details = page.getByRole("dialog", { name: "SQL Server", exact: true });
  await expect(details).toContainText("Schema discovery");
  await expect(
    details.getByRole("button", { name: /Configure|View setup/ }),
  ).toHaveCount(1);
  await expectAccessible(page);
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "Explore SQL Server", exact: true }),
  ).toBeFocused();
  await page.getByLabel("Find a connector", { exact: true }).fill("REST");
  await page.getByLabel("Catalog layout", { exact: true }).selectOption("list");
  await expect(
    page.getByRole("heading", { name: "REST API", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Snowflake", exact: true }),
  ).toHaveCount(0);
  await page
    .getByLabel("Find a connector", { exact: true })
    .fill("no-such-connector");
  await page
    .getByRole("button", { name: "Clear filters", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Snowflake", exact: true }),
  ).toBeVisible();
  await expectAccessible(page);
});

test("warehouse and REST cards open the correct existing forms without losing object or consumer scope", async ({
  page,
}) => {
  await signInAs(
    page,
    "platform_admin",
    "/platform/data-sources?object=Entity&field=name&product=identity.intelligence&agent=test-agent&draft=test-draft",
  );
  for (const [name, provider] of [
    ["Databricks", "databricks"],
    ["Microsoft Fabric", "fabric"],
    ["Snowflake", "snowflake"],
    ["REST API", "openapi"],
    ["SQL Server", "sqlserver"],
  ] as const) {
    await page
      .getByRole("button", { name: `Explore ${name}`, exact: true })
      .click();
    await page
      .getByRole("dialog", { name, exact: true })
      .getByRole("button", { name: `Configure ${name}`, exact: true })
      .click();
    const form = page.getByRole("dialog", {
      name: "Add enterprise connection",
      exact: true,
    });
    await expect(form.getByLabel("Connector", { exact: true })).toHaveValue(
      provider,
    );
    if (provider === "sqlserver") {
      await expect(
        form.getByLabel("SQL Server authentication", { exact: true }),
      ).toHaveValue("sql_password");
      await expect(form.getByLabel("Schema", { exact: true })).toHaveValue(
        "dbo",
      );
      await form
        .getByLabel("SQL Server authentication", { exact: true })
        .selectOption("entra_token");
      await expect(
        form.getByLabel("SQL Server authentication", { exact: true }),
      ).toHaveValue("entra_token");
    }
    const url = new URL(page.url());
    for (const [key, value] of Object.entries({
      object: "Entity",
      field: "name",
      product: "identity.intelligence",
      productId: "identity.intelligence",
      agent: "test-agent",
      draft: "test-draft",
    }))
      expect(url.searchParams.get(key)).toBe(value);
    await expectAccessible(page);
    await form.getByRole("button", { name: "Cancel", exact: true }).click();
    await page
      .getByRole("button", { name: "Browse connector catalog", exact: true })
      .click();
  }
});

test("field source coverage distinguishes saved configuration from multi-source resolution", async ({
  page,
}) => {
  await signInAs(
    page,
    "context_architect",
    "/platform/data-sources?tab=mappings&object=Entity&field=attributes.email&product=identity.intelligence",
  );
  await expect(
    page.getByRole("heading", {
      name: "Fields and their sources",
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByLabel("Context object", { exact: true })).toHaveValue(
    "Entity",
  );
  await expect(
    page.getByRole("table", {
      name: "Entity field mappings · saved configuration",
      exact: true,
    }),
  ).toContainText("No mapping");
  await expect(
    page.getByText("Multiple mappings do not yet combine field values.", {
      exact: false,
    }),
  ).toBeVisible();
  await page
    .getByRole("link", { name: "Attach a source to Entity", exact: true })
    .click();
  await expect(
    page.getByRole("region", {
      name: "Choose a source connector",
      exact: true,
    }),
  ).toContainText("Entity.attributes.email");
  await expectAccessible(page);
});
