import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { businessCommandSchema, createKycCaseRequestSchema, recordCanonicalRecordsPayloadSchema, stableDigest, type ApplicationSubmissionInput } from "@ehf/contracts";
import { buildApp } from "./app.js";
import type { Upstream } from "./upstream.js";

const principal = { subjectId: "analyst", tenantId: "tenant-cases", actorType: "human" as const, roles: ["Case.Analyst"], source: "local" as const };
const PLAN = "e".repeat(64);
const DOCUMENT_PLAN = JSON.parse(readFileSync(new URL("../../../artifacts/document-extraction.plan.json", import.meta.url), "utf8"));
const selection = (jurisdiction: string, customerTypes: string[]) => ({
  planDigest: PLAN, policySnapshotDigest: "5".repeat(64),
  policyAuthority: { policyId: `policy.pack.${jurisdiction.toLowerCase()}.bank-synthetic.business-banking`, policyVersion: "1.0.0", policyBundleDigest: "8".repeat(64), dependencyDigest: "b".repeat(64) },
  scope: { customerType: "corporate", trigger: "onboarding", dueDiligence: "standard", jurisdictions: ["US", "GB"], products: ["deposit", "payments"], institution: "bank.synthetic" },
  pack: { id: `policy.pack.${jurisdiction.toLowerCase()}.bank-synthetic.business-banking`, scope: { jurisdiction, institution: "bank.synthetic", productSet: "business-banking", products: ["deposit", "lending", "payments"], customerTypes } },
});

const COMPANY: ApplicationSubmissionInput = {
  scope: { customerType: "corporate", trigger: "onboarding", dueDiligence: "standard", jurisdiction: "GB", products: ["deposit", "payments"] },
  customer: { name: "Thistle Fabrication Ltd", legalForm: "corporation", registrationNumber: "SC401042", registrationJurisdiction: "GB",
    addresses: [{ lines: ["Unit 4, Mill Lane"], locality: "Sheffield", country: "GB" }] },
  relatedParties: [
    { name: "Gareth Thistle", roles: ["beneficial_owner", "director"], ownershipPercent: "60", nationality: "GB" },
    { name: "Priya Nair", roles: ["beneficial_owner"], ownershipPercent: "40" },
  ],
  expectedActivity: [{ product: "deposit", currency: "GBP", monthlyInflow: "310000" }],
  sourceOfFunds: "Revenue from fabrication contracts", externalRef: "APP-GB-1",
};
const PERSON: ApplicationSubmissionInput = {
  scope: { customerType: "individual", trigger: "onboarding", jurisdiction: "US", products: ["deposit"] },
  customer: { name: "Dana Reyes", dateOfBirth: "1990-06-30", nationality: "US", identifiers: [{ type: "passport", issuer: "US", value: "SPECIMEN-9" }] },
};

/** A case API that keeps cases and command receipts by idempotency key, as the case store does. */
function caseApi() {
  const cases = new Map<string, { request: any; caseId: string; createdAt: string; sequence: number }>();
  const receipts = new Map<string, { digest: string; response: any }>();
  const records: any[] = [];
  const subjects: any[] = [];
  const uploads = new Map<string, any>();
  const contents = new Map<string, string>();
  const reviews: any[] = [];
  const runs: { body: any; key: string | undefined }[] = [];
  let clock = Date.parse("2026-11-11T10:00:00Z");
  const upstream = vi.fn<Upstream>(async (service, method, path, _principal, body, headers = {}) => {
    if (service === "control-api" && path === "/v1/case-plans/select") {
      const scope = body as { jurisdiction: string; customerType: string };
      if (scope.jurisdiction === "AU") return { status: 422, body: { error: "case.plan_no_pack", message: "no released plan pins a pack for AU covering deposit", candidates: ["a".repeat(64)] } };
      return { status: 200, body: selection(scope.jurisdiction, [scope.customerType === "individual" ? "individual" : "corporate"]) };
    }
    if (service === "case-api" && method === "POST" && path === "/v1/cases") {
      const parsed = createKycCaseRequestSchema.parse(body);
      const key = headers["idempotency-key"]!;
      const prior = cases.get(key);
      if (prior) {
        if (stableDigest(prior.request) !== stableDigest(parsed)) return { status: 409, body: { error: "case.idempotency_conflict" } };
        return { status: 200, body: { created: false, case: { caseId: prior.caseId, caseSequence: prior.sequence, createdAt: prior.createdAt } } };
      }
      const entry = { request: parsed, caseId: `case_${stableDigest(key).slice(0, 12)}`, createdAt: new Date(clock += 1000).toISOString(), sequence: 1 };
      cases.set(key, entry);
      return { status: 201, body: { created: true, case: { caseId: entry.caseId, caseSequence: 1, createdAt: entry.createdAt } } };
    }
    const upload = /^\/v1\/cases\/([^/]+)\/documents$/.exec(path);
    if (service === "case-api" && method === "POST" && upload) {
      // As case-api: the first registration for a key is replayed (same case, file and bytes) or conflicts.
      const input = body as { filename: string; mediaType: string; contentBase64: string; subjectRefs: string[] };
      const key = headers["idempotency-key"]!;
      const digest = createHash("sha256").update(Buffer.from(input.contentBase64, "base64")).digest("hex");
      const prior = uploads.get(key);
      if (prior) return prior.integrity.rawDigest === digest && prior.caseId === upload[1] ? { status: 200, body: { created: false, evidence: prior } } : { status: 409, body: { error: "evidence.idempotency_conflict" } };
      const evidence = { evidenceId: `evidence_${uploads.size + 1}`, caseId: upload[1], subjectRefs: input.subjectRefs, source: { dataset: `document:${input.filename}` },
        integrity: { rawDigest: digest, normalizedDigest: null, artifactRef: `artifact://postgres/tenant-cases/${digest}` } };
      uploads.set(key, evidence);
      contents.set(key, input.contentBase64);
      return { status: 201, body: { created: true, evidence, document: { documentId: `doc_${digest.slice(0, 24)}` } } };
    }
    const snap = /^\/v2\/cases\/([^/]+)\/snapshot$/.exec(path);
    if (service === "case-api" && method === "GET" && snap) {
      const entry = [...cases.values()].find((value) => value.caseId === decodeURIComponent(snap[1]!))!;
      const grouped: Record<string, any[]> = {};
      for (const record of records) (grouped[record.object_type] ??= []).push(record);
      return { status: 200, body: { tenantId: principal.tenantId, caseId: entry.caseId, caseSequence: entry.sequence, planDigest: PLAN,
        policyAuthority: { policySnapshotDigest: "5".repeat(64) }, data: { records: grouped, reviews,
          evidence: [...uploads.values()].map((evidence) => ({ evidence_id: evidence.evidenceId, evidence_type: "DOCUMENT", raw_digest: evidence.integrity.rawDigest, source: evidence.source })) } } };
    }
    const content = /^\/v1\/evidence\/([^/]+)\/content$/.exec(path);
    if (service === "case-api" && method === "GET" && content) {
      const [evidence, input] = [...uploads.entries()].map(([key, value]) => [value, contents.get(key)]).find(([value]) => value.evidenceId === decodeURIComponent(content[1]!))!;
      return { status: 200, body: { caseId: evidence.caseId, rawDigest: evidence.integrity.rawDigest, contentBase64: input } };
    }
    if (service === "control-api" && method === "GET" && path.startsWith("/v1/plans/")) return { status: 200, body: DOCUMENT_PLAN };
    if (service === "control-api" && method === "POST" && path === "/v1/runs") {
      runs.push({ body, key: headers["idempotency-key"] });
      return { status: 202, body: { run: { runId: `run_${stableDigest(headers["idempotency-key"]).slice(0, 8)}` }, created: true } };
    }
    const match = /^\/v1\/cases\/([^/]+)\/commands$/.exec(path);
    if (service === "case-api" && method === "POST" && match) {
      const command = businessCommandSchema.parse(body);
      const entry = [...cases.values()].find((value) => value.caseId === decodeURIComponent(match[1]!))!;
      const prior = receipts.get(command.idempotencyKey);
      if (prior) {
        if (prior.digest !== stableDigest(command)) return { status: 409, body: { error: "command.idempotency_conflict" } };
        return { status: 200, body: { ...prior.response, replayed: true } };
      }
      if (command.preconditions.caseSequence !== entry.sequence) return { status: 409, body: { error: "command.case_sequence_conflict" } };
      if (command.commandType === "AddSubject") subjects.push(command.payload);
      if (command.commandType === "RecordCanonicalRecords") records.push(...recordCanonicalRecordsPayloadSchema.parse(command.payload).records);
      if (command.commandType === "RecordReview") {
        const payload = command.payload as any;
        reviews.push({ review_type: payload.reviewType, details: { requestKey: payload.documentRunAuthorization.requestKey, authorization: payload.documentRunAuthorization } });
      }
      entry.sequence += 1;
      const response = { outcome: "ACCEPTED", caseId: entry.caseId, caseSequence: entry.sequence };
      receipts.set(command.idempotencyKey, { digest: stableDigest(command), response });
      return { status: 200, body: response };
    }
    return { status: 500, body: { error: "unexpected" } };
  });
  return { upstream, cases, records, subjects, uploads, reviews, runs };
}

async function harness(upstream: Upstream, roles = principal.roles, env: Record<string, string> = {}) {
  const app = buildApp({ env: { BFF_PUBLIC_ORIGIN: "http://ui.test", BFF_IDENTITY_MODE: "delegated", ...env }, principalResolver: { source: "local", resolve: async () => ({ ...principal, roles }) }, upstream });
  const session = await app.inject({ url: "/api/v1/session", headers: { authorization: "Bearer analyst-session" } });
  const headers = { cookie: String(session.headers["set-cookie"]).split(";")[0]!, origin: "http://ui.test", "x-csrf-token": session.json().csrfToken };
  return { app, headers };
}

it("selects the plan, opens a KYB case for a company, adds its subjects and records the application", async () => {
  const api = caseApi();
  const { app, headers } = await harness(api.upstream);
  try {
    const response = await app.inject({ method: "POST", url: "/api/v1/applications", payload: COMPANY, headers: { ...headers, "idempotency-key": "application-key-1" } });
    expect(response.statusCode, response.body).toBe(201);
    const body = response.json();
    expect(body).toMatchObject({ caseType: "kyb_onboarding", planDigest: PLAN, pack: { id: "policy.pack.gb.bank-synthetic.business-banking" }, subjectsAdded: 3 });
    expect(body.recordsRecorded).toBe(api.records.length);
    const calls = api.upstream.mock.calls.map((call) => `${call[0]} ${call[1]} ${call[2]}`);
    expect(calls[0]).toBe("control-api POST /v1/case-plans/select");
    expect(api.upstream.mock.calls[0]![4]).toEqual({ ...COMPANY.scope });
    expect(api.upstream.mock.calls[0]![5]).not.toHaveProperty("idempotency-key");
    expect(calls[1]).toBe("case-api POST /v1/cases");
    expect(api.upstream.mock.calls[1]![4]).toMatchObject({ caseType: "kyb_onboarding", schemaVersion: "kyb.case.v1", jurisdiction: "GB", harnessPlanDigest: PLAN, externalRef: "APP-GB-1",
      policyAuthority: { policyId: "policy.pack.gb.bank-synthetic.business-banking" }, actor: { type: "HUMAN", principalId: "analyst" } });
    expect(calls.slice(2)).toEqual([...Array(4)].map(() => `case-api POST /v1/cases/${body.caseId}/commands`));
    // The customer is the first subject: the flows read subjects.0.
    expect(api.subjects.map((subject) => [subject.subjectId, subject.subjectType])).toEqual([["entity.customer", "legal_entity"], ["entity.party-1", "individual"], ["entity.party-2", "individual"]]);
    expect(new Set(api.records.map((record) => record.object_type))).toEqual(new Set(["Entity", "Identity", "IdentityIdentifier", "Address", "Registration", "Party", "Product", "ExpectedActivity", "BankingRelationship", "OwnershipInterest", "OfficerRole", "SourceOfFunds", "Application"]));
    // Observed at the case's creation, so a retry maps to the same versions.
    expect(new Set(api.records.map((record) => record.observed_at))).toEqual(new Set([[...api.cases.values()][0]!.createdAt]));
  } finally { await app.close(); }
});

it("is idempotent: a retried submission opens no second case and records nothing twice; a different application under the key conflicts", async () => {
  const api = caseApi();
  const { app, headers } = await harness(api.upstream);
  try {
    const send = (payload: ApplicationSubmissionInput, key = "application-key-2") => app.inject({ method: "POST", url: "/api/v1/applications", payload, headers: { ...headers, "idempotency-key": key } });
    const first = await send(COMPANY);
    const recorded = api.records.length;
    const retry = await send(COMPANY);
    expect(retry.statusCode, retry.body).toBe(201);
    expect(retry.json()).toEqual(first.json());
    expect(api.cases.size).toBe(1);
    expect(api.records).toHaveLength(recorded);
    expect(api.subjects).toHaveLength(3);

    const changed = await send({ ...COMPANY, sourceOfFunds: "A director's loan" });
    expect(changed.statusCode).toBe(409);
    expect(changed.json().error).toBe("command.idempotency_conflict");
    expect(api.records).toHaveLength(recorded);

  } finally { await app.close(); }
});

it("completes a partial earlier attempt on retry", async () => {
  const api = caseApi();
  const inner = api.upstream.getMockImplementation()!;
  let failNext = true;
  const flaky = vi.fn<Upstream>(async (...args) => {
    if (failNext && (args[4] as { commandType?: string } | undefined)?.commandType === "RecordCanonicalRecords") { failNext = false; return { status: 503, body: { error: "case.store_unavailable" } }; }
    return inner(...args);
  });
  const { app, headers } = await harness(flaky);
  try {
    const send = () => app.inject({ method: "POST", url: "/api/v1/applications", payload: COMPANY, headers: { ...headers, "idempotency-key": "application-key-3" } });
    const failed = await send();
    expect(failed.statusCode).toBe(503);
    expect(api.subjects).toHaveLength(3);
    expect(api.records).toHaveLength(0);
    const retried = await send();
    expect(retried.statusCode, retried.body).toBe(201);
    expect(api.cases.size).toBe(1);
    expect(api.subjects).toHaveLength(3);
    expect(api.records.length).toBe(retried.json().recordsRecorded);
  } finally { await app.close(); }
});

it("opens a KYC case for a person, and keeps a refused selection's status, reason and candidates", async () => {
  const api = caseApi();
  const { app, headers } = await harness(api.upstream);
  try {
    const person = await app.inject({ method: "POST", url: "/api/v1/applications", payload: PERSON, headers: { ...headers, "idempotency-key": "application-person" } });
    expect(person.statusCode, person.body).toBe(201);
    expect(person.json()).toMatchObject({ caseType: "kyc_onboarding", subjectsAdded: 1 });
    expect([...api.cases.values()][0]!.request).toMatchObject({ caseType: "kyc_onboarding", schemaVersion: "kyc.case.v1", jurisdiction: "US" });

    api.upstream.mockClear();
    const refused = await app.inject({ method: "POST", url: "/api/v1/applications", payload: { ...COMPANY, scope: { ...COMPANY.scope, jurisdiction: "AU" } }, headers: { ...headers, "idempotency-key": "application-au" } });
    expect(refused.statusCode).toBe(422);
    expect(refused.json()).toMatchObject({ error: "case.plan_no_pack", message: expect.stringContaining("AU"), details: { candidates: ["a".repeat(64)] } });
    expect(api.upstream.mock.calls.filter((call) => call[0] === "case-api")).toHaveLength(0);

    const changed = await app.inject({ method: "POST", url: "/api/v1/applications", payload: { ...COMPANY, harnessPlanDigest: "f".repeat(64) }, headers: { ...headers, "idempotency-key": "application-changed" } });
    expect(changed.statusCode).toBe(409);
    expect(changed.json().error).toBe("case.plan_selection_changed");
  } finally { await app.close(); }
});

it("refuses an invalid application, a missing key, a role without case.write and a missing CSRF token, before any upstream call", async () => {
  const api = caseApi();
  const { app, headers } = await harness(api.upstream);
  try {
    const invalid = await app.inject({ method: "POST", url: "/api/v1/applications", payload: { ...COMPANY, relatedParties: [] , customer: { name: "No Registration Ltd", legalForm: "corporation" } }, headers: { ...headers, "idempotency-key": "application-invalid" } });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ error: "application.request_invalid", details: { issues: expect.arrayContaining([expect.objectContaining({ path: "customer.registrationNumber", message: "application.registration_number_required" })]) } });
    expect((await app.inject({ method: "POST", url: "/api/v1/applications", payload: COMPANY, headers })).json().error).toBe("application.idempotency_key_required");
    const { "x-csrf-token": _csrf, ...noCsrf } = headers;
    expect((await app.inject({ method: "POST", url: "/api/v1/applications", payload: COMPANY, headers: { ...noCsrf, "idempotency-key": "application-csrf" } })).json().error).toBe("csrf.invalid");
    expect(api.upstream).not.toHaveBeenCalled();
  } finally { await app.close(); }
  const reader = await harness(api.upstream, ["Case.Reviewer"]);
  try {
    const forbidden = await reader.app.inject({ method: "POST", url: "/api/v1/applications", payload: COMPANY, headers: { ...reader.headers, "idempotency-key": "application-reader" } });
    expect(forbidden.statusCode).toBe(403);
    expect(api.upstream).not.toHaveBeenCalled();
  } finally { await reader.app.close(); }
});

const CERTIFICATE = Buffer.from("CERTIFICATE OF INCORPORATION\nCompany name: Thistle Fabrication Ltd\nCompany number: SC401042\n");
const WITH_DOCUMENT: ApplicationSubmissionInput = {
  ...COMPANY,
  documents: [{ documentType: "certificate_of_incorporation", filename: "certificate.txt", mediaType: "text/plain", contentBase64: CERTIFICATE.toString("base64") }],
};

it("uploads the applicant's documents to the case and records DocumentVersions over the stored artifacts, idempotently", async () => {
  const api = caseApi();
  const { app, headers } = await harness(api.upstream);
  try {
    const send = () => app.inject({ method: "POST", url: "/api/v1/applications", payload: WITH_DOCUMENT, headers: { ...headers, "idempotency-key": "application-document" } });
    const response = await send();
    expect(response.statusCode, response.body).toBe(201);
    // An analyst can upload but not authorize an extraction run: the document is named, not silently left unparsed.
    expect(response.json()).toMatchObject({ documentsUploaded: 1, documentRuns: [{ status: "NOT_STARTED", reason: "authorization.role_missing" }] });
    const calls = api.upstream.mock.calls.map((call) => `${call[1]} ${call[2]}`);
    const caseId = response.json().caseId;
    // After the case exists and before its records: the records cite the upload.
    expect(calls.indexOf(`POST /v1/cases/${caseId}/documents`)).toBe(calls.indexOf("POST /v1/cases") + 1);
    const uploaded = api.upstream.mock.calls.find((call) => String(call[2]).endsWith("/documents"))!;
    expect(uploaded[4]).toEqual({ filename: "certificate.txt", mediaType: "text/plain", contentBase64: CERTIFICATE.toString("base64"), documentType: "certificate_of_incorporation", subjectRefs: ["entity.customer"] });
    const digest = createHash("sha256").update(CERTIFICATE).digest("hex");
    expect(api.records.filter((record) => record.object_type === "DocumentVersion")).toEqual([expect.objectContaining({
      object_id: `doc_${digest.slice(0, 24)}`,
      data: expect.objectContaining({ artifact_hash: digest, artifact_ref: `artifact://postgres/tenant-cases/${digest}`, media_type: "text/plain",
        extensions: { "ehf.application": { schema_version: "1.0.0", value: expect.objectContaining({ evidence_id: "evidence_1", document_type: "certificate_of_incorporation" }) } } }),
    })]);
    const recorded = api.records.length;
    const retry = await send();
    expect(retry.statusCode, retry.body).toBe(201);
    expect(api.uploads.size).toBe(1);
    expect(api.records).toHaveLength(recorded);
  } finally { await app.close(); }
});

it("starts each uploaded document's extraction run once, and names a run it cannot start", async () => {
  const api = caseApi();
  const roles = ["Case.Analyst", "Case.Reviewer", "Harness.Operator"];
  const { app, headers } = await harness(api.upstream, roles, { BFF_DOCUMENT_PLAN_DIGEST: DOCUMENT_PLAN.planDigest });
  try {
    const send = () => app.inject({ method: "POST", url: "/api/v1/applications", payload: WITH_DOCUMENT, headers: { ...headers, "idempotency-key": "application-run" } });
    const response = await send();
    expect(response.statusCode, response.body).toBe(201);
    const digest = createHash("sha256").update(CERTIFICATE).digest("hex");
    const [run] = response.json().documentRuns;
    expect(run).toMatchObject({ documentId: `doc_${digest.slice(0, 24)}`, status: "STARTED", runId: expect.stringMatching(/^run_/) });
    // The run is authorized by a review on the case and reads the verified original bytes.
    expect(api.reviews).toHaveLength(1);
    expect(api.runs).toHaveLength(1);
    expect(api.runs[0]!.body).toMatchObject({ planDigest: DOCUMENT_PLAN.planDigest, input: { caseId: response.json().caseId, documentVersion: digest, evidenceId: "evidence_1", contentBase64: CERTIFICATE.toString("base64") } });
    const retry = await send();
    expect(retry.json().documentRuns).toEqual([run]);
    expect(api.reviews).toHaveLength(1);
    expect(new Set(api.runs.map((call) => call.key)).size).toBe(1);
  } finally { await app.close(); }
  // No document plan configured: the case is still opened and the document named as not started.
  const unconfigured = caseApi();
  const plain = await harness(unconfigured.upstream, roles);
  try {
    const response = await plain.app.inject({ method: "POST", url: "/api/v1/applications", payload: WITH_DOCUMENT, headers: { ...plain.headers, "idempotency-key": "application-no-plan" } });
    expect(response.statusCode, response.body).toBe(201);
    expect(response.json().documentRuns).toEqual([expect.objectContaining({ status: "NOT_STARTED", reason: "document.extraction_plan_not_configured" })]);
    expect(unconfigured.runs).toHaveLength(0);
  } finally { await plain.app.close(); }
});

it("refuses a document type outside the document field catalog before any upstream call", async () => {
  const api = caseApi();
  const { app, headers } = await harness(api.upstream);
  try {
    const response = await app.inject({ method: "POST", url: "/api/v1/applications", headers: { ...headers, "idempotency-key": "application-bad-type" },
      payload: { ...WITH_DOCUMENT, documents: [{ ...WITH_DOCUMENT.documents![0]!, documentType: "napkin_sketch" }] } });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "application.request_invalid", details: { issues: [{ path: "documents.0.documentType", message: "application.document_type_unknown" }] } });
    expect(api.upstream).not.toHaveBeenCalled();
  } finally { await app.close(); }
});

it("adds a person's declared PEP sibling as a case subject with a PEPRelationship", async () => {
  const api = caseApi();
  const { app, headers } = await harness(api.upstream);
  try {
    const response = await app.inject({ method: "POST", url: "/api/v1/applications", headers: { ...headers, "idempotency-key": "application-pep" },
      payload: { ...PERSON, relatedParties: [{ name: "Kim Reyes", relationToCustomer: "sibling", politicallyExposed: "yes", pepPosition: "Ambassador" }] } });
    expect(response.statusCode, response.body).toBe(201);
    expect(response.json()).toMatchObject({ caseType: "kyc_onboarding", subjectsAdded: 2 });
    expect(api.subjects[1]).toMatchObject({ subjectId: "entity.party-1", subjectType: "individual", attributes: { relationToCustomer: "sibling", politicallyExposed: "yes" } });
    expect(api.records.filter((record) => record.object_type === "PEPRelationship").map((record) => record.data)).toEqual([
      expect.objectContaining({ source: "entity.customer", target: "entity.party-1", relation: "sibling", verified: false }),
    ]);
  } finally { await app.close(); }
});
