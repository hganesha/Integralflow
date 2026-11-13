import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { deploymentProfileSchema } from "@ehf/contracts/deployment";
import { databaseTargets, checkDatabases } from "./database-targets.js";
import { autoApproveDeployedSkillBundle, provisionRuntimeLogins, publishRuntimeModels } from "./runtime-configuration.js";
import { resolveModelLimits } from "./runtime-models.js";
import { isDocumentExtractionPlan, skillBundleLockSchema } from "@ehf/contracts";
import { createDatabase, getPlan, requireApprovedSkillBundle, requireExecutableRelease } from "@ehf/persistence";
import { ensureDatabases } from "@ehf/persistence/ensure-databases";
import { qualifyProtectedBucket } from "@ehf/blob-store/qualification";

// Intentionally an operator job, never a web route. Credentials are supplied by
// the deployment platform and are never resolved from an untrusted exported URL.
async function main() {
  const [action, flag, environmentId, ...extra] = process.argv.slice(2);
  if (!["check", "apply"].includes(action ?? "") || extra.length || (action === "check" ? Boolean(flag) : flag !== "--environment" || !environmentId)) throw new Error("migration.usage: check | apply --environment ENVIRONMENT_ID");
  const bundlePath = process.env.DEPLOYMENT_BUNDLE_PATH;
  if (!bundlePath && !process.env.DEPLOYMENT_BUNDLE_JSON) throw new Error("migration.bundle_path_required");
  const bundle = JSON.parse(process.env.DEPLOYMENT_BUNDLE_JSON ?? await readFile(bundlePath!, "utf8"));
  if (bundle.apiVersion !== "integralflow/deployment-bundle-v1") throw new Error("migration.bundle_version_invalid");
  const profile = deploymentProfileSchema.parse(bundle.profile);
  if (action === "apply" && (environmentId !== profile.environmentId || bundle.phase !== "configured")) throw new Error("migration.prepared_environment_confirmation_required");
  // Always default to the production posture. A local smoke explicitly chooses development.
  process.env.SECURITY_PROFILE ??= "production";
  const targets = databaseTargets(profile, process.env);
  if (process.env.DEPLOYMENT_OBJECT_STORE) await qualifyProtectedBucket(JSON.parse(process.env.DEPLOYMENT_OBJECT_STORE));
  const discovery = targets.find(target => target.store === "discovery");
  if (action === "apply" && discovery) {
    const maintenance = targets.find(target => target.store === "control")!;
    try {
      await ensureDatabases(maintenance.connectionString, [discovery.database]);
    } catch {
      throw new Error("migration.discovery_database_provision_failed");
    }
  }
  const checks = await checkDatabases(targets);
  process.stdout.write(JSON.stringify({ environmentId: profile.environmentId, revision: bundle.revision, action: "check", results: checks }) + "\n");
  if (checks.some(check => check.status !== "passed")) { process.exitCode = 1; return; }
  if (action === "check") return;
  const completed: string[] = [];
  for (const target of [...targets.map(target => ({ store: target.store, service: `migrate-${target.store}` })),
    { store: "authoring", service: "seed-authoring" }]) {
    const entry = fileURLToPath(new URL(`../${target.service}/server.mjs`, import.meta.url));
    const result = await new Promise<{ status: number | null; code: string }>((resolve, reject) => {
      // Suppress raw database errors (which can contain SQL or credential material).
      const child = spawn(process.execPath, [entry], { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, PGCONNECT_TIMEOUT: "5", PGOPTIONS: "-c statement_timeout=120000 -c lock_timeout=30000" } });
      let diagnostic = "";
      child.stderr.on("data", chunk => { diagnostic = (diagnostic + String(chunk)).slice(-4096); });
      const timeout = setTimeout(() => child.kill("SIGKILL"), 600_000);
      child.once("error", error => { clearTimeout(timeout); reject(error); });
      child.once("close", status => {
        clearTimeout(timeout);
        let code = "migration.store_failed";
        try { const value = JSON.parse(diagnostic.trim().split("\n").at(-1) ?? ""); if (/^[A-Z0-9]{5}$/.test(value.code)) code = value.code; } catch { /* Raw diagnostics are never returned. */ }
        resolve({ status, code });
      });
    });
    if (result.status !== 0) {
      process.stdout.write(JSON.stringify({ action: "apply", status: "failed", completed, failed: target.store, code: result.code, message: "Migrations are transactional per file, not across stores. Correct privileges or migration errors and rerun the same image; completed migrations are checksum protected." }) + "\n");
      process.exitCode = 1; return;
    }
    completed.push(target.store);
  }
  if (process.env.DEPLOYMENT_SERVICE_LOGINS) await provisionRuntimeLogins(targets, JSON.parse(process.env.DEPLOYMENT_SERVICE_LOGINS), profile);
  if (process.env.DEPLOYMENT_MODEL_CATALOG) {
    if (!process.env.PLATFORM_TENANT_ID) throw new Error("migration.tenant_required");
    await publishRuntimeModels(profile, JSON.parse(process.env.DEPLOYMENT_MODEL_CATALOG), process.env.PLATFORM_TENANT_ID, resolveModelLimits(JSON.parse(process.env.DEPLOYMENT_MODEL_LIMITS ?? "{}")));
  }
  // Development deployments only (the runtime inputs' skillHost.autoApproveBundle).
  let skillBundle: Awaited<ReturnType<typeof autoApproveDeployedSkillBundle>> | undefined;
  if (process.env.DEPLOYMENT_SKILL_BUNDLE_LOCK_DIGEST) {
    if (!process.env.PLATFORM_TENANT_ID) throw new Error("migration.tenant_required");
    skillBundle = await autoApproveDeployedSkillBundle({ lockPath: process.env.SKILL_BUNDLE_LOCK_PATH ?? "/app/config/skill-bundle.lock.json",
      expectedLockDigest: process.env.DEPLOYMENT_SKILL_BUNDLE_LOCK_DIGEST, tenantId: process.env.PLATFORM_TENANT_ID, environmentId: profile.environmentId });
  }
  const documentDigest = profile.intelligence.documentServices?.extractionPlanDigest;
  if (documentDigest) {
    const tenantId = process.env.PLATFORM_TENANT_ID;
    if (!tenantId) throw new Error("migration.tenant_required");
    const database = createDatabase();
    try {
      const plan = await getPlan(database, documentDigest, tenantId);
      if (!plan || !isDocumentExtractionPlan(plan)) throw new Error("deployment.document_plan_invalid");
      await requireExecutableRelease(database, tenantId, documentDigest, "development");
      const lock = skillBundleLockSchema.parse(JSON.parse(await readFile(process.env.SKILL_BUNDLE_LOCK_PATH ?? "/app/config/skill-bundle.lock.json", "utf8")));
      if (plan.skillBindings?.some(binding => binding.bundleDigest?.replace(/^sha256:/, "") !== lock.bundle_digest.replace(/^sha256:/, ""))) {
        throw new Error("deployment.document_plan_bundle_mismatch");
      }
      try { await requireApprovedSkillBundle(database, tenantId, lock); }
      catch { throw new Error("deployment.document_skill_bundle_not_approved"); }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("deployment.document_")) throw error;
      throw new Error("deployment.document_plan_not_active");
    } finally { await database.end(); }
  }
  process.stdout.write(JSON.stringify({ action: "apply", status: "passed", environmentId: profile.environmentId, revision: bundle.revision, completed, ...(skillBundle ? { skillBundle } : {}), runtimeReady: false, message: "Schemas and grants applied. Service login bindings, workload identities, runtime hosting and connector qualification remain separate steps." }) + "\n");
}
try { await main(); } catch (error) {
  const code = error instanceof Error && /^(migration\.|database\.|deployment\.|platform\.|blob\.)/.test(error.message) ? error.message : "migration.invalid_input_or_execution_failed";
  process.stderr.write(code + "\n"); process.exitCode = 1;
}
