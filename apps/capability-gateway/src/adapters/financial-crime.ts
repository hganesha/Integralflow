import { assignmentFor, type CanonicalCatalog, type FinancialCrimeClient } from "@ehf/fincrime-integration";
import type { CapabilityAdapterModule, ExecutableAdapter } from "./types.js";

/** The adapter ID of canonical financial-crime skills: `financial-crime:<skill>@<semver>`. */
export const FINANCIAL_CRIME_ADAPTER_ID = "financial-crime";

/**
 * Execution authority of one financial-crime call, derived by the gateway from the verified
 * envelope and the leased work item. Caller parameters never supply it.
 */
export type FinancialCrimeExecution = {
  tenantId: string; caseId: string; runId: string; nodeId: string; workItemId: string;
  executionId: string; runFencingEpoch: number; workFencingEpoch: number; planDigest: string; taskId: string;
  catalogDigest: string;
};

export type FinancialCrimeBinding = {
  catalog: CanonicalCatalog;
  catalogDigest: string;
  client: FinancialCrimeClient;
  // Application-owned source adapter. Caller parameters can never supply this basis.
  resolveBasis: (execution: FinancialCrimeExecution) => Promise<{ caseSequence: number; snapshotDigest: string }>;
};

export function createFinancialCrimeAdapter(binding: FinancialCrimeBinding): ExecutableAdapter {
  return {
    descriptor: async () => ({
      id: FINANCIAL_CRIME_ADAPTER_ID,
      label: "Canonical financial crime skills",
      supportedKinds: ["deterministic", "tool"],
      credentialState: "Configured",
      bindingOptions: binding.catalog.skills.map((s) => ({ value: `${s.value.id}@${s.value.semver}`, label: String(s.value.id) })),
    }),
    invoke: async (name, capability, input, context) => {
      const execution = context.financialCrimeExecution;
      if (!execution || execution.tenantId !== context.tenantId || capability.effect !== "read") throw new Error("fincrime.execution_authority_required");
      if (execution.catalogDigest !== binding.catalogDigest) throw new Error("fincrime.catalog_not_admitted");
      const separator = name.lastIndexOf("@");
      const skillId = name.slice(0, separator), version = name.slice(separator + 1);
      const basis = await binding.resolveBasis(execution);
      const scope = assignmentFor(binding.catalog, { taskId: execution.taskId, skillId, scope: {
        tenant_id: execution.tenantId, case_id: execution.caseId, run_id: execution.runId, node_id: execution.nodeId,
        work_item_id: execution.workItemId, execution_id: execution.executionId, work_fencing_epoch: execution.workFencingEpoch,
        run_fencing_epoch: execution.runFencingEpoch, case_sequence: basis.caseSequence, snapshot_digest: basis.snapshotDigest,
        plan_digest: execution.planDigest.replace(/^sha256:/, ""),
      } });
      if (scope.skill_version !== version) throw new Error("fincrime.binding_version_mismatch");
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("fincrime.parameters_required");
      const output = await binding.client.execute(scope, input as Record<string, unknown>);
      return { output, provider: "financial-crime-skills", model: "deterministic", providerRequestId: scope.execution_id,
        inputTokens: null, outputTokens: null, costUsd: null };
    },
  };
}

/**
 * Not a loadable module: it exists only when the deployment injects a canonical catalog and
 * bridge client (`financialCrime` registry option), so it is outside ADAPTER_MODULES and
 * GATEWAY_ADAPTERS.
 */
export function financialCrimeModule(binding: FinancialCrimeBinding): CapabilityAdapterModule {
  return {
    id: FINANCIAL_CRIME_ADAPTER_ID,
    sourcePolicyClass: "platform_internal",
    cloud: "any",
    label: "Canonical financial crime skills",
    supportedKinds: ["deterministic", "tool"],
    enabledByDefault: false,
    create: () => createFinancialCrimeAdapter(binding),
  };
}
