import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { businessSkillCatalogSchema } from "@ehf/contracts";
import type { Database } from "@ehf/persistence";
import { buildControlApi } from "./app.js";

const catalog = businessSkillCatalogSchema.parse(JSON.parse(
  readFileSync(new URL("../../../config/business-skills.json", import.meta.url), "utf8"),
));
const entry = catalog.skills.find((skill) => skill.skillId === "screening.sanctions.execute")!;
const row = {
  skill_id: entry.skillId, semver: entry.semver, manifest: entry.manifest, manifest_digest: entry.manifestDigest,
  status: entry.status, maturity: entry.maturity, source: entry.source, owner: entry.owner,
  created_at: new Date(0), updated_at: new Date(0),
};

it("serves the business skill registry to readers, and only to readers", async () => {
  const edge = "edge-test-credential-000000000002";
  const query = vi.fn(async (_text: string, _values?: unknown[]) => ({ rows: [row], rowCount: 1 }));
  const app = buildControlApi({ db: { query } as unknown as Database, env: { EDGE_SERVICE_TOKEN: edge } });
  app.log.level = "silent";
  // Startup housekeeping may query the database; count only what the requests below do.
  await app.ready();
  query.mockClear();
  const headers = { authorization: `Bearer ${edge}`, "x-actor-id": "reader", "x-actor-roles": "Case.Analyst" };
  try {
    expect((await app.inject({ url: "/v1/business-skills", headers })).statusCode).toBe(403);
    expect(query).not.toHaveBeenCalled();
    headers["x-actor-roles"] = "Harness.Reader";

    const listed = await app.inject({ url: "/v1/business-skills?maturity=implemented_synthetic&domain=screening", headers });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().skills[0]).toMatchObject({
      skillId: "screening.sanctions.execute", maturity: "implemented_synthetic", status: "draft", effects: { mode: "read_only", approval: "none" },
    });
    expect(query.mock.calls[0]![1]).toEqual([null, "implemented_synthetic", "screening"]);
    expect((await app.inject({ url: "/v1/business-skills?maturity=implemented", headers })).statusCode).toBe(400);

    const one = await app.inject({ url: `/v1/business-skills/screening.sanctions.execute?semver=${entry.semver}`, headers });
    expect(one.statusCode).toBe(200);
    expect(one.json().manifestDigest).toBe(entry.manifestDigest);
    expect((await app.inject({ url: "/v1/business-skills/screening.sanctions.v1.", headers })).statusCode).toBe(400);
    query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    expect((await app.inject({ url: "/v1/business-skills/entity.resolve", headers })).statusCode).toBe(404);
  } finally { await app.close(); }
});
