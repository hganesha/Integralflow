import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { readCanonicalCatalog } from "@ehf/fincrime-integration";
import { buildApp } from "./app.js";
import type { Upstream } from "./upstream.js";
const artifact = JSON.parse(
  readFileSync(
    new URL("../../fincrime-host/catalog/ehf-catalog.json", import.meta.url),
    "utf8",
  ),
);
const source = {
  catalogDigest: artifact.sha256,
  ...readCanonicalCatalog(artifact, artifact.sha256),
};
it("serves real catalog/access projections with authorized production routes and an honest preview blocker", async () => {
  const upstream = vi.fn<Upstream>(async () => ({ status: 200, body: source }));
  const app = buildApp({
    env: { BFF_PUBLIC_ORIGIN: "http://bff.test" },
    upstream,
    principalResolver: {
      source: "local",
      resolve: async () => ({
        subjectId: "context-author",
        tenantId: "tenant_verified",
        actorType: "human",
        roles: ["Harness.Author"],
        source: "local",
      }),
    },
  });
  try {
    for (const url of [
      "/api/v1/fincrime/catalog",
      "/api/v1/fincrime/context/products",
      "/api/v1/fincrime/context/readiness",
      "/api/v1/fincrime/context/products/party360",
    ]) {
      const r = await app.inject(url);
      expect(r.statusCode, r.body).toBe(200);
    }
    expect(
      (await app.inject("/api/v1/fincrime/context/products/missing"))
        .statusCode,
    ).toBe(404);
    expect(
      upstream.mock.calls.every((c) => c[3].tenantId === "tenant_verified"),
    ).toBe(true);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/fincrime/context/packets:preview",
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
    const session = await app.inject("/api/v1/session");
    const preview = await app.inject({
      method: "POST",
      url: "/api/v1/fincrime/context/packets:preview",
      payload: {
        agentId: "agent.screening",
        taskId: "task.screening",
        caseId: "case-preview",
      },
      headers: {
        cookie: String(session.headers["set-cookie"]).split(";")[0]!,
        origin: "http://bff.test",
        "x-csrf-token": session.json().csrfToken,
      },
    });
    expect(preview.statusCode).toBe(409);
    expect(preview.json().error).toBe("context.preview_target_required");
  } finally {
    await app.close();
  }
});

it("composes the ontology through authorized schema and relationship routes and rejects version mixing", async () => {
  const ontology = JSON.parse(readFileSync(new URL("../../../packages/library-contracts/src/vendor/ontology.schema.json", import.meta.url), "utf8"));
  const lock = JSON.parse(readFileSync(new URL("../../../packages/library-contracts/src/vendor/lock.json", import.meta.url), "utf8"));
  const relationships = JSON.parse(readFileSync(new URL("../../../packages/library-contracts/src/vendor/context-relationships.json", import.meta.url), "utf8"));
  const upstream = vi.fn<Upstream>(async (_service, _method, path) => ({ status: 200, body: path.endsWith("/schema") ? { schemaVersion: lock.context_schema_version, lock, objectTypes: ontology['x-context-types'], definitions: ontology.$defs } : path.endsWith("/relationships") ? relationships : source }));
  const app = buildApp({ env: { BFF_PUBLIC_ORIGIN: "http://bff.test" }, upstream, principalResolver: { source: "local", resolve: async () => ({ subjectId: "author", tenantId: "tenant_verified", actorType: "human", roles: ["Harness.Author"], source: "local" }) } });
  try {
    const response = await app.inject("/api/v1/fincrime/context/ontology");
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().nodes).toHaveLength(89);
    expect(upstream.mock.calls.map(c => c[2])).toEqual(["/v1/context/catalog", "/v1/context/schema", "/v1/context/relationships"]);
    expect(upstream.mock.calls.every(c => c[3].tenantId === "tenant_verified")).toBe(true);
    relationships.schemaVersion = "invalid";
    const changed = await app.inject("/api/v1/fincrime/context/ontology");
    expect(changed.statusCode).toBe(409);
    expect(changed.json().error).toBe("context.ontology_version_mismatch");
  } finally { await app.close(); }
});
