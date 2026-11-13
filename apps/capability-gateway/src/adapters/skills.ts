import { Validator } from "@cfworker/json-schema";
import { EnvelopeAuthorityError } from "@ehf/execution-auth";
import {
  fetchSkillBundleLock,
  runSkillExecution,
  type AccessTokenProvider,
  type SkillHostConnection,
} from "@ehf/adapters";
import {
  BUSINESS_SKILL_ID_PATTERN,
  BUSINESS_SKILL_MATURITY_LEVELS,
  SKILL_ADAPTER_PREFIX,
  SKILL_EXECUTION_CONTRACT_VERSION,
  businessSkillDependencies,
  businessSkillManifestDigest,
  platformCapabilityId,
  businessSkillEffects,
  businessSkillPermissions,
  businessSkillProducedObjectTypes,
  isSkillForbiddenCommand,
  skillProposedRecordIssue,
  delegatedSkillAudience,
  skillBindingForNode,
  skillCapabilityInputV1Schema,
  skillCapabilityOutputV1Schema,
  skillExecutionRequestV1Schema,
  skillBundleLockDigest,
  stableDigest,
  type BusinessSkillManifest,
  type CapabilityDefinition,
  type ExecutionEnvelopeClaims,
  type HarnessPlanV2,
  type PlanSkillBinding,
  type SkillBundleLock,
  type SkillComputation,
  type SkillEffectMode,
  type SkillExecutionRequestV1,
  type SkillExecutionResponseV1,
} from "@ehf/contracts";
import { allowsInsecureEndpoints, isProductionProfile, workloadAuth } from "@ehf/identity";
import { delegatedReceiptDigests, getBusinessSkill, requireApprovedSkillBundle, requireSkillQualification } from "@ehf/persistence";
import { validateRecordData } from "@ehf/library-contracts";
import { databricksWorkspaceToken } from "./databricks.js";
import type { AdapterInvocationContext, AdapterModuleDeps, CapabilityAdapterModule, ExecutableAdapter } from "./types.js";

/**
 * `skills:<skill_id>`: a business skill executed by a skill host (skill.execution.v1,
 * docs/implementation/skill-library-integration-contract.md). The gateway is the only platform
 * caller of the host. Per invocation it:
 *
 *  1. resolves the node's pinned skill binding (version, manifest digest, bundle digest) from
 *     the admitted plan and the manifest from the business-skill registry;
 *  2. verifies the host's served bundle lock (cached ≤ 60 s): same `bundle_digest` as the plan,
 *     an approved, unrevoked `skill-bundle` registry entry naming exactly this lock, and the
 *     pinned skill/version/manifest digest in it;
 *  3. issues a delegated envelope in-process (delegation.ts), narrowed to the skill's
 *     declared dependency capabilities;
 *  4. sends SkillExecutionRequest.v1 (`Idempotency-Key` = gateway invocation id), polls a 202,
 *     cancels on deadline or abort, maps §10 errors;
 *  5. validates the response: schema, payload against the manifest's output schema, effect-mode
 *     rules (§6.3) and evidence attribution (section digests of this request, receipt digests of
 *     this execution's delegated gateway calls).
 *
 * Config: SKILL_HOST_URL, SKILL_HOST_AUTH (platform_token | databricks_app; default
 * platform_token: the gateway's own service credential -- GATEWAY_SERVICE_TOKEN locally, its
 * workload-identity token in production), SKILL_HOST_GATEWAY_URL (the gateway URL the host
 * calls back), SKILL_BUNDLE_CACHE_SECONDS (≤ 60). Under ENVELOPE_SIGNER=private_key the gateway
 * signs delegated envelopes with DELEGATED_ENVELOPE_PRIVATE_KEY_FILE / DELEGATED_ENVELOPE_KEY_ID.
 */

export const SKILLS_CONFIG_ENV = [
  "SKILL_HOST_URL", "SKILL_HOST_AUTH", "SKILL_HOST_GATEWAY_URL", "GATEWAY_SERVICE_TOKEN",
];

const SKILL_BINDING = new RegExp(BUSINESS_SKILL_ID_PATTERN.source);
const MAX_BUNDLE_CACHE_MS = 60_000;

type Resolved<T> = { config: T } | { problem: string };

function serviceUrl(value: string | undefined, env: NodeJS.ProcessEnv, problem: string): Resolved<URL> {
  const raw = value?.trim();
  if (!raw) return { problem };
  try {
    const url = new URL(raw);
    if (url.username || url.password || url.search || url.hash) return { problem };
    // Local stacks reach sibling containers over plain HTTP; production never does.
    if (url.protocol === "https:" || (url.protocol === "http:" && allowsInsecureEndpoints(env))) return { config: url };
    return { problem };
  } catch {
    return { problem };
  }
}

function hostToken(deps: AdapterModuleDeps): Resolved<AccessTokenProvider> {
  const { env } = deps;
  // Undeclared, the skill host is reached with the gateway's own service credential: one
  // identity for every service the gateway calls.
  const mode = env.SKILL_HOST_AUTH?.trim() || "platform_token";
  if (mode === "platform_token") {
    if (workloadAuth(env) === "static_token" && !env.GATEWAY_SERVICE_TOKEN?.trim()) return { problem: "gateway.skills_not_configured" };
    return { config: deps.workloadToken };
  }
  if (mode === "databricks_app") {
    const workspace = databricksWorkspaceToken(deps);
    return "problem" in workspace ? { problem: workspace.problem } : { config: workspace.token };
  }
  return { problem: "gateway.skills_auth_invalid" };
}


type SkillsConfig = {
  host: SkillHostConnection;
  hostUrl: URL;
  callbackUrl: URL;
  bundleCacheMs: number;
};

function readConfig(deps: AdapterModuleDeps): Resolved<SkillsConfig> {
  const { env } = deps;
  const host = serviceUrl(env.SKILL_HOST_URL, env, "gateway.skills_host_url_invalid");
  if ("problem" in host) return host;
  const callback = serviceUrl(env.SKILL_HOST_GATEWAY_URL, env, "gateway.skills_callback_url_invalid");
  if ("problem" in callback) return callback;
  const token = hostToken(deps);
  if ("problem" in token) return token;
  const seconds = Number(env.SKILL_BUNDLE_CACHE_SECONDS ?? 60);
  return {
    config: {
      hostUrl: host.config,
      callbackUrl: callback.config,
      bundleCacheMs: Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds * 1000, MAX_BUNDLE_CACHE_MS) : MAX_BUNDLE_CACHE_MS,
      host: {
        baseUrl: host.config, token: token.config, fetch: deps.fetch,
        ...(deps.now ? { now: deps.now } : {}), ...(deps.sleep ? { sleep: deps.sleep } : {}),
      },
    },
  };
}

function fail(code: string): never {
  throw new Error(`adapter.skills_${code}`);
}

const prefixed = (digest: string) => (digest.startsWith("sha256:") ? digest : `sha256:${digest}`);
const bare = (digest: string) => digest.replace(/^sha256:/, "");

function effectMode(manifest: BusinessSkillManifest): SkillEffectMode {
  // The CR-5 mapping the registry seed and bundle locks use; undeclared is read-only.
  return businessSkillEffects(manifest).mode;
}

/** A skill's declared provider capabilities, as platform capability ids (CR-8). */
function declaredCapabilities(manifest: BusinessSkillManifest): string[] {
  return businessSkillDependencies(manifest).capabilities.map(platformCapabilityId);
}

function requiredPermissions(manifest: BusinessSkillManifest): Set<string> {
  return new Set(businessSkillPermissions(manifest));
}

/**
 * The schema a computation's payload must meet. A skill that outputs `proposed_records` has them lifted by the host
 * into `computation.proposed_records` (§6.2), where they are checked as records; the payload no longer carries them.
 */
function payloadSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const properties = schema.properties as Record<string, unknown> | undefined;
  if (!properties || !Object.hasOwn(properties, "proposed_records")) return schema;
  const { proposed_records: _lifted, ...rest } = properties;
  return { ...schema, properties: rest, ...(Array.isArray(schema.required) ? { required: schema.required.filter(name => name !== "proposed_records") } : {}) };
}

function schemaErrors(schema: Record<string, unknown>, value: unknown): boolean {
  return !new Validator(schema as never, "2020-12", false).validate(value).valid;
}

/**
 * §6.3 effect modes, §6.2 record shapes and §4.2 evidence rules over a completed computation.
 *
 * Records: each `local_ref` once; every body is its record type's shape
 * (`skillProposedRecordIssue`); a `CanonicalRecord` needs mode `proposal` or higher (read-only
 * already refuses any record), an object type the manifest says it produces when it says, and
 * `synthetic: true` while the registry has the skill at `implemented_synthetic`, and `data` valid
 * under the closed record contract (`validateRecordData`, @ehf/library-contracts). Effects: each
 * `idempotency_key` once; never a decision, disposition, review or approval command; a
 * `case_command` must be declared by the manifest and granted to the node, directly
 * (`case_writes`) or to be held for approval (`case_writes_held`).
 */
export function checkComputation(input: {
  computation: SkillComputation;
  mode: SkillEffectMode;
  manifest: BusinessSkillManifest;
  request: SkillExecutionRequestV1;
  caseWrites: readonly string[];
  heldCaseWrites?: readonly string[];
  receiptDigests: ReadonlySet<string>;
  /** Registry maturity of the skill version; `implemented_synthetic` requires synthetic records. */
  maturity?: string;
}): void {
  const { computation, mode, manifest, request } = input;
  // A business gap (NEEDS_EVIDENCE, NEEDS_REVIEW, BLOCKED, FAILED) may come back without a payload:
  // the skill stopped before it could compute one. It must then say why, so a gap is never silent
  // and never mistaken for an integrity failure. Any payload that is present meets the schema.
  const gap = computation.business_status !== "COMPLETED" && computation.business_status !== "PARTIAL";
  const payload = computation.payload;
  const emptyPayload = payload === null || payload === undefined
    || (typeof payload === "object" && !Array.isArray(payload) && Object.keys(payload).length === 0);
  if (gap && emptyPayload) {
    if (!computation.unresolved_items.length) fail("integrity_gap_unexplained");
  } else if (schemaErrors(payloadSchema(manifest.output_schema), computation.payload)) {
    fail("integrity_payload_schema_invalid");
  }
  if (mode === "read_only" && (computation.proposed_records.length || computation.requested_effects.length)) fail("integrity_read_only_violated");
  if (mode === "proposal" && computation.requested_effects.length) fail("integrity_effects_not_permitted");
  const refs = computation.proposed_records.map((record) => record.local_ref);
  if (new Set(refs).size !== refs.length) fail("integrity_local_ref_duplicate");
  const keys = computation.requested_effects.map((effect) => effect.idempotency_key);
  if (new Set(keys).size !== keys.length) fail("integrity_effect_key_duplicate");
  const produces = businessSkillProducedObjectTypes(manifest);
  const requireSynthetic = (input.maturity ?? "implemented_synthetic") === "implemented_synthetic";
  for (const record of computation.proposed_records) {
    const issue = skillProposedRecordIssue(record, { produces, requireSynthetic });
    if (issue) fail(`integrity_${issue}`);
    // A proposed canonical record meets the same closed contract as a connector's records
    // (library context 2.0.0, or a platform-only record type): the store never holds data a
    // library skill cannot ingest, whoever produced it.
    if (record.record_type === "CanonicalRecord") {
      const body = record.body as { object_type: string; data: unknown };
      if (!validateRecordData(body.object_type, body.data).valid) fail("integrity_record_data_invalid");
    }
  }
  const permissions = requiredPermissions(manifest);
  for (const effect of computation.requested_effects) {
    if (effect.type === "external_action" && mode !== "external_write") fail("integrity_external_action_not_permitted");
    if (effect.type === "case_command") {
      const command = effect.command_type!;
      // A skill never creates a decision, disposition, review or approval record (§6.2).
      if (isSkillForbiddenCommand(command)) fail("integrity_case_command_forbidden");
      // Declared by the skill and granted to the node by the compiled plan (the envelope's case_writes,
      // or case_writes_held for an approval-required skill whose effects wait for the approval).
      if (!permissions.has(command) && !permissions.has(`case_command:${command}`)) fail("integrity_case_command_undeclared");
      if (!input.caseWrites.includes(command) && !(input.heldCaseWrites ?? []).includes(command)) fail("integrity_case_command_not_granted");
    }
  }
  const sections = new Map(request.context.sections.map((section) => [section.id, section.content_digest]));
  for (const record of computation.proposed_records) {
    for (const evidence of record.evidence) {
      if ("section_id" in evidence) {
        if (sections.get(evidence.section_id) !== evidence.content_digest) fail("integrity_evidence_untraceable");
      } else if (!input.receiptDigests.has(bare(evidence.receipt_digest))) {
        fail("integrity_evidence_untraceable");
      }
    }
  }
  // Missing mandatory evidence never reads as a pass.
  if (computation.business_status === "COMPLETED" && request.context.missing.some((item) => item.required)) {
    fail("integrity_completed_without_required_context");
  }
}

type DelegatedEnvelope = { envelope: string; expiresAt: string; capabilities: string[] };

async function delegate(deps: AdapterModuleDeps, tenantId: string, execution: NonNullable<AdapterInvocationContext["execution"]>, body: {
  skillId: string; skillVersion: string; capabilities: string[]; deadlineAt: string;
}): Promise<DelegatedEnvelope> {
  try {
    return await deps.delegate(tenantId, execution.envelope, body);
  } catch (error) {
    // Authority denials (stale fence, lease lost, revoked release) are authorization failures.
    const code = error instanceof EnvelopeAuthorityError && /^broker\.[a-z0-9_.]+$/.test(error.code) ? error.code.slice(7) : null;
    if (code) fail(`delegation_denied_${code}`);
    fail("delegation_unavailable");
  }
}

function maturityRank(level: string): number {
  return (BUSINESS_SKILL_MATURITY_LEVELS as readonly string[]).indexOf(level);
}

function sectionCase(provenanceRef: string): string | null {
  const match = /^case:([^@/]+)/.exec(provenanceRef);
  return match ? match[1]! : null;
}

export function createSkillsAdapter(deps: AdapterModuleDeps): ExecutableAdapter {
  let configState: Resolved<SkillsConfig> | undefined;
  const config = () => (configState ??= readConfig(deps));
  const now = deps.now ?? Date.now;
  const lockCache = new Map<string, { lock: SkillBundleLock; fetchedAt: number }>();

  async function servedLock(settings: SkillsConfig): Promise<SkillBundleLock> {
    const key = settings.hostUrl.toString();
    const cached = lockCache.get(key);
    if (cached && now() - cached.fetchedAt < settings.bundleCacheMs) return cached.lock;
    const lock = await fetchSkillBundleLock(settings.host);
    lockCache.set(key, { lock, fetchedAt: now() });
    return lock;
  }

  return {
    descriptor: async () => ({
      id: "skills",
      label: "Skill host",
      supportedKinds: ["tool", "deterministic", "model"],
      credentialState: "config" in config() ? "Configured" : "Missing",
      bindingOptions: [],
    }),
    acceptsBinding: (bindingName) => SKILL_BINDING.test(bindingName) && bindingName.length <= 128,
    assertCapability: (capability: CapabilityDefinition) => {
      // A skill's own dependency calls carry their effects; the skill call itself never writes.
      if (capability.effect === "external" || capability.effect === "destructive") throw new Error("gateway.skills_capability_effect_invalid");
    },
    async invoke(bindingName, capability, input, context) {
      const state = config();
      if ("problem" in state) throw new Error(state.problem);
      const settings = state.config;
      const execution = context.execution;
      if (!execution || !context.invocationId) fail("execution_context_missing");
      const claims: ExecutionEnvelopeClaims = execution.claims;
      if (claims.delegated_to) fail("delegated_envelope_denied");
      if (execution.plan.apiVersion !== "harness.factory/plan-v2") fail("plan_v2_required_denied");
      const plan = execution.plan as HarnessPlanV2;

      // 1. The pinned binding and the registry manifest it names.
      let binding: PlanSkillBinding | null;
      try {
        // The node's binding for this skill: its own skill, or one of its agent loop's skills.
        binding = skillBindingForNode(plan, claims.node_id, bindingName);
      } catch {
        binding = null;
      }
      if (!binding || binding.skillId !== bindingName) fail("binding_mismatch");
      if (!binding.candidates.some((candidate) => candidate.capabilityId === capability.id && candidate.connectorId === `${SKILL_ADAPTER_PREFIX}${bindingName}`)) {
        fail("binding_mismatch");
      }
      if (!binding.bundleDigest) fail("integrity_bundle_unpinned");
      const skill = await getBusinessSkill(deps.db, binding.skillId, binding.semver);
      if (!skill) fail("integrity_skill_unregistered");
      if (skill.manifestDigest !== binding.manifestDigest) fail("integrity_manifest_digest_mismatch");
      // The stored manifest is the one its digest names: a row edited in place never runs.
      if (businessSkillManifestDigest(skill.manifest) !== skill.manifestDigest) fail("integrity_manifest_tampered");
      const production = isProductionProfile(deps.env) || deps.env.RELEASE_ENVIRONMENT === "production";
      if (production && maturityRank(skill.maturity) < maturityRank("integration_verified")) {
        fail("maturity_insufficient_denied");
      }
      if (production && skill.status !== "active") fail("lifecycle_inactive_denied");
      const manifest = skill.manifest;
      const mode = effectMode(manifest);

      // The runtime's input: SkillInput.v1 + assembled context, for this tenant and case only.
      const parsed = skillCapabilityInputV1Schema.safeParse(input);
      if (!parsed.success) fail("input_invalid");
      const skillInput = parsed.data;
      if (skillInput.input.tenant_id !== claims.tenant_id || skillInput.context.envelope.tenant_id !== claims.tenant_id
        || skillInput.input.case_id !== claims.case_id || skillInput.context.envelope.case_id !== claims.case_id
        || skillInput.context.sections.some((section) => {
          const caseId = sectionCase(section.provenance_ref);
          return caseId !== null && caseId !== claims.case_id;
        })) {
        fail("tenant_scope_denied");
      }
      if (skillInput.context.missing.some((item) => item.required)) fail("context_missing");
      if (schemaErrors(manifest.input_schema, skillInput.input.parameters)) fail("parameters_invalid");

      // 2. The served bundle is the pinned, approved one and serves exactly this skill version.
      const lock = await servedLock(settings);
      if (lock.bundle_digest !== binding.bundleDigest) {
        lockCache.delete(settings.hostUrl.toString());
        fail("integrity_bundle_digest_mismatch");
      }
      try {
        await requireApprovedSkillBundle(deps.db, context.tenantId, lock);
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        fail(message.includes("revoked") ? "bundle_revoked_denied" : message.includes("lock_mismatch") ? "integrity_bundle_lock_mismatch" : "bundle_not_approved_denied");
      }
      const entry = lock.skills.find((item) => item.id === binding.skillId && item.version === binding.semver);
      if (!entry || entry.manifest_digest !== prefixed(binding.manifestDigest)) fail("integrity_skill_not_in_bundle");
      if (entry.effects !== mode) fail("integrity_effect_mode_mismatch");

      let qualificationDigest: string | undefined;
      if (production) {
        const policySections = skillInput.context.sections.filter((section) => section.kind === "policy")
          .map((section) => ({ id: section.id, provenance_ref: section.provenance_ref, value: section.value }))
          .sort((a, b) => a.id.localeCompare(b.id));
        if (!policySections.length || skillInput.input.policy_snapshot_ref !== skillInput.context.envelope.policy_snapshot_ref) {
          fail("qualification_policy_context_denied");
        }
        try {
          qualificationDigest = await requireSkillQualification(deps.db, context.tenantId, {
            skillId: binding.skillId, skillVersion: binding.semver, manifestDigest: binding.manifestDigest,
            bundleDigest: lock.bundle_digest, bundleLockDigest: skillBundleLockDigest(lock), planDigest: plan.planDigest,
            policySnapshotRef: skillInput.input.policy_snapshot_ref, purpose: skillInput.input.purpose,
            policyContextDigest: stableDigest(policySections),
            jurisdiction: skillInput.context.envelope.jurisdiction,
          }, now());
        } catch { fail("qualification_required_denied"); }
      }

      // 3. Delegated authority, narrowed to declared dependencies the node may call.
      const startedAt = now();
      const deadlineMs = startedAt + capability.timeoutMs;
      const skillCapabilities = new Set(plan.capabilities.filter((item) => item.adapterBindingId.startsWith(SKILL_ADAPTER_PREFIX)).map((item) => item.id));
      const permitted = declaredCapabilities(manifest)
        .filter((id) => entry.dependencies.capabilities.map(platformCapabilityId).includes(id) && claims.capabilities.includes(id) && !skillCapabilities.has(id));
      const delegated = await delegate(deps, context.tenantId, execution, {
        skillId: binding.skillId, skillVersion: binding.semver, capabilities: permitted, deadlineAt: new Date(deadlineMs).toISOString(),
      });

      // 4. Execute.
      const request = skillExecutionRequestV1Schema.parse({
        contract_version: SKILL_EXECUTION_CONTRACT_VERSION,
        execution_id: context.invocationId,
        skill_id: binding.skillId,
        skill_version: binding.semver,
        bundle_digest: binding.bundleDigest,
        input: skillInput.input,
        context: skillInput.context,
        callback: {
          gateway_url: settings.callbackUrl.toString().replace(/\/+$/, ""),
          delegated_envelope: delegated.envelope,
          expires_at: delegated.expiresAt,
          permitted_capabilities: delegated.capabilities,
          permitted_skills: entry.dependencies.skills,
        },
        limits: {
          deadline_at: new Date(deadlineMs).toISOString(),
          max_capability_calls: plan.budgets.maxCapabilityCalls,
          max_model_calls: plan.budgets.maxModelCalls,
          cost_ceiling_usd: plan.budgets.maxCostUsd,
        },
        extensions: { delegated_to: delegatedSkillAudience(binding.skillId, binding.semver) },
      });
      context.recordAttributes?.({
        "harness.skill.id": binding.skillId,
        "harness.skill.version": binding.semver,
        "harness.skill.bundle_digest_prefix": bare(lock.bundle_digest).slice(0, 12),
      });
      const response: SkillExecutionResponseV1 = await runSkillExecution(settings.host, {
        request, deadlineMs,
        ...(execution.traceparent ? { traceparent: execution.traceparent } : {}),
        ...(execution.signal ? { signal: execution.signal } : {}),
      });

      // 5. Validate what came back before anyone relies on it.
      const receipts = await delegatedReceiptDigests(deps.db, claims.run_id, context.invocationId);
      if (response.computation) {
        checkComputation({
          computation: response.computation, mode, manifest, request, caseWrites: claims.case_writes,
          heldCaseWrites: claims.case_writes_held ?? [], receiptDigests: new Set(receipts), maturity: skill.maturity,
        });
      }
      const output = skillCapabilityOutputV1Schema.parse({
        contract_version: SKILL_EXECUTION_CONTRACT_VERSION,
        execution_id: response.execution_id,
        skill_id: binding.skillId,
        skill_version: binding.semver,
        bundle_digest: lock.bundle_digest,
        manifest_digest: binding.manifestDigest,
        effect_mode: mode,
        lifecycle: response.lifecycle,
        computation: response.computation,
        error: response.error,
        trace: response.trace,
        dependency_receipts: receipts,
        ...(qualificationDigest ? { qualification_digest: qualificationDigest } : {}),
      });
      return {
        output,
        provider: `skill-host:${lock.bundle_id}`,
        model: `${binding.skillId}@${binding.semver}`,
        providerRequestId: response.execution_id,
        inputTokens: null,
        outputTokens: null,
        costUsd: null,
      };
    },
  };
}

export const skillsModule: CapabilityAdapterModule = {
  id: "skills",
  sourcePolicyClass: "platform_internal",
  cloud: "any",
  label: "Skill host (skill.execution.v1)",
  supportedKinds: ["tool", "deterministic", "model"],
  // Needs a skill host, a callback URL and broker credentials: enable with GATEWAY_ADAPTERS=default,skills.
  enabledByDefault: false,
  connectorTemplate: {
    bindingPattern: SKILL_BINDING,
    capabilityIds: ["skill.business.execute.v1"],
    configEnv: SKILLS_CONFIG_ENV,
    description: "A business skill served by an approved skill-host bundle, named by its catalog skill ID (skills:<skill_id>); the plan pins version, manifest and bundle digests.",
  },
  create: (deps) => createSkillsAdapter(deps),
};
