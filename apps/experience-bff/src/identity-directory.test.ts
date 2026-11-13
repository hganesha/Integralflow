import { describe, expect, it, vi } from "vitest";
import { entraDirectoryFromEnv } from "./identity-directory.js";

const tenant = "11111111-1111-4111-8111-111111111111";
const id = "c3d83044-8cf1-49c0-9a35-116bca61090e";
const env = { OIDC_ISSUER: `https://login.microsoftonline.com/${tenant}/v2.0`, OIDC_AUDIENCE: "directory-client", BFF_OIDC_CLIENT_SECRET: "directory-client-secret" };
const profile = { id, displayName: "Jamie Chen", mail: "Jamie.Chen@example.com", userPrincipalName: "jamie@example.com", accountEnabled: true };
function transport(graph: (url: URL) => Response = () => Response.json({ value: [profile] })) {
  return vi.fn<typeof fetch>(async (url, init) => String(url).includes("/oauth2/")
    ? Response.json({ access_token: "private-graph-token", expires_in: 3600 }) : graph(new URL(String(url))));
}
describe("Entra identity directory", () => {
  it("reuses configured Entra sign-in, searches basic profiles and caches server-only Graph tokens", async () => {
    const fetch = transport();
    const directory = entraDirectoryFromEnv(env, fetch);
    expect(directory.configuration).toEqual({ provider: "entra", label: "Microsoft Entra ID", configured: true, reason: null });
    expect(await directory.search("Jamie")).toEqual({ items: [{ id, displayName: "Jamie Chen", email: "jamie.chen@example.com", principalName: "jamie@example.com", enabled: true }], hasMore: false });
    await directory.search("Chen");
    expect(fetch.mock.calls.filter(call => String(call[0]).includes("/oauth2/"))).toHaveLength(1);
    const tokenRequest = fetch.mock.calls[0]!;
    expect(new URLSearchParams(String(tokenRequest[1]?.body)).get("scope")).toBe("https://graph.microsoft.com/.default");
    expect(new URLSearchParams(String(tokenRequest[1]?.body)).get("client_secret")).toBe(env.BFF_OIDC_CLIENT_SECRET);
    const graphRequest = fetch.mock.calls[1]!;
    expect(new URL(String(graphRequest[0])).searchParams.get("$select")).toBe("id,displayName,mail,userPrincipalName,accountEnabled");
    expect(graphRequest[1]).toMatchObject({ redirect: "error", headers: { authorization: "Bearer private-graph-token", ConsistencyLevel: "eventual" } });
    expect(directory.subjectId(id)).toBe(`entra:${tenant}:${id}`);
  });
  it("escapes OData quotes, restricts request origins and never follows provider pagination URLs", async () => {
    const fetch = transport(() => Response.json({ value: [profile], "@odata.nextLink": "https://untrusted.example/steal-token" }));
    const directory = entraDirectoryFromEnv(env, fetch);
    expect((await directory.search("O'Neil")).hasMore).toBe(true);
    expect(new URL(String(fetch.mock.calls[1]![0])).searchParams.get("$filter")).toContain("startsWith(displayName,'O''Neil')");
    expect(fetch.mock.calls.every(call => ["login.microsoftonline.com", "graph.microsoft.com"].includes(new URL(String(call[0])).hostname))).toBe(true);
    await expect(directory.get("../../me")).rejects.toMatchObject({ status: 400 });
    await expect(directory.search("x")).rejects.toMatchObject({ status: 400 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("refreshes the selected person's profile on import and uses their immutable object ID", async () => {
    const fetch = transport(url => {
      expect(url.pathname).toBe(`/v1.0/users/${id}`);
      return Response.json({ ...profile, mail: null });
    });
    const person = await entraDirectoryFromEnv(env, fetch).get(id);
    expect(person.email).toBe(profile.userPrincipalName);
  });
  it.each([
    [403, "identity_directory.permission_required"], [401, "identity_directory.authentication_failed"],
    [404, "identity_directory.user_not_found"], [429, "identity_directory.rate_limited"], [500, "identity_directory.unavailable"],
  ])("returns a safe error for provider HTTP %i", async (status, code) => {
    const directory = entraDirectoryFromEnv(env, transport(() => new Response("secret-provider-details", { status })));
    await expect(directory.get(id)).rejects.toMatchObject({ code });
  });
  it("rejects disabled, missing-email and mismatched records instead of creating access", async () => {
    for (const [record, code] of [
      [{ ...profile, accountEnabled: false }, "identity_directory.user_disabled"],
      [{ ...profile, mail: null, userPrincipalName: "not-an-email" }, "identity_directory.email_missing"],
      [{ ...profile, id: tenant }, "identity_directory.response_invalid"],
    ] as const) await expect(entraDirectoryFromEnv(env, transport(() => Response.json(record))).get(id)).rejects.toMatchObject({ code });
  });
  it("keeps unconfigured or non-Entra connections unavailable without making requests", async () => {
    const fetch = transport();
    for (const config of [{}, { ...env, OIDC_ISSUER: "https://other-idp.example.com" }, { ...env, IDENTITY_DIRECTORY_PROVIDER: "unsupported" }]) {
      const directory = entraDirectoryFromEnv(config, fetch);
      expect(directory.configuration.configured).toBe(false);
      await expect(directory.search("Jamie")).rejects.toMatchObject({ code: "identity_directory.not_configured" });
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});
