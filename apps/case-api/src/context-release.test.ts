import { expect, it } from "vitest";
import type { CaseStore } from "@ehf/case-store";
import { buildCaseApi } from "./app.js";

// The context release job's case-api surface (data-stores-plan.md §3.3): its role reaches the
// release endpoints and nothing that writes case data, and people do not reach the release
// endpoints at all.

const EDGE_TOKEN = "edge-service-token-for-tests-0001";
const RELEASE_TOKEN = "context-release-token-for-tests-01";

function api() {
  return buildCaseApi({
    store: {
      db: { query: async () => ({ rowCount: 0, rows: [] }), connect: async () => ({ query: async () => ({ rowCount: 0, rows: [] }), release: () => {} }) },
      ownsDatabase: false, schemas: { core: "case_core", ledger: "case_ledger", evidence: "evidence" },
      artifactBackend: "postgres", evidenceRequireScan: false, evidenceMaxBytes: 1024,
    } as unknown as CaseStore,
    env: {},
    serviceGrants: [
      { token: EDGE_TOKEN, subjectId: "control-surface-edge", roles: ["Edge.Delegate"], tenantId: "tenant_demo" },
      { token: RELEASE_TOKEN, subjectId: "context-release", roles: ["Context.Release"], tenantId: "tenant_demo" },
    ],
  });
}

const job = { authorization: `Bearer ${RELEASE_TOKEN}` };
const analyst = { authorization: `Bearer ${EDGE_TOKEN}`, "x-actor-id": "analyst@example.test", "x-actor-roles": "Case.Analyst", "x-tenant-id": "tenant_demo" };

it("lets the release job list closed cases and read release eligibility", async () => {
  const app = api();
  app.log.level = "silent";
  try {
    expect((await app.inject({ url: "/v1/context-release/cases", headers: job })).json()).toEqual({ caseIds: [], nextCursor: null });
    expect((await app.inject({ url: "/v1/cases/case_1/context-release", headers: job })).statusCode).toBe(404);
  } finally { await app.close(); }
});

it("gives the release job no way to write case data", async () => {
  const app = api();
  app.log.level = "silent";
  try {
    const command = await app.inject({ method: "POST", url: "/v1/cases/case_1/commands", headers: job, payload: {} });
    expect([400, 403]).toContain(command.statusCode);
    const evidence = await app.inject({ method: "POST", url: "/v1/evidence:register", headers: job, payload: {} });
    expect(evidence.statusCode).toBe(403);
    expect(evidence.json().error).toBe("authorization.role_missing");
    const create = await app.inject({ method: "POST", url: "/v1/cases", headers: job, payload: {} });
    expect(create.statusCode).toBe(403);
  } finally { await app.close(); }
});

it("keeps people off the release endpoints", async () => {
  const app = api();
  app.log.level = "silent";
  try {
    for (const request of [
      { method: "GET" as const, url: "/v1/context-release/cases" },
      { method: "GET" as const, url: "/v1/cases/case_1/context-release" },
      { method: "POST" as const, url: "/v1/cases/case_1/context-release", payload: { closedSequence: 3, releasedAt: new Date().toISOString(), counts: {}, promotedEvidenceIds: [] } },
    ]) {
      const response = await app.inject({ ...request, headers: analyst });
      expect(response.statusCode, request.url).toBe(403);
      expect(response.json().error).toBe("authorization.role_missing");
    }
  } finally { await app.close(); }
});
