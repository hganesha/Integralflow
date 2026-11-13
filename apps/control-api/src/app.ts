import { discoveryRunInputSchema, stableDigest } from "@ehf/contracts";
import { registerUserRoutes } from "./user-routes.js";
import { registerProductCatalogRoutes } from "./product-catalog-routes.js";
import { compileSavedDraft, registerDraftTestRoutes } from "./draft-test-routes.js";
import { registerSandboxRunRoutes } from "./sandbox-run-routes.js";
import { isDocumentExtractionPlan } from "@ehf/contracts";
import { registerDocumentStudio } from "./document-studio.js";
import { registerWorkbench } from "./workbench.js";
import { checkDependency, httpHealthCheck, notConfigured } from "@ehf/contracts/platform-health";
import { registerContextPulls } from "./context-pulls.js";
import { registerContextOntologyRoutes } from "./context-ontology-routes.js";
import { registerContextRefresh } from "./context-refresh.js";
import { registerContextSetupRoutes } from "./context-setup-routes.js";
import { registerContextSourceRoutes } from "./context-source-routes.js";
import { registerExternalProviderRoutes } from "./external-provider-routes.js";
import { registerExternalBindingRoutes } from "./external-binding-routes.js";
import { createContextStore, type ContextStore } from "@ehf/context-store";
import { recordSandboxObservation, registerSandboxObservationWrites, sandboxContextObservation } from "./sandbox-observations.js";
import { registerContextRoutes } from "./context-routes.js";
import { z } from "zod";
import rateLimit from "@fastify/rate-limit";
import { registerPlatformOperations, workerDependencies } from "./platform-operations.js";
import { loadAuthoringTemplates } from "./authoring-templates.js";
import { validateSourceFiles } from "./harnessc.js";
import Fastify, { type FastifyRequest } from "fastify";
import { verifyIntegrationEnvelope, verifyRuntimeGrant } from "@ehf/execution-auth";
import {
  businessSkillIdSchema, businessSkillMaturitySchema, businessSkillStatusSchema, runRequestSchema, semverSchema,
} from "@ehf/contracts";
import {
  AuthorizationError,
  createGuard,
  createPrivateKeyJwtSignerFromEnv,
  createWorkloadResolverFromEnv,
  DelegatedPrincipalResolver,
  envelopeSigner,
  serviceGrants,
  envelopeVerifier,
  isProductionProfile,
  type AuthorizationDecision,
  type PlatformAction,
  type Principal,
  type ResourceRef,
  type ServiceTokenGrant,
} from "@ehf/identity";
import {
  admitPlan, createAuthoringDraft, createDatabase, createRun, getAuthoringDraft, getPlan, getRun,
  requestRunCancellation, SeparationOfDutiesError, requireExecutableRelease, isSandboxRelease, getPublishedPolicy, getExecutionWorkItem,
  getAuthoringAgent, getBusinessSkill, listAuthoringAgents, listAuthoringSkills, listBusinessSkills, registerAuthoringAgent, registerAuthoringSkill,
  listAuthoringDrafts, listAuthoringEvents, listEventsPage, listGatewayReceiptsPage, listHumanWorkQueue, listNodeAttempts, listPlanRecordsPage,
  listRegisteredCapabilities, listRunsPage, resolveSettingSection, setAuthoringLifecycle,
  updateAuthoringSources, type Database, type SkillRegistryRecord,
} from "@ehf/persistence";
import { resolve } from "node:path";
import {
  analyzeAuthoringSources,
  compileAuthoringDraft,
  defaultAuthoringSources,
  evaluateCompiledPlan,
} from "./authoring.js";
import { importAgentBundle } from "./agent-import.js";
import { importFinancialCrimeCatalog, readFinancialCrimeCatalog } from "./canonical-catalog.js";
import { invocationStoreOperation } from "./runtime-invocations.js";
import { updateAuthoringContextClassificationPolicies, updateAuthoringContextSelectors } from "./authoring-context.js";
import { EnvelopeBrokerError, issueExecutionEnvelope } from "./envelope-broker.js";
import { registerIntelligenceRoutes } from "./intelligence-routes.js";
import { registerSkillBundleRoutes } from "./skill-bundle-routes.js";
import { registerSkillQualificationRoutes } from "./skill-qualification-routes.js";
import { registerSourcePolicyRoutes } from "./source-policy-routes.js";
import {
  applyStateWrite,
  authorizeStateWrite,
  parseStateRequest,
  RuntimeStateAuthorityError,
  runtimeStateOperations,
  type RuntimeStateOperation,
} from "./runtime-state-routes.js";
import { applyAgentToAuthoringSources, materializeRegisteredContracts, updateNodeCaseWrites } from "./authoring-agents.js";
import {
  AdminConfigError,
  activateModelProfile,
  adminChangeLogView,
  adminModelProfilesView,
  adminProvidersView,
  adminSettingsView,
  administeredModelProfileRegistry,
  writeModelProfile,
  writeProvider,
  writeSettingSection,
  type AdminRouteDeps,
} from "./admin-config.js";
import { addOrchestrationNode, authoringGraphMutationSchema, mutateAuthoringGraph, type OrchestrationNodeInput } from "./authoring-nodes.js";
import { businessGateTemplate } from "./authoring-gates.js";
import { registerPolicyAuthoringRoutes } from "./policy-authoring.js";
import { registerAuthoringScopeRoutes } from "./authoring-scope.js";
import { registerCasePlanRoutes } from "./case-plans.js";
import { registerGovernanceRoutes } from "./governance-routes.js";
import { caseServiceRequest, registerIntegrationRoutes } from "./integration-routes.js";
import { escalateCaseDueDiligence, registerCaseEscalationRoutes } from "./case-escalation.js";
import { registerDocumentFactoryRoutes } from "./document-factory-routes.js";

/**
 * A registered agent instruction as the API presents it. The registry row keeps its
 * original shape (`skill`, in harness_control.skill_registry); `instruction.instructions`
 * is the instruction text an agent profile embeds as `instructions[].text`.
 */
function agentInstructionView(record: SkillRegistryRecord) {
  const { skill, ...rest } = record;
  return { instruction: skill, ...rest };
}

/** The services that call the control API, one identity each, and what each may do here. */
function serviceGrantsFromEnv(env: NodeJS.ProcessEnv): ServiceTokenGrant[] {
  return serviceGrants([
    { subjectId: "discovery-worker", roles: ["Discovery.Launch"], tokenEnv: "DISCOVERY_WORKER_SERVICE_TOKEN" },
    { subjectId: "context-refresh", roles: ["Context.Refresh"], tokenEnv: "CONTEXT_REFRESH_SERVICE_TOKEN" },
    { subjectId: "control-surface-edge", roles: ["Edge.Delegate"], tokenEnv: "EDGE_SERVICE_TOKEN" },
    { subjectId: "harness-runtime", roles: ["Runtime.State.Write"], tokenEnv: "RUNTIME_SERVICE_TOKEN" },
    { subjectId: "runtime-dispatcher", roles: ["Deployment.Verify"], tokenEnv: "DEPLOYMENT_VERIFIER_SERVICE_TOKEN" },
    { subjectId: "integration-worker", roles: ["Integration.Dispatch"], tokenEnv: "INTEGRATION_SERVICE_TOKEN" },
    // The case service: publishes committed case events and reads a node's policy
    // authority before evaluating a gate. It used to borrow the integration worker's and
    // the runtime's credentials for these; it now calls as itself.
    { subjectId: "case-api", roles: ["Case.Outbox.Publish", "Policy.Authority.Read"], tokenEnv: "CASE_API_SERVICE_TOKEN" },
    // The Document Factory worker: claims approved release jobs and reports their results (document-factory-routes.ts).
    { subjectId: "document-factory-worker", roles: ["Factory.Worker"], tokenEnv: "FACTORY_WORKER_SERVICE_TOKEN" },
  ], env);
}

export type ControlApiOptions = {
  db?: Database;
  /** The context store (ehf_context); created from CONTEXT_DATABASE_URL / CONTEXT_DB_* when omitted. */
  contextStore?: ContextStore | null;
  serviceGrants?: ServiceTokenGrant[];
  env?: NodeJS.ProcessEnv;
  envelopeSecret?: string;
  grantSecret?: string;
  integrationSecret?: string;
  /** Transport for the runtime host health check (tests). */
  fetch?: typeof globalThis.fetch;
};

export function buildControlApi(options: ControlApiOptions = {}) {
  const app = Fastify({ logger: true });
  // The case outbox relay posts structured-mode CloudEvents (application/cloudevents+json).
  // Without this parser Fastify answered 415 and no case event ever reached the control plane.
  app.addContentTypeParser("application/cloudevents+json", { parseAs: "string" }, app.getDefaultJsonParser("error", "error"));
  // Per-replica admission bound. Do not trust caller-supplied forwarding headers.
  void app.register(rateLimit, { global: false, max: 1000, timeWindow: 60_000, skipOnError: false });
  app.after((error) => {
    if (error) throw error;
    // Install one shared limiter after the plugin boots, including routes that
    // these synchronous builders have already registered.
    app.addHook("onRequest", app.rateLimit());
  });
  const env = options.env ?? process.env;
  const db = options.db ?? createDatabase();
  const workloadResolver = createWorkloadResolverFromEnv(options.serviceGrants ?? serviceGrantsFromEnv(env), env);
  const recordDecision = (decision: AuthorizationDecision) => app.log.info({ authorization: decision }, "authorization decision");
  // Human operations arrive delegated through the control surface edge; the edge proves
  // itself and the actor it carries is believed only then. There is no longer a default
  // actor: an anonymous request is anonymous.
  const guard = createGuard({ resolver: new DelegatedPrincipalResolver(workloadResolver), onDecision: recordDecision });
  const runtimeGuard = createGuard({ resolver: workloadResolver, onDecision: recordDecision });
  // Read once at boot: a missing or unreadable key fails startup, not the first mint.
  const executionSigner = envelopeSigner(env) === "private_key" ? createPrivateKeyJwtSignerFromEnv("EXECUTION_ENVELOPE", env) : undefined;

  app.setErrorHandler((error: unknown, _request, reply) => {
    if (error instanceof Error && "statusCode" in error && error.statusCode === 429) {
      return reply.code(429).send({ error: "request.rate_limit_exceeded" });
    }
    if (error instanceof AuthorizationError) {
      return reply.code(error.httpStatus).send({ error: error.decision.reasonCode });
    }
    if (error instanceof SeparationOfDutiesError) {
      return reply.code(403).send({ error: error.message, actor: error.actor });
    }
    if (error instanceof AdminConfigError) {
      return reply.code(error.httpStatus).send({ error: error.message });
    }
    if (error instanceof Error && error.message.startsWith("pagination.")) {
      return reply.code(400).send({ error: error.message });
    }
    app.log.error(error);
    return reply.code(500).send({ error: "control.internal_error" });
  });

  app.get("/health/live", async () => ({ status: "ok" }));
  app.get("/health/ready", async () => { await db.query("select 1"); return { status: "ready" }; });
  const requirePrincipal = (
    request: { headers: Record<string, string | string[] | undefined> },
    action: PlatformAction,
    resource?: ResourceRef,
  ): Promise<Principal> => guard.require(request, action, resource);
  const profilesPath = env.MODEL_PROFILES_PATH ?? "config/model-profiles.json";
  const adminDeps: AdminRouteDeps = { db, env };
  const envelopeSecret = () => {
    const value = options.envelopeSecret ?? env.EXECUTION_ENVELOPE_SECRET;
    if (!value) throw new EnvelopeBrokerError("broker.envelope_secret_missing", 503);
    return value;
  };
  const grantSecret = () => {
    const value = options.grantSecret ?? (envelopeVerifier(env) === "public_key"
      ? env.RUNTIME_GRANT_PUBLIC_KEY_PEM
      : env.RUNTIME_GRANT_SECRET);
    if (!value) throw new EnvelopeBrokerError("broker.grant_secret_missing", 503);
    return value;
  };
  const integrationSecret = () => {
    const value = options.integrationSecret ?? (envelopeVerifier(env) === "public_key"
      ? env.INTEGRATION_ENVELOPE_PUBLIC_KEY_PEM
      : env.INTEGRATION_ENVELOPE_SECRET);
    if (!value) throw new EnvelopeBrokerError("integration.envelope_verifier_missing", 503);
    return value;
  };
  const domainsPath = env.DOMAINS_PATH ?? resolve(process.cwd(), "domains");
  // Operations-only stamps do not expose an authoring API. Keeping this guard at the
  // routing boundary means a role assignment cannot accidentally re-enable authoring.
  if (env.AUTHORING_MODE === "disabled") {
    app.addHook("onRequest", async (request, reply) => {
      if (request.url.startsWith("/v1/authoring")) return reply.code(404).send({ error: "authoring.disabled" });
      if (request.method !== "GET" && (request.url === "/v1/plans" || request.url.startsWith("/v1/releases"))) {
        return reply.code(404).send({ error: "authoring.disabled" });
      }
    });
  } else {
    registerPolicyAuthoringRoutes(app, {
      opaVersion: env.OPA_VERSION ?? "1.9.0",
      authorize: requirePrincipal,
    });
    registerAuthoringScopeRoutes(app, {
      db, authorize: requirePrincipal, domainsPath,
      configPath: env.CONFIG_PATH ?? resolve(domainsPath, "../config"),
    });
  }
  registerCasePlanRoutes(app, { db, authorize: requirePrincipal, environment: env.RELEASE_ENVIRONMENT ?? "development" });
  // Enhanced due-diligence escalation: runs the case under its enhanced process (case-escalation.ts).
  const caseService = (tenantId: string, path: string, init?: { method?: string; body?: unknown }) => caseServiceRequest(env, tenantId, path, init);
  const runsRequireSourceContext = isProductionProfile(env) || env.RELEASE_ENVIRONMENT === "production";
  registerCaseEscalationRoutes(app, { db, authorize: requirePrincipal, environment: env.RELEASE_ENVIRONMENT ?? "development", caseService, runsRequireSourceContext });
  registerDraftTestRoutes(app, { db, env, authorize: requirePrincipal });
  registerSandboxRunRoutes(app, { db, env, authorize: requirePrincipal, caseService, contextStore: () => resolveContextStore(), opaVersion: env.OPA_VERSION ?? "1.9.0",
    compile: (draft, tenantId) => compileSavedDraft(db, env, draft, tenantId) });
  registerProductCatalogRoutes(app, { db, env, authorize: requirePrincipal });
  registerDocumentStudio(app, { db, env, authorize: requirePrincipal,
    authorizeVerification: request => runtimeGuard.require(request, "deployment.verify", { kind: "document-studio" }) });
  registerDocumentFactoryRoutes(app, { db, env, authorize: requirePrincipal, workload: (r, a, resource) => runtimeGuard.require(r, a, resource) });
  registerUserRoutes(app, db, requirePrincipal, workloadResolver);
  registerIntelligenceRoutes(app, { db, env, authorize: requirePrincipal });
  registerContextOntologyRoutes(app, { db, env, ...(executionSigner ? { signer: executionSigner } : {}), authorize: requirePrincipal });
  registerContextSetupRoutes(app, { db, env, authorize: requirePrincipal });
  registerContextPulls(app, { db, env, authorize: requirePrincipal });
  registerWorkbench(app,{db,env,authorize:requirePrincipal});
  registerPlatformOperations(app,{db,env,authorize:requirePrincipal,fetch:options.fetch??globalThis.fetch});
  registerContextRefresh(app, { db, env, authorize: requirePrincipal, workload: (r,a,resource)=>runtimeGuard.require(r,a,resource) });
  registerSkillBundleRoutes(app, { db, authorize: requirePrincipal });
  registerSkillQualificationRoutes(app, { db, authorize: requirePrincipal });
  registerSourcePolicyRoutes(app, { db, authorize: requirePrincipal });
  registerContextSourceRoutes(app, { db, environment:env.RELEASE_ENVIRONMENT ?? "development", authorize: requirePrincipal });
  registerExternalProviderRoutes(app, { db, authorize: requirePrincipal });
  registerExternalBindingRoutes(app, { db, authorize: requirePrincipal });
  registerGovernanceRoutes(app, {
    db,
    env,
    opaVersion: env.OPA_VERSION ?? "1.9.0",
    authorize: requirePrincipal,
  });
  registerIntegrationRoutes(app, {
    db,
    env,
    authorize: requirePrincipal,
    authorizeIngress: (request, action, resource) => runtimeGuard.require(request, action, resource),
    // The policy's EDD escalation work item moves the case onto its enhanced process at once.
    onCaseEvent: async (event) => {
      if (event.type !== "work_item.created") return;
      const result = await escalateCaseDueDiligence({ db, environment: env.RELEASE_ENVIRONMENT ?? "development", tenantId: event.tenantId,
        caseId: event.caseId, requestedBy: "policy:edd-escalation", caseService, runsRequireSourceContext });
      if (result.status !== "not_required") app.log.info({ escalation: result }, "due-diligence escalation");
    },
  });
  app.get<{ Querystring: { cursor?: string; limit?: string } }>("/v1/plans", async (request) => {
    const principal = await requirePrincipal(request, "plan.read", { kind: "plan" });
    const page = await listPlanRecordsPage(db, principal.tenantId, {
      ...(request.query.cursor ? { cursor: request.query.cursor } : {}),
      ...(request.query.limit ? { limit: Number(request.query.limit) } : {}),
    });
    return { plans: page.items.map((record) => record.plan), nextCursor: page.nextCursor };
  });
  app.post<{ Body: { execution: { grant: string; runId: string; attempt: number; workerId: string; fencingEpoch: number }; nodeId: string } }>("/v1/runtime/policy-authority", async (request, reply) => {
    const principal = await runtimeGuard.require(request, "policy.authority.read", { kind: "policy" });
    const { execution, nodeId } = request.body;
    const { grant: token, ...fence } = execution;
    await authorizeStateWrite(db, token, grantSecret(), fence);
    const grant = await verifyRuntimeGrant(token, grantSecret());
    if (grant.node_id !== nodeId || !grant.work_item_id) return reply.code(403).send({ error: "policy.node_grant_required" });
    const work = await getExecutionWorkItem(db, principal.tenantId, grant.work_item_id);
    if (work?.status !== "RUNNING" || !work.lease || work.lease.fencingEpoch !== grant.work_fencing_epoch
      || work.constraints.nodeId !== nodeId || work.constraints.runId !== grant.run_id
      || work.lease.owner !== grant.worker_id || Date.parse(work.lease.leaseUntil) <= Date.now()) {
      return reply.code(403).send({ error: "policy.work_authority_expired" });
    }
    const plan = await getPlan(db, grant.plan_digest, principal.tenantId);
    const node = plan?.graph.nodes.find((item) => item.id === nodeId);
    if (plan?.apiVersion !== "harness.factory/plan-v2" || node?.kind !== "gate") return reply.code(403).send({ error: "policy.gate_required" });
    const release = await requireExecutableRelease(db, principal.tenantId, plan.planDigest, env.RELEASE_ENVIRONMENT ?? "development");
    const binding = plan.policyBundles.find((item) => item.policyId === node.config.policyRef);
    const policy = binding ? await getPublishedPolicy(db, principal.tenantId, binding.bundleDigest) : null;
    if (!policy?.compiledBundle) return reply.code(409).send({ error: "policy.published_bundle_missing" });
    // requireExecutableRelease has already required approved, unrevoked registry entries
    // for the release manifest and every policy bundle it names. Bind this bundle to it.
    const bundleDigest = policy.compiledBundle.bundleDigest.replace(/^sha256:/, "");
    if (!release.manifest.policyBundleDigests.some((digest) => digest.replace(/^sha256:/, "") === bundleDigest)) {
      return reply.code(403).send({ error: "policy.bundle_not_released" });
    }
    const run = await getRun(db, grant.run_id, principal.tenantId);
    const caseId = (run?.input as { caseId?: unknown })?.caseId;
    if (typeof caseId !== "string" || caseId !== work.caseId) return reply.code(403).send({ error: "policy.case_scope_mismatch" });
    return { plan, files: policy.files, manifest: policy.compiledBundle, releaseDigest: release.manifest.manifestDigest, productionReady: policy.releaseBlockers.length === 0,
      // A sandbox release rehearses a draft: its checkpoints may decide under a candidate policy.
      sandbox: isSandboxRelease(release.manifest),
      execution: { tenant_id: principal.tenantId, case_id: caseId, run_id: grant.run_id, plan_digest: grant.plan_digest,
        attempt: grant.attempt, fencing_epoch: grant.fencing_epoch, work_item_id: grant.work_item_id, work_fencing_epoch: grant.work_fencing_epoch } };

  });
  app.get<{ Querystring: { cursor?: string; limit?: string } }>("/v1/plan-records", async (request) => {
    const principal = await requirePrincipal(request, "plan.read", { kind: "plan" });
    const page = await listPlanRecordsPage(db, principal.tenantId, {
      ...(request.query.cursor ? { cursor: request.query.cursor } : {}),
      ...(request.query.limit ? { limit: Number(request.query.limit) } : {}),
    });
    return { records: page.items, nextCursor: page.nextCursor };
  });
  app.get<{ Params: { digest: string } }>("/v1/plans/:digest", async (request, reply) => {
    const principal = await requirePrincipal(request, "plan.read", { kind: "plan", id: request.params.digest });
    const plan = await getPlan(db, request.params.digest, principal.tenantId);
    return plan ?? reply.code(404).send({ error: "plan.not_found" });
  });
  // A case creator may not hold plan.read. Return only the policy pins needed to
  // create a case, after verifying this exact plan's executable release authority.
  app.get<{ Params: { digest: string } }>("/v1/plans/:digest/case-authority", async (request, reply) => {
    const principal = await requirePrincipal(request, "case.write", { kind: "plan", id: request.params.digest });
    if (principal.actorType !== "human") return reply.code(403).send({ error: "authorization.interactive_user_required" });
    const plan = await getPlan(db, request.params.digest, principal.tenantId);
    if (!plan) return reply.code(404).send({ error: "plan.not_found" });
    const release = await requireExecutableRelease(db, principal.tenantId, plan.planDigest, env.RELEASE_ENVIRONMENT ?? "development");
    // Multi-policy plans need an explicit case policy, rather than an arbitrary first pin.
    if (plan.policyBundles.length !== 1) return reply.code(409).send({ error: "case.policy_authority_ambiguous" });
    const binding = plan.policyBundles[0]!;
    const policy = await getPublishedPolicy(db, principal.tenantId, binding.bundleDigest);
    const bundle = policy?.compiledBundle;
    if (!bundle || !release.manifest.policyBundleDigests.some(d => d.replace(/^sha256:/, "") === binding.bundleDigest.replace(/^sha256:/, ""))) return reply.code(409).send({ error: "case.policy_authority_unavailable" });
    return { planDigest: plan.planDigest, policySnapshotDigest: bundle.sourceDigest,
      policyAuthority: { policyId: binding.policyId, policyVersion: bundle.policyVersion,
        policyBundleDigest: binding.bundleDigest, dependencyDigest: plan.dependencyManifestDigest } };
  });
  if (env.AUTHORING_MODE !== "disabled") {
    app.post("/v1/plans", async (request, reply) => {
      const principal = await requirePrincipal(request, "plan.admit", { kind: "plan" });
      try {
        // admitPlan verifies the digest before it writes; do not re-order these.
        const admitted = await admitPlan(db, request.body, principal.tenantId);
        return reply.code(admitted.created ? 201 : 200).send(admitted);
      } catch (error) {
        return reply.code(400).send({ error: error instanceof Error ? error.message : "plan.invalid" });
      }
    });
  }
  app.get("/v1/authoring/drafts", async (request) => {
    const principal = await requirePrincipal(request, "draft.read", { kind: "draft" });
    return { drafts: await listAuthoringDrafts(db, principal.tenantId) };
  });
  app.get("/v1/authoring/agents", async (request) => {
    await requirePrincipal(request, "draft.read", { kind: "agent" });
    return { agents: await listAuthoringAgents(db) };
  });
  app.post("/v1/authoring/agents", async (request, reply) => {
    await requirePrincipal(request, "agent.register", { kind: "agent" });
    try { return reply.code(201).send(await registerAuthoringAgent(db, request.body)); }
    catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : "authoring.agent_invalid" }); }
  });
  // Agent instructions: what an agent profile follows (docs/implementation/agent-profiles.md).
  // The registry still stores them in harness_control.skill_registry; "skill" now means only
  // the business skills below.
  app.get("/v1/authoring/agent-instructions", async (request) => {
    await requirePrincipal(request, "draft.read", { kind: "agent-instruction" });
    return { instructions: (await listAuthoringSkills(db)).map(agentInstructionView) };
  });
  // The business skill registry (catalog skills such as screening.sanctions.execute). Not the
  // authoring registry's agent instructions above. Read with the capability-read authority.
  app.get<{ Querystring: { status?: string; maturity?: string; domain?: string } }>("/v1/business-skills", async (request, reply) => {
    await requirePrincipal(request, "capability.read", { kind: "business-skill" });
    const { status, maturity, domain } = request.query;
    const parsedStatus = status === undefined ? undefined : businessSkillStatusSchema.safeParse(status);
    const parsedMaturity = maturity === undefined ? undefined : businessSkillMaturitySchema.safeParse(maturity);
    if (parsedStatus?.success === false || parsedMaturity?.success === false
      || (domain !== undefined && !/^[a-z][a-z_]*$/.test(domain))) {
      return reply.code(400).send({ error: "business_skill.query_invalid" });
    }
    const skills = await listBusinessSkills(db, {
      ...(parsedStatus?.success ? { status: parsedStatus.data } : {}),
      ...(parsedMaturity?.success ? { maturity: parsedMaturity.data } : {}),
      ...(domain ? { domain } : {}),
    });
    return { skills };
  });
  app.get<{ Params: { skillId: string }; Querystring: { semver?: string } }>("/v1/business-skills/:skillId", async (request, reply) => {
    await requirePrincipal(request, "capability.read", { kind: "business-skill", id: request.params.skillId });
    if (!businessSkillIdSchema.safeParse(request.params.skillId).success
      || (request.query.semver !== undefined && !semverSchema.safeParse(request.query.semver).success)) {
      return reply.code(400).send({ error: "business_skill.id_invalid" });
    }
    const skill = await getBusinessSkill(db, request.params.skillId, request.query.semver);
    if (!skill) return reply.code(404).send({ error: "business_skill.not_found" });
    return skill;
  });
  app.post("/v1/authoring/agent-instructions", async (request, reply) => {
    await requirePrincipal(request, "agent.register", { kind: "agent-instruction" });
    try {
      const { created, ...record } = await registerAuthoringSkill(db, request.body);
      return reply.code(201).send({ created, ...agentInstructionView(record) });
    } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : "authoring.agent_instruction_invalid" }); }
  });
  app.post("/v1/authoring/import/fincrime", { bodyLimit: 16 * 1024 * 1024 }, async (request, reply) => {
    const principal = await requirePrincipal(request, "agent.register", { kind: "canonical-catalog" });
    try {
      const body = request.body as { artifact?: unknown; expectedDigest?: unknown } | null;
      if (!body || typeof body.expectedDigest !== "string") return reply.code(400).send({ error: "fincrime.expected_digest_required" });
      return reply.code(201).send(await importFinancialCrimeCatalog(db, principal.tenantId, principal.subjectId, body.artifact, body.expectedDigest));
    } catch { return reply.code(400).send({ error: "fincrime.catalog_import_invalid" }); }
  });
  app.get<{ Params: { digest: string } }>("/v1/authoring/catalogs/fincrime/:digest", async (request, reply) => {
    const principal = await requirePrincipal(request, "draft.read", { kind: "canonical-catalog" });
    try {
      const result = await readFinancialCrimeCatalog(db, principal.tenantId, request.params.digest);
      return result ?? reply.code(404).send({ error: "fincrime.catalog_not_found" });
    } catch { return reply.code(400).send({ error: "fincrime.catalog_digest_invalid" }); }
  });
  app.post("/v1/authoring/import/github", async (request, reply) => {
    await requirePrincipal(request, "agent.register", { kind: "agent-import" });
    try {
      const url = (request.body as { url?: unknown } | null)?.url;
      if (typeof url !== "string") return reply.code(400).send({ error: "authoring.github_url_required" });
      const bundle = await importAgentBundle(url);
      const instructions = await Promise.all(bundle.skills.map(async (skill) => {
        const { created, ...record } = await registerAuthoringSkill(db, skill);
        return { created, ...agentInstructionView(record) };
      }));
      const agent = await registerAuthoringAgent(db, bundle.agent);
      return reply.code(201).send({ agent, instructions });
    } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : "authoring.github_import_failed" }); }
  });
  // A draft carries its whole source bundle; the agentic templates exceed the 1 MiB default.
  app.post("/v1/authoring/drafts", { bodyLimit: 4 * 1024 * 1024 }, async (request, reply) => {
    const principal = await requirePrincipal(request, "draft.write", { kind: "draft" });
    try {
      const body = (request.body ?? {}) as { packageSource?: unknown; workflowSource?: unknown; sourceFiles?: unknown };
      const defaults = defaultAuthoringSources(
        (await resolveSettingSection(db, principal.tenantId, "authoring", env)).value.defaultBudgets,
      );
      const packageSource = typeof body.packageSource === "string" ? body.packageSource : defaults.packageSource;
      const workflowSource = typeof body.workflowSource === "string" ? body.workflowSource : defaults.workflowSource;
      const analysis = analyzeAuthoringSources(packageSource, workflowSource);
      const draft = await createAuthoringDraft(db, {
        packageSource, workflowSource, sourceFiles: validateSourceFiles(body.sourceFiles, String(analysis.parsedPackage.workflow ?? "workflow.yaml")), parsedPackage: analysis.parsedPackage, parsedWorkflow: analysis.parsedWorkflow,
        ...analysis.metadata, diagnostics: analysis.diagnostics, actor: principal.subjectId,
        tenantId: principal.tenantId,
      });
      return reply.code(201).send(draft);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "authoring.create_failed" });
    }
  });
  app.get("/v1/authoring/templates", async (request) => {
    await requirePrincipal(request, "draft.read", { kind: "template" });
    const templates = await loadAuthoringTemplates(domainsPath);
    return { templates };
  });
  app.get<{ Params: { draftId: string } }>("/v1/authoring/drafts/:draftId", async (request, reply) => {
    const principal = await requirePrincipal(request, "draft.read", { kind: "draft", id: request.params.draftId });
    const draft = await getAuthoringDraft(db, request.params.draftId, principal.tenantId);
    if (!draft) return reply.code(404).send({ error: "authoring.draft_not_found" });
    return { ...draft, events: await listAuthoringEvents(db, draft.draftId) };
  });
  app.put<{ Params: { draftId: string } }>("/v1/authoring/drafts/:draftId", { bodyLimit: 4 * 1024 * 1024 }, async (request, reply) => {
    const principal = await requirePrincipal(request, "draft.write", { kind: "draft", id: request.params.draftId });
    try {
      const body = request.body as { expectedRevision?: unknown; packageSource?: unknown; workflowSource?: unknown; sourceFiles?: unknown };
      if (typeof body.expectedRevision !== "number" || typeof body.packageSource !== "string" || typeof body.workflowSource !== "string") {
        return reply.code(400).send({ error: "authoring.update_invalid" });
      }
      const analysis = analyzeAuthoringSources(body.packageSource, body.workflowSource);
      return await updateAuthoringSources(db, request.params.draftId, {
        expectedRevision: body.expectedRevision, packageSource: body.packageSource, workflowSource: body.workflowSource,
        ...(body.sourceFiles === undefined ? {} : { sourceFiles: validateSourceFiles(body.sourceFiles, String(analysis.parsedPackage.workflow ?? "workflow.yaml")) }),
        parsedPackage: analysis.parsedPackage, parsedWorkflow: analysis.parsedWorkflow, ...analysis.metadata,
        diagnostics: analysis.diagnostics, actor: principal.subjectId,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "authoring.update_failed";
      return reply.code(message.includes("conflict") ? 409 : 400).send({ error: message });
    }
  });
  app.post<{ Params: { draftId: string; agentId: string } }>("/v1/authoring/drafts/:draftId/agents/:agentId/attach", async (request, reply) => {
    const principal = await requirePrincipal(request, "draft.write", { kind: "draft", id: request.params.draftId });
    try {
      const body = (request.body ?? {}) as { expectedRevision?: unknown; nodeId?: unknown; mode?: unknown; newNodeId?: unknown };
      if (typeof body.expectedRevision !== "number" || typeof body.nodeId !== "string" || (body.mode !== "replace" && body.mode !== "insert-after")) {
        return reply.code(400).send({ error: "authoring.agent_attachment_invalid" });
      }
      const [draft, registered, registeredSkills] = await Promise.all([
        getAuthoringDraft(db, request.params.draftId, principal.tenantId),
        getAuthoringAgent(db, request.params.agentId),
        listAuthoringSkills(db),
      ]);
      if (!draft) return reply.code(404).send({ error: "authoring.draft_not_found" });
      if (!registered) return reply.code(404).send({ error: "authoring.agent_not_found" });
      const sources = applyAgentToAuthoringSources({
        packageSource: draft.packageSource, workflowSource: draft.workflowSource, agent: registered.agent,
        skills: registeredSkills.map((item) => item.skill),
        nodeId: body.nodeId, mode: body.mode, ...(typeof body.newNodeId === "string" ? { newNodeId: body.newNodeId } : {}),
      });
      const analysis = analyzeAuthoringSources(sources.packageSource, sources.workflowSource);
      const updated = await updateAuthoringSources(db, draft.draftId, {
        expectedRevision: body.expectedRevision, packageSource: sources.packageSource, workflowSource: sources.workflowSource,
        parsedPackage: analysis.parsedPackage, parsedWorkflow: analysis.parsedWorkflow, ...analysis.metadata,
        diagnostics: analysis.diagnostics, actor: principal.subjectId,
      });
      return { draft: updated, attachedNodeId: sources.attachedNodeId };
    } catch (error) {
      const message = error instanceof Error ? error.message : "authoring.agent_attachment_failed";
      return reply.code(message.includes("conflict") ? 409 : 400).send({ error: message });
    }
  });
  app.put<{ Params: { draftId: string; nodeId: string } }>("/v1/authoring/drafts/:draftId/nodes/:nodeId/case-writes", async (request, reply) => {
    const principal = await requirePrincipal(request, "draft.write", { kind: "draft", id: request.params.draftId });
    try {
      const body = (request.body ?? {}) as { expectedRevision?: unknown; caseWrites?: unknown };
      if (typeof body.expectedRevision !== "number" || !Array.isArray(body.caseWrites)) {
        return reply.code(400).send({ error: "authoring.case_writes_update_invalid" });
      }
      const draft = await getAuthoringDraft(db, request.params.draftId, principal.tenantId);
      if (!draft) return reply.code(404).send({ error: "authoring.draft_not_found" });
      const workflowSource = updateNodeCaseWrites(draft.workflowSource, request.params.nodeId, body.caseWrites);
      const analysis = analyzeAuthoringSources(draft.packageSource, workflowSource);
      const caseWriteErrors = analysis.diagnostics.filter((item) => item.severity === "error" && item.path.includes(`nodes.${request.params.nodeId}.config.caseWrites`));
      if (caseWriteErrors.length) return reply.code(422).send({ error: "authoring.case_writes_invalid", diagnostics: caseWriteErrors });
      return await updateAuthoringSources(db, draft.draftId, {
        expectedRevision: body.expectedRevision, packageSource: draft.packageSource, workflowSource,
        parsedPackage: analysis.parsedPackage, parsedWorkflow: analysis.parsedWorkflow, ...analysis.metadata,
        diagnostics: analysis.diagnostics, actor: principal.subjectId,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "authoring.case_writes_update_failed";
      return reply.code(message.includes("conflict") ? 409 : 400).send({ error: message });
    }
  });
  app.put<{ Params: { draftId: string } }>("/v1/authoring/drafts/:draftId/context-selectors", async (request, reply) => {
    const principal = await requirePrincipal(request, "draft.write", { kind: "draft", id: request.params.draftId });
    try {
      const body = (request.body ?? {}) as { expectedRevision?: unknown; contextSelectors?: unknown };
      if (typeof body.expectedRevision !== "number" || !Array.isArray(body.contextSelectors)) {
        return reply.code(400).send({ error: "authoring.context_selectors_update_invalid" });
      }
      const draft = await getAuthoringDraft(db, request.params.draftId, principal.tenantId);
      if (!draft) return reply.code(404).send({ error: "authoring.draft_not_found" });
      const packageSource = updateAuthoringContextSelectors(draft.packageSource, body.contextSelectors);
      const analysis = analyzeAuthoringSources(packageSource, draft.workflowSource);
      return await updateAuthoringSources(db, draft.draftId, {
        expectedRevision: body.expectedRevision, packageSource, workflowSource: draft.workflowSource,
        parsedPackage: analysis.parsedPackage, parsedWorkflow: analysis.parsedWorkflow, ...analysis.metadata,
        diagnostics: analysis.diagnostics, actor: principal.subjectId,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "authoring.context_selectors_update_failed";
      return reply.code(message.includes("conflict") ? 409 : 400).send({ error: message });
    }
  });
  app.put<{ Params: { draftId: string } }>("/v1/authoring/drafts/:draftId/context-classification-policies", async (request, reply) => {
    const principal = await requirePrincipal(request, "draft.write", { kind: "draft", id: request.params.draftId });
    try {
      const body = (request.body ?? {}) as { expectedRevision?: unknown; contextClassificationPolicies?: unknown };
      if (typeof body.expectedRevision !== "number" || !Array.isArray(body.contextClassificationPolicies)) {
        return reply.code(400).send({ error: "authoring.context_classification_policies_update_invalid" });
      }
      const draft = await getAuthoringDraft(db, request.params.draftId, principal.tenantId);
      if (!draft) return reply.code(404).send({ error: "authoring.draft_not_found" });
      const packageSource = updateAuthoringContextClassificationPolicies(draft.packageSource, body.contextClassificationPolicies);
      const analysis = analyzeAuthoringSources(packageSource, draft.workflowSource);
      return await updateAuthoringSources(db, draft.draftId, {
        expectedRevision: body.expectedRevision, packageSource, workflowSource: draft.workflowSource,
        parsedPackage: analysis.parsedPackage, parsedWorkflow: analysis.parsedWorkflow, ...analysis.metadata,
        diagnostics: analysis.diagnostics, actor: principal.subjectId,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "authoring.context_classification_policies_update_failed";
      return reply.code(message.includes("conflict") ? 409 : 400).send({ error: message });
    }
  });
  app.post<{ Params: { draftId: string } }>("/v1/authoring/drafts/:draftId/orchestration-nodes", async (request, reply) => {
    const principal = await requirePrincipal(request, "draft.write", { kind: "draft", id: request.params.draftId });
    try {
      const parsed = z.object({ expectedRevision: z.number().int().nonnegative(), node: z.record(z.string(), z.unknown()) }).safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "authoring.orchestration_node_invalid" });
      const body = parsed.data;
      const draft = await getAuthoringDraft(db, request.params.draftId, principal.tenantId);
      if (!draft) return reply.code(404).send({ error: "authoring.draft_not_found" });
      const added = addOrchestrationNode(draft.workflowSource, body.node as OrchestrationNodeInput);
      const analysis = analyzeAuthoringSources(draft.packageSource, added.workflowSource);
      const errors = analysis.diagnostics.filter((item) => item.severity === "error");
      if (errors.length) return reply.code(422).send({ error: "authoring.orchestration_node_invalid", diagnostics: errors });
      const updated = await updateAuthoringSources(db, draft.draftId, {
        expectedRevision: body.expectedRevision,
        packageSource: draft.packageSource,
        workflowSource: added.workflowSource,
        parsedPackage: analysis.parsedPackage,
        parsedWorkflow: analysis.parsedWorkflow,
        ...analysis.metadata,
        diagnostics: analysis.diagnostics,
        actor: principal.subjectId,
      });
      return reply.code(201).send({ draft: updated, nodeId: added.nodeId });
    } catch (error) {
      const message = error instanceof Error ? error.message : "authoring.orchestration_node_failed";
      return reply.code(message.includes("conflict") ? 409 : 400).send({ error: message });
    }
  });
  app.post<{ Params: { draftId: string } }>("/v1/authoring/drafts/:draftId/graph", async (request, reply) => {
    const principal = await requirePrincipal(request, "draft.write", { kind: "draft", id: request.params.draftId });
    try {
      const parsed = z.object({ expectedRevision: z.number().int().nonnegative(), mutation: authoringGraphMutationSchema }).strict().safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "authoring.graph_mutation_invalid" });
      const body = parsed.data;
      const draft = await getAuthoringDraft(db, request.params.draftId, principal.tenantId);
      if (!draft) return reply.code(404).send({ error: "authoring.draft_not_found" });
      let packageSource = draft.packageSource;
      let mutation = body.mutation;
      let workflowSource = draft.workflowSource;
      const adding =
        mutation.type === "add" || mutation.type === "insert-on-edge";
      const agentId =
        (mutation.type === "add" || mutation.type === "insert-on-edge") &&
        mutation.node.kind === "agent"
          ? mutation.node.agentId
          : mutation.type === "update-node"
            ? mutation.agentId
            : undefined;
      if (agentId) {
        const [registered, instructions] = await Promise.all([
          getAuthoringAgent(db, agentId),
          listAuthoringSkills(db),
        ]);
        if (!registered || registered.agent.status !== "active")
          return reply.code(400).send({ error: "authoring.agent_not_found" });
        let nodeId: string;
        if (mutation.type === "add" || mutation.type === "insert-on-edge") {
          const { agentId: _agentId, ...node } = mutation.node;
          nodeId = node.id;
          // A native placeholder gives insertion the same exact-edge semantics as other steps.
          workflowSource = mutateAuthoringGraph(workflowSource, {
            ...mutation,
            node: { ...node, kind: "join" },
          }).workflowSource;
          mutation = {
            type: "update-node",
            nodeId,
            name: node.name,
            description: node.description ?? "",
          };
        } else if (mutation.type === "update-node") {
          nodeId = mutation.nodeId;
          const nodes =
            (
              draft.parsedWorkflow.spec as {
                nodes?: Array<{
                  id: string;
                  kind: string;
                  config?: { agentRef?: string };
                }>;
              }
            )?.nodes ?? [];
          const prior = nodes.find((node) => node.id === nodeId);
          if (!prior || !(prior.kind === "agent" || prior.config?.agentRef))
            return reply
              .code(400)
              .send({ error: "authoring.agent_node_required" });
          const { agentId: _agentId, ...edit } = mutation;
          mutation = edit;
        } else throw new Error("authoring.agent_attachment_invalid");
        const attached = applyAgentToAuthoringSources({
          packageSource,
          workflowSource,
          agent: registered.agent,
          skills: instructions.map((item) => item.skill),
          nodeId,
          mode: "replace",
        });
        packageSource = attached.packageSource;
        workflowSource = attached.workflowSource;
      }
      const gate =
        mutation.type === "update-node"
          ? mutation.gate
          : mutation.type === "add" || mutation.type === "insert-on-edge"
            ? mutation.node.gate
            : undefined;
      if (
        gate &&
        !(
          Array.isArray(draft.parsedPackage.policies) &&
          draft.parsedPackage.policies.some(
            (policy) =>
              policy &&
              typeof policy === "object" &&
              (policy as { policyId?: string }).policyId === gate.policyRef,
          )
        )
      )
        return reply
          .code(400)
          .send({ error: "authoring.gate_policy_unresolved" });
      const result = mutateAuthoringGraph(workflowSource, mutation, gate ? {
        gateTemplate: ({ nodes, edges }) => businessGateTemplate({ sourceFiles: draft.sourceFiles as Record<string, string> | undefined,
          packageDocument: draft.parsedPackage as Record<string, unknown>, workflowNodes: nodes, workflowEdges: edges, gate }),
      } : {});
      const analysis = analyzeAuthoringSources(
        packageSource,
        result.workflowSource,
      );
      const updated = await updateAuthoringSources(db, draft.draftId, {
        expectedRevision: body.expectedRevision,
        packageSource,
        workflowSource: result.workflowSource,
        parsedPackage: analysis.parsedPackage,
        parsedWorkflow: analysis.parsedWorkflow,
        ...analysis.metadata,
        diagnostics: analysis.diagnostics,
        actor: principal.subjectId,
      });
      const nodeId =
        adding &&
        (body.mutation.type === "add" ||
          body.mutation.type === "insert-on-edge")
          ? body.mutation.node.id
          : result.nodeId;
      return { draft: updated, ...(nodeId ? { nodeId } : {}) };
    } catch (error) {
      const message = error instanceof Error ? error.message : "authoring.graph_mutation_failed";
      return reply.code(message.includes("conflict") ? 409 : 400).send({ error: message });
    }
  });
  app.post<{ Params: { draftId: string } }>("/v1/authoring/drafts/:draftId/validate", async (request, reply) => {
    const principal = await requirePrincipal(request, "draft.read", { kind: "draft", id: request.params.draftId });
    const draft = await getAuthoringDraft(db, request.params.draftId, principal.tenantId);
    if (!draft) return reply.code(404).send({ error: "authoring.draft_not_found" });
    const analysis = analyzeAuthoringSources(draft.packageSource, draft.workflowSource);
    return { valid: !analysis.diagnostics.some((item) => item.severity === "error"), diagnostics: analysis.diagnostics };
  });
  app.post<{ Params: { draftId: string } }>("/v1/authoring/drafts/:draftId/compile", async (request, reply) => {
    const principal = await requirePrincipal(request, "draft.compile", { kind: "draft", id: request.params.draftId });
    try {
      let draft = await getAuthoringDraft(db, request.params.draftId, principal.tenantId);
      if (!draft) return reply.code(404).send({ error: "authoring.draft_not_found" });
      if (draft.status !== "DRAFT") return reply.code(409).send({ error: "authoring.compile_requires_draft" });
      const [registry, registeredAgents, registeredSkills] = await Promise.all([
        listRegisteredCapabilities(db), listAuthoringAgents(db), listAuthoringSkills(db),
      ]);
      const sources = materializeRegisteredContracts({
        packageSource: draft.packageSource,
        workflowSource: draft.workflowSource,
        agents: registeredAgents.filter((item) => item.agent.status === "active").map((item) => item.agent),
        skills: registeredSkills.filter((item) => item.skill.status === "active").map((item) => item.skill),
        capabilities: registry.filter((item) => item.capability.status === "active").map((item) => item.capability),
      });
      if (sources.materialized) {
        const analysis = analyzeAuthoringSources(sources.packageSource, sources.workflowSource);
        draft = await updateAuthoringSources(db, draft.draftId, {
          expectedRevision: draft.revision, packageSource: sources.packageSource, workflowSource: sources.workflowSource,
          parsedPackage: analysis.parsedPackage, parsedWorkflow: analysis.parsedWorkflow, ...analysis.metadata,
          diagnostics: analysis.diagnostics, actor: principal.subjectId,
        });
      }
      // Compile against the administered profiles, not the registry baked into the
      // image. The compiler digests each profile into the plan, so if compilation kept
      // reading the file the control panel would change what an invocation resolves
      // without changing what a plan is compiled against -- and the two would drift.
      const administered = await administeredModelProfileRegistry(adminDeps, principal.tenantId);
      const result = await compileAuthoringDraft({
        packageSource: draft.packageSource, workflowSource: draft.workflowSource,
        registryCapabilities: registry.filter((item) => item.capability.status === "active").map((item) => item.capability),
        modelProfilesPath: profilesPath,
        ...(administered ? { modelProfileRegistry: administered } : {}),
        sourceFiles: draft.sourceFiles,
      });
      if (!result.plan) return reply.code(422).send({ error: "authoring.compile_failed", diagnostics: result.diagnostics });
      return await setAuthoringLifecycle(db, draft.draftId, {
        expectedStatus: "DRAFT", status: "COMPILED", actor: principal.subjectId, compiledPlan: result.plan, diagnostics: result.diagnostics,
      });
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "authoring.compile_failed" });
    }
  });
  app.post<{ Params: { draftId: string } }>("/v1/authoring/drafts/:draftId/evaluate", async (request, reply) => {
    const principal = await requirePrincipal(request, "draft.evaluate", { kind: "draft", id: request.params.draftId });
    try {
      const draft = await getAuthoringDraft(db, request.params.draftId, principal.tenantId);
      if (!draft?.compiledPlan) return reply.code(409).send({ error: "authoring.evaluate_requires_compiled" });
      const report = evaluateCompiledPlan(draft.compiledPlan);
      if (!report.passed) return reply.code(422).send({ error: "authoring.evaluation_failed", report });
      return await setAuthoringLifecycle(db, draft.draftId, { expectedStatus: "COMPILED", status: "EVALUATED", actor: principal.subjectId, evaluationReport: report });
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : "authoring.evaluate_failed" });
    }
  });
  app.post<{ Params: { draftId: string } }>("/v1/authoring/drafts/:draftId/approve", async (request, reply) => {
    const principal = await requirePrincipal(request, "draft.approve", { kind: "draft", id: request.params.draftId });
    try {
      return await setAuthoringLifecycle(db, request.params.draftId, { expectedStatus: "EVALUATED", status: "APPROVED", actor: principal.subjectId });
    } catch (error) {
      if (error instanceof SeparationOfDutiesError) throw error;
      return reply.code(409).send({ error: error instanceof Error ? error.message : "authoring.approve_failed" });
    }
  });
  app.post<{ Params: { draftId: string } }>("/v1/authoring/drafts/:draftId/publish", async (request, reply) => {
    const principal = await requirePrincipal(request, "draft.publish", { kind: "draft", id: request.params.draftId });
    try {
      const draft = await getAuthoringDraft(db, request.params.draftId, principal.tenantId);
      if (!draft?.compiledPlan || draft.status !== "APPROVED") return reply.code(409).send({ error: "authoring.publish_requires_approved" });
      await admitPlan(db, draft.compiledPlan, principal.tenantId);
      return await setAuthoringLifecycle(db, draft.draftId, { expectedStatus: "APPROVED", status: "PUBLISHED", actor: principal.subjectId, publishedPlanDigest: draft.compiledPlan.planDigest });
    } catch (error) {
      if (error instanceof SeparationOfDutiesError) throw error;
      return reply.code(409).send({ error: error instanceof Error ? error.message : "authoring.publish_failed" });
    }
  });
  // Private broker surface. The runtime holds no signing key; it presents the grant the
  // dispatcher issued for this invocation and receives an envelope scoped to one node.
  const mintNodeEnvelope = async (tenantId: string, grant: string, body: unknown) => issueExecutionEnvelope({
    db,
    ...(executionSigner ? { envelopeSigner: executionSigner } : { envelopeSecret: envelopeSecret() }),
    grantSecret: grantSecret(),
    environment: env.RELEASE_ENVIRONMENT ?? "development",
    // Resolved per mint rather than at boot: the envelope lifetime is a live
    // security knob, and one that waits for a restart is not the one the
    // administrator set. The administered section already falls back to
    // EXECUTION_ENVELOPE_TTL_SECONDS when nothing is stored.
    envelopeTtlSeconds: (await resolveSettingSection(db, tenantId, "envelope", env)).value.ttlSeconds,
  }, grant, body);
  app.post("/v1/runtime/envelopes", async (request, reply) => {
    const runtimePrincipal = await runtimeGuard.require(request, "envelope.mint", { kind: "run" });
    const header = request.headers["x-runtime-grant"];
    const grant = (Array.isArray(header) ? header[0] : header)?.trim();
    if (!grant) return reply.code(401).send({ error: "broker.grant_missing" });
    try {
      return await mintNodeEnvelope(runtimePrincipal.tenantId, grant, request.body);
    } catch (error) {
      if (error instanceof EnvelopeBrokerError) return reply.code(error.httpStatus).send({ error: error.code });
      return reply.code(400).send({ error: error instanceof Error ? error.message : "broker.request_invalid" });
    }
  });


  // Private journalling surface. The runtime describes what happened; the control plane
  app.post("/v1/runtime/invocation-store", { bodyLimit: 4 * 1024 * 1024 }, async (request, reply) => {
    const principal = await runtimeGuard.require(request, "runtime.state.write", { kind: "run" });
    try { return await invocationStoreOperation(db, principal.tenantId, grantSecret(), request.body); }
    catch { return reply.code(409).send({ error: "runtime_invocations.operation_denied" }); }
  });

  // What a model was shown, recorded in the context store for the runtime.
  let contextStore = options.contextStore;
  const resolveContextStore = (): ContextStore | null => {
    if (contextStore !== undefined) return contextStore;
    const configured = Boolean(env.CONTEXT_DATABASE_URL);
    contextStore = configured ? createContextStore({ ...(env.CONTEXT_DATABASE_URL ? { connectionString: env.CONTEXT_DATABASE_URL } : {}), env }) : null;
    return contextStore;
  };
  app.addHook("onClose", async () => { if (contextStore && !options.contextStore) await contextStore.db.end(); });

  // Live checks of what only the control plane reaches (the Health screen).
  app.get("/v1/platform/dependencies", async (request) => {
    await requirePrincipal(request, "capability.read", { kind: "platform-health" });
    const context = { id: "context-store", name: "Context store (PostgreSQL, pgvector, AGE)", group: "store" as const };
    const runtime = { id: "runtime-host", name: "Agent runtime host", group: "runtime" as const };
    let contexts: ContextStore | null = null;
    let contextProblem = false;
    try { contexts = resolveContextStore(); } catch { contextProblem = true; }
    const provider = env.RUNTIME_PROVIDER ?? "local_http";
    const endpoint = provider === "hosted_http" ? env.RUNTIME_HOSTED_ENDPOINT : provider === "local_http" ? env.RUNTIME_LOCAL_ENDPOINT ?? "http://runtime-host-local:8088/invocations" : undefined;
    let runtimeHealth: URL | null = null;
    try { runtimeHealth = endpoint ? new URL("/health/ready", endpoint) : null; } catch { runtimeHealth = null; }
    return { components: [...await workerDependencies(env, options.fetch??globalThis.fetch,db), ...await Promise.all([
      checkDependency({ id: "control-store", name: "Control store (PostgreSQL)", group: "store" }, async () => { await db.query("select 1"); }),
      contextProblem ? Promise.resolve({ ...context, status: "Unavailable" as const, detail: "Its configuration was refused.", latencyMs: null })
        : contexts ? checkDependency(context, async () => { await contexts!.db.query("select 1"); })
          : Promise.resolve(notConfigured(context)),
      runtimeHealth ? checkDependency(runtime, httpHealthCheck(options.fetch ?? globalThis.fetch, runtimeHealth))
        : Promise.resolve({ ...runtime, status: "Unknown" as const, detail: provider === "databricks" ? "A Databricks runtime is not checked from here." : "Its address is not configured.", latencyMs: null }),
    ])] };
  });
  const requireRuntimeJournal = (request: FastifyRequest) => runtimeGuard.require(request, "runtime.state.write", { kind: "run" });
  registerSandboxObservationWrites(app, { db, env, requireRuntime: requireRuntimeJournal, grantSecret });
  registerContextRoutes(app, {
    db, store: resolveContextStore, requireRuntime: requireRuntimeJournal, grantSecret,
    observe: async (tenantId, run, pack) => {
      const observation = sandboxContextObservation(pack);
      if (observation) await recordSandboxObservation(db, tenantId, run, observation)
        .catch(() => app.log.warn("Sandbox context capture unavailable"));
    },
  });

  // Private journalling surface. The runtime describes what happened; the control plane
  // re-checks the lease and fence and decides whether to record it, so the runtime needs
  // no database credential of its own.
  app.post<{ Params: { operation: string } }>("/v1/runtime/state/:operation", async (request, reply) => {
    await runtimeGuard.require(request, "runtime.state.write", { kind: "run" });
    const operation = request.params.operation as RuntimeStateOperation;
    if (!runtimeStateOperations.includes(operation)) return reply.code(404).send({ error: "runtime_state.operation_unknown" });
    const header = request.headers["x-runtime-grant"];
    const grant = (Array.isArray(header) ? header[0] : header)?.trim();
    try {
      const { run, payload } = parseStateRequest(operation, request.body);
      await authorizeStateWrite(db, grant, grantSecret(), run);
      const { issueCaseReadEnvelope, ...write } = payload as { issueCaseReadEnvelope?: boolean; nodeId?: string };
      await applyStateWrite(db, operation, run, write);
      if (operation === "node-started" && issueCaseReadEnvelope) {
        // The node's read authority, issued under exactly the broker's rules (and its own
        // permission check) in the write that starts the node: one exchange instead of two.
        const principal = await runtimeGuard.require(request, "envelope.mint", { kind: "run" });
        const issued = await mintNodeEnvelope(principal.tenantId, grant!, {
          runId: run.runId, nodeId: write.nodeId, attempt: run.attempt,
          invocationId: `${run.runId}:${write.nodeId}:case-read:${run.attempt}`,
        });
        return reply.code(200).send({ caseReadEnvelope: issued.envelope, expiresInSeconds: issued.expiresInSeconds });
      }
      return reply.code(204).send();
    } catch (error) {
      if (error instanceof RuntimeStateAuthorityError) return reply.code(error.httpStatus).send({ error: error.code });
      if (error instanceof EnvelopeBrokerError) return reply.code(error.httpStatus).send({ error: error.code });
      const message = error instanceof Error ? error.message : "runtime_state.request_invalid";
      // A fenced write that lost its race is a denial, not a server fault.
      if (message.includes("stale_fence")) return reply.code(403).send({ error: message });
      return reply.code(400).send({ error: message });
    }
  });

  app.get<{ Querystring: { cursor?: string; limit?: string; planDigest?: string } }>("/v1/runs", async (request) => {
    const principal = await requirePrincipal(request, "run.read", { kind: "run" });
    const page = await listRunsPage(db, principal.tenantId, {
      ...(request.query.cursor ? { cursor: request.query.cursor } : {}),
      ...(request.query.limit ? { limit: Number(request.query.limit) } : {}),
      ...(request.query.planDigest ? { planDigest: request.query.planDigest } : {}),
    });
    return { runs: page.items, nextCursor: page.nextCursor };
  });
  if (env.DISCOVERY_SYNTHETIC_ENABLED === "true" && !isProductionProfile(env)
    && (env.RELEASE_ENVIRONMENT ?? "development") === "development") {
    app.post("/v1/internal/discovery/runs", async (request, reply) => {
      const principal = await runtimeGuard.require(request, "discovery.launch", { kind: "discovery" });
      const launch = z.object({ attempt: z.number().int().min(1).max(10_000), body: z.object({
        planDigest: z.string().regex(/^[a-f0-9]{64}$/), input: discoveryRunInputSchema,
      }).strict() }).strict().safeParse(request.body);
      if (!launch.success || launch.data.body.input.tenantId !== principal.tenantId
        || launch.data.body.planDigest !== env.DISCOVERY_HOSTED_PLAN_DIGEST) {
        return reply.code(403).send({ error: "discovery.launch_scope_denied" });
      }
      const { body, attempt } = launch.data;
      const plan = await getPlan(db, body.planDigest, principal.tenantId);
      if (plan?.metadata.domain !== "discovery" || plan.execution.coordinationMode !== "dataFlow") {
        return reply.code(403).send({ error: "discovery.launch_plan_denied" });
      }
      try {
        await requireExecutableRelease(db, principal.tenantId, body.planDigest, "development");
        const result = await createRun(db, { tenantId: principal.tenantId, planDigest: body.planDigest, runInput: body.input,
          idempotencyKey: `recon-${stableDigest({ body, attempt })}` });
        return reply.code(result.created ? 202 : 200).send({ runId: result.run.runId });
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("release.")) {
          return reply.code(409).send({ error: "discovery.advisory_release_unavailable" });
        }
        throw error;
      }
    });
  }

  app.post("/v1/runs", async (request, reply) => {
    const principal = request.headers["x-actor-id"] !== undefined
      ? await requirePrincipal(request, "run.start", { kind: "run" })
      : await runtimeGuard.require(request, "run.start", { kind: "run" });
    const parsed = runRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "run.request_invalid", issues: parsed.error.issues });
    if (principal.actorType === "workload" && principal.roles.includes("Integration.Dispatch")) {
      const raw = request.headers["x-integration-envelope"];
      const token = (Array.isArray(raw) ? raw[0] : raw)?.trim();
      if (!token) return reply.code(401).send({ error: "authorization.integration_envelope_required" });
      try {
        const claims = await verifyIntegrationEnvelope(token, integrationSecret());
        const identity = parsed.data.input as { tenantId?: unknown; caseId?: unknown } | null;
        if (claims.intent !== "start_run" || claims.tenant_id !== principal.tenantId
          || claims.plan_digest !== parsed.data.planDigest || claims.case_id !== identity?.caseId) {
          return reply.code(403).send({ error: "authorization.integration_envelope_mismatch" });
        }
      } catch (error) {
        if (error instanceof EnvelopeBrokerError) throw error;
        return reply.code(403).send({ error: "authorization.integration_envelope_invalid" });
      }
    }
    // Scoped read: a plan admitted in another tenant is not startable here.
    if (!await getPlan(db, parsed.data.planDigest, principal.tenantId)) return reply.code(404).send({ error: "plan.not_found" });
    const key = String(request.headers["idempotency-key"] ?? "");
    if (!key) return reply.code(400).send({ error: "run.idempotency_key_required" });
    try {
      const plan = await getPlan(db, parsed.data.planDigest, principal.tenantId);
      if (plan?.apiVersion === "harness.factory/plan-v2") {
        await requireExecutableRelease(db, principal.tenantId, plan.planDigest, env.RELEASE_ENVIRONMENT ?? "development");
        const identity = parsed.data.input as { tenantId?: unknown; caseId?: unknown } | null;
        if (!identity || identity.tenantId !== principal.tenantId || typeof identity.caseId !== "string" || !identity.caseId) {
          return reply.code(400).send({ error: "run.case_identity_invalid" });
        }
        if (plan.metadata.domain === "discovery" && !discoveryRunInputSchema.safeParse(identity).success) {
          return reply.code(400).send({ error: "discovery.advisory_input_invalid" });
        }
        // The bounded extraction plan reads a single case original under the separately
        // checked document review grant. It has no external source-policy bindings.
        const reviewedDocumentPlan = plan.planDigest === env.DOCUMENT_EXTRACTION_PLAN_DIGEST && isDocumentExtractionPlan(plan);
        if ((plan.sourceAuthorization || (!reviewedDocumentPlan && (isProductionProfile(env) || env.RELEASE_ENVIRONMENT === "production"))) && !parsed.data.sourceContextDigest) {
          return reply.code(400).send({ error: "source_policy.context_required" });
        }
      }
      const result = await createRun(db, {
        planDigest: parsed.data.planDigest, runInput: parsed.data.input, idempotencyKey: key,
        tenantId: principal.tenantId,
        ...(parsed.data.sourceContextDigest ? { sourceContextDigest: parsed.data.sourceContextDigest } : {}),
      });
      // The queue is authoritative and the dispatcher learns of the run from it (NOTIFY,
      // with its bounded poll as the fallback); a queue-depth autoscaler scales it. No
      // second call is needed, so a committed run can no longer fail on a wake signal.
      return reply.code(result.created ? 202 : 200).send(result);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("release.")) {
        return reply.code(409).send({ error: error.message });
      }
      if (error instanceof Error && error.message === "run.idempotency_conflict") {
        return reply.code(409).send({ error: error.message });
      }
      if (error instanceof Error && (error.message.startsWith("source_policy.") || error.message.startsWith("artifact."))) {
        return reply.code(error.message.includes("denied") || error.message.includes("revoked") ? 403 : 400).send({ error: error.message });
      }
      if (error instanceof Error && error.message === "run.queue_saturated") {
        reply.header("retry-after", "5");
        return reply.code(429).send({ error: error.message });
      }
      if (error instanceof Error && error.message === "run.environment_stopped") {
        return reply.code(409).send({ error: error.message });
      }
      throw error;
    }
  });
  app.get<{ Params: { runId: string } }>("/v1/runs/:runId", async (request, reply) => {
    const principal = await requirePrincipal(request, "run.read", { kind: "run", id: request.params.runId });
    const run = await getRun(db, request.params.runId, principal.tenantId);
    return run ?? reply.code(404).send({ error: "run.not_found" });
  });
  app.get<{ Params: { runId: string } }>("/v1/runs/:runId/execution", async (request, reply) => {
    const principal = await requirePrincipal(request, "run.read", { kind: "run", id: request.params.runId });
    const run = await getRun(db, request.params.runId, principal.tenantId);
    if (!run) return reply.code(404).send({ error: "run.not_found" });
    // A run reader may inspect the immutable plan bound to that run, without general plan access.
    const [plan, attempts] = await Promise.all([getPlan(db, run.planDigest, principal.tenantId), listNodeAttempts(db, run.runId)]);
    if (!plan) return reply.code(404).send({ error: "plan.not_found" });
    return { run, plan, attempts };
  });
  app.post<{ Params: { runId: string }; Body: { reason?: unknown } }>("/v1/runs/:runId/cancel", async (request, reply) => {
    const principal = await requirePrincipal(request, "run.cancel", { kind: "run", id: request.params.runId });
    const reason = typeof request.body?.reason === "string" && request.body.reason.trim()
      ? request.body.reason.trim().slice(0, 200)
      : "operator_request";
    const { outcome, run } = await requestRunCancellation(db, {
      runId: request.params.runId, tenantId: principal.tenantId, reason,
    });
    if (outcome === "not_found") return reply.code(404).send({ error: "run.not_found" });
    if (outcome === "already_terminal") return reply.code(409).send({ error: "run.already_terminal", run });
    // "requested" means a worker is still executing: its authority is revoked now, and
    // the run becomes terminal when it stops. Cancellation cannot unmake a committed
    // effect, so the two states are reported separately rather than conflated.
    return reply.code(202).send({ outcome, run });
  });

  app.get<{ Params: { traceId: string } }>("/v1/traces/:traceId/authority", async (request, reply) => {
    const principal = await requirePrincipal(request, "telemetry.read", { kind: "trace", id: request.params.traceId });
    if (principal.actorType !== "human") return reply.code(403).send({ error: "authorization.interactive_user_required" });
    if (!/^[a-f0-9]{16,32}$/.test(request.params.traceId)) return reply.code(400).send({ error: "trace.id_invalid" });
    const traceId = request.params.traceId;
    const owners = await db.query<{
      tenant_id: string;
      run_id: string;
      root_span_id: string | null;
      trace_flags: number | null;
      started_at: Date | null;
      completed_at: Date | null;
    }>(`
      select r.tenant_id, r.run_id, r.root_span_id, r.trace_flags,
             coalesce(r.started_at, r.created_at) as started_at, r.completed_at
      from harness_runtime.runs r
      where r.trace_id=$1
      union all
      select r.tenant_id, r.run_id, t.root_span_id, t.trace_flags,
             t.observed_at as started_at, r.completed_at
      from observability.trace_link t
      join harness_runtime.runs r on r.run_id=t.run_id
      where t.trace_id=$1
      limit 257
    `, [traceId]);
    if (!owners.rows.length || owners.rows.length > 256 || owners.rows.some((row) => row.tenant_id !== principal.tenantId)) {
      return reply.code(404).send({ error: "trace.not_found" });
    }
    const roots = owners.rows.flatMap(row => row.root_span_id && row.started_at ? [{
      runId: row.run_id,
      spanId: row.root_span_id.trim(),
      sampled: Boolean((row.trace_flags ?? 0) & 1),
      startedAt: row.started_at.toISOString(),
      completedAt: row.completed_at?.toISOString() ?? null,
    }] : []);
    if (!env.FOUNDRY_TRACE_BINDING_JSON) return { traceId, roots };

    try {
      const linked = await db.query<{
        parent_span_id: string;
        application_insights_resource_id: string;
        project_endpoint: string;
        agent_name: string;
        agent_version: string;
        response_id: string;
        started_at: Date;
        completed_at: Date;
      }>(`
        select f.parent_span_id, f.application_insights_resource_id, f.project_endpoint,
               f.agent_name, f.agent_version, f.response_id, f.started_at, f.completed_at
        from observability.foundry_invocation_link f
        join harness_runtime.runs r on r.run_id=f.run_id
        where f.trace_id=$1 and r.tenant_id=$2 and r.run_id=any($3::text[])
          and exists (
            select 1 from observability.trace_link t
            where t.run_id=f.run_id and t.attempt=f.attempt and t.trace_id=f.trace_id
          )
        order by f.started_at, f.invocation_id
        limit 17
      `, [traceId, principal.tenantId, [...new Set(owners.rows.map(row => row.run_id))]]);
      return { traceId, roots, foundry: linked.rows.slice(0, 16).map(row => ({
        parentSpanId: row.parent_span_id.trim(),
        applicationInsightsResourceId: row.application_insights_resource_id,
        projectEndpoint: row.project_endpoint,
        agentName: row.agent_name,
        agentVersion: row.agent_version,
        responseId: row.response_id,
        startedAt: row.started_at.toISOString(),
        completedAt: row.completed_at.toISOString(),
      })), foundryPartial: linked.rows.length > 16 };
    } catch {
      // The platform trace remains useful if native correlation evidence is unavailable.
      return { traceId, roots, foundryPartial: true };
    }
  });

  app.get<{ Params: { runId: string } }>("/v1/runs/:runId/trace", async (request, reply) => {
    const principal = await requirePrincipal(request, "telemetry.read", { kind: "run", id: request.params.runId });
    const run = await getRun(db, request.params.runId, principal.tenantId);
    if (!run) return reply.code(404).send({ error: "run.not_found" });
    if (!run.traceId || !run.rootSpanId) return reply.code(404).send({ error: "trace.not_bound" });
    return {
      traceId: run.traceId,
      rootSpanId: run.rootSpanId,
      sampled: Boolean((run.traceFlags ?? 0) & 1),
      viewerUrl: null,
    };
  });
  app.get<{ Params: { runId: string }; Querystring: { after?: string; limit?: string } }>("/v1/runs/:runId/events", async (request, reply) => {
    const principal = await requirePrincipal(request, "event.read", { kind: "run", id: request.params.runId });
    if (!await getRun(db, request.params.runId, principal.tenantId)) return reply.code(404).send({ error: "run.not_found" });
    const page = await listEventsPage(db, request.params.runId, principal.tenantId, {
      afterSequence: Number(request.query.after ?? 0),
      ...(request.query.limit ? { limit: Number(request.query.limit) } : {}),
    });
    return { events: page.items, nextCursor: page.nextCursor };
  });
  app.get<{ Params: { runId: string } }>("/v1/runs/:runId/attempts", async (request, reply) => {
    const principal = await requirePrincipal(request, "run.read", { kind: "run", id: request.params.runId });
    const run = await getRun(db, request.params.runId, principal.tenantId);
    if (!run) return reply.code(404).send({ error: "run.not_found" });
    const [attempts, humanWork] = await Promise.all([
      listNodeAttempts(db, request.params.runId),
      listHumanWorkQueue(db, principal.tenantId, { runId: request.params.runId, includeTerminal: true }),
    ]);
    const attemptedNodes = new Set(attempts.map((attempt) => attempt.nodeId));
    const humanAttempts = humanWork.flatMap((item) => {
      const constraints = item.workItem.constraints as Record<string, unknown>;
      const nodeId = typeof constraints.nodeId === "string" ? constraints.nodeId : null;
      if (!nodeId || attemptedNodes.has(nodeId)) return [];
      const status = item.workItem.status === "COMPLETED"
        ? "completed"
        : item.workItem.status === "FAILED" || item.workItem.status === "CANCELLED" || item.workItem.status === "EXPIRED"
          ? "failed"
          : "running";
      return [{
        runId: request.params.runId,
        nodeId,
        attempt: run.attempt,
        fencingEpoch: run.fencingEpoch,
        status,
        inputDigest: item.workItem.dependencyDigest,
        outputDigest: null,
        checkpointId: null,
        startedAt: item.workItem.createdAt,
        completedAt: status === "completed" ? item.workItem.terminalAt ?? item.workItem.updatedAt : null,
        errorCode: status === "failed" ? item.workItem.reasonCode : null,
        traceId: item.workItem.traceId,
        spanId: null,
        humanReview: {
          workItemId: item.workItem.workItemId,
          requiredApprovals: item.requiredApprovals,
          decisions: item.decisions.map(({ principalId, decision, reasonCode, rationale, evidenceRefs, decidedAt }) => ({
            principalId, decision, reasonCode, rationale, evidenceRefs, decidedAt,
          })),
        },
      }];
    });
    return { attempts: [...attempts, ...humanAttempts] };
  });
  app.get<{ Querystring: { runId?: string; decision?: string; limit?: string; cursor?: string; nodeId?: string; attempt?: string; fencingEpoch?: string; invocationId?: string } }>("/v1/gateway/receipts", async (request, reply) => {
    const principal = await requirePrincipal(request, "receipt.read", { kind: "receipt" });
    const decision = request.query.decision;
    if (decision && decision !== "allowed" && decision !== "denied") {
      return reply.code(400).send({ error: "gateway.decision_filter_invalid" });
    }
    const attempt = request.query.attempt === undefined ? undefined : Number(request.query.attempt);
    const fencingEpoch = request.query.fencingEpoch === undefined ? undefined : Number(request.query.fencingEpoch);
    if ([attempt, fencingEpoch].some(value => value !== undefined && (!Number.isSafeInteger(value) || value < 0))
      || (attempt !== undefined && attempt > 2_147_483_647)) {
      return reply.code(400).send({ error: "gateway.attempt_filter_invalid" });
    }
    const normalizedDecision = decision === "allowed" || decision === "denied" ? decision : undefined;
    const page = await listGatewayReceiptsPage(db, principal.tenantId, {
        ...(request.query.runId ? { runId: request.query.runId } : {}),
        ...(normalizedDecision ? { decision: normalizedDecision } : {}),
        ...(request.query.nodeId ? { nodeId: request.query.nodeId } : {}),
        ...(request.query.invocationId ? { invocationId: request.query.invocationId } : {}),
        ...(attempt !== undefined ? { attempt } : {}),
        ...(fencingEpoch !== undefined ? { fencingEpoch } : {}),
        ...(request.query.limit ? { limit: Number(request.query.limit) } : {}),
        ...(request.query.cursor ? { cursor: request.query.cursor } : {}),
    });
    return { receipts: page.items, nextCursor: page.nextCursor };
  });

  // Administered platform configuration.
  //
  // These routes write the values that used to be baked into images: model-profile
  // revisions, provider bindings, and the operational knobs each service reads. They are
  // gated on their own actions rather than on plan or run authority, because repointing a
  // provider is a different decision from admitting a plan, and no provider credential
  // passes through them -- a provider names the environment variable that holds its
  // credential, and the gateway resolves that name locally.
  app.get("/v1/admin/providers", async (request) => {
    const principal = await requirePrincipal(request, "admin.read", { kind: "provider" });
    return adminProvidersView(adminDeps, principal.tenantId);
  });
  app.put<{ Params: { providerId: string }; Body: unknown }>("/v1/admin/providers/:providerId", async (request) => {
    const principal = await requirePrincipal(request, "admin.write", { kind: "provider", id: request.params.providerId });
    const result = await writeProvider(adminDeps, {
      tenantId: principal.tenantId,
      actor: { subjectId: principal.subjectId, roles: principal.roles },
      providerId: request.params.providerId,
      body: request.body,
    });
    return result;
  });
  app.get("/v1/admin/model-profiles", async (request) => {
    const principal = await requirePrincipal(request, "admin.read", { kind: "model-profile" });
    return adminModelProfilesView(adminDeps, principal.tenantId);
  });
  app.put<{ Params: { profileId: string }; Body: unknown }>("/v1/admin/model-profiles/:profileId", async (request, reply) => {
    const principal = await requirePrincipal(request, "admin.write", { kind: "model-profile", id: request.params.profileId });
    const result = await writeModelProfile(adminDeps, {
      tenantId: principal.tenantId,
      actor: { subjectId: principal.subjectId, roles: principal.roles },
      profileId: request.params.profileId,
      body: request.body,
    });
    // A save that changed nothing is not a new revision: the digest is the identity, and
    // minting a revision per click would detach the history from what actually changed.
    return reply.code(result.created ? 201 : 200).send(result);
  });
  app.post<{ Params: { profileId: string }; Body: unknown }>("/v1/admin/model-profiles/:profileId/activate", async (request) => {
    const principal = await requirePrincipal(request, "admin.write", { kind: "model-profile", id: request.params.profileId });
    return activateModelProfile(adminDeps, {
      tenantId: principal.tenantId,
      actor: { subjectId: principal.subjectId, roles: principal.roles },
      profileId: request.params.profileId,
      body: request.body,
    });
  });
  app.get("/v1/admin/settings", async (request) => {
    const principal = await requirePrincipal(request, "admin.read", { kind: "platform-setting" });
    return adminSettingsView(adminDeps, principal.tenantId);
  });
  app.put<{ Params: { section: string }; Body: unknown }>("/v1/admin/settings/:section", async (request) => {
    const principal = await requirePrincipal(request, "admin.write", { kind: "platform-setting", id: request.params.section });
    return writeSettingSection(adminDeps, {
      tenantId: principal.tenantId,
      actor: { subjectId: principal.subjectId, roles: principal.roles },
      section: request.params.section,
      body: request.body,
    });
  });
  app.get<{ Querystring: { limit?: string } }>("/v1/admin/change-log", async (request) => {
    const principal = await requirePrincipal(request, "admin.read", { kind: "platform-setting" });
    return adminChangeLogView(adminDeps, principal.tenantId, request.query.limit ? Number(request.query.limit) : undefined);
  });

  app.addHook("onClose", async () => { if (!options.db) await db.end(); });
  return app;
}
