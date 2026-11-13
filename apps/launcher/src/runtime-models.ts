import { createHash } from "node:crypto";
import { z } from "zod";
import { deploymentModelName, type DeploymentCatalog, type DeploymentProfile } from "@ehf/contracts/deployment";

/** Public endpoint/ref fingerprint; never hash or publish the credential value. */
export function runtimeModelBinding(profile: DeploymentProfile) {
  const fingerprint = createHash("sha256").update(JSON.stringify([profile.environmentId, profile.intelligence.provider, profile.intelligence.endpoint, profile.intelligence.credentialRef])).digest("hex").slice(0, 24);
  return { providerId: `onboarding.${profile.environmentId}.${fingerprint}`, credentialName: `ONBOARDING_MODEL_TOKEN_${fingerprint.toUpperCase()}` };
}

/**
 * Limits applied to every curated model profile a deployment publishes. Defaults suit a
 * pilot; raise maxConcurrency to the provider contract's rate limit (runtime inputs
 * `modelLimits`). Bounds match modelProfileDocumentSchema.
 */
export const DEFAULT_MODEL_LIMITS = { maxConcurrency: 2, timeoutMs: 60_000, maxOutputTokens: 2_048 } as const;
export const modelLimitsSchema = z.object({
  maxConcurrency: z.number().int().min(1).max(64),
  timeoutMs: z.number().int().min(1_000).max(600_000),
  maxOutputTokens: z.number().int().min(1).max(200_000),
}).partial().strict();
export type ModelLimits = { maxConcurrency: number; timeoutMs: number; maxOutputTokens: number };
export function resolveModelLimits(overrides: unknown = {}): ModelLimits {
  const given = Object.fromEntries(Object.entries(modelLimitsSchema.parse(overrides ?? {})).filter(([, value]) => value !== undefined));
  return { ...DEFAULT_MODEL_LIMITS, ...given };
}

/** The one definition of the model profiles a deployment publishes: the recipe's file and the migration job's registry revisions. */
export function curatedModelProfiles(profile: DeploymentProfile, catalog: DeploymentCatalog, limits: ModelLimits) {
  const provider = runtimeModelBinding(profile).providerId;
  const profiles = Object.entries(profile.intelligence.models).filter(([, id]) => id).map(([tier, id]) => {
    const model = deploymentModelName(profile, catalog, tier);
    if (!model) throw new Error("deployment.curated_model_missing");
    return { id: `model.${profile.environmentId}.${tier}.v1`, provider, model, ...limits };
  });
  const documents = profile.intelligence.documentServices;
  if (documents) {
    const model = deploymentModelName(profile, catalog, documents.modelTier);
    if (!model) throw new Error("deployment.document_model_tier_required");
    profiles.push({ id: "model.document.v1", provider, model,
      maxConcurrency: limits.maxConcurrency, timeoutMs: 150_000, maxOutputTokens: 16_000 });
  }
  return profiles;
}
