# Consolidated context specification

Status: design baseline with executable release 0.3.0 / context schema 2.0.0.

Implementation follow-through: [executable context matrix](../catalog/context-matrix.json), [runtime schemas](../schemas/runtime/ContextManifest.schema.json) and [release status](implementation-status.md). All 87 canonical data types have closed schemas, including the 27 formerly generic envelopes. Release 0.3.0 adds [twelve context products](../catalog/context-products.json), profile ceilings and the [EHF task/context boundary](ehf-integration.md). The [contract guide](schema-contracts.md) defines executable types, projections, extension rules and migration. The draft below retains broader design targets; illustrative requests below are not executable wire contracts.
Date: 2026-11-07.  
Scope: all 222 skills in the [canonical specification](../financial_crime_canonical_skills_spec_v1.md).  
Related: [implementation plan](skill-implementation-plan.md), [per-skill backlog](skill-design-backlog.md).

## 1. Purpose and governing rules

Provide a shared, typed, governed context layer that can serve deterministic functions, model-assisted skills, workflows and hosted agents. A context snapshot is a derived view over authoritative records, not a new system of record.

Start with jurisdiction-neutral object contracts, synthetic policies and local sources. Every fixture carries `synthetic: true` and source/policy scope so downstream consumers cannot mistake it for a real verification.

Required invariants: tenant isolation; authorized purpose and delegated actor; stable versioned references; valid-time and recorded-time selection; evidence lineage; explicit missingness and uncertainty; bounded graph/window retrieval; no mandatory data silently removed by token limits; no claims promoted to verified facts merely because they appear in a summary.

## 2. Three contracts rather than one giant context document

| Contract | Contents | Consumer |
| --- | --- | --- |
| Context requirements | Per-skill fields, selectors, optionality, sources, time/freshness, coverage and size constraints | Compiler and dependency planner |
| Context manifest | Exact authorized versions selected, source scope/gaps, policy/authorization references, hashes and allocation | Executor, audit and replay |
| Context payload/views | Typed objects and data handles for code; ranked source excerpts and compact facts for models | Skill implementation or agent |

Maintain one consolidated schema registry and one requirements vocabulary. Do not merge every skill's required data into every invocation. An agent profile establishes an upper bound; the skill gets the smallest view needed for the current call.

## 3. Inventory and normalization of catalog context types

The 20 default context lists reference **81 distinct names**. The table accounts for all 81 exactly once. These groups are design organization, not mandatory storage technologies or independent services.

| Context group | Catalog types | Domain-specific fields to define beyond the common envelope |
| --- | --- | --- |
| Identity and legal existence | Entity, IdentityIdentifier, Alias, Address, EntityCandidate, Identity | Entity kind; identifiers and issuing authority; original/normalized names and scripts; address components; candidate match features; verification criteria/status. |
| Customer relationship | Party, CustomerRelationship, Account, Product, ExpectedActivity, GeographyExposure, Counterparty | Entity/party relationship; role; account/product/channel; expected volumes/currencies/counterparties; geography basis and exposure period. |
| Ownership and association | Relationship, OwnershipInterest, ControlRight, OwnershipGraph, BeneficialOwner, OfficerRole, NetworkGraph | Directed edges; direct interests/voting rights; control basis; source/target; as-of interval; graph completeness; paths and calculation method; owner candidate/verified status. |
| Documents, registry and sources | Document, DocumentVersion, DocumentPage, Registration, RegistryRecord, Filing, License, SourceRecord | Artifact/version hashes; page/byte/character/bounding-box coordinates; extraction/translations; registry namespace/status; filing kind and authority; license validity. |
| Evidence and epistemic records | Evidence, Provenance, Assertion, ExtractedAssertion, Fact, Finding, Conflict, Hypothesis, TimelineEvent | Source links and spans; original/derived content; observation versus inference; verification method; contradictions and alternatives; temporal event basis. |
| Screening | WatchlistEntry, ScreeningHit, SanctionsRegime, PEPRelationship, AdverseMediaEvent | Source/list versions; applicable regimes; aliases/identifiers; candidate features; disposition basis; relationship degrees; media event attribution and deduplication. |
| Risk and EDD | RiskFactor, RiskAssessment, RiskModel, SourceOfFunds, SourceOfWealth | Factor inputs and contributions; model version; missing-factor behavior; tier recommendation; wealth/funds claims and corroboration. |
| Transactions and detection | Transaction, Payment, PaymentRail, Typology, DetectionRule, Alert | Amount/currency and settlement semantics; parties/accounts; event timestamps; window scope; rule/model version; contributing events; alert grouping and disposition. |
| Fraud and authentication | Device, Session, AuthenticationEvent, FraudSignal | Signal provenance/consent where relevant; pseudonymous identifiers; session links; event time; provider/model score meaning; supported modality and limitations. |
| Case and workflow | Case, Task, WorkflowDefinition, Checkpoint, SLA, Investigation, SkillExecution | State/revision; workflow/skill versions; task dependencies; execution attempts; checkpoint refs; deadlines; investigation questions; pending approvals. |
| Policy, authority and obligations | Policy, Requirement, Control, Obligation, Exception, Decision, Approval, Actor, Jurisdiction, RetentionRule | Effective jurisdiction/institution scope; requirement applicability; rule IDs; authority/roles; approved action/input hashes; exception scope/expiry; retention/legal hold. |
| Ongoing monitoring | MonitoringPlan, ReviewTrigger, Event | Trigger source and dedup key; schedule/calendar/timezone; evaluation window; review scope; watermark and next scheduled action. |
| Assurance and evaluation | AuditEvent, EvaluationCase, ExpectedOutcome, ModelVersion | Event chain and execution identity; fixture provenance; expected output/tolerances; evaluation split; model/config/artifact identifiers. |

Normalization decisions:

- `Identity` is a role-specific identity profile referencing an `Entity`, identifiers and authentication evidence, not a second independent real-world entity ID.
- `ExtractedAssertion` is a typed extraction form of `Assertion`, with mandatory source spans and extractor version. `Fact` requires a separate verification record and verification criteria.
- `OwnershipGraph` and `NetworkGraph` are versioned graph views over canonical nodes/edges, with scope and completeness metadata. They do not create duplicate entity records.
- `Filing` needs a discriminated kind for corporate-registry filings versus regulatory submissions; their authorization and confidentiality differ.
- `Event` is an envelope for typed business events; `AuditEvent` is an execution/security record; `TimelineEvent` is an evidence-backed investigative view. Preserve these distinctions.
- `Policy`, `WorkflowDefinition` and `ModelVersion` are versioned control-plane artifacts. `EvaluationCase` and `ExpectedOutcome` belong in evaluation context and are denied to normal production reasoning unless explicitly authorized.
- `Checkpoint` points to durable execution progress; its private engine state is not generally exposed to the model.

Additional contracts required by the source's prose, but absent from its 81-name union: `ContextRequirements`, `ContextManifest`, `NegativeSearchEvidence`, `UnresolvedQuestion`, `RiskIndicator`, `Recommendation`, `ProviderCoverage`, `SourceSnapshot`, `AuthorizationSnapshot`, `AgentProfile`, `ExecutionLock`, `ApprovalTask`, `EffectCommand` and `SubmissionReceipt`. Add these to the schema registry explicitly rather than treating catalog name counts as the entire ontology.

Skill behavior also exposes gaps in the domain-default lists. Proposed supplemental types include `TradeRecord`/`Invoice`/`Shipment` for `aml.trade_based.detect`, `ExchangeRateSnapshot` for currency-normalized analytics, `BusinessCalendar` for deadlines and schedules, `VerificationRecord` for fact/identity promotion, `DetectorAssessment` for modality-specific fraud results and `DatasetScope` for transaction/source completeness. Decide whether each becomes a standalone schema or a typed embedded record during field-level design. Do not implement these skills using fabricated inputs merely because their original domain lists omit the needed data.

## 4. Shared object and reference semantics

`CanonicalRef = {tenant_id, object_type, object_id, version_id, schema_version}`. A manifest must resolve mutable aliases such as "latest" to an exact version. Cross-tenant references fail admission. Public reference datasets still need an explicit authorized namespace/mapping rather than bypassing tenant checks.

Common persisted business-record fields:

| Category | Fields/semantics |
| --- | --- |
| Identity | `id`, `tenant_id`, `schema_version`, immutable `version_id`, predecessor/supersedes reference |
| Time | `valid_from`, `valid_to`, `observed_at`, `recorded_at`, capture time; nullable fields have explicit applicability rules |
| Provenance | `source_refs`, `provenance_ref`, content hash and derivation/method references |
| Governance | Access classification, purpose tags, residency/license restrictions, retention/legal hold metadata |
| Revision | Stable entity ID plus immutable versions; created/updated metadata for mutable heads, not in-place modification of evidence content |
| State of knowledge | Object-appropriate status, unresolved gaps and verification record; confidence only where defined and calibrated |

Use explicit schema profiles for configuration, execution records and derived views rather than fabricating meaningless source spans for every object. Every derived material claim must have real supporting evidence; an audit event can instead cite the execution that generated it.

Financial values use decimal strings with currency, units, precision and rounding policy. Keep original and converted amounts with rate/source/as-of metadata. Ownership interests distinguish direct, path and aggregated effective values; retain numerator/denominator or precision needed to reproduce calculations. Time intervals use documented boundaries, defaulting to half-open `[start, end)`; timestamps are UTC with original timezone/calendar where legally or operationally relevant.

## 5. Context request and manifest

The source's ContextEnvelope becomes a request plus an immutable resolved manifest. Proposed request fields:

```yaml
context_request_version: "1.0"
request_id: "..."
execution_id: "..."
tenant_id: "..."
case_ref: null                     # permitted before case.create
subject_refs: []
skill_ref: {id: "entity.resolve", version: "0.1.0"}
profile_ref: {id: "kyb-reviewer", version: "0.1.0"}
purpose: onboarding
actor_ref: "..."
delegation_ref: "..."
jurisdiction_scope: []            # explicit not-applicable/unknown/configured handling
policy_snapshot_ref: "..."
as_of_time: "..."                  # business effective-time cutoff
knowledge_cutoff: "..."            # recorded-time cutoff for historical replay
requirements_ref: "..."
requested_views: [structured, model]
limits:                           # values resolved from policy/profile, never unbounded
  max_objects: 100
  max_graph_depth: 3
  max_graph_edges: 500
  max_model_tokens: 12000
correlation_id: "..."
```

The limits are illustrative test settings, not production defaults. Actual budgets must be explicit and caller-adjustable only within authorization. Policy bootstrap may initially use a trusted tenant policy-binding reference; resolve it before reading business data. Do not require a business case or already-resolved policy output to bootstrap `case.create` or `decision.policy.resolve`.

The manifest records:

- Request and execution identities; skill/profile/workflow versions; requirements schema/version/hash.
- Actor/delegation and authorization decision reference; policy snapshot and applicable jurisdiction/requirement scope.
- Effective-time/recorded-time cutoffs; compiler and resolver versions; exact object/source/list/model versions and hashes.
- Selected fields, graph roots/depth/edges, query/window filters, watermarks, pagination/coverage and truncation boundaries.
- Required/optional completeness, missingness reasons, stale/conflicting records, denied sources and unresolved questions.
- Provider entitlements, coverage and residency constraints; negative search evidence and known limitations.
- Structured payload handles and content hashes; model excerpt allocation, redaction transformations and source spans.
- Canonical serialization/hash algorithm; manifest hash, creation time and replay-store references.

A hash is an integrity check, not sufficient replay data. Retain referenced immutable artifacts or authorized replay recordings according to retention/license policy. Record when replay is no longer possible. Exact model text reproduction is not guaranteed; replay can reconstruct the decision inputs, captured outputs and deterministic rule path.

## 6. Per-skill context requirement declaration

Each of the 222 skill packages must declare its own requirements. This example is deliberately partial:

```yaml
skill_id: ownership.interest.calculate
context_schema_version: "1.0"
required:
  - object_type: OwnershipInterest
    selector: authorized_graph_edges
    fields: [owner_ref, owned_ref, direct_interest, valid_from, valid_to, source_refs]
    min_count: 1
    temporal: effective_at_request_time
    source_policy_ref: ownership-evidence-policy
    freshness_policy_ref: ownership-freshness-policy
    on_missing: NEEDS_EVIDENCE
optional:
  - object_type: ControlRight
    selector: same_graph_scope
    fields: [controller_ref, controlled_ref, control_basis, source_refs]
    purpose: preserve_distinction_between_equity_and_control
coverage:
  require_explicit_graph_boundary: true
  require_unresolved_paths: true
outputs_context_types: [OwnershipGraph, Finding]
```

The full contract must additionally specify field types/nullability, role/purpose restrictions, source precedence, conflict behavior, max traversal/path counts, cycle policy, required calculation configuration, data sensitivity, model visibility and evidence depth. Zero ownership records can be a valid complete state for some entity types and an evidence gap for others; applicability must be explicit rather than globally assuming `min_count: 1`.

Generate a matrix with one row per skill/field requirement: canonical skill/version, object/field path, selector, cardinality, applicability, mandatory/optional, temporal rule, freshness policy, source capability, classification, fallback, missing/stale behavior, tests and owner. Reverse-index it by source/object/field so source schema changes identify every affected skill. Domain default lists in the original catalog are input to this analysis, not final mandatory requirements.

## 7. Compilation and enrichment pipeline

1. Validate the invocation, profile, schema versions and bootstrap tenant policy binding.
2. Authenticate actor/delegation and calculate effective scope. Deny before retrieval where possible; recheck at storage boundaries.
3. Expand selected skill requirements into a retrieval plan. Resolve object/field dependencies without recursively invoking the compiler business skill.
4. Fetch exact authorized versions from local stores/source adapters. Apply valid-time and knowledge-cutoff semantics. Capture source responses and provider coverage.
5. Verify integrity, freshness, temporal alignment and source authority. Preserve conflicts; apply documented precedence only where policy allows it.
6. Normalize missingness and negative coverage. Fail or return incomplete context with explicit downstream status when mandatory requirements are unsatisfied.
7. Build bounded graph/transaction views. Report actual completeness and limits. Large computations receive paginated/streamed dataset handles plus scope/watermark metadata.
8. Create the minimal structured view; derive the separate model view with authorized fields, evidence excerpts and redaction. Retrieved content stays untrusted data.
9. Check model token allocation including profile/skill instructions and tool schemas. Preserve mandatory contradictions and control evidence; fail or request a different strategy if they do not fit.
10. Persist the immutable manifest and payload hashes; emit audit events. The executor checks compatibility and manifest validity before invocation.

A skill requests enrichment through `ContextQuery` specifying missing fields, reason, subjects/time window and needed capability. The resolver repeats policy/entitlement checks and returns a new manifest revision. No agent can widen its graph scope or provider access merely by asking for more context. Cache keys include tenant, actor/delegation scope, purpose, policy, requirements, source versions, time cutoffs and redaction profile; authorization is rechecked on reads.

## 8. Missingness, freshness, coverage and conflicts

Distinguish `PRESENT`, `UNKNOWN`, `NOT_COLLECTED`, `NOT_APPLICABLE`, `REDACTED`, `ACCESS_DENIED`, `STALE`, `SOURCE_UNAVAILABLE` and `CONFLICTED`. Empty arrays mean zero results only when scope/completeness metadata establishes a completed query. Do not silently convert errors to empty results.

Missing mandatory evidence maps to `NEEDS_EVIDENCE`; denied or unresolved policy may map to `BLOCKED`; conflicting material evidence may require `NEEDS_REVIEW`. A partial payload remains marked incomplete. Rule outcomes independently distinguish `PASS`, `FAIL`, `UNKNOWN`, `NOT_APPLICABLE`; missing context cannot yield `PASS`.

Freshness is field/source/task-specific. Record source effective date, retrieval time, list/model version, maximum allowed age and invalidating events. Historical runs use their historical freshness reference; a newly retrieved record does not make an old underlying list current. Live actions revalidate applicable policy, authorization and freshness before commit.

`NegativeSearchEvidence` includes provider/index/list and version, query and normalization, exact subjects/identifiers, query time, covered jurisdictions/dates/content, entitlement limitations, filters, pagination completeness, errors and expiry. No hit in a partial search is not universal clearance.

Conflicts record incompatible assertions, supporting sources, effective times, materiality, precedence rule if any, reviewer/resolution basis and remaining uncertainty. Resolution supersedes a claim or attaches a disposition without rewriting the source evidence.

## 9. Domain context supplements and source contracts

| Consumers | Supplement beyond shared objects | Source contract / synthetic fixture requirement |
| --- | --- | --- |
| Entity, party, registry | Issuer namespaces, identifier rules, alias history, relationship roles, registry status scope | Synthetic registry/customer/document records with collisions, supersession and unavailable authorities |
| Ownership | Graph boundary/completeness, cycles, share classes/voting rights, trust/nominee/control evidence, aggregation policy | Multi-path/circular/opaque graphs with exact expected math and unresolved paths |
| Document | Binary/version/page hashes, OCR geometry, extraction schema, language, translation lineage, authenticity indicators | Locally generated documents plus captured parser/OCR responses; genuine source spans |
| Screening | Applicable regimes, exact lists/as-of versions, match policy, prior dispositions, provider coverage | Synthetic watchlists/media with identity collisions, stale lists, negative scope and contradictory evidence |
| Risk and EDD | Model/factor/rule versions, override authority, declared and verified funds/wealth, expected activity | Synthetic risk factor packs with missing inputs and explicit contribution calculations |
| Transactions, network, AML | Authorized data windows, event/ingestion times, currency conversions, late/duplicate records, completeness and baselines | Ledger/event fixtures with known typology positives, benign alternatives, watermarks and reconciliation |
| Alert, investigation | Hypotheses, chronology, contradictory/exculpatory evidence, prior findings, collection permissions | Multi-source case fixtures; unsupported assertions and alternative explanations |
| Fraud | Consented/permitted device/session/biometric signal scope, model calibration, provider limitations | Synthetic signal responses only; no inference that local fake responses validate a real detector |
| Case, decision | Revision, tasks/dependencies, policy applicability, actor authority, pending approvals and expiry | Synthetic roles/policies, denied transitions, changed-input approvals and duplicate requests |
| Monitoring, regulatory | Event watermarks, durable schedules, jurisdictional calendars, obligation version, filing schemas/receipts | Synthetic calendars, obligations, local regulator endpoint and ambiguous acknowledgment scenarios |
| Evidence, quality | Verification criteria, chain of derivation, claim-source matrix, retention/holds and evaluation access | Immutable source fixtures, corrupted hashes, unsupported claims and legal-hold conflicts |

Each source adapter declares canonical types/fields supplied, permitted purposes, jurisdiction/time coverage, freshness SLA, pagination semantics, authorization mode, residency/license terms, capture/retention behavior, error taxonomy and health. Provider-specific fields remain in captured source records and mapped extensions; they do not silently alter canonical semantics.

## 10. Persistence, synchronization and lifecycle

Use repositories for canonical state, an artifact store for immutable source/document versions, and an append-only audit/effect log. Graph and vector indexes are derived and carry source-version/watermark metadata. Their storage products remain an implementation choice. Local test stores should exercise the same interfaces and revision checks as production stores.

Skill computations produce proposed typed records and evidence links. The executor validates and persists outputs under a transaction/revision boundary, then publishes references and events. Business state transitions and external effects require separate command authority. Parallel branches append independent results and join against explicit case revisions; do not silently overwrite one another.

Context snapshots expire or are invalidated by source updates, policy changes, access revocation or case revision changes according to the action. Historical manifests remain historical records; action authorization is current. Human resume compares approved hashes/revisions and recompiles or requests renewed approval when necessary.

Retention applies to source artifacts, derived views, caches and replay bundles. Legal holds block deletion. An append-only audit history does not require retaining prohibited personal content forever: record authorized deletion/tombstones while preserving permissible integrity metadata. Exact retention rules are policy inputs, not a universal constant.

## 11. Context implementation and acceptance sequence

1. Write JSON Schemas/typed models for references, base object profiles, assertions/facts/evidence, policy/authorization, request/manifest and requirement declarations.
2. Produce the 222-skill field coverage matrix in tandem with approved design cards; keep unresolved fields explicit until domain design resolves them.
3. Implement local repositories and fixture providers, then bootstrap scope checks, bitemporal selection and integrity validation.
4. Implement structured hydration, bounded graph/window views, completeness/missingness and deterministic manifest hashing.
5. Add model view ranking/redaction/token allocation and governed enrichment.
6. Add provenance/replay, cache invalidation, approval resume checks and runtime integration.

Acceptance cases: cross-tenant denial; field-level denial; unknown versus empty; stale watchlist; historical reconstruction with later-recorded corrections; graph truncation/cycles; partial provider pagination; conflicting ownership; prompt injection in source text; mandatory evidence exceeding token limits; revoked approval after context change; deterministic hash under stable content; cache isolation; retained replay after restart; unavailable replay after authorized deletion; large transaction aggregation without model truncation.

Completion means the context required by each skill is declared, validated, traceable to a permitted source and exercised by fixtures. This draft consolidates the design and inventories the object vocabulary; it does not claim that all 222 field-level contracts have already been authored.
