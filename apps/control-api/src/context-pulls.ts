import { z } from "zod";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import {
  BANK_CONTEXT_RECORD_TYPES,
  contextCaseBindingSaveSchema,
  contextPullRequestSchema,
} from "@ehf/contracts/context-setup";
import {
  contextDatasetId,
  contextSourceFields,
  stableDigest,
  type ContextCaseBinding,
} from "@ehf/contracts";
import { compileMapping } from "@ehf/context-mapping";
import { assertContextSourceDestination } from "@ehf/context-bank-connectors";
import { evaluateSourceAuthorization } from "@ehf/policy-engine";
import {
  ContextSetupError,
  getContextDefinition,
  getContextEnablement,
  getPlan,
  loadSourceAuthority,
  requireExecutableRelease,
  saveContextDefinition,
  listContextDefinitions,
  createRun,
  getRun,
  type Database,
  type ContextScope,
} from "@ehf/persistence";
import type { PlatformAction, Principal, ResourceRef } from "@ehf/identity";
import { assertRefreshPlan } from "./context-refresh.js";

type Options = {
  db: Database;
  env: NodeJS.ProcessEnv;
  authorize: (
    r: FastifyRequest,
    a: PlatformAction,
    resource?: ResourceRef,
  ) => Promise<Principal>;
};
const deny = (code: string, status = 409): never => {
  throw new ContextSetupError(`context.${code}`, status);
};
export function sourceKeysForCase(
  binding: ContextCaseBinding,
  subjects: string[],
): string[] {
  if (
    !subjects.length ||
    subjects.length > 20 ||
    new Set(subjects).size !== subjects.length ||
    subjects.some((id) => !binding.subjects.some((s) => s.subjectId === id))
  )
    deny("case_subject_scope_denied", 403);
  return binding.subjects
    .filter((s) => subjects.includes(s.subjectId))
    .map((s) => s.sourceKey);
}
/** All writes use an already admitted, dedicated acquisition plan and the normal run queue. */
export function registerContextPulls(app: FastifyInstance, o: Options) {
  const scope = (p: Principal): ContextScope => ({
    tenantId: p.tenantId,
    environment: o.env.EHF_ENVIRONMENT ?? o.env.RELEASE_ENVIRONMENT ?? "local",
  });
  const validate = async (b: ContextCaseBinding, p: Principal) => {
    const sc = scope(p),
      enabled = await getContextEnablement(o.db, sc, b.mappingId);
    const m = await getContextDefinition(o.db, sc, "mapping", b.mappingId);
    if (
      !b.enabled ||
      !enabled ||
      enabled.paused ||
      enabled.revision !== b.enablementRevision ||
      m?.definition.kind !== "mapping" ||
      m.digest !== b.mappingDigest ||
      enabled.mappingDigest !== b.mappingDigest
    )
      deny("pull_qualification_changed");
    const mapping = m!.definition;
    if (mapping.kind !== "mapping") return deny("mapping_not_found");
    const plan = await getPlan(o.db, b.planDigest, p.tenantId);
    if (
      !plan ||
      enabled!.authority.planDigest.replace(/^sha256:/, "") !== b.planDigest
    )
      deny("pull_plan_invalid");
    await requireExecutableRelease(
      o.db,
      p.tenantId,
      b.planDigest,
      o.env.RELEASE_ENVIRONMENT ?? sc.environment,
    );
    const resource = await getContextDefinition(
      o.db,
      sc,
      "resource",
      mapping.resourceId,
    );
    if (
      resource?.definition.kind !== "resource" ||
      resource.digest !== mapping.resourceDigest
    )
      return deny("resource_revision_changed");
    const connection = await getContextDefinition(
      o.db,
      sc,
      "connection",
      resource.definition.connectionId,
    );
    if (
      connection?.definition.kind !== "connection" ||
      connection.digest !== resource.definition.connectionDigest
    )
      return deny("connection_revision_changed");
    if (
      mapping.outputs.some(
        (output) => !BANK_CONTEXT_RECORD_TYPES.has(output.objectType),
      )
    )
      deny("source_record_type_denied", 403);
    const acquisition = plan!.graph.nodes.find((n) => n.id === b.nodeId);
    if (
      !acquisition?.contextSelectorIds.length ||
      acquisition.contextSelectorIds.some((id) => {
        const selector = plan!.contextSelectors.find((s) => s.id === id);
        return (
          !selector ||
          selector.source !== "case" ||
          !(selector.path === "case" || selector.path.startsWith("case."))
        );
      })
    )
      deny("pull_case_metadata_selector_required");
    const connectorId = connection.definition.connectorId;
    if (
      !("api" in connection.definition) ||
      !("api" in resource.definition) ||
      connectorId !== `context-${connection.definition.api.kind}:${b.mappingId}`
    )
      deny("pull_connector_invalid");
    try {
      assertRefreshPlan(
        plan!,
        { nodeId: b.nodeId, mappingId: b.mappingId } as never,
        connectorId,
      );
    } catch {
      deny("pull_plan_invalid");
    }
    const authority = await loadSourceAuthority(o.db, {
      tenantId: p.tenantId,
      caseId: b.caseId,
      plan: plan!,
      contextDigest: b.sourceContextDigest,
      capabilityId: "context.records.fetch.v1",
      connectorId,
    });
    if (
      authority.context.caseId !== b.caseId ||
      authority.binding.mappingVersion !== compileMapping(mapping).digest ||
      !authority.binding.datasetIds.includes(
        contextDatasetId(resource.definition),
      ) ||
      !contextSourceFields(resource.definition).every((f) =>
        authority.binding.fields.includes(f),
      )
    )
      deny("source_mapping_scope_denied", 403);
    assertContextSourceDestination(
      connection.definition,
      p.tenantId,
      o.env,
      authority.binding,
    );
    const decision = evaluateSourceAuthorization({
      ...authority,
      capabilityId: "context.records.fetch.v1",
      connectorId,
      evaluatedAt: new Date().toISOString(),
      request: {
        stage: "acquire",
        recipientId: p.tenantId,
        redistribute: false,
      },
    });
    if (decision.outcome !== "ALLOW") deny("source_read_denied", 403);
  };
  const wrap =
    (
      action: PlatformAction,
      fn: (r: FastifyRequest, p: Principal) => Promise<unknown>,
    ) =>
    async (r: FastifyRequest, reply: FastifyReply) => {
      reply.header("cache-control", "no-store");
      const caseId = (r.params as { caseId: string }).caseId;
      const p = await o.authorize(r, action, { kind: "case", id: caseId });
      await o.authorize(r, "case.read", { kind: "case", id: caseId });
      if (p.actorType !== "human")
        return reply
          .code(403)
          .send({ error: "authorization.interactive_user_required" });
      try {
        return await fn(r, p);
      } catch (e) {
        if (e instanceof ContextSetupError)
          return reply.code(e.status).send({ error: e.code });
        if (e instanceof z.ZodError)
          return reply
            .code(400)
            .send({ error: "context.pull_request_invalid" });
        if (
          e instanceof Error &&
          /^(release|artifact|source_policy|run)\./.test(e.message)
        )
          return reply
            .code(409)
            .send({ error: "context.pull_authority_unavailable" });
        throw e;
      }
    };
  const publicBinding = (
    revision: Awaited<ReturnType<typeof getContextDefinition>>,
  ) => {
    if (revision?.definition.kind !== "case-binding") return null;
    const { subjects, ...definition } = revision.definition;
    return {
      ...revision,
      definition: { ...definition, subjects: subjects.map((s) => s.subjectId) },
    };
  };
  app.get(
    "/v1/context/cases/:caseId/bindings",
    wrap("case.read", async (r, p) => {
      const caseId = (r.params as { caseId: string }).caseId;
      const items = (await listContextDefinitions(o.db, scope(p))).filter(
        (x) =>
          x.definition.kind === "case-binding" &&
          x.definition.caseId === caseId,
      );
      return { items: items.map(publicBinding) };
    }),
  );
  app.post(
    "/v1/context/cases/:caseId/bindings",
    wrap("release.activate", async (r, p) => {
      const input = contextCaseBindingSaveSchema.parse(r.body);
      if (input.binding.caseId !== (r.params as { caseId: string }).caseId)
        deny("case_binding_scope_denied", 403);
      const prior = await getContextDefinition(
        o.db,
        scope(p),
        "case-binding",
        input.binding.id,
      );
      if (
        prior?.definition.kind === "case-binding" &&
        prior.definition.caseId !== input.binding.caseId
      )
        deny("case_binding_scope_denied", 403);
      if (input.binding.enabled) await validate(input.binding, p);
      return publicBinding(
        await saveContextDefinition(o.db, scope(p), {
          definition: input.binding,
          expectedRevision: input.expectedRevision,
          reason: input.reason,
          actor: p.subjectId,
        }),
      );
    }),
  );
  app.post(
    "/v1/context/cases/:caseId/pulls",
    wrap("run.start", async (r, p) => {
      const input = contextPullRequestSchema.parse(r.body),
        sc = scope(p);
      const rev = await getContextDefinition(
        o.db,
        sc,
        "case-binding",
        input.bindingId,
      );
      if (
        rev?.definition.kind !== "case-binding" ||
        rev.definition.caseId !== (r.params as { caseId: string }).caseId ||
        rev.digest !== input.expectedBindingDigest
      )
        return deny("case_binding_scope_denied", 403);
      const b = rev.definition,
        subjects = sourceKeysForCase(b, input.subjects);
      await validate(b, p);
      const result = await createRun(o.db, {
        tenantId: p.tenantId,
        planDigest: b.planDigest,
        sourceContextDigest: b.sourceContextDigest,
        idempotencyKey: `context-pull:${stableDigest({ tenant: p.tenantId, case: b.caseId, key: input.idempotencyKey })}`,
        runInput: {
          tenantId: p.tenantId,
          caseId: b.caseId,
          subjects,
          canonicalSubjects: b.subjects
            .filter((s) => input.subjects.includes(s.subjectId))
            .map((s) => s.subjectId),
          contextPullBinding: { id: b.id, digest: rev.digest },
          actorId: p.subjectId,
          contextPullNodeId: b.nodeId,
          contextEnvironment: sc.environment,
        },
      });
      return {
        runId: result.run.runId,
        status: result.run.status,
        created: result.created,
        committed: false,
      };
    }),
  );
  app.get(
    "/v1/context/cases/:caseId/pulls",
    wrap("case.read", async (r, p) => {
      const caseId = (r.params as { caseId: string }).caseId;
      const rows = await o.db.query<{ run_id: string }>(
        `select run_id from harness_runtime.runs where tenant_id=$1 and input->>'caseId'=$2 and input ? 'contextPullBinding' order by created_at desc limit 20`,
        [p.tenantId, caseId],
      );
      const items = [];
      for (const row of rows.rows) {
        const run = await getRun(o.db, row.run_id, p.tenantId);
        if (!run) continue;
        const input = run.input as {
          contextPullBinding: { id: string; digest: string };
          canonicalSubjects: string[];
          caseId: string;
          contextPullNodeId: string;
        };
        if (
          input.caseId !== caseId ||
          typeof input.contextPullNodeId !== "string"
        )
          continue;
        if (
          typeof input.contextPullBinding?.id !== "string" ||
          typeof input.contextPullBinding.digest !== "string"
        )
          continue;
        const pinned = await getContextDefinition(
          o.db,
          scope(p),
          "case-binding",
          input.contextPullBinding.id,
          input.contextPullBinding.digest,
        );
        if (
          pinned?.definition.kind !== "case-binding" ||
          pinned.definition.caseId !== caseId ||
          pinned.definition.planDigest !== run.planDigest ||
          pinned.definition.nodeId !== input.contextPullNodeId
        )
          continue;
        const receipt = await o.db.query<{ sequence: number }>(
          `select sequence from harness_runtime.run_events where run_id=$1 and node_id=$2 and code='case.write.completed' and status='passed' and values->>'commandType'='RecordCanonicalRecords' order by sequence desc limit 1`,
          [run.runId, input.contextPullNodeId],
        );
        const committed = run.status === "completed" && receipt.rows.length > 0;
        items.push({
          runId: run.runId,
          bindingId: input.contextPullBinding.id,
          subjects: input.canonicalSubjects,
          status:
            run.status === "completed" && !committed ? "failed" : run.status,
          committed,
          errorCode:
            run.status === "completed" && !committed
              ? "context.pull_commit_missing"
              : run.errorCode,
          createdAt: run.createdAt,
          completedAt: run.completedAt,
          receiptDigest: committed
            ? stableDigest({
                runId: run.runId,
                sequence: receipt.rows[0]!.sequence,
              })
            : null,
        });
      }
      return { items };
    }),
  );
}
