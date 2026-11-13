import {
  contextSampleRequestSchema,
  saveContextDefinitionSchema,
} from "@ehf/contracts/context-setup";
import { selectRecordSection } from "@ehf/context-plane";
import { mintContextPreviewProof } from "@ehf/execution-auth";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import {
  stableDigest,
  contextDatasetId,
  contextSourceFields,
  skillBindingForNode,
  agentProfileForNode,
  type ContextSampleReport,
  type ContextSetupConnection,
  type ContextResourceBinding,
  type ContextDefinitionRevision,
  type CanonicalMapping,
} from "@ehf/contracts";
import {
  assertBoundedContextInput,
  compileMapping,
  createContextMappingTemplate,
  CONTEXT_MAPPING_TEMPLATES,
  executeMapping,
  evaluateExpression,
} from "@ehf/context-mapping";
import {
  canonicalSchemaMetadata,
  canonicalRelationships,
} from "@ehf/library-contracts";
import { readCanonicalCatalog } from "@ehf/fincrime-integration";
import { evaluateSourceAuthorization } from "@ehf/policy-engine";
import {
  activateContextMapping,
  getContextEnablement,
  pauseContextMapping,
  requireExecutableRelease,
  ContextSetupError,
  getContextDefinition,
  getContextSample,
  getPlan,
  getSourceArtifact,
  getSourceDecision,
  listContextDefinitions,
  listContextSampleHistory,
  loadSourceAuthority,
  saveContextDefinition,
  saveContextSample,
  type Database,
  type ContextScope,
} from "@ehf/persistence";
import type { PlatformAction, Principal, ResourceRef } from "@ehf/identity";
import {
  assertResourceScope,
  assertContextSourceDestination,
  contextSourceCredential,
  discoverContextResource,
  fetchContextSample,
} from "./context-postgres.js";
export function contextCatalog(env: NodeJS.ProcessEnv) {
  const path =
    env.FINCRIME_CATALOG_PATH ??
    fileURLToPath(
      new URL("../../fincrime-host/catalog/ehf-catalog.json", import.meta.url),
    );
  const artifact = JSON.parse(readFileSync(path, "utf8"));
  const catalog = readCanonicalCatalog(artifact, artifact.sha256);
  return { catalogDigest: artifact.sha256 as string, ...catalog };
}
export function registerContextSetupRoutes(
  app: FastifyInstance,
  options: {
    db: Database;
    env: NodeJS.ProcessEnv;
    authorize: (
      r: FastifyRequest,
      a: PlatformAction,
      resource?: ResourceRef,
    ) => Promise<Principal>;
  },
) {
  const environment =
    options.env.EHF_ENVIRONMENT ?? options.env.RELEASE_ENVIRONMENT ?? "local";
  const handle =
    (
      action: PlatformAction,
      fn: (
        r: FastifyRequest,
        p: Principal,
        s: ContextScope,
      ) => Promise<unknown>,
    ) =>
    async (r: FastifyRequest, reply: FastifyReply) => {
      reply.header("cache-control", "no-store");
      const p = await options.authorize(r, action, { kind: "context-source" });
      if (
        options.env.AUTHORING_MODE === "disabled" &&
        ["draft.write", "draft.compile", "draft.evaluate"].includes(action)
      )
        return reply.code(404).send({ error: "authoring.disabled" });
      if (p.actorType !== "human")
        return reply
          .code(403)
          .send({ error: "authorization.interactive_user_required" });
      try {
        if (r.body !== undefined) assertBoundedContextInput(r.body);
        return await fn(r, p, { tenantId: p.tenantId, environment });
      } catch (e) {
        if (e instanceof ContextSetupError)
          return reply.code(e.status).send({ error: e.code });
        if (e instanceof Error && /^(source_policy|artifact)\./.test(e.message))
          return reply
            .code(403)
            .send({ error: "context.source_authority_denied" });
        if (
          e instanceof Error &&
          /^context\.(mapping_|identity_|source_value_)/.test(e.message)
        )
          return reply.code(400).send({ error: e.message });
        if (e instanceof z.ZodError)
          return reply.code(400).send({
            error: "context.request_invalid",
            issues: e.issues
              .map((i) => ({ path: i.path, code: i.code }))
              .slice(0, 20),
          });
        throw e;
      }
    };
  const chain = async (scope: ContextScope, mapping: CanonicalMapping) => {
    const resource = await getContextDefinition(
      options.db,
      scope,
      "resource",
      mapping.resourceId,
    );
    if (
      !resource ||
      resource.definition.kind !== "resource" ||
      resource.digest !== mapping.resourceDigest
    )
      throw new ContextSetupError("context.resource_revision_changed", 409);
    const connection = await getContextDefinition(
      options.db,
      scope,
      "connection",
      resource.definition.connectionId,
    );
    if (
      !connection ||
      connection.definition.kind !== "connection" ||
      connection.digest !== resource.definition.connectionDigest
    )
      throw new ContextSetupError("context.connection_revision_changed", 409);
    assertResourceScope(connection.definition, resource.definition);
    return {
      resource: resource as ContextDefinitionRevision & {
        definition: ContextResourceBinding;
      },
      connection: connection as ContextDefinitionRevision & {
        definition: ContextSetupConnection;
      },
    };
  };
  app.get(
    "/v1/context/mapping-templates",
    handle("draft.read", async (r, p, scope) => {
      const input = z
        .object({
          resourceId: z.string().min(1),
          template: z.enum(CONTEXT_MAPPING_TEMPLATES),
        })
        .parse(r.query);
      const resource = await getContextDefinition(
        options.db,
        scope,
        "resource",
        input.resourceId,
      );
      if (resource?.definition.kind !== "resource")
        throw new ContextSetupError("context.resource_not_found", 404);
      const catalog = contextCatalog(options.env);
      return {
        mapping: createContextMappingTemplate(
          input.template,
          {
            kind: "mapping",
            id: `${resource.definition.id.slice(0, 100)}-${input.template}`,
            name: `${input.template} mapping`,
            productId:
              input.template === "identity"
                ? "identity.intelligence"
                : input.template === "source-evidence"
                  ? "evidence.intelligence"
                  : input.template === "transaction"
                    ? "transaction.intelligence"
                    : input.template === "risk"
                      ? "risk.intelligence"
                      : input.template === "application" ||
                          input.template === "holding"
                        ? "platform.application.v1"
                        : "party360",
            resourceId: resource.definition.id,
            resourceDigest: resource.digest,
            schemaVersion: canonicalSchemaMetadata().schemaVersion,
            catalogDigest: catalog.catalogDigest,
          },
          resource.definition.connectionId,
          resource.definition.subjectColumn,
          resource.definition.columns,
        ),
        limitations: [
          "Template fields are suggestions. Resolve canonical references explicitly; source identifiers from different systems are not interchangeable.",
          "Application and holding v1 are platform contracts; existing library skills have no automatic subscription.",
        ],
      };
    }),
  );
  app.post(
    "/v1/context/preview-target",
    handle("draft.read", async (r, p) => {
      const input = z
        .object({
          planDigest: z.string().regex(/^(sha256:)?[a-f0-9]{64}$/),
          nodeId: z.string().min(1),
          agentId: z.string().min(1),
          taskId: z.string().min(1),
        })
        .strict()
        .parse(r.body);
      const plan = await getPlan(options.db, input.planDigest, p.tenantId);
      const catalog = contextCatalog(options.env);
      const task = catalog.tasks.find((t) => t.value.id === input.taskId);
      const agent = catalog.agents.find((a) => a.value.id === input.agentId);
      const node = plan?.graph.nodes.find((n) => n.id === input.nodeId);
      const steps = task?.value.steps as
        | Array<{ skill_id: string; skill_version: string }>
        | undefined;
      if (
        !plan ||
        !node ||
        !task ||
        !agent ||
        task.value.agent_profile !== input.agentId
      )
        throw new ContextSetupError("context.preview_target_not_found", 404);
      const step = steps?.find((step) => step.skill_id === node.config.skillId);
      const skillMatch =
        step &&
        skillBindingForNode(plan, node.id)?.semver === step.skill_version;
      const profile = node.config.agentRef
        ? agentProfileForNode(plan, node.id)
        : null;
      const agentMatch =
        node.config.agentRef === input.agentId &&
        profile?.version === agent.value.version;
      if (!skillMatch && !agentMatch)
        throw new ContextSetupError("context.preview_task_node_mismatch", 403);
      return { plan, nodeId: node.id };
    }),
  );
  app.post(
    "/v1/context/preview-authority",
    handle("case.read", async (r, p) => {
      const input = z
        .object({
          caseId: z.string().min(1),
          planDigest: z.string().min(1),
          nodeId: z.string().min(1),
          snapshotDigest: z.string().min(1),
          decisionIds: z.array(z.string().min(1).max(200)).max(300),
          sourceContextDigest: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .strict()
        .parse(r.body);
      const plan = await getPlan(options.db, input.planDigest, p.tenantId);
      if (!plan || !plan.graph.nodes.some((n) => n.id === input.nodeId))
        throw new ContextSetupError("context.preview_target_not_found", 404);
      let expiresAt = new Date(Date.now() + 30000).toISOString();
      for (const id of [...new Set(input.decisionIds)].sort()) {
        const prior = await getSourceDecision(options.db, p.tenantId, id);
        if (
          prior.stage !== "use" ||
          prior.decision.outcome !== "ALLOW" ||
          !prior.decision.contextDigest
        )
          throw new ContextSetupError(
            "context.preview_source_provenance_denied",
            403,
          );
        const priorContext = await getSourceArtifact(
          options.db,
          p.tenantId,
          "source-context",
          prior.decision.contextDigest,
          false,
        );
        if (
          priorContext.kind !== "source-context" ||
          priorContext.caseId !== input.caseId
        )
          throw new ContextSetupError(
            "context.preview_source_case_denied",
            403,
          );
        const authority = await loadSourceAuthority(options.db, {
          tenantId: p.tenantId,
          caseId: input.caseId,
          plan,
          contextDigest: input.sourceContextDigest,
          capabilityId: prior.capabilityId,
          connectorId: prior.connectorId,
        });
        if (stableDigest(authority.binding) !== prior.decision.bindingDigest)
          throw new ContextSetupError(
            "context.preview_source_binding_changed",
            403,
          );
        const decision = evaluateSourceAuthorization({
          ...authority,
          capabilityId: prior.capabilityId,
          connectorId: prior.connectorId,
          evaluatedAt: new Date().toISOString(),
          request: {
            stage: "use",
            recipientId: p.tenantId,
            redistribute: false,
            ...(prior.observation ? { observation: prior.observation } : {}),
          },
        });
        if (decision.outcome !== "ALLOW")
          throw new ContextSetupError(
            "context.preview_source_use_denied",
            403,
          );
        expiresAt = new Date(
          Math.min(Date.parse(expiresAt), Date.parse(decision.validUntil)),
        ).toISOString();
      }
      const secret =
        options.env.CONTEXT_PREVIEW_PRIVATE_KEY_PEM ??
        options.env.CONTEXT_PREVIEW_SECRET;
      if (!secret)
        throw new ContextSetupError(
          "context.preview_authority_unavailable",
          503,
        );
      const { sourceContextDigest: _context, ...scope } = input;
      const requestDigest = stableDigest({
        tenantId: p.tenantId,
        actor: p.subjectId,
        ...scope,
        decisionIds: [...new Set(input.decisionIds)].sort(),
      });
      return {
        proof: await mintContextPreviewProof({
          secret,
          tenantId: p.tenantId,
          actor: p.subjectId,
          requestDigest,
          expiresAt,
        }),
      };
    }),
  );
  app.get(
    "/v1/context/catalog",
    handle("draft.read", async () => contextCatalog(options.env)),
  );
  app.get(
    "/v1/context/schema",
    handle("draft.read", async () => canonicalSchemaMetadata()),
  );
  app.get(
    "/v1/context/relationships",
    handle("draft.read", async () => canonicalRelationships()),
  );
  app.get(
    "/v1/context/definitions",
    handle("draft.read", async (_r, _p, s) => ({
      items: (await listContextDefinitions(options.db, s)).filter(
        (revision) => revision.definition.kind !== "case-binding",
      ),
    })),
  );
  app.post(
    "/v1/context/definitions",
    { bodyLimit: 262144 },
    handle("draft.write", async (r, p, s) => {
      const input = saveContextDefinitionSchema.parse(r.body);
      if (input.definition.kind === "case-binding")
        throw new ContextSetupError(
          "context.case_binding_route_required",
          403,
        );
      // Incomplete mapping drafts are allowed; pinned dependencies still must exist.
      if (input.definition.kind === "mapping") {
        await chain(s, input.definition);
        if (
          input.definition.catalogDigest !==
          contextCatalog(options.env).catalogDigest
        )
          throw new ContextSetupError("context.catalog_changed", 409);
        compileMapping(input.definition);
      }
      if (input.definition.kind === "connection") {
        await options.authorize(r, "integration.connector.write", {
          kind: "context-connection",
          id: input.definition.id,
        });
      }
      if (input.definition.kind === "resource") {
        const c = await getContextDefinition(
          options.db,
          s,
          "connection",
          input.definition.connectionId,
        );
        if (
          !c ||
          c.definition.kind !== "connection" ||
          c.digest !== input.definition.connectionDigest
        )
          throw new ContextSetupError(
            "context.connection_revision_changed",
            409,
          );
        assertResourceScope(c.definition, input.definition);
      }
      return saveContextDefinition(options.db, s, {
        ...input,
        actor: p.subjectId,
      });
    }),
  );
  app.post(
    "/v1/context/resources/:id/discover",
    handle("draft.evaluate", async (r, p, s) => {
      const id = (r.params as { id: string }).id;
      const resource = await getContextDefinition(
        options.db,
        s,
        "resource",
        id,
      );
      if (!resource || resource.definition.kind !== "resource")
        throw new ContextSetupError("context.resource_not_found", 404);
      const c = await getContextDefinition(
        options.db,
        s,
        "connection",
        resource.definition.connectionId,
      );
      if (
        !c ||
        c.definition.kind !== "connection" ||
        c.digest !== resource.definition.connectionDigest
      )
        throw new ContextSetupError(
          "context.connection_revision_changed",
          409,
        );
      return discoverContextResource(
        c.definition,
        resource.definition,
        p.tenantId,
        options.env,
      );
    }),
  );
  app.post(
    "/v1/context/mappings/validate",
    { bodyLimit: 262144 },
    handle("draft.compile", async (r) => compileMapping(r.body)),
  );
  app.get(
    "/v1/context/sample-runs",
    handle("draft.read", async (r, p, s) => {
      const query = z
        .object({ mappingId: z.string().min(1).max(128) })
        .strict()
        .parse(r.query);
      return {
        items: await listContextSampleHistory(
          options.db,
          s,
          query.mappingId,
          p.subjectId,
        ),
      };
    }),
  );
  app.post(
    "/v1/context/sample-runs",
    { bodyLimit: 1048576 },
    handle("draft.evaluate", async (r, p, s) => {
      const input = contextSampleRequestSchema.parse(r.body);
      const rev = await getContextDefinition(
        options.db,
        s,
        "mapping",
        input.mappingId,
      );
      if (!rev || rev.definition.kind !== "mapping")
        throw new ContextSetupError("context.mapping_not_found", 404);
      if (rev.digest !== input.expectedDigest)
        throw new ContextSetupError("context.revision_conflict", 409);
      const mapping = rev.definition;
      const { connection, resource } = await chain(s, mapping);
      if (mapping.catalogDigest !== contextCatalog(options.env).catalogDigest)
        throw new ContextSetupError("context.catalog_changed", 409);
      let rows = input.rows ?? [];
      let sourceDecision: unknown = null;
      let fingerprint: string | null = null;
      let truncated = false;
      const now = new Date().toISOString();
      let expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      if (input.origin === "live") {
        if (!input.authority || !input.subjects || input.rows)
          throw new ContextSetupError("context.live_scope_required");
        const plan = await getPlan(
          options.db,
          input.authority.planDigest,
          p.tenantId,
        );
        const context = await getSourceArtifact(
          options.db,
          p.tenantId,
          "source-context",
          input.authority.contextDigest,
        );
        if (!plan || context.kind !== "source-context")
          throw new ContextSetupError("context.source_authority_missing", 403);
        await options.authorize(r, "case.read", {
          kind: "case",
          id: context.caseId,
        });
        if (input.authority.connectorId !== connection.definition.connectorId)
          throw new ContextSetupError("context.connector_scope_denied", 403);
        const authority = await loadSourceAuthority(options.db, {
          tenantId: p.tenantId,
          caseId: context.caseId,
          plan,
          contextDigest: input.authority.contextDigest,
          capabilityId: input.authority.capabilityId,
          connectorId: input.authority.connectorId,
        });
        if (
          authority.binding.mappingVersion !== compileMapping(mapping).digest ||
          !authority.binding.datasetIds.includes(
            contextDatasetId(resource.definition),
          ) ||
          !contextSourceFields(resource.definition).every((f) =>
            authority.binding.fields.includes(f),
          )
        )
          throw new ContextSetupError(
            "context.source_mapping_scope_denied",
            403,
          );
        assertContextSourceDestination(
          connection.definition,
          p.tenantId,
          options.env,
          authority.binding,
        );
        const decision = evaluateSourceAuthorization({
          ...authority,
          capabilityId: input.authority.capabilityId,
          connectorId: input.authority.connectorId,
          evaluatedAt: now,
          request: {
            stage: "acquire",
            recipientId: p.tenantId,
            redistribute: false,
          },
        });
        if (decision.outcome !== "ALLOW")
          throw new ContextSetupError("context.source_read_denied", 403);
        sourceDecision = decision;
        expiresAt = new Date(
          Math.min(
            Date.parse(expiresAt),
            Date.now() + (decision.obligations.maxRetentionSeconds ?? 0) * 1000,
          ),
        ).toISOString();
        const fetched = await fetchContextSample(
          connection.definition,
          resource.definition,
          input.subjects,
          p.tenantId,
          options.env,
        );
        rows = fetched.rows;
        fingerprint = fetched.fingerprint;
        truncated = fetched.truncated;
      } else if (!rows.length || !input.observedAt)
        throw new ContextSetupError(
          "context.sample_rows_and_observation_required",
        );
      const mapped = executeMapping(
        mapping,
        rows,
        input.origin === "live"
          ? (row) => {
              return String(
                evaluateExpression(
                  {
                    op: "instant",
                    value: {
                      op: "field",
                      path: resource.definition.observedAtColumn,
                    },
                  },
                  row,
                ),
              );
            }
          : new Date(input.observedAt!).toISOString(),
      );
      if (input.origin === "live")
        for (const subject of input.subjects ?? []) {
          if (
            !rows.some(
              (row) =>
                String(row[resource.definition.subjectColumn]) === subject,
            )
          )
            mapped.issues.push({
              code: "context.requested_subject_missing",
              row: null,
              objectType: null,
              field: resource.definition.subjectColumn,
              message: `No row returned for requested subject key ${subject}.`,
              action:
                "Inspect the subject key, source coverage and request scope.",
            });
        }
      const report: ContextSampleReport = {
        id: randomUUID(),
        mappingId: mapping.id,
        mappingDigest: rev.digest,
        resourceDigest: resource.digest,
        connectionDigest: connection.digest,
        compilationDigest: mapped.compilationDigest,
        schemaVersion: mapping.schemaVersion,
        catalogDigest: mapping.catalogDigest,
        origin: input.origin,
        createdAt: now,
        expiresAt,
        actor: p.subjectId,
        inputDigest: stableDigest(rows),
        parameters: {
          subjects: input.subjects ?? null,
          observedAt: input.observedAt ?? null,
        },
        schemaFingerprint: fingerprint,
        counts: {
          rows: rows.length,
          acceptedRows: mapped.acceptedRows,
          rejectedRows: mapped.rejectedRows,
          duplicateRecords: mapped.duplicateRecords,
          candidates: mapped.candidates.length,
          subjects: new Set(mapped.candidates.flatMap((c) => c.subject_ids))
            .size,
        },
        stages: [
          {
            stage: "fetch",
            status: "passed",
            detail: `${rows.length} ${input.origin} rows${truncated ? "; source row limit reached" : ""}`,
          },
          {
            stage: "transform",
            status: mapped.rejectedRows ? "attention" : "passed",
            detail: `${mapped.acceptedRows} accepted input rows; ${mapped.rejectedRows} rejected`,
          },
          {
            stage: "validate",
            status: mapped.issues.some(
              (i) => i.code !== "context.reference_unresolved",
            )
              ? "attention"
              : "passed",
            detail: "Pinned closed canonical schemas",
          },
          {
            stage: "relationships",
            status: mapped.issues.some(
              (i) => i.code === "context.reference_unresolved",
            )
              ? "attention"
              : "passed",
            detail: "References checked within this bounded sample",
          },
          {
            stage: "assess",
            status: "unavailable",
            detail:
              "Choose an admitted task/plan target for consumer assessment.",
          },
          {
            stage: "packet",
            status: "unavailable",
            detail:
              "Packet preview requires purpose-bound case and plan authority.",
          },
        ],
        issues: mapped.issues,
        candidates: mapped.candidates,
        lineage: mapped.lineage,
        limitations: [
          "Sample validated only; no claim about unsampled records.",
          "Relationship checks cover this sample only.",
          ...(input.origin !== "live"
            ? ["Uploaded or fixture data does not qualify a live connection."]
            : []),
          ...(truncated
            ? [
                "Pagination incomplete; full-window completeness is not established.",
              ]
            : []),
        ],
        authority: input.authority ?? null,
        sourceDecision,
      };
      if (input.consumer) {
        const catalog = contextCatalog(options.env);
        const agent = catalog.agents.find(
          (a) => a.value.id === input.consumer!.agentId,
        );
        const task = catalog.tasks.find(
          (t) => t.value.id === input.consumer!.taskId,
        );
        if (
          !agent ||
          !task ||
          task.value.agent_profile !== input.consumer.agentId
        )
          throw new ContextSetupError("context.consumer_not_found", 404);
        const skills = (task.value.steps as Array<{ skill_id: string }>).map(
          (step) => step.skill_id,
        );
        const execution = agent.value.execution as {
          context_fields?: Record<string, string[]>;
        };
        const subjectIds = [
          ...new Set(mapped.candidates.flatMap((c) => c.subject_ids)),
        ];
        const gaps: Array<{
          subjectId: string;
          skillId: string;
          objectType: string;
          code: string;
          message: string;
        }> = [];
        for (const skillId of skills) {
          const skill = catalog.skills.find((s) => s.value.id === skillId);
          for (const req of (skill?.value.required_context ?? []) as Array<{
            object_type: string;
            fields: string[];
            min_count: number;
            max_age_seconds: number | null;
          }>) {
            if (req.object_type === "Policy") continue;
            const denied = req.fields.filter(
              (f) => !execution.context_fields?.[req.object_type]?.includes(f),
            );
            for (const subjectId of subjectIds) {
              if (denied.length) {
                gaps.push({
                  subjectId,
                  skillId,
                  objectType: req.object_type,
                  code: "context.ceiling_gap",
                  message: `Fields outside the selected agent ceiling: ${denied.join(", ")}`,
                });
                continue;
              }
              const result = selectRecordSection(
                {
                  id: skillId,
                  source: "case",
                  path: `records.${req.object_type}`,
                  purpose: "sample.assessment",
                  classification: "CONFIDENTIAL",
                  required: true,
                  record: {
                    objectType: req.object_type,
                    fields: req.fields,
                    minCount: req.min_count,
                    maxAgeSeconds: req.max_age_seconds,
                  },
                },
                mapped.candidates.filter((c) =>
                  c.subject_ids.includes(subjectId),
                ),
                now,
                [subjectId],
              );
              for (const gap of result.gaps)
                gaps.push({
                  subjectId,
                  skillId,
                  objectType: req.object_type,
                  code: gap.code,
                  message: gap.explanation,
                });
            }
          }
        }
        report.assessment = {
          ...input.consumer,
          gaps,
          limitations: [
            "Policy, predecessor parameters, tenant-defined freshness and runtime authority require an admitted case preview.",
          ],
        };
        report.stages.find((stage) => stage.stage === "assess")!.status =
          "attention";
        report.stages.find((stage) => stage.stage === "assess")!.detail =
          `${gaps.length} subject/task field or count gaps; runtime policy and authority remain unassessed.`;
      }
      return saveContextSample(options.db, s, report);
    }),
  );
  app.get(
    "/v1/context/mappings/:id/enablement",
    handle("draft.read", async (r, _p, s) => ({
      enablement: await getContextEnablement(
        options.db,
        s,
        (r.params as { id: string }).id,
      ),
    })),
  );
  app.post(
    "/v1/context/mappings/:id/enable",
    handle("release.activate", async (r, p, s) => {
      const mappingId = (r.params as { id: string }).id;
      const input = z
        .object({
          reportId: z.string().uuid(),
          expectedDigest: z.string().regex(/^[a-f0-9]{64}$/),
          expectedRevision: z.number().int().min(0),
        })
        .strict()
        .parse(r.body);
      const report = await getContextSample(options.db, s, input.reportId);
      if (
        report.mappingId !== mappingId ||
        report.mappingDigest !== input.expectedDigest
      )
        throw new ContextSetupError("context.sample_mapping_mismatch", 409);
      const plan = report.authority
        ? await getPlan(options.db, report.authority.planDigest, p.tenantId)
        : null;
      if (!plan || !report.authority)
        throw new ContextSetupError("context.live_sample_required", 409);
      let release;
      try {
        release = await requireExecutableRelease(
          options.db,
          p.tenantId,
          plan.planDigest,
          options.env.RELEASE_ENVIRONMENT ?? environment,
        );
      } catch {
        throw new ContextSetupError(
          "context.executable_release_required",
          409,
        );
      }
      const pins = plan.sourceAuthorization;
      return activateContextMapping(options.db, s, {
        mappingId,
        mappingDigest: input.expectedDigest,
        report,
        expectedRevision: input.expectedRevision,
        actor: p.subjectId,
        artifactDigests: [
          release.manifest.manifestDigest,
          ...(pins?.policyDigests ?? []),
          ...(pins?.bindings.flatMap((b) => [
            b.bindingDigest,
            b.accessDigest,
          ]) ?? []),
          report.authority.contextDigest,
        ],
        authorize: async () => {
          const current = await getContextDefinition(
            options.db,
            s,
            "mapping",
            mappingId,
          );
          if (
            !current ||
            current.definition.kind !== "mapping" ||
            current.digest !== report.mappingDigest ||
            current.definition.catalogDigest !==
              contextCatalog(options.env).catalogDigest ||
            compileMapping(current.definition).digest !==
              report.compilationDigest
          )
            throw new ContextSetupError("context.qualification_changed", 409);
          const { connection, resource } = await chain(s, current.definition);
          const authority = await loadSourceAuthority(options.db, {
            tenantId: p.tenantId,
            caseId: (
              (await getSourceArtifact(
                options.db,
                p.tenantId,
                "source-context",
                report.authority!.contextDigest,
              )) as { caseId: string }
            ).caseId,
            plan,
            contextDigest: report.authority!.contextDigest,
            capabilityId: report.authority!.capabilityId,
            connectorId: report.authority!.connectorId,
          });
          if (
            authority.binding.mappingVersion !== report.compilationDigest ||
            report.schemaFingerprint !== resource.definition.schemaFingerprint
          )
            throw new ContextSetupError("context.qualification_changed", 409);
          contextSourceCredential(
            connection.definition,
            p.tenantId,
            options.env,
          );
          assertContextSourceDestination(
            connection.definition,
            p.tenantId,
            options.env,
            authority.binding,
          );
          const discovered = await discoverContextResource(
            connection.definition,
            resource.definition,
            p.tenantId,
            options.env,
          );
          if (discovered.fingerprint !== report.schemaFingerprint)
            throw new ContextSetupError("context.source_schema_changed", 409);
          const decision = evaluateSourceAuthorization({
            ...authority,
            capabilityId: report.authority!.capabilityId,
            connectorId: report.authority!.connectorId,
            evaluatedAt: new Date().toISOString(),
            request: {
              stage: "acquire",
              recipientId: p.tenantId,
              redistribute: false,
            },
          });
          if (decision.outcome !== "ALLOW")
            throw new ContextSetupError("context.source_read_denied", 403);
          try {
            await requireExecutableRelease(
              options.db,
              p.tenantId,
              plan.planDigest,
              options.env.RELEASE_ENVIRONMENT ?? environment,
            );
          } catch {
            throw new ContextSetupError(
              "context.executable_release_required",
              409,
            );
          }
        },
      });
    }),
  );
  app.post(
    "/v1/context/mappings/:id/pause",
    handle("integration.pause", async (r, p, s) => {
      const body = z
        .object({ expectedRevision: z.number().int().positive() })
        .strict()
        .parse(r.body);
      return pauseContextMapping(
        options.db,
        s,
        (r.params as { id: string }).id,
        body.expectedRevision,
        p.subjectId,
      );
    }),
  );
  app.get(
    "/v1/context/sample-runs/:id",
    handle("draft.read", async (r, p, s) => {
      const report = await getContextSample(
        options.db,
        s,
        (r.params as { id: string }).id,
      );
      if (report.actor !== p.subjectId)
        await options.authorize(r, "release.approve", {
          kind: "context-sample",
          id: report.id,
        });
      if (report.origin === "live" && report.authority) {
        const plan = await getPlan(
          options.db,
          report.authority.planDigest,
          p.tenantId,
        );
        const context = await getSourceArtifact(
          options.db,
          p.tenantId,
          "source-context",
          report.authority.contextDigest,
        );
        if (!plan || context.kind !== "source-context")
          throw new ContextSetupError("context.source_authority_denied", 403);
        await options.authorize(r, "case.read", {
          kind: "case",
          id: context.caseId,
        });
        const authority = await loadSourceAuthority(options.db, {
          tenantId: p.tenantId,
          caseId: context.caseId,
          plan,
          contextDigest: report.authority.contextDigest,
          capabilityId: report.authority.capabilityId,
          connectorId: report.authority.connectorId,
        });
        const decision = evaluateSourceAuthorization({
          ...authority,
          capabilityId: report.authority.capabilityId,
          connectorId: report.authority.connectorId,
          evaluatedAt: new Date().toISOString(),
          request: {
            stage: "acquire",
            recipientId: p.tenantId,
            redistribute: false,
          },
        });
        if (decision.outcome !== "ALLOW")
          throw new ContextSetupError("context.source_authority_denied", 403);
      }
      return report;
    }),
  );
}
