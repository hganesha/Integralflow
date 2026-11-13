import { expect, it } from "vitest";
import { runtimeReadiness } from "./readiness.js";
const options = {
  checkpointBackend: "postgres",
  checkpoints: async () => {},
  journal: async () => {},
  gatewayUrl: "http://gateway.test",
  caseApiUrl: "http://case.test",
  fetch: (async () => Response.json({ status: "ready" })) as typeof fetch,
};
it("reads checkpoints and authenticated journal and probes both services", async () => {
  const called: string[] = [];
  const result = await runtimeReadiness({
    ...options,
    checkpoints: async () => {
      called.push("checkpoints");
    },
    journal: async () => {
      called.push("journal");
    },
    fetch: (async (url) => {
      called.push(String(url));
      return Response.json({ status: "ready" });
    }) as typeof fetch,
  })();
  expect(result.status).toBe("ready");
  expect(called).toEqual(
    expect.arrayContaining([
      "checkpoints",
      "journal",
      "http://gateway.test/health/ready",
      "http://case.test/health/ready",
    ]),
  );
});
it("exposes a failed journal and checkpoint schema as unavailable", async () => {
  const result = await runtimeReadiness({
    ...options,
    checkpoints: async () => {
      throw new Error("private schema failure");
    },
    journal: async () => {
      throw new Error("private token");
    },
  })();
  expect(result.status).toBe("unavailable");
  expect(
    result.checks.filter((row) => row.status === "Unavailable"),
  ).toHaveLength(2);
  expect(JSON.stringify(result)).not.toContain("private");
});
it("keeps memory persistence and degraded downstream readiness visible", async () => {
  const result = await runtimeReadiness({
    ...options,
    checkpointBackend: "memory",
    fetch: (async () => Response.json({ status: "degraded" })) as typeof fetch,
  })();
  expect(result.status).toBe("degraded");
  expect(result.checks[0]!.status).toBe("Degraded");
  expect(result.checks[2]!.status).toBe("Degraded");
});
