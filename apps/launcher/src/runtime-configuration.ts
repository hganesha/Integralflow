import { readFile } from "node:fs/promises";
import { skillBundleLockDigest, skillBundleLockSchema } from "@ehf/contracts";
import { autoApproveSkillBundle } from "@ehf/persistence";
import pg from "pg";
import { z } from "zod";
import { createDatabase } from "@ehf/persistence";
import { saveModelProfileRevision, upsertProvider } from "@ehf/persistence/admin";
import { deploymentModelName, type DeploymentCatalog, type DeploymentProfile } from "@ehf/contracts/deployment";
import type { DatabaseTarget } from "./database-targets.js";
import { curatedModelProfiles, resolveModelLimits, runtimeModelBinding, type ModelLimits } from "./runtime-models.js";

export const SERVICE_DATABASE_GRANTS = {
  "control-api": { control: ["ehf_svc_control_api"], context: ["ehf_svc_context_writer"] },
  "case-api": { control: ["ehf_svc_case_execution"], case: ["ehf_svc_case_api", "ehf_svc_case_outbox_relay"] },
  "capability-gateway": { control: ["ehf_svc_capability_gateway"], context: ["ehf_svc_context_retrieval"] },
  "runtime-worker": { control: ["ehf_svc_runtime_dispatcher"] },
  "integration-worker": { control: ["ehf_svc_integration_worker"] },
} as const;
const serviceLoginSchema = z.record(z.string(), z.object({ login: z.string().regex(/^if_[a-z0-9_]{3,59}$/), password: z.string().regex(/^[a-f0-9]{64}$/) }).strict());
/** The autoscaler's login: two queue-depth functions in the control database, nothing else (044_queue_metrics.sql). */
export const QUEUE_SCALER_GRANTS = { control: ["ehf_svc_queue_metrics"] } as const;
export const QUEUE_SCALER = "queue-scaler";
export async function provisionRuntimeLogins(targets: DatabaseTarget[], raw: unknown, profile: DeploymentProfile) {
  const logins = serviceLoginSchema.parse(raw);
  const services = Object.keys(SERVICE_DATABASE_GRANTS);
  const grantsByLogin: Record<string, Record<string, readonly string[]>> = { ...SERVICE_DATABASE_GRANTS, ...(logins[QUEUE_SCALER] ? { [QUEUE_SCALER]: QUEUE_SCALER_GRANTS } : {}) };
  if (targets.some(target => target.store === "discovery")) {
    grantsByLogin["case-api"] = { ...SERVICE_DATABASE_GRANTS["case-api"], discovery: ["ehf_svc_discovery_reader"] };
    grantsByLogin["discovery-worker"] = { control: ["ehf_svc_discovery_observer"], case: ["ehf_svc_discovery_case_reader"],
      discovery: ["ehf_svc_discovery_writer"] };
  }
  const expected = Object.keys(grantsByLogin);
  if (Object.keys(logins).length !== expected.length || services.some(service => !logins[service]) || new Set(Object.values(logins).map(value => value.login)).size !== expected.length || new Set(Object.values(logins).map(value => value.password)).size !== expected.length) throw new Error("database.distinct_service_logins_required");
  const prefix = `if_${profile.environmentId.replaceAll("-", "_")}_`;
  if (Object.values(logins).some(value => !value.login.startsWith(prefix))) throw new Error("database.login_scope_invalid");
  for (const target of targets) {
    const client = new pg.Client({ connectionString: target.connectionString, connectionTimeoutMillis: 5000 });
    await client.connect();
    try {
      await client.query("begin");
      for (const [service, grants] of Object.entries(grantsByLogin)) {
        const groups = (grants as Record<string, readonly string[]>)[target.store];
        if (!groups) continue;
        const { login, password } = logins[service]!;
        const existing = await client.query<{ rolsuper: boolean; rolbypassrls: boolean; rolcreaterole: boolean; rolcreatedb: boolean }>("select rolsuper, rolbypassrls, rolcreaterole, rolcreatedb from pg_roles where rolname=$1", [login]);
        if (existing.rows.some(role => role.rolsuper || role.rolbypassrls || role.rolcreaterole || role.rolcreatedb)) throw new Error("database.existing_login_privileged");
        const quoted = (await client.query<{ value: string }>("select quote_literal($1) as value", [password])).rows[0]!.value;
        // Managed PostgreSQL administrators cannot ALTER superuser-related attributes,
        // even to repeat their existing false values. Existing roles were checked above;
        // rotate only their login/password, retaining those verified restrictions.
        const attributes = existing.rowCount ? "login" : "login nosuperuser nobypassrls nocreatedb nocreaterole";
        await client.query(`${existing.rowCount ? "alter" : "create"} role ${pg.escapeIdentifier(login)} ${attributes} password ${quoted}`);
        for (const group of groups) await client.query(`grant ${pg.escapeIdentifier(group)} to ${pg.escapeIdentifier(login)}`);
      }
      await client.query("commit");
    } catch (error) { await client.query("rollback").catch(() => undefined); throw error; }
    finally { await client.end(); }
  }
}

/**
 * Development only, chosen in the private runtime inputs: register and approve the skill host's
 * bundle lock, the one its image was built with, so library skills run without a second person.
 */
export async function autoApproveDeployedSkillBundle(input: { lockPath: string; expectedLockDigest: string; tenantId: string; environmentId: string }) {
  const lock = skillBundleLockSchema.parse(JSON.parse(await readFile(input.lockPath, "utf8")));
  // The lock in this image must be the one recorded when the skill host image was built.
  if (skillBundleLockDigest(lock) !== input.expectedLockDigest) throw new Error("deployment.skill_bundle_lock_mismatch");
  const database = createDatabase();
  try {
    const { entry, lockDigest } = await autoApproveSkillBundle(database, { tenantId: input.tenantId, lock, registeredBy: `system:deployment:${input.environmentId}` });
    return { digest: entry.digest, status: entry.status, approvedBy: entry.approvedBy ?? null, lockDigest };
  } finally { await database.end(); }
}

export async function publishRuntimeModels(profile: DeploymentProfile, catalog: DeploymentCatalog, tenantId: string, limits: ModelLimits = resolveModelLimits()) {
  const database = createDatabase();
  const actor = { subjectId: "system:onboarding", roles: ["Platform.Admin"] };
  const binding = runtimeModelBinding(profile);
  const provider = binding.providerId;
  try {
    await upsertProvider(database, { tenantId, actor, provider: { id: provider, kind: profile.intelligence.provider === "openrouter" ? "openrouter" : "openai_compatible", displayName: profile.displayName, baseUrl: profile.intelligence.endpoint, credentialRef: binding.credentialName, siteUrl: null, appName: "IntegralFlow", status: "active" }, reason: "Reviewed onboarding deployment" });
    const profiles = curatedModelProfiles(profile, catalog, limits);
    for (const definition of profiles) {
      await saveModelProfileRevision(database, { tenantId, actor, profile: definition, reason: "Reviewed onboarding curated model binding" });
    }
    const selectedIds = profiles.map(definition => definition.id);
    // Existing pinned runs may still resolve superseded profiles; new compilations
    // must not pick an unassigned onboarding tier. Other operator profiles are untouched.
    const ownedIds = [...["low", "med", "high", "xhigh"].map(tier => `model.${profile.environmentId}.${tier}.v1`), "model.document.v1"];
    await database.query("update harness_admin.model_profile_revisions set status='superseded' where tenant_id=$1 and definition->>'provider' like $2 and status='active' and profile_id = any($3::text[]) and not (profile_id = any($4::text[]))", [tenantId, `onboarding.${profile.environmentId}.%`, ownedIds, selectedIds]);
  } finally { await database.end(); }
}
