import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { compilePackage } from "@ehf/compiler";
import { activateSandboxRelease, admitPlan, createDatabase, sandboxReleaseManifest } from "@ehf/persistence";
import { expect, it } from "vitest";
import { buildControlApi } from "./app.js";

const databaseUrl = process.env.EHF_TEST_DISCOVERY_CONTROL_DATABASE_URL ?? process.env.EHF_TEST_DATABASE_URL;

it.skipIf(!databaseUrl)("launches only the configured synthetic advisory plan and deduplicates a lost response", async () => {
  if (!databaseUrl) throw new Error("Control test database URL required");
  const db = createDatabase(databaseUrl);
  const tenantId = `tenant_${randomUUID()}`;
  const workerToken = "discovery-test-worker-token-00000001";
  const plan = compilePackage(fileURLToPath(new URL("../../../domains/discovery-advisory", import.meta.url)), {
    modelProfiles: fileURLToPath(new URL("../../../config/model-profiles.json", import.meta.url)),
  });
  const env = { DISCOVERY_SYNTHETIC_ENABLED: "true", DISCOVERY_HOSTED_PLAN_DIGEST: plan.planDigest };
  const app = buildControlApi({ db, env, contextStore: null,
    serviceGrants: [{ token: workerToken, subjectId: "discovery-worker", tenantId, roles: ["Discovery.Launch"] }] });
  app.log.level = "silent";
  try {
    const { plan: admitted } = await admitPlan(db, JSON.parse(plan.document), tenantId);
    await activateSandboxRelease(db, { tenantId, actor: "test-author", manifest: sandboxReleaseManifest(admitted, { tenantId, environment: "development" }), policies: [] }, env);
    const body = { planDigest: plan.planDigest, input: { tenantId, caseId: `recon_${"a".repeat(64)}`,
      seed: { companyName: "Asterion Advanced Materials Ltd.", country: "GB" } } };
    const headers = { authorization: `Bearer ${workerToken}` };
    const call = (payload: unknown) => app.inject({ url: "/v1/internal/discovery/runs", method: "POST", headers, payload: payload as object });
    expect((await app.inject({ url: "/v1/runs", method: "POST", headers, payload: body })).statusCode).toBe(403);
    expect((await call({ body: { ...body, planDigest: "b".repeat(64) }, attempt: 1 })).statusCode).toBe(403);
    expect((await call({ body: { ...body, input: { ...body.input, caseId: "primary-case" } }, attempt: 1 })).statusCode).toBe(403);
    const first = await call({ body, attempt: 1 });
    expect(first.statusCode, first.body).toBe(202);
    const replay = await call({ body, attempt: 1 });
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json()).toEqual(first.json());
    expect((await db.query("select 1 from harness_runtime.runs where tenant_id=$1", [tenantId])).rowCount).toBe(1);
  } finally {
    await app.close();
    await db.end();
  }
});
