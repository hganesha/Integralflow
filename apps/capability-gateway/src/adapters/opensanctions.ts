import { invokeOpenSanctions } from "@ehf/adapters";
import type { AdapterBindingOption, CapabilityAdapterModule } from "./types.js";

export const openSanctionsOperations: AdapterBindingOption[] = [
  { value: "pep", label: "PEP screening", description: "Restricts matches to politically exposed persons." },
  { value: "sanctions", label: "Sanctions screening", description: "Restricts matches to sanctions and linked entities." },
];

/** Direct OpenSanctions match API. Env OPENSANCTIONS_API_KEY (+ optional URL, dataset, threshold). */
export const openSanctionsModule: CapabilityAdapterModule = {
  id: "opensanctions",
  cloud: "vendor",
  label: "OpenSanctions",
  supportedKinds: ["tool"],
  enabledByDefault: true,
  create: ({ env, fetch }) => ({
    descriptor: async () => ({
      id: "opensanctions",
      label: "OpenSanctions",
      supportedKinds: ["tool"],
      credentialState: env.OPENSANCTIONS_API_KEY ? "Configured" : "Missing",
      bindingOptions: openSanctionsOperations,
    }),
    normalizeBinding: (bindingName) => ({
      "screening.pep.search": "pep",
      "screening.sanctions.search": "sanctions",
    }[bindingName] ?? bindingName),
    invoke: async (bindingName, capability, input, context) => {
      const dataset = env.OPENSANCTIONS_DATASET?.trim() || "default";
      if (context.sourceAuthorization && !context.sourceAuthorization.bindingDatasetIds.includes(dataset)) throw new Error("gateway.source_policy_denied:dataset_configuration_changed");
      return invokeOpenSanctions({
      input,
      tenantId: context.tenantId,
      ...(context.invocationId ? { invocationId: context.invocationId } : {}),
      apiKey: env.OPENSANCTIONS_API_KEY ?? "",
      timeoutMs: capability.timeoutMs,
      fetch,
      screeningType: bindingName === "pep" ? "PEP" : "SANCTIONS",
      topics: bindingName === "pep" ? ["role.pep"] : ["sanction", "sanction.linked"],
      ...(env.OPENSANCTIONS_API_URL ? { apiUrl: env.OPENSANCTIONS_API_URL } : {}),
      ...(env.OPENSANCTIONS_DATASET ? { dataset: env.OPENSANCTIONS_DATASET } : {}),
      ...(env.OPENSANCTIONS_MATCH_THRESHOLD ? { threshold: Number(env.OPENSANCTIONS_MATCH_THRESHOLD) } : {}),
      });
    },
  }),
};
