import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createCaseStore, createKycCase, type CaseStore } from "@ehf/case-store";
import { createKycCaseRequestSchema } from "@ehf/contracts";
import { buildCaseApi } from "./app.js";

const EDGE_TOKEN = "edge-service-token-for-tests-0001";
const RUNTIME_TOKEN = "runtime-service-token-for-tests-01";
const grants = (tenantId: string) => [
  { token: EDGE_TOKEN, subjectId: "control-surface-edge", roles: ["Edge.Delegate"], tenantId },
  { token: RUNTIME_TOKEN, subjectId: "harness-runtime", roles: ["Case.Api.Access"], tenantId },
];
const person = (roles: string) => ({ authorization: `Bearer ${EDGE_TOKEN}`, "x-actor-id": "analyst@example.test", "x-actor-roles": roles });
const upload = { filename: "certificate.txt", mediaType: "text/plain", contentBase64: Buffer.from("Certificate of incorporation\nName: Acme Ltd").toString("base64"), documentType: "certificate_of_incorporation" };

function stubStore(): CaseStore {
  return {
    db: { query: async () => ({ rowCount: 0, rows: [] }) },
    ownsDatabase: false,
    schemas: { core: "case_core", ledger: "case_ledger", evidence: "evidence" },
    artifactBackend: "postgres",
    evidenceRequireScan: false,
    evidenceMaxBytes: 1024,
  } as unknown as CaseStore;
}

describe("case documents", () => {
  it("lets only a person with evidence.write upload, and validates the upload", async () => {
    const app = buildCaseApi({ store: stubStore(), env: {}, serviceGrants: grants("tenant_demo") });
    try {
      const reader = await app.inject({ method: "POST", url: "/v1/cases/case_1/documents", headers: person("Harness.Reader"), payload: upload });
      expect([reader.statusCode, reader.json().error]).toEqual([403, "authorization.role_missing"]);
      // A workload registers evidence through /v1/evidence:register under an execution envelope, never here.
      const workload = await app.inject({ method: "POST", url: "/v1/cases/case_1/documents", headers: { authorization: `Bearer ${RUNTIME_TOKEN}` }, payload: upload });
      expect(workload.statusCode).toBe(403);
      for (const payload of [{ ...upload, filename: "../etc/passwd" }, { ...upload, mediaType: "text plain" }, { ...upload, documentType: "Bad Type" }, { ...upload, extra: 1 }]) {
        const invalid = await app.inject({ method: "POST", url: "/v1/cases/case_1/documents", headers: person("Case.Analyst"), payload });
        expect([invalid.statusCode, invalid.json().error]).toEqual([400, "document.request_invalid"]);
      }
      const content = await app.inject({ method: "GET", url: "/v1/evidence/ev_1/content", headers: { authorization: `Bearer ${RUNTIME_TOKEN}` } });
      expect(content.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it.skipIf(!process.env.EHF_TEST_DATABASE_URL)("store an upload content-addressed, replay it idempotently and return its verified bytes", async () => {
    const store = createCaseStore({ connectionString: process.env.EHF_TEST_DATABASE_URL! });
    const tenantId = `documents_${randomUUID()}`;
    const app = buildCaseApi({ store, env: {}, serviceGrants: grants(tenantId) });
    try {
      const created = await createKycCase(store, createKycCaseRequestSchema.parse({ tenantId, policySnapshotDigest: "a".repeat(64), harnessPlanDigest: "b".repeat(64),
        actor: { type: "HUMAN", principalId: "creator", roles: [] } }), randomUUID());
      const caseId = created.case.caseId;
      const headers = { ...person("Case.Analyst"), "idempotency-key": randomUUID() };
      const first = await app.inject({ method: "POST", url: `/v1/cases/${caseId}/documents`, headers, payload: upload });
      expect(first.statusCode).toBe(201);
      const sha256 = createHash("sha256").update(Buffer.from(upload.contentBase64, "base64")).digest("hex");
      expect(first.json().document).toEqual({ documentId: `doc_${sha256.slice(0, 24)}`, sha256, filename: "certificate.txt", mediaType: "text/plain",
        documentType: "certificate_of_incorporation", status: "UPLOADED_UNPARSED" });
      expect(first.json().evidence).toMatchObject({ type: "DOCUMENT", source: { type: "UPLOAD", dataset: "document:certificate.txt" },
        trust: { tier: "CUSTOMER_PROVIDED", instructionTrust: "UNTRUSTED_EXTERNAL" }, createdBy: { type: "HUMAN", principalId: "analyst@example.test" } });
      const replay = await app.inject({ method: "POST", url: `/v1/cases/${caseId}/documents`, headers, payload: upload });
      expect(replay.statusCode).toBe(200);
      expect(replay.json().evidence.evidenceId).toBe(first.json().evidence.evidenceId);
      const evidenceId = first.json().evidence.evidenceId as string;
      const content = await app.inject({ method: "GET", url: `/v1/evidence/${evidenceId}/content`, headers: person("Case.Reviewer") });
      expect(content.statusCode).toBe(200);
      expect(content.headers["cache-control"]).toBe("no-store");
      expect(content.json()).toEqual({ evidenceId, caseId, mediaType: "text/plain", rawDigest: expect.stringContaining(sha256), contentBase64: upload.contentBase64 });
      const missing = await app.inject({ method: "GET", url: "/v1/evidence/ev_missing/content", headers: person("Case.Reviewer") });
      expect(missing.statusCode).toBe(404);
    } finally {
      await app.close(); // closes the store's pool, which it owns
    }
  });
});
