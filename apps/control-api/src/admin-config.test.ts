import { describe, expect, it } from "vitest";
import type { Database } from "@ehf/persistence";
import { buildControlApi } from "./app.js";

const EDGE_TOKEN = "edge-service-token-for-admin-tests";

function stubDatabase(): Database {
  return {
    query: async () => ({ rowCount: 0, rows: [] }),
    connect: async () => ({ query: async () => ({ rowCount: 0, rows: [] }), release: () => {} }),
    end: async () => {},
  } as unknown as Database;
}

function api() {
  return buildControlApi({
    db: stubDatabase(),
    env: { LOCAL_DEFAULT_TENANT_ID: "tenant_demo" },
    serviceGrants: [
      { token: EDGE_TOKEN, subjectId: "control-surface-edge", roles: ["Edge.Delegate"], tenantId: "tenant_demo" },
    ],
  });
}

function asActor(roles: string) {
  return {
    authorization: `Bearer ${EDGE_TOKEN}`,
    "x-actor-id": "person@example.test",
    "x-actor-roles": roles,
  };
}

describe("administered configuration authorization", () => {
  it("refuses an unauthenticated read", async () => {
    const app = api();
    const response = await app.inject({ method: "GET", url: "/v1/admin/model-profiles" });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("refuses a reader, an author and an operator", async () => {
    // Administration is deliberately not a superset of authoring, approval or operation:
    // repointing a provider is a different authority from publishing a plan or starting
    // a run, and nobody acquires it by holding those.
    const app = api();
    for (const roles of ["Harness.Reader", "Harness.Author", "Harness.Operator", "Case.Analyst"]) {
      const response = await app.inject({
        method: "PUT", url: "/v1/admin/providers/openrouter",
        headers: asActor(roles),
        payload: { provider: { kind: "openrouter", displayName: "x", baseUrl: null, credentialRef: null, siteUrl: null, appName: null, status: "active" } },
      });
      expect([response.statusCode, roles]).toEqual([403, roles]);
      expect(response.json().error).toBe("authorization.role_missing");
    }
    await app.close();
  });

  it("lets an auditor read the configuration but not change it", async () => {
    const app = api();
    const read = await app.inject({
      method: "GET", url: "/v1/admin/settings", headers: asActor("Platform.Auditor"),
    });
    expect(read.statusCode).toBe(200);
    const write = await app.inject({
      method: "PUT", url: "/v1/admin/settings/envelope",
      headers: asActor("Platform.Auditor"),
      payload: { value: { ttlSeconds: 300 } },
    });
    expect(write.statusCode).toBe(403);
    await app.close();
  });

  it("reports the resolution source for every setting section", async () => {
    const app = api();
    const response = await app.inject({
      method: "GET", url: "/v1/admin/settings", headers: asActor("Platform.Admin"),
    });
    expect(response.statusCode).toBe(200);
    const sections = response.json().sections as Array<{
      section: string; source: string; appliesAt: string; service: string;
      fields: Array<{ path: string; kind: string; appliesAt: string; envName?: string; options?: string[] }>;
    }>;
    expect(sections.map((section) => section.section).sort()).toEqual([
      "authoring", "caseStore", "database", "dispatcher", "envelope",
      "evidence", "gateway", "observability", "outbox", "runtime",
    ]);
    // With an empty store and a bare environment, every section has to report that it is
    // still the built-in value rather than presenting itself as administered.
    expect(sections.every((section) => section.source === "default")).toBe(true);
    expect(sections.find((section) => section.section === "gateway")?.appliesAt).toBe("live");
    await app.close();
  });

  it("describes every field, so the surface never has to guess what a knob does", async () => {
    const app = api();
    const response = await app.inject({
      method: "GET", url: "/v1/admin/settings", headers: asActor("Platform.Admin"),
    });
    const sections = response.json().sections as Array<{
      section: string; appliesAt: string;
      fields: Array<{ path: string; label: string; help: string; service: string; appliesAt: string; kind: string; options?: string[] }>;
    }>;
    for (const section of sections) {
      expect(section.fields.length).toBeGreaterThan(0);
      for (const field of section.fields) {
        expect(field.label.length).toBeGreaterThan(0);
        expect(field.help.length).toBeGreaterThan(0);
        expect(field.service.length).toBeGreaterThan(0);
        if (field.kind === "enum") expect(field.options?.length).toBeGreaterThan(0);
      }
    }
    // A section whose fields disagree must say so rather than pick one and mislabel the
    // other: the trace viewer link is live while the exporter beside it is not.
    const observability = sections.find((section) => section.section === "observability");
    expect(observability?.appliesAt).toBe("mixed");
    expect(observability?.fields.find((field) => field.path === "traceViewerBaseUrl")?.appliesAt).toBe("live");
    expect(observability?.fields.find((field) => field.path === "otlpTracesEndpoint")?.appliesAt).toBe("restart");
    await app.close();
  });

  it("accepts an administered agent runtime binding and rejects a malformed endpoint", async () => {
    const app = api();
    const ok = await app.inject({
      method: "PUT", url: "/v1/admin/settings/runtime",
      headers: asActor("Platform.Admin"),
      payload: { value: {
        provider: "hosted_http:kyc-harness",
        localEndpoint: "http://runtime-host-local:8088/invocations",
        bindings: {
          "kyc-harness": { adapter: "hosted_http", endpoint: "https://runtime.example.test/invocations", auth: "platform_token" },
        },
        checkpointBackend: "postgres",
      } },
    });
    expect(ok.statusCode).toBe(200);

    const bad = await app.inject({
      method: "PUT", url: "/v1/admin/settings/runtime",
      headers: asActor("Platform.Admin"),
      payload: { value: {
        provider: "hosted_http",
        localEndpoint: "not-a-url",
        checkpointBackend: "postgres",
      } },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toContain("localEndpoint");
    await app.close();
  });

  it("refuses the removed cloud-specific runtime settings at save time", async () => {
    const app = api();
    const response = await app.inject({
      method: "PUT", url: "/v1/admin/settings/runtime",
      headers: asActor("Platform.Admin"),
      payload: { value: {
        provider: "hosted_http",
        localEndpoint: "http://runtime-host-local:8088/invocations",
        foundry: { agentName: "kyc-harness" },
        checkpointBackend: "postgres",
      } },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("answers a bad request with a bad request, not a server fault", async () => {
    // A rejected section name or a malformed provider is the operator's input, not a
    // broken platform: reporting it as a 500 sends them looking for an outage.
    const app = api();
    const section = await app.inject({
      method: "PUT", url: "/v1/admin/settings/not-a-section",
      headers: asActor("Platform.Admin"),
      payload: { value: {} },
    });
    expect(section.statusCode).toBe(400);
    expect(section.json().error).toContain("admin.invalid_input");

    const provider = await app.inject({
      method: "PUT", url: "/v1/admin/providers/openrouter",
      headers: asActor("Platform.Admin"),
      // A pasted credential in the reference field: the control plane holds no provider
      // secret, and a field that accepted one would quietly make it hold one.
      payload: { provider: { kind: "openrouter", displayName: "OpenRouter", baseUrl: null, credentialRef: "sk-or-v1-abcdef", siteUrl: null, appName: null, status: "active" } },
    });
    expect(provider.statusCode).toBe(400);
    expect(provider.json().error).toContain("credentialRef");
    await app.close();
  });
});
