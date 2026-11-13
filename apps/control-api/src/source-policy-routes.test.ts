import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { stableDigest } from "@ehf/contracts";
import type { PlatformAction, Principal } from "@ehf/identity";
import { createDatabase, type Database } from "@ehf/persistence";
import { registerSourcePolicyRoutes } from "./source-policy-routes.js";

const fixture = JSON.parse(readFileSync(new URL("../../../packages/contracts/test-fixtures/source-policy.json", import.meta.url), "utf8"));
const principal = { tenantId: "tenant_demo", subjectId: "author", actorType: "human", roles: [] } as unknown as Principal;

describe("source policy authoring routes", () => {
  it("validates/digests candidates and simulates without accessing provider or approval storage", async () => {
    const app = Fastify();
    const actions: PlatformAction[] = [];
    const db = { query: () => { throw new Error("candidate simulation must not access authority storage"); } } as unknown as Database;
    registerSourcePolicyRoutes(app, { db, authorize: async (_request, action) => { actions.push(action); return principal; } });
    try {
      const compiled = await app.inject({ method: "POST", url: "/v1/authoring/source-policies/compile", payload: { artifact: fixture.policy } });
      expect(compiled.statusCode).toBe(200);
      expect(compiled.json()).toMatchObject({ status: "candidate", digest: stableDigest(fixture.policy) });
      const input = { context: fixture.context, policies: [fixture.policy], binding: fixture.binding, access: fixture.access,
        capabilityId: fixture.binding.capabilityId, connectorId: fixture.binding.connectorId, connectorDigest: fixture.binding.connectorDigest,
        request: { stage: "acquire", recipientId: "tenant_demo", redistribute: false }, evaluatedAt: "2026-11-08T12:00:00Z" };
      const simulated = await app.inject({ method: "POST", url: "/v1/authoring/source-policies/simulate", payload: input });
      expect(simulated.json()).toMatchObject({ simulation: true, decision: { outcome: "ALLOW" } });
      expect(actions).toEqual(["draft.compile", "draft.evaluate"]);
      const foreign = await app.inject({ method: "POST", url: "/v1/authoring/source-policies/simulate", payload: { ...input, context: { ...fixture.context, tenantId: "foreign" } } });
      expect(foreign.statusCode).toBe(403);
      const malformed = await app.inject({ method: "POST", url: "/v1/authoring/source-policies/compile", payload: { artifact: { ...fixture.policy, rules: [] } } });
      expect(malformed.statusCode).toBe(400);
    } finally { await app.close(); }
  });
});

describe.skipIf(!process.env.EHF_TEST_DATABASE_URL)("source policy API approval and tenant boundaries", () => {
  it("requires a different approver and exposes only the current tenant's artifacts", async () => {
    const db = createDatabase(process.env.EHF_TEST_DATABASE_URL);
    const app = Fastify();
    const current = { ...principal, tenantId: `source-api-${randomUUID()}` };
    registerSourcePolicyRoutes(app, { db, authorize: async () => current });
    const digest = stableDigest(fixture.policy);
    try {
      const registered = await app.inject({ method: "POST", url: "/v1/source-policies/artifacts", payload: { artifact: fixture.policy, expectedDigest: digest } });
      expect(registered.statusCode, registered.body).toBe(201);
      const approve = () => app.inject({ method: "POST", url: `/v1/source-policies/artifacts/source-policy/${digest}/approve` });
      expect((await approve()).statusCode).toBe(403);
      current.subjectId = "independent-reviewer";
      expect((await approve()).statusCode).toBe(200);
      expect((await app.inject("/v1/source-policies/artifacts")).json().artifacts[0].status).toBe("approved");
      current.tenantId += "-other";
      expect((await app.inject("/v1/source-policies/artifacts")).json().artifacts).toEqual([]);
    } finally { await app.close(); await db.end(); }
  });
});
