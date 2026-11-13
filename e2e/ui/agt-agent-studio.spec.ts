import {readFileSync} from "node:fs";
import { expect, test } from "@playwright/test";
import { expectAccessible, signInAs } from "./support";

// Process Studio (BUILD-SPEC v2 §10 AGT-01…05) against the mock catalog (fincrime.catalog.json).

const artifact=JSON.parse(readFileSync(new URL("../../apps/fincrime-host/catalog/ehf-catalog.json",import.meta.url),"utf8"));
const sourceCatalog=JSON.parse(artifact.content);
const CATALOG_DIGEST=artifact.sha256;
const AGENT = "agent.identity_ownership";
const TASK = "task.identity_ownership";

test("AGT-01-AC1/AC2/AC3: the atlas shows the source catalog agent cards with separate readiness and release chips under the catalog provenance", async ({ page }) => {
  await signInAs(page, "agent_architect", "/studio/agents/mandates");
  await expect(page.getByRole("heading", { level: 1, name: "Workforce Atlas" })).toBeVisible();
  const provenance = page.getByRole("banner").or(page.locator("main")).getByLabel("Catalog provenance").first();
  await expect(provenance.getByTitle(CATALOG_DIGEST)).toBeVisible();
  await expect(provenance).toContainText(sourceCatalog.sourceRelease);

  const cards = page.getByRole("list", { name: "Agents in the admitted catalog" }).getByRole("article");
  await expect(cards).toHaveCount(sourceCatalog.agents.length);
  const card = page.getByRole("article", { name: "Establish corporate identity, legal existence, ownership and control." }).or(page.locator(`[data-agent="${AGENT}"]`)).first();
  await expect(card).toContainText(AGENT);
  await expect(card.getByText("Readiness", { exact: true })).toBeVisible();
  await expect(card.getByText("Context ready")).toBeVisible();
  await expect(card.getByText("Release", { exact: true })).toBeVisible();
  await expect(card.getByText("Active", { exact: true })).toBeVisible();
  await expect(card.getByRole("link", { name: / task$/ })).toBeVisible();
  await expect(card.getByLabel(/Active work: 0 running, 1 waiting on a human, 0 failed/)).toBeVisible();
  await expect(card.getByRole("list", { name: `${AGENT} human gates` }).getByRole("listitem")).toHaveText(["ambiguous evidence", "policy exception", "consequential decision"]);
  // Readiness is never a percentage.
  await expect(page.locator("main")).not.toContainText("%");
  await expectAccessible(page);
});

test("AGT-02-AC1/AC2: the profile lists execution bounds, ceilings, human gates verbatim and allowed skills with versions", async ({ page }) => {
  await signInAs(page, "agent_architect", `/studio/agents/mandates/${AGENT}`);
  const bounds = page.getByRole("table", { name: "Execution bounds" });
  await expect(bounds.getByRole("row", { name: /max_agent_steps/ })).toBeVisible();
  for (const field of ["max_objects", "model_char_budget", "timeout_seconds", "purposes"]) await expect(bounds.getByText(field, { exact: true })).toBeVisible();

  const ceiling = page.getByRole("table", { name: "Context field ceiling" });
  await expect(ceiling.getByRole("row", { name: /OwnershipInterest/ })).toBeVisible();
  await expect(page.getByRole("list", { name: "Policy fields the agent may see" })).toBeVisible();

  const gates = page.getByRole("complementary", { name: "Agent gates and subscriptions" });
  await expect(gates.getByRole("listitem").filter({ hasText: "consequential decision" })).toBeVisible();
  await expect(gates.getByRole("link", { name: "Ownership", exact:true })).toBeVisible();

  const skills = page.getByRole("region", { name: "Ownership", exact:true }).getByRole("table", { name: "Allowed skills with pinned versions" });
  await expect(skills.getByRole("row", { name: /ownership\.ubo\.resolve.*0\.3\.0/ })).toBeVisible();
  await expectAccessible(page);

  await page.getByRole("link", { name: / task$/ }).click();
  await expect(page).toHaveURL(new RegExp(`/studio/agents/mandates/${AGENT}/tasks/${TASK}$`));
});

test("AGT-03-AC1/AC3/AC4: identity & ownership runs entity ∥ registry → UBO resolve → UBO verify, with validation chips and the inspector tabs", async ({ page }) => {
  await signInAs(page, "agent_architect", `/studio/agents/mandates/${AGENT}/tasks/${TASK}`);
  const map = page.getByRole("list", { name: "Task steps by dependency" });
  const parallel = map.getByRole("group", { name: "Parallel group 0: entity_resolve ∥ registry_company_verify" });
  await expect(parallel.locator("[data-step]")).toHaveCount(2);
  const order = await map.locator("[data-step]").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-step")));
  expect(order).toEqual(["entity_resolve", "registry_company_verify", "ownership_ubo_resolve", "ownership_ubo_verify"]);
  // F2 resolved: no duplicate-execution disclosure.
  await expect(page.getByText(/duplicate/i)).toHaveCount(0);

  const validation = page.getByRole("list", { name: "Task validation" });
  await expect(validation.getByRole("listitem")).toHaveCount(4);
  await expect(validation).toContainText("Every step has a completion criterion · pass");

  const inspector = page.getByRole("complementary", { name: "Step inspector" });
  await expect(inspector.getByRole("tab")).toHaveText(["Contract", "Context", "Guardrails", "Evaluation", "Trace"]);
  await expect(inspector.getByText("Bindings are defined in the FinCrime catalog (kyc) and admitted per release.")).toBeVisible();
  await expect(inspector.getByRole("heading", { name: "entity_resolve" })).toBeVisible();

  await map.getByRole("button", { name: /Ownership ubo resolve/ }).click();
  await expect(page).toHaveURL(/step=ownership_ubo_resolve/);
  await expect(inspector.getByRole("heading", { name: "ownership_ubo_resolve" })).toBeVisible();
  await expect(map.getByRole("button", { name: /Ownership ubo resolve/ })).toHaveAttribute("aria-pressed", "true");
  await inspector.getByRole("tab", { name: "Guardrails" }).click();
  await expect(page).toHaveURL(/tab=guardrails/);
  await expect(inspector.getByText("Failure codes")).toBeVisible();
  await expect(inspector.getByText("Task failure policy")).toBeVisible();
  await inspector.getByRole("tab", { name: "Evaluation" }).click();
  await expect(inspector.getByText("Evaluation results are not available here")).toBeVisible();
  await expectAccessible(page);
});

test("AGT-03-AC2: a step that requires a human decision shows the gate glyph", async ({ page }) => {
  await signInAs(page, "agent_architect", "/agents/agent.decision_support/tasks/task.decision_support");
  const map = page.getByRole("list", { name: "Task steps by dependency" });
  await expect(map.locator('[data-step="decision_human_review"]').getByRole("img", { name: "Requires a human decision" })).toBeVisible();
  await expect(map.locator('[data-step="decision_rules_evaluate"]').getByRole("img", { name: "Requires a human decision" })).toHaveCount(0);
});

test("AGT-05-AC1/AC2: the context handshake marks each requirement met, outside the ceiling or needing a runtime check; dry run links to the preview", async ({ page }) => {
  await signInAs(page, "agent_architect", `/studio/agents/mandates/${AGENT}/tasks/${TASK}?step=ownership_ubo_resolve&tab=context`);
  const inspector = page.getByRole("complementary", { name: "Step inspector" });
  const table = inspector.getByRole("table", { name: "Context requirements of ownership.ubo.resolve" });
  await expect(table.getByRole("row", { name: /OwnershipInterest\.owner\s*Needs runtime check\s*required/ })).toBeVisible();
  await expect(table.getByRole("row", { name: /Policy\.jurisdiction\s*Met\s*required/ })).toBeVisible();
  const statuses = await table.locator("tbody [data-handshake]").allTextContents();
  expect(statuses.length).toBeGreaterThan(0);
  for (const status of statuses) expect(["Met", "Outside agent ceiling", "Needs runtime check"]).toContain(status.trim());
  await expect(inspector).not.toContainText("%");
  await expect(inspector.getByRole("link", { name: "Dry run the context packet" }))
    .toHaveAttribute("href", `/context/preview?agent=${encodeURIComponent(AGENT)}&task=${encodeURIComponent(TASK)}`);
  await expectAccessible(page);
});

test("AGT-04: the skill detail shows the manifest contract, guardrails and field requirements", async ({ page }) => {
  await signInAs(page, "agent_architect", "/studio/skills/definitions/ownership.ubo.resolve");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page).toHaveURL(/studio\/skills\?source=ownership.ubo.resolve/);
  await page.getByRole("tab", {name:"Context requirements",exact:true}).click();
  await expect(page.getByRole("table", { name: "Field requirements of ownership.ubo.resolve" }).getByRole("row", { name: /OwnershipInterest\s+owner/ })).toBeVisible();
  await page.getByRole("tab", {name:"Contract & schemas",exact:true}).click();
  await expect(page.getByText("Input schema")).toBeVisible();
  await page.getByRole("tab", {name:"Agents & tasks",exact:true}).click();
  await expect(page.getByRole("tabpanel").getByRole("link", { name: /^Identity and ownership/ })).toBeVisible();
  await expectAccessible(page);
});

test("AGT guard: a persona without draft.read gets the 403 surface for Process Studio", async ({ page }) => {
  await signInAs(page, "cdd_analyst", "/studio/agents/mandates");
  await expect(page.getByText(/draft\.read/).first()).toBeVisible();
  await expect(page.getByRole("list", { name: "Agents in the admitted catalog" })).toHaveCount(0);
});
