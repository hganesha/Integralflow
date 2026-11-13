import { expect, it } from "vitest";
import type { CaseStore } from "@ehf/case-store";
import { buildCaseApi } from "./app.js";

// Legal hold endpoints (data-stores-plan.md §3.6): only a person with Legal.HoldOfficer
// reaches them; case analysts, administrators and workloads do not. Store behaviour (two
// officers, targets, storage) is covered in packages/case-store/src/governance.test.ts.

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

const person = (roles: string) => ({ authorization: `Bearer ${EDGE_TOKEN}`, "x-actor-id": "someone@example.test", "x-actor-roles": roles, "x-tenant-id": "tenant_demo" });
const placeBody = { matterRef: "M-1", caseIds: ["case_1"], authority: { basis: "notice" } };
const requests = [
  { method: "GET" as const, url: "/v1/legal-holds" },
  { method: "GET" as const, url: "/v1/legal-holds/hold_1" },
  { method: "POST" as const, url: "/v1/legal-holds", payload: placeBody },
  { method: "POST" as const, url: "/v1/legal-holds/hold_1/release", payload: { authority: { basis: "closed" } } },
];

it("keeps everyone but a hold officer off the legal hold endpoints", async () => {
  const app = api();
  app.log.level = "silent";
  try {
    for (const headers of [person("Case.Analyst"), person("Platform.Admin,Case.Reviewer"), { authorization: `Bearer ${RELEASE_TOKEN}` }]) {
      for (const request of requests) {
        const response = await app.inject({ ...request, headers });
        expect(response.statusCode, `${request.method} ${request.url}`).toBe(403);
        expect(response.json().error).toBe("authorization.role_missing");
      }
    }
  } finally { await app.close(); }
});

it("lets a hold officer through to validation", async () => {
  const app = api();
  app.log.level = "silent";
  try {
    const officer = person("Legal.HoldOfficer");
    const bad = await app.inject({ method: "POST", url: "/v1/legal-holds", headers: officer, payload: { caseIds: [] } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe("legal_hold.request_invalid");
    const noKey = await app.inject({ method: "POST", url: "/v1/legal-holds", headers: officer, payload: placeBody });
    expect(noKey.json().error).toBe("legal_hold.idempotency_key_required");
    expect((await app.inject({ method: "GET", url: "/v1/legal-holds", headers: officer })).json()).toEqual({ holds: [] });
  } finally { await app.close(); }
});
