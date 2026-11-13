import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCaseStore, createKycCase, submitBusinessCommand } from "../../packages/case-store/src/index.js";
import { renderMigration } from "../../packages/case-store/src/config.js";
import { createKycCaseRequestSchema, type BusinessCommand } from "../../packages/contracts/src/index.js";
import { buildCaseApi } from "../../apps/case-api/src/app.js";
import { buildApp } from "../../apps/experience-bff/src/app.js";
import { validateResponse } from "../../packages/ui-contracts/src/validate.js";
import fixture from "../../packages/fincrime-views/src/fixtures/documents.kyb-1042.json" with { type: "json" };

const database = process.env.EHF_TEST_DATABASE_URL;
describe.skipIf(!database)("live document workspace → BFF → case API → PostgreSQL", () => {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
  const schemas = { core: `facet_${suffix}_core`, ledger: `facet_${suffix}_ledger`, evidence: `facet_${suffix}_evidence` };
  const token = "facet-integration-edge-token-00000001", tenantId = `facet_${suffix}`;
  const store = createCaseStore({ connectionString: database!, schemas });
  const person = { subjectId: "document-reviewer", tenantId, actorType: "human" as const, roles: ["Case.Analyst", "Case.Reviewer"], source: "local" as const };
  const caseApi = buildCaseApi({ store, env: {}, serviceGrants: [{ token, tenantId, subjectId: "facet-edge", roles: ["Edge.Delegate"] }] });
  const bff = buildApp({ env: { BFF_PUBLIC_ORIGIN: "http://bff.test" }, principalResolver: { source: "local", resolve: async () => person }, upstream: async (service, method, path, principal, body, headers) => {
    if (service !== "case-api") throw new Error("This story must use only the case API.");
    const result = await caseApi.inject({ method: method as "GET" | "POST", url: path, headers: { ...headers, authorization: `Bearer ${token}`, "x-actor-id": principal.subjectId, "x-actor-roles": principal.roles.join(","), "x-tenant-id": principal.tenantId, "x-purpose": "document_evidence_review" }, ...(body ? { payload: body as object } : {}) });
    return { status: result.statusCode, body: result.json() };
  } });
  let caseId = "", csrf = "", cookie = "", documentId = "", version = "", sequence = 0;
  const headers = () => ({ cookie, origin: "http://bff.test", "x-csrf-token": csrf });
  const path = () => `/api/v1/fincrime/cases/${caseId}/documents/${documentId}`;
  const get = () => bff.inject({ url: path(), headers: headers() });
  beforeAll(async () => {
    const migrations = new URL("../../packages/case-store/migrations/", import.meta.url);
    for (const name of (await readdir(migrations)).filter(name => name.endsWith(".sql")).sort()) await store.db.query(renderMigration(await readFile(new URL(name, migrations), "utf8"), schemas));
    // As `pnpm db:migrate` does: the ledger writer that owns append_event holds only what grants.sql gives it.
    await store.db.query(`create table if not exists "${schemas.core}".schema_migrations (name text primary key, checksum text not null, applied_at timestamptz not null default now())`);
    await store.db.query(renderMigration(await readFile(new URL("../grants.sql", migrations), "utf8"), schemas));
    const created = await createKycCase(store, createKycCaseRequestSchema.parse({ tenantId, harnessPlanDigest: "b".repeat(64), policySnapshotDigest: "a".repeat(64), policyAuthority: { policyId: "document-review", policyVersion: "1", policyBundleDigest: "c".repeat(64), dependencyDigest: "d".repeat(64) }, actor: { type: "HUMAN", principalId: person.subjectId, roles: person.roles } }), `create-${suffix}`);
    caseId = created.case.caseId;
    const records = fixture.records.map(record => ({ ...record, schema_version: "1.0.0", observed_at: new Date().toISOString(), subject_ids: [], source_refs: [], provenance: { method: "connector_normalizer" }, classification: "CONFIDENTIAL", purposes: [], synthetic: true }));
    const result = await submitBusinessCommand(store, { commandId: randomUUID(), commandType: "RecordCanonicalRecords", commandVersion: "1.0.0", tenantId, caseId, actor: { type: "HUMAN", principalId: person.subjectId, roles: person.roles }, authority: { planDigest: "b".repeat(64), policySnapshotDigest: "a".repeat(64), permissionEnvelopeDigest: "c".repeat(64) }, payload: { records }, preconditions: { caseSequence: created.case.caseSequence }, idempotencyKey: `seed-${suffix}` } as BusinessCommand);
    expect(result.outcome).toBe("ACCEPTED");
    const session = await bff.inject("/api/v1/session"); csrf = session.json().csrfToken; cookie = String(session.headers["set-cookie"]).split(";")[0]!;
    const listing = await bff.inject({ url: `/api/v1/fincrime/cases/${caseId}/documents`, headers: headers() });
    expect(listing.statusCode).toBe(200);
    expect(validateResponse("getFincrimeCasesCaseIdDocuments", 200, listing.json()).valid).toBe(true);
    documentId = listing.json().documents[0].documentId; version = listing.json().documents[0].documentVersion; sequence = listing.json().caseSequence;
  }, 30_000);
  afterAll(async () => { await bff.close(); for (const schema of Object.values(schemas)) await store.db.query(`drop schema if exists "${schema}" cascade`); await caseApi.close(); });

  it("records a correction once, persists it across reads, and retains unverified source values", async () => {
    const initial = (await get()).json(); const assertion = initial.assertions[0];
    const body = { documentVersion: version, expectedCaseSequence: sequence, idempotencyKey: randomUUID(), rationale: "Checked the cited original.", entries: [{ assertionId: assertion.objectId, assertionVersion: assertion.versionId, outcome: "CORRECTED", correctedValue: "Reviewed human value" }] };
    const result = await bff.inject({ method: "POST", url: `${path()}/reviews`, headers: headers(), payload: body });
    expect(result.statusCode).toBe(200); expect(validateResponse("postFincrimeCasesCaseIdDocumentsDocumentIdReviews", 200, result.json()).valid).toBe(true); expect(result.json().outcome).toBe("ACCEPTED");
    const replay = await bff.inject({ method: "POST", url: `${path()}/reviews`, headers: headers(), payload: body });
    expect(replay.json().commandId).toBe(result.json().commandId);
    expect(replay.statusCode).toBe(200); expect(replay.json()).toEqual(result.json());
    const reused = await bff.inject({ method: "POST", url: `${path()}/reviews`, headers: headers(), payload: { ...body, rationale: "A different review under the same key." } });
    expect(reused.statusCode).toBe(409); expect(reused.json().error).toBe("command.idempotency_conflict");
    const reloaded = (await get()).json(), edited = reloaded.assertions.find((entry: { objectId: string }) => entry.objectId === assertion.objectId);
    expect(edited.value).toEqual(assertion.value); expect(edited.verification).toBe("UNVERIFIED");
    expect(edited.review).toMatchObject({ outcome: "CORRECTED", correctedValue: "Reviewed human value", actor: person.subjectId });
    expect(reloaded.caseSequence).toBe(sequence + 1);
    expect(validateResponse("getFincrimeCasesCaseIdDocumentsDocumentId", 200, reloaded).valid).toBe(true);
  });
  it("refuses stale reviews, fabricated assertion versions, CSRF failures and premature completion", async () => {
    const detail = (await get()).json(); const assertion = detail.assertions[0];
    const body = { documentVersion: version, expectedCaseSequence: detail.caseSequence, idempotencyKey: randomUUID(), rationale: "Review", entries: [{ assertionId: assertion.objectId, assertionVersion: "not-this-extraction", outcome: "CHECKED" }] };
    const wrong = await bff.inject({ method: "POST", url: `${path()}/reviews`, headers: headers(), payload: body });
    expect(wrong.statusCode).toBe(409); expect(wrong.json().error).toBe("document.assertion_conflict");
    const csrfFailure = await bff.inject({ method: "POST", url: `${path()}/reviews`, headers: { ...headers(), origin: "http://foreign.test" }, payload: body }); expect(csrfFailure.statusCode).toBe(403);
    const incomplete = await bff.inject({ method: "POST", url: `${path()}/reviews`, headers: headers(), payload: { ...body, entries: [{ assertionId: null, assertionVersion: null, outcome: "CHECKED" }] } });
    expect(incomplete.statusCode).toBe(409); expect(incomplete.json().error).toBe("document.review_incomplete");
    const stale = await bff.inject({ method: "POST", url: `${path()}/reviews`, headers: headers(), payload: { ...body, expectedCaseSequence: sequence, entries: [{ assertionId: assertion.objectId, assertionVersion: assertion.versionId, outcome: "CHECKED" }] } });
    expect(stale.statusCode).toBe(409); expect(stale.json().outcome).not.toBe("ACCEPTED"); expect((await get()).json().caseSequence).toBe(detail.caseSequence);
  });
  it("completes a reviewed document and invalidates completion when a field review resets", async () => {
    let detail = (await get()).json();
    const record = async (entries: object[]) => {
      const response = await bff.inject({ method: "POST", url: `${path()}/reviews`, headers: headers(), payload: { documentVersion: version, expectedCaseSequence: detail.caseSequence, idempotencyKey: randomUUID(), rationale: "Compared every current assertion with the source.", entries } });
      expect(response.statusCode).toBe(200);
      expect(response.json().outcome).toBe("ACCEPTED");
      detail = (await get()).json();
    };
    await record(detail.assertions.filter((entry: any) => !entry.review || !["CHECKED", "CORRECTED"].includes(entry.review.outcome)).map((entry: any) => ({ assertionId: entry.objectId, assertionVersion: entry.versionId, outcome: "CHECKED" })));
    expect(detail.document.reviewPending).toBe(0);
    await record([{ assertionId: null, assertionVersion: null, outcome: "CHECKED" }]);
    expect(detail.review.outcome).toBe("CHECKED");
    const corrected = detail.assertions.find((entry: any) => entry.review?.outcome === "CORRECTED");
    expect(corrected.review.correctedValue).toBe("Reviewed human value");
    await record([{ assertionId: corrected.objectId, assertionVersion: corrected.versionId, outcome: "RESET" }]);
    expect(detail.review).toBeNull();
    expect(detail.document.reviewPending).toBe(1);
  });
  it("shows a route conflict on its field, resolves it in a review and records the decision as feedback, not training data", async () => {
    // The conflict work item a document run raises (fixture: the passport's date of birth, read differently by the two routes).
    const conflict = fixture.workItems[0]!;
    let current = (await bff.inject({ url: `/api/v1/fincrime/cases/${caseId}/documents`, headers: headers() })).json();
    const proposed = await submitBusinessCommand(store, { commandId: randomUUID(), commandType: "ProposeWorkItem", commandVersion: "1.0.0", tenantId, caseId, actor: { type: "HUMAN", principalId: person.subjectId, roles: person.roles },
      authority: { planDigest: "b".repeat(64), policySnapshotDigest: "a".repeat(64), permissionEnvelopeDigest: "c".repeat(64) },
      payload: { workItemId: conflict.work_item_id, workType: conflict.work_type, description: conflict.description, subjectRef: conflict.subject_ref }, preconditions: { caseSequence: current.caseSequence }, idempotencyKey: `conflict-${suffix}` } as BusinessCommand);
    expect(proposed.outcome).toBe("ACCEPTED");
    const passport = current.documents.find((item: { filename: string }) => item.filename === "director-passport.txt");
    const url = `/api/v1/fincrime/cases/${caseId}/documents/${passport.documentId}`;
    let detail = (await bff.inject({ url, headers: headers() })).json();
    expect(validateResponse("getFincrimeCasesCaseIdDocumentsDocumentId", 200, detail).valid).toBe(true);
    expect(detail.workItems).toEqual([expect.objectContaining({ workItemId: conflict.work_item_id, workType: "DOCUMENT_FIELD_CONFLICT", status: "OPEN", assertionId: conflict.subject_ref })]);
    const birth = detail.assertions.find((item: { objectId: string }) => item.objectId === conflict.subject_ref);
    expect(birth.routes).toMatchObject({ outcome: "CONFLICT", proposedRoute: "llm", candidates: expect.arrayContaining([expect.objectContaining({ route: "azure_di", value: "2030-05-31", grounded: true })]) });
    const review = (resolvedWorkItems: string[], entry: object) => bff.inject({ method: "POST", url: `${url}/reviews`, headers: headers(), payload: { documentVersion: detail.document.documentVersion,
      expectedCaseSequence: detail.caseSequence, idempotencyKey: randomUUID(), rationale: "The printed birth date is 1987-04-12; the model read the expiry date.", resolvedWorkItems, entries: [entry] } });
    // A conflict is resolved only by a decision on its own assertion.
    const other = detail.assertions.find((item: { objectId: string }) => item.objectId !== conflict.subject_ref);
    const unrelated = await review([conflict.work_item_id], { assertionId: other.objectId, assertionVersion: other.versionId, outcome: "CHECKED" });
    expect(unrelated.statusCode).toBe(409); expect(unrelated.json().error).toBe("document.conflict_resolution_invalid");
    const kept = await review([conflict.work_item_id], { assertionId: birth.objectId, assertionVersion: birth.versionId, outcome: "CHECKED", selectedRoute: "llm" });
    expect(kept.statusCode).toBe(200); expect(kept.json().outcome).toBe("ACCEPTED");
    detail = (await bff.inject({ url, headers: headers() })).json();
    expect(detail.workItems[0]).toMatchObject({ status: "COMPLETED" });
    expect(detail.assertions.find((item: { objectId: string }) => item.objectId === birth.objectId).review).toMatchObject({ outcome: "CHECKED" });
    const again = await review([conflict.work_item_id], { assertionId: birth.objectId, assertionVersion: birth.versionId, outcome: "CHECKED" });
    expect(again.statusCode).toBe(409); expect(again.json().error).toBe("work_item.not_open");
    // The feedback store: the resolution with both routes' readings, append-only and never training data.
    const rows = (await store.db.query(`select kind, outcome, field, proposed_value, final_value, proposed_route, adjudication, resolved_work_items, training_use from "${schemas.core}".document_feedback where tenant_id=$1 and case_id=$2 order by created_at`, [tenantId, caseId])).rows;
    expect(rows.find(row => row.kind === "CONFLICT_RESOLUTION")).toMatchObject({ outcome: "CHECKED", field: "date_of_birth", proposed_value: "1987-04-12", final_value: "1987-04-12", proposed_route: "llm",
      resolved_work_items: [conflict.work_item_id], training_use: "prohibited", adjudication: expect.objectContaining({ outcome: "CONFLICT", selected_route: "llm" }) });
    expect(rows.some(row => row.kind === "CORRECTION" && row.final_value === "Reviewed human value")).toBe(true);
    await expect(store.db.query(`update "${schemas.core}".document_feedback set training_use='prohibited' where tenant_id=$1`, [tenantId])).rejects.toThrow(/append-only/);
  });
  it("uploads original bytes idempotently and only serves content belonging to the selected case", async () => {
    const contentBase64 = Buffer.from("Original documentary source\n").toString("base64");
    const uploadHeaders = { ...headers(), "idempotency-key": randomUUID() };
    const request = { method: "POST" as const, url: `/api/v1/fincrime/cases/${caseId}/documents`, headers: uploadHeaders, payload: { filename: "original-source.txt", mediaType: "text/plain", contentBase64 } };
    const upload = await bff.inject(request), replay = await bff.inject(request);
    expect(upload.statusCode).toBe(201);
    expect(replay.json().documentId).toBe(upload.json().documentId);
    expect(replay.statusCode).toBe(201); expect(replay.json()).toEqual(upload.json());
    const reused = await bff.inject({ ...request, payload: { ...request.payload, contentBase64: Buffer.from("Other bytes\n").toString("base64") } });
    expect(reused.statusCode).toBe(409); expect(reused.json().error).toBe("evidence.idempotency_conflict");
    expect(validateResponse("postFincrimeCasesCaseIdDocuments", 201, upload.json()).valid).toBe(true);
    const url = `/api/v1/fincrime/cases/${caseId}/documents/${upload.json().documentId}/content`;
    const content = await bff.inject({ url, headers: headers() });
    expect(content.statusCode).toBe(200);
    expect(content.json()).toMatchObject({ contentBase64, mediaType: "text/plain", documentVersion: upload.json().sha256 });
    expect(validateResponse("getFincrimeCasesCaseIdDocumentsDocumentIdContent", 200, content.json()).valid).toBe(true);
    const unrelated = await bff.inject({ url: url.replace(caseId, "case_unrelated"), headers: headers() });
    expect(unrelated.statusCode).toBe(404);
  });
});
