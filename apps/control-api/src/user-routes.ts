import { resolvedCreatePlatformUserSchema, updatePlatformUserSchema } from "@ehf/contracts";
import { HUMAN_ROLES, actionsForRoles, type PlatformAction, type Principal, type PrincipalResolver } from "@ehf/identity";
import { listPlatformUsers, platformUserForSubject, savePlatformUser, UserDirectoryError, type Database } from "@ehf/persistence";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

export function registerUserRoutes(app: FastifyInstance, db: Database, requirePrincipal: (request: { headers: Record<string, string | string[] | undefined> }, action: PlatformAction) => Promise<Principal>, edgeResolver: PrincipalResolver) {
  // Private edge lookup: the authenticated edge supplies a verified subject and cannot widen its tenant.
  app.get("/v1/identity/access", async (request, reply) => {
    const edge = await edgeResolver.resolve(request);
    const subject = request.headers["x-actor-id"];
    if (edge.actorType !== "workload" || !edge.roles.includes("Edge.Delegate") || typeof subject !== "string" || !subject || request.headers["x-tenant-id"] !== edge.tenantId) return reply.code(403).send({ error: "authorization.delegation_not_permitted" });
    reply.header("cache-control", "no-store");
    const directorySubject = request.headers["x-actor-directory-subject-id"];
    const managed = typeof directorySubject === "string" && /^entra:[0-9a-f-]{36}:[0-9a-f-]{36}$/.test(directorySubject) ? await platformUserForSubject(db, edge.tenantId, directorySubject) : null;
    return { user: managed ?? await platformUserForSubject(db, edge.tenantId, subject) };
  });
  app.get("/v1/admin/roles", async request => {
    await requirePrincipal(request, "admin.read");
    return { items: HUMAN_ROLES.map(role => ({ ...role, actions: [...actionsForRoles([role.id])].sort() })), nextCursor: null, generatedAt: new Date().toISOString() };
  });
  app.get("/v1/admin/users", async request => {
    const actor = await requirePrincipal(request, "admin.read");
    return { items: await listPlatformUsers(db, actor.tenantId), nextCursor: null, generatedAt: new Date().toISOString() };
  });
  app.post("/v1/admin/users", async (request, reply) => {
    const actor = await requirePrincipal(request, "admin.write");
    const parsed = resolvedCreatePlatformUserSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "users.input_invalid" });
    const { reason, ...input } = parsed.data;
    try { return reply.code(201).send(await savePlatformUser(db, actor, input, reason)); }
    catch (error) { if (error instanceof UserDirectoryError) return reply.code(error.httpStatus).send({ error: error.message }); throw error; }
  });
  app.put("/v1/admin/users/:userId", async (request, reply) => {
    const actor = await requirePrincipal(request, "admin.write");
    const parsed = updatePlatformUserSchema.safeParse(request.body);
    const id = z.uuid().safeParse((request.params as { userId: string }).userId);
    if (!parsed.success || !id.success) return reply.code(400).send({ error: "users.input_invalid" });
    const current = (await listPlatformUsers(db, actor.tenantId)).find(user => user.userId === id.data);
    if (!current) return reply.code(404).send({ error: "users.not_found" });
    const { reason, expectedRevision, ...input } = parsed.data;
    try { return await savePlatformUser(db, actor, { ...input, subjectId: current.subjectId }, reason, { userId: id.data, expectedRevision }); }
    catch (error) { if (error instanceof UserDirectoryError) return reply.code(error.httpStatus).send({ error: error.message }); throw error; }
  });
}
