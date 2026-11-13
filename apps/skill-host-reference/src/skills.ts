import type {
  PlatformSkillManifest,
  EffectClass,
  SkillContextSection,
  SkillEffectMode,
  SkillErrorCode,
  SkillExecutionContext,
  SkillProposedRecord,
  SkillRequestedEffect,
  SkillResultStatus,
} from "@ehf/contracts";
import { stableDigest } from "@ehf/contracts";

/**
 * Three trivially synthetic sample skills that mirror the shapes of the contract's first
 * increment (§12): a deterministic calculation over context sections, a provider-backed skill
 * that calls a declared dependency capability through the gateway with the delegated envelope,
 * and a read-only skill that returns NEEDS_EVIDENCE when its required context is missing.
 * They exist to exercise the protocol and the conformance suite; they implement no business
 * logic anyone should rely on.
 */

export type CapabilityCallResult = {
  status: "succeeded" | "failed" | "denied";
  output: unknown;
  errorCode: string | null;
  receiptDigest: string | null;
};

/** The §5 `services` interface as the reference host backs it. */
export type SkillServices = {
  capabilities: {
    invoke(capabilityId: string, input: unknown, options?: { idempotencyKey?: string; effect?: EffectClass }): Promise<CapabilityCallResult>;
  };
  context: {
    section(id: string): SkillContextSection | null;
    readonly sections: readonly SkillContextSection[];
    readonly missing: SkillExecutionContext["missing"];
  };
  records: { propose(record: SkillProposedRecord): void };
  effects: { request(effect: SkillRequestedEffect): void };
  clock: { now(): string };
  ids: { "new": () => string };
  trace: { event(name: string, attributes: Record<string, string | number | boolean>): void };
  /** Aborted on cancel or when `limits.deadline_at` passes. */
  signal: AbortSignal;
};

/** A failure the skill reports as `FAILED_EXECUTION` with a §4.3 code. */
export class SkillFailure extends Error {
  constructor(readonly code: SkillErrorCode, readonly retryable = false) {
    super(code);
  }
}

export type SkillOutcome = {
  business_status: SkillResultStatus;
  payload: unknown;
  unresolved_items?: Array<{ code: string; subject_ref: string; explanation: string }>;
  negative_searches?: Array<{ capability: string; query: unknown; coverage: string; as_of: string; limitations?: string | null }>;
};

export type SampleSkill = {
  manifest: PlatformSkillManifest;
  effects: SkillEffectMode;
  /** Stands in for a real code digest; bump it when the skill's behaviour changes. */
  codeRevision: string;
  instructions: string;
  execute(parameters: Record<string, unknown>, services: SkillServices): Promise<SkillOutcome>;
};

const OWNER = "ehf-platform-reference";

// The samples use the platform-authored manifest form (platformSkillManifestSchema), not the
// library catalog form: the compiler's skill-hosted fixture pins this bundle's digest.

function manifest(input: {
  id: string; description: string; outcome: string; inputSchema: Record<string, unknown>; outputSchema: Record<string, unknown>;
  requiredContext: string[]; mode: PlatformSkillManifest["execution_mode"]; effects: SkillEffectMode; capabilities: string[];
  failureCodes: PlatformSkillManifest["failure_codes"];
  produces?: string[];
}): PlatformSkillManifest {
  return {
    id: input.id,
    semver: "0.1.0",
    description: input.description,
    business_outcome: input.outcome,
    input_schema: input.inputSchema,
    output_schema: input.outputSchema,
    required_context: input.requiredContext,
    composition_type: "atomic",
    execution_mode: input.mode,
    ...(input.capabilities.length ? { permitted_capabilities: input.capabilities } : {}),
    failure_codes: input.failureCodes,
    data_classification: "SYNTHETIC",
    owner: OWNER,
    maturity: "implemented_synthetic",
    source: "apps/skill-host-reference",
    package: {
      implementation: { kind: input.capabilities.length ? "provider" : "code", entrypoint: `skill_host_reference.${input.id}` },
      dependencies: { skills: [], capabilities: input.capabilities, libraries: [] },
      effects: { mode: input.effects },
      authorization: { required_permissions: [] },
      ...(input.produces ? { produces: input.produces } : {}),
    },
  };
}

async function pause(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason ?? new Error("aborted")); }, { once: true });
  });
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Deterministic: each holder's percentage of the total from the `holdings` section. */
const interestCalculate: SampleSkill = {
  manifest: manifest({
    id: "sample.ownership.interest.calculate",
    description: "Synthetic sample: compute each holder's percentage interest from a holdings section.",
    outcome: "Percentage interests per holder, and the holders at or above 25%.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["entity_ref"],
      properties: { entity_ref: { type: "string", minLength: 1 }, delay_ms: { type: "integer", minimum: 0, maximum: 60000 } },
    },
    outputSchema: {
      type: "object", additionalProperties: false, required: ["entity_ref", "total_shares", "interests", "above_threshold"],
      properties: {
        entity_ref: { type: "string" },
        total_shares: { type: ["number", "null"] },
        interests: { type: "array", items: { type: "object", required: ["holder_ref", "shares", "percent"] } },
        above_threshold: { type: "array", items: { type: "string" } },
      },
    },
    requiredContext: ["holdings"],
    mode: "deterministic",
    effects: "read_only",
    capabilities: [],
    failureCodes: ["INPUT_INVALID", "CONTEXT_MISSING", "TIMEOUT"],
  }),
  effects: "read_only",
  codeRevision: "sample.ownership.interest.calculate:1",
  instructions: "Deterministic calculation; no model instructions.",
  async execute(parameters, services) {
    await pause(typeof parameters.delay_ms === "number" ? parameters.delay_ms : 0, services.signal);
    const entityRef = String(parameters.entity_ref);
    const holdings = record(services.context.section("holdings")?.value)?.holdings;
    if (!Array.isArray(holdings)) {
      return {
        business_status: "NEEDS_EVIDENCE",
        payload: { entity_ref: entityRef, total_shares: null, interests: [], above_threshold: [] },
        unresolved_items: [{ code: "CONTEXT_MISSING", subject_ref: entityRef, explanation: "The holdings section is missing or malformed." }],
      };
    }
    const rows = holdings.map(record).filter((row): row is Record<string, unknown> => row !== null)
      .filter((row) => typeof row.holder_ref === "string" && typeof row.shares === "number" && Number.isFinite(row.shares) && row.shares >= 0)
      .map((row) => ({ holder_ref: row.holder_ref as string, shares: row.shares as number }))
      .sort((left, right) => (left.holder_ref < right.holder_ref ? -1 : left.holder_ref > right.holder_ref ? 1 : 0));
    const total = rows.reduce((sum, row) => sum + row.shares, 0);
    if (!rows.length || total <= 0) {
      return {
        business_status: "NEEDS_EVIDENCE",
        payload: { entity_ref: entityRef, total_shares: total, interests: [], above_threshold: [] },
        unresolved_items: [{ code: "EVIDENCE_INSUFFICIENT", subject_ref: entityRef, explanation: "No usable holdings were provided." }],
      };
    }
    const interests = rows.map((row) => ({ ...row, percent: Math.round((row.shares / total) * 1_000_000) / 10_000 }));
    return {
      business_status: "COMPLETED",
      payload: { entity_ref: entityRef, total_shares: total, interests, above_threshold: interests.filter((row) => row.percent >= 25).map((row) => row.holder_ref) },
    };
  },
};

const UNKNOWN_OUTCOMES = new Set(["unknown", "not_checked", "inconclusive", "resubmit"]);

/** Provider-backed: one call to its declared dependency through the gateway. */
const registryVerify: SampleSkill = {
  manifest: manifest({
    id: "sample.registry.verify",
    description: "Synthetic sample: check a company against a registry lookup capability.",
    outcome: "Whether the registry reports the company as registered and active, citing the gateway receipt.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["company_name"],
      properties: { company_name: { type: "string", minLength: 1, maxLength: 200 }, jurisdiction: { type: "string", maxLength: 8 } },
    },
    outputSchema: {
      type: "object", additionalProperties: false, required: ["company_name", "registered", "active"],
      properties: { company_name: { type: "string" }, registered: { type: ["boolean", "null"] }, active: { type: ["boolean", "null"] } },
    },
    requiredContext: [],
    mode: "retrieval",
    effects: "proposal",
    capabilities: ["business.registry.lookup.v1"],
    produces: ["RegistryRecord"],
    failureCodes: ["INPUT_INVALID", "ACCESS_DENIED", "SOURCE_UNAVAILABLE", "EVIDENCE_INSUFFICIENT", "TIMEOUT"],
  }),
  effects: "proposal",
  codeRevision: "sample.registry.verify:3",
  instructions: "Provider-backed lookup; no model instructions.",
  async execute(parameters, services) {
    const name = String(parameters.company_name);
    const query = { name, ...(typeof parameters.jurisdiction === "string" ? { jurisdiction: parameters.jurisdiction } : {}) };
    const unknown = (why: string): SkillOutcome => ({
      business_status: "NEEDS_EVIDENCE",
      payload: { company_name: name, registered: null, active: null },
      unresolved_items: [{ code: "EVIDENCE_INSUFFICIENT", subject_ref: `company:${name}`, explanation: `The registry did not establish a result (${why}).` }],
    });
    const result = await services.capabilities.invoke("business.registry.lookup.v1", query, { idempotencyKey: "registry-lookup" });
    if (result.status === "denied") throw new SkillFailure("ACCESS_DENIED");
    if (result.status === "failed") {
      const code = result.errorCode ?? "";
      if (/timeout/.test(code)) throw new SkillFailure("TIMEOUT", true);
      if (/rate_limit|429/.test(code)) throw new SkillFailure("RATE_LIMITED", true);
      throw new SkillFailure("SOURCE_UNAVAILABLE", true);
    }
    const output = record(result.output);
    const outcome = typeof output?.outcome === "string" ? output.outcome : null;
    if (!output || (outcome && UNKNOWN_OUTCOMES.has(outcome)) || typeof output.found !== "boolean") return unknown(outcome ?? "no usable result");
    const evidence = [{ receipt_digest: result.receiptDigest!, path: "$.output" }];
    if (!output.found) {
      return {
        business_status: "COMPLETED",
        payload: { company_name: name, registered: false, active: null },
        negative_searches: [{ capability: "business.registry.lookup.v1", query, coverage: "sample registry", as_of: services.clock.now(), limitations: "Synthetic sample coverage." }],
      };
    }
    const active = output.active === true;
    services.records.propose({
      record_type: "Finding", local_ref: "f1",
      body: {
        finding_type: active ? "COMPANY_REGISTERED_ACTIVE" : "COMPANY_REGISTERED_INACTIVE",
        subject_ref: `company:${name}`,
        reason: `The registry lookup reports ${name} as registered and ${active ? "active" : "inactive"}.`,
      },
      evidence,
    });
    // The registry entry as an ontology record (contract amendment: `CanonicalRecord`). Synthetic,
    // because this skill is `implemented_synthetic`; ids and version are derived from the input and
    // the receipt, so a replayed execution proposes the same version.
    services.records.propose({
      record_type: "CanonicalRecord", local_ref: "registry-record",
      body: {
        object_type: "RegistryRecord",
        object_id: `registry:sample:${stableDigest(name.toLowerCase()).slice(0, 16)}`,
        version_id: `v-${stableDigest({ name, receipt: result.receiptDigest }).slice(0, 16)}`,
        schema_version: "2.0.0",
        data: {
          registration_id: typeof output.registration_id === "string" ? output.registration_id : name,
          status: active ? "ACTIVE" : "INACTIVE",
          // Library context 2.0.0 `Coverage`: a sample registry never claims complete coverage.
          coverage: { complete: false, jurisdictions: typeof parameters.jurisdiction === "string" ? [parameters.jurisdiction] : [] },
          name,
        },
        observed_at: services.clock.now(),
        source_refs: [],
        classification: "CONFIDENTIAL",
        synthetic: true,
      },
      evidence,
    });
    if (!active) {
      return {
        business_status: "NEEDS_REVIEW",
        payload: { company_name: name, registered: true, active: false },
        unresolved_items: [{ code: "HUMAN_REVIEW_REQUIRED", subject_ref: `company:${name}`, explanation: "The registry reports the company as inactive." }],
      };
    }
    return { business_status: "COMPLETED", payload: { company_name: name, registered: true, active: true } };
  },
};

/** Read-only: needs the `subject` section and says so when it is missing. */
const evidenceCheck: SampleSkill = {
  manifest: manifest({
    id: "sample.evidence.check",
    description: "Synthetic sample: check that the subject section carries a display name.",
    outcome: "Whether the subject has a display name; NEEDS_EVIDENCE without the subject section.",
    inputSchema: {
      type: "object", additionalProperties: false, required: ["subject_ref"],
      properties: { subject_ref: { type: "string", minLength: 1 } },
    },
    outputSchema: {
      type: "object", additionalProperties: false, required: ["subject_ref", "has_display_name"],
      properties: { subject_ref: { type: "string" }, has_display_name: { type: ["boolean", "null"] }, display_name_length: { type: "integer" } },
    },
    requiredContext: ["subject"],
    mode: "deterministic",
    effects: "read_only",
    capabilities: [],
    failureCodes: ["INPUT_INVALID", "CONTEXT_MISSING", "EVIDENCE_INSUFFICIENT"],
  }),
  effects: "read_only",
  codeRevision: "sample.evidence.check:1",
  instructions: "Deterministic check; no model instructions.",
  async execute(parameters, services) {
    const subjectRef = String(parameters.subject_ref);
    const subject = services.context.section("subject");
    const missing = services.context.missing.some((item) => item.selector === "subject");
    if (!subject || missing || subject.quarantined) {
      return {
        business_status: "NEEDS_EVIDENCE",
        payload: { subject_ref: subjectRef, has_display_name: null },
        unresolved_items: [{ code: "CONTEXT_MISSING", subject_ref: subjectRef, explanation: "The required subject section was not provided." }],
      };
    }
    const name = record(subject.value)?.display_name;
    if (typeof name !== "string" || !name.trim()) {
      return {
        business_status: "NEEDS_EVIDENCE",
        payload: { subject_ref: subjectRef, has_display_name: false },
        unresolved_items: [{ code: "EVIDENCE_INSUFFICIENT", subject_ref: subjectRef, explanation: "The subject has no display name." }],
      };
    }
    return { business_status: "COMPLETED", payload: { subject_ref: subjectRef, has_display_name: true, display_name_length: name.trim().length } };
  },
};

export const SAMPLE_SKILLS: readonly SampleSkill[] = [interestCalculate, registryVerify, evidenceCheck];
