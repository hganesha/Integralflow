import { expect, type Page } from "@playwright/test";
import { mock, signInAs } from "./support";

export const CASE = "KYB-1042";

/** Navigate inside the SPA so the in-page mock (and any forced response) keeps its state. */
export async function go(page: Page, path: string): Promise<void> {
  await page.evaluate((to) => {
    window.history.pushState({}, "", to);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, path);
}

/** Sign in, then jump the mock to a scenario state and open `path` without a reload. */
export async function openInScenario(page: Page, personaId: string, scenario: string, path: string): Promise<void> {
  await signInAs(page, personaId, "/assurance");
  await expect(page.getByRole("heading", { name: "Mission Control", level: 1 })).toBeVisible();
  await mock(page, "PUT", "/mock/scenario", { scenario });
  await go(page, path);
}
