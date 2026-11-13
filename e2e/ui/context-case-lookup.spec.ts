import { expect, test } from "@playwright/test";
import { expectAccessible, signInAs } from "./support";

test("case lookup authoring saves field paths, source filters and returned subject association", async ({
  page,
}) => {
  await signInAs(
    page,
    "platform_admin",
    "/platform/data-sources?connectionMode=enterprise&tab=connections",
  );
  await page
    .getByRole("button", { name: "Add connection", exact: true })
    .click();
  await page.getByLabel("Connection ID", { exact: true }).fill("lookup-test");
  await page
    .getByLabel("Connection name", { exact: true })
    .fill("Lookup test source");
  await page.getByLabel("Connector", { exact: true }).selectOption("sqlserver");
  await page
    .getByLabel("Endpoint", { exact: true })
    .fill("tds://sql.example.test:1433/governed");
  await page.getByLabel("Database", { exact: true }).fill("governed");
  await page.getByLabel("Schema", { exact: true }).fill("dbo");
  await page.getByLabel("Object", { exact: true }).fill("customers");
  await page
    .getByRole("button", { name: "Save connection", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Add enterprise connection" }),
  ).toHaveCount(0);
  await page
    .getByRole("tab", { name: "Product bindings", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Add product binding", exact: true })
    .click();
  await page.getByLabel("Binding ID", { exact: true }).fill("case-lookup-test");
  await page
    .getByLabel("Binding name", { exact: true })
    .fill("Case customer lookup");
  await page
    .getByRole("button", { name: "Add lookup parameter", exact: true })
    .click();
  await page
    .getByLabel("Source lookup column", { exact: true })
    .fill("customer_key");
  await page
    .getByLabel("Filter parameter", { exact: true })
    .selectOption("customer_id");
  await page
    .getByRole("button", { name: "Apply lookup filter", exact: true })
    .click();
  await expect(page.getByLabel("Read query", { exact: true })).toHaveValue(
    "SELECT * FROM customers WHERE customer_key = :customer_id",
  );
  await page
    .getByLabel("Returned canonical subject field", { exact: true })
    .fill("canonical_subject_id");
  await page
    .getByLabel("Permitted record purposes", { exact: true })
    .fill("onboarding, review");
  await expectAccessible(page);
  await page.getByRole("button", { name: "Save binding", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "Map a context source" }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Revise binding", exact: true })
    .click();
  await expect(page.getByLabel("Value from 1", { exact: true })).toHaveValue(
    "input",
  );
  await expect(
    page.getByLabel("Case / entity field path 1", { exact: true }),
  ).toHaveValue("subject.customerId");
  await expect(
    page.getByLabel("Returned canonical subject field", { exact: true }),
  ).toHaveValue("canonical_subject_id");
  await expect(
    page.getByLabel("Permitted record purposes", { exact: true }),
  ).toHaveValue("onboarding, review");
  await page.getByText("Try lookup values", { exact: true }).click();
  await page
    .getByRole("button", { name: "Preview lookup values", exact: true })
    .click();
  await expect(
    page.getByLabel("Resolved source parameters", { exact: true }),
  ).toContainText('"customer_id": "CIF-123"');
  await page
    .getByLabel("Example acquisition input", { exact: true })
    .fill('{"customer_id":"no fallback"}');
  await page
    .getByRole("button", { name: "Preview lookup values", exact: true })
    .click();
  await expect(
    page.getByText("context_source.lookup_value_missing", { exact: true }),
  ).toBeVisible();
  await page
    .getByLabel("Value from 1", { exact: true })
    .selectOption("case_id");
  await page
    .getByRole("button", { name: "Preview lookup values", exact: true })
    .click();
  await expect(
    page.getByLabel("Resolved source parameters", { exact: true }),
  ).toContainText('"customer_id": "CASE-1042"');
  await expectAccessible(page);
});
