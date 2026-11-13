import { KYC_WIRING_OPERATION_PATTERN, invokeKycWiring, kycWiringBindingProblem } from "@ehf/adapters";
import { allowsInsecureEndpoints } from "@ehf/identity";
import { kycServiceSettings, kycServiceState } from "./shared.js";
import type { AdapterBindingOption, CapabilityAdapterModule } from "./types.js";

export const kycWiringOperations: AdapterBindingOption[] = [
  { value: "opensanctions:screening.sanctions", label: "Sanctions screening (OpenSanctions)" },
  { value: "opensanctions:screening.pep", label: "PEP screening (OpenSanctions)" },
  { value: "complyadvantage:screening.adverse_media", label: "Adverse-media screening (ComplyAdvantage)" },
  { value: "companies-house:business.registry.lookup", label: "UK company registry lookup (Companies House)" },
  { value: "gleif:reference.identifier.lookup", label: "LEI lookup (GLEIF)" },
  { value: "persona:identity.document.verify", label: "Identity document verification (Persona)" },
];

/**
 * KYC API wiring: every vendor connection and vendor credential lives in the wiring service.
 * The binding name is its catalog operation ID (`wiring:<provider>:<capability>`).
 */
export const wiringModule: CapabilityAdapterModule = {
  id: "wiring",
  cloud: "vendor",
  label: "KYC API wiring",
  supportedKinds: ["tool"],
  enabledByDefault: true,
  create: ({ env, fetch }) => ({
    descriptor: async () => ({
      id: "wiring",
      label: "KYC API wiring",
      supportedKinds: ["tool"],
      credentialState: kycServiceState(env, "wiring"),
      bindingOptions: kycWiringOperations,
    }),
    acceptsBinding: (bindingName) => KYC_WIRING_OPERATION_PATTERN.test(bindingName),
    // v2 canonical model: an operation serves only its own capability, and corrected or
    // quarantined operations are never bound.
    assertCapability: (capability, bindingName) => {
      const problem = kycWiringBindingProblem(capability.id, bindingName);
      if (problem) throw new Error(problem);
    },
    invoke: async (bindingName, capability, input, context) => {
      if (kycServiceState(env, "wiring") !== "Configured") throw new Error("gateway.kyc_wiring_not_configured");
      const { url, token } = kycServiceSettings(env, "wiring");
      return invokeKycWiring({
        operationId: bindingName,
        input,
        baseUrl: url,
        token,
        wiringTenantId: env.KYC_WIRING_TENANT_ID?.trim() || "demo-tenant",
        tenantId: context.tenantId,
        ...(context.invocationId ? { invocationId: context.invocationId } : {}),
        timeoutMs: capability.timeoutMs,
        requireHttps: !allowsInsecureEndpoints(env),
        fetch,
        ...(context.sourceAuthorization ? { authorizedScope: context.sourceAuthorization } : {}),
      });
    },
  }),
};
