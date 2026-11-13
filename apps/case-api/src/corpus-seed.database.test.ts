import { execFileSync } from "node:child_process";
import { randomInt } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { createCaseStore, type CaseStore } from "@ehf/case-store";
import { readParty, seedParty } from "@ehf/context-corpus";
import { buildCaseApi } from "./app.js";

// Seeds corpus parties through the real case API and a real Postgres, using the local server
// binaries (initdb, pg_ctl). Opt in with EHF_RUN_CORPUS_DB_TESTS=1.
const root = fileURLToPath(new URL("../../../fixtures/context-corpus", import.meta.url));
const migrations = new URL("../../../packages/case-store/migrations/", import.meta.url);
const tenantId = "tenant_demo";

it.skipIf(process.env.EHF_RUN_CORPUS_DB_TESTS !== "1")("seeds H04, H06, H07, H10 and H12 through the case API into Postgres, idempotently", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corpus-pg-"));
  const port = 20000 + randomInt(20000);
  const pg = (bin: string, args: string[]) => execFileSync(bin, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, LC_ALL: "en_US.UTF-8" } });
  pg("initdb", ["-D", join(dir, "data"), "-U", "postgres", "--auth=trust", "-E", "UTF8"]);
  pg("pg_ctl", ["-D", join(dir, "data"), "-o", `-p ${port} -c unix_socket_directories= -c listen_addresses=127.0.0.1`, "-l", join(dir, "log"), "-w", "start"]);
  let store: CaseStore | undefined;
  try {
    const admin = createCaseStore({ connectionString: `postgresql://postgres@127.0.0.1:${port}/postgres` });
    await admin.db.query("create database ehf_case");
    await admin.db.end?.();
    const db = (store = createCaseStore({ connectionString: `postgresql://postgres@127.0.0.1:${port}/ehf_case` })).db;
    // Local Postgres has no pgvector; the knowledge-search migrations are irrelevant to canonical records.
    for (const file of readdirSync(migrations).filter((f) => f.endsWith(".sql")).sort()) {
      const sql = readFileSync(new URL(file, migrations), "utf8");
      if (/vector|knowledge_chunks/i.test(sql)) continue;
      await db.query(sql.replaceAll("{{CASE_CORE_SCHEMA}}", '"case_core"')
        .replaceAll("{{CASE_LEDGER_SCHEMA}}", '"case_ledger"').replaceAll("{{EVIDENCE_SCHEMA}}", '"evidence"'));
    }
    // append_event is owned by ehf_ledger_writer (migration 013), which needs table access to write the chain.
    await db.query('grant usage on schema case_ledger to ehf_ledger_writer');
    await db.query('grant select, insert, update on all tables in schema case_ledger to ehf_ledger_writer');
    const edge = "corpus-live-edge-token-000000001";
    const app = buildCaseApi({ store: store!, env: {}, serviceGrants: [{ token: edge, subjectId: "edge", tenantId, roles: ["Edge.Delegate"] }] });
    app.log.level = process.env.CORPUS_DB_TEST_LOG ?? "silent";
    const inject: typeof fetch = async (url, init) => {
      const u = new URL(String(url));
      const res = await app.inject({ method: String(init?.method) as "POST", url: u.pathname, headers: init?.headers as Record<string, string>, payload: String(init?.body) });
      return new Response(res.body, { status: res.statusCode });
    };
    const options = { baseUrl: "http://case-api.local", tenantId, token: edge, policySnapshotDigest: "a".repeat(64),
      harnessPlanDigest: "b".repeat(64), permissionEnvelopeDigest: "c".repeat(64), fetch: inject };

    for (const party of ["H04", "H06", "H07", "H10", "H12"]) {
      const dossier = readParty(root, party);
      const first = await seedParty(dossier, options);
      expect(first.created).toBe(true);
      const count = async () => Number((await db.query("select count(*) from case_core.canonical_records where case_id=$1", [first.caseId])).rows[0].count);
      const subjects = async () => Number((await db.query("select count(*) from case_core.case_subjects where case_id=$1", [first.caseId])).rows[0].count);
      expect(await count()).toBe(dossier.records.length);
      expect(await subjects()).toBe(dossier.case.subjects.length);

      const again = await seedParty(dossier, options);
      expect(again).toMatchObject({ caseId: first.caseId, created: false });
      expect(await count()).toBe(dossier.records.length);
      expect(await subjects()).toBe(dossier.case.subjects.length);
    }
    await app.close();
  } finally {
    try { await store?.db.end?.(); } catch { /* app.close() already ended the pool */ }
    try { pg("pg_ctl", ["-D", join(dir, "data"), "-m", "immediate", "stop"]); } catch { /* already stopped */ }
    rmSync(dir, { recursive: true, force: true });
  }
}, 180_000);
