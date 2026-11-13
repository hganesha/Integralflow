import { expect, test } from "@playwright/test";
import { apiCall, DRAFT_B, spaNavigate } from "./authoring-support";
import { expectAccessible, signInAs } from "./support";

const workspace = `/studio/drafts/${DRAFT_B}?tab=workflow`;
type Draft = { revision: number; packageSource: string; workflowSource: string; parsedWorkflow: { spec: { nodes: Array<{ id: string; name: string; config: Record<string, unknown> }>; edges: Array<{ id: string; from: string; to: string; kind: string; condition?: string }> } } };
const getDraft = async (page: Parameters<typeof apiCall>[0]) => (await apiCall<Draft>(page, "GET", `/v1/authoring/drafts/${DRAFT_B}`)).body;

test("canvas edits save canonical names and notes and survive a tab round trip", async ({ page }) => {
  await signInAs(page, "agent_architect", workspace);
  const before = await getDraft(page);
  const step = before.parsedWorkflow.spec.nodes[0]!;
  await page.getByRole("button", { name: "Edit canvas", exact: true }).click();
  await expectAccessible(page);
  await page.getByRole("button", { name: `Edit step ${step.name}`, exact: true }).click();
  const form = page.getByRole("form", { name: `Edit step ${step.id}` });
  await form.getByLabel("Step name", { exact: true }).fill("Review incoming evidence");
  await form.getByLabel("Step description", { exact: true }).fill("Read the original document before proceeding.");
  await form.getByRole("button", { name: "Save step", exact: true }).click();
  await expect(form).toHaveCount(0);
  const saved = await getDraft(page);
  expect(saved.revision).toBe(before.revision + 1);
  expect(saved.parsedWorkflow.spec.nodes[0]).toMatchObject({ name: "Review incoming evidence", config: { ...step.config, ui: { ...(step.config.ui as object), description: "Read the original document before proceeding." } } });
  await page.getByRole("tab", { name: "Sources", exact: true }).click();
  await expect(page.getByLabel("workflow.yaml", { exact: true })).toHaveValue(/Read the original document before proceeding/);
  await page.getByRole("tab", { name: "Workflow", exact: true }).click();
  // Step descriptions show in All steps (the canvas opens on the process overview).
  const allSteps = page.getByRole("button", { name: "All steps", exact: true });
  await allSteps.click();
  await expect(allSteps).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("Read the original document before proceeding.", { exact: true })).toBeVisible();
  // Let the view toggle's colour transition finish before the contrast scan.
  await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished)));
  await expectAccessible(page);
});

test("inserting on a conditional connection preserves its predicate and sibling branch", async ({ page }) => {
  await signInAs(page, "agent_architect", "/studio/drafts");
  const draft = await getDraft(page);
  const workflow = structuredClone(draft.parsedWorkflow);
  const edge = workflow.spec.edges[0]!;
  edge.condition = "needs_review";
  const sibling = { id: "skip-review", from: edge.from, to: workflow.spec.nodes.at(-1)!.id, kind: "control", condition: "skip_review" };
  workflow.spec.edges.push(sibling);
  const saved = await apiCall<Draft>(page, "PUT", `/v1/authoring/drafts/${DRAFT_B}`, { expectedRevision: draft.revision, packageSource: draft.packageSource, workflowSource: JSON.stringify(workflow) });
  expect(saved.status).toBe(200);
  await spaNavigate(page, workspace);
  await page.getByRole("button", { name: "Edit canvas", exact: true }).click();
  await page.getByRole("button", { name: `Insert step on connection ${edge.from} to ${edge.to}`, exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Insert workflow step" });
  await sheet.getByLabel("Step type", { exact: true }).selectOption("approval");
  await sheet.getByLabel("Step ID", { exact: true }).fill("check-source");
  await sheet.getByLabel("Step name", { exact: true }).fill("Check source");
  await expectAccessible(page);
  await sheet.getByRole("button", { name: "Insert step", exact: true }).click();
  await expect(sheet).toHaveCount(0);
  const updated = await getDraft(page);
  expect(updated.revision).toBe(saved.body.revision + 1);
  expect(updated.parsedWorkflow.spec.edges).toContainEqual({ ...edge, to: "check-source" });
  expect(updated.parsedWorkflow.spec.edges).toContainEqual(sibling);
  expect(updated.parsedWorkflow.spec.edges).toContainEqual(expect.objectContaining({ from: "check-source", to: edge.to }));
  expect(updated.parsedWorkflow.spec.nodes).toContainEqual(expect.objectContaining({ id: "check-source", kind: "approval" }));
});

test("a stale inline edit keeps its text until the author explicitly uses the latest revision", async ({ page }) => {
  await signInAs(page, "agent_architect", workspace);
  const draft = await getDraft(page);
  const step = draft.parsedWorkflow.spec.nodes[0]!;
  await page.getByRole("button", { name: "Edit canvas", exact: true }).click();
  await page.getByRole("button", { name: `Edit step ${step.name}`, exact: true }).click();
  const form = page.getByRole("form", { name: `Edit step ${step.id}` });
  await form.getByLabel("Step name", { exact: true }).fill("My pending edit");
  expect((await apiCall(page, "POST", `/v1/authoring/drafts/${DRAFT_B}/graph`, { expectedRevision: draft.revision, mutation: { type: "update-node", nodeId: step.id, name: "Another author's edit", description: "" } })).status).toBe(200);
  await form.getByRole("button", { name: "Save step", exact: true }).click();
  await expect(form.getByLabel("Step name", { exact: true })).toHaveValue("My pending edit");
  await expect(form.getByRole("button", { name: "Use latest revision", exact: true })).toBeVisible();
  expect((await getDraft(page)).parsedWorkflow.spec.nodes[0]!.name).toBe("Another author's edit");
  await form.getByRole("button", { name: "Use latest revision", exact: true }).click();
  await form.getByRole("button", { name: "Save step", exact: true }).click();
  await expect(form).toHaveCount(0);
  expect((await getDraft(page)).parsedWorkflow.spec.nodes[0]!.name).toBe("My pending edit");
});

test("view mode and read-only roles expose no mutation controls", async ({ page }) => {
  await signInAs(page, "harness_approver", workspace);
  await expect(page.getByRole("button", { name: "Edit canvas", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: /^Edit step / })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Insert step on connection / })).toHaveCount(0);
  const draft = await getDraft(page);
  await page.keyboard.press("Delete");
  expect((await getDraft(page)).revision).toBe(draft.revision);
  await expectAccessible(page);
});
