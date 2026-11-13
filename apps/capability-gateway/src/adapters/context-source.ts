import { stableDigest, resolveContextSourceParameters } from "@ehf/contracts";
import {
  normalizeContextRows,
  runContextConnector,
} from "@ehf/context-connectors";
import {
  loadContextBinding,
  contextSourceQualification,
} from "@ehf/persistence";
import type { CapabilityAdapterModule } from "./types.js";

const pattern = /^([a-f0-9]{16}):([a-z][a-z0-9_-]{1,63})\.r([1-9][0-9]*)$/;
export const contextSourceModule: CapabilityAdapterModule = {
  id: "context-source",
  cloud: "any",
  label: "Enterprise context sources",
  supportedKinds: ["tool"],
  enabledByDefault: false,
  connectorTemplate: {
    bindingPattern: pattern,
    capabilityIds: ["context.source.read.v1"],
    configEnv: ["CONTEXT_SOURCE_TARGETS_JSON"],
    description: "Read a qualified, revision-pinned enterprise context source.",
  },
  create: ({ db, env, fetch }) => ({
    descriptor: async () => ({
      id: "context-source",
      label: "Enterprise context sources",
      supportedKinds: ["tool"],
      credentialState: env.CONTEXT_SOURCE_TARGETS_JSON
        ? "Configured"
        : "Missing",
      bindingOptions: [],
    }),
    acceptsBinding: (binding) => pattern.test(binding),
    assertCapability: (capability) => {
      if (
        capability.id !== "context.source.read.v1" ||
        capability.effect !== "read"
      )
        throw new Error("context_source.capability_mismatch");
    },
    invoke: async (name, _capability, input, context) => {
      const match = pattern.exec(name);
      if (
        !match ||
        match[1] !==
          stableDigest({ tenantId: context.tenantId }).slice(0, 16) ||
        !context.sourceAuthorization?.checkEndpoint
      )
        throw new Error(
          "gateway.source_policy_denied:context_source_authority_required",
        );
      const { binding, connection } = await loadContextBinding(db, {
        tenantId: context.tenantId,
        bindingId: match[2]!,
        revision: Number(match[3]),
        executable: true,
      });
      const qualification = await contextSourceQualification(
        db,
        context.tenantId,
        binding.definition.id,
        binding.revision,
      );
      if (
        !qualification ||
        qualification.status !== "passed" ||
        qualification.bindingDigest !== binding.digest ||
        qualification.connectionDigest !== connection.digest
      )
        throw new Error("context_source.qualification_required");
      const parameters = resolveContextSourceParameters(
        binding.definition,
        input,
        {
          ...(context.execution?.claims.case_id
            ? { caseId: context.execution.claims.case_id }
            : {}),
        },
      );
      const result = await runContextConnector(
        connection.definition,
        binding.definition,
        parameters,
        {
          env,
          fetch,
          tenantId: context.tenantId,
          checkTransport: context.sourceAuthorization.checkEndpoint,
          ...(context.execution?.signal
            ? { signal: context.execution.signal }
            : {}),
        },
      );
      if (result.schemaFingerprint !== qualification.schemaFingerprint)
        throw new Error("context_source.schema_drift");
      if (result.truncated) throw new Error("context_source.result_truncated");
      const records = normalizeContextRows(binding.definition, result, {
        connectorId: `context-source:${name}`,
        tenantId: context.tenantId,
        invocationId: context.invocationId ?? name,
        bindingDigest: binding.digest,
        connectionDigest: connection.digest,
        qualificationId: qualification.id,
      });
      return {
        output: {
          records,
          contextSource: {
            bindingDigest: binding.digest,
            connectionDigest: connection.digest,
            schemaFingerprint: result.schemaFingerprint,
            rowCount: records.length,
          },
        },
        provider: connection.definition.provider,
        model: binding.digest,
        providerRequestId: null,
        inputTokens: null,
        outputTokens: null,
        costUsd: null,
        sourceEvidence: {
          datasetIds: [binding.definition.datasetId],
          fields: [...new Set(binding.definition.mapping.map((m) => m.target))],
          role: "supplemental",
          observedAt: records.length
            ? records.map((r) => r.observed_at).sort()[0]!
            : new Date().toISOString(),
          complete: records.length > 0,
        },
      };
    },
  }),
};
