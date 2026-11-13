import { expect, test } from "@playwright/test";
import { apiCall } from "./authoring-support";
import { expectAccessible } from "./support";
const base = process.env.WORKBENCH_HTTP_URL;
test.skip(!base, "Requires the isolated real HTTP stack.");
const shots = "../../docs/audits/2026-11-09-ui/navigation/screenshots";

test("agent case access uses selectors and commands, saves generated identity and pins reads on attachment", async ({
  page,
}) => {
  await page.goto(base + "/studio/drafts");
  const draft = (await apiCall<any>(page, "POST", "/v1/authoring/drafts", {}))
    .body;
  const read = {
    id: "case-id",
    source: "case",
    path: "case.caseId",
    purpose: "REVIEW",
    classification: "CONFIDENTIAL",
    required: true,
  };
  const prepared = await apiCall<any>(
    page,
    "PUT",
    `/v1/authoring/drafts/${draft.draftId}/context-selectors`,
    { expectedRevision: draft.revision, contextSelectors: [read] },
  );
  expect(prepared.status).toBe(200);
  await page.goto(base + `/studio/drafts/${draft.draftId}?tab=agents`);
  await page.getByRole("button", { name: "Create agent", exact: true }).click();
  const form = page.locator("form").filter({
    has: page.getByRole("heading", {
      name: "New agent contract",
      exact: true,
    }),
  });
  const name = "Case review " + Date.now();
  await form.getByLabel("Name", { exact: true }).fill(name);
  const id = await form.getByLabel("Agent ID", { exact: true }).inputValue();
  expect(id).toMatch(/^agent\.case-review-.*\.v1$/);
  await form
    .getByLabel("Description", { exact: true })
    .fill("Review selected case data");
  await form.getByLabel("Role", { exact: true }).fill("Reviewer");
  await form
    .getByLabel("System prompt", { exact: true })
    .fill("Use only the selected case data.");
  await form
    .getByLabel("Output parameters (JSON Schema)", { exact: true })
    .fill(
      JSON.stringify({
        type: "object",
        properties: { evidenceId: { type: "string" } },
      }),
    );
  await form
    .getByLabel("Add case read", { exact: true })
    .selectOption("case-id");
  await form
    .getByLabel("Add case write", { exact: true })
    .selectOption("LinkEvidence");
  await form
    .locator("summary")
    .filter({ hasText: "Payload mapping and schema" })
    .click();
  await expect(
    form.getByLabel("Case write 1 payload", { exact: true }),
  ).toHaveValue(/output.evidenceId/);
  await expectAccessible(page);
  await page.screenshot({
    path: shots + "/agent-case-access-desktop.png",
    fullPage: true,
  });
  const saved = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/v1/authoring/agents") &&
      response.request().method() === "POST",
  );
  await form
    .getByRole("button", { name: "Register agent", exact: true })
    .click();
  const result = await saved;
  expect(result.status(), await result.text()).toBe(201);
  const registration = await result.json();
  expect(registration.agent.id).toBe(id);
  expect(registration.agent.caseReads).toEqual([read]);
  expect(registration.agent.caseWrites[0].payload).toEqual({
    evidenceId: "{{ output.evidenceId }}",
  });
  const attached = await apiCall<any>(
    page,
    "POST",
    `/v1/authoring/drafts/${draft.draftId}/agents/${id}/attach`,
    {
      expectedRevision: prepared.body.revision,
      nodeId: "intake",
      mode: "insert-after",
      newNodeId: "review-case",
    },
  );
  expect(attached.status, JSON.stringify(attached.body)).toBe(200);
  expect(
    attached.body.draft.parsedWorkflow.spec.nodes.find(
      (node: any) => node.id === "review-case",
    ).contextSelectorIds,
  ).toEqual(["case-id"]);
  await page.reload();
  await page
    .getByRole("listitem")
    .filter({ hasText: name })
    .getByRole("button", { name: "Edit", exact: true })
    .click();
  await expect(page.getByLabel("Agent ID", { exact: true })).toHaveValue(id);
  await expect(
    page.getByRole("button", { name: "Remove case read case.caseId" }),
  ).toBeVisible();
});

test("context connection, binding and dataset identities are filled and persist without typing IDs", async ({
  page,
}) => {
  await page.goto(base + "/platform/data-sources?tab=connections&connectionMode=enterprise");
  await page
    .getByRole("tab", { name: "Product source connections", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Add connection", exact: true })
    .click();
  const connection = page.getByRole("dialog", {
    name: "Add enterprise connection",
    exact: true,
  });
  const name = "Auto IDs " + Date.now();
  await connection.getByLabel("Connection name", { exact: true }).fill(name);
  const id = await connection
    .getByLabel("Connection ID", { exact: true })
    .inputValue();
  expect(id).toMatch(/^auto-ids-/);
  await connection
    .getByLabel("Endpoint", { exact: true })
    .fill("postgresql://warehouse.example.test:5432/customers");
  await connection.getByLabel("Database", { exact: true }).fill("customers");
  await connection.getByLabel("Object", { exact: true }).fill("customer_view");
  const savedConnection = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/v1/context-sources/connections") &&
      response.request().method() === "POST",
  );
  await connection
    .getByRole("button", { name: "Save connection", exact: true })
    .click();
  expect((await savedConnection).status()).toBe(201);
  await page
    .getByRole("tab", { name: "Product bindings", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Add product binding", exact: true })
    .click();
  const binding = page.getByRole("dialog", {
    name: "Map a context source",
    exact: true,
  });
  await binding
    .getByLabel("Binding name", { exact: true })
    .fill(name + " mapping");
  await binding
    .getByLabel("Connection revision", { exact: true })
    .selectOption(id + ":1");
  const bindingId = await binding
    .getByLabel("Binding ID", { exact: true })
    .inputValue();
  const datasetId = await binding
    .getByLabel("Dataset ID", { exact: true })
    .inputValue();
  expect(bindingId).toMatch(/^auto-ids-/);
  expect(datasetId).toMatch(/^dataset\.auto-ids-/);
  const savedBinding = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/v1/context-sources/bindings") &&
      response.request().method() === "POST",
  );
  await binding
    .getByRole("button", { name: "Save binding", exact: true })
    .click();
  const response = await savedBinding;
  expect(response.status(), await response.text()).toBe(201);
  expect((await response.json()).definition).toMatchObject({
    id: bindingId,
    datasetId,
    connectionId: id,
  });
});

test("catalog skills open highlighted in a tabbed Studio and carry tabs into editable source", async ({
  page,
}) => {
  await page.goto(
    base + "/catalogs/skills?q=screening.name.normalize&view=table",
  );
  const skill = page.getByRole("link", {
    name: "Normalize screening name",
    exact: true,
  });
  await expect(skill).toBeVisible();
  await skill.click();
  await expect(page).toHaveURL(
    /studio\/skills\?source=screening.name.normalize/,
  );
  await expect(
    page.getByRole("heading", { name: "Skill Studio", exact: true }),
  ).toBeVisible();
  const selected = page
    .getByRole("region", { name: "Skill library" })
    .getByRole("link", { name: /Normalize screening name/ });
  await expect(selected).toHaveAttribute("aria-current", "page");
  for (const tab of [
    "Overview",
    "Contract & schemas",
    "Context requirements",
    "Guardrails",
    "Agents & tasks",
    "Source files",
  ]) {
    await page.getByRole("tab", { name: tab, exact: true }).click();
    await expect(
      page.getByRole("tab", { name: tab, exact: true }),
    ).toHaveAttribute("aria-selected", "true");
  }
  await expect(page.getByLabel("Find a file", { exact: true })).toBeVisible();
  await expectAccessible(page);
  await page.screenshot({
    path: shots + "/skill-studio-source-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  const browse = page.getByRole("button", {
    name: "Browse skills and workspaces",
    exact: true,
  });
  await expect(browse).toHaveAttribute("aria-expanded", "false");
  await browse.click();
  await expect(selected).toBeVisible();
  await browse.click();
  await expect(page.getByRole("tabpanel")).toBeVisible();
  await page.screenshot({
    path: shots + "/skill-studio-source-mobile.png",
    fullPage: true,
  });
  await page
    .getByRole("tab", { name: "Dataset evaluations", exact: true })
    .click();
  await page
    .getByRole("button", {
      name: /Create editable workspace|Open workspace/,
      exact: true,
    })
    .click();
  await expect(
    page.getByLabel("Dataset (JSON)", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("tab", { name: "Contract & schemas", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("tab", { name: "Revisions & publication", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Revisions & publication", exact: true }),
  ).toBeVisible();
});

test("Azure Foundry appears in intelligence with generated proposal IDs and honest adapter status", async ({
  page,
}) => {
  await page.goto(base + "/platform/intelligence?tab=connections");
  const inventory = await (
    await page.request.get(base + "/api/v1/intelligence")
  ).json();
  expect(inventory.adapters).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        cloud: "azure",
        id: "azure_foundry",
        implemented: true,
      }),
      expect.objectContaining({
        cloud: "azure",
        id: "azure_foundry_agents",
        implemented: false,
      }),
    ]),
  );
  await page
    .getByRole("button", { name: "Configure connection", exact: true })
    .click();
  const sheet = page.getByRole("dialog", {
    name: "Configure intelligence binding",
    exact: true,
  });
  await sheet
    .getByLabel("Service class", { exact: true })
    .selectOption("runtime");
  const name = "Azure review " + Date.now();
  await sheet.getByLabel("Name", { exact: true }).fill(name);
  const id = await sheet.getByLabel("Binding ID", { exact: true }).inputValue();
  expect(id).toMatch(/^runtime\.azure-review-/);
  await sheet.getByRole("button", { name: "Continue", exact: true }).click();
  await sheet
    .getByLabel("Cloud or deployment", { exact: true })
    .selectOption("azure");
  await expect(sheet.getByLabel("Adapter", { exact: true })).toHaveValue(
    "azure_foundry_agents",
  );
  await expect(
    sheet.getByText(/This adapter is a planning target/),
  ).toBeVisible();
  await sheet
    .getByLabel("Resource endpoint", { exact: true })
    .fill("https://foundry.services.ai.azure.com/api/projects/review");
  await sheet.getByRole("button", { name: /4\s+Review/ }).click();
  await sheet
    .getByLabel("Change reason", { exact: true })
    .fill("Record Foundry integration requirements");
  const saved = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/v1/intelligence/candidates") &&
      response.request().method() === "POST",
  );
  await sheet
    .getByRole("button", { name: "Save proposal", exact: true })
    .click();
  const response = await saved;
  expect(response.status(), await response.text()).toBe(200);
  expect((await response.json()).definition).toMatchObject({
    id,
    connection: { cloud: "azure", adapterId: "azure_foundry_agents" },
  });
  await expect(page.getByRole("dialog", { name, exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("dialog", { name, exact: true })).toContainText(
    id,
  );
  await expectAccessible(page);
});
