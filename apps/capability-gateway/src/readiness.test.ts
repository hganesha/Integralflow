import { expect, it } from "vitest";
import type { Database } from "@ehf/persistence";
import { buildGateway } from "./app.js";
it("degrades readiness when model execution is not configured and reports failed storage as unavailable", async () => {
  const app = buildGateway({
    db: {
      query: async () => ({ rows: [], rowCount: 0 }),
    } as unknown as Database,
    executionSecret: "local-test-execution-secret",
    serviceGrants: [
      {
        token: "readiness-test-token-0000000001",
        subjectId: "edge",
        tenantId: "tenant_demo",
        roles: ["Edge.Delegate"],
      },
    ],
    env: {},
  });
  app.log.level = "silent";
  const response = await app.inject("/health/ready");
  expect(response.statusCode).toBe(200);
  expect(response.json().status).toBe("degraded");
  expect(response.json().checks).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ status: "NotConfigured" }),
    ]),
  );
  await app.close();
  const broken = buildGateway({
    db: {
      query: async () => {
        throw new Error("private storage endpoint");
      },
    } as unknown as Database,
    executionSecret: "local-test-execution-secret",
    serviceGrants: [
      {
        token: "readiness-test-token-0000000001",
        subjectId: "edge",
        tenantId: "tenant_demo",
        roles: ["Edge.Delegate"],
      },
    ],
    env: {},
  });
  broken.log.level = "silent";
  const down = await broken.inject("/health/ready");
  expect(down.statusCode).toBe(503);
  expect(down.json()).toEqual({ status: "unavailable" });
  await broken.close();
});
