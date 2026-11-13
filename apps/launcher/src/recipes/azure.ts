import prebuiltRoutes from "../../../../packages/adapters/src/azure-prebuilt-routes.json" with { type: "json" };
import { contextConnectionSchema } from "@ehf/contracts/context-sources";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { z } from "zod";
import { QUEUE_DEPTH_QUERIES, RUNTIME_ENTRYPOINTS, RUNTIME_SERVICES, serviceReplicas } from "@ehf/contracts/deployment-plan";
import { databaseTargets } from "../database-targets.js";
import { deploymentModelName, deploymentProfileSchema, telemetryConfigured, type FoundryTraceQualification } from "@ehf/contracts/deployment";
import { curatedModelProfiles, modelLimitsSchema, resolveModelLimits, runtimeModelBinding } from "../runtime-models.js";
import { QUEUE_SCALER } from "../runtime-configuration.js";
import { parseAdlsCredential } from "@ehf/blob-store/adls";
import type { DeploymentJob } from "../deployment-jobs.js";

const https = z.string().url().refine(value => { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password && !url.hash; });
export const runtimeInputsSchema = z.object({
  tenantId: z.string().regex(/^[a-zA-Z0-9._-]{1,100}$/), monthlyLimitUsd: z.number().positive().max(1000000),
  databaseUrls: z.object({ control: z.string(), case: z.string(), context: z.string(), discovery: z.string().optional() }).strict(),
  discovery: z.object({
    enabled: z.boolean().optional(),
    databaseUrl: z.string().optional(),
    companies: z.unknown().optional(), // Accepted for existing runtime inputs.
    deployment: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/).optional(),
  }).strict().optional(),
  secrets: z.record(z.string(), z.string().min(1).max(65536)),
  identityAllowedOrigins: z.array(https.refine(value => new URL(value).origin === value)).max(20).optional(),
  databaseCaPem: z.string().max(20000).optional(),
  // Optional scaling inputs; every default is in RUNTIME_SERVICES or DEFAULT_MODEL_LIMITS.
  database: z.object({
    // A transaction-mode pooler (Azure Flexible Server's built-in PgBouncer listens on 6432).
    // Services connect through it; migrations and the dispatcher's LISTEN stay direct.
    pooler: z.object({ host: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}$/).optional(), port: z.number().int().min(1).max(65535) }).strict().optional(),
    servicePoolMax: z.number().int().min(1).max(50).optional(),
  }).strict().optional(),
  scaling: z.partialRecord(z.enum(RUNTIME_ENTRYPOINTS), z.object({ maxReplicas: z.number().int().min(1).max(30) }).strict()).optional(),
  modelLimits: modelLimitsSchema.optional(),
  workbench: z.object({jobId:z.string().regex(/^\/subscriptions\/[a-f0-9-]+\/resourceGroups\/[a-zA-Z0-9_.()-]+\/providers\/Microsoft.App\/jobs\/[a-zA-Z0-9_.()-]+$/),
    image:z.string().regex(/@sha256:[a-f0-9]{64}$/),storageAccount:z.string().regex(/^[a-z0-9]{3,24}$/),storageContainer:z.string().regex(/^[a-z0-9-]{3,63}$/).default('workbench-evaluations'),
    identityId:z.string().regex(/^\/subscriptions\/[^ ]+\/providers\/Microsoft.ManagedIdentity\/userAssignedIdentities\/[^/]+$/),identityClientId:z.string().uuid()}).strict().optional(),
  foundryTraceQualification: z.unknown().optional(),
  contextSources: z.array(contextConnectionSchema).max(100).optional(),
  contextSourceCaPem: z.string().max(20000).optional(),
  // Library skill host and evidence pipeline, deployed from their own images beside the
  // platform services and reached only by the capability gateway.
  hostedServices: z.object({
    // Development only: approve the skill host's bundle lock during the deployment instead of by a second person.
    skillHost: z.object({ autoApproveBundle: z.boolean().optional() }).strict().optional(),
    evidencePipeline: z.object({ tokenRef: z.string().min(1), dataKeyRef: z.string().min(1) }).strict().optional(),
  }).strict().optional(),
  workload: z.object({ issuer: https, audience: z.string().min(1).max(200), tokenEndpoint: https, jwksUri: https,
    clients: z.record(z.string(), z.object({ clientId: z.string().min(1).max(200), secretRef: z.string(), subject: z.string().min(1).max(320), scope: z.string().max(500).default("") }).strict()),
  }).strict(),
}).strict();
export type RuntimeInputs = z.infer<typeof runtimeInputsSchema>;
export type AzureObservabilityContext = {
  queryIdentityId: string;
  queryIdentityClientId: string;
  foundry?: {
    qualification: FoundryTraceQualification;
    invokeIdentityId: string;
    invokeIdentityClientId: string;
  };
};
export type AzureContext = { observability?: AzureObservabilityContext; name: string; location: string; managedEnvironmentId: string; defaultDomain: string; pullIdentityId: string; registryHost: string;
  /** Digest-pinned images of the hosted services, built into the same registry by the bootstrap. */
  hostImages?: Partial<Record<HostedService, string>>;
  documents?: { endpoint: string; identityId: string; clientId: string; workerIdentity?: { id: string; clientId: string }; trainingContainerUrl?: string };
  /** Digest of the bundle lock the skill host image was built with (recorded by the bootstrap). */
  skillBundleLockDigest?: string };

/** Services deployed from their own images; the gateway is their only caller. */
export const HOSTED_SERVICES = {
  "skill-host": { alias: "skills", port: 8090, identity: "skill-host" },
  "evidence-pipeline": { alias: "docs", port: 8080, identity: null },
  "document-factory-worker": { alias: "factory", port: 8091, identity: "document-factory-worker" },
} as const;
export type HostedService = keyof typeof HOSTED_SERVICES;
/** Where the evidence pipeline's data volume is mounted in the environment (deploy/azure/bootstrap.bicep). */
export const EVIDENCE_PIPELINE_STORAGE = "evidence-pipeline-data";
const DISCOVERY_WORKER = { entrypoint: "discovery-worker", alias: "recon", port: 9092,
  databases: ["case", "control", "discovery"] } as const;
const TOKEN_DIRECTORY = "/var/run/integralflow-token";
/** Container App names derive from the bootstrap name; the bootstrap predicts the web app's origin with the same function. */
export function azureBaseName(bootstrapName: string) { return `${bootstrapName.slice(0, 14)}-${createHash("sha256").update(bootstrapName).digest("hex").slice(0, 4)}`; }
export function azureApplicationName(bootstrapName: string, entrypoint: string) {
  const service = RUNTIME_SERVICES.find(item => item.entrypoint === entrypoint) ?? (entrypoint === DISCOVERY_WORKER.entrypoint ? DISCOVERY_WORKER : undefined) ?? (Object.hasOwn(HOSTED_SERVICES, entrypoint) ? HOSTED_SERVICES[entrypoint as HostedService] : undefined);
  if (!service) throw new Error("deployment.service_unknown");
  return `${azureBaseName(bootstrapName)}-${service.alias}`;
}
export function resolveInputSecret(inputs: RuntimeInputs, ref: string) {
  const value = inputs.secrets[ref] ?? (ref.startsWith("env:") ? inputs.secrets[ref.slice(4)] : undefined);
  if (!value) throw new Error("deployment.secret_binding_missing");
  return value;
}

export function compileAzureRuntime(job: DeploymentJob, rawInputs: unknown, context: AzureContext, stableKeys?: Record<string, { publicKey: string; privateKey: string }>) {
  const inputs = runtimeInputsSchema.parse(rawInputs);
  const p = deploymentProfileSchema.parse(job.document.profile);
  const modelBinding = runtimeModelBinding(p);
  if (!telemetryConfigured(p)) throw new Error("deployment.telemetry_binding_required");
  const trace = p.foundation.observability?.backend === "azure_monitor" ? p.foundation.observability : undefined;
  if (trace && !context.observability) throw new Error("deployment.telemetry_query_identity_required");
  const foundry = trace?.foundry && context.observability?.foundry;
  const foundryBinding = foundry ? JSON.stringify({
    projectEndpoint: foundry.qualification.projectEndpoint,
    agentName: foundry.qualification.agentName,
    agentVersion: foundry.qualification.agentVersion,
    applicationInsightsResourceId: foundry.qualification.applicationInsightsResourceId,
    tenantId: foundry.qualification.tenantId,
    contentIsolation: "verified",
    qualificationExpiresAt: foundry.qualification.expiresAt,
  }) : undefined;
  if (!p.foundation.objectStore.endpoint || !p.foundation.objectStore.bucket || !p.foundation.objectStore.credentialRef) throw new Error("deployment.protected_object_store_required");
  const rawStorageCredential: unknown = JSON.parse(resolveInputSecret(inputs, p.foundation.objectStore.credentialRef));
  const objectStore = p.foundation.objectStore.provider === "adls_gen2" ? { provider: "adls_gen2" as const, credentials: parseAdlsCredential(rawStorageCredential) } : z.union([
    z.object({ accessKeyId: z.string().min(1), secretAccessKey: z.string().min(1), region: z.string().min(1) }).strict(),
    z.object({ provider: z.literal("azure_blob"), accountName: z.string().regex(/^[a-z0-9]{3,24}$/), accountKey: z.string().min(1) }).strict(),
  ]).parse(rawStorageCredential);
  if (p.target.provider !== "azure" || p.target.recipe !== "azure-container-apps-bootstrap-v1" || !/^.+@sha256:[a-f0-9]{64}$/.test(job.image) || !job.image.startsWith(`${context.registryHost}/`)) throw new Error("deployment.recipe_or_image_invalid");
  if (!/^[a-z][a-z0-9-]{1,25}$/.test(context.name) || !/^[a-zA-Z0-9.-]+$/.test(context.defaultDomain)) throw new Error("deployment.bootstrap_context_invalid");
  const discoveryEndpoint = URL.parse(p.intelligence.endpoint);
  const foundrySearch = discoveryEndpoint && /^\/openai\/v1\/?$/.test(discoveryEndpoint.pathname)
    && (p.intelligence.provider === "azure_foundry" || (p.intelligence.provider === "openai_compatible"
      && /\.(?:openai|services\.ai)\.azure\.com$/.test(discoveryEndpoint.hostname)));
  const discoveryDeployment = inputs.discovery?.deployment ?? ["med", "low", "high", "xhigh"]
    .map(tier => deploymentModelName(p, job.catalog, tier)).find(Boolean);
  const discoveryUrl = inputs.discovery?.databaseUrl ?? inputs.databaseUrls.discovery;
  const discovery = inputs.discovery?.enabled !== false && foundrySearch && discoveryDeployment && discoveryUrl
    ? { databaseUrl: discoveryUrl, deployment: discoveryDeployment } : undefined;
  if (!discovery && inputs.discovery?.enabled !== false && (inputs.discovery?.databaseUrl || inputs.discovery?.enabled)) {
    throw new Error("deployment.discovery_foundry_binding_required");
  }
  const discoveryEnv = discovery ? {
    DISCOVERY_TENANT_ID: inputs.tenantId,
    DISCOVERY_WEB_SEARCH_PROVIDER: "azure_foundry",
  } : {};
  const targets = databaseTargets(p, { SECURITY_PROFILE: "production", DATABASE_AUTH: "url",
    DATABASE_URL: inputs.databaseUrls.control, CASE_DATABASE_URL: inputs.databaseUrls.case, CONTEXT_DATABASE_URL: inputs.databaseUrls.context,
    ...(discovery ? { DISCOVERY_DATABASE_URL: discovery.databaseUrl } : {}),
  });
  const selected = RUNTIME_SERVICES.filter(service => !(service.entrypoint === "runtime-host" && p.intelligence.runtimeEndpoint));
  if (RUNTIME_SERVICES.some(service => !inputs.workload.clients[service.identity]) || new Set(Object.values(inputs.workload.clients).map(client => client.subject)).size !== Object.keys(inputs.workload.clients).length || new Set(Object.values(inputs.workload.clients).map(client => client.clientId)).size !== Object.keys(inputs.workload.clients).length) throw new Error("deployment.distinct_workload_clients_required");
  const workloadSecrets = RUNTIME_SERVICES.map(service => resolveInputSecret(inputs, inputs.workload.clients[service.identity]!.secretRef));
  if (new Set(workloadSecrets).size !== RUNTIME_SERVICES.length || workloadSecrets.some(value => value.length < 24)) throw new Error("deployment.distinct_workload_credentials_required");
  const generation = job.id.replaceAll("-", "").slice(0, 8);
  const keys = stableKeys ?? Object.fromEntries(["execution", "integration", "runtime-grant", "delegated"].map(name => {
    const pair = generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
    return [name, pair];
  }));
  const baseName = azureBaseName(context.name);
  const applicationName = (service: string) => azureApplicationName(context.name, service);
  const hosted = inputs.hostedServices ?? {};
  const documents = p.intelligence.documentServices;
  const azureDocuments = documents?.azure;
  const documentBinding = context.documents;
  const workerIdentity = documentBinding?.workerIdentity;
  if (azureDocuments?.factory && !workerIdentity) throw new Error("deployment.document_identity_required");
  if (azureDocuments?.factory && azureDocuments.trainingContainerId && !documentBinding?.trainingContainerUrl) {
    throw new Error("deployment.document_training_container_incompatible");
  }
  if (documents && (!hosted.skillHost || (!hosted.evidencePipeline && !p.intelligence.documentIntelligence?.endpoint))) {
    throw new Error("deployment.document_hosts_required");
  }
  if (azureDocuments && (azureDocuments.layout || azureDocuments.modelExtraction || azureDocuments.factory) && !documentBinding) {
    throw new Error("deployment.document_account_required");
  }
  const hostImage = (service: HostedService) => {
    const value = context.hostImages?.[service];
    if (!value || !/^.+@sha256:[a-f0-9]{64}$/.test(value) || !value.startsWith(`${context.registryHost}/`)) throw new Error("deployment.hosted_image_missing");
    return value;
  };
  const auxiliaryIdentities = [...(hosted.skillHost ? ["skill-host"] : []), ...(azureDocuments?.factory ? ["document-factory-worker"] : [])];
  const usedSecrets = new Set(workloadSecrets);
  for (const identity of auxiliaryIdentities) {
    const client = inputs.workload.clients[identity];
    const secret = client ? resolveInputSecret(inputs, client.secretRef) : "";
    if (!client || secret.length < 24 || usedSecrets.has(secret)) throw new Error("deployment.distinct_workload_credentials_required");
    usedSecrets.add(secret);
  }
  // A document service is either bound in the profile or deployed here, never both.
  if (hosted.evidencePipeline && p.intelligence.documentIntelligence?.endpoint) throw new Error("deployment.document_intelligence_conflict");
  const identityNames = [...new Set([...RUNTIME_SERVICES.map(service => service.identity), ...auxiliaryIdentities])];
  const endpoint = (service: string) => `https://${applicationName(service)}.${service === "experience-bff" ? "" : "internal."}${context.defaultDomain}`;
  const evidenceToken = hosted.evidencePipeline ? resolveInputSecret(inputs, hosted.evidencePipeline.tokenRef) : undefined;
  if (evidenceToken !== undefined && evidenceToken.length < 32) throw new Error("deployment.evidence_pipeline_token_weak");
  const evidenceEndpoint = hosted.evidencePipeline ? endpoint("evidence-pipeline") : p.intelligence.documentIntelligence?.endpoint;
  const evidenceCredential = evidenceToken ?? (p.intelligence.documentIntelligence?.endpoint ? resolveInputSecret(inputs, p.intelligence.documentIntelligence.credentialRef) : undefined);
  const runtimeEndpoint = p.intelligence.runtimeEndpoint || endpoint("runtime-host");
  const databaseServices = [...RUNTIME_SERVICES.filter(service => service.databases.length), ...(discovery ? [DISCOVERY_WORKER] : [])];
  const logins = Object.fromEntries(databaseServices.map((service, index) => [service.entrypoint, { login: `if_${p.environmentId.replaceAll("-", "_")}_${index}_${generation}`, password: randomBytes(32).toString("hex") }]));
  // Workers scale on queue depth through a count-only login. A platform scaler cannot be given
  // a private CA, so with one the workers stay at their minimum replica count.
  const queueScaling = !inputs.databaseCaPem;
  if (queueScaling) logins[QUEUE_SCALER] = { login: `if_${p.environmentId.replaceAll("-", "_")}_scaler_${generation}`, password: randomBytes(32).toString("hex") };
  const modelLimits = resolveModelLimits(inputs.modelLimits);
  const modelsJson = JSON.stringify({ apiVersion: "harness.factory/model-profiles-v1", profiles: curatedModelProfiles(p, job.catalog, modelLimits) });
  // Services reach the databases through the pooler when one is configured.
  const direct = { host: p.foundation.database.host, port: p.foundation.database.port };
  const pooled = inputs.database?.pooler ? { host: inputs.database.pooler.host ?? direct.host, port: inputs.database.pooler.port } : direct;
  const servicePoolMax = inputs.database?.servicePoolMax ?? 5;
  const databaseUrl = (target: typeof targets[number], login: string, via: typeof direct) => {
    const url = new URL(target.connectionString); url.username = login;
    if (via !== direct) { url.hostname = via.host; url.port = String(via.port); }
    return url.toString();
  };
  const replicaRange = (service: typeof RUNTIME_SERVICES[number]) => serviceReplicas(service, p.foundation.posture, inputs.scaling?.[service.entrypoint]?.maxReplicas);
  const workloadIdentities = JSON.stringify(Object.fromEntries(identityNames.map(identity => [identity, inputs.workload.clients[identity]!.subject])));
  const common = {
    SECURITY_PROFILE: "production", DATABASE_AUTH: "url", IDENTITY_PROVIDER: "oidc", WORKLOAD_AUTH: "workload_identity", ENVELOPE_SIGNER: "private_key", ENVELOPE_VERIFIER: "public_key", TELEMETRY_EXPORTER: "otlp",
    INTEGRALFLOW_RUNTIME_LAUNCH: "true", HOST: "0.0.0.0", PLATFORM_TENANT_ID: inputs.tenantId,
    INTEGRALFLOW_DEPLOYMENT_ID: job.id,
    OIDC_ISSUER: p.access.issuer, OIDC_AUDIENCE: p.access.clientId, OIDC_ROLES_CLAIM: p.access.rolesClaim, OIDC_GROUP_ROLE_MAPPINGS: JSON.stringify(p.access.mappings),
    WORKLOAD_IDENTITY_ISSUER: inputs.workload.issuer, WORKLOAD_IDENTITY_AUDIENCE: inputs.workload.audience, WORKLOAD_IDENTITY_JWKS_URI: inputs.workload.jwksUri, WORKLOAD_IDENTITIES: workloadIdentities,
    WORKLOAD_OAUTH_TOKEN_ENDPOINT: inputs.workload.tokenEndpoint,
    DEPLOYMENT_ENVIRONMENT: p.environmentId, CLOUD_REGION: context.location,
    ...(trace?.samplerRatio === undefined ? {} : { OTEL_TRACES_SAMPLER_ARG: String(trace.samplerRatio) }),
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: p.foundation.telemetryEndpoint.endsWith("/v1/traces") ? p.foundation.telemetryEndpoint : `${p.foundation.telemetryEndpoint.replace(/\/$/, "")}/v1/traces`,
    CONTROL_API_URL: endpoint("control-api"), CASE_API_URL: endpoint("case-api"), CAPABILITY_GATEWAY_URL: endpoint("capability-gateway"), ENVELOPE_BROKER_URL: endpoint("control-api"),
    CONTROL_API_INTERNAL_URL: endpoint("control-api"), CASE_API_INTERNAL_URL: endpoint("case-api"), CAPABILITY_GATEWAY_INTERNAL_URL: endpoint("capability-gateway"),
    RUNTIME_PROVIDER: "hosted_http", RUNTIME_HOSTED_ENDPOINT: `${runtimeEndpoint.replace(/\/$/, "")}/invocations`, RUNTIME_CHECKPOINT_BACKEND: "memory",
    METERED_MONTHLY_LIMIT_USD: String(inputs.monthlyLimitUsd), EHF_ENVIRONMENT: p.environmentId,
    EXECUTION_ENVELOPE_PUBLIC_KEY_PEM: keys.execution!.publicKey, INTEGRATION_ENVELOPE_PUBLIC_KEY_PEM: keys.integration!.publicKey, RUNTIME_GRANT_PUBLIC_KEY_PEM: keys["runtime-grant"]!.publicKey,
    WEB_ROOT: "/app/web", BFF_PUBLIC_ORIGIN: endpoint("experience-bff"), BFF_OIDC_ALLOWED_ORIGINS: [...new Set([new URL(p.access.issuer).origin, ...(inputs.identityAllowedOrigins ?? [])])].join(","),
  };
  const b64 = (value: string) => Buffer.from(value).toString("base64");
  const services = selected.map(service => {
    const client = inputs.workload.clients[service.identity]!;
    const environment: Record<string, string> = { ...common, SERVICE_NAME: service.entrypoint, PORT: String(service.port), WORKLOAD_OAUTH_CLIENT_ID: client.clientId, WORKLOAD_OAUTH_SUBJECT: client.subject, WORKLOAD_OAUTH_SCOPE: client.scope };
    const secrets: Record<string, string> = { WORKLOAD_OAUTH_CLIENT_SECRET: resolveInputSecret(inputs, client.secretRef) };
    const isControl = service.entrypoint === "control-api";
    const isGateway = service.entrypoint === "capability-gateway";
    if (documents && isControl) {
      environment.DOCUMENT_STUDIO_SKILL_HOST_URL = endpoint("skill-host");
      environment.DOCUMENT_STUDIO_DEPLOYED = "true";
      secrets[modelBinding.credentialName] = resolveInputSecret(inputs, p.intelligence.credentialRef);
    }
    if ((isGateway || isControl && documents) && evidenceEndpoint && evidenceCredential) {
      environment.EVIDENCE_PIPELINE_URL = evidenceEndpoint;
      secrets.EVIDENCE_PIPELINE_TOKEN = evidenceCredential;
    }
    if ((isGateway || isControl) && documentBinding && azureDocuments && (azureDocuments.layout || azureDocuments.modelExtraction)) {
      Object.assign(environment, {
        AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT: documentBinding.endpoint,
        AZURE_DOCUMENT_INTELLIGENCE_AUTH: "managed_identity",
        AZURE_CLIENT_ID: documentBinding.clientId,
        ...(azureDocuments.layout ? { DOCUMENT_LAYOUT_PROVIDER: "azure_document_intelligence", DOCUMENT_LAYOUT_REMOTE_ALLOWED: "true" } : {}),
        ...(azureDocuments.modelExtraction ? { DOCUMENT_MODEL_PROVIDER: "azure_document_intelligence", DOCUMENT_MODEL_REMOTE_ALLOWED: "true", DOCUMENT_MODEL_RELEASE_ENVIRONMENT: p.environmentId } : {}),
      });
    }
    if (documents?.extractionPlanDigest) {
      if (service.entrypoint === "experience-bff") environment.BFF_DOCUMENT_PLAN_DIGEST = documents.extractionPlanDigest;
      if (isControl) environment.DOCUMENT_EXTRACTION_PLAN_DIGEST = documents.extractionPlanDigest;
    }
    if (service.entrypoint === "control-api" && foundryBinding) environment.FOUNDRY_TRACE_BINDING_JSON = foundryBinding;
    if(service.entrypoint==='control-api'&&inputs.workbench)Object.assign(environment,{
      WORKBENCH_EVALUATOR_BACKEND:'azure_jobs',WORKBENCH_AZURE_JOB_ID:inputs.workbench.jobId,WORKBENCH_EVALUATOR_IMAGE:inputs.workbench.image,
      WORKBENCH_AZURE_STORAGE_ACCOUNT:inputs.workbench.storageAccount,WORKBENCH_AZURE_STORAGE_CONTAINER:inputs.workbench.storageContainer,
      WORKBENCH_AZURE_MANAGED_IDENTITY_CLIENT_ID:inputs.workbench.identityClientId});
    const files: Record<string, string> = {};
    if (["control-api", "capability-gateway"].includes(service.entrypoint)) { files["models.json"] = b64(modelsJson); environment.MODEL_PROFILES_PATH = "/tmp/integralflow-secrets/models.json"; }
    if (inputs.databaseCaPem) { files["database-ca.pem"] = b64(inputs.databaseCaPem); environment.NODE_EXTRA_CA_CERTS = "/tmp/integralflow-secrets/database-ca.pem"; }
    const login = logins[service.entrypoint];
    if (login) {
      const stores = targets.filter(target => (service.databases as readonly string[]).includes(target.store)
        || (service.entrypoint === "case-api" && target.store === "discovery"));
      const listenDirect = service.entrypoint === "runtime-worker" && pooled !== direct;
      const endpoints = [pooled, ...(listenDirect ? [direct] : [])];
      files.pgpass = b64(stores.flatMap(target => endpoints.map(via => `${via.host}:${via.port}:${target.database}:${login.login}:${login.password}`)).join("\n") + "\n");
      environment.PGPASSFILE = "/tmp/integralflow-secrets/pgpass";
      environment.DB_POOL_MAX = String(servicePoolMax);
      for (const target of stores) {
        const variable = target.store === "discovery" ? "DISCOVERY_DATABASE_URL" : target.store === "case" ? "CASE_DATABASE_URL" : target.store === "context" ? "CONTEXT_DATABASE_URL" : service.entrypoint === "case-api" ? "EXECUTION_DATABASE_URL" : "DATABASE_URL";
        environment[variable] = databaseUrl(target, login.login, pooled);
      }
      // LISTEN needs session state, which a transaction-mode pooler does not keep.
      if (listenDirect) environment.DATABASE_LISTEN_URL = databaseUrl(targets.find(target => target.store === "control")!, login.login, direct);
    }
    // Scale rules and the secrets only they read (never exposed to the container).
    const range = replicaRange(service);
    const scaleSecrets: Record<string, string> = {};
    let rules: unknown[] = [];
    if (service.scale.trigger === "http") rules = [{ name: "http-concurrency", http: { metadata: { concurrentRequests: String(service.scale.concurrentRequests) } } }];
    else if (queueScaling) {
      const scaler = logins[QUEUE_SCALER]!;
      // The platform scaler cannot read a pgpass file, so this one secret carries the password.
      const connection = new URL(databaseUrl(targets.find(target => target.store === "control")!, scaler.login, pooled)); connection.password = scaler.password;
      scaleSecrets.QUEUE_SCALER_CONNECTION = connection.toString();
      rules = [{ name: "queue-depth", custom: { type: "postgresql", metadata: { query: QUEUE_DEPTH_QUERIES[service.scale.queue], targetQueryValue: String(service.scale.readyPerReplica), activationTargetQueryValue: "1" }, auth: [{ secretRef: "queue-scaler-connection", triggerParameter: "connection" }] } }];
    }
    const signer = ({ "control-api": ["execution", "EXECUTION_ENVELOPE"], "runtime-worker": ["runtime-grant", "RUNTIME_GRANT"], "integration-worker": ["integration", "INTEGRATION_ENVELOPE"], "capability-gateway": ["delegated", "DELEGATED_ENVELOPE"] } as Record<string, string[]>)[service.entrypoint];
    if (signer) { const [key, prefix] = signer as [string, string]; files[`${key}.pem`] = b64(keys[key]!.privateKey); environment[`${prefix}_PRIVATE_KEY_FILE`] = `/tmp/integralflow-secrets/${key}.pem`; environment[`${prefix}_KEY_ID`] = `${key}-${createHash("sha256").update(keys[key]!.publicKey).digest("hex").slice(0, 12)}`; }
    if (service.entrypoint === "capability-gateway") { secrets[modelBinding.credentialName] = resolveInputSecret(inputs, p.intelligence.credentialRef); environment.DELEGATED_ENVELOPE_PUBLIC_KEY_PEM = keys.delegated!.publicKey; }
    if (service.entrypoint === "capability-gateway") {
      if (p.intelligence.provider === "azure_foundry") environment.FOUNDRY_MODEL_ENDPOINT = p.intelligence.endpoint;
      if (foundry && foundryBinding) {
        environment.FOUNDRY_TRACE_BINDING_JSON = foundryBinding;
        environment.FOUNDRY_AGENT_MANAGED_IDENTITY_CLIENT_ID = foundry.invokeIdentityClientId;
      }
      const adapters = ["default", ...(inputs.contextSources?.length ? ["context-source"] : []), ...(hosted.skillHost ? ["skills"] : []), ...(foundry ? ["foundry-agent"] : [])];
      if (adapters.length > 1) environment.GATEWAY_ADAPTERS = adapters.join(",");
      if (hosted.skillHost) Object.assign(environment, { SKILL_HOST_URL: endpoint("skill-host"), SKILL_HOST_AUTH: "platform_token", SKILL_HOST_GATEWAY_URL: endpoint("capability-gateway") });
    }
    if (service.entrypoint === "capability-gateway" && inputs.contextSources?.length) {
      environment.CONTEXT_SOURCE_TARGETS_JSON = JSON.stringify({ [inputs.tenantId]: inputs.contextSources.map(connection => ({ provider: connection.provider, endpoint: connection.endpoint, credentialRef: connection.credentialRef })) });
      for (const connection of inputs.contextSources) {
        const name = connection.credentialRef.slice(4);
        if (Object.hasOwn(environment, name) || Object.hasOwn(secrets, name) || /^(DATABASE|PG|WORKLOAD|EXECUTION|INTEGRATION|RUNTIME|OIDC|BFF|NODE|FOUNDRY|OTEL|AZURE|DOCUMENT|FACTORY|EVIDENCE)_/.test(name)) throw new Error("deployment.context_secret_name_reserved");
        secrets[name] = resolveInputSecret(inputs, connection.credentialRef);
      }
      if (inputs.contextSourceCaPem) {
        secrets.CONTEXT_SOURCE_CA_PEM = inputs.contextSourceCaPem;
        files["context-source-ca.pem"] = b64([inputs.databaseCaPem, inputs.contextSourceCaPem].filter(Boolean).join("\n"));
        environment.NODE_EXTRA_CA_CERTS = "/tmp/integralflow-secrets/context-source-ca.pem";
      }
    }
    if (service.entrypoint === "experience-bff" && p.access.clientSecretRef) secrets.BFF_OIDC_CLIENT_SECRET = resolveInputSecret(inputs, p.access.clientSecretRef);
    if (service.entrypoint === "experience-bff") {
      environment.ONBOARDING_CONSOLE_ORIGIN = `https://${context.name}.${context.defaultDomain}`;
      if (trace && context.observability) Object.assign(environment, {
        BFF_TRACE_BACKEND: "azure_monitor",
        BFF_TRACE_APP_INSIGHTS_RESOURCE_ID: trace.applicationInsightsResourceId,
        BFF_TRACE_MANAGED_IDENTITY_CLIENT_ID: context.observability.queryIdentityClientId,
        BFF_TRACE_CONFIGURATION_REVISION: String(job.revision),
        BFF_TRACE_RETENTION_DAYS: String(trace.retentionDays ?? 30),
        ...(trace.foundry ? { BFF_TRACE_FOUNDRY_CANDIDATE_JSON: JSON.stringify(trace.foundry) } : {}),
        ...(foundry && foundryBinding ? { FOUNDRY_TRACE_BINDING_JSON: foundryBinding, BFF_TRACE_FOUNDRY_QUALIFICATION_CHECKED_AT: foundry.qualification.checkedAt } : {}),
        ...(trace.legacyJaeger ? {
          BFF_JAEGER_QUERY_URL: trace.legacyJaeger.endpoint,
          BFF_TRACE_CUTOVER_AT: trace.legacyJaeger.cutoverAt,
          BFF_TRACE_PREVIOUS_READER_UNTIL: trace.legacyJaeger.readUntil,
        } : {}),
      });
    }
    if (service.entrypoint === "case-api") {
      Object.assign(environment, discoveryEnv);
      environment.CASE_ARTIFACT_BACKEND = "object_store";
      environment.EVIDENCE_BLOB_ENDPOINT = p.foundation.objectStore.endpoint;
      environment.EVIDENCE_BLOB_BUCKET = p.foundation.objectStore.bucket;
      environment.EVIDENCE_BLOB_IMMUTABILITY = "object_lock";
      if ("provider" in objectStore && objectStore.provider === "adls_gen2") {
        environment.EVIDENCE_BLOB_PROVIDER = "adls_gen2";
        environment.EVIDENCE_BLOB_IMMUTABILITY = "container_policy";
        environment.EVIDENCE_BLOB_AZURE_CREDENTIAL_FILE = "/tmp/integralflow-secrets/adls-credential.json";
        files["adls-credential.json"] = b64(JSON.stringify(objectStore.credentials));
      } else if ("accountKey" in objectStore) {
        environment.EVIDENCE_BLOB_PROVIDER = "azure_blob";
        environment.EVIDENCE_BLOB_ACCOUNT = objectStore.accountName;
        environment.EVIDENCE_BLOB_ACCOUNT_KEY_FILE = "/tmp/integralflow-secrets/object-store-key";
        files["object-store-key"] = b64(objectStore.accountKey);
      } else {
        environment.EVIDENCE_BLOB_REGION = objectStore.region;
        environment.EVIDENCE_BLOB_SECRET_ACCESS_KEY_FILE = "/tmp/integralflow-secrets/object-store-key";
        secrets.EVIDENCE_BLOB_ACCESS_KEY_ID = objectStore.accessKeyId;
        files["object-store-key"] = b64(objectStore.secretAccessKey);
      }
    }
    secrets.INTEGRALFLOW_PRIVATE_FILES = JSON.stringify(files);
    const traceIdentityId = service.entrypoint === "experience-bff" ? context.observability?.queryIdentityId
      : service.entrypoint === "capability-gateway" ? foundry?.invokeIdentityId : undefined;
    return { ...((isControl || isGateway) && documentBinding && (azureDocuments?.layout || azureDocuments?.modelExtraction) ? { documentIdentityId: documentBinding.identityId } : {}), ...(traceIdentityId ? { traceIdentityId } : {}), ...(service.entrypoint==='control-api'&&inputs.workbench?{evaluationIdentityId:inputs.workbench.identityId}:{}), name: applicationName(service.entrypoint), entrypoint: service.entrypoint as typeof service.entrypoint | typeof DISCOVERY_WORKER.entrypoint, port: service.port as number, external: service.entrypoint === "experience-bff", replicas: range.min, maxReplicas: queueScaling || service.scale.trigger === "http" ? range.max : range.min, cpu: service.size.cpu, memory: service.size.memory, rules, environment, secrets, scaleSecrets };
  });
  if (discovery) {
    const login = logins[DISCOVERY_WORKER.entrypoint]!;
    const stores = targets.filter(target => (DISCOVERY_WORKER.databases as readonly string[]).includes(target.store));
    const files = {
      pgpass: b64(stores.map(target => `${pooled.host}:${pooled.port}:${target.database}:${login.login}:${login.password}`).join("\n") + "\n"),
      ...(inputs.databaseCaPem ? { "database-ca.pem": b64(inputs.databaseCaPem) } : {}),
    };
    const environment: Record<string, string> = {
      ...discoveryEnv, SERVICE_NAME: DISCOVERY_WORKER.entrypoint, PORT: String(DISCOVERY_WORKER.port), HOST: "0.0.0.0",
      SECURITY_PROFILE: "production", DATABASE_AUTH: "url", INTEGRALFLOW_RUNTIME_LAUNCH: "true",
      INTEGRALFLOW_DEPLOYMENT_ID: job.id, PGPASSFILE: "/tmp/integralflow-secrets/pgpass",
      DISCOVERY_FOUNDRY_ENDPOINT: p.intelligence.endpoint,
      DISCOVERY_FOUNDRY_DEPLOYMENT: discovery.deployment,
      ...(inputs.databaseCaPem ? { NODE_EXTRA_CA_CERTS: "/tmp/integralflow-secrets/database-ca.pem" } : {}),
    };
    const variables = { case: "CASE_DATABASE_URL", control: "DISCOVERY_CONTROL_DATABASE_URL", discovery: "DISCOVERY_DATABASE_URL" } as const;
    for (const target of stores) environment[variables[target.store as keyof typeof variables]] = databaseUrl(target, login.login, pooled);
    services.push({
      name: applicationName(DISCOVERY_WORKER.entrypoint), entrypoint: DISCOVERY_WORKER.entrypoint, port: DISCOVERY_WORKER.port,
      external: false, replicas: 1, maxReplicas: 1, cpu: 0.25, memory: "0.5Gi", rules: [], environment, scaleSecrets: {},
      secrets: { INTEGRALFLOW_PRIVATE_FILES: JSON.stringify(files), DISCOVERY_FOUNDRY_API_KEY: resolveInputSecret(inputs, p.intelligence.credentialRef) },
    });
  }
  // The hosted services: their own images, no platform launcher, and only what each needs.
  const tokenSidecar = (identity: string) => {
    const client = inputs.workload.clients[identity]!;
    return {
      environment: { INTEGRALFLOW_RUNTIME_LAUNCH: "true", SERVICE_NAME: "workload-token", WORKLOAD_TOKEN_OUTPUT: `${TOKEN_DIRECTORY}/workload.jwt`,
        WORKLOAD_OAUTH_TOKEN_ENDPOINT: inputs.workload.tokenEndpoint, WORKLOAD_IDENTITY_ISSUER: inputs.workload.issuer, WORKLOAD_IDENTITY_AUDIENCE: inputs.workload.audience,
        WORKLOAD_IDENTITY_JWKS_URI: inputs.workload.jwksUri, WORKLOAD_OAUTH_CLIENT_ID: client.clientId, WORKLOAD_OAUTH_SUBJECT: client.subject, WORKLOAD_OAUTH_SCOPE: client.scope },
      secrets: { WORKLOAD_OAUTH_CLIENT_SECRET: resolveInputSecret(inputs, client.secretRef) },
    };
  };
  const hostedServices = [
    ...(hosted.skillHost ? [{
      name: applicationName("skill-host"), entrypoint: "skill-host", port: HOSTED_SERVICES["skill-host"].port, external: false, image: hostImage("skill-host"), probePath: "/healthz",
      replicas: 1, maxReplicas: 1, cpu: "0.5", memory: "1Gi", rules: [] as unknown[],
      environment: { INTEGRALFLOW_DEPLOYMENT_ID: job.id, SECURITY_PROFILE: "production", WORKLOAD_AUTH: "workload_identity", SKILL_HOST_PORT: String(HOSTED_SERVICES["skill-host"].port),
        WORKLOAD_IDENTITY_ISSUER: inputs.workload.issuer, WORKLOAD_IDENTITY_AUDIENCE: inputs.workload.audience, WORKLOAD_IDENTITY_JWKS_URI: inputs.workload.jwksUri,
        WORKLOAD_IDENTITIES: workloadIdentities, WORKLOAD_TOKEN_FILE: `${TOKEN_DIRECTORY}/workload.jwt`,
        // The gateway signs the delegated envelopes this host is sent.
        SKILL_HOST_ENVELOPE_PUBLIC_KEY_PEM: keys.delegated!.publicKey } as Record<string, string>,
      secrets: {} as Record<string, string>, scaleSecrets: {} as Record<string, string>,
      sidecar: tokenSidecar("skill-host"), volumes: [{ name: "workload-token", storageType: "EmptyDir" }], mounts: [{ volumeName: "workload-token", mountPath: TOKEN_DIRECTORY }],
    }] : []),
    // SQLite and its uploads on a file share: exactly one writer.
    ...(azureDocuments?.factory && documentBinding && workerIdentity ? [{
      name: applicationName("document-factory-worker"), entrypoint: "document-factory-worker", port: HOSTED_SERVICES["document-factory-worker"].port,
      external: false, image: hostImage("skill-host"), args: ["python", "-m", "document_factory.worker", "run"], probePath: "/healthz",
      replicas: 1, maxReplicas: 1, cpu: "0.5", memory: "1Gi", rules: [] as unknown[],
      documentIdentityId: workerIdentity.id,
      environment: { INTEGRALFLOW_DEPLOYMENT_ID: job.id, SECURITY_PROFILE: "production", WORKLOAD_AUTH: "workload_identity",
        WORKLOAD_TOKEN_FILE: `${TOKEN_DIRECTORY}/workload.jwt`, CONTROL_API_URL: endpoint("control-api"), FACTORY_DATASET_ROOT: "/data/datasets",
        FACTORY_HEALTH_PORT: String(HOSTED_SERVICES["document-factory-worker"].port), FACTORY_PREBUILT_ROUTES_JSON: JSON.stringify(prebuiltRoutes),
        AZURE_DOCUMENT_INTELLIGENCE_AUTH: "managed_identity", AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT: documentBinding.endpoint, AZURE_CLIENT_ID: workerIdentity.clientId,
        ...(documentBinding.trainingContainerUrl ? { FACTORY_TRAINING_CONTAINER_URL: documentBinding.trainingContainerUrl } : {}) } as Record<string, string>,
      secrets: {} as Record<string, string>, scaleSecrets: {} as Record<string, string>, sidecar: tokenSidecar("document-factory-worker"),
      volumes: [{ name: "workload-token", storageType: "EmptyDir" }, { name: "datasets", storageType: "AzureFile", storageName: "factory-datasets", mountOptions: "uid=10001,gid=10001,dir_mode=0500,file_mode=0400" }],
      mounts: [{ volumeName: "workload-token", mountPath: TOKEN_DIRECTORY }, { volumeName: "datasets", mountPath: "/data/datasets" }],
    }] : []),
    ...(hosted.evidencePipeline ? [{
      name: applicationName("evidence-pipeline"), entrypoint: "evidence-pipeline", port: HOSTED_SERVICES["evidence-pipeline"].port, external: false, image: hostImage("evidence-pipeline"), probePath: "/healthz",
      replicas: 1, maxReplicas: 1, cpu: "1.0", memory: "2Gi", rules: [] as unknown[],
      environment: { INTEGRALFLOW_DEPLOYMENT_ID: job.id, EVIDENCE_PIPELINE_DATA_DIR: "/data", EVIDENCE_PIPELINE_PORT: String(HOSTED_SERVICES["evidence-pipeline"].port) } as Record<string, string>,
      secrets: { EVIDENCE_PIPELINE_TOKEN: evidenceToken!, KYC_DATA_KEY: resolveInputSecret(inputs, hosted.evidencePipeline.dataKeyRef) } as Record<string, string>, scaleSecrets: {} as Record<string, string>,
      sidecar: null, volumes: [{ name: "data", storageType: "AzureFile", storageName: EVIDENCE_PIPELINE_STORAGE, mountOptions: "uid=10001,gid=10001,dir_mode=0700,file_mode=0600,cache=none,nosharesock,nobrl" }], mounts: [{ volumeName: "data", mountPath: "/data" }],
    }] : []),
  ];
  if (hosted.evidencePipeline && !/^[A-Za-z0-9+/]{43}=$/.test(hostedServices.at(-1)!.secrets.KYC_DATA_KEY!)) throw new Error("deployment.evidence_pipeline_data_key_invalid");
  const migration: Record<string, string> = { SERVICE_NAME: "migrate", SECURITY_PROFILE: "production", DATABASE_AUTH: "url", PLATFORM_TENANT_ID: inputs.tenantId,
    DATABASE_URL: inputs.databaseUrls.control, CASE_DATABASE_URL: inputs.databaseUrls.case, CONTEXT_DATABASE_URL: inputs.databaseUrls.context,
    PGPASSWORD: resolveInputSecret(inputs, p.foundation.database.credentialRef), DEPLOYMENT_BUNDLE_JSON: JSON.stringify({ apiVersion: "integralflow/deployment-bundle-v1", ...job.document }),
    DEPLOYMENT_SERVICE_LOGINS: JSON.stringify(logins), DEPLOYMENT_MODEL_CATALOG: JSON.stringify(job.catalog), DEPLOYMENT_MODEL_LIMITS: JSON.stringify(modelLimits),
  };
  if (discovery) migration.DISCOVERY_DATABASE_URL = discovery.databaseUrl;
  migration.INTEGRALFLOW_RUNTIME_LAUNCH = "true";
  migration.MODEL_PROFILES_PATH = "/tmp/integralflow-secrets/models.json";
  migration.INTEGRALFLOW_PRIVATE_FILES = JSON.stringify({ "models.json": b64(modelsJson), ...(inputs.databaseCaPem ? { "database-ca.pem": b64(inputs.databaseCaPem) } : {}) });
  if (inputs.databaseCaPem) migration.NODE_EXTRA_CA_CERTS = "/tmp/integralflow-secrets/database-ca.pem";
  if (hosted.skillHost?.autoApproveBundle) {
    if (!context.skillBundleLockDigest || !/^[a-f0-9]{64}$/.test(context.skillBundleLockDigest)) throw new Error("deployment.skill_bundle_lock_unknown");
    migration.DEPLOYMENT_SKILL_BUNDLE_LOCK_DIGEST = context.skillBundleLockDigest;
  }
  migration.DEPLOYMENT_OBJECT_STORE = JSON.stringify({ ...objectStore, endpoint: p.foundation.objectStore.endpoint, bucket: p.foundation.objectStore.bucket });
  // Peak client connections per database if every service reaches its maximum replica count
  // (deploy/performance.md): pool size per replica, plus the dispatcher's LISTEN and the
  // scaler. Compare it with the server's (or the pooler's) usable connections.
  const connectionBudget = Object.fromEntries(targets.map(target => [target.database, services.reduce((sum, service) => {
    if (service.entrypoint === DISCOVERY_WORKER.entrypoint) {
      return sum + (target.store === "discovery" ? 2 : target.store === "case" || target.store === "control" ? 1 : 0);
    }
    if (target.store === "discovery") return sum + (service.entrypoint === "case-api" ? service.maxReplicas * 2 : 0);
    const definition = RUNTIME_SERVICES.find(item => item.entrypoint === service.entrypoint)!;
    if (!(definition.databases as readonly string[]).includes(target.store)) return sum;
    return sum + service.maxReplicas * (servicePoolMax + (service.entrypoint === "runtime-worker" && target.store === "control" ? 1 : 0));
  }, target.store === "control" && queueScaling ? 2 : 0)]));
  return { services, hostedServices, migration, inputs, keys, baseName, applicationUrl: endpoint("experience-bff"), runtimeEndpoint, context, image: job.image, generation, connectionBudget, pooled: pooled !== direct, queueScaling };
}
