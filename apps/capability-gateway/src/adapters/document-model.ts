import { createHash } from "node:crypto";
import { documentModelProviderFromEnv } from "@ehf/adapters";
import { documentExtractionVariant, type HarnessPlanV2 } from "@ehf/contracts";
import { DEFAULT_FACTORY_PRICES } from "@ehf/contracts/document-factory";
import { releasedDocumentModel } from "@ehf/persistence";
import type { AdapterInvocationContext, CapabilityAdapterModule } from "./types.js";

export const DOCUMENT_MODEL_ADAPTER_PREFIX = "document-model:";
const PROVIDER = "azure_document_intelligence";
const HASH = /^[a-f0-9]{64}$/;

/**
 * The original a run may have read by a document model: only an admitted adjudicated document pipeline's run
 * (factory plan Phase 4), only the bytes in its own input, and only when they hash to its document version. The
 * case store authorized that run's start against the stored evidence (documentRunScope), so this adds no new
 * read path to raw evidence: the connector sees exactly what the run's prepare step already holds.
 */
export function documentOfRun(plan: HarnessPlanV2, input: unknown): NonNullable<AdapterInvocationContext["runDocument"]> {
  if (documentExtractionVariant(plan) !== "adjudicated") throw new Error("gateway.document_model_plan_denied");
  const value = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const version = typeof value.documentVersion === "string" ? value.documentVersion.replace(/^sha256:/, "") : "";
  if (!HASH.test(version) || typeof value.contentBase64 !== "string") throw new Error("gateway.document_model_source_denied");
  const content = new Uint8Array(Buffer.from(value.contentBase64, "base64"));
  if (createHash("sha256").update(content).digest("hex") !== version) throw new Error("gateway.document_model_source_denied");
  return { documentVersion: version, filename: typeof value.filename === "string" ? value.filename : version, content };
}

const requestOf = (input: unknown) => {
  const raw = input && typeof input === "object" && "input" in input && !("document_type" in input) ? (input as { input: unknown }).input : input;
  const value = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  if (typeof value.document_type !== "string" || !/^[a-z][a-z0-9_]{0,80}$/.test(value.document_type)
    || typeof value.artifact_hash !== "string" || !HASH.test(value.artifact_hash.replace(/^sha256:/, ""))) throw new Error("adapter.input_invalid");
  return { documentType: value.document_type, artifactHash: value.artifact_hash.replace(/^sha256:/, "") };
};

/**
 * Route A for case runs (`document.model.extract.v1`, the library's `document.model`): the run's own original
 * read by the document model of the Document Factory release in effect for the type
 * (`DOCUMENT_MODEL_RELEASE_ENVIRONMENT`), else the platform's prebuilt route for it. The result is field
 * candidates for the library to anchor and adjudicate; nothing is promoted. A type with neither is refused
 * (`adapter.document_model_route_unsupported`) and the wrapper records the route as not run.
 * Off unless `DOCUMENT_MODEL_PROVIDER` and `DOCUMENT_MODEL_REMOTE_ALLOWED=true` are set.
 */
export const documentModelModule: CapabilityAdapterModule = {
  id: "document-model",
  cloud: "vendor",
  label: "Document extraction models",
  supportedKinds: ["tool"],
  enabledByDefault: true,
  create: ({ env, fetch, db }) => {
    const provider = () => documentModelProviderFromEnv(env, fetch);
    const environment = () => env.DOCUMENT_MODEL_RELEASE_ENVIRONMENT?.trim() || null;
    return {
      descriptor: async () => ({
        id: "document-model", label: "Document extraction models", supportedKinds: ["tool"],
        credentialState: provider() ? "Configured" : "Missing",
        bindingOptions: [{ value: PROVIDER, label: "Azure Document Intelligence", description: "The release in effect's model for the type, else the prebuilt model; reads only the run's own document." }],
      }),
      acceptsBinding: (name) => name === PROVIDER,
      invoke: async (name, capability, input, context) => {
        if (name !== PROVIDER || capability.id !== "document.model.extract.v1") throw new Error("gateway.document_model_binding_mismatch");
        const document = context.runDocument;
        if (!document) throw new Error("gateway.document_model_source_denied");
        const request = requestOf(input);
        if (request.artifactHash !== document.documentVersion) throw new Error("gateway.document_model_source_denied");
        const configured = provider();
        if (!configured) throw new Error("gateway.document_model_not_configured");
        const at = environment();
        const released = at ? await releasedDocumentModel(db, { tenantId: context.tenantId, environment: at, documentType: request.documentType }) : null;
        let output, custom = false;
        if (released && released.route !== "llm_only" && released.providerModelId && configured.extractReleased) {
          output = await configured.extractReleased(document.content, request.documentType, { route: released.route, providerModelId: released.providerModelId });
          custom = released.route === "custom";
        } else if (released?.route === "llm_only") {
          throw new Error("adapter.document_model_route_unsupported");
        } else if (configured.supports(request.documentType)) {
          output = await configured.extract(document.content, request.documentType);
        } else throw new Error("adapter.document_model_route_unsupported");
        context.recordAttributes?.({ "harness.document_model.release": released?.releaseDigest.slice(0, 12) ?? "prebuilt", "harness.document_model.model": output.model });
        // An estimate for the run budget: Azure bills analysis per page (custom models at the custom rate).
        const pages = Math.max(1, ...output.fields.map(field => field.page ?? 1));
        const costUsd = pages * (custom ? DEFAULT_FACTORY_PRICES.customPageUsd : DEFAULT_FACTORY_PRICES.layoutPageUsd);
        return { output, provider: PROVIDER, model: output.model, providerRequestId: null, inputTokens: 0, outputTokens: 0, costUsd };
      },
    };
  },
};
