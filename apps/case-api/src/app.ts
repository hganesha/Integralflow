import { caseReconStatus, requestCaseRecon } from "@ehf/case-store/recon-jobs";
import { reconModeSchema } from "@ehf/contracts";
import { actionsForRoles } from "@ehf/identity";
import { createDiscoveryDatabase, liveDiscoveryEnabled, readLatestDiscoveryBrief, syntheticDiscoveryEnabled } from "@ehf/case-store/discovery";
import { checkDependency, notConfigured } from "@ehf/contracts/platform-health";
import { registerCaseTraversal } from "./case-traversal.js";
import { registerDocumentSearch } from "./document-search.js";
import type { ContextStore } from "@ehf/context-store";
import { registerCaseContextPreview } from "./context-preview.js";
import { z } from "zod";
import { createHash } from "node:crypto";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { evaluateStoredCaseGate } from "./policy-evaluator.js";
import type { GateEvaluationRequest } from "@ehf/runtime-core";
import { summarizeDiligenceDecisions } from "@ehf/policy-engine/diligence";
import {
  recordPolicySnapshotRead,
  getStoredBusinessDecision,
  listBusinessDecisionReceipts,
  recordBusinessHumanResponse,
  CaseStoreError,
  documentRunScope,
  contextPullRunScope,
  getCaseSequence,
  scopeContextPullSnapshot,
  scopeDocumentSnapshot,
  assertActiveCaseExecution,
  getContextReleaseEligibility,
  recordContextReleased,
  getLegalHold,
  listLegalHolds,
  placeLegalHold,
  releaseLegalHold,
  assertSkillCommitWithinEnvelope,
  commitSkillExecution,
  listSkillEffects,
  releaseSkillEffects,
  createCaseStore,
  createAuditExport,
  getAuditExport,
  renderAuditExport,
  createKycCase,
  caseStanding,
  getCaseAssignment,
  listCaseAssignments,
  listCaseTeams,
  upsertCaseTeam,
  getCanonicalCaseSnapshot,
  getCaseSnapshot,
  getCaseView,
  projectCanonicalCaseSnapshot,
  getEvidence,
  getEvidenceContent,
  findEvidenceRegistration,
  listCaseEventsPage,
  listCasesPage,
  registerEvidence,
  submitBusinessCommand,
  verifyCaseLedger,
  type CaseStore,
} from "@ehf/case-store";
import {
  businessCommandSchema,
  createKycCaseRequestSchema,
  documentUploadSchema,
  kycCaseStatusSchema,
  registerEvidenceRequestSchema,
  skillCommitRequestSchema,
  skillEffectReleaseRequestSchema,
} from "@ehf/contracts";
import {
  AuthorizationError,
  createGuard,
  createWorkloadResolverFromEnv,
  createWorkloadAuthorization,
  DelegatedPrincipalResolver,
  envelopeVerifier,
  serviceGrants,
  type AuthorizationDecision,
  type PlatformAction,
  type Principal,
  type ServiceTokenGrant,
} from "@ehf/identity";
import { extractTraceContext, SpanKind, withSpan } from "@ehf/telemetry";
import {
  verifiedActor,
  requireHuman,
  assertCaseCreationWithinIntegrationEnvelope,
  assertCommandWithinEnvelope,
  assertCommandWithinIntegrationEnvelope,
  assertSnapshotWithinEnvelope,
  isWorkload,
  verifyCaseReadAuthority,
  verifyCaseWriteAuthority,
  verifyIntegrationWriteAuthority,
} from "./execution-authority.js";

/** The services that call the case API, one identity each, and what each may do here. */
function serviceGrantsFromEnv(env: NodeJS.ProcessEnv): ServiceTokenGrant[] {
  return serviceGrants([
    { subjectId: "control-surface-edge", roles: ["Edge.Delegate"], tokenEnv: "EDGE_SERVICE_TOKEN" },
    { subjectId: "capability-gateway", roles: ["Case.Api.Access"], tokenEnv: "GATEWAY_CASE_SERVICE_TOKEN" },
    { subjectId: "harness-runtime", roles: ["Case.Api.Access"], tokenEnv: "RUNTIME_SERVICE_TOKEN" },
    { subjectId: "integration-worker", roles: ["Integration.Dispatch"], tokenEnv: "INTEGRATION_SERVICE_TOKEN" },
    // The control API acting for a person it has authenticated (human-work case actions).
    // In its own name it may also move a case onto the plan its policy escalated it to (case.replan).
    { subjectId: "control-api", roles: ["Edge.Delegate", "Case.Replan"], tokenEnv: "CONTROL_API_SERVICE_TOKEN" },
    // The context release job: reads a closed case's release eligibility and records the release.
    { subjectId: "context-release", roles: ["Context.Release"], tokenEnv: "CONTEXT_RELEASE_SERVICE_TOKEN" },
  ], env);
}

function requestedTenant(request: FastifyRequest): string | undefined {
  const value = request.headers["x-tenant-id"];
  const single = Array.isArray(value) ? value[0] : value;
  return single?.trim() || undefined;
}

function requestParent(request: FastifyRequest) {
  const carrier = Object.fromEntries(Object.entries(request.headers).map(([key, value]) => [key, value]));
  return extractTraceContext(carrier);
}

async function traced<T>(request: FastifyRequest, operation: string, attributes: Record<string, string | number>, fn: () => Promise<T>) {
  return withSpan(operation, {
    kind: SpanKind.SERVER,
    attributes: {
      "http.request.method": request.method,
      "url.path": request.url.split("?")[0] ?? request.url,
      "case.operation": operation,
      ...attributes,
    },
  }, async (span) => {
    const result = await fn();
    span.setAttribute("case.outcome", "OK");
    return result;
  }, requestParent(request));
}

export type CaseApiOptions = {
  contextStore?: ContextStore | null;
  discoveryDb?: CaseStore["db"];
  store?: CaseStore;
  serviceGrants?: ServiceTokenGrant[];
  /** The case API's outgoing service credential; defaults to its configured workload credential. */
  outboundAuthorization?: () => Promise<string>;
  env?: NodeJS.ProcessEnv;
  executionSecret?: string;
  integrationSecret?: string;
  /** A person's standing on a case; defaults to the case store's assignment records. */
  caseStanding?: (tenantId: string, caseId: string, subjectId: string) => Promise<"assigned" | "team" | "unassigned" | "none">;
};

export function buildCaseApi(options: CaseApiOptions = {}) {
  const app = Fastify({ logger: true });
  // Per-replica admission bound. Do not trust caller-supplied forwarding headers.
  void app.register(rateLimit, { global: false, max: 1000, timeWindow: 60_000, skipOnError: false });
  app.after((error) => {
    if (error) throw error;
    // Install one shared limiter after the plugin boots, including routes that
    // these synchronous builders have already registered.
    app.addHook("onRequest", app.rateLimit());
  });
  const env = options.env ?? process.env;
  const store = options.store ?? createCaseStore();
  const workloadResolver = createWorkloadResolverFromEnv(options.serviceGrants ?? serviceGrantsFromEnv(env), env);
  const executionSecret = options.executionSecret ?? (envelopeVerifier(env) === "public_key"
    ? env.EXECUTION_ENVELOPE_PUBLIC_KEY_PEM
    : env.EXECUTION_ENVELOPE_SECRET) ?? "";
  const integrationSecret = options.integrationSecret ?? (envelopeVerifier(env) === "public_key"
    ? env.INTEGRATION_ENVELOPE_PUBLIC_KEY_PEM
    : env.INTEGRATION_ENVELOPE_SECRET) ?? "";
  const recordDecision = (decision: AuthorizationDecision) => app.log.info({ authorization: decision }, "authorization decision");
  const humanGuard = createGuard({ resolver: new DelegatedPrincipalResolver(workloadResolver), onDecision: recordDecision });
  const workloadGuard = createGuard({ resolver: workloadResolver, onDecision: recordDecision });
  // The case API's own identity for the calls it makes to the control plane.
  const outboundAuthorization = options.outboundAuthorization ?? createWorkloadAuthorization({ staticTokenEnv: "CASE_API_SERVICE_TOKEN" }, env);

  /**
   * An integration command carries no policy digest of its own: the integration worker
   * cannot know which policy snapshot the case is pinned to without asking for it first.
   * The case API already holds the case, so it fills the digest in once the integration
   * envelope proves the caller may write to exactly this case under exactly this plan --
   * one call where there used to be a read followed by a write. Everything else about the
   * command is still checked against the envelope by the normal path.
   */
  async function fillIntegrationPolicyDigest(request: FastifyRequest<{ Params: { caseId: string } }>): Promise<void> {
    const body = request.body as { authority?: Record<string, unknown>; tenantId?: unknown } | undefined;
    if (!body?.authority || body.authority.policySnapshotDigest !== undefined || !request.headers["x-integration-envelope"]) return;
    const claims = await verifyIntegrationWriteAuthority(request, integrationSecret);
    if (claims.intent !== "submit_case_command" || claims.case_id !== request.params.caseId || claims.tenant_id !== body.tenantId) {
      throw new CaseStoreError("authorization.integration_case_mismatch", 403);
    }
    const result = await getCaseView(store, claims.tenant_id, request.params.caseId);
    if (!result) throw new CaseStoreError("case.not_found", 404);
    if (result.case.harnessPlanDigest !== claims.plan_digest) throw new CaseStoreError("authorization.integration_plan_mismatch", 403);
    body.authority.policySnapshotDigest = result.case.policySnapshotDigest;
  }

  /**
   * Authorize a case operation and return the principal whose tenant it runs in.
   *
   * Tenancy is taken from the authenticated identity. `x-tenant-id` used to be the only
   * thing standing between a caller and any tenant's cases; it is now at most a
   * requested scope that has to match the assignment the identity already carries.
   */
  const authorize = async (request: FastifyRequest, action: PlatformAction, resource: { kind: string; id?: string }): Promise<Principal> => {
    const delegated = request.headers["x-actor-id"] !== undefined;
    const guard = delegated ? humanGuard : workloadGuard;
    const scope = requestedTenant(request);
    return guard.require(request, action, scope ? { ...resource, tenantId: scope } : resource);
  };

  registerCaseTraversal(app, { store, env, authorize });
  /**
   * Standing on a case, for people only (case-access-model.md): assigned to it, in its team, or
   * the case has no assignment yet. Agents and services act under their own envelopes.
   */
  const requireStanding = async (principal: Principal, caseId: string): Promise<void> => {
    if (isWorkload(principal)) return;
    const standing = options.caseStanding
      ? await options.caseStanding(principal.tenantId, caseId, principal.subjectId)
      : await caseStanding(store, principal.tenantId, caseId, principal.subjectId);
    if (standing === "none") {
      throw new CaseStoreError("authorization.case_standing_missing", 403);
    }
  };

  app.setErrorHandler((error: unknown, _request, reply) => {
    if (error instanceof Error && "statusCode" in error && error.statusCode === 429) {
      return reply.code(429).send({ error: "request.rate_limit_exceeded" });
    }
    if (error instanceof AuthorizationError) {
      return reply.code(error.httpStatus).send({ error: error.decision.reasonCode });
    }
    if (error instanceof CaseStoreError) {
      return reply.code(error.httpStatus).send({ error: error.code, ...error.details });
    }
    app.log.error(error);
    return reply.code(500).send({ error: "case_store.internal_error" });
  });

  registerDocumentSearch(app, { store, contextStore: options.contextStore, env, executionSecret, authorize });
  registerCaseContextPreview(app, { store, env, authorize });

  const synthetic = syntheticDiscoveryEnabled(env);
  const hostedSynthetic = synthetic && /^[a-f0-9]{64}$/.test(env.DISCOVERY_HOSTED_PLAN_DIGEST ?? "");
  const liveTenantId = env.DISCOVERY_TENANT_ID;
  const searchProvider = env.DISCOVERY_WEB_SEARCH_PROVIDER ?? "openrouter";
  const configuredSearchProviders = env.DISCOVERY_WEB_SEARCH_CONFIGURED_PROVIDERS?.split(",");
  const liveEnabled = Boolean(liveTenantId && (options.discoveryDb || env.DISCOVERY_DATABASE_URL))
    && liveDiscoveryEnabled(env) && (configuredSearchProviders?.includes(searchProvider) ?? true);
  if (synthetic || liveEnabled) {
    let discovery = options.discoveryDb;
    if (!discovery && env.DISCOVERY_DATABASE_URL) {
      try {
        discovery = createDiscoveryDatabase(env);
      } catch {
        app.log.warn("Discovery database configuration is invalid");
      }
    }
    const discoveryPool = discovery;
    if (discoveryPool && !options.discoveryDb) app.addHook("onClose", async () => { await discoveryPool.end(); });
    if (synthetic) app.get<{ Params: { caseId: string } }>("/v1/cases/:caseId/discovery", async (request, reply) => {
      const { caseId } = request.params;
      const principal = await authorize(request, "discovery.read", { kind: "case", id: caseId });
      requireHuman(principal);
      if (!discovery) throw new CaseStoreError("discovery.database_unavailable", 503);
      const brief = await readLatestDiscoveryBrief(store, discovery, principal.tenantId, caseId, principal.subjectId);
      return reply.header("cache-control", "private, no-store").send({ brief });
    });

    if (hostedSynthetic || liveEnabled) {
      type ReconRoute = { Params: { caseId: string }; Querystring: { mode?: unknown } };
      const handleRecon = async (request: FastifyRequest<ReconRoute>, reply: FastifyReply) => {
        const { caseId } = request.params;
        const principal = await authorize(request, request.method === "POST" ? "discovery.request" : "discovery.read", { kind: "case", id: caseId });
        requireHuman(principal);
        const standing = options.caseStanding
          ? await options.caseStanding(principal.tenantId, caseId, principal.subjectId)
          : await caseStanding(store, principal.tenantId, caseId, principal.subjectId);
        if (standing !== "assigned" && standing !== "team") {
          throw new CaseStoreError("authorization.discovery_standing_missing", 403);
        }
        if (!discoveryPool) throw new CaseStoreError("discovery.database_unavailable", 503);
        const scope = { tenantId: principal.tenantId, caseId, subjectId: principal.subjectId };
        const canRequest = actionsForRoles(principal.roles).has("discovery.request");
        const liveAvailable = liveEnabled && principal.tenantId === liveTenantId;
        reply.header("cache-control", "private, no-store");
        if (request.method === "POST") {
          const mode = reconModeSchema.safeParse(request.query.mode ?? "synthetic");
          if (!mode.success) throw new CaseStoreError("discovery.invalid_mode", 400);
          if (mode.data === "live" ? !liveAvailable : !hostedSynthetic) {
            throw new CaseStoreError("discovery.mode_unavailable", 409);
          }
          return requestCaseRecon(store, discoveryPool, scope, mode.data);
        }
        const [syntheticState, liveState] = await Promise.all([
          hostedSynthetic ? caseReconStatus(store, discoveryPool, scope, canRequest) : null,
          liveAvailable ? caseReconStatus(store, discoveryPool, scope, canRequest, "live") : null,
        ]);
        return {
          ...(syntheticState ?? { status: "unavailable", canRequest: false, brief: null }),
          ...(liveState && liveState.status !== "unavailable" ? { live: liveState } : {}),
        };
      };
      app.get<ReconRoute>("/v1/cases/:caseId/recon", handleRecon);
      app.post<ReconRoute>("/v1/cases/:caseId/recon", handleRecon);
    }
  }

  app.get("/health/live", async () => ({ status: "ok" }));
  app.get("/health/ready", async () => {
    await store.db.query("select 1");
    return {
      status: "ready",
      schemas: store.schemas,
      artifactBackend: store.artifactBackend,
      evidencePolicy: { requireScan: store.evidenceRequireScan, maxBytes: store.evidenceMaxBytes },
    };
  });

  // Live checks of what only the case service reaches (the Health screen).
  app.get("/v1/platform/dependencies", async (request) => {
    await authorize(request, "capability.read", { kind: "platform-health" });
    const evidence = { id: "evidence-store", name: "Evidence store (object storage)", group: "store" as const };
    return { components: await Promise.all([
      checkDependency({ id: "case-store", name: "Case store (PostgreSQL)", group: "store" }, async () => { await store.db.query("select 1"); }),
      // Reading the properties of an absent object reaches the bucket and proves the credential, and writes nothing.
      store.evidenceBlobs
        ? checkDependency(evidence, async () => { await store.evidenceBlobs!.head(".platform-health"); return { status: "Ready", detail: `Reachable; immutability ${store.evidenceBlobs!.immutability === "object_lock" ? "enforced" : "not enforced"}.` }; })
        : Promise.resolve(notConfigured(evidence, "Evidence is kept in the case database.")),
    ]) };
  });

  app.post("/v1/cases", async (request, reply) => traced(request, "case.create", {}, async () => {
    const principal = await authorize(request, "case.write", { kind: "case" });
    const parsed = createKycCaseRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "case.request_invalid", issues: parsed.error.issues });
    if (parsed.data.tenantId !== principal.tenantId) return reply.code(403).send({ error: "authorization.tenant_mismatch" });
    if (isWorkload(principal)) {
      if (principal.roles.includes("Integration.Dispatch")) assertCaseCreationWithinIntegrationEnvelope(parsed.data, await verifyIntegrationWriteAuthority(request, integrationSecret));
      else throw new CaseStoreError("authorization.runtime_case_creation_forbidden", 403);
    } else if (parsed.data.actor.type === "INTEGRATION" || parsed.data.actor.type === "AGENT") {
      return reply.code(403).send({ error: "authorization.workload_actor_requires_envelope" });
    }
    parsed.data.actor = verifiedActor(principal, parsed.data.actor);
    const key = String(request.headers["idempotency-key"] ?? "");
    const result = await createKycCase(store, parsed.data, key);
    return reply.code(result.created ? 201 : 200).send(result);
  }));

  app.get<{ Querystring: { status?: string; planDigest?: string; limit?: string; cursor?: string } }>("/v1/cases", async (request, reply) => traced(request, "case.list", {}, async () => {
    const principal = await authorize(request, "case.read", { kind: "case" });
    requireHuman(principal);
    const tenant = principal.tenantId;
    const status = request.query.status ? kycCaseStatusSchema.safeParse(request.query.status) : null;
    if (status && !status.success) return reply.code(400).send({ error: "case.status_invalid" });
    if (request.query.planDigest && !/^[a-f0-9]{64}$/i.test(request.query.planDigest)) {
      return reply.code(400).send({ error: "case.plan_digest_invalid" });
    }
    const page = await listCasesPage(store, {
        tenantId: tenant,
        ...(status?.success ? { status: status.data } : {}),
        ...(request.query.planDigest ? { harnessPlanDigest: request.query.planDigest } : {}),
        ...(request.query.limit ? { limit: Number(request.query.limit) } : {}),
        ...(request.query.cursor ? { cursor: request.query.cursor } : {}),
    });
    return { cases: page.items, nextCursor: page.nextCursor };
  }));

  app.get<{ Params: { caseId: string } }>("/v2/cases/:caseId/sequence", async (request, reply) => {
    reply.header("cache-control", "no-store");
    const principal = await authorize(request, "case.write", { kind: "case", id: request.params.caseId });
    const claims = await verifyCaseWriteAuthority(request, executionSecret);
    if (!isWorkload(principal) || !claims.case_writes.length) throw new CaseStoreError("authorization.command_not_declared", 403);
    await assertActiveCaseExecution(store.executionDb ?? store.db, claims, principal.tenantId, request.params.caseId);
    const caseSequence = await getCaseSequence(store, principal.tenantId, request.params.caseId);
    return caseSequence === null ? reply.code(404).send({ error: "case.not_found" }) : { caseSequence };
  });

  app.get<{ Params: { caseId: string } }>("/v1/cases/:caseId", async (request, reply) => traced(request, "case.read", {
    "case.id": request.params.caseId,
  }, async () => {
    const principal = await authorize(request, "case.read", { kind: "case", id: request.params.caseId });
    requireHuman(principal);
    const result = await getCaseView(store, principal.tenantId, request.params.caseId);
    if (!result) return reply.code(404).send({ error: "case.not_found" });
    reply.header("etag", result.etag);
    return result;
  }));

  // What the control plane needs to move a case onto the process its policy escalated it to, and
  // nothing else (no subjects, records or evidence): the pin, status, jurisdiction, sequence and the
  // open work items' identity. Only the re-planning authority reads it.
  app.get<{ Params: { caseId: string } }>("/v1/cases/:caseId/replan-context", async (request, reply) => traced(request, "case.replan_context.read", {
    "case.id": request.params.caseId,
  }, async () => {
    const principal = await authorize(request, "case.replan", { kind: "case", id: request.params.caseId });
    if (!isWorkload(principal)) return reply.code(403).send({ error: "authorization.replan_workload_required" });
    const result = await getCaseView(store, principal.tenantId, request.params.caseId);
    if (!result) return reply.code(404).send({ error: "case.not_found" });
    const kase = result.case as Record<string, unknown>;
    return {
      case: { caseId: kase.caseId, status: kase.status, jurisdiction: kase.jurisdiction, caseSequence: kase.caseSequence,
        harnessPlanDigest: kase.harnessPlanDigest, policySnapshotDigest: kase.policySnapshotDigest },
      workItems: (result.workItems as Array<Record<string, unknown>>).map((item) => ({ work_item_id: item.work_item_id, work_type: item.work_type, status: item.status })),
    };
  }));

  app.post<{ Params: { caseId: string } }>("/v1/cases/:caseId/exports", async (request) => {
    const principal = await authorize(request, "case.read", { kind: "case", id: request.params.caseId });
    requireHuman(principal);
    await authorize(request, "evidence.read", { kind: "case", id: request.params.caseId });
    const result = await createAuditExport(store, principal.tenantId, request.params.caseId);
    return { digest: result.digest, caseSequence: result.document.caseSequence, formats: ["json", "html", "pdf"] };
  });
  app.get<{ Params: { caseId: string; digest: string; format: string } }>("/v1/cases/:caseId/exports/:digest/:format", async (request, reply) => {
    const principal = await authorize(request, "case.read", { kind: "case", id: request.params.caseId });
    requireHuman(principal);
    await authorize(request, "evidence.read", { kind: "case", id: request.params.caseId });
    const format = request.params.format;
    if (format !== "json" && format !== "html" && format !== "pdf") return reply.code(400).send({ error: "audit.format_invalid" });
    const document = await getAuditExport(store, principal.tenantId, request.params.caseId, request.params.digest);
    const content = await renderAuditExport(document, format);
    return reply.header("content-type", { json: "application/json", html: "text/html; charset=utf-8", pdf: "application/pdf" }[format])
      .header("content-disposition", `attachment; filename="audit-${request.params.digest}.${format}"`)
      .header("cache-control", "private, no-store").header("x-content-type-options", "nosniff")
      .header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox")
      .send(content);
  });

  app.get<{ Params: { caseId: string } }>("/v1/cases/:caseId/snapshot", async (request, reply) => traced(request, "case.snapshot.read", {
    "case.id": request.params.caseId,
  }, async () => {
    const principal = await authorize(request, "case.read", { kind: "case", id: request.params.caseId });
    requireHuman(principal);
    const purpose = String(request.headers["x-purpose"] ?? "").trim();
    if (!purpose) return reply.code(400).send({ error: "case.snapshot_purpose_required" });
    const result = await getCaseSnapshot(store, principal.tenantId, request.params.caseId, purpose);
    if (!result) return reply.code(404).send({ error: "case.not_found" });
    reply.header("etag", `\"${result.snapshotDigest}\"`);
    return result;
  }));

  app.get<{ Params: { caseId: string } }>("/v2/cases/:caseId/snapshot", async (request, reply) => traced(request, "case.snapshot.v2.read", {
    "case.id": request.params.caseId,
  }, async () => {
    const principal = await authorize(request, "case.read", { kind: "case", id: request.params.caseId });
    const requestedPurpose = String(request.headers["x-purpose"] ?? "").trim();
    let purpose = requestedPurpose;
    let claims: Awaited<ReturnType<typeof verifyCaseReadAuthority>> | undefined;
    if (isWorkload(principal)) {
      claims = await verifyCaseReadAuthority(request, executionSecret);
      await assertActiveCaseExecution(store.executionDb ?? store.db, claims, principal.tenantId, request.params.caseId);
      const purposes = [...new Set(claims.case_reads.map((selector) => selector.purpose))];
      if (purposes.length !== 1 || !purposes[0]) return reply.code(403).send({ error: "authorization.context_purpose_ambiguous" });
      if (requestedPurpose && requestedPurpose !== purposes[0]) return reply.code(403).send({ error: "authorization.context_purpose_mismatch" });
      purpose = purposes[0];
    }
    if (!purpose) return reply.code(400).send({ error: "case.snapshot_purpose_required" });
    let result = await getCanonicalCaseSnapshot(store, principal.tenantId, request.params.caseId, purpose);
    if (!result) return reply.code(404).send({ error: "case.not_found" });
    if (claims && result.planDigest !== claims.plan_digest) {
      const pull = await contextPullRunScope(store, claims);
      result = pull ? scopeContextPullSnapshot(result, pull) : scopeDocumentSnapshot(result, await documentRunScope(store, claims));
    }
    const readAuthority = claims ? assertSnapshotWithinEnvelope(result, requestedPurpose || undefined, claims) : undefined;
    let response = readAuthority
      ? projectCanonicalCaseSnapshot(result, readAuthority.selectors, readAuthority.policies)
      : result;
    if (claims) response=await recordPolicySnapshotRead(store,response,claims.node_id,purpose);
    reply.header("etag", `"${response.snapshotDigest}"`);
    return response;
  }));

  app.get<{ Params: { caseId: string; decisionId: string } }>("/v2/cases/:caseId/business-decisions/:decisionId", async (request, reply) => {
    const principal = await authorize(request, "case.read", { kind: "case", id: request.params.caseId });
    if (isWorkload(principal)) return reply.code(403).send({ error: "policy.interactive_read_required" });
    return await getStoredBusinessDecision(store, principal.tenantId, request.params.caseId, request.params.decisionId)
      ?? reply.code(404).send({ error: "policy.decision_not_found" });
  });
  app.post<{ Params: { caseId: string; decisionId: string } }>("/v2/cases/:caseId/business-decisions/:decisionId/responses", async (request, reply) => {
    const principal = await authorize(request, "case.write", { kind: "case", id: request.params.caseId });
    if (principal.actorType !== "human") return reply.code(403).send({ error: "policy.authenticated_human_required" });
    try {
      return await recordBusinessHumanResponse(store, { tenantId: principal.tenantId, caseId: request.params.caseId,
        decisionId: request.params.decisionId, actor: { type: "HUMAN", principalId: principal.subjectId, roles: principal.roles }, choice: request.body });
    } catch (error) {
      if (error instanceof CaseStoreError) return reply.code(error.httpStatus).send({ error: error.code });
      if (error instanceof z.ZodError) return reply.code(400).send({ error: "policy.human_response_invalid" });
      throw error;
    }
  });

  /** Policy monitoring: how the tenant's stored diligence decisions came out. Reads receipts only. */
  app.get<{ Querystring: { gateId?: string; since?: string; limit?: string; levels?: string; customerTypes?: string } }>("/v1/policy/monitoring/diligence", async (request, reply) => traced(request, "policy.monitoring.diligence", {}, async () => {
    const principal = await authorize(request, "case.read", { kind: "policy-monitoring" });
    const query = z.object({
      gateId: z.string().min(1).max(200).default("diligence-level"),
      since: z.iso.datetime({ offset: true }).optional(),
      limit: z.coerce.number().int().min(1).max(5000).default(1000),
      levels: z.string().regex(/^[A-Z][A-Z0-9_]{0,31}(,[A-Z][A-Z0-9_]{0,31}){0,9}$/).optional(),
      customerTypes: z.string().regex(/^(individual|corporate)(,(individual|corporate))?$/).optional(),
    }).safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: "policy.monitoring_query_invalid" });
    const { receipts, limited } = await listBusinessDecisionReceipts(store, principal.tenantId,
      { gateId: query.data.gateId, limit: query.data.limit, ...(query.data.since ? { since: query.data.since } : {}),
        ...(query.data.customerTypes ? { customerTypes: query.data.customerTypes.split(",") } : {}) });
    const levels = query.data.levels?.split(",") ?? [];
    return { gateId: query.data.gateId, generatedAt: new Date().toISOString(), limited, levels, summary: summarizeDiligenceDecisions(receipts, levels) };
  }));

  app.post<{ Body: GateEvaluationRequest }>("/v2/policy/evaluate", async (request, reply) => {
    const principal = await authorize(request, "case.write", { kind: "case" });
    if (!isWorkload(principal) || !request.body.execution) return reply.code(403).send({ error: "policy.execution_required" });
    let authorization: string;
    try { authorization = await outboundAuthorization(); } catch { return reply.code(503).send({ error: "policy.control_credential_missing" }); }
    const response = await fetch(`${env.CONTROL_API_URL ?? "http://control-api:4100"}/v1/runtime/policy-authority`, {
      method: "POST", headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({ execution: request.body.execution, nodeId: request.body.nodeId }), signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return reply.code(403).send({ error: "policy.execution_authority_denied" });
    try {
      return await evaluateStoredCaseGate({ store, request: request.body, tenantId: principal.tenantId,
        authority: await response.json() as Parameters<typeof evaluateStoredCaseGate>[0]["authority"] });
    } catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : "policy.evaluation_failed" }); }
  });

  app.post<{ Params: { caseId: string } }>("/v1/cases/:caseId/commands", async (request, reply) => traced(request, "case.command", {
    "case.id": request.params.caseId,
  }, async () => {
    await fillIntegrationPolicyDigest(request);
    const parsed = businessCommandSchema.safeParse(request.body);
    const review = parsed.success && ["FinalizeDisposition", "RecordReview"].includes(parsed.data.commandType);
    // Moving a case's plan pin is its own authority, held only by the control plane in its own name.
    const replan = parsed.success && parsed.data.commandType === "ReplanCase";
    // Assigning a case is its own authority (case.assign): a manager who distributes work does not
    // thereby hold case.write, and a case writer cannot reassign a case to themselves.
    const assign = parsed.success && parsed.data.commandType === "AssignCase";
    const principal = await authorize(request, assign ? "case.assign" : review ? "case.review" : replan ? "case.replan" : "case.write", { kind: "case", id: request.params.caseId });
    if (assign && isWorkload(principal)) return reply.code(403).send({ error: "assignment.human_authority_required" });
    if (parsed.success && parsed.data.commandType === "RecordPolicyEvaluation") return reply.code(403).send({ error: "policy.evaluator_endpoint_required" });
    if (!parsed.success) return reply.code(400).send({ error: "command.request_invalid", issues: parsed.error.issues });
    if (parsed.data.caseId !== request.params.caseId) return reply.code(400).send({ error: "command.case_id_mismatch" });
    // The command names its own tenant; that claim only holds inside the caller's.
    if (parsed.data.tenantId !== principal.tenantId) return reply.code(403).send({ error: "authorization.tenant_mismatch" });
    let execution: Awaited<ReturnType<typeof verifyCaseWriteAuthority>> | undefined;
    if (replan && !isWorkload(principal)) return reply.code(403).send({ error: "authorization.replan_workload_required" });
    if (isWorkload(principal) && !replan) {
      if (principal.roles.includes("Integration.Dispatch")) {
        assertCommandWithinIntegrationEnvelope(parsed.data, await verifyIntegrationWriteAuthority(request, integrationSecret));
      } else {
        // An agent writes to a case only with authority the compiled plan granted its node.
        execution = await verifyCaseWriteAuthority(request, executionSecret);
        assertCommandWithinEnvelope(parsed.data, execution);
      }
    }
    parsed.data.actor = verifiedActor(principal, parsed.data.actor, execution);
    // A person acts on a case they are assigned to, or whose team they are in (case-access-model.md
    // step 3). Assigning is the manager's own authority and is not subject to standing.
    if (!assign) await requireStanding(principal, request.params.caseId);
    const result = await submitBusinessCommand(store, parsed.data, execution);
    return reply.code(200).send(result);
  }));

  // A hosted skill's output (skill.execution.v1 §6.2–6.3), committed atomically for one node
  // attempt by the runtime that ran the node, never by the skill host: the node's envelope decides
  // which command types it may write directly (case_writes) or only hold for approval
  // (case_writes_held), and decision, disposition, review and approval commands are refused.
  app.post<{ Params: { caseId: string } }>("/v1/cases/:caseId/skill-commits", async (request, reply) => traced(request, "case.skill.commit", {
    "case.id": request.params.caseId,
  }, async () => {
    const principal = await authorize(request, "case.write", { kind: "case", id: request.params.caseId });
    if (!isWorkload(principal) || principal.roles.includes("Integration.Dispatch")) throw new CaseStoreError("authorization.skill_commit_runtime_required", 403);
    const parsed = skillCommitRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "skill_commit.request_invalid", issues: parsed.error.issues });
    if (parsed.data.caseId !== request.params.caseId) return reply.code(400).send({ error: "command.case_id_mismatch" });
    if (parsed.data.tenantId !== principal.tenantId) return reply.code(403).send({ error: "authorization.tenant_mismatch" });
    const execution = await verifyCaseWriteAuthority(request, executionSecret);
    assertSkillCommitWithinEnvelope(parsed.data, execution);
    return reply.code(200).send(await commitSkillExecution(store, parsed.data, execution));
  }));

  // The release node after a durable approval: commit (or discard) the effects held for one skill
  // execution, after re-validating the binding, the case sequence and the expiry.
  app.post<{ Params: { caseId: string; executionId: string } }>("/v1/cases/:caseId/skill-executions/:executionId/release", async (request, reply) => traced(request, "case.skill.release", {
    "case.id": request.params.caseId,
  }, async () => {
    const principal = await authorize(request, "case.write", { kind: "case", id: request.params.caseId });
    if (!isWorkload(principal) || principal.roles.includes("Integration.Dispatch")) throw new CaseStoreError("authorization.skill_commit_runtime_required", 403);
    const parsed = skillEffectReleaseRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "skill_release.request_invalid", issues: parsed.error.issues });
    if (parsed.data.caseId !== request.params.caseId || parsed.data.executionId !== request.params.executionId) return reply.code(400).send({ error: "skill_release.target_mismatch" });
    if (parsed.data.tenantId !== principal.tenantId) return reply.code(403).send({ error: "authorization.tenant_mismatch" });
    const execution = await verifyCaseWriteAuthority(request, executionSecret);
    const result = await releaseSkillEffects(store, parsed.data, execution);
    return reply.code(result.httpStatus).send(result.body);
  }));

  app.get<{ Params: { caseId: string } }>("/v1/cases/:caseId/skill-effects", async (request) => traced(request, "case.skill.effects.read", {
    "case.id": request.params.caseId,
  }, async () => {
    const principal = await authorize(request, "case.read", { kind: "case", id: request.params.caseId });
    requireHuman(principal);
    return { effects: await listSkillEffects(store, principal.tenantId, request.params.caseId) };
  }));

  app.get<{ Params: { caseId: string }; Querystring: { after?: string; limit?: string } }>("/v1/cases/:caseId/events", async (request) => traced(request, "case.events.read", {
    "case.id": request.params.caseId,
  }, async () => {
    const principal = await authorize(request, "event.read", { kind: "case", id: request.params.caseId });
    requireHuman(principal);
    const page = await listCaseEventsPage(store, principal.tenantId, request.params.caseId, {
      afterSequence: Number(request.query.after ?? 0),
      ...(request.query.limit ? { limit: Number(request.query.limit) } : {}),
    });
    return { events: page.items, nextCursor: page.nextCursor };
  }));

  app.post<{ Params: { caseId: string } }>("/v1/cases/:caseId/ledger::verify", async (request) => traced(request, "case.ledger.verify", {
    "case.id": request.params.caseId,
  }, async () => {
    const principal = await authorize(request, "case.read", { kind: "case", id: request.params.caseId });
    requireHuman(principal);
    return verifyCaseLedger(store, principal.tenantId, request.params.caseId);
  }));

  // The context release job (data-stores-plan.md §3.3): whether a closed case's working
  // context may be released, and the ledger record that it was. The job can do nothing else
  // to a case.
  // The case list serves people; the release job gets the ids of closed cases and nothing else.
  app.get<{ Querystring: { cursor?: string } }>("/v1/context-release/cases", async (request) => traced(request, "case.context_release.list", {}, async () => {
    const principal = await authorize(request, "context.release", { kind: "case" });
    const page = await listCasesPage(store, { tenantId: principal.tenantId, status: "CLOSED", limit: 200, ...(request.query.cursor ? { cursor: request.query.cursor } : {}) });
    return { caseIds: page.items.map((item) => item.caseId), nextCursor: page.nextCursor };
  }));
  app.get<{ Params: { caseId: string } }>("/v1/cases/:caseId/context-release", async (request, reply) => traced(request, "case.context_release.read", {
    "case.id": request.params.caseId,
  }, async () => {
    const principal = await authorize(request, "context.release", { kind: "case", id: request.params.caseId });
    const eligibility = await getContextReleaseEligibility(store, principal.tenantId, request.params.caseId);
    return eligibility ? reply.send(eligibility) : reply.code(404).send({ error: "case.not_found" });
  }));
  app.post<{ Params: { caseId: string } }>("/v1/cases/:caseId/context-release", async (request, reply) => traced(request, "case.context_release.record", {
    "case.id": request.params.caseId,
  }, async () => {
    const principal = await authorize(request, "context.release", { kind: "case", id: request.params.caseId });
    const parsed = z.object({
      closedSequence: z.number().int().positive(),
      releasedAt: z.string().datetime(),
      counts: z.record(z.string(), z.number().int().nonnegative().nullable()),
      promotedEvidenceIds: z.array(z.string().min(1)),
    }).strict().safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "context_release.request_invalid" });
    const result = await recordContextReleased(store, principal.tenantId, request.params.caseId, { ...parsed.data, releasedBy: principal.subjectId });
    return reply.code(result.replayed ? 200 : 201).send(result);
  }));

  // Legal holds (data-stores-plan.md §3.6): people with Legal.HoldOfficer place a hold over
  // cases and a different officer releases it. The matter reference stays here, out of the
  // case ledger; the retention job applies the holds to storage.
  const holdAuthority = z.object({ basis: z.string().min(1).max(200), reference: z.string().min(1).max(200).optional() }).strict();
  app.post("/v1/legal-holds", async (request, reply) => traced(request, "legal_hold.place", {}, async () => {
    const principal = await authorize(request, "legal_hold.write", { kind: "legal_hold" });
    requireHuman(principal);
    const parsed = z.object({
      matterRef: z.string().min(1).max(200),
      caseIds: z.array(z.string().min(1)).min(1).max(500),
      authority: holdAuthority,
    }).strict().safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "legal_hold.request_invalid" });
    const key = String(request.headers["idempotency-key"] ?? "");
    const result = await placeLegalHold(store, principal.tenantId, key, { ...parsed.data, placedBy: principal.subjectId });
    return reply.code(result.created ? 201 : 200).send(result.hold);
  }));
  // Case teams and assignment (docs/implementation/case-access-model.md, step 1). Recorded and
  // readable; nothing here restricts access to a case yet.
  app.get("/v1/case-teams", async (request) => traced(request, "case_team.list", {}, async () => {
    const principal = await authorize(request, "case.read", { kind: "case_team" });
    requireHuman(principal);
    return { teams: await listCaseTeams(store, principal.tenantId) };
  }));
  app.put<{ Params: { teamId: string }; Body: { name?: unknown; members?: unknown } }>("/v1/case-teams/:teamId", async (request, reply) => traced(request, "case_team.upsert", {}, async () => {
    const principal = await authorize(request, "case.assign", { kind: "case_team", id: request.params.teamId });
    requireHuman(principal);
    const body = request.body ?? {};
    if (typeof body.name !== "string" || !Array.isArray(body.members) || body.members.some((member) => typeof member !== "string")) {
      return reply.code(400).send({ error: "case_team.request_invalid" });
    }
    return upsertCaseTeam(store, principal.tenantId, { teamId: request.params.teamId, name: body.name, members: body.members as string[] },
      { type: "HUMAN", principalId: principal.subjectId, roles: principal.roles });
  }));
  app.get<{ Params: { caseId: string } }>("/v1/cases/:caseId/assignment", async (request) => traced(request, "case.assignment.read", {
    "case.id": request.params.caseId,
  }, async () => {
    const principal = await authorize(request, "case.read", { kind: "case", id: request.params.caseId });
    requireHuman(principal);
    return { assignment: await getCaseAssignment(store, principal.tenantId, request.params.caseId) };
  }));
  app.get<{ Querystring: { caseIds?: string } }>("/v1/case-assignments", async (request) => traced(request, "case.assignment.list", {}, async () => {
    const principal = await authorize(request, "case.read", { kind: "case" });
    requireHuman(principal);
    const caseIds = (request.query.caseIds ?? "").split(",").map((id) => id.trim()).filter(Boolean);
    return { assignments: await listCaseAssignments(store, principal.tenantId, caseIds) };
  }));
  app.get<{ Querystring: { active?: string; caseId?: string } }>("/v1/legal-holds", async (request) => traced(request, "legal_hold.list", {}, async () => {
    const principal = await authorize(request, "legal_hold.read", { kind: "legal_hold" });
    requireHuman(principal);
    const active = request.query.active === undefined ? undefined : request.query.active === "true";
    return { holds: await listLegalHolds(store, principal.tenantId, { ...(active === undefined ? {} : { active }), ...(request.query.caseId ? { caseId: request.query.caseId } : {}) }) };
  }));
  app.get<{ Params: { holdId: string } }>("/v1/legal-holds/:holdId", async (request, reply) => traced(request, "legal_hold.read", {}, async () => {
    const principal = await authorize(request, "legal_hold.read", { kind: "legal_hold", id: request.params.holdId });
    requireHuman(principal);
    const hold = await getLegalHold(store, principal.tenantId, request.params.holdId);
    return hold ? reply.send(hold) : reply.code(404).send({ error: "legal_hold.not_found" });
  }));
  app.post<{ Params: { holdId: string } }>("/v1/legal-holds/:holdId/release", async (request, reply) => traced(request, "legal_hold.release", {}, async () => {
    const principal = await authorize(request, "legal_hold.write", { kind: "legal_hold", id: request.params.holdId });
    requireHuman(principal);
    const parsed = z.object({ authority: holdAuthority }).strict().safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "legal_hold.request_invalid" });
    const result = await releaseLegalHold(store, principal.tenantId, request.params.holdId, { releasedBy: principal.subjectId, authority: parsed.data.authority });
    return reply.send(result.hold);
  }));

  app.post("/v1/evidence::register", async (request, reply) => traced(request, "evidence.register", {}, async () => {
    const principal = await authorize(request, "evidence.write", { kind: "evidence" });
    const execution = isWorkload(principal) ? await verifyCaseWriteAuthority(request, executionSecret) : undefined;
    const parsed = registerEvidenceRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "evidence.request_invalid", issues: parsed.error.issues });
    if (parsed.data.tenantId !== principal.tenantId) return reply.code(403).send({ error: "authorization.tenant_mismatch" });
    const key = String(request.headers["idempotency-key"] ?? "");
    // The context pack behind an agent's proposal (data-stores-plan.md §3.3) is promoted by the
    // runtime under the node's own envelope (registerEvidence enforces who may); it needs no
    // LinkEvidence grant.
    if (execution) {
      if (parsed.data.type !== "model_context" && !execution.case_writes.includes("LinkEvidence")) {
        throw new CaseStoreError("authorization.command_not_declared", 403);
      }
      await assertActiveCaseExecution(store.executionDb ?? store.db, execution, principal.tenantId, parsed.data.caseId);
    }
    parsed.data.createdBy = verifiedActor(principal, parsed.data.createdBy, execution);
    const result = await registerEvidence(store, parsed.data, key, execution);
    return reply.code(result.created ? 201 : 200).send(result);
  }));

  // A person uploads a case document (an analyst or relationship manager; workloads register
  // evidence through /v1/evidence:register). The bytes are stored content-addressed like any
  // evidence; the document is untrusted external content until parsed and reviewed. `documentId`
  // is derived from the content digest, so the same file uploaded twice is one document.
  app.post<{ Params: { caseId: string } }>("/v1/cases/:caseId/documents", { bodyLimit: Math.ceil(store.evidenceMaxBytes * 4 / 3) + 65536 }, async (request, reply) => traced(request, "document.upload", {
    "case.id": request.params.caseId,
  }, async () => {
    const principal = await authorize(request, "evidence.write", { kind: "case", id: request.params.caseId });
    requireHuman(principal);
    const parsed = documentUploadSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "document.request_invalid", issues: parsed.error.issues });
    const key = String(request.headers["idempotency-key"] ?? "");
    if (!key) return reply.code(400).send({ error: "evidence.idempotency_key_required" });
    const actor = verifiedActor(principal, { type: "HUMAN", principalId: principal.subjectId, roles: [] });
    // Adding evidence to a case is acting on it (case-access-model.md step 3).
    await requireStanding(principal, request.params.caseId);
    const describe = (evidence: Record<string, unknown>, created: boolean) => {
      const integrity = (evidence as { integrity?: { rawDigest?: string } }).integrity;
      const sha256 = String(integrity?.rawDigest ?? "").replace(/^sha256:/, "");
      return reply.code(created ? 201 : 200).send({
        created, evidence,
        document: {
          documentId: `doc_${sha256.slice(0, 24)}`, sha256, filename: parsed.data.filename,
          mediaType: parsed.data.mediaType, documentType: parsed.data.documentType ?? null, status: "UPLOADED_UNPARSED",
        },
      });
    };
    // A retry carries a new upload time, so replay the first registration for this key rather than
    // letting the request digest differ: same case, file name, bytes, subjects and residency return it,
    // anything else conflicts.
    const prior = await findEvidenceRegistration(store, principal.tenantId, key);
    if (prior) {
      const evidence = prior.evidence as { caseId?: string; source?: { dataset?: string }; integrity?: { rawDigest?: string }; subjectRefs?: unknown; residency?: unknown };
      const digest = createHash("sha256").update(Buffer.from(parsed.data.contentBase64, "base64")).digest("hex");
      if (evidence.caseId !== request.params.caseId || evidence.source?.dataset !== `document:${parsed.data.filename}`
        || String(evidence.integrity?.rawDigest ?? "").replace(/^sha256:/, "") !== digest
        || JSON.stringify(evidence.subjectRefs ?? []) !== JSON.stringify(parsed.data.subjectRefs) || evidence.residency !== parsed.data.residency) {
        return reply.code(409).send({ error: "evidence.idempotency_conflict" });
      }
      return describe(prior.evidence, false);
    }
    const result = await registerEvidence(store, {
      tenantId: principal.tenantId,
      caseId: request.params.caseId,
      schemaVersion: "harness.evidence.v1",
      type: "DOCUMENT",
      mediaType: parsed.data.mediaType,
      contentBase64: parsed.data.contentBase64,
      ...(parsed.data.declaredDigest ? { declaredDigest: parsed.data.declaredDigest } : {}),
      source: { type: "UPLOAD", retrievedAt: new Date().toISOString(), dataset: `document:${parsed.data.filename}` },
      subjectRefs: parsed.data.subjectRefs,
      trust: { tier: "CUSTOMER_PROVIDED", instructionTrust: "UNTRUSTED_EXTERNAL" },
      classification: "CONFIDENTIAL",
      retentionClass: "KYC_REGULATED",
      residency: parsed.data.residency,
      createdBy: actor,
    }, key);
    return describe(result.evidence, result.created);
  }));

  // The stored bytes of one evidence artifact, re-verified against their digest, for a person
  // with evidence.read (the document viewer). Workloads never read raw evidence bytes here.
  app.get<{ Params: { evidenceId: string } }>("/v1/evidence/:evidenceId/content", async (request, reply) => traced(request, "evidence.content", {
    "evidence.id": request.params.evidenceId,
  }, async () => {
    const principal = await authorize(request, "evidence.read", { kind: "evidence", id: request.params.evidenceId });
    requireHuman(principal);
    const result = await getEvidenceContent(store, principal.tenantId, request.params.evidenceId);
    if (!result) return reply.code(404).send({ error: "evidence.not_found" });
    reply.header("cache-control", "no-store");
    return { evidenceId: result.evidenceId, caseId: result.caseId, mediaType: result.mediaType, rawDigest: result.rawDigest, contentBase64: result.content.toString("base64") };
  }));

  app.get<{ Params: { evidenceId: string } }>("/v1/evidence/:evidenceId", async (request, reply) => traced(request, "evidence.read", {
    "evidence.id": request.params.evidenceId,
  }, async () => {
    const principal = await authorize(request, "evidence.read", { kind: "evidence", id: request.params.evidenceId });
    requireHuman(principal);
    const result = await getEvidence(store, principal.tenantId, request.params.evidenceId);
    return result ?? reply.code(404).send({ error: "evidence.not_found" });
  }));

  app.addHook("onClose", async () => {
    if (store.ownsDatabase) {
      await store.db.end();
      await store.executionDb?.end();
    }
  });
  return app;
}
