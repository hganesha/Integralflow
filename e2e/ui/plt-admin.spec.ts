import { expect, test } from "@playwright/test";
import { expectAccessible, mock, signInAs } from "./support";

// PLT-14 Administration, PLT-15 Integrations (BUILD-SPEC v2 §10).

test.describe("PLT-14 Administration", () => {
  test("AC1: an auditor reads every tab and every write control is disabled with Requires Platform.Admin", async ({ page }) => {
    await signInAs(page, "auditor", "/platform/admin");
    await expect(page.getByRole("heading", { name: "Administration", level: 1 })).toBeVisible();
    const tabs = page.getByRole("tablist", { name: "Administration sections" });

    const analysis = page.getByRole("region", { name: "analysis" });
    await expect(analysis.getByRole("button", { name: "Save as new revision" })).toBeDisabled();
    await expect(analysis.getByText("Requires Platform.Admin").first()).toBeVisible();
    await expect(analysis.getByRole("button", { name: /Make revision 1 of analysis active/ })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Create profile" })).toBeDisabled();
    await expectAccessible(page);

    await tabs.getByRole("tab", { name: /Providers/ }).click();
    const openrouter = page.getByRole("region", { name: "openrouter" });
    await expect(openrouter.getByRole("button", { name: "Save binding" })).toBeDisabled();
    await expect(openrouter.getByText("Requires Platform.Admin")).toBeVisible();
    await expect(openrouter.getByLabel("Credential variable name")).toHaveValue("OPENROUTER_API_KEY");

    await tabs.getByRole("tab", { name: /Capabilities/ }).click();
    await expect(page.getByRole("button", { name: "Register contract" })).toBeDisabled();
    await expect(page.getByText("Requires Platform.Admin").first()).toBeVisible();

    await tabs.getByRole("tab", { name: /Platform settings/ }).click();
    await expect(page.getByRole("button", { name: "Save dispatcher" })).toBeDisabled();
    await expect(page.getByRole("region", { name: "dispatcher" }).getByText("Requires Platform.Admin")).toBeVisible();

    await tabs.getByRole("tab", { name: /Change history/ }).click();
    await expect(page.getByRole("list", { name: "Change history" })).toBeVisible();
    await expectAccessible(page);
  });

  test("AC2: change history shows before/after digests and reason, with a JSON diff on expand", async ({ page }) => {
    await signInAs(page, "platform_admin", "/platform/admin");
    const analysis = page.getByRole("region", { name: "analysis" });
    await analysis.getByLabel("Max output tokens").fill("4800");
    await analysis.getByLabel(/Reason/).fill("tune output budget");
    await analysis.getByRole("button", { name: "Save as new revision" }).click();
    await expect(analysis.getByText("Saved analysis.")).toBeVisible();
    await expect(page.getByRole("list", { name: "analysis revisions" }).getByText("r3")).toBeVisible();

    await page.getByRole("tab", { name: /Change history/ }).click();
    const entry = page.getByRole("list", { name: "Change history" }).getByRole("listitem").first();
    await expect(entry.getByText(/tune output budget/)).toBeVisible();
    await expect(entry.getByLabel("before digest")).toHaveText(/^[0-9a-f]{12}…$/);
    await expect(entry.getByLabel("after digest")).toHaveText(/^[0-9a-f]{12}…$/);
    await entry.getByText(/tune output budget/).click();
    const diff = entry.getByRole("table");
    await expect(diff.getByRole("row", { name: /maxOutputTokens/ })).toContainText("4000");
    await expect(diff.getByRole("row", { name: /maxOutputTokens/ })).toContainText("4800");
    await expectAccessible(page);
  });

  test("delta 1: a tab's unsaved draft survives switching tabs", async ({ page }) => {
    await signInAs(page, "platform_admin", "/platform/admin");
    const tokens = page.getByRole("region", { name: "triage" }).getByLabel("Max output tokens");
    await tokens.fill("1500");
    await page.getByRole("tab", { name: /Providers/ }).click();
    await expect(page.getByRole("region", { name: "openrouter" })).toBeVisible();
    await expect(page.getByRole("tab", { name: /Model profiles/ })).toContainText("•");
    await page.getByRole("tab", { name: /Model profiles/ }).click();
    await expect(page.getByRole("region", { name: "triage" }).getByLabel("Max output tokens")).toHaveValue("1500");
  });

  test("delta 5: a credential reference accepts a variable name, never a secret", async ({ page }) => {
    await signInAs(page, "platform_admin", "/platform/admin?tab=providers");
    const openrouter = page.getByRole("region", { name: "openrouter" });
    const ref = openrouter.getByLabel("Credential variable name");
    await ref.fill("sk-or-v1-0123456789");
    await expect(openrouter.getByText(/Use the name of an environment variable/)).toBeVisible();
    await expect(openrouter.getByRole("button", { name: "Save binding" })).toBeDisabled();
    await ref.fill("OPENROUTER_EU_KEY");
    await openrouter.getByRole("button", { name: "Save binding" }).click();
    await expect(openrouter.getByText("Saved provider openrouter.")).toBeVisible();
    await expect(openrouter.getByText("Credential variable OPENROUTER_EU_KEY", { exact: false })).toBeVisible();
  });

  test("delta 3: an upstream 409 is shown as a conflict, not a generic failure", async ({ page }) => {
    await signInAs(page, "platform_admin", "/platform/admin?tab=settings");
    const dispatcher = page.getByRole("region", { name: "dispatcher" });
    await dispatcher.getByLabel(/Worker concurrency/).fill("3");
    // Sticky so a background poll cannot consume the injected failure before the save.
    await mock(page, "PUT", "/mock/faults", { failNext: { status: 409, error: "admin.immutable_infrastructure_requires_deployment" }, sticky: ["failNext"] });
    await dispatcher.getByRole("button", { name: "Save dispatcher" }).click();
    await expect(dispatcher.getByText(/Conflict · HTTP 409/)).toBeVisible();
    await mock(page, "PUT", "/mock/faults", { failNext: null, sticky: [] });
    // The draft is kept so the user can retry.
    await expect(dispatcher.getByLabel(/Worker concurrency/)).toHaveValue("3");
  });

  test("observability verifies platform ingestion and shows Foundry qualification separately", async ({ page }) => {
    const reason = "Verify the reviewed Azure deployment";
    const component = "/subscriptions/11111111-1111-4111-8111-111111111111/resourceGroups/pilot/providers/Microsoft.Insights/components/platform";
    await page.addInitScript(({ component }) => {
      const browserFetch = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        const path = new URL(input instanceof Request ? input.url : input.toString(), window.location.href).pathname;
        if (!/^\/api\/v1\/admin\/observability(?:\/verify)?$/.test(path)) return browserFetch(input, init);
        const request = new Request(input, init);
        if (path.endsWith("/verify") && request.method === "POST") {
          sessionStorage.setItem("observabilityVerification", await request.text());
        }
        const verificationStarted = sessionStorage.getItem("observabilityVerification") !== null;
        return Response.json({
          backend: "azure_monitor", revision: "7", collectorEndpoint: "https://collector.example.com/v1/traces",
          applicationInsightsResourceId: component, editUrl: "/onboarding?step=1", lookupDays: 30, samplerRatio: 0.5,
          foundry: { projectEndpoint: "https://foundry.services.ai.azure.com/api/projects/pilot", agentName: "probe", agentVersion: "1", applicationInsightsResourceId: `${component}-foundry` },
          checks: [
            { id: "ingestion", label: "Platform span ingestion", state: verificationStarted ? "passed" : "unverified", detail: verificationStarted ? "Application Insights returned the synthetic Collector span." : "Waiting for verification.", checkedAt: null },
            { id: "foundry", label: "Foundry native trace qualification", state: "blocked", detail: "A current deployment qualification is required.", checkedAt: null },
          ],
        });
      };
    }, { component });
    await signInAs(page, "platform_admin", "/platform/admin?tab=settings");
    const settings = page.getByRole("region", { name: "Observability", exact: true });
    await expect(settings.getByText("Application Insights + Log Analytics")).toBeVisible();
    await expect(settings.getByText("probe · version 1")).toBeVisible();
    await expect(settings.getByText("Blocked", { exact: true })).toBeVisible();
    await expect(settings.getByRole("link", { name: "Edit deployment" })).toHaveAttribute("href", "/onboarding?step=1");
    const verify = settings.getByRole("button", { name: "Verify connection" });
    await expect(verify).toBeDisabled();
    await settings.getByLabel("Reason for verification").fill(reason);
    await verify.click();
    await expect(settings.getByText("Application Insights returned the synthetic Collector span.")).toBeVisible();
    expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem("observabilityVerification") ?? "null"))).toEqual({ reason });
    await expect(settings.getByText("Blocked", { exact: true })).toBeVisible();
  });

  test("delta 4: the capabilities tab round-trips a model-kind contract", async ({ page }) => {
    await signInAs(page, "platform_admin", "/platform/admin?tab=capabilities");
    await page.getByLabel("Capability ID").fill("model.analysis.contract.v1");
    await page.getByLabel("Description").fill("Analysis tier model contract");
    await page.getByLabel("Kind").selectOption("model");
    await page.getByLabel("Adapter").selectOption("openrouter");
    const posted = page.waitForRequest((request) => request.url().endsWith("/v1/gateway/registry") && request.method() === "POST");
    await page.getByRole("button", { name: "Register contract" }).click();
    expect((await posted).postDataJSON()).toMatchObject({ id: "model.analysis.contract.v1", kind: "model", effect: "none", adapterBindingId: "openrouter:analysis" });
    const list = page.getByRole("list", { name: "Registered capabilities" });
    await expect(list.getByText("model.analysis.contract.v1")).toBeVisible();

    await list.getByRole("button", { name: "Edit model.analysis.contract.v1" }).click();
    await expect(page.getByLabel("Kind")).toHaveValue("model");
    await expect(page.getByLabel("Capability ID")).toHaveAttribute("readonly", "");
    const updated = page.waitForRequest((request) => request.url().endsWith("/v1/gateway/registry") && request.method() === "POST");
    await page.getByRole("button", { name: "Update contract" }).click();
    expect((await updated).postDataJSON()).toMatchObject({ kind: "model" });
  });
});

test.describe("PLT-15 Integrations", () => {
  test("AC1: binding actions appear per caller action; replay requires integration.replay", async ({ page }) => {
    await signInAs(page, "ops_manager", "/platform/integrations?tab=bindings");
    await expect(page.getByRole("button", { name: "Test crm-intake-kyb" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Activate crm-intake-kyb" })).toHaveCount(0);
    await page.getByRole("button", { name: "Pause crm-intake-kyb" }).click();
    await expect(page.getByText("Binding paused.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Activate crm-intake-kyb" })).toBeVisible();
    await page.getByRole("tab", { name: "Deliveries" }).click();
    await expect(page.getByRole("button", { name: "Replay dlv_0001" })).toBeEnabled();
    await page.getByRole("button", { name: "Replay dlv_0001" }).click();
    await expect(page.getByText("Replay queued.")).toBeVisible();
    await expectAccessible(page);

    await signInAs(page, "platform_admin", "/platform/integrations?tab=bindings");
    await expect(page.getByText("No binding actions for your role")).toBeVisible();
    await expect(page.getByRole("button", { name: "Test crm-intake-kyb" })).toHaveCount(0);
    await page.getByRole("tab", { name: "Deliveries" }).click();
    await expect(page.getByRole("button", { name: "Replay dlv_0001" })).toBeDisabled();
    await expect(page.getByText("Requires integration.replay")).toBeVisible();
  });

  test("AC2: connector credentials are secret_ref only", async ({ page }) => {
    await signInAs(page, "platform_admin", "/platform/integrations");
    await expect(page.getByRole("table", { name: "Connectors" }).getByText("INTAKE_HMAC")).toBeVisible();
    await page.getByLabel("Connector ID").fill("erp-outbound");
    await page.getByLabel("Name", { exact: true }).fill("ERP outbound webhook");
    const ref = page.getByLabel("Credential reference (secret_ref)");
    await ref.fill("whsec_live_abcdef");
    await expect(page.getByText(/Use the name of an environment variable/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Register connector" })).toBeDisabled();
    await ref.fill("ERP_WEBHOOK_SECRET");
    await page.getByRole("button", { name: "Register connector" }).click();
    await expect(page.getByText("Connector registered.")).toBeVisible();
    await expect(page.getByRole("table", { name: "Connectors" }).getByText("ERP_WEBHOOK_SECRET")).toBeVisible();
    await expectAccessible(page);
  });

  test("outbound connectors may use OAuth 2.0 client credentials from any token endpoint; inbound stays HMAC", async ({ page }) => {
    await signInAs(page, "platform_admin", "/platform/integrations");
    const authentication = page.getByLabel("Authentication");
    await expect(authentication.locator("option[value=oauth2_client_credentials]")).toBeDisabled();
    await page.getByLabel("Connector ID").fill("partner-deliveries");
    await page.getByLabel("Name", { exact: true }).fill("Partner deliveries");
    await page.getByLabel("Channel").selectOption("outbound_webhook");
    await page.getByLabel("Endpoint").fill("https://partner.example/hooks/ehf");
    await authentication.selectOption("oauth2_client_credentials");
    await page.getByLabel("Client secret reference (secret_ref)").fill("PARTNER_CLIENT_SECRET");
    await expect(page.getByRole("button", { name: "Register connector" })).toBeDisabled();
    await page.getByLabel("Token URL").fill("https://idp.example/oauth2/token");
    await page.getByLabel("Client ID").fill("ehf-delivery");
    await page.getByLabel("Audience (token scope)").fill("partner.deliveries");
    const posted = page.waitForRequest((request) => request.url().endsWith("/v1/integrations/connectors") && request.method() === "POST");
    await page.getByRole("button", { name: "Register connector" }).click();
    expect((await posted).postDataJSON()).toMatchObject({
      channel: "outbound_webhook",
      authentication: { kind: "oauth2_client_credentials", tokenUrl: "https://idp.example/oauth2/token", clientId: "ehf-delivery", audience: "partner.deliveries", credentialRef: "PARTNER_CLIENT_SECRET" },
    });
    await expect(page.getByText("Connector registered.")).toBeVisible();
    await expectAccessible(page);
  });
});
