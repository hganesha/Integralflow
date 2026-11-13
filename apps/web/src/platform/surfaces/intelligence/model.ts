import type { Schemas } from "@ehf/ui-contracts";

export type Index = Schemas["IntelligenceIndex"];
export type Definition = Schemas["IntelligenceDefinition"];
export type Candidate = Schemas["IntelligenceRecord"];
export type ServiceClass = Definition["serviceClass"];
export type Tier = Schemas["IntelligenceReasoningConfiguration"]["tier"];
export const TIERS: readonly Tier[] = ["low", "med", "high", "xhigh"];
export const TIER_LABELS: Record<Tier, string> = { low: "Low", med: "Med", high: "High", xhigh: "XHigh" };
export const TIER_PURPOSE: Record<Tier, string> = {
  low: "Routing, extraction and classification", med: "Everyday synthesis and agent steps",
  high: "Complex investigation and evidence synthesis", xhigh: "Exceptional ambiguity with explicit budgets",
};
export const SERVICE_LABELS: Record<ServiceClass, string> = { reasoning: "Reasoning", runtime: "Agent runtimes", inference: "ML inference", document: "Document Intelligence", decision: "System 1 Decisions", mcp: "MCP servers & tools" };
export const SERVICE_PURPOSE: Record<ServiceClass, string> = {
  mcp: "Register MCP servers and exact tool allowlists with pinned schemas, workload or delegated identity, effects and approval policy. Catalog changes require review before use.",
  reasoning: "Model requests with qualified effort, output and token budgets.",
  runtime: "Invocation, status and cancellation with independent workload and callback identities.",
  inference: "Versioned features, prediction semantics, freshness and calibration. Invalid or stale features must abstain; thresholds remain domain policy.",
  document: "OCR, layout, extraction, classification and splitting with page provenance, bounded jobs and review on uncertain results.",
  decision: "Fast, atomic judgments over typed state: choices, rubric scores, truth probabilities and boxes. Missing or insufficient confidence must abstain when a threshold is set; policy controls business actions.",
};
export const BINDING_PREFIX: Record<ServiceClass, string> = { reasoning: "reasoning.", runtime: "runtime.", inference: "ml.", document: "document.", decision: "decision.", mcp: "mcp." };
export const CLOUD_LABELS: Record<Definition["connection"]["cloud"], string> = {
  azure: "Microsoft Azure / Foundry",
  aws: "AWS", gcp: "Google Cloud", databricks: "Databricks", saas: "Hosted service / API", gateway: "Enterprise gateway", private: "Private / on premises",
};
export const AUTH_LABELS: Record<Definition["connection"]["auth"]["mode"], string> = {
  unconfigured: "Choose authentication", workload_identity: "Platform workload identity", aws_iam: "AWS IAM / STS", gcp_federation: "Google workload federation",
  oauth_m2m: "OAuth machine to machine", oauth_delegated: "OAuth delegated user", mtls: "Mutual TLS", provider_key: "Provider key reference", platform_token: "Platform token reference",
};
const SUGGESTIONS: Partial<Record<Tier, string>> = { low: "model.fast.v1", med: "model.standard.v1", high: "model.deep.v1" };
export const suggestedProfile = (index: Index, tier: Tier) => index.profiles.find(profile => profile.profile.id === SUGGESTIONS[tier]);
export const currentReport = (index: Index, candidate: Candidate) => index.reports.find(report => report.bindingId === candidate.definition.id && report.revision === candidate.revision && report.digest === candidate.digest);

export function newDefinition(serviceClass: ServiceClass, owner: string, tier: Tier = "med"): Definition {
  const cloud = serviceClass === "mcp" ? "gateway" : serviceClass === "reasoning" || serviceClass === "decision" ? "saas" : "private";
  const adapterId = { reasoning: "openrouter", runtime: "hosted_http", inference: "private_inference", document: "private_document", decision: "jev", mcp: "mcp_gateway" }[serviceClass];
  const common = { schemaVersion: "intelligence.binding.v1" as const, name: "", id: "", owner, description: "", dataClass: "internal" as const,
    connection: { cloud, adapterId, endpoint: null, account: "", resourceId: "", region: "", networkZone: "",
      auth: { mode: "unconfigured" as const, principal: "", audience: "", issuer: "", subject: "", credentialRef: null, clientIdRef: null, certificateRef: null } } as Definition["connection"],
  };
  if (serviceClass === "reasoning") return { ...common, id: `reasoning.${tier}`, name: `${TIER_LABELS[tier]} reasoning`, serviceClass,
    configuration: { tier, profileId: null, model: "", nativeEffort: "provider_default", maxOutputTokens: 2400, timeoutMs: 45000, maxConcurrency: 4, outputMode: "text", toolCalling: false, evaluationRef: "" } };
  if (serviceClass === "runtime") return { ...common, serviceClass, configuration: { target: null, agentName: "", agentVersion: "", imageDigest: null, lifecycleEndpoint: null, lifecycleAudience: "", maxConcurrency: 4, timeoutMs: 120000, callbackNetwork: "" } };
  if (serviceClass === "mcp") return { ...common, serviceClass, configuration: { transport: "streamable_http", protocolVersion: "", serverName: "", serverVersion: "", identityMode: "workload", scopes: [], catalogSource: "pinned_snapshot", catalogRef: "", catalogDigest: null, tools: [], launchProfileRef: "", policyRef: "", evaluationRef: "", catalogChangeBehavior: "block", timeoutMs: 30000, maxConcurrency: 4, maxResultBytes: 1048576, unavailableBehavior: "deny" } };
  if (serviceClass === "document") return { ...common, serviceClass, configuration: { capabilityId: "document.analyze.v1", operation: "layout", model: "", modelVersion: "", apiVersion: "", outputSchemaRef: "", locale: "", features: [], executionMode: "asynchronous", maxPages: 100, maxBytes: 20971520, timeoutMs: 120000, pollIntervalMs: 2000, resultStoreRef: "", provenanceRequired: true, minConfidence: 0.8, unavailableBehavior: "review", evaluationRef: "" } };
  if (serviceClass === "decision") return { ...common, serviceClass, configuration: { capabilityId: "decision.classify.v1", primitive: "choice", model: "", modelVersion: "", stateSchemaRef: "", questionSetRef: "", outputSchemaRef: "", options: ["match", "no_match"], confidenceMode: "none", minConfidence: 0, calibrationRef: "", policyRef: "", evaluationRef: "", maxQuestions: 10, timeoutMs: 5000, unavailableBehavior: "abstain" } };
  return { ...common, serviceClass, configuration: { capabilityId: "risk.customer.assess.v1", modelVersion: "", featureSchemaRef: "", outputSchemaRef: "", preprocessingVersion: "", calibrationVersion: "", targetDefinition: "", predictionHorizon: "", scoreMin: 0, scoreMax: 1, scoreDirection: "higher_risk", maxFeatureAgeSeconds: 3600, timeoutMs: 30000, unavailableBehavior: "abstain", validationRef: "" } };
}

/** Local form feedback; authoritative validation remains at the control API. */
export function formErrors(definition: Definition, reason: string): string[] {
  const errors: string[] = [];
  if (!/^[a-z0-9][a-z0-9._-]{0,99}$/.test(definition.id)) errors.push("Use a stable binding ID with lowercase letters, digits, dots, underscores or dashes.");
  const prefix = BINDING_PREFIX[definition.serviceClass];
  if (!definition.id.startsWith(prefix) || definition.id.length === prefix.length) errors.push(`Use a named binding in the ${prefix} namespace.`);
  if (!definition.name.trim() || !definition.owner.trim()) errors.push("Name and owner are required.");
  if (!reason.trim()) errors.push("A change reason is required.");
  for (const [label, value] of [["Endpoint", definition.connection.endpoint], ["Lifecycle endpoint", definition.serviceClass === "runtime" ? definition.configuration.lifecycleEndpoint : null]]) {
    if (!value) continue;
    try { const url = new URL(value); if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error(); }
    catch { errors.push(`${label}: use HTTPS without embedded credentials, query parameters or a fragment.`); }
  }
  for (const value of [definition.connection.auth.credentialRef, definition.connection.auth.clientIdRef, definition.connection.auth.certificateRef]) if (value && !/^[A-Z][A-Z0-9_]{2,64}$/.test(value)) errors.push("Credential and certificate fields accept environment variable names only.");
  const config = definition.configuration;
  const limit = (value: number, minimum: number, maximum: number, label: string) => { if (!Number.isInteger(value) || value < minimum || value > maximum) errors.push(`${label} must be an integer from ${minimum.toLocaleString()} to ${maximum.toLocaleString()}.`); };
  limit(config.timeoutMs, 1, definition.serviceClass === "runtime" ? 3600000 : 600000, "Timeout");
  if (definition.serviceClass === "reasoning") { limit(definition.configuration.maxOutputTokens, 1, 200000, "Output tokens"); limit(definition.configuration.maxConcurrency, 1, 64, "Concurrency"); }
  if (definition.serviceClass === "runtime") {
    limit(definition.configuration.maxConcurrency, 1, 1000, "Concurrency");
    if (definition.configuration.target && !/^[a-z][a-z0-9_]{1,39}(:[a-z0-9][a-z0-9._-]{0,99})?$/.test(definition.configuration.target)) errors.push("Runtime target must be adapter or adapter:binding.");
    if (definition.configuration.imageDigest && !/^sha256:[a-f0-9]{64}$/.test(definition.configuration.imageDigest)) errors.push("Image digest must be sha256 followed by 64 hexadecimal characters.");
  }
  if (definition.serviceClass === "inference") {
    const inference = definition.configuration;
    if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+\.v[0-9]+$/.test(inference.capabilityId)) errors.push("Use a versioned capability ID, for example risk.customer.assess.v1.");
    if (!Number.isFinite(inference.scoreMin) || !Number.isFinite(inference.scoreMax) || inference.scoreMin >= inference.scoreMax) errors.push("Score maximum must exceed its minimum.");
    limit(inference.maxFeatureAgeSeconds, 1, 31536000, "Feature age");
  }
  if (definition.serviceClass === "document") {
    const config = definition.configuration;
    limit(config.maxPages, 1, 10000, "Page limit"); limit(config.maxBytes, 1, 536870912, "Byte limit"); limit(config.pollIntervalMs, 100, 60000, "Poll interval");
    if (!Number.isFinite(config.minConfidence) || config.minConfidence < 0 || config.minConfidence > 1) errors.push("Confidence threshold must be from 0 to 1.");
  }
  if (definition.serviceClass === "decision") {
    const config = definition.configuration;
    limit(config.maxQuestions, 1, 100, "Question limit");
    if (["choice", "score"].includes(config.primitive) && config.options.length < 2) errors.push("Choice and score require at least two labels or rubric levels.");
    if (config.options.length > 100 || config.options.some(option => !option.trim() || option.length > 120) || new Set(config.options.map(option => option.trim())).size !== config.options.length) errors.push("Use up to 100 unique, nonempty labels of at most 120 characters.");
    if (!Number.isFinite(config.minConfidence) || config.minConfidence < 0 || config.minConfidence > 1) errors.push("Confidence threshold must be from 0 to 1.");
    if (config.confidenceMode === "none" && config.minConfidence !== 0) errors.push("A confidence threshold requires a declared confidence source.");
  }
  if (definition.serviceClass === "mcp") {
    const mcp = definition.configuration;
    limit(mcp.maxConcurrency, 1, 64, "Concurrency"); limit(mcp.maxResultBytes, 1, 10485760, "Result byte limit");
    if (mcp.protocolVersion && !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(mcp.protocolVersion)) errors.push("Use an MCP protocol revision in YYYY-MM-DD format.");
    if (mcp.catalogDigest && !/^[a-f0-9]{64}$/.test(mcp.catalogDigest)) errors.push("Catalog digest must be 64 lowercase hexadecimal characters.");
    if (mcp.tools.length > 50) errors.push("Register at most 50 tools per server binding.");
    if (new Set(mcp.tools.map(tool => tool.name.trim())).size !== mcp.tools.length) errors.push("Tool names must be unique.");
    if (new Set(mcp.tools.map(tool => tool.capabilityId)).size !== mcp.tools.length) errors.push("Tool capability IDs must be unique.");
    if (mcp.tools.some(tool => !tool.name.trim() || tool.name.length > 128 || /[\s*]/.test(tool.name))) errors.push("Use exact tool names without whitespace or wildcards (up to 128 characters).");
    if (mcp.tools.some(tool => !/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+\.v[0-9]+$/.test(tool.capabilityId))) errors.push("Each tool needs a versioned capability ID, for example mcp.customer.lookup.v1.");
    if (mcp.scopes.length > 30 || mcp.scopes.some(scope => !scope.trim() || scope.length > 120) || new Set(mcp.scopes).size !== mcp.scopes.length) errors.push("Use up to 30 unique, nonempty scopes of at most 120 characters.");
  }
  if (definition.serviceClass === "document" || definition.serviceClass === "decision") {
    if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+\.v[0-9]+$/.test(definition.configuration.capabilityId)) errors.push("Use a versioned capability ID, for example document.analyze.v1 or decision.classify.v1.");
  }
  return [...new Set(errors)];
}
