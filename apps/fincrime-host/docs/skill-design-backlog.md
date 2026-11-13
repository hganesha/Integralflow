# Per-skill design backlog

Status: proposed design targets; not implementation status.  
Executable reference implementations now cover all 222 IDs. See [implementation status](implementation-status.md) and [skill packages](../skills/) for delivered behavior; these rows remain the qualification targets.
Date: 2026-11-07.  
Source: [canonical specification](../financial_crime_canonical_skills_spec_v1.md).  
Related: [build plan](skill-implementation-plan.md), [context specification](context-specification.md).

This backlog covers all 222 canonical IDs exactly once. Each row defines concrete behavior and a distinguishing acceptance concern. The reference release supplies executable contracts, instructions, code and synthetic tests; use these rows for deeper domain qualification. The baseline execution mode is copied for review, not accepted as the final implementation classification. Current readiness is recorded in the linked implementation status.

Each domain lists shared dependency candidates and its original context vocabulary. These are discovery inputs; exact per-skill field requirements and directed skill dependencies must be authored and validated during design. Do not interpret every domain context object or every shared candidate as mandatory for every row. Wave assignments are initial priorities; prerequisites can be pulled forward. `monitor.customer.schedule` is explicitly pulled into the KYB slice.

| Wave | Canonical IDs assigned |
| --- | ---: |
| W1 | 42 |
| W2 | 93 |
| W3 | 56 |
| W4 | 12 |
| W5 | 19 |
| Total | 222 |

## 01. `entity.*` — 12 skills

Catalog context vocabulary: Entity, IdentityIdentifier, Alias, Address, EntityCandidate, SourceRecord, Evidence, Policy.

Dependency candidates and shared fixtures: Normalization/identifier primitives, candidate retrieval, matching/calibration; collision, transliteration, false-merge and historical fixtures.

| Skill | Baseline mode | Wave | Proposed implementation behavior and acceptance focus |
| --- | --- | --- | --- |
| `entity.resolve` | hybrid | W2 | Normalize, retrieve candidates, compare identifiers and explain resolution; never merge solely on a name. |
| `entity.match` | hybrid | W2 | Compute pairwise feature scores and contradiction penalties; expose calibrated scores and identifier evidence. |
| `entity.deduplicate` | hybrid | W2 | Propose duplicate clusters with reversible merge commands; protect distinct entities sharing names. |
| `entity.disambiguate` | hybrid | W2 | Rank ambiguous candidates and request discriminating evidence; preserve unresolved alternatives. |
| `entity.classify` | hybrid | W2 | Classify entity kind from typed legal evidence; retain competing classifications and source basis. |
| `entity.identifiers.validate` | deterministic | W2 | Implement issuer-specific format/checksum checks; distinguish structural validity from verified existence. |
| `entity.alias.resolve` | hybrid | W2 | Normalize aliases/transliterations while retaining original script and temporal name lineage. |
| `entity.address.normalize` | deterministic | W2 | Parse and standardize address components; keep original text and distinguish normalization from verification. |
| `entity.identity.verify` | deterministic | W2 | Combine authoritative verification responses and policy criteria; do not treat a valid identifier as identity proof. |
| `entity.relationship.resolve` | hybrid | W2 | Resolve typed directional relationship candidates with effective dates and supporting source spans. |
| `entity.history.reconstruct` | hybrid | W2 | Reconstruct identity versions as of valid time and knowledge cutoff; preserve superseded claims. |
| `entity.confidence.assess` | hybrid | W2 | Calculate resolution confidence from evaluated features and calibration data; expose out-of-distribution limits. |

## 02. `party.*` — 10 skills

Catalog context vocabulary: Party, Entity, CustomerRelationship, Account, Product, ExpectedActivity, GeographyExposure, Policy.

Dependency candidates and shared fixtures: Canonical entity/relationship repositories and requirement evaluation; missing-field, ambiguous-role and profile-refresh fixtures.

| Skill | Baseline mode | Wave | Proposed implementation behavior and acceptance focus |
| --- | --- | --- | --- |
| `party.profile.build` | hybrid | W2 | Assemble a versioned party view from entity, relationship, product and activity records; record gaps. |
| `party.profile.refresh` | hybrid | W2 | Diff stale profile fields and request permitted updates; preserve versions and unresolved changes. |
| `party.type.classify` | hybrid | W2 | Map entity and relationship evidence to customer taxonomy with explicit unknown cases. |
| `party.role.resolve` | hybrid | W2 | Resolve director/signatory/customer roles and effective intervals without conflating entity and party. |
| `party.activity.profile` | hybrid | W2 | Build declared and observed activity profiles separately; cite declarations and observation windows. |
| `party.industry.classify` | hybrid | W2 | Map business evidence to versioned industry taxonomy and candidate codes; preserve classification ambiguity. |
| `party.geography.profile` | hybrid | W2 | Calculate geographic exposure by typed basis such as domicile, business and transaction activity. |
| `party.product.profile` | hybrid | W2 | Aggregate products/channels and relationship dates; distinguish available products from actual usage. |
| `party.expected_behavior.model` | hybrid | W2 | Construct expected behavior parameters and ranges with source basis; keep forecasts separate from observations. |
| `party.profile.completeness` | hybrid | W2 | Evaluate applicable mandatory fields against requirement sets; unknown fields cannot count as complete. |

## 03. `ownership.*` — 12 skills

Catalog context vocabulary: Entity, OwnershipInterest, ControlRight, Relationship, OwnershipGraph, BeneficialOwner, Evidence, Policy.

Dependency candidates and shared fixtures: Temporal graph, Decimal calculations, policy predicates and identity verification; multi-path, cyclic, nominee and opaque graphs.

| Skill | Baseline mode | Wave | Proposed implementation behavior and acceptance focus |
| --- | --- | --- | --- |
| `ownership.graph.build` | hybrid | W2 | Build canonical ownership/control edges with versioned source lineage and explicit graph boundary. |
| `ownership.graph.expand` | hybrid | W2 | Traverse authorized graph slices with depth/node limits; return unresolved frontier and coverage. |
| `ownership.interest.calculate` | deterministic | W2 | Calculate path interests using exact decimals and governed aggregation; detect cycles and avoid double-counting. |
| `ownership.control.resolve` | hybrid | W2 | Apply configured non-equity control tests to sourced rights; retain disputed/unknown control. |
| `ownership.ubo.resolve` | hybrid | W2 | Compose graph expansion, interest math, control tests and threshold policy into candidate UBO findings. |
| `ownership.ubo.verify` | deterministic | W2 | Verify UBO identity and supporting ownership evidence; retain candidate versus verified status. |
| `ownership.threshold.evaluate` | deterministic | W2 | Evaluate effective-dated jurisdictional thresholds and aggregation rules; no universal threshold constant. |
| `ownership.nominee.detect` | hybrid | W2 | Detect sourced nominee/proxy indicators; avoid presenting suspected arrangements as established facts. |
| `ownership.circular.detect` | hybrid | W2 | Find strongly connected ownership components and cycle paths; report implications for calculation completeness. |
| `ownership.structure.complexity` | hybrid | W2 | Compute transparent structural complexity measures with policy thresholds and missing-graph qualifications. |
| `ownership.discrepancy.detect` | hybrid | W2 | Compare declared and sourced ownership by entity/time/interest; distinguish corrections from contradictions. |
| `ownership.history.compare` | hybrid | W2 | Diff effective ownership snapshots; separate actual ownership changes from newly recorded historical evidence. |

## 04. `document.*` — 12 skills

Catalog context vocabulary: Document, DocumentVersion, DocumentPage, ExtractedAssertion, Evidence, Provenance, Policy.

Dependency candidates and shared fixtures: Document parser/OCR, structured extraction, source-span validation and optional translation/forensics adapters; partial extraction and conflicting documents.

| Skill | Baseline mode | Wave | Proposed implementation behavior and acceptance focus |
| --- | --- | --- | --- |
| `document.classify` | model-assisted | W2 | Classify supported document types using parsers/model output; preserve unknown type and source version. |
| `document.parse` | model-assisted | W2 | Parse documents through format/OCR interfaces with page geometry and partial-extraction metadata. |
| `document.fields.extract` | model-assisted | W2 | Extract schema-typed assertions with source spans; reject invented or unlocatable values. |
| `document.entities.extract` | model-assisted | W2 | Extract entity mentions with span evidence; delegate canonical identity resolution to entity capabilities. |
| `document.authenticity.assess` | model-assisted | W2 | Assess authenticity indicators through specialist interfaces; return limitations rather than authenticity guarantees. |
| `document.validity.check` | model-assisted | W2 | Check issuance, expiry and formal requirements deterministically after extracting supported fields. |
| `document.consistency.check` | model-assisted | W2 | Compare typed cross-document assertions and validity intervals; retain material conflicts. |
| `document.requirements.evaluate` | model-assisted | W2 | Evaluate documents against applicable requirements and freshness rules; missing evidence stays unknown. |
| `document.evidence.link` | model-assisted | W2 | Validate and attach exact document-version/page spans to assertions; reject broken citations. |
| `document.version.compare` | model-assisted | W2 | Diff document versions at text/field level with source coordinate mapping and material change classification. |
| `document.translation.normalize` | model-assisted | W2 | Translate/normalize with original-language lineage; preserve names, numeric fields and uncertain translations. |
| `document.request.generate` | model-assisted | W2 | Produce missing-document request content from requirement gaps; sending is a separate authorized effect. |

## 05. `registry.*` — 10 skills

Catalog context vocabulary: Entity, Registration, RegistryRecord, Filing, OfficerRole, License, Evidence, Policy.

Dependency candidates and shared fixtures: Registry lookup/source-capture contracts and identity normalization; status changes, pagination, stale and missing registrations.

| Skill | Baseline mode | Wave | Proposed implementation behavior and acceptance focus |
| --- | --- | --- | --- |
| `registry.company.lookup` | retrieval | W2 | Implement canonical registry search and response capture; report jurisdiction and pagination coverage. |
| `registry.company.verify` | deterministic | W2 | Verify existence/status against registry evidence and criteria; distinguish unavailable sources from no registration. |
| `registry.directors.resolve` | retrieval | W2 | Resolve sourced director/officer roles with effective dates; avoid treating names as canonical identities. |
| `registry.filings.retrieve` | retrieval | W2 | Retrieve permitted filing versions and hashes; preserve source authority, dates and download failures. |
| `registry.licenses.verify` | deterministic | W2 | Validate license scope, issuer, status and validity intervals through configured source interfaces. |
| `registry.taxid.validate` | deterministic | W2 | Apply identifier validation and permitted authority checks separately; format validity is not registration proof. |
| `registry.address.verify` | deterministic | W2 | Compare registered versus declared addresses with match evidence and temporal/source qualifications. |
| `registry.status.monitor` | retrieval | W2 | Compare registry snapshots using durable watermarks; publish change candidates without duplicate events. |
| `registry.jurisdiction.resolve` | retrieval | W2 | Resolve incorporation jurisdiction from legal records; retain conflicts and avoid guessing from mailing address. |
| `registry.discrepancy.detect` | retrieval | W2 | Compare declared and registry attributes by field/time; return conflicts with authority and source lineage. |

## 06. `screening.*` — 14 skills

Catalog context vocabulary: Entity, Alias, WatchlistEntry, ScreeningHit, SanctionsRegime, PEPRelationship, AdverseMediaEvent, Evidence, Policy.

Dependency candidates and shared fixtures: List/media providers, name matching, ownership/control primitives and governed dispositions; collisions, stale lists and incomplete coverage.

| Skill | Baseline mode | Wave | Proposed implementation behavior and acceptance focus |
| --- | --- | --- | --- |
| `screening.sanctions.execute` | hybrid | W2 | Compose normalization, list retrieval, matching and ownership/control tests; unresolved hits cannot auto-clear. |
| `screening.pep.execute` | hybrid | W2 | Screen persons/relationships against permitted PEP coverage; return sourced candidates and scope limitations. |
| `screening.adverse_media.execute` | hybrid | W2 | Search authorized media sources and preserve queries, coverage and allegations versus established events. |
| `screening.watchlist.execute` | hybrid | W2 | Screen configured authorized lists with exact versions and scope; no implicit universal watchlist coverage. |
| `screening.name.normalize` | deterministic | W2 | Normalize scripts and aliases with versioned deterministic transforms; retain original names and alternatives. |
| `screening.match.score` | deterministic | W2 | Compute configured name/identifier feature scores with missing-feature handling and explanation. |
| `screening.match.disambiguate` | hybrid | W2 | Compare candidate identifiers and conflicting evidence; produce disposition candidates or review requirements. |
| `screening.sanctions.ownership.evaluate` | deterministic | W2 | Apply configured sanctions ownership aggregation to complete graph scope; preserve unknown paths. |
| `screening.sanctions.control.evaluate` | deterministic | W2 | Apply regime-specific control tests separately from equity aggregation; cite controlling policy and evidence. |
| `screening.pep.relationship.resolve` | hybrid | W2 | Resolve sourced family/associate relationships and temporal scope; avoid unsupported association inference. |
| `screening.adverse_media.classify` | hybrid | W2 | Classify media allegations/events with source spans, dates, relevance and uncertainty. |
| `screening.adverse_media.correlate` | hybrid | W2 | Cluster syndicated and duplicate media events without treating repeated publication as independent evidence. |
| `screening.alert.disposition` | hybrid | W2 | Separate disposition recommendation from authorized disposition recording; bind approvals to hit/list/input versions. |
| `screening.rescreen.schedule` | deterministic | W2 | Create idempotent rescreen tasks from policy and invalidating events; persist due times and trigger basis. |

## 07. `risk.*` — 12 skills

Catalog context vocabulary: Party, RiskFactor, RiskAssessment, RiskModel, GeographyExposure, Finding, Policy, Evidence.

Dependency candidates and shared fixtures: Versioned factor/rule engine, exposure aggregations and offline calibration; missing factors, policy changes and score reproducibility.

| Skill | Baseline mode | Wave | Proposed implementation behavior and acceptance focus |
| --- | --- | --- | --- |
| `risk.customer.assess` | deterministic | W2 | Compose factor evaluation and configured deterministic scoring; return factor contributions and recommended tier. |
| `risk.inherent.calculate` | deterministic | W2 | Calculate inherent risk using versioned formula and explicit missing-input semantics. |
| `risk.residual.calculate` | deterministic | W2 | Calculate residual risk from sourced control effectiveness and policy; do not assume controls eliminate risk. |
| `risk.factor.evaluate` | deterministic | W2 | Evaluate one configured risk factor with input lineage, score mapping and unknown outcome. |
| `risk.geography.assess` | deterministic | W2 | Evaluate geography factors using versioned exposure and policy datasets with effective dates. |
| `risk.industry.assess` | deterministic | W2 | Evaluate industry factors from classified activities and policy; preserve ambiguous sector inputs. |
| `risk.product.assess` | deterministic | W2 | Evaluate product/channel factors from actual exposure and versioned risk mappings. |
| `risk.behavior.assess` | deterministic | W2 | Calculate behavioral risk features over complete authorized windows with baseline and coverage checks. |
| `risk.score.explain` | deterministic | W2 | Render explanations from exact score contributions and rule IDs; no model-invented score rationale. |
| `risk.score.calibrate` | deterministic | W2 | Fit or compare calibration candidates offline with held-out fixtures; activation requires governed promotion. |
| `risk.change.detect` | deterministic | W2 | Compare versioned assessments and attribute changes to inputs versus model/policy revisions. |
| `risk.tier.assign` | deterministic | W2 | Map scores and mandatory overrides to recommended tiers; final acceptance authority remains separate. |

## 08. `edd.*` — 10 skills

Catalog context vocabulary: Party, RiskAssessment, SourceOfFunds, SourceOfWealth, Investigation, Finding, Evidence, Policy.

Dependency candidates and shared fixtures: Requirements, evidence, transaction and screening capabilities; unsupported funds/wealth, counterexamples and review gates.

| Skill | Baseline mode | Wave | Proposed implementation behavior and acceptance focus |
| --- | --- | --- | --- |
| `edd.trigger.evaluate` | deterministic | W2 | Evaluate configured EDD trigger rules and unresolved prerequisites; expose reasons and unknowns. |
| `edd.scope.plan` | hybrid | W2 | Plan investigative tasks from triggers, requirements and gaps; keep analyst adjustments auditable. |
| `edd.source_of_funds.verify` | deterministic | W2 | Corroborate funds claims against origin, transaction and document evidence; record insufficient verification. |
| `edd.source_of_wealth.assess` | hybrid | W2 | Assess wealth explanations using sourced chronology and plausibility checks; distinguish inference from proof. |
| `edd.business.purpose.validate` | deterministic | W2 | Evaluate declared commercial purpose against evidence and policy; preserve unsupported or conflicting claims. |
| `edd.counterparty.analyze` | hybrid | W2 | Compose permitted counterparty resolution, screening and relationship analysis with explicit scope. |
| `edd.geographic.exposure` | hybrid | W2 | Investigate geographic exposure using sourced relationships/activity; retain coverage limitations. |
| `edd.pep.exposure` | hybrid | W2 | Investigate PEP connections, roles, dates and sources without assuming prohibited activity. |
| `edd.findings.synthesize` | hybrid | W2 | Synthesize sourced EDD findings, alternative explanations and remaining gaps with a claim-evidence matrix. |
| `edd.recommendation.generate` | hybrid | W2 | Generate a reviewable EDD recommendation from findings and policy; do not record final acceptance. |

## 09. `transaction.*` — 12 skills

Catalog context vocabulary: Transaction, Account, Counterparty, Party, ExpectedActivity, PaymentRail, Evidence, Policy.

Dependency candidates and shared fixtures: Canonical event ingestion, deduplication, Decimal/currency, time-window and aggregation primitives; late events and ledger reconciliation.

| Skill | Baseline mode | Wave | Proposed implementation behavior and acceptance focus |
| --- | --- | --- | --- |
| `transaction.ingest` | deterministic | W3 | Normalize canonical transactions with stable event IDs; reconcile duplicates, reversals and source coverage. |
| `transaction.enrich` | deterministic | W3 | Join authorized party/account/rail context and preserve enrichment source versions and missing fields. |
| `transaction.classify` | deterministic | W3 | Map transactions into a versioned taxonomy using rail/code rules and explicit unknown categories. |
| `transaction.counterparty.resolve` | deterministic | W3 | Resolve counterparty identifiers through entity/party primitives; retain unresolved candidates and evidence. |
| `transaction.behavior.profile` | deterministic | W3 | Aggregate behavior over declared windows/currencies; expose completeness, sample sizes and late-data policy. |
| `transaction.baseline.compare` | deterministic | W3 | Compare observed and expected activity on aligned windows; separate missing baselines from deviations. |
| `transaction.velocity.analyze` | deterministic | W3 | Compute configurable sliding-window counts/values with deduplication and event-time boundaries. |
| `transaction.flow.trace` | deterministic | W3 | Trace selected flows with allocation assumptions, bounded paths and unresolved breaks. |
| `transaction.cashflow.analyze` | deterministic | W3 | Aggregate inflows/outflows by account/window/currency and reconcile reversals and internal transfers. |
| `transaction.geography.analyze` | deterministic | W3 | Compute transaction geography from sourced party/rail attributes; retain unknown/ambiguous origin and destination. |
| `transaction.anomaly.detect` | deterministic | W3 | Apply versioned statistical/model anomaly logic with seed/config metadata and calibrated limitations. |
| `transaction.exposure.aggregate` | deterministic | W3 | Aggregate exposures with configured dimensions and currency rules; prevent duplicated-event double counting. |

## 10. `network.*` — 10 skills

Catalog context vocabulary: Entity, Relationship, Transaction, OwnershipGraph, NetworkGraph, Finding, Evidence, Policy.

Dependency candidates and shared fixtures: Temporal graph algorithms and canonical entity/transaction edges; disconnected graphs, cycles, truncated paths and deterministic seeds.

| Skill | Baseline mode | Wave | Proposed implementation behavior and acceptance focus |
| --- | --- | --- | --- |
| `network.graph.build` | deterministic | W3 | Build a bounded temporal graph from canonical nodes/edges and transaction links; preserve lineage. |
| `network.relationship.infer` | deterministic | W3 | Infer candidate links from configured features; inferred edges remain distinct from established relationships. |
| `network.community.detect` | deterministic | W3 | Run reproducible community algorithms with version/seed and graph-scope qualifications. |
| `network.path.find` | deterministic | W3 | Find bounded typed paths with source lineage and explicit traversal limits. |
| `network.centrality.calculate` | deterministic | W3 | Compute specified centrality measures with graph completeness and disconnected-node semantics. |
| `network.cycle.detect` | deterministic | W3 | Detect graph/flow cycles with temporal and amount constraints; return contributing edges. |
| `network.beneficiary.trace` | deterministic | W3 | Trace beneficiary paths under explicit allocation/control assumptions and unresolved frontiers. |
| `network.shared_attributes.detect` | deterministic | W3 | Detect shared attributes with normalization and collision controls; common values are not proof of collusion. |
| `network.temporal.analyze` | deterministic | W3 | Compare temporal graph views under consistent boundaries and late-data handling. |
| `network.risk.propagate` | deterministic | W3 | Propagate risk only under governed rules with contribution paths; do not inherit final guilt by association. |

## 11. `aml.*` — 12 skills

Catalog context vocabulary: Transaction, Account, Party, Typology, DetectionRule, Alert, Finding, Evidence, Policy.

Dependency candidates and shared fixtures: Transaction/window/graph primitives and synthetic typology policy packs; positive indicators, benign alternatives and coverage gaps.

| Skill | Baseline mode | Wave | Proposed implementation behavior and acceptance focus |
| --- | --- | --- | --- |
| `aml.structuring.detect` | deterministic | W3 | Detect configured aggregation/splitting patterns with time/currency thresholds and benign-case fixtures. |
| `aml.layering.detect` | deterministic | W3 | Detect multi-hop layering indicators over complete flow windows with path evidence and limitations. |
| `aml.roundtrip.detect` | deterministic | W3 | Detect return flows using time/amount tolerances and explicit entity/account identity handling. |
| `aml.funnel.detect` | deterministic | W3 | Detect convergent/dispersing funnel patterns with expected-business comparison and contributing transactions. |
| `aml.smurfing.detect` | deterministic | W3 | Detect distributed small-payment patterns using governed linkage and aggregation rules. |
| `aml.pass_through.detect` | deterministic | W3 | Measure rapid in/out throughput with balance/dwell assumptions and source coverage. |
| `aml.trade_based.detect` | deterministic | W3 | Evaluate trade-based indicators from trade/invoice/shipment context through declared optional capabilities. |
| `aml.mule.detect` | deterministic | W3 | Evaluate mule-account indicators with behavioral and counterparty evidence and false-positive alternatives. |
| `aml.shell_company.detect` | deterministic | W3 | Evaluate shell-company indicators from legal, ownership and activity context without asserting illegality. |
| `aml.velocity.detect` | deterministic | W3 | Apply versioned movement-velocity rules with aligned windows and de-duplicated events. |
| `aml.typology.match` | deterministic | W3 | Evaluate configured typology predicates and emit explainable indicator findings and missing prerequisites. |
| `aml.suspicion.assess` | deterministic | W3 | Assess indicators against investigation-escalation criteria; no automatic criminal conclusion or filing decision. |

## 12. `alert.*` — 10 skills

Catalog context vocabulary: Alert, DetectionRule, Party, Entity, Transaction, Case, Finding, Evidence, Policy.

Dependency candidates and shared fixtures: Alert/event repositories, context compiler and policy routing; duplicate alerts, incomplete evidence and conflicting dispositions.

| Skill | Baseline mode | Wave | Proposed implementation behavior and acceptance focus |
| --- | --- | --- | --- |
| `alert.ingest` | deterministic | W3 | Normalize source alerts with stable IDs, rule/model versions and contributing records. |
| `alert.classify` | hybrid | W3 | Classify alert categories using source/rule evidence with explicit ambiguous cases. |
| `alert.prioritize` | hybrid | W3 | Prioritize by transparent risk, severity, coverage and SLA inputs; retain human override lineage. |
| `alert.deduplicate` | hybrid | W3 | Propose duplicate groups using subject/event overlap and time windows; preserve original alerts. |
| `alert.correlate` | hybrid | W3 | Link related alerts with reasoned relation types and source evidence; avoid unsupported consolidation. |
| `alert.context.assemble` | hybrid | W3 | Invoke the context compiler for alert-scoped fields and evidence; report unresolved enrichment requests. |
| `alert.false_positive.assess` | hybrid | W3 | Assess false-positive explanations against supporting and contradictory evidence; unresolved risk needs review. |
| `alert.escalation.evaluate` | deterministic | W3 | Evaluate escalation requirements, severity and SLA rules deterministically with reason codes. |
| `alert.disposition.recommend` | hybrid | W3 | Recommend disposition from evidence and policy; separate recommendation from authorized closure. |
| `alert.feedback.capture` | hybrid | W3 | Capture attributed analyst feedback as versioned labels; do not automatically retrain or change policy. |

## 13. `investigation.*` — 12 skills

Catalog context vocabulary: Investigation, Case, Hypothesis, TimelineEvent, Transaction, Relationship, Finding, Evidence, Policy.

Dependency candidates and shared fixtures: Governed evidence collection, timeline/graph/flow primitives and bounded narrative generation; alternative hypotheses and unsupported claims.

| Skill | Baseline mode | Wave | Proposed implementation behavior and acceptance focus |
| --- | --- | --- | --- |
| `investigation.plan` | hybrid | W3 | Create bounded investigative tasks from alert questions, requirements, permissions and gaps. |
| `investigation.hypothesis.generate` | hybrid | W3 | Generate falsifiable hypotheses with supporting and opposing evidence needs; label them as hypotheses. |
| `investigation.evidence.collect` | hybrid | W3 | Collect through permitted source capabilities and preserve queries, coverage, access and source captures. |
| `investigation.timeline.build` | hybrid | W3 | Build sourced chronological events with uncertain dates and effective/recorded-time distinctions. |
| `investigation.relationship.analyze` | hybrid | W3 | Analyze typed party relationships with lineage; keep inferred and verified links separate. |
| `investigation.fundflow.reconstruct` | hybrid | W3 | Reconstruct fund movement using transaction/graph primitives and explicit allocation assumptions. |
| `investigation.hypothesis.test` | hybrid | W3 | Test hypotheses against defined evidence criteria and alternatives; return supported/refuted/unresolved states. |
| `investigation.contradiction.detect` | hybrid | W3 | Detect incompatible claims and timelines with cited sources; separate semantic assessment from exact checks. |
| `investigation.gaps.identify` | hybrid | W3 | Evaluate unanswered investigative questions and missing evidence; generate specific enrichment/task requests. |
| `investigation.findings.synthesize` | hybrid | W3 | Compose claim-evidence matrices, contradictions, alternatives and evidence-backed findings for review. |
| `investigation.narrative.generate` | hybrid | W3 | Draft a cited narrative from approved finding scope; check unsupported statements and confidentiality. |
| `investigation.recommendation.generate` | hybrid | W3 | Recommend case action with policy rationale, alternatives and unresolved issues; final disposition is separate. |

## 14. `fraud.*` — 12 skills

Catalog context vocabulary: Party, Identity, Device, Session, AuthenticationEvent, Payment, FraudSignal, Alert, Evidence, Policy.

Dependency candidates and shared fixtures: Typed signal/detector provider interfaces, session/payment/graph features; simulated scores, inconclusive signals and false-positive cases.

| Skill | Baseline mode | Wave | Proposed implementation behavior and acceptance focus |
| --- | --- | --- | --- |
| `fraud.identity.synthetic.detect` | hybrid | W4 | Combine synthetic-identity indicators through evaluated signal/provider interfaces; preserve score limits. |
| `fraud.identity.theft.assess` | hybrid | W4 | Assess identity-theft explanations using identity/session evidence and authorized verification signals. |
| `fraud.document.tamper.detect` | hybrid | W4 | Use document-forensics interfaces and source artifacts; report suspected tampering without certainty claims. |
| `fraud.deepfake.detect` | hybrid | W4 | Use a declared detector interface with modality/model/calibration metadata; synthetic scores are test responses. |
| `fraud.liveness.verify` | hybrid | W4 | Use a liveness-provider contract with challenge/session integrity and inconclusive handling. |
| `fraud.device.fingerprint` | hybrid | W4 | Normalize permitted device signals into pseudonymous features; preserve provenance and access restrictions. |
| `fraud.behavior.anomaly` | hybrid | W4 | Evaluate session/user behavior against versioned baselines with cold-start and drift limitations. |
| `fraud.account_takeover.detect` | hybrid | W4 | Combine authentication/session changes into takeover indicators; route uncertainty to step-up/review. |
| `fraud.payment.anomaly` | hybrid | W4 | Evaluate payment anomalies using transaction and fraud features with calibrated thresholds. |
| `fraud.beneficiary.risk` | hybrid | W4 | Assess beneficiary identity, history and graph exposure with evidence and unknowns. |
| `fraud.network.detect` | hybrid | W4 | Detect coordinated patterns using governed graph/linkage features; avoid inferring collusion from shared IP alone. |
| `fraud.case.assess` | hybrid | W4 | Compose fraud signals, contradictions and action recommendations under policy and human authorization. |

## 15. `case.*` — 10 skills

Catalog context vocabulary: Case, Task, WorkflowDefinition, Checkpoint, SLA, Actor, Approval, AuditEvent, Policy.

Dependency candidates and shared fixtures: Infrastructure repositories, context compiler, workflow DAG, command authorization and checkpoint services; conflicts and restart fixtures.

| Skill | Baseline mode | Wave | Proposed implementation behavior and acceptance focus |
| --- | --- | --- | --- |
| `case.create` | deterministic | W1 | Create a case through an authorized idempotent command without requiring an existing case context. |
| `case.context.hydrate` | deterministic | W1 | Expose the infrastructure context compiler through a skill facade; avoid recursive hydration calls. |
| `case.tasks.plan` | deterministic | W1 | Compile required tasks from workflow/requirements and current case state with stable task IDs. |
| `case.tasks.assign` | deterministic | W1 | Assign tasks through role, workload and separation-of-duties rules using revision-checked commands. |
| `case.state.transition` | deterministic | W1 | Apply explicit state-machine commands with preconditions, actor authority and audit records. |
| `case.dependencies.evaluate` | deterministic | W1 | Evaluate task DAG prerequisites and joins; distinguish blocked, unmet and completed dependencies. |
| `case.sla.monitor` | deterministic | W1 | Calculate SLA status against configured calendars, pause rules and deadlines. |
| `case.escalate` | deterministic | W1 | Create authorized escalation tasks/events with reason, recipient role and deduplication key. |
| `case.summary.generate` | deterministic | W1 | Render a deterministic structured case summary; optional prose requires separate bounded model execution. |
| `case.close` | deterministic | W1 | Close only when configured obligations, approvals and tasks pass; enforce concurrency and audit controls. |

## 16. `decision.*` — 12 skills

Catalog context vocabulary: Policy, Requirement, Control, Finding, RiskAssessment, Decision, Approval, Exception, Evidence.

Dependency candidates and shared fixtures: Policy/requirement compiler, deterministic rules and authenticated human-task gateway; unknown inputs, expired approvals and prohibited overrides.

| Skill | Baseline mode | Wave | Proposed implementation behavior and acceptance focus |
| --- | --- | --- | --- |
| `decision.policy.resolve` | deterministic | W1 | Resolve effective policy scope/version from trusted tenant bindings without assuming an existing decision. |
| `decision.requirements.compile` | deterministic | W1 | Compile applicable requirements from party/product/jurisdiction context and versioned policy packs. |
| `decision.rules.evaluate` | deterministic | W1 | Execute deterministic rules returning PASS/FAIL/UNKNOWN/NOT_APPLICABLE with input hashes and reasons. |
| `decision.exceptions.evaluate` | deterministic | W1 | Validate explicit exceptions against issuer authority, scope, expiry and prohibited-override constraints. |
| `decision.gaps.evaluate` | deterministic | W1 | Identify missing/failed obligations from the requirement-control matrix without treating unknowns as satisfied. |
| `decision.risk.acceptance.evaluate` | deterministic | W1 | Evaluate risk acceptance eligibility and required authority; no automatic unauthorized acceptance. |
| `decision.recommendation.generate` | deterministic | W1 | Build recommendations from rule outcomes and explicit policy mappings with traceable reasons. |
| `decision.approval.route` | deterministic | W1 | Create approval tasks routed to eligible roles with separation-of-duties and input hashes. |
| `decision.human.review` | human-gated | W1 | Capture authenticated human review via durable task/resume; validate scope, authority and changed inputs. |
| `decision.disposition.record` | human-gated | W1 | Record a disposition through an authorized revision-checked command with bound approvals and evidence. |
| `decision.explain` | deterministic | W1 | Render reasons from evaluated rules, evidence and approvals; no invented post-hoc rationale. |
| `decision.audit.verify` | deterministic | W1 | Verify complete decision lineage, authority, policy/input versions and approved state transitions. |

## 17. `monitor.*` — 10 skills

Catalog context vocabulary: Party, MonitoringPlan, ReviewTrigger, Event, RiskAssessment, ScreeningHit, Case, Policy.

Dependency candidates and shared fixtures: Durable scheduler/event ledger plus profile, ownership, screening and risk skills; duplicates, late events and timer recovery.

| Skill | Baseline mode | Wave | Proposed implementation behavior and acceptance focus |
| --- | --- | --- | --- |
| `monitor.customer.schedule` | deterministic | W2 | Persist periodic review schedules using configured risk/calendar rules and idempotent job IDs. |
| `monitor.trigger.evaluate` | deterministic | W5 | Evaluate source events against versioned triggers with deduplication, event time and coverage. |
| `monitor.profile.change` | deterministic | W5 | Diff authorized party profile snapshots and emit material change candidates. |
| `monitor.ownership.change` | deterministic | W5 | Compare ownership graph versions and classify material changes with unresolved-path qualifications. |
| `monitor.screening.refresh` | deterministic | W5 | Compose refreshed screening with list freshness/coverage checks and prior disposition invalidation. |
| `monitor.transaction.deviation` | deterministic | W5 | Compare monitored behavior to aligned baselines with complete window/watermark metadata. |
| `monitor.risk.recalculate` | deterministic | W5 | Recalculate risk from changed inputs and record cause/model/policy versions without final acceptance. |
| `monitor.review.scope` | deterministic | W5 | Select review requirements/tasks from trigger scope, previous evidence and current policy. |
| `monitor.review.execute` | deterministic | W5 | Execute an explicit review workflow through the common executor with durable progress and bounded branches. |
| `monitor.review.close` | deterministic | W5 | Close review only after scope-specific evidence, tasks and approvals satisfy policy; schedule next action. |

## 18. `regulatory.*` — 10 skills

Catalog context vocabulary: Jurisdiction, Obligation, Filing, Case, Investigation, Transaction, Evidence, Approval, Policy.

Dependency candidates and shared fixtures: Synthetic obligation/calendar/filing schemas, authenticated approvals, outbox and local submission endpoint; lost receipts and duplicate requests.

| Skill | Baseline mode | Wave | Proposed implementation behavior and acceptance focus |
| --- | --- | --- | --- |
| `regulatory.obligations.resolve` | human-gated | W5 | Resolve synthetic reporting obligation packs by scope/effective time; production authority needs qualified policy. |
| `regulatory.sar.evaluate` | deterministic | W5 | Evaluate potential SAR obligations and review criteria from case findings; indicators alone do not decide filing. |
| `regulatory.sar.draft` | human-gated | W5 | Draft cited structured narrative from case facts and findings; mark uncertainties and require review. |
| `regulatory.sar.validate` | deterministic | W5 | Validate SAR fields, chronology, confidentiality and claim coverage against versioned filing schema. |
| `regulatory.ctr.evaluate` | deterministic | W5 | Evaluate configured CTR predicates with aggregation/currency/time rules and explicit applicability. |
| `regulatory.ctr.prepare` | human-gated | W5 | Prepare typed CTR fields and evidence from governed records; do not submit during preparation. |
| `regulatory.deadline.calculate` | deterministic | W5 | Calculate deadlines from obligation events, configured calendars/timezones and extension rules. |
| `regulatory.filing.prepare` | human-gated | W5 | Build immutable versioned filing packages with schema checks, evidence and approval requirements. |
| `regulatory.filing.submit` | human-gated | W5 | Submit an approved package through outbox/idempotency controls; reconcile ambiguous acknowledgments. |
| `regulatory.filing.track` | deterministic | W5 | Poll/capture submission status and receipts with bounded retries and reconciliation; never infer acceptance. |

## 19. `evidence.*` — 10 skills

Catalog context vocabulary: Evidence, SourceRecord, Assertion, Fact, Finding, Provenance, Conflict, RetentionRule, Policy.

Dependency candidates and shared fixtures: Artifact repository, canonical hashing, span validation and derivation DAG; corruption, conflicts and legal holds.

| Skill | Baseline mode | Wave | Proposed implementation behavior and acceptance focus |
| --- | --- | --- | --- |
| `evidence.collect` | hybrid | W1 | Collect permitted artifacts/source responses with hashes, capture times and source/query metadata. |
| `evidence.normalize` | deterministic | W1 | Normalize metadata while preserving raw source values, versions and license/access restrictions. |
| `evidence.provenance.attach` | hybrid | W1 | Attach verifiable derivation/source/span lineage to records; prohibit source-free verified facts. |
| `evidence.integrity.verify` | deterministic | W1 | Verify content hashes and source/span references; surface corruption and missing artifacts. |
| `evidence.facts.extract` | hybrid | W1 | Extract assertions with source spans; promote to facts only after explicit verification criteria pass. |
| `evidence.conflicts.resolve` | hybrid | W1 | Reconcile conflicting claims with temporal/authority rules and human review; preserve both source records. |
| `evidence.sufficiency.assess` | hybrid | W1 | Evaluate evidence against applicable requirement/question coverage and source quality; unknowns remain gaps. |
| `evidence.lineage.trace` | hybrid | W1 | Traverse derivation DAGs to sources with cycle detection and missing-link reporting. |
| `evidence.bundle.compile` | deterministic | W1 | Compile immutable, access-filtered evidence bundles with manifest hashes and completeness checks. |
| `evidence.retention.enforce` | deterministic | W1 | Apply configured retention/legal-hold rules via authorized deletion commands; include caches and derived views. |

## 20. `quality.*` — 10 skills

Catalog context vocabulary: SkillExecution, EvaluationCase, ExpectedOutcome, Finding, Evidence, AuditEvent, Policy, ModelVersion.

Dependency candidates and shared fixtures: Schema validators, trace/policy/evidence contracts and offline evaluation services; unsupported claims and evaluation-data access controls.

| Skill | Baseline mode | Wave | Proposed implementation behavior and acceptance focus |
| --- | --- | --- | --- |
| `quality.data.validate` | deterministic | W1 | Validate object completeness, ranges, duplicates, temporal consistency and source-specific quality rules. |
| `quality.schema.validate` | deterministic | W1 | Validate canonical schemas and version compatibility without silent coercion of invalid data. |
| `quality.findings.verify` | deterministic | W1 | Check finding types, citations and source support; semantic support needs evaluated model/human assistance. |
| `quality.hallucination.detect` | deterministic | W1 | Detect broken/missing citations deterministically and assess unsupported claims separately; no perfect detector claim. |
| `quality.policy.compliance` | deterministic | W1 | Verify execution/control results against the pinned policy and required authorization path. |
| `quality.coverage.assess` | deterministic | W1 | Compute requirement, source, graph and test coverage with explicit denominators and exclusions. |
| `quality.confidence.calibrate` | deterministic | W1 | Evaluate confidence calibration on held-out labeled data; activation of changes is a governed action. |
| `quality.agent.trace.evaluate` | deterministic | W1 | Evaluate trace structure, permitted calls, budgets, evidence and approval ordering against execution policy. |
| `quality.outcome.reconcile` | deterministic | W1 | Compare expected and observed outcomes with schema-aware tolerances and attributable differences. |
| `quality.remediation.plan` | deterministic | W1 | Produce remediation tasks from concrete validation failures with owners, prerequisites and verification criteria. |

