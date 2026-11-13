import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { defaultDeploymentProfile } from "@ehf/contracts/deployment";
import { SetupStore, type SetupState } from "./store.js";
import { buildLauncher } from "./app.js";
import { DEPLOYMENT_STEPS } from "./deployment-jobs.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
async function fixture(method: "oidc" | "bootstrap" = "oidc") {
  const directory = await mkdtemp(join(tmpdir(), "deployment-jobs-")); cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const catalog = { revision: "test", models: [{ id: "curated", name: "Curated", publisher: "Example", family: "frontier" as const, providers: { openrouter: "wire/model" } }] };
  const profile = defaultDeploymentProfile({ provider: "azure", scopeId: "/subscriptions/test/resourceGroups/test", region: "centralus", recipe: "azure-container-apps-bootstrap-v1" });
  profile.foundation.database = { host: "database.example.com", port: 5432, credentialRef: "env:DB_PASSWORD" }; profile.foundation.objectStore = { endpoint: "https://objects.example.com", bucket: "evidence", credentialRef: "env:OBJECT_STORE" }; profile.foundation.telemetryEndpoint = "https://telemetry.example.com"; profile.foundation.observability = { backend: "otlp" };
  profile.intelligence.models.low = "curated"; profile.intelligence.credentialRef = "env:MODEL_TOKEN";
  const initial: SetupState = { claimed: true, identityVerified: method === "oidc", sessions: [{ hash: sha("owner"), csrf: "csrf", subject: "owner", method, expires: Date.now() + 600000 }], document: { revision: 2, phase: "configured", updatedAt: new Date().toISOString(), profile, tests: [{ kind: "inference", catalogRevision: "test", revision: 2, status: "passed", checkedAt: new Date().toISOString(), message: "qualified" }] }, events: [] };
  const store = new SetupStore(directory, () => structuredClone(initial));
  const env = { ONBOARDING_PUBLIC_ORIGIN: "https://setup.example.com", ONBOARDING_BOOTSTRAP_SHA256: sha("bootstrap"), ONBOARDING_EXECUTOR_SHA256: sha("e".repeat(64)), IMAGE_REFERENCE: `registry/app@sha256:${"a".repeat(64)}`, DEPLOYMENT_PROVIDER: "azure", DEPLOYMENT_SCOPE: profile.target.scopeId, DEPLOYMENT_REGION: "centralus", DEPLOYMENT_RECIPE: profile.target.recipe };
  const app = buildLauncher({ store, env, catalog }); cleanups.push(() => app.close());
  const owner = { cookie: "integralflow_setup=owner", origin: env.ONBOARDING_PUBLIC_ORIGIN, "x-csrf-token": "csrf", "if-match": '"2"' };
  const executor = { authorization: `Bearer ${"e".repeat(64)}` };
  const status = () => app.inject({ url: "/api/onboarding/deployment", headers: owner });
  const queue = async (planHash?: string) => app.inject({ method: "POST", url: "/api/onboarding/deployment", headers: owner, payload: { environmentId: profile.environmentId, planHash: planHash ?? (await status()).json().planHash } });
  return { app, store, owner, executor, queue, status, initial };
}
describe("reviewed deployment authority", () => {
  it("requires a verified human administrator, CSRF, current review hash and a separate executor credential", async () => {
    const bootstrap = await fixture("bootstrap"); expect((await bootstrap.queue()).statusCode).toBe(403);
    const f = await fixture();
    expect((await f.app.inject({ url: "/api/onboarding/deployment" })).statusCode).toBe(401);
    expect((await f.queue("b".repeat(64))).statusCode).toBe(409);
    expect((await f.app.inject({ method: "POST", url: "/api/deployment/lease", headers: f.owner })).statusCode).toBe(401);
    expect((await f.queue()).statusCode).toBe(202);
    expect((await f.queue()).statusCode).toBe(409);
    expect((await f.app.inject({ method: "PUT", url: "/api/onboarding", headers: f.owner, payload: f.initial.document.profile })).statusCode).toBe(409);
  });
  it("leases a job once, rejects incomplete success, records verification and invalidates readiness on a new revision", async () => {
    const f = await fixture(); await f.queue();
    const lease = (await f.app.inject({ method: "POST", url: "/api/deployment/lease", headers: f.executor })).json();
    expect(lease.job.phase).toBe("running"); expect(lease.job).not.toHaveProperty("leaseHash");
    expect((await f.app.inject({ method: "POST", url: "/api/deployment/lease", headers: f.executor })).json().job).toBe(null);
    const report = { id: lease.job.id, leaseToken: lease.leaseToken, phase: "succeeded", steps: [], applicationUrl: "https://application.example.com" };
    expect((await f.app.inject({ method: "POST", url: "/api/deployment/report", headers: f.executor, payload: report })).statusCode).toBe(400);
    report.steps = DEPLOYMENT_STEPS.map(name => ({ name, status: "passed" })) as never;
    expect((await f.app.inject({ method: "POST", url: "/api/deployment/report", headers: f.executor, payload: report })).statusCode).toBe(200);
    expect((await f.status()).json().runtimeReady).toBe(true);
    expect((await f.app.inject({ url: "/api/onboarding/plan", headers: f.owner })).json().runtimeReady).toBe(true);
    await f.store.update(state => { state.document.revision++; });
    expect((await f.status()).json().runtimeReady).toBe(false);
  });
  it("never automatically replays a job whose executor disappeared", async () => {
    const f = await fixture(); await f.queue();
    const lease = (await f.app.inject({ method: "POST", url: "/api/deployment/lease", headers: f.executor })).json();
    const recover = () => f.app.inject({ method: "POST", url: "/api/onboarding/deployment/recover", headers: f.owner, payload: { acknowledgeExecutorStopped: true, jobId: lease.job.id } });
    expect((await recover()).statusCode).toBe(409);
    await f.store.update(state => { state.deployment!.leaseUntil = Date.now() - 1; });
    expect((await f.app.inject({ method: "POST", url: "/api/deployment/lease", headers: f.executor })).json().job).toBe(null);
    expect((await recover()).statusCode).toBe(200);
    expect((await f.status()).json().job.phase).toBe("failed");
  });
});
