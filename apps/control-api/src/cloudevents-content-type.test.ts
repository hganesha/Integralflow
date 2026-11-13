import { expect, it } from "vitest";
import type { Database } from "@ehf/persistence";
import { buildControlApi } from "./app.js";

it("parses the structured CloudEvents the case outbox relay sends", async () => {
  const app = buildControlApi({ env: { EDGE_SERVICE_TOKEN: "test".repeat(8) }, db: { query: async () => ({ rows: [] }) } as unknown as Database });
  app.log.level = "silent";
  try {
    const event = { specversion: "1.0", id: "evt_1", source: "urn:ehf:case", type: "case.created", data: { tenantId: "tenant_demo" } };
    for (const contentType of ["application/cloudevents+json", "application/json"]) {
      const response = await app.inject({ method: "POST", url: "/v1/integrations/internal/events",
        headers: { "content-type": contentType }, payload: JSON.stringify(event) });
      // The body is parsed and the request reaches authorization (it carries no credential).
      expect(response.statusCode, contentType).toBe(401);
    }
    // A malformed body is refused exactly as a malformed application/json body is.
    const malformed = async (contentType: string) => (await app.inject({ method: "POST", url: "/v1/integrations/internal/events",
      headers: { "content-type": contentType }, payload: "{not json" })).statusCode;
    expect(await malformed("application/cloudevents+json")).toBe(await malformed("application/json"));
  } finally { await app.close(); }
});
