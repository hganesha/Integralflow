import { importCanonicalCatalog } from "@ehf/fincrime-integration";
import type { Database } from "@ehf/persistence";

/** Imported versions are immutable, tenant-scoped drafts; importing never activates a release. */
export async function importFinancialCrimeCatalog(db: Database, tenantId: string, actorId: string, artifact: unknown, expectedDigest: string) {
  const imported = importCanonicalCatalog(artifact, expectedDigest);
  const client = await db.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('app.tenant_id',$1,true)", [tenantId]);
    await client.query(`insert into harness_control.canonical_catalogs
      (tenant_id,catalog_digest,source_release,bundle_code_hash,artifact,imported_by)
      values ($1,$2,$3,$4,$5::jsonb,$6) on conflict do nothing`,
    [tenantId, expectedDigest, imported.catalog.sourceRelease, imported.catalog.bundleCodeHash, JSON.stringify(artifact), actorId]);
    await client.query("commit");
    return { catalogDigest: expectedDigest, sourceRelease: imported.catalog.sourceRelease, status: "draft",
      skills: imported.skills.length, agents: imported.agents.length, tasks: imported.catalog.tasks.length };
  } catch (error) { await client.query("rollback"); throw error; }
  finally { client.release(); }
}

export async function readFinancialCrimeCatalog(db: Database, tenantId: string, digest: string) {
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("fincrime.catalog_digest_invalid");
  const client = await db.connect();
  try {
    await client.query("begin read only");
    await client.query("select set_config('app.tenant_id',$1,true)", [tenantId]);
    const result = await client.query<{ artifact: unknown }>(
      "select artifact from harness_control.canonical_catalogs where tenant_id=$1 and catalog_digest=$2", [tenantId,digest]);
    await client.query("commit");
    return result.rows[0] ? importCanonicalCatalog(result.rows[0].artifact, digest) : null;
  } catch (error) { await client.query("rollback"); throw error; }
  finally { client.release(); }
}
