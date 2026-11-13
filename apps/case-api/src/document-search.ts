import { z } from "zod";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { CanonicalRecord, CaseSnapshot } from "@ehf/contracts";
import {
  documentSearchScopeSchema,
  documentSearchRequestSchema,
  documentCitationRequestSchema,
} from "@ehf/contracts/document-search";
import {
  createContextStore,
  ContextStoreError,
  indexDocument,
  prepareDocumentIndex,
  searchDocuments,
  resolveDocumentCitation,
  withdrawDocumentIndex,
  documentAuthorizationDigest,
  type ContextStore,
  type IndexDocument,
  type DocumentRetrievalAuthority,
} from "@ehf/context-store";
import {
  getCanonicalCaseSnapshot,
  getEvidence,
  assertActiveCaseExecution,
  projectCanonicalCaseSnapshot,
  CaseStoreError,
  type CaseStore,
} from "@ehf/case-store";
import type { PlatformAction, Principal, ResourceRef } from "@ehf/identity";
import {
  isWorkload,
  verifyCaseReadAuthority,
  assertSnapshotWithinEnvelope,
} from "./execution-authority.js";

const object = (v: unknown): Record<string, any> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, any>)
    : {};
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
export function searchableDocuments(
  snapshot: CaseSnapshot,
  subjects: string[],
  purpose: string,
  roles: string[],
  residencies: string[],
  permittedPurposes: string[] = ["kyc.review"],
): IndexDocument[] {
  const records = object(snapshot.data.records);
  const pages = (
    Array.isArray(records.DocumentPage) ? records.DocumentPage : []
  ) as CanonicalRecord[];
  const versions = (
    Array.isArray(records.DocumentVersion) ? records.DocumentVersion : []
  ) as CanonicalRecord[];
  const hasSourceAuthority = (p: CanonicalRecord) =>
    Boolean(
      object(p.provenance).source_decision_id ||
      object(p.provenance).source_use_decision_id ||
      object(p.provenance).sourceUseDecisionId ||
      object(p.provenance).sourceDecisionIds ||
      object(p.provenance).source_decision_ids,
    );
  const classifications = ["PUBLIC", "INTERNAL", "CONFIDENTIAL"];
  const evidence = (
    Array.isArray(snapshot.data.evidence) ? snapshot.data.evidence : []
  ).map(object);
  const documents: IndexDocument[] = [];
  for (const version of versions) {
    const d = object(version.data);
    if (
      typeof d.document_id !== "string" ||
      !d.document_id ||
      hasSourceAuthority(version)
    )
      continue;
    const artifactRef = String(d.artifact_ref).replace(
      /^ehf:case-evidence:/,
      "",
    );
    const artifact = evidence.find((e) =>
      [e.evidence_id, e.evidenceId, e.artifact_ref, e.artifactRef].includes(
        artifactRef,
      ),
    );
    // Only captured artifacts in this case. Source-backed pages need current source-use
    // authority, which this first retrieval profile does not yet delegate: fail closed.
    if (
      !artifact ||
      String(artifact.raw_digest ?? artifact.rawDigest).replace(
        /^sha256:/,
        "",
      ) !== d.artifact_hash
    )
      continue;
    if (object(artifact.source).type !== "UPLOAD") continue;
    const residency = String(artifact.residency ?? "");
    const selected = pages.filter(
      (p) => p.data.document_version === d.artifact_hash,
    );
    const linkedSubjects = (p: CanonicalRecord) =>
      p.subject_ids?.length
        ? p.subject_ids
        : strings(artifact.subject_refs ?? artifact.subjectRefs);
    const permitted = (p: CanonicalRecord) =>
      p.purposes?.length ? p.purposes : permittedPurposes;
    if (
      selected.some(
        (p) =>
          !linkedSubjects(p).length ||
          linkedSubjects(p).some((id) => !subjects.includes(id)) ||
          !permitted(p).includes(purpose) ||
          object(p.provenance).source_use_decision_id ||
          object(p.provenance).sourceUseDecisionId ||
          object(p.provenance).sourceDecisionIds ||
          object(p.provenance).source_decision_ids ||
          object(p.provenance).source_decision_id ||
          !classifications.includes(p.classification) ||
          typeof p.data.text !== "string" ||
          !Number.isInteger(p.data.page) ||
          Number(p.data.page) < 1,
      )
    )
      continue;
    if (
      !selected.length ||
      !residencies.includes(residency) ||
      !permitted(version).includes(purpose) ||
      !classifications.includes(version.classification)
    )
      continue;
    const basis = selected.map(
      (p) =>
        object(object(object(p.data.extensions)["ehf.document"]).value)
          .text_basis ??
        object(object(object(p.data.extensions)["ehf.connector"]).value)
          .text_basis,
    );
    documents.push({
      documentId: String(d.document_id),
      documentVersion: String(d.artifact_hash),
      artifactHash: String(d.artifact_hash),
      artifactRef: String(artifact.evidence_id ?? artifact.evidenceId),
      subjects: [...new Set(selected.flatMap(linkedSubjects))],
      purposes: permitted(version).filter((purpose) =>
        selected.every((page) => permitted(page).includes(purpose)),
      ),
      accessRoles: [...roles].sort(),
      residency,
      parserVersion: String(
        object(object(object(version.data.extensions)["ehf.document"]).value)
          .parser_version ??
          object(object(object(version.data.extensions)["ehf.connector"]).value)
            .parser ??
          "unknown",
      ),
      textCoverage: basis.every((b) => b === "full_text")
        ? "extracted_text"
        : basis.every((b) => b === "cited_quotes")
          ? "cited_quotes"
          : "unknown",
      pages: selected.map((p) => ({
        page: Number(p.data.page),
        text: String(p.data.text),
        objectId: p.object_id,
        versionId: p.version_id,
      })),
    });
  }
  if (documents.length > 100)
    throw new CaseStoreError("document.search_document_limit", 413);
  return documents;
}
export function registerDocumentSearch(
  app: FastifyInstance,
  o: {
    store: CaseStore;
    contextStore?: ContextStore | null | undefined;
    env: NodeJS.ProcessEnv;
    executionSecret: string;
    authorize: (
      r: FastifyRequest,
      a: PlatformAction,
      resource: ResourceRef,
    ) => Promise<Principal>;
  },
) {
  let context = o.contextStore;
  const indexStore = () => {
    if (context === undefined)
      context = o.env.CONTEXT_DATABASE_URL
        ? createContextStore({
            connectionString: o.env.CONTEXT_DATABASE_URL,
            env: o.env,
          })
        : null;
    if (!context)
      throw new CaseStoreError("document.search_store_unavailable", 503);
    return context;
  };
  app.addHook("onClose", async () => {
    if (context && !o.contextStore) await context.db.end();
  });
  const allowedRoles = (
    o.env.DOCUMENT_SEARCH_ROLES ??
    "Case.Analyst,Case.Reviewer,Harness.Operator,Harness.Author,Harness.Reader"
  )
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const permittedPurposes = (o.env.DOCUMENT_SEARCH_PURPOSES ?? "kyc.review")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const residencies = (o.env.DOCUMENT_SEARCH_RESIDENCIES ?? "US")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const authorize = async (
    r: FastifyRequest,
    action: PlatformAction,
    purpose: string,
    requested?: string[],
  ) => {
    const caseId = (r.params as { caseId: string }).caseId;
    if (!permittedPurposes.includes(purpose))
      throw new CaseStoreError("document.search_purpose_denied", 403);
    const p = await o.authorize(r, action, { kind: "case", id: caseId });
    await o.authorize(r, "evidence.read", { kind: "case", id: caseId });
    const workload = isWorkload(p);
    if (workload && action !== "case.read")
      throw new CaseStoreError("document.index_interactive_required", 403);
    let snapshot = await getCanonicalCaseSnapshot(
      o.store,
      p.tenantId,
      caseId,
      purpose,
    );
    if (!snapshot) throw new CaseStoreError("case.not_found", 404);
    if (workload) {
      const claims = await verifyCaseReadAuthority(r, o.executionSecret);
      await assertActiveCaseExecution(
        o.store.executionDb ?? o.store.db,
        claims,
        p.tenantId,
        caseId,
      );
      const grant = assertSnapshotWithinEnvelope(snapshot, purpose, claims);
      // Projection precedes indexing/search authorization. Missing fields deny retrieval.
      snapshot = projectCanonicalCaseSnapshot(
        snapshot,
        grant.selectors,
        grant.policies,
      );
    }
    const caseSubjects = (
      Array.isArray(snapshot.data.subjects) ? snapshot.data.subjects : []
    ).map((x) => String(object(x).subjectId ?? object(x).subject_id ?? ""));
    const subjects = requested ?? caseSubjects;
    if (!subjects.length || subjects.some((id) => !caseSubjects.includes(id)))
      throw new CaseStoreError("document.search_subject_denied", 403);
    const roles = workload
      ? allowedRoles
      : p.roles.filter((role) => allowedRoles.includes(role));
    if (!roles.length)
      throw new CaseStoreError("document.search_access_denied", 403);
    // Stable policy labels, independent of the author who last rebuilt the index.
    const documents = searchableDocuments(
      snapshot,
      subjects,
      purpose,
      allowedRoles,
      residencies,
      permittedPurposes,
    );
    const authority: DocumentRetrievalAuthority = {
      caseId,
      subjects,
      purpose,
      roles,
      residencies,
      documents: documents.map((d) => ({
        documentId: d.documentId,
        authorizationDigest: documentAuthorizationDigest(d),
      })),
    };
    return { p, documents, authority };
  };
  const route =
    (fn: (r: FastifyRequest) => Promise<unknown>) =>
    async (r: FastifyRequest, reply: any) => {
      reply.header("cache-control", "no-store");
      try {
        return await fn(r);
      } catch (e) {
        if (e instanceof ContextStoreError || e instanceof CaseStoreError)
          return reply.code(e.httpStatus).send({ error: e.code });
        if (e instanceof z.ZodError)
          return reply
            .code(400)
            .send({ error: "document.search_request_invalid" });
        throw e;
      }
    };
  app.post(
    "/v2/cases/:caseId/documents/index",
    { bodyLimit: 16384 },
    route(async (r) => {
      const input = documentSearchScopeSchema
        .extend({ rebuildKey: z.string().min(1).max(128) })
        .parse(r.body);
      const { p, documents, authority } = await authorize(
        r,
        "evidence.write",
        input.purpose,
        input.subjects,
      );
      // Validate the whole bounded input before changing any generation.
      if (documents.length > 20)
        throw new CaseStoreError("document.index_batch_limit", 413);
      for (const document of documents)
        prepareDocumentIndex(
          p.tenantId,
          authority.caseId,
          document,
          input.rebuildKey,
        );
      const result = [];
      for (const d of documents)
        result.push({
          documentId: d.documentId,
          ...(await indexDocument(
            indexStore(),
            p.tenantId,
            authority.caseId,
            d,
            input.rebuildKey,
          )),
        });
      return {
        documents: result,
        limitations: [
          "Only captured uploaded artifacts and authorized extracted pages are indexed. Source-backed documents require source-use authority.",
        ],
      };
    }),
  );
  app.post(
    "/v2/cases/:caseId/documents/search",
    { bodyLimit: 16384 },
    route(async (r) => {
      const input = documentSearchRequestSchema.parse(r.body);
      const { p, authority } = await authorize(
        r,
        "case.read",
        input.purpose,
        input.subjects,
      );
      return searchDocuments(indexStore(), p.tenantId, authority, input);
    }),
  );
  app.post(
    "/v2/cases/:caseId/documents/citations/resolve",
    { bodyLimit: 16384 },
    route(async (r) => {
      const input = documentCitationRequestSchema.parse(r.body);
      const { p, authority } = await authorize(
        r,
        "case.read",
        input.purpose,
        input.subjects,
      );
      const resolved = await resolveDocumentCitation(
        indexStore(),
        p.tenantId,
        authority,
        input.citationId,
      );
      // Recheck the current captured artifact when resolving each citation; no bytes come from the index.
      const evidence = await getEvidence(
        o.store,
        p.tenantId,
        resolved.citation.artifactRef,
      );
      if (
        !evidence ||
        evidence.case_id !== authority.caseId ||
        String(evidence.raw_digest).replace(/^sha256:/, "") !==
          resolved.citation.artifactHash
      )
        throw new CaseStoreError("document.citation_unavailable", 404);
      return resolved;
    }),
  );
  app.delete(
    "/v2/cases/:caseId/documents/index/:documentId",
    { bodyLimit: 16384 },
    route(async (r) => {
      const { purpose, subjects } = documentSearchScopeSchema.parse(r.body);
      const { p, authority } = await authorize(
        r,
        "evidence.write",
        purpose,
        subjects,
      );
      return withdrawDocumentIndex(
        indexStore(),
        p.tenantId,
        authority.caseId,
        (r.params as { documentId: string }).documentId,
      );
    }),
  );
}
