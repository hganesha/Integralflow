import { randomBytes, timingSafeEqual } from "node:crypto";
import { actionsForRoles, AuthorizationError, browserOidcClient, isProductionProfile, type Principal, type PrincipalResolver } from "@ehf/identity";
import type { FastifyInstance, FastifyRequest } from "fastify";

type Session = { principal: Principal; csrf: string; expires: number; authorization?: string | undefined };
const COOKIE = "ehf_session";
/**
 * A post-sign-in destination on this origin, or the default. The value is resolved the way
 * a browser would, against a placeholder origin, so tab/newline stripping and backslash
 * normalization cannot turn "/\t/host" or "/\\host" into a scheme-relative off-site URL.
 */
export function sameOriginPath(value: unknown, fallback = "/catalogs"): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.length > 2048) return fallback;
  const base = "https://same-origin.invalid";
  let url: URL;
  try { url = new URL(value, base); } catch { return fallback; }
  return url.origin === base ? `${url.pathname}${url.search}${url.hash}` : fallback;
}

export function sessionAccess(app: FastifyInstance, identity: PrincipalResolver, env: NodeJS.ProcessEnv, resolveAccess: (principal: Principal) => Promise<Principal> = async principal => principal) {
  const sessions = new Map<string, Session>();
  const production = isProductionProfile(env);
  const browserLogin = production && env.BFF_PUBLIC_ORIGIN && env.OIDC_ISSUER && env.OIDC_AUDIENCE ? browserOidcClient({ issuer: env.OIDC_ISSUER, clientId: env.OIDC_AUDIENCE, clientSecret: env.BFF_OIDC_CLIENT_SECRET, redirectUri: `${env.BFF_PUBLIC_ORIGIN}/auth/callback`, allowedOrigins: (env.BFF_OIDC_ALLOWED_ORIGINS ?? new URL(env.OIDC_ISSUER).origin).split(",").map(value => value.trim()) }) : null;
  const keyOf = (request: { headers: Record<string, unknown> }) => String(request.headers.cookie ?? "").split(";").map(part => part.trim()).find(part => part.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  const held = (request: { headers: Record<string, unknown> }) => { const key = keyOf(request); const value = key ? sessions.get(key) : undefined; if (value && value.expires > Date.now()) return value; if (key) sessions.delete(key); return null; };
  const create = (principal: Principal, authorization?: string) => {
    for (const [key, session] of sessions) if (session.expires <= Date.now()) sessions.delete(key);
    if (sessions.size >= 10000) throw new Error("session.capacity_exceeded");
    const key = randomBytes(32).toString("hex");
    let expires = Date.now() + 30 * 60_000;
    if (authorization?.startsWith("Bearer ")) { try { const claims = JSON.parse(Buffer.from(authorization.slice(7).split(".")[1] ?? "", "base64url").toString()); if (typeof claims.exp === "number") expires = Math.min(expires, claims.exp * 1000); } catch { /* A non-JWT development credential has the normal session limit. */ } }
    const value: Session = { principal, csrf: randomBytes(32).toString("hex"), expires, authorization };
    sessions.set(key, value);
    return { key, value };
  };
  const cookie = (key: string, maxAge = 1800) => `${COOKIE}=${key}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${production ? "; Secure" : ""}`;
  const resolver: PrincipalResolver = { source: identity.source, resolve: async request => resolveAccess(held(request)?.principal ?? await identity.resolve(request)) };
  const csrf = (request: FastifyRequest) => {
    const session = held(request);
    const token = String(request.headers["x-csrf-token"] ?? "");
    const origin = String(request.headers.origin ?? "");
    const expectedOrigin = env.BFF_PUBLIC_ORIGIN ?? `http://${request.headers.host}`;
    return Boolean(session && origin === expectedOrigin && /^[a-f0-9]{64}$/.test(token) && timingSafeEqual(Buffer.from(token), Buffer.from(session.csrf)));
  };
  app.get("/api/v1/session", async (request, reply) => {
    try {
      let session = held(request);
      if (!session) {
        const principal = await identity.resolve(request);
        if (principal.actorType !== "human") return reply.code(403).send({ error: "authorization.interactive_user_required", status: 403, correlationId: request.id, retryable: false });
        const created = create(principal, request.headers.authorization);
        session = created.value;
        reply.header("set-cookie", cookie(created.key));
      }
      const principal = await resolveAccess(session.principal);
      reply.header("cache-control", "no-store");
      return { subject: { subjectId: principal.subjectId, ...(principal.directorySubjectId ? { directorySubjectId: principal.directorySubjectId } : {}), displayName: principal.displayName ?? principal.subjectId, actorType: "human", email: principal.email ?? null }, tenant: { tenantId: principal.tenantId, name: principal.tenantId }, roles: principal.roles, actions: [...actionsForRoles(principal.roles)], authoringEnabled: env.AUTHORING_ENABLED !== "false", environment: { name: env.EHF_ENVIRONMENT ?? "local", managedConfiguration: production, runtimeMode: env.RUNTIME_MODE ?? "http", build: env.BUILD_VERSION ?? "development", synthetic: false }, domains: [{ id: "fincrime", label: "Financial crime", catalogDigest: null, sourceRelease: null }], csrfToken: session.csrf, expiresAt: new Date(session.expires).toISOString() };
    } catch (error) { const status = error instanceof AuthorizationError ? error.httpStatus : 503; return reply.code(status).send({ error: status === 503 ? "session.unavailable" : "session.expired", status, correlationId: request.id, retryable: status === 503 }); }
  });
  app.get("/auth/login", async (request, reply) => {
    if (browserLogin && !request.headers.authorization) {
      try { const flow = await browserLogin.start(); return reply.header("set-cookie", `integralflow_login=${flow.state}; Path=/auth; HttpOnly; Secure; SameSite=Lax; Max-Age=600`).redirect(flow.url); }
      catch { return reply.code(503).send({ error: "session.identity_unavailable" }); }
    }
    // An authenticated ingress may supply the verified JWT. Local sign-in is explicitly configured.
    let principal: Principal;
    if (!production && env.BFF_LOCAL_SUBJECT && env.BFF_LOCAL_ROLES) principal = { subjectId: env.BFF_LOCAL_SUBJECT, tenantId: env.LOCAL_DEFAULT_TENANT_ID ?? "tenant_demo", roles: env.BFF_LOCAL_ROLES.split(",").map(role => role.trim()).filter(Boolean), actorType: "human", source: "local" };
    else { try { principal = await identity.resolve(request); } catch { return reply.code(401).send({ error: "session.sign_in_required", message: "Sign in through the configured identity ingress." }); } }
    if (principal.actorType !== "human") return reply.code(403).send({ error: "authorization.interactive_user_required" });
    try { await resolveAccess(principal); }
    catch { return reply.code(503).send({ error: "users.directory_unavailable" }); }
    const created = create(principal, request.headers.authorization);
    reply.header("set-cookie", cookie(created.key));
    return reply.redirect(sameOriginPath((request.query as Record<string, unknown>).returnTo));
  });
  app.get("/auth/callback", async (request, reply) => {
    if (!browserLogin) return reply.code(404).send({ error: "route.not_found" });
    const query = request.query as Record<string, unknown>;
    const flowCookie = String(request.headers.cookie ?? "").split(";").map(value => value.trim()).find(value => value.startsWith("integralflow_login="))?.slice("integralflow_login=".length) ?? "";
    try {
      if (typeof query.code !== "string" || typeof query.state !== "string") throw new Error("identity.callback_invalid");
      const { idToken } = await browserLogin.finish(query.code, query.state, flowCookie);
      const principal = await identity.resolve({ headers: { authorization: `Bearer ${idToken}` } });
      if (principal.actorType !== "human" || !(await resolveAccess(principal)).roles.length) throw new Error("identity.group_access_required");
      const created = create(principal, `Bearer ${idToken}`);
      return reply.header("set-cookie", [cookie(created.key), "integralflow_login=; Path=/auth; HttpOnly; Secure; SameSite=Lax; Max-Age=0"]).redirect("/catalogs");
    } catch { return reply.code(401).send({ error: "session.sign_in_failed" }); }
  });
  app.post("/auth/logout", async (request, reply) => { if (!csrf(request)) return reply.code(403).send({ error: "csrf.invalid", status: 403, correlationId: request.id, retryable: false }); const key = keyOf(request); if (key) sessions.delete(key); return reply.header("set-cookie", cookie("", 0)).send({ ok: true }); });
  return { resolver, csrf, authorization: (request: FastifyRequest) => held(request)?.authorization ?? request.headers.authorization };
}
