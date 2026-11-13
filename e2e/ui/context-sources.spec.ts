import { expect, test } from "@playwright/test";
import { expectAccessible, signInAs } from "./support.js";
test("configure, map, qualify and activate a synthetic enterprise source", async ({
  page,
}) => {
  // The former Context sources page now lives in Platform › Data sources: product bindings on
  // the "Product bindings" tab, enterprise connections under Connections › Product source
  // connections. The old route redirects to the bindings tab.
  await signInAs(page, "platform_admin", "/platform/context-sources");
  await expect(page).toHaveURL(/\/platform\/data-sources\?tab=bindings/);
  await expect(
    page.getByRole("heading", { name: "Data sources", exact: true }),
  ).toBeVisible();
  const sections = page.getByRole("tablist", { name: "Data source sections" });
  await page
    .getByRole("link", { name: "Manage product source connections" })
    .click();
  await expect(
    page.getByRole("tab", { name: "Product source connections" }),
  ).toHaveAttribute("aria-selected", "true");
  await page
    .getByRole("button", { name: "Add connection", exact: true })
    .click();
  let sheet = page.getByRole("dialog");
  await sheet.getByLabel("Connection ID", { exact: true }).fill("customer-db");
  await sheet
    .getByLabel("Connection name", { exact: true })
    .fill("Customer database");
  await sheet
    .getByLabel("Endpoint", { exact: true })
    .fill("postgresql://source.example.test:5432/governed");
  await sheet.getByLabel("Database", { exact: true }).fill("governed");
  await sheet.getByLabel("Object", { exact: true }).fill("customers");
  await sheet
    .getByRole("button", { name: "Save connection", exact: true })
    .click();
  await expect(sheet).toBeHidden();
  await expect(
    page.getByRole("table", { name: "Enterprise connections" }),
  ).toContainText("Customer database");
  await sections.getByRole("tab", { name: "Product bindings", exact: true }).click();
  await page
    .getByRole("button", { name: "Add product binding", exact: true })
    .click();
  sheet = page.getByRole("dialog", { name: "Map a context source" });
  await sheet
    .getByLabel("Binding ID", { exact: true })
    .fill("customer-records");
  await sheet
    .getByLabel("Binding name", { exact: true })
    .fill("Customer records");
  await sheet.getByLabel("Dataset ID", { exact: true }).fill("customer-master");
  await expect(
    sheet.getByRole("table", { name: "Canonical field mapping" }),
  ).toBeVisible();
  await sheet
    .getByLabel("Transformation 1", { exact: true })
    .selectOption("trim");
  await sheet.getByRole("button", { name: "Edit mapping code" }).click();
  const mappingCode = sheet.getByLabel("Mapping definition JSON", {
    exact: true,
  });
  const mapping = await mappingCode.inputValue();
  expect(JSON.parse(mapping)[0].transform).toBe("trim");
  await mappingCode.fill("[");
  await expect(
    sheet.getByRole("button", { name: "Save binding", exact: true }),
  ).toBeDisabled();
  await mappingCode.fill(mapping);
  await sheet.getByRole("button", { name: "Use visual mapping" }).click();
  await expect(
    sheet.getByLabel("Transformation 1", { exact: true }),
  ).toHaveValue("trim");
  await expectAccessible(page);
  await page.screenshot({ path: test.info().outputPath("canonical-mapping.png"), fullPage: true });
  await sheet
    .getByRole("button", { name: "Save binding", exact: true })
    .click();
  await expect(sheet).toBeHidden();
  await page
    .getByRole("button", { name: "Customer records customer-records" })
    .click();
  sheet = page.getByRole("dialog");
  await sheet
    .getByLabel("Reason", { exact: true })
    .fill("Source reviewed and tested");
  await expect(
    sheet.getByRole("button", { name: "Activate qualified revision" }),
  ).toBeDisabled();
  await sheet.getByRole("button", { name: "Discover schema" }).click();
  await expect(
    sheet.getByRole("table", { name: "Discovered source fields" }),
  ).toBeVisible();
  await sheet.getByRole("button", { name: "Qualify binding" }).click();
  await expect(
    sheet.getByRole("button", { name: "Activate qualified revision" }),
  ).toBeEnabled();
  await sheet
    .getByRole("button", { name: "Activate qualified revision" })
    .click();
  await expect(sheet.getByText("Activation state recorded.")).toBeVisible();
  await expectAccessible(page);
  await sheet.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByText("Active r1", { exact: true })).toBeVisible();
  await expectAccessible(page);
});
test("readers can inspect sources while configuration controls remain disabled", async ({
  page,
}) => {
  await signInAs(page, "harness_approver", "/platform/context-sources");
  await expect(page).toHaveURL(/\/platform\/data-sources\?tab=bindings/);
  await expect(
    page.getByRole("button", { name: "Add product binding", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByText("You have read access. Changes require Platform.Admin."),
  ).toBeVisible();
  await page
    .getByRole("link", { name: "Manage product source connections" })
    .click();
  await expect(
    page.getByRole("button", { name: "Add connection", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Import setup connection", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByText("You have read access. Changes require Platform.Admin."),
  ).toBeVisible();
  await expectAccessible(page);
});
