import { BANK_CONTEXT_RECORD_TYPES } from "@ehf/contracts/context-setup";
import { z } from "zod";
import {
  stableDigest,
  canonicalRecordInputSchema,
  contextDatasetId,
  contextSourceFields,
} from "@ehf/contracts";
import {
  compileMapping,
  executeMapping,
  evaluateExpression,
} from "@ehf/context-mapping";
import {
  assertContextSourceDestination,
  fetchContextSample,
} from "@ehf/context-bank-connectors";
import {
  getContextDefinition,
  getContextEnablement,
  getRun,
  loadSourceAuthority,
} from "@ehf/persistence";
import type { CapabilityAdapterModule } from "./types.js";
/** Native source reads remain behind gateway policy, execution authority and receipts. */
function moduleFor(vendor: "salesforce" | "fenergo"): CapabilityAdapterModule {
  return {
    id: `context-${vendor}`,
    cloud: "any",
    label: `${vendor === "salesforce" ? "Salesforce/FSC" : "Fenergo"} case context`,
    supportedKinds: ["tool"],
    enabledByDefault: false,
    connectorTemplate: {
      bindingPattern: /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/,
      capabilityIds: ["context.records.fetch.v1"],
      configEnv: [],
      description:
        "On-demand case-scoped API reads through a reviewed subject binding and enabled ontology mapping.",
    },
    create: (deps) => ({
      descriptor: async (tenantId) => ({
        id: `context-${vendor}`,
        label: `${vendor === "salesforce" ? "Salesforce/FSC" : "Fenergo"} case context`,
        supportedKinds: ["tool"],
        credentialState: Object.entries(deps.env).some(([key, value]) => {
          if (!key.startsWith("CONTEXT_SOURCE_") || !value) return false;
          try {
            const credential = JSON.parse(value);
            return (
              credential.tenantId === tenantId &&
              typeof credential.clientId === "string" &&
              typeof credential.connectorId === "string" &&
              credential.connectorId.startsWith(`context-${vendor}:`)
            );
          } catch {
            return false;
          }
        })
          ? "Configured"
          : "Missing",
        bindingOptions: [],
      }),
      acceptsBinding: (name) =>
        /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(name),
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
        if (
          mapping.outputs.some(
            (output) => !BANK_CONTEXT_RECORD_TYPES.has(output.objectType),
          )
        )
          throw new Error("context.source_record_type_denied");
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
        if (
          !("api" in connection.definition) ||
          !("api" in resource.definition) ||
          connection.definition.api.kind !== vendor ||
          resource.definition.api.kind !== vendor
        )
          throw new Error("context.resource_scope_denied");
        const run = await getRun(
          deps.db,
          execution.claims.run_id,
          context.tenantId,
        );
        if (!run?.sourceContextDigest)
          throw new Error("context.source_authority_required");
        const runInput = (run.input ?? {}) as {
          contextPullBinding?: { id?: string; digest?: string };
          canonicalSubjects?: string[];
        };
        const node = execution.plan.graph.nodes.find(
          (n) => n.id === execution.claims.node_id,
        );
        const bindingId =
          runInput?.contextPullBinding?.id ?? node?.config.contextCaseBindingId;
        if (typeof bindingId !== "string")
          throw new Error("context.case_binding_required");
        const bindingRevision = await getContextDefinition(
          deps.db,
          scope,
          "case-binding",
          bindingId,
        );
        const b = bindingRevision?.definition;
        if (
          !bindingRevision ||
          b?.kind !== "case-binding" ||
          !b.enabled ||
          b.caseId !== execution.claims.case_id ||
          b.mappingId !== mappingId ||
          b.mappingDigest !== rev.digest ||
          b.enablementRevision !== enabled.revision ||
          b.planDigest !== execution.plan.planDigest.replace(/^sha256:/, "") ||
          b.nodeId !== execution.claims.node_id ||
          b.sourceContextDigest !== run.sourceContextDigest ||
          (runInput.contextPullBinding &&
            bindingRevision.digest !== runInput.contextPullBinding.digest)
        )
          throw new Error("context.case_binding_scope_denied");
        const selected = b.subjects.filter((s) =>
          params.subjects.includes(s.sourceKey),
        );
        if (
          selected.length !== params.subjects.length ||
          new Set(params.subjects).size !== params.subjects.length ||
          (runInput.contextPullBinding &&
            stableDigest(selected.map((s) => s.subjectId).sort()) !==
              stableDigest([...(runInput.canonicalSubjects ?? [])].sort()))
        )
          throw new Error("context.case_subject_scope_denied");
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
            contextDatasetId(resource.definition),
          ) ||
          !contextSourceFields(resource.definition).every((f) =>
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
          deps.fetch,
          execution.signal,
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
        if (
          mapped.candidates.length > 200 ||
          mapped.candidates.some((c) => {
            const sourceKey = String(
              fetched.rows[c.row - 1]?.[
                resource.definition.kind === "resource"
                  ? resource.definition.subjectColumn
                  : ""
              ],
            );
            const subject = selected.find((s) => s.sourceKey === sourceKey);
            return (
              !subject ||
              c.subject_ids.length !== 1 ||
              c.subject_ids[0] !== subject.subjectId
            );
          })
        )
          throw new Error("context.case_subject_mapping_denied");
        for (const pin of [rev, resource, connection, bindingRevision]) {
          const current = await getContextDefinition(
            deps.db,
            scope,
            pin.definition.kind,
            pin.definition.id,
          );
          if (current?.digest !== pin.digest)
            throw new Error("context.qualification_changed");
        }
        const currentEnablement = await getContextEnablement(
          deps.db,
          scope,
          mappingId,
        );
        if (
          !currentEnablement ||
          currentEnablement.paused ||
          currentEnablement.revision !== enabled.revision
        )
          throw new Error("context.mapping_not_enabled");
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
            datasetIds: [contextDatasetId(resource.definition)],
            fields: contextSourceFields(resource.definition),
            role: authority.binding.evidenceRoles[0]!,
            observedAt: oldest,
            complete: true,
          },
          provider: vendor,
          model: `mapping/${mappingId}`,
          providerRequestId: context.invocationId ?? stableDigest(params),
          inputTokens: null,
          outputTokens: null,
          costUsd: null,
        };
      },
    }),
  };
}
export const contextSalesforceModule = moduleFor("salesforce");
export const contextFenergoModule = moduleFor("fenergo");
