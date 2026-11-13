import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import pg from "pg";

export const CHECKPOINT_SCHEMA = "langgraph_checkpoint";

/**
 * The last of @langchain/langgraph-checkpoint-postgres's own migrations that the control
 * database migrations create (packages/persistence/migrations/043_langgraph_checkpoint_tables.sql).
 * checkpoint.test.ts fails when the installed package has a different number.
 */
export const CHECKPOINT_SCHEMA_VERSION = 4;

/**
 * Open the Postgres checkpoint saver without running its setup().
 *
 * PostgresSaver.setup() starts with CREATE SCHEMA IF NOT EXISTS, which PostgreSQL refuses
 * unless the login holds CREATE on the whole database, even when the schema exists. The
 * control migrations create the schema and tables instead, and the runtime's group holds
 * only DML on them. Here the saver's migration ledger is checked so that a host whose
 * package expects tables the database does not have refuses to start, rather than
 * failing on its first checkpoint.
 */
export async function openPostgresCheckpointSaver(
  connectionString: string,
  schema: string = CHECKPOINT_SCHEMA,
): Promise<PostgresSaver> {
  const pool = new pg.Pool({ connectionString });
  try {
    await assertCheckpointSchema(pool, schema);
  } catch (error) {
    await pool.end().catch(() => undefined);
    throw error;
  }
  return new PostgresSaver(pool, undefined, { schema });
}

async function assertCheckpointSchema(pool: pg.Pool, schema: string): Promise<void> {
  let version: number | null;
  try {
    const result = await pool.query<{ v: number | null }>(
      `select max(v) as v from ${pg.escapeIdentifier(schema)}.checkpoint_migrations`,
    );
    version = result.rows[0]?.v ?? null;
  } catch (error) {
    // 42P01: the control migrations have not created the tables yet.
    if ((error as { code?: string }).code === "42P01") throw new Error("runtime.checkpoint_schema_missing");
    throw error;
  }
  if (version !== CHECKPOINT_SCHEMA_VERSION) {
    throw new Error(`runtime.checkpoint_schema_version_mismatch:${version ?? "none"}:${CHECKPOINT_SCHEMA_VERSION}`);
  }
}
