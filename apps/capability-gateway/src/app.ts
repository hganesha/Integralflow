import type { FoundryInvocationLink } from "@ehf/contracts/foundry";
import { FOUNDRY_AGENT_ADAPTER } from "./adapters/foundry-agent.js";
import { registerWorkbenchModels } from "./workbench.js";
import { cachedReport, overallReadiness, type DependencyComponent } from "@ehf/contracts/platform-health";
import { gatewayDependencies } from "./platform-dependencies.js";
import { registerContextSourceChecks } from "./context-source-routes.js";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import rateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import { invokeOpenSanctions, loadModelProfiles } from "@ehf/adapters";
import {
  capabilityRegistrationSchema,
  capabilityRequestSchema,
  connectorStatusSchema,
  connectorTemplateRegistrationSchema,
  checkSkillSelection,
  connectorCoverageSchema,
  evaluateConnectorCoverage,
  SKILL_COVERAGE_DENIED_PREFIX,
  skillBindingForNode,
  skillBindingsForNode,
  isDelegatedInvocationId,
  SKILL_ADAPTER_PREFIX,
  stableDigest,
  type ConnectorCoverage,
  type ConnectorStatus,
  type CapabilityDefinition,
  type CapabilityRequest,
  type CapabilityResult,
  type ExecutionEnvelopeClaims,
  type HarnessPlanV2,
} from "@ehf/contracts";
import { verifyExecutionEnvelope, mintSourceAuthorizationProof } from "@ehf/execution-auth";
import {
  AuthorizationError,
  createGuard,
  createPrivateKeyJwtSignerFromEnv,
  type PrivateKeyJwtSigner,
  envelopeVerifier,
  createWorkloadResolverFromEnv,
  DelegatedPrincipalResolver,
  serviceGrants,
  platformTenantId,
  type AuthorizationDecision,
  type Guard,
  type ServiceTokenGrant,
} from "@ehf/identity";
import {
  abandonGatewayReceipt,
  completeGatewayReceipt,
  createDatabase,
  currentFencingEpoch,
  getPlan,
  getCapabilityConnector,
  getProvider,
  getRun,
  getExecutionWorkItem,
  getSourceDecision,
  getSourceArtifact,
  listActiveModelProfiles,
  listCapabilityConnectors,
  listRegisteredCapabilities,
  recordCapabilityCost,
  registerCapability,
  reserveGatewayReceipt,
  resolveSettingSection,
  upsertCapabilityConnector,
  type Database,
} from "@ehf/persistence";
import {
  SpanKind,
  SpanStatusCode,
  context,
  extractTraceContext,
  injectTraceContext,
  recordFailure,
  trace,
  traceReference,
  withSpan,
} from "@ehf/telemetry";
import { createAdapterRegistry, kycServiceState, type AdapterInvocationContext, type DelegateEnvelope, type FinancialCrimeBinding, type FinancialCrimeExecution } from "./adapter-registry.js";
import { DOCUMENT_MODEL_ADAPTER_PREFIX, documentOfRun } from "./adapters/document-model.js";
import { createInProcessDelegation } from "./delegation.js";
import { attachSourceProvenance, createSourceTransport, sourceInvocationAuthority, sourcePolicyRequired, type SourceInvocationAuthority } from "./source-policy.js";
import { z } from "zod";

export type GatewayOptions = {
  db?: Database;
  executionSecret?: string;
  /** Replaces the in-process delegated-envelope issuer (tests). */
  delegate?: DelegateEnvelope;
  modelProfilesPath?: string;
  /** Provider transport override used by deterministic gateway tests. */
  fetch?: typeof globalThis.fetch;
  /** Callers permitted to reach this gateway, and the roles each one holds. */
  serviceGrants?: ServiceTokenGrant[];
  env?: NodeJS.ProcessEnv;
  financialCrime?: FinancialCrimeBinding;
};

/**
 * The execution envelope travels in its own header.
 *
 * Transport authorization and execution authority answer different questions -- "is this
 * workload the runtime?" and "may this run, node and attempt call these capabilities
 * right now?" -- and a deployment needs both. Sharing the Authorization header between
 * them makes it impossible to require both at once.
 */
const EXECUTION_ENVELOPE_HEADER = "x-execution-envelope";

/** The services that call the gateway, one identity each, and what each may do here. */
function serviceGrantsFromEnv(env: NodeJS.ProcessEnv): ServiceTokenGrant[] {
  return serviceGrants([
    { subjectId: "control-api", roles:["Workbench.Evaluate"],tokenEnv:"CONTROL_API_SERVICE_TOKEN" },
    { subjectId: "harness-runtime", roles: ["Capability.Invoke"], tokenEnv: "RUNTIME_SERVICE_TOKEN" },
    { subjectId: "control-surface-edge", roles: ["Edge.Delegate"], tokenEnv: "EDGE_SERVICE_TOKEN" },
    // A skill host's own workload identity; it may spend only delegated envelopes.
    { subjectId: "skill-host", roles: ["Skill.Host"], tokenEnv: "SKILL_HOST_GATEWAY_TOKEN" },
  ], env);
}

function envelopeToken(headers: Record<string, string | string[] | undefined>): string {
  const value = headers[EXECUTION_ENVELOPE_HEADER];
  const token = (Array.isArray(value) ? value[0] : value)?.trim();
  if (!token) throw new Error("gateway.execution_envelope_missing");
  return token;
}

function loadConnectorCoverageFile(path: string | undefined): ConnectorCoverage {
  if (!path?.trim()) return {};
  const parsed = connectorCoverageSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (!parsed.success) throw new Error(`gateway.connector_coverage_file_invalid:${parsed.error.issues[0]?.path.join(".") ?? ""}`);
  return parsed.data;
}

function expectedDenial(code: string): boolean {
  return code.includes("denied") || code.includes("authorization") || code.includes("stale_fence");
}

/**
 * Resolve the credential a provider binding names.
 *
 * The binding carries the *name* of an environment variable, never its value, so the
 * credential still exists only in this process. An administrator changes which credential
 * is used by naming a different variable; they cannot read or set one through the admin
 * API, and nothing in the control plane or the control surface ever holds it.
 */
function credentialFor(
  provider: { credentialRef: string | null } | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (!provider?.credentialRef) return undefined;
  const value = env[provider.credentialRef];
  return value && value.trim() ? value : undefined;
}

type OpenSanctionsProbe = {
  screeningType: "PEP" | "SANCTIONS";
  name: string;
  dateOfBirth?: string;
  country?: string;
};

function openSanctionsScope(screeningType: "PEP" | "SANCTIONS") {
  return screeningType === "PEP"
    ? { screeningType, topics: ["role.pep"] }
    : { screeningType, topics: ["sanction", "sanction.linked"] };
}

function openSanctionsProbe(body: unknown): OpenSanctionsProbe {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("gateway.opensanctions_probe_invalid");
  }
  const input = body as Record<string, unknown>;
  const screeningType = input.screeningType ?? "PEP";
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if ((screeningType !== "PEP" && screeningType !== "SANCTIONS") || !name || name.length > 200) {
    throw new Error("gateway.opensanctions_probe_invalid");
  }
  const optional = (field: "dateOfBirth" | "country") => {
    const value = input[field];
    if (value === undefined) return undefined;
    if (typeof value !== "string" || !value.trim() || value.length > 100) {
      throw new Error("gateway.opensanctions_probe_invalid");
    }
    return value.trim();
  };
  const dateOfBirth = optional("dateOfBirth");
  const country = optional("country");
  return {
    screeningType,
    name,
    ...(dateOfBirth ? { dateOfBirth } : {}),
    ...(country ? { country } : {}),
  };
}

export function buildGateway(options: GatewayOptions = {}) {
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
  const fetcher = options.fetch ?? globalThis.fetch;
  const db = options.db ?? createDatabase();
  const secret = options.executionSecret ?? (envelopeVerifier(env) === "public_key"
    ? env.EXECUTION_ENVELOPE_PUBLIC_KEY_PEM
    : env.EXECUTION_ENVELOPE_SECRET) ?? "";
  const profilesPath = options.modelProfilesPath ?? env.MODEL_PROFILES_PATH ?? "config/model-profiles.json";
  // Lowest-precedence connector coverage: a file the deployment ships (local sandbox), read
  // once at start and validated, so a malformed file stops the gateway instead of silently
  // attesting nothing. A stored or environment setting replaces it entirely.
  const fileCoverage = loadConnectorCoverageFile(env.CONNECTOR_COVERAGE_PATH);
  // Delegated envelopes are issued and verified here. With a shared secret both sides use
  // it; with key pairs the gateway signs with its own key (read on first use, so a gateway
  // that never runs a hosted skill needs none) and verifies with its public key.
  const keyPairs = envelopeVerifier(env) === "public_key";
  let delegationSigner: PrivateKeyJwtSigner | undefined;
  const delegationKey = (): PrivateKeyJwtSigner => (delegationSigner ??= createPrivateKeyJwtSignerFromEnv("DELEGATED_ENVELOPE", env));
  const delegate: DelegateEnvelope = options.delegate ?? (async (tenant, parent, request) => createInProcessDelegation({
    db, parentVerifier: secret, environment: env.RELEASE_ENVIRONMENT ?? "development",
    ...(keyPairs ? { signer: delegationKey() } : { secret }),
  })(tenant, parent, request));
  const verifyEnvelope = async (token: string): Promise<ExecutionEnvelopeClaims> => {
    try {
      const verified = await verifyExecutionEnvelope(token, secret);
      // Under key pairs the control plane never issues a delegated envelope any more.
      if (keyPairs && verified.delegated_to !== undefined) throw new Error("gateway.delegated_envelope_untrusted");
      return verified;
    } catch (error) {
      if (!keyPairs || !env.DELEGATED_ENVELOPE_PRIVATE_KEY_FILE) throw error;
      const delegated = await verifyExecutionEnvelope(token, delegationKey().publicKeyPem);
      if (delegated.delegated_to === undefined) throw new Error("gateway.delegated_envelope_required");
      return delegated;
    }
  };
  const sourceTransport = createSourceTransport(fetcher, sourcePolicyRequired(env));
  const adapterRegistry = createAdapterRegistry({ db, env, fetch: sourceTransport.fetch, modelProfilesPath: profilesPath, delegate,
    ...(options.financialCrime ? { financialCrime: options.financialCrime } : {}) });
  const workloadResolver = createWorkloadResolverFromEnv(options.serviceGrants ?? serviceGrantsFromEnv(env), env);
  const recordDecision = (decision: AuthorizationDecision) => {
    app.log.info({ authorization: decision }, "authorization decision");
    const span = trace.getActiveSpan();
    span?.setAttributes({
      "harness.authorization.outcome": decision.outcome.toUpperCase(),
      "harness.authorization.reason": decision.reasonCode,
      "harness.principal.type": decision.actorType,
    });
  };
  // Management routes are operated by a person through the control surface; capability
  // invocation is a workload path and is authorized by the execution envelope below.
  const managementGuard: Guard = createGuard({
    resolver: new DelegatedPrincipalResolver(workloadResolver),
    onDecision: recordDecision,
  });
  registerContextSourceChecks(app, { db, env, fetch: fetcher, authorize: (request, action, resource) => managementGuard.require(request, action, resource) });
  const workloadGuard: Guard = createGuard({ resolver: workloadResolver, onDecision: recordDecision });
  registerWorkbenchModels(app,{db,env,fetch:fetcher,authorize:(r,a,ref)=>workloadGuard.require(r,a,ref)});

  app.setErrorHandler((error: unknown, _request, reply) => {
    if (error instanceof Error && "statusCode" in error && error.statusCode === 429) {
      return reply.code(429).send({ error: "request.rate_limit_exceeded" });
    }
    if (error instanceof AuthorizationError) {
      return reply.code(error.httpStatus).send({ error: error.decision.reasonCode });
    }
    app.log.error(error);
    return reply.code(500).send({ error: "gateway.internal_error" });
  });

  app.get("/health/live", async () => ({ status: "ok" }));
  app.get("/health/ready", async (_request, reply) => {
    try {
      await db.query("select 1");
      const components=await dependencyReports(platformTenantId(env),()=>gatewayDependencies({db,env,fetch:fetcher},platformTenantId(env)));
      let readiness=overallReadiness(components);
      if(!secret&&readiness==="Ready")readiness="Degraded";
      if(readiness==="Ready"&&components.some(row=>row.id==="model:none"&&row.status==="NotConfigured"))readiness="Degraded";
      return reply.code(readiness==="Unavailable"?503:200).send({status:readiness.toLowerCase(),checks:components.map(row=>({name:row.name,status:row.status,detail:row.detail}))});
    } catch {return reply.code(503).send({status:"unavailable"});}
  });
  // Live checks of what only this gateway reaches (the Health screen). Model endpoints are
  // external calls, so a tenant's report is reused for a short while.
  const dependencyReports = cachedReport<DependencyComponent[]>(30_000);
  app.get("/v1/platform/dependencies", async (request) => {
    const principal = await managementGuard.require(request, "capability.read", { kind: "gateway" });
    return { components: await dependencyReports(principal.tenantId, () => gatewayDependencies({ db, env, fetch: fetcher }, principal.tenantId)) };
  });
  app.get("/v1/status", async (request) => {
    const principal=await managementGuard.require(request,"capability.read",{kind:"gateway"});
    const [dependencies,metrics,profiles]=await Promise.all([
      dependencyReports(principal.tenantId,()=>gatewayDependencies({db,env,fetch:fetcher},principal.tenantId)),
      db.query<{calls:string;denials:string}>(`select count(*)::text as calls,count(*) filter(where decision='denied')::text as denials from harness_gateway.receipts where tenant_id=$1 and created_at>=now()-interval '24 hours'`,[principal.tenantId]).catch(()=>null),
      listActiveModelProfiles(db,principal.tenantId).catch(()=>[]),
    ]);
    const providers=await Promise.all(profiles.map(profile=>getProvider(db,principal.tenantId,profile.profile.provider)));
    const recorded=providers.length>0&&providers.every(provider=>provider?.kind==='recorded');
    const modelRows=dependencies.filter(row=>row.id.startsWith('model:'));
    const generatedAt=new Date().toISOString();
    return {readiness:secret?overallReadiness(dependencies):'Degraded',
      openRouterState:recorded||modelRows.some(row=>row.status==='Ready')?'Configured':modelRows.some(row=>row.status==='Unavailable')?'Unreachable':'Missing',
      openSanctionsState:env.OPENSANCTIONS_API_KEY?'Configured':'Missing',
      kycWiringState:kycServiceState(env,'wiring'),evidencePipelineState:kycServiceState(env,'evidence'),
      runtimeMode:recorded?'Recorded':providers.length||env.OPENROUTER_API_KEY?'Live':'Unknown',
      envelopeVerifierStatus:secret?(keyPairs?'Configured · public-key execution envelopes':'Configured · HMAC-SHA256 execution envelopes'):'Not configured',
      calls24h:metrics?.rows[0]?Number(metrics.rows[0].calls):null,denials24h:metrics?.rows[0]?Number(metrics.rows[0].denials):null,
      generatedAt,telemetryFreshThrough:metrics?.rows[0]?generatedAt:null};
  });
  /**
   * The profiles this gateway would resolve for a new compilation.
   *
   * The administered store is the authority. The JSON registry answers only when the
   * store holds nothing for the tenant, which is the window between a fresh database and
   * the seeding migration; `source` says which one answered so the control surface never
   * presents a file-derived profile as an administered one.
   */
  app.get("/v1/model-profiles", async (request) => {
    const principal = await managementGuard.require(request, "capability.read", { kind: "model-profile" });
    const administered = await listActiveModelProfiles(db, principal.tenantId);
    if (administered.length === 0) {
      return { source: "registry-file", profiles: await loadModelProfiles(profilesPath) };
    }
    const providers = new Map(await Promise.all(
      [...new Set(administered.map((record) => record.profile.provider))]
        .map(async (id) => [id, await getProvider(db, principal.tenantId, id)] as const),
    ));
    return {
      source: "admin-store",
      profiles: administered.map((record) => ({
        ...record.profile,
        revision: record.revision,
        digest: record.digest,
        updatedAt: record.createdAt,
        updatedBy: record.createdBy,
        providerKind: providers.get(record.profile.provider)?.kind ?? null,
        providerStatus: providers.get(record.profile.provider)?.status ?? "missing",
        credentialState: credentialFor(providers.get(record.profile.provider)) ? "Configured" : "Missing",
      })),
    };
  });
  app.get("/v1/capabilities", async (request) => {
    await managementGuard.require(request, "capability.read", { kind: "capability" });
    return { capabilities: await listRegisteredCapabilities(db) };
  });
  // The connector registry: which adapter bindings can serve each canonical capability.
  app.get("/v1/connectors", async (request, reply) => {
    await managementGuard.require(request, "capability.read", { kind: "capability" });
    const query = (request.query ?? {}) as Record<string, unknown>;
    const text = (name: string, max = 300) => {
      const value = query[name];
      if (value === undefined) return undefined;
      if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error("gateway.connector_query_invalid");
      return value.trim();
    };
    try {
      const limit = text("limit", 4);
      if (limit !== undefined && !/^[0-9]+$/.test(limit)) throw new Error("pagination.limit_invalid");
      const status = text("status", 20);
      if (status !== undefined && !connectorStatusSchema.safeParse(status).success) throw new Error("gateway.connector_status_invalid");
      const bindable = text("bindable", 5);
      if (bindable !== undefined && bindable !== "true" && bindable !== "false") throw new Error("gateway.connector_query_invalid");
      const page = await listCapabilityConnectors(db, {
        ...(text("capabilityId") ? { capabilityId: text("capabilityId")! } : {}),
        // v2 canonical routing lookups: which connectors serve a canonical key or jurisdiction.
        ...(text("jurisdiction", 40) ? { jurisdiction: text("jurisdiction", 40)! } : {}),
        ...(text("canonicalCapabilityId") ? { canonicalCapabilityId: text("canonicalCapabilityId")! } : {}),
        ...(bindable === "true" ? { bindable: true } : {}),
        ...(text("adapterId") ? { adapterId: text("adapterId")! } : {}),
        ...(text("providerId") ? { providerId: text("providerId")! } : {}),
        ...(status ? { status: status as ConnectorStatus } : {}),
        ...(limit ? { limit: Number(limit) } : {}),
        ...(text("cursor", 2_000) ? { cursor: text("cursor", 2_000)! } : {}),
      });
      return { connectors: page.items, nextCursor: page.nextCursor };
    } catch (error) {
      const code = error instanceof Error ? error.message : "gateway.connector_query_invalid";
      if (code.startsWith("pagination.") || code.startsWith("gateway.connector_") || code.startsWith("connector.")) return reply.code(400).send({ error: code });
      throw error;
    }
  });
  app.get<{ Params: { connectorId: string } }>("/v1/connectors/:connectorId", async (request, reply) => {
    await managementGuard.require(request, "capability.read", { kind: "capability" });
    const connector = await getCapabilityConnector(db, request.params.connectorId);
    if (!connector) return reply.code(404).send({ error: "gateway.connector_not_found" });
    return connector;
  });
  // A concrete connector from an adapter's connector template (Databricks, HTTP operations): the
  // binding is deployment-specific, so it is validated against the template's pattern and the
  // adapter must be enabled here. Same authority as maintaining capability definitions.
  app.post("/v1/connectors", async (request, reply) => {
    const action = env.AUTHORING_MODE === "disabled" ? "admin.write" : "capability.register";
    await managementGuard.require(request, action, { kind: "capability" });
    const parsed = connectorTemplateRegistrationSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "gateway.connector_registration_invalid" });
    const body = parsed.data;
    try {
      const module = adapterRegistry.assertConnectorFromTemplate(body.adapterId, body.binding, body.capabilityId);
      const result = await upsertCapabilityConnector(db, {
        connectorId: `${body.adapterId}:${body.binding}`,
        adapterId: body.adapterId,
        providerId: body.providerId ?? module.cloud,
        providerName: body.providerName ?? module.label,
        capabilityId: body.capabilityId,
        operation: body.binding,
        resultFamily: null,
        status: body.status,
        demoSupported: false,
        liveBlockers: body.liveBlockers,
        source: { catalog: "ehfconcept/platform", revision: `connector-template:${body.adapterId}` },
      });
      return reply.code(result.created ? 201 : 200).send(result.record);
    } catch (error) {
      const code = error instanceof Error ? error.message : "gateway.connector_registration_invalid";
      if (code.startsWith("gateway.connector_") || code.startsWith("connector.")) {
        return reply.code(code === "gateway.connector_adapter_disabled" ? 409 : 400).send({ error: code });
      }
      throw error;
    }
  });
  app.get("/v1/adapters", async (request) => {
    const principal = await managementGuard.require(request, "capability.read", { kind: "adapter" });
    // `adapters`: what this gateway can execute now. `modules`: every loadable adapter module,
    // with its cloud, whether GATEWAY_ADAPTERS enables it, and its connector template.
    return { adapters: await adapterRegistry.listDescriptors(principal.tenantId), modules: adapterRegistry.listModules() };
  });
  app.post("/v1/capabilities", async (request, reply) => {
    // Capability definitions are administered runtime configuration. Authors may maintain
    // the registry on an authoring-enabled stamp; an operations-only stamp requires the
    // narrower Platform.Admin authority instead, so disabling authoring does not freeze
    // endpoint operations or accidentally preserve Harness.Author write access.
    const action = env.AUTHORING_MODE === "disabled" ? "admin.write" : "capability.register";
    const principal = await managementGuard.require(request, action, { kind: "capability" });
    try {
      const capability = capabilityRegistrationSchema.parse(request.body);
      if (capability.status === "active") await adapterRegistry.assertSupported(capability, principal.tenantId);
      const result = await registerCapability(db, capability);
      return reply.code(result.created ? 201 : 200).send(result);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "capability.registration_invalid" });
    }
  });
  app.post("/v1/openrouter/test", async (request, reply) => {
    await managementGuard.require(request, "capability.read", { kind: "provider-probe" });
    const started = Date.now();
    const testedAt = new Date().toISOString();
    if (!env.OPENROUTER_API_KEY) {
      return {
        status: "Recorded",
        credentialState: "Missing",
        latencyMs: Date.now() - started,
        testedAt,
        message: "OPENROUTER_API_KEY is not configured; deterministic recorded adapter remains available.",
      };
    }
    try {
      const response = await fetcher("https://openrouter.ai/api/v1/models", {
        headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`openrouter.http_${response.status}`);
      return {
        status: "Ready",
        credentialState: "Configured",
        latencyMs: Date.now() - started,
        testedAt,
        message: "OpenRouter catalog and credential probe succeeded; credential value remained server-side.",
      };
    } catch (error) {
      return reply.code(503).send({
        status: "Unavailable",
        credentialState: "Configured",
        latencyMs: Date.now() - started,
        testedAt,
        message: error instanceof Error ? error.message : "openrouter.test_failed",
      });
    }
  });

  app.post("/v1/opensanctions/test", async (request, reply) => {
    await managementGuard.require(request, "capability.read", { kind: "provider-probe" });
    const started = Date.now();
    const testedAt = new Date().toISOString();
    if (!env.OPENSANCTIONS_API_KEY) {
      return reply.code(503).send({
        status: "Unavailable",
        credentialState: "Missing",
        latencyMs: Date.now() - started,
        testedAt,
        message: "OPENSANCTIONS_API_KEY is not configured; live screening is unavailable.",
      });
    }
    try {
      const probe = openSanctionsProbe(request.body);
      const adapter = await invokeOpenSanctions({
        input: {
          name: probe.name,
          ...(probe.dateOfBirth ? { dateOfBirth: probe.dateOfBirth } : {}),
          ...(probe.country ? { country: probe.country } : {}),
        },
        apiKey: env.OPENSANCTIONS_API_KEY,
        ...openSanctionsScope(probe.screeningType),
        fetch: sourceTransport.fetch,
        ...(env.OPENSANCTIONS_API_URL ? { apiUrl: env.OPENSANCTIONS_API_URL } : {}),
        ...(env.OPENSANCTIONS_DATASET ? { dataset: env.OPENSANCTIONS_DATASET } : {}),
        ...(env.OPENSANCTIONS_MATCH_THRESHOLD
          ? { threshold: Number(env.OPENSANCTIONS_MATCH_THRESHOLD) }
          : {}),
      });
      const output = adapter.output && typeof adapter.output === "object"
        ? adapter.output as Record<string, unknown>
        : {};
      const alerts = Array.isArray(output.alerts) ? output.alerts : [];
      const acceptedMatchCount = alerts.filter((alert) =>
        Boolean(alert && typeof alert === "object" && (alert as Record<string, unknown>).acceptedByMatcher === true)).length;
      return {
        status: "Ready",
        credentialState: "Configured",
        provider: adapter.provider,
        dataset: adapter.model.replace(/^match\//, ""),
        screeningType: probe.screeningType,
        matchCount: alerts.length,
        acceptedMatchCount,
        providerRequestId: adapter.providerRequestId,
        latencyMs: Date.now() - started,
        testedAt,
        message: "OpenSanctions match and credential probe succeeded; subject details and credential remained server-side.",
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "opensanctions.test_failed";
      const invalid = message === "gateway.opensanctions_probe_invalid";
      return reply.code(invalid ? 400 : 503).send({
        status: invalid ? "Invalid" : "Unavailable",
        credentialState: "Configured",
        latencyMs: Date.now() - started,
        testedAt,
        message,
      });
    }
  });

  app.post("/v1/evidence/use", async (request, reply) => {
    const principal = await workloadGuard.require(request, "capability.read", { kind: "capability" });
    try {
      const claims = await verifyExecutionEnvelope(envelopeToken(request.headers), secret);
      const { decisionIds } = z.object({ decisionIds: z.array(z.string().min(1).max(200)).min(1).max(300) }).strict().parse(request.body);
      // This endpoint returns use decisions only. Case/graph controls separately authorize the data read.
      if (claims.tenant_id !== principal.tenantId || claims.delegated_to || !claims.case_id) throw new Error("gateway.source_policy_denied:evidence_read_authority_missing");
      if (await currentFencingEpoch(db, claims.run_id) !== claims.fencing_epoch) throw new Error("gateway.stale_fence");
      const run = await getRun(db, claims.run_id, principal.tenantId);
      const plan = await getPlan(db, claims.plan_digest, principal.tenantId);
      const permission = plan?.permissionEnvelopes.find((item) => item.nodeId === claims.node_id);
      if (!run || !plan || run.planDigest !== claims.plan_digest || permission?.digest !== claims.permission_digest) throw new Error("gateway.source_policy_denied:run_authority_mismatch");
      const decisions = [];
      for (const decisionId of [...new Set(decisionIds)]) {
        const prior = await getSourceDecision(db, principal.tenantId, decisionId);
        if (prior.stage !== "use" || prior.decision.outcome !== "ALLOW" || !prior.decision.contextDigest) throw new Error("gateway.source_policy_denied:evidence_provenance_missing");
        // Historical acquisition approval need not remain active; current source/access policy must.
        const priorContext = await getSourceArtifact(db, principal.tenantId, "source-context", prior.decision.contextDigest, false);
        if (priorContext.kind !== "source-context" || priorContext.caseId !== claims.case_id) throw new Error("gateway.source_policy_denied:evidence_case_mismatch");
        const capability = plan.capabilities.find((item) => item.id === prior.capabilityId);
        if (!capability || !plan.sourceAuthorization?.bindings.some((pin) => pin.capabilityId === prior.capabilityId && pin.connectorId === prior.connectorId && pin.bindingDigest === prior.decision.bindingDigest)) throw new Error("gateway.source_policy_denied:evidence_binding_unpinned");
        const authority = sourceInvocationAuthority(db, { tenantId: principal.tenantId, caseId: claims.case_id, runId: claims.run_id,
          invocationId: `${claims.jti}:evidence-use:${decisionId}`, contextDigest: run.sourceContextDigest, plan, capability: { ...capability, adapterBindingId: prior.connectorId } });
        const current = await authority.reuse(prior.observation ?? undefined);
        decisions.push({ originalDecisionId: decisionId, decisionId: current.decisionId, validUntil: current.decision.validUntil });
      }
      return { authorized: true, decisions };
    } catch (error) {
      return reply.code(403).send({ error: error instanceof Error && error.message.startsWith("gateway.") ? error.message : "gateway.source_policy_denied:evidence_use_unavailable" });
    }
  });

  app.post("/v1/invoke", async (request, reply) => {
    const parent = extractTraceContext(request.headers as Record<string, string | string[] | undefined>);
    return withSpan("capability.invoke", {
      kind: SpanKind.SERVER,
      attributes: { "http.request.method": "POST", "http.route": "/v1/invoke" },
    }, async (span) => {
      const started = Date.now();
      let claims!: ExecutionEnvelopeClaims;
      let envelope = "";
      let delegated = false;
      let tenantId = "";
      let invocation!: CapabilityRequest;
      let plan!: HarnessPlanV2;
      let capability!: CapabilityDefinition;
      let reservedInvocation: { invocationId: string; runId: string } | null = null;
      let providerReturned = false;
      let foundryInvocationDispatched = false;
      let foundryInvocationLink: FoundryInvocationLink | undefined;
      let financialCrimeExecution: FinancialCrimeExecution | undefined;
      let runDocument: AdapterInvocationContext["runDocument"];
      let sourceAuthority: SourceInvocationAuthority | undefined;
      let sourceAcquisition: Awaited<ReturnType<SourceInvocationAuthority["acquire"]>> | undefined;
      let evidenceUseDecisionId: string | undefined;
      let evidenceUseValidUntil: string | undefined;
      try {
        const authSpan = trace.getTracer("harness.gateway", "0.1.0").startSpan(
          "authorization.evaluate", { kind: SpanKind.INTERNAL }, context.active(),
        );
        try {
          // Both credentials are required: the workload token says which service is
          // calling, the envelope says what this run, node and attempt may do right now.
          const workload = await workloadGuard.require(request, "capability.read", { kind: "capability" });
          tenantId = workload.tenantId;
          envelope = envelopeToken(request.headers);
          claims = await verifyEnvelope(envelope);
          if (claims.tenant_id !== tenantId) throw new Error("gateway.tenant_denied");
          invocation = capabilityRequestSchema.parse(request.body);
          delegated = claims.delegated_to !== undefined;
          // A delegated envelope (skill.execution.v1 §6.1) is presented only by a skill host,
          // which holds nothing else; a skill host cannot spend a node envelope.
          const skillHost = workload.roles.includes("Skill.Host");
          if (delegated && !skillHost) throw new Error("gateway.delegated_envelope_caller_denied");
          if (!delegated && skillHost && !workload.roles.includes("Capability.Invoke")) throw new Error("gateway.skill_host_envelope_denied");
          if (delegated) {
            if (claims.tenant_id !== tenantId) throw new Error("gateway.tenant_denied");
            // One delegated envelope covers the skill execution's dependency calls, each with its
            // own receipt: `<execution_id>:<key>`, the execution id being the parent's jti.
            if (!isDelegatedInvocationId(claims.parent_jti!, invocation.invocationId)) throw new Error("gateway.invocation_mismatch");
            if (invocation.skill) throw new Error("gateway.skill_selection_denied");
          } else if (claims.jti !== invocation.invocationId) {
            throw new Error("gateway.invocation_mismatch");
          }
          if (!claims.capabilities.includes(invocation.capabilityId)) throw new Error("gateway.capability_denied");
          if (!claims.effects.includes(invocation.effect)) throw new Error("gateway.effect_denied");
          const epoch = await currentFencingEpoch(db, claims.run_id);
          if (epoch !== claims.fencing_epoch) throw new Error("gateway.stale_fence");
          const admittedPlan = await getPlan(db, claims.plan_digest, tenantId);
          if (!admittedPlan) throw new Error("gateway.plan_not_admitted");
          plan = admittedPlan;
          const permission = plan.permissionEnvelopes.find((item) => item.nodeId === claims.node_id);
          const resolved = plan.capabilities.find((item) => item.id === invocation.capabilityId);
          if (!permission || permission.digest !== claims.permission_digest) throw new Error("gateway.permission_mismatch");
          if (!permission.capabilities.includes(invocation.capabilityId)) throw new Error("gateway.capability_denied");
          if (!permission.effects.includes(invocation.effect)) throw new Error("gateway.effect_denied");
          if (!resolved || resolved.effect !== invocation.effect) throw new Error("gateway.capability_contract_mismatch");
          capability = resolved;
          // A call to one of a skill-bound node's pinned candidates must say which candidate
          // it serves, so the binding's policy below cannot be skipped by omitting it.
          // That includes an agent loop's skills: each is a pinned binding of this node too.
          if (!delegated && !invocation.skill
            && skillBindingsForNode(plan, claims.node_id).some((pinned) => pinned.candidates.some((item) => item.capabilityId === invocation.capabilityId))) {
            throw new Error("gateway.skill_selection_denied");
          }
          if (invocation.skill) {
            // A skill-bound call names the pinned candidate it serves. It must be exactly a
            // candidate of the admitted plan's binding for this node; the call then goes to
            // that candidate's pinned connector, which may differ from the capability's
            // default binding (an equivalent-coverage fallback).
            let candidate;
            try {
              candidate = checkSkillSelection(plan, claims.node_id, invocation.capabilityId, invocation.skill);
            } catch {
              throw new Error("gateway.skill_selection_denied");
            }
            if (candidate.connectorId !== resolved.adapterBindingId) {
              capability = { ...resolved, adapterBindingId: candidate.connectorId };
            }
            // The binding's resolution policy (spec §9): the selected connector must be
            // entitled for this tenant, cover the subject's jurisdiction and screen current
            // lists, as the operator attests per tenant. Refused before any provider call;
            // the runtime then tries its next pinned candidate.
            if (!plan.sourceAuthorization && !sourcePolicyRequired(env)) {
              const policy = skillBindingForNode(plan, claims.node_id, invocation.skill.skillId)!.policy;
              const gatewaySettings = await resolveSettingSection(db, claims.tenant_id, "gateway", env);
              const coverage = gatewaySettings.source === "default" ? fileCoverage : gatewaySettings.value.connectorCoverage;
              const verdict = evaluateConnectorCoverage({
                coverage, connectorId: candidate.connectorId, policy, jurisdiction: invocation.skill.jurisdiction ?? null, now: new Date(),
              });
              if (!verdict.eligible) throw new Error(`${SKILL_COVERAGE_DENIED_PREFIX}${verdict.reason}`);
            }
          }
          // Sub-skills run in-process in the host (§5): a skill never calls a skill through the gateway.
          if (delegated && capability.adapterBindingId.startsWith(SKILL_ADAPTER_PREFIX)) throw new Error("gateway.delegated_skill_call_denied");
          const run = await getRun(db, claims.run_id, tenantId);
          if (!run) throw new Error("gateway.run_not_found");
          if (run.planDigest !== plan.planDigest) throw new Error("gateway.run_plan_denied");
          // The document-model connector reads one original: the one this run was started with, by an admitted
          // adjudicated document pipeline whose start the case store authorized. Nothing else reaches raw evidence.
          if (capability.adapterBindingId.startsWith(DOCUMENT_MODEL_ADAPTER_PREFIX)) runDocument = documentOfRun(plan, run.input);
          // Irreversible business effects in a v2 plan leave through the policy-owned
          // case outbox. A workflow envelope (including a human-approved skill) is not
          // permission to invoke the external sink directly.
          if (["external","destructive"].includes(capability.effect)
            && (sourcePolicyRequired(env) || plan.graph.nodes.some(node=>node.config.businessDecision==="v2"))) throw new Error("gateway.policy_action_grant_denied");
          const sourceClass = adapterRegistry.sourcePolicyClass(capability);
          const sourceRequired = sourcePolicyRequired(env) || Boolean(plan.sourceAuthorization);
          if (sourceRequired && sourceClass === "synthetic") throw new Error("gateway.source_policy_denied:synthetic_source_forbidden");
          if (sourceRequired && (sourceClass === "external" || plan.sourceAuthorization?.bindings.some((pin) => pin.capabilityId === capability.id && pin.connectorId === capability.adapterBindingId))) {
            sourceAuthority = sourceInvocationAuthority(db, { tenantId, caseId: claims.case_id ?? "", runId: claims.run_id,
              invocationId: invocation.invocationId, contextDigest: run.sourceContextDigest, plan, capability });
            sourceAcquisition = await sourceAuthority.acquire();
          }
          if (capability.adapterBindingId.startsWith("financial-crime:")) {
            const work = claims.work_item_id ? await getExecutionWorkItem(db, tenantId, claims.work_item_id) : null;
            const node = plan.graph.nodes.find(n => n.id === claims.node_id);
            if (claims.tenant_id !== tenantId || !claims.case_id || work?.caseId !== claims.case_id || work.status !== "RUNNING"
              || !work.lease || work.lease.fencingEpoch !== claims.work_fencing_epoch || Date.parse(work.lease.leaseUntil) <= Date.now()
              || run.status !== "running" || typeof node?.config.fincrimeTaskId !== "string") throw new Error("fincrime.execution_authority_required");
            if(typeof node.config.fincrimeCatalogDigest!=='string' || node.config.fincrimeCatalogDigest!==options.financialCrime?.catalogDigest) throw new Error('fincrime.catalog_not_admitted');
            financialCrimeExecution = { tenantId, caseId: claims.case_id, runId: claims.run_id, nodeId: claims.node_id,
              workItemId: work.workItemId, executionId: work.lease.executionId, runFencingEpoch: claims.fencing_epoch,
              workFencingEpoch: work.lease.fencingEpoch, planDigest: claims.plan_digest, taskId: node.config.fincrimeTaskId,catalogDigest:node.config.fincrimeCatalogDigest };
          }
          authSpan.setAttributes({
            "harness.authorization.outcome": "ALLOWED",
            "harness.authorization.reason": delegated ? "permission.delegated_envelope_allowed" : "permission.envelope_allowed",
            "harness.capability.effect": capability.effect,
          });
          authSpan.setStatus({ code: SpanStatusCode.OK });
        } catch (error) {
          const message = error instanceof Error ? error.message : "gateway.unknown";
          if (expectedDenial(message)) {
            authSpan.setStatus({ code: SpanStatusCode.OK });
            authSpan.setAttributes({ "harness.authorization.outcome": "DENIED", "harness.authorization.reason": message });
          } else {
            recordFailure(authSpan, error);
          }
          throw error;
        } finally {
          authSpan.end();
        }

        span.setAttributes({
          "harness.execution.id": claims.run_id,
          "harness.node.id": claims.node_id,
          "harness.execution.attempt": claims.attempt,
          "harness.capability.id": invocation.capabilityId,
          "harness.capability.effect": invocation.effect,
          "harness.plan.digest_prefix": claims.plan_digest.slice(0, 12),
          "harness.provider.binding_digest_prefix": stableDigest(capability.adapterBindingId).slice(0, 12),
        });
        const spanRef = traceReference(span);
        const requestDigest = stableDigest(invocation);
        const reserved = await reserveGatewayReceipt(db, {
          invocationId: invocation.invocationId,
          runId: claims.run_id,
          nodeId: claims.node_id,
          attempt: claims.attempt,
          fencingEpoch: claims.fencing_epoch,
          planDigest: claims.plan_digest,
          permissionDigest: claims.permission_digest,
          capabilityId: invocation.capabilityId,
          effect: invocation.effect,
          decision: "allowed",
          reasonCode: delegated ? `permission.delegated_envelope_allowed:${claims.delegated_to}` : "permission.envelope_allowed",
          requestDigest,
          traceId: spanRef.traceId,
          spanId: spanRef.spanId,
          ...(invocation.skill ? { skillSelection: invocation.skill } : {}),
          ...(sourceAcquisition ? { sourceDecisionId: sourceAcquisition.decisionId } : {}),
          budget: {
            modelCall: capability.kind === "model",
            maxCapabilityCalls: plan.budgets.maxCapabilityCalls,
            maxModelCalls: plan.budgets.maxModelCalls,
            maxCostUsd: plan.budgets.maxCostUsd,
          },
        });
        if (!reserved.created) {
          span.setAttribute("harness.gateway.receipt_replayed", true);
          if (reserved.result) {
            if (sourceAuthority && reserved.result.status === "succeeded") {
              if (!reserved.result.evidenceUseDecisionId) throw new Error("gateway.source_policy_denied:cached_evidence_provenance_missing");
              const prior = await getSourceDecision(db, tenantId, reserved.result.evidenceUseDecisionId);
              if (prior.decision.outcome !== "ALLOW" || prior.stage !== "use" || prior.decision.bindingDigest !== sourceAcquisition?.decision.bindingDigest) throw new Error("gateway.source_policy_denied:cached_evidence_scope_mismatch");
              const reuse = await sourceAuthority.reuse(prior.observation ?? undefined);
              const { receiptDigest: _originalDigest, ...original } = reserved.result;
              const unsigned = { ...original, evidenceUseDecisionId: reuse.decisionId };
              return { ...unsigned, receiptDigest: stableDigest(unsigned) };
            }
            return reserved.result;
          }
          return reply.code(409).send({ error: "gateway.invocation_in_progress" });
        }
        reservedInvocation = { invocationId: invocation.invocationId, runId: claims.run_id };

        const operationName = capability.kind === "model" ? "model.inference" : "tool.execution";
        const foundryAgent = capability.adapterBindingId.startsWith(`${FOUNDRY_AGENT_ADAPTER}:`);
        const adapter = await withSpan(operationName, {
          kind: SpanKind.CLIENT,
          attributes: {
            "gen_ai.operation.name": foundryAgent ? "invoke_agent" : capability.kind === "model" ? "chat" : "execute_tool",
            ...(capability.kind === "model"
              ? { "gen_ai.request.model": capability.adapterBindingId.replace(/^openrouter:/, "") }
              : { "gen_ai.tool.name": capability.id }),
            "harness.capability.id": capability.id,
            "harness.capability.effect": capability.effect,
            "harness.provider.binding_digest_prefix": stableDigest(capability.adapterBindingId).slice(0, 12),
            ...(capability.kind === "model"
              ? { "harness.model.profile": capability.adapterBindingId.replace(/^openrouter:/, "") }
              : {}),
          },
        }, async (providerSpan) => {
          // Only administered model profiles carry a pinned digest; a cloud model connector
          // (databricks-serving) is pinned by its binding.
          const profileId = capability.kind === "model" && capability.adapterBindingId.startsWith("openrouter:")
            ? capability.adapterBindingId.replace(/^openrouter:/, "")
            : null;
          // Only the skills adapter acts beyond one provider call on the caller's behalf, so only
          // it receives the verified envelope, the plan and a cancellation signal.
          let execution: AdapterInvocationContext["execution"];
          if (capability.adapterBindingId.startsWith(SKILL_ADAPTER_PREFIX)) {
            const carrier: Record<string, string> = {};
            injectTraceContext(carrier);
            const abort = new AbortController();
            reply.raw.once("close", () => { if (!reply.raw.writableFinished) abort.abort(); });
            execution = {
              envelope, claims, plan, signal: abort.signal,
              ...(carrier.traceparent ? { traceparent: carrier.traceparent } : {}),
            };
          }
          const foundrySignal = foundryAgent ? new AbortController() : undefined;
          if (foundrySignal) {
            reply.raw.once("close", () => { if (!reply.raw.writableFinished) foundrySignal.abort(); });
          }
          const response = await sourceTransport.run(sourceAuthority?.checkTransport, () => adapterRegistry.invoke(capability, invocation.input, {
            tenantId,
            invocationId: invocation.invocationId,
            ...(foundrySignal ? {
              signal: foundrySignal.signal,
              onFoundryDispatch: () => { foundryInvocationDispatched = true; },
              recordFoundryInvocationLink: (link: FoundryInvocationLink) => { foundryInvocationLink = link; },
            } : {}),
            ...(execution ? { execution } : {}),
            ...(financialCrimeExecution ? { financialCrimeExecution } : {}),
            ...(runDocument ? { runDocument } : {}),
            ...(sourceAcquisition ? { sourceAuthorization: {
              checkEndpoint: sourceAuthority!.checkTransport,
              purpose: sourceAcquisition.context.purpose, legalBasis: sourceAcquisition.access.legalBasisRef,
              policyId: sourceAcquisition.policies[0]!.id, policyVersion: sourceAcquisition.policies[0]!.version,
              jurisdictions: [sourceAcquisition.binding.jurisdiction.toUpperCase()], processingRegions: sourceAcquisition.binding.processingRegions,
              datasetIds: sourceAcquisition.decision.obligations.datasetIds,
              bindingDatasetIds: sourceAcquisition.binding.datasetIds,
              signRequest: (body: string) => {
                if (!env.SOURCE_AUTHORIZATION_SIGNING_KEY) throw new Error("gateway.source_policy_denied:wiring_signer_missing");
                const currentAuthority = sourceAuthority!.acquire();
                return currentAuthority.then((current) => mintSourceAuthorizationProof({ secret: env.SOURCE_AUTHORIZATION_SIGNING_KEY!, tenantId: env.KYC_WIRING_TENANT_ID?.trim() || "demo-tenant",
                operationId: capability.adapterBindingId.replace(/^wiring:/, ""), requestDigest: createHash("sha256").update(body).digest("hex"),
                decisionId: current.decisionId, expiresAt: current.decision.validUntil,
                scope: { approved_endpoints: sourceAcquisition!.binding.approvedEndpoints, processing_regions: sourceAcquisition!.binding.processingRegions,
                  storage_regions: sourceAcquisition!.binding.storageRegions, subprocessors: sourceAcquisition!.binding.subprocessors,
                  dataset_ids: sourceAcquisition!.decision.obligations.datasetIds, purpose: sourceAcquisition!.context.purpose,
                  legal_basis: sourceAcquisition!.access.legalBasisRef, policy_refs: sourceAcquisition!.policies.map((policy) => `${policy.id}:${policy.version}`),
                  binding_digest: sourceAcquisition!.decision.bindingDigest, access_digest: sourceAcquisition!.decision.accessDigest,
                  policy_digests: sourceAcquisition!.decision.policyDigests, context_digest: sourceAcquisition!.decision.contextDigest,
                  upstream_contract_digest: sourceAcquisition!.binding.upstreamContractDigest ?? null } }));
              },
            } } : {}),
            ...(profileId
              ? { expectedModelProfileDigest: plan.modelProfiles.find((item) => item.id === profileId)?.digest ?? null }
              : {}),
            recordAttributes: (attributes) => providerSpan.setAttributes(attributes),
          }));
          providerSpan.setAttributes({
            "harness.provider": response.provider,
            "harness.model.id": response.model,
            "harness.outcome": "SUCCEEDED",
            ...(response.inputTokens === null ? {} : { "gen_ai.usage.input_tokens": response.inputTokens }),
            ...(response.outputTokens === null ? {} : { "gen_ai.usage.output_tokens": response.outputTokens }),
            ...(response.costUsd === null ? {} : { "harness.cost.usd": response.costUsd }),
          });
          return response;
        });

        // A completed external effect is never retried merely because its evidence is unusable.
        providerReturned = true;
        await recordCapabilityCost(db, { runId: claims.run_id, costUsd: adapter.costUsd });
        if (sourceAuthority && (!adapter.output || typeof adapter.output !== "object" || Array.isArray(adapter.output))) throw new Error("gateway.source_policy_denied:source_output_envelope_required");
        if (sourceAuthority && sourceAcquisition) {
          const use = await sourceAuthority.use(adapter.sourceEvidence, sourceAcquisition);
          evidenceUseDecisionId = use.decisionId;
          evidenceUseValidUntil = use.decision.validUntil;
        }

        const unsigned = {
          invocationId: invocation.invocationId,
          capabilityId: invocation.capabilityId,
          status: "succeeded" as const,
          output: evidenceUseDecisionId ? attachSourceProvenance(adapter.output, evidenceUseDecisionId, evidenceUseValidUntil!) : adapter.output,
          errorCode: null,
          provider: adapter.provider,
          model: adapter.model,
          providerRequestId: adapter.providerRequestId,
          usage: { inputTokens: adapter.inputTokens, outputTokens: adapter.outputTokens, costUsd: adapter.costUsd },
          latencyMs: Date.now() - started,
          ...(sourceAcquisition ? { sourceDecisionId: sourceAcquisition.decisionId } : {}),
          ...(evidenceUseDecisionId ? { evidenceUseDecisionId } : {}),
        };
        providerReturned = true;
        const result: CapabilityResult = { ...unsigned, receiptDigest: stableDigest(unsigned) };
        await completeGatewayReceipt(db, claims.run_id, result, foundryInvocationLink);
        span.setAttributes({ "harness.outcome": "SUCCEEDED", "harness.gateway.receipt_replayed": false });
        return result;
      } catch (error) {
        if (reservedInvocation && providerReturned && error instanceof Error && error.message.startsWith("gateway.source_policy_denied:")) {
          const unsigned = { invocationId: invocation.invocationId, capabilityId: invocation.capabilityId, status: "denied" as const,
            output: null, errorCode: error.message, provider: null, model: null, providerRequestId: null,
            usage: { inputTokens: null, outputTokens: null, costUsd: null }, latencyMs: Date.now() - started,
            ...(sourceAcquisition ? { sourceDecisionId: sourceAcquisition.decisionId } : {}) };
          const denied: CapabilityResult = { ...unsigned, receiptDigest: stableDigest(unsigned) };
          await completeGatewayReceipt(db, claims.run_id, denied, foundryInvocationLink);
          return reply.code(403).send(denied);
        }
        if (reservedInvocation && foundryInvocationDispatched && !providerReturned) {
          // The request crossed the provider boundary. Keep an idempotent failure receipt even
          // when a timeout left the remote outcome unknown, so replay cannot repeat a paid call.
          const message = error instanceof Error ? error.message : "";
          const errorCode = /^gateway\.foundry_agent_[a-z0-9_]+$/.test(message)
            ? message : "gateway.foundry_agent_outcome_unknown";
          const unsigned = {
            invocationId: invocation.invocationId, capabilityId: invocation.capabilityId,
            status: "failed" as const, output: null, errorCode, provider: "azure_foundry_agents",
            model: null, providerRequestId: null,
            usage: { inputTokens: null, outputTokens: null, costUsd: null }, latencyMs: Date.now() - started,
            ...(sourceAcquisition ? { sourceDecisionId: sourceAcquisition.decisionId } : {}),
          };
          await recordCapabilityCost(db, { runId: claims.run_id, costUsd: null });
          const result: CapabilityResult = { ...unsigned, receiptDigest: stableDigest(unsigned) };
          await completeGatewayReceipt(db, claims.run_id, result, foundryInvocationLink);
          recordFailure(span, new Error(errorCode));
          return result;
        }
        // A provider rejection or timeout is known not to have produced a usable
        // result, so release this claim and allow the runtime's bounded retry to
        // make progress. Once a provider has returned, keep the claim fail-closed:
        // deleting it after a receipt-write failure could repeat an external effect.
        if (reservedInvocation && !providerReturned) {
          try {
            await abandonGatewayReceipt(db, reservedInvocation.runId, reservedInvocation.invocationId);
          } catch (cleanupError) {
            request.log.error({ err: cleanupError }, "failed to release gateway invocation claim");
          }
        }
        const message = error instanceof Error ? error.message : "gateway.unknown";
        if (expectedDenial(message)) {
          span.setStatus({ code: SpanStatusCode.OK });
          span.setAttribute("harness.outcome", "DENIED");
        } else {
          recordFailure(span, error);
        }
        request.log.warn({ err: error }, "capability invocation denied or failed");
        return reply.code(expectedDenial(message) ? 403 : 400).send({ error: message });
      }
    }, parent);
  });

  app.addHook("onClose", async () => { if (!options.db) await db.end(); });
  return app;
}
