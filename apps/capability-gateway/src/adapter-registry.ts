import {
  EVIDENCE_PIPELINE_OPERATIONS,
  KYC_WIRING_OPERATION_PATTERN,
  type AccessTokenProvider,
  type AdapterResult,
} from "@ehf/adapters";
import type { CapabilityDefinition } from "@ehf/contracts";
import { createWorkloadTokenProvider } from "@ehf/identity";
import type { Database } from "@ehf/persistence";
import { ADAPTER_MODULES } from "./adapters/index.js";
import { financialCrimeModule, type FinancialCrimeBinding } from "./adapters/financial-crime.js";
import { openSanctionsOperations } from "./adapters/opensanctions.js";
import { simulatorOperations } from "./adapters/simulator.js";
import { DOCUMENT_FIELDS_BINDING_PREFIX } from "./adapters/openrouter.js";
import type {
  AdapterCloud,
  AdapterDescriptor,
  AdapterInvocationContext,
  AdapterModuleDeps,
  CapabilityAdapterModule,
  DelegateEnvelope,
  ExecutableAdapter,
} from "./adapters/types.js";

export type {
  AdapterBindingOption,
  AdapterCloud,
  AdapterDescriptor,
  AdapterInvocationContext,
  AdapterModuleDeps,
  CapabilityAdapterModule,
  ConnectorTemplateSpec,
  DelegateEnvelope,
  ExecutableAdapter,
} from "./adapters/types.js";
export { ADAPTER_MODULES } from "./adapters/index.js";
export type { FinancialCrimeBinding, FinancialCrimeExecution } from "./adapters/financial-crime.js";
export { kycServiceState, resolveOpenAICompatibleEndpoint, type KycService } from "./adapters/shared.js";

type AdapterRegistryOptions = {
  db: Database;
  env: NodeJS.ProcessEnv;
  fetch: typeof globalThis.fetch;
  modelProfilesPath: string;
  /** The gateway's outgoing service credential; defaults to its configured workload credential. */
  workloadToken?: AccessTokenProvider;
  /** In-process delegated-envelope issuance for the `skills` adapter (see delegation.ts). */
  delegate?: DelegateEnvelope;
  /** The loadable modules; defaults to ADAPTER_MODULES. */
  modules?: readonly CapabilityAdapterModule[];
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Canonical financial-crime catalog and bridge; registers the `financial-crime` adapter. */
  financialCrime?: FinancialCrimeBinding;
};

/** The adapters enabled when GATEWAY_ADAPTERS is unset, in registration order. */
export const REGISTERED_ADAPTER_IDS: readonly string[] = ADAPTER_MODULES.filter((module) => module.enabledByDefault).map((module) => module.id);

/** Every adapter module ID this gateway can load. */
export const ADAPTER_MODULE_IDS: readonly string[] = ADAPTER_MODULES.map((module) => module.id);

/**
 * The adapter IDs a deployment enables. GATEWAY_ADAPTERS is a comma list of module IDs;
 * the entry `default` stands for every module enabled by default, so
 * `GATEWAY_ADAPTERS=default,databricks-serving` adds one adapter to the usual set. Unset
 * means the default set. An unknown ID fails startup rather than silently serving less.
 */
export function resolveEnabledAdapterIds(
  env: NodeJS.ProcessEnv,
  modules: readonly CapabilityAdapterModule[] = ADAPTER_MODULES,
): string[] {
  const defaults = modules.filter((module) => module.enabledByDefault).map((module) => module.id);
  const raw = env.GATEWAY_ADAPTERS?.trim();
  if (!raw) return defaults;
  const known = new Set(modules.map((module) => module.id));
  const wanted = new Set<string>();
  for (const entry of raw.split(",").map((item) => item.trim()).filter(Boolean)) {
    if (entry === "default") defaults.forEach((id) => wanted.add(id));
    else if (known.has(entry)) wanted.add(entry);
    else throw new Error(`gateway.adapter_module_unknown: ${entry.slice(0, 64)}`);
  }
  if (wanted.size === 0) throw new Error("gateway.adapter_modules_empty");
  return modules.map((module) => module.id).filter((id) => wanted.has(id));
}

/** A connector template as published in config/connector-catalog.json. */
export type PublishedConnectorTemplate = {
  adapterId: string;
  cloud: AdapterCloud;
  bindingPattern: string;
  capabilityIds: string[];
  configEnv: string[];
  description: string;
};

/** The templates the loadable modules publish, sorted by adapter ID. */
export function moduleConnectorTemplates(modules: readonly CapabilityAdapterModule[] = ADAPTER_MODULES): PublishedConnectorTemplate[] {
  return modules.flatMap((module) => module.connectorTemplate ? [{
    adapterId: module.id,
    cloud: module.cloud,
    bindingPattern: module.connectorTemplate.bindingPattern.source,
    capabilityIds: [...module.connectorTemplate.capabilityIds].sort(),
    configEnv: [...module.connectorTemplate.configEnv].sort(),
    description: module.connectorTemplate.description,
  }] : []).sort((left, right) => (left.adapterId < right.adapterId ? -1 : 1));
}

/**
 * Checks a connector catalog (config/connector-catalog.json) against this gateway: every
 * connector names a default-enabled adapter and a binding that adapter accepts, and every
 * connector template matches the module that publishes it. Model-profile bindings are
 * administered data, so the caller passes the profile IDs it expects.
 * Returns the problems found; an empty list means consistent.
 */
export function checkConnectorCatalogConsistency(
  catalog: {
    connectors: Array<{ connectorId: string; adapterId: string }>;
    connectorTemplates?: PublishedConnectorTemplate[];
  },
  options: { modelProfileIds: string[] },
): string[] {
  const staticBindings: Record<string, Set<string>> = {
    simulator: new Set(simulatorOperations.map((option) => option.value)),
    opensanctions: new Set(openSanctionsOperations.map((option) => option.value)),
    evidence: new Set(EVIDENCE_PIPELINE_OPERATIONS),
    pgvector: new Set(["knowledge.search"]),
    "document-model": new Set(["azure_document_intelligence"]),
    // `document_fields.<profile>` serves the skill library's document.fields through that profile.
    openrouter: new Set(options.modelProfileIds.flatMap((id) => [id, `${DOCUMENT_FIELDS_BINDING_PREFIX}${id}`])),
  };
  const registered = new Set<string>(REGISTERED_ADAPTER_IDS);
  const problems: string[] = [];
  for (const connector of catalog.connectors) {
    let parts: { adapterId: string; bindingName: string };
    try {
      parts = splitBinding(connector.connectorId);
    } catch {
      problems.push(`${connector.connectorId}: binding_invalid`);
      continue;
    }
    if (parts.adapterId !== connector.adapterId) problems.push(`${connector.connectorId}: adapter_mismatch`);
    if (!registered.has(parts.adapterId)) {
      problems.push(`${connector.connectorId}: adapter_unregistered`);
      continue;
    }
    const accepted = parts.adapterId === "wiring"
      ? KYC_WIRING_OPERATION_PATTERN.test(parts.bindingName)
      : staticBindings[parts.adapterId]?.has(parts.bindingName) ?? false;
    if (!accepted) problems.push(`${connector.connectorId}: binding_unsupported`);
  }
  const published = new Map(moduleConnectorTemplates().map((template) => [template.adapterId, template]));
  for (const template of catalog.connectorTemplates ?? []) {
    const expected = published.get(template.adapterId);
    if (!expected) {
      problems.push(`template ${template.adapterId}: adapter_unregistered`);
      continue;
    }
    const normalized = { ...template, capabilityIds: [...template.capabilityIds].sort(), configEnv: [...template.configEnv].sort() };
    if (JSON.stringify(normalized, Object.keys(expected).sort()) !== JSON.stringify(expected, Object.keys(expected).sort())) {
      problems.push(`template ${template.adapterId}: template_mismatch`);
    }
  }
  return problems;
}

function splitBinding(bindingId: string): { adapterId: string; bindingName: string } {
  const separator = bindingId.indexOf(":");
  if (separator <= 0 || separator === bindingId.length - 1) {
    throw new Error("gateway.capability_adapter_binding_invalid");
  }
  return { adapterId: bindingId.slice(0, separator), bindingName: bindingId.slice(separator + 1) };
}

function assertBindingOption(adapter: ExecutableAdapter, descriptor: AdapterDescriptor, bindingName: string): void {
  const accepted = adapter.acceptsBinding
    ? adapter.acceptsBinding(bindingName)
    : descriptor.bindingOptions.some((option) => option.value === bindingName);
  if (!accepted) {
    throw new Error("gateway.capability_adapter_binding_unsupported");
  }
}

export type AdapterModuleState = {
  id: string;
  label: string;
  cloud: AdapterCloud;
  supportedKinds: CapabilityDefinition["kind"][];
  enabled: boolean;
  enabledByDefault: boolean;
  connectorTemplate: Omit<PublishedConnectorTemplate, "adapterId" | "cloud"> | null;
};

export function createAdapterRegistry(options: AdapterRegistryOptions) {
  const modules = options.modules ?? ADAPTER_MODULES;
  const enabledIds = new Set(resolveEnabledAdapterIds(options.env, modules));
  // One deps object for every module, so modules sharing a connection can key on it.
  const deps: AdapterModuleDeps = {
    db: options.db,
    env: options.env,
    fetch: options.fetch,
    modelProfilesPath: options.modelProfilesPath,
    workloadToken: options.workloadToken ?? createWorkloadTokenProvider({ staticTokenEnv: "GATEWAY_SERVICE_TOKEN" }, options.env),
    delegate: options.delegate ?? (async () => { throw new Error("gateway.skills_delegation_unconfigured"); }),
    ...(options.sleep ? { sleep: options.sleep } : {}),
    ...(options.now ? { now: options.now } : {}),
  };
  const adapters = new Map<string, { module: CapabilityAdapterModule; adapter: ExecutableAdapter }>();
  for (const module of modules) {
    if (enabledIds.has(module.id)) adapters.set(module.id, { module, adapter: module.create(deps) });
  }
  if (options.financialCrime) {
    const module = financialCrimeModule(options.financialCrime);
    adapters.set(module.id, { module, adapter: module.create(deps) });
  }

  const descriptorFor = async (capability: CapabilityDefinition, tenantId: string) => {
    const { adapterId, bindingName } = splitBinding(capability.adapterBindingId);
    if (adapterId === "unconfigured") throw new Error("gateway.capability_adapter_unconfigured");
    const entry = adapters.get(adapterId);
    if (!entry) throw new Error("gateway.capability_adapter_unsupported");
    const { adapter } = entry;
    const descriptor = await adapter.descriptor(tenantId);
    const normalizedBindingName = adapter.normalizeBinding?.(bindingName) ?? bindingName;
    if (!descriptor.supportedKinds.includes(capability.kind)) {
      throw new Error("gateway.capability_adapter_kind_unsupported");
    }
    assertBindingOption(adapter, descriptor, normalizedBindingName);
    adapter.assertCapability?.(capability, normalizedBindingName);
    return { adapter, bindingName: normalizedBindingName };
  };

  return {
    sourcePolicyClass(capability: CapabilityDefinition): "external" | "platform_internal" | "synthetic" {
      return adapters.get(splitBinding(capability.adapterBindingId).adapterId)?.module.sourcePolicyClass ?? "external";
    },
    /** Descriptors of the enabled adapters, each marked with its cloud. */
    async listDescriptors(tenantId: string): Promise<AdapterDescriptor[]> {
      return Promise.all([...adapters.values()].map(async ({ module, adapter }) => ({
        ...(await adapter.descriptor(tenantId)),
        cloud: module.cloud,
        enabled: true,
      })));
    },
    /** Every loadable module, enabled or not. */
    listModules(): AdapterModuleState[] {
      const templates = new Map(moduleConnectorTemplates(modules).map((template) => [template.adapterId, template]));
      return modules.map((module) => {
        const template = templates.get(module.id);
        return {
          id: module.id,
          label: module.label,
          cloud: module.cloud,
          supportedKinds: module.supportedKinds,
          enabled: enabledIds.has(module.id),
          enabledByDefault: module.enabledByDefault,
          connectorTemplate: template
            ? { bindingPattern: template.bindingPattern, capabilityIds: template.capabilityIds, configEnv: template.configEnv, description: template.description }
            : null,
        };
      });
    },
    /**
     * Validates a connector registered from a template: the adapter publishes a template that
     * serves the capability, is enabled here, and accepts the binding.
     */
    assertConnectorFromTemplate(adapterId: string, bindingName: string, capabilityId: string): CapabilityAdapterModule {
      const module = modules.find((item) => item.id === adapterId);
      if (!module?.connectorTemplate) throw new Error("gateway.connector_template_unknown");
      if (!module.connectorTemplate.capabilityIds.includes(capabilityId)) throw new Error("gateway.connector_capability_unsupported");
      if (!module.connectorTemplate.bindingPattern.test(bindingName)) throw new Error("gateway.connector_binding_mismatch");
      const entry = adapters.get(adapterId);
      if (!entry) throw new Error("gateway.connector_adapter_disabled");
      if (entry.adapter.acceptsBinding && !entry.adapter.acceptsBinding(bindingName)) throw new Error("gateway.connector_binding_mismatch");
      return module;
    },
    async assertSupported(capability: CapabilityDefinition, tenantId: string): Promise<void> {
      await descriptorFor(capability, tenantId);
    },
    async invoke(
      capability: CapabilityDefinition,
      input: unknown,
      context: AdapterInvocationContext,
    ): Promise<AdapterResult> {
      const { adapter, bindingName } = await descriptorFor(capability, context.tenantId);
      return adapter.invoke(bindingName, capability, input, context);
    },
  };
}

export type AdapterRegistry = ReturnType<typeof createAdapterRegistry>;
