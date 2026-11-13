import type { FastifyInstance, FastifyRequest } from "fastify";
import { verifyContextPackDigest, type ContextPack } from "@ehf/context-plane";
import { ContextStoreError, recordContextPack, type ContextStore } from "@ehf/context-store";
import { getRun, runTenant, type Database } from "@ehf/persistence";
import { contextPackRecordSchema, fencedRunSchema, type FencedRun } from "@ehf/runtime-state";
import { z } from "zod";
import { authorizeStateWrite, RuntimeStateAuthorityError } from "./runtime-state-routes.js";

export class ContextRecordError extends Error {
  constructor(readonly code: string, readonly httpStatus = 400) {
    super(code);
  }
}

/**
 * Record one context pack for the runtime (data-stores-plan.md §3.3). The runtime has no
 * database credential; it hands the pack to the control plane, which records it only when:
 *   - the runtime grant and the run's live fence still hold (as for every journal write),
 *   - the pack belongs to that run, its plan, its case and the named node,
 *   - the pack's digests recompute (verifyContextPackDigest), so nothing but an assembled
 *     pack can be recorded under a digest a later decision will cite.
 * The tenant is the run's, never one the caller names.
 */
export async function recordRuntimeContextPack(
  db: Database,
  store: ContextStore | null,
  grantToken: string | undefined,
  grantSecret: string,
  body: unknown,
  observe?: (tenantId: string, run: FencedRun, pack: ContextPack) => Promise<void>,
): Promise<{ recorded: boolean }> {
  const envelope = z.object({ run: fencedRunSchema }).passthrough().parse(body);
  const { run: _run, ...rest } = envelope as Record<string, unknown>;
  const input = contextPackRecordSchema.parse(rest);
  await authorizeStateWrite(db, grantToken, grantSecret, envelope.run);
  if (!store) throw new ContextRecordError("context_store.unavailable", 503);
  const [record, tenantId] = await Promise.all([getRun(db, envelope.run.runId), runTenant(db, envelope.run.runId)]);
  if (!record || !tenantId) throw new ContextRecordError("context.run_not_found", 404);
  const pack = input.pack as unknown as ContextPack;
  const runCase = record.input && typeof record.input === "object" ? (record.input as { caseId?: unknown }).caseId : undefined;
  if (pack.runId !== envelope.run.runId || pack.nodeId !== input.nodeId) throw new ContextRecordError("context.pack_identity_mismatch", 403);
  if (pack.planDigest.replace(/^sha256:/, "") !== record.planDigest.replace(/^sha256:/, "")) throw new ContextRecordError("context.plan_mismatch", 403);
  if ((typeof runCase === "string" ? runCase : null) !== input.caseId) throw new ContextRecordError("context.case_mismatch", 403);
  if (!verifyContextPackDigest(pack)) throw new ContextRecordError("context.pack_digest_invalid", 400);
  const manifest = pack.manifest;
  const result = await recordContextPack(store, {
    tenantId,
    caseId: input.caseId,
    runId: envelope.run.runId,
    nodeId: input.nodeId,
    attempt: envelope.run.attempt,
    pack,
    snapshot: manifest ? { snapshotId: manifest.caseSnapshotId, snapshotDigest: manifest.caseSnapshotDigest, caseSequence: manifest.caseSequence } : null,
  });
  if ((record.input as { sandboxObservation?: unknown } | null)?.sandboxObservation === true) {
    await observe?.(tenantId, envelope.run, pack);
  }
  return result;
}

export function registerContextRoutes(app: FastifyInstance, options: {
  db: Database;
  store: () => ContextStore | null;
  requireRuntime: (request: FastifyRequest) => Promise<unknown>;
  grantSecret: () => string;
  observe?: (tenantId: string, run: FencedRun, pack: ContextPack) => Promise<void>;
}): void {
  // Packs are bounded by the node's context budget (60,000 characters by default) plus the
  // agent profile's instructions; 4 MiB leaves room without accepting arbitrary bodies.
  app.post("/v1/runtime/context-packs", { bodyLimit: 4 * 1024 * 1024 }, async (request, reply) => {
    await options.requireRuntime(request);
    const header = request.headers["x-runtime-grant"];
    const grant = (Array.isArray(header) ? header[0] : header)?.trim();
    try {
      const result = await recordRuntimeContextPack(options.db, options.store(), grant, options.grantSecret(), request.body, options.observe);
      return reply.code(result.recorded ? 201 : 200).send(result);
    } catch (error) {
      if (error instanceof RuntimeStateAuthorityError || error instanceof ContextRecordError || error instanceof ContextStoreError) {
        return reply.code(error.httpStatus).send({ error: error.code });
      }
      if (error instanceof z.ZodError) return reply.code(400).send({ error: "context.request_invalid" });
      throw error;
    }
  });
}
