import { z } from "zod";
import { stableDigest, canonicalRecordInputSchema } from "@ehf/contracts";
import {
  compileMapping,
  executeMapping,
  evaluateExpression,
} from "@ehf/context-mapping";
import {
  assertContextSourceDestination,
  fetchContextSample,
} from "@ehf/context-postgres";
import {
  getContextDefinition,
  getContextEnablement,
  getRun,
  loadSourceAuthority,
} from "@ehf/persistence";
import type { CapabilityAdapterModule } from "./types.js";
/** Native source reads remain behind gateway policy, execution authority and receipts. */
export const contextPostgresModule: CapabilityAdapterModule = {
  id: "context-postgres",
  cloud: "any",
  label: "PostgreSQL canonical context",
  supportedKinds: ["tool"],
  enabledByDefault: false,
  connectorTemplate: {
    bindingPattern: /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/,
    capabilityIds: ["context.records.fetch.v1"],
    configEnv: [],
    description:
      "Bounded approved-view reads through an enabled, version-pinned canonical mapping.",
  },
  create: (deps) => ({
    descriptor: async () => ({
      id: "context-postgres",
      label: "PostgreSQL canonical context",
      supportedKinds: ["tool"],
      credentialState: Object.keys(deps.env).some((k) =>
        k.startsWith("CONTEXT_SOURCE_"),
      )
        ? "Configured"
        : "Missing",
      bindingOptions: [],
    }),
    acceptsBinding: (name) => /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(name),
    assertCapability: (c) => {
      if (c.id !== "context.records.fetch.v1" || c.effect !== "read")
        throw new Error("context.capability_invalid");
    },
    invoke: async (mappingId, capability, input, context) => {
      const params = z
        .object({
          subjects: z.array(z.string().min(1).max(256)).min(1).max(20),
        })
        .strict()
        .parse(input);
      const execution = context.execution;
      if (
        !execution?.claims.case_id ||
        execution.claims.delegated_to ||
        !context.invocationId
      )
        throw new Error("context.execution_authority_required");
      const scope = {
        tenantId: context.tenantId,
        environment:
          deps.env.EHF_ENVIRONMENT ?? deps.env.RELEASE_ENVIRONMENT ?? "local",
      };
      const enabled = await getContextEnablement(deps.db, scope, mappingId);
      const rev = await getContextDefinition(
        deps.db,
        scope,
        "mapping",
        mappingId,
      );
      if (
        !enabled ||
        enabled.paused ||
        !rev ||
        rev.definition.kind !== "mapping" ||
        enabled.mappingDigest !== rev.digest ||
        enabled.authority.planDigest.replace(/^sha256:/, "") !==
          execution.plan.planDigest.replace(/^sha256:/, "")
      )
        throw new Error("context.mapping_not_enabled");
      const mapping = rev.definition;
      const resource = await getContextDefinition(
        deps.db,
        scope,
        "resource",
        mapping.resourceId,
      );
      if (
        !resource ||
        resource.definition.kind !== "resource" ||
        resource.digest !== mapping.resourceDigest
      )
        throw new Error("context.resource_revision_changed");
      const connection = await getContextDefinition(
        deps.db,
        scope,
        "connection",
        resource.definition.connectionId,
      );
      if (
        !connection ||
        connection.definition.kind !== "connection" ||
        connection.digest !== resource.definition.connectionDigest ||
        connection.definition.connectorId !== capability.adapterBindingId
      )
        throw new Error("context.connection_revision_changed");
      if ("api" in connection.definition || "api" in resource.definition) throw new Error("context.resource_scope_denied");
      const run = await getRun(
        deps.db,
        execution.claims.run_id,
        context.tenantId,
      );
      if (!run?.sourceContextDigest)
        throw new Error("context.source_authority_required");
      const authority = await loadSourceAuthority(deps.db, {
        tenantId: context.tenantId,
        caseId: execution.claims.case_id,
        plan: execution.plan,
        contextDigest: run.sourceContextDigest,
        capabilityId: capability.id,
        connectorId: capability.adapterBindingId,
      });
      if (
        authority.binding.mappingVersion !== compileMapping(mapping).digest ||
        !authority.binding.datasetIds.includes(
          `${resource.definition.schema}.${resource.definition.table}`,
        ) ||
        !resource.definition.columns.every((f) =>
          authority.binding.fields.includes(f),
        )
      )
        throw new Error("context.source_mapping_scope_denied");
      assertContextSourceDestination(
        connection.definition,
        context.tenantId,
        deps.env,
        authority.binding,
      );
      const fetched = await fetchContextSample(
        connection.definition,
        resource.definition,
        params.subjects,
        context.tenantId,
        deps.env,
      );
      if (fetched.truncated)
        throw new Error("context.ingestion_requires_repair");
      if (
        params.subjects.some(
          (key) =>
            !fetched.rows.some(
              (row) =>
                String(
                  row[
                    resource.definition.kind === "resource"
                      ? resource.definition.subjectColumn
                      : ""
                  ],
                ) === key,
            ),
        )
      )
        throw new Error("context.requested_subject_missing");
      const observedAtColumn = resource.definition.observedAtColumn;
      const mapped = executeMapping(mapping, fetched.rows, (row) => {
        return String(
          evaluateExpression(
            { op: "instant", value: { op: "field", path: observedAtColumn } },
            row,
          ),
        );
      });
      if (mapped.issues.length || fetched.truncated)
        throw new Error("context.ingestion_requires_repair");
      const records = mapped.candidates.map(({ row: _row, ...c }) =>
        canonicalRecordInputSchema.parse({
          ...c,
          version_id: `v-${stableDigest({ candidateVersion: c.version_id, mappingDigest: rev.digest, invocationId: context.invocationId }).slice(0, 40)}`,
          tenant_id: context.tenantId,
          case_id: execution.claims.case_id,
          source_refs: [
            {
              tenant_id: context.tenantId,
              object_type: "GatewayInvocation",
              object_id: context.invocationId!,
              version_id: "receipt",
            },
          ],
          classification: "CONFIDENTIAL",
          purposes: [authority.context.purpose],
          synthetic: false,
          provenance: {
            method: "connector_normalizer",
            normalizer: `context-mapping@${mapped.compilationDigest}`,
            connector_id: capability.adapterBindingId,
            capability_id: capability.id,
            invocation_id: context.invocationId,
          },
        }),
      );
      const oldest = mapped.candidates.map((c) => c.observed_at).sort()[0];
      if (!oldest) throw new Error("context.no_records");
      return {
        output: {
          records,
          mappingDigest: rev.digest,
          compilationDigest: mapped.compilationDigest,
          lineage: mapped.lineage,
        },
        sourceEvidence: {
          datasetIds: [
            `${resource.definition.schema}.${resource.definition.table}`,
          ],
          fields: resource.definition.columns,
          role: authority.binding.evidenceRoles[0]!,
          observedAt: oldest,
          complete: true,
        },
        provider: "postgresql",
        model: `mapping/${mappingId}`,
        providerRequestId: context.invocationId ?? stableDigest(params),
        inputTokens: null,
        outputTokens: null,
        costUsd: null,
      };
    },
  }),
};
