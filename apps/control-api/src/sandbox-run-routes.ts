import { readSandboxContextResults, sandboxContextResultsQuery } from "./sandbox-context-results.js";
import type { ContextStore } from "@ehf/context-store";
import { readSandboxObservations, sandboxObservationQuery } from "./sandbox-observations.js";
import { randomUUID } from "node:crypto";
import { findSandboxReplay, readSandboxHistory, readSandboxPolicy, recordSandboxLaunch } from "./sandbox-history.js";
import { sandboxReleasesAllowed } from "@ehf/persistence";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { HarnessPlanV2 } from "@ehf/contracts";
import { seedParty } from "@ehf/context-corpus";
import type { PlatformAction, Principal, ResourceRef } from "@ehf/identity";
import { getAuthoringDraft, type AuthoringDraftRecord, type Database } from "@ehf/persistence";
import { listSandboxParties, sandboxCorpusRoot, sandboxDocumentLoader, sandboxUnavailableReason, startSandboxRun } from "./sandbox-run.js";

type CaseService = (tenantId: string, path: string, init?: { method?: string; body?: unknown; headers?: Record<string, string> }) => Promise<unknown>;
type Deps = {
  db: Database; env: NodeJS.ProcessEnv; opaVersion: string;
  authorize(request: FastifyRequest, action: PlatformAction, resource: ResourceRef): Promise<Principal>;
  /** The saved revision compiled in memory, as a draft test compiles it: the lifecycle does not advance. */
  compile(draft: AuthoringDraftRecord, tenantId: string): Promise<HarnessPlanV2>;
  caseService: CaseService;
  contextStore?: () => ContextStore | null;
  loadDraft?: typeof getAuthoringDraft;
  /** The party's source documents into the evidence pipeline; default: from the environment, when configured. */
  loadDocument?: NonNullable<Parameters<typeof startSandboxRun>[0]["loadDocument"]>;
};

const requestSchema = z.object({ expectedRevision: z.number().int().min(0), party: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/) }).strict();

/** The draft's one policy source, as its package names it. */
function policyFiles(draft: AuthoringDraftRecord): Record<string, string> | null {
  const policies = (draft.parsedPackage as { policies?: Array<{ source?: unknown }> }).policies ?? [];
  const path = policies.length === 1 && typeof policies[0]!.source === "string" ? policies[0]!.source : null;
  const source = path ? draft.sourceFiles?.[path] : undefined;
  return source ? { "policy.yaml": source } : null;
}

/**
 * Sandbox runs of a draft (docs/implementation/draft-testing.md): the saved revision on the real
 * runtime, on a fresh copy of a synthetic test party. Offered outside production only.
 */
export function registerSandboxRunRoutes(app: FastifyInstance, deps: Deps) {
  const { db, env } = deps;
  const root = sandboxCorpusRoot(env);
  const loadDocument = deps.loadDocument ?? sandboxDocumentLoader(env);
  const load = async (request: FastifyRequest, action: PlatformAction) => {
    const { draftId } = request.params as { draftId: string };
    const principal = await deps.authorize(request, action, { kind: "draft", id: draftId });
    return { principal, draft: await (deps.loadDraft ?? getAuthoringDraft)(db, draftId, principal.tenantId) };
  };

  const environment = env.RELEASE_ENVIRONMENT ?? "development";
  app.get("/v1/authoring/sandbox-runs", async (request, reply) => {
    const principal = await deps.authorize(request, "run.read", { kind: "tenant" });
    if (!sandboxReleasesAllowed(environment, env)) return reply.code(403).send({ error: "sandbox.not_available" });
    return { items: await readSandboxHistory(db, { tenantId: principal.tenantId, environment }) };
  });

  app.get<{ Params: { runId: string } }>("/v1/authoring/sandbox-runs/:runId", async (request, reply) => {
    const principal = await deps.authorize(request, "run.read", { kind: "run", id: request.params.runId });
    if (!sandboxReleasesAllowed(environment, env)) return reply.code(403).send({ error: "sandbox.not_available" });
    const [run] = await readSandboxHistory(db, { tenantId: principal.tenantId, environment }, request.params.runId);
    return run ?? reply.code(404).send({ error: "sandbox.run_not_found" });
  });

  app.get<{ Params: { runId: string } }>("/v1/authoring/sandbox-runs/:runId/policy", async (request, reply) => {
    const { runId } = request.params;
    const principal = await deps.authorize(request, "run.read", { kind: "run", id: runId });
    if (!sandboxReleasesAllowed(environment, env)) return reply.code(403).send({ error: "sandbox.not_available" });
    const scope = { tenantId: principal.tenantId, environment };
    const [run] = await readSandboxHistory(db, scope, runId);
    if (!run) return reply.code(404).send({ error: "sandbox.run_not_found" });
    await deps.authorize(request, "case.read", { kind: "case", id: run.caseId });
    return { decisions: await readSandboxPolicy(db, scope, run) };
  });

  app.get<{ Params: { runId: string } }>("/v1/authoring/sandbox-runs/:runId/observations", async (request, reply) => {
    const { runId } = request.params;
    const principal = await deps.authorize(request, "run.read", { kind: "run", id: runId });
    if (!sandboxReleasesAllowed(environment, env)) return reply.code(403).send({ error: "sandbox.not_available" });
    const query = sandboxObservationQuery.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: "sandbox.observation_filter_invalid" });
    const [run] = await readSandboxHistory(db, { tenantId: principal.tenantId, environment }, runId);
    if (!run) return reply.code(404).send({ error: "sandbox.run_not_found" });
    await deps.authorize(request, "case.read", { kind: "case", id: run.caseId });
    await deps.authorize(request, "evidence.read", { kind: "case", id: run.caseId });
    reply.header("cache-control", "private, no-store");
    return readSandboxObservations(db, principal.tenantId, principal.subjectId, runId, query.data);
  });

  app.get<{ Params: { runId: string } }>("/v1/authoring/sandbox-runs/:runId/context-results", async (request, reply) => {
    const { runId } = request.params;
    const principal = await deps.authorize(request, "run.read", { kind: "run", id: runId });
    if (!sandboxReleasesAllowed(environment, env)) return reply.code(403).send({ error: "sandbox.not_available" });
    const query = sandboxContextResultsQuery.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: "sandbox.context_filter_invalid" });
    const [run] = await readSandboxHistory(db, { tenantId: principal.tenantId, environment }, runId);
    if (!run) return reply.code(404).send({ error: "sandbox.run_not_found" });
    await deps.authorize(request, "case.read", { kind: "case", id: run.caseId });
    await deps.authorize(request, "evidence.read", { kind: "case", id: run.caseId });
    reply.header("cache-control", "private, no-store");
    return readSandboxContextResults(db, deps.contextStore?.() ?? null, {
      ...query.data, runId, caseId: run.caseId, tenantId: principal.tenantId, actor: principal.subjectId,
    });
  });

  app.get("/v1/authoring/drafts/:draftId/sandbox", async (request, reply) => {
    const { draft } = await load(request, "draft.read");
    if (!draft) return reply.code(404).send({ error: "authoring.draft_not_found" });
    const reason = sandboxUnavailableReason(env, root) ?? (policyFiles(draft) ? null : "This draft does not carry exactly one policy source.");
    return { available: reason === null, reason, revision: draft.revision, parties: reason === null ? listSandboxParties(root) : [] };
  });

  app.post("/v1/authoring/drafts/:draftId/sandbox-runs", async (request, reply) => {
    const { draft, principal } = await load(request, "draft.evaluate");
    if (!draft) return reply.code(404).send({ error: "authoring.draft_not_found" });
    // As for a draft test: the user must also hold the compile privilege.
    await deps.authorize(request, "draft.compile", { kind: "draft", id: draft.draftId });
    if (principal.actorType !== "human") return reply.code(403).send({ error: "authorization.interactive_user_required" });
    const unavailable = sandboxUnavailableReason(env, root);
    if (unavailable) return reply.code(403).send({ error: "sandbox.not_available", message: unavailable });
    const parsed = requestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "sandbox.request_invalid", issues: parsed.error.issues });
    const key = request.headers["idempotency-key"];
    if (key !== undefined && (typeof key !== "string" || key.length < 8 || key.length > 200)) {
      return reply.code(400).send({ error: "sandbox.idempotency_key_invalid" });
    }
    const launch = { tenantId: principal.tenantId, environment, draftId: draft.draftId, key: key ?? randomUUID(),
      actor: principal.subjectId, revision: parsed.data.expectedRevision, party: parsed.data.party };
    try {
      const replay = key ? await findSandboxReplay(db, launch) : null;
      if (replay) return { ...replay, draftId: launch.draftId, revision: launch.revision };
      if (launch.revision !== draft.revision) return reply.code(409).send({ error: "authoring.revision_conflict" });
      if (!listSandboxParties(root).some((party) => party.id === launch.party)) return reply.code(404).send({ error: "sandbox.party_unknown" });
      const files = policyFiles(draft);
      if (!files) return reply.code(422).send({ error: "sandbox.policy_source_missing" });
      const plan = await deps.compile(draft, principal.tenantId);
      // The case service is reached with this service's own identity, acting for the author.
      const viaCaseService: typeof fetch = async (target, init) => {
        const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)
          .filter(([name]) => name !== "authorization" && name !== "content-type"));
        try {
          const body = await deps.caseService(principal.tenantId, new URL(String(target)).pathname, {
            method: init?.method ?? "GET", headers, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
          return new Response(JSON.stringify(body), { status: 200 });
        } catch (error) {
          return new Response(JSON.stringify({ error: error instanceof Error ? error.message : "sandbox.case_service_failed" }), { status: 409 });
        }
      };
      const result = await startSandboxRun({
        db, env, tenantId: principal.tenantId, actor: principal.subjectId, plan, policyFiles: files, party: parsed.data.party,
        recordLaunch: (planDigest, execute) => recordSandboxLaunch(db, launch, planDigest, execute),
        corpusRoot: root, opaVersion: deps.opaVersion, ...(loadDocument ? { loadDocument } : {}),
        seed: (dossier, pins) => seedParty(dossier, { ...pins, baseUrl: "http://case-service.internal", token: "unused",
          actor: { type: "HUMAN", principalId: principal.subjectId, roles: [] }, fetch: viaCaseService }),
      });
      return { ...result, draftId: draft.draftId, revision: draft.revision };
    } catch (error) {
      const message = error instanceof Error ? error.message : "sandbox.run_failed";
      request.log.warn({ err: error }, "sandbox run refused");
      if (["sandbox.idempotency_conflict", "sandbox.launch_in_progress"].includes(message)) {
        return reply.code(409).send({ error: message });
      }
      return reply.code(message.startsWith("sandbox.not_available") || message.startsWith("release.sandbox_not_allowed") ? 403 : 422)
        .send({ error: message.split(":")[0], message });
    }
  });
}
