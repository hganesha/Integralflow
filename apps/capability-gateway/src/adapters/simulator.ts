import { invokeSimulator, LIBRARY_SANDBOX_CAPABILITIES, LIBRARY_SIMULATOR_PREFIX } from "@ehf/adapters";
import type { AdapterBindingOption, CapabilityAdapterModule } from "./types.js";

export const simulatorOperations: AdapterBindingOption[] = [
  { value: "screening.sanctions.search", label: "Sanctions search" },
  { value: "screening.pep.search", label: "PEP search" },
  { value: "screening.adverse-media.search", label: "Adverse-media search" },
  { value: "vendor.lookup", label: "Vendor lookup" },
  { value: "purchase_order.lookup", label: "Purchase order lookup" },
  { value: "policy.kyc.lookup", label: "KYC policy lookup" },
  { value: "investigation.web.search", label: "Investigation web search" },
  { value: "discovery.public.search", label: "Synthetic corporate reconnaissance search" },
  // The skill library's provider capabilities (CR-8): schema-checked, always INCONCLUSIVE.
  ...LIBRARY_SANDBOX_CAPABILITIES.map((capability) => ({ value: `${LIBRARY_SIMULATOR_PREFIX}${capability}`, label: `Skill library sandbox: ${capability}` })),
];

/** Deterministic fixtures for offline runs and demos. */
export const simulatorModule: CapabilityAdapterModule = {
  id: "simulator",
  sourcePolicyClass: "synthetic",
  cloud: "local",
  label: "Simulator",
  supportedKinds: ["tool", "deterministic"],
  enabledByDefault: true,
  create: () => ({
    descriptor: async () => ({
      id: "simulator",
      label: "Simulator",
      supportedKinds: ["tool", "deterministic"],
      credentialState: "Not required",
      bindingOptions: simulatorOperations,
    }),
    invoke: async (bindingName, _capability, input) => invokeSimulator(bindingName, input),
  }),
};
