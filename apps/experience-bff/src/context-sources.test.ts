import { afterEach, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import type { Upstream } from "./upstream.js";
import fixture from "../../../packages/contracts/test-fixtures/context-source.json" with { type: "json" };
const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
function app(upstream: Upstream, roles = ["Platform.Admin"]) {
  const value = buildApp({
    env: { BFF_PUBLIC_ORIGIN: "http://bff.test" },
    principalResolver: {
      source: "local",
      resolve: async () => ({
        subjectId: "verified-admin",
        tenantId: "verified-tenant",
        actorType: "human",
        roles,
        source: "local",
      }),
    },
    upstream,
  });
  apps.push(value);
  return value;
}
it("uses verified identity, validates requests and requires CSRF before any upstream call", async () => {
  const upstream = vi.fn<Upstream>(async () => ({
    status: 409,
    body: { error: "context_source.revision_conflict" },
  }));
  const bff = app(upstream);
  const session = await bff.inject("/api/v1/session");
  const payload = { definition: fixture.connection, expectedRevision: null };
  expect(
    (
      await bff.inject({
        method: "POST",
        url: "/api/v1/context-sources/connections",
        payload,
      })
    ).statusCode,
  ).toBe(403);
  const headers = {
    origin: "http://bff.test",
    cookie: String(session.headers["set-cookie"]).split(";")[0]!,
    "x-csrf-token": session.json().csrfToken,
    "x-tenant-id": "spoofed",
  };
  expect(
    (
      await bff.inject({
        method: "POST",
        url: "/api/v1/context-sources/connections",
        headers,
        payload: { ...payload, tenantId: "spoofed" },
      })
    ).statusCode,
  ).toBe(400);
  expect(upstream).not.toHaveBeenCalled();
  expect(
    (
      await bff.inject({
        method: "POST",
        url: "/api/v1/context-sources/connections",
        headers,
        payload,
      })
    ).statusCode,
  ).toBe(409);
  expect(upstream.mock.calls[0]?.[3]).toMatchObject({
    tenantId: "verified-tenant",
    subjectId: "verified-admin",
  });
  const reader = app(upstream, ["Harness.Reader"]);
  expect(
    (
      await reader.inject({
        method: "POST",
        url: "/api/v1/context-sources/connections",
        payload,
      })
    ).statusCode,
  ).toBe(403);
});
it("keeps unavailable inventory unavailable and validates successful responses", async () => {
  expect(
    (
      await app(async () => ({
        status: 503,
        body: { error: "store.unavailable" },
      })).inject("/api/v1/context-sources")
    ).statusCode,
  ).toBe(503);
  expect(
    (
      await app(async () => ({
        status: 200,
        body: {
          connections: [],
          bindings: [],
          checks: [],
          refreshes: [],
          canonicalTypes: [],
        },
      })).inject("/api/v1/context-sources")
    ).statusCode,
  ).toBe(200);
  expect(
    (
      await app(async () => ({
        status: 200,
        body: { connections: [] },
      })).inject("/api/v1/context-sources")
    ).statusCode,
  ).toBe(503);
});
