# Financial crime skill implementation plan

Status: proposed implementation design; no production skills implemented by this plan.  
Implementation follow-through: [release status and verification](implementation-status.md), [integration API](integration-guide.md). The plan below is retained as the approved design baseline.
Date: 2026-11-07.  
Source: [canonical specification](../financial_crime_canonical_skills_spec_v1.md).  
Companions: [consolidated context specification](context-specification.md), [all-skill design backlog](skill-design-backlog.md).

> **Hosting update.** The Foundry hosting path this plan originally targeted has been removed from the library and the platform. Skills are hosted by the portable skill.execution.v1 skill host (`src/financial_crime/runtimes/skill_host.py`, the container's default) or the EHF bridge host (`financial_crime.ehf.create_bridge_host`), both standard-library HTTP servers with no cloud SDK; the platform reaches them from its capability gateway, and its own runtimes are `local_http`, `hosted_http` and `databricks`. Where this dated plan says "remote runtime" or "hosted adapter", read one of those hosts. See [integration guide](integration-guide.md) and [implementation status](implementation-status.md).

## 1. Outcome and agreed starting conditions

Build all 222 canonical skills as versioned, executable packages that workflows and agent profiles can invoke through a common execution service. Start with jurisdiction-neutral contracts, synthetic policy fixtures and local test providers, as selected by the user. A remote HTTP host (now the skill host or bridge host) is the first remote target; local execution is the reference implementation.

The deliverable is a library and execution contract, with real instructions, deterministic logic, declared dependencies, provider interfaces and tests. A manifest or generated SKILL.md alone is not an implementation. A synthetic implementation is executable and testable but does not establish real-world identity, screening coverage, authenticity or compliance.

This change provides the design and build plan first. It does not create 222 placeholders or claim those skills exist.

## 2. Catalog review

The repository currently contains the canonical Markdown specification and no implementation, package configuration, adapters, agent profiles or runtime code.

| Finding | Design consequence |
| --- | --- |
| 222 unique skills in 20 domains | Preserve every canonical ID and produce a coverage report against the source catalog. Do not equate a skill with a container, agent or service. |
| Only 10 distinct input descriptions and 10 output descriptions across 222 entries | Define actual parameter and result schemas for every skill; domain defaults are insufficient. |
| 20 context lists, one per domain | Replace blanket object lists with per-skill field requirements, selectors, cardinality, freshness and missing-data behavior. |
| Every skill shares the same evidence description and acceptance description | Write behavior-specific evidence and acceptance criteria before implementation. |
| Baseline modes: 115 deterministic, 82 hybrid, 12 model-assisted, 6 retrieval, 7 human-gated | Separate computation type, provider dependency, composition and authorization. These dimensions can coexist. |
| The union of declared context types contains 81 names | Normalize aliases, define the missing object contracts and distinguish runtime context from evaluation/control-plane data. |
| The 24-skill roadmap omits five skills referenced by the KYB workflow | Add `case.create`, `decision.policy.resolve`, `ownership.ubo.verify`, `decision.disposition.record`, `monitor.customer.schedule`; then calculate the full dependency closure. The resulting slice may exceed 29. |
| Domain labels can conceal mixed behavior | For example, expiry validation can be deterministic; document parsing needs parsers/providers; authenticity assessment needs specialist evidence; a human gate is not an algorithm. Review each row. |
| Quality checks are described as deterministic even when semantic verification is required | Separate deterministic citation/schema checks from model or human assessment of whether a source supports a claim. Do not promise perfect hallucination detection. |
| `case.context.hydrate` is itself a skill | Implement the context compiler as execution infrastructure; expose it through this skill without recursive self-invocation. |
| Workflow examples contain shorthand such as `screening.*`, conditional EDD and human review | Compile these into explicit, versioned steps, branches, joins and approval tasks. Wildcards cannot become executable workflow nodes. |

## 3. Architecture and responsibilities

```text
Workflow definition + Agent profile + Invocation + Actor authorization
                             |
                 Run planner / admission controller
       resolve versions -> check dependencies -> pin execution lock
                             |
            Context compiler + capability/provider resolver
                             |
                 Runtime-neutral execution service
              /              |                \
        Python/code     Model-assisted     Composition/human task
              \              |                /
             Validate result + verify evidence + commit controls
                             |
           Case/evidence/event stores + durable checkpoints
                             |
               Local adapter / remote HTTP host adapter
```

The diagram shows logical responsibilities. The runtime adapter hosts the executor; it is not necessarily a network hop after persistence. Skills use injected interfaces rather than platform SDKs or direct database credentials.

| Component | Owns | Must not own |
| --- | --- | --- |
| Skill package | Business contract, instructions, implementation, dependencies, evaluation cases | Global tenant access, arbitrary tool discovery, final authority inferred from a prompt |
| Agent profile | Role instructions, allowed skills, model requirements, planning bounds, context ceiling, approval constraints | Copies of skill algorithms or executable policy overrides |
| Workflow | Required order, branches, task dependencies, durable progress, joins and completion criteria | Vendor-specific API payloads |
| Executor | Admission, validation, invocation, result persistence, authorization, retries, audit | Domain policy invented by a model |
| Context compiler | Authorized, time-aligned, minimal snapshots and governed enrichment | Hidden expansion of access or treating conversation history as fact |
| Capability/provider adapter | Canonical request/response mapping and source capture | Business outcome definitions or silent fallback to weaker coverage |
| Runtime adapter | Identity propagation, transport, hosting, cancellation and recovery mapping | Changes to canonical skill semantics |

Use Python as the proposed first implementation language because the source already calls for Python/Pydantic contracts and graph/rule computations. Keep JSON Schema and transport contracts language-neutral. Confirm SDK-compatible Python and package versions during the first compatibility spike, then lock them.

## 4. Standard executable skill package

```text
skills/entity/resolve/
  SKILL.md                 # concise trigger, procedure, uncertainty, tool use
  skill.yaml               # canonical entity.resolve, semver, schemas, capabilities
  input.schema.json        # skill-specific parameters
  output.schema.json       # skill-specific payload
  context.yaml             # required/optional fields and retrieval bounds
  implementation.py        # typed entrypoint or explicit composite definition
  tests/                   # fixtures and observable behavior assertions
  references/              # only conditional domain guidance that is needed
```

Use `entity-resolve` for skill frontmatter names when a harness requires hyphenated names; keep `entity.resolve` as the canonical registry ID. Maintain an explicit bijective mapping. Deterministic callers can invoke the implementation without loading prose. Model-assisted callers load the instructions and only the references relevant to their task.

The manifest extends the source contract with explicit implementation and deployment metadata:

```yaml
id: entity.resolve
version: 0.1.0
implementation:
  kind: composite                 # code | model | provider | composite | human_task
  entrypoint: financial_crime.skills.entity.resolve:execute
instructions: SKILL.md
schemas:
  input: input.schema.json
  output: output.schema.json
context: context.yaml
dependencies:
  skills: []                      # populated by the approved design card
  capabilities: []               # provider-neutral contracts, not API secrets
  libraries: []                  # resolved in the bundle lockfile
effects:
  mode: proposal                 # read_only | proposal | internal_write | external_write
authorization:
  required_permissions: []       # explicit action permissions added per design
evaluation_profile: entity-resolution-v1
```

This is an illustration of fields, not a complete or executable manifest. Each real definition must supply the full required fields from source section 4, including policy, timeout, retry, failure, evidence, ownership and deprecation settings.

Distinguish four dependency graphs: Python/package dependencies, skill calls, capability/provider requirements, and workflow data dependencies. Validate cycles and version compatibility separately. Composite skills call smaller skills; primitives do not call their parent composites. Runtime infrastructure primitives are injected services, not mandatory business-skill calls.

Do not install arbitrary packages or execute freshly downloaded code during an invocation. Resolve and package dependencies at build time. Dynamic assembly selects from a trusted, compatible set of published packages. A new code dependency requires a new tested bundle/image; changing only an allowed profile configuration need not rebuild the image.

## 5. Per-skill design and build process

Apply this process to every row in the [222-skill backlog](skill-design-backlog.md).

1. **Write the design card.** Specify outcome, non-goals, caller, precise parameters, typed payload, failure semantics and evidence. Replace generic language with concrete behavior and examples.
2. **Declare context.** Name exact fields and selectors, required versus optional data, minimum counts, graph/window bounds, freshness, source authority, conflict handling and action on missing data. Update the shared context coverage matrix in the same change.
3. **Choose execution and dependencies.** Identify pure calculations, provider calls, inference, composition and human tasks. Declare candidate dependencies and make the call graph acyclic. Separate internal persistence from business mutations and external actions.
4. **Write behavior fixtures first.** Define positive, negative, ambiguous, missing, stale, conflicting and unauthorized cases relevant to this skill. Specify the expected payload/status and evidence; set numerical evaluation thresholds only when the design has a justified baseline.
5. **Implement real logic.** Write deterministic functions and canonical adapters; write bounded instructions for model tasks; define composites as explicit steps and branches. Inject clocks, random seeds, provider clients and storage interfaces. Never replace a required detector with an always-success response.
6. **Verify locally.** Run unit/property tests where mathematical or state invariants matter, contract tests, source-lineage checks and integration tests using local providers. For model-dependent behavior, use recorded responses for control tests plus separate live-model evaluations when configured.
7. **Verify through the runtime contract.** Execute identical fixtures via the local adapter and then the remote host. Compare deterministic payloads and control behavior; use quality thresholds for probabilistic outputs. Inject process loss around checkpoints and effects.
8. **Publish a versioned package.** Generate discovery metadata, an execution lockfile, dependency bill of materials and evaluation report. Register capability coverage and maturity truthfully. Review contract or policy changes for migration impact.

A design card is ready to build only when examples, context dependencies, entrypoint behavior, acceptance criteria and effect boundaries are reviewable. Maintain `catalogued -> designed -> implemented_synthetic -> integration_verified -> production_qualified` as separate maturity states. A provider-dependent skill can reach synthetic readiness without qualifying its production provider.

Use a common async entrypoint shaped as `execute(parameters, context, services) -> SkillComputation`, with typed parameters and context views. `services` exposes only admitted capabilities, repositories and clock/trace helpers. `SkillComputation` carries the specialized payload, proposed records, evidence links, unresolved items and any requested effect commands. The executor validates and commits permitted records, executes separately authorized commands, and produces the source's `SkillResult.v1` reference envelope. This avoids pretending an unpersisted model-generated object already has an authoritative case-store reference.

## 6. Dynamic agent profiles and execution

An `AgentProfile` contains its ID/version, role instructions, supported workflow roles, allowed skill IDs/version constraints, model capabilities and provider policy, permitted context profiles, planning/tool/cost limits, delegated permissions and required approval roles. It references skill instructions rather than duplicating them.

At invocation:

1. Authenticate the workflow caller and resolve actor delegation, tenant, purpose and requested action.
2. Resolve the requested profile and skill versions against an immutable catalog release. Validate runtime, schema, model and dependency compatibility.
3. Compute the effective grant as the intersection of actor/delegated permissions, tenant policy, profile limits, workflow limits and skill requirements. A profile can restrict permissions; it cannot grant new ones.
4. Pin profile, workflow, skill/transitive dependency versions, instruction hashes, code/image digest, model configuration, policy snapshot, provider coverage and context schema in an execution lockfile.
5. Offer a compact permitted-skill index to an agent. Load selected instructions and tool schemas progressively. Re-run admission on every invocation, including dynamically selected subskills and enrichment requests.
6. Compile the selected skill's context; execute under budgets; validate its typed result and evidence; commit through controlled persistence.
7. Persist progress and return result references. Human tasks suspend durable execution and resume with a validated approval record, never a bare model assertion that approval occurred.

Keep execution lifecycle (`QUEUED`, `RUNNING`, `WAITING_FOR_HUMAN`, `CANCELLED`, terminal) separate from the source's business result statuses (`COMPLETED`, `PARTIAL`, `NEEDS_EVIDENCE`, `NEEDS_REVIEW`, `BLOCKED`, `FAILED`). Preserve both. `COMPLETED` is not a customer approval.

Approval records bind the exact action, subject, input/context/policy hashes, approving actor, authority, expiry and relevant case revision. Revalidate at execution time; changed inputs invalidate or require reevaluation of the approval. One approval does not authorize unrelated subsequent mutations.

For writes, use command validation, optimistic concurrency and idempotency. An outbox command records intent before the external call; ambiguous acknowledgments enter reconciliation rather than blind retries. Do not claim exactly-once delivery for arbitrary external systems.

## 7. Remote hosting strategy

Package the shared executor, selected skill libraries and a thin HTTP host in a container. A profile may select skills from that approved bundle; do not deploy a separate host for every canonical skill.

Use a structured invocation contract for workflow jobs, and add conversational transport only for analyst interaction if needed. Select the transport based on the current runtime contract rather than baking protocol details into every skill.

A host can be restarted mid-request and a request can be repeated; application checkpoints and effect tracking remain necessary. Keep canonical case state in application-owned stores and map runtime work/input IDs to durable workflow/execution IDs.

Implement `execute`, `status`, `cancel`, `resume` and event streaming as application adapter responsibilities with transport-specific bindings, not assumed native methods. Start with local test equivalents. Test tenant and user identity propagation, deployment identity access, process loss, cancellation, approval resume, request duplication and cross-profile isolation.

## 8. Consolidated context workstream

Treat [context-specification.md](context-specification.md) as a first-class contract shared by every skill, not a prompt template. Build it alongside skills in this order:

1. Normalize the 81 catalog type names and define stable references, evidence types, time semantics, tenant boundaries and missing-data states.
2. Define schema families, per-skill field requirements and a bidirectional matrix: skill -> required fields -> source contracts; field/object -> consuming skills -> responsible source owner.
3. Implement local canonical stores and governed source adapters with synthetic data.
4. Implement context planning, authorization, as-of selection, source/freshness checks, graph and transaction slices, redaction and model token allocation.
5. Add immutable manifests, hashes, policy snapshots and replay bundles; invalidate snapshots when inputs or permissions change.
6. Add production storage/search adapters only after the contracts and fixtures work. Select relational/document/graph/vector products through measured access patterns, not because the ontology contains graph objects.

Structured data passed to deterministic calculations is distinct from model excerpts. Transaction aggregations must operate over the authorized dataset with explicit watermarks and coverage, not a token-truncated sample. Vector search is an evidence discovery aid and cannot establish exhaustive negative coverage.

## 9. Delivery sequence and coverage

These are dependency-driven milestones, not calendar estimates. Every canonical skill has a proposed home wave in the backlog. Pull prerequisites forward when the validated dependency graph requires them; the coverage report counts each ID once.

| Wave | Scope | Exit evidence |
| --- | --- | --- |
| W0: contracts and execution skeleton | Catalog extraction; schema/manifest/profile contracts; context bootstrap; local stores; executor interfaces; trace/error vocabulary; package tooling | All 222 IDs inventoried; schema examples validate; dynamic profile resolves a trusted test package; tenant denial and context gaps fail correctly. No business skill claimed complete. |
| W1: shared controls | `case`, `decision`, `evidence`, `quality` domains | Executable case lifecycle, policies, provenance, contextualization, rules and approval/resume under synthetic fixtures. Semantic QA is explicitly qualified. |
| W2: complete KYB slice and core domains | `entity`, `party`, `ownership`, `document`, `registry`, `screening`, `risk`, `edd`; pull `monitor.customer.schedule` forward | Original 24-skill seed plus the five omitted workflow skills and all declared prerequisites run end to end; local and remote-host integration parity; synthetic approval and monitoring handoff. |
| W3: transactions and AML investigation | `transaction`, `network`, `aml`, `alert`, `investigation` | Authorized transaction-window coverage, deterministic typology fixtures, reproducible graphs, evidence-backed investigation and human disposition. |
| W4: fraud | All 12 `fraud` skills | Real adapter contracts and synthetic provider implementations; no simulated biometric/deepfake score represented as a validated detector. |
| W5: ongoing monitoring and reporting | Remaining `monitor` and all `regulatory` skills | Durable triggers/timers, review workflows, report validation, approval, local submission receipts and uncertain-submission reconciliation. |
| W6: complete-library qualification | All 222, cross-domain workflows and adapters | No missing IDs; every skill has contract, instructions, implementation and evaluation report. Production qualification tracked separately per policy/source/model/runtime combination. |

W1 is reusable infrastructure plus canonical skill facades, not a large upfront attempt to solve every semantic QA problem. Initially implement the contract and concrete checks that are testable for the first slice, then extend domain-specific checks with their consumers. Never mark a whole domain complete if those checks are still absent.

The first implementation sequence should be: catalog and contract tooling -> synthetic case/evidence/policy stores -> context compiler -> deterministic policy/executor path -> `entity.identifiers.validate` and `ownership.interest.calculate` -> entity and document evidence pipeline -> complete KYB dependency closure -> remote host parity. This tests deterministic calculations, provider dependencies, composites and approval suspension before scaling the rest of the catalog.

## 10. Proposed repository layout and dependencies

```text
docs/                         # design, ADRs, context spec, generated coverage views
schemas/                      # JSON Schemas and compatibility fixtures
catalog/                      # 222 manifests and catalog releases
skills/<domain>/<skill>/       # instructions, context declaration, schemas, tests
src/financial_crime/
  contracts/                  # typed shared contracts
  context/                    # planner, compiler, scopes, replay
  execution/                  # registry, admission, invocation, effects
  primitives/                 # shared money/time/graph/rules/provenance functions
  providers/                  # canonical interfaces, local and production adapters
  storage/                    # repository interfaces and implementations
  runtimes/local/
  runtimes/skill_host.py      # skill.execution.v1 host (the remote host that shipped)
profiles/                     # versioned role profiles
workflows/                    # explicit workflow definitions
policies/synthetic/           # clearly non-regulatory test policy packs
tests/fixtures/               # shared synthetic cases, recordings and golden outputs
```

Keep executable implementations in the importable package; skill folders may point to those entrypoints rather than duplicating code. The package illustration in section 4 shows the logical package contents; packaging tooling must resolve those references and ship the needed instructions and schemas as resources.

Proposed dependency categories: Pydantic/JSON Schema validation; an async HTTP client; Decimal and explicit currency/time utilities; graph algorithms; document parsing/OCR interfaces; persistence/checkpoint adapters; OpenTelemetry; pytest/property testing. Hosts use the standard library only; any cloud SDK would belong in an optional extra. Add provider/model libraries as optional extras or separate compatible bundles. Pin direct/transitive versions and image digests after compatibility tests; do not guess current SDK versions in the plan.

LangGraph remains an optional orchestration adapter, matching the source's workflow examples. The business library and context compiler must run without importing it. A runtime that already owns durable orchestration can call the same executor directly.

## 11. Acceptance and rollout

A skill is integration-ready when its executable behavior, schemas, instructions, context requirements, dependency graph, evidence, failure handling, authorization and tests are complete. Static manifest validation is necessary and insufficient.

Library release gates:

- Coverage: all 222 source IDs map to one versioned implementation; no unresolved entrypoints, hidden TODO implementations, always-success adapters or silently omitted capabilities.
- Determinism: identical captured inputs/policies produce identical deterministic payloads; execution timestamps and trace IDs are compared separately. Ownership math covers multiple paths, cycles, unknown interests and rounding.
- Evidence: material findings trace to retained source versions and method details; contradictory, exculpatory and negative-search evidence survive compilation.
- Isolation: cross-tenant/context/provider denial tests pass; retrieved text cannot become executable instructions or grant capabilities.
- Recovery: checkpoints, duplicate requests/callbacks, expired approvals and ambiguous external acknowledgments do not repeat consequential actions.
- Evaluation: thresholds are specified per skill with datasets, limitations and measured results. Model/provider changes require relevant reevaluation.
- Runtime: local/remote-host contract parity, identity mapping, cancellation and human resume pass. Network transport is tested in addition to direct Python invocation.

Production qualification additionally requires approved institution/jurisdiction packs, permitted real data sources, source coverage/freshness guarantees, model/detector evaluation, authorized approval roles, operating SLOs and security/deployment boundaries. These are future integration inputs, not assumptions embedded in synthetic fixtures.

## 12. Decisions and immediate next work

Settled: jurisdiction-neutral contracts; synthetic policy packs; local test providers; all 222 skills in scope; plan before implementation.

Proposed defaults: Python reference library; JSON Schema interoperability; immutable registry releases; approved bundles selected by dynamic profiles; local first and a remote HTTP host second; authoritative application-owned case/evidence state; optional orchestration framework.

Before the first remote integration, resolve: model/harness choice, host protocol version, deployment identity/region/network boundary and checkpoint backend. Before production, resolve policy authority, actual jurisdictions, licensed sources, existing systems, approval roles, retention/residency and quantitative targets. These do not block synthetic core development.

Next concrete increment: build the catalog importer/validator, manifest/profile/context schemas and synthetic context compiler with a small executor demonstration. Use one deterministic calculation, one provider-backed retrieval, one model-assisted extraction and one approval-gated composite to prove the package contract before expanding the library.
