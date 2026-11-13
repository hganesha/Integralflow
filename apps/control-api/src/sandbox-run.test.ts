import { readFileSync } from "node:fs";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { harnessPlanV2Schema, type HarnessPlanV2 } from "@ehf/contracts";
import type { Principal } from "@ehf/identity";
import type { AuthoringDraftRecord, Database } from "@ehf/persistence";
import { createHash } from "node:crypto";
import { readParty } from "@ehf/context-corpus";
import { listSandboxParties, sandboxCorpusRoot, sandboxDocumentLoader, sandboxDocuments, sandboxUnavailableReason } from "./sandbox-run.js";
import { registerSandboxRunRoutes } from "./sandbox-run-routes.js";

const plan = harnessPlanV2Schema.parse(JSON.parse(readFileSync(new URL("../../../artifacts/kyc-agentic.plan.json", import.meta.url), "utf8"))) as HarnessPlanV2;
const policy = readFileSync(new URL("../../../domains/kyc-agentic/policy.yaml", import.meta.url), "utf8");
const draft = { draftId: "draft-1", revision: 4, parsedPackage: { policies: [{ source: "policy.yaml" }] }, sourceFiles: { "policy.yaml": policy } } as unknown as AuthoringDraftRecord;
const author: Principal = { subjectId: "author", tenantId: "tenant-1", roles: ["Harness.Author"], actorType: "human", source: "local" } as Principal;

function build(env: NodeJS.ProcessEnv, overrides: { draft?: AuthoringDraftRecord | null; principal?: Principal } = {}) {
  const app = Fastify();
  const caseService = vi.fn(async () => { throw new Error("The case service must not be reached"); });
  const compile = vi.fn(async () => plan);
  const authorize = vi.fn(async () => overrides.principal ?? author);
  registerSandboxRunRoutes(app, { db: {} as Database, env, opaVersion: "1.9.0", authorize, compile, caseService,
    loadDraft: (async () => overrides.draft === undefined ? draft : overrides.draft) as never });
  return { app, caseService, compile, authorize };
}

describe("sandbox runs of a draft", () => {
  const root = sandboxCorpusRoot({});

  it("requires evidence access on the sandbox case before querying observations", async () => {
    const app = Fastify();
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("from harness_control.sandbox_launches")) {
        return { rows: [{ result: { caseId: "case_sandbox", runId: "run_sandbox" }, draft_id: "draft-1", created_at: new Date() }] };
      }
      return { rows: [] };
    });
    const db = { connect: async () => ({ query, release: () => {} }) } as unknown as Database;
    const authorize = vi.fn<Parameters<typeof registerSandboxRunRoutes>[1]["authorize"]>(async (_request, action) => {
      if (action === "evidence.read") throw Object.assign(new Error("evidence.restricted"), { statusCode: 403 });
      return author;
    });
    registerSandboxRunRoutes(app, { db, env: {}, authorize, opaVersion: "1.9.0",
      compile: async () => plan, caseService: async () => ({}) });
    try {
      const response = await app.inject("/v1/authoring/sandbox-runs/run_sandbox/observations?kind=skill");
      expect(response.statusCode).toBe(403);
      expect(authorize.mock.calls.map(([, action, resource]) => [action, resource])).toEqual([
        ["run.read", { kind: "run", id: "run_sandbox" }],
        ["case.read", { kind: "case", id: "case_sandbox" }],
        ["evidence.read", { kind: "case", id: "case_sandbox" }],
      ]);
      expect(query.mock.calls.some(([sql]) => sql.includes("sandbox_observations"))).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("lists the synthetic test parties from their case files", () => {
    const parties = listSandboxParties(root);
    expect(parties.map((party) => party.id)).toEqual(["H01", "H02", "H03", "H04", "H05", "H06", "H07", "H10", "H12"]);
    expect(parties.find((party) => party.id === "H01")).toMatchObject({ name: "Ingrid Halvorsen", customerType: "individual", records: 1097 });
    expect(parties.find((party) => party.id === "H04")).toMatchObject({ customerType: "business" });
    expect(listSandboxParties("/nonexistent")).toEqual([]);
  });

  it("rebuilds a party's source documents only when they hash to the recorded artifact", () => {
    const h02 = readParty(root, "H02");
    const rebuilt = sandboxDocuments(h02);
    expect(rebuilt.skipped).toBe(0);
    expect(rebuilt.documents.map((document) => document.filename)).toEqual(["rios-national-identity-card.txt", "rios-utility-bill-2026-08.txt"]);
    for (const document of rebuilt.documents) expect(createHash("sha256").update(document.content).digest("hex")).toBe(document.sha256);
    expect(sandboxDocuments(readParty(root, "H01"))).toEqual({ documents: [], skipped: 0 });
    // A page whose text no longer hashes to the artifact is skipped, never loaded as an approximation.
    const altered = { ...h02, documents: h02.documents!.map((row) => row.object_type === "DocumentPage" ? { ...row, data: { ...row.data, text: `${String(row.data.text)} ` } } : row) };
    expect(sandboxDocuments(altered)).toEqual({ documents: [], skipped: 2 });
  });

  it("loads a document into the evidence pipeline only where one is configured, and checks what it stored", async () => {
    expect(sandboxDocumentLoader({})).toBeUndefined();
    expect(sandboxDocumentLoader({ EVIDENCE_PIPELINE_URL: "http://pipeline" })).toBeUndefined();
    const document = sandboxDocuments(readParty(root, "H02")).documents[0]!;
    const calls: Array<{ url: string; body: { filename: string; content_base64: string }; authorization: string }> = [];
    const pipeline = (sha256: string, status = 200) => (async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init!.body)), authorization: (init!.headers as Record<string, string>).authorization! });
      return new Response(JSON.stringify({ document_sha256: sha256 }), { status });
    }) as typeof fetch;
    const env = { EVIDENCE_PIPELINE_URL: "http://pipeline/", EVIDENCE_PIPELINE_TOKEN: "token-token-token-token" };
    await sandboxDocumentLoader(env, pipeline(document.sha256))!("case_1", document);
    expect(calls[0]).toMatchObject({ url: "http://pipeline/v1/cases/case_1/documents", authorization: "Bearer token-token-token-token", body: { filename: document.filename } });
    expect(Buffer.from(calls[0]!.body.content_base64, "base64").equals(document.content)).toBe(true);
    await expect(sandboxDocumentLoader(env, pipeline("0".repeat(64)))!("case_1", document)).rejects.toThrow("sandbox.document_hash_mismatch");
    await expect(sandboxDocumentLoader(env, pipeline(document.sha256, 422))!("case_1", document)).rejects.toThrow("sandbox.document_load_failed");
  });

  it("is offered outside production only, and only where the corpus is installed", () => {
    expect(sandboxUnavailableReason({}, root)).toBeNull();
    expect(sandboxUnavailableReason({ SECURITY_PROFILE: "production" }, root)).toMatch(/production/);
    expect(sandboxUnavailableReason({ RELEASE_ENVIRONMENT: "production" }, root)).toMatch(/production/);
    expect(sandboxUnavailableReason({}, "/nonexistent")).toMatch(/test parties/);
  });

  it("describes availability for a draft", async () => {
    const offered = await build({}).app.inject({ method: "GET", url: "/v1/authoring/drafts/draft-1/sandbox" });
    expect(offered.json()).toMatchObject({ available: true, reason: null, revision: 4 });
    expect(offered.json().parties).toHaveLength(9);
    const production = await build({ SECURITY_PROFILE: "production" }).app.inject({ method: "GET", url: "/v1/authoring/drafts/draft-1/sandbox" });
    expect(production.json()).toMatchObject({ available: false, parties: [] });
    const noPolicy = await build({}, { draft: { ...draft, sourceFiles: {} } as AuthoringDraftRecord }).app.inject({ method: "GET", url: "/v1/authoring/drafts/draft-1/sandbox" });
    expect(noPolicy.json()).toMatchObject({ available: false, reason: expect.stringMatching(/policy source/) });
    expect((await build({}, { draft: null }).app.inject({ method: "GET", url: "/v1/authoring/drafts/draft-1/sandbox" })).statusCode).toBe(404);
  });

  it("refuses before compiling or touching a case", async () => {
    const post = (env: NodeJS.ProcessEnv, payload: unknown, overrides = {}) => {
      const built = build(env, overrides);
      return built.app.inject({ method: "POST", url: "/v1/authoring/drafts/draft-1/sandbox-runs", payload: payload as never }).then((response) => ({ response, ...built }));
    };
    const production = await post({ SECURITY_PROFILE: "production" }, { expectedRevision: 4, party: "H01" });
    expect(production.response.statusCode).toBe(403);
    expect(production.response.json().error).toBe("sandbox.not_available");
    const stale = await post({}, { expectedRevision: 3, party: "H01" });
    expect(stale.response.statusCode).toBe(409);
    const unknown = await post({}, { expectedRevision: 4, party: "H99" });
    expect(unknown.response.statusCode).toBe(404);
    const malformed = await post({}, { expectedRevision: 4, party: "../H01" });
    expect(malformed.response.statusCode).toBe(400);
    const workload = await post({}, { expectedRevision: 4, party: "H01" }, { principal: { ...author, actorType: "workload" } as Principal });
    expect(workload.response.statusCode).toBe(403);
    for (const attempt of [production, stale, unknown, malformed, workload]) {
      expect(attempt.compile).not.toHaveBeenCalled();
      expect(attempt.caseService).not.toHaveBeenCalled();
    }
    // Both the evaluate and the compile privilege are checked.
    expect(stale.authorize.mock.calls.map((call) => (call as unknown[])[1])).toEqual(["draft.evaluate", "draft.compile"]);
  });

  it("refuses a party the plan's policy packs do not cover, before any write", async () => {
    // H04 is a business; the individual-onboarding plan pins personal-banking packs only.
    const built = build({});
    const response = await built.app.inject({ method: "POST", url: "/v1/authoring/drafts/draft-1/sandbox-runs", payload: { expectedRevision: 4, party: "H04" } });
    expect(response.statusCode).toBe(422);
    expect(response.json().error).toBe("sandbox.party_not_covered");
    expect(built.caseService).not.toHaveBeenCalled();
  });
});
