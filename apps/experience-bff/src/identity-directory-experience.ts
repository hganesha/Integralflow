import { createPlatformUserSchema } from "@ehf/contracts/users";
import { actionsForRoles } from "@ehf/identity";
import { validateResponse } from "@ehf/ui-contracts/validate";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { delegatedHeaders, errorResponse } from "./relay.js";
import type { sessionAccess } from "./session.js";
import { UpstreamError, type Upstream } from "./upstream.js";
import type { IdentityDirectory } from "./identity-directory.js";

export function registerIdentityDirectoryExperience(app: FastifyInstance, access: ReturnType<typeof sessionAccess>, upstream: Upstream, env: NodeJS.ProcessEnv, directory: IdentityDirectory) {
  const authorize = async (request: FastifyRequest, action: "admin.read" | "admin.write") => {
    const principal = await access.resolver.resolve(request);
    if (principal.actorType !== "human" || !actionsForRoles(principal.roles).has(action)) throw new UpstreamError(403, "authorization.role_missing");
    return principal;
  };
  app.get("/api/v1/admin/identity-provider", async (request, reply) => {
    reply.header("cache-control", "no-store");
    try { await authorize(request, "admin.read"); return directory.configuration; }
    catch (error) { const failure = errorResponse(error, request); return reply.code(failure.status).send(failure.body); }
  });
  app.get("/api/v1/admin/identity-provider/users", async (request, reply) => {
    reply.header("cache-control", "no-store").header("x-correlation-id", request.id);
    try {
      const principal = await authorize(request, "admin.write");
      const query = (request.query as Record<string, unknown>).query;
      if (typeof query !== "string" || query.trim().length < 2 || query.length > 100) throw new UpstreamError(400, "identity_directory.query_invalid");
      const [found, existing] = await Promise.all([
        directory.search(query),
        upstream("control-api", "GET", "/v1/admin/users", principal, undefined, delegatedHeaders(request, access, env)),
      ]);
      if (existing.status !== 200 || !Array.isArray(existing.body?.items)) throw new UpstreamError(503, "users.directory_unavailable");
      return { ...found, items: found.items.map(person => ({ ...person, alreadyAdded: existing.body.items.some((user: { subjectId: string; email: string }) => user.subjectId === directory.subjectId(person.id) || person.email !== null && user.email.toLowerCase() === person.email.toLowerCase()) })) };
    } catch (error) { const failure = errorResponse(error, request); return reply.code(failure.status).send(failure.body); }
  });
  app.post("/api/v1/admin/users", async (request, reply) => {
    reply.header("cache-control", "no-store").header("x-correlation-id", request.id);
    try {
      const principal = await authorize(request, "admin.write");
      if (!access.csrf(request)) throw new UpstreamError(403, "csrf.invalid");
      const parsed = createPlatformUserSchema.safeParse(request.body);
      if (!parsed.success) throw new UpstreamError(400, "users.input_invalid");
      // Re-read from the provider on submit. Browser-supplied profile fields are never authority.
      const person = await directory.get(parsed.data.directoryUserId);
      const result = await upstream("control-api", "POST", "/v1/admin/users", principal, {
        subjectId: directory.subjectId(person.id), displayName: person.displayName, email: person.email,
        roles: parsed.data.roles, reason: parsed.data.reason,
      }, delegatedHeaders(request, access, env));
      if (result.status >= 400) throw new UpstreamError(result.status, result.body?.error ?? "bff.upstream_failed");
      if (!validateResponse("postAdminUsers", result.status, result.body).valid) throw new UpstreamError(502, "bff.upstream_contract_invalid");
      return reply.code(result.status).send(result.body);
    } catch (error) { const failure = errorResponse(error, request); return reply.code(failure.status).send(failure.body); }
  });
}
