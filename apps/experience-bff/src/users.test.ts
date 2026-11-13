import { describe, expect, it, vi } from "vitest";
import { validateResponse } from "@ehf/ui-contracts/validate";
import type { Principal } from "@ehf/identity";
import { buildApp } from "./app.js";
import { directoryAccess } from "./user-access.js";
import type { Upstream } from "./upstream.js";
import type { IdentityDirectory } from "./identity-directory.js";

const principal: Principal = { subjectId: "idp-admin", tenantId: "verified-tenant", roles: ["Platform.Admin"], actorType: "human", source: "local" };
const now = new Date().toISOString();
const user = { userId: "1c69f2cc-105a-44f4-8e6c-ff528da13b58", subjectId: "idp-jamie", displayName: "Jamie Chen", email: "jamie@example.com", roles: ["Case.Analyst"], revision: 1, createdAt: now, updatedAt: now, updatedBy: principal.subjectId };
const directoryId = "c3d83044-8cf1-49c0-9a35-116bca61090e";
const identityDirectory: IdentityDirectory = { configuration: { provider: "entra", label: "Microsoft Entra ID", configured: true, reason: null }, subjectId: () => user.subjectId,
  get: async id => ({ id, displayName: user.displayName, email: user.email, principalName: user.email, enabled: true }),
  search: async () => ({ items: [{ id: directoryId, displayName: user.displayName, email: user.email, principalName: user.email, enabled: true }], hasMore: false }) };
describe("user management experience", () => {
  it("returns a service-unavailable response when local sign-in cannot resolve saved access", async () => {
    const app = buildApp({ principalResolver: { source: "local", resolve: async () => principal }, resolveUserAccess: async () => { throw new Error("directory unavailable"); } });
    try {
      const response = await app.inject("/auth/login");
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ error: "users.directory_unavailable" });
    } finally { await app.close(); }
  });
  it("relays durable creates and edits with session CSRF and the verified actor", async () => {
    const upstream = vi.fn<Upstream>(async (_service, method, path) => ({ status: method === "POST" ? 201 : 200, body: path.endsWith("/users") && method === "GET" ? { items: [user], nextCursor: null, generatedAt: now } : user }));
    const app = buildApp({ env: { BFF_PUBLIC_ORIGIN: "http://ui.test" }, principalResolver: { source: "local", resolve: async () => principal }, upstream, identityDirectory });
    try {
      const session = await app.inject("/api/v1/session");
      const cookie = session.headers["set-cookie"]!.toString().split(";")[0]!;
      const headers = { cookie, origin: "http://ui.test", "x-csrf-token": session.json().csrfToken };
      const input = { directoryUserId: directoryId, roles: user.roles, reason: "Add colleague" };
      const denied = await app.inject({ method: "POST", url: "/api/v1/admin/users", payload: input, headers: { cookie } });
      expect(denied.statusCode).toBe(403);
      expect(upstream).not.toHaveBeenCalled();
      const created = await app.inject({ method: "POST", url: "/api/v1/admin/users", payload: input, headers });
      expect(created.statusCode, created.body).toBe(201);
      expect(validateResponse("postAdminUsers", 201, created.json()).valid).toBe(true);
      expect(upstream.mock.calls[0]?.[4]).toEqual({ subjectId: user.subjectId, displayName: user.displayName, email: user.email, roles: user.roles, reason: input.reason });
      const update = { displayName: user.displayName, email: user.email, roles: user.roles, reason: input.reason };
      const saved = await app.inject({ method: "PUT", url: `/api/v1/admin/users/${user.userId}`, payload: { ...update, expectedRevision: 1 }, headers });
      expect(saved.statusCode, saved.body).toBe(200);
      expect(upstream.mock.calls.every(call => call[3].subjectId === principal.subjectId && call[3].tenantId === principal.tenantId)).toBe(true);
    } finally { await app.close(); }
  });
  it("searches only for administrators, flags existing users, and rejects browser-supplied identity fields", async () => {
    const upstream = vi.fn<Upstream>(async () => ({ status: 200, body: { items: [user], nextCursor: null, generatedAt: now } }));
    const app = buildApp({ env: { BFF_PUBLIC_ORIGIN: "http://ui.test" }, principalResolver: { source: "local", resolve: async () => principal }, upstream, identityDirectory });
    try {
      const found = await app.inject("/api/v1/admin/identity-provider/users?query=Jamie");
      expect(found.statusCode, found.body).toBe(200);
      expect(found.json().items[0]).toMatchObject({ id: directoryId, alreadyAdded: true });
      expect((await app.inject("/api/v1/admin/identity-provider/users?query=x")).statusCode).toBe(400);
      const session = await app.inject("/api/v1/session");
      const headers = { cookie: session.headers["set-cookie"]!.toString().split(";")[0]!, origin: "http://ui.test", "x-csrf-token": session.json().csrfToken };
      const spoofed = await app.inject({ method: "POST", url: "/api/v1/admin/users", headers, payload: { directoryUserId: directoryId, subjectId: "someone-else", roles: ["Platform.Admin"], reason: "Forged profile" } });
      expect(spoofed.statusCode).toBe(400);
      expect(upstream).toHaveBeenCalledTimes(1);
    } finally { await app.close(); }
    const auditor = buildApp({ principalResolver: { source: "local", resolve: async () => ({ ...principal, roles: ["Platform.Auditor"] }) }, upstream, identityDirectory });
    try { expect((await auditor.inject("/api/v1/admin/identity-provider/users?query=Jamie")).statusCode).toBe(403); }
    finally { await auditor.close(); }
  });
  it("lets auditors read the directory but rejects role writes", async () => {
    const upstream = vi.fn<Upstream>(async () => ({ status: 200, body: { items: [user], nextCursor: null, generatedAt: now } }));
    const app = buildApp({ principalResolver: { source: "local", resolve: async () => ({ ...principal, roles: ["Platform.Auditor"] }) }, upstream });
    try {
      expect((await app.inject("/api/v1/admin/users")).statusCode).toBe(200);
      const denied = await app.inject({ method: "POST", url: "/api/v1/admin/users", payload: {} });
      expect(denied.statusCode).toBe(403);
      expect(upstream).toHaveBeenCalledTimes(1);
    } finally { await app.close(); }
  });
  it("replaces identity-provider roles on every existing-session request and fails closed when unavailable", async () => {
    let roles = ["Platform.Admin"];
    let available = true;
    const upstream = vi.fn<Upstream>(async (_service, _method, path) => path === "/v1/identity/access" ? { status: available ? 200 : 503, body: { user: { ...user, subjectId: principal.subjectId, roles } } } : { status: 200, body: { items: [user], nextCursor: null, generatedAt: now } });
    const app = buildApp({ principalResolver: { source: "local", resolve: async () => principal }, resolveUserAccess: directoryAccess(upstream), upstream });
    try {
      const first = await app.inject("/api/v1/session");
      expect(first.json().roles).toEqual(["Platform.Admin"]);
      const headers = { cookie: first.headers["set-cookie"]!.toString().split(";")[0]! };
      roles = ["Case.Analyst"];
      const refreshed = await app.inject({ url: "/api/v1/session", headers });
      expect(refreshed.json()).toMatchObject({ roles, subject: { displayName: "Jamie Chen" } });
      expect((await app.inject({ url: "/api/v1/admin/users", headers })).statusCode).toBe(403);
      available = false;
      expect((await app.inject({ url: "/api/v1/session", headers })).statusCode).toBe(503);
    } finally { await app.close(); }
  });
});
