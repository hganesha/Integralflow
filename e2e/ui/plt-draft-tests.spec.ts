import { expect, test } from "@playwright/test";
import { apiCall, DRAFT_B } from "./authoring-support";
import { expectAccessible, signInAs } from "./support";

const workspace = `/platform/drafts/${DRAFT_B}?tab=workflow`;
test("draft testing selects sample data, validates JSON and requires the real execution service", async ({ page }) => {
  await signInAs(page, "agent_architect", workspace);
  const before = (await apiCall<{ revision: number; status: string }>(page, "GET", `/v1/authoring/drafts/${DRAFT_B}`)).body;
  await page.getByRole("button", { name: "Test draft", exact: true }).click();
  const form = page.getByRole("form", { name: "Test draft", exact: true });
  await expect(form.getByLabel("Sample data", { exact: true })).toHaveValue("schema-template");
  await expect(form.getByLabel("Model execution", { exact: true })).toHaveValue("recorded");
  await form.getByLabel("Test data (JSON)", { exact: true }).fill("{");
  await form.getByRole("button", { name: "Run draft test", exact: true }).click();
  await expect(form.getByText(/JSON/).last()).toBeVisible();
  await form.getByLabel("Test data (JSON)", { exact: true }).fill(JSON.stringify({ input: {}, context: {}, capabilityOutputs: {} }));
  await form.getByRole("button", { name: "Run draft test", exact: true }).click();
  await expect(form.getByText(/Open HTTP mode with the control API/)).toBeVisible();
  const after = (await apiCall<{ revision: number; status: string }>(page, "GET", `/v1/authoring/drafts/${DRAFT_B}`)).body;
  expect(after.revision).toBe(before.revision); expect(after.status).toBe(before.status);
  await expectAccessible(page);
});

test("canvas editing and read-only roles cannot start draft tests", async ({ page }) => {
  await signInAs(page, "agent_architect", workspace);
  await page.getByRole("button", { name: "Edit canvas", exact: true }).click();
  await page.getByRole("button", { name: "Test draft", exact: true }).click();
  await expect(page.getByRole("button", { name: "Run draft test", exact: true })).toBeDisabled();
  await expect(page.getByText("Finish editing the canvas before testing.")).toBeVisible();
  await signInAs(page, "auditor", workspace);
  await page.getByRole("button", { name: "Test draft", exact: true }).click();
  await expect(page.getByRole("button", { name: "Run draft test", exact: true })).toBeDisabled();
});
