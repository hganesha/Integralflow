import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCaseStore, createKycCase, getCanonicalCaseSnapshot, submitBusinessCommand, registerEvidence, commitSkillExecution, type CaseExecutionAuthority } from "../../packages/case-store/src/index.js";
import { renderMigration } from "../../packages/case-store/src/config.js";
import { createKycCaseRequestSchema, registerEvidenceRequestSchema, computeReleaseManifestDigest, skillCapabilityOutputV1Schema, stableDigest, type ReleaseManifest, type BusinessCommand, type CanonicalRecord } from "../../packages/contracts/src/index.js";
import { admitPlan, createDatabase } from "../../packages/persistence/src/index.js";
import { registerReleaseManifest, transitionRelease } from "../../packages/persistence/src/governance.js";
import { mintExecutionEnvelope } from "../../packages/execution-auth/src/index.js";
import { buildControlApi } from "../../apps/control-api/src/app.js";
import { buildCaseApi } from "../../apps/case-api/src/app.js";
import { buildApp } from "../../apps/experience-bff/src/app.js";
import { planSkillCommit } from "../../packages/runtime-core/src/skill-commit.js";
import { buildDocumentExtractionPlan } from "../../scripts/document-extraction-plan.js";
const database = process.env.EHF_TEST_DATABASE_URL;
describe.skipIf(!database)("document rerun → native admission → scoped case execution", () => {
  const suffix = randomUUID().replaceAll("-", "").slice(0,10), tenantId = `document_${suffix}`;
  const schemas = { core: `doc_${suffix}_core`, ledger: `doc_${suffix}_ledger`, evidence: `doc_${suffix}_evidence` };
  const store = createCaseStore({ connectionString: database!, schemas }), db = createDatabase(database!);
  const plan = buildDocumentExtractionPlan().plan, parent = "b".repeat(64), policy = "a".repeat(64);
  const edge = "document-test-edge-token-00000001", runtime = "document-test-runtime-token-0001", secret = "document-test-envelope-secret-0001";
  const person = { subjectId: "document-reviewer", tenantId, roles: ["Case.Analyst", "Case.Reviewer", "Harness.Operator"], actorType: "human" as const, source: "local" as const };
  const control = buildControlApi({ db, env: {}, serviceGrants: [{ token: edge, tenantId, subjectId: "edge", roles: ["Edge.Delegate"] }] });
  const caseApi = buildCaseApi({ store, env: {}, executionSecret: secret, serviceGrants: [{ token: edge, tenantId, subjectId: "edge", roles: ["Edge.Delegate"] }, { token: runtime, tenantId, subjectId: "runtime", roles: ["Case.Api.Access"] }] });
  const bff = buildApp({ env: { BFF_PUBLIC_ORIGIN: "http://bff.test", BFF_DOCUMENT_PLAN_DIGEST: plan.planDigest }, principalResolver: { source: "local", resolve: async () => person }, upstream: async (service, method, path, principal, body, headers) => {
    const result = await (service === "case-api" ? caseApi : control).inject({ method: method as "GET" | "POST", url: path, headers: { ...headers, authorization: `Bearer ${edge}`, "x-actor-id": principal.subjectId, "x-actor-roles": principal.roles.join(","), "x-tenant-id": tenantId, "x-purpose": "document_review" }, ...(body ? { payload: body as object } : {}) });
    return { status: result.statusCode, body: result.json() };
  } });
  let caseId = "", documentId = "", version = "", evidenceId = "", runId = "", cookie = "", csrf = "";
  const headers = () => ({ origin: "http://bff.test", cookie, "x-csrf-token": csrf });
  const authority = (): CaseExecutionAuthority => ({ tenant_id: tenantId, case_id: caseId, run_id: runId, plan_digest: plan.planDigest, attempt: 1, fencing_epoch: 1 });
  const record = (object_type: string, object_id: string, data: object): CanonicalRecord => ({ object_type, object_id, version_id: `v-${stableDigest(data).slice(0,20)}`, schema_version: "2.0.0", observed_at: new Date().toISOString(), data, subject_ids: [], source_refs: [], provenance: { method: "connector_normalizer" }, classification: "CONFIDENTIAL", purposes: [], synthetic: true });
  beforeAll(async () => {
    control.log.level = caseApi.log.level = "error";
    const migrations = new URL("../../packages/case-store/migrations/", import.meta.url);
    for (const name of (await readdir(migrations)).filter(name => name.endsWith(".sql")).sort()) await store.db.query(renderMigration(await readFile(new URL(name, migrations), "utf8"), schemas));
    // The ledger function runs as its own role: the grant matrix makes these schemas usable, as migrate.ts does.
    await store.db.query(`create table if not exists "${schemas.core}".schema_migrations (name text primary key, checksum text not null, applied_at timestamptz not null default now())`);
    await store.db.query(renderMigration(await readFile(new URL("../grants.sql", migrations), "utf8"), schemas));
    await admitPlan(db, plan, tenantId);
    // Isolated test identities exercise the normal release gate; no real tenant approvals change.
    const digest = stableDigest({ suffix });
    const manifest: ReleaseManifest = { apiVersion: "harness.factory/release-manifest-v1", kind: "ReleaseManifest", releaseId: `release-${suffix}`, manifestDigest: digest, planDigest: plan.planDigest, packageDigest: digest, policyBundleDigests: [], schemaSetDigest: digest, agentDigests: [], skillDigests: [], capabilityDigests: [], modelProfileDigests: [], executionProfileDigest: digest, compilerDigest: digest, runtimeDigest: digest, dependencyManifestDigest: digest, evaluationAttestationDigest: digest, provenanceDigest: digest, scope: { environment: "development", tenants: [tenantId], regions: ["US"], cohort: "isolated-test" }, createdAt: new Date().toISOString() };
    manifest.manifestDigest = computeReleaseManifestDigest(manifest);
    await registerReleaseManifest(db, { tenantId, actor: "test-author", manifest });
    const result = await createKycCase(store, createKycCaseRequestSchema.parse({ tenantId, harnessPlanDigest: parent, policySnapshotDigest: policy, policyAuthority: { policyId: "test-policy", policyVersion: "1", policyBundleDigest: "c".repeat(64), dependencyDigest: "d".repeat(64) }, actor: { type: "HUMAN", principalId: person.subjectId, roles: person.roles } }), suffix);
    caseId = result.case.caseId;
    const session = await bff.inject("/api/v1/session"); cookie = String(session.headers["set-cookie"]).split(";")[0]!; csrf = session.json().csrfToken;
    const upload = await bff.inject({ method: "POST", url: `/api/v1/fincrime/cases/${caseId}/documents`, headers: { ...headers(), "idempotency-key": suffix }, payload: { filename: "selected.txt", mediaType: "text/plain", contentBase64: Buffer.from("Certificate of incorporation\nEntity: Example\n").toString("base64") } });
    expect(upload.statusCode, upload.body).toBe(201);
    documentId = upload.json().documentId; version = upload.json().sha256; evidenceId = upload.json().evidenceId;
  }, 30_000);
  afterAll(async () => {
    await bff.close();
    await db.query("delete from harness_runtime.runs where tenant_id=$1", [tenantId]);
    for (const table of ["release_events", "release_activations", "release_manifests", "artifact_registry_events", "artifact_registry"]) await db.query(`delete from harness_control.${table} where tenant_id=$1`, [tenantId]);
    await db.query("delete from harness_control.plans where tenant_id=$1", [tenantId]);
    for (const schema of Object.values(schemas)) await store.db.query(`drop schema if exists "${schema}" cascade`);
    await caseApi.close(); await control.close(); await db.end();
  });
  it("persists an audited authorization before native run creation and retries without a second review", async () => {
    const request = { method: "POST" as const, url: `/api/v1/fincrime/cases/${caseId}/documents/${documentId}/rerun`, headers: { ...headers(), "idempotency-key": `extract-${suffix}` }, payload: { documentVersion: version } };
    const blocked = await bff.inject(request);
    expect(blocked.statusCode, blocked.body).toBe(409); expect(blocked.json().error).toBe("release.executable_authority_missing");
    await transitionRelease(db, { tenantId, releaseId: `release-${suffix}`, actor: "test-reviewer", expectedRevision: 0, to: "approved", reasonCode: "test-fixture" });
    await transitionRelease(db, { tenantId, releaseId: `release-${suffix}`, actor: "test-reviewer", expectedRevision: 1, to: "active", reasonCode: "test-fixture" });
    const response = await bff.inject(request);
    expect(response.statusCode, response.body).toBe(200); runId = response.json().runId; expect(runId).toMatch(/^RUN-/);
    expect((await bff.inject(request)).json().runId).toBe(runId);
    expect((await store.db.query(`select details from "${schemas.core}".case_reviews where tenant_id=$1`, [tenantId])).rows).toHaveLength(1);
    const saved = (await db.query("select input from harness_runtime.runs where run_id=$1", [runId])).rows[0].input;
    expect(saved).toMatchObject({ documentId, documentVersion: version, evidenceId, filename: "selected.txt" });
    await db.query("update harness_runtime.runs set status='running',attempt=1,fencing_epoch=1,lease_expires_at=now()+interval '5 minutes' where run_id=$1", [runId]);
  });
  it("commits only selected-version document records; root plan, facts and unrelated documents stay protected", async () => {
    const command = async (records: CanonicalRecord[]) => {
      const snapshot = await getCanonicalCaseSnapshot(store, tenantId, caseId, "document_review");
      return submitBusinessCommand(store, { commandId: randomUUID(), commandType: "RecordCanonicalRecords", commandVersion: "1", tenantId, caseId, actor: { type: "AGENT", principalId: "runtime", roles: [] }, authority: { planDigest: plan.planDigest, policySnapshotDigest: policy, permissionEnvelopeDigest: "c".repeat(64) }, payload: { records }, preconditions: { caseSequence: snapshot!.caseSequence }, idempotencyKey: randomUUID() } as BusinessCommand, authority());
    };
    const initial = await getCanonicalCaseSnapshot(store, tenantId, caseId, "document_review");
    await submitBusinessCommand(store, { commandId: randomUUID(), commandType: "RecordCanonicalRecords", commandVersion: "1", tenantId, caseId, actor: { type: "HUMAN", principalId: person.subjectId, roles: person.roles }, authority: { planDigest: parent, policySnapshotDigest: policy, permissionEnvelopeDigest: "c".repeat(64) }, payload: { records: [record("DocumentPage", "foreign-page", { text: "Foreign document", page: 1, document_version: "f".repeat(64) })] }, preconditions: { caseSequence: initial!.caseSequence }, idempotencyKey: randomUUID() } as BusinessCommand);
    await expect(command([record("DocumentPage", "foreign-page", { text: "Overwrite attempt", page: 1, document_version: version })])).rejects.toThrow("document.record_outside_scope");
    const records = [record("DocumentVersion", documentId, { document_id: documentId, artifact_hash: version, media_type: "text/plain", artifact_ref: `kyc-evidence-pipeline:${documentId}`, page_count: 1 }), record("DocumentPage", "selected-page", { text: "Example", page: 1, document_version: version }), record("ExtractedAssertion", "selected-name", { subject: "subject", field: "entity_name", value: "Example", document_version: version })];
    expect((await command(records)).outcome).toBe("ACCEPTED");
    await expect(command([record("ExtractedAssertion", "foreign-assertion", { document_version: "f".repeat(64) })])).rejects.toThrow("document.record_outside_scope");
    await expect(command([record("Entity", "foreign-entity", { name: "Forged" })])).rejects.toThrow("document.record_outside_scope");
    expect((await getCanonicalCaseSnapshot(store, tenantId, caseId, "document_review"))!.planDigest).toBe(parent);
    await db.query("update harness_runtime.runs set fencing_epoch=2 where run_id=$1", [runId]);
    await expect(command(records)).rejects.toThrow("authorization.execution_inactive");
    await db.query("update harness_runtime.runs set fencing_epoch=1 where run_id=$1", [runId]);
  });
  it("allows derived evidence for the authorized document run without changing the case plan", async () => {
    const result = await registerEvidence(store, registerEvidenceRequestSchema.parse({ tenantId, caseId, type: "skill_computation", mediaType: "application/json", contentBase64: Buffer.from('{"parse":"receipt"}').toString("base64"), source: { type: "DERIVED", capability: "document.evidence.prepare.v1", retrievedAt: new Date().toISOString() }, trust: { tier: "SKILL_COMPUTATION", instructionTrust: "UNTRUSTED_DATA" }, createdBy: { type: "AGENT", principalId: "runtime", roles: [] } }), randomUUID(), authority());
    expect(result.created).toBe(true);
  });
  it("persists structured skill proposals idempotently and exposes them in the document workspace", async () => {
    const binding = plan.skillBindings!.find(binding => binding.skillId === "document.fields.adjudicated_extract")!;
    const value = [{ owner_name: "Synthetic Example", percentage: "60", voting_percentage: null }];
    const canonical = record("ExtractedAssertion", "selected-structured", { subject: "subject", field: "ownership_interests", value, document_version: version, extensions: { "ehf.document": { schema_version: "1.0.0", value: { document_type: "shareholder_register", path: "/extracted_fields/ownership_interests", verification: "UNVERIFIED", review_state: "PENDING_REVIEW" } } } });
    const { provenance: _provenance, ...body } = canonical;
    const output = skillCapabilityOutputV1Schema.parse({ contract_version: "skill.execution.v1", execution_id: `execution-${suffix}`, skill_id: binding.skillId, skill_version: binding.semver, bundle_digest: binding.bundleDigest, manifest_digest: binding.manifestDigest, effect_mode: "proposal", lifecycle: "COMPLETED_EXECUTION", computation: { business_status: "COMPLETED", payload: {}, proposed_records: [{ record_type: "CanonicalRecord", local_ref: "structured-field", evidence: [], body }], unresolved_items: [], negative_searches: [], requested_effects: [], metrics: { duration_ms: 1, capability_calls: 0, model_calls: 0 } }, error: null, trace: { subskill_executions: [] }, dependency_receipts: [] });
    const request = planSkillCommit({ plan, nodeId: "document-fields-adjudicated-extract", binding, output, tenantId, caseId, receiptDigest: "e".repeat(64), requestDigest: "f".repeat(64), contextHash: "d".repeat(64), snapshotSequence: null, evidenceId });
    const claims = { ...authority(), node_id: "document-fields-adjudicated-extract", permission_digest: plan.permissionEnvelopes.find(envelope => envelope.nodeId === "document-fields-adjudicated-extract")!.digest, case_writes: ["LinkEvidence", "RecordCanonicalRecords", "ProposeWorkItem"] as const };
    await commitSkillExecution(store, request, { ...claims, case_writes: [...claims.case_writes] });
    expect((await commitSkillExecution(store, request, { ...claims, case_writes: [...claims.case_writes] })).replayed).toBe(true);
    const detail = await bff.inject({ url: `/api/v1/fincrime/cases/${caseId}/documents/${documentId}`, headers: headers() });
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json().assertions.find((assertion: any) => assertion.field === "ownership_interests")).toMatchObject({ value, verification: "UNVERIFIED" });
  });
  it("projects signed reads to the selected source and rejects tampered run scope", async () => {
    const selector = plan.contextSelectors.find(selector => selector.path === "records.DocumentPage")!;
    const token = await mintExecutionEnvelope({ secret, tenantId, caseId, runId, nodeId: "document-classify-catalog", invocationId: randomUUID(), planDigest: plan.planDigest, permissionDigest: "c".repeat(64), capabilities: [], effects: [], caseReads: [selector], caseReadPolicies: [{ classification: selector.classification, action: "allow" }], attempt: 1, fencingEpoch: 1 });
    const read = () => caseApi.inject({ url: `/v2/cases/${caseId}/snapshot`, headers: { authorization: `Bearer ${runtime}`, "x-execution-envelope": token } });
    const response = await read(); expect(response.statusCode, response.body).toBe(200);
    expect(response.json().planDigest).toBe(plan.planDigest);
    expect(response.json().data.records.DocumentPage).toHaveLength(1);
    expect(response.json().data.records.DocumentPage[0].data.document_version).toBe(version);
    expect(response.json().data).not.toHaveProperty("reviews");
    const { snapshotId, snapshotDigest, capturedAt, ...canonical } = response.json(); expect(stableDigest(canonical)).toBe(snapshotDigest);
    await db.query("update harness_runtime.runs set input=jsonb_set(input,'{documentVersion}',to_jsonb($2::text)) where run_id=$1", [runId, "f".repeat(64)]);
    expect((await read()).statusCode).toBe(403);
    await db.query("update harness_runtime.runs set input=jsonb_set(input,'{documentVersion}',to_jsonb($2::text)) where run_id=$1", [runId, version]);
  });
});
