import { afterEach, expect, it, vi } from "vitest";
import { createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify, SignJWT } from "jose";
import { buildApp } from "./app.js";
import type { PrincipalResolver } from "@ehf/identity";

afterEach(() => vi.unstubAllGlobals());
it("completes production PKCE sign-in, maps verified access, creates a CSRF session and rejects replay", async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwks = { keys: [{ ...await exportJWK(publicKey), kid: "test", alg: "RS256" }] };
  let nonce = "";
  vi.stubGlobal("fetch", async (url: URL | string, init?: RequestInit) => {
    if (String(url).endsWith("openid-configuration")) return Response.json({ issuer: "https://id.example.com", authorization_endpoint: "https://id.example.com/authorize", token_endpoint: "https://id.example.com/token", jwks_uri: "https://id.example.com/jwks", code_challenge_methods_supported: ["S256"] });
    if (String(url).endsWith("/jwks")) return Response.json(jwks);
    expect((init?.headers as Record<string, string>).authorization).toBe(`Basic ${Buffer.from("human-client:private-client-secret").toString("base64")}`);
    return Response.json({ id_token: await new SignJWT({ nonce, groups: ["operators"] }).setProtectedHeader({ alg: "RS256", kid: "test" }).setIssuer("https://id.example.com").setAudience("human-client").setSubject("owner").setIssuedAt().setExpirationTime("5m").sign(privateKey) });
  });
  const resolver: PrincipalResolver = { source: "oidc", resolve: async request => {
    const { payload } = await jwtVerify(String(request.headers.authorization).slice(7), createLocalJWKSet(jwks), { issuer: "https://id.example.com", audience: "human-client" });
    return { subjectId: payload.sub!, tenantId: "tenant", actorType: "human", source: "oidc", roles: Array.isArray(payload.groups) && payload.groups.includes("operators") ? ["Platform.Admin"] : [] };
  } };
  const app = buildApp({ principalResolver: resolver, env: { SECURITY_PROFILE: "production", BFF_PUBLIC_ORIGIN: "https://app.example.com", OIDC_ISSUER: "https://id.example.com", OIDC_AUDIENCE: "human-client", BFF_OIDC_CLIENT_SECRET: "private-client-secret", ONBOARDING_CONSOLE_ORIGIN: "https://setup.example.com" } });
  try {
    const login = await app.inject({ url: "/auth/login" });
    expect(login.statusCode).toBe(302);
    const authorize = new URL(login.headers.location!); nonce = authorize.searchParams.get("nonce")!;
    const callback = `/auth/callback?code=authorization-code&state=${authorize.searchParams.get("state")}`;
    const flowCookie = String(login.headers["set-cookie"]).split(";")[0]!;
    expect((await app.inject({ url: callback, headers: { cookie: "integralflow_login=wrong" } })).statusCode).toBe(401);
    const signedIn = await app.inject({ url: callback, headers: { cookie: flowCookie } });
    expect(signedIn.statusCode).toBe(302);
    expect(signedIn.headers.location).toBe("/catalogs");
    const sessionCookie = (signedIn.headers["set-cookie"] as string[])[0]!.split(";")[0]!;
    const session = await app.inject({ url: "/api/v1/session", headers: { cookie: sessionCookie } });
    expect(session.json()).toMatchObject({ subject: { subjectId: "owner" }, roles: ["Platform.Admin"], environment: { managedConfiguration: true } });
    const setup = await app.inject({ url: "/onboarding", headers: { cookie: sessionCookie } });
    expect(setup.statusCode).toBe(302); expect(setup.headers.location).toBe("https://setup.example.com/onboarding");
    expect((await app.inject({ url: callback, headers: { cookie: flowCookie } })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/auth/logout", headers: { cookie: sessionCookie, origin: "https://app.example.com", "x-csrf-token": session.json().csrfToken } })).statusCode).toBe(200);
  } finally { await app.close(); }
});
