import { canonicalTypeDescriptors } from "@ehf/library-contracts";
import {
  contextRefreshSaveSchema,
  contextActivationSchema,
} from "@ehf/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  configureContextRefresh,
  getPlan,
  requireExecutableRelease,
  loadContextBinding,
  contextConnectorId,
  activateContextBinding,
  contextSourceIndex,
  saveContextSource,
  ContextSourceError,
  type Database,
} from "@ehf/persistence";
import type { Principal, PlatformAction, ResourceRef } from "@ehf/identity";

export function registerContextSourceRoutes(
  app: FastifyInstance,
  options: {
    db: Database;
    environment?: string;
    authorize: (
      request: FastifyRequest,
      action: PlatformAction,
      resource?: ResourceRef,
    ) => Promise<Principal>;
  },
): void {
  app.get("/v1/context-sources", async (request) => {
    const principal = await options.authorize(request, "capability.read", {
      kind: "context-source",
    });
    return {
      ...(await contextSourceIndex(options.db, principal.tenantId)),
      canonicalTypes: canonicalTypeDescriptors(),
    };
  });
  const save =
    (kind: "connection" | "binding") =>
    async (request: FastifyRequest, reply: import("fastify").FastifyReply) => {
      const principal = await options.authorize(request, "admin.write", {
        kind: "context-source",
      });
      try {
        return reply.code(201).send(
          await saveContextSource(options.db, {
            tenantId: principal.tenantId,
            actor: principal.subjectId,
            kind,
            body: request.body,
          }),
        );
      } catch (error) {
        if (error instanceof ContextSourceError)
          return reply.code(error.status).send({ error: error.message });
        throw error;
      }
    };
  app.post(
    "/v1/context-sources/connections",
    { bodyLimit: 65536 },
    save("connection"),
  );
  app.post(
    "/v1/context-sources/bindings",
    { bodyLimit: 65536 },
    save("binding"),
  );
  app.post<{ Params: { bindingId: string } }>(
    "/v1/context-sources/bindings/:bindingId/activation",
    { bodyLimit: 4096 },
    async (request, reply) => {
      const principal = await options.authorize(request, "admin.write", {
        kind: "context-source",
        id: request.params.bindingId,
      });
      try {
        const parsed = contextActivationSchema.safeParse(request.body);
        if (!parsed.success)
          return reply
            .code(400)
            .send({ error: "context_source.activation_invalid" });
        if (parsed.data.action === "activate") {
          const { binding } = await loadContextBinding(options.db, {
            tenantId: principal.tenantId,
            bindingId: request.params.bindingId,
            revision: parsed.data.revision,
          });
          const refresh = binding.definition.refresh;
          if (refresh.enabled) {
            await options.authorize(request, "integration.activate", {
              kind: "context-refresh",
            });
            await options.authorize(request, "run.start", {
              kind: "context-refresh",
            });
            await requireExecutableRelease(
              options.db,
              principal.tenantId,
              refresh.planDigest!,
              options.environment ?? "development",
            );
            const plan = await getPlan(
              options.db,
              refresh.planDigest!,
              principal.tenantId,
            );
            if (
              !plan?.capabilities.some(
                (capability) =>
                  capability.adapterBindingId ===
                  contextConnectorId(
                    principal.tenantId,
                    binding.definition.id,
                    binding.revision,
                  ),
              )
            )
              throw new ContextSourceError(
                "context_source.refresh_plan_mismatch",
                400,
              );
          }
        }
        return await activateContextBinding(options.db, {
          tenantId: principal.tenantId,
          actor: principal.subjectId,
          bindingId: request.params.bindingId,
          body: request.body,
        });
      } catch (error) {
        if (error instanceof ContextSourceError)
          return reply.code(error.status).send({ error: error.message });
        if (error instanceof Error && error.message.startsWith("release."))
          return reply.code(409).send({ error: error.message });
        throw error;
      }
    },
  );
  app.post<{ Params: { bindingId: string } }>(
    "/v1/context-sources/bindings/:bindingId/refresh",
    { bodyLimit: 65536 },
    async (request, reply) => {
      const principal = await options.authorize(request, "admin.write", {
        kind: "context-source",
      });
      await options.authorize(request, "integration.activate", {
        kind: "context-refresh",
      });
      await options.authorize(request, "run.start", {
        kind: "context-refresh",
      });
      const parsed = contextRefreshSaveSchema.safeParse(request.body);
      if (!parsed.success)
        return reply
          .code(400)
          .send({ error: "context_source.refresh_invalid" });
      try {
        if (parsed.data.configuration.enabled) {
          await requireExecutableRelease(
            options.db,
            principal.tenantId,
            parsed.data.configuration.planDigest!,
            options.environment ?? "development",
          );
          const plan = await getPlan(
            options.db,
            parsed.data.configuration.planDigest!,
            principal.tenantId,
          );
          if (
            !plan?.capabilities.some(
              (c) =>
                c.adapterBindingId ===
                contextConnectorId(
                  principal.tenantId,
                  request.params.bindingId,
                  parsed.data.revision,
                ),
            )
          )
            throw new ContextSourceError(
              "context_source.refresh_plan_mismatch",
              400,
            );
        }
        return await configureContextRefresh(options.db, {
          tenantId: principal.tenantId,
          actor: principal.subjectId,
          bindingId: request.params.bindingId,
          body: request.body,
        });
      } catch (error) {
        if (error instanceof ContextSourceError)
          return reply.code(error.status).send({ error: error.message });
        if (error instanceof Error && error.message.startsWith("release."))
          return reply.code(409).send({ error: error.message });
        throw error;
      }
    },
  );
}
