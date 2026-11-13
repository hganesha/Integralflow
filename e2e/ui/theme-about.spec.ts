import { expect, test } from "@playwright/test";
import { expectAccessible, signInAs } from "./support";

test("the single theme button cycles preferences, persists them, and follows system changes", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await signInAs(page, "cdd_analyst", "/about");
  const root = page.locator("html");
  const scheme = () => root.evaluate(element => getComputedStyle(element).colorScheme);
  await expect(root).toHaveAttribute("data-theme", "system");
  expect(await scheme()).toBe("dark");
  await page.getByRole("button", { name: "Theme: System. Switch to light mode" }).click();
  expect(await scheme()).toBe("light");
  await page.reload();
  await expect(page.getByRole("button", { name: "Theme: Light. Switch to dark mode" })).toBeVisible();
  expect(await scheme()).toBe("light");
  await expectAccessible(page);
  await page.getByRole("button", { name: "Theme: Light. Switch to dark mode" }).click();
  expect(await scheme()).toBe("dark");
  await page.emulateMedia({ colorScheme: "light" });
  expect(await scheme()).toBe("dark");
  // Let the existing control background transition finish before measuring contrast.
  await expect.poll(() => page.getByRole("banner").getByRole("button", { name: /Search/ }).evaluate(element => getComputedStyle(element).backgroundColor)).toBe("rgb(23, 34, 56)");
  await expectAccessible(page);
  await page.screenshot({ path: "/tmp/integralflow-about-dark.png", fullPage: true });
  await page.getByRole("button", { name: "Theme: Dark. Switch to system mode" }).click();
  expect(await scheme()).toBe("light");
  await page.emulateMedia({ colorScheme: "dark" });
  expect(await scheme()).toBe("dark");
});

test("About opens the shipped story with agent, policy and document explanations", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await signInAs(page, "cdd_analyst");
  await page.getByRole("banner").getByRole("link", { name: "About IntegralFlow", exact: true }).click();
  await expect(page).toHaveURL(/\/about$/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("an accountable decision");
  await page.getByRole("link", { name: /The visual story/ }).click();
  await expect(page).toHaveURL(/\/visual-story.html$/);
  await expect(page.getByRole("heading", { name: "The case lifecycle" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Specialist agent execution" })).toBeVisible();
  // The execution diagram sits in the technical reference's collapsed disclosure.
  await page.locator("#architecture-reference > summary").click();
  const execution = page.locator("#agent-execution");
  await expect(execution.getByText("LLM / model provider", { exact: true })).toBeVisible();
  await execution.screenshot({ path: "/tmp/integralflow-agent-execution-light.png" });
  await page.emulateMedia({ colorScheme: "dark" });
  await expectAccessible(page);
  await execution.screenshot({ path: "/tmp/integralflow-agent-execution-dark.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await execution.locator("h3").scrollIntoViewIfNeeded();
  await page.screenshot({ path: "/tmp/integralflow-agent-execution-mobile.png" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await execution.getByRole("link", { name: "Explore skills catalog" }).click();
  await expect(page.locator("#catalog-kind")).toHaveText("Skills");
  // Focus moves to the chosen catalog's entry list (the refreshed story scrolls there).
  await expect(page.locator("#catalog-entry-heading")).toBeFocused();
  await execution.getByRole("link", { name: "Explore context catalog" }).click();
  await expect(page.locator("#catalog-kind")).toHaveText("Context");
  await execution.getByRole("link", { name: "Explore agents catalog" }).click();
  await expect(page.locator("#catalog-kind")).toHaveText("Agents");
  await page.locator('[data-catalog="policies"]').click();
  await expect(page.locator("#catalog-entry-heading")).toContainText(/Policies \/ [1-9]/);
  await expect(page.locator("#catalog-entry-list details").first()).toBeVisible();
  await page.locator('[data-catalog="documents"]').click();
  await expect(page.locator("#catalog-entry-heading")).toContainText(/Documents \/ [1-9]/);
  await page.locator("#catalog-entry-search").fill("certificate");
  await expect(page.locator("#catalog-entry-list")).toContainText(/certificate/i);
  await page.locator('[data-inventory="kyc"]').click();
  await expect(page.locator("#workflow-stats")).toContainText("51 graph nodes");
  await page.locator('[data-inventory="kyb"]').click();
  await expect(page.locator("#workflow-stats")).toContainText("63 graph nodes");
  for (let step = 0; step < 7; step++) await page.getByRole("button", { name: "Next story step" }).click();
  // The walk reaches the policy step: the released policy decides, asks for evidence or asks a person.
  await expect(page.locator("#stage-description")).toContainText("The released installation policy evaluates");
  // The story has no in-article return links (1be3b9f3): the browser takes the reader back to About.
  await page.goBack();
  await expect(page).toHaveURL(/\/about$/);
  await expect(page.getByRole("link", { name: "IntegralFlow home" })).toBeVisible();
  await page.getByRole("article").getByRole("link", { name: "Back to app" }).click();
  await expect(page).not.toHaveURL(/\/about$/);
  expect(errors).toEqual([]);
});

test("the navigation shows readiness as an accessible light without a visible label", async ({ page }) => {
  await signInAs(page, "platform_admin", "/about");
  const banner = page.getByRole("banner");
  await expect(banner.getByRole("img", { name: /^System readiness:/ })).toBeVisible();
  await expect(banner.getByText("Ready", { exact: true })).toHaveCount(0);
});
