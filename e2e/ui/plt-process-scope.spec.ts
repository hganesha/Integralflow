import { expect, test, type Page } from "@playwright/test";
import { apiCall } from "./authoring-support";
import { expectAccessible, signInAs } from "./support";

/** The seeded agentic KYC draft (ui-mock process-scope.ts): individual, onboarding, US + GB, personal banking. */
const AGENTIC_KYC = "draft_6f1c2c3e-0000-4000-8000-000000000003";
const workspace = `/studio/drafts/${AGENTIC_KYC}?tab=workflow`;
const GATE = "Policy pack: intake-ready";

async function openScopeEditor(page: Page) {
  await signInAs(page, "agent_architect", workspace);
  const chips = page.getByRole("list", { name: `Process scope pinned by ${GATE}`, exact: true });
  await expect(chips).toContainText("Individual");
  await expect(chips).toContainText("US · GB");
  await page.getByRole("button", { name: `Change process scope from ${GATE}`, exact: true }).click();
  const form = page.getByRole("form", { name: "Process scope", exact: true });
  await expect(form.getByLabel("Customer type", { exact: true })).toHaveValue("individual");
  return form;
}

test("changing a policy gate's customer type recommends the ownership agent and data, then applies it", async ({ page }) => {
  const form = await openScopeEditor(page);
  await expect(form.getByLabel("Trigger", { exact: true }).locator("option")).toHaveText(["Onboarding", "Periodic review", "Event-driven review"]);
  await expectAccessible(page);

  await form.getByLabel("Customer type", { exact: true }).selectOption("corporate");
  await form.getByRole("checkbox", { name: "card", exact: true }).uncheck();
  await form.getByRole("checkbox", { name: "lending", exact: true }).check();
  await form.getByRole("checkbox", { name: "merchant acquiring", exact: true }).check();

  const recommendation = page.getByTestId("scope-recommendation");
  const agents = recommendation.getByRole("region", { name: /^Agents: 1 added, 0 removed$/ });
  await expect(agents).toContainText("agent.identity_ownership");
  await expect(agents).toContainText("Ownership and control agent serves corporate customers.");
  const acquisition = recommendation.getByRole("region", { name: /^Data acquisition: 4 added/ });
  await expect(acquisition).toContainText("Company registry lookup");
  await expect(acquisition).toContainText("Ownership discovery");
  await expect(acquisition).toContainText("Basis: pack screening_roles includes director (layer pack.product.lending+pack.product.payments)");
  const packs = recommendation.getByRole("region", { name: /^Policy packs: 2 added, 2 removed$/ });
  await expect(packs.locator("[data-change=added]")).toContainText(["policy.pack.us.bank-synthetic.business-banking", "policy.pack.gb.bank-synthetic.business-banking"]);
  await expect(packs.locator("[data-change=removed]")).toContainText(["policy.pack.us.bank-synthetic.personal-banking", "policy.pack.gb.bank-synthetic.personal-banking"]);
  await expect(recommendation.getByRole("region", { name: /^Process steps: 6 added/ })).toContainText("registry.company.verify");
  await expectAccessible(page);

  await form.getByRole("button", { name: "Apply changes", exact: true }).click();
  await expect(form).toHaveCount(0);
  await expect(page.getByText(/Applied the process scope as revision 2: agents \+1\/−0/)).toBeVisible();
  const canvas = page.getByTestId("workflow-canvas");
  const added = canvas.getByRole("region", { name: "Ownership and control agent", exact: true });
  await expect(added).toBeVisible();
  await expect(added).toHaveAttribute("data-scope-change", "added");
  await expect(page.getByRole("list", { name: `Process scope pinned by ${GATE}`, exact: true })).toContainText("Corporate");
  const draft = await apiCall<{ revision: number; parsedWorkflow: { spec: { nodes: Array<{ id: string }> } } }>(page, "GET", `/v1/authoring/drafts/${AGENTIC_KYC}`);
  expect(draft.body.revision).toBe(2);
  expect(draft.body.parsedWorkflow.spec.nodes.map((node) => node.id)).toEqual(expect.arrayContaining(["identity-ownership-review", "acquire-registry", "acquire-officers"]));
  await expectAccessible(page);
});

test("a jurisdiction without a pack layer shows what to author instead of a diff", async ({ page }) => {
  const form = await openScopeEditor(page);
  await form.getByRole("checkbox", { name: /^DE/ }).check();
  const refusal = page.getByRole("alert").filter({ hasText: "This scope cannot be composed yet" });
  await expect(refusal).toContainText("scope.pack_layer_missing");
  await expect(refusal).toContainText("What to do: Author a jurisdiction policy pack layer for DE (domains/policy/packs).");
  await expect(page.getByTestId("scope-recommendation")).toHaveCount(0);
  await expect(form.getByRole("button", { name: "Apply changes", exact: true })).toBeDisabled();
  await expectAccessible(page);
  // Australia has a layer: the same change with AU instead is a plain pack change.
  await form.getByRole("checkbox", { name: /^DE/ }).uncheck();
  await form.getByRole("checkbox", { name: "AU", exact: true }).check();
  await expect(page.getByTestId("scope-recommendation").getByRole("region", { name: /^Policy packs: 1 added, 0 removed$/ })).toContainText("policy.pack.au.bank-synthetic.personal-banking");
});

test("due diligence and event reviews: EDD adds its steps, events follow the customer type", async ({ page }) => {
  const form = await openScopeEditor(page);
  const dueDiligence = form.getByLabel("Due diligence", { exact: true });
  await expect(dueDiligence.locator("option[value=simplified]")).toBeDisabled();
  await dueDiligence.selectOption("enhanced");
  const steps = page.getByTestId("scope-recommendation").getByRole("region", { name: /^Process steps: 3 added, 0 removed$/ });
  await expect(steps).toContainText("edd.source_of_funds.verify");
  await expect(steps).toContainText("edd.source_of_wealth.assess");
  await expect(page.getByTestId("scope-recommendation")).toContainText("Enhanced (EDD): Enhanced due diligence: source of funds verified with documents");

  await dueDiligence.selectOption("standard");
  await form.getByLabel("Trigger", { exact: true }).selectOption("event_review");
  const event = form.getByLabel("Review event", { exact: true });
  await expect(page.getByTestId("scope-recommendation")).toHaveCount(0);
  await expect(form).toContainText("Choose the event that triggers the review.");
  await expect(event.locator("option[value=ownership_change]")).toHaveCount(0);
  await event.selectOption("tax_circumstances_change");
  await expect(page.getByTestId("scope-recommendation").getByRole("region", { name: /^Agents: 0 added, 1 removed$/ })).toContainText("A tax circumstances change review does not re-run Identity and verification agent.");
  await expect(page.getByTestId("workflow-canvas").getByRole("region", { name: "Identity and verification agent", exact: true })).toHaveAttribute("data-scope-change", "removed");
  await expectAccessible(page);
});
