import { expect, test, type Request } from "@playwright/test";
import { expectAccessible, mock, session, signInAs } from "./support";

// Shell acceptance criteria (BUILD-SPEC v2 §10.0).
test('sign-out failure keeps the current workspace usable and only ends the session after acknowledgement',async({page})=>{
  await signInAs(page,'agent_architect','/catalogs/skills');
  await mock(page,'PUT','/mock/faults',{csrfRejectNext:true});
  await page.getByLabel(/Account:/).click();
  await page.getByRole('button',{name:'Sign out',exact:true}).click();
  await expect(page.getByText('Sign out could not be confirmed. Try again from your account menu.')).toBeVisible();
  await expect(page.getByRole('dialog',{name:'Your session ended'})).toBeHidden();
  await expect(page.getByRole('heading',{name:'Skills',level:1,exact:true})).toBeVisible();
  await page.getByLabel(/Account:/).click();
  await page.getByRole('button',{name:'Sign out',exact:true}).click();
  await expect(page.getByRole('dialog',{name:'Your session ended'})).toBeVisible();
});

test("AC1: chrome shows environment, mode and identity from the session, never hard-coded", async ({ page }) => {
  await signInAs(page, "cdd_analyst");
  const current = await session(page);
  const chrome = page.getByRole("banner");
  await expect(chrome.getByText(`${current.environment.name} · ${current.environment.runtimeMode}`)).toBeVisible();
  await expect(chrome.getByText(current.subject.displayName, {exact:true}).first()).toBeVisible();
  await expect(chrome.getByText("Synthetic")).toBeVisible();
  await expect(chrome.getByText(/v0\.1\.0|Fixture/)).toHaveCount(0);
});

test("AC2: the switcher shows only usable experiences; a forbidden deep link names the missing permission", async ({ page }) => {
  await signInAs(page, "cdd_analyst");
  const experiences = page.getByRole("navigation", { name: "Experiences" });
  await expect(experiences.getByRole("link", { name: "Workspace" })).toBeVisible();
  await expect(experiences.getByRole("link", { name: "Process Studio" })).toHaveCount(0);
  await page.goto("/platform/admin");
  await expect(page.getByRole("heading", { name: "Administration is not available to you" })).toBeVisible();
  await expect(page.getByText("admin.read")).toBeVisible();
  await expectAccessible(page);
});

test("AC3: ⌘K finds KYB-1042 and Enter opens the case room", async ({ page }) => {
  await signInAs(page, "cdd_analyst");
  await page.keyboard.press("Control+K");
  const search = page.getByRole("combobox", { name: "Search" });
  await expect(search).toBeFocused();
  await search.fill("KYB-1042");
  // Wait for the palette's own results; My Workspace behind the sheet has options of its own.
  await expect(page.getByRole("listbox", { name: "Search results" }).getByRole("option").first()).toContainText("KYB-1042");
  await search.press("Enter");
  await expect(page).toHaveURL(/\/work\/cases\/KYB-1042$/);
  await expect(page.getByRole("heading", { level: 2, name: "Overview" })).toBeVisible();
});

test("AC4: switching persona refetches the session and re-filters navigation without a reload", async ({ page }) => {
  await signInAs(page, "cdd_analyst", "/work");
  await page.evaluate(() => ((window as unknown as { __marker: boolean }).__marker = true));
  const experiences = page.getByRole("navigation", { name: "Experiences" });
  await expect(experiences.getByRole("link", { name: "Workspace" })).toBeVisible();
  await expect(experiences.getByRole("link", { name: "Process Studio" })).toHaveCount(0);
  await mock(page, "PUT", "/mock/session", { personaId: "platform_admin" });
  await expect(page.getByRole("banner").getByText("N. Osei", {exact:true}).first()).toBeVisible();
  await expect(experiences.getByRole("link", { name: "Process Studio" })).toBeVisible();
  await expect(experiences.getByRole("link", { name: "Platform" })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __marker?: boolean }).__marker)).toBe(true);
});

test("AC5: an expired session opens the sign-in dialog and signing in returns to the same route", async ({ page }) => {
  await signInAs(page, "cdd_analyst", "/platform/runs");
  await mock(page, "PUT", "/mock/faults", { expireSessionNext: true });
  const dialog = page.getByRole("dialog", { name: "Your session ended" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Sign in again" }).click();
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(/\/platform\/runs$/);
  await expect(page.getByRole("heading", { name: "Runs", level: 1 })).toBeVisible();
});

test("AC7: every non-GET request the SPA sends carries X-CSRF-Token", async ({ page }) => {
  const mutations: Request[] = [];
  page.on("request", (request) => {
    if ((request.url().includes("/api/v1/") || request.url().includes("/auth/")) && request.method() !== "GET") mutations.push(request);
  });
  await signInAs(page, "cdd_analyst");
  await page.getByLabel(/Account:/).click();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("dialog", { name: "Your session ended" })).toBeVisible();
  const appMutations = mutations.filter((request) => !request.url().includes("/mock/"));
  expect(appMutations.some(request => request.url().endsWith('/auth/logout'))).toBe(true);
  for (const request of appMutations) expect(await request.headerValue("x-csrf-token"), request.url()).toBeTruthy();
});

test("hub lands each persona on its start page", async ({ page }) => {
  for (const [personaId, landing] of [["cdd_analyst", "/work"], ["agent_architect", "/catalogs"], ["platform_admin", "/platform/admin"], ["auditor", "/assurance"]] as const) {
    await signInAs(page, personaId, "/");
    await expect(page).toHaveURL(new RegExp(`${landing}$`));
  }
});

test("platform console shows only permitted sections and marks the current one", async ({ page }) => {
  await signInAs(page, "cdd_analyst", "/platform/runs");
  const nav = page.getByRole("navigation", { name: "Platform" });
  await expect(nav.getByRole("link", { name: "Runs" })).toHaveAttribute("aria-current", "page");
  await expect(nav.getByRole("link", { name: "Overview" })).not.toHaveAttribute("aria-current", "page");
  await expect(nav.getByRole("link", { name: "Administration" })).toHaveCount(0);
  await expectAccessible(page);
});

test("unknown routes show a 404 with search", async ({ page }) => {
  await signInAs(page, "cdd_analyst", "/nowhere/at/all");
  await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
  await page.getByRole("main").getByRole("button", { name: "Search" }).click();
  await expect(page.getByRole("combobox", { name: "Search" })).toBeFocused();
  await expectAccessible(page);
});

test("domain studios render in the workspace layout and pass axe", async ({ page }) => {
  await signInAs(page, "cdd_analyst", "/work");
  await expect(page.getByRole("heading", { name: "My Workspace" })).toBeVisible();
  await expect(page.getByRole("complementary", { name: "Workspace navigation" })).toBeVisible();
  await expectAccessible(page);
});
