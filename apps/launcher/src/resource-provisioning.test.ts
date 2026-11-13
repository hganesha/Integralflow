import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { buildLauncher } from "./app.js";
import { defaultResourceConfiguration, RESOURCE_KINDS } from "@ehf/contracts/resource-provisioning";
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const scope = "/subscriptions/11111111-1111-4111-8111-111111111111/resourceGroups/test";
const origin = "https://setup.example.com";
const token = "a".repeat(64); const executorToken = "b".repeat(64);
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const tenant = "22222222-2222-4222-8222-222222222222";
const image = `example.azurecr.io/app@sha256:${"c".repeat(64)}`;
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "resource-jobs-")); cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const env = { ONBOARDING_STATE_DIR: directory, ONBOARDING_PUBLIC_ORIGIN: origin, ONBOARDING_BOOTSTRAP_SHA256: sha(token), ONBOARDING_EXECUTOR_SHA256: sha(executorToken), DEPLOYMENT_PROVIDER: "azure", DEPLOYMENT_SCOPE: scope, DEPLOYMENT_REGION: "centralus", IMAGE_REFERENCE: image, AZURE_TENANT_ID: tenant };
  const app = buildLauncher({ env, catalog: { revision: "test", models: [{ id: "model", name: "Model", publisher: "Test", family: "frontier", providers: { azure_foundry: "gpt-4.1" } }] } }); cleanup.push(() => app.close());
  const claim = await app.inject({ method: "POST", url: "/api/onboarding/claim", headers: { origin }, payload: { token } });
  const headers = { origin, cookie: String(claim.headers["set-cookie"]).split(";")[0]!, "x-csrf-token": claim.json().csrfToken, "if-match": '"0"' };
  const executor = { authorization: `Bearer ${executorToken}` };
  const configuration = defaultResourceConfiguration(tenant, "33333333-3333-4333-8333-333333333333");
  return { app, env, headers, executor, configuration, directory };
}
describe("resource setup lifecycle", () => {
  it("requires the installer session, CSRF, pinned tenant/scope, and an exact reviewed revision", async () => {
    const f = await fixture();
    expect((await f.app.inject({ url: "/api/onboarding/resources" })).statusCode).toBe(401);
    expect((await f.app.inject({ method: "PUT", url: "/api/onboarding/resources", headers: { ...f.headers, origin: "https://other.example" }, payload: f.configuration })).statusCode).toBe(403);
    for (const configuration of [{ ...f.configuration, tenantId: "44444444-4444-4444-8444-444444444444" }, { ...f.configuration, resources: { ...f.configuration.resources, postgres: { mode: "existing", resourceId: "/subscriptions/other/resourceGroups/other/providers/postgres/server" } } }]) {
      expect((await f.app.inject({ method: "PUT", url: "/api/onboarding/resources", headers: f.headers, payload: configuration })).statusCode).toBe(400);
    }
    expect((await f.app.inject({ method: "PUT", url: "/api/onboarding/resources", headers: f.headers, payload: f.configuration })).statusCode).toBe(200);
    expect((await f.app.inject({ method: "PUT", url: "/api/onboarding/resources", headers: f.headers, payload: f.configuration })).statusCode).toBe(409);
    expect((await f.app.inject({ method: "POST", url: "/api/provisioning/lease", headers: f.executor, payload: { image, scopeId: "another-scope" } })).statusCode).toBe(409);
  });
  it("blocks irreversible retention and broad test network rules until explicitly reviewed", async () => {
    const f = await fixture();
    f.configuration.resources.evidence.mode = "create";
    await f.app.inject({ method: "PUT", url: "/api/onboarding/resources", headers: f.headers, payload: f.configuration });
    const view = (await f.app.inject({ url: "/api/onboarding/resources", headers: f.headers })).json();
    const response = await f.app.inject({ method: "POST", url: "/api/onboarding/resources", headers: { ...f.headers, "if-match": '"1"' }, payload: { environmentId: "integralflow", planHash: view.planHash } });
    expect(response.statusCode).toBe(400); expect(response.json().error).toBe("deployment.retention_lock_approval_required");
  });
  it("fences a lost executor only after an explicit stopped-executor acknowledgement", async () => {
    const f = await fixture();
    await f.app.inject({ method: "PUT", url: "/api/onboarding/resources", headers: f.headers, payload: f.configuration });
    const view = (await f.app.inject({ url: "/api/onboarding/resources", headers: f.headers })).json();
    await f.app.inject({ method: "POST", url: "/api/onboarding/resources", headers: { ...f.headers, "if-match": '\"1\"' }, payload: { environmentId: "integralflow", planHash: view.planHash } });
    const lease = (await f.app.inject({ method: "POST", url: "/api/provisioning/lease", headers: f.executor, payload: { image, scopeId: scope } })).json();
    const recovery = { jobId: lease.job.id, acknowledgeExecutorStopped: true };
    expect((await f.app.inject({ method: "POST", url: "/api/onboarding/resources/recover", headers: f.headers, payload: recovery })).statusCode).toBe(409);
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 121000);
    try {
      expect((await f.app.inject({ method: "POST", url: "/api/onboarding/resources/recover", headers: f.headers, payload: { jobId: lease.job.id } })).statusCode).toBe(400);
      expect((await f.app.inject({ method: "POST", url: "/api/onboarding/resources/recover", headers: f.headers, payload: recovery })).statusCode).toBe(200);
      expect((await f.app.inject({ method: "POST", url: "/api/provisioning/report", headers: f.executor, payload: { id: lease.job.id, leaseToken: lease.leaseToken, phase: "running" } })).statusCode).toBe(409);
    } finally { clock.mockRestore(); }
  });
  it("saves a Foundry draft before its endpoint exists, so creation has no credential prerequisite", async () => {
    const f = await fixture();
    const profile = (await f.app.inject({ url: "/api/onboarding", headers: f.headers })).json().profile;
    profile.intelligence = { ...profile.intelligence, provider: "azure_foundry", endpoint: "", credentialRef: "", models: { low: "model", med: "model", high: "model", xhigh: "model" } };
    expect((await f.app.inject({ method: "PUT", url: "/api/onboarding", headers: f.headers, payload: profile })).statusCode).toBe(200);
    f.configuration.resources.postgres.mode = "create";
    await f.app.inject({ method: "PUT", url: "/api/onboarding/resources", headers: { ...f.headers, "if-match": '\"1\"' }, payload: f.configuration });
    const view = (await f.app.inject({ url: "/api/onboarding/resources", headers: f.headers })).json();
    const result = await f.app.inject({ method: "POST", url: "/api/onboarding/resources", headers: { ...f.headers, "if-match": '\"2\"' }, payload: { environmentId: "integralflow", planHash: view.planHash } });
    expect(result.statusCode).toBe(400); expect(result.json().error).toBe("deployment.database_network_approval_required");
  });
  it("provisions before OIDC, persists across restart, binds only safe outputs, and rejects replay", async () => {
    const f = await fixture(); f.configuration.resources.postgres.mode = "create"; f.configuration.allowAzureDatabaseAccess = true;
    await f.app.inject({ method: "PUT", url: "/api/onboarding/resources", headers: f.headers, payload: f.configuration });
    const view = (await f.app.inject({ url: "/api/onboarding/resources", headers: f.headers })).json();
    expect((await f.app.inject({ method: "POST", url: "/api/onboarding/resources", headers: { ...f.headers, "if-match": '"1"' }, payload: { environmentId: "integralflow", planHash: view.planHash } })).statusCode).toBe(202);
    const lease = (await f.app.inject({ method: "POST", url: "/api/provisioning/lease", headers: f.executor, payload: { image, scopeId: scope } })).json();
    expect(lease.job.phase).toBe("running");
    expect((await f.app.inject({ method: "POST", url: "/api/provisioning/lease", headers: f.executor, payload: { image, scopeId: scope } })).json().job).toBeNull();
    const report = { id: lease.job.id, leaseToken: lease.leaseToken, phase: "running" };
    expect((await f.app.inject({ method: "POST", url: "/api/provisioning/report", headers: f.executor, payload: { ...report, resource: { kind: "postgres", status: "passed", message: "Resource verified", output: { password: "must-not-be-stored" } } } })).statusCode).toBe(400);
    expect((await f.app.inject({ method: "POST", url: "/api/provisioning/report", headers: f.executor, payload: { ...report, phase: "succeeded" } })).statusCode).toBe(400);
    const restarted = buildLauncher({ env: f.env, catalog: { revision: "test", models: [] } }); cleanup.push(() => restarted.close());
    for (const kind of RESOURCE_KINDS) expect((await restarted.inject({ method: "POST", url: "/api/provisioning/report", headers: f.executor, payload: { ...report, resource: { kind, status: "passed", message: "Resource verified", ...(kind === "postgres" ? { output: { hostname: "owned.postgres.database.azure.com", credentialRef: "env:DATABASE_MIGRATOR_PASSWORD", resourceId: `${scope}/providers/Microsoft.DBforPostgreSQL/flexibleServers/owned` } } : {}) } } })).statusCode).toBe(200);
    expect((await restarted.inject({ method: "POST", url: "/api/provisioning/report", headers: f.executor, payload: { ...report, phase: "succeeded" } })).statusCode).toBe(200);
    expect((await restarted.inject({ method: "POST", url: "/api/provisioning/report", headers: f.executor, payload: report })).statusCode).toBe(409);
    const saved = (await restarted.inject({ url: "/api/onboarding", headers: f.headers })).json();
    expect(saved.profile.foundation.database.host).toBe("owned.postgres.database.azure.com"); expect(saved.revision).toBe(2); expect(saved.identityVerified).toBe(false);
    const raw = await readFile(join(f.directory, "setup.json"), "utf8"); expect(raw).not.toContain(lease.leaseToken); expect(raw).not.toContain(executorToken); expect(raw).not.toContain("must-not-be-stored");
  });
});
