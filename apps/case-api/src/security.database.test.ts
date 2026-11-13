import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { expect, it } from "vitest";
import { createCaseStore, createKycCase, assertActiveCaseExecution, type CaseStore } from "@ehf/case-store";
import { createKycCaseRequestSchema } from "@ehf/contracts";
import { mintExecutionEnvelope } from "@ehf/execution-auth";
import { buildCaseApi } from "./app.js";

it.skipIf(process.env.EHF_RUN_SECURITY_DB_TESTS !== "1")("enforces actor, case, cancellation and fencing boundaries against separate databases", async () => {
  const name = `ehf-security-${randomBytes(5).toString("hex")}`;
  const docker = (args: string[]) => execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const image = docker(["image", "inspect", "pgvector/pgvector:pg17", "--format", "{{.Id}}"]);
  const password = randomBytes(24).toString("hex");
  execFileSync("docker", ["run", "--rm", "-d", "--name", name, "--label", "ehf.test=security", "-p", "127.0.0.1::5432", "-e", "POSTGRES_PASSWORD", image],
    { env: { ...process.env, POSTGRES_PASSWORD: password }, stdio: "pipe" });
  const stores: CaseStore[] = [];
  const connect = (database: string, role?: string) => {
    const port = docker(["port", name, "5432/tcp"]).split(":").at(-1);
    const store = createCaseStore({ connectionString: `postgresql://postgres:${password}@127.0.0.1:${port}/${database}${role ? `?options=${encodeURIComponent(`-c role=${role}`)}` : ""}` });
    stores.push(store); return store;
  };
  const admin = connect("postgres");
  let app: ReturnType<typeof buildCaseApi> | undefined;
  try {
    let ready = false;
    for (let i = 0; i < 40; i++) {
      try { await admin.db.query("select 1"); ready = true; break; } catch { await new Promise((done) => setTimeout(done, 250)); }
    }
    expect(ready).toBe(true);
    await admin.db.query("create database ehf_control");
    await admin.db.query("create database ehf_case");
    await admin.db.query('create role "security-case" nologin');
    const control = connect("ehf_control");
    const cases = connect("ehf_case");
    for (const [db, directory] of [[control.db, "../../../packages/persistence/migrations/"], [cases.db, "../../../packages/case-store/migrations/"]] as const) {
      const root = new URL(directory, import.meta.url);
      for (const file of readdirSync(root).filter((file) => file.endsWith(".sql")).sort()) {
        await db.query(readFileSync(new URL(file, root), "utf8").replaceAll("{{CASE_CORE_SCHEMA}}", '"case_core"')
          .replaceAll("{{CASE_LEDGER_SCHEMA}}", '"case_ledger"').replaceAll("{{EVIDENCE_SCHEMA}}", '"evidence"'));
      }
    }
    await control.db.query('grant usage on schema harness_runtime to "security-case"');
    await control.db.query('grant execute on function harness_runtime.lock_case_execution(text,text,text,text,integer,bigint,text,bigint) to "security-case"');
    await control.db.query('grant execute on function harness_runtime.document_extraction_run(text,text,text,text) to "security-case"');
    await control.db.query('grant execute on function harness_runtime.document_extraction_plan(text,text) to "security-case"');
    await cases.db.query('grant usage on schema case_core,case_ledger,evidence to "security-case"');
    await cases.db.query('grant select,insert,update,delete on all tables in schema case_core,case_ledger,evidence to "security-case"');
    await cases.db.query('grant usage,select on all sequences in schema case_core,case_ledger,evidence to "security-case"');
    const store = connect("ehf_case", "security-case");
    const executionStore = connect("ehf_control", "security-case");
    store.executionDb = executionStore.db; store.ownsDatabase = false;
    const digest = "a".repeat(64);
    const tenantId = "tenant_demo";
    const initial = createKycCaseRequestSchema.parse({ tenantId, policySnapshotDigest: digest, harnessPlanDigest: digest,
      actor: { type: "HUMAN", principalId: "creator", roles: [] } });
    const caseA = (await createKycCase(store, initial, "case-a")).case.caseId;
    const caseB = (await createKycCase(store, initial, "case-b")).case.caseId;
    await control.db.query("insert into harness_control.plans(plan_digest,plan_id,name,domain,version,plan,tenant_id) values($1,'plan','test','kyc','1','{}',$2)", [digest, tenantId]);
    await control.db.query("insert into harness_runtime.runs(run_id,idempotency_key,plan_digest,status,input,attempt,fencing_epoch,lease_expires_at,tenant_id,request_digest) values('run-a','run-a',$1,'running',$2,1,1,now()+interval '5 minutes',$3,'test-request')", [digest, { caseId: caseA }, tenantId]);
    const edge = "database-test-edge-token-00000001", runtime = "database-test-runtime-token-00001", secret = "database-test-envelope-secret-0001";
    app = buildCaseApi({ store, env: {}, executionSecret: secret, serviceGrants: [
      { token: edge, subjectId: "edge", tenantId, roles: ["Edge.Delegate"] }, { token: runtime, subjectId: "runtime", tenantId, roles: ["Case.Api.Access"] },
    ] });
    app.log.level = "silent";
    const token = await mintExecutionEnvelope({ secret, tenantId, caseId: caseA, runId: "run-a", nodeId: "node", invocationId: "inv", attempt: 1,
      planDigest: digest, permissionDigest: digest, capabilities: [], effects: [], caseWrites: ["AddSubject"], fencingEpoch: 1 });
    const command = { commandId: "add-a", commandType: "AddSubject", commandVersion: "v1", tenantId, caseId: caseA,
      actor: { type: "AGENT", principalId: "forged", roles: ["KYC.SeniorReviewer"] }, authority: { planDigest: digest, permissionEnvelopeDigest: digest, policySnapshotDigest: digest },
      payload: { subjectType: "individual" }, preconditions: { caseSequence: 1 }, idempotencyKey: "add-a" };
    const headers = { authorization: `Bearer ${runtime}`, "x-execution-envelope": token };
    const wrongCase = await app.inject({ method: "POST", url: `/v1/cases/${caseB}/commands`, headers, payload: { ...command, caseId: caseB } });
    expect(wrongCase.statusCode).toBe(403);
    const success = await app.inject({ method: "POST", url: `/v1/cases/${caseA}/commands`, headers, payload: command });
    expect(success.statusCode, success.body).toBe(200);
    expect((await cases.db.query("select created_by from case_core.case_subjects where case_id=$1", [caseA])).rows[0].created_by)
      .toEqual({ type: "AGENT", principalId: "runtime", executionId: "run-a", roles: [] });
    const live = { tenant_id: tenantId, case_id: caseA, run_id: "run-a", plan_digest: digest, attempt: 1, fencing_epoch: 1 };
    await expect(assertActiveCaseExecution(executionStore.db, { ...live, case_id: caseB }, tenantId, caseB)).rejects.toThrow("authorization.execution_inactive");
    await expect(assertActiveCaseExecution(executionStore.db, { ...live, attempt: 2 }, tenantId, caseA)).rejects.toThrow("authorization.execution_inactive");
    await expect(assertActiveCaseExecution(executionStore.db, { ...live, work_item_id: "superseded-work", work_fencing_epoch: 1 }, tenantId, caseA)).rejects.toThrow("authorization.execution_inactive");
    await control.db.query("update harness_runtime.runs set lease_expires_at=now()-interval '1 second' where run_id='run-a'");
    await expect(assertActiveCaseExecution(executionStore.db, live, tenantId, caseA)).rejects.toThrow("authorization.execution_inactive");
    await control.db.query("update harness_runtime.runs set lease_expires_at=now()+interval '5 minutes' where run_id='run-a'");
    // A cancellation cannot overtake a case transaction holding authority.
    const lease = await executionStore.db.connect();
    await lease.query("begin");
    await assertActiveCaseExecution(lease, { tenant_id: tenantId, case_id: caseA, run_id: "run-a", plan_digest: digest, attempt: 1, fencing_epoch: 1 }, tenantId, caseA);
    const cancel = await control.db.connect();
    await cancel.query("set lock_timeout='100ms'");
    await expect(cancel.query("update harness_runtime.runs set fencing_epoch=2 where run_id='run-a'")).rejects.toMatchObject({ code: "55P03" });
    await lease.query("rollback"); lease.release();
    await cancel.query("update harness_runtime.runs set fencing_epoch=2 where run_id='run-a'"); cancel.release();
    const stale = await app.inject({ method: "POST", url: `/v1/cases/${caseA}/commands`, headers, payload: { ...command, commandId: "stale", idempotencyKey: "stale", preconditions: { caseSequence: 2 } } });
    expect(stale.json().error).toBe("authorization.execution_inactive");
    await control.db.query("update harness_runtime.runs set fencing_epoch=1,cancellation_requested_at=now() where run_id='run-a'");
    expect((await app.inject({ method: "POST", url: `/v1/cases/${caseA}/commands`, headers, payload: command })).json().error).toBe("authorization.execution_inactive");
    await expect(executionStore.db.query("select * from harness_runtime.runs")).rejects.toMatchObject({ code: "42501" });
    // Narrow document authority lookups work without opening runtime/control table reads.
    const documentPlan = JSON.parse(readFileSync(new URL("../../../artifacts/document-extraction.plan.json", import.meta.url), "utf8"));
    await control.db.query("insert into harness_control.plans(plan_digest,plan_id,name,domain,version,plan,tenant_id) values($1,$2,'document-reextraction','documents','1',$3,$4)", [documentPlan.planDigest, documentPlan.planId, documentPlan, tenantId]);
    await control.db.query("insert into harness_runtime.runs(run_id,idempotency_key,plan_digest,status,input,tenant_id,request_digest) values('doc-run','doc-intent',$1,'queued',$2,$3,'test')", [documentPlan.planDigest, { tenantId, caseId: caseA, documentId: "doc_original", documentVersion: digest, evidenceId: "ev_original", contentBase64: "must-not-leak" }, tenantId]);
    const lookup = await executionStore.db.query("select * from harness_runtime.document_extraction_run($1,$2,'doc-run',$3)", [tenantId, caseA, documentPlan.planDigest]);
    expect(lookup.rows[0].input).toEqual({ tenantId, caseId: caseA, documentId: "doc_original", documentVersion: digest, evidenceId: "ev_original" });
    expect((await executionStore.db.query("select * from harness_runtime.document_extraction_run($1,$2,'doc-run',$3)", [tenantId, caseB, documentPlan.planDigest])).rows).toEqual([]);
    expect((await executionStore.db.query("select harness_runtime.document_extraction_plan($1,$2) as plan", [tenantId, documentPlan.planDigest])).rows[0].plan.planDigest).toBe(documentPlan.planDigest);
    expect((await executionStore.db.query("select harness_runtime.document_extraction_plan('unrelated-tenant',$1) as plan", [documentPlan.planDigest])).rows[0].plan).toBeNull();
    await expect(executionStore.db.query("select * from harness_control.plans")).rejects.toMatchObject({ code: "42501" });
    // Reviewer permission still permits a valid disposition and replaces forged attribution.
    await cases.db.query("update case_core.cases set status='HUMAN_REVIEW' where case_id=$1", [caseA]);
    await cases.db.query("insert into case_core.case_gate_results(tenant_id,case_id,gate_result_id,recommendation_ref,decision,case_sequence,rule_results,policy_snapshot_digest,created_by,created_at) values($1,$2,'gate','rec','AUTHORIZED',2,'[]',$3,'{}',now())", [tenantId, caseA, digest]);
    const final = { ...command, commandType: "FinalizeDisposition", commandId: "final", idempotencyKey: "final", actor: { type: "HUMAN", principalId: "forged", roles: ["KYC.SeniorReviewer"] },
      payload: { recommendationRef: "rec", gateResultRef: "gate", outcome: "APPROVED", rationale: "Reviewed" }, preconditions: { caseSequence: 2 } };
    const humanHeaders = { authorization: `Bearer ${edge}`, "x-actor-id": "actual-reviewer", "x-actor-roles": "Case.Analyst" };
    expect((await app.inject({ method: "POST", url: `/v1/cases/${caseA}/commands`, headers: humanHeaders, payload: final })).statusCode).toBe(403);
    humanHeaders["x-actor-roles"] = "Case.Reviewer";
    const approved = await app.inject({ method: "POST", url: `/v1/cases/${caseA}/commands`, headers: humanHeaders, payload: final });
    expect(approved.statusCode, approved.body).toBe(200);
    expect((await cases.db.query("select authorized_actor from case_core.case_final_dispositions where case_id=$1", [caseA])).rows[0].authorized_actor.principalId).toBe("actual-reviewer");
  } finally {
    await app?.close();
    await Promise.all(stores.map((store) => store.db.end()));
    docker(["rm", "-f", name]);
  }
}, 60_000);
