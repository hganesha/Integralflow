import { z } from "zod";
import type { ModelProfileRegistry } from "@ehf/compiler";
import {
  PLATFORM_SETTING_FIELDS,
  PLATFORM_SETTING_SCOPES,
  platformSettingSectionSchema,
  type PlatformSettingSection,
} from "@ehf/contracts";
import {
  AdminConfigError,
  activateModelProfileRevision,
  listActiveModelProfiles,
  listAdminChanges,
  listModelProfileRevisions,
  listProviders,
  getProvider,
  resolvePlatformSettings,
  saveModelProfileRevision,
  saveSettingSection,
  upsertProvider,
  type AdminActor,
  type Database,
} from "@ehf/persistence";
import { isProductionProfile } from "@ehf/identity";

export { AdminConfigError };

export type AdminRouteDeps = {
  db: Database;
  env: NodeJS.ProcessEnv;
};

/**
 * Turn a schema rejection into the operator's answer.
 *
 * A malformed provider or profile is a bad request, not a server fault: surfacing it as
 * a 500 tells an administrator their platform is broken when in fact their input is, and
 * hands them a stack trace instead of the field that failed.
 */
async function validated<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof z.ZodError) {
      const issue = error.issues[0];
      const path = issue?.path.join(".");
      throw new AdminConfigError(
        `admin.invalid_input${path ? `:${path}` : ""} ${issue?.message ?? ""}`.trim(),
        400,
      );
    }
    throw error;
  }
}

function reasonOf(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const reason = (body as { reason?: unknown }).reason;
  return typeof reason === "string" && reason.trim() ? reason.trim().slice(0, 500) : null;
}

/**
 * The catalogue the control surface renders.
 *
 * It travels with the values rather than being duplicated in the UI, so a knob cannot be
 * shown without saying which service reads it and whether saving it takes effect now or
 * at the next restart. A setting presented as live when it is not is worse than one that
 * is not presented at all.
 */
export async function adminSettingsView(deps: AdminRouteDeps, tenantId: string) {
  const resolved = await resolvePlatformSettings(deps.db, tenantId, deps.env);
  return {
    sections: resolved.map((section) => ({
      ...section,
      ...PLATFORM_SETTING_SCOPES[section.section],
      deploymentManaged: isProductionProfile(deps.env) && ["runtime", "observability"].includes(section.section),
      // The field descriptors travel with the values so the control surface renders a
      // typed control, its help and which service reads it, without keeping a second
      // copy of the catalogue that would drift from this one.
      fields: PLATFORM_SETTING_FIELDS[section.section].map((field) => ({
        ...field,
        // Whether this specific field is being held by an environment variable. A
        // section can be reported as stored while one of its fields is still whatever
        // the process was started with, and the operator has to be able to see that.
        envPresent: field.envName ? Boolean(deps.env[field.envName]?.trim()) : false,
      })),
    })),
  };
}

export async function adminProvidersView(deps: AdminRouteDeps, tenantId: string) {
  const providers = await listProviders(deps.db, tenantId);
  return {
    providers: providers.map((record) => ({
      ...record,
      deploymentManaged: isProductionProfile(deps.env),
      // Whether the named variable is actually populated in *this* process. The control
      // plane holds no provider credential, so this is a presence check against its own
      // environment and is reported as advisory; the gateway is the authority.
      credentialPresent: record.provider.credentialRef
        ? Boolean(deps.env[record.provider.credentialRef]?.trim())
        : null,
    })),
  };
}

export async function adminModelProfilesView(deps: AdminRouteDeps, tenantId: string) {
  const [active, revisions] = await Promise.all([
    listActiveModelProfiles(deps.db, tenantId),
    listModelProfileRevisions(deps.db, tenantId),
  ]);
  return {
    profiles: active.map((record) => ({
      ...record,
      revisions: revisions
        .filter((revision) => revision.profile.id === record.profile.id)
        .map(({ revision, digest, status, note, createdAt, createdBy, profile }) => ({
          revision, digest, status, note, createdAt, createdBy, profile,
        })),
    })),
  };
}

export async function adminChangeLogView(deps: AdminRouteDeps, tenantId: string, limit?: number) {
  return { changes: await listAdminChanges(deps.db, tenantId, limit ?? 100) };
}

export async function writeProvider(deps: AdminRouteDeps, input: {
  tenantId: string; actor: AdminActor; providerId: string; body: unknown;
}) {
  const body = (input.body ?? {}) as Record<string, unknown>;
  const provider = { ...(body.provider ?? body) as Record<string, unknown>, id: input.providerId };
  if (isProductionProfile(deps.env)) {
    const previous = await getProvider(deps.db, input.tenantId, input.providerId);
    if (!previous || ["kind", "baseUrl", "credentialRef"].some((key) => provider[key as keyof typeof provider] !== previous[key as keyof typeof previous])) {
      throw new AdminConfigError("admin.immutable_provider_binding_requires_deployment", 409);
    }
    if (!reasonOf(body)) throw new AdminConfigError("admin.change_reason_required", 400);
  }
  return validated(() => upsertProvider(deps.db, {
    tenantId: input.tenantId, actor: input.actor, provider, reason: reasonOf(body),
  }));
}

export async function writeModelProfile(deps: AdminRouteDeps, input: {
  tenantId: string; actor: AdminActor; profileId: string; body: unknown;
}) {
  const body = (input.body ?? {}) as Record<string, unknown>;
  const profile = { ...(body.profile ?? body) as Record<string, unknown>, id: input.profileId };
  if (isProductionProfile(deps.env)) {
    const current = (await listActiveModelProfiles(deps.db, input.tenantId)).find((item) => item.profile.id === input.profileId);
    if (!current || ["provider", "model"].some((key) => profile[key as keyof typeof profile] !== current.profile[key as keyof typeof current.profile])) {
      throw new AdminConfigError("admin.model_deployment_change_requires_deployment", 409);
    }
    if (!reasonOf(body)) throw new AdminConfigError("admin.change_reason_required", 400);
  }
  const note = typeof body.note === "string" && body.note.trim() ? body.note.trim().slice(0, 500) : null;
  return validated(() => saveModelProfileRevision(deps.db, {
    tenantId: input.tenantId, actor: input.actor, profile, note, reason: reasonOf(body),
  }));
}

export async function activateModelProfile(deps: AdminRouteDeps, input: {
  tenantId: string; actor: AdminActor; profileId: string; body: unknown;
}) {
  const body = (input.body ?? {}) as Record<string, unknown>;
  const revision = Number(body.revision);
  if (!Number.isInteger(revision) || revision < 1) throw new AdminConfigError("admin.revision_invalid");
  if (isProductionProfile(deps.env)) {
    const [current, revisions] = await Promise.all([listActiveModelProfiles(deps.db, input.tenantId), listModelProfileRevisions(deps.db, input.tenantId, input.profileId)]);
    const active = current.find((item) => item.profile.id === input.profileId)?.profile;
    const target = revisions.find((item) => item.revision === revision)?.profile;
    if (!active || !target || active.provider !== target.provider || active.model !== target.model) throw new AdminConfigError("admin.model_deployment_change_requires_deployment", 409);
    if (!reasonOf(body)) throw new AdminConfigError("admin.change_reason_required", 400);
  }
  return activateModelProfileRevision(deps.db, {
    tenantId: input.tenantId, actor: input.actor, profileId: input.profileId, revision, reason: reasonOf(body),
  });
}

export async function writeSettingSection(deps: AdminRouteDeps, input: {
  tenantId: string; actor: AdminActor; section: string; body: unknown;
}) {
  return validated(async () => {
    const section: PlatformSettingSection = platformSettingSectionSchema.parse(input.section);
    const body = (input.body ?? {}) as Record<string, unknown>;
    const value = body.value ?? body;
    if (isProductionProfile(deps.env)) {
      if (["runtime", "observability"].includes(section)) throw new AdminConfigError("admin.immutable_infrastructure_requires_deployment", 409);
      if (section === "gateway" && (value as Record<string, unknown>).recordedFallback === "allow") throw new AdminConfigError("admin.recorded_fallback_forbidden_in_production", 409);
      if (!reasonOf(body)) throw new AdminConfigError("admin.change_reason_required", 400);
    }
    const saved = await saveSettingSection(deps.db, {
      tenantId: input.tenantId, actor: input.actor, section, value, reason: reasonOf(body),
    });
    return { ...saved, ...PLATFORM_SETTING_SCOPES[section] };
  });
}

/**
 * The tenant's administered profiles as the model profile registry a plan is compiled against.
 *
 * The compiler digests each profile into the plan, so this is what makes an administered
 * edit reach a new compilation. Without it the control panel would change what an
 * invocation resolves but not what a plan is compiled against, and the two would drift
 * apart silently. The registry is a plain JSON document (it round-trips through JSON), so
 * its digests are those of the registry file it replaces.
 *
 * Returns null when the tenant has nothing administered, which leaves the caller on the
 * checked-in registry file it used before.
 */
export async function administeredModelProfileRegistry(
  deps: AdminRouteDeps, tenantId: string,
): Promise<ModelProfileRegistry | null> {
  const active = await listActiveModelProfiles(deps.db, tenantId);
  if (active.length === 0) return null;
  return JSON.parse(JSON.stringify({
    apiVersion: "harness.factory/model-profiles-v1",
    profiles: active.map((record) => record.profile),
  })) as ModelProfileRegistry;
}
