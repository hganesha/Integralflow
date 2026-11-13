import { EVIDENCE_PIPELINE_OPERATIONS, invokeEvidencePipeline, layoutProviderFromEnv, prepareDocument } from "@ehf/adapters";
import { allowsInsecureEndpoints } from "@ehf/identity";
import { kycServiceSettings, kycServiceState } from "./shared.js";
import type { AdapterBindingOption, CapabilityAdapterModule } from "./types.js";

export const evidencePipelineOperations: AdapterBindingOption[] = [
  { value: "prepare", label: "Decode selected document", description: "Decodes one hash-bound original for catalog extraction without deciding or accepting a case. Images, and PDFs without a usable text layer, use the configured layout provider." },
  { value: "ingest", label: "Ingest case document", description: "Parses one document into provisional, source-cited case evidence." },
  { value: "package", label: "Case evidence package", description: "Exports the canonical evidence package for a case." },
  { value: "ownership", label: "Ownership graph", description: "Exports the case ownership and control graph." },
  { value: "resume", label: "Resume after review", description: "Submits a human review decision to a paused run." },
  { value: "pages", label: "Decoded document pages", description: "Returns a parsed document's numbered page text in the skill library's document.ocr contract, bound to its artifact hash." },
];

/** KYC evidence pipeline: document evidence preparation; it never decides a case. */
export const evidenceModule: CapabilityAdapterModule = {
  id: "evidence",
  cloud: "local",
  label: "KYC evidence pipeline",
  supportedKinds: ["tool"],
  enabledByDefault: true,
  create: ({ env, fetch }) => ({
    descriptor: async () => ({
      id: "evidence",
      label: "KYC evidence pipeline",
      supportedKinds: ["tool"],
      credentialState: kycServiceState(env, "evidence"),
      bindingOptions: evidencePipelineOperations,
    }),
    acceptsBinding: (bindingName) => (EVIDENCE_PIPELINE_OPERATIONS as readonly string[]).includes(bindingName),
    invoke: async (bindingName, capability, input, context) => {
      if (kycServiceState(env, "evidence") !== "Configured") throw new Error("gateway.evidence_pipeline_not_configured");
      const { url, token } = kycServiceSettings(env, "evidence");
      if (bindingName === "prepare") {
        // OCR and layout run here, through the configured provider; the pipeline never contacts it.
        return prepareDocument({
          tenantId: context.tenantId,
          ...(context.invocationId ? { invocationId: context.invocationId } : {}),
          input, baseUrl: url, token, timeoutMs: capability.timeoutMs, requireHttps: !allowsInsecureEndpoints(env), fetch,
        }, layoutProviderFromEnv(env, fetch));
      }
      return invokeEvidencePipeline({
        tenantId: context.tenantId,
        ...(context.invocationId ? { invocationId: context.invocationId } : {}),
        operation: bindingName,
        input,
        baseUrl: url,
        token,
        timeoutMs: capability.timeoutMs,
        requireHttps: !allowsInsecureEndpoints(env),
        fetch,
      });
    },
  }),
};
