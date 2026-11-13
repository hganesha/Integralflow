# Skill catalog audit and production evolution plan

Date: 2026-11-08. Status: proposed roadmap, based on the working tree at `4022a14`.

The catalog is a credible synthetic execution foundation, but it is not yet a production business knowledge catalog. It has typed contracts, executable handlers, context controls, evidence lineage and approval boundaries. Its next investment should be deeper business semantics, authored instructions, explicit variation contracts and artifact-specific qualification. Expanding the number of skills or generating longer versions of the same prose would not address those gaps.

Start with individual CDD for a US deposit relationship, then ordinary corporate KYB, using the existing workflows as the initial dependency set. This sequencing is a planning assumption drawn from the two reference domains, not a confirmed commercial priority. Preserve the broader 20-domain catalog as synthetic until each supported business slice is qualified. Higher-risk products and additional jurisdictions need separate coverage decisions.

Companions: [all 229 skill records](skill-catalog-audit/skills.csv) and [authoring standard with a worked example](skill-catalog-audit/authoring-standard.md).

## Audit scope and evidence

The metadata census covers every current skill manifest and instruction package, the source and vendored catalogs, and both domain-package manifest slices. Code review follows the common generator, registry, execution and qualification seams, with targeted business-handler review in identity, ownership, screening, document processing, risk/EDD, AML, investigation, governance and reporting. This is not an independent line-by-line qualification of all 211 entrypoints.

Existing unrelated authoring/UI changes were present in the working tree. This audit adds documentation and an inventory; it does not change executable behavior, maturity or release approval.

| Observation | Current evidence | Meaning |
| --- | --- | --- |
| Library release | `0.4.0`; individual skill contracts remain `0.2.0`; context schema `2.0.0` | These are separate version axes and must be displayed separately. |
| Catalog size | 229 IDs: 222 canonical plus seven document extensions, across 20 domains | The source and vendored catalog agree. Several prose docs retain older counts/versions. |
| Qualification | All 229 are `implemented_synthetic` | No catalog entry establishes production fitness. |
| Instructions | 229 `SKILL.md` files, 307–378 whitespace-delimited words, median 319 | A common execution template dominates; word count is a diagnostic, not a quality gate. |
| Business labels | Three descriptions and business outcomes equal their IDs: sanctions, PEP and watchlist execution | High-impact discovery entries do not state their business result. |
| Limitations | 216 entries have empty structured `limitations` | Generic prose disclaimers do not provide machine-readable boundaries. |
| Modes | 218 code, three model, eight provider | A code handler can consume externally acquired records; this is not evidence of live acquisition. |
| Effects | 213 read-only, eight internal-write, seven human-gated, one proposal | Qualification must address both reasoning quality and effect authority. |
| Composition | Only the seven document extensions declare skill dependencies; 222 entries are classified atomic | Some advertised compositions are local helper calls or workflow responsibilities. Classify deliberately rather than adding dependencies everywhere. |
| Handler reuse | 211 distinct entrypoint strings for 229 IDs | Reuse is appropriate where outcomes remain distinct and separately evaluated. |
| Context freshness | All 228 required/optional collection declarations have `max_age_seconds: null` | Freshness can still be enforced by pinned tenant policy; the package does not declare differentiated per-collection limits. |
| Qualification metadata | All entries use synthetic evaluation names, one generic owner and `internal` classification | Ownership, field sensitivity, operating scope and evaluation evidence need business-specific treatment. |
| Workflow coverage | KYB references 33 distinct skills; KYC 28; union 41, intersection 20 | These are the starting business slice, not proof that every dependency or canonical record producer exists. |

The [CSV](skill-catalog-audit/skills.csv) has one row per skill with description, domain, handler, mode, effects, context, policy fields, dependency and workflow membership, instruction size, proposed wave and review concerns. Its flags are review signals. For example, no provider dependency is normal for a pure calculation or a consumer of canonical records.

Inventory fields through `kyb_workflow` describe current artifacts; delivery queue, variance dimensions, qualification focus, review signals and review action are proposed audit annotations. Domain-level qualification concerns are repeated across a domain's rows to support triage, not presented as 229 individually proven defects. The final column identifies the raw source catalog file by SHA-256 (`b67cbb395ce9974f6f49368cc84164efcae8ef1d9be8320b1d01956d9cc22944`); it is a file checksum, not the library's canonical manifest digest. Regenerate this census after catalog changes rather than treating it as runtime authority.

Primary evidence:

| Evidence | Source |
| --- | --- |
| Current manifests and release lock | [catalog](../../apps/fincrime-host/catalog/catalog.json), [lock](../../apps/fincrime-host/catalog/release-lock.json), [vendored catalog](../../config/skill-library/catalog.json) |
| Instruction generation | [build_catalog.py](../../apps/fincrime-host/scripts/build_catalog.py) |
| Shared defaults and policy-field inference | [registry.py](../../apps/fincrime-host/src/financial_crime/registry.py) |
| Business design targets | [per-skill design backlog](../../apps/fincrime-host/docs/skill-design-backlog.md), [extension semantics](../../apps/fincrime-host/docs/skill-extensions.md) |
| Source workflows and boundaries | [KYC](../../domains/archive/kyc-v2-deterministic/README.md), [KYB](../../domains/archive/kyb-deterministic/README.md), [candidate banking policy](../../domains/fincrime/banking-policy.json) |
| Runtime and qualification | [skills gateway adapter](../../apps/capability-gateway/src/adapters/skills.ts), [registry persistence](../../packages/persistence/src/business-skills.ts), [skill host](../../apps/fincrime-host/src/financial_crime/runtimes/skill_host.py) |

## Findings and their business consequences

### F1 High priority — instructions are generated transport guidance

`build_catalog.py:65` onward emits the same five execution steps for every skill, inserts one design-backlog sentence, and copies handler metadata/context. The generated files are outputs; hand-editing them would be overwritten. They rarely explain when a skill is appropriate, how to choose between neighboring skills, how to resolve contradictory evidence, or what to do for specific business variants. The three shared list-screening registrations also inherit an ID as description because `list_screen` has no docstring.

Introduce authored per-skill procedures and conditional references as source inputs to the generator. Validate their identifiers, links and metadata against the manifest. Keep deterministic calculations and authority in code/policy. In the Python agent path, instructions currently help skill parameter preparation; deterministic domain workflows execute handlers directly. Improving prose alone cannot fix either handler behavior or those workflows.

### F2 High priority — intended outcomes sometimes exceed actual implementation

The sanctions procedure says it composes normalization, retrieval, matching and ownership/control tests. [list_screen](../../apps/fincrime-host/src/financial_crime/skills/screening.py) actually evaluates admitted `Entity`, `WatchlistEntry` and `ScreeningExecution` records. It has no acquisition capability and does not invoke the ownership or control skills. Those responsibilities must be explicit in a parent workflow/composite and its acceptance evidence.

Other representative depth gaps: address normalization is Unicode/whitespace normalization; identity verification consumes supplied verification records; EDD funds/wealth handlers inspect captured verification flags and evidence presence; SAR drafting delegates to a finding narrative builder. These are useful bounded operations, but their names must not imply qualified postal validation, independent identity investigation, economic corroboration or a regulator-ready narrative.

For every skill, create an intent-to-code trace: business claim → supported behavior → input producer → implementation → output/evidence → independent acceptance case. Decide whether to narrow its description, deepen the implementation, or expose a separately versioned composite. Do not assume that every broad verb requires a model.

### F3 High priority — absent policy can look like a favorable empty result

At [risk_edd.py:109](../../apps/fincrime-host/src/financial_crime/skills/risk_edd.py), `edd.trigger.evaluate` defaults absent `edd_triggers` to an empty list and returns `required: false`. At [identity.py:161](../../apps/fincrime-host/src/financial_crime/skills/identity.py), `party.profile.completeness` defaults absent `profile_fields` to an empty list and reports `complete: true`. Both outputs were reproduced directly against the handlers with empty policy; this does not demonstrate a bypass of the entire admission/gate path.

For production, distinguish a missing configuration from an explicitly approved empty/not-applicable configuration. Missing applicability or policy must yield a policy gap, never a favorable business determination. Make this an all-skill audit pattern, including requirements, rules, exception handling and monitoring. Add regression cases at the public executor and workflow boundaries, not only direct function tests.

### F4 High priority — qualification is not scoped to the full artifact and business variant

The gateway checks registry maturity only when `RELEASE_ENVIRONMENT` is exactly `production`, and its floor is `integration_verified` (`skills.ts:353`). That is a useful synthetic barrier, but integration verification alone is weaker than the requested production qualification. `SECURITY_PROFILE` and release environment are independent settings; test and document the combined posture rather than assuming one implies the other.

The registry seed can replace a manifest at the same `(skill_id, semver)` while keeping the higher stored maturity; `upsertBusinessSkill` can also explicitly set maturity. Thus the data model can carry prior maturity onto changed content. Existing digest pinning and artifact approval remain separate controls; this observation is not a claim that all approval checks can be bypassed.

Make released versions immutable. Qualification should name the manifest, instruction/reference content, code and dependency closure, schema versions, policy pack, provider/model version, workflow and supported variant. Require an approved, current qualification record for production. Content changes invalidate or explicitly re-evaluate affected qualification; permit revocation and expiry. Keep lifecycle, implementation maturity, integration verification and business qualification separate in both API and UI.

### F5 Medium priority — contracts are structurally strong but operational semantics are generic

Every manifest currently declares the same six failure codes, although handlers can raise `POLICY_UNRESOLVED`, `EVIDENCE_INSUFFICIENT`, `REVISION_CONFLICT` and `CONTEXT_BUDGET_EXCEEDED`. All use the same 30-second timeout, generic evidence statement, owner and classification. `policy_fields` is inferred through source regex plus a manual indirect-call map; refactoring a helper can change the advertised policy dependency surface.

Replace inference as authority with explicit typed policy requirements, including applicability, required versus optional settings, unknown behavior and effective dates. Keep inference/lint as a warning tool. Declare real failure/status behavior, source-specific freshness, currency/unit handling, evidence sufficiency, retry safety, PII handling and execution budgets. Defaults may be shared, but business exceptions must be intentional and testable.

### F6 High priority — tests demonstrate synthetic controls, not measured business effectiveness

The all-skill smoke test executes authored synthetic examples and checks status, schema, hashes and admission. Additional suites test meaningful math, evidence and recovery invariants. This is valuable and should remain. It does not measure identity false merges, sanctions miss rates, document extraction accuracy, adverse-media relevance or analyst usefulness on representative institution data.

Use independent evaluation datasets and reviewers, supported-variant strata and explicit uncertainty. Keep developer fixtures separate from held-out qualification data. Pin evaluation inputs and rubric versions; quantify sample size and confidence where applicable. Contract/control pass rates and business performance must be reported separately.

### F7 Medium priority — discovery hides supported scope and ownership

The current catalog has useful source provenance and maturity, but production consumers also need supported customer/product/jurisdiction/source scope, known exclusions, quality evidence, accountable owners, prerequisites and suggested workflow uses. Older documentation saying 222 skills or release 0.2/0.3 obscures the current 229-entry 0.4.0 release. Historical design notes should retain clear historical status; current inventory summaries should be generated.

Expose filters for qualified scope and hide unsupported combinations from executable selection. A catalog card should distinguish a canonical skill, its implementation, a wrapper, and a business workflow. A larger word count or a completed UI review must never raise readiness.

## Align the catalog to business journeys

Use business outcomes to select the next work. The 41 skills already referenced by KYC/KYB form an initial review queue; confirm their complete producer and implementation dependency closure before committing to a production slice.

| Journey | Business outcome | Dependencies to qualify | Acceptance measures |
| --- | --- | --- | --- |
| Individual CDD onboarding | Evidence-backed recommendation and controlled human decision for an eligible deposit relationship | Identity, party roles, required documents, sanctions/PEP/media, risk, evidence, policy and case gates | Evidence completeness, scoped screening coverage, analyst handling time, rework and decision traceability |
| Corporate KYB onboarding | Explainable legal-entity, ownership/control and related-party assessment | Registry acquisition, legal form, ownership graph, UBO/control, related-party screening, EDD and approvals | Unresolved ownership, omitted-party rate, evidence gaps, escalation correctness and review time |
| Periodic/event-driven review | Material changes trigger the right durable work and reassessment | Current/baseline snapshots, event deduplication, schedules, live worker handoff and reopened controls | Due-work timeliness, completed reassessments and handoff reconciliation; queued work is not completed monitoring |
| Screening/alert investigation | Traceable candidate resolution and evidence-backed investigation | Licensed sources, complete search scope, disambiguation, corroboration, investigation and human disposition | Adjudicated detection performance, relevance, citation support and analyst overturns |
| AML and fraud surveillance | Qualified indicators for a defined channel, typology and observation window | Complete transaction/event feeds, bounded graph/time computations, calibrated detectors and human triage | Recall/precision on labeled populations, coverage gaps, drift, queue load and loss/control impact where measurable |
| Regulatory reporting | Reviewable package, authorized submission and reconciled receipt | Approved obligation packs, narrative evidence, validation, deadlines, dual control and live delivery | Required-field completeness, citation support, deadline performance and confirmed acknowledgments |

Initial production support should end at an authorized recommendation/human decision boundary. External filing, payment actions and higher-risk product enablement require their own qualification and operational acceptance.

### Domain review queue

Counts below are current inventory; deliverables are proposed qualification work. Wave labels identify priority, not readiness. Dependencies may move forward.

| Domain | Count | Required business depth | Proposed expansion wave |
| --- | ---: | --- | --- |
| entity | 12 | Issuer-specific identity, false-merge avoidance, multilingual names, history and calibrated confidence | A: CDD/KYB |
| party | 10 | Relationship-specific roles, expected versus observed activity, conditional completeness | A |
| ownership | 12 | Temporal graphs, ranges/cycles, equity versus control, legal-form-specific UBO rules | A, especially KYB |
| document | 19 | 293-type contract support boundaries, full-page extraction, nested claims, verification handoff | A |
| registry | 10 | Authoritative source mappings, jurisdiction coverage, stale/conflicting status | A |
| screening | 14 | Subject/list/query scope, transliteration, disambiguation, negative evidence, ownership/control handoffs | A |
| risk | 12 | Approved factor models, missingness, calibration, tier explanation and override governance | A |
| edd | 10 | Trigger applicability, source-of-funds/wealth corroboration, business purpose and scoped investigation | A/B |
| transaction | 12 | Feed completeness, events/reversals, currency, windows and expected-activity comparisons | C: surveillance |
| network | 10 | Typed temporal links, graph completeness, bounded paths and evidentiary interpretation | C |
| aml | 12 | Typology-specific definitions, independent datasets, channel calibration and indicator limits | C |
| alert | 10 | Deduplication without lost evidence, priority, routing, context and feedback | B: investigation |
| investigation | 12 | Competing hypotheses, source support, contradictions, fund-flow uncertainty and narrative review | B |
| fraud | 12 | Permitted device/identity data, specialist detector qualification, channel drift and triage | C |
| case | 10 | Role/queue routing, SLA calendars, revision conflicts, reopen/close semantics and audit | A prerequisites; B expansion |
| decision | 12 | Applicable policy, exceptions, unresolved controls, independent human authority and explanation | A |
| monitor | 10 | Event applicability, durable timers, work delivery, changed facts and monitoring acknowledgment | A handoff; B full execution |
| regulatory | 10 | Institution/jurisdiction obligations, versioned forms, reviewed narrative and receipt reconciliation | D: reporting |
| evidence | 10 | Provenance, source sufficiency, conflicts, retention/legal hold and claim promotion boundaries | A prerequisites; D retention |
| quality | 10 | Deterministic checks versus semantic review, independent rubrics, evaluated error bounds | A prerequisites; all waves |

## Model business variances explicitly

Avoid one copied skill per bank, product or jurisdiction. Reuse the canonical skill contract with approved variation packs when the inputs, outcome meaning and effect authority remain compatible. Create a new skill/composite or major version when those semantics change. Keep provider adapters separate from business policy.

| Dimension | Required distinctions | Where it belongs | Evaluation coverage |
| --- | --- | --- | --- |
| Institution and policy | Institution type, risk appetite, adopted relief, sources, approval authority | Approved institution/policy pack | Conflicting/missing configuration, adoption and effective-date changes |
| Jurisdiction | Booking, formation, residence, policy applicability and source/list coverage | Explicit applicability resolver and versioned jurisdiction packs | Cross-border conflicts, unsupported location and historical as-of dates |
| Customer/legal form | Individual, sole proprietor, corporation, charity, trust, fund; joint and related parties | Typed relationship context plus conditional requirements | Unknown form, multiple roles, exemptions requiring evidence, opaque ownership |
| Product/channel | The 11 families already modeled: deposit, card, payments, lending, trade finance, acquiring, private banking, correspondent, FBO, digital assets, custody | Product packs and workflow controls | Product-specific evidence and controls; approval for one product cannot qualify another |
| Lifecycle and risk | Onboarding, periodic/event review, EDD, material change, closure and reopen | Workflow/profile plus risk policy | Stale evidence, changed relationships, high-risk escalation and reassessment |
| Evidence/source | Registry availability, language/script, document formats, source quality, provider licenses | Source profile, capability binding and data contracts | Truncation, conflicting records, no coverage, outages and transliteration |
| Deployment/authority | Human-assisted versus automated steps, residency, retention and write authority | Environment release/entitlement policy and execution envelope | Tenant/role denial, approval expiry, revocation and external-outcome uncertainty |

Resolve institution → applicable jurisdiction set → customer/legal form and roles → product/channel → lifecycle/risk → source/deployment constraints through explicit compatibility rules. This is an applicability pipeline, not a generic last-write-wins configuration merge. Material policy conflicts must stop for review. The resolved pack and conflict decisions must be pinned and visible in evidence.

Use risk-based pairwise coverage for ordinary interactions and exhaustive targeted cases for high-consequence combinations. Every supported combination must have an evaluation scope; combinations outside that scope remain unsupported. Add locale/calendar/currency and historical-policy tests where the outcome depends on them.

## Target package and release model

1. **Authored business source:** per-skill purpose, triggers, procedure, evidence rules, exceptions, limitations and examples, with explicit technical metadata. The [standard](skill-catalog-audit/authoring-standard.md) defines the minimum content and a sanctions specimen.
2. **Generated distributable:** current `skills/<domain>/<leaf>/` layout and installed resources, schemas, context declarations and catalog entries. Continue reproducible builds and canonical IDs; add trusted, content-addressed references.
3. **Implementation and context:** reuse shared modules, but declare actual policy/context/producer requirements and real composites. Preserve raw evidence versus assertions, verified facts, findings, recommendations and authorized decisions.
4. **Variant qualification:** an evidence record for the exact package, policy, provider/model, workflow and supported scope, with accountable owner, independent reviewer, results, exceptions, expiry and revocation.
5. **Execution:** compile/pin the supported implementation and resolved variation; enforce qualification, entitlement and current release status at admission and invocation. Reject unknown scope and failed required evidence.
6. **Catalog presentation:** show business use, prerequisites, supported/unsupported scope, owners, evidence summaries and version/qualification history. Catalog access and search remain permission-filtered.

Retain existing canonical hashing, approved/unrevoked artifact-registry trust, envelope permissions, effect controls, dual control and gateway receipts. New qualification evidence should use that trust anchor. Do not add a parallel signing authority merely to label skills as production-ready.

### Maturity and qualification gates

| Gate | Required evidence | Who accepts |
| --- | --- | --- |
| Designed | Approved business contract, procedure, variation boundary, context/producer map and acceptance cases | Domain owner and engineering owner |
| Implemented synthetic | Current contracts, negative/edge cases, evidence and control/recovery checks; reproducible package | Engineering and QA |
| Integration verified | Real approved adapter behavior, identity/tenant/entitlement checks, complete data mapping, failure and recovery evidence | Integration owner, security and operations |
| Production qualified | Independent representative evaluation, approved policy/source scope, operating limits, runbooks, human process and shadow/canary evidence | Business/policy owner, independent QA, security/privacy and operations |
| Production active | Approved artifact and environment release, current scope-specific qualification, monitoring and rollback route | Authorized release approvers under existing separation of duties |

Qualification is not a weighted score that can offset a failed authority or evidence control. Proposed absolute engineering gates: all required control cases pass, no open critical defects, no unsupported scope selected, complete pinned provenance, and successful rollback/recovery rehearsal. Business accuracy, error rates, sample size and p95 latency/cost limits must be set by accountable owners using measured baselines and representative demand; this audit does not invent institution-specific thresholds.

## Delivery plan

Estimates are planning ranges, not committed dates. They assume available domain SMEs, one owning engineering team, independent QA, and timely licensed-source/policy decisions. Production-data and vendor onboarding may dominate the schedule.

| Phase | Scope and indicative duration | Concrete outputs | Exit criteria |
| --- | --- | --- | --- |
| 0 — Correct semantics and establish scope | 1–2 weeks | Confirm first customer/product/jurisdiction slice; assign owners; triage F1–F7; correct missing-policy cases, advertised compositions and current inventory summaries | Signed-off supported-scope matrix; public-path regression cases for policy gaps; every affected description agrees with implemented behavior |
| 1 — Authoring and qualification foundations | 2–3 weeks | Authored-source loader; document/metadata lint; explicit policy requirements; immutable releases; artifact/variant qualification contracts; UI/API readiness semantics | Deterministic regeneration; reference hashes enforced; changed artifacts cannot inherit qualification; maturity cannot substitute for required qualification |
| 2 — Twelve representative skill packages | 3–5 weeks | SME-authored procedures, implementation gaps, variance packs, independent evaluation cases and end-to-end evidence for the pilot set below | Each passes design/synthetic gates; supported live bindings pass integration gates; no collective production-readiness claim |
| 3 — First complete CDD slice, then KYB | 4–6+ weeks after foundations | All prerequisite skill/record producers; approved policy pack; real sources; analyst/human workflow; shadow runs; durable monitoring handoff | Complete business journeys meet approved quality/operating thresholds and artifact-specific qualification, then controlled canary promotion |
| 4 — Catalog expansion and continuous qualification | Incremental, by business demand | Remaining investigation, surveillance, fraud/reporting skills; new product/jurisdiction packs; drift and requalification process | Each released slice independently qualifies; all unqualified entries retain explicit synthetic/unsupported status |

The twelve Phase-2 exemplars cover different implementation and business risks: `entity.identity.verify`, `ownership.ubo.resolve`, `screening.sanctions.execute`, `screening.sanctions.ownership.evaluate`, `screening.pep.execute`, `screening.adverse_media.execute`, `document.fields.contract_extract`, `document.requirements.resolve`, `risk.customer.assess`, `edd.trigger.evaluate`, `decision.recommendation.generate`, `monitor.customer.schedule`. These exemplars are not a complete runnable closure. `party.profile.completeness` receives a Phase-0 semantic fix and joins its journey's dependency work.

### Engineering backlog and ownership

| Work item | Primary code/content area | Accountable role | Proof required |
| --- | --- | --- | --- |
| Explicit no-policy semantics | `skills/identity.py`, `risk_edd.py`, then all policy-driven handlers | Domain engineering + policy owner | Missing, empty-approved and not-applicable cases remain distinct through the executor and workflow |
| Authored procedures and trusted references | `scripts/build_catalog.py`, new authored-source tree; `registry.py`, `agents.py`, `runtimes/skill_host.py` | Skill-platform engineering | Regeneration preserves content; missing references/incorrect hashes fail; lazy reference loading obeys budget and scope |
| Explicit business contracts | `registry.py`, `schema_types.py`, `payload_types.py`, `packages/contracts` and sync scripts | Contract owners | Versioned migration; declared policy/errors/limitations validated against behavior |
| Immutable artifacts and qualification | `packages/persistence`, registry routes, `skill-bundle-routes.ts`, `adapters/skills.ts`, release admission | Platform/release owners + independent QA | Same-version mutation refused; qualification expires/revokes; dependency changes require reviewed requalification; posture combinations covered |
| Canonical data producers | Acquisition adapters, context plane, `scripts/lib/library-package.mjs`, KYC/KYB generators | Integration/context owners | Every required field has an authorized producer; missing or partial source stays a gap; assertions do not become facts silently |
| Human and monitoring operations | Case commands, approval/release, work items and integration workers | Operations + platform engineering | Restart-safe work, independent approval, changed-basis rejection and reconciled handoff |
| Catalog readiness and discovery | `catalog-snapshot.mjs`, `fincrime-views`, BFF and catalog UI contracts | Product/catalog owners | Readiness reflects supported variants and evidence; permission-filtered counts/search; version history visible |
| Independent business evaluation | Evaluation corpora, CI reports and artifact registry evidence | Domain QA independent from implementer | Held-out cases, rubric/version pins, representative strata, adjudicated outcomes and release thresholds |

All baseline catalog entries need an assigned product/domain owner and a technical maintainer. Generic ownership does not identify who can approve a semantic or policy change. High-impact findings/requirements need an independent reviewer; implementation authors should not qualify their own release.

## Business measures and operating cadence

Baseline first, then set targets per supported slice. Track recommendation quality against adjudicated outcomes, missing-evidence and unresolved-policy rates, false merges/missed matches, extraction errors by document/field, unsupported-scope selection, analyst handling time/rework, escalation load, overdue reviews, p95 latency, cost per completed business outcome, and recovery/reconciliation time. Report denominators and source coverage; a falling gap rate is not an improvement if checks were omitted.

Release evidence should include control test results, independent quality results, live integration results, policy/owner approvals, supported-variant matrix, operating limits, incident/runbook owner, rollback and qualification expiry. Review operational drift monthly and upon material policy, source, model, schema, workflow or content changes; revoke promptly when evidence no longer supports the active scope.

Decisions needed during Phase 0: first commercial journey and eligible customer segment; institution/policy owner; approved jurisdiction and product scope; licensed sources and canonical producers; representative evaluation data; acceptable error/latency/cost limits; human authority and escalation staffing; monitoring delivery owner. The current US banking policy remains `CANDIDATE`; this plan grants it no new authority.

## Validation performed for this audit

- `build_catalog.py --check`: passed; 2,472 generated artifacts checked for 229 executable skills.
- `sync-business-skills.mjs --check`: passed; the vendored catalog and registry seed are current.
- Targeted Python suites (`test_catalog`, `test_banking_semantics`, `test_analytics`, `test_document_wrappers`): **1,181 passed**.
- Targeted TypeScript suites (library skills gateway, business-skill persistence and contracts): **21 passed** across three files.
- Direct handler probes reproduced the two missing-policy outputs in F3. These are narrow behavior probes, separate from the passing public-path suites.

No live provider quality study, enterprise deployment, full monorepo check, load test or production qualification was performed. Passing checks establish the current synthetic baseline and drift consistency; they do not resolve the findings above.
