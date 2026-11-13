import { beforeEach, expect, it, vi } from "vitest";
import { mintExecutionEnvelope } from "@ehf/execution-auth";
import {
  assertActiveCaseExecution,
  getCaseSequence,
  type CaseStore,
} from "@ehf/case-store";
import { buildCaseApi } from "./app.js";
vi.mock("@ehf/case-store", async (actual) => ({
  ...(await actual<object>()),
  assertActiveCaseExecution: vi.fn(),
  getCaseSequence: vi.fn(),
}));
const secret = "test-context-pull-execution-secret-000001",
  token = "test-runtime-service-credential-000001";
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getCaseSequence).mockResolvedValue(7);
  vi.mocked(assertActiveCaseExecution).mockResolvedValue();
});
async function envelope(writes: boolean) {
  return mintExecutionEnvelope({
    secret,
    tenantId: "tenant",
    caseId: "case",
    runId: "run",
    nodeId: "fetch",
    invocationId: "inv",
    planDigest: "a".repeat(64),
    permissionDigest: "b".repeat(64),
    attempt: 1,
    fencingEpoch: 1,
    capabilities: ["context.records.fetch.v1"],
    effects: ["read"],
    caseWrites: writes ? ["RecordCanonicalRecords"] : [],
  });
}
it("releases only the case sequence to an active signed node with declared case writes", async () => {
  const app = buildCaseApi({
    store: {
      db: {},
      ownsDatabase: false,
      evidenceMaxBytes: 1024,
    } as unknown as CaseStore,
    env: {},
    executionSecret: secret,
    serviceGrants: [
      {
        token,
        subjectId: "runtime",
        tenantId: "tenant",
        roles: ["Case.Api.Access"],
      },
    ],
  });
  app.log.level = "silent";
  try {
    const request = (signed?: string) =>
      app.inject({
        method: "GET",
        url: "/v2/cases/case/sequence",
        headers: {
          authorization: `Bearer ${token}`,
          ...(signed ? { "x-execution-envelope": signed } : {}),
        },
      });
    expect((await request()).statusCode).toBe(401);
    expect((await request(await envelope(false))).statusCode).toBe(403);
    expect(getCaseSequence).not.toHaveBeenCalled();
    const response = await request(await envelope(true));
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({ caseSequence: 7 });
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(assertActiveCaseExecution).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ case_id: "case", node_id: "fetch" }),
      "tenant",
      "case",
    );
    vi.mocked(assertActiveCaseExecution).mockRejectedValueOnce(
      new Error("inactive execution"),
    );
    expect((await request(await envelope(true))).statusCode).not.toBe(200);
    expect(getCaseSequence).toHaveBeenCalledTimes(1);
  } finally {
    await app.close();
  }
});
