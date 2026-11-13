import { stableDigest } from "@ehf/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  createWorkspaceSchema,
  saveWorkspaceSchema,
  evaluateWorkspaceSchema,
  workspaceConfig,
} from "@ehf/contracts/workbench";
import {
  cancelWorkspaceEvaluation,
  getWorkspace,
  listWorkspaces,
  promoteWorkspace,
  queueWorkspaceEvaluation,
  saveWorkspace,
  resolveModelProfile,
  WorkbenchError,
  type Database,
} from "@ehf/persistence";
import type { PlatformAction, Principal, ResourceRef } from "@ehf/identity";
import {
  importWorkspaceSource,
  listWorkspaceSources,
  workspaceTemplate,
} from "./workbench-sources.js";
import { startWorkbenchEvaluator } from "./workbench-evaluator.js";

export function registerWorkbench(
  app: FastifyInstance,
  options: {
    db: Database;
    env: NodeJS.ProcessEnv;
    authorize: (
      request: FastifyRequest,
      action: PlatformAction,
      resource?: ResourceRef,
    ) => Promise<Principal>;
  },
) {
  const sources = new Map<
    string,
    {
      at: number;
      bundle: Promise<{
        sourceId: string;
        kind: "skill" | "agent";
        name: string;
        files: Record<string, string>;
        config: ReturnType<typeof workspaceConfig>;
        digest: string;
      }>;
    }
  >();
  const auth = async (request: FastifyRequest, action: PlatformAction) => {
    const principal = await options.authorize(request, action, {
      kind: "source-workspace",
    });
    if (principal.actorType !== "human")
      throw new WorkbenchError("authorization.human_required", 403);
    return principal;
  };
  app.register(async (routes) => {
    routes.setErrorHandler((error, _request, reply) => {
      if (error instanceof WorkbenchError)
        return reply.code(error.status).send({ error: error.message });
      if (error instanceof Error && error.message.startsWith("workbench."))
        return reply.code(400).send({ error: error.message });
      if (error instanceof z.ZodError || error instanceof SyntaxError)
        return reply.code(400).send({
          error: "workbench.source_invalid",
          issues: error instanceof z.ZodError ? error.issues : [],
        });
      // Preserve the service's authorization handler.
      throw error;
    });
    routes.get("/v1/workbench/sources", async (request) => {
      await auth(request, "draft.read");
      return { items: await listWorkspaceSources(options.db, options.env) };
    });
    routes.get<{
      Params: { sourceId: string };
      Querystring: { kind?: string };
    }>(
      "/v1/workbench/sources/:sourceId",
      { bodyLimit: 10 * 1024 * 1024 },
      async (request, reply) => {
        const principal = await auth(request, "draft.read");
        const kind = z
          .enum(["skill", "agent"])
          .parse(
            request.query.kind ??
              (request.params.sourceId.startsWith("agent.")
                ? "agent"
                : "skill"),
          );
        const known = (
          await listWorkspaceSources(options.db, options.env)
        ).find(
          (item) => item.kind === kind && item.id === request.params.sourceId,
        );
        if (!known) throw new WorkbenchError("workbench.source_not_found", 404);
        const cacheKey = principal.tenantId + ":" + kind + ":" + known.id;
        let cached = sources.get(cacheKey);
        if (!cached || Date.now() - cached.at > 30_000) {
          const bundle = importWorkspaceSource(
            options.db,
            options.env,
            kind,
            known.id,
          ).then((files) => ({
            sourceId: known.id,
            kind,
            name: known.name,
            files,
            config: workspaceConfig(files),
            digest: stableDigest(files),
          }));
          cached = { at: Date.now(), bundle };
          sources.set(cacheKey, cached);
          bundle.catch(() => sources.delete(cacheKey));
          if (sources.size > 8) sources.delete(sources.keys().next().value!);
        }
        const bundle = await cached.bundle;
        const etag = '"' + bundle.digest + '"';
        reply.header("etag", etag).header("cache-control", "private, no-cache");
        if (request.headers["if-none-match"] === etag)
          return reply.code(304).send();
        return bundle;
      },
    );
    routes.get("/v1/workbench/workspaces", async (request) => {
      const p = await auth(request, "draft.read");
      return { items: await listWorkspaces(options.db, p.tenantId) };
    });
    routes.post(
      "/v1/workbench/workspaces",
      { bodyLimit: 10 * 1024 * 1024 },
      async (request, reply) => {
        const p = await auth(request, "draft.write");
        const input = createWorkspaceSchema.parse(request.body);
        const files =
          input.files ??
          (input.sourceId
            ? await importWorkspaceSource(
                options.db,
                options.env,
                input.kind,
                input.sourceId,
              )
            : workspaceTemplate(input.kind, input.name));
        if (workspaceConfig(files).kind !== input.kind)
          throw new WorkbenchError("workbench.kind_mismatch", 400);
        if (
          input.sourceId &&
          input.kind === "agent" &&
          files["skills/versions.json"]
        ) {
          const refs = [];
          for (const id of Object.keys(
            JSON.parse(files["skills/versions.json"]),
          )) {
            const childFiles = await importWorkspaceSource(
              options.db,
              options.env,
              "skill",
              id,
            );
            const child = await saveWorkspace(options.db, {
              tenantId: p.tenantId,
              actor: p.subjectId,
              files: childFiles,
              message: "Imported for agent " + input.sourceId,
            });
            refs.push({
              id: child.workspace.workspaceId,
              version: child.source.config.version,
              digest: child.source.digest,
            });
          }
          files["workbench.json"] = JSON.stringify(
            { ...workspaceConfig(files), skillRefs: refs },
            null,
            2,
          );
        }
        const result = await saveWorkspace(options.db, {
          tenantId: p.tenantId,
          actor: p.subjectId,
          files,
          message: input.sourceId
            ? "Imported " + input.sourceId
            : "Created workspace",
        });
        return reply.code(201).send(result);
      },
    );
    routes.get<{
      Params: { workspaceId: string };
      Querystring: { revision?: string };
    }>("/v1/workbench/workspaces/:workspaceId", async (request, reply) => {
      const p = await auth(request, "draft.read");
      const rev =
        request.query.revision === undefined
          ? undefined
          : z.coerce.number().int().positive().parse(request.query.revision);
      const view = await getWorkspace(
        options.db,
        p.tenantId,
        request.params.workspaceId,
        rev,
      );
      const etag =
        '"' +
        stableDigest({
          source: view.source.digest,
          head: view.workspace,
          history: view.history,
          promotions: view.promotions,
          evaluations: view.evaluations.map((report) => ({
            id: report.evaluationId,
            status: report.status,
            completedAt: report.completedAt,
          })),
        }) +
        '"';
      reply.header("etag", etag).header("cache-control", "private, no-cache");
      if (request.headers["if-none-match"] === etag)
        return reply.code(304).send();
      return view;
    });
    routes.put<{ Params: { workspaceId: string } }>(
      "/v1/workbench/workspaces/:workspaceId",
      { bodyLimit: 10 * 1024 * 1024 },
      async (request) => {
        const p = await auth(request, "draft.write");
        const input = saveWorkspaceSchema.parse(request.body);
        return saveWorkspace(options.db, {
          ...input,
          id: request.params.workspaceId,
          tenantId: p.tenantId,
          actor: p.subjectId,
        });
      },
    );
    routes.post<{ Params: { workspaceId: string } }>(
      "/v1/workbench/workspaces/:workspaceId/evaluations",
      { bodyLimit: 2 * 1024 * 1024 },
      async (request, reply) => {
        const p = await auth(request, "draft.evaluate");
        if (!options.env.WORKBENCH_EVALUATOR_BACKEND)
          throw new WorkbenchError("workbench.evaluator_not_configured", 503);
        const input = evaluateWorkspaceSchema.parse(request.body);
        const view = await getWorkspace(
          options.db,
          p.tenantId,
          request.params.workspaceId,
          input.revision,
        );
        const profileId =
          input.modelProfileId ?? view.source.config.modelProfileId;
        const profile = profileId
          ? await resolveModelProfile(options.db, {
              tenantId: p.tenantId,
              profileId,
            })
          : null;
        if (
          (profileId && !profile) ||
          (view.source.config.engine === "agent" && !profile)
        )
          throw new WorkbenchError("workbench.model_profile_required", 400);
        if (view.source.config.engine !== "agent" && profileId)
          throw new WorkbenchError(
            "workbench.model_requires_agent_engine",
            400,
          );
        const report = await queueWorkspaceEvaluation(options.db, {
          tenantId: p.tenantId,
          actor: p.subjectId,
          workspaceId: request.params.workspaceId,
          revision: input.revision,
          dataset: input.dataset,
          maxCostUsd: input.maxCostUsd,
          monthlyLimitUsd:
            options.env.METERED_MONTHLY_LIMIT_USD === undefined
              ? null
              : Number(options.env.METERED_MONTHLY_LIMIT_USD),
          modelProfileId: profileId,
          modelProfileDigest: profile?.digest ?? null,
          modelProfileRevision: profile?.revision ?? null,
        });
        return reply.code(202).send(report);
      },
    );
    routes.post<{ Params: { workspaceId: string } }>(
      "/v1/workbench/workspaces/:workspaceId/promotions",
      async (request) => {
        const input = z
          .object({
            revision: z.number().int().positive(),
            operation: z.enum(["approve", "publish"]),
            evaluationId: z.string(),
            reason: z.string().trim().min(3).max(500),
          })
          .strict()
          .parse(request.body);
        const p = await auth(
          request,
          input.operation === "approve" ? "draft.approve" : "draft.publish",
        );
        return promoteWorkspace(options.db, {
          ...input,
          id: request.params.workspaceId,
          tenantId: p.tenantId,
          actor: p.subjectId,
        });
      },
    );
    routes.post<{ Params: { evaluationId: string } }>(
      "/v1/workbench/evaluations/:evaluationId/cancel",
      async (request) => {
        const p = await auth(request, "draft.evaluate");
        await cancelWorkspaceEvaluation(
          options.db,
          p.tenantId,
          request.params.evaluationId,
        );
        return { cancelled: true };
      },
    );
    routes.get<{
      Params: { workspaceId: string };
      Querystring: { revision?: string };
    }>(
      "/v1/workbench/workspaces/:workspaceId/export",
      async (request, reply) => {
        const p = await auth(request, "draft.read");
        const rev =
          request.query.revision === undefined
            ? undefined
            : z.coerce.number().int().positive().parse(request.query.revision);
        const view = await getWorkspace(
          options.db,
          p.tenantId,
          request.params.workspaceId,
          rev,
        );
        reply.header(
          "content-disposition",
          `attachment; filename="${view.workspace.workspaceId}-r${view.source.revision}.json"`,
        );
        return { format: "ehf.source-bundle.v1", source: view.source };
      },
    );
  });
  if (
    options.env.WORKBENCH_EVALUATOR_BACKEND &&
    !["docker", "azure_jobs", "http"].includes(
      options.env.WORKBENCH_EVALUATOR_BACKEND,
    )
  )
    throw new Error("workbench.evaluator_backend_invalid");
  if (options.env.WORKBENCH_EVALUATOR_BACKEND)
    startWorkbenchEvaluator(app, options.db, options.env);
}
