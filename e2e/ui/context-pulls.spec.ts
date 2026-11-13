import { expect, test } from "@playwright/test";
import { signInAs, expectAccessible } from "./support";

test("bank source setup exposes explicit API drafts and retains the ontology mapping workbench", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await signInAs(
    page,
    "context_architect",
    "/context/connections?product=party360",
  );
  // The catalog opens the existing record setup, preserving product scope. Read-only
  // authors can inspect setup; source mutations retain their existing permission checks.
  await expect(page).toHaveURL(/\/platform\/data-sources\?.*product=party360/);
  await expect(
    page.getByRole("heading", { name: "Data sources", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Explore Salesforce / FSC", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Salesforce / FSC", exact: true })
    .getByRole("button", {
      name: /^(Configure|View setup for) Salesforce \/ FSC$/,
    })
    .click();
  const setup = page.getByRole("region", { name: "Bank API source setup" });
  await expect(setup).toBeVisible();
  await setup
    .getByText("Connection and resource configuration", { exact: true })
    .click();
  const draft = setup.getByLabel("API connection and resource draft", {
    exact: true,
  });
  await expect(draft).toHaveValue(/context-salesforce/);
  await setup
    .getByLabel("Bank source template", { exact: true })
    .selectOption("fenergo");
  await expect(draft).toHaveValue(/entitydataquery/);
  await expect(draft).not.toHaveValue(/clientSecret/);
  // Resource mapping remains reachable from setup; creation stays in Connections.
  await expect(
    page.getByRole("heading", { name: "Scope source resource", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByLabel("Mapping template", { exact: true }),
  ).toHaveValue("customer");
  await expect(
    page.getByRole("button", {
      name: "Create Entity / Party mapping",
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("tablist", { name: "Data source sections" })
    .getByRole("tab", { name: "Mappings", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Choose a mapping", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", {
      name: "Fields and their sources",
      exact: true,
    }),
  ).toBeVisible();
  await expectAccessible(page);
  expect(errors).toEqual([]);
});

test("opening a case reads source binding metadata without starting a pull", async ({
  page,
}) => {
  const posts: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && /\/context\/cases\/[^/]+\/pulls/.test(r.url()))
      posts.push(r.url());
  });
  await signInAs(page, "ops_manager", "/platform/cases/KYB-1042");
  const context = page.getByRole("region", { name: "Case source context" });
  await expect(context).toBeVisible();
  await expect(
    context.getByText("No approved source bindings for this case.", {
      exact: true,
    }),
  ).toBeVisible();
  await context
    .getByRole("button", { name: "Refresh pull status", exact: true })
    .click();
  expect(posts).toEqual([]);
  await expectAccessible(page);
});

test("case context retries only on an explicit action and reports success only after commit", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const original = window.fetch.bind(window);
    let started = false;
    const state = { bodies: [] as unknown[], committed: false };
    (window as unknown as { contextPullTest: typeof state }).contextPullTest =
      state;
    window.fetch = async (input, init) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      const path = new URL(url, location.href).pathname;
      const endpoint = "/api/v1/context/cases/KYB-1042";
      if (path === `${endpoint}/bindings`)
        return Response.json({
          items: [
            {
              digest: "a".repeat(64),
              revision: 1,
              definition: {
                id: "crm",
                caseId: "KYB-1042",
                mappingId: "crm-identity",
                enabled: true,
                subjects: ["entity:one"],
              },
            },
          ],
        });
      if (path === `${endpoint}/pulls`) {
        if (
          (input instanceof Request ? input.method : init?.method) === "POST"
        ) {
          const body =
            input instanceof Request
              ? await input.clone().text()
              : String(init?.body);
          state.bodies.push(JSON.parse(body));
          started = true;
          return Response.json({
            runId: "pull-run",
            status: "queued",
            created: true,
            committed: false,
          });
        }
        return Response.json({
          items: [
            {
              runId: "pull-run",
              bindingId: "crm",
              subjects: ["entity:one"],
              status: state.committed
                ? "completed"
                : started
                  ? "running"
                  : "failed",
              committed: state.committed,
              errorCode: started ? null : "context.source_unavailable",
              createdAt: "2026-11-09T12:00:00Z",
              completedAt: state.committed ? "2026-11-09T12:01:00Z" : null,
            },
          ],
        });
      }
      return original(input, init);
    };
  });
  await signInAs(page, "ops_manager", "/platform/cases/KYB-1042");
  const context = page.getByRole("region", { name: "Case source context" });
  const retry = context.getByRole("button", {
    name: "Retry context pull",
    exact: true,
  });
  await expect(retry).toBeEnabled();
  await retry.click();
  await expect(
    context.getByText(
      "Pull queued. Context becomes available after validation and case commit.",
    ),
  ).toBeVisible();
  await expect(
    context.getByRole("button", { name: "Pull context", exact: true }),
  ).toBeDisabled();
  await expect(context.getByText(/Committed to case/)).toHaveCount(0);
  const bodies = await page.evaluate(
    () =>
      (
        window as unknown as {
          contextPullTest: { bodies: unknown[]; committed: boolean };
        }
      ).contextPullTest.bodies,
  );
  expect(bodies).toEqual([
    expect.objectContaining({
      bindingId: "crm",
      expectedBindingDigest: "a".repeat(64),
      subjects: ["entity:one"],
    }),
  ]);
  expect(bodies[0]).not.toHaveProperty("sourceKey");
  await page.evaluate(() => {
    (
      window as unknown as { contextPullTest: { committed: boolean } }
    ).contextPullTest.committed = true;
  });
  await context
    .getByRole("button", { name: "Refresh pull status", exact: true })
    .click();
  await expect(context.getByText(/Committed to case/)).toBeVisible();
  await expectAccessible(page);
});
