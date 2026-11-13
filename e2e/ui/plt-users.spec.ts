import { expect, test } from "@playwright/test";
import { expectAccessible, signInAs } from "./support";

test("Platform users: add a colleague, filter, update roles and inspect permissions", async ({ page }) => {
  await signInAs(page, "platform_admin", "/platform/users");
  await expect(page.getByRole("heading", { name: "Users & roles", level: 1 })).toBeVisible();
  await page.getByRole("button", { name: "Add user", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Add user", exact: true });
  await expect(sheet.getByLabel("Identity subject ID")).toHaveCount(0);
  await sheet.getByLabel("Search Microsoft Entra ID").fill("Jamie");
  await sheet.getByRole("button", { name: "Select Jamie Chen", exact: true }).click();
  await expect(sheet.getByLabel("Full name")).toHaveValue("Jamie Chen");
  await expect(sheet.getByLabel("Email address")).toHaveValue("jamie.chen@example.com");
  await expect(sheet.getByLabel("Full name")).toHaveAttribute("readonly", "");
  await sheet.getByRole("checkbox", { name: /Case analyst/ }).check();
  await sheet.getByRole("checkbox", { name: /Process flow reader/ }).check();
  await sheet.getByLabel("Reason for change").fill("New analyst joining the operations team");
  await expectAccessible(page);
  await sheet.getByRole("button", { name: "Add user", exact: true }).click();
  await expect(sheet).not.toBeVisible();
  await page.getByLabel("Search users", { exact: true }).fill("jamie.chen@example.com");
  await expect(page.getByRole("row", { name: /Jamie Chen/ })).toContainText("Case analyst");
  await page.getByLabel("Search users", { exact: true }).fill("Jamie Chen");
  await page.getByRole("button", { name: "Manage Jamie Chen" }).click();
  const edit = page.getByRole("dialog", { name: "Manage user" });
  await expect(edit.getByLabel("Identity subject ID")).toHaveCount(0);
  await edit.getByRole("checkbox", { name: /Case analyst/ }).uncheck();
  await edit.getByRole("checkbox", { name: /Case reviewer/ }).check();
  await edit.getByLabel("Reason for change").fill("Move to the review team");
  await edit.getByRole("button", { name: "Save changes" }).click();
  await expect(edit).not.toBeVisible();
  await expect(page.getByRole("row", { name: /Jamie Chen/ })).toContainText("Case reviewer");
  await page.getByRole("combobox", { name: "Role", exact: true }).selectOption("Case.Analyst");
  await expect(page.getByText("No users match your filters")).toBeVisible();
  await page.getByRole("tab", { name: /Roles & permissions/ }).click();
  await page.getByRole("region", { name: "Case reviewer", exact: true }).getByText(/permissions/).click();
  await expect(page.getByText("case.review", { exact: true })).toBeVisible();
  await expectAccessible(page);
});

test("Platform users: read-only auditor access and non-admin route gating", async ({ page }) => {
  await signInAs(page, "auditor", "/platform/users");
  await expect(page.getByRole("heading", { name: "Users & roles", level: 1 })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add user", exact: true })).toBeDisabled();
  await expect(page.getByText(/You have read-only access/)).toBeVisible();
  await signInAs(page, "cdd_analyst", "/platform/users");
  await expect(page.getByRole("heading", { name: "Users & roles is not available to you" })).toBeVisible();
});

test("Platform users: search handles existing users, disabled accounts and no matches", async ({ page }) => {
  await signInAs(page, "platform_admin", "/platform/users");
  await page.getByRole("button", { name: "Add user", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Add user", exact: true });
  const search = sheet.getByLabel("Search Microsoft Entra ID");
  await search.fill("Okafor");
  await expect(sheet.getByRole("button", { name: /Select R. Okafor · Already added/ })).toBeDisabled();
  await search.fill("Robin");
  await expect(sheet.getByRole("button", { name: /Select Robin Stone · Account disabled/ })).toBeDisabled();
  await search.fill("Nobodymatches");
  await expect(sheet.getByText("No people found. Try another name or email.")).toBeVisible();
  await expect(sheet.getByRole("button", { name: "Add user", exact: true })).toBeDisabled();
  await expectAccessible(page);
});

test("Platform users: unconfigured identity provider explains how to connect and prevents manual identity entry", async ({ page }) => {
  await page.addInitScript(() => {
    const original = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (new URL(request.url).pathname === "/api/v1/admin/identity-provider") return Response.json({ provider: null, label: "Identity provider", configured: false, reason: "identity_directory.not_configured" });
      return original(request);
    };
  });
  await signInAs(page, "platform_admin", "/platform/users");
  await page.getByRole("button", { name: "Add user", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Add user", exact: true });
  await expect(sheet.getByText("Connect your identity provider", { exact: true })).toBeVisible();
  await expect(sheet.getByRole("link", { name: "Open identity setup" })).toHaveAttribute("href", "/onboarding");
  await expect(sheet.getByRole("button", { name: "Add user", exact: true })).toBeDisabled();
  await expect(sheet.getByLabel("Identity subject ID")).toHaveCount(0);
  await expectAccessible(page);
});
