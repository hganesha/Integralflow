import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { emptyCheckpoint } from "@langchain/langgraph-checkpoint";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { CHECKPOINT_SCHEMA, CHECKPOINT_SCHEMA_VERSION, openPostgresCheckpointSaver } from "./checkpoint.js";

// The saver's migrations are not exported; load them from the installed package so an
// upgrade that adds one fails here rather than at a runtime host's first checkpoint.
async function packageMigrations(): Promise<string[]> {
  const require = createRequire(import.meta.url);
  const entry = require.resolve("@langchain/langgraph-checkpoint-postgres");
  const module = await import(pathToFileURL(join(dirname(entry), "migrations.js")).href) as {
    getMigrations: (schema: string) => string[];
  };
  return module.getMigrations(CHECKPOINT_SCHEMA);
}

describe("checkpoint schema version", () => {
  it("matches the installed saver's migrations", async () => {
    expect((await packageMigrations()).length - 1).toBe(CHECKPOINT_SCHEMA_VERSION);
  });

  it("matches what the control migration records", async () => {
    const migration = await readFile(new URL("../../../packages/persistence/migrations/043_langgraph_checkpoint_tables.sql", import.meta.url), "utf8");
    expect(migration).toContain(`generate_series(0, ${CHECKPOINT_SCHEMA_VERSION})`);
  });
});

// Against a real PostgreSQL. EHF_TEST_DATABASE_URL must point at a database migrated by
// @ehf/persistence, as a role that can create roles; the test creates one throwaway login
// in the runtime host's group (ehf_svc_runtime_checkpoint) and drops it afterwards.
const adminUrl = process.env.EHF_TEST_DATABASE_URL;

describe.skipIf(!adminUrl)("Postgres checkpoint saver as the runtime host's role", () => {
  let admin: pg.Pool;
  let login = "";
  let runtimeUrl = "";
  let canRun = false;

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
    const self = await admin.query<{ rolsuper: boolean; rolcreaterole: boolean }>("select rolsuper, rolcreaterole from pg_roles where rolname = current_user");
    canRun = Boolean(self.rows[0]?.rolsuper || self.rows[0]?.rolcreaterole);
    if (!canRun) return;
    login = `ehf_test_runtime_host_${randomBytes(4).toString("hex")}`;
    const password = randomBytes(18).toString("hex");
    await admin.query(`create role ${login} login password '${password}' nosuperuser nobypassrls`);
    await admin.query(`grant ehf_svc_runtime_checkpoint to ${login}`);
    const url = new URL(adminUrl!);
    url.username = login; url.password = password;
    runtimeUrl = url.toString();
  });

  afterAll(async () => {
    if (login) await admin.query(`drop role if exists ${login}`);
    await admin?.end();
  });

  it("cannot run the saver's own setup(), which needs CREATE on the database", async ({ skip }) => {
    if (!canRun) skip();
    // The reason runtime-host does not call setup(): CREATE SCHEMA IF NOT EXISTS is checked
    // against the database before the schema's existence.
    const saver = PostgresSaver.fromConnString(runtimeUrl, { schema: CHECKPOINT_SCHEMA });
    try {
      await expect(saver.setup()).rejects.toThrow(/permission denied for database/);
    } finally {
      await saver.end();
    }
  });

  it("opens the saver and checkpoints, reads and deletes a thread", async ({ skip }) => {
    if (!canRun) skip();
    const saver = await openPostgresCheckpointSaver(runtimeUrl);
    try {
      const threadId = `run_${randomUUID()}`;
      const config = { configurable: { thread_id: threadId, checkpoint_ns: "plan-digest" } };
      const checkpoint = { ...emptyCheckpoint(), channel_values: { state: { step: 1 } }, channel_versions: { state: 1 } };
      const saved = await saver.put(config, checkpoint, { source: "input", step: -1, parents: {} }, { state: 1 });
      await saver.putWrites(saved, [["state", { step: 2 }]], "task-1");
      const tuple = await saver.getTuple(config);
      expect(tuple?.checkpoint.id).toBe(checkpoint.id);
      expect(tuple?.checkpoint.channel_values).toEqual({ state: { step: 1 } });
      expect(tuple?.pendingWrites).toEqual([["task-1", "state", { step: 2 }]]);
      await saver.deleteThread(threadId);
      expect(await saver.getTuple(config)).toBeUndefined();
    } finally {
      await saver.end();
    }
  });

  it("holds no DDL in the database or the checkpoint schema", async ({ skip }) => {
    if (!canRun) skip();
    const privileges = await admin.query<{ database_create: boolean; schema_create: boolean }>(`
      select has_database_privilege($1, current_database(), 'CREATE') as database_create,
             has_schema_privilege($1, $2, 'CREATE') as schema_create
    `, [login, CHECKPOINT_SCHEMA]);
    expect(privileges.rows[0]).toEqual({ database_create: false, schema_create: false });
    const runtime = new pg.Pool({ connectionString: runtimeUrl, max: 1 });
    try {
      await expect(runtime.query(`create table ${CHECKPOINT_SCHEMA}.not_allowed (id int)`)).rejects.toThrow(/permission denied/);
      await expect(runtime.query(`insert into ${CHECKPOINT_SCHEMA}.checkpoint_migrations (v) values (99)`)).rejects.toThrow(/permission denied/);
    } finally {
      await runtime.end();
    }
  });

  it("has tables identical to the ones the saver's setup() creates", async ({ skip }) => {
    if (!canRun) skip();
    await withReferenceSchema(async (scratch) => {
      const shape = async (schema: string) => (await admin.query(`
        select c.table_name, c.column_name, c.data_type, c.is_nullable, c.column_default, c.ordinal_position
        from information_schema.columns c where c.table_schema = $1
        order by c.table_name, c.ordinal_position
      `, [schema])).rows;
      const keys = async (schema: string) => (await admin.query(`
        select t.relname as table_name, pg_get_constraintdef(k.oid) as definition
        from pg_constraint k join pg_class t on t.oid = k.conrelid join pg_namespace n on n.oid = t.relnamespace
        where n.nspname = $1 order by 1, 2
      `, [schema])).rows;
      const versions = async (schema: string) => (await admin.query(`select v from ${pg.escapeIdentifier(schema)}.checkpoint_migrations order by v`)).rows;
      expect(await shape(CHECKPOINT_SCHEMA)).toEqual(await shape(scratch));
      expect(await keys(CHECKPOINT_SCHEMA)).toEqual(await keys(scratch));
      expect(await versions(CHECKPOINT_SCHEMA)).toEqual(await versions(scratch));
    });
  });

  it("refuses to start against tables at another version, or none", async ({ skip }) => {
    if (!canRun) skip();
    // A control database migrated before the package added a migration: same tables, a
    // ledger one version behind.
    await withReferenceSchema(async (scratch) => {
      await admin.query(`delete from ${pg.escapeIdentifier(scratch)}.checkpoint_migrations where v = $1`, [CHECKPOINT_SCHEMA_VERSION]);
      await admin.query(`grant usage on schema ${pg.escapeIdentifier(scratch)} to ${login}`);
      await admin.query(`grant select on ${pg.escapeIdentifier(scratch)}.checkpoint_migrations to ${login}`);
      await expect(openPostgresCheckpointSaver(runtimeUrl, scratch)).rejects.toThrow(
        `runtime.checkpoint_schema_version_mismatch:${CHECKPOINT_SCHEMA_VERSION - 1}:${CHECKPOINT_SCHEMA_VERSION}`,
      );
      await admin.query(`drop table ${pg.escapeIdentifier(scratch)}.checkpoint_migrations cascade`);
      await expect(openPostgresCheckpointSaver(runtimeUrl, scratch)).rejects.toThrow("runtime.checkpoint_schema_missing");
    });
  });

  /** A schema built by the saver's own setup(), as a superuser would, dropped afterwards. */
  async function withReferenceSchema(use: (schema: string) => Promise<void>): Promise<void> {
    const scratch = `ehf_test_checkpoint_${randomBytes(4).toString("hex")}`;
    const reference = new PostgresSaver(admin, undefined, { schema: scratch });
    try {
      await reference.setup();
      await use(scratch);
    } finally {
      await admin.query(`drop schema if exists ${pg.escapeIdentifier(scratch)} cascade`);
    }
  }
});
