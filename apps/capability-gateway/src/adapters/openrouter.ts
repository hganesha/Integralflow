import { DOCUMENT_FIELDS_CAPABILITY_ID, invokeDocumentFieldsModel, invokeModel, loadModelProfiles } from "@ehf/adapters";

/** Binding-name prefix of a document-fields connector: `openrouter:document_fields.<model profile>`. */
export const DOCUMENT_FIELDS_BINDING_PREFIX = "document_fields.";
import { isProductionProfile } from "@ehf/identity";
import { getProvider, listActiveModelProfiles, resolveModelProfile, resolveSettingSection } from "@ehf/persistence";
import { credentialFor } from "./shared.js";
import type { CapabilityAdapterModule } from "./types.js";

/**
 * Whether an absent provider credential may be answered by the deterministic recorded
 * adapter. The production profile never allows it, whatever is stored or set, so a
 * deployment cannot report model calls it never made; `platform_default` allows it only
 * while developing.
 */
export function recordedFallbackAllowed(
  env: NodeJS.ProcessEnv,
  administered?: "allow" | "deny" | "platform_default",
): boolean {
  if (isProductionProfile(env)) return false;
  const setting = administered ?? (env.MODEL_RECORDED_FALLBACK as "allow" | "deny" | undefined);
  return setting !== "deny";
}

/**
 * Administered model profiles (`openrouter:<profile-id>`). The profile's provider binding
 * decides the transport: OpenRouter or any OpenAI-compatible base URL (a hosted API, a cloud
 * model service's OpenAI-compatible endpoint, or a self-hosted server), or the deterministic
 * recorded adapter.
 */
export const openRouterModule: CapabilityAdapterModule = {
  id: "openrouter",
  cloud: "any",
  label: "Model",
  supportedKinds: ["model"],
  enabledByDefault: true,
  create: (deps) => {
    const { db, env, modelProfilesPath } = deps;
    return {
      descriptor: async (tenantId) => {
        const administered = await listActiveModelProfiles(db, tenantId);
        const profiles = administered.length > 0
          ? administered.map((record) => record.profile)
          : await loadModelProfiles(modelProfilesPath);
        const providerBindings = await Promise.all(profiles.map((profile) => getProvider(db, tenantId, profile.provider)));
        const allRecorded = providerBindings.length > 0 && providerBindings.every((provider) => provider?.kind === "recorded");
        const allConfigured = providerBindings.every((provider) =>
          provider?.kind === "recorded" || Boolean(credentialFor(provider, env) ?? env.OPENROUTER_API_KEY));
        return {
          id: "openrouter",
          label: "Model",
          supportedKinds: ["model"],
          credentialState: allRecorded ? "Not required" : allConfigured ? "Configured" : "Missing",
          // Each profile serves plain inference, and the library's document.fields as `document_fields.<profile>`.
          bindingOptions: profiles.flatMap((profile) => [
            { value: profile.id, label: profile.id, description: profile.model },
            { value: `${DOCUMENT_FIELDS_BINDING_PREFIX}${profile.id}`, label: `${profile.id} (document fields)`, description: profile.model },
          ]),
        };
      },
      invoke: async (binding, capability, input, context) => {
        // A document-fields connector names its model profile after the prefix, and serves only
        // that capability; a plain profile binding never serves it.
        const documentFields = binding.startsWith(DOCUMENT_FIELDS_BINDING_PREFIX);
        if (documentFields !== (capability.id === DOCUMENT_FIELDS_CAPABILITY_ID)) throw new Error("gateway.model_binding_capability_mismatch");
        const bindingName = documentFields ? binding.slice(DOCUMENT_FIELDS_BINDING_PREFIX.length) : binding;
        const resolved = await resolveModelProfile(db, {
          tenantId: context.tenantId,
          profileId: bindingName,
          expectedDigest: context.expectedModelProfileDigest ?? null,
        });
        const profile = resolved?.profile
          ?? (await loadModelProfiles(modelProfilesPath)).find((item) => item.id === bindingName);
        if (!profile) throw new Error("gateway.model_profile_missing");
        const providerBinding = await getProvider(db, context.tenantId, profile.provider);
        const gatewaySettings = (await resolveSettingSection(db, context.tenantId, "gateway", env)).value;
        context.recordAttributes?.({
          "harness.model.profile_revision": resolved?.revision ?? 0,
          "harness.model.profile_pinned": resolved?.pinned ?? false,
          "harness.model.profile_source": resolved ? "admin-store" : "registry-file",
        });
        const credential = providerBinding ? credentialFor(providerBinding, env) : env.OPENROUTER_API_KEY;
        if (documentFields) {
          // The skill library's document.fields: the request carries its own contract schema, and
          // there is never a recorded answer (packages/adapters invokeDocumentFieldsModel).
          return invokeDocumentFieldsModel({
            fetch: deps.fetch,
            ...(env.FOUNDRY_MODEL_ENDPOINT ? { foundryModelEndpoint: env.FOUNDRY_MODEL_ENDPOINT } : {}),
            profile, input,
            ...(providerBinding ? { providerBinding } : {}),
            ...(credential ? { apiKey: credential } : {}),
            ...(env.OPENROUTER_SITE_URL ? { siteUrl: env.OPENROUTER_SITE_URL } : {}),
            ...(env.OPENROUTER_APP_NAME ? { appName: env.OPENROUTER_APP_NAME } : {}),
          });
        }
        return invokeModel({
          fetch: deps.fetch,
          ...(env.FOUNDRY_MODEL_ENDPOINT ? { foundryModelEndpoint: env.FOUNDRY_MODEL_ENDPOINT } : {}),
          profile,
          input,
          allowRecordedFallback: recordedFallbackAllowed(env, gatewaySettings.recordedFallback),
          capabilityId: capability.id,
          outputSchema: capability.outputSchema,
          ...(providerBinding ? { providerBinding } : {}),
          ...(credential ? { apiKey: credential } : {}),
          ...(env.OPENROUTER_SITE_URL ? { siteUrl: env.OPENROUTER_SITE_URL } : {}),
          ...(env.OPENROUTER_APP_NAME ? { appName: env.OPENROUTER_APP_NAME } : {}),
        });
      },
    };
  },
};
