import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ContextPack } from "@ehf/context-plane";
import { sandboxReleasesAllowed, runTenant, type Database } from "@ehf/persistence";
import { fencedRunSchema, sandboxContextObservationSchema, sandboxRuntimeObservationSchema, sandboxPayloadShape, type FencedRun, type SandboxObservation } from "@ehf/runtime-state";
import { z } from "zod";
import { authorizeStateWrite, RuntimeStateAuthorityError } from "./runtime-state-routes.js";
import { withSandboxTenant } from "./sandbox-history.js";

const retentionDays = 14;
const maxObservations = 512;
const pageSize = 16;

const reference = (value: unknown) => typeof value === "string" && /^[a-zA-Z0-9_.:/@-]{1,220}$/.test(value) ? value : null;

export function sandboxContextObservation(pack: ContextPack): SandboxObservation | null {
  const manifest = pack.manifest;
  const result = sandboxContextObservationSchema.safeParse({
    kind: "context", key: pack.packDigest, nodeId: pack.nodeId, invocationId: null,
    data: {
      packDigest: pack.packDigest, manifestDigest: manifest?.manifestDigest ?? null,
      snapshotId: reference(manifest?.caseSnapshotId), snapshotDigest: manifest?.caseSnapshotDigest ?? null,
      caseSequence: manifest?.caseSequence ?? null, usedChars: pack.budget.usedChars,
      sections: pack.sections.slice(0, 30).map(section => ({
        id: section.id, kind: section.kind, digest: section.contentDigest,
        source: /^(case:|run:|receipt:|evidence:)/.test(section.provenanceRef) ? reference(section.provenanceRef) : null,
        required: section.required,
        state: section.quarantined ? "Quarantined" : pack.budget.droppedSectionIds.includes(section.id) ? "Dropped by budget" : "Included",
        items: Array.isArray(section.value) ? section.value.length : null,
        fields: section.quarantined || pack.budget.droppedSectionIds.includes(section.id) ? [] :
          (sandboxPayloadShape(section.value)?.fields ?? []).filter(field => field.path.includes("/") && field.type !== "omitted").slice(0, 8).map(field => field.path),
      })),
      gaps: (pack.recordGaps ?? []).slice(0, 20).map(({ selector, objectType, code, required }) => ({ selector, objectType, code, required })),
      truncated: pack.sections.length > 30 || (pack.recordGaps?.length ?? 0) > 20,
    },
  });
  return result.success ? result.data : null;
}

/** The launch's server-side capture flag is established in the same transaction that queues the run. */
export async function recordSandboxObservation(db: Database, tenantId: string, run: FencedRun, observation: SandboxObservation) {
  const payload = JSON.stringify(observation.data);
  if (Buffer.byteLength(payload, "utf8") > 14_000) return;
  await withSandboxTenant(db, { tenantId }, async client => {
    // Serialize the run's capture budget and enforce the fence at the write itself.
    const eligible = await client.query(`
      select run_id from harness_runtime.runs
      where tenant_id=$1 and run_id=$2 and sandbox_capture and status='running' and attempt=$3 and fencing_epoch=$4
      for update
    `, [tenantId, run.runId, run.attempt, run.fencingEpoch]);
    if (!eligible.rowCount) return;
    await client.query(`
      insert into harness_control.sandbox_observations
        (tenant_id,run_id,node_id,attempt,fencing_epoch,kind,observation_key,invocation_id,data)
      select $1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb
      where exists (
        select from harness_runtime.node_attempts where run_id=$2 and node_id=$3 and attempt=$4 and fencing_epoch=$5
      ) and (
        select count(*) from harness_control.sandbox_observations where tenant_id=$1 and run_id=$2
      ) < $10
      on conflict do nothing
    `, [tenantId, run.runId, observation.nodeId, run.attempt, run.fencingEpoch,
      observation.kind, observation.key, observation.invocationId, payload, maxObservations]);
  });
}

const numeric = z.string().regex(/^\d{1,15}$/).transform(Number);
export const sandboxObservationQuery = z.object({
  kind: z.enum(["context", "skill", "documents"]), nodeId: z.string().min(1).max(220).optional(),
  attempt: numeric.pipe(z.number().int().max(2_147_483_647)).optional(),
  fencingEpoch: numeric.optional(), before: numeric.optional(),
}).strict();

type Query = z.infer<typeof sandboxObservationQuery>;
type StoredObservation = {
  sequence: string; node_id: string; attempt: number; fencing_epoch: string; kind: SandboxObservation["kind"];
  observation_key: string; invocation_id: string | null; version: number; data: SandboxObservation["data"];
  recorded_at: Date; expires_at: Date;
};

export async function readSandboxObservations(db: Database, tenantId: string, actor: string, runId: string, query: Query) {
  return withSandboxTenant(db, { tenantId }, async client => {
    const filters = [tenantId, runId, query.kind, query.nodeId ?? null, query.attempt ?? null, query.fencingEpoch ?? null];
    const result = await client.query<StoredObservation>(`
      select sequence,node_id,attempt,fencing_epoch,kind,observation_key,invocation_id,version,data,recorded_at,expires_at
      from harness_control.sandbox_observations
      where tenant_id=$1 and run_id=$2 and kind=$3
        and ($4::text is null or node_id=$4)
        and ($5::int is null or attempt=$5) and ($6::bigint is null or fencing_epoch=$6)
        and ($7::bigint is null or sequence<$7) and expires_at>now()
      order by sequence desc limit $8
    `, [...filters, query.before ?? null, pageSize + 1]);
    if (result.rows.length) {
      await client.query(`
        insert into harness_control.sandbox_observation_reads (tenant_id,run_id,kind,node_id,attempt,fencing_epoch,actor)
        values ($1,$2,$3,$4,$5,$6,$7)
      `, [...filters, actor]);
    }
    const page = result.rows.slice(0, pageSize);
    return {
      items: page.map(row => ({
        sequence: Number(row.sequence), nodeId: row.node_id, attempt: row.attempt, fencingEpoch: Number(row.fencing_epoch),
        kind: row.kind, key: row.observation_key, invocationId: row.invocation_id, version: row.version, data: row.data,
        recordedAt: row.recorded_at.toISOString(), expiresAt: row.expires_at.toISOString(),
      })),
      nextBefore: result.rows.length > pageSize ? Number(page.at(-1)?.sequence) : null,
      retentionDays,
    };
  });
}

export function registerSandboxObservationWrites(app: FastifyInstance, options: {
  db: Database; env: NodeJS.ProcessEnv; requireRuntime(request: FastifyRequest): Promise<unknown>; grantSecret(): string;
}) {
  const enabled = sandboxReleasesAllowed(options.env.RELEASE_ENVIRONMENT ?? "development", options.env);
  if (enabled) {
    // Best-effort housekeeping: whatever goes wrong here, including a failure before the query
    // returns a promise, is logged and must never stop the service from starting.
    const prune = () => void (async () => {
      try {
        await options.db.query("select harness_control.prune_sandbox_observations()");
      } catch {
        app.log.warn("Sandbox observation cleanup unavailable");
      }
    })();
    const timer = setInterval(prune, 15 * 60_000).unref();
    app.addHook("onReady", async () => { prune(); });
    app.addHook("onClose", async () => { clearInterval(timer); });
  }

  app.post("/v1/runtime/sandbox-observations", { bodyLimit: 32_768 }, async (request, reply) => {
    await options.requireRuntime(request);
    if (!enabled) return reply.code(204).send();
    const parsed = z.object({ run: fencedRunSchema }).passthrough().safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "sandbox.observation_invalid" });
    const { run, ...value } = parsed.data;
    const observation = sandboxRuntimeObservationSchema.safeParse(value);
    if (!observation.success) return reply.code(400).send({ error: "sandbox.observation_invalid" });
    if (observation.data.invocationId && !observation.data.invocationId.startsWith(`${run.runId}:${observation.data.nodeId}:`)) {
      return reply.code(400).send({ error: "sandbox.observation_invocation_mismatch" });
    }
    const header = request.headers["x-runtime-grant"];
    try {
      await authorizeStateWrite(options.db, (Array.isArray(header) ? header[0] : header)?.trim(), options.grantSecret(), run);
      const tenantId = await runTenant(options.db, run.runId);
      if (tenantId) await recordSandboxObservation(options.db, tenantId, run, observation.data);
      return reply.code(204).send();
    } catch (error) {
      if (error instanceof RuntimeStateAuthorityError) return reply.code(error.httpStatus).send({ error: error.code });
      request.log.warn("Sandbox observation write unavailable");
      return reply.code(503).send({ error: "sandbox.observation_unavailable" });
    }
  });
}
