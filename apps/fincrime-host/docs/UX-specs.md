The download links aren't working in your app, so I won't send another one.

Instead, I've made the specification available directly in this conversation as a copyable, editable document. You can open the document block below and copy its contents without downloading a file.

# Financial Crime Experience Platform

## Comprehensive UX Architecture & Product Design Specification

**Version:** 1.0\
**Status:** Proposed design baseline\
**Date:** November 7, 2026

**Scope:** Contextboard, Agent Studio, Taskboard, Skillboard, KYC Workspace, Assurance Studio, shared design system, and execution contracts.

**Audience:** Enterprise architects, product designers, business operations, financial crime SMEs, engineering, security, compliance, audit, and platform leadership.

---

# 1. Executive Vision

The platform is a unified enterprise environment for configuring intelligence, composing AI agents, conducting regulated financial crime operations, and reconstructing every consequential action.

The product has three principal operating modes:

**Author and Govern:** Configure intelligence sources, define agent mandates, compose tasks and skills, test behavior, and publish governed configurations.

**Operate and Decide:** Enable business users to perform KYC, KYB, CDD, EDD, AML, sanctions, monitoring, and compliance work through adaptive workspaces.

**Observe and Prove:** Reconstruct actions across human, automated, and agentic invocations using case state, evidence, event ledgers, and OpenTelemetry traces.

## 1.1 Core Product Experiences

| Experience       | Primary purpose                                                |
| ---------------- | -------------------------------------------------------------- |
| Contextboard     | Configure and govern enterprise intelligence                   |
| Agent Studio     | Define agent mandates, tasks, skills, and operating boundaries |
| Taskboard        | Compose bounded business objectives                            |
| Skillboard       | Configure reusable canonical business skills                   |
| KYC Workspace    | Help business users complete regulated work                    |
| Assurance Studio | Observe, reconstruct, audit, and improve execution             |

These are not independent applications. They share a canonical business model, execution architecture, design system, governance model, and navigation language.

## 1.2 Canonical Architecture

**Persona → Agent → Task → Skill → Capability → Context**

- Persona: The accountable human business function.
- Agent: A specialist operating under a durable mandate.
- Task: A bounded business objective with explicit outputs and acceptance criteria.
- Skill: A reusable, versioned business capability contract.
- Capability: The technical implementation, including APIs, tools, deterministic code, models, or human actions.
- Context: The authorized, task-scoped information needed for execution.

Workflow orchestration operates across these layers, while Assurance Studio provides observability and auditability across all of them.

## 1.3 Product Design Principles

1. **Business language first.** Business users interact with outcomes, findings, and decisions, not underlying APIs.
2. **Recognition over recall.** Use stable information architecture, familiar groupings, and consistent spatial layouts.
3. **Progressive disclosure.** Reveal technical complexity only when users need it.
4. **One case, many lenses.** Every authorized persona interacts with the same canonical case through a relevant workbench.
5. **Calibrated trust.** Distinguish verified facts, assertions, findings, recommendations, and decisions.
6. **Governed by construction.** Authorization and policy are enforced at runtime, not merely represented by interface controls.
7. **Read before write.** Material changes require validation and appropriate authorization.
8. **Temporal fidelity.** Preserve what was known, done, and authorized at a particular moment.
9. **Observable without fiction.** Visualizations must reflect recorded events and explicitly disclose missing evidence or telemetry.
10. **Accessible direct manipulation.** Every important interaction supports keyboard operation and accessible alternatives.

---

# 2. Users, Personas, and Access Boundaries

## 2.1 Authoring and Governance Personas

**Platform Administrator**

Configures tenants, providers, credential references, operational settings, deployment environments, and service health.

**Context Architect**

Manages intelligence categories, canonical mappings, context profiles, source precedence, provenance, and freshness.

**Agent Architect**

Defines specialist agents, mandates, task compositions, skill bindings, and runtime constraints.

**Skill Engineer**

Maintains canonical skill definitions, implementation dependencies, input/output contracts, and evaluations.

**Compliance and Policy Author**

Maintains regulatory requirements, jurisdiction packs, approval matrices, exceptions, and control definitions.

**QA and Model Risk Evaluator**

Tests skills and agents using golden cases, failure scenarios, trace analysis, and regression evaluation.

**Security and Privacy Administrator**

Governs authentication, access, classification, purpose restrictions, redaction, retention, and sensitive audit access.

## 2.2 Twelve Business Personas

| Persona                        | Primary experience        | Accountable work                                           |
| ------------------------------ | ------------------------- | ---------------------------------------------------------- |
| Relationship Manager           | Relationship Workspace    | Customer engagement and information requests               |
| KYC Onboarding Specialist      | Intake Workspace          | Requirements and documentation completeness                |
| CDD / KYB Analyst              | Due Diligence Workbench   | Identity, ownership, business activity verification        |
| EDD Analyst                    | Investigation Workbench   | Enhanced investigation and elevated-risk findings          |
| AML Investigator               | Financial Crime Workbench | Suspicious activity analysis and escalation                |
| Sanctions & Screening Analyst  | Screening Workbench       | Match review and authorized disposition                    |
| KYC Risk Analyst               | Risk Workbench            | Risk calculation, attribution, validation                  |
| QA Reviewer                    | Assurance Workbench       | Independent evidence and control challenge                 |
| Compliance Officer / MLRO      | Decision Desk             | Authorized decisions and regulatory accountability         |
| KYC Operations Manager         | Operations Workspace      | Allocation, throughput, SLA, and exception management      |
| Periodic Review Analyst        | Monitoring Workspace      | Refreshes, change detection, and reassessment              |
| Policy & Governance Specialist | Policy Workspace          | Policy maintenance, impact analysis, and control oversight |

These are logical responsibilities rather than necessarily twelve separate employees.

A human persona may interact with several AI agents. One specialist agent may support several business personas.

---

# 3. Unified Information Architecture and Design System

## 3.1 Global Navigation

The primary platform destinations are:

- Business Workspace
- Agent Studio
- Contextboard
- Assurance Studio
- Platform Administration

Visibility depends on authorization, tenant, role, and purpose.

A business user should not encounter an engineering configuration surface unless it is relevant and authorized.

## 3.2 Desktop Spatial Layout

The primary desktop experience uses four stable regions.

**Left — Orientation**

Navigation, hierarchy, profiles, queues, filters, and saved views.

**Center — Work Surface**

The primary interaction canvas: intelligence banks, task compositions, ownership graphs, investigations, risk analysis, or execution traces.

**Right — Inspector**

Context-sensitive details: evidence, selected capability, skill contract, policy, authorization, provenance, and next action.

**Bottom — Activity Rail**

Execution activity, case status, events, traces, validation results, and operational feedback.

The center canvas receives the greatest visual emphasis.

## 3.3 Visual Language

The system borrows the behavioral qualities of sophisticated analog musical instruments rather than reproducing physical hardware literally.

**Colors**

Warm porcelain and graphite surfaces, restrained emerald for positive states, ochre for attention, muted coral for blocking conditions, and slate-blue for informational states.

Color must never be the sole indicator of meaning.

**Typography**

Modern, precise sans-serif typography for interface content. Tabular numbers for metrics and timestamps. Monospaced type for technical identifiers, contracts, and traces.

**Geometry**

Consistent spacing, aligned control banks, restrained corner radii, subtle surface elevation, and deliberate use of negative space.

**Motion**

Subtle transitions communicating selection, causality, expansion, execution, and state change.

Animations must correspond to real events when representing progress.

**Density**

Support comfortable and dense layouts without changing the information hierarchy.

## 3.4 Semantic States

Configuration and execution states must remain separate.

| State dimension | Representative values                                              |
| --------------- | ------------------------------------------------------------------ |
| Connection      | Connected, Disconnected, Degraded                                  |
| Authorization   | Authorized, Restricted, Approval Required                          |
| Assignment      | Not Assigned, Eligible, Required, Conditional                      |
| Readiness       | Ready, Missing Context, Dependency Unavailable, Pending Evaluation |
| Execution       | Completed, Partial, Needs Evidence, Needs Review, Blocked, Failed  |
| Publication     | Draft, Validated, Approved, Published, Deprecated                  |

A green configuration switch must never imply a successful business execution or regulatory approval.

## 3.5 Accessibility

Target WCAG 2.2 AA.

Provide keyboard support, visible focus, screen-reader descriptions, high-contrast states, reduced-motion support, nonvisual alternatives to graphs, and accessible data tables.

Preserve consistent spatial grouping across accessibility modes.

---

# 4. Contextboard — Enterprise Intelligence Switchboard

## 4.1 Product Purpose

Contextboard provides an enterprise intelligence layer that can connect to hundreds of external providers and dozens of internal data products.

Providers are configured once through governed authentication, mapping, entitlement, and lifecycle processes.

Business capabilities are organized by canonical intelligence domains rather than vendor names.

A capability may use multiple providers, while a provider may support multiple capabilities.

## 4.2 Information Hierarchy

**Business Context → Intelligence Domain → Canonical Capability → Source Binding → Context Contract**

The first three levels dominate the primary interface.

Source and contract details are revealed through progressive inspection.

## 4.3 Canonical Intelligence Banks

Representative banks include:

- Identity Intelligence
- Entity Intelligence
- Ownership Intelligence
- Document Intelligence
- Registry Intelligence
- Screening Intelligence
- Party360 and Customer360
- Transaction Intelligence
- Network Intelligence
- Risk Intelligence
- Case Intelligence
- Policy Intelligence
- Evidence Intelligence

Each bank has a stable location and identity.

Provider availability must not alter the bank's position.

## 4.4 Contextboard — Play

**Screen CXT-01: Context Overview**

The user selects a business context such as Corporate Onboarding, Periodic Review, Investigations, or Fraud Detection.

The interface displays the corresponding intelligence banks, readiness, missing dependencies, restrictions, and configuration version.

The primary question is:

**What intelligence is available for this business purpose?**

Main interactions:

- Select a context profile.
- Explore intelligence banks.
- Inspect canonical capabilities.
- See availability and policy restrictions.
- Review the resulting context contract.
- Compare profile versions.

## 4.5 Contextboard — Tune

**Screen CXT-02: Context Composition**

Users compose governed intelligence profiles.

Capability settings include Required, Optional, and Conditional.

Advanced controls include source priority, fallback rules, freshness requirements, jurisdictional constraints, and context budgets.

Changes are staged in drafts.

A profile may inherit a common foundation and override permitted settings for a specific process or institution.

The primary question is:

**Which intelligence capabilities should this business process use?**

## 4.6 Contextboard — Engineer

**Screen CXT-03: Provider and Mapping Workbench**

The engineering surface exposes:

- Endpoint configuration
- Authentication status
- Secret references
- Source entitlements
- Permitted purposes
- Jurisdictional coverage
- Canonical field mappings
- Data transformations
- Source authority
- Freshness and SLA requirements
- Licensing restrictions
- Latency and cost
- Retries and fallbacks
- Validation and diagnostics

Actual secrets are never displayed.

Engineers can test provider bindings against approved synthetic or authorized test inputs.

## 4.7 Context Signal

**Screen CXT-04: Context Preview**

The Context Signal shows the actual preparation lifecycle:

Context request → Authorization → Source resolution → Canonical mapping → Context assembly → Validated output.

The preview includes:

- ContextEnvelope manifest
- Included canonical objects
- Excluded or restricted objects
- Evidence references
- Source provenance
- Freshness
- Unresolved requirements
- Conflicts
- Context hash
- Token budget

The system must not imply a provider responded when no corresponding execution event exists.

## 4.8 Contextboard Success Criteria

A business architect must be able to choose a context profile, understand available intelligence, identify gaps, inspect source lineage, and explain the governed output without needing to understand vendor-specific API payloads.

---

# 5. Agent Studio — Specialist Workforce and Composition

## 5.1 Product Purpose

Agent Studio defines accountable specialist agents using versioned, declarative configurations.

An agent is not equivalent to a skill, API, or autonomous execution loop.

Agent Profiles describe durable business mandates and operating boundaries.

Tasks describe bounded objectives.

Skills describe reusable business capabilities.

## 5.2 Specialist Agent Workforce

The target logical workforce contains 16 specialist agents.

| ID  | Agent                    | Mandate                                                          |
| --- | ------------------------ | ---------------------------------------------------------------- |
| A01 | Intake & Profile         | Case creation, requirements, customer profile                    |
| A02 | Identity & Ownership     | Entity identity, legal existence, UBO and control                |
| A03 | Document Intelligence    | Classification, extraction, validation and citation              |
| A04 | Internal Intelligence    | Authorized internal party, customer and transaction intelligence |
| A05 | External Intelligence    | External records and provider-backed intelligence                |
| A06 | Screening                | Sanctions, PEP, adverse media and watchlists                     |
| A07 | Risk Assessment          | Risk scoring, factors and explanations                           |
| A08 | EDD                      | Higher-risk investigations                                       |
| A09 | Transaction Intelligence | Transaction enrichment, behavior and fund flows                  |
| A10 | AML Detection            | Detection typologies and suspicious indicators                   |
| A11 | Network Intelligence     | Relationship and transaction network analysis                    |
| A12 | Investigation            | Hypotheses, evidence, timelines and findings                     |
| A13 | Fraud Intelligence       | Identity, device, deepfake and payment fraud indicators          |
| A14 | Regulatory Reporting     | Filing preparation and controlled submission                     |
| A15 | Decision Support         | Policy evaluation, recommendations and approvals                 |
| A16 | QA & Assurance           | Independent evidence and control verification                    |

These are logical profiles and do not require sixteen independent LLM runtimes.

## 5.3 Shared Orchestration Roles

Four cross-cutting responsibilities are implemented initially as runtime services.

**Workflow Coordinator**

Controls case progression, state, parallel work, and lifecycle.

**Task Planner**

Selects tasks based on case facts, objectives, and policy.

**Context Assembler**

Deterministically assembles authorized, task-scoped context.

**Execution & Recovery Controller**

Handles checkpointing, retries, interrupts, recovery, and durable actions.

For the standalone KYC POC, LangGraph provides the workflow and checkpoint foundation.

## 5.4 Workforce Atlas

**Screen AGT-01**

The Workforce Atlas provides an overview of the specialist agent registry.

Each profile displays:

- Agent identity
- Mandate
- Supported task families
- Owner
- Version
- Publication status
- Evaluation status
- Governance exceptions
- Dependencies

Agents may be grouped by business domain.

## 5.5 Agent Profile

**Screen AGT-02**

Each Agent Profile includes:

- Mandate
- Scope and exclusions
- Accountable business roles
- Task repertoire
- Skill repertoire
- Context subscriptions
- Runtime constraints
- Human gates
- Evaluation profile
- Published versions

Primary navigation:

Overview → Taskboard → Skillboard → Context Bindings → Mandate & Guardrails → Rehearsal → Versions.

---

# 6. Taskboard — Business Objective Composition

## 6.1 Purpose

The Taskboard becomes the primary composition surface within an agent profile.

A task defines what must be accomplished, not how a particular provider API must be invoked.

## 6.2 Task Definition

A canonical TaskSpec contains:

- Task identifier and version
- Assigned agent profile
- Objective
- Inputs
- Required context
- Skill composition
- Dependencies
- Canonical outputs
- Completion criteria
- Failure policy
- Human interrupts
- Authorization and audit requirements

## 6.3 Taskboard Interface

**Screen AGT-03**

The interface shows a repertoire of task cards organized around business outcomes.

Each task displays its objective, required outputs, assigned skills, context dependencies, and status.

Selecting a task expands its composition within Skillboard.

## 6.4 Corporate Ownership Example

Task: `task.resolve_corporate_ownership`

Objective: Establish beneficial ownership and controlling parties with supporting evidence.

Representative skills:

- `entity.resolve`
- `registry.company.verify`
- `ownership.graph.build`
- `ownership.graph.expand`
- `ownership.interest.calculate`
- `ownership.control.resolve`
- `ownership.ubo.resolve`
- `ownership.ubo.verify`

Canonical outputs include OwnershipGraph, BeneficialOwnershipFinding, UnresolvedOwnershipPath, and EvidenceReference.

Task execution must preserve dependencies, avoid redundant composite operations, and surface insufficient evidence.

---

# 7. Skillboard — Task-Aware Canonical Skill Instrument

## 7.1 Purpose

Skillboard is a reusable visual instrument for composing business skills within agent tasks.

The canonical skill registry remains independent of agent implementations.

The detailed financial crime baseline describes 222 skills across 20 domains. A later architecture proposal refers to 220 slots; the implementation must reconcile this against the authoritative registry.

## 7.2 Primary Information Hierarchy

Agent Profile → Task → Skill Assignment → Skill Contract → Dependencies → Implementation → Context.

The Taskboard communicates business outcomes.

Skillboard communicates the skills required to accomplish them.

## 7.3 Skillboard — Overview

The user sees the agent's assigned repertoire grouped into stable business categories.

These could include:

- Identify
- Relate
- Detect
- Assess
- Investigate
- Govern

These are cognitive navigation groups, not replacements for the canonical domains.

## 7.4 Skillboard — Compose

**Screen AGT-04**

Users configure task-specific skill bindings.

Each binding distinguishes:

**Required:** Explicitly required by the task contract.

**Conditional:** Required when an applicable condition is satisfied.

**Eligible:** Permitted to be selected under defined constraints.

**Composed Dependency:** Invoked through another skill's defined composition.

The interface must not present these as interchangeable activation states.

## 7.5 Dependency Map

A visual dependency graph illustrates how skills combine.

For `ownership.ubo.resolve`, possible internal operations include graph expansion, effective ownership calculations, control resolution, and UBO verification.

The compiler must determine whether these are already contained in the composite implementation.

The UI must reveal:

- Explicit skill calls
- Internal composite dependencies
- Conditional branches
- Parallel operations
- Human gates
- Required synchronization
- Duplicate or conflicting execution paths

## 7.6 Skill Inspector

Six core inspection tabs:

| Tab          | Purpose                                      |
| ------------ | -------------------------------------------- |
| Contract     | Input and output schemas                     |
| Context      | Required canonical objects and freshness     |
| Dependencies | Other skills and implementation requirements |
| Guardrails   | Authorization and policy constraints         |
| Evaluation   | Golden cases and quality tests               |
| Trace        | Actual execution and diagnostics             |

## 7.7 Context Handshake

**Screen AGT-05**

Skillboard communicates its context requirements to Contextboard.

The context compiler combines the TaskSpec and Skill Contracts to determine the minimal authorized context.

The interface shows missing objects, stale sources, authorization restrictions, and validation gaps.

A skill cannot acquire unrestricted provider access through a user-interface toggle.

## 7.8 Rehearsal and Evaluation

**Screen AGT-06**

Rehearsal allows an architect to execute tasks against representative golden cases.

It displays real execution events, dependency paths, context requests, outputs, policy evaluations, errors, retries, and human interrupts.

Test results can generate controlled improvement candidates linked to the relevant Skill Contract, TaskSpec, or Contextboard configuration.

## 7.9 Publishing and Versioning

**Screen AGT-07**

The publishing workflow compares:

- Agent mandate
- Task composition
- Skill bindings
- Canonical contract versions
- Context profiles
- Policies
- Evaluation baselines

Changes undergo validation, impact analysis, applicable approval, and versioned publication.

Published configurations are immutable execution references.

---

# 8. KYC Workspace — Adaptive Business Operations

## 8.1 Experience Model

**My Workspace → Case Room → Specialist Workbench**

All twelve business personas operate over a shared canonical case, but see different information priorities and controls.

Users should not need to understand the underlying agent architecture.

## 8.2 My Workspace

**Screen BIZ-01**

The home experience answers:

**What requires my attention?**

Primary groups include:

- Needs my action
- Prepared by automation
- Waiting on others
- Approaching SLA
- Recently changed
- Escalated or blocked

Every work item shows the case, customer, accountable next step, reason, urgency, and due date.

## 8.3 Shared Case Room

**Screen BIZ-02**

The Case Room is the common collaboration and review surface.

A persistent header displays case identity, customer, jurisdiction, case stage, assigned roles, risk context, and version.

Principal areas:

- Summary
- Activities
- Evidence
- Findings
- Tasks
- Decisions
- History
- Audit

AI-generated results appear as structured, reviewable work products rather than only chat messages.

## 8.4 AI Work Product Standard

Every substantial agent-prepared artifact should contain:

1. Business finding or recommendation.
2. Supporting evidence.
3. Verification status.
4. Uncertainty and unresolved items.
5. Applicable policy.
6. Evidence freshness and provenance.
7. Execution trace reference.
8. Proposed human action.

The user can inspect, accept, challenge, request further work, or escalate according to authorization.

## 8.5 Relationship and Intake Workbench

For Relationship Managers and Onboarding Specialists.

Core components:

- Customer relationship timeline
- Product and relationship overview
- Document requirements
- Submitted document tracker
- Customer communications
- Outstanding information requests
- Intake completion and handoff

The primary goal is to coordinate customer engagement and produce a complete intake package.

## 8.6 CDD Workbench

**Screen BIZ-03**

The central canvas is a directed ownership and control graph.

It supports:

- Direct and effective ownership percentages
- Legal entities and natural persons
- Non-equity control relationships
- Temporal ownership changes
- Candidate versus verified UBOs
- Unresolved ownership paths
- Source evidence references

A document reconciliation view allows analysts to compare registry filings, customer declarations, and extracted assertions.

An attractive graph must never imply that an unverified ownership path is established fact.

## 8.7 EDD Workbench

**Screen BIZ-04**

A hypothesis-oriented investigation environment.

Major components include:

- Hypothesis matrix
- Source-of-funds analysis
- Source-of-wealth analysis
- Relationship intelligence
- Chronology
- Supporting and contradictory evidence
- Alternative explanations
- Investigation gaps

Hypotheses are visibly classified as supported, contradicted, unresolved, or untested.

## 8.8 AML Investigation Workbench

**Screen BIZ-05**

The main interface focuses on financial activity.

Components include:

- Fund-flow graph
- Account and counterparty relationships
- Transaction timeline
- Behavioral baseline comparison
- Suspicious typology indicators
- Supporting and exculpatory evidence
- Hypothesis testing
- Evidence-linked investigative narrative

The system must distinguish suspicious indicators from proven misconduct.

## 8.9 Screening Workbench

**Screen BIZ-06**

The primary interaction is a side-by-side comparison between the customer or related party and a candidate screening match.

Fields include names, aliases, identifiers, jurisdiction, dates, supporting sources, list version, and ownership or control exposure.

The interface highlights agreement, contradiction, and missing information.

Authorized analysts can record documented dispositions or escalations.

Unresolved potential true matches cannot be cleared contrary to policy.

## 8.10 Risk and Decision Workbench

**Screen BIZ-07**

The Risk Analyst experience emphasizes:

- Risk-factor attribution
- Calculation inputs
- Geographic and industry exposure
- Product and ownership risk
- Prior-versus-current assessment
- Overrides and exceptions
- Reproducibility
- Evidence gaps

The Compliance Officer experience emphasizes:

- Decision memorandum
- Policy obligations
- Independent QA
- Approval requirements
- Alternatives
- Material unresolved risks
- Sign-off and attestation

Recommendation, deterministic control evaluation, and authorized human decision are separate objects.

## 8.11 QA and Governance Workbench

**Screen BIZ-08**

The QA experience includes:

- Required control checklist
- Evidence coverage
- Unsupported assertion detection
- Contradiction analysis
- Independent challenge register
- Remediation tracking
- Retest results

The Policy Specialist experience includes policy differences, affected controls, impacted cases, and regression evaluation.

## 8.12 Operations and Monitoring Workbench

**Screen BIZ-09**

Operations Managers see:

- Work in progress
- Cases by stage
- Aging and SLA exposure
- Team capacity
- Bottlenecks
- Human interrupts
- Exceptions and escalations

Periodic Review Analysts see a temporal before-and-after view of customer identity, ownership, screening, transaction activity, and risk.

## 8.13 Human Handoff Standard

Each handoff includes a versioned package with:

- Business objective
- Completed tasks
- Verified facts
- Findings
- Evidence references
- Unresolved issues
- Recommendations
- Escalation reasons
- Policy snapshot
- Prior accountable actor
- Due date

Receiving users should understand what has already been established and what requires their judgment.

---

# 9. Assurance Studio — Audit, Observability, and Proof

## 9.1 Purpose

Assurance Studio provides a cross-cutting audit and operational observability environment.

It reconstructs actions regardless of whether execution was initiated by:

- Human interaction
- Scheduled workflow
- External API
- Application event
- Service trigger
- Agent delegation
- Orchestrated process

The product is not simply a technical log viewer.

It is a navigable environment for understanding business causality, decision authority, provenance, and execution quality.

## 9.2 Four Major Experiences

**Mission Control:** Cross-enterprise operational monitoring.

**Flight Recorder:** Detailed case and execution reconstruction.

**Decision Lineage:** Evidence-to-decision causal analysis.

**Assurance Lab:** Evaluation, diagnostics, and continuous improvement.

A governed Assurance Package service supports audit deliverables.

## 9.3 Mission Control

**Screen ASR-01**

Mission Control provides cross-case monitoring with emphasis on actionable exceptions.

Representative measures include:

- Active workflows
- Blocked executions
- Failed skills
- Human interrupts
- Recovery events
- Source failures
- Policy violations
- SLA exposure
- Retry rates
- Trace coverage gaps
- Evidence completeness
- Operational latency and cost

Views adapt to the observer.

Operations focuses on business flow.

Platform engineering focuses on runtime failures and technical behavior.

Compliance focuses on control execution and consequential actions.

Model assurance focuses on quality, evidence, and evaluation.

Every metric requires a defined calculation and freshness indicator.

## 9.4 Flight Recorder

**Screen ASR-02**

The Flight Recorder is the signature audit experience.

It contains four synchronized regions.

**Left — Business Chronology**

Durable business events, task transitions, approvals, interruptions, case mutations, and decisions.

**Center — Causal Execution Graph**

Agents, tasks, skills, dependencies, parallel branches, retries, checkpoints, interruptions, and resumptions.

**Right — Event Inspector**

Selected event details, triggering cause, inputs, outputs, actor, authorization, context snapshot, policy version, evidence, and ledger reference.

**Bottom — Technical Trace Rail**

OpenTelemetry spans, service calls, timing, exceptions, retry diagnostics, and linked execution metadata.

## 9.5 Flight Recorder Interactions

Selecting an event illuminates its causal neighborhood:

- Upstream trigger
- Initiating actor
- Executing identity
- Assigned task
- Skill invocation
- Capability resolution
- Context manifest
- Policy checks
- Input artifacts
- Output artifacts
- Downstream consumers
- Ledger entry
- Correlated spans

Users can navigate from:

Case → Workflow → Task → Skill → Capability → Tool call → Source event.

## 9.6 Temporal Fidelity

The interface must distinguish:

- Event occurrence time
- Ledger recording time
- Business effective time
- Source observation time
- Workflow and checkpoint sequencing

Chronological order alone does not establish causality.

A workflow may resume hours or days later with a new technical trace while retaining the same business case and workflow identity.

Missing or sampled spans must be disclosed.

## 9.7 Decision Lineage

**Screen ASR-03**

Decision Lineage allows auditors to start at a business conclusion and travel backward.

Decision → Policy evaluation → Findings → Verified facts and assertions → Evidence → Original sources.

Every node preserves source references, version, time, and epistemic status.

The visual language distinguishes observations, assertions, facts, hypotheses, findings, recommendations, and authorized decisions.

Reverse lineage identifies which decisions or findings depended on a subsequently corrected source or deprecated policy.

## 9.8 Assurance Lab

**Screen ASR-04**

Assurance Lab converts recorded execution into quality and governance insight.

Evaluation areas include:

- Golden-case correctness
- Contract validity
- Evidence provenance
- Unsupported assertions
- Authorization correctness
- Policy adherence
- Recovery reliability
- Provider drift
- Model and skill regression
- Cost and latency
- Human-review effectiveness

An evaluator can select a failure cluster, inspect representative traces, and create a controlled improvement candidate in Agent Studio.

No improvement is silently applied to a published agent.

## 9.9 Assurance Packages

**Screen ASR-05**

A governed package contains:

- Business chronology
- Actor and authority history
- Case-state transitions
- Evidence manifest
- Evidence hashes
- Findings and decisions
- Relevant policy versions
- Skill and model versions
- Approval records
- Decision lineage
- Trace references
- Integrity verification
- Missing or redacted material disclosures

Access and export activity are themselves audited.

---

# 10. Canonical Audit and Execution Model

## 10.1 Source Responsibilities

| Source         | Responsibility                                                      |
| -------------- | ------------------------------------------------------------------- |
| Case Store     | Authoritative business state and case records                       |
| Evidence Store | Immutable evidence, source versions, assertions, provenance         |
| Case Ledger    | Durable business actions and state transitions                      |
| OpenTelemetry  | Distributed traces, spans, latency, errors, retries and diagnostics |

OpenTelemetry is not the authoritative business audit record.

The ledger must capture audit-critical events even when telemetry is sampled or unavailable.

## 10.2 Unified Correlation Model

Every significant action receives stable correlation identifiers.

The proposed audit envelope includes:

```
AuditEvent:
  event_id: uuid
  tenant_id: string
  case_id: string
  workflow_id: string
  workflow_run_id: string

  task_execution_id: string | null
  skill_execution_id: string | null
  execution_attempt_id: string | null

  trace_id: string | null
  span_id: string | null

  initiator:
    kind: human | schedule | service | event | api
    identity_ref: string
    trigger_ref: string | null

  executor:
    kind: human | agent | deterministic_service
    identity_ref: string
    authority_ref: string | null

  event_type: string
  occurred_at: datetime
  recorded_at: datetime
  ledger_sequence: integer

  context_manifest_ref: string | null
  policy_snapshot_ref: string | null

  input_refs: [string]
  output_refs: [string]
  evidence_refs: [string]

  result_status: string
  error_code: string | null
  integrity_ref: string | null
```

This is a proposed platform correlation contract rather than an OpenTelemetry-native schema.

## 10.3 Three Replay Modes

**Historical Reconstruction**

Read-only reconstruction of recorded events and retained context.

**Controlled Re-execution**

Execute a new isolated run using retained inputs, pinned versions, and authorized test sources.

**Counterfactual Simulation**

Change selected context, policy, model, or skills to evaluate hypothetical outcomes.

These modes must remain visually and technically distinct.

## 10.4 Integrity and Privacy

Audit-critical records require durable append-only capture and verifiable integrity.

Sensitive payloads should be stored through controlled evidence references rather than exposed inside generic telemetry.

Secrets and unnecessary PII must not appear in spans.

All access and exports require authorization, purpose limitation, and audit capture.

---

# 11. Shared Technical and Experience Contracts

## 11.1 Skill Contract

Every canonical skill maintains:

- ID and semantic version
- Business purpose
- Input schema
- Output schema
- Required context
- Optional context
- Freshness
- Dependencies
- Execution mode
- Permitted capabilities
- Provider policy
- Authorization
- Idempotency
- Timeout and retry rules
- Human interrupt conditions
- Failure codes
- Evidence requirements
- Evaluation profile
- Audit fields
- Classification and jurisdiction
- Owner and deprecation policy

The business workspace exposes only relevant details. Engineering and assurance surfaces expose the complete contract.

## 11.2 ContextEnvelope

Each task receives the smallest authorized context appropriate for its execution.

The envelope carries tenant, case, subjects, jurisdiction, purpose, actor, policy snapshot, as-of timestamp, object and evidence references, graph scope, freshness requirements, permitted providers, redaction profile, token budget, and correlation identity.

Missing data remains explicitly missing.

## 11.3 Execution Flow

Workflow recipe → LangGraph orchestration → TaskSpec → Agent Profile → Skill Registry → Context Compiler → Capability Resolver → Implementation → Canonical Result Validator → Case/Evidence/Ledger.

The execution and observability layers record all relevant transitions.

## 11.4 Concurrency and Synchronization

Document parsing and registry retrieval can run in parallel when permitted.

UBO resolution must wait for sufficiently reconciled ownership evidence.

Screening and preliminary risk assessment may overlap.

Final decisioning must incorporate material findings and applicable controls.

Use durable checkpoints, explicit joins, human interrupts, bounded retries, and idempotent mutations.

## 11.5 Data Ownership

No UI becomes an independent system of record.

Actions submit typed commands to authorized services.

The interface updates after confirmed results.

Draft configuration changes must never be mistaken for production mutations.

---

# 12. Five End-to-End User Journeys

## Journey A: Configure Intelligence

1. Context architect opens Corporate Onboarding in Contextboard.
2. Reviews intelligence banks and canonical capabilities.
3. Inspects available authorized sources.
4. Defines requirements and conditional dependencies.
5. Previews context assembly against a test case.
6. Validates completeness and policies.
7. Publishes a versioned context profile.

Failure paths include unavailable providers, missing mappings, stale sources, and unauthorized access.

## Journey B: Compose an Agent

1. Agent architect selects A02 Identity & Ownership.
2. Opens Taskboard.
3. Selects Corporate Ownership Resolution.
4. Reviews skill composition and dependencies.
5. Inspects context requirements.
6. Rehearses a complex ownership case.
7. Evaluates outputs, evidence, and interrupts.
8. Compares versions and publishes the approved configuration.

## Journey C: Process Corporate KYB

1. Relationship Manager initiates onboarding.
2. Onboarding Specialist validates documentation.
3. Authorized agents gather registry and internal intelligence.
4. CDD Analyst reviews ownership findings and evidence.
5. Workflow pauses if material ambiguity requires human review.
6. Screening and Risk agents evaluate reconciled facts.
7. Conditional EDD investigates heightened exposure.
8. QA performs independent verification.
9. Compliance records authorized decisions.
10. Monitoring begins from the durable case record.

## Journey D: Audit a Decision

1. Auditor searches by case, decision, or execution identity.
2. Flight Recorder presents the event chronology.
3. Auditor selects the material decision.
4. Decision Lineage expands the relevant facts and evidence.
5. Historical context shows what was known at the time.
6. Related actor identities, approvals, rules, and traces are inspected.
7. Missing records or telemetry are explicitly disclosed.
8. Authorized assurance package is generated.

## Journey E: Improve an Agent from Traces

1. Assurance Lab identifies recurring execution failures.
2. Evaluator filters failures by agent, skill, provider, and version.
3. Representative traces are inspected.
4. Context and contract issues are identified.
5. An improvement candidate is created.
6. New behavior is evaluated against golden cases.
7. The approved version is published.
8. Historical executions remain linked to their original versions.

---

# 13. Screen Inventory

| ID     | Screen                | Primary purpose                         |
| ------ | --------------------- | --------------------------------------- |
| CXT-01 | Contextboard Overview | Intelligence discovery                  |
| CXT-02 | Context Composition   | Governed profile authoring              |
| CXT-03 | Provider Workbench    | Integrations and mappings               |
| CXT-04 | Context Preview       | Context validation                      |
| AGT-01 | Workforce Atlas       | Specialist agent discovery              |
| AGT-02 | Agent Profile         | Mandate and boundaries                  |
| AGT-03 | Taskboard             | Task composition                        |
| AGT-04 | Skillboard            | Canonical skill composition             |
| AGT-05 | Context Handshake     | Task-scoped context requirements        |
| AGT-06 | Rehearsal             | Test execution and evaluation           |
| AGT-07 | Publish & Diff        | Version validation                      |
| BIZ-01 | My Workspace          | Role-based attention queue              |
| BIZ-02 | Case Room             | Shared case work                        |
| BIZ-03 | CDD Workbench         | Identity and ownership                  |
| BIZ-04 | EDD Workbench         | Enhanced investigations                 |
| BIZ-05 | AML Workbench         | Transaction and fund-flow investigation |
| BIZ-06 | Screening Workbench   | Screening adjudication                  |
| BIZ-07 | Risk & Decision       | Risk and compliance authority           |
| BIZ-08 | QA & Policy           | Verification and governance             |
| BIZ-09 | Operations & Review   | Operational flow and monitoring         |
| ASR-01 | Mission Control       | Cross-enterprise observability          |
| ASR-02 | Flight Recorder       | Execution reconstruction                |
| ASR-03 | Decision Lineage      | Evidence and authority traceability     |
| ASR-04 | Assurance Lab         | Evaluation and improvement              |
| ASR-05 | Assurance Packages    | Audit deliverables                      |

---

# 14. Shared Component Library

The design system should provide reusable components across all experiences.

**Canonical Object Header**

Shows ID, version, owner, state, scope, and as-of timestamp.

**Instrument Bank**

Stable grouping of canonical capabilities and operational states.

**Task Tile**

Business objective, inputs, outputs, dependencies, and completion criteria.

**Skill Key**

Canonical skill, assignment status, composition type, and readiness.

**Case Card**

Customer, owner, stage, priority, SLA, and next action.

**Evidence Panel**

Claim type, source, provenance, verification, freshness, and challenge actions.

**Human Decision Surface**

Authority, policy obligations, rationale, alternatives, and attestation.

**Temporal Graph**

Directed relationships, time, provenance, and an accessible table alternative.

**Trace Span Row**

Technical execution event, timing, parent/linked spans, errors, and correlation.

**Audit Event Inspector**

Trigger, identity, authority, context, evidence, ledger, and trace references.

**Diff and Impact Inspector**

Changed versions, affected consumers, regression results, and publishing consequences.

**Activity Rail**

Execution state, events, retries, errors, and human requests.

---

# 15. Security, Trust, and Compliance Constraints

The following apply across the platform.

1. Runtime authorization takes precedence over UI configuration.
2. Every material finding retains evidence provenance.
3. Policy versions are immutable execution references.
4. Human approval and segregation-of-duties requirements are explicit.
5. Negative searches must disclose their coverage and limitations.
6. Context hydration follows least-privilege and purpose-limitation principles.
7. AI uncertainty is not represented as verified truth.
8. Material side effects require controlled, auditable execution.
9. Business audit records and technical telemetry have distinct reliability guarantees.
10. Institution-specific regulatory requirements require authorized policy owners and legal validation.

The product must not imply regulatory compliance merely because a configured control appears green.

---

# 16. Product Metrics and UX Acceptance

## 16.1 Contextboard

Measure provisioning lead time, mapping errors, context availability, authorization correctness, freshness, and configuration comprehension.

Success means an architect can configure and explain intelligence without vendor-specific API expertise.

## 16.2 Agent Studio

Measure composition time, dependency duplication, contract failures, evaluation pass rates, configuration reuse, and release quality.

Success means reusable agents can be composed without rewriting provider integrations.

## 16.3 KYC Workspace

Measure time to useful findings, case cycle time, analyst interactions, evidence rework, handoff latency, and overdue cases.

Success means business users can reach correct, authorized decisions with clear evidence.

## 16.4 Assurance Studio

Measure time to reconstruct a decision, evidence lineage completeness, trace correlation coverage, audit package defects, and control evaluation completeness.

Success means an auditor can travel from a decision to its supporting sources without reading raw logs.

## 16.5 Critical Acceptance Scenarios

**Contextboard**

A connected but unauthorized provider must remain unavailable for prohibited purposes.

**Skillboard**

Composite skills must not unintentionally duplicate execution of dependent skills.

**Business Workspace**

An unverified UBO must not be represented as verified.

**Decisioning**

Unauthorized users must not be able to approve material decisions.

**Assurance**

Human interrupts and resumptions must remain correlated across separate technical traces.

**Historical Reconstruction**

The system must use the policy and evidence snapshots relevant to the historical event rather than silently substituting current values.

**Accessibility**

Essential workflows must remain operable without pointer-based manipulation.

---

# 17. Delivery Roadmap

| Phase                         | Product scope                                                                   | Exit outcome                         |
| ----------------------------- | ------------------------------------------------------------------------------- | ------------------------------------ |
| 0 — Foundation                | Ontology, UX architecture, design tokens, identity and audit contracts          | Validated shared platform foundation |
| 1 — KYB Vertical Slice        | Contextboard, six agents, Taskboard, Skillboard, CDD Case Room, Flight Recorder | One end-to-end governed KYB case     |
| 2 — Business Depth            | Intake, screening, risk, QA, decision workbenches                               | Controlled business workflow         |
| 3 — Assurance Depth           | Decision Lineage, Mission Control, audit packages                               | Evidence and audit reconstruction    |
| 4 — Financial Crime Expansion | EDD, AML, fraud, monitoring, additional agents                                  | Broader reusable platform            |
| 5 — Optimization              | Trace-driven improvement, version comparison, policy simulation                 | Governed continuous improvement      |

## 17.1 First Demonstrable Product

The first complete experience should demonstrate:

- A context architect configuring intelligence.
- An agent architect composing an ownership task.
- A business user reviewing a corporate KYB case.
- A human resolving an ownership discrepancy.
- A compliance decision being recorded.
- An auditor reconstructing the full process through Flight Recorder and Decision Lineage.

This demonstrates the connected architecture rather than five isolated prototypes.

---

# 18. Open Architecture and Product Decisions

Before implementation, resolve the following.

**Architecture**

Canonical entity and party schemas, authoritative case store, ledger integrity guarantees, correlation identities, model artifact retention, and capability registry ownership.

**Governance**

Initial bank and jurisdiction, approval authorities, segregation of duties, provider licensing, PII privileges, and change ownership.

**Product**

Final naming, platform navigation, Contextboard placement, responsive layouts, search behavior, and design-system validation.

**Data Quality**

Reconcile the 222-skill catalog against the later 220-slot description. Confirm machine-readable contracts and required context for every implementation-ready skill.

**Release**

Distinguish conceptual mockups, validated prototypes, production integrations, and regulator-approved workflows.

---

# 19. Canonical Business and Audit Language

## 19.1 Business Object Progression

SourceRecord / Document / RegistryRecord → ExtractedAssertion → VerifiedFact or Disputed Assertion → Finding → Recommendation → Authorized Decision.

Evidence provenance, uncertainty, source limitations, and historical validity must survive every transition.

## 19.2 Proposed Event Vocabulary

```
case.created
task.planned
context.requested
context.authorized
context.hydrated
skill.started
capability.resolved
provider.called
evidence.recorded
skill.completed
policy.evaluated
workflow.interrupted
human.reviewed
workflow.resumed
decision.recorded
case.transitioned
export.generated
```

These names are proposed and should become governed machine-readable contracts.

## 19.3 Unified Product Metaphor

**Contextboard — The Switchboard**

What intelligence can be known and delivered under policy?

**Taskboard — The Score**

What bounded business work must be completed?

**Skillboard — The Instrument**

What reusable capabilities fulfill that work?

**Agent Profile — The Performer**

Who executes the work, under what mandate and constraints?

**LangGraph / Workflow Runtime — The Conductor**

What executes, when, and under what dependencies?

**KYC Workspace — The Professional Work Surface**

What must a business user understand, verify, and decide?

**Assurance Studio — The Flight Recorder**

What happened, why, under whose authority, and can it be proven?

---

# 20. Final Product Design Standard

The platform succeeds when three very different users can interact with one coherent architecture.

**A business user** should be able to complete regulated work without understanding the implementation details of AI agents.

**An architect** should be able to compose governed agents and tasks without manually wiring hundreds of provider APIs.

**An auditor** should be able to reconstruct a consequential decision from its outcome to the original evidence and authority without having to read raw technical logs.

All three must have access, within their permissions, to the same underlying canonical truth.

**The design objective is not simply to make complex enterprise software easier to use. It is to make intelligence, action, judgment, and accountability comprehensible within one connected human-centered operating environment.**
