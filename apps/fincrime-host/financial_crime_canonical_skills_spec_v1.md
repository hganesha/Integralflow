# Financial Crime Canonical Skills & Context Plane — Detailed Specification

**Status:** Architecture baseline / proposed design, not implemented or regulator-approved  
**Version:** 1.0.0 · **Date:** 2026-11-07  
**Coverage:** KYC, KYB, CDD, EDD, AML, sanctions, PEP, adverse media, transaction monitoring, fraud, investigations, regulatory reporting, ongoing reviews.  
**Intended use:** Portable specification and Work-session implementation handoff.

## 1. Executive intent and non-goals

Build a provider-agnostic financial crime capability layer in which a canonical business skill is reusable across agents, deterministic workflows, analyst interfaces, and multiple regulated institutions. The catalog contains **222 skills in 20 domains**. These are logical business contracts, not 222 separate LLM agents, microservices, or endpoints. A composite skill may call other skills and atomic capabilities.

**Non-goals:** automating final legally consequential judgments without appropriate authority; assuming a single jurisdiction; assuming a single KYC workflow; treating unverified inference as established fact; binding skill semantics to LangGraph; interpreting vendor API payloads as canonical truth.

### Design invariants
1. Skill != agent != tool != workflow. Skills describe business outcomes; tools/capabilities implement them; workflows compose them; agents may choose/invoke them under constraints.
2. Canonical inputs and outputs; provider-specific adapters at the edge.
3. Separate source records, assertions, verified facts, findings, hypotheses, risk indicators, recommendations and authorized decisions.
4. Probabilistic interpretation inside deterministic policy and authorization boundaries.
5. Every result carries provenance, policy/version, time and execution identity.
6. Ambiguity, unknowns, negative search scope and conflicting evidence are first-class.
7. Explicit jurisdiction, customer type, product, entity type and risk tier determine mandatory requirements.
8. Read before write: material mutations and external submissions require authorization, idempotency and auditability.
9. Skills are versioned and independently evaluated; providers may be changed without altering the skill contract.
10. Case store is authoritative for state; model context is ephemeral, least-privilege and task-scoped.

## 2. Logical architecture

`Business workflow → LangGraph or deterministic orchestrator → skill registry/composition planner → policy/context compiler → capability resolver → provider adapters / code / model / human gate → canonical result validator → event/evidence/case store`.

**Control plane:** tenant policies, entitlements, purpose-of-use, jurisdiction packs, schemas, skill registry, provider routing, evaluation profiles, human authorization.  
**Data/context plane:** canonical entity/party/ownership/transaction graph; document JSON and source spans; evidence store; vector indexes; negative knowledge registry; temporal facts; case state; policy snapshots.  
**Execution plane:** LangGraph checkpointing, interrupts, bounded retries, concurrency limits, tool router, durable outbox, asynchronous workers, trace capture.  
**Assurance plane:** deterministic rule gates, data validation, provenance verification, human approvals, replay, golden-case evaluation and audit logs.

The context compiler hydrates the smallest authorized snapshot for a skill; the skill does not directly roam all connected systems. A skill may request missing context through a governed resolver, with the request and result logged.

## 3. Canonical ontology and context plane

### 3.1 Entity and party semantics
- **Entity**: stable real-world individual, legal person, trust, fund or other organization; may have multiple identifiers and names.
- **Party**: an entity's role in a bank/customer relationship, account, case, transaction or counterparty context; do not conflate with Entity.
- **IdentityIdentifier / Alias / Address / Registration / OfficerRole**: independently sourced, effective-dated attributes.
- **Relationship / OwnershipInterest / ControlRight / BeneficialOwner**: typed, directional, effective-dated graph edges; record percentages, voting rights, control mechanisms, jurisdictions and source evidence.
- **Account / Product / CustomerRelationship / ExpectedActivity / Transaction / Payment / Counterparty**: operational relationship and behavioral model.
- **Document / DocumentVersion / DocumentPage / SourceRecord / Evidence / Provenance**: immutable source artifacts, location spans, hash, capture time, source authority, license, freshness and access tags.
- **Assertion / Fact / Finding / Hypothesis / RiskIndicator / Conflict / UnresolvedQuestion**: distinct epistemic types. Facts require defined verification criteria; findings can be uncertain; hypotheses are not conclusions.
- **ScreeningHit / WatchlistEntry / AdverseMediaEvent / PEPRelationship / SanctionsRegime**: screening and sanctions-specific concepts.
- **RiskFactor / RiskModel / RiskAssessment / Typology / DetectionRule / Alert / Investigation / TimelineEvent**: analytical and investigative state.
- **Policy / Requirement / Control / Obligation / Exception / Decision / Approval / Filing**: governed obligations and disposition.
- **Case / Task / WorkflowDefinition / SkillExecution / ToolInvocation / Checkpoint / AuditEvent / MonitoringPlan / ReviewTrigger / SLA**: workflow and execution records.

### 3.2 Required common fields
All persisted objects: `id`, `tenant_id`, `schema_version`, `created_at`, `updated_at`, `source_refs`, `access_classification`, `purpose_tags`, `valid_from`, `valid_to` (when relevant), `observed_at`, `recorded_at`, `supersedes_ref`, `provenance_ref`. Financial quantities include currency, units and rounding policy; ownership edges include direct/effective percentages and control basis. Keep both valid-time and recorded-time for retrospective reconstruction.

### 3.3 Context hydration manifest
Every skill receives `ContextEnvelope {tenant_id, case_id, subject_refs, jurisdiction, purpose, actor, policy_snapshot_ref, as_of_time, object_refs, evidence_refs, graph_scope, freshness_requirements, permitted_providers, redaction_profile, token_budget, correlation_id}`. The compiler must check entitlement, consent/legal basis where applicable, data minimization, provider terms, stale-data rules, temporal alignment, source precedence and negative knowledge. Include context hash for replay. A missing object is not silently represented as an empty value.

### 3.4 Evidence and epistemic status
Evidence lifecycle: `OBSERVED → EXTRACTED_ASSERTION → VERIFIED_FACT` or `DISPUTED/UNVERIFIED`; analytical `FINDING` references one or more assertions/facts and method; `RECOMMENDATION` references findings and policy; `DECISION` requires authorized actor/control execution. Negative search evidence records query, provider, coverage, date, identifiers and limitations. Every derived claim must be traceable to document spans, API responses, rules or calculations.

## 4. Skill contract standard

Required definition fields: `id`, `semver`, `description`, `business_outcome`, `input_schema`, `output_schema`, `required_context`, `optional_context`, `context_freshness`, `preconditions`, `dependencies`, `composition_type`, `execution_mode`, `permitted_capabilities`, `provider_policy`, `policy_gates`, `authorization`, `idempotency`, `timeout`, `retry_policy`, `human_interrupt_conditions`, `failure_codes`, `evidence_requirements`, `audit_fields`, `evaluation_profile`, `cost_latency_budget`, `data_classification`, `jurisdiction_scope`, `owner`, `deprecation_policy`.

### 4.1 Shared input schema
```yaml
SkillInput.v1:
  execution_id: uuid
  tenant_id: string
  case_id: string|null
  subject_refs: [CanonicalRef]
  parameters: object  # skill-specific validated schema
  context_manifest_ref: string
  policy_snapshot_ref: string
  as_of_time: datetime
  purpose: enum[onboarding,review,monitoring,investigation,fraud,reporting]
  actor_ref: string
  idempotency_key: string
  trace_id: string
```

### 4.2 Shared output schema
```yaml
SkillResult.v1:
  execution_id: uuid
  skill_id: string
  skill_version: semver
  status: enum[COMPLETED,PARTIAL,NEEDS_EVIDENCE,NEEDS_REVIEW,BLOCKED,FAILED]
  result_refs: [CanonicalRef]
  evidence_refs: [EvidenceRef]
  finding_refs: [FindingRef]
  unresolved_items: [{code: string, subject_ref: string, explanation: string}]
  policy_snapshot_ref: string
  context_hash: string
  trace_ref: string
  metrics: {duration_ms: integer, provider_calls: integer, cost_estimate: number}
  error: {code: string, retryable: boolean}|null
```
`COMPLETED` means execution completed, not compliance approval. Missing mandatory evidence must not yield PASS. `BLOCKED` is distinct from negative findings.

### 4.3 Standard errors and controls
Errors: `INPUT_INVALID`, `CONTEXT_MISSING`, `CONTEXT_STALE`, `ACCESS_DENIED`, `POLICY_UNRESOLVED`, `SOURCE_UNAVAILABLE`, `SOURCE_CONFLICT`, `LOW_CONFIDENCE`, `EVIDENCE_INSUFFICIENT`, `HUMAN_REVIEW_REQUIRED`, `CONTROL_FAILED`, `RATE_LIMITED`, `TIMEOUT`, `INTEGRITY_FAILURE`, `EXTERNAL_ACTION_UNCONFIRMED`. Retry only transient errors with bounded exponential backoff; never retry non-idempotent external writes blindly. Use durable outbox and confirmation reconciliation for filing/notifications.

### 4.4 Evaluation by type
Entity resolution: pairwise precision/recall, false merges, calibration. Ownership: path completeness, effective percentage, control rule accuracy. Document: field-level precision/recall, source-span validity. Screening: recall at defined false-positive burden, list freshness, disposition accuracy. Risk: score reproducibility, calibration, stability and fairness reviews. AML/fraud: precision/recall, detection latency, drift and analyst burden. Narrative: citation coverage, contradiction rate and unsupported claims. Policy: zero unauthorized approvals, deterministic replay and coverage. All: latency, cost, freshness, authorization, provenance and recovery tests.

## 5. Complete 222-skill registry

Each definition below includes business outcome, minimum context, input/output specialization, execution type, evidence requirement, dependencies/controls, and acceptance tests. These are logical defaults; regulated deployments must bind jurisdiction-specific rules, source SLAs and owners.


### 01. `entity.*` — 12 skills

**Default context objects:** Entity, IdentityIdentifier, Alias, Address, EntityCandidate, SourceRecord, Evidence, Policy. **Default execution mode:** hybrid.

#### `entity.resolve`
- **Purpose:** Resolve records to a stable canonical real-world entity.
- **Inputs:** subject canonical references, as-of timestamp, purpose and policy snapshot. `SkillInput.v1` envelope required.
- **Required context:** Entity, IdentityIdentifier, Alias, Address, EntityCandidate, SourceRecord, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** typed canonical result and evidence-backed Finding/Status; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** hybrid; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `entity.match`
- **Purpose:** Score candidate record equivalence.
- **Inputs:** subject canonical references, as-of timestamp, purpose and policy snapshot. `SkillInput.v1` envelope required.
- **Required context:** Entity, IdentityIdentifier, Alias, Address, EntityCandidate, SourceRecord, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** typed canonical result and evidence-backed Finding/Status; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** hybrid; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `entity.deduplicate`
- **Purpose:** Detect and consolidate duplicate entity records.
- **Inputs:** subject canonical references, as-of timestamp, purpose and policy snapshot. `SkillInput.v1` envelope required.
- **Required context:** Entity, IdentityIdentifier, Alias, Address, EntityCandidate, SourceRecord, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** typed canonical result and evidence-backed Finding/Status; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** hybrid; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `entity.disambiguate`
- **Purpose:** Resolve ambiguous identity candidates.
- **Inputs:** subject canonical references, as-of timestamp, purpose and policy snapshot. `SkillInput.v1` envelope required.
- **Required context:** Entity, IdentityIdentifier, Alias, Address, EntityCandidate, SourceRecord, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** typed canonical result and evidence-backed Finding/Status; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** hybrid; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `entity.classify`
- **Purpose:** Determine legal entity/person/trust/fund type.
- **Inputs:** subject canonical references, as-of timestamp, purpose and policy snapshot. `SkillInput.v1` envelope required.
- **Required context:** Entity, IdentityIdentifier, Alias, Address, EntityCandidate, SourceRecord, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** typed canonical result and evidence-backed Finding/Status; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** hybrid; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `entity.identifiers.validate`
- **Purpose:** Validate identity and registration identifiers.
- **Inputs:** subject canonical references, as-of timestamp, purpose and policy snapshot. `SkillInput.v1` envelope required.
- **Required context:** Entity, IdentityIdentifier, Alias, Address, EntityCandidate, SourceRecord, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** typed canonical result and evidence-backed Finding/Status; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** deterministic; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `entity.alias.resolve`
- **Purpose:** Normalize alternate names and transliterations.
- **Inputs:** subject canonical references, as-of timestamp, purpose and policy snapshot. `SkillInput.v1` envelope required.
- **Required context:** Entity, IdentityIdentifier, Alias, Address, EntityCandidate, SourceRecord, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** typed canonical result and evidence-backed Finding/Status; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** hybrid; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `entity.address.normalize`
- **Purpose:** Normalize and validate addresses.
- **Inputs:** subject canonical references, as-of timestamp, purpose and policy snapshot. `SkillInput.v1` envelope required.
- **Required context:** Entity, IdentityIdentifier, Alias, Address, EntityCandidate, SourceRecord, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** typed canonical result and evidence-backed Finding/Status; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** deterministic; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `entity.identity.verify`
- **Purpose:** Verify identity with authoritative evidence.
- **Inputs:** subject canonical references, as-of timestamp, purpose and policy snapshot. `SkillInput.v1` envelope required.
- **Required context:** Entity, IdentityIdentifier, Alias, Address, EntityCandidate, SourceRecord, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** typed canonical result and evidence-backed Finding/Status; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** deterministic; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `entity.relationship.resolve`
- **Purpose:** Resolve relationships between entities.
- **Inputs:** subject canonical references, as-of timestamp, purpose and policy snapshot. `SkillInput.v1` envelope required.
- **Required context:** Entity, IdentityIdentifier, Alias, Address, EntityCandidate, SourceRecord, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** typed canonical result and evidence-backed Finding/Status; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** hybrid; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `entity.history.reconstruct`
- **Purpose:** Reconstruct temporal identity changes.
- **Inputs:** subject canonical references, as-of timestamp, purpose and policy snapshot. `SkillInput.v1` envelope required.
- **Required context:** Entity, IdentityIdentifier, Alias, Address, EntityCandidate, SourceRecord, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** typed canonical result and evidence-backed Finding/Status; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** hybrid; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `entity.confidence.assess`
- **Purpose:** Assess entity resolution confidence.
- **Inputs:** subject canonical references, as-of timestamp, purpose and policy snapshot. `SkillInput.v1` envelope required.
- **Required context:** Entity, IdentityIdentifier, Alias, Address, EntityCandidate, SourceRecord, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** typed canonical result and evidence-backed Finding/Status; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** hybrid; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.


### 02. `party.*` — 10 skills

**Default context objects:** Party, Entity, CustomerRelationship, Account, Product, ExpectedActivity, GeographyExposure, Policy. **Default execution mode:** hybrid.

#### `party.profile.build`
- **Purpose:** Assemble party/customer 360.
- **Inputs:** subject canonical references, as-of timestamp, purpose and policy snapshot. `SkillInput.v1` envelope required.
- **Required context:** Party, Entity, CustomerRelationship, Account, Product, ExpectedActivity, GeographyExposure, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** typed canonical result and evidence-backed Finding/Status; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** hybrid; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `party.profile.refresh`
- **Purpose:** Refresh stale party information.
- **Inputs:** subject canonical references, as-of timestamp, purpose and policy snapshot. `SkillInput.v1` envelope required.
- **Required context:** Party, Entity, CustomerRelationship, Account, Product, ExpectedActivity, GeographyExposure, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** typed canonical result and evidence-backed Finding/Status; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** hybrid; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `party.type.classify`
- **Purpose:** Classify customer type.
- **Inputs:** subject canonical references, as-of timestamp, purpose and policy snapshot. `SkillInput.v1` envelope required.
- **Required context:** Party, Entity, CustomerRelationship, Account, Product, ExpectedActivity, GeographyExposure, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** typed canonical result and evidence-backed Finding/Status; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** hybrid; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `party.role.resolve`
- **Purpose:** Identify signatories directors and related roles.
- **Inputs:** subject canonical references, as-of timestamp, purpose and policy snapshot. `SkillInput.v1` envelope required.
- **Required context:** Party, Entity, CustomerRelationship, Account, Product, ExpectedActivity, GeographyExposure, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** typed canonical result and evidence-backed Finding/Status; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** hybrid; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `party.activity.profile`
- **Purpose:** Establish expected business activity.
- **Inputs:** subject canonical references, as-of timestamp, purpose and policy snapshot. `SkillInput.v1` envelope required.
- **Required context:** Party, Entity, CustomerRelationship, Account, Product, ExpectedActivity, GeographyExposure, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** typed canonical result and evidence-backed Finding/Status; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** hybrid; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `party.industry.classify`
- **Purpose:** Classify industry codes.
- **Inputs:** subject canonical references, as-of timestamp, purpose and policy snapshot. `SkillInput.v1` envelope required.
- **Required context:** Party, Entity, CustomerRelationship, Account, Product, ExpectedActivity, GeographyExposure, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** typed canonical result and evidence-backed Finding/Status; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** hybrid; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `party.geography.profile`
- **Purpose:** Map domicile and geographic exposures.
- **Inputs:** subject canonical references, as-of timestamp, purpose and policy snapshot. `SkillInput.v1` envelope required.
- **Required context:** Party, Entity, CustomerRelationship, Account, Product, ExpectedActivity, GeographyExposure, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** typed canonical result and evidence-backed Finding/Status; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** hybrid; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `party.product.profile`
- **Purpose:** Identify products and channels.
- **Inputs:** subject canonical references, as-of timestamp, purpose and policy snapshot. `SkillInput.v1` envelope required.
- **Required context:** Party, Entity, CustomerRelationship, Account, Product, ExpectedActivity, GeographyExposure, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** typed canonical result and evidence-backed Finding/Status; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** hybrid; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `party.expected_behavior.model`
- **Purpose:** Establish expected transaction behavior.
- **Inputs:** subject canonical references, as-of timestamp, purpose and policy snapshot. `SkillInput.v1` envelope required.
- **Required context:** Party, Entity, CustomerRelationship, Account, Product, ExpectedActivity, GeographyExposure, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** typed canonical result and evidence-backed Finding/Status; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** hybrid; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `party.profile.completeness`
- **Purpose:** Assess mandatory profile coverage.
- **Inputs:** subject canonical references, as-of timestamp, purpose and policy snapshot. `SkillInput.v1` envelope required.
- **Required context:** Party, Entity, CustomerRelationship, Account, Product, ExpectedActivity, GeographyExposure, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** typed canonical result and evidence-backed Finding/Status; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** hybrid; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.


### 03. `ownership.*` — 12 skills

**Default context objects:** Entity, OwnershipInterest, ControlRight, Relationship, OwnershipGraph, BeneficialOwner, Evidence, Policy. **Default execution mode:** hybrid.

#### `ownership.graph.build`
- **Purpose:** Construct ownership and control graph.
- **Inputs:** subject entity/ownership graph scope, as-of date, jurisdictional threshold and control policy. `SkillInput.v1` envelope required.
- **Required context:** Entity, OwnershipInterest, ControlRight, Relationship, OwnershipGraph, BeneficialOwner, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** OwnershipGraph/BeneficialOwnershipFinding and unresolved paths; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** hybrid; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** Evaluate all relevant ownership paths, cycles and non-equity control; unknown paths remain unresolved.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `ownership.graph.expand`
- **Purpose:** Traverse direct and indirect ownership.
- **Inputs:** subject entity/ownership graph scope, as-of date, jurisdictional threshold and control policy. `SkillInput.v1` envelope required.
- **Required context:** Entity, OwnershipInterest, ControlRight, Relationship, OwnershipGraph, BeneficialOwner, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** OwnershipGraph/BeneficialOwnershipFinding and unresolved paths; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** hybrid; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** Evaluate all relevant ownership paths, cycles and non-equity control; unknown paths remain unresolved.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `ownership.interest.calculate`
- **Purpose:** Compute effective ownership interests.
- **Inputs:** subject entity/ownership graph scope, as-of date, jurisdictional threshold and control policy. `SkillInput.v1` envelope required.
- **Required context:** Entity, OwnershipInterest, ControlRight, Relationship, OwnershipGraph, BeneficialOwner, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** OwnershipGraph/BeneficialOwnershipFinding and unresolved paths; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** deterministic; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** Evaluate all relevant ownership paths, cycles and non-equity control; unknown paths remain unresolved.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `ownership.control.resolve`
- **Purpose:** Resolve non-equity control rights.
- **Inputs:** subject entity/ownership graph scope, as-of date, jurisdictional threshold and control policy. `SkillInput.v1` envelope required.
- **Required context:** Entity, OwnershipInterest, ControlRight, Relationship, OwnershipGraph, BeneficialOwner, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** OwnershipGraph/BeneficialOwnershipFinding and unresolved paths; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** hybrid; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** Evaluate all relevant ownership paths, cycles and non-equity control; unknown paths remain unresolved.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `ownership.ubo.resolve`
- **Purpose:** Identify ultimate beneficial owners.
- **Inputs:** subject entity/ownership graph scope, as-of date, jurisdictional threshold and control policy. `SkillInput.v1` envelope required.
- **Required context:** Entity, OwnershipInterest, ControlRight, Relationship, OwnershipGraph, BeneficialOwner, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** OwnershipGraph/BeneficialOwnershipFinding and unresolved paths; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** hybrid; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** Evaluate all relevant ownership paths, cycles and non-equity control; unknown paths remain unresolved.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `ownership.ubo.verify`
- **Purpose:** Verify identified beneficial owners.
- **Inputs:** subject entity/ownership graph scope, as-of date, jurisdictional threshold and control policy. `SkillInput.v1` envelope required.
- **Required context:** Entity, OwnershipInterest, ControlRight, Relationship, OwnershipGraph, BeneficialOwner, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** OwnershipGraph/BeneficialOwnershipFinding and unresolved paths; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** deterministic; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** Evaluate all relevant ownership paths, cycles and non-equity control; unknown paths remain unresolved.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `ownership.threshold.evaluate`
- **Purpose:** Apply jurisdiction-specific ownership thresholds.
- **Inputs:** subject entity/ownership graph scope, as-of date, jurisdictional threshold and control policy. `SkillInput.v1` envelope required.
- **Required context:** Entity, OwnershipInterest, ControlRight, Relationship, OwnershipGraph, BeneficialOwner, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** OwnershipGraph/BeneficialOwnershipFinding and unresolved paths; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** deterministic; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** Evaluate all relevant ownership paths, cycles and non-equity control; unknown paths remain unresolved.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `ownership.nominee.detect`
- **Purpose:** Identify nominee and proxy arrangements.
- **Inputs:** subject entity/ownership graph scope, as-of date, jurisdictional threshold and control policy. `SkillInput.v1` envelope required.
- **Required context:** Entity, OwnershipInterest, ControlRight, Relationship, OwnershipGraph, BeneficialOwner, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** OwnershipGraph/BeneficialOwnershipFinding and unresolved paths; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** hybrid; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** Evaluate all relevant ownership paths, cycles and non-equity control; unknown paths remain unresolved.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `ownership.circular.detect`
- **Purpose:** Detect circular ownership.
- **Inputs:** subject entity/ownership graph scope, as-of date, jurisdictional threshold and control policy. `SkillInput.v1` envelope required.
- **Required context:** Entity, OwnershipInterest, ControlRight, Relationship, OwnershipGraph, BeneficialOwner, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** OwnershipGraph/BeneficialOwnershipFinding and unresolved paths; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** hybrid; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** Evaluate all relevant ownership paths, cycles and non-equity control; unknown paths remain unresolved.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `ownership.structure.complexity`
- **Purpose:** Assess opacity and structural complexity.
- **Inputs:** subject entity/ownership graph scope, as-of date, jurisdictional threshold and control policy. `SkillInput.v1` envelope required.
- **Required context:** Entity, OwnershipInterest, ControlRight, Relationship, OwnershipGraph, BeneficialOwner, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** OwnershipGraph/BeneficialOwnershipFinding and unresolved paths; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** hybrid; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** Evaluate all relevant ownership paths, cycles and non-equity control; unknown paths remain unresolved.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `ownership.discrepancy.detect`
- **Purpose:** Compare declared versus discovered ownership.
- **Inputs:** subject entity/ownership graph scope, as-of date, jurisdictional threshold and control policy. `SkillInput.v1` envelope required.
- **Required context:** Entity, OwnershipInterest, ControlRight, Relationship, OwnershipGraph, BeneficialOwner, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** OwnershipGraph/BeneficialOwnershipFinding and unresolved paths; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** hybrid; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** Evaluate all relevant ownership paths, cycles and non-equity control; unknown paths remain unresolved.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `ownership.history.compare`
- **Purpose:** Identify ownership changes over time.
- **Inputs:** subject entity/ownership graph scope, as-of date, jurisdictional threshold and control policy. `SkillInput.v1` envelope required.
- **Required context:** Entity, OwnershipInterest, ControlRight, Relationship, OwnershipGraph, BeneficialOwner, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** OwnershipGraph/BeneficialOwnershipFinding and unresolved paths; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** hybrid; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** Evaluate all relevant ownership paths, cycles and non-equity control; unknown paths remain unresolved.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.


### 04. `document.*` — 12 skills

**Default context objects:** Document, DocumentVersion, DocumentPage, ExtractedAssertion, Evidence, Provenance, Policy. **Default execution mode:** model-assisted.

#### `document.classify`
- **Purpose:** Classify document type.
- **Inputs:** document/version references, target extraction schema, language and policy. `SkillInput.v1` envelope required.
- **Required context:** Document, DocumentVersion, DocumentPage, ExtractedAssertion, Evidence, Provenance, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** ExtractedAssertion/DocumentFinding with page-span references; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** model-assisted; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `document.parse`
- **Purpose:** Extract structured document content.
- **Inputs:** document/version references, target extraction schema, language and policy. `SkillInput.v1` envelope required.
- **Required context:** Document, DocumentVersion, DocumentPage, ExtractedAssertion, Evidence, Provenance, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** ExtractedAssertion/DocumentFinding with page-span references; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** model-assisted; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `document.fields.extract`
- **Purpose:** Extract canonical fields.
- **Inputs:** document/version references, target extraction schema, language and policy. `SkillInput.v1` envelope required.
- **Required context:** Document, DocumentVersion, DocumentPage, ExtractedAssertion, Evidence, Provenance, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** ExtractedAssertion/DocumentFinding with page-span references; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** model-assisted; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `document.entities.extract`
- **Purpose:** Extract named entities.
- **Inputs:** document/version references, target extraction schema, language and policy. `SkillInput.v1` envelope required.
- **Required context:** Document, DocumentVersion, DocumentPage, ExtractedAssertion, Evidence, Provenance, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** ExtractedAssertion/DocumentFinding with page-span references; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** model-assisted; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `document.authenticity.assess`
- **Purpose:** Assess possible tampering and authenticity indicators.
- **Inputs:** document/version references, target extraction schema, language and policy. `SkillInput.v1` envelope required.
- **Required context:** Document, DocumentVersion, DocumentPage, ExtractedAssertion, Evidence, Provenance, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** ExtractedAssertion/DocumentFinding with page-span references; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** model-assisted; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `document.validity.check`
- **Purpose:** Validate issuance expiration and formal requirements.
- **Inputs:** document/version references, target extraction schema, language and policy. `SkillInput.v1` envelope required.
- **Required context:** Document, DocumentVersion, DocumentPage, ExtractedAssertion, Evidence, Provenance, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** ExtractedAssertion/DocumentFinding with page-span references; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** model-assisted; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `document.consistency.check`
- **Purpose:** Detect cross-document contradictions.
- **Inputs:** document/version references, target extraction schema, language and policy. `SkillInput.v1` envelope required.
- **Required context:** Document, DocumentVersion, DocumentPage, ExtractedAssertion, Evidence, Provenance, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** ExtractedAssertion/DocumentFinding with page-span references; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** model-assisted; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `document.requirements.evaluate`
- **Purpose:** Check documents against policy.
- **Inputs:** document/version references, target extraction schema, language and policy. `SkillInput.v1` envelope required.
- **Required context:** Document, DocumentVersion, DocumentPage, ExtractedAssertion, Evidence, Provenance, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** ExtractedAssertion/DocumentFinding with page-span references; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** model-assisted; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `document.evidence.link`
- **Purpose:** Link extracted assertions to source spans.
- **Inputs:** document/version references, target extraction schema, language and policy. `SkillInput.v1` envelope required.
- **Required context:** Document, DocumentVersion, DocumentPage, ExtractedAssertion, Evidence, Provenance, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** ExtractedAssertion/DocumentFinding with page-span references; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** model-assisted; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `document.version.compare`
- **Purpose:** Compare document versions.
- **Inputs:** document/version references, target extraction schema, language and policy. `SkillInput.v1` envelope required.
- **Required context:** Document, DocumentVersion, DocumentPage, ExtractedAssertion, Evidence, Provenance, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** ExtractedAssertion/DocumentFinding with page-span references; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** model-assisted; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `document.translation.normalize`
- **Purpose:** Normalize multilingual documents.
- **Inputs:** document/version references, target extraction schema, language and policy. `SkillInput.v1` envelope required.
- **Required context:** Document, DocumentVersion, DocumentPage, ExtractedAssertion, Evidence, Provenance, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** ExtractedAssertion/DocumentFinding with page-span references; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** model-assisted; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `document.request.generate`
- **Purpose:** Generate missing-document requests.
- **Inputs:** document/version references, target extraction schema, language and policy. `SkillInput.v1` envelope required.
- **Required context:** Document, DocumentVersion, DocumentPage, ExtractedAssertion, Evidence, Provenance, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** ExtractedAssertion/DocumentFinding with page-span references; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** model-assisted; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.


### 05. `registry.*` — 10 skills

**Default context objects:** Entity, Registration, RegistryRecord, Filing, OfficerRole, License, Evidence, Policy. **Default execution mode:** retrieval.

#### `registry.company.lookup`
- **Purpose:** Retrieve corporate registry records.
- **Inputs:** subject canonical references, as-of timestamp, purpose and policy snapshot. `SkillInput.v1` envelope required.
- **Required context:** Entity, Registration, RegistryRecord, Filing, OfficerRole, License, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** typed canonical result and evidence-backed Finding/Status; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** retrieval; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `registry.company.verify`
- **Purpose:** Verify legal existence and status.
- **Inputs:** subject canonical references, as-of timestamp, purpose and policy snapshot. `SkillInput.v1` envelope required.
- **Required context:** Entity, Registration, RegistryRecord, Filing, OfficerRole, License, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** typed canonical result and evidence-backed Finding/Status; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** deterministic; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `registry.directors.resolve`
- **Purpose:** Resolve directors and officers.
- **Inputs:** subject canonical references, as-of timestamp, purpose and policy snapshot. `SkillInput.v1` envelope required.
- **Required context:** Entity, Registration, RegistryRecord, Filing, OfficerRole, License, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** typed canonical result and evidence-backed Finding/Status; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** retrieval; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `registry.filings.retrieve`
- **Purpose:** Retrieve filings.
- **Inputs:** subject canonical references, as-of timestamp, purpose and policy snapshot. `SkillInput.v1` envelope required.
- **Required context:** Entity, Registration, RegistryRecord, Filing, OfficerRole, License, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** typed canonical result and evidence-backed Finding/Status; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** retrieval; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `registry.licenses.verify`
- **Purpose:** Validate licenses.
- **Inputs:** subject canonical references, as-of timestamp, purpose and policy snapshot. `SkillInput.v1` envelope required.
- **Required context:** Entity, Registration, RegistryRecord, Filing, OfficerRole, License, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** typed canonical result and evidence-backed Finding/Status; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** deterministic; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `registry.taxid.validate`
- **Purpose:** Validate tax/business identifiers.
- **Inputs:** subject canonical references, as-of timestamp, purpose and policy snapshot. `SkillInput.v1` envelope required.
- **Required context:** Entity, Registration, RegistryRecord, Filing, OfficerRole, License, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** typed canonical result and evidence-backed Finding/Status; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** deterministic; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `registry.address.verify`
- **Purpose:** Verify registered addresses.
- **Inputs:** subject canonical references, as-of timestamp, purpose and policy snapshot. `SkillInput.v1` envelope required.
- **Required context:** Entity, Registration, RegistryRecord, Filing, OfficerRole, License, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** typed canonical result and evidence-backed Finding/Status; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** deterministic; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `registry.status.monitor`
- **Purpose:** Detect status changes.
- **Inputs:** subject canonical references, as-of timestamp, purpose and policy snapshot. `SkillInput.v1` envelope required.
- **Required context:** Entity, Registration, RegistryRecord, Filing, OfficerRole, License, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** typed canonical result and evidence-backed Finding/Status; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** retrieval; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `registry.jurisdiction.resolve`
- **Purpose:** Determine incorporation jurisdiction.
- **Inputs:** subject canonical references, as-of timestamp, purpose and policy snapshot. `SkillInput.v1` envelope required.
- **Required context:** Entity, Registration, RegistryRecord, Filing, OfficerRole, License, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** typed canonical result and evidence-backed Finding/Status; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** retrieval; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `registry.discrepancy.detect`
- **Purpose:** Compare registry and declarations.
- **Inputs:** subject canonical references, as-of timestamp, purpose and policy snapshot. `SkillInput.v1` envelope required.
- **Required context:** Entity, Registration, RegistryRecord, Filing, OfficerRole, License, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** typed canonical result and evidence-backed Finding/Status; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** retrieval; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.


### 06. `screening.*` — 14 skills

**Default context objects:** Entity, Alias, WatchlistEntry, ScreeningHit, SanctionsRegime, PEPRelationship, AdverseMediaEvent, Evidence, Policy. **Default execution mode:** hybrid.

#### `screening.sanctions.execute`
- **Purpose:** Screen against applicable sanctions sources.
- **Inputs:** subject identities/aliases, lists and jurisdictions, list snapshot and matching thresholds. `SkillInput.v1` envelope required.
- **Required context:** Entity, Alias, WatchlistEntry, ScreeningHit, SanctionsRegime, PEPRelationship, AdverseMediaEvent, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** ScreeningHit/DispositionCandidate and match evidence; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** hybrid; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** Use applicable sanctions regimes and ownership/control tests; unresolved potential matches must not auto-clear.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `screening.pep.execute`
- **Purpose:** Screen politically exposed persons.
- **Inputs:** subject identities/aliases, lists and jurisdictions, list snapshot and matching thresholds. `SkillInput.v1` envelope required.
- **Required context:** Entity, Alias, WatchlistEntry, ScreeningHit, SanctionsRegime, PEPRelationship, AdverseMediaEvent, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** ScreeningHit/DispositionCandidate and match evidence; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** hybrid; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** Use applicable sanctions regimes and ownership/control tests; unresolved potential matches must not auto-clear.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `screening.adverse_media.execute`
- **Purpose:** Search adverse media.
- **Inputs:** subject identities/aliases, lists and jurisdictions, list snapshot and matching thresholds. `SkillInput.v1` envelope required.
- **Required context:** Entity, Alias, WatchlistEntry, ScreeningHit, SanctionsRegime, PEPRelationship, AdverseMediaEvent, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** ScreeningHit/DispositionCandidate and match evidence; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** hybrid; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** Use applicable sanctions regimes and ownership/control tests; unresolved potential matches must not auto-clear.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `screening.watchlist.execute`
- **Purpose:** Screen authorized watchlists.
- **Inputs:** subject identities/aliases, lists and jurisdictions, list snapshot and matching thresholds. `SkillInput.v1` envelope required.
- **Required context:** Entity, Alias, WatchlistEntry, ScreeningHit, SanctionsRegime, PEPRelationship, AdverseMediaEvent, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** ScreeningHit/DispositionCandidate and match evidence; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** hybrid; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** Use applicable sanctions regimes and ownership/control tests; unresolved potential matches must not auto-clear.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `screening.name.normalize`
- **Purpose:** Normalize names across scripts.
- **Inputs:** subject identities/aliases, lists and jurisdictions, list snapshot and matching thresholds. `SkillInput.v1` envelope required.
- **Required context:** Entity, Alias, WatchlistEntry, ScreeningHit, SanctionsRegime, PEPRelationship, AdverseMediaEvent, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** ScreeningHit/DispositionCandidate and match evidence; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** deterministic; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** Use applicable sanctions regimes and ownership/control tests; unresolved potential matches must not auto-clear.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `screening.match.score`
- **Purpose:** Score screening candidate matches.
- **Inputs:** subject identities/aliases, lists and jurisdictions, list snapshot and matching thresholds. `SkillInput.v1` envelope required.
- **Required context:** Entity, Alias, WatchlistEntry, ScreeningHit, SanctionsRegime, PEPRelationship, AdverseMediaEvent, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** ScreeningHit/DispositionCandidate and match evidence; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** deterministic; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** Use applicable sanctions regimes and ownership/control tests; unresolved potential matches must not auto-clear.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `screening.match.disambiguate`
- **Purpose:** Assess candidate true/false matches.
- **Inputs:** subject identities/aliases, lists and jurisdictions, list snapshot and matching thresholds. `SkillInput.v1` envelope required.
- **Required context:** Entity, Alias, WatchlistEntry, ScreeningHit, SanctionsRegime, PEPRelationship, AdverseMediaEvent, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** ScreeningHit/DispositionCandidate and match evidence; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** hybrid; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** Use applicable sanctions regimes and ownership/control tests; unresolved potential matches must not auto-clear.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `screening.sanctions.ownership.evaluate`
- **Purpose:** Evaluate applicable sanctions ownership aggregation.
- **Inputs:** subject identities/aliases, lists and jurisdictions, list snapshot and matching thresholds. `SkillInput.v1` envelope required.
- **Required context:** Entity, Alias, WatchlistEntry, ScreeningHit, SanctionsRegime, PEPRelationship, AdverseMediaEvent, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** ScreeningHit/DispositionCandidate and match evidence; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** deterministic; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** Use applicable sanctions regimes and ownership/control tests; unresolved potential matches must not auto-clear.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `screening.sanctions.control.evaluate`
- **Purpose:** Evaluate applicable control restrictions.
- **Inputs:** subject identities/aliases, lists and jurisdictions, list snapshot and matching thresholds. `SkillInput.v1` envelope required.
- **Required context:** Entity, Alias, WatchlistEntry, ScreeningHit, SanctionsRegime, PEPRelationship, AdverseMediaEvent, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** ScreeningHit/DispositionCandidate and match evidence; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** deterministic; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** Use applicable sanctions regimes and ownership/control tests; unresolved potential matches must not auto-clear.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `screening.pep.relationship.resolve`
- **Purpose:** Resolve relatives and close associates.
- **Inputs:** subject identities/aliases, lists and jurisdictions, list snapshot and matching thresholds. `SkillInput.v1` envelope required.
- **Required context:** Entity, Alias, WatchlistEntry, ScreeningHit, SanctionsRegime, PEPRelationship, AdverseMediaEvent, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** ScreeningHit/DispositionCandidate and match evidence; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** hybrid; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** Use applicable sanctions regimes and ownership/control tests; unresolved potential matches must not auto-clear.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `screening.adverse_media.classify`
- **Purpose:** Classify relevant negative events.
- **Inputs:** subject identities/aliases, lists and jurisdictions, list snapshot and matching thresholds. `SkillInput.v1` envelope required.
- **Required context:** Entity, Alias, WatchlistEntry, ScreeningHit, SanctionsRegime, PEPRelationship, AdverseMediaEvent, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** ScreeningHit/DispositionCandidate and match evidence; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** hybrid; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** Use applicable sanctions regimes and ownership/control tests; unresolved potential matches must not auto-clear.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `screening.adverse_media.correlate`
- **Purpose:** Correlate media across sources.
- **Inputs:** subject identities/aliases, lists and jurisdictions, list snapshot and matching thresholds. `SkillInput.v1` envelope required.
- **Required context:** Entity, Alias, WatchlistEntry, ScreeningHit, SanctionsRegime, PEPRelationship, AdverseMediaEvent, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** ScreeningHit/DispositionCandidate and match evidence; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** hybrid; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** Use applicable sanctions regimes and ownership/control tests; unresolved potential matches must not auto-clear.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `screening.alert.disposition`
- **Purpose:** Recommend or record screening disposition.
- **Inputs:** subject identities/aliases, lists and jurisdictions, list snapshot and matching thresholds. `SkillInput.v1` envelope required.
- **Required context:** Entity, Alias, WatchlistEntry, ScreeningHit, SanctionsRegime, PEPRelationship, AdverseMediaEvent, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** ScreeningHit/DispositionCandidate and match evidence; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** hybrid; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** Use applicable sanctions regimes and ownership/control tests; unresolved potential matches must not auto-clear.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `screening.rescreen.schedule`
- **Purpose:** Schedule rescreening.
- **Inputs:** subject identities/aliases, lists and jurisdictions, list snapshot and matching thresholds. `SkillInput.v1` envelope required.
- **Required context:** Entity, Alias, WatchlistEntry, ScreeningHit, SanctionsRegime, PEPRelationship, AdverseMediaEvent, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** ScreeningHit/DispositionCandidate and match evidence; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** deterministic; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** Use applicable sanctions regimes and ownership/control tests; unresolved potential matches must not auto-clear.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.


### 07. `risk.*` — 12 skills

**Default context objects:** Party, RiskFactor, RiskAssessment, RiskModel, GeographyExposure, Finding, Policy, Evidence. **Default execution mode:** deterministic.

#### `risk.customer.assess`
- **Purpose:** Assess overall customer risk.
- **Inputs:** party, factor inputs, model version and policy. `SkillInput.v1` envelope required.
- **Required context:** Party, RiskFactor, RiskAssessment, RiskModel, GeographyExposure, Finding, Policy, Evidence; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** RiskAssessment/RiskFactor and explanation; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** deterministic; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `risk.inherent.calculate`
- **Purpose:** Compute inherent risk.
- **Inputs:** party, factor inputs, model version and policy. `SkillInput.v1` envelope required.
- **Required context:** Party, RiskFactor, RiskAssessment, RiskModel, GeographyExposure, Finding, Policy, Evidence; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** RiskAssessment/RiskFactor and explanation; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** deterministic; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `risk.residual.calculate`
- **Purpose:** Compute residual risk.
- **Inputs:** party, factor inputs, model version and policy. `SkillInput.v1` envelope required.
- **Required context:** Party, RiskFactor, RiskAssessment, RiskModel, GeographyExposure, Finding, Policy, Evidence; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** RiskAssessment/RiskFactor and explanation; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** deterministic; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `risk.factor.evaluate`
- **Purpose:** Evaluate risk factors.
- **Inputs:** party, factor inputs, model version and policy. `SkillInput.v1` envelope required.
- **Required context:** Party, RiskFactor, RiskAssessment, RiskModel, GeographyExposure, Finding, Policy, Evidence; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** RiskAssessment/RiskFactor and explanation; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** deterministic; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `risk.geography.assess`
- **Purpose:** Assess geographic risk.
- **Inputs:** party, factor inputs, model version and policy. `SkillInput.v1` envelope required.
- **Required context:** Party, RiskFactor, RiskAssessment, RiskModel, GeographyExposure, Finding, Policy, Evidence; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** RiskAssessment/RiskFactor and explanation; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** deterministic; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `risk.industry.assess`
- **Purpose:** Assess sector risk.
- **Inputs:** party, factor inputs, model version and policy. `SkillInput.v1` envelope required.
- **Required context:** Party, RiskFactor, RiskAssessment, RiskModel, GeographyExposure, Finding, Policy, Evidence; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** RiskAssessment/RiskFactor and explanation; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** deterministic; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `risk.product.assess`
- **Purpose:** Assess product/channel risk.
- **Inputs:** party, factor inputs, model version and policy. `SkillInput.v1` envelope required.
- **Required context:** Party, RiskFactor, RiskAssessment, RiskModel, GeographyExposure, Finding, Policy, Evidence; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** RiskAssessment/RiskFactor and explanation; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** deterministic; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `risk.behavior.assess`
- **Purpose:** Assess observed behavior.
- **Inputs:** party, factor inputs, model version and policy. `SkillInput.v1` envelope required.
- **Required context:** Party, RiskFactor, RiskAssessment, RiskModel, GeographyExposure, Finding, Policy, Evidence; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** RiskAssessment/RiskFactor and explanation; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** deterministic; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `risk.score.explain`
- **Purpose:** Explain score drivers.
- **Inputs:** party, factor inputs, model version and policy. `SkillInput.v1` envelope required.
- **Required context:** Party, RiskFactor, RiskAssessment, RiskModel, GeographyExposure, Finding, Policy, Evidence; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** RiskAssessment/RiskFactor and explanation; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** deterministic; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `risk.score.calibrate`
- **Purpose:** Calibrate risk model.
- **Inputs:** party, factor inputs, model version and policy. `SkillInput.v1` envelope required.
- **Required context:** Party, RiskFactor, RiskAssessment, RiskModel, GeographyExposure, Finding, Policy, Evidence; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** RiskAssessment/RiskFactor and explanation; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** deterministic; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `risk.change.detect`
- **Purpose:** Detect risk changes.
- **Inputs:** party, factor inputs, model version and policy. `SkillInput.v1` envelope required.
- **Required context:** Party, RiskFactor, RiskAssessment, RiskModel, GeographyExposure, Finding, Policy, Evidence; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** RiskAssessment/RiskFactor and explanation; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** deterministic; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `risk.tier.assign`
- **Purpose:** Assign risk tier.
- **Inputs:** party, factor inputs, model version and policy. `SkillInput.v1` envelope required.
- **Required context:** Party, RiskFactor, RiskAssessment, RiskModel, GeographyExposure, Finding, Policy, Evidence; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** RiskAssessment/RiskFactor and explanation; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** deterministic; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.


### 08. `edd.*` — 10 skills

**Default context objects:** Party, RiskAssessment, SourceOfFunds, SourceOfWealth, Investigation, Finding, Evidence, Policy. **Default execution mode:** hybrid.

#### `edd.trigger.evaluate`
- **Purpose:** Determine EDD trigger.
- **Inputs:** subject canonical references, as-of timestamp, purpose and policy snapshot. `SkillInput.v1` envelope required.
- **Required context:** Party, RiskAssessment, SourceOfFunds, SourceOfWealth, Investigation, Finding, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** typed canonical result and evidence-backed Finding/Status; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** deterministic; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `edd.scope.plan`
- **Purpose:** Plan EDD investigation.
- **Inputs:** subject canonical references, as-of timestamp, purpose and policy snapshot. `SkillInput.v1` envelope required.
- **Required context:** Party, RiskAssessment, SourceOfFunds, SourceOfWealth, Investigation, Finding, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** typed canonical result and evidence-backed Finding/Status; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** hybrid; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `edd.source_of_funds.verify`
- **Purpose:** Verify source of funds.
- **Inputs:** subject canonical references, as-of timestamp, purpose and policy snapshot. `SkillInput.v1` envelope required.
- **Required context:** Party, RiskAssessment, SourceOfFunds, SourceOfWealth, Investigation, Finding, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** typed canonical result and evidence-backed Finding/Status; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** deterministic; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `edd.source_of_wealth.assess`
- **Purpose:** Assess source of wealth.
- **Inputs:** subject canonical references, as-of timestamp, purpose and policy snapshot. `SkillInput.v1` envelope required.
- **Required context:** Party, RiskAssessment, SourceOfFunds, SourceOfWealth, Investigation, Finding, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** typed canonical result and evidence-backed Finding/Status; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** hybrid; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `edd.business.purpose.validate`
- **Purpose:** Validate commercial purpose.
- **Inputs:** subject canonical references, as-of timestamp, purpose and policy snapshot. `SkillInput.v1` envelope required.
- **Required context:** Party, RiskAssessment, SourceOfFunds, SourceOfWealth, Investigation, Finding, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** typed canonical result and evidence-backed Finding/Status; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** deterministic; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `edd.counterparty.analyze`
- **Purpose:** Investigate counterparties.
- **Inputs:** subject canonical references, as-of timestamp, purpose and policy snapshot. `SkillInput.v1` envelope required.
- **Required context:** Party, RiskAssessment, SourceOfFunds, SourceOfWealth, Investigation, Finding, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** typed canonical result and evidence-backed Finding/Status; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** hybrid; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `edd.geographic.exposure`
- **Purpose:** Investigate high-risk geographic exposure.
- **Inputs:** subject canonical references, as-of timestamp, purpose and policy snapshot. `SkillInput.v1` envelope required.
- **Required context:** Party, RiskAssessment, SourceOfFunds, SourceOfWealth, Investigation, Finding, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** typed canonical result and evidence-backed Finding/Status; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** hybrid; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `edd.pep.exposure`
- **Purpose:** Investigate PEP exposure.
- **Inputs:** subject canonical references, as-of timestamp, purpose and policy snapshot. `SkillInput.v1` envelope required.
- **Required context:** Party, RiskAssessment, SourceOfFunds, SourceOfWealth, Investigation, Finding, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** typed canonical result and evidence-backed Finding/Status; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** hybrid; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `edd.findings.synthesize`
- **Purpose:** Synthesize EDD findings.
- **Inputs:** subject canonical references, as-of timestamp, purpose and policy snapshot. `SkillInput.v1` envelope required.
- **Required context:** Party, RiskAssessment, SourceOfFunds, SourceOfWealth, Investigation, Finding, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** typed canonical result and evidence-backed Finding/Status; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** hybrid; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `edd.recommendation.generate`
- **Purpose:** Recommend EDD outcome.
- **Inputs:** subject canonical references, as-of timestamp, purpose and policy snapshot. `SkillInput.v1` envelope required.
- **Required context:** Party, RiskAssessment, SourceOfFunds, SourceOfWealth, Investigation, Finding, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** typed canonical result and evidence-backed Finding/Status; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** hybrid; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.


### 09. `transaction.*` — 12 skills

**Default context objects:** Transaction, Account, Counterparty, Party, ExpectedActivity, PaymentRail, Evidence, Policy. **Default execution mode:** deterministic.

#### `transaction.ingest`
- **Purpose:** Normalize transaction data.
- **Inputs:** transaction/account references, analysis window and currency normalization. `SkillInput.v1` envelope required.
- **Required context:** Transaction, Account, Counterparty, Party, ExpectedActivity, PaymentRail, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** TransactionFinding/FlowGraph and contributing transaction refs; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** deterministic; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `transaction.enrich`
- **Purpose:** Enrich transaction context.
- **Inputs:** transaction/account references, analysis window and currency normalization. `SkillInput.v1` envelope required.
- **Required context:** Transaction, Account, Counterparty, Party, ExpectedActivity, PaymentRail, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** TransactionFinding/FlowGraph and contributing transaction refs; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** deterministic; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `transaction.classify`
- **Purpose:** Classify transaction type.
- **Inputs:** transaction/account references, analysis window and currency normalization. `SkillInput.v1` envelope required.
- **Required context:** Transaction, Account, Counterparty, Party, ExpectedActivity, PaymentRail, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** TransactionFinding/FlowGraph and contributing transaction refs; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** deterministic; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `transaction.counterparty.resolve`
- **Purpose:** Resolve counterparties.
- **Inputs:** transaction/account references, analysis window and currency normalization. `SkillInput.v1` envelope required.
- **Required context:** Transaction, Account, Counterparty, Party, ExpectedActivity, PaymentRail, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** TransactionFinding/FlowGraph and contributing transaction refs; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** deterministic; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `transaction.behavior.profile`
- **Purpose:** Build behavioral profiles.
- **Inputs:** transaction/account references, analysis window and currency normalization. `SkillInput.v1` envelope required.
- **Required context:** Transaction, Account, Counterparty, Party, ExpectedActivity, PaymentRail, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** TransactionFinding/FlowGraph and contributing transaction refs; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** deterministic; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `transaction.baseline.compare`
- **Purpose:** Compare observed versus expected activity.
- **Inputs:** transaction/account references, analysis window and currency normalization. `SkillInput.v1` envelope required.
- **Required context:** Transaction, Account, Counterparty, Party, ExpectedActivity, PaymentRail, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** TransactionFinding/FlowGraph and contributing transaction refs; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** deterministic; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `transaction.velocity.analyze`
- **Purpose:** Analyze transaction velocity.
- **Inputs:** transaction/account references, analysis window and currency normalization. `SkillInput.v1` envelope required.
- **Required context:** Transaction, Account, Counterparty, Party, ExpectedActivity, PaymentRail, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** TransactionFinding/FlowGraph and contributing transaction refs; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** deterministic; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `transaction.flow.trace`
- **Purpose:** Trace fund flows.
- **Inputs:** transaction/account references, analysis window and currency normalization. `SkillInput.v1` envelope required.
- **Required context:** Transaction, Account, Counterparty, Party, ExpectedActivity, PaymentRail, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** TransactionFinding/FlowGraph and contributing transaction refs; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** deterministic; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `transaction.cashflow.analyze`
- **Purpose:** Analyze inflows and outflows.
- **Inputs:** transaction/account references, analysis window and currency normalization. `SkillInput.v1` envelope required.
- **Required context:** Transaction, Account, Counterparty, Party, ExpectedActivity, PaymentRail, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** TransactionFinding/FlowGraph and contributing transaction refs; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** deterministic; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `transaction.geography.analyze`
- **Purpose:** Analyze geographic exposure.
- **Inputs:** transaction/account references, analysis window and currency normalization. `SkillInput.v1` envelope required.
- **Required context:** Transaction, Account, Counterparty, Party, ExpectedActivity, PaymentRail, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** TransactionFinding/FlowGraph and contributing transaction refs; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** deterministic; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `transaction.anomaly.detect`
- **Purpose:** Detect anomalous transactions.
- **Inputs:** transaction/account references, analysis window and currency normalization. `SkillInput.v1` envelope required.
- **Required context:** Transaction, Account, Counterparty, Party, ExpectedActivity, PaymentRail, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** TransactionFinding/FlowGraph and contributing transaction refs; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** deterministic; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `transaction.exposure.aggregate`
- **Purpose:** Aggregate exposure.
- **Inputs:** transaction/account references, analysis window and currency normalization. `SkillInput.v1` envelope required.
- **Required context:** Transaction, Account, Counterparty, Party, ExpectedActivity, PaymentRail, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** TransactionFinding/FlowGraph and contributing transaction refs; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** deterministic; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.


### 10. `network.*` — 10 skills

**Default context objects:** Entity, Relationship, Transaction, OwnershipGraph, NetworkGraph, Finding, Evidence, Policy. **Default execution mode:** deterministic.

#### `network.graph.build`
- **Purpose:** Build relationship network.
- **Inputs:** subject canonical references, as-of timestamp, purpose and policy snapshot. `SkillInput.v1` envelope required.
- **Required context:** Entity, Relationship, Transaction, OwnershipGraph, NetworkGraph, Finding, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** typed canonical result and evidence-backed Finding/Status; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** deterministic; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `network.relationship.infer`
- **Purpose:** Infer candidate links.
- **Inputs:** subject canonical references, as-of timestamp, purpose and policy snapshot. `SkillInput.v1` envelope required.
- **Required context:** Entity, Relationship, Transaction, OwnershipGraph, NetworkGraph, Finding, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** typed canonical result and evidence-backed Finding/Status; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** deterministic; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `network.community.detect`
- **Purpose:** Identify clusters.
- **Inputs:** subject canonical references, as-of timestamp, purpose and policy snapshot. `SkillInput.v1` envelope required.
- **Required context:** Entity, Relationship, Transaction, OwnershipGraph, NetworkGraph, Finding, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** typed canonical result and evidence-backed Finding/Status; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** deterministic; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `network.path.find`
- **Purpose:** Find relationship paths.
- **Inputs:** subject canonical references, as-of timestamp, purpose and policy snapshot. `SkillInput.v1` envelope required.
- **Required context:** Entity, Relationship, Transaction, OwnershipGraph, NetworkGraph, Finding, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** typed canonical result and evidence-backed Finding/Status; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** deterministic; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `network.centrality.calculate`
- **Purpose:** Compute graph centrality.
- **Inputs:** subject canonical references, as-of timestamp, purpose and policy snapshot. `SkillInput.v1` envelope required.
- **Required context:** Entity, Relationship, Transaction, OwnershipGraph, NetworkGraph, Finding, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** typed canonical result and evidence-backed Finding/Status; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** deterministic; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `network.cycle.detect`
- **Purpose:** Detect cyclic flows.
- **Inputs:** subject canonical references, as-of timestamp, purpose and policy snapshot. `SkillInput.v1` envelope required.
- **Required context:** Entity, Relationship, Transaction, OwnershipGraph, NetworkGraph, Finding, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** typed canonical result and evidence-backed Finding/Status; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** deterministic; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `network.beneficiary.trace`
- **Purpose:** Trace ultimate beneficiaries.
- **Inputs:** subject canonical references, as-of timestamp, purpose and policy snapshot. `SkillInput.v1` envelope required.
- **Required context:** Entity, Relationship, Transaction, OwnershipGraph, NetworkGraph, Finding, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** typed canonical result and evidence-backed Finding/Status; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** deterministic; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `network.shared_attributes.detect`
- **Purpose:** Identify shared identifiers.
- **Inputs:** subject canonical references, as-of timestamp, purpose and policy snapshot. `SkillInput.v1` envelope required.
- **Required context:** Entity, Relationship, Transaction, OwnershipGraph, NetworkGraph, Finding, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** typed canonical result and evidence-backed Finding/Status; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** deterministic; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `network.temporal.analyze`
- **Purpose:** Analyze temporal network changes.
- **Inputs:** subject canonical references, as-of timestamp, purpose and policy snapshot. `SkillInput.v1` envelope required.
- **Required context:** Entity, Relationship, Transaction, OwnershipGraph, NetworkGraph, Finding, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** typed canonical result and evidence-backed Finding/Status; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** deterministic; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `network.risk.propagate`
- **Purpose:** Calculate governed network risk exposure.
- **Inputs:** subject canonical references, as-of timestamp, purpose and policy snapshot. `SkillInput.v1` envelope required.
- **Required context:** Entity, Relationship, Transaction, OwnershipGraph, NetworkGraph, Finding, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** typed canonical result and evidence-backed Finding/Status; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** deterministic; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.


### 11. `aml.*` — 12 skills

**Default context objects:** Transaction, Account, Party, Typology, DetectionRule, Alert, Finding, Evidence, Policy. **Default execution mode:** deterministic.

#### `aml.structuring.detect`
- **Purpose:** Detect possible structuring.
- **Inputs:** subject canonical references, as-of timestamp, purpose and policy snapshot. `SkillInput.v1` envelope required.
- **Required context:** Transaction, Account, Party, Typology, DetectionRule, Alert, Finding, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** typed canonical result and evidence-backed Finding/Status; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** deterministic; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** Indicators are not proof; record false-positive considerations, model/rule version and analyst escalation.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `aml.layering.detect`
- **Purpose:** Detect possible layering.
- **Inputs:** subject canonical references, as-of timestamp, purpose and policy snapshot. `SkillInput.v1` envelope required.
- **Required context:** Transaction, Account, Party, Typology, DetectionRule, Alert, Finding, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** typed canonical result and evidence-backed Finding/Status; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** deterministic; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** Indicators are not proof; record false-positive considerations, model/rule version and analyst escalation.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `aml.roundtrip.detect`
- **Purpose:** Detect round-tripping.
- **Inputs:** subject canonical references, as-of timestamp, purpose and policy snapshot. `SkillInput.v1` envelope required.
- **Required context:** Transaction, Account, Party, Typology, DetectionRule, Alert, Finding, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** typed canonical result and evidence-backed Finding/Status; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** deterministic; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** Indicators are not proof; record false-positive considerations, model/rule version and analyst escalation.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `aml.funnel.detect`
- **Purpose:** Detect funnel patterns.
- **Inputs:** subject canonical references, as-of timestamp, purpose and policy snapshot. `SkillInput.v1` envelope required.
- **Required context:** Transaction, Account, Party, Typology, DetectionRule, Alert, Finding, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** typed canonical result and evidence-backed Finding/Status; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** deterministic; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** Indicators are not proof; record false-positive considerations, model/rule version and analyst escalation.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `aml.smurfing.detect`
- **Purpose:** Detect distributed small payments.
- **Inputs:** subject canonical references, as-of timestamp, purpose and policy snapshot. `SkillInput.v1` envelope required.
- **Required context:** Transaction, Account, Party, Typology, DetectionRule, Alert, Finding, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** typed canonical result and evidence-backed Finding/Status; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** deterministic; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** Indicators are not proof; record false-positive considerations, model/rule version and analyst escalation.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `aml.pass_through.detect`
- **Purpose:** Detect pass-through accounts.
- **Inputs:** subject canonical references, as-of timestamp, purpose and policy snapshot. `SkillInput.v1` envelope required.
- **Required context:** Transaction, Account, Party, Typology, DetectionRule, Alert, Finding, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** typed canonical result and evidence-backed Finding/Status; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** deterministic; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** Indicators are not proof; record false-positive considerations, model/rule version and analyst escalation.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `aml.trade_based.detect`
- **Purpose:** Detect trade-based laundering indicators.
- **Inputs:** subject canonical references, as-of timestamp, purpose and policy snapshot. `SkillInput.v1` envelope required.
- **Required context:** Transaction, Account, Party, Typology, DetectionRule, Alert, Finding, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** typed canonical result and evidence-backed Finding/Status; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** deterministic; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** Indicators are not proof; record false-positive considerations, model/rule version and analyst escalation.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `aml.mule.detect`
- **Purpose:** Detect mule-account indicators.
- **Inputs:** subject canonical references, as-of timestamp, purpose and policy snapshot. `SkillInput.v1` envelope required.
- **Required context:** Transaction, Account, Party, Typology, DetectionRule, Alert, Finding, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** typed canonical result and evidence-backed Finding/Status; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** deterministic; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** Indicators are not proof; record false-positive considerations, model/rule version and analyst escalation.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `aml.shell_company.detect`
- **Purpose:** Detect shell-company indicators.
- **Inputs:** subject canonical references, as-of timestamp, purpose and policy snapshot. `SkillInput.v1` envelope required.
- **Required context:** Transaction, Account, Party, Typology, DetectionRule, Alert, Finding, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** typed canonical result and evidence-backed Finding/Status; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** deterministic; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** Indicators are not proof; record false-positive considerations, model/rule version and analyst escalation.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `aml.velocity.detect`
- **Purpose:** Detect abnormal movement velocity.
- **Inputs:** subject canonical references, as-of timestamp, purpose and policy snapshot. `SkillInput.v1` envelope required.
- **Required context:** Transaction, Account, Party, Typology, DetectionRule, Alert, Finding, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** typed canonical result and evidence-backed Finding/Status; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** deterministic; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** Indicators are not proof; record false-positive considerations, model/rule version and analyst escalation.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `aml.typology.match`
- **Purpose:** Match known typologies.
- **Inputs:** subject canonical references, as-of timestamp, purpose and policy snapshot. `SkillInput.v1` envelope required.
- **Required context:** Transaction, Account, Party, Typology, DetectionRule, Alert, Finding, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** typed canonical result and evidence-backed Finding/Status; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** deterministic; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** Indicators are not proof; record false-positive considerations, model/rule version and analyst escalation.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `aml.suspicion.assess`
- **Purpose:** Assess whether indicators warrant investigation.
- **Inputs:** subject canonical references, as-of timestamp, purpose and policy snapshot. `SkillInput.v1` envelope required.
- **Required context:** Transaction, Account, Party, Typology, DetectionRule, Alert, Finding, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** typed canonical result and evidence-backed Finding/Status; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** deterministic; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** Indicators are not proof; record false-positive considerations, model/rule version and analyst escalation.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.


### 12. `alert.*` — 10 skills

**Default context objects:** Alert, DetectionRule, Party, Entity, Transaction, Case, Finding, Evidence, Policy. **Default execution mode:** hybrid.

#### `alert.ingest`
- **Purpose:** Normalize alert.
- **Inputs:** subject canonical references, as-of timestamp, purpose and policy snapshot. `SkillInput.v1` envelope required.
- **Required context:** Alert, DetectionRule, Party, Entity, Transaction, Case, Finding, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** typed canonical result and evidence-backed Finding/Status; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** deterministic; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `alert.classify`
- **Purpose:** Classify alert type.
- **Inputs:** subject canonical references, as-of timestamp, purpose and policy snapshot. `SkillInput.v1` envelope required.
- **Required context:** Alert, DetectionRule, Party, Entity, Transaction, Case, Finding, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** typed canonical result and evidence-backed Finding/Status; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** hybrid; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `alert.prioritize`
- **Purpose:** Prioritize alerts.
- **Inputs:** subject canonical references, as-of timestamp, purpose and policy snapshot. `SkillInput.v1` envelope required.
- **Required context:** Alert, DetectionRule, Party, Entity, Transaction, Case, Finding, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** typed canonical result and evidence-backed Finding/Status; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** hybrid; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `alert.deduplicate`
- **Purpose:** Identify duplicate alerts.
- **Inputs:** subject canonical references, as-of timestamp, purpose and policy snapshot. `SkillInput.v1` envelope required.
- **Required context:** Alert, DetectionRule, Party, Entity, Transaction, Case, Finding, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** typed canonical result and evidence-backed Finding/Status; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** hybrid; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `alert.correlate`
- **Purpose:** Correlate related alerts.
- **Inputs:** subject canonical references, as-of timestamp, purpose and policy snapshot. `SkillInput.v1` envelope required.
- **Required context:** Alert, DetectionRule, Party, Entity, Transaction, Case, Finding, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** typed canonical result and evidence-backed Finding/Status; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** hybrid; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `alert.context.assemble`
- **Purpose:** Assemble alert context.
- **Inputs:** subject canonical references, as-of timestamp, purpose and policy snapshot. `SkillInput.v1` envelope required.
- **Required context:** Alert, DetectionRule, Party, Entity, Transaction, Case, Finding, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** typed canonical result and evidence-backed Finding/Status; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** hybrid; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `alert.false_positive.assess`
- **Purpose:** Assess false-positive indicators.
- **Inputs:** subject canonical references, as-of timestamp, purpose and policy snapshot. `SkillInput.v1` envelope required.
- **Required context:** Alert, DetectionRule, Party, Entity, Transaction, Case, Finding, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** typed canonical result and evidence-backed Finding/Status; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** hybrid; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `alert.escalation.evaluate`
- **Purpose:** Evaluate escalation.
- **Inputs:** subject canonical references, as-of timestamp, purpose and policy snapshot. `SkillInput.v1` envelope required.
- **Required context:** Alert, DetectionRule, Party, Entity, Transaction, Case, Finding, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** typed canonical result and evidence-backed Finding/Status; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** deterministic; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `alert.disposition.recommend`
- **Purpose:** Recommend alert disposition.
- **Inputs:** subject canonical references, as-of timestamp, purpose and policy snapshot. `SkillInput.v1` envelope required.
- **Required context:** Alert, DetectionRule, Party, Entity, Transaction, Case, Finding, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** typed canonical result and evidence-backed Finding/Status; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** hybrid; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `alert.feedback.capture`
- **Purpose:** Capture investigation feedback.
- **Inputs:** subject canonical references, as-of timestamp, purpose and policy snapshot. `SkillInput.v1` envelope required.
- **Required context:** Alert, DetectionRule, Party, Entity, Transaction, Case, Finding, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** typed canonical result and evidence-backed Finding/Status; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** hybrid; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.


### 13. `investigation.*` — 12 skills

**Default context objects:** Investigation, Case, Hypothesis, TimelineEvent, Transaction, Relationship, Finding, Evidence, Policy. **Default execution mode:** hybrid.

#### `investigation.plan`
- **Purpose:** Plan investigation.
- **Inputs:** case, hypothesis scope, time window and evidence set. `SkillInput.v1` envelope required.
- **Required context:** Investigation, Case, Hypothesis, TimelineEvent, Transaction, Relationship, Finding, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** InvestigationFinding/HypothesisResult and timeline; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** hybrid; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `investigation.hypothesis.generate`
- **Purpose:** Generate testable hypotheses.
- **Inputs:** case, hypothesis scope, time window and evidence set. `SkillInput.v1` envelope required.
- **Required context:** Investigation, Case, Hypothesis, TimelineEvent, Transaction, Relationship, Finding, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** InvestigationFinding/HypothesisResult and timeline; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** hybrid; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `investigation.evidence.collect`
- **Purpose:** Gather authorized evidence.
- **Inputs:** case, hypothesis scope, time window and evidence set. `SkillInput.v1` envelope required.
- **Required context:** Investigation, Case, Hypothesis, TimelineEvent, Transaction, Relationship, Finding, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** InvestigationFinding/HypothesisResult and timeline; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** hybrid; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `investigation.timeline.build`
- **Purpose:** Build event timeline.
- **Inputs:** case, hypothesis scope, time window and evidence set. `SkillInput.v1` envelope required.
- **Required context:** Investigation, Case, Hypothesis, TimelineEvent, Transaction, Relationship, Finding, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** InvestigationFinding/HypothesisResult and timeline; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** hybrid; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `investigation.relationship.analyze`
- **Purpose:** Analyze associated parties.
- **Inputs:** case, hypothesis scope, time window and evidence set. `SkillInput.v1` envelope required.
- **Required context:** Investigation, Case, Hypothesis, TimelineEvent, Transaction, Relationship, Finding, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** InvestigationFinding/HypothesisResult and timeline; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** hybrid; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `investigation.fundflow.reconstruct`
- **Purpose:** Reconstruct funds movement.
- **Inputs:** case, hypothesis scope, time window and evidence set. `SkillInput.v1` envelope required.
- **Required context:** Investigation, Case, Hypothesis, TimelineEvent, Transaction, Relationship, Finding, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** InvestigationFinding/HypothesisResult and timeline; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** hybrid; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `investigation.hypothesis.test`
- **Purpose:** Test hypotheses.
- **Inputs:** case, hypothesis scope, time window and evidence set. `SkillInput.v1` envelope required.
- **Required context:** Investigation, Case, Hypothesis, TimelineEvent, Transaction, Relationship, Finding, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** InvestigationFinding/HypothesisResult and timeline; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** hybrid; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `investigation.contradiction.detect`
- **Purpose:** Identify conflicting evidence.
- **Inputs:** case, hypothesis scope, time window and evidence set. `SkillInput.v1` envelope required.
- **Required context:** Investigation, Case, Hypothesis, TimelineEvent, Transaction, Relationship, Finding, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** InvestigationFinding/HypothesisResult and timeline; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** hybrid; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `investigation.gaps.identify`
- **Purpose:** Identify investigative gaps.
- **Inputs:** case, hypothesis scope, time window and evidence set. `SkillInput.v1` envelope required.
- **Required context:** Investigation, Case, Hypothesis, TimelineEvent, Transaction, Relationship, Finding, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** InvestigationFinding/HypothesisResult and timeline; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** hybrid; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `investigation.findings.synthesize`
- **Purpose:** Synthesize supported findings.
- **Inputs:** case, hypothesis scope, time window and evidence set. `SkillInput.v1` envelope required.
- **Required context:** Investigation, Case, Hypothesis, TimelineEvent, Transaction, Relationship, Finding, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** InvestigationFinding/HypothesisResult and timeline; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** hybrid; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `investigation.narrative.generate`
- **Purpose:** Draft evidence-backed narrative.
- **Inputs:** case, hypothesis scope, time window and evidence set. `SkillInput.v1` envelope required.
- **Required context:** Investigation, Case, Hypothesis, TimelineEvent, Transaction, Relationship, Finding, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** InvestigationFinding/HypothesisResult and timeline; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** hybrid; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `investigation.recommendation.generate`
- **Purpose:** Recommend disposition.
- **Inputs:** case, hypothesis scope, time window and evidence set. `SkillInput.v1` envelope required.
- **Required context:** Investigation, Case, Hypothesis, TimelineEvent, Transaction, Relationship, Finding, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** InvestigationFinding/HypothesisResult and timeline; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** hybrid; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.


### 14. `fraud.*` — 12 skills

**Default context objects:** Party, Identity, Device, Session, AuthenticationEvent, Payment, FraudSignal, Alert, Evidence, Policy. **Default execution mode:** hybrid.

#### `fraud.identity.synthetic.detect`
- **Purpose:** Detect synthetic identity indicators.
- **Inputs:** identity/session/payment signals, device provenance and policy. `SkillInput.v1` envelope required.
- **Required context:** Party, Identity, Device, Session, AuthenticationEvent, Payment, FraudSignal, Alert, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** FraudSignal/FraudFinding and confidence; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** hybrid; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** Indicators are not proof; record false-positive considerations, model/rule version and analyst escalation.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `fraud.identity.theft.assess`
- **Purpose:** Assess identity theft.
- **Inputs:** identity/session/payment signals, device provenance and policy. `SkillInput.v1` envelope required.
- **Required context:** Party, Identity, Device, Session, AuthenticationEvent, Payment, FraudSignal, Alert, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** FraudSignal/FraudFinding and confidence; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** hybrid; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** Indicators are not proof; record false-positive considerations, model/rule version and analyst escalation.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `fraud.document.tamper.detect`
- **Purpose:** Detect document tampering.
- **Inputs:** identity/session/payment signals, device provenance and policy. `SkillInput.v1` envelope required.
- **Required context:** Party, Identity, Device, Session, AuthenticationEvent, Payment, FraudSignal, Alert, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** FraudSignal/FraudFinding and confidence; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** hybrid; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** Indicators are not proof; record false-positive considerations, model/rule version and analyst escalation.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `fraud.deepfake.detect`
- **Purpose:** Assess deepfake indicators.
- **Inputs:** identity/session/payment signals, device provenance and policy. `SkillInput.v1` envelope required.
- **Required context:** Party, Identity, Device, Session, AuthenticationEvent, Payment, FraudSignal, Alert, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** FraudSignal/FraudFinding and confidence; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** hybrid; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** Indicators are not proof; record false-positive considerations, model/rule version and analyst escalation.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `fraud.liveness.verify`
- **Purpose:** Check liveness.
- **Inputs:** identity/session/payment signals, device provenance and policy. `SkillInput.v1` envelope required.
- **Required context:** Party, Identity, Device, Session, AuthenticationEvent, Payment, FraudSignal, Alert, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** FraudSignal/FraudFinding and confidence; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** hybrid; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** Indicators are not proof; record false-positive considerations, model/rule version and analyst escalation.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `fraud.device.fingerprint`
- **Purpose:** Assess device signals.
- **Inputs:** identity/session/payment signals, device provenance and policy. `SkillInput.v1` envelope required.
- **Required context:** Party, Identity, Device, Session, AuthenticationEvent, Payment, FraudSignal, Alert, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** FraudSignal/FraudFinding and confidence; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** hybrid; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** Indicators are not proof; record false-positive considerations, model/rule version and analyst escalation.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `fraud.behavior.anomaly`
- **Purpose:** Detect anomalous user behavior.
- **Inputs:** identity/session/payment signals, device provenance and policy. `SkillInput.v1` envelope required.
- **Required context:** Party, Identity, Device, Session, AuthenticationEvent, Payment, FraudSignal, Alert, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** FraudSignal/FraudFinding and confidence; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** hybrid; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** Indicators are not proof; record false-positive considerations, model/rule version and analyst escalation.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `fraud.account_takeover.detect`
- **Purpose:** Detect takeover indicators.
- **Inputs:** identity/session/payment signals, device provenance and policy. `SkillInput.v1` envelope required.
- **Required context:** Party, Identity, Device, Session, AuthenticationEvent, Payment, FraudSignal, Alert, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** FraudSignal/FraudFinding and confidence; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** hybrid; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** Indicators are not proof; record false-positive considerations, model/rule version and analyst escalation.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `fraud.payment.anomaly`
- **Purpose:** Detect payment anomalies.
- **Inputs:** identity/session/payment signals, device provenance and policy. `SkillInput.v1` envelope required.
- **Required context:** Party, Identity, Device, Session, AuthenticationEvent, Payment, FraudSignal, Alert, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** FraudSignal/FraudFinding and confidence; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** hybrid; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** Indicators are not proof; record false-positive considerations, model/rule version and analyst escalation.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `fraud.beneficiary.risk`
- **Purpose:** Assess beneficiary risk.
- **Inputs:** identity/session/payment signals, device provenance and policy. `SkillInput.v1` envelope required.
- **Required context:** Party, Identity, Device, Session, AuthenticationEvent, Payment, FraudSignal, Alert, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** FraudSignal/FraudFinding and confidence; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** hybrid; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** Indicators are not proof; record false-positive considerations, model/rule version and analyst escalation.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `fraud.network.detect`
- **Purpose:** Detect coordinated fraud.
- **Inputs:** identity/session/payment signals, device provenance and policy. `SkillInput.v1` envelope required.
- **Required context:** Party, Identity, Device, Session, AuthenticationEvent, Payment, FraudSignal, Alert, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** FraudSignal/FraudFinding and confidence; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** hybrid; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** Indicators are not proof; record false-positive considerations, model/rule version and analyst escalation.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `fraud.case.assess`
- **Purpose:** Assess fraud case.
- **Inputs:** identity/session/payment signals, device provenance and policy. `SkillInput.v1` envelope required.
- **Required context:** Party, Identity, Device, Session, AuthenticationEvent, Payment, FraudSignal, Alert, Evidence, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** FraudSignal/FraudFinding and confidence; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** hybrid; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** Indicators are not proof; record false-positive considerations, model/rule version and analyst escalation.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.


### 15. `case.*` — 10 skills

**Default context objects:** Case, Task, WorkflowDefinition, Checkpoint, SLA, Actor, Approval, AuditEvent, Policy. **Default execution mode:** deterministic.

#### `case.create`
- **Purpose:** Create canonical case.
- **Inputs:** subject canonical references, as-of timestamp, purpose and policy snapshot. `SkillInput.v1` envelope required.
- **Required context:** Case, Task, WorkflowDefinition, Checkpoint, SLA, Actor, Approval, AuditEvent, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** typed canonical result and evidence-backed Finding/Status; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** deterministic; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** Enforce state-machine transitions, separation of duties, approval authority, policy snapshot and immutable audit trail.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `case.context.hydrate`
- **Purpose:** Hydrate governed case context.
- **Inputs:** subject canonical references, as-of timestamp, purpose and policy snapshot. `SkillInput.v1` envelope required.
- **Required context:** Case, Task, WorkflowDefinition, Checkpoint, SLA, Actor, Approval, AuditEvent, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** typed canonical result and evidence-backed Finding/Status; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** deterministic; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** Enforce state-machine transitions, separation of duties, approval authority, policy snapshot and immutable audit trail.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `case.tasks.plan`
- **Purpose:** Plan required tasks.
- **Inputs:** subject canonical references, as-of timestamp, purpose and policy snapshot. `SkillInput.v1` envelope required.
- **Required context:** Case, Task, WorkflowDefinition, Checkpoint, SLA, Actor, Approval, AuditEvent, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** typed canonical result and evidence-backed Finding/Status; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** deterministic; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** Enforce state-machine transitions, separation of duties, approval authority, policy snapshot and immutable audit trail.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `case.tasks.assign`
- **Purpose:** Assign tasks.
- **Inputs:** subject canonical references, as-of timestamp, purpose and policy snapshot. `SkillInput.v1` envelope required.
- **Required context:** Case, Task, WorkflowDefinition, Checkpoint, SLA, Actor, Approval, AuditEvent, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** typed canonical result and evidence-backed Finding/Status; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** deterministic; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** Enforce state-machine transitions, separation of duties, approval authority, policy snapshot and immutable audit trail.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `case.state.transition`
- **Purpose:** Apply permitted state transition.
- **Inputs:** subject canonical references, as-of timestamp, purpose and policy snapshot. `SkillInput.v1` envelope required.
- **Required context:** Case, Task, WorkflowDefinition, Checkpoint, SLA, Actor, Approval, AuditEvent, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** typed canonical result and evidence-backed Finding/Status; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** deterministic; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** Enforce state-machine transitions, separation of duties, approval authority, policy snapshot and immutable audit trail.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `case.dependencies.evaluate`
- **Purpose:** Evaluate task dependencies.
- **Inputs:** subject canonical references, as-of timestamp, purpose and policy snapshot. `SkillInput.v1` envelope required.
- **Required context:** Case, Task, WorkflowDefinition, Checkpoint, SLA, Actor, Approval, AuditEvent, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** typed canonical result and evidence-backed Finding/Status; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** deterministic; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** Enforce state-machine transitions, separation of duties, approval authority, policy snapshot and immutable audit trail.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `case.sla.monitor`
- **Purpose:** Monitor SLAs.
- **Inputs:** subject canonical references, as-of timestamp, purpose and policy snapshot. `SkillInput.v1` envelope required.
- **Required context:** Case, Task, WorkflowDefinition, Checkpoint, SLA, Actor, Approval, AuditEvent, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** typed canonical result and evidence-backed Finding/Status; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** deterministic; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** Enforce state-machine transitions, separation of duties, approval authority, policy snapshot and immutable audit trail.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `case.escalate`
- **Purpose:** Escalate case.
- **Inputs:** subject canonical references, as-of timestamp, purpose and policy snapshot. `SkillInput.v1` envelope required.
- **Required context:** Case, Task, WorkflowDefinition, Checkpoint, SLA, Actor, Approval, AuditEvent, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** typed canonical result and evidence-backed Finding/Status; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** deterministic; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** Enforce state-machine transitions, separation of duties, approval authority, policy snapshot and immutable audit trail.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `case.summary.generate`
- **Purpose:** Summarize case.
- **Inputs:** subject canonical references, as-of timestamp, purpose and policy snapshot. `SkillInput.v1` envelope required.
- **Required context:** Case, Task, WorkflowDefinition, Checkpoint, SLA, Actor, Approval, AuditEvent, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** typed canonical result and evidence-backed Finding/Status; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** deterministic; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** Enforce state-machine transitions, separation of duties, approval authority, policy snapshot and immutable audit trail.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `case.close`
- **Purpose:** Close case after controls.
- **Inputs:** subject canonical references, as-of timestamp, purpose and policy snapshot. `SkillInput.v1` envelope required.
- **Required context:** Case, Task, WorkflowDefinition, Checkpoint, SLA, Actor, Approval, AuditEvent, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** typed canonical result and evidence-backed Finding/Status; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** deterministic; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** Enforce state-machine transitions, separation of duties, approval authority, policy snapshot and immutable audit trail.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.


### 16. `decision.*` — 12 skills

**Default context objects:** Policy, Requirement, Control, Finding, RiskAssessment, Decision, Approval, Exception, Evidence. **Default execution mode:** deterministic.

#### `decision.policy.resolve`
- **Purpose:** Resolve policy version.
- **Inputs:** case findings, policy snapshot, approvals and actor authorization. `SkillInput.v1` envelope required.
- **Required context:** Policy, Requirement, Control, Finding, RiskAssessment, Decision, Approval, Exception, Evidence; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** ControlEvaluation/DecisionRecommendation or authorized Decision; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** deterministic; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** Enforce state-machine transitions, separation of duties, approval authority, policy snapshot and immutable audit trail.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `decision.requirements.compile`
- **Purpose:** Compile required controls.
- **Inputs:** case findings, policy snapshot, approvals and actor authorization. `SkillInput.v1` envelope required.
- **Required context:** Policy, Requirement, Control, Finding, RiskAssessment, Decision, Approval, Exception, Evidence; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** ControlEvaluation/DecisionRecommendation or authorized Decision; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** deterministic; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** Enforce state-machine transitions, separation of duties, approval authority, policy snapshot and immutable audit trail.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `decision.rules.evaluate`
- **Purpose:** Execute deterministic rules.
- **Inputs:** case findings, policy snapshot, approvals and actor authorization. `SkillInput.v1` envelope required.
- **Required context:** Policy, Requirement, Control, Finding, RiskAssessment, Decision, Approval, Exception, Evidence; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** ControlEvaluation/DecisionRecommendation or authorized Decision; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** deterministic; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** Enforce state-machine transitions, separation of duties, approval authority, policy snapshot and immutable audit trail.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `decision.exceptions.evaluate`
- **Purpose:** Evaluate authorized exceptions.
- **Inputs:** case findings, policy snapshot, approvals and actor authorization. `SkillInput.v1` envelope required.
- **Required context:** Policy, Requirement, Control, Finding, RiskAssessment, Decision, Approval, Exception, Evidence; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** ControlEvaluation/DecisionRecommendation or authorized Decision; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** deterministic; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** Enforce state-machine transitions, separation of duties, approval authority, policy snapshot and immutable audit trail.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `decision.gaps.evaluate`
- **Purpose:** Find unmet obligations.
- **Inputs:** case findings, policy snapshot, approvals and actor authorization. `SkillInput.v1` envelope required.
- **Required context:** Policy, Requirement, Control, Finding, RiskAssessment, Decision, Approval, Exception, Evidence; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** ControlEvaluation/DecisionRecommendation or authorized Decision; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** deterministic; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** Enforce state-machine transitions, separation of duties, approval authority, policy snapshot and immutable audit trail.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `decision.risk.acceptance.evaluate`
- **Purpose:** Evaluate risk acceptance criteria.
- **Inputs:** case findings, policy snapshot, approvals and actor authorization. `SkillInput.v1` envelope required.
- **Required context:** Policy, Requirement, Control, Finding, RiskAssessment, Decision, Approval, Exception, Evidence; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** ControlEvaluation/DecisionRecommendation or authorized Decision; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** deterministic; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** Enforce state-machine transitions, separation of duties, approval authority, policy snapshot and immutable audit trail.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `decision.recommendation.generate`
- **Purpose:** Generate decision recommendation.
- **Inputs:** case findings, policy snapshot, approvals and actor authorization. `SkillInput.v1` envelope required.
- **Required context:** Policy, Requirement, Control, Finding, RiskAssessment, Decision, Approval, Exception, Evidence; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** ControlEvaluation/DecisionRecommendation or authorized Decision; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** deterministic; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** Enforce state-machine transitions, separation of duties, approval authority, policy snapshot and immutable audit trail.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `decision.approval.route`
- **Purpose:** Route authorized approval.
- **Inputs:** case findings, policy snapshot, approvals and actor authorization. `SkillInput.v1` envelope required.
- **Required context:** Policy, Requirement, Control, Finding, RiskAssessment, Decision, Approval, Exception, Evidence; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** ControlEvaluation/DecisionRecommendation or authorized Decision; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** deterministic; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** Enforce state-machine transitions, separation of duties, approval authority, policy snapshot and immutable audit trail.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `decision.human.review`
- **Purpose:** Capture human review.
- **Inputs:** case findings, policy snapshot, approvals and actor authorization. `SkillInput.v1` envelope required.
- **Required context:** Policy, Requirement, Control, Finding, RiskAssessment, Decision, Approval, Exception, Evidence; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** ControlEvaluation/DecisionRecommendation or authorized Decision; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** human-gated; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** Enforce state-machine transitions, separation of duties, approval authority, policy snapshot and immutable audit trail.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `decision.disposition.record`
- **Purpose:** Record disposition.
- **Inputs:** case findings, policy snapshot, approvals and actor authorization. `SkillInput.v1` envelope required.
- **Required context:** Policy, Requirement, Control, Finding, RiskAssessment, Decision, Approval, Exception, Evidence; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** ControlEvaluation/DecisionRecommendation or authorized Decision; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** human-gated; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** Enforce state-machine transitions, separation of duties, approval authority, policy snapshot and immutable audit trail.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `decision.explain`
- **Purpose:** Explain decision and evidence.
- **Inputs:** case findings, policy snapshot, approvals and actor authorization. `SkillInput.v1` envelope required.
- **Required context:** Policy, Requirement, Control, Finding, RiskAssessment, Decision, Approval, Exception, Evidence; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** ControlEvaluation/DecisionRecommendation or authorized Decision; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** deterministic; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** Enforce state-machine transitions, separation of duties, approval authority, policy snapshot and immutable audit trail.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `decision.audit.verify`
- **Purpose:** Verify decision audit trail.
- **Inputs:** case findings, policy snapshot, approvals and actor authorization. `SkillInput.v1` envelope required.
- **Required context:** Policy, Requirement, Control, Finding, RiskAssessment, Decision, Approval, Exception, Evidence; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** ControlEvaluation/DecisionRecommendation or authorized Decision; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** deterministic; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** Enforce state-machine transitions, separation of duties, approval authority, policy snapshot and immutable audit trail.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.


### 17. `monitor.*` — 10 skills

**Default context objects:** Party, MonitoringPlan, ReviewTrigger, Event, RiskAssessment, ScreeningHit, Case, Policy. **Default execution mode:** deterministic.

#### `monitor.customer.schedule`
- **Purpose:** Schedule periodic review.
- **Inputs:** subject canonical references, as-of timestamp, purpose and policy snapshot. `SkillInput.v1` envelope required.
- **Required context:** Party, MonitoringPlan, ReviewTrigger, Event, RiskAssessment, ScreeningHit, Case, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** typed canonical result and evidence-backed Finding/Status; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** deterministic; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `monitor.trigger.evaluate`
- **Purpose:** Evaluate event triggers.
- **Inputs:** subject canonical references, as-of timestamp, purpose and policy snapshot. `SkillInput.v1` envelope required.
- **Required context:** Party, MonitoringPlan, ReviewTrigger, Event, RiskAssessment, ScreeningHit, Case, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** typed canonical result and evidence-backed Finding/Status; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** deterministic; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `monitor.profile.change`
- **Purpose:** Detect profile changes.
- **Inputs:** subject canonical references, as-of timestamp, purpose and policy snapshot. `SkillInput.v1` envelope required.
- **Required context:** Party, MonitoringPlan, ReviewTrigger, Event, RiskAssessment, ScreeningHit, Case, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** typed canonical result and evidence-backed Finding/Status; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** deterministic; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `monitor.ownership.change`
- **Purpose:** Detect ownership changes.
- **Inputs:** subject canonical references, as-of timestamp, purpose and policy snapshot. `SkillInput.v1` envelope required.
- **Required context:** Party, MonitoringPlan, ReviewTrigger, Event, RiskAssessment, ScreeningHit, Case, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** typed canonical result and evidence-backed Finding/Status; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** deterministic; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `monitor.screening.refresh`
- **Purpose:** Refresh screening.
- **Inputs:** subject canonical references, as-of timestamp, purpose and policy snapshot. `SkillInput.v1` envelope required.
- **Required context:** Party, MonitoringPlan, ReviewTrigger, Event, RiskAssessment, ScreeningHit, Case, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** typed canonical result and evidence-backed Finding/Status; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** deterministic; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `monitor.transaction.deviation`
- **Purpose:** Detect behavioral deviations.
- **Inputs:** subject canonical references, as-of timestamp, purpose and policy snapshot. `SkillInput.v1` envelope required.
- **Required context:** Party, MonitoringPlan, ReviewTrigger, Event, RiskAssessment, ScreeningHit, Case, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** typed canonical result and evidence-backed Finding/Status; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** deterministic; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `monitor.risk.recalculate`
- **Purpose:** Recalculate risk.
- **Inputs:** subject canonical references, as-of timestamp, purpose and policy snapshot. `SkillInput.v1` envelope required.
- **Required context:** Party, MonitoringPlan, ReviewTrigger, Event, RiskAssessment, ScreeningHit, Case, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** typed canonical result and evidence-backed Finding/Status; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** deterministic; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `monitor.review.scope`
- **Purpose:** Scope review.
- **Inputs:** subject canonical references, as-of timestamp, purpose and policy snapshot. `SkillInput.v1` envelope required.
- **Required context:** Party, MonitoringPlan, ReviewTrigger, Event, RiskAssessment, ScreeningHit, Case, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** typed canonical result and evidence-backed Finding/Status; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** deterministic; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `monitor.review.execute`
- **Purpose:** Execute review.
- **Inputs:** subject canonical references, as-of timestamp, purpose and policy snapshot. `SkillInput.v1` envelope required.
- **Required context:** Party, MonitoringPlan, ReviewTrigger, Event, RiskAssessment, ScreeningHit, Case, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** typed canonical result and evidence-backed Finding/Status; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** deterministic; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `monitor.review.close`
- **Purpose:** Close completed review.
- **Inputs:** subject canonical references, as-of timestamp, purpose and policy snapshot. `SkillInput.v1` envelope required.
- **Required context:** Party, MonitoringPlan, ReviewTrigger, Event, RiskAssessment, ScreeningHit, Case, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** typed canonical result and evidence-backed Finding/Status; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** deterministic; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.


### 18. `regulatory.*` — 10 skills

**Default context objects:** Jurisdiction, Obligation, Filing, Case, Investigation, Transaction, Evidence, Approval, Policy. **Default execution mode:** human-gated.

#### `regulatory.obligations.resolve`
- **Purpose:** Resolve reporting obligations.
- **Inputs:** jurisdiction, reportable activity, filing type and policy deadlines. `SkillInput.v1` envelope required.
- **Required context:** Jurisdiction, Obligation, Filing, Case, Investigation, Transaction, Evidence, Approval, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** ObligationAssessment/FilingPackage or submission receipt; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** human-gated; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** Enforce state-machine transitions, separation of duties, approval authority, policy snapshot and immutable audit trail.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `regulatory.sar.evaluate`
- **Purpose:** Evaluate potential SAR obligation.
- **Inputs:** jurisdiction, reportable activity, filing type and policy deadlines. `SkillInput.v1` envelope required.
- **Required context:** Jurisdiction, Obligation, Filing, Case, Investigation, Transaction, Evidence, Approval, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** ObligationAssessment/FilingPackage or submission receipt; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** deterministic; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** Enforce state-machine transitions, separation of duties, approval authority, policy snapshot and immutable audit trail.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `regulatory.sar.draft`
- **Purpose:** Draft SAR narrative.
- **Inputs:** jurisdiction, reportable activity, filing type and policy deadlines. `SkillInput.v1` envelope required.
- **Required context:** Jurisdiction, Obligation, Filing, Case, Investigation, Transaction, Evidence, Approval, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** ObligationAssessment/FilingPackage or submission receipt; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** human-gated; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** Enforce state-machine transitions, separation of duties, approval authority, policy snapshot and immutable audit trail.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `regulatory.sar.validate`
- **Purpose:** Validate SAR package.
- **Inputs:** jurisdiction, reportable activity, filing type and policy deadlines. `SkillInput.v1` envelope required.
- **Required context:** Jurisdiction, Obligation, Filing, Case, Investigation, Transaction, Evidence, Approval, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** ObligationAssessment/FilingPackage or submission receipt; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** deterministic; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** Enforce state-machine transitions, separation of duties, approval authority, policy snapshot and immutable audit trail.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `regulatory.ctr.evaluate`
- **Purpose:** Evaluate CTR requirement.
- **Inputs:** jurisdiction, reportable activity, filing type and policy deadlines. `SkillInput.v1` envelope required.
- **Required context:** Jurisdiction, Obligation, Filing, Case, Investigation, Transaction, Evidence, Approval, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** ObligationAssessment/FilingPackage or submission receipt; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** deterministic; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** Enforce state-machine transitions, separation of duties, approval authority, policy snapshot and immutable audit trail.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `regulatory.ctr.prepare`
- **Purpose:** Prepare CTR data.
- **Inputs:** jurisdiction, reportable activity, filing type and policy deadlines. `SkillInput.v1` envelope required.
- **Required context:** Jurisdiction, Obligation, Filing, Case, Investigation, Transaction, Evidence, Approval, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** ObligationAssessment/FilingPackage or submission receipt; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** human-gated; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** Enforce state-machine transitions, separation of duties, approval authority, policy snapshot and immutable audit trail.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `regulatory.deadline.calculate`
- **Purpose:** Calculate regulatory deadlines.
- **Inputs:** jurisdiction, reportable activity, filing type and policy deadlines. `SkillInput.v1` envelope required.
- **Required context:** Jurisdiction, Obligation, Filing, Case, Investigation, Transaction, Evidence, Approval, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** ObligationAssessment/FilingPackage or submission receipt; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** deterministic; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** Enforce state-machine transitions, separation of duties, approval authority, policy snapshot and immutable audit trail.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `regulatory.filing.prepare`
- **Purpose:** Prepare filing.
- **Inputs:** jurisdiction, reportable activity, filing type and policy deadlines. `SkillInput.v1` envelope required.
- **Required context:** Jurisdiction, Obligation, Filing, Case, Investigation, Transaction, Evidence, Approval, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** ObligationAssessment/FilingPackage or submission receipt; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** human-gated; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** Enforce state-machine transitions, separation of duties, approval authority, policy snapshot and immutable audit trail.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `regulatory.filing.submit`
- **Purpose:** Submit authorized filing.
- **Inputs:** jurisdiction, reportable activity, filing type and policy deadlines. `SkillInput.v1` envelope required.
- **Required context:** Jurisdiction, Obligation, Filing, Case, Investigation, Transaction, Evidence, Approval, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** ObligationAssessment/FilingPackage or submission receipt; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** human-gated; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** Enforce state-machine transitions, separation of duties, approval authority, policy snapshot and immutable audit trail.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `regulatory.filing.track`
- **Purpose:** Track filing status.
- **Inputs:** jurisdiction, reportable activity, filing type and policy deadlines. `SkillInput.v1` envelope required.
- **Required context:** Jurisdiction, Obligation, Filing, Case, Investigation, Transaction, Evidence, Approval, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** ObligationAssessment/FilingPackage or submission receipt; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** deterministic; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** Enforce state-machine transitions, separation of duties, approval authority, policy snapshot and immutable audit trail.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.


### 19. `evidence.*` — 10 skills

**Default context objects:** Evidence, SourceRecord, Assertion, Fact, Finding, Provenance, Conflict, RetentionRule, Policy. **Default execution mode:** hybrid.

#### `evidence.collect`
- **Purpose:** Collect authorized evidence.
- **Inputs:** subject canonical references, as-of timestamp, purpose and policy snapshot. `SkillInput.v1` envelope required.
- **Required context:** Evidence, SourceRecord, Assertion, Fact, Finding, Provenance, Conflict, RetentionRule, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** typed canonical result and evidence-backed Finding/Status; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** hybrid; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `evidence.normalize`
- **Purpose:** Normalize evidence metadata.
- **Inputs:** subject canonical references, as-of timestamp, purpose and policy snapshot. `SkillInput.v1` envelope required.
- **Required context:** Evidence, SourceRecord, Assertion, Fact, Finding, Provenance, Conflict, RetentionRule, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** typed canonical result and evidence-backed Finding/Status; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** deterministic; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `evidence.provenance.attach`
- **Purpose:** Attach provenance.
- **Inputs:** subject canonical references, as-of timestamp, purpose and policy snapshot. `SkillInput.v1` envelope required.
- **Required context:** Evidence, SourceRecord, Assertion, Fact, Finding, Provenance, Conflict, RetentionRule, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** typed canonical result and evidence-backed Finding/Status; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** hybrid; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `evidence.integrity.verify`
- **Purpose:** Verify evidence integrity.
- **Inputs:** subject canonical references, as-of timestamp, purpose and policy snapshot. `SkillInput.v1` envelope required.
- **Required context:** Evidence, SourceRecord, Assertion, Fact, Finding, Provenance, Conflict, RetentionRule, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** typed canonical result and evidence-backed Finding/Status; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** deterministic; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `evidence.facts.extract`
- **Purpose:** Extract factual assertions.
- **Inputs:** subject canonical references, as-of timestamp, purpose and policy snapshot. `SkillInput.v1` envelope required.
- **Required context:** Evidence, SourceRecord, Assertion, Fact, Finding, Provenance, Conflict, RetentionRule, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** typed canonical result and evidence-backed Finding/Status; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** hybrid; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `evidence.conflicts.resolve`
- **Purpose:** Reconcile conflicts.
- **Inputs:** subject canonical references, as-of timestamp, purpose and policy snapshot. `SkillInput.v1` envelope required.
- **Required context:** Evidence, SourceRecord, Assertion, Fact, Finding, Provenance, Conflict, RetentionRule, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** typed canonical result and evidence-backed Finding/Status; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** hybrid; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `evidence.sufficiency.assess`
- **Purpose:** Assess evidence sufficiency.
- **Inputs:** subject canonical references, as-of timestamp, purpose and policy snapshot. `SkillInput.v1` envelope required.
- **Required context:** Evidence, SourceRecord, Assertion, Fact, Finding, Provenance, Conflict, RetentionRule, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** typed canonical result and evidence-backed Finding/Status; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** hybrid; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `evidence.lineage.trace`
- **Purpose:** Trace findings to sources.
- **Inputs:** subject canonical references, as-of timestamp, purpose and policy snapshot. `SkillInput.v1` envelope required.
- **Required context:** Evidence, SourceRecord, Assertion, Fact, Finding, Provenance, Conflict, RetentionRule, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** typed canonical result and evidence-backed Finding/Status; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** hybrid; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `evidence.bundle.compile`
- **Purpose:** Compile immutable evidence bundle.
- **Inputs:** subject canonical references, as-of timestamp, purpose and policy snapshot. `SkillInput.v1` envelope required.
- **Required context:** Evidence, SourceRecord, Assertion, Fact, Finding, Provenance, Conflict, RetentionRule, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** typed canonical result and evidence-backed Finding/Status; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** deterministic; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `evidence.retention.enforce`
- **Purpose:** Enforce retention and legal holds.
- **Inputs:** subject canonical references, as-of timestamp, purpose and policy snapshot. `SkillInput.v1` envelope required.
- **Required context:** Evidence, SourceRecord, Assertion, Fact, Finding, Provenance, Conflict, RetentionRule, Policy; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** typed canonical result and evidence-backed Finding/Status; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** deterministic; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.


### 20. `quality.*` — 10 skills

**Default context objects:** SkillExecution, EvaluationCase, ExpectedOutcome, Finding, Evidence, AuditEvent, Policy, ModelVersion. **Default execution mode:** deterministic.

#### `quality.data.validate`
- **Purpose:** Validate data quality.
- **Inputs:** subject canonical references, as-of timestamp, purpose and policy snapshot. `SkillInput.v1` envelope required.
- **Required context:** SkillExecution, EvaluationCase, ExpectedOutcome, Finding, Evidence, AuditEvent, Policy, ModelVersion; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** typed canonical result and evidence-backed Finding/Status; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** deterministic; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `quality.schema.validate`
- **Purpose:** Validate canonical schemas.
- **Inputs:** subject canonical references, as-of timestamp, purpose and policy snapshot. `SkillInput.v1` envelope required.
- **Required context:** SkillExecution, EvaluationCase, ExpectedOutcome, Finding, Evidence, AuditEvent, Policy, ModelVersion; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** typed canonical result and evidence-backed Finding/Status; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** deterministic; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `quality.findings.verify`
- **Purpose:** Verify findings against sources.
- **Inputs:** subject canonical references, as-of timestamp, purpose and policy snapshot. `SkillInput.v1` envelope required.
- **Required context:** SkillExecution, EvaluationCase, ExpectedOutcome, Finding, Evidence, AuditEvent, Policy, ModelVersion; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** typed canonical result and evidence-backed Finding/Status; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** deterministic; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `quality.hallucination.detect`
- **Purpose:** Detect unsupported assertions.
- **Inputs:** subject canonical references, as-of timestamp, purpose and policy snapshot. `SkillInput.v1` envelope required.
- **Required context:** SkillExecution, EvaluationCase, ExpectedOutcome, Finding, Evidence, AuditEvent, Policy, ModelVersion; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** typed canonical result and evidence-backed Finding/Status; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** deterministic; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `quality.policy.compliance`
- **Purpose:** Verify control compliance.
- **Inputs:** subject canonical references, as-of timestamp, purpose and policy snapshot. `SkillInput.v1` envelope required.
- **Required context:** SkillExecution, EvaluationCase, ExpectedOutcome, Finding, Evidence, AuditEvent, Policy, ModelVersion; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** typed canonical result and evidence-backed Finding/Status; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** deterministic; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `quality.coverage.assess`
- **Purpose:** Assess coverage.
- **Inputs:** subject canonical references, as-of timestamp, purpose and policy snapshot. `SkillInput.v1` envelope required.
- **Required context:** SkillExecution, EvaluationCase, ExpectedOutcome, Finding, Evidence, AuditEvent, Policy, ModelVersion; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** typed canonical result and evidence-backed Finding/Status; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** deterministic; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `quality.confidence.calibrate`
- **Purpose:** Calibrate confidence.
- **Inputs:** subject canonical references, as-of timestamp, purpose and policy snapshot. `SkillInput.v1` envelope required.
- **Required context:** SkillExecution, EvaluationCase, ExpectedOutcome, Finding, Evidence, AuditEvent, Policy, ModelVersion; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** typed canonical result and evidence-backed Finding/Status; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** deterministic; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `quality.agent.trace.evaluate`
- **Purpose:** Evaluate execution traces.
- **Inputs:** subject canonical references, as-of timestamp, purpose and policy snapshot. `SkillInput.v1` envelope required.
- **Required context:** SkillExecution, EvaluationCase, ExpectedOutcome, Finding, Evidence, AuditEvent, Policy, ModelVersion; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** typed canonical result and evidence-backed Finding/Status; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** deterministic; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `quality.outcome.reconcile`
- **Purpose:** Reconcile expected and observed outcomes.
- **Inputs:** subject canonical references, as-of timestamp, purpose and policy snapshot. `SkillInput.v1` envelope required.
- **Required context:** SkillExecution, EvaluationCase, ExpectedOutcome, Finding, Evidence, AuditEvent, Policy, ModelVersion; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** typed canonical result and evidence-backed Finding/Status; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** deterministic; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.

#### `quality.remediation.plan`
- **Purpose:** Plan remediation.
- **Inputs:** subject canonical references, as-of timestamp, purpose and policy snapshot. `SkillInput.v1` envelope required.
- **Required context:** SkillExecution, EvaluationCase, ExpectedOutcome, Finding, Evidence, AuditEvent, Policy, ModelVersion; scoped to subject, purpose and time. Missing mandatory fields produce `NEEDS_EVIDENCE` or `BLOCKED`.
- **Outputs:** typed canonical result and evidence-backed Finding/Status; typed `SkillResult.v1` envelope, evidence refs, uncertainty and trace.
- **Execution:** deterministic; composition may invoke registry skills and authorized provider capabilities; side effects only through explicit permissions.
- **Controls:** No unauthorized writes; validate policy scope, temporal freshness, entitlement and source coverage.
- **Evidence:** Source references and extraction/calculation trace; explicit unresolved gaps and negative search scope when applicable.
- **Acceptance:** Golden positive, negative, ambiguous and stale-source fixtures; deterministic schema/provenance checks; unauthorized-access and transient-failure tests.


## 6. Critical composite skill specifications

### 6.1 `entity.resolve`
Input: raw names, identifiers, addresses, entity type hints, country, date. Hydrate aliases, source-record lineage, prior candidate entities, identity identifiers, temporal name changes and resolution policy. Pipeline: normalize → candidate retrieval (exact/fuzzy/vector as allowed) → deterministic identifier comparison → probabilistic scoring → contradiction analysis → match/disambiguate → stable entity ref or unresolved candidate set. Never merge on name alone. Return match explanations, scores, source lineage and false-merge risk. Human review for high-impact uncertain merges.

### 6.2 `ownership.ubo.resolve`
Input: corporate entity, as-of date, policy/jurisdiction, ownership threshold, control rules. Hydrate complete direct/indirect ownership and voting edges, trust/nominee relationships, registry filings, declared UBOs, temporal snapshots and source quality. Build graph, detect cycles, enumerate paths, compute effective percentages with explicit math and rounding, aggregate relevant interests, evaluate non-equity control, identify individuals, verify identities, flag opaque/unresolved paths. Output graph, paths, computations, candidate/verified UBOs, exceptions and evidence. Do not universally apply a 25% threshold or collapse OFAC/UK/EU control rules.

### 6.3 `screening.sanctions.execute`
Input: party/entity refs, aliases, jurisdiction, sanctions programs, screening purpose and list as-of time. Hydrate approved watchlist snapshots, list identifiers, ownership graph, alias transliteration, country/date-of-birth data, matching policy and disposition history. Normalize, generate candidates, score, corroborate identifiers, apply jurisdictional ownership/control evaluation, create hits and recommended review status. Block automatic clearance of unresolved potential true matches; preserve provider/list version and timestamps.

### 6.4 `risk.customer.assess`
Input: party, jurisdiction, product scope, factor/model version. Hydrate entity/party profile, UBO, screening, expected behavior, geographic and industry exposures, transaction patterns, existing findings, previous assessments and risk policy. Calculate factor scores with deterministic model, handle missing data as unknown, evaluate override/EDD triggers, explain each contribution, compare previous score. Return versioned risk assessment with factor provenance and recommended tier, not unapproved final acceptance.

### 6.5 `case.context.hydrate`
Input: case/task/skill, requested object types, time horizon, purpose, budget. Resolve authorization and policy; assemble canonical graph slices, structured document excerpts, vector-retrieved evidence, negative knowledge and latest facts; deduplicate and rank by authority/freshness; redact unnecessary PII; preserve stable refs and token allocation; emit manifest/hash and unresolved source gaps. Do not silently add external tools or expand entitlements.

### 6.6 `investigation.findings.synthesize`
Input: case, hypotheses, evidence refs, required investigative questions. Hydrate transactions, timeline, graph, alerts, prior findings, contradictory and exculpatory evidence, negative searches, policy and typology rules. Generate claim-evidence matrix, separate observations from inference, identify gaps, draft alternative explanations, flag unsupported statements and return findings for QA/human review.

### 6.7 `decision.rules.evaluate`
Input: canonical facts/findings, requirement set, policy snapshot and decision context. Execute versioned deterministic rules, distinguish PASS/FAIL/UNKNOWN/NOT_APPLICABLE, record input hashes, rule IDs, source lineage, reason codes and blocking obligations. No model-generated policy overrides; human exceptions require explicit authority and audit.

### 6.8 `regulatory.sar.draft` / `regulatory.filing.submit`
Draft uses verified case facts, transaction chronology, subject identifiers, filing instructions and evidence links; performs narrative completeness and contradiction checks, and marks unverified allegations. Submit is a separate, permissioned, human-gated side-effecting operation using approved regulator interfaces, dual control where required, idempotency key, receipt tracking, deadline handling, confidentiality and jurisdiction-specific obligations. Never infer filing from an AML typology hit alone.

## 7. Workflow compositions

### 7.1 Corporate KYB onboarding
`case.create → decision.policy.resolve → decision.requirements.compile → [entity.resolve, registry.company.verify, document.fields.extract, party.profile.build] → ownership.graph.build → ownership.ubo.resolve → ownership.ubo.verify → [screening.sanctions.execute, screening.pep.execute, screening.adverse_media.execute] → risk.customer.assess → edd.trigger.evaluate → (conditional EDD) → evidence.sufficiency.assess → quality.findings.verify → decision.rules.evaluate → decision.approval.route → decision.disposition.record → monitor.customer.schedule`.

### 7.2 Individual KYC onboarding
`case.create → entity.resolve → entity.identity.verify → document.authenticity.assess → party.profile.build → screening.* → risk.customer.assess → decision.requirements.compile → evidence.sufficiency.assess → decision.rules.evaluate → approval/disposition`.

### 7.3 Periodic review / event-driven refresh
`monitor.trigger.evaluate → case.create → case.context.hydrate → party.profile.refresh → ownership.history.compare → screening.rescreen.schedule → transaction.baseline.compare → risk.change.detect → monitor.risk.recalculate → decision.rules.evaluate → review/approval`.

### 7.4 Transaction monitoring to AML investigation
`transaction.ingest → transaction.enrich → aml.typology.match → alert.ingest → alert.correlate → alert.prioritize → investigation.plan → investigation.evidence.collect → transaction.flow.trace → network.graph.build → investigation.hypothesis.test → investigation.findings.synthesize → quality.findings.verify → regulatory.sar.evaluate → human review → regulatory.sar.draft/validate → authorized filing or closure`.

### 7.5 Sanctions alert
`screening.sanctions.execute → screening.match.disambiguate → ownership.graph.expand → screening.sanctions.ownership.evaluate → screening.sanctions.control.evaluate → alert.escalation.evaluate → decision.rules.evaluate → human review → authorized hold/block/release/record per applicable rules`.

### 7.6 Fraud / CIAM high-risk identity
`fraud.device.fingerprint → fraud.liveness.verify → fraud.deepfake.detect → fraud.identity.synthetic.detect → fraud.behavior.anomaly → fraud.case.assess → alert.prioritize → decision.rules.evaluate → human authorization or step-up control`.

## 8. LangGraph integration and runtime

- Define one LangGraph `StateGraph` per workflow template; nodes invoke skills by registry ID, not vendor API names.
- State stores canonical refs, completed skill results, pending requirements, policy snapshot, correlation IDs and errors; not unbounded source text.
- Durable checkpointer enables replay/recovery. Interrupt before approvals, exceptions, filings and consequential case mutations.
- Parallel branches for registry/ownership/screening with joins guarded by evidence sufficiency; avoid race conditions by append-only results and canonical case-store compare-and-swap.
- Async execution with bounded concurrency, per-provider rate limits, circuit breakers, timeouts, retries and idempotency. Provider fallback only when policy permits equivalent coverage.
- Strict Pydantic schemas and validated tool calls; deterministic JSON parser/repair boundaries; no silent schema coercion.
- Context budget assembler allocates system instructions, task spec, canonical facts, evidence excerpts, tool schemas and working scratchpad; scratchpad/episodic/semantic memory separated from authoritative facts.
- Every run emits event trace (`planned`, `context_hydrated`, `skill_started`, `provider_called`, `skill_completed`, `control_evaluated`, `human_interrupted`, `resumed`, `decision_recorded`).
- Canonical case store is the authoritative head; agents remain stateless between invocations except through durable orchestrator state and explicit context hydration.

## 9. Capability registry and resolver

Map each business skill to permitted implementations: deterministic Python/rules engine, SQL/graph query, document parser, retrieval provider, model-assisted analyzer, human task or composite subgraph. Resolver inputs: tenant, policy, jurisdiction, entitlement, freshness, provider coverage, latency, cost, sensitivity, execution health. Resolver output: selected implementation ID/version, reason, fallback policy and constraints. Never downgrade sanctions coverage, legal obligations or authorization to optimize cost.

Sample:
```yaml
skill_id: screening.sanctions.execute
implementation_candidates:
  - id: internal-watchlist-v2
    mode: deterministic
    coverage: [configured_regimes]
  - id: external-screening-adapter-v1
    mode: retrieval
    coverage: [contracted_regimes]
resolution_constraints:
  require_entitlement: true
  require_list_freshness: true
  require_jurisdiction_coverage: true
  log_selected_implementation: true
```

## 10. Governance, security, privacy and regulatory caveats

Apply least privilege, purpose limitation, source license constraints, retention, encryption, PII redaction, tenant isolation, regional data residency, separation of duties, immutable logs and access recertification. Legal/regulatory requirements vary by jurisdiction, institution and effective date; all sanctions aggregation/control, UBO, CDD, SAR/CTR, FATCA/CRS and record retention rules must be supplied as versioned jurisdiction packs and reviewed by compliance counsel. Deepfake detection, adverse media and inferred relationships must not be treated as infallible. Provide appeal/review pathways, model risk oversight and fairness testing where applicable.

## 11. Test strategy and acceptance gates

- **Contract tests:** schema, required context, output semantics, version migration and backward compatibility.
- **Golden cases:** simple, nested, circular, nominee and opaque UBO; sanctions name collisions; PEP relatives; adverse media duplicates; false-positive alert; suspicious fund flow; missing documents; stale provider; cross-border conflicting policies.
- **Property tests:** ownership sums and path aggregation; time-travel correctness; idempotency; no unauthorized state transition; unknown != pass; evidence claim must have provenance.
- **Failure injection:** timeout, rate limit, source outage, partial document extraction, graph cycle, duplicate callback, interrupted approval, checkpoint restart, conflicting evidence, stale list.
- **Security tests:** entitlement denial, prompt injection in retrieved documents, provider payload contamination, PII exfiltration, cross-tenant leakage, tool misuse.
- **Operational SLOs:** measure p50/p95 latency, cost per case, coverage, human touches, error/retry rates, checkpoint recovery and reproducibility; set numeric targets only after baseline measurements.
- **Release gates:** zero unauthorized final decisions, zero untraced material findings in golden fixtures, no uncontrolled side effects, full replayability of critical decisions, human approval for filing actions.

## 12. Delivery roadmap

**Phase 0 — Canonical foundation:** ontology, temporal graph, evidence/epistemic types, policy snapshots, registry schemas, context compiler, auth, tracing, gold cases.

**Phase 1 — 24-skill KYB vertical slice:** `entity.resolve`, `entity.match`, `party.profile.build`, `registry.company.verify`, `document.classify`, `document.fields.extract`, `document.evidence.link`, `ownership.graph.build`, `ownership.interest.calculate`, `ownership.ubo.resolve`, `screening.sanctions.execute`, `screening.pep.execute`, `screening.adverse_media.execute`, `screening.match.disambiguate`, `risk.customer.assess`, `edd.trigger.evaluate`, `case.context.hydrate`, `case.tasks.plan`, `decision.requirements.compile`, `decision.rules.evaluate`, `decision.approval.route`, `evidence.provenance.attach`, `evidence.sufficiency.assess`, `quality.findings.verify`.

**Phase 2 — Full KYC/KYB:** additional ownership, document, EDD, periodic review and customer risk capabilities; institution/jurisdiction packs.

**Phase 3 — AML/sanctions investigations:** transactions, network, detection, alert triage, investigative evidence, SAR draft and reporting controls.

**Phase 4 — Fraud and intelligence:** CIAM, deepfake, payment fraud, graph rings, trade finance, crypto and cross-case intelligence as authorized.

**Phase 5 — Optimization:** benchmark harness, policy differential tests, provider A/B tests, drift monitoring, trace-based improvements, versioned skill promotions.

## 13. Expansion namespaces (not included in 222)

`payment.*` payment sanctions/holds; `trade.*` trade finance and dual-use indicators; `crypto.*` virtual asset analytics; `correspondent.*` correspondent bank risk; `tax.*` FATCA/CRS; `market.*` market abuse; `cyber.*` cyber-enabled fraud; `intelligence.*` cross-case typology intelligence; `modelrisk.*` validation and drift; `privacy.*` purpose limitation and retention.

## 14. Work session implementation brief

**Goal:** Convert this baseline into a working, testable, repo-backed financial crime skill registry and LangGraph KYB vertical slice. Start by auditing any existing KYC canonical case store, task/agent/skill specs, provider adapters and policy YAML. Produce: (1) JSON Schema/Pydantic ontology, (2) 222 machine-readable skill manifests, (3) context hydration contract and policy enforcement, (4) capability registry/resolver, (5) 24-skill Phase 1 implementations or explicit stubs with contract tests, (6) LangGraph workflow with checkpoint/interrupt/retry, (7) evaluation fixture suite and trace viewer, (8) ADRs and runbook. Do not claim incomplete stubs are production-ready. Keep jurisdiction policy configurable. Propose and seek approval before external side-effecting actions.

### Decisions to resolve before implementation
1. Target institution and initial jurisdiction (US bank baseline suggested, not assumed).
2. Existing canonical schema and source systems to reuse versus migrate.
3. Whether provider adapters are mock, sandbox or live; permitted data sources and licenses.
4. Policy authority, approval roles and SAR/CTR workflows.
5. Quantitative evaluation baselines and operational SLOs.
6. Repository ownership, CI environment, deployment/security boundaries.

---
**Design note:** This specification deliberately provides detailed per-skill contract semantics at a uniform level, plus deeper critical composite examples. Before implementation, generate domain-specific JSON Schemas and precise input/output field definitions for each skill, then validate them against real bank policies and golden cases. No universal policy thresholds or regulatory conclusions are encoded here.
