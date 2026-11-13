import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { contextCheckRequestSchema, type ContextCheck } from "@ehf/contracts";
import {
  assertContextTarget,
  normalizeContextRows,
  runContextConnector,
} from "@ehf/context-connectors";
import {
  ContextSourceError,
  registerQualifiedContextConnector,
  loadContextBinding,
  recordContextCheck,
  type Database,
} from "@ehf/persistence";
import type { Principal, PlatformAction, ResourceRef } from "@ehf/identity";
import {
  sourceEndpointAllowed,
  sourceNativeEndpointAllowed,
} from "./source-policy.js";

/** Technical qualification is never a source-policy approval. Administrative probes use
 * deployment-granted destinations; workload reads still require the execution envelope,
 * approved source artifacts and the common acquire/transport/use evaluator. */
export function registerContextSourceChecks(
  app: FastifyInstance,
  options: {
    db: Database;
    env: NodeJS.ProcessEnv;
    fetch: typeof globalThis.fetch;
    authorize: (
      request: FastifyRequest,
      action: PlatformAction,
      resource?: ResourceRef,
    ) => Promise<Principal>;
  },
): void {
  app.post<{ Params: { bindingId: string } }>(
    "/v1/context-sources/bindings/:bindingId/checks",
    { bodyLimit: 65536 },
    async (request, reply) => {
      const principal = await options.authorize(request, "admin.write", {
        kind: "context-source",
        id: request.params.bindingId,
      });
      const parsed = contextCheckRequestSchema.safeParse(request.body);
      if (!parsed.success)
        return reply.code(400).send({ error: "context_source.check_invalid" });
      try {
        const { binding, connection } = await loadContextBinding(options.db, {
          tenantId: principal.tenantId,
          bindingId: request.params.bindingId,
          revision: parsed.data.expectedRevision,
        });
        const started = Date.now();
        let report: ContextCheck = {
          id: randomUUID(),
          bindingId: binding.definition.id,
          revision: binding.revision,
          bindingDigest: binding.digest,
          connectionDigest: connection.digest,
          kind: parsed.data.kind,
          status: "failed",
          schemaFingerprint: null,
          fields: [],
          rowCount: 0,
          truncated: false,
          error: null,
          checkedAt: new Date(started).toISOString(),
          expiresAt: new Date(started + 86400000).toISOString(),
          actor: principal.subjectId,
        };
        const runtime = {
          env: options.env,
          fetch: options.fetch,
          tenantId: principal.tenantId,
          checkTransport: async (url: URL) => {
            assertContextTarget(connection.definition, {
              env: options.env,
              tenantId: principal.tenantId,
            });
            const allowed =
              url.protocol === "https:"
                ? sourceEndpointAllowed(url, [connection.definition.endpoint])
                : sourceNativeEndpointAllowed(url, [
                    connection.definition.endpoint,
                  ]);
            if (!allowed) throw new Error("context_source.endpoint_denied");
          },
        };
        try {
          const result = await runContextConnector(
            connection.definition,
            binding.definition,
            parsed.data.parameters,
            runtime,
            parsed.data.kind === "discover",
          );
          if (parsed.data.kind !== "discover")
            normalizeContextRows(binding.definition, result, {
              tenantId: principal.tenantId,
              connectorId: `context-source:${binding.definition.id}.r${binding.revision}`,
              invocationId: report.id,
              bindingDigest: binding.digest,
              connectionDigest: connection.digest,
            });
          if (
            parsed.data.kind === "qualify" &&
            (result.truncated || !result.rows.length)
          )
            throw new Error(
              result.truncated
                ? "context_source.result_truncated"
                : "context_source.qualification_empty",
            );
          report = {
            ...report,
            status: "passed",
            schemaFingerprint: result.schemaFingerprint,
            fields: result.fields,
            rowCount: result.rows.length,
            truncated: result.truncated,
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : "";
          report.error = /^context_source\.[a-z_0-9]+$/.test(message)
            ? message
            : "context_source.probe_failed";
        }
        const saved = await recordContextCheck(
          options.db,
          principal.tenantId,
          report,
        );
        if (saved.status === "passed" && saved.kind === "qualify")
          await registerQualifiedContextConnector(
            options.db,
            principal.tenantId,
            binding.definition.id,
            binding.revision,
            connection.definition.provider,
          );
        return saved;
      } catch (error) {
        if (error instanceof ContextSourceError)
          return reply.code(error.status).send({ error: error.message });
        throw error;
      }
    },
  );
}
