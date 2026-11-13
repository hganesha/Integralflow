import { expect, type Page } from "@playwright/test";
import { mock } from "./support";

/** Fixture drafts (platform.json): DRAFT_A is COMPILED and authored by j.moreau; DRAFT_B is DRAFT, by m.lindqvist. */
export const DRAFT_A = "draft_6f1c2c3e-0000-4000-8000-000000000001";
export const DRAFT_B = "draft_6f1c2c3e-0000-4000-8000-000000000002";

const NAMES: Record<string, string> = { agent_architect: "J. Moreau", harness_approver: "E. Kowalski", context_architect: "M. Lindqvist" };

/** Switch persona in place (no reload, so the mock store keeps this test's edits). */
export async function switchPersona(page: Page, personaId: keyof typeof NAMES & string): Promise<void> {
  await mock(page, "PUT", "/mock/session", { personaId });
  await expect(page.getByRole("banner").getByText(NAMES[personaId]!).first()).toBeVisible();
}

/**
 * Call the Experience API as the current persona from inside the page, the way a second
 * browser tab would (CSRF token from the session, no identity headers).
 */
export async function apiCall<T = Record<string, unknown>>(page: Page, method: "GET" | "POST" | "PUT", path: string, body?: unknown): Promise<{ status: number; body: T }> {
  return page.evaluate(async ({ method, path, body }) => {
    const session = await (await fetch("/api/v1/session")).json();
    const response = await fetch(`/api${path}`, {
      method,
      headers: { "content-type": "application/json", ...(method === "GET" ? {} : { "X-CSRF-Token": session.csrfToken }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  }, { method, path, body }) as Promise<{ status: number; body: T }>;
}

export async function draftRevision(page: Page, draftId: string): Promise<number> {
  const { body } = await apiCall<{ revision: number }>(page, "GET", `/v1/authoring/drafts/${draftId}`);
  return body.revision;
}

/** Navigate inside the SPA (a full reload would reseed the mock store). */
export async function spaNavigate(page: Page, path: string): Promise<void> {
  await page.evaluate((target) => {
    window.history.pushState({}, "", target);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, path);
}

/**
 * Make the next app request whose path ends with `suffix` answer with `status`/`body`
 * without reaching the mock. The mock answers inside its service worker, which page.route
 * does not see, so the page's fetch is wrapped before any app script loads. Call before
 * the first navigation.
 */
export async function installForcedResponses(page: Page): Promise<void> {
  await page.addInitScript(() => {
    type Forced = { suffix: string; status: number; body: unknown };
    const scope = window as unknown as { __forced?: Forced | null };
    const original = window.fetch.bind(window);
    window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const forced = scope.__forced;
      if (forced && new URL(url, location.href).pathname.endsWith(forced.suffix)) {
        scope.__forced = null;
        return Promise.resolve(new Response(JSON.stringify(forced.body), { status: forced.status, headers: { "content-type": "application/json" } }));
      }
      return original(input, init);
    };
  });
}

export async function forceNextResponse(page: Page, suffix: string, status: number, body: unknown): Promise<void> {
  await page.evaluate((forced) => {
    (window as unknown as { __forced?: unknown }).__forced = forced;
  }, { suffix, status, body });
}
