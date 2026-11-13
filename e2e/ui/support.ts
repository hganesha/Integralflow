import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";

/** Drive the mock through its contract-declared /mock operations (x-mock-only). */
export async function mock(page: Page, method: "PUT" | "POST", path: string, body: unknown = {}): Promise<unknown> {
  return page.evaluate(async ({ method, path, body }) => {
    const response = await fetch(`/api${path}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!response.ok) throw new Error(`${method} ${path} → ${response.status}`);
    return response.json();
  }, { method, path, body });
}

export async function session(page: Page): Promise<{ subject: { displayName: string }; roles: string[]; actions: string[]; environment: { name: string; runtimeMode: string; synthetic: boolean } }> {
  return page.evaluate(async () => (await fetch("/api/v1/session")).json());
}

/** Open the app, wait for the shell, and select a persona. */
export async function signInAs(page: Page, personaId: string, path = "/"): Promise<void> {
  await page.goto(path);
  await expect(page.getByRole("link", { name: "IntegralFlow home" })).toBeVisible();
  await mock(page, "POST", "/mock/reset");
  await mock(page, "PUT", "/mock/session", { personaId });
  await page.goto(path);
  await expect(page.getByRole("link", { name: "IntegralFlow home" })).toBeVisible();
}

/** Zero serious or critical WCAG 2.2 A/AA violations (§11.5). */
export async function expectAccessible(page: Page): Promise<void> {
  // Let CSS transitions finish first: a control caught mid-fade (text already in its new colour,
  // background still animating) reads as a contrast failure that the settled page does not have.
  await page.evaluate(() => Promise.all(document.getAnimations().filter((animation) => animation instanceof CSSTransition).map((animation) => animation.finished.catch(() => undefined))));
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  const blocking = results.violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical");
  expect(blocking.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}
