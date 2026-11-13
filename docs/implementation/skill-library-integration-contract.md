# Skill library ↔ platform integration contract

**Contract version:** `skill.execution.v1` (draft for implementation) · **Date:** 2026-11-07
**Parties:** the *skill library* (the financial-crime canonical skills: 222 skills, Python
reference implementation) and the *platform* (`ehfconcept`: durable orchestrator,
runtimes, capability gateway, context plane, case/evidence store, policy, human work).
**Normative sources:** [canonical skills spec v1](#references) §3–§4 for `SkillInput.v1`,
`SkillResult.v1`, `ContextEnvelope`, error codes and epistemic types; this document for
everything about how a skill runs on the platform.

The key words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119.

---

## 1. Division of responsibility

| Concern | Skill library | Platform |
| --- | --- | --- |
| Business contract per skill (`skill.yaml`, schemas, `context.yaml`, `SKILL.md`) | **owns** | ingests into the skill registry; never edits |
| Skill logic: deterministic code, model instructions, composite steps | **owns** | — |
| Fixtures, evaluation reports, maturity claims | **owns** | records and gates releases on them |
| A skill host process that executes skills from an approved bundle | **owns** (image) | hosts it, calls it, authenticates it |
| Workflow order, branches, joins, retries, durability, human suspension | — | **owns** (Postgres orchestrator) |
| Version pinning / execution lock | declares versions and digests | **owns**: compiled plan + artifact registry |
| Authorization (effective grant, per-call envelopes, fencing) | declares requirements | **owns** |
| Provider and model access, credentials, budgets, receipts | declares capability dependencies | **owns** (capability gateway) |
| Context compilation, redaction, trust labelling, manifests | declares needs (`context.yaml`) | **owns** (context plane) |
| Authoritative state: case, evidence, ledger, approvals, outbox | proposes records and effects | **owns** and commits |

The skill library MUST NOT ship its own production executor, admission controller, runtime
adapters, provider adapters, stores or context compiler. It SHOULD keep in-memory test
doubles of the `services` interface (§5) so every skill is unit-testable without the
platform; those doubles are test code, not a second platform.

## 2. Vocabulary

| Term | Meaning here |
| --- | --- |
| **Skill** | A catalog business skill (`entity.resolve`, `screening.sanctions.execute`, …). The only thing called "skill". |
| **Agent profile** | Role instructions, allowed skills, model and planning limits (library §6). The platform's former agent-instruction "skills" become profile instructions; the platform renames them. |
| **Capability** | A canonical, provider-neutral operation the gateway executes, e.g. `screening.sanctions.v1`, `business.registry.lookup.v1`, `model.general.inference.v1` ([naming](capability-naming.md)). |
| **Connector** | A concrete provider binding for a capability, e.g. `wiring:companies-house:business.registry.lookup`. Skills MUST NOT name connectors or providers. |
| **Skill bundle** | One skill-host image plus its bundle lock (§8). |
| **Execution** | One invocation of one skill version for one workflow node attempt. |

## 3. How a skill runs

```
 orchestrator ── node (config.skillId = registry.company.verify) ──► runtime (local / hosted / Databricks)
                                                                         │
                     context plane: ContextEnvelope + sections ◄─────────┤
                                                                         │ POST /v1/invoke  capability "skills:registry.company.verify"
                                                                         ▼
                                                               capability gateway ── budget, receipt, envelope check
                                                                         │ POST /v1/skills/{skill_id}/executions   (skill.execution.v1)
                                                                         ▼
                                                                    skill host ── execute(parameters, context, services)
                                                                         │ services.capabilities.invoke(...) with the delegated envelope
                                                                         ▼
                                                               capability gateway ── connectors / models
```

1. The compiler resolves the node's skill to its pinned implementation (pin at compile,
   select at run) and adds the skill's declared dependency capabilities (§6) to the
   node's permission envelope.
2. The runtime assembles context through the context plane from the skill's
   `context.yaml` (§7). If required context is missing, the platform returns
   `CONTEXT_MISSING` without calling the skill.
3. The runtime calls the gateway capability `skills:<skill_id>`. The gateway's `skills`
   adapter calls the skill host with a `SkillExecutionRequest.v1` (§4.1), including a
   **delegated envelope** for the skill's own dependency calls.
4. The skill host runs `execute(parameters, context, services)` and returns a
   `SkillComputation` (§4.2).
5. The platform validates the payload against the skill's output schema, commits
   permitted proposed records through case-store commands, routes requested effects
   (§6), and only then builds the `SkillResult.v1` with real references.

## 4. Wire protocol (platform → skill host)

Transport: HTTPS + JSON. All bodies are UTF-8 JSON; unknown top-level fields MUST be
rejected (`INPUT_INVALID`); unknown fields inside `extensions` objects MUST be ignored.

### 4.1 Start an execution

`POST /v1/skills/{skill_id}/executions`

Headers:
- `Authorization: Bearer <platform workload token>` (§9).
- `Idempotency-Key: <execution_id>`. A repeated request with the same key and the same
  body digest MUST return the original response. The same key with a different body MUST
  return `409` with `INPUT_INVALID`.
- `traceparent`: W3C trace context; the host MUST propagate it to its gateway calls.

```jsonc
// SkillExecutionRequest.v1
{
  "contract_version": "skill.execution.v1",
  "execution_id": "inv_…",                 // = gateway invocation id; stable across retries
  "skill_id": "registry.company.verify",
  "skill_version": "0.3.0",                // exact version pinned in the plan
  "bundle_digest": "sha256:…",             // the bundle the plan was compiled against
  "input": { /* SkillInput.v1 exactly as spec §4.1; parameters validated against input.schema.json */ },
  "context": {
    "envelope": { /* ContextEnvelope.v1, spec §3.3 */ },
    "context_hash": "sha256:…",            // = context manifest digest; replay key
    "sections": [
      {
        "id": "subject",                   // selector id from context.yaml
        "kind": "case|evidence|policy|upstream|observation",
        "trust": "TRUSTED_DATA|UNTRUSTED_DATA|UNTRUSTED_EXTERNAL",
        "classification": "PII|CONFIDENTIAL|…",
        "purpose": "KYC_SCREENING",
        "provenance_ref": "case:CASE-1@42/case:subjects.0",
        "content_digest": "sha256:…",
        "quarantined": false,
        "value": { }                        // structured data; never instructions
      }
    ],
    "missing": [ { "selector": "registrations", "code": "CONTEXT_MISSING", "required": false } ]
  },
  "callback": {
    "gateway_url": "https://gateway.internal",
    "delegated_envelope": "<jwt>",         // §6.1
    "expires_at": "2026-11-07T12:05:00Z",
    "permitted_capabilities": ["business.registry.lookup.v1", "reference.identifier.lookup.v1"],
    "permitted_skills": ["entity.identifiers.validate@0.2.0"]
  },
  "limits": {
    "deadline_at": "2026-11-07T12:04:30Z",
    "max_capability_calls": 6,
    "max_model_calls": 2,
    "cost_ceiling_usd": 0.20
  },
  "extensions": {}
}
```

The skill host MUST:
- refuse with `409 INTEGRITY_FAILURE` if it does not serve exactly `skill_id@skill_version`
  from `bundle_digest`. It MUST NOT substitute a nearby version.
- validate `input.parameters` against the skill's input schema before running any logic.
- treat every `sections[].value` as data. Content from `UNTRUSTED_*` sections MUST NOT
  become instructions, tool choices or capability grants (spec §11 security tests).
- stop and return `TIMEOUT` once `limits.deadline_at` passes.

### 4.2 Responses

`200 OK` if the execution finished within the request. `202 Accepted` with
`{"execution_id", "status": "RUNNING"}` if it continues. A host MAY always answer 202.

```jsonc
// SkillExecutionResponse.v1
{
  "contract_version": "skill.execution.v1",
  "execution_id": "inv_…",
  "lifecycle": "COMPLETED_EXECUTION|FAILED_EXECUTION|RUNNING|CANCELLED",
  "computation": {                          // present when lifecycle = COMPLETED_EXECUTION
    "business_status": "COMPLETED|PARTIAL|NEEDS_EVIDENCE|NEEDS_REVIEW|BLOCKED|FAILED",
    "payload": { },                         // validated by the platform against output.schema.json
    "proposed_records": [                   // §6.2; never applied by the host
      { "record_type": "Assertion|Finding|Hypothesis|RiskIndicator|Conflict|UnresolvedQuestion|Fact|CanonicalRecord",
        "local_ref": "f1", "body": { }, "evidence": [ { "section_id": "subject", "content_digest": "sha256:…", "span": null },
                                                     { "receipt_digest": "…", "path": "$.result.registrations[0]" } ] }
    ],
    "unresolved_items": [ { "code": "EVIDENCE_INSUFFICIENT", "subject_ref": "entity:…", "explanation": "…" } ],
    "negative_searches": [ { "capability": "business.registry.lookup.v1", "query": { }, "coverage": "GB companies register",
                             "as_of": "2026-11-07T12:00:00Z", "limitations": "…" } ],
    "requested_effects": [ ],               // §6.3
    "metrics": { "duration_ms": 812, "capability_calls": 2, "model_calls": 0 }
  },
  "error": null,                            // { "code": <spec §4.3 code>, "retryable": bool, "detail_ref": null } when FAILED_EXECUTION
  "trace": { "instructions_digest": "sha256:…", "code_digest": "sha256:…", "subskill_executions": [ ] }
}
```

Rules:
- `lifecycle` (did the execution run?) and `business_status` (what did the skill find?)
  are independent, as library plan §6 requires. `COMPLETED` is never approval.
- Missing mandatory evidence MUST yield `NEEDS_EVIDENCE` or `BLOCKED`, never `COMPLETED`
  with a passing payload. A capability outcome of `unknown`, `not_checked` or
  `inconclusive` MUST NOT be treated as a pass.
- Every `proposed_records[].evidence` entry MUST point at a context section digest or a
  gateway `receipt_digest` from this execution. The platform rejects records whose
  evidence it cannot trace (`INTEGRITY_FAILURE`).
- The host MUST NOT return provider payloads verbatim as canonical results. It maps them
  to the skill's output schema and cites the receipt.

### 4.3 Status, cancel, health

- `GET /v1/skills/executions/{execution_id}` returns the latest `SkillExecutionResponse.v1`.
  If the host does not know the execution (for example after a restart without its
  store), it MUST return `404`. It MUST NOT return a guessed terminal state. The platform
  treats 404 as "unknown" and does not blindly re-run executions with external effects.
- `POST /v1/skills/executions/{execution_id}/cancel` (body `{"reason"}`) is best effort.
  The final state is reported through status.
- `GET /healthz` and `GET /v1/bundle` return the bundle lock (§8) so the platform can
  verify the serving digest before routing traffic.

## 5. The `services` interface (inside the skill host)

Signature, as in library plan §5:
`async execute(parameters, context, services) -> SkillComputation`.
On the platform, `services` is backed as follows. The library's test doubles MUST
implement the same interface.

| Member | Behaviour on the platform |
| --- | --- |
| `services.capabilities.invoke(capability_id, input, *, idempotency_key=None)` | `POST {callback.gateway_url}/v1/invoke` with `x-execution-envelope: <delegated_envelope>` and the host's workload token. Returns the gateway `CapabilityResult` (`status`, `output`, `errorCode`, `usage`, `receiptDigest`). Calls outside `permitted_capabilities` fail locally with `ACCESS_DENIED`, and the gateway denies them anyway. |
| `services.models.complete(task_capability_id, prompt, *, schema)` | Sugar over `capabilities.invoke` for `kind: model` capabilities. There are **no model SDK keys in the host**: models are reached only through the gateway. Structured output is validated against `schema` with one repair attempt, then `LOW_CONFIDENCE`. |
| `services.skills.invoke(skill_id, parameters)` | A composite calls a dependency **in-process** when the dependency is in the same bundle and listed in `permitted_skills`. Version pins come from the bundle lock, and each sub-execution is recorded in `trace.subskill_executions`. Anything else is `ACCESS_DENIED`. |
| `services.context` | A read-only view of `context.sections` keyed by selector id, plus `missing`. There is no method that fetches more context. Additional context is a declared dependency on `case.context.hydrate`, resolved by the platform. |
| `services.records.propose(record)` / `services.effects.request(effect)` | Append to the `SkillComputation`. Nothing is persisted or executed by the host. |
| `services.clock.now()`, `services.ids.new()` | Deterministic in replay: the platform supplies `as_of_time` and a seed. Skills MUST NOT read the wall clock or OS randomness directly. |
| `services.trace.event(name, attributes)` | Bounded, non-content attributes only (ids, digests, counts). |

## 6. Authority: dependencies, records and effects

### 6.1 Declared dependencies → delegated envelope

- `skill.yaml.dependencies.capabilities` MUST list every capability the skill may call,
  by canonical capability ID. `dependencies.skills` lists sub-skills with version ranges.
- At compile time the platform resolves the closure and adds those capabilities to the
  node's permission envelope. An undeclared dependency cannot be called.
- At run time the platform mints a **delegated envelope**: the node's execution envelope
  narrowed to `permitted_capabilities`, bound to the same run, node, attempt, fencing
  epoch and plan digest, with claim `delegated_to: skills:<skill_id>@<version>` and a TTL no
  longer than `limits.deadline_at`. The gateway verifies it like any envelope. A stale
  fence or a revoked release invalidates it immediately.
- Budgets (`limits`) are enforced by the gateway reservation, not by trust in the host.

### 6.2 Proposed records

The platform maps record types to case-store `BusinessCommand`s and commits them with an
`AGENT` actor attributed to the skill execution:

| Record type | Command | Lands as |
| --- | --- | --- |
| Assertion | `ProposeClaim` | claim, `PENDING_REVIEW` |
| Finding / RiskIndicator | `RecordScreeningFinding` | finding with classification and evidence refs |
| Conflict | `RaiseContradiction` | open contradiction |
| UnresolvedQuestion | `ProposeWorkItem` | work item for an analyst |
| Fact | `ProposeClaim` + verification criteria | becomes a fact only through `AcceptClaimAsFact` by a permitted actor or deterministic rule |
| CanonicalRecord | `RecordCanonicalRecords` | an ontology record version (amendment, below) |

`Hypothesis` is not committed. Record bodies (amendment, 2026-11-08; `packages/contracts`
"Skill output commit path"):

| Record type | `body` |
| --- | --- |
| Assertion | `{ subject_ref?, predicate, value, confidence? (0–1) }` |
| Fact | Assertion's fields + `verification_criteria` (1–32 strings) |
| Finding / RiskIndicator | `{ finding_type (UPPER_SNAKE), subject_ref?, reason, confidence?, uncertainty?, policy_relevance? }` |
| Conflict | `{ object_refs (≥ 2), description, materiality: LOW\|MEDIUM\|HIGH\|MATERIAL, detection_method? }` |
| UnresolvedQuestion | `{ question, work_type? (UPPER_SNAKE), priority?: LOW\|NORMAL\|HIGH\|URGENT, due_at?, required_capability? }` |
| CanonicalRecord | a canonical record ([canonical records](canonical-records.md)) without the fields the platform sets: `{ object_type, object_id, version_id, schema_version?, data, subject_ids?, valid_from?, valid_to?, observed_at, source_refs, classification, purposes?, synthetic, supersedes? }` |

A `CanonicalRecord` needs effect mode `proposal` or higher; its `object_type` must be one the
manifest says the skill produces, when the manifest says (`package.produces` on a platform
manifest; library catalog entries have no such field yet, so any valid ontology type); and
`synthetic` must be `true` while the skill's registry maturity is `implemented_synthetic`. The
platform commits it with provenance naming the skill execution (skill id@version, execution id,
gateway receipt digest, manifest digest) and cites the validated computation as evidence (whose
section digests and receipt digests the gateway has verified). `local_ref` is unique within a
computation and, with the execution id, the record's idempotency key.

The skill never receives write credentials. A skill cannot create a decision, a
disposition or an approval record: `FinalizeDisposition`, `RecordReview`, `RecordQAResult`,
`RecordGateResult`, `RecordPolicyEvaluation` and `AcceptClaimAsFact` are refused as grants,
as effects and on the commit endpoints.

### 6.3 Effect modes (`skill.yaml.effects.mode`)

| Mode | Allowed output | Platform action |
| --- | --- | --- |
| `read_only` | payload, unresolved items, negative searches | `proposed_records` and `requested_effects` MUST be empty, otherwise `INTEGRITY_FAILURE` |
| `proposal` | plus `proposed_records` | committed as proposals (§6.2) |
| `internal_write` | plus `requested_effects` of type `case_command` | each command type MUST appear in `authorization.required_permissions` and in the node's compiled `caseWrites`; executed by the platform with optimistic concurrency |
| `external_write` | plus `requested_effects` of type `external_action` | written to the platform outbox with `idempotency_key`, then routed to human approval when policy requires. Ambiguous acknowledgements go to reconciliation. The host never performs external writes itself |

```jsonc
// requested_effects[] item
{ "type": "case_command|external_action",
  "command_type": "RequestHumanReview",          // case_command: a BusinessCommand type
  "action": "regulatory.filing.submit",          // external_action: canonical action id
  "idempotency_key": "…", "payload": { }, "justification_refs": ["f1"] }
```

Approvals follow library plan §6: an approval binds action, subject, input/context/policy
hashes, approving actor, authority, expiry and case revision. The platform revalidates
the approval when the effect executes.

On the platform (see [canonical records](canonical-records.md#skill-originated-records)): the
records and effects of one node attempt are committed atomically and idempotently per execution
(`skill:<execution_id>:<local_ref|idempotency_key>`). A `case_command` of a skill whose registry
entry has `approval: none` commits with the records, at the case sequence the skill computed
against (`payload.expected_case_sequence`, else the node snapshot's); a moved case refuses the
commit and fails the node, re-run on fresh context. A `case_command` of an `approval: required`
skill, and every `external_action`, is held, bound to the run, node, execution and binding
hashes, the case sequence at the hold and an expiry (`payload.expires_at`, default seven days).
The node after the following durable approval releases them: on an approval by named humans
other than the case's requester, if the case is unchanged since the hold and the expiry has not
passed, it commits the case commands and writes each external action whose id the plan
publishes (`external_action.<id>`) to the case outbox with its idempotency key; an action
without an outbound route stays a pending intent (`NO_ROUTE`). A rejection discards them. Every
outcome, including a refused release, has an audit event.

## 7. Context (`context.yaml`)

```yaml
selectors:
  - id: subject
    source: case                 # case | evidence | policy
    path: subjects.0             # canonical case path
    purpose: KYC_ONBOARDING      # one purpose per node (platform rule)
    classification: PII
    required: true
    freshness: { max_age: P30D } # stale → CONTEXT_STALE before execution
    on_missing: block            # block | needs_evidence | proceed
  - id: registrations
    source: evidence
    path: registrations
    purpose: KYC_ONBOARDING
    classification: CONFIDENTIAL
    required: false
budget: { max_chars: 40000 }
redaction_profile: kyc-standard
```

- The platform compiles selectors into the plan's purpose-bound context grants. The
  context plane assembles sections with trust, provenance and digests, quarantines
  instruction-like untrusted content, and computes `context_hash`.
- The platform consumes the library's per-skill field matrix (library plan §8 steps 1–2)
  to validate `context.yaml` against canonical case paths. **Pending:** the library's
  `context-specification.md`.
- Structured data for deterministic calculation (for example a full transaction window)
  is passed as structured sections with watermarks and coverage. It is never cut to fit
  a model token budget, and budget overflow on a required section fails the execution.

## 8. Packaging, registry and pinning

- **Manifest:** `skills/<domain>/<skill>/skill.yaml` (library plan §4), plus every spec §4
  field. `version` is semver. Frontmatter names (`entity-resolve`) map one-to-one to
  canonical IDs (`entity.resolve`).
- **Maturity:** `catalogued | designed | implemented_synthetic | integration_verified |
  production_qualified`. The platform refuses to bind a production plan to a skill below
  `integration_verified`, and records maturity in the plan.
- **Bundle lock** (`bundle.lock.json`, served at `GET /v1/bundle`):
  ```jsonc
  { "bundle_id": "fincrime-skills", "bundle_version": "0.4.0", "bundle_digest": "sha256:…",
    "image_digest": "sha256:…", "python": "3.12.x",
    "skills": [ { "id": "registry.company.verify", "version": "0.3.0", "maturity": "implemented_synthetic",
                  "manifest_digest": "sha256:…", "instructions_digest": "sha256:…", "code_digest": "sha256:…",
                  "input_schema_digest": "sha256:…", "output_schema_digest": "sha256:…",
                  "dependencies": { "capabilities": ["business.registry.lookup.v1"], "skills": [] },
                  "effects": "proposal", "evaluation_report_digest": "sha256:…" } ],
    "sbom_digest": "sha256:…" }
  ```
- The platform ingests the library's `catalog/catalog.json` entries verbatim into its skill
  registry (vendored in `config/skill-library`, `scripts/sync-business-skills.mjs`); a
  `manifest_digest` is `sha256:` + sha256 over the canonical JSON of the catalog entry, the
  library's own `digest()` (CR-7). It registers each bundle digest in
  the **artifact registry** (kind `skill-bundle`), and pins `bundle_digest`,
  `skill_version` and `manifest_digest` into compiled plans. A bundle is executable only
  while its registry entry is approved and unrevoked.
- No dynamic code: the host MUST NOT install packages or load code at execution time.
  A new dependency means a new bundle.

## 9. Hosting and identity

- **Image:** one skill-host image per bundle. It needs no secrets other than its workload
  identity, and no network egress except to the gateway URL.
- **Inbound authentication** (one mode per deployment, as on the platform's runtime host):
  - local: a shared bearer `SKILL_HOST_AUTH_TOKEN`
  - workload identity: the gateway's projected workload-identity token, verified against the issuer
  - Databricks App: the Apps proxy's forwarded identity, limited to the gateway's service principal
- **Outbound:** the host authenticates to the gateway with its own workload identity *and*
  presents the delegated envelope. Both are required.
- **Runtimes:** the host runs as a gateway-reachable service next to any platform runtime
  (local Compose profile `skills`, a deployment on any Kubernetes cluster or container
  platform, or a Databricks App). It is not deployed per skill.

## 10. Errors

Use the spec §4.3 codes exactly. HTTP mapping:

| HTTP | When | `error.code` |
| --- | --- | --- |
| 200/202 | execution accepted or finished, including business failures | per `computation` / `error` |
| 400 | body or parameters invalid | `INPUT_INVALID` |
| 401/403 | caller not authenticated or not the gateway | `ACCESS_DENIED` |
| 404 | unknown skill, or unknown execution on status | `INPUT_INVALID` / none |
| 409 | version or bundle mismatch, or idempotency conflict | `INTEGRITY_FAILURE` / `INPUT_INVALID` |
| 429 | host saturated | `RATE_LIMITED` (retryable) |
| 503 | dependency down | `SOURCE_UNAVAILABLE` (retryable) |

`retryable: true` only for `RATE_LIMITED`, `TIMEOUT` and `SOURCE_UNAVAILABLE`, and only
when the skill has no pending external effect. The platform owns retries: the host never
retries a gateway call that returned a receipt.

## 11. Conformance

The platform provides a conformance suite the host must pass before a bundle is approved:

1. **Idempotency:** the same `execution_id` returns the same response, and a mismatched body returns 409.
2. **Pinning:** the wrong `skill_version` or `bundle_digest` returns 409. There is no fallback.
3. **Authority:** an undeclared capability call is denied, and an expired or delegated-elsewhere envelope is refused.
4. **Unknown ≠ pass:** fixtures with `not_checked`, `unknown` or missing required context never yield a passing payload.
5. **Injection:** instruction-like text in `UNTRUSTED_*` sections changes neither tool use nor results.
6. **Effects:** `read_only` skills return no records, and external writes appear only as `requested_effects`.
7. **Recovery:** cancel, deadline and host restart report honestly (404 or terminal), and nothing is repeated.
8. **Determinism:** identical request, context hash and seed give an identical deterministic payload.
9. **Tenant isolation:** sections from another tenant are rejected (`ACCESS_DENIED`).

The same fixtures run through the library's in-memory `services` and through the platform
(local runtime, then a hosted runtime or Databricks). Deterministic payloads must match exactly;
model outputs are compared against quality thresholds.

## 12. First increment (proves the contract)

| Skill | Kind | Platform path |
| --- | --- | --- |
| `ownership.interest.calculate` | deterministic | context sections only; no capability calls |
| `registry.company.verify` | provider-backed | `business.registry.lookup.v1`, `reference.identifier.lookup.v1` via wiring connectors |
| `document.fields.extract` | model-assisted | `document.evidence.ingest.v1` + a `model.*` task capability |
| `decision.approval.route` | approval-gated composite | returns a `case_command` effect `RequestHumanReview`; the orchestrator suspends on a durable approval |

Done when all four run end to end in the KYB slice, pass §11, and match between the
library's local doubles and the platform.

## 13. Who builds what next

| Platform (`ehfconcept`) | Skill library |
| --- | --- |
| Skill registry ingestion of the catalog + maturity (done: `config/skill-library`) | `skill.yaml` / schemas / `context.yaml` for the four first-increment skills |
| `skills` gateway adapter (this protocol) + delegated envelopes | Skill host implementing §4 and §5; in-memory `services` doubles |
| Artifact kind `skill-bundle`, bundle verification via `GET /v1/bundle` | Bundle lock generation, SBOM, evaluation reports |
| Compile-time dependency closure into permission envelopes | Declared dependencies for each skill |
| Record/effect commit path (§6.2–6.3) and outbox routing (done: §15) | Typed proposed records and effects, incl. `CanonicalRecord` (CR-5, CR-9) |
| Conformance suite (§11) and a Compose profile `skills` | Pass the suite; keep fixtures shared |
| Rename agent-instruction "skills" to agent-profile instructions | `context-specification.md` field matrix (needed for §7) |

The library-side changes this requires of release 0.1.0 are listed in
[skill-library-change-request.md](skill-library-change-request.md).

## 14. Open items

- The library's `context-specification.md` and `skill-design-backlog.md` are needed to
  finalize the §7 path vocabulary and the KYB dependency closure.
- Agent profiles (library §6) versus platform agent registrations: merged on the platform
  side into one `agentProfiles` contract for v2 plans; the contract, compiler rules and
  field mapping to the library's `AgentProfile` are in [agent-profiles.md](agent-profiles.md).
  `timeout_seconds` and `max_objects` are not represented yet. The library reviews.
- Whether the host should stream progress events (`skill_started`, `provider_called`, …,
  spec §8) or the platform derives them from gateway receipts. The platform derives them
  initially.
- Python version and SDK pins are settled in the library's compatibility spike.

## 15. Implementation status (platform)

Non-normative. What the platform side of §4, §6.1, §8, §9, §11 and §13 does today, where it
lives, and where it reads the normative text more narrowly than it is written. Above, §6.2 was
amended on 2026-11-08 (the `CanonicalRecord` record type and the record bodies) and §6.3 gained the
platform's hold-and-release paragraph; nothing else was changed.

### What exists

| Contract | Platform implementation |
| --- | --- |
| §4.1/4.2/6.3/8 schemas | `packages/contracts/src/index.ts`: `skillExecutionRequestV1Schema`, `skillExecutionResponseV1Schema`, `skillComputationSchema`, `skillProposedRecordSchema`, `skillRequestedEffectSchema`, `skillEvidenceRefSchema`, `skillBundleLockSchema`, `skillExecutionAcceptedSchema`, `skillHostErrorBodySchema`. Top-level objects (and the shapes the contract spells out) are strict; `extensions` is free-form. |
| Capability input/output | `skillCapabilityInputV1Schema` = `{ input: SkillInput.v1, context: { envelope, context_hash, sections, missing }, extensions? }`, the body the runtime sends as `CapabilityRequest.input` to a `skills:` capability. The gateway adds everything else (execution id, pins, callback, limits). `skillCapabilityOutputV1Schema` is what comes back as `CapabilityResult.output`: the validated host response plus `skill_id`, `skill_version`, `bundle_digest`, `manifest_digest`, `effect_mode` and `dependency_receipts`. `FAILED_EXECUTION` and `CANCELLED` are results (the execution ran); pinning, transport and integrity problems are gateway failures (`adapter.skills_*`). `packages/runtime-core/src/skill-execution.ts` maps the output to SkillResult.v1 (not yet re-exported from the runtime-core index). |
| §6.1 delegated envelope | `mintDelegatedEnvelope` and `issueDelegatedEnvelope` (`packages/execution-auth`), issued in-process by the gateway (`apps/capability-gateway/src/delegation.ts`) and accepted in `apps/capability-gateway/src/app.ts`. Design below. |
| §4, §10 platform caller | `skills` gateway adapter module (`apps/capability-gateway/src/adapters/skills.ts`), wire client `packages/adapters/src/skill-host.ts`. See [capability adapters](capability-adapters.md#skill-host-skills). |
| §8 pinning | `harnessc` accepts `bundleDigest` (required when a candidate's connector is `skills:<skill_id>`, refused otherwise) and `dependencyCapabilities` on a package `skillBindings` entry, pins both into the plan (`planSkillBindingSchema`, emitted only when present, so existing plans keep their digests) and adds the dependency capabilities to the node's permission envelope (a dependency bound to `skills:` is refused: no recursion). Fixture: `packages/contracts/test-fixtures/skill-hosted/`. |
| §8 registry | Artifact kind `skill-bundle` (migration 033). `POST /v1/registry/skill-bundles` (`release.create`) registers a lock: every `(id, version, manifest_digest)` must be in the business-skill registry; the entry's reference is `skill-bundle:<bundle_id>@<bundle_version>;lock=<sha256 of the canonical lock>`. `POST /v1/registry/skill-bundles/:digest/approve` (`release.approve`) approves it, never by the registrant (the registry's separation of duties). Revoke with the generic `POST /v1/registry/artifacts/skill-bundle/:digest/revoke`; list with `GET /v1/registry/artifacts?kind=skill-bundle`. |
| §9 hosting | Compose profile `skills` runs `apps/skill-host-reference` (local bearer). The gateway authenticates to a host with `SKILL_HOST_AUTH=platform_token|databricks_app`; `platform_token` is the gateway's own service credential (`GATEWAY_SERVICE_TOKEN` locally, its workload-identity token in production). |
| §11 conformance | `packages/skill-conformance`: `runSkillHostConformance({ baseUrl, token, fixtures, … })` runs checks 1–9 against any host with a fake gateway, and a CLI (`pnpm --filter @ehf/skill-conformance conformance -- --base-url … --fixtures …`). CI runs it against the reference host (`apps/skill-host-reference/src/conformance.test.ts`), including a deliberately broken host the suite must fail. |
| §12 shapes | The reference host's three synthetic skills: `sample.ownership.interest.calculate` (deterministic over a `holdings` section), `sample.registry.verify` (calls `business.registry.lookup.v1` through the gateway with the delegated envelope, cites the receipt, proposes a Finding and a synthetic `RegistryRecord` `CanonicalRecord`; manifest `package.produces: [RegistryRecord]`), `sample.evidence.check` (read-only, NEEDS_EVIDENCE without `subject`). |
| §6.2–6.3 commit path | Runtime: `commitSkillComputation` / `releaseHeldSkillEffects` (`packages/runtime-core/src/index.ts`), mapping `planSkillCommit` (`packages/runtime-core/src/skill-commit.ts`), wired in `packages/runtime-langgraph/src/index.ts` after the gateway result and before SkillResult.v1. Case API: `POST /v1/cases/{caseId}/skill-commits`, `POST /v1/cases/{caseId}/skill-executions/{executionId}/release`, `GET /v1/cases/{caseId}/skill-effects`; store `packages/case-store/src/skill-commits.ts`, table `skill_effects` (migration 011). Compiler: binding `effects` pin and node `skillGrant` entries (`packages/compiler/src/compiler.ts` `checkSkillGrants`); envelope claim `case_writes_held`. Gateway: record bodies, CanonicalRecord rules, forbidden effects (`checkComputation`). Conformance check 6: the same record rules. Details: [canonical records](canonical-records.md#skill-originated-records). |
| §4.1 `policy` section (CR-4) | `packages/context-plane/src/policy.ts`: for a node with `config.skillPolicy` (compiled from the pinned policy bundle, `scripts/sync-kyc-package.mjs`) the runtime sends `sections[]` id `policy`, kind `policy`, `TRUSTED_DATA`, `provenance_ref` `policy-snapshot:<digest>`, holding exactly the manifest's `policy_context_fields`; per-cohort values are computed with `@ehf/policy-engine`. A case pinned to another bundle or an unresolved field blocks the skill (NEEDS_EVIDENCE, `POLICY_UNRESOLVED`). Used by `domains/archive/kyc-v2-deterministic`; KYB has no platform policy bundle. |

### Delegated envelope design (§6.1)

A delegated envelope is presented only by a skill host and accepted only by the gateway, so the
gateway issues it in-process; no other service is involved and the gateway needs no identity at
the control plane. Under `ENVELOPE_SIGNER=private_key` it signs delegated envelopes with its own
key (`DELEGATED_ENVELOPE_PRIVATE_KEY_FILE`, `DELEGATED_ENVELOPE_KEY_ID`) and is their only
verifier; under `hmac` (development) it uses the shared envelope secret.

1. The gateway verifies the runtime's node envelope for its own `/v1/invoke` as for any call.
2. The `skills` adapter calls the in-process `issueDelegatedEnvelope` (`@ehf/execution-auth`)
   with the parent envelope and `{skillId, skillVersion, capabilities, deadlineAt}`.
3. Issuance verifies the parent again (the shared secret, or the control plane's
   `EXECUTION_ENVELOPE_PUBLIC_KEY_PEM`), refuses a delegated parent (no chains), and re-derives authority from durable state as
   `issueExecutionEnvelope` does: run running at the parent's attempt, current fence equal to the
   parent's, v2 plan whose release is still executable (a revoked release refuses at once), work
   item still leased under the parent's work fence for that node. The node must be bound to that
   skill version with a registry manifest of the pinned digest. Requested capabilities must lie
   in the parent, the node's permission envelope and the skill's declared dependencies, and none
   may be bound to `skills:`.
4. It mints claims identical to the parent's (tenant, case, run, node, attempt, work item and
   both fences, plan and permission digests) with the narrowed `capabilities` and their effects,
   empty `case_writes`/`case_reads`, `delegated_to: skills:<skill_id>@<semver>`,
   `parent_jti`, `jti: dlg:<parent jti>`, and `exp = min(parent exp, deadlineAt)`.

The gateway accepts a delegated envelope on `/v1/invoke` exactly like a node envelope (same fence,
plan, permission-digest, capability and effect checks against the admitted plan, same budget
reservation and receipt), plus: the caller must hold the `Skill.Host` role (and a `Skill.Host`-only
caller cannot spend a node envelope); the invocation id must be `<parent jti>:<key>` (the parent
jti is the execution id, so each dependency call has its own receipt and replays idempotently);
no skill-selection record; and a capability bound to `skills:` is refused
(`gateway.delegated_skill_call_denied`). The receipt's reason code names `delegated_to`. The case
API refuses delegated envelopes outright.

### Readings and deviations

- **`manifest_digest` (§8).** The platform compares it with its own registry digest: `sha256:` +
  `businessSkillManifestDigest(entry)`, sha256 over the canonical JSON (keys sorted, no
  whitespace) of the library catalog entry as the catalog states it, i.e.
  `config/business-skills.json` `manifestDigest`. This is the library's own `digest()`
  (it reproduces `release-lock.json` `catalog_hash`), agreed in CR-7; registration refuses a lock
  whose digests differ.
- **Dependency calls (§5).** The host sends `invocationId = <execution_id>:<key>` (key
  `[A-Za-z0-9._~-]{1,128}`, the `idempotency_key` when given) and the capability's declared
  effect (default `read`) in the gateway `CapabilityRequest`; the gateway rejects anything else.
- **Outbound identity (§9).** The gateway recognises a host by the `Skill.Host` workload role
  (`SKILL_HOST_GATEWAY_TOKEN` locally; in production the host's workload identity, mapped to
  `skill-host` through `WORKLOAD_IDENTITIES`).
- **Delegated TTL.** Bounded by the parent's remaining lifetime as well as `deadline_at`, so with
  the default 60 s envelope TTL a skill's dependency calls must happen within about a minute of
  the node envelope's issue. Longer skills need a longer envelope TTL; delegation refresh is not
  implemented.
- **Tenant isolation (§11.9).** A section's `provenance_ref` of the form `case:<case_id>…` must
  name the envelope's case, and input and envelope must agree on tenant and case. The gateway
  refuses otherwise before calling the host, and conforming hosts refuse with 403 ACCESS_DENIED.
- **Required context (§3 step 2).** The gateway refuses a request whose `context.missing` has a
  `required: true` entry (`adapter.skills_context_missing`) and refuses `COMPLETED` when it does;
  returning CONTEXT_MISSING without calling the skill remains the runtime's job.
- **Effect mode.** Derived from the registry manifest by `businessSkillEffects` (library
  `effects` per CR-5: `human_gated` → `internal_write`, or `external_write` for
  `regulatory.filing.submit` and `evidence.retention.enforce`, with approval required; a
  platform-authored manifest's `package.effects.mode`, default `read_only`) and must equal the
  lock entry's `effects`, at registration and at every call. `internal_write` case commands must
  be in the manifest's `authorization` (as `<Type>` or `case_command:<Type>`) and in the node
  envelope's `case_writes` (or, for an approval-required skill, `case_writes_held`); decision,
  disposition, review and approval commands are refused outright.
- **Evidence attribution.** Section evidence must match a section id and digest of this request;
  receipt evidence must be the digest of a gateway receipt for `<execution_id>:*` in the same run.
- **Error bodies.** Non-2xx host answers carry `{ "error": { "code", "retryable", "detail_ref" } }`;
  a status 404 for an unknown execution has no code. Unknown skill at start is 404 INPUT_INVALID.
- **Maturity.** The gateway refuses a skill below `integration_verified` when
  `RELEASE_ENVIRONMENT=production` (registry maturity, not the lock's claim). Compile-time
  refusal is not implemented.

- **Commit path (§6.2–6.3).** The commit runs in the runtime after the gateway result, not in the
  gateway or the host: the runtime holds the validated computation, the plan and the node
  envelope; the case API re-checks authority from the envelope (`case_writes` /
  `case_writes_held`) and never trusts the request for it. Claims land `PROPOSED` (the case
  store's pending-review status). A `Fact`'s claim value is `{ asserted, verificationCriteria }`.
  A `Hypothesis` is not committed. The case API derives the actor
  (`skills:<skill_id>@<semver>`, `executionId` = run), plan, permission and policy digests
  itself. A release requires reviewer ids (a conflict resolution, which names none, cannot
  release: `approval_unverifiable`) and refuses reviewers that include the case's human
  requester; reviewer authorization and dual control are the human work queue's. The approval
  decision is the one the durable approval node committed, presented by the release node; the
  case API does not re-read it from the control plane (below). Held effects expire after seven
  days unless the skill names an earlier `expires_at` (at most thirty).

### Not done yet

- The case API trusts the release node's report of the durable approval decision (bounded by
  that node's envelope, the held binding and reviewer independence from the requester); it does
  not cross-check the decision against the control plane's human-decision record.
- An outbox row for an approved external action is delivered by the outbox relay to the
  governed integration plane like any case event; per-action acknowledgement and reconciliation
  of ambiguous acknowledgements (`EXTERNAL_ACTION_UNCONFIRMED`) are not implemented, and a
  `NO_ROUTE` intent stays pending until someone acts on it.
- A node re-executed after a crash between its commit and its work-item completion is a new
  skill execution (its context names the newer case sequence): canonical records dedupe by
  version, claims and findings are proposed again.
- Compile-time dependency closure from the registry: `dependencyCapabilities` is authored in the
  package, not derived from the registry entry, and `manifestDigest`/`bundleDigest` are not
  checked against the registry at compile time (the KYB/KYC generators check them against
  `config/skill-library`).
- Per-skill `limits`: the gateway passes the plan's run budgets and the capability timeout; the
  gateway reservation enforces run-wide counts, not per-execution ceilings.
- Deployment (outside this repository): the gateway's `skills` settings and delegated-envelope
  key, the `skill-host` entry in `WORKLOAD_IDENTITIES`, and the skill-host deployment or
  Databricks App.
- The reference host's sample manifests are not seeded into the business-skill registry, so the
  Compose `skills` profile needs them registered (and the bundle registered and approved) before
  a plan can call them; the gateway test does this with a fake database.
- `permitted_skills` is passed through from the lock; the platform does not yet check sub-skill
  versions or `trace.subskill_executions`. `services.models` and progress streaming (§14) are
  untouched.

## References

- Canonical skills spec v1 (§3 context and epistemic types, §4 contract, §8 runtime, §9 resolver)
- Skill implementation plan (library): §4 package, §5 entrypoint, §6 profiles, §7 hosting
- Platform: [artifact registry](artifact-registry.md), [context plane](context-plane.md),
  [agent loop](agent-loop.md), [runtime adapters](runtime-adapters.md),
  [capability adapters](capability-adapters.md), [capability naming](capability-naming.md),
  [business skills](business-skills.md) (in progress)
