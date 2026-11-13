import type { FoundryInvocationLink } from "@ehf/contracts/foundry";
import type { AccessTokenProvider, AdapterResult } from "@ehf/adapters";
import type { CapabilityDefinition, ExecutionEnvelopeClaims, HarnessPlanV2 } from "@ehf/contracts";
import type { Database } from "@ehf/persistence";
import type { FinancialCrimeExecution } from "./financial-crime.js";

export type AdapterBindingOption = {
  value: string;
  label: string;
  description?: string;
};

/** Where an adapter's provider runs; `any` for adapters that are cloud-neutral. */
export type AdapterCloud = "local" | "databricks" | "vendor" | "any";

export type AdapterDescriptor = {
  id: string;
  label: string;
  supportedKinds: CapabilityDefinition["kind"][];
  credentialState: "Configured" | "Missing" | "Not required";
  bindingOptions: AdapterBindingOption[];
  /** Set by the registry from the adapter's module. */
  cloud?: AdapterCloud;
  /** Set by the registry: whether GATEWAY_ADAPTERS enables this adapter. */
  enabled?: boolean;
};

export type AdapterInvocationContext = {
  sourceAuthorization?: {
    checkEndpoint?: (endpoint: URL) => Promise<void>;
    purpose: string; legalBasis: string; policyId: string; policyVersion: string; jurisdictions: string[];
    processingRegions: string[]; datasetIds: string[]; bindingDatasetIds: string[]; signRequest: (body: string) => Promise<string>;
  };
  tenantId: string;
  invocationId?: string;
  signal?: AbortSignal;
  onFoundryDispatch?: () => void;
  recordFoundryInvocationLink?: (link: FoundryInvocationLink) => void;
  expectedModelProfileDigest?: string | null;
  recordAttributes?: (attributes: Record<string, string | number | boolean>) => void;
  /**
   * The verified execution authority of this invocation. Only adapters that act on the
   * caller's behalf beyond one provider call need it: the `skills` adapter exchanges the node
   * envelope for a delegated envelope and reads the node's pinned skill binding from the plan.
   */
  execution?: {
    envelope: string;
    claims: ExecutionEnvelopeClaims;
    plan: HarnessPlanV2;
    traceparent?: string;
    /** Aborted when the caller goes away; adapters cancel remote work on it. */
    signal?: AbortSignal;
  };
  /**
   * The original a document run was started with, for the `document-model` adapter only: decoded from the run's
   * own input and checked against its version (adapters/document-model.ts `documentOfRun`).
   */
  runDocument?: { documentVersion: string; filename: string; content: Uint8Array };
  /** Gateway-derived authority for the `financial-crime` adapter (see adapters/financial-crime.ts). */
  financialCrimeExecution?: FinancialCrimeExecution;
};

export type ExecutableAdapter = {
  descriptor: (tenantId: string) => Promise<AdapterDescriptor>;
  normalizeBinding?: (bindingName: string) => string;
  /**
   * For adapters whose operation space is a catalog rather than a short list: decides
   * whether a binding is well formed, and `bindingOptions` only advertises examples.
   */
  acceptsBinding?: (bindingName: string) => boolean;
  /**
   * Refuses a capability contract this adapter must not serve (for example a vendor agent
   * declared with an effect weaker than `paid`, or a wiring operation that serves another
   * capability). Checked at registration and invocation, with the normalized binding name.
   */
  assertCapability?: (capability: CapabilityDefinition, bindingName: string) => void;
  invoke: (
    bindingName: string,
    capability: CapabilityDefinition,
    input: unknown,
    context: AdapterInvocationContext,
  ) => Promise<AdapterResult>;
};

export type DelegatedEnvelopeRequest = { skillId: string; skillVersion: string; capabilities: string[]; deadlineAt: string };
export type DelegateEnvelope = (
  callerTenantId: string, parentEnvelope: string, request: DelegatedEnvelopeRequest,
) => Promise<{ envelope: string; expiresAt: string; capabilities: string[] }>;

/** What a module may use to build its adapter. Credentials come only from `env`. */
export type AdapterModuleDeps = {
  env: NodeJS.ProcessEnv;
  fetch: typeof globalThis.fetch;
  db: Database;
  modelProfilesPath: string;
  /**
   * The gateway's own service credential, the same one for every service it calls: the
   * development token (`GATEWAY_SERVICE_TOKEN`) or its workload-identity token.
   */
  workloadToken: AccessTokenProvider;
  /**
   * Issue a delegated envelope for a skill execution (skill.execution.v1 §6.1), in-process:
   * the gateway is the only component that presents or accepts one, so no other service is
   * involved. Refusals throw `EnvelopeAuthorityError` with a `broker.*` reason code.
   */
  delegate: DelegateEnvelope;
  /** Test seams for adapters that poll. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

/**
 * Published in config/connector-catalog.json (`connectorTemplates`) for adapters whose binding
 * names are deployment-specific (an endpoint, an index, a deployment). An operator registers a
 * concrete connector from it with POST /v1/connectors.
 */
export type ConnectorTemplateSpec = {
  bindingPattern: RegExp;
  capabilityIds: string[];
  configEnv: string[];
  description: string;
};

/** One pluggable gateway adapter. See docs/implementation/capability-adapters.md. */
export type CapabilityAdapterModule = {
  /** Reviewed platform code classification. Unclassified modules require external source policy. */
  sourcePolicyClass?: "platform_internal" | "synthetic";
  /** The adapter ID: the `<adapter>` in `<adapter>:<binding>`. */
  id: string;
  cloud: AdapterCloud;
  label: string;
  supportedKinds: CapabilityDefinition["kind"][];
  /**
   * Enabled when GATEWAY_ADAPTERS is unset. True for adapters that need no cloud
   * configuration to be registered (they report `Missing` credentials until configured).
   */
  enabledByDefault: boolean;
  connectorTemplate?: ConnectorTemplateSpec;
  create(deps: AdapterModuleDeps): ExecutableAdapter;
};
