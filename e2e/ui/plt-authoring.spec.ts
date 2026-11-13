import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { apiCall, DRAFT_A, DRAFT_B, draftRevision, forceNextResponse, installForcedResponses, spaNavigate, switchPersona } from "./authoring-support";
import { expectAccessible, signInAs } from "./support";

/** PLT-02 / PLT-03 / PLT-04 acceptance (BUILD-SPEC v2 §10) against the mock. */

const workspace = (draftId: string, tab = "workflow") => `/studio/drafts/${draftId}?tab=${tab}`;
const tabs = (page: Page) => page.getByRole("tablist", { name: "Authoring sections" });

async function openTab(page: Page, name: string) {
  await tabs(page).getByRole("tab", { name }).click();
  await expect(tabs(page).getByRole("tab", { name })).toHaveAttribute("aria-selected", "true");
}

// ---- PLT-02 · Drafts ------------------------------------------------------------------------

test("PLT-02-AC1: a new draft starts from a template or blank", async ({ page }) => {
  await signInAs(page, "agent_architect", "/studio/drafts");
  await expect(page.getByRole("heading", { level: 1, name: "Draft processes" })).toBeVisible();
  await expectAccessible(page);

  await page.getByRole("button", { name: "New from FinCrime KYB" }).click();
  await expect(page).toHaveURL(/\/studio\/drafts\/draft_[0-9a-f-]+$/);
  await expect(page.getByRole("heading", { level: 1, name: "FinCrime KYB draft" })).toBeVisible();
  // The canvas opens on the process overview; the step-level count is in All steps.
  await page.getByRole("button", { name: "All steps", exact: true }).click();
  await expect(page.getByText("9 nodes · 8 connections")).toBeVisible();

  await page.getByRole("navigation", { name: "Process Studio" }).getByRole("link", { name: "Draft processes" }).click();
  await page.getByRole("button", { name: "New process" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "New process" })).toBeVisible();
  await expect(page.getByText("2 nodes · 1 connections")).toBeVisible();
});

test("PLT-02-AC1: Import FinCrime catalog shows the artifact digest and catalog counts", async ({ page }) => {
  await signInAs(page, "agent_architect", "/studio/drafts");
  await page.getByRole("button", { name: "Import FinCrime catalog" }).click();
  const sheet = page.getByRole("dialog", { name: "Import FinCrime catalog" });
  const artifact = JSON.parse(readFileSync(new URL("../../apps/fincrime-host/catalog/ehf-catalog.json", import.meta.url), "utf8"));
  const digest: string = artifact.sha256;
  await sheet.getByLabel("Catalog artifact file").setInputFiles({
    name: "ehf-catalog.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(artifact)),
  });
  await expect(sheet.getByLabel("Expected digest")).toHaveValue(digest);
  await sheet.getByRole("button", { name: "Import catalog" }).click();
  const imported = sheet.getByRole("region", { name: "Imported catalog" });
  await expect(imported.getByText(digest.slice(0, 12)).first()).toBeVisible();
  await expect(imported.getByText("skillCount")).toBeVisible();
  await expect(imported.getByText(String(JSON.parse(artifact.content).skills.length))).toBeVisible();
  await expect(imported.getByRole("term").filter({ hasText: /^agents$/ })).toBeVisible();
  await expect(imported.getByRole("term").filter({ hasText: /^tasks$/ })).toBeVisible();
  await expectAccessible(page);
});

test("PLT-02-AC1: personas without agent.register or draft.write cannot import or create", async ({ page }) => {
  await signInAs(page, "harness_approver", "/studio/drafts");
  await expect(page.getByRole("button", { name: "Import FinCrime catalog" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "New process" })).toBeDisabled();
});

test("PLT-02-AC2: status uses the authoring dimension and PUBLISHED rows show the plan digest", async ({ page }) => {
  await signInAs(page, "agent_architect", "/studio/drafts");
  const rows = page.getByRole("table", { name: "Draft processes" }).getByRole("row");
  await expect(rows.filter({ hasText: "screening threshold" }).getByText("COMPILED")).toBeVisible();
  await expect(rows.filter({ hasText: "context selectors" }).getByText("DRAFT", { exact: true })).toBeVisible();

  // Author compiles and evaluates; an independent approver approves and publishes.
  expect((await apiCall(page, "POST", `/v1/authoring/drafts/${DRAFT_B}/compile`)).status).toBe(200);
  expect((await apiCall(page, "POST", `/v1/authoring/drafts/${DRAFT_B}/evaluate`)).status).toBe(200);
  await switchPersona(page, "harness_approver");
  expect((await apiCall(page, "POST", `/v1/authoring/drafts/${DRAFT_B}/approve`)).status).toBe(200);
  expect((await apiCall(page, "POST", `/v1/authoring/drafts/${DRAFT_B}/publish`)).status).toBe(200);

  const published = rows.filter({ hasText: "context selectors" });
  await expect(published.getByText("PUBLISHED")).toBeVisible({ timeout: 10_000 });
  await expect(published.getByRole("button", { name: "Copy plan digest" })).toBeVisible();
  await expectAccessible(page);
});

// ---- PLT-03 · Draft workspace ---------------------------------------------------------------

test("PLT-03-AC1: separation of duties disables approve for the author; a forced call shows the server's refusal", async ({ page }) => {
  await installForcedResponses(page);
  await signInAs(page, "agent_architect", workspace(DRAFT_A, "release"));
  await page.getByRole("button", { name: "Run evaluation gates" }).click();
  await expect(page.getByText("Run evaluation gates completed.")).toBeVisible();
  await expect(page.getByLabel("Lifecycle: EVALUATED")).toBeVisible();

  const approve = page.getByRole("button", { name: "Approve", exact: true });
  await expect(approve).toBeDisabled();
  await expect(page.getByText(/Needs a different approver \(separation of duties\): you edited or compiled this draft/).first()).toBeVisible();
  await expectAccessible(page);

  // The author's own call is refused by the server too.
  const own = await apiCall<{ error: string }>(page, "POST", `/v1/authoring/drafts/${DRAFT_A}/approve`);
  expect(own.status).toBe(403);

  // Force the separation refusal through the UI: the server says someone else must approve.
  await switchPersona(page, "harness_approver");
  await expect(approve).toBeEnabled();
  await forceNextResponse(page, `/drafts/${DRAFT_A}/approve`, 403, {
    error: "authorization.separation_of_duties", message: "You authored or compiled this, so someone else must approve it.", status: 403, correlationId: "corr-sod", retryable: false, details: { actor: "e.kowalski" },
  });
  await approve.click();
  await expect(page.getByText("someone else must approve").first()).toBeVisible();
  await expect(page.getByText("authorization.separation_of_duties").first()).toBeVisible();
  await expect(page.getByLabel("Lifecycle: EVALUATED")).toBeVisible();

  // An independent approver approves and publishes.
  await approve.click();
  await expect(page.getByText("Approve completed.")).toBeVisible();
  await page.getByRole("button", { name: "Publish immutable plan" }).click();
  await expect(page.getByText(/Published immutable plan/)).toBeVisible();
  await expect(page.getByLabel("Lifecycle: PUBLISHED")).toBeVisible();
});

test("PLT-03-AC2: a concurrent save shows the conflict view with both revisions and keeps the losing edit", async ({ page }) => {
  await signInAs(page, "agent_architect", workspace(DRAFT_B, "sources"));
  const editor = page.getByLabel("workflow.yaml", { exact: true });
  await expect(editor).toHaveValue(/"kind": "Workflow"/);
  const original = await editor.inputValue();
  const mine = original.replace('"name": "Screening"', '"name": "Screening (mine)"');
  await editor.fill(mine);
  await expect(page.getByText("Unsaved source changes, based on revision 3.")).toBeVisible();

  // Another tab saves first.
  const other = await apiCall(page, "PUT", `/v1/authoring/drafts/${DRAFT_B}`, { expectedRevision: 3, packageSource: (await apiCall<{ packageSource: string }>(page, "GET", `/v1/authoring/drafts/${DRAFT_B}`)).body.packageSource, workflowSource: original });
  expect(other.status).toBe(200);

  await page.getByRole("button", { name: "Save & validate" }).click();
  const conflict = page.getByRole("region", { name: /this draft changed while you were editing/ });
  await expect(conflict).toBeVisible();
  await expect(conflict.getByText("revision 4", { exact: true })).toBeVisible();
  await expect(conflict.getByText("revision 3", { exact: true })).toBeVisible();
  await expect(conflict.getByText("draft.updated by j.moreau")).toBeVisible();
  await expect(editor).toHaveValue(mine);
  await expectAccessible(page);

  await page.getByRole("button", { name: "Keep my edits on revision 4" }).click();
  await expect(page.getByText("expectedRevision 4")).toBeVisible();
  await page.getByRole("button", { name: "Save & validate" }).click();
  await expect(page.getByText("Sources saved and validation passed.")).toBeVisible();
  expect(await draftRevision(page, DRAFT_B)).toBe(5);
  await expect(editor).toHaveValue(/Screening \(mine\)/);
});

test("PLT-03-AC3: dragging three nodes in edit mode produces one revision", async ({ page }) => {
  await signInAs(page, "agent_architect", workspace(DRAFT_B));
  await page.getByRole("button", { name: "All steps", exact: true }).click();
  const canvas = page.getByTestId("workflow-canvas");
  await expect(canvas.locator(".react-flow__node")).toHaveCount(9);
  await expectAccessible(page);

  // View mode by default: nothing moves.
  await expect(page.getByText("View mode · select a node to inspect it")).toBeVisible();
  const before = await draftRevision(page, DRAFT_B);
  const graphCalls: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith(`/drafts/${DRAFT_B}/graph`)) graphCalls.push(request.postData() ?? "");
  });

  await page.getByRole("button", { name: "Edit canvas" }).click();
  for (const id of ["intake", "screening", "result"]) {
    const box = (await canvas.locator(`.react-flow__node[data-id="${id}"]`).boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + 12);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 30, box.y + 52, { steps: 4 });
    await page.mouse.up();
  }
  await expect(page.getByText(`Saved the layout of 3 nodes as revision ${before + 1}.`)).toBeVisible();
  expect(graphCalls).toHaveLength(1);
  expect(JSON.parse(graphCalls[0]!).mutation.type).toBe("layout");
  expect(JSON.parse(graphCalls[0]!).mutation.positions).toHaveLength(3);
  expect(await draftRevision(page, DRAFT_B)).toBe(before + 1);
});

test("PLT-03-AC4: context selectors save through their own mutation and survive a refetch", async ({ page }) => {
  await signInAs(page, "agent_architect", workspace(DRAFT_B));
  const selectorSaves: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "PUT" && request.url().includes(`/drafts/${DRAFT_B}/`)) selectorSaves.push(new URL(request.url()).pathname);
  });
  await page.getByRole("button", { name: "Case context" }).click();
  const panel = page.getByRole("complementary", { name: "Case context" });
  await panel.getByRole("button", { name: "Add read" }).click();
  await panel.getByLabel("Path").fill("case.subject.legalName");
  await panel.getByRole("button", { name: "Save reads" }).click();
  await expect(page.getByText("Saved 1 case-read contract.")).toBeVisible();
  expect(selectorSaves).toEqual([`/api/v1/authoring/drafts/${DRAFT_B}/context-selectors`]);
  await expectAccessible(page);

  // A fresh read of the draft carries it (the mock store resets on a full page load, so the
  // reload is a client-side remount plus refetch).
  const saved = await apiCall<{ parsedPackage: { contextSelectors: Array<{ id: string; path: string }> } }>(page, "GET", `/v1/authoring/drafts/${DRAFT_B}`);
  expect(saved.body.parsedPackage.contextSelectors).toEqual([expect.objectContaining({ id: "case-context-1", path: "case.subject.legalName" })]);
  await spaNavigate(page, "/studio/drafts");
  await expect(page.getByRole("heading", { level: 1, name: "Draft processes" })).toBeVisible();
  await spaNavigate(page, workspace(DRAFT_B));
  await page.getByRole("button", { name: "Case context" }).click();
  await expect(page.getByRole("complementary", { name: "Case context" }).getByText("case-context-1", { exact: true })).toBeVisible();
  await expect(page.getByRole("complementary", { name: "Case context" }).getByText("case · case.subject.legalName")).toBeVisible();
});

test("PLT-03-AC5: compile failure shows diagnostics with code and path; clicking one focuses the source at that path", async ({ page }) => {
  await signInAs(page, "agent_architect", workspace(DRAFT_B, "sources"));
  const editor = page.getByLabel("workflow.yaml", { exact: true });
  await expect(editor).toHaveValue(/"id": "screening"/);
  await editor.fill((await editor.inputValue()).replace('"id": "screening"', '"id": "Screening_Step"'));
  await page.getByRole("button", { name: "Save & validate" }).click();
  await expect(page.getByText("Saved with validation errors.")).toBeVisible();

  await openTab(page, "Review & release");
  await page.getByRole("button", { name: "Validate & compile" }).click();
  await expect(page.getByText("Compilation failed. Fix the diagnostics below, then compile again.")).toBeVisible();
  await expect(page.getByText("authoring.compile_failed").first()).toBeVisible();
  await expect(page.getByText("authoring.node_id_invalid", { exact: true })).toBeVisible();
  await expectAccessible(page);

  await page.getByRole("button", { name: "workflow.spec.nodes.4.id" }).click();
  await expect(page).toHaveURL(/tab=sources/);
  await expect(page).toHaveURL(/path=workflow\.spec\.nodes\.4\.id/);
  const focused = page.getByLabel("workflow.yaml", { exact: true });
  await expect(focused).toBeFocused();
  const selected = await focused.evaluate((element: HTMLTextAreaElement) => element.value.slice(element.selectionStart, element.selectionEnd));
  expect(selected).toContain('"id": "Screening_Step"');
});

test("PLT-03: every tab renders accessibly and caseWrites commands are a Select over businessCommandType", async ({ page }) => {
  await signInAs(page, "agent_architect", workspace(DRAFT_B));
  await page.getByRole("button", { name: "All steps", exact: true }).click();
  await page.getByRole("navigation", { name: "Outline" }).getByRole("button", { name: /Screening\s+Agent/ }).click();
  const inspector = page.getByRole("complementary", { name: "Node inspector" });
  await expect(inspector.getByRole("heading", { name: "Screening" })).toBeVisible();
  await inspector.locator("summary", { hasText: "Case writes" }).click();
  await inspector.getByRole("button", { name: "Add write" }).click();
  const command = inspector.getByLabel("Command");
  await expect(command).toHaveJSProperty("tagName", "SELECT");
  await expect(command.locator("option")).toHaveCount(21);
  await expectAccessible(page);
  for (const name of ["Agents & instructions", "Sources", "Capabilities", "Models & tiers", "Integrations", "Review & release"]) {
    await openTab(page, name);
    await expectAccessible(page);
  }
});

// ---- PLT-04 · Policy Studio -----------------------------------------------------------------

const policies = (draftId: string) => `/studio/drafts/${draftId}/policies`;

test("PLT-04-AC1: compile by a non-author shows the author-mismatch copy; approve by the author shows the separation copy", async ({ page }) => {
  await signInAs(page, "agent_architect", `${policies(DRAFT_B)}?tab=approvals`);
  await expect(page.getByRole("navigation", { name: "Breadcrumb" }).getByText("Policy Studio")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Revision lifecycle" })).toBeVisible();
  await expectAccessible(page);
  const lifecycle = page.getByRole("tabpanel", { name: "Approvals" });
  const header = page.locator("header").filter({ has: page.getByRole("button", { name: "Simulate" }) });
  await expect(header.getByRole("button", { name: "Save revision" })).toBeEnabled();
  await lifecycle.getByRole("button", { name: "Save new revision" }).click();
  await expect(page.getByText("Saved revision 1.")).toBeVisible();
  await expect(lifecycle.getByRole("button", { name: "Approve revision" })).toBeDisabled();
  await expect(header.getByRole("button", { name: "Compile revision" })).toBeEnabled();

  await switchPersona(page, "context_architect");
  await lifecycle.getByRole("button", { name: "Compile saved revision" }).click();
  await expect(page.getByText("Only the author of this revision can compile it.").first()).toBeVisible();
  await expect(page.getByText("policy.revision_author_mismatch").first()).toBeVisible();

  await switchPersona(page, "agent_architect");
  await lifecycle.getByRole("button", { name: "Compile saved revision" }).click();
  await expect(page.getByText(/Revision 1: COMPILED/)).toBeVisible();
  await expect(lifecycle.getByRole("button", { name: "Approve revision" })).toBeDisabled();
  await expect(lifecycle.getByText("Needs a different approver (separation of duties): you authored revision 1.")).toBeVisible();
  // The header's next step is the same action and carries the same reason.
  await expect(header.getByRole("button", { name: "Approve revision" })).toBeDisabled();
  await expect(header.getByRole("button", { name: "Approve revision" })).toHaveAccessibleDescription("Needs a different approver (separation of duties): you authored revision 1.");

  await switchPersona(page, "harness_approver");
  await expect(header.getByRole("button", { name: "Approve revision" })).toBeEnabled();
  await header.getByRole("button", { name: "Approve revision" }).click();
  await expect(page.getByText(/Revision 1: APPROVED/)).toBeVisible();
  await expect(header.getByRole("button", { name: "Publish" })).toBeVisible();
});

test("PLT-04-AC2: a production-blocked compile lists details.blockers", async ({ page }) => {
  await signInAs(page, "agent_architect", "/studio/policies?tab=approvals");
  await page.getByRole("button", { name: "Check production eligibility" }).click();
  await expect(page.getByText("Production release is blocked. Close these release blockers first.")).toBeVisible();
  const blockers = page.getByRole("region", { name: /^Release blockers \(\d+\)$/ });
  await expect(blockers.getByRole("listitem").filter({ hasText: "Approve installation policy set policy.pack.us.bank-synthetic.personal-banking.v2 (POLICY_SET_NOT_APPROVED)" })).toHaveCount(1);
  // The checkpoint rules are SYNTHETIC placeholders, so no gate is waiting for rules; content an owner
  // must supply (provider permission) is still listed.
  await expect(blockers.getByRole("listitem").filter({ hasText: "INSTALLATION_POLICY_RULES_REQUIRED" })).toHaveCount(0);
  await expect(blockers.getByRole("listitem").filter({ hasText: "INSTALLATION_CONTENT_UNRESOLVED" }).first()).toBeVisible();
  await expectAccessible(page);
});

test("PLT-04-AC3: the corpus runner shows the policy decision per gate with the policy dimension", async ({ page }) => {
  await signInAs(page, "agent_architect", `${policies(DRAFT_A)}?template=kyc&tab=approvals`);
  await page.getByRole("button", { name: "Compile candidate" }).click();
  await expect(page.getByText("Candidate compiled. Review the release blockers and sample results before release.")).toBeVisible();
  await page.getByRole("tab", { name: "Advanced" }).click();
  await page.getByRole("radio", { name: "Test corpus" }).click();
  await page.getByRole("button", { name: "Run corpus" }).click();
  const table = page.getByRole("table", { name: "Policy decision per gate" });
  await expect(table.getByRole("row")).toHaveCount(3);
  for (const gate of ["edd.required", "decision.consequential"]) {
    const row = table.getByRole("row").filter({ hasText: gate });
    await expect(row.getByText("Policy", { exact: true })).toBeVisible();
    await expect(row.getByText("REVIEW", { exact: true }).first()).toBeVisible();
  }
  await expectAccessible(page);
});
