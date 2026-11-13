import { expect, test, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parse, stringify } from "yaml";
import { apiCall } from "./authoring-support";
import { expectAccessible } from "./support";
const base = process.env.WORKBENCH_HTTP_URL;
test.skip(!base, "Requires isolated HTTP services.");
type Draft = {
  draftId: string;
  name: string;
  revision: number;
  packageSource: string;
  workflowSource: string;
  parsedPackage: Record<string, any>;
  parsedWorkflow: Record<string, any>;
};
async function create(page: Page) {
  await page.goto(base + "/studio/drafts");
  const result = await apiCall<Draft>(page, "POST", "/v1/authoring/drafts", {});
  expect(result.status).toBe(201);
  return result.body;
}
const load = async (page: Page, id: string) =>
  (await apiCall<Draft>(page, "GET", `/v1/authoring/drafts/${id}`)).body;
const graph = (page: Page, draft: Draft, mutation: unknown) =>
  apiCall<{ draft: Draft }>(
    page,
    "POST",
    `/v1/authoring/drafts/${draft.draftId}/graph`,
    { expectedRevision: draft.revision, mutation },
  );
const shots = "../../docs/audits/2026-11-09-ui/navigation/screenshots";

test("inline process name persists, cancels and retains a conflicting edit; readers cannot rename", async ({
  page,
  browser,
}) => {
  const draft = await create(page);
  await page.goto(base + `/studio/drafts/${draft.draftId}`);
  await page
    .getByRole("button", { name: "Edit process name", exact: true })
    .click();
  await page.getByLabel("Process name", { exact: true }).fill("Cancelled name");
  await page.getByLabel("Process name", { exact: true }).press("Escape");
  expect((await load(page, draft.draftId)).revision).toBe(draft.revision);
  await page
    .getByRole("button", { name: "Edit process name", exact: true })
    .click();
  await page
    .getByLabel("Process name", { exact: true })
    .fill("Customer onboarding");
  await page.getByRole("button", { name: "Save name", exact: true }).click();
  await expect(
    page.getByRole("heading", {
      name: "Customer onboarding",
      level: 1,
      exact: true,
    }),
  ).toBeVisible();
  const saved = await load(page, draft.draftId);
  expect(saved.name).toBe("Customer onboarding");
  expect(saved.revision).toBe(draft.revision + 1);
  expect(saved.packageSource).toBe(draft.packageSource);
  expect(saved.parsedWorkflow.metadata.name).toBe(
    draft.parsedWorkflow.metadata.name,
  );
  await page.reload();
  await expect(
    page.getByRole("heading", {
      name: "Customer onboarding",
      level: 1,
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Edit process name", exact: true })
    .click();
  await page
    .getByLabel("Process name", { exact: true })
    .fill("My process name");
  expect(
    (
      await graph(page, saved, {
        type: "rename-process",
        name: "Another author's name",
      })
    ).status,
  ).toBe(200);
  await page.getByRole("button", { name: "Save name", exact: true }).click();
  await expect(
    page.getByRole("region", { name: /Rename process: this draft changed/ }),
  ).toBeVisible();
  await expect(page.getByLabel("Process name", { exact: true })).toHaveValue(
    "My process name",
  );
  expect((await load(page, draft.draftId)).name).toBe("Another author's name");
  await page
    .getByRole("group", { name: "Edit process name", exact: true })
    .getByRole("button", { name: "Use latest revision", exact: true })
    .click();
  await page.getByRole("button", { name: "Save name", exact: true }).click();
  await expect(
    page.getByRole("heading", {
      name: "My process name",
      level: 1,
      exact: true,
    }),
  ).toBeVisible();
  await expectAccessible(page);
  await page.screenshot({
    path: shots + "/process-name-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole("button", { name: "Edit process name", exact: true })
    .click();
  await expectAccessible(page);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: shots + "/process-name-inline-mobile.png",
    fullPage: true,
  });
  await page.getByLabel("Process name", { exact: true }).press("Escape");
  const reader = await browser.newContext({
    extraHTTPHeaders: {
      "x-workbench-user": "process-reader",
      "x-workbench-roles": "Harness.Reader",
    },
  });
  try {
    const view = await reader.newPage();
    await view.goto(base + `/studio/drafts/${draft.draftId}`);
    await expect(
      view.getByRole("heading", {
        name: "My process name",
        level: 1,
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      view.getByRole("button", { name: "Edit process name", exact: true }),
    ).toHaveCount(0);
    await expect(
      view.getByRole("button", { name: "Edit canvas", exact: true }),
    ).toBeDisabled();
  } finally {
    await reader.close();
  }
});

test("agent, human review and policy gate insertions and inline edits persist through real APIs", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const draft = await create(page);
  const suffix = Date.now();
  const agent = {
    id: `agent.canvas-review.${suffix}`,
    name: "Canvas evidence reviewer",
    description: "Review supplied evidence",
    role: "reviewer",
    prompt: "Review the supplied evidence.",
    modelProfileId: "model.standard.v1",
    runtimeTarget: "local_http",
    skillIds: [],
    caseWrites: [],
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    version: "1.0.0",
    status: "active",
  };
  const registration = await apiCall(
    page,
    "POST",
    "/v1/authoring/agents",
    agent,
  );
  expect(registration.status).toBe(201);
  const policySource = readFileSync(
    new URL("../../domains/kyc/policy/policy.yaml", import.meta.url),
    "utf8",
  );
  const pkg = parse(draft.packageSource);
  pkg.policies = [
    {
      policyId: "policy.kyc.customer-acceptance.v1",
      policyVersion: "1.0.0",
      source: "policy.yaml",
      digest:
        "sha256:" + createHash("sha256").update(policySource).digest("hex"),
    },
  ];
  const seeded = await apiCall<Draft>(
    page,
    "PUT",
    `/v1/authoring/drafts/${draft.draftId}`,
    {
      expectedRevision: draft.revision,
      packageSource: stringify(pkg),
      workflowSource: draft.workflowSource,
      sourceFiles: { "policy.yaml": policySource },
    },
  );
  expect(seeded.status).toBe(200);
  const failed = await graph(page, seeded.body, {
    type: "insert-on-edge",
    edgeId: "e1",
    node: {
      id: "absent-agent",
      kind: "agent",
      name: "Absent",
      agentId: "agent.missing",
    },
  });
  expect(failed.status).toBe(400);
  expect((await load(page, draft.draftId)).revision).toBe(seeded.body.revision);
  await page.goto(base + `/studio/drafts/${draft.draftId}`);
  await page.getByRole("button", { name: "Edit canvas", exact: true }).click();
  let previous = "intake";
  for (const [kind, id, name] of [
    ["agent", "agent-review", "Evidence review"],
    ["approval", "human-review", "Human approval"],
    ["gate", "policy-review", "Acceptance gate"],
  ] as const) {
    const before = await load(page, draft.draftId);
    await page
      .getByRole("button", {
        name: `Insert step on connection ${previous} to result`,
        exact: true,
      })
      .click();
    const sheet = page.getByRole("dialog", {
      name: "Insert workflow step",
      exact: true,
    });
    await sheet.getByLabel("Step type", { exact: true }).selectOption(kind);
    if (kind === "agent")
      await sheet
        .getByLabel("Registered agent", { exact: true })
        .selectOption(agent.id);
    if (kind === "gate") {
      await sheet
        .getByLabel("Policy reference", { exact: true })
        .selectOption("policy.kyc.customer-acceptance.v1");
      await sheet
        .getByLabel("Gate ID", { exact: true })
        .fill("customer_acceptance");
    }
    await sheet.getByLabel("Step ID", { exact: true }).fill(id);
    await sheet.getByLabel("Step name", { exact: true }).fill(name);
    await sheet
      .getByRole("button", { name: "Insert step", exact: true })
      .click();
    await expect(sheet).toBeHidden();
    const inserted = await load(page, draft.draftId);
    expect(inserted.revision).toBe(before.revision + 1);
    expect(inserted.parsedWorkflow.spec.edges).toContainEqual(
      expect.objectContaining({ from: previous, to: id }),
    );
    expect(inserted.parsedWorkflow.spec.edges).toContainEqual(
      expect.objectContaining({ from: id, to: "result" }),
    );
    if (kind === "agent") {
      expect(
        inserted.parsedWorkflow.spec.nodes.find((node: any) => node.id === id)
          .config,
      ).toMatchObject({
        agentRef: agent.id,
        agentVersion: "1.0.0",
        modelProfileId: agent.modelProfileId,
      });
      expect(inserted.parsedPackage.agentProfiles).toContainEqual(
        expect.objectContaining({
          id: agent.id,
          version: "1.0.0",
          prompt: agent.prompt,
        }),
      );
      expect(
        (
          await apiCall(page, "POST", "/v1/authoring/agents", {
            ...agent,
            version: "2.0.0",
            prompt: "Changed registry prompt",
          })
        ).status,
      ).toBe(201);
    }
    await page
      .getByRole("button", { name: `Edit step ${name}`, exact: true })
      .click();
    const form = page.getByRole("form", {
      name: `Edit step ${id}`,
      exact: true,
    });
    await expect
      .poll(async () => {
        const box = await form.boundingBox(),
          canvas = await page.getByTestId("workflow-canvas").boundingBox();
        return Boolean(
          box &&
            canvas &&
            box.x >= canvas.x &&
            box.y >= canvas.y &&
            box.x + box.width <= canvas.x + canvas.width + 1 &&
            box.y + box.height <= canvas.y + canvas.height + 1,
        );
      })
      .toBe(true);
    await expect(
      form.getByRole("button", { name: "Save step", exact: true }),
    ).toBeInViewport({ ratio: 1 });
    await form.getByLabel("Step name", { exact: true }).fill(name + " updated");
    await form
      .getByLabel("Step description", { exact: true })
      .fill("Inline configuration retained");
    if (kind === "gate")
      await form
        .getByLabel("Gate ID", { exact: true })
        .fill("acceptance_review");
    if (kind === "gate") {
      await expectAccessible(page);
      await page.screenshot({
        path: shots + "/authoring-inline-node-desktop.png",
        fullPage: true,
      });
    }
    await form.getByRole("button", { name: "Save step", exact: true }).click();
    await expect(form).toBeHidden();
    const updated = await load(page, draft.draftId);
    const node = updated.parsedWorkflow.spec.nodes.find(
      (node: any) => node.id === id,
    );
    expect(node.name).toBe(name + " updated");
    expect(node.config.ui.description).toBe("Inline configuration retained");
    if (kind === "agent") expect(node.config.agentVersion).toBe("1.0.0");
    if (kind === "gate")
      expect(node.config).toMatchObject({
        policyRef: "policy.kyc.customer-acceptance.v1",
        gateId: "acceptance_review",
      });
    previous = id;
  }
  const replacement = {
    ...agent,
    id: agent.id + ".replacement",
    name: "Replacement reviewer",
    version: "3.0.0",
  };
  expect(
    (await apiCall(page, "POST", "/v1/authoring/agents", replacement)).status,
  ).toBe(201);
  await page
    .getByRole("button", {
      name: "Edit step Evidence review updated",
      exact: true,
    })
    .click();
  const agentForm = page.getByRole("form", {
    name: "Edit step agent-review",
    exact: true,
  });
  await agentForm
    .getByLabel("Registered agent", { exact: true })
    .selectOption(replacement.id);
  await agentForm
    .getByRole("button", { name: "Save step", exact: true })
    .click();
  await expect(agentForm).toBeHidden();
  expect(
    (await load(page, draft.draftId)).parsedWorkflow.spec.nodes.find(
      (node: any) => node.id === "agent-review",
    ).config,
  ).toMatchObject({ agentRef: replacement.id, agentVersion: "3.0.0" });
  await page.reload();
  for (const name of [
    "Evidence review updated",
    "Human approval updated",
    "Acceptance gate updated",
  ])
    await expect(
      page
        .getByRole("navigation", { name: "Outline", exact: true })
        .getByRole("button", { name: new RegExp(name) }),
    ).toBeVisible();
  await expectAccessible(page);
  await page.screenshot({
    path: shots + "/authoring-node-types-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId("workflow-canvas")).toBeVisible();
  expect(
    (await page.getByTestId("workflow-canvas").boundingBox())!.height,
  ).toBeGreaterThan(250);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: shots + "/authoring-node-types-mobile.png",
    fullPage: true,
  });
});
