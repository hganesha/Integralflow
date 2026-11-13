import { execFileSync } from "node:child_process";
import { randomInt } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createCaseStore, type CaseStore } from "@ehf/case-store";
import { mapApplicationSubmission, type ApplicationSubmissionInput } from "@ehf/contracts";
import { buildCaseApi } from "./app.js";

// The application intake's commands (experience-bff application-intake.ts) through the real case API
// into a real Postgres: a KYB case, its subjects and every canonical record the mapping produces
// (Application references resolve; the library and platform record checks pass), replayed
// idempotently. Uses the local server binaries (initdb, pg_ctl). Opt in with EHF_RUN_CORPUS_DB_TESTS=1.
const migrations = new URL("../../../packages/case-store/migrations/", import.meta.url);
const tenantId = "tenant_demo";
const COMPANY: ApplicationSubmissionInput = {
  scope: { customerType: "corporate", trigger: "onboarding", jurisdiction: "GB", products: ["deposit", "payments"] },
  customer: { name: "Thistle Fabrication Ltd", legalForm: "corporation", registrationNumber: "SC401042", registrationJurisdiction: "GB",
    addresses: [{ lines: ["Unit 4, Mill Lane"], locality: "Sheffield", country: "GB" }], identifiers: [{ type: "lei", issuer: "GLEIF", value: "5493001KJTIIGC8Y1R12" }] },
  relatedParties: [
    { name: "Gareth Thistle", roles: ["beneficial_owner", "director"], ownershipPercent: "60", dateOfBirth: "1971-11-08", nationality: "GB", politicallyExposed: "yes", pepPosition: "Councillor" },
    { name: "Priya Nair", roles: ["beneficial_owner"], ownershipPercent: "40" },
  ],
  expectedActivity: [{ product: "deposit", currency: "GBP", monthlyInflow: "310000", counterpartyCountries: ["GB"] }],
  sourceOfFunds: "Revenue from fabrication contracts", externalRef: "APP-DB-1",
  documents: [{ documentType: "certificate_of_incorporation", filename: "certificate.txt", mediaType: "text/plain",
    contentBase64: Buffer.from("CERTIFICATE OF INCORPORATION\nCompany name: Thistle Fabrication Ltd\n").toString("base64") }],
};

it.skipIf(process.env.EHF_RUN_CORPUS_DB_TESTS !== "1")("records an application's subjects and canonical records in a KYB case, idempotently", async () => {
  const dir = mkdtempSync(join(tmpdir(), "intake-pg-"));
  const port = 20000 + randomInt(20000);
  // initdb refuses to run as root: run the server binaries as the postgres user then.
  const root = process.getuid?.() === 0;
  if (root) execFileSync("chown", ["postgres", dir]);
  const pg = (bin: string, args: string[]) => execFileSync(root ? "runuser" : bin, root ? ["-u", "postgres", "--", bin, ...args] : args,
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, LC_ALL: "C.UTF-8" } });
  pg("initdb", ["-D", join(dir, "data"), "-U", "postgres", "--auth=trust", "-E", "UTF8"]);
  pg("pg_ctl", ["-D", join(dir, "data"), "-o", `-p ${port} -c unix_socket_directories= -c listen_addresses=127.0.0.1`, "-l", join(dir, "log"), "-w", "start"]);
  let store: CaseStore | undefined;
  try {
    const admin = createCaseStore({ connectionString: `postgresql://postgres@127.0.0.1:${port}/postgres` });
    await admin.db.query("create database ehf_case");
    await admin.db.end?.();
    const db = (store = createCaseStore({ connectionString: `postgresql://postgres@127.0.0.1:${port}/ehf_case` })).db;
    for (const file of readdirSync(migrations).filter((f) => f.endsWith(".sql")).sort()) {
      const sql = readFileSync(new URL(file, migrations), "utf8");
      if (/vector|knowledge_chunks/i.test(sql)) continue;
      await db.query(sql.replaceAll("{{CASE_CORE_SCHEMA}}", '"case_core"').replaceAll("{{CASE_LEDGER_SCHEMA}}", '"case_ledger"').replaceAll("{{EVIDENCE_SCHEMA}}", '"evidence"'));
    }
    await db.query("grant usage on schema case_ledger to ehf_ledger_writer");
    await db.query("grant select, insert, update on all tables in schema case_ledger to ehf_ledger_writer");
    const edge = "intake-live-edge-token-0000000001";
    const app = buildCaseApi({ store: store!, env: {}, serviceGrants: [{ token: edge, subjectId: "edge", tenantId, roles: ["Edge.Delegate"] }] });
    app.log.level = "silent";
    const actor = { type: "HUMAN" as const, principalId: "analyst", roles: ["Case.Analyst"] };
    const call = async (path: string, body: unknown, key?: string) => {
      const res = await app.inject({ method: "POST", url: path, payload: body as object, headers: {
        authorization: `Bearer ${edge}`, "x-actor-id": actor.principalId, "x-actor-roles": "Case.Analyst", ...(key ? { "idempotency-key": key } : {}) } });
      expect(res.statusCode, res.body).toBeLessThan(300);
      return res.json();
    };
    const authority = { planDigest: "b".repeat(64), permissionEnvelopeDigest: "c".repeat(64), policySnapshotDigest: "a".repeat(64) };
    const submit = async () => {
      const created = await call("/v1/cases", { tenantId, caseType: "kyb_onboarding", schemaVersion: "kyb.case.v1", jurisdiction: "GB", externalRef: "APP-DB-1",
        policySnapshotDigest: authority.policySnapshotDigest, harnessPlanDigest: authority.planDigest, actor }, "application_intake_db");
      const caseId = created.case.caseId as string;
      // Documents through the case's upload route, as the BFF does: content-addressed evidence.
      const documents = [];
      for (const [index, document] of (COMPANY.documents ?? []).entries()) {
        const { relatedParty: _party, ...body } = document;
        const uploaded = await call(`/v1/cases/${caseId}/documents`, { ...body, subjectRefs: ["entity.customer"] }, `application_intake_db:document:${index}`);
        documents.push({ evidenceId: uploaded.evidence.evidenceId, artifactRef: uploaded.evidence.integrity.artifactRef, sha256: uploaded.evidence.integrity.rawDigest });
      }
      const intake = mapApplicationSubmission(COMPANY, { tenantId, observedAt: created.case.createdAt, documents });
      let sequence = 1;
      const command = async (commandType: string, payload: object, step: string) => {
        const receipt = await call(`/v1/cases/${caseId}/commands`, { commandId: `cmd-${step}`, commandType, commandVersion: "1", tenantId, caseId, actor, authority,
          payload, preconditions: { caseSequence: sequence }, idempotencyKey: `application_intake_db:${step}` });
        expect(receipt.outcome).toBe("ACCEPTED");
        sequence = receipt.caseSequence;
      };
      for (const [index, subject] of intake.subjects.entries()) await command("AddSubject", subject, `subject:${index}`);
      await command("RecordCanonicalRecords", { records: intake.records }, "records:0");
      return { caseId, created: created.created as boolean, intake };
    };
    const first = await submit();
    expect(first.created).toBe(true);
    const count = async (table: string) => Number((await db.query(`select count(*) from case_core.${table} where case_id=$1`, [first.caseId])).rows[0].count);
    expect((await db.query("select case_type, schema_version from case_core.cases where case_id=$1", [first.caseId])).rows[0]).toEqual({ case_type: "kyb_onboarding", schema_version: "kyb.case.v1" });
    expect(await count("canonical_records")).toBe(first.intake.records.length);
    expect(await count("case_subjects")).toBe(3);
    for (const type of ["Registration", "PEPRelationship", "DocumentVersion"]) expect(first.intake.records.some((record) => record.object_type === type), type).toBe(true);
    expect(Number((await db.query("select count(*) from evidence.evidence_objects where case_id=$1", [first.caseId])).rows[0].count)).toBe(1);
    const again = await submit();
    expect(again).toMatchObject({ caseId: first.caseId, created: false });
    expect(await count("canonical_records")).toBe(first.intake.records.length);
    expect(await count("case_subjects")).toBe(3);
    expect(Number((await db.query("select count(*) from evidence.evidence_objects where case_id=$1", [first.caseId])).rows[0].count)).toBe(1);
    await app.close();
  } finally {
    try { await store?.db.end?.(); } catch { /* app.close() already ended the pool */ }
    try { pg("pg_ctl", ["-D", join(dir, "data"), "-m", "immediate", "stop"]); } catch { /* already stopped */ }
    rmSync(dir, { recursive: true, force: true });
  }
}, 180_000);
