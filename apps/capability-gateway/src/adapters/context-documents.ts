import { createWorkloadAuthorization } from "@ehf/identity";
import {
  documentSearchRequestSchema,
  documentCitationRequestSchema,
} from "@ehf/contracts/document-search";
import type { CapabilityAdapterModule } from "./types.js";
/** Case API projects the signed read grants before index filtering. No case DB credential here. */
export const contextDocumentsModule: CapabilityAdapterModule = {
  id: "context-documents",
  cloud: "any",
  label: "Authorized document retrieval",
  supportedKinds: ["tool"],
  enabledByDefault: false,
  sourcePolicyClass: "platform_internal",
  connectorTemplate: {
    bindingPattern: /^(search|citation)$/,
    capabilityIds: [
      "context.documents.search.v1",
      "context.documents.citation.v1",
    ],
    configEnv: ["CASE_API_URL"],
    description:
      "Case-scoped lexical retrieval and exact citation resolution under signed read grants.",
  },
  create: (deps) => {
    const authorization = createWorkloadAuthorization(
      { staticTokenEnv: "GATEWAY_CASE_SERVICE_TOKEN" },
      deps.env,
    );
    return {
      descriptor: async () => ({
        id: "context-documents",
        label: "Authorized document retrieval",
        supportedKinds: ["tool"],
        credentialState: deps.env.CASE_API_URL ? "Configured" : "Missing",
        bindingOptions: [
          { value: "search", label: "Search captured document text" },
          { value: "citation", label: "Resolve exact citation" },
        ],
      }),
      acceptsBinding: (name) => ["search", "citation"].includes(name),
      assertCapability: (cap, name) => {
        if (
          cap.effect !== "read" ||
          cap.id !==
            `context.documents.${name === "search" ? "search" : "citation"}.v1`
        )
          throw new Error("document.capability_invalid");
      },
      invoke: async (name, _cap, input, context) => {
        const execution = context.execution;
        if (!execution?.claims.case_id || execution.claims.delegated_to)
          throw new Error("document.execution_authority_required");
        const params =
          name === "search"
            ? documentSearchRequestSchema.parse(input)
            : documentCitationRequestSchema.parse(input);
        const response = await deps.fetch(
          `${(deps.env.CASE_API_URL ?? "http://case-api:4102").replace(/\/$/, "")}/v2/cases/${encodeURIComponent(execution.claims.case_id)}/documents/${name === "search" ? "search" : "citations/resolve"}`,
          {
            method: "POST",
            headers: {
              authorization: await authorization(),
              "content-type": "application/json",
              "x-execution-envelope": execution.envelope,
            },
            body: JSON.stringify(params),
            signal: execution.signal
              ? AbortSignal.any([execution.signal, AbortSignal.timeout(10000)])
              : AbortSignal.timeout(10000),
            redirect: "error",
          },
        );
        if (!response.ok)
          throw new Error(`document.retrieval_http_${response.status}`);
        const output = await response.json();
        // Runtime tool observations are UNTRUSTED_EXTERNAL and pass the existing context
        // plane's quarantine/budget/manifest path. Each match carries exact chunk provenance.
        return {
          output,
          provider: "context-store",
          model: "lexical-v1",
          providerRequestId: context.invocationId ?? null,
          inputTokens: null,
          outputTokens: null,
          costUsd: null,
        };
      },
    };
  },
};
