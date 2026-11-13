import { z } from "zod";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  saveContextRefreshScheduleSchema,
  type ContextRefreshSchedule,
} from "@ehf/contracts/context-refresh";
import { stableDigest, type HarnessPlanV2 } from "@ehf/contracts";
import { compileMapping } from "@ehf/context-mapping";
import { evaluateSourceAuthorization } from "@ehf/policy-engine";
import { assertContextSourceDestination } from "@ehf/context-postgres";
import {
  ContextSetupError,
  createRun,
  getRun,
  getPlan,
  getContextEnablement,
  getContextDefinition,
  loadSourceAuthority,
  requireExecutableRelease,
  listContextRefreshSchedules,
  saveContextRefreshSchedule,
  tickContextRefresh,
  retryContextRefresh,
  type ContextScope,
  type Database,
} from "@ehf/persistence";
import type { PlatformAction, Principal, ResourceRef } from "@ehf/identity";

/** Refresh plans have one acquisition/commit and no conditional or business-effect branches. */
export function assertRefreshPlan(
  plan: HarnessPlanV2,
  s: ContextRefreshSchedule,
  connectorId = `context-postgres:${s.mappingId}`,
) {
  const tools = plan.graph.nodes.filter((n) => n.kind === "tool");
  const node = tools[0];
  const writes = node?.config.caseWrites as
    Array<{ commandType?: string; payload?: unknown }> | undefined;
  const capability = plan.capabilities.find(
    (c) => c.id === node?.config.capabilityId,
  );
  if (
    tools.length !== 1 ||
    node?.id !== s.nodeId ||
    capability?.id !== "context.records.fetch.v1" ||
    capability.adapterBindingId !== connectorId ||
    plan.graph.nodes.some(
      (n) => !["input", "transform", "tool", "output"].includes(n.kind),
    ) ||
    plan.graph.nodes.some(
      (n) =>
        n.id !== node.id && (n.config.caseWrites || n.config.evidenceCapture),
    ) ||
    !writes ||
    writes.length !== 1 ||
    writes[0]?.commandType !== "RecordCanonicalRecords" ||
    JSON.stringify(writes[0].payload) !==
      JSON.stringify({ records: "{{output.records}}" }) ||
    node.config.usePredecessorInput !== true ||
    node.prompt ||
    node.config.skillId ||
    node.config.subjectAcquisition ||
    node.config.evidenceCapture ||
    plan.graph.edges.some((e) => e.condition || e.outcome)
  )
    throw new ContextSetupError("context.refresh_plan_invalid", 409);
  const inputs = plan.graph.nodes.filter((n) => n.kind === "input"),
    outputs = plan.graph.nodes.filter((n) => n.kind === "output"),
    transforms = plan.graph.nodes.filter((n) => n.kind === "transform");
  const projection = transforms[0];
  if (
    inputs.length !== 1 ||
    outputs.length !== 1 ||
    transforms.length !== 1 ||
    plan.graph.nodes.length !== 4 ||
    projection?.config.operation !== "project" ||
    JSON.stringify(projection.config.fields) !== JSON.stringify(["subjects"]) ||
    plan.graph.edges.length !== 3 ||
    ![
      [inputs[0]!.id, projection.id],
      [projection.id, node.id],
      [node.id, outputs[0]!.id],
    ].every(([from, to]) =>
      plan.graph.edges.some(
        (e) =>
          e.from === from &&
          e.to === to &&
          e.kind === "data" &&
          !e.sourcePath &&
          !e.targetPath,
      ),
    )
  )
    throw new ContextSetupError("context.refresh_plan_invalid", 409);
}
export function registerContextRefresh(
  app: FastifyInstance,
  o: {
    db: Database;
    env: NodeJS.ProcessEnv;
    authorize: (
      r: FastifyRequest,
      a: PlatformAction,
      resource?: ResourceRef,
    ) => Promise<Principal>;
    workload: (
      r: FastifyRequest,
      a: PlatformAction,
      resource?: ResourceRef,
    ) => Promise<Principal>;
  },
) {
  const environment =
    o.env.EHF_ENVIRONMENT ?? o.env.RELEASE_ENVIRONMENT ?? "local";
  const scope = (p: Principal) => ({ tenantId: p.tenantId, environment });
  const validate = async (s: ContextRefreshSchedule, sc: ContextScope) => {
    const enabled = await getContextEnablement(o.db, sc, s.mappingId);
    const m = await getContextDefinition(o.db, sc, "mapping", s.mappingId);
    if (
      !enabled ||
      enabled.paused ||
      enabled.revision !== s.enablementRevision ||
      enabled.mappingDigest !== s.mappingDigest ||
      m?.definition.kind !== "mapping" ||
      m.digest !== s.mappingDigest
    )
      throw new ContextSetupError(
        "context.refresh_qualification_changed",
        409,
      );
    const plan = await getPlan(o.db, s.planDigest, sc.tenantId);
    if (
      !plan ||
      enabled.authority.planDigest.replace(/^sha256:/, "") !==
        plan.planDigest.replace(/^sha256:/, "")
    )
      throw new ContextSetupError("context.refresh_plan_invalid", 409);
    assertRefreshPlan(plan, s);
    await requireExecutableRelease(
      o.db,
      sc.tenantId,
      plan.planDigest,
      o.env.RELEASE_ENVIRONMENT ?? environment,
    );
    const resource = await getContextDefinition(
      o.db,
      sc,
      "resource",
      m.definition.resourceId,
    );
    if (
      resource?.definition.kind !== "resource" ||
      resource.digest !== m.definition.resourceDigest
    )
      throw new ContextSetupError("context.resource_revision_changed", 409);
    const connection = await getContextDefinition(
      o.db,
      sc,
      "connection",
      resource.definition.connectionId,
    );
    if (
      connection?.definition.kind !== "connection" ||
      connection.digest !== resource.definition.connectionDigest ||
      connection.definition.identityMode !== "service" ||
      "api" in connection.definition || "api" in resource.definition
    )
      throw new ContextSetupError("context.connection_revision_changed", 409);
    const a = await loadSourceAuthority(o.db, {
      tenantId: sc.tenantId,
      caseId: s.caseId,
      plan,
      contextDigest: s.sourceContextDigest,
      capabilityId: "context.records.fetch.v1",
      connectorId: `context-postgres:${s.mappingId}`,
    });
    if (
      a.context.caseId !== s.caseId ||
      a.binding.mappingVersion !== compileMapping(m.definition).digest
    )
      throw new ContextSetupError("context.source_mapping_scope_denied", 403);
    assertContextSourceDestination(
      connection.definition,
      sc.tenantId,
      o.env,
      a.binding,
    );
    const decision = evaluateSourceAuthorization({
      ...a,
      capabilityId: "context.records.fetch.v1",
      connectorId: `context-postgres:${s.mappingId}`,
      evaluatedAt: new Date().toISOString(),
      request: {
        stage: "acquire",
        recipientId: sc.tenantId,
        redistribute: false,
      },
    });
    if (decision.outcome !== "ALLOW")
      throw new ContextSetupError("context.source_read_denied", 403);
  };
  const tick = (sc: ContextScope, id: string) =>
    tickContextRefresh(o.db, sc, id, {
      validate: (s) => validate(s, sc),
      start: async (s, key) =>
        (
          await createRun(o.db, {
            tenantId: sc.tenantId,
            planDigest: s.planDigest,
            sourceContextDigest: s.sourceContextDigest,
            idempotencyKey: key,
            runInput: {
              tenantId: sc.tenantId,
              caseId: s.caseId,
              subjects: s.subjects,
            },
          })
        ).run.runId,
      inspect: async (runId, s) => {
        const run = await getRun(o.db, runId, sc.tenantId);
        if (!run)
          return { status: "failed", errorCode: "context.refresh_run_missing" };
        if (["queued", "retrying", "running"].includes(run.status))
          return { status: "pending" };
        if (run.status !== "completed")
          return {
            status: "failed",
            errorCode: run.errorCode ?? "context.refresh_run_failed",
          };
        const receipt = await o.db.query<{ sequence: number }>(
          `select sequence from harness_runtime.run_events where run_id=$1 and node_id=$2 and code='case.write.completed' and status='passed' and values->>'commandType'='RecordCanonicalRecords' order by sequence desc limit 1`,
          [runId, s.nodeId],
        );
        if (!receipt.rows.length)
          return {
            status: "failed",
            errorCode: "context.refresh_commit_missing",
          };
        return {
          status: "completed",
          receiptDigest: stableDigest({
            runId,
            nodeId: s.nodeId,
            eventSequence: receipt.rows[0]!.sequence,
            output: run.output,
          }),
        };
      },
    });
  const wrap =
    (
      action: PlatformAction,
      fn: (r: FastifyRequest, p: Principal) => Promise<unknown>,
      workload = false,
    ) =>
    async (r: FastifyRequest, reply: any) => {
      reply.header("cache-control", "no-store");
      const p = await (workload ? o.workload : o.authorize)(r, action, {
        kind: "context-refresh",
      });
      if (workload ? p.actorType === "human" : p.actorType !== "human")
        return reply
          .code(403)
          .send({ error: "authorization.actor_type_invalid" });
      try {
        return await fn(r, p);
      } catch (e) {
        if (e instanceof ContextSetupError)
          return reply.code(e.status).send({ error: e.code });
        if (e instanceof z.ZodError)
          return reply
            .code(400)
            .send({ error: "context.refresh_request_invalid" });
        if (
          e instanceof Error &&
          /^(release|source_policy|artifact)\./.test(e.message)
        )
          return reply
            .code(409)
            .send({ error: "context.refresh_authority_unavailable" });
        throw e;
      }
    };
  app.get(
    "/v1/context/refresh-schedules",
    wrap("draft.read", async (r, p) => ({
      schedules: await listContextRefreshSchedules(
        o.db,
        scope(p),
        (r.query as { mappingId?: string }).mappingId,
      ),
    })),
  );
  app.post(
    "/v1/context/refresh-schedules",
    wrap("release.activate", async (r, p) => {
      const input = saveContextRefreshScheduleSchema.parse(r.body);
      if (input.schedule.enabled) await validate(input.schedule, scope(p));
      return saveContextRefreshSchedule(o.db, scope(p), {
        ...input,
        actor: p.subjectId,
      });
    }),
  );
  app.post(
    "/v1/context/refresh-schedules/:id/tick",
    wrap("run.start", async (r, p) =>
      tick(scope(p), (r.params as { id: string }).id),
    ),
  );
  app.post(
    "/v1/context/refresh-schedules/:id/retry",
    wrap("run.retry", async (r, p) => {
      const input = z
        .object({ expectedRevision: z.number().int().positive() })
        .strict()
        .parse(r.body);
      return retryContextRefresh(
        o.db,
        scope(p),
        (r.params as { id: string }).id,
        input.expectedRevision,
      );
    }),
  );
  app.post(
    "/internal/context/refresh:tick",
    wrap(
      "context.refresh",
      async (_r, p) => {
        const sc = scope(p),
          schedules = await listContextRefreshSchedules(o.db, sc);
        const results = [];
        for (const s of schedules)
          results.push({ id: s.id, ...(await tick(sc, String(s.id))) });
        return { results };
      },
      true,
    ),
  );
}
