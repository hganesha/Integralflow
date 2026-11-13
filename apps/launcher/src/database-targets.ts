import pg from "pg";
import { assertPlatformInvariants } from "@ehf/identity";
import type { DeploymentProfile } from "@ehf/contracts/deployment";

const SETTINGS = { control: "DATABASE_URL", case: "CASE_DATABASE_URL", context: "CONTEXT_DATABASE_URL", discovery: "DISCOVERY_DATABASE_URL" } as const;
export type DatabaseTarget = { store: keyof typeof SETTINGS; connectionString: string; database: string };
export function databaseTargets(profile: DeploymentProfile, env: NodeJS.ProcessEnv): DatabaseTarget[] {
  assertPlatformInvariants({ mechanisms: ["DATABASE_AUTH"], forbidden: ["DATABASE_BOOTSTRAP_URL", "DATABASE_DEV_LOGIN_PASSWORD"] }, env);
  if (!profile.foundation.database.host) throw new Error("database.profile_host_required");
  const targets = Object.entries(SETTINGS).filter(([store]) => store !== "discovery" || env.DISCOVERY_DATABASE_URL).map(([store, setting]) => {
    const value = env[setting];
    if (!value) throw new Error(`database.setting_required:${setting}`);
    let url: URL;
    try { url = new URL(value); } catch { throw new Error(`database.url_invalid:${setting}`); }
    if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.username || url.password || url.hash) throw new Error(`database.passwordless_url_required:${setting}`);
    if (url.hostname.toLowerCase() !== profile.foundation.database.host.toLowerCase() || Number(url.port || 5432) !== profile.foundation.database.port) throw new Error(`database.profile_target_mismatch:${setting}`);
    // libpq query parameters can override host/user/password or weaken certificate
    // verification. Accept only the explicit TLS policy; credentials stay mounted.
    if ([...url.searchParams.keys()].some(key => key !== "sslmode") || url.searchParams.getAll("sslmode").length > 1) throw new Error(`database.url_parameters_refused:${setting}`);
    if (env.SECURITY_PROFILE !== "development" && url.searchParams.get("sslmode") !== "verify-full") throw new Error(`database.verified_tls_required:${setting}`);
    if (env.SECURITY_PROFILE === "development" && ![null, "disable", "verify-full"].includes(url.searchParams.get("sslmode"))) throw new Error(`database.tls_policy_invalid:${setting}`);
    const database = decodeURIComponent(url.pathname.slice(1));
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(database)) throw new Error(`database.name_invalid:${setting}`);
    return { store: store as DatabaseTarget["store"], connectionString: value, database };
  });
  if (new Set(targets.map(target => target.database)).size !== targets.length) throw new Error("database.stores_must_be_distinct");
  return targets;
}

export type DatabaseCheck = { store: string; database: string; status: "passed" | "failed"; checks: Array<{ id: string; passed: boolean }>; message: string };
export async function checkDatabases(targets: DatabaseTarget[], createClient = (target: DatabaseTarget) => new pg.Client({ connectionString: target.connectionString, connectionTimeoutMillis: 5_000, query_timeout: 8_000, statement_timeout: 5_000, application_name: "integralflow-deployment-check" })) : Promise<DatabaseCheck[]> {
  const results: DatabaseCheck[] = [];
  for (const target of targets) {
    const client = createClient(target);
    try {
      await client.connect();
      await client.query("begin read only");
      const result = await client.query<{ version: number; superuser: boolean; createdb: boolean; shared: string; session: string }>(`select current_setting('server_version_num')::int as version,
        (select rolsuper from pg_roles where rolname = current_user) as superuser,
        has_database_privilege(current_database(), 'CREATE') as createdb,
        current_setting('shared_preload_libraries') as shared, current_setting('session_preload_libraries') as session`);
      const row = result.rows[0]!;
      const extensions = await client.query<{ name: string }>("select name from pg_available_extensions where name in ('vector', 'age')");
      const required = target.store === "context" ? ["vector", "age"] : target.store === "case" ? ["vector"] : [];
      const hasAge = [row.shared, row.session].some(list => list.split(",").some(item => item.trim().replace(/^"|"$/g, "") === "age"));
      const checks = [{ id: "postgresql-17-or-newer", passed: row.version >= 170000 }, { id: "schema-create-privilege", passed: row.createdb },
        ...required.map(name => ({ id: `extension-available:${name}`, passed: extensions.rows.some(extension => extension.name === name) })),
        ...(target.store === "context" ? [{ id: "age-load-authority", passed: hasAge || row.superuser }] : [])];
      await client.query("rollback");
      const passed = checks.every(check => check.passed);
      results.push({ store: target.store, database: target.database, status: passed ? "passed" : "failed", checks, message: passed ? "Read-only compatibility checks passed. Migration and grant privileges are verified when applying migrations." : "Database compatibility requirements are unmet. No schema changes were made." });
    } catch {
      results.push({ store: target.store, database: target.database, status: "failed", checks: [], message: "Connection or read-only inspection failed. Check mounted credentials, TLS trust and database reachability; server errors are not retained." });
    } finally { await client.end().catch(() => undefined); }
  }
  return results;
}
