import { describe, expect, it } from "vitest";
import { defaultDeploymentProfile } from "@ehf/contracts/deployment";
import { RUNTIME_SERVICES } from "@ehf/contracts/deployment-plan";
import { azureApplicationName, compileAzureRuntime } from "./azure.js";
import { SERVICE_DATABASE_GRANTS } from "../runtime-configuration.js";
import type { DeploymentJob } from "../deployment-jobs.js";

const profile = defaultDeploymentProfile({ provider: "azure", scopeId: "/subscriptions/test/resourceGroups/test", region: "centralus", recipe: "azure-container-apps-bootstrap-v1" });
profile.foundation.database = { host: "database.example.com", port: 5432, credentialRef: "env:DB_SECRET" }; profile.foundation.objectStore = { endpoint: "https://objects.example.com", bucket: "evidence", credentialRef: "env:OBJECT_STORE" }; profile.foundation.telemetryEndpoint = "https://telemetry.example.com"; profile.foundation.observability = { backend: "otlp" };
profile.intelligence.credentialRef = "env:MODEL_SECRET"; profile.intelligence.models.low = "curated";
profile.access.issuer = "https://identity.example.com/humans"; profile.access.clientId = "human-client";
const job: DeploymentJob = { id: "c7873f4d-2ee2-433e-b639-0d08c8cdcb74", revision: 1, planHash: "a".repeat(64), phase: "running", requestedBy: "admin", createdAt: "now", updatedAt: "now", steps: [], image: `registry.example.com/integralflow@sha256:${"a".repeat(64)}`, document: { revision: 1, phase: "configured", profile, updatedAt: "now", tests: [] }, catalog: { revision: "test", models: [{ id: "curated", name: "Model", publisher: "Publisher", family: "frontier", providers: { openrouter: "publisher/model" } }] } };
const inputs = { tenantId: "test", monthlyLimitUsd: 10, databaseUrls: { control: "postgresql://migrator@database.example.com/control?sslmode=verify-full", case: "postgresql://migrator@database.example.com/case?sslmode=verify-full", context: "postgresql://migrator@database.example.com/context?sslmode=verify-full" }, secrets: { OBJECT_STORE: JSON.stringify({ accessKeyId: "test", secretAccessKey: "test-storage-secret", region: "us-east-1" }), DB_SECRET: "migration-password", MODEL_SECRET: "model-secret", ...Object.fromEntries(RUNTIME_SERVICES.map(service => [`${service.identity}-secret`, `private-workload-secret-${service.identity}`])) }, workload: { issuer: "https://identity.example.com/workloads", audience: "integralflow", tokenEndpoint: "https://identity.example.com/token", jwksUri: "https://identity.example.com/jwks", clients: Object.fromEntries(RUNTIME_SERVICES.map(service => [service.identity, { clientId: service.identity, subject: `service:${service.identity}`, secretRef: `${service.identity}-secret`, scope: "integralflow" }])) } };
const context = { name: "abcdefghijklmnopqrstuvwxzy", location: "centralus", managedEnvironmentId: "environment", defaultDomain: "environment.example.com", pullIdentityId: "pull-identity", registryHost: "registry.example.com" };
describe("Azure adapter compiles open-protocol runtime configuration", () => {
  it("attaches the trace reader only to the BFF and leaves unqualified Foundry as a candidate", () => {
    const configured = structuredClone(job);
    const scope = "/subscriptions/11111111-1111-4111-8111-111111111111/resourceGroups/test";
    const applicationInsightsResourceId = `${scope}/providers/Microsoft.Insights/components/platform`;
    const foundry = { projectEndpoint: "https://example.services.ai.azure.com/api/projects/test", agentName: "trace-agent", agentVersion: "1", applicationInsightsResourceId: `${scope}/providers/Microsoft.Insights/components/foundry` };
    configured.document.profile.target.scopeId = scope;
    configured.document.profile.foundation.observability = { backend: "azure_monitor", applicationInsightsResourceId, foundry, samplerRatio: 0.25 };
    expect(() => compileAzureRuntime(configured, inputs, context)).toThrow("deployment.telemetry_query_identity_required");
    const queryIdentityId = `${scope}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/trace-reader`;
    const queryIdentityClientId = "11111111-1111-4111-8111-111111111112";
    const compiled = compileAzureRuntime(configured, inputs, { ...context, observability: { queryIdentityId, queryIdentityClientId } });
    const edge = compiled.services.find(service => service.entrypoint === "experience-bff")!;
    expect(edge.traceIdentityId).toBe(queryIdentityId);
    expect(edge.environment).toMatchObject({
      BFF_TRACE_BACKEND: "azure_monitor", BFF_TRACE_APP_INSIGHTS_RESOURCE_ID: applicationInsightsResourceId,
      BFF_TRACE_MANAGED_IDENTITY_CLIENT_ID: queryIdentityClientId, BFF_TRACE_CONFIGURATION_REVISION: "1",
      BFF_TRACE_FOUNDRY_CANDIDATE_JSON: JSON.stringify(foundry), OTEL_TRACES_SAMPLER_ARG: "0.25",
    });
    expect(compiled.services.filter(service => service !== edge).every(service => !service.traceIdentityId)).toBe(true);
    expect(compiled.services.every(service => !service.environment.FOUNDRY_TRACE_BINDING_JSON)).toBe(true);
    const invokeIdentityId = `${scope}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/foundry-invoker`;
    const invokeIdentityClientId = "11111111-1111-4111-8111-111111111113";
    const checkedAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const qualified = compileAzureRuntime(configured, inputs, { ...context, observability: {
      queryIdentityId, queryIdentityClientId, foundry: {
        invokeIdentityId, invokeIdentityClientId,
        qualification: {
          ...foundry, apiVersion: "integralflow/foundry-trace-qualification-v1", checkedAt, expiresAt, tenantId: inputs.tenantId,
          queryIdentityId, queryIdentityClientId, contentProbePassed: true, protectedContentDenied: true, unrelatedComponentDenied: true,
          traceId: "a".repeat(32), responseId: "resp_pilot",
          unrelatedApplicationInsightsResourceId: `${scope}/providers/Microsoft.Insights/components/unrelated`,
          workspaceResourceId: `${scope}/providers/Microsoft.OperationalInsights/workspaces/isolated`,
          workspaceTransformationResourceId: `${scope}/providers/Microsoft.Insights/dataCollectionRules/isolated`,
          workspaceTransformationEtag: "pilot-etag",
        },
      },
    } }, compiled.keys);
    const gateway = qualified.services.find(service => service.entrypoint === "capability-gateway")!;
    const control = qualified.services.find(service => service.entrypoint === "control-api")!;
    const bff = qualified.services.find(service => service.entrypoint === "experience-bff")!;
    expect(gateway.traceIdentityId).toBe(invokeIdentityId);
    expect(gateway.environment).toMatchObject({ GATEWAY_ADAPTERS: "default,foundry-agent", FOUNDRY_AGENT_MANAGED_IDENTITY_CLIENT_ID: invokeIdentityClientId });
    const binding = JSON.stringify({ ...foundry, tenantId: inputs.tenantId, contentIsolation: "verified", qualificationExpiresAt: expiresAt });
    expect([gateway, control, bff].every(service => service.environment.FOUNDRY_TRACE_BINDING_JSON === binding)).toBe(true);
    expect(bff.environment.BFF_TRACE_FOUNDRY_QUALIFICATION_CHECKED_AT).toBe(checkedAt);
    expect(JSON.stringify(qualified.services)).not.toContain("pilot-etag");
  });
  it("deploys Foundry aliases as runtime model names while scoping the model key to the gateway", () => {
    const foundry = structuredClone(job);
    foundry.document.profile.intelligence = { ...foundry.document.profile.intelligence, provider: "azure_foundry", endpoint: "https://test.services.ai.azure.com/openai/v1", deployments: { low: "ehf-test-low" } };
    foundry.catalog.models[0]!.providers.azure_foundry = "gpt-4.1-mini";
    const compiled = compileAzureRuntime(foundry, inputs, context);
    const gateway = compiled.services.find(service => service.entrypoint === "capability-gateway")!;
    expect(gateway.environment.FOUNDRY_MODEL_ENDPOINT).toBe("https://test.services.ai.azure.com/openai/v1");
    const files = JSON.parse(gateway.secrets.INTEGRALFLOW_PRIVATE_FILES!);
    expect(JSON.parse(Buffer.from(files["models.json"], "base64").toString()).profiles).toEqual([expect.objectContaining({ model: "ehf-test-low" })]);
    expect(Object.values(gateway.secrets)).toContain("model-secret");
    for (const service of compiled.services.filter(service => service !== gateway)) expect(Object.values(service.secrets)).not.toContain("model-secret");
  });
  it("enables Foundry Recon by default when the discovery database is configured", () => {
    const foundry = structuredClone(job);
    foundry.document.profile.intelligence = { ...foundry.document.profile.intelligence,
      provider: "azure_foundry", endpoint: "https://test.services.ai.azure.com/openai/v1",
      models: { low: "curated", med: "curated", high: "", xhigh: "" }, deployments: { med: "ehf-med" } };
    foundry.catalog.models[0]!.providers.azure_foundry = "gpt-4.1-mini";
    const discovery = { databaseUrl: "postgresql://migrator@database.example.com/ehf_discovery?sslmode=verify-full" };
    const withDiscovery = { ...inputs, databaseUrls: { ...inputs.databaseUrls, discovery: discovery.databaseUrl } };
    const compiled = compileAzureRuntime(foundry, withDiscovery, context);
    const worker = compiled.services.find(service => service.entrypoint === "discovery-worker")!;
    const cases = compiled.services.find(service => service.entrypoint === "case-api")!;
    expect(worker).toMatchObject({ external: false, replicas: 1, environment: {
      DISCOVERY_WEB_SEARCH_PROVIDER: "azure_foundry", DISCOVERY_FOUNDRY_DEPLOYMENT: "ehf-med",
      DISCOVERY_FOUNDRY_ENDPOINT: foundry.document.profile.intelligence.endpoint,
    }, secrets: { DISCOVERY_FOUNDRY_API_KEY: "model-secret" } });
    const legacy = compileAzureRuntime(foundry, { ...inputs, discovery: { ...discovery, companies: [] } }, context);
    expect(legacy.services.find(service => service.entrypoint === "discovery-worker")?.environment.DISCOVERY_FOUNDRY_DEPLOYMENT)
      .toBe("ehf-med");
    const disabled = compileAzureRuntime(foundry, { ...withDiscovery, discovery: { enabled: false } }, context);
    expect(disabled.services.some(service => service.entrypoint === "discovery-worker")).toBe(false);
    expect(disabled.migration.DISCOVERY_DATABASE_URL).toBeUndefined();
    expect(worker.environment).not.toHaveProperty("EXECUTION_DATABASE_URL");
    expect(worker.secrets).not.toHaveProperty("WORKLOAD_OAUTH_CLIENT_SECRET");
    expect(cases.environment.DISCOVERY_TENANT_ID).toBe(inputs.tenantId);
    expect(cases.secrets).not.toHaveProperty("DISCOVERY_FOUNDRY_API_KEY");
    expect(new URL(worker.environment.DISCOVERY_DATABASE_URL!).pathname).toBe("/ehf_discovery");
    expect(new URL(cases.environment.DISCOVERY_DATABASE_URL!).username)
      .not.toBe(new URL(worker.environment.DISCOVERY_DATABASE_URL!).username);
    expect(compiled.migration.DISCOVERY_DATABASE_URL).toBe(discovery.databaseUrl);
    expect(JSON.parse(compiled.migration.DEPLOYMENT_SERVICE_LOGINS!)).toHaveProperty("discovery-worker");
    expect(compileAzureRuntime(foundry, inputs, context).services.some(service => service.entrypoint === "discovery-worker")).toBe(false);
    expect(() => compileAzureRuntime(job, { ...inputs, discovery }, context)).toThrow("deployment.discovery_foundry_binding_required");
    expect(() => compileAzureRuntime(foundry, { ...inputs, discovery: { ...discovery, databaseUrl: inputs.databaseUrls.case } }, context))
      .toThrow("database.stores_must_be_distinct");
  });
  it("binds ADLS only to evidence storage and migration qualification without leaking credentials to other services", () => {
    const adlsJob = structuredClone(job);
    adlsJob.document.profile.foundation.objectStore = { provider: "adls_gen2", endpoint: "https://testaccount.dfs.core.windows.net", bucket: "evidence", credentialRef: "env:ADLS_CREDENTIAL" };
    const credential = { tenantId: "11111111-1111-1111-1111-111111111111", clientId: "22222222-2222-2222-2222-222222222222", clientSecret: "private-adls-secret", subscriptionId: "33333333-3333-3333-3333-333333333333", resourceGroup: "test" };
    const compiled = compileAzureRuntime(adlsJob, { ...inputs, secrets: { ...inputs.secrets, ADLS_CREDENTIAL: JSON.stringify(credential) } }, context);
    const cases = compiled.services.find(service => service.entrypoint === "case-api")!;
    expect(cases.environment).toMatchObject({ EVIDENCE_BLOB_PROVIDER: "adls_gen2", EVIDENCE_BLOB_IMMUTABILITY: "container_policy", EVIDENCE_BLOB_AZURE_CREDENTIAL_FILE: "/tmp/integralflow-secrets/adls-credential.json" });
    expect(cases.environment).not.toHaveProperty("EVIDENCE_BLOB_REGION");
    const files = JSON.parse(cases.secrets.INTEGRALFLOW_PRIVATE_FILES!);
    expect(JSON.parse(Buffer.from(files["adls-credential.json"], "base64").toString())).toEqual(credential);
    expect(JSON.parse(compiled.migration.DEPLOYMENT_OBJECT_STORE!)).toMatchObject({ provider: "adls_gen2", endpoint: adlsJob.document.profile.foundation.objectStore.endpoint, credentials: credential });
    for (const service of compiled.services.filter(service => service !== cases)) {
      expect(JSON.stringify(service)).not.toContain("private-adls-secret");
      expect(JSON.stringify(service)).not.toContain(files["adls-credential.json"]);
    }
    expect(() => compileAzureRuntime(adlsJob, inputs, context)).toThrow("deployment.secret_binding_missing");
    expect(() => compileAzureRuntime(adlsJob, { ...inputs, secrets: { ...inputs.secrets, ADLS_CREDENTIAL: inputs.secrets.OBJECT_STORE } }, context)).toThrow("blob.adls_credentials_invalid");
  });
  it("wires document services and keeps training access on the Factory worker", () => {
    const configured = structuredClone(job);
    const scope = "/subscriptions/11111111-1111-4111-8111-111111111111/resourceGroups/test";
    configured.document.profile.target.scopeId = scope;
    const extractionPlanDigest = "d".repeat(64);
    configured.document.profile.intelligence.documentServices = {
      modelTier: "low", extractionPlanDigest, azure: {
        resourceId: `${scope}/providers/Microsoft.CognitiveServices/accounts/documents`,
        layout: true, modelExtraction: false, factory: true,
      },
    };
    const bindings = structuredClone(inputs);
    for (const identity of ["skill-host", "document-factory-worker"]) {
      const secretRef = `${identity}-secret`;
      Object.assign(bindings.workload.clients, { [identity]: { clientId: identity, subject: `service:${identity}`, secretRef, scope: "integralflow" } });
      Object.assign(bindings.secrets, { [secretRef]: `private-workload-secret-${identity}` });
    }
    const digest = "a".repeat(64);
    const compiled = compileAzureRuntime(configured, {
      ...bindings, secrets: { ...bindings.secrets, EVIDENCE_TOKEN: "e".repeat(64), EVIDENCE_KEY: Buffer.alloc(32).toString("base64") },
      hostedServices: { skillHost: {}, evidencePipeline: { tokenRef: "env:EVIDENCE_TOKEN", dataKeyRef: "env:EVIDENCE_KEY" } },
    }, {
      ...context,
      hostImages: { "skill-host": `registry.example.com/skills@sha256:${digest}`, "evidence-pipeline": `registry.example.com/evidence@sha256:${digest}` },
      documents: {
        endpoint: "https://documents.cognitiveservices.azure.com", identityId: "document-reader", clientId: "document-client",
        workerIdentity: { id: "factory-identity", clientId: "factory-client" },
      },
    });
    const control = compiled.services.find(service => service.entrypoint === "control-api")!;
    const gateway = compiled.services.find(service => service.entrypoint === "capability-gateway")!;
    const web = compiled.services.find(service => service.entrypoint === "experience-bff")!;
    expect(control.environment).toMatchObject({ DOCUMENT_EXTRACTION_PLAN_DIGEST: extractionPlanDigest, DOCUMENT_LAYOUT_REMOTE_ALLOWED: "true", DOCUMENT_STUDIO_DEPLOYED: "true" });
    expect(gateway.environment.DOCUMENT_MODEL_REMOTE_ALLOWED).toBeUndefined();
    expect(gateway.documentIdentityId).toBe("document-reader");
    expect(web.environment.BFF_DOCUMENT_PLAN_DIGEST).toBe(extractionPlanDigest);
    expect(web.environment.AZURE_CLIENT_ID).toBeUndefined();
    const worker = compiled.hostedServices.find(service => service.entrypoint === "document-factory-worker")!;
    expect(worker).toMatchObject({ external: false, documentIdentityId: "factory-identity", args: ["python", "-m", "document_factory.worker", "run"], environment: { AZURE_CLIENT_ID: "factory-client", WORKLOAD_AUTH: "workload_identity" } });
    expect(worker.secrets).toEqual({});
    expect(worker.sidecar?.environment.WORKLOAD_OAUTH_CLIENT_ID).toBe("document-factory-worker");
  });
  it("supplies document service credentials only to the capability gateway", () => {
    const withDocuments = structuredClone(job);
    withDocuments.document.profile.intelligence.documentIntelligence = { endpoint: "https://documents.example.com", credentialRef: "env:DOCUMENT_TOKEN" };
    const compiled = compileAzureRuntime(withDocuments, { ...inputs, secrets: { ...inputs.secrets, DOCUMENT_TOKEN: "private-document-token" } }, context);
    const gateway = compiled.services.find(service => service.entrypoint === "capability-gateway")!;
    expect(gateway.environment.EVIDENCE_PIPELINE_URL).toBe("https://documents.example.com");
    expect(gateway.secrets.EVIDENCE_PIPELINE_TOKEN).toBe("private-document-token");
    expect(compiled.services.filter(service => service !== gateway).some(service => JSON.stringify(service).includes("private-document-token"))).toBe(false);
    expect(JSON.stringify(compiled.migration)).not.toContain("private-document-token");
    expect(() => compileAzureRuntime(withDocuments, inputs, context)).toThrow("deployment.secret_binding_missing");
  });
  it("deploys the skill host and evidence pipeline from their own images, reachable only through the gateway", () => {
    const dataKey = Buffer.alloc(32, 7).toString("base64");
    const hostedInputs = { ...inputs,
      secrets: { ...inputs.secrets, "skill-host-secret": "private-workload-secret-skill-host", EVIDENCE_TOKEN: "e".repeat(64), EVIDENCE_KEY: dataKey },
      workload: { ...inputs.workload, clients: { ...inputs.workload.clients, "skill-host": { clientId: "skill-host", subject: "service:skill-host", secretRef: "skill-host-secret", scope: "integralflow" } } },
      hostedServices: { skillHost: {}, evidencePipeline: { tokenRef: "env:EVIDENCE_TOKEN", dataKeyRef: "env:EVIDENCE_KEY" } } };
    const hostImages = { "skill-host": `registry.example.com/integralflow-skill-host@sha256:${"b".repeat(64)}`, "evidence-pipeline": `registry.example.com/integralflow-evidence-pipeline@sha256:${"c".repeat(64)}` };
    const compiled = compileAzureRuntime(job, hostedInputs, { ...context, hostImages });
    const [skills, documents] = compiled.hostedServices;
    expect(compiled.services).toHaveLength(7);
    expect(skills).toMatchObject({ entrypoint: "skill-host", image: hostImages["skill-host"], external: false, probePath: "/healthz", replicas: 1, maxReplicas: 1 });
    expect(documents).toMatchObject({ entrypoint: "evidence-pipeline", image: hostImages["evidence-pipeline"], external: false, probePath: "/healthz", replicas: 1, maxReplicas: 1 });
    // The skill host verifies the gateway's delegated envelopes and its callers, and reads a token its sidecar projects.
    expect(skills!.environment).toMatchObject({ SECURITY_PROFILE: "production", WORKLOAD_AUTH: "workload_identity", WORKLOAD_TOKEN_FILE: "/var/run/integralflow-token/workload.jwt", SKILL_HOST_ENVELOPE_PUBLIC_KEY_PEM: compiled.keys.delegated!.publicKey });
    expect(JSON.parse(skills!.environment.WORKLOAD_IDENTITIES!)).toMatchObject({ "capability-gateway": "service:capability-gateway", "skill-host": "service:skill-host" });
    expect(JSON.stringify(skills!.environment) + JSON.stringify(skills!.secrets)).not.toContain("private-workload-secret-skill-host");
    expect(skills!.sidecar).toMatchObject({ environment: { SERVICE_NAME: "workload-token", WORKLOAD_OAUTH_SUBJECT: "service:skill-host" }, secrets: { WORKLOAD_OAUTH_CLIENT_SECRET: "private-workload-secret-skill-host" } });
    expect(documents!.secrets).toEqual({ EVIDENCE_PIPELINE_TOKEN: "e".repeat(64), KYC_DATA_KEY: dataKey });
    expect(documents!.volumes).toEqual([expect.objectContaining({ storageType: "AzureFile", storageName: "evidence-pipeline-data" })]);
    const gateway = compiled.services.find(service => service.entrypoint === "capability-gateway")!;
    expect(gateway.environment).toMatchObject({ GATEWAY_ADAPTERS: "default,skills", SKILL_HOST_AUTH: "platform_token",
      SKILL_HOST_URL: `https://${skills!.name}.internal.environment.example.com`, EVIDENCE_PIPELINE_URL: `https://${documents!.name}.internal.environment.example.com` });
    expect(gateway.secrets.EVIDENCE_PIPELINE_TOKEN).toBe("e".repeat(64));
    expect(JSON.parse(gateway.environment.WORKLOAD_IDENTITIES!)["skill-host"]).toBe("service:skill-host");
    // Other services never see the evidence pipeline's token or data key, or the skill host's credential.
    for (const service of compiled.services.filter(item => item !== gateway)) expect(JSON.stringify(service)).not.toMatch(new RegExp(`${"e".repeat(64)}|${dataKey.replace(/[+/]/g, "\\$&")}|private-workload-secret-skill-host`));
    expect(new Set([...compiled.services, ...compiled.hostedServices].map(service => service.name)).size).toBe(9);
    expect(() => compileAzureRuntime(job, hostedInputs, context)).toThrow("deployment.hosted_image_missing");
    expect(() => compileAzureRuntime(job, hostedInputs, { ...context, hostImages: { ...hostImages, "skill-host": "elsewhere.example.com/skills@sha256:" + "b".repeat(64) } })).toThrow("deployment.hosted_image_missing");
    expect(() => compileAzureRuntime(job, { ...hostedInputs, secrets: { ...hostedInputs.secrets, EVIDENCE_TOKEN: "short" } }, { ...context, hostImages })).toThrow("deployment.evidence_pipeline_token_weak");
    expect(() => compileAzureRuntime(job, { ...hostedInputs, secrets: { ...hostedInputs.secrets, EVIDENCE_KEY: "not-a-key" } }, { ...context, hostImages })).toThrow("deployment.evidence_pipeline_data_key_invalid");
    expect(() => compileAzureRuntime(job, { ...hostedInputs, secrets: { ...hostedInputs.secrets, "skill-host-secret": "private-workload-secret-control-api" } }, { ...context, hostImages })).toThrow("deployment.distinct_workload_credentials_required");
    const bound = structuredClone(job);
    bound.document.profile.intelligence.documentIntelligence = { endpoint: "https://documents.example.com", credentialRef: "env:EVIDENCE_TOKEN" };
    expect(() => compileAzureRuntime(bound, hostedInputs, { ...context, hostImages })).toThrow("deployment.document_intelligence_conflict");
    expect(compileAzureRuntime(job, inputs, context).hostedServices).toEqual([]);
  });
  it("approves the skill bundle in the migration job only when development auto-approval is chosen", () => {
    const hostedInputs = { ...inputs,
      secrets: { ...inputs.secrets, "skill-host-secret": "private-workload-secret-skill-host" },
      workload: { ...inputs.workload, clients: { ...inputs.workload.clients, "skill-host": { clientId: "skill-host", subject: "service:skill-host", secretRef: "skill-host-secret", scope: "integralflow" } } },
      hostedServices: { skillHost: { autoApproveBundle: true } } };
    const hostContext = { ...context, hostImages: { "skill-host": `registry.example.com/integralflow-skill-host@sha256:${"b".repeat(64)}` }, skillBundleLockDigest: "f".repeat(64) };
    expect(compileAzureRuntime(job, hostedInputs, hostContext).migration.DEPLOYMENT_SKILL_BUNDLE_LOCK_DIGEST).toBe("f".repeat(64));
    expect(compileAzureRuntime(job, { ...hostedInputs, hostedServices: { skillHost: {} } }, hostContext).migration.DEPLOYMENT_SKILL_BUNDLE_LOCK_DIGEST).toBeUndefined();
    const { skillBundleLockDigest: _unrecorded, ...withoutLock } = hostContext;
    expect(() => compileAzureRuntime(job, hostedInputs, withoutLock)).toThrow("deployment.skill_bundle_lock_unknown");
  });
  it("binds an Azure storage account by its credential shape, giving the key to the case service only", () => {
    const accountKey = Buffer.from("private-storage-account-key").toString("base64");
    const azureInputs = { ...inputs, secrets: { ...inputs.secrets, OBJECT_STORE: JSON.stringify({ provider: "azure_blob", accountName: "ehfevidence", accountKey }) } };
    const compiled = compileAzureRuntime(job, azureInputs, context);
    const caseApi = compiled.services.find(service => service.entrypoint === "case-api")!;
    expect(caseApi.environment).toMatchObject({ CASE_ARTIFACT_BACKEND: "object_store", EVIDENCE_BLOB_PROVIDER: "azure_blob", EVIDENCE_BLOB_ACCOUNT: "ehfevidence",
      EVIDENCE_BLOB_ENDPOINT: "https://objects.example.com", EVIDENCE_BLOB_BUCKET: "evidence", EVIDENCE_BLOB_IMMUTABILITY: "object_lock", EVIDENCE_BLOB_ACCOUNT_KEY_FILE: "/tmp/integralflow-secrets/object-store-key" });
    expect(Object.keys({ ...caseApi.environment, ...caseApi.secrets }).some(key => /^EVIDENCE_BLOB_(?:.*ACCESS_KEY|REGION)/.test(key))).toBe(false);
    expect(Buffer.from(JSON.parse(caseApi.secrets.INTEGRALFLOW_PRIVATE_FILES!)["object-store-key"], "base64").toString()).toBe(accountKey);
    expect(compiled.services.filter(service => service !== caseApi).some(service => JSON.stringify(service).includes(Buffer.from(accountKey).toString("base64")) || JSON.stringify(service).includes(accountKey))).toBe(false);
    expect(JSON.parse(compiled.migration.DEPLOYMENT_OBJECT_STORE!)).toEqual({ provider: "azure_blob", accountName: "ehfevidence", accountKey, endpoint: "https://objects.example.com", bucket: "evidence" });
    expect(compileAzureRuntime(job, inputs, context).services.find(service => service.entrypoint === "case-api")!.environment.EVIDENCE_BLOB_PROVIDER).toBeUndefined();
    expect(() => compileAzureRuntime(job, { ...inputs, secrets: { ...inputs.secrets, OBJECT_STORE: JSON.stringify({ provider: "azure_blob", accountName: "ehfevidence", accountKey, region: "x" }) } }, context)).toThrow();
  });
  it("isolates database and signing credentials, keeps internal services private and uses one digest-pinned image", () => {
    const compiled = compileAzureRuntime(job, inputs, context);
    expect(compiled.services).toHaveLength(7);
    expect(compiled.services.every(service => service.name.length <= 32)).toBe(true);
    expect(compiled.services.filter(service => service.external).map(service => service.entrypoint)).toEqual(["experience-bff"]);
    for (const name of ["experience-bff", "runtime-host"]) {
      const service = compiled.services.find(service => service.entrypoint === name)!;
      expect(Object.keys(service.environment).some(key => key.includes("DATABASE_URL"))).toBe(false);
      expect(service.secrets.INTEGRALFLOW_PRIVATE_FILES).not.toContain("pgpass");
    }
    const gateway = compiled.services.find(service => service.entrypoint === "capability-gateway")!;
    expect(gateway.environment.CONTROL_API_URL).toContain(".internal.");
    expect(gateway.environment).not.toHaveProperty("PGPASSWORD");
    expect(Object.entries(gateway.secrets).find(([key]) => key.startsWith("ONBOARDING_MODEL_TOKEN_"))?.[1]).toBe("model-secret");
    expect(Object.keys(compiled.services.find(service => service.entrypoint === "control-api")!.secrets).some(key => key.startsWith("ONBOARDING_MODEL_TOKEN_"))).toBe(false);
    const logins = JSON.parse(compiled.migration.DEPLOYMENT_SERVICE_LOGINS!);
    expect(new Set(Object.values(logins).map((entry: any) => entry.password)).size).toBe(6);
    expect(Object.keys(logins)).toContain("queue-scaler");
    const again = compileAzureRuntime(job, inputs, context, compiled.keys);
    expect(again.keys).toEqual(compiled.keys);
  });
  it("rejects duplicate service subjects, unreviewed databases and missing secret bindings", () => {
    const duplicate = structuredClone(inputs); duplicate.workload.clients["control-api"]!.subject = duplicate.workload.clients["case-api"]!.subject;
    expect(() => compileAzureRuntime(job, duplicate, context)).toThrow("deployment.distinct_workload_clients_required");
    expect(() => compileAzureRuntime(job, { ...inputs, secrets: {} }, context)).toThrow();
    expect(() => compileAzureRuntime(job, { ...inputs, databaseUrls: { ...inputs.databaseUrls, case: inputs.databaseUrls.case.replace("database.example.com", "another.example.com") } }, context)).toThrow("database.profile_target_mismatch");
  });
  it("derives ports, names, replicas and database grants from the shared runtime topology", () => {
    const resilient = structuredClone(job); resilient.document.profile.foundation.posture = "resilient";
    const compiled = compileAzureRuntime(resilient, inputs, context);
    for (const service of RUNTIME_SERVICES) {
      const deployed = compiled.services.find(item => item.entrypoint === service.entrypoint)!;
      expect(deployed.port).toBe(service.port);
      expect(deployed.name).toBe(azureApplicationName(context.name, service.entrypoint));
      expect(deployed.replicas).toBe(service.scale.trigger === "http" ? 2 : 1);
      expect(deployed.maxReplicas).toBe(service.scale.maxReplicas);
      expect([deployed.cpu, deployed.memory]).toEqual([service.size.cpu, service.size.memory]);
    }
    // The bootstrap predicts the public application origin with the same naming function.
    expect(compiled.applicationUrl).toBe(`https://${azureApplicationName(context.name, "experience-bff")}.${context.defaultDomain}`);
    // Every database a service is planned to reach has login grants, and nothing more.
    expect(Object.fromEntries(Object.entries(SERVICE_DATABASE_GRANTS).map(([service, grants]) => [service, Object.keys(grants).sort()])))
      .toEqual(Object.fromEntries(RUNTIME_SERVICES.filter(service => service.databases.length).map(service => [service.entrypoint, [...service.databases].sort()])));
  });
  it("routes services through a pooler while migrations and LISTEN stay on the direct port", () => {
    const compiled = compileAzureRuntime(job, { ...inputs, database: { pooler: { port: 6432 }, servicePoolMax: 8 } }, context);
    const dispatcher = compiled.services.find(service => service.entrypoint === "runtime-worker")!;
    expect(new URL(dispatcher.environment.DATABASE_URL!).port).toBe("6432");
    expect(new URL(dispatcher.environment.DATABASE_LISTEN_URL!).port).toBe("");
    expect(dispatcher.environment.DB_POOL_MAX).toBe("8");
    const files = JSON.parse(dispatcher.secrets.INTEGRALFLOW_PRIVATE_FILES!);
    expect(Buffer.from(files.pgpass, "base64").toString()).toMatch(/:6432:control:[^\n]+\n[^\n]+:5432:control:/);
    for (const service of compiled.services.filter(item => item.entrypoint !== "runtime-worker")) expect(service.environment.DATABASE_LISTEN_URL).toBeUndefined();
    expect(new URL(compiled.migration.DATABASE_URL!).port).toBe("");
    expect(compiled.pooled).toBe(true);
    expect(compiled.connectionBudget.control).toBeGreaterThan(compiled.connectionBudget.case!);
  });
  it("gives only the workers a queue-depth rule whose credential never reaches a container", () => {
    const compiled = compileAzureRuntime(job, inputs, context);
    for (const service of compiled.services) {
      const definition = RUNTIME_SERVICES.find(item => item.entrypoint === service.entrypoint)!;
      const rule = service.rules[0] as any;
      if (definition.scale.trigger === "queue") {
        expect(rule.custom.type).toBe("postgresql");
        expect(rule.custom.metadata.query).toMatch(/^select (harness_runtime\.ready_run_count|integration\.ready_work_count)\(\)$/);
        expect(new URL(service.scaleSecrets.QUEUE_SCALER_CONNECTION!).username).toMatch(/_scaler_/);
      } else {
        expect(rule.http.metadata.concurrentRequests).toBe(String(definition.scale.concurrentRequests));
        expect(service.scaleSecrets).toEqual({});
      }
      expect(JSON.stringify({ environment: service.environment, secrets: service.secrets })).not.toContain("_scaler_");
    }
  });
  it("keeps workers at their minimum when the database uses a private CA, and honours replica overrides", () => {
    const compiled = compileAzureRuntime(job, { ...inputs, databaseCaPem: "-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----", scaling: { "runtime-worker": { maxReplicas: 10 }, "control-api": { maxReplicas: 1 } } }, context);
    const dispatcher = compiled.services.find(service => service.entrypoint === "runtime-worker")!;
    expect([dispatcher.replicas, dispatcher.maxReplicas, dispatcher.rules]).toEqual([1, 1, []]);
    expect(JSON.parse(compiled.migration.DEPLOYMENT_SERVICE_LOGINS!)).not.toHaveProperty("queue-scaler");
    expect(compiled.services.find(service => service.entrypoint === "control-api")!.maxReplicas).toBe(1);
    expect(() => compileAzureRuntime(job, { ...inputs, scaling: { "not-a-service": { maxReplicas: 2 } } }, context)).toThrow();
  });
  it("applies one set of model limits to the profile file and the migration job", () => {
    const compiled = compileAzureRuntime(job, { ...inputs, modelLimits: { maxConcurrency: 16 } }, context);
    expect(JSON.parse(compiled.migration.DEPLOYMENT_MODEL_LIMITS!)).toEqual({ maxConcurrency: 16, timeoutMs: 60000, maxOutputTokens: 2048 });
    const gateway = compiled.services.find(service => service.entrypoint === "capability-gateway")!;
    const models = JSON.parse(Buffer.from(JSON.parse(gateway.secrets.INTEGRALFLOW_PRIVATE_FILES!)["models.json"], "base64").toString());
    expect(models.profiles.every((profile: any) => profile.maxConcurrency === 16)).toBe(true);
    expect(() => compileAzureRuntime(job, { ...inputs, modelLimits: { maxConcurrency: 65 } }, context)).toThrow();
  });
});

it("mounts approved context-source credentials and destinations only on the gateway",()=>{
  const source={id:"customers",name:"Customers",provider:"postgresql",endpoint:"postgresql://source.example.com:5432/customer",credentialRef:"env:CUSTOMER_SOURCE",identityMode:"service",openapiPath:"/openapi.json",resource:{database:"customer",schema:"public",object:"customers",catalog:"",warehouse:"",project:""}};
  const compiled=compileAzureRuntime(job,{...inputs,contextSources:[source],secrets:{...inputs.secrets,CUSTOMER_SOURCE:"private-context-source-value"}},context);
  const gateway=compiled.services.find(service=>service.entrypoint==="capability-gateway")!;
  expect(gateway.environment.GATEWAY_ADAPTERS).toBe("default,context-source");
  expect(gateway.environment.CONTEXT_SOURCE_TARGETS_JSON).toContain(source.endpoint);
  expect(gateway.secrets.CUSTOMER_SOURCE).toBe("private-context-source-value");
  expect(compiled.services.filter(service=>service!==gateway).some(service=>JSON.stringify(service).includes("private-context-source-value"))).toBe(false);
  expect(JSON.stringify(compiled.migration)).not.toContain("private-context-source-value");
  expect(()=>compileAzureRuntime(job,{...inputs,contextSources:[{...source,credentialRef:"env:WORKLOAD_OAUTH_CLIENT_SECRET"}]},context)).toThrow("context_secret_name_reserved");
});

it('binds evaluation job authority only to the control plane and requires a pinned sandbox image',()=>{
 const workbench={jobId:'/subscriptions/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/resourceGroups/workbench-test/providers/Microsoft.App/jobs/source-evaluator',image:`registry.example.com/evaluator@sha256:${'d'.repeat(64)}`,storageAccount:'workbenchtest',storageContainer:'workbench-evaluations',identityId:'/subscriptions/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/resourceGroups/workbench-test/providers/Microsoft.ManagedIdentity/userAssignedIdentities/evaluation-controller',identityClientId:'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'};
 const compiled=compileAzureRuntime(job,{...inputs,workbench},context);
 const control=compiled.services.find(service=>service.entrypoint==='control-api')!;
 expect(control.evaluationIdentityId).toBe(workbench.identityId);expect(control.environment.WORKBENCH_EVALUATOR_BACKEND).toBe('azure_jobs');
 expect(compiled.services.filter(service=>service!==control).every(service=>!service.evaluationIdentityId&&!Object.keys(service.environment).some(key=>key.startsWith('WORKBENCH_')))).toBe(true);
 expect(()=>compileAzureRuntime(job,{...inputs,workbench:{...workbench,image:'registry.example.com/evaluator:latest'}},context)).toThrow();
});
