# Financial Crime Experience Platform
## Design Addendum v1.1 — MCP, A2UI & Adaptive Enterprise Experiences

**Parent specification:** Comprehensive UX Architecture & Product Design Specification v1.0  
**Status:** Proposed architecture and design standard  
**Scope:** Headless enterprise capabilities, agent-renderable UI contracts, adaptive presentation, trusted actions, realtime interaction, and end-to-end auditability.

---

# 1. Executive Intent

## 1.1 What changes

The existing platform defines six interconnected experiences:

1. Contextboard — governed enterprise intelligence.
2. Agent Studio — specialist agent profiles and mandates.
3. Taskboard — bounded business objectives.
4. Skillboard — reusable skill composition.
5. KYC Workspace — business operations and decision-making.
6. Assurance Studio — observability, audit, and execution reconstruction.

These experiences remain visually and conceptually intact.

The new architectural direction separates **enterprise capability, business semantics, UI intent, and device-specific rendering**.

Previously, a screen and its behavior might be implemented together in a React application, communicating with application-specific REST endpoints.

Under the proposed architecture, enterprise objects and actions are exposed through governed, headless capabilities. Agents and deterministic services assemble authorized information and produce structured presentation contracts. Clients render those contracts through trusted native UI components.

The outcome is not a fully generated application. It is a governed, adaptive user experience built from reusable semantic and presentation primitives.

## 1.2 Architectural principle

**Model once. Govern centrally. Compose contextually. Render natively. Audit completely.**

This principle applies regardless of whether the experience was initiated by a human, an agent, a scheduled workflow, an API request, or an operational event.

## 1.3 Four distinct responsibilities

| Responsibility | Architectural mechanism |
|---|---|
| What exists and what it means | Canonical ontology and business object contracts |
| What the system can read and do | MCP resources, tools, and prompts |
| What should be presented | A2UI surface and presentation contracts |
| What is permitted to execute | Server-side policy, workflow, and action services |

A2UI does not replace the domain model.

MCP does not replace business authorization.

The agent does not become the system of record.

The renderer does not become the workflow engine.

---

# 2. Revised Reference Architecture

## 2.1 Logical layers

**Layer 1 — Enterprise Systems**

Internal data products, operational applications, external intelligence providers, document repositories, transaction platforms, policy systems, identity systems, and evidence repositories.

**Layer 2 — Canonical Ontology**

The governed enterprise object model:

- Party
- Entity
- Case
- Task
- Skill
- AgentProfile
- Evidence
- Finding
- RiskAssessment
- Decision
- Approval
- Policy
- Execution
- AuditEvent

Includes typed properties, relationships, lifecycle states, classification, provenance, and temporal semantics.

**Layer 3 — Enterprise Capability Plane**

MCP-facing resources, tools, and prompts backed by authorized enterprise services.

Provides discoverable, typed access to canonical business capabilities without exposing raw provider complexity to the consuming agent.

**Layer 4 — Orchestration and Context**

LangGraph workflows, TaskSpecs, Skill Registry, Context Compiler, Capability Resolver, Policy Engine, and human interrupts.

Deterministic workflows remain deterministic. An LLM is invoked where interpretation, planning, synthesis, or presentation composition adds value.

**Layer 5 — Presentation Orchestration**

Transforms authorized business results into UI intents, chooses eligible templates and components, validates A2UI payloads, applies channel constraints, and coordinates actions.

**Layer 6 — Native Experience Renderers**

Desktop web, tablet, mobile, accessibility-oriented interfaces, voice surfaces, and approved constrained-device presentations.

**Cross-cutting — Assurance**

Case Store, Evidence Store, Case Ledger, policy snapshots, execution identity, and OpenTelemetry.

## 2.2 Reference execution sequence

1. An event or user action initiates a business intent.
2. Workflow orchestration determines the authorized task.
3. The Context Compiler assembles task-scoped canonical information.
4. The agent or deterministic service invokes permitted MCP capabilities.
5. Returned results undergo canonical validation and provenance checks.
6. The presentation layer selects an appropriate UI intent and template.
7. The A2UI compiler emits validated declarative surface updates.
8. The native renderer displays the resulting interface.
9. A human interaction generates a typed action request.
10. The action service performs authorization and required validation.
11. Material actions may require preview, review, and approval.
12. Execution results update the authoritative stores.
13. The presentation layer updates the visible state.
14. Assurance Studio correlates the complete sequence.

The A2UI path is a presentation option, not a mandatory dependency for every deterministic system screen.

---

# 3. The Canonical Ontology Becomes the UX Foundation

## 3.1 Model-first rather than page-first

The product should define reusable object experiences independently of screens.

For example, a `Case` can appear as:

- A compact queue item.
- A detailed Case Room.
- An operations summary.
- An approval brief.
- An audit chronology.
- A notification.
- A voice-readable status.

All presentations reference the same canonical object identity and versioned business state.

The renderer changes the representation, not the underlying meaning.

## 3.2 Canonical object descriptor

Every UI-addressable object should support a semantic descriptor containing:

| Property | Purpose |
|---|---|
| Object ID and type | Stable identity |
| Schema version | Contract compatibility |
| Title and summary | Human-readable identity |
| Business state | Canonical lifecycle |
| Classification | Privacy and sensitivity |
| Allowed actions | Authorized operation candidates |
| Source references | Provenance |
| Observed and effective times | Temporal validity |
| Freshness | Staleness and update status |
| Relationship references | Navigation and causal context |
| Evidence status | Verification and uncertainty |
| Policy scope | Purpose, jurisdiction, tenant and entitlement |

Presentation contracts refer to these descriptors instead of inventing business facts.

## 3.3 One object, multiple projections

A business object has three important projections.

**Overview projection**

Minimal status, identity, urgency, and next action.

**Working projection**

Complete task-relevant information, linked objects, visual analysis, and available operations.

**Assurance projection**

Historical versions, provenance, execution history, policy, authorization, and evidence lineage.

These projections become reusable building blocks across the six studios.

---

# 4. MCP Enterprise Capability Design

## 4.1 MCP Resources

MCP Resources expose authorized enterprise information.

Examples of proposed platform URI conventions:

- `fincrime://case/KYB-1042`
- `fincrime://case/KYB-1042/evidence`
- `fincrime://party/P-120/profile`
- `fincrime://entity/E-420/ownership`
- `fincrime://policy/kyc/requirements`
- `fincrime://execution/EX-812/summary`

These are platform-defined URI conventions, not reserved MCP URI schemes.

Resources should return canonical structured information with provenance and freshness.

Access to the resource is re-evaluated using the calling identity and purpose.

A resource reference does not itself grant permission.

## 4.2 MCP Tools

Tools represent typed business operations.

Avoid exposing generic writes such as `updateCase(anyPayload)` to autonomous consumers.

Prefer bounded business operations.

For example:

| Tool | Purpose |
|---|---|
| `case.search` | Discover authorized cases |
| `case.get` | Retrieve a case projection |
| `ownership.resolve` | Execute governed ownership resolution |
| `evidence.compare` | Identify differences across evidence |
| `decision.preview` | Evaluate proposed decision impact |
| `decision.propose` | Create a controlled decision proposal |
| `decision.commit` | Record an authorized decision |
| `workflow.resume` | Resume an interrupted execution |
| `assurance.trace.get` | Retrieve authorized execution details |

Each tool carries a contract with input and output schemas, risk tier, authorization requirements, allowed purpose, side-effect classification, idempotency rules, and audit fields.

The tool description helps the agent select a capability but does not confer authority.

## 4.3 MCP Prompts

Prompts represent reusable guidance and procedures.

Examples:

- Corporate KYB review
- Screening match analysis
- EDD hypothesis investigation
- AML investigation preparation
- Independent QA review
- Decision package preparation

Prompts can provide task guidance, but are not substitutes for executable policy gates or deterministic workflow requirements.

## 4.4 The MCP Gateway

The gateway is a governed access boundary.

Responsibilities include:

- Authentication and caller identity.
- Tenant isolation.
- Scope and purpose validation.
- Tool discovery filtered by authorization.
- Schema validation.
- Tool invocation routing.
- Resource classification and redaction.
- Provider and implementation resolution.
- Rate limits and operational quotas.
- Idempotency enforcement.
- Audit correlation.
- Source provenance.
- Response normalization.

Use the supported MCP protocol revision and negotiate capabilities explicitly. Do not assume every MCP server supports identical authorization, notifications, subscriptions, or long-running-task behavior.

## 4.5 MCP is not the canonical system of record

The existing Case Store remains authoritative for case state.

The Evidence Store retains underlying source material.

The Case Ledger records durable consequential events.

MCP exposes controlled access to those systems.

This protects historical integrity and prevents protocol or client changes from changing the meaning of the business record.

---

# 5. A2UI Design System Architecture

## 5.1 From components to presentation contracts

The existing design system retains its visual foundations:

- Typography
- Color tokens
- Spacing
- Density
- Cards and panels
- Tables
- Graphs
- Instrument banks
- Inspectors
- Evidence displays
- Decision controls
- Accessible input patterns

The change is that approved components also become machine-readable presentation capabilities.

Agents can request eligible components but cannot define arbitrary executable UI.

## 5.2 Component catalog

The initial enterprise A2UI catalog should contain a small set of powerful semantic components.

| Component | Purpose | Relevant experiences |
|---|---|---|
| `StatusHeader` | Object identity, status, freshness | All |
| `ObjectCard` | Canonical business object summary | All |
| `WorkQueue` | Task and exception collection | KYC Workspace |
| `EvidencePanel` | Claims, proof and provenance | KYC, Assurance |
| `EvidenceTimeline` | Source and event chronology | KYC, Assurance |
| `OwnershipGraph` | Corporate control relationships | CDD, EDD |
| `FundFlowGraph` | Financial movement analysis | AML, EDD |
| `RiskAttribution` | Risk factors and calculations | Risk, Decision |
| `PolicyEvaluation` | Rules and obligation results | Decision, QA |
| `ImpactPreview` | Proposed action consequences | All consequential workflows |
| `ApprovalSheet` | Trusted approval interaction | Decision, Compliance |
| `ExecutionTimeline` | Business and technical events | Assurance |
| `TraceInspector` | Tool and span diagnostics | Assurance |
| `ContextBank` | Intelligence capability group | Contextboard |
| `SkillBank` | Skill assignment group | Skillboard |
| `TaskComposition` | Task and dependency arrangement | Taskboard |
| `ComparisonView` | Version and before/after comparison | All |
| `AgentActivity` | Observable agent progress and tool activity | All |
| `ActionBar` | Eligible contextual actions | All |

This catalog is an enterprise extension built on the underlying A2UI representation.

## 5.3 Component descriptor

Each component requires a versioned descriptor containing:

**Identity**

Component ID, version, title, semantic purpose, supported contract versions.

**Properties**

JSON Schema for required data and presentation options.

**Data binding**

Allowed canonical object types, resource references, data projections, freshness requirements, and permitted classifications.

**Interactions**

Declared events and permitted action identifiers.

**Accessibility**

Semantic labels, keyboard behavior, focus policy, screen-reader support, alternative representations, reduced-motion behavior.

**Attention**

Glanceability, information density, maximum meaningful actions, and optional voice summarization.

**Device support**

Desktop, mobile, tablet, wearable, voice, or approved embedded surface.

**Trust**

Whether the component is informational, agent-composable, application-controlled, or reserved for trusted consequential actions.

## 5.4 Four presentation trust classes

**Class P0 — Native application chrome**

Navigation, authentication state, global identity, tenant, security classification, and critical system controls.

Always owned by the application.

**Class P1 — Approved information components**

Status cards, summaries, evidence collections, tables, graphs, and timelines.

May be populated or composed by an agent using approved contracts.

**Class P2 — Interactive workflow components**

Forms, comparisons, candidate selection, proposed changes, and action previews.

Agent-composable within defined constraints. Server validation remains mandatory.

**Class P3 — Trusted consequential actions**

Approvals, regulatory submissions, material case mutations, exceptional risk acceptance, and other high-impact operations.

Application-owned or OS-owned trusted UI; the agent may supply a validated proposal but cannot invent or impersonate the confirmation control.

## 5.5 Hybrid composition model

The platform should favor canonical templates for predictable high-stakes workflows.

Agents may dynamically choose, populate, and arrange permitted information components when doing so adds value.

The proposed **80% canonical templates / 20% dynamic composition** is a useful design heuristic, not a fixed runtime quota.

Complex enterprise workbenches should retain stable layout and interactions. Dynamic composition should concentrate on contextual summaries, evidence presentations, investigative comparisons, and task-specific panels.

---

# 6. Presentation Intent as a New Architectural Contract

## 6.1 Why presentation intent is needed

An agent should not have to decide directly how a dense desktop workspace translates into a watch notification.

Instead, the system first defines the business meaning of the presentation.

For example:

**Intent:** `decision.review_required`

**Subject:** Case KYB-1042

**Audience:** Authorized compliance approver

**Purpose:** Review an unresolved ownership exception.

**Evidence:** Versioned decision package and supporting references.

**Available action:** Review decision package.

**Action risk:** Consequential.

**Required attention:** High.

**Suitable channels:** Desktop and approved mobile review.

The renderer then chooses a permitted representation.

## 6.2 Proposed presentation-intent contract

| Field | Description |
|---|---|
| `intent_id` | Stable semantic intent |
| `intent_version` | Contract version |
| `object_refs` | Relevant canonical subjects |
| `audience_context` | Role, permissions and purpose |
| `priority` | Operational priority |
| `data_projection` | Requested information scope |
| `evidence_refs` | Sources supporting the presentation |
| `available_action_refs` | Governed action candidates |
| `attention_class` | Overview, working, investigative, consequential |
| `freshness_policy` | Validity and update rules |
| `preferred_template` | Optional canonical presentation |
| `fallback_template` | Deterministic safe alternative |

The presentation orchestrator converts this semantic intent into validated A2UI messages for an eligible client.

## 6.3 Three levels of adaptation

**Level 1 — Data adaptation**

Select the information relevant to the user's task.

**Level 2 — Interaction adaptation**

Select eligible controls based on authority, attention, and device.

**Level 3 — Layout adaptation**

Map the content and interactions into native components, density, and input conventions.

The business semantics must not change between levels.

---

# 7. How the Existing Studios Evolve

## 7.1 Contextboard

### Visual experience preserved

The analog-inspired intelligence banks remain.

### Architectural changes

Each bank represents canonical capabilities exposed through the governed capability plane.

The corresponding presentation contracts reference capability definitions, source-binding metadata, policy status, and context requirements.

Selecting a capability may trigger authorized MCP reads to retrieve mapping, health, or configuration information.

Switching a capability in draft mode creates a proposed configuration change, not an immediate production mutation.

### New cross-cutting experience

The Contextboard inspector can generate an A2UI `ContextPreview` surface showing the result of a governed context dry run.

The same preview can appear within Skillboard or Assurance Studio without creating a duplicate UI implementation.

## 7.2 Agent Studio

### Visual experience preserved

The specialist workforce, agent profile, mandate, skills, context bindings, and publication experience remain.

### Architectural changes

Agent profiles are canonical, versioned objects.

Tasks and skill assignments are represented as typed resources.

Agent actions—validate, compare, rehearse, propose publication—are exposed through governed operations.

The A2UI layer is primarily used to render evaluation findings, contract comparisons, and context-specific engineering inspectors.

Agent-generated UI must not directly alter agent mandates, published configurations, or runtime authority.

## 7.3 Taskboard and Skillboard

### Visual experience preserved

The task-centered instrument with grouped skill keys and a dependency inspector remains.

### Architectural changes

Task composition is driven by versioned TaskSpec contracts.

Skill assignments reference canonical skill IDs.

A compiler resolves composite dependencies and validates compatibility before execution.

The Skillboard can render context readiness and evaluation results supplied through shared enterprise resources.

The agent may recommend a skill composition, but configuration changes require explicit validation and publication.

## 7.4 KYC Workspace

### Visual experience preserved

The role-aware My Workspace, shared Case Room, and six specialist workbench families remain.

### Architectural changes

Business objects and actions become reusable headless capabilities.

Agent-generated work products may populate contextual A2UI cards, summaries, evidence panels, comparisons, and investigation artifacts.

The application preserves the stable Case Room layout.

The agent does not recreate the complete screen for every interaction.

A CDD analyst still receives an ownership workbench; an AML investigator still receives a fund-flow experience; a compliance approver still receives an application-controlled Decision Desk.

## 7.5 Assurance Studio

### Visual experience preserved

Mission Control, Flight Recorder, Decision Lineage, and Assurance Lab remain.

### Architectural changes

Assurance Studio becomes a consumer of the same canonical objects, action contracts, and presentation events used by the other studios.

It can reconstruct:

- Why an agent selected a capability.
- Which tool was called.
- Which authorized data was returned.
- Which A2UI surface was presented.
- What information the human actually received.
- Which action was selected.
- What preview was displayed.
- Which approval was recorded.
- What durable mutation occurred.

This introduces **presentation lineage** as an extension of execution lineage.

---

# 8. Unified Interaction Pattern — Stream, Canvas, Verification

## 8.1 Agent Stream

The stream describes observable activity without exposing private model reasoning.

Examples:

- Retrieving authorized customer records.
- Comparing ownership declarations against registry filings.
- Evaluating unresolved control relationships.
- Waiting for approval.
- Revalidating a changed source.
- Resuming a suspended workflow.

Every action entry may expose its tool invocation, results, timing, and trace references.

The stream must distinguish proposed, running, completed, failed, and interrupted operations.

## 8.2 Generative Canvas

The canvas displays task-relevant structured work products.

Possible outputs include:

- Ownership graph.
- Evidence comparison.
- Screening match review.
- Risk assessment.
- Investigation narrative.
- Policy evaluation.
- Action impact preview.

The canvas uses approved components from the enterprise A2UI catalog.

Dynamic updates should not unexpectedly rearrange actively selected or edited content.

## 8.3 Verification Drawer

A persistent or expandable inspector provides:

- Provenance.
- Source and observation time.
- Verification status.
- Canonical object references.
- Conflicting evidence.
- Applicable policy.
- Execution history.
- Uncertainty.
- Action authority.

Users should be able to move from a finding to its original evidence without re-running an investigation.

## 8.4 Human Steering

Users may:

- Refine task scope.
- Request more evidence.
- Challenge an assertion.
- Compare alternatives.
- Approve a bounded plan.
- Reject a recommendation.
- Route a question for review.
- Resume an authorized workflow.

Steering becomes a recorded action, not an undocumented modification to an agent's internal state.

---

# 9. First-Class Enterprise Action Contracts

## 9.1 Separate insight from action

The platform must maintain four distinct business states:

1. Observation.
2. Recommendation.
3. Proposed action.
4. Committed action.

A recommendation is not an approval.

A preview is not a mutation.

An optimistic UI update is not proof of successful execution.

## 9.2 Proposed action lifecycle

**Discover → Preview → Propose → Authorize → Commit → Confirm → Audit**

For low-risk actions, some stages may be simplified under policy.

For consequential operations, the complete lifecycle should be visible.

## 9.3 Action descriptor

Each action contract defines:

- Action identifier and version.
- Business meaning.
- Input schema.
- Subject object types.
- Required authority.
- Side-effect classification.
- Risk tier.
- Preview support.
- Approval requirements.
- Idempotency.
- Preconditions.
- Conflict detection.
- Valid state transitions.
- Reversibility or compensation.
- Audit event contract.
- Result schema.

## 9.4 UX autonomy tiers

| Tier | Nature | User experience |
|---|---|---|
| L0 | Authorized reads and summaries | Automatic presentation |
| L1 | Low-risk reversible action | Bounded confirmation or policy-permitted streamlined action |
| L2 | Consequential action | Explicit impact preview, review, and authorization |
| L3 | High-impact, irreversible, or separation-of-duties action | Trusted approval flow, potentially dual control |

Actual tier assignment is determined by the institution's policies and action semantics.

The tiers are not unrestricted agent autonomy levels.

## 9.5 Trusted approval interface

The trusted Approval Sheet must present:

- Exact business action.
- Object and subject.
- Before-and-after values where relevant.
- Impact.
- Evidence and policy links.
- Required actor authority.
- Approval obligations.
- Action version and expiration.
- Explicit confirmation.

The server generates an integrity-protected action reference bound to the proposed operation and context.

The client cannot arbitrarily substitute another action or payload.

The server revalidates authorization, object state, and preconditions at commit.

The agent is never trusted to self-attest approval.

## 9.6 Irreversible operations

Regulatory filings and other irreversible operations must not be treated as ordinary undoable UI actions.

They require explicit authority, appropriate human controls, idempotency, durable submission, and external receipt reconciliation.

A failed response cannot automatically be interpreted as a failed submission.

---

# 10. Device and Attention Adaptation

## 10.1 Core principle

**Render the intent, not a scaled copy of the desktop screen.**

A desktop workbench, mobile card, and voice summary may share a business object and presentation intent while using different controls and information density.

## 10.2 Device capability negotiation

Each renderer advertises a platform capability profile.

Representative fields include:

- Renderer ID and version.
- Supported A2UI version.
- Supported component catalog.
- Input modalities.
- Screen class.
- Density.
- Accessibility capabilities.
- Maximum action complexity.
- Attention constraints.
- Local device policy.
- Offline availability.
- Authentication capability.
- Trusted confirmation support.

The presentation service may produce a different surface for each profile.

Unsupported interactions must be omitted or replaced with safe navigation, not approximated with untrusted controls.

## 10.3 Device adaptation matrix

| Device | Recommended experience | Consequential actions |
|---|---|---|
| Desktop web | Full workspace, linked graphs, tables, inspectors | Permitted through trusted approval flows |
| Tablet | Focused split-pane workspace | Permitted when full review is supported |
| Mobile | Task summaries, evidence review, compact comparisons | Only if sufficient context and authentication are available |
| watchOS | Glanceable status and reminders | Generally defer KYC approvals to an appropriate device |
| Voice | Status, explanation and guided navigation | Do not rely on voice alone for complex financial crime approvals |
| CarPlay | Only platform-eligible, driving-safe notifications or interactions | Suppress detailed case review and consequential approvals |
| Automotive proprietary systems | Only where a supported platform integration and safety review exist | Determined by device policy and attention state |

No universal A2UI renderer support is assumed for watchOS, CarPlay, or proprietary automotive systems.

Device-specific adapters are required where legally and technically permitted.

## 10.4 Attention-aware content

### Glance

One status, one meaningful change, and at most a narrowly permitted next action.

### Card

Short explanation, importance, supporting status, and safe navigation.

### Detail

Full evidence and task context.

### Workspace

Dense analysis, linked selection, comparison, and consequential review.

### Raw inspection

Canonical payload, audit history, technical trace, and controlled diagnostics.

These layers form a progressive information hierarchy.

## 10.5 No unsafe truncation

A complex approval must not be transformed into an oversimplified yes/no interaction merely to fit a small screen.

When the required evidence cannot be displayed appropriately, the interface should offer a safe handoff:

**Review on a supported device.**

---

# 11. Realtime UI and Streaming Architecture

## 11.1 Realtime is an explicit contract

MCP access alone does not guarantee arbitrary resource subscription semantics.

The platform should use supported MCP notifications or subscriptions where available, with a dedicated event distribution service where needed.

The application may use SSE, WebSockets, or another appropriate delivery mechanism for presentation updates.

Transport choice must be separated from business event semantics.

## 11.2 A2UI surface lifecycle

The renderer manages:

- Surface creation.
- Component definition updates.
- Data-model updates.
- User interactions.
- Surface deletion.
- Error reporting.

A2UI messages are validated against the selected protocol and component catalog before rendering.

The application must reject unsupported or invalid structures.

## 11.3 Recommended patch envelope

The platform should extend its presentation delivery with:

- Surface ID.
- Surface revision.
- Message sequence.
- Event correlation reference.
- Object version.
- Data revision.
- Patch type.
- Freshness.
- Source status.
- Integrity metadata where required.

The client uses these fields to detect duplicate, outdated, or inconsistent updates.

This is a proposed application-level delivery envelope, not a claim that every field is part of standard A2UI.

## 11.4 Canonical asynchronous states

- Idle
- Loading
- Streaming
- Ready
- Stale
- Conflict
- Offline
- Degraded
- Retryable failure
- Terminal failure
- Awaiting approval
- Committing
- Confirmed

States must be explicit and semantically consistent.

## 11.5 Stable layout during updates

Keep fixed locations for core work items.

Use reserved space for critical metrics.

Update values in place.

Avoid changing scroll position during background updates.

Do not automatically reorder a queue while the user is interacting with it.

Instead, show a discreet notification indicating that new results are available.

## 11.6 Reconciliation

The server remains authoritative.

Optimistic updates are allowed only for appropriately reversible interactions.

Consequential actions show a pending state until server confirmation.

Version conflicts produce an explicit comparison and resolution experience rather than silent overwriting.

## 11.7 Degraded-mode behavior

If an agent or presentation service fails:

1. Preserve the current valid UI.
2. Mark affected information as stale when appropriate.
3. Disable actions that cannot be safely authorized or validated.
4. Offer the canonical deterministic screen.
5. Permit retries or resumption only through valid execution paths.
6. Record the failure for Assurance Studio.

A failed A2UI message must never blank a mission-critical workspace.

---

# 12. Security and Trust Boundaries

## 12.1 Five trust boundaries

**Boundary A — External and internal data**

Provider results and retrieved documents are untrusted input, regardless of source reputation.

**Boundary B — MCP capability execution**

Every action is checked by the server against caller identity, policy, and permitted scope.

**Boundary C — Agent interpretation**

Agent plans, summaries, and component proposals are not authoritative business facts.

**Boundary D — A2UI rendering**

Only allowlisted, versioned components and validated data bindings are accepted.

**Boundary E — Consequential action**

High-impact actions use trusted controls and server-verified authorization.

## 12.2 Threat scenarios

The architecture must explicitly address:

- Prompt injection inside retrieved evidence.
- Forged resource metadata.
- Unauthorized MCP tool discovery.
- Cross-tenant resource exposure.
- Excessive data hydration.
- UI spoofing.
- Misleading evidence or confidence labels.
- Forged approval affordances.
- Replayed commit requests.
- Stale action confirmation.
- Out-of-order UI patches.
- Sensitive information leakage through telemetry.
- Unauthorized cross-device presentation.

## 12.3 Defense principles

- Treat retrieved content as data, not instructions.
- Enforce schemas at capability and presentation boundaries.
- Use scoped identities and purpose restrictions.
- Validate object-level and action-level access.
- Keep authoritative status separate from agent-generated labels.
- Bind consequential actions to trusted server-side references.
- Recheck permission and state before commit.
- Retain stable provenance and execution identity.
- Fail closed for unsafe actions.
- Fall back to validated canonical screens.

The renderer should not execute arbitrary code received from an agent.

---

# 13. Audit and Observability Extension

## 13.1 Presentation lineage

The existing Assurance Studio correlates Case Store, Evidence Store, Case Ledger, and OpenTelemetry.

The MCP + A2UI architecture adds two new entities:

**Capability Invocation**

A governed tool or resource operation performed through the enterprise capability plane.

**Presentation Event**

A recorded description of what was displayed, updated, selected, or confirmed in the user interface.

These enable auditors to connect execution to human perception and action.

## 13.2 Extended correlation identities

The audit model should support:

- Case ID.
- Workflow run ID.
- Task execution ID.
- Skill execution ID.
- Capability invocation ID.
- Tool invocation ID.
- Trace ID and span ID.
- Context manifest reference.
- Source evidence references.
- Presentation intent ID.
- A2UI surface ID.
- Surface revision.
- User interaction ID.
- Action proposal ID.
- Approval ID.
- Commit ID.
- Ledger event ID.

A single trace ID is insufficient for long-running cases spanning asynchronous tasks, human interrupts, and multiple executions.

Use a durable correlation graph, with trace IDs connected to it.

## 13.3 Revised Flight Recorder

The Flight Recorder gains a presentation lane.

Its synchronized views become:

**Business**

Case events and decisions.

**Agent and workflow**

Tasks, skills, checkpoints, delegates, and interrupts.

**Capabilities**

MCP resources, tools, policy checks, invocation results, and failures.

**Presentation**

What UI surface was generated and presented, which object revisions it contained, and which interaction occurred.

**Technical execution**

OpenTelemetry spans, latency, errors, dependencies, and operational diagnostics.

## 13.4 Historical presentation reconstruction

An auditor should be able to answer:

- What information was available to the agent?
- What tool calls occurred?
- What result was returned?
- Which finding was communicated to the user?
- Was that finding marked verified or uncertain?
- What evidence was displayed?
- What action did the user select?
- What impact preview did the user receive?
- Was the approval valid and current?
- What mutation actually committed?

Presentation reconstruction must use retained UI payloads, presentation contracts, object versions, and relevant evidence references.

A current UI rendering should not be presented as an exact historical screen unless the original state is sufficiently preserved.

## 13.5 Audit-critical recording

Consequential decisions and human authorizations must be recorded durably even when distributed tracing is sampled.

The platform should record presentation intent, trusted action references, approval identity, policy evaluation, and resulting mutation independently of optional technical telemetry.

Record hashes or other integrity references where required.

## 13.6 Feedback into improvement

Assurance Lab can detect:

- Confusing approval presentations.
- Misleading freshness labels.
- Excessive agent-generated components.
- Evidence missing from human decision views.
- Repeated action-preview rejection.
- Invalid A2UI schemas.
- Unsupported device presentations.
- Excessive UI patch traffic.
- Permission failures.
- Failed renderers.

These findings can produce controlled improvement candidates for UI contracts, agent instructions, skill definitions, or capability implementations.

---

# 14. Revised UX Governance Model

## 14.1 New registries

The platform now requires six governed registries:

| Registry | Responsibility |
|---|---|
| Ontology Registry | Business objects, relationships, semantics |
| Capability Registry | MCP resource and tool bindings |
| Skill Registry | Canonical reusable business skills |
| Agent & Task Registry | Mandates, tasks, compositions |
| Presentation Registry | UI intents, components, templates |
| Policy & Authorization Registry | Rules, actions, permissions and approvals |

These registries are logically distinct, though implementation may consolidate storage and management services.

## 14.2 Presentation publication lifecycle

Draft → Schema validation → Accessibility validation → Security validation → Device compatibility → Integration testing → Approval → Published.

Published presentation contracts are immutable references.

Breaking changes require version migration or explicit client compatibility handling.

## 14.3 Who can author what

**Product Designer**

Design tokens, interaction templates, component behavior, accessibility, attention profiles.

**Business Architect**

Ontology semantics, business projections, workflow intents, task experience requirements.

**Agent Architect**

Agent mandates, task and skill compositions, permitted presentation patterns.

**Platform Engineer**

MCP bindings, component integration, renderer capabilities, streaming implementation.

**Security and Compliance**

Action authority, trusted components, information classification, approval requirements.

**Audit and QA**

Trace completeness, presentation integrity, replay validation, evaluation criteria.

Agents may propose eligible compositions but do not become publishers of trusted application code or approval controls.

---

# 15. Example — Corporate KYB Decision Review

## 15.1 Business scenario

A CDD analyst encounters a material unresolved ownership relationship.

The Identity & Ownership Agent produces findings requiring human review.

The workflow enters a LangGraph interrupt.

The user must inspect evidence and provide an authorized response.

## 15.2 Headless flow

**Context**

Retrieve the relevant canonical case, entity, ownership graph, source evidence, and applicable policy.

**Skill execution**

`ownership.ubo.resolve` produces a result with unresolved paths and evidence references.

**Workflow**

The task enters `NEEDS_REVIEW`.

**Presentation intent**

`ownership.review_required`

**Desktop representation**

The existing CDD workbench opens its ownership graph with the unresolved path selected.

The right inspector displays the discrepancy, evidence, uncertainty, and policy obligation.

**Mobile representation**

A concise review-needed card shows the case, material issue, current status, and navigation to an authorized review experience.

**Wearable representation**

A permitted status notification indicates that review is required, without exposing sensitive details or providing an oversimplified approval.

## 15.3 Human response

The analyst requests additional evidence or records a validated review outcome.

The action follows the governed preview, authorization, and commit lifecycle.

The workflow resumes only after the required conditions are met.

## 15.4 Assurance

The Flight Recorder correlates:

- Context hydration.
- Skill execution.
- Ownership findings.
- Policy evaluation.
- Interrupt and checkpoint.
- Presentation intent.
- UI surface version.
- Human interaction.
- Authorized action.
- Resumed execution.
- Updated case state.

No visual representation is allowed to bypass the underlying state transition.

---

# 16. Screen Inventory Impact

The original 25-screen inventory remains the baseline.

The change is primarily in implementation contracts and reusable overlays rather than navigation or aesthetics.

| Existing screen | Added headless capability | A2UI contract impact |
|---|---|---|
| Contextboard Overview | Intelligence registry read | `ContextBank`, `StatusHeader` |
| Context Composition | Profile preview and proposal | `ContextBank`, `ImpactPreview` |
| Provider Workbench | Connector metadata and diagnostics | `ObjectCard`, `TraceInspector` |
| Agent Profile | Agent registry resources | `ObjectCard`, `StatusHeader` |
| Taskboard | TaskSpec read and validation | `TaskComposition` |
| Skillboard | Skill registry and dependency compilation | `SkillBank`, `ComparisonView` |
| Rehearsal | Test execution services | `ExecutionTimeline`, `EvidencePanel` |
| My Workspace | Case and task resources | `WorkQueue`, `ActionBar` |
| Case Room | Canonical case projections | `ObjectCard`, `EvidencePanel` |
| CDD Workbench | Ownership and registry intelligence | `OwnershipGraph` |
| EDD Workbench | Investigation and evidence services | `EvidenceTimeline`, `ComparisonView` |
| AML Workbench | Transaction and network capabilities | `FundFlowGraph` |
| Screening Workbench | Match and disposition capabilities | `ComparisonView`, `EvidencePanel` |
| Risk Workbench | Risk and policy services | `RiskAttribution` |
| Decision Desk | Governed preview and commit actions | `PolicyEvaluation`, trusted `ApprovalSheet` |
| QA Workbench | Evidence and control validation | `EvidencePanel`, `ComparisonView` |
| Mission Control | Execution and operations projections | `StatusHeader`, `WorkQueue` |
| Flight Recorder | Correlated execution and ledger data | `ExecutionTimeline`, `TraceInspector` |
| Decision Lineage | Provenance and causal graph access | `EvidencePanel`, graph components |
| Assurance Lab | Evaluation and regression resources | `ComparisonView`, `ExecutionTimeline` |

The reusable components and object contracts reduce duplicate work without eliminating purpose-built specialist experiences.

---

# 17. Implementation Roadmap

## Phase 1 — Headless Foundation

**Goal:** Expose one existing business workflow through governed capabilities.

Recommended first workflow: Corporate KYB ownership review.

Deliver:

- Canonical object contracts.
- MCP resource and tool interfaces.
- Context and policy enforcement.
- Preview and commit semantics.
- Auditable execution identity.
- Existing UI connected through the capability layer.

**Exit criterion:** The original UI works without direct provider-specific business integration logic.

## Phase 2 — A2UI Foundation

**Goal:** Introduce declarative presentation without redesigning the visual system.

Deliver:

- Presentation Registry.
- Component JSON Schemas.
- Approved A2UI catalogs.
- Initial web renderer.
- Contextual evidence and action components.
- Server-side surface validation.
- Deterministic fallback screens.

Begin with six to eight foundational components and expand based on real workflows.

**Exit criterion:** The same semantic work product can be rendered from a validated contract.

## Phase 3 — Agent-Enabled Presentation

**Goal:** Allow agents to populate and compose approved presentation surfaces.

Deliver:

- Presentation intent planner.
- A2UI compiler.
- Agent activity stream.
- Evidence drawer.
- Task-specific UI composition.
- Read-only and preview-first action flows.
- Presentation lineage.

**Exit criterion:** An agent can produce a useful, evidence-backed UI without arbitrary frontend code execution.

## Phase 4 — Consequential Actions

**Goal:** Support governed human decisions.

Deliver:

- Typed action proposals.
- Impact previews.
- Trusted approval interface.
- Authorization rechecks.
- Idempotent commit.
- Conflict handling.
- Human interrupts and resume.
- Audited action outcomes.

**Exit criterion:** Consequential actions remain safe under stale UI, retries, failures, and agent mistakes.

## Phase 5 — Adaptive Multi-Client Experiences

**Goal:** Use one semantic intent across supported devices.

Deliver:

- Capability negotiation.
- Mobile renderer.
- Attention-aware presentation profiles.
- Voice-oriented summaries where appropriate.
- Device-specific security constraints.
- Cross-device continuity.
- Accessibility validation.

Constrained automotive surfaces should be considered only where the application category, platform integration, and safety requirements permit the intended use.

**Exit criterion:** Device adaptation preserves semantics and never weakens authorization or required review.

## Phase 6 — Assurance and Optimization

**Goal:** Make agentic UI behavior measurable and auditable.

Deliver:

- Presentation-event capture.
- Unified execution correlation.
- Historical surface reconstruction.
- Renderer diagnostics.
- Contract regression testing.
- Trace-driven improvement candidates.
- Continuous UX quality evaluation.

**Exit criterion:** An authorized auditor can reconstruct what the system did, what the user saw, and which action was ultimately committed.

---

# 18. Nonfunctional Acceptance Criteria

## Security

No agent-generated payload can execute arbitrary application code.

All material MCP actions are authorized server-side.

Trusted approval controls cannot be spoofed by agent-generated content.

No cross-tenant data or presentation state leaks.

## Correctness

Canonical facts retain their epistemic status.

Resource freshness is visible.

UI data bindings resolve only authorized objects.

A2UI schema violations fail safely.

## Reliability

Invalid surfaces fall back to canonical views.

Lost event streams reconnect with consistent state reconciliation.

Out-of-order and duplicate updates do not corrupt the visible business state.

Consequential writes are never falsely shown as committed.

## Auditability

Every material action links to an actor, authority, context, and recorded outcome.

Presentation events correlate to underlying execution and ledger references.

Missing telemetry is explicitly disclosed.

## Accessibility

All core desktop workflows support keyboard and assistive technology.

Charts and graphs offer accessible alternatives.

Dynamic updates preserve focus and orientation.

Reduced-motion settings are honored.

## Portability

Business intent is independent of device layout.

Unsupported controls are not silently substituted.

A presentation may degrade in detail but must not degrade in accuracy, authority, or safety.

## Performance

The interface must support high-density enterprise analysis with virtualized collections, stable layout under live updates, bounded patch sizes, and efficient selective data retrieval.

Performance targets should be established against measured workloads rather than assumed numeric thresholds.

---

# 19. Critical Architectural Decisions

The following decisions should be formalized as Architecture Decision Records.

**ADR-01 — Canonical ontology is the semantic source of truth.**

**ADR-02 — MCP is the governed capability-access interface, not the business system of record.**

**ADR-03 — A2UI is a declarative presentation protocol, not an authorization or workflow engine.**

**ADR-04 — Existing application chrome and consequential controls remain trusted native UI.**

**ADR-05 — Agent-generated surfaces are restricted to allowlisted, versioned presentation contracts.**

**ADR-06 — Task and skill contracts remain independent of presentation contracts.**

**ADR-07 — Durable case identity and execution correlation span multiple technical traces.**

**ADR-08 — Historical reconstruction and counterfactual simulation remain separate.**

**ADR-09 — Device adaptation cannot weaken action authority or required human review.**

**ADR-10 — Deterministic canonical screens are the fallback for presentation failures.**

**ADR-11 — The application must support both agent-composed and non-agentic rendering paths.**

**ADR-12 — UI presentation and consequential human interactions are first-class auditable events.**

---

# 20. Recommended Product Architecture

The end-state should be understood as three major, independently governed planes.

## Intelligence Plane

**What is known?**

Canonical ontology, internal data products, external providers, semantic mappings, context compilation, evidence, and authorization.

Exposed through Contextboard and authorized MCP resources.

## Action Plane

**What can be done?**

Agent Profiles, TaskSpecs, Skill Contracts, capability resolution, LangGraph orchestration, deterministic services, governed tools, and human decision services.

Designed through Agent Studio, Taskboard, and Skillboard.

## Experience Plane

**What should a human see and be able to do?**

Presentation intents, A2UI contracts, native components, adaptive rendering, trusted actions, and role-aware workflows.

Experienced through KYC Workspace and the other studios.

**Assurance Studio spans all three planes**, preserving the relationships among information, execution, presentation, and decisions.

---

# 21. Final Design Standard

The evolution to MCP and A2UI must not erase the sophistication already established in the product.

Contextboard remains an intuitive enterprise intelligence instrument.

Skillboard remains a task-aware composition instrument.

KYC Workspace remains a specialist business operating environment.

Assurance Studio remains a causality and evidence investigation environment.

What changes is the architectural mechanism behind their presentation and behavior.

The application moves from tightly coupled screen implementations toward a consistent collection of semantic objects, governed capabilities, versioned presentation contracts, and native renderers.

Agents become capable of assembling appropriate interfaces from approved building blocks, but never become the final authority over business facts, security, or consequential actions.

The platform remains understandable even when agents fail, sources become stale, or presentation contracts are invalid.

**The north star is a single enterprise system in which intelligence, action, presentation, human judgment, and auditability remain connected—regardless of which agent initiated the work or which supported device is used to experience it.**

---

## Technical Reference Baseline

The implementation should pin and test its chosen protocol revisions against the official specifications rather than relying on examples from mixed versions.

- MCP specification and SDK documentation: https://modelcontextprotocol.io
- MCP July 2026 specification: https://blog.modelcontextprotocol.io/posts/2026-07-28/
- A2UI specification and renderer documentation: https://a2ui.org
- A2UI v1.0 protocol: https://github.com/a2ui-project/a2ui
- Apple CarPlay developer constraints: https://developer.apple.com/carplay/
