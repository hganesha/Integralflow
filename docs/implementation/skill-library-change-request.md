# Change request: skill library → platform hosting (`skill.execution.v1`)

To: skill library team (`hganesha/kyc`, written against release 0.1.0; updated for release 0.2.0,
catalog of 222 `implemented_synthetic` skills, context schema 2.0.0)
From: platform (`ehfconcept`)
Status: proposed; see [Status after library 0.2.0](#status-after-library-020). CR-7 and the
platform side of CR-2/CR-4/CR-5/CR-6/CR-9 (the commit path for proposed records and requested
effects, 2026-11-08) are done (below). Normative text stays in the
[integration contract](skill-library-integration-contract.md); this request lists what the library
has to change so the platform can run its skills. Section numbers (§) refer to the contract.

## Why

Release 0.1.0 is a complete, self-contained library: its own `Executor`, SQLite `Repository`,
approval store, `WorkflowRunner`, outbox and its own invocation transport. The platform already
owns each of those (durable Postgres orchestrator, case store, approval nodes, outbox, artifact
registry, gateway with receipts and budgets). If both run, the same case has two authorities.

The division we agreed:

1. Platform connectors acquire data and store it as **canonical records** in the case store.
2. Library skills **reason over those records** and return a payload, proposed records and
   requested effects.
3. The platform validates and commits, or routes them to human approval.

The library keeps its executor for local tests and demos. Nothing below removes it. What is
needed is a second, stateless hosting mode in which the platform is the authority.

## Status after library 0.2.0

Release 0.2.0 closed the library's contracts (87 closed context types, 444 closed skill
input/output schemas, closed effect-command variants, nine provider request/response schemas,
record migration 1.0.0 → 2.0.0). It added no platform hosting mode. The platform has vendored those
contracts ([library-contracts.md](library-contracts.md)) and built its side wherever the closed
shapes made that possible:

| # | State after 0.2.0 | What the platform did | Still asked of the library |
| --- | --- | --- | --- |
| CR-1 | Open | — | `skill.execution.v1` transport |
| CR-2 | Open | The platform commits proposed records itself (§6.2 commit path) | Request-seeded repository |
| CR-3 | Open | — | `GatewayProvider` |
| CR-4 | Policy half settled on the platform side | Each skill node pins its `policy_context_fields` projection of the policy it runs under (KYB: the synthetic pack; KYC: the US KYC OPA bundle); one resolver (`packages/context-plane/src/policy.ts`) sends it as the `policy` section, provenance `policy-snapshot:<case snapshot digest>`, only for a case pinned to that policy and bundle and only when every declared field resolves (else POLICY_UNRESOLVED, skill not called) | Read policy from the `policy` section; build `Principal`/`AgentProfile` from the request |
| CR-5 | Effect shapes closed (`EffectCommand.schema.json`), still raw `state`/`outbox` | `mapLibraryEffects` maps every variant to typed `requested_effects` and refuses undeclared or unmapped commands; `LIBRARY_SKILL_EFFECTS` lists the case commands and external actions each of the 15 write/gated skills' commands map to, with mode and approval from the one registry rule (`businessSkillEffects`); the commit path commits or holds effects only within the binding's pinned effects (`case_command:<Type>` in the manifest) | Emit `requested_effects` directly (or adopt the mapping in the platform host), with the case sequence from `state.case`; list `case_command:<Type>` authorizations |
| CR-6 | Open | Approval-required effects are held, bound to the execution, and released or discarded by the release node after the durable approval | Binding verification on resume (optional, see CR-6) |
| CR-7 | `manifest_digest` rule agreed | The registry is the vendored catalog; KYB and KYC pin `businessSkillManifestDigest` of each entry and `bundle_code_hash` | `bundle.lock.json` served by the host |
| CR-8 | Provider contracts closed | 8 new capability IDs in the connector catalog; 6 schema-checked sandbox connectors that only answer INCONCLUSIVE; model capabilities await a model connector | Write the canonical IDs into `dependencies.capabilities`; `fraud.liveness` needs a liveness assessment from `identity.biometric.verify.v1` |
| CR-9 | Record shapes closed (context 2.0.0) | Connector normalizers emit closed 2.0.0 data (extras under `extensions["ehf.connector"]`) and validate every record before commit; the gateway applies the same closed contract to skill-proposed `CanonicalRecord`s | Accept negative-search evidence (see below) |
| CR-10 | Open | — | Conformance fixtures per skill |

Answers that 0.2.0 supplies to the questions at the end: **Q4** — the 29 KYB skills read 19 policy
fields: `active_registry_statuses`, `approval_roles`, `control_bases`, `document_types`,
`edd_triggers`, `freshness_seconds`, `jurisdiction`, `ownership_threshold`, `permissions`,
`requirements`, `review_interval_seconds`, `risk_model_version`, `risk_tiers`, `risk_weights`,
`role_members`, `rules`, `screening_threshold`, `verification_methods`, `version` (all present in
the synthetic pack). Across the 222 skills, 56 policy fields are declared; `remediation_role` is
not in the synthetic pack.

New since 0.2.0:

- **Negative search.** The ontology still has no type for a completed search with no candidate.
  The platform keeps `NegativeSearchEvidence` as a platform-only record with its own closed schema;
  the screening skills still answer NEEDS_EVIDENCE on a clean screen. Proposal: add a
  `NegativeSearchEvidence` context type (capability, provider, subject, dataset versions, scope,
  truncated, total candidates, `Coverage`, query time, limitations) and let the screening skills
  report "no candidate within this coverage" from it, never "clear".
- **`Evidence.requirement_ids` / `verified`** are now required. Document evidence from the
  platform's pipeline carries `requirement_ids: []` and `verified: false`, so
  `evidence.sufficiency.assess` keeps reporting insufficient until requirement mapping and
  verification exist (platform or library: to agree).
- **`Party.customer_type`** is required; the platform sends `corporate` for registry subjects, the
  synthetic pack's KYB customer type (`customer_types: { corporate: KYB, individual: KYC }`). The
  schema leaves it a free `Id`; an enum or a policy-bound check would catch a mismatch earlier.

## Summary of changes

| # | Change | Size | Blocks |
| --- | --- | --- | --- |
| CR-1 | `skill.execution.v1` HTTP transport (§4) | M | everything |
| CR-2 | Per-execution, request-seeded `Repository` (no host-owned state) | M | CR-1 |
| CR-3 | `GatewayProvider`: capabilities through the platform gateway | S | provider/model skills |
| CR-4 | Principal and policy from the request, not a bearer-hash file | S | CR-1 |
| CR-5 | Typed effects instead of raw state writes; effect-mode mapping | M | 15 write skills |
| CR-6 | Human-gated skills: platform-held approval, library-verified binding | M | 7 gated skills |
| CR-7 | Bundle lock and `manifest_digest` agreement (§8); platform side done | S | bundle approval |
| CR-8 | Canonical capability IDs for the 9 provider/model dependencies | S | CR-3 |
| CR-9 | Record envelope and context section shape | S | CR-2 |
| CR-10 | Pass the conformance suite (§11) | S | bundle approval |

Suggested order: CR-7 and CR-9 (agreements, small), then CR-1 + CR-2 + CR-4 with read-only code
skills only, then CR-3/CR-8, then CR-5/CR-6, then CR-10 on the whole bundle.

---

## CR-1. `skill.execution.v1` transport

Add `financial_crime/runtimes/platform.py` (an ASGI app; the library's former Foundry runtime
has since been removed) implementing §4 exactly:

| Route | Behaviour |
| --- | --- |
| `POST /v1/skills/{skill_id}/executions` | Parse `SkillExecutionRequest.v1`; refuse unknown top-level fields; `409 INTEGRITY_FAILURE` unless the bundle serves exactly `skill_id@skill_version` from `bundle_digest`; build an `Invocation` + `Principal` (CR-4) and a request-seeded repository (CR-2); call `Executor.run`; map the `SkillResult` to `SkillExecutionResponse.v1`. |
| `GET /v1/skills/executions/{execution_id}` | Latest response, or `404` with no body code when unknown (for example after a restart). Never a guessed terminal state. |
| `POST /v1/skills/executions/{execution_id}/cancel` | Best effort; maps to the executor's existing cancellation. |
| `GET /healthz`, `GET /v1/bundle` | The bundle lock (CR-7). |

`Idempotency-Key` equals `execution_id`. A repeat with the same body digest returns the original
response; a different body returns `409 INPUT_INVALID`. An in-memory map bounded by TTL is
enough: the platform treats a `404` after restart as "unknown" and does not re-run blindly.

Field mapping, request → library `Invocation`:

| `Invocation` field | Source |
| --- | --- |
| `execution_id`, `idempotency_key` | `execution_id` |
| `skill_id`, `skill_version` | path + `skill_version` |
| `tenant_id`, `case_id`, `subject_ids` | `context.envelope.tenant_id`, `case_id`, `subject_refs` (strip the `subject:` prefix) |
| `actor_ref` | `context.envelope.actor` (a workload such as `workload:runtime/<worker>`) |
| `profile_id` | a fixed `platform` profile built per execution (CR-4) |
| `purpose` | `sections[].purpose` mapped by the table in CR-9 |
| `policy_snapshot_ref`, `as_of_time` | `context.envelope.policy_snapshot_ref`, `as_of_time` |
| `knowledge_cutoff` | `context.envelope.as_of_time` unless `extensions.knowledge_cutoff` is given |
| `parameters` | `input.parameters` (already validated by the platform; validate again) |
| `trace_id` | the `traceparent` trace id |

Response mapping, library `SkillResult` → `SkillExecutionResponse.v1`:

| Library | Contract |
| --- | --- |
| `lifecycle` `SUCCEEDED` / `WAITING_FOR_HUMAN` | `COMPLETED_EXECUTION` (waiting for a human is a business status, not a lifecycle) |
| `lifecycle` `FAILED` / `CANCELLED` | `FAILED_EXECUTION` with `error` / `CANCELLED` |
| `status` | `computation.business_status` (identical enum) |
| `payload`, `unresolved_items` | same |
| `Computation.commands` | `computation.requested_effects` (CR-5) |
| `evidence_refs` / `finding_refs` | `proposed_records[].evidence` as section or receipt citations (CR-9) |
| `execution_lock` (code/instruction hashes) | `trace.code_digest`, `trace.instructions_digest` |
| `metrics` | `computation.metrics` (`duration_ms`, `capability_calls`, `model_calls`) |
| `SkillError.code`, `.retryable` | `error.code`, `error.retryable` (`retryable` only for `RATE_LIMITED`, `TIMEOUT`, `SOURCE_UNAVAILABLE`) |

`limits.deadline_at` must stop the execution with `TIMEOUT`; the library's
`AgentProfile.timeout_seconds` becomes `min(timeout_seconds, deadline_at - now)`.

## CR-2. Request-seeded repository

The library's `Repository` protocol is already the right seam. Add an in-memory
`ExecutionRepository` that lives for one execution and is never the authority:

| `Repository` method | Behaviour in platform mode |
| --- | --- |
| `records(tenant, object_type)` | Records from `context.sections` whose id is `records.<ObjectType>` (CR-9). Other tenants are impossible: refuse a section whose `provenance_ref` names another case with `ACCESS_DENIED`. |
| `put(record)` | Appends to `computation.proposed_records` (§6.2). Not visible to later executions. |
| `state(kind, id)` | Read from a `state.<kind>` section (for example the case status and revision); missing state is `CONTEXT_MISSING`, not an empty object. |
| `set_state(...)` | Not allowed directly; skills emit typed effects (CR-5). |
| `add_outbox(cmd)` | Becomes an `external_action` in `requested_effects` (CR-5). |
| `event`, `audit_chain` | Into `trace` (ids, digests and counts only). |
| `jobs`, `claim_job`, `save_job`, `discard_job` | Keyed on `execution_id` in memory; the platform's work-item lease is the real claim. |
| `transaction()` | No-op context manager; nothing is committed by the host. |

**Platform side done (2026-11-08).** `put(record)` for an ontology record becomes a
`CanonicalRecord` proposed record (contract §6.2 amendment): `body` is the library `Record`
without the fields the platform sets — no `tenant_id`, `recorded_at`, digest or provenance; the
library's `id` is `object_id` — i.e. `{ object_type, object_id, version_id, schema_version?,
data, subject_ids?, valid_from?, valid_to?, observed_at, source_refs, classification, purposes?,
synthetic, supersedes? }`, with `local_ref` unique per execution and evidence citing a section
digest or receipt of this execution. The platform commits it with `RecordCanonicalRecords`
(provenance `skill_proposal` naming skill, version, execution id and receipt digest) in the
same transaction as the node's other records, and the next skill in the run selects it. A
record proposed by a skill the catalog marks `read_only` is refused (`INTEGRITY_FAILURE`): the
skills whose outputs later steps read as records must be `proposal` (CR-5).

`Executor.replay` is not used in platform mode: the platform keeps the `ContextManifest` and
replays by re-sending the identical request (§11.8 determinism). The library's
`services.clock`/`ids` must take `as_of_time` and a seed from the request in this mode.

Acceptance: a platform-mode execution writes nothing to disk, and two hosts given the same request
return byte-identical deterministic payloads.

## CR-3. `GatewayProvider`

Implement the existing `Provider` protocol over the gateway (§5):

```python
class GatewayProvider:
    provider_id = "platform-gateway"
    async def invoke(self, capability: str, request: dict) -> ProviderResponse:
        # POST {callback.gateway_url}/v1/invoke
        #   x-execution-envelope: <callback.delegated_envelope>
        #   Authorization: Bearer <host workload token, role Skill.Host>
        #   body: { invocationId: f"{execution_id}:{key}", capabilityId: CAPABILITY_MAP[capability],
        #           effect: "read", input: request }
        # ProviderResponse(provider_id=result.provider, capability=capability,
        #   request_hash=<as today>, payload=result.output,
        #   evidence_refs=[receipt ref built from result.receiptDigest],
        #   source_version=result.output.source_version, coverage=result.output.coverage,
        #   synthetic=<from the platform connector>)
```

Rules the gateway already enforces and the provider must respect:

- `invocationId` is `<execution_id>:<key>`, key `[A-Za-z0-9._~-]{1,128}`; reuse the key on retry so
  the call replays idempotently. Do not retry a call that returned a receipt.
- Only capabilities in `callback.permitted_capabilities` (refuse locally with `ACCESS_DENIED`).
- The delegated envelope lives at most as long as the node envelope (~60 s by default), so
  dependency calls must happen early in the execution.
- Status `succeeded` with an outcome of `unknown`, `not_checked` or `inconclusive` is not a pass:
  return `NEEDS_EVIDENCE` (the library already does this for missing recordings; keep it).
- Model skills (`document.entities.extract`, `document.translation.normalize`) use the same path
  with a `kind: model` capability. No model SDK keys in the host.

Keep `RecordedProvider` for local tests; select the provider by hosting mode, never as a fallback.

## CR-4. Principal and policy from the request

In platform mode, the platform has already authorised the call (plan pin, node envelope, gateway
admission, delegated envelope). The host must not re-authorise from a bearer-hash file. Build,
per execution:

- `Principal(tenant_id=envelope.tenant_id, actor_id=envelope.actor, permissions={f"skill:{skill_id}"},
  purposes={purpose}, classifications=<from sections>, case_ids={envelope.case_id},
  subject_ids=set(subject_ids))`.
- `AgentProfile(id="platform", allowed_skills={skill_id: skill_version},
  capabilities=set(permitted_capabilities), timeout_seconds=<from deadline>)`.

Inbound authentication stays as §9 (local bearer `SKILL_HOST_AUTH_TOKEN`, the gateway's
workload-identity token, or the Databricks Apps proxy). Only the gateway's identity may call the host.

Policy: the platform sends a `policy` section containing the pinned policy snapshot slice for the
skill's `policy_context_fields`, with `provenance_ref` `policy-snapshot:<digest>`. The library's
compiler reads policy from that section instead of its own store. The synthetic policy fields
(version, jurisdiction, permissions, freshness, `role_members`, `acceptance_role`) are the first
set to agree.

## CR-5. Typed effects

Today write skills emit raw state replacement:
`{"kind": "state", "type": "case", "id": …, "expected_revision": rev, "data": {...}}`
(`skills/governance.py:command`) and outbox items with free-form actions. The platform case store
accepts only typed `BusinessCommand`s with optimistic concurrency, so the host must return
`requested_effects` (§6.3) instead:

| Skill | Today | Requested effect |
| --- | --- | --- |
| `case.create` | state `case` `OPEN` | `case_command` `CreateCase` |
| `case.state.transition`, `case.close` | state `case` `state` | `case_command` `TransitionCaseStatus` |
| `case.tasks.assign` | state `assignment` | `case_command` `ProposeWorkItem` |
| `case.escalate` | state `escalation` | `case_command` `RequestHumanReview` (reason `escalation`) |
| `decision.human.review` | approval task | `case_command` `RequestHumanReview` |
| `decision.disposition.record`, `screening.alert.disposition`, `monitor.review.close` | state `case` `disposition` | `case_command` `RecordReview` after approval (CR-6) |
| `screening.rescreen.schedule`, `monitor.customer.schedule`, `monitor.review.execute` | outbox `execute_skill` | `case_command` `ProposeWorkItem` with a due date (the platform schedules runs; the host never queues skills) |
| `alert.feedback.capture` | state | `case_command` `RecordScreeningFinding` feedback |
| `regulatory.filing.submit` | outbox `submit_filing` | `external_action` `regulatory.filing.submit` |
| `evidence.retention.enforce` | outbox `delete_artifact` | `external_action` `evidence.retention.delete` |

Each effect carries `idempotency_key` (the library's existing digest), the case revision it was
computed against in `payload.expected_case_sequence`, and `justification_refs`. The platform
rejects a stale revision; the skill is then re-run on fresh context.

Effect modes in the manifest and lock (§6.3) replace the library's three values:

| Library `effects` | Contract `effects` |
| --- | --- |
| `read_only` (207) | `read_only` |
| `internal_write` (8) | `internal_write`, with each command type in `authorization` as `case_command:<Type>` |
| `human_gated` (7) | `internal_write` or `external_write` (filing, retention), plus `approval: required` |

Skills that produce findings, assertions or conflicts should return them as
`proposed_records` (`Finding`, `Assertion`, `Conflict`, `UnresolvedQuestion`) rather than state,
which makes them `proposal` mode.

**Platform side done (2026-11-08).** The platform commits immediate `case_command` effects with
optimistic concurrency (`payload.expected_case_sequence`, else the node snapshot's sequence; a
moved case fails the node, never overwrites) and holds those of `approval: required` skills
(CR-6). It refuses `FinalizeDisposition`, `RecordReview`, `RecordQAResult`, `RecordGateResult`,
`RecordPolicyEvaluation` and `AcceptClaimAsFact` as effects: a skill never records a decision,
disposition, review or approval, so the `RecordReview` rows in the table above
(`decision.disposition.record`, `screening.alert.disposition`, `monitor.review.close`) need
another effect — the human approval *is* the review, and the disposition is the reviewer's
`FinalizeDisposition`. Requests to the library:

1. `authorization` entries `case_command:<Type>` for every effect a write skill requests (none
   today, so every case-command effect is refused and the compiled nodes carry no effect grant).
2. Effect mode `proposal`, and `CanonicalRecord` proposals (CR-2, CR-9), for the read-only
   skills whose payloads carry what later steps require as records — in the KYB/KYC workflows
   apparently `ownership.ubo.resolve` (BeneficialOwner and the UBO VerificationRecord that
   `ownership.ubo.verify` needs), `risk.factor.evaluate` (RiskFactor, for
   `risk.customer.assess`) and `decision.requirements.compile` (Control, for
   `decision.recommendation.generate` and `decision.disposition.record`); please confirm which
   skill is meant to produce each. No skill on those paths produces WorkflowDefinition
   (`case.tasks.plan`), Finding (`quality.findings.verify`) or `Evidence.requirement_ids` /
   `verified` (`evidence.sufficiency.assess`): say whether those are skill outputs or platform
   state.

## CR-6. Human-gated skills

The platform owns approval: a durable approval node suspends the run, collects an independent
reviewer through the case API, and records the decision. The library keeps its binding checks,
without its own approval store:

1. **First execution.** The skill returns `business_status: NEEDS_REVIEW`, the proposed effect
   (not committed), and a `case_command` `RequestHumanReview` whose payload carries the binding:
   `{ skill_id, action, request_hash, context_hash, execution_lock_hash, case_sequence, expires_at }`.
2. **Platform.** Opens the review, checks reviewer ≠ requester and the policy role
   (`acceptance_role`), and records `RecordReview`.
3. **Resume.** A new execution (new `execution_id`) of the same skill version, with
   `extensions.approval = { approval_id, approver, role, decided_at, expires_at, binding }`.
   The host recomputes the binding from the new request and refuses with `CONTROL_FAILED` unless it
   matches, the approval has not expired and the case sequence is unchanged. This replaces
   `Executor._validate_approval`'s store lookup; the checks stay the same.
4. **Effect.** On a match the skill returns the gated effect in `requested_effects`. The platform
   revalidates the approval when it executes the effect (§6.3).

The host never sees reviewer credentials and `effects_committed` is always false in platform mode.

**Platform side done (2026-11-08).** The effects of an `approval: required` skill (and every
`external_action`) returned by the first execution are held by the platform, bound to the run,
node, execution id and binding hashes (request, context, code), the case sequence and an expiry
(`payload.expires_at`, default seven days). The generated packages put a release node after the
durable approval: on an approval by named humans other than the case's requester it re-validates
expiry and case sequence and commits them (external actions to the outbox only when the plan has
an outbound route for the action id, else a pending `NO_ROUTE` intent); on a rejection it
discards them, with an audit event either way. So steps 3–4 above can be the platform's alone:
the library need not re-execute the skill with `extensions.approval` for its effects to take
effect. If the library prefers to re-verify the binding itself (step 3), the second execution's
effects are held and released the same way.

## CR-7. Bundle lock and `manifest_digest`

Emit `bundle.lock.json` (§8) from `scripts/build_catalog.py` and serve it at `GET /v1/bundle`:

| Lock field | Library source |
| --- | --- |
| `bundle_id`, `bundle_version` | `financial-crime-skills`, `0.1.0` |
| `bundle_digest` | `sha256:` + `release-lock.json` `bundle_code_hash` (or a digest over the whole wheel; say which) |
| `image_digest`, `sbom_digest` | container build |
| `skills[].id`, `version`, `maturity` | catalog `id`, `semver`, `maturity` |
| `skills[].instructions_digest`, `code_digest` | `sha256:` + `instruction_hash`, `code_hash` |
| `skills[].input_schema_digest`, `output_schema_digest` | `sha256:` over canonical JSON of `input_schema`, `output_schema` |
| `skills[].dependencies` | catalog `dependencies.capabilities` (canonical IDs, CR-8) and `skills` |
| `skills[].effects` | CR-5 mapping |
| `skills[].manifest_digest` | see below |

**`manifest_digest`: agreed rule, platform side done.** The platform's business-skill registry
is now the library catalog itself: `config/skill-library/` vendors `catalog/catalog.json` and
`catalog/release-lock.json` byte for byte (with the library commit), and
`scripts/sync-business-skills.mjs` ingests every catalog entry verbatim as the registry
manifest (no platform-side manifest is generated). Both sides use one rule:

> `manifest_digest` = `sha256:` + sha256 over the canonical JSON of the catalog entry exactly as
> `catalog/catalog.json` states it: UTF-8, object keys sorted, separators `,` and `:` with no
> whitespace, no NaN/Infinity.

That is the library's existing `contracts.digest()` applied to one entry; the platform's
`businessSkillManifestDigest` (`packages/contracts`) is the same function, and a platform test
checks that it reproduces `release-lock.json` `catalog_hash` over the whole catalog. The KYB and
KYC packages pin exactly this value, the registry stores it, the skill-bundle route compares
the lock's `manifest_digest` with it, and the gateway refuses a mismatch. Effects in the lock
follow the CR-5 table (`human_gated` → `internal_write`, or `external_write` for
`regulatory.filing.submit` and `evidence.retention.enforce`); the platform refuses a lock entry
whose `effects` differ. `librarySkillBundleLock` in `packages/contracts` builds the lock the
platform expects from a catalog release (the table above, `bundle_digest` = `sha256:` +
`bundle_code_hash`), and a platform test registers that lock for all 222 skills.

What the library must still provide:

1. `bundle.lock.json` emitted by `scripts/build_catalog.py` with the fields above, and served by
   its host at `GET /v1/bundle` (CR-1); the platform registers and approves exactly that lock.
2. `image_digest` and `sbom_digest` from the host's container build.
3. If `bundle_digest` becomes a digest over the whole wheel (question 1), a new catalog field
   carrying it, so packages and registry pin the same value.
4. A catalog entry change means a new semver (the digest changes); the platform re-vendors with
   `node scripts/sync-business-skills.mjs --library <checkout>` and regenerates the packages.

## CR-8. Canonical capability IDs

The platform names capabilities `<namespace>.<subject>[.<action>].v<major>`. The nine library
dependencies need canonical IDs. Proposal (the platform adds the new ones to its connector catalog
with sandbox connectors):

| Library name | Used by | Platform capability |
| --- | --- | --- |
| `document.entities` | `document.entities.extract` (model) | `document.entities.extract.v1` (new, `kind: model`) |
| `document.translate` | `document.translation.normalize` (model) | `document.translate.v1` (new, `kind: model`) |
| `document.forensics` | `document.authenticity.assess` | `document.forensics.assess.v1` (new) |
| `fraud.synthetic_identity` | `fraud.identity.synthetic.detect` | `fraud.identity.synthetic.v1` (new) |
| `fraud.identity_theft` | `fraud.identity.theft.assess` | `fraud.identity.theft.v1` (new) |
| `fraud.document_tamper` | `fraud.document.tamper.detect` | `fraud.document.tamper.v1` (new) |
| `fraud.deepfake` | `fraud.deepfake.detect` | `fraud.media.deepfake.v1` (new) |
| `fraud.liveness` | `fraud.liveness.verify` | `identity.biometric.verify.v1` (existing; output must include a liveness result) |
| `fraud.account_takeover` | `fraud.account_takeover.detect` | `fraud.account_takeover.v1` (new; `risk.device.v1` supplies device signals) |

Write the canonical IDs into `dependencies.capabilities` and `permitted_capabilities`. The other 213
skills declare no capability dependencies: they read records that platform connectors already
acquired (registry, screening, identity, ownership). Keep it that way. A code skill that needs
fresh source data declares the capability rather than assuming the record is present.

## CR-9. Records and context sections

The platform's canonical record ([canonical-records.md](canonical-records.md)) follows the
library's `Record` envelope field for field (`tenant_id`, `object_type`, `version_id`,
`schema_version`, `data`, `subject_ids`, `source_refs`, `valid_from`, `valid_to`, `observed_at`,
`recorded_at`, `purposes`, `classification`, `synthetic`, `supersedes`) with three differences
the host must map:

| Platform record | Library |
| --- | --- |
| `object_id` | `Record.id` (the name the library's own `Ref` already uses) |
| `case_id`, `provenance` (connector, gateway invocation, captured evidence) | not in `Record`; ignore or carry in `source_refs` |
| `record_digest` (set by the case store) | not in `Record`; the platform cites it as the section content digest |

`recorded_at` and `record_digest` are set by the case store, never by a writer. Object types are
the library ontology's shapes.

Sections the platform sends:

| Section id | `kind` | `value` |
| --- | --- | --- |
| `records.<ObjectType>` | `case` or `evidence` | list of `Record` (current bitemporal versions as of `as_of_time`, only the fields the skill's `requirements` declare) |
| `state.case` | `case` | `{ status, sequence, disposition? }` |
| `policy` | `policy` | the skill's `policy_context_fields` slice (CR-4) |
| `upstream.<node>` | `upstream` | a prior skill's payload, when a workflow binds it |

`context.missing` lists required object types the platform could not supply; the library's
compiler maps them to its existing gap handling (`CONTEXT_MISSING` / `NEEDS_EVIDENCE`).

Vocabulary to agree:

| Library | Platform |
| --- | --- |
| purposes `onboarding`, `review`, `monitoring`, `investigation`, `fraud`, `reporting` | node purposes are finer-grained strings (`KYC_ONBOARDING`, `KYC_SCREENING`, `KYC_PEP_SCREENING`, `KYC_DISPOSITION`, …). Proposal: each skill-bound node also declares one of the six library purposes, and the platform sends that value as the section `purpose`. The host does not translate. |
| classification `internal` (default) | `INTERNAL`; `PII` and `CONFIDENTIAL` must be accepted when sections carry them |
| `Ref` (`tenant_id`, `object_type`, `object_id`, `version_id`) | section citation `{ section_id, content_digest }` or `{ receipt_digest, path }` |

Proposed records must cite a section digest or a gateway receipt digest from the same execution.

**`CanonicalRecord` proposals (platform side done, 2026-11-08).** A skill returns an ontology
record as `record_type: "CanonicalRecord"` with the `Record` envelope above minus the fields the
platform sets (CR-2). The gateway requires effect mode `proposal` or higher, `synthetic: true`
while the catalog says `implemented_synthetic`, and — once the manifest declares it — an
`object_type` the skill produces. Requests: a manifest field listing the object types each skill
produces (the platform reads it as `produces`; until then any valid ontology type is accepted),
and object types that match the consumers' `required_context` exactly.
A library `Ref` to a record in a section becomes `{ section_id: "records.<ObjectType>",
content_digest, path: "$[<index>]" }`.

## CR-10. Conformance

Run `packages/skill-conformance` against the platform-mode host before the bundle is registered:

```sh
pnpm --filter @ehf/skill-conformance conformance -- --base-url http://localhost:8090 --fixtures <dir>
```

The library supplies one fixture per skill from its existing synthetic examples (each already runs
through the executor and validates its result). The suite checks idempotency, pinning, authority,
unknown ≠ pass, injection, effects, recovery, determinism and tenant isolation (§11).

## Platform side (for reference)

Done: `skills:` gateway adapter, delegated envelopes, skill-bundle registry, conformance suite,
reference host, runtime mapping to SkillResult.v1 and journal events, the canonical record store,
the commit path for proposed records (including `CanonicalRecord`) and requested effects with
approval-held effects, release nodes and outbox routing (§6.2–6.3),
the KYB slice on the library's 29-step `synthetic-kyb.json`, and individual KYC on library skills
with the `policy` section (CR-4) and OPA gates between stages, and the CR-7 platform side: the
business-skill registry is the vendored library catalog, pinned by the shared manifest digest. Next: the new capability IDs in CR-8 with sandbox
connectors, compile-time dependency closure from the ingested manifests, and per-action
acknowledgement and reconciliation for outbox-routed external actions.

## Observed while building the KYB slice

The platform now runs the library's 29-step `synthetic-kyb.json` as `domains/archive/kyb-deterministic` (generated by
`scripts/sync-kyb-package.mjs` from a vendored snapshot). Findings that need library changes:

- **Manifest shape (CR-7, resolved).** The registry now ingests the catalog entries verbatim
  (`config/skill-library`), so the 29 manifests are registry entries and the KYB package's
  `manifestDigest` (sha256 of the canonical catalog entry) matches them; `bundleDigest` is
  `sha256:` + `bundle_code_hash` until the library publishes a lock.
- **Screening over provider search.** The screening skills expect a captured list
  (`WatchlistEntry` records), not a provider candidate search. A clean provider screen is stored
  as `NegativeSearchEvidence` and the skill returns NEEDS_EVIDENCE, never clear. Either the
  skills accept negative-search evidence with coverage, or the platform ingests lists.
- **Record types with no source.** `BeneficialOwner`, `VerificationRecord`, `RiskFactor`,
  `WorkflowDefinition`, `Finding` and `Control` have no connector source; several are outputs
  of earlier library skills. The platform's §6.2 commit path now commits `CanonicalRecord`
  proposals and the next skill reads them, but the catalog marks the producing skills
  `read_only` and their outputs are payload fields, not records (CR-2, CR-5, CR-9). Until the
  library changes that, a run still stops at `evidence.sufficiency.assess`.
- **Policy section (CR-4).** Resolved on the platform side (since library 0.2.0): each KYB skill
  node pins its `policy_context_fields` projection of the library's synthetic neutral policy pack
  (`domains/archive/kyb-deterministic/library/policy.synthetic-neutral.json`), and the context plane sends it as the
  `policy` section through the same resolver as KYC (below). A KYB case must be pinned to
  `policy.synthetic.neutral` with the pack's digest as its policy bundle digest.

## Observed while building the KYC slice

`domains/archive/kyc-v2-deterministic` now runs individual KYC (CDD onboarding) on library skills: a 22-step workflow
in the library's workflow format (`domains/archive/kyc-v2-deterministic/source/kyc-workflow.json`; the library has no
individual-KYC workflow), generated into a package by the same generator as KYB.

- **The policy section is now sent (CR-4).** For a skill node that declares a policy projection,
  the context plane sends `sections[]` id `policy`, kind `policy`, trust `TRUSTED_DATA`,
  `provenance_ref` `policy-snapshot:<case policy snapshot digest>`, whose `value` is exactly the
  manifest's `policy_context_fields`, taken from the policy the case is pinned to
  (`packages/context-plane/src/policy.ts`; for KYC the US KYC OPA bundle, for KYB the library's
  synthetic pack). Values are copied or derived from the policy at compile time; case-dependent
  values (today KYC's `review_interval_seconds`, per risk cohort) are computed by the policy
  engine at run time. The section is not sent, and the skill not called, when the case is pinned
  to another policy or bundle or any declared field does not resolve (NEEDS_EVIDENCE,
  `POLICY_UNRESOLVED`). The host should read policy only from this section.
- **Policy vocabulary.** An institution's policy (here the US KYC decision tables) does not
  speak the library's policy vocabulary. From the US bundle the platform can supply `version`,
  `jurisdiction`, `freshness_seconds`, `screening_threshold`, `customer_types`, `requirements`
  and (per cohort) `review_interval_seconds`; it cannot supply `risk_tiers`, `risk_weights`,
  `risk_model_version`, `risk_factor_maps`, `edd_triggers`, `verification_methods`,
  `document_types`, `recommendations` or `rules`, so `entity.identity.verify`,
  `document.classify`, the four risk skills, `edd.trigger.evaluate` and
  `decision.recommendation.generate` are refused today. Requests: document each policy field's
  meaning, type and unit; mark which fields a skill needs (`policy_context_fields` lists every
  field, so the platform must treat all as required); and say whether a skill may run without
  an optional one.
- **`permissions` is authorization, not policy.** Every manifest lists `permissions` as a policy
  field. The platform sends the skills the plan binds (`skill:<id>`, plus `effect:<mode>`), which
  is what it already authorised (KYB scopes it further to the grants that execution's own check
  reads); under CR-4 the host should take these from the principal.
- **Parameters from case context.** Library workflows bind parameters only from earlier step
  payloads, so `synthetic-kyb.json` hard-codes `name: "Acme"` and default facts
  (`identity_verified: true`, `tier: "LOW"`) that read like real facts. KYC binds `name` and
  `value` from the case subject (`skillContextBindings`, a platform overlay) and refuses to call
  a skill whose binding resolves to nothing (`requireBoundParameters`), instead of running on an
  authored default. Request: a `context.<selector>` binding form in the workflow format, and no
  fact-like defaults.
- **Recommendation vocabulary.** `decision.recommendation.generate` answers
  `REVIEW_FOR_ACCEPTANCE | ESCALATE | COLLECT_EVIDENCE`; the case's decision recommendation is
  `APPROVE | REVIEW | DECLINE`. The platform submits every library recommendation as `REVIEW`
  with `requiresHumanReview`, so the OPA disposition gate never auto-approves on it.
- **Human-gated first execution.** KYC routes a human-gated skill to its approval only when the
  execution completed (`lifecycle == COMPLETED_EXECUTION`); CR-6's `NEEDS_REVIEW` business status
  for the first execution should be confirmed so the platform can route on it instead.
- **Catalog hash.** Release 0.2.0 changed every skill's schemas and semver but kept
  `catalog.source_hash` (`666b0366…`) from 0.1.0, so the hash does not cover the manifests.
  The platform pins each manifest by its own digest; the library should say what `source_hash`
  covers.

## Questions for the library team

1. `bundle_digest`: `bundle_code_hash` alone, or a digest over the full wheel (code, instructions,
   schemas)? The platform prefers the full wheel.
2. ~~`manifest_digest`~~: settled (CR-7): the catalog entry digested with the library's own `digest()`.
3. Can `Executor` run with an injected repository, provider and profile per call, or does platform
   mode need a lightweight executor instance per execution?
4. ~~Which policy fields beyond the bootstrap set do the 222 skills consume?~~ Answered by 0.2.0's
   `policy_context_fields`; see [Status after library 0.2.0](#status-after-library-020).
