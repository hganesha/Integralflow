import { expect, type Page } from "@playwright/test";
import { mock } from "./support";

export const CASE = "KYB-1042";

export type Scenario = "ownership_review" | "screening_review" | "decision_pending" | "second_approval" | "decided";

export const NAMES: Record<string, string> = {
  case_manager: "M. Castillo",
  cdd_analyst: "R. Okafor",
  screening_analyst: "L. Nakamura",
  compliance_officer: "S. Varga",
  second_approver: "H. Adeyemi",
  relationship_manager: "D. Patel",
  ops_manager: "A. Ruiz",
  auditor: "P. Lindgren",
};

/** Open `path` as `personaId` with the mock store freshly seeded at `scenario`. */
export async function openAs(page: Page, personaId: string, scenario: Scenario, path: string): Promise<void> {
  await page.goto(path);
  await expect(page.getByRole("link", { name: "IntegralFlow home" })).toBeVisible();
  await mock(page, "PUT", "/mock/scenario", { scenario });
  await mock(page, "POST", "/mock/reset");
  await mock(page, "PUT", "/mock/session", { personaId });
  await page.goto(path);
  await expect(page.getByRole("banner").getByText(NAMES[personaId] ?? personaId).first()).toBeVisible();
}

/** Switch persona in place: no reload, so this test's store mutations survive. */
export async function become(page: Page, personaId: string): Promise<void> {
  await mock(page, "PUT", "/mock/session", { personaId });
  await expect(page.getByRole("banner").getByText(NAMES[personaId] ?? personaId).first()).toBeVisible();
}

/** Navigate inside the SPA (a full reload would reseed the mock store). */
export async function go(page: Page, path: string): Promise<void> {
  await page.evaluate((target) => {
    window.history.pushState({}, "", target);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, path);
}

/** The case sequence the case header shows. */
export function caseSequence(page: Page) {
  return page.getByTestId("case-sequence");
}

/**
 * Fill and submit the open TrustedDecisionSheet: choose the option, a reason, a rationale,
 * attest, decide. Returns the dialog for follow-up assertions.
 */
export async function decideInSheet(page: Page, option: string, rationale = "Reviewed the cited evidence.") {
  const sheet = page.getByRole("dialog");
  await sheet.getByRole("radio", { name: option }).click();
  const reason = sheet.getByLabel("Reason code");
  if ((await reason.evaluate((element) => element.tagName)) === "SELECT") await reason.selectOption({ index: 1 });
  else await reason.fill("evidence.sufficient");
  await sheet.getByLabel(/^Rationale/).fill(rationale);
  await sheet.getByRole("checkbox", { name: /I reviewed the evidence and this decision is mine/ }).check();
  await sheet.getByRole("button", { name: "Decide", exact: true }).click();
  return sheet;
}
