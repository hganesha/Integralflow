import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAuthorizer, type Principal } from "@ehf/identity";
import { stableDigest } from "@ehf/contracts";
import { getActionReceipt, getPlan, type Database } from "@ehf/persistence";
import { registerIntegrationRoutes } from "./integration-routes.js";

vi.mock("@ehf/persistence", async (original) => ({
  ...await original<typeof import("@ehf/persistence")>(),
  getActionReceipt: vi.fn(), getPlan: vi.fn(),
}));

describe("human action authorization", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

  it.each([
    ["claim", "human_work.claim"], ["approve", "human_work.decide"],
    ["reject", "human_work.decide"], ["return", "human_work.decide"],
    ["resolve", "human_work.resolve"],
  ])("requires %s authority even for a previously recorded action", async (operation, expectedPermission) => {
    const app = Fastify();
    const principal: Principal = { subjectId: "reader", tenantId: "tenant_demo", actorType: "human", roles: ["Harness.Reader"], source: "local" };
    const guard = createAuthorizer();
    const authorize = vi.fn(async (_request, permission, resource) => {
      guard.require(principal, permission, resource);
      return principal;
    });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ case: { caseSequence: 1, harnessPlanDigest: "a".repeat(64) } })));
    vi.mocked(getActionReceipt).mockResolvedValue({ requestDigest: stableDigest({ expectedCaseSequence: 1, input: {} }), response: { privateResult: true } } as Awaited<ReturnType<typeof getActionReceipt>>);
    registerIntegrationRoutes(app, { db: {} as Database, env: { CONTROL_API_SERVICE_TOKEN: "test" }, authorize, authorizeIngress: authorize });
    try {
      const response = await app.inject({ method: "POST", url: `/v1/integrations/human/cases/case_1/actions/work:work_1:${operation}:execute`, payload: { requestId: "request_1", expectedCaseSequence: 1, input: {} } });
      expect(response.statusCode).toBe(401);
      expect(authorize.mock.calls.map((call) => call[1])).toEqual(["case.read", expectedPermission]);
      expect(getActionReceipt).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });

  it("keeps an authorized replay available after the case sequence changes", async () => {
    const app = Fastify();
    const principal: Principal = { subjectId: "reviewer", tenantId: "tenant_demo", actorType: "human", roles: ["Case.Reviewer"], source: "local" };
    const guard = createAuthorizer();
    const authorize = vi.fn(async (_request, permission, resource) => { guard.require(principal, permission, resource); return principal; });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ case: { caseSequence: 2 } })));
    vi.mocked(getActionReceipt).mockResolvedValue({ requestDigest: stableDigest({ expectedCaseSequence: 1, input: {} }), response: { outcome: "ACCEPTED" } } as Awaited<ReturnType<typeof getActionReceipt>>);
    registerIntegrationRoutes(app, { db: {} as Database, env: { CONTROL_API_SERVICE_TOKEN: "test" }, authorize, authorizeIngress: authorize });
    try {
      const response = await app.inject({ method: "POST", url: "/v1/integrations/human/cases/case_1/actions/work:work_1:claim:execute", payload: { requestId: "request_1", expectedCaseSequence: 1, input: {} } });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ outcome: "ACCEPTED", replayed: true });
      expect(getPlan).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
});
