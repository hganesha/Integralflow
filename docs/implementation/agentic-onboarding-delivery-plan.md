# Agentic KYC and KYB onboarding: gap review and delivery plan

Status: proposed 2026-11-09, reconciled the same day with the policy engine consolidation plan (*Policy engine
consolidation: implementation review, remediation and test plan*; findings F01-F18, PRs R01-R10). Its references
below use that plan's IDs. It follows phases 0 to 4 of the [agentic KYC and KYB plan](agentic-kyc-kyb-plan.md) and
the first live runs ([agentic-flows.md](agentic-flows.md)), and replaces phases 5 and 6 of that plan with the waves below.

## 1. Purpose and scope

The goal is to put the agentic KYC (individual) and KYB (business) **onboarding** flows on the platform, end to end.
That means:
- an application comes in;
- the case is hydrated from sources and documents;
- the agents work it with a core set of qualified skills;
- the case reaches a person's recorded decision.

Every part must be tested at each layer.

**In scope:**
- case and evidence store writes;
- access to skills (host, gateway, delegation, qualification);
- the context layer and the new ontology work;
- optional document authenticity checks during hydration;
- the ten agents;
- the onboarding variant;
- the test strategy.

**Out of scope: the policy layer.** The policy engine consolidation plan owns everything below. Where a gap here is really a policy question, it is noted and handed over (section 8), not planned:
- **Gates and sinks:** every authoritative business decision and protected business action. That covers OPA evaluation, decision and grant contracts, installation packs and their release, protected-sink enforcement in the case store, gate-driven human work and routing, and banking and source policy.
- **Implicit decisions in skill outputs:** retiring implicit business decisions inside skill outputs (F10).

This plan builds the **observations, proposals, hydration, skill access, context and agents** that those gates consume. It also builds the flows that route on their decisions.

## 2. Where we are

**Built** (phases 0 to 4):
- the archived deterministic flows;
- agent nodes that run skills and have their tasks judged by the runtime;
- layered policy packs with per-case selection and pack checkpoints;
- ten agents;
- the two agentic flows;
- the Claude reasoning connector;
- synthetic customer documents with an answer key;
- a live harness.

**Live-tested:** the document and identity agents, on H02, H03 and H04 with Claude. They passed every scored check (12 of 12).

**Not tested end to end:** the other eight agents, and everything on the platform path (case store, gateway, skill host).

**Readiness matrix.** To measure skill readiness, I ran every required skill of both flows over nine corpus heroes through the skill library, with no models. Bindings were resolved as the plans do, under a synthetic policy:
- **14 of 33** required skills complete on every hero.
- **10** complete on some heroes: documents, screening, expected behaviour and ownership.
- **9 never complete:**
  - `document.fields.contract_extract`, because this run has no model to answer its provider request;
  - `document.validity.assess` and `document.consistency.assess`, because without extraction there are no assertions (section 3.1);
  - `screening.adverse_media.execute`, because there is no adverse-media source;
  - `investigation.findings.synthesize` and `quality.findings.verify`, because there is no producer of Finding records;
  - `decision.recommendation.generate` and `quality.policy.compliance`, because there is no producer of Control records;
  - `entity.resolve`, which is always NEEDS_REVIEW because the flows bind no identifiers.

Section 3.5 has the per-agent view.

### 2.1 Implementation status (waves 0 to 5)

Each wave is a commit on the agentic branch. What a wave left to another owner or for later is named with it.

| Wave | Delivered | Left for its owner or later |
|---|---|---|
| 0 | **W1** the disposition checkpoint continues to the person on ALLOW or REVIEW (interim; R05 replaces it). **W2** completion reads `proposed_records` from the computation. **S6** `entity.resolve` gets the subject's identifier values through a filtered context binding. **C8** duplicate vendored files removed. | |
| 1 | **S1/CR-8** library capability names map to platform ids; the flows declare the provider capabilities their skills reach, so the compiler puts them in node envelopes and the gateway delegates them. **S2** the library host is the compose default (profile `skills`); `pnpm agentic:prepare` admits the plans and registers the lock, approving nothing. **S5** the host verifies the delegated envelope's RS256 signature and can keep executions in sqlite. | A `deploy/` entry and a compose smoke test; the two skipped conformance checks. |
| 2 | Declarative writes repeat over a list (`forEach`, at most 50). Findings become UNVERIFIED Finding records (`agent_proposal` provenance) and proposed claims; the identity agent's CONFLICT checks become contradictions; decision support's recommendation becomes SubmitDecisionRecommendation (never APPROVE). **W7** a stop records the checkpoint result as evidence; **W8** stops and results link the run. **W11** the compiler refuses a proposal-mode skill node without proposal grants. | Everything protected (R01, R04-R05); ProposeWorkItem from agents awaits R01's classification; Control producers. |
| 3 | **W3/W4** acquisition connectors run as hydration stages: identity (documents; registry, LEI, officers, ownership for a business) before the document agent, screening before the screening agent, each with an `allSettled` barrier. **C1** context-source bindings name a subject field and purposes. The corpus seeder writes the heroes' documents. | **C2** Application type and intake API; **C3** relationships (not landed); **C4** per-record trust labels; **C5** freshness (policy-owned); **S7** per-party extraction; the case type is a single literal. |
| 4 | The document agent's hydration skills `document.authenticity.assess` and `fraud.document.tamper.detect` run before classification, outside its completion, shown to its review. Bound to the sandbox connectors (always INCONCLUSIVE). A completed, informative tamper answer becomes a FraudSignal citing the detector output; an inconclusive one writes nothing. The document and identity agents read FraudSignal; `documents[].authenticity` is NOT_CHECKED, INCONCLUSIVE or SIGNAL, never authentic. | The artifact-based request CR, deepfake and liveness (need a media Session), planted authenticity cases, a vendor connector, the enable flag in installation policy. |
| 5 | See below. | |

**Wave 5, agents tested.**
- **Answer keys** (`packages/runtime-langgraph/src/agent-answer-key.ts`) are derived only from each hero's `expectations.yaml` and `documents.expected.yaml`: document types, validity and planted conflicts; beneficial owners; each screening hit proposed and never cleared or confirmed against the facts; EDD where the facts require it; a clean hero raises nothing blocking; decision support never decides and agrees with the facts' direction. What needs policy (a tier, per-party document requirements) is reported unscored.
- **The harness walks the compiled plan** (`agent-flow-run.ts`): every skill on the main path in order, each agent's review with its real pack, loop, schema and completion. The detectors are answered by their sandbox connectors in-process.
- **Recorded replay in CI.** `scripts/live-agent-run.ts --record` stores the library's results and the models' answers (`fixtures/agent-recordings/`). `agent-flow-replay.test.ts` replays every recording through today's plan: every agent of both flows must answer within its schema, have its completion judged, never declare itself final, and still pass every check its live run passed. Drift is reported; `--replay <file> --strict` fails on it.
- **QA independence:** a test checks the judge profile is used by QA alone and is a different model from every other tier, in every profile set.
- **Live runs** (Claude through OpenRouter, development split): every agent of both flows, single runs on five development heroes:

  | Flow | Hero | What it plants | Answer key | Model calls | Cost |
  | --- | --- | --- | --- | --- | --- |
  | KYC | H01 | clean control, no documents | 15/15 | 13 | $1.16 |
  | KYC | H02 | sanctions hit with conflicting identifiers | 19/19 | 17 | $2.51 |
  | KYC | H03 | sibling is a verified PEP; DOB conflict, expired licence | 24/24 | 21 | $3.12 |
  | KYB | H04 | clean ownership; registered-office conflict | 26/27 | 18 | $1.88 |
  | KYB | H06 | sanctions through ownership, nominee range, cycle | 19/19 | 18 | $2.97 |

  103 of 104 checks, $11.63 in all. The miss: on H04 the screening agent raised a BLOCKING finding because the pinned lists are marked incomplete. It did not do that on the previous run of the same hero, so this is variance that repeated runs need to measure. No agent decided anything, and every task ended in review, evidence or blocked.
- **Fixed from the first runs:**
  - Decision support proposed COLLECT_EVIDENCE on H06 because it never saw the screening agent's blocking findings. The walk now commits each review's findings as UNVERIFIED Finding records, as the platform's wave 2 writes do. Decision support reads Finding and ScreeningHit; QA reads Finding. It now escalates H06.
  - The intake agent classified an individual as `unknown` because it never saw the banking relationship, and the risk agent proposed no EDD for a customer whose sibling is a verified PEP because it never saw the PEP relationship or the hit. Both now read those records.

**Observations to calibrate:** with the findings committed, each run proposes 35 to 52 Finding records, and decision support escalates or collects evidence on every hero, the clean ones included. The keys check direction only ("not a decline"), so they do not catch over-escalation. Packs grew too, which roughly doubled cost. Before qualification, the owners should set a severity discipline for findings and a key for over-escalation on clean heroes.

**Not yet done in wave 5:** five repeated runs per agent and hero, the held-out split and `agent.qualification.v1` evidence (they need the owners' thresholds); adversarial cases (document prompt injection, stale screening, unreachable tool); H06's layered ownership and H12's trust as scored keys beyond named owners; the platform harness through the composed services; a nightly live evaluation job.

## 3. Gap review

Gaps carry IDs for tracking. **P0** blocks any end-to-end run, **P1** blocks a pilot, and **P2** is hardening.

### 3.1 Case and evidence store writes

The commit machinery is sound:
- **Commit mapping:** `planSkillCommit` maps proposals to commands.
- **Case-store checks:** the case store checks grants against the envelope, and commits atomically and idempotently with a sequence precondition.
- **Read-after-write:** a run sees its own writes, because `snapshotFor` re-reads the case for every node.

The generator keeps the grants. What is missing is in the flows:

| ID | Pri | Gap | Evidence |
| --- | --- | --- | --- |
| W1 | P0 | **The human decision is unreachable.** `pack-disposition` always returns REVIEW (`HUMAN_DECISION_REQUIRED`, by design), but the edge continues only on ALLOW, so every run stops before `decision-human-review`. The interim fix routes REVIEW with `HUMAN_DECISION_REQUIRED` to the person. The lasting fix is gate-driven routing on typed decisions (R05) | `policy-packs.ts:468-470`; `library-package.mjs` checkpoint routing |
| W2 | P0 | **The document agent's task can never complete on the platform.** Its completion requires the payload field `proposed_records`, but the skill host moves that field out of the payload into the computation | `skill_host.py:312`; `task.document_intelligence` criteria. The live harness bypasses the host, so it missed this |
| W3 | P0 | **No document intake.** The flows load no documents: upload stores `UPLOADED_UNPARSED` evidence only, and DocumentVersion and DocumentPage records come from `normalizeEvidencePackage`, which no node of the agentic plans calls. The required page selector then makes classification answer NEEDS_EVIDENCE | `case-api/src/app.ts:520-570`; `canonical-records.ts:682-780`; `sync-agentic-flows.ts` passes `connectors: []` |
| W4 | P0 | **No acquisition.** The archived flows and production slice 1 had `acquire-*` connector nodes for identity, registry, ownership, sanctions, PEP and adverse media, writing RecordCanonicalRecords as `system`. The agentic flows have none, so screening, ownership and the pack checkpoints read only pre-seeded records | `kyb-connectors.mjs:22-55`; readiness matrix (screening NEEDS_EVIDENCE on five of nine heroes) |
| W5 | P1 | **The decision is not recorded** (**policy layer:** FinalizeDisposition and TransitionCaseStatus are protected sinks, F04-F06, R04-R05). `decision.human.review` has no case commands, and its release node writes nothing (`NOTHING_HELD`). No RecordReview, FinalizeDisposition or TransitionCaseStatus | `business-skills.json`; `runtime-core/src/index.ts:1310-1316` |
| W6 | P1 | **Agent outputs are opaque evidence** (this plan: as non-authoritative proposals and observations). Findings, gaps, requests, `documentChecks`, recommendations and `requiresHumanReview` are stored as one JSON evidence item. None becomes a work item, contradiction, claim or decision recommendation | `runtime-core/src/index.ts:1054-1126` |
| W7 | P1 | **The stop node writes nothing.** A case a checkpoint stops leaves no RequestHumanReview or work item, and nobody is told. A technical stop must also stay distinct from a policy-issued human requirement (F17) | `sync-agentic-flows.ts` stop node |
| W8 | P1 | **Lifecycle writes dropped** (**policy layer** for TransitionCaseStatus; this plan for LinkExecution). Compared with archived KYC v2, the flows lost TransitionCaseStatus, SubmitDecisionRecommendation and LinkExecution | `artifacts/archive/kyc-v2.plan.json` |
| W9 | P1 | **Unreviewed assertions are used as-is.** `validity.assess` and `consistency.assess` consume `PENDING_REVIEW` assertions with no filter on `review_state`. That is acceptable for assessment, but agents must label them as unverified | `skill-commit` path |
| W10 | P2 | **Library commands dropped.** The host returns `requested_effects: []` and drops a skill's library `commands` (for example `monitor.customer.schedule`) | `skill_host.py:307-318` |
| W11 | P2 | **Missing grants are not caught.** The compiler refuses grants beyond the pin, but does not require grants for a node's pinned mode | `compiler.ts:341-394` |

### 3.2 Access to skills

| ID | Pri | Gap | Evidence |
| --- | --- | --- | --- |
| S1 | P0 | **Provider capabilities are unreachable through the gateway (CR-8).** Manifests declare library names (`document.fields`, `document.ocr`), delegation matches exact platform IDs, and neither plan contains them. So `contract_extract` and `parse.artifact` cannot call their connectors on the platform. The harness worked only because it bypasses the gateway | `skills.ts:376-377`; `business-skills.md:302` |
| S2 | P0 | **The library skill host is not runnable by default.** It sits under an opt-in compose profile, the gateway's default `SKILL_HOST_URL` points at the three-skill reference host, the lock is registered and approved by hand, and the host is absent from `deploy/` | `compose.yaml:183,256-273`; `deploy/platform-entrypoint.sh:11` |
| S3 | P1 | **No production path for any skill.** All 229 skills are `implemented_synthetic`, all registry entries are `draft`, and no `skill.qualification.v1` record exists. In production the gateway refuses every roster skill (maturity of at least `integration_verified`, plus approved qualification) | `skills.ts:314-370` |
| S4 | P1 | **Only 11 roster skills have corpus evaluation evidence** (production slice 1), and that evaluation ran in-process, not through the host. The other 46 have synthetic fixtures only | `evaluate.py:36-41` |
| S5 | P1 | **Unverified envelopes; no durability.** The host decodes the delegated envelope without verifying it, and executions live in memory, so a restart answers 404. Two conformance sub-checks are skipped | `skill_host.py:78-87,216-258` |
| S6 | P1 | **Unbound identifiers.** `entity.resolve` gets `identifiers: []`, although case subjects carry identifiers. So it is NEEDS_REVIEW on every hero, and the identity agent's task never completes | readiness matrix; `case.json` subjects |
| S7 | P2 | **One-subject extraction.** `contract_extract` extracts for one subject per execution, so a director's passport is attributed to the company | live H04 run |
| S8 | P2 | **No vendor connectors live.** 822 wiring connectors are `available` but blocked (credentials, contracts, entitlements), including the registry (Companies House, GLEIF) and IDV vendors | `config/connector-catalog.json` |
| S9 | — | **Handed to policy.** All 57 skills read policy fields; 18 have fields the packs leave unresolved (risk weights, EDD triggers, decision rules, permitted providers). The policy agent owns these | `skillPolicies` projections |

### 3.3 Context layer and the ontology

The ontology (`ontology.schema.json` 2.0.0, 89 types) is now becoming a graph. You described these pieces, but they are **on no pushed branch yet**, so this plan consumes them as they land:
- 34 typed semantic relationships (`apps/fincrime-host/ontology/relationships.json` → `catalog/context-relationships.json`, digested and vendored with the library lock);
- `/v1/context/relationships`;
- the Contextboard;
- a bounded **case relationship projection**: in the case service, over the context pack's admitted sections only, with typed resolution, explicit unresolved reasons, limits of 200 record versions and 500 relationship observations, and completeness always false.

| ID | Pri | Gap | Evidence |
| --- | --- | --- | --- |
| C1 | P0 | **Connector records are invisible to skills.** `normalizeContextRows` sets no `subject_ids` or `purposes`, and the library admits a record only if it shares a subject and purpose with the invocation | `context-connectors/src/index.ts:695`; `financial_crime/context.py:76-80` |
| C2 | P0 | **Application intake landed** (`POST /v1/applications`: case by scope with its subjects and Application, Party, Product, BankingRelationship, ExpectedActivity, Entity, IdentityIdentifier, Address, OwnershipInterest, OfficerRole and SourceOfFunds records; KYB cases typed `kyb_onboarding`). Still open: document uploads at intake, Registration records. Originally: **No onboarding hydration.** Nothing turns an application into a populated case:<ul><li>no `Application` type (context-experience §5);</li><li>a connector binding emits one object type;</li><li>there are no join or identity-resolution transforms;</li><li>refresh is bound to an existing case.</li></ul>Today cases come only from the corpus seeder, which hard-codes `caseType: kyc_onboarding` (KYB too) and loads no documents | `context-corpus/src/seed.ts`; `context-experience.md` |
| C3 | P1 | **Flat agent context.** Packs are per-type record lists: no subject scoping, no traversal. An agent must join ids itself (ExtractedAssertion → Identity, OfficerRole → Entity) | `context-plane/src/records.ts` |
| C4 | P1 | **Coarse trust labels.** Every record section is labelled `UNTRUSTED_EXTERNAL`, whether it holds bank data, applicant data, registry data or skill proposals. Per-record provenance exists but is not shown to the model | `context-plane/src/index.ts:338` |
| C5 | P1 | **No staleness bounds.** Every record selector in both plans has `maxAgeSeconds: null`; freshness exists only inside skill policy | plans |
| C6 | P2 | **Off-ontology selector.** `records.BankingRelationship` is a platform type, not an ontology type; it needs an ontology home or a documented platform namespace | plans |
| C7 | P2 | **No retrieval.** The context store's graph is provenance only, and pgvector knowledge has no writer and no pack integration | `context-store` |
| C8 | P2 | **Vendor hygiene.** Duplicate vendored files (`ontology.schema 6.json`, `lock 6.json`) | `packages/library-contracts/src/vendor` |

### 3.4 Document authenticity

| ID | Pri | Gap | Evidence |
| --- | --- | --- | --- |
| A1 | P1 | **Skills exist but are unused.** `document.authenticity.assess`, `fraud.document.tamper.detect`, `fraud.deepfake.detect`, `fraud.liveness.verify`, `fraud.identity.synthetic.detect` and `fraud.identity.theft.assess` exist (read-only, `implemented_synthetic`). No agent or flow uses them | catalog; roster |
| A2 | P1 | **No bytes reach a detector.** The forensics request carries hashes of page **text** and tamper detection carries page text, never the file. A real vendor cannot assess them | `payload_types.py:156-168` |
| A3 | P1 | **Only simulators answer.** Every detector capability is answered by the simulator, always INCONCLUSIVE. IDV vendors (Veriff, Jumio, Sumsub, Persona, Onfido, Regula and others) are catalogued but blocked; liveness has no mapping from the vendor `verification` family to `DetectorAssessment` | `adapters/src/index.ts:611-621`; `library-contracts.md:116-124` |
| A4 | P1 | **Results don't land as records.** No authenticity result becomes a canonical record, and there is no mapping to `FraudSignal` | ontology |
| A5 | P2 | **No authenticity operation in the registry.** The Intelligence registry's document service class has no forensics or authenticity operation (OCR, layout, extract, classify and split only) | `intelligence.ts:84` |

### 3.5 Agents

**Live-tested**

| Agent | What works | Gaps |
| --- | --- | --- |
| Document intelligence | Classifies every document by title; extraction passes the library's span and binding validation after the connector fixes; validity and consistency run over the committed assertions; expiry and cross-document conflicts reported | W2 completion bug; W3 no intake; S1 extraction unreachable through the gateway; S7 single-subject extraction; per-party document requirements (policy); its tool `document.evidence.package.v1` unavailable in the harness; single runs, no repetition or held-out set; no recorded fixtures for CI |
| Identity verification | Compares document assertions and pages with identity and registry records; reports the planted date-of-birth and registered-office conflicts and no false conflicts on the clean case | S6 `entity.resolve` never resolves, so the task is NEEDS_REVIEW on every hero; registry and identifier tools unavailable; `registry.company.verify` only over seeded RegistryRecords (no live registry, S8); the same harness limits |

**Untested (8)**

| Agent | Required skills on the corpus | Blocking gaps |
| --- | --- | --- |
| Intake and profile | All three complete on 9/9 heroes | C2 no application intake: it profiles seeded records, not an application; no `Application` type; KYB seeded as `kyc_onboarding` |
| Ownership and control (KYB) | Complete on H04, H05, H07; PARTIAL on H06 (layered, ranges); NEEDS_EVIDENCE on H12 (trust, no ownership interests) | W4 no ownership acquisition; trust and arrangement structures (H12) have no ownership model; `ubo.verify` needs a verified BeneficialOwner producer; no answer key for agent output beyond slice-1 skill evaluation |
| Screening | Sanctions and PEP NEEDS_EVIDENCE on 5/9 heroes; disambiguation needs ScreeningHit | W4 no screening acquisition stage (production slice 1 had one); list freshness and as-of are never refreshed; adverse media is a loop tool only |
| Investigation | `evidence.collect` 9/9; adverse media 0/9; `findings.synthesize` 0/9 | No AdverseMediaEvent source (corpus H09 not built); no producer of Finding records (W6: agents' findings are not committed) |
| Risk and EDD | All three complete on 9/9 | Results come from unresolved policy fields (favourable defaults, F3): handed to policy; the EDD work item is declarative only; no answer key for tiers |
| Relationship and product | Product profile and monitoring 9/9; expected behaviour NEEDS_EVIDENCE on H03, H05, H12 | ExpectedActivity comes from the application, which doesn't exist yet (C2); the monitoring schedule's library command is dropped (W10) |
| Decision support | Requirements and rules 9/9; recommendation 0/9 | No producer of Control records; W1 the decision is unreachable; W5 not recorded; rules come from unresolved policy fields (policy) |
| QA and assurance | 0/9 on both skills | Needs Finding, Evidence and Control records (W6 and Control producer); the judge model on an independent profile is untested live |

## 4. The onboarding variant, end to end

The target path for one onboarding case. Each step names the gaps it closes.

1. **Application intake (C2).** A person or channel submits an application: customer type, legal names, identifiers, addresses, products wanted, expected activity, related parties, and document uploads. The case API creates the case with the right case type (`kyc_onboarding` or `kyb_onboarding`), its subjects with identifiers, and a BankingRelationship (booking jurisdiction, institution, products). From those, the pack selection pins the policy pack, which belongs to the policy layer.
2. **Hydration (C1, C2, W3, W4).** A hydration stage at the head of each flow:
   - **Documents:** uploaded documents go through the evidence pipeline (`document.evidence.package`), then `normalizeEvidencePackage`, as DocumentVersion, DocumentPage and Evidence records.
   - **Acquisition:** connectors acquire identity verification, registry, officers, ownership, sanctions and PEP lists, and adverse media through their bindings (live, `corpus:` replay or simulator), and record canonical records with `subject_ids` and `purposes`.
   - **Optional authenticity checks** (section 6, W3).
   - **Barrier:** all acquisitions settle before the agents start (`allSettled`). A failed source is visible, and its records are simply absent.
3. **The agents** work the case as now, each over its own skills, its reads and the case's relationships (C3).
4. **Checkpoints.**
   - Interim: as now, with routing fixed (W1).
   - Target: gate nodes that return typed decisions (section 8). Evidence to collect and human work come from the decision's obligations and human requirement. A technical stop stays operational (W7, F17).
5. **Decision.**
   - Decision support records its recommendation (SubmitDecisionRecommendation, a proposal). QA records its findings as proposals.
   - The released decision gate decides (policy plan section 5). The automated outcome, the evidence to collect, the human requirement (roles, quorum, independence) and the permitted effect all come from that decision.
   - A person's response goes to a post-review gate. The owning service applies the grant-backed effect (FinalizeDisposition, TransitionCaseStatus).
   - Whether a person is required is installation policy, not this flow's code.
6. **Handoff.**
   - **Approved:** the case closes as approved, and the monitoring schedule becomes a periodic review work item.
   - **Declined or more evidence:** the case stays open, with the requests composed by the document agent as work items.

The variants share one topology:
- **KYC individual** (nine agents).
- **KYB business** (ten agents).
- Within KYB, **trusts and arrangements**: H12 needs an ownership model for settlor, trustee and beneficiary, which ownership skills don't cover today. It is planned as a KYB sub-variant in wave 6, not in the first pilot.

Periodic review and event-driven review reuse the flows with a different intake, later.

## 5. The core skill set

Not all 57 roster skills can be made robust at once. The pilot depends on a **core set of 24**, which must be:
- **implemented:** reachable through gateway, delegation and host;
- **evaluated:** against corpus answer keys, through the host, on development and held-out splits;
- **qualified:** a `skill.qualification.v1` record with owner thresholds.

The other skills stay available as loop skills or remain stubs. Their absence is reported, never treated as a pass.

| Area | Core skills | Evidence today | To do |
| --- | --- | --- | --- |
| Intake | `party.profile.build`, `party.type.classify`, `party.profile.completeness` | 9/9 synthetic | Answer key per hero; run over application-derived records |
| Documents | `document.classify.catalog`, `document.fields.contract_extract`, `document.validity.assess`, `document.consistency.assess`, `document.requirements.resolve` | Live 3 heroes | S1, W2, W3; extend documents to every hero; per-party extraction (S7) |
| Identity | `entity.resolve`, `entity.identity.verify`, `registry.company.verify` | Slice-1 eval (2 of 3) | S6 identifier binding; registry acquisition |
| Ownership | `ownership.graph.build`, `ownership.interest.calculate`, `ownership.ubo.resolve`, `ownership.ubo.verify` | Slice-1 eval | Through the host; held-out split |
| Screening | `screening.sanctions.execute`, `screening.pep.execute`, `screening.match.disambiguate`, `screening.sanctions.ownership.evaluate` | Slice-1 eval | Acquisition stage (W4) |
| Risk | `risk.customer.assess`, `risk.tier.assign`, `edd.trigger.evaluate` | 9/9 synthetic | Answer key for tiers once policy supplies weights |
| Decision | `decision.requirements.compile`, `decision.rules.evaluate` | 9/9 synthetic | Recorded outputs; Control producer before `recommendation.generate` joins |

**Joins later, once their inputs have producers:**
- `screening.adverse_media.execute` (source and H09);
- `investigation.findings.synthesize` and `quality.findings.verify` (Finding producer);
- `decision.recommendation.generate` and `quality.policy.compliance` (Control producer);
- `party.expected_behavior.model` (application ExpectedActivity).

Until then, the agents that own them report them as gaps. Their completion criteria accept NEEDS_EVIDENCE with a reason, never COMPLETED.

## 6. Optional document authenticity during hydration

**Placement.** A non-blocking hydration step after documents are normalized:
- `document.authenticity.assess` and `fraud.document.tamper.detect` per document;
- `fraud.deepfake.detect` and `fraud.liveness.verify` when the application carries a selfie or media Session.

It never blocks hydration, and never enters any completion criteria.

**Observations, not decisions.** Detector outputs are observations with limitations. Step-up, clearance and escalation are gate decisions (policy plan section 6, fraud row).

**Optional by configuration, not by code.** The step is on in a flow variant when:
- the flow generator's variant includes it (product and customer type);
- the binding has a connector;
- the effective policy set says it is required or enabled, as installation policy. Until the flag exists, the default is enabled-and-advisory, and no gate consumes the result.

**Contract changes** (the skill-library change process, CR):
- Forensics and tamper requests carry `{artifact_ref, artifact_hash, media_type}` from the DocumentVersion, so a vendor reads the bytes from the case API's content store (hash-checked).
- Liveness maps the vendor `verification` family to `DetectorAssessment`.

**Records.** Each detector result becomes:
- a `FraudSignal` (`kind` = capability, `evidence_ids` → DocumentVersion), with the full assessment, limitations, provider, synthetic flag and INCONCLUSIVE status in an `ehf.authenticity` extension;
- optionally a `VerificationRecord` with `method: document.forensics` and status `UNKNOWN` or `UNVERIFIED`, never `VERIFIED`.

**Agents.**
- Both the document and identity agents read `FraudSignal`. The document agent's `documents[]` gains `authenticity: NOT_CHECKED | INCONCLUSIVE | SIGNAL`.
- Prompts state that INCONCLUSIVE, simulated or absent is not a pass, and a signal is a finding for a person, never a disposition.

**Connectors.**
- The simulators stay the default.
- A vendor (one IDV vendor for documents and liveness) is bound through the existing connector catalog once contracts and credentials exist. The response shape is already fixed.

## 7. Workstreams and waves

Each wave lists its deliverables, tests and exit criteria. Waves 1 to 3 can run in parallel after wave 0.

### Wave 0: correctness (P0 defects in what is built)

**Deliverables:**
- **W1, interim routing:** the disposition checkpoint continues to the person on `REVIEW` with `HUMAN_DECISION_REQUIRED`, and stops on BLOCK or UNKNOWN. The generator gets a per-checkpoint `continueOn`.
  - The fix stays in the flow generator, which R05 later replaces with routing on typed decisions.
  - It makes the human step reachable; it confers no authority. The person's choice still applies no business effect until R04 and R05 exist.
- **W2, completion field:** the completion check reads `proposed_records` from the computation (contracts `skillNodeOutcome`), or the task criterion drops the field. The fix and the test are both in the runtime, not in the harness.
- **S6, identifier binding:** `entity.resolve` binds identifiers from the case subjects (`subjects.0.identifiers[*].value`).
- **C8:** remove the duplicate vendored files.

**Tests:**
- A flow topology test proves the decision node is reachable for each checkpoint outcome.
- A runtime test proves the document review's completion over a host-shaped computation.
- The readiness matrix shows `entity.resolve` COMPLETED on heroes with identifiers.

**Exit:** a scripted run of each plan reaches `decision-human-review`.

### Wave 1: skill access on the platform

**Deliverables:**
- **S1:** close CR-8. Manifests' provider capabilities are mapped to platform IDs at plan compile time, and the plan carries the provider capabilities (`document.fields.extract.v1`, `document.ocr.extract.v1`, detector IDs) as capabilities the skill node may delegate.
- **S2:**
  - The library skill host is the default skill host in compose: lock registered and approved by a setup step, health-checked.
  - There is a deploy entry for it.
  - Its image is pinned in the lock (no stand-in digests).
- **S5:**
  - The host verifies the delegated envelope signature.
  - Executions are persisted (sqlite or Postgres), so a restart does not lose them.
  - The two skipped conformance checks run.

**Tests:**
- Gateway + delegation + host integration tests for a provider-backed skill (`contract_extract` with a recorded model connector).
- Conformance with no skips.
- Compose smoke: a library skill called through the gateway.

**Exit:** every core skill runs through gateway and host in compose.

### Wave 2: case and evidence writes (observations and proposals)

This wave writes only what is **not** a protected business action. Every write that adopts, decides or changes business state is a protected sink, owned by the policy plan (F04-F06, R01, R04-R05). For those, this wave only makes the flows ready to consume a decision and grant.

**Deliverables:**
- **Agent outputs as proposals and observations (W6).** Declarative, per field, with templates checked against the output schema. All are attributed `AGENT_DERIVED` and never adopted:
  - `documentChecks[]` with `CONFLICT` → RaiseContradiction;
  - `findings[]` → Finding proposals (RecordScreeningFinding where the finding is a screening finding);
  - `requests[]` → a document-request proposal.
  - Whether a request or finding becomes human work is a gate outcome: NEEDS_HUMAN or NEEDS_EVIDENCE, with obligations (policy plan 5.5). R01 is asked to classify agent-originated ProposeWorkItem as protected or not; until it does, agent outputs create no work items.
- **Decision support's recommendation** is committed as SubmitDecisionRecommendation, a proposal. The decision gate consumes it as input; it is never the decision (F03, F10).
- **W7, two kinds of stop.** The stop node records the checkpoint's outcome and reason codes as an observation, kept apart from a technical stop:
  - a technical stop (error, timeout, lost lease) is an operational stop and retry (F17);
  - a policy checkpoint's NEEDS_HUMAN or NEEDS_EVIDENCE creates human work through the gate's human requirement (policy plan 5.5), not through a flow-authored RequestHumanReview.
- **W8:** LinkExecution at the result. TransitionCaseStatus waits for R04.
- **W5, the decision: an interface only.** The flow's last steps are reshaped to the policy plan's sequence: gate decision → human requirement (when NEEDS_HUMAN) → authenticated human response → post-review gate → grant-backed effect applied by the owning service. This wave delivers the flow topology and its tests against a stub decision service. R04 and R05 deliver the enforcement.
- **Finding and Control producers.**
  - Investigation and screening findings are proposals, as above.
  - Controls come from a deterministic `decision.requirements.compile` proposal (a CR to `proposal` mode). Control *adoption* is a gate (F10). The owners of the decision chain confirm the mapping, using the slice-1 wave-3 notes.
- **W11:** the compiler requires grants for a node's pinned mode; coordinated with R01's protected-action registry.

**Tests:**
- A case-store integration test per non-protected command: an envelope with these grants succeeds, and one without them is refused.
- Every protected command from an agent or skill node is refused: `SKILL_FORBIDDEN_COMMANDS`, plus R01's registry once it exists (policy plan A01-A06).
- A plan-level test: every agent output field with a write template has a schema-valid path.
- An end-to-end (compose) test: `contract_extract` commits ExtractedAssertion records, then `validity.assess` reads them in the same run.

**Exit:** a run leaves an auditable case of records, proposals, contradictions and recommendations, with no protected mutation. With R04 and R05 present, the same run reaches a grant-backed, recorded decision.

### Wave 3: hydration and the context layer

**Deliverables:**
- **C2, onboarding intake:**
  - an `Application` record type, proposed to the ontology owners with the context-experience §5 design;
  - an application API that creates the case, subjects (with identifiers), BankingRelationship and documents;
  - the right case type per variant.
- **C1:** `normalizeContextRows` sets `subject_ids` (from a binding's subject field) and `purposes` (from the binding's admitted purposes).
- **W3, document intake node:** a `document.evidence.package` acquisition node, then normalization, in the hydration stage.
- **W4, acquisition stage:** reintroduce the `acquire-*` connector nodes (identity, registry, officers, ownership, sanctions, PEP, adverse media) from `kyb-connectors.mjs` into the agentic generator, with an `allSettled` barrier. Bindings to `corpus:` replay locally, simulators in sandbox and vendors when live.
- **Corpus:**
  - the seeder loads `documents.jsonl` and sets the case type per hero;
  - documents and answer keys for every hero, not only H02 to H04;
  - registry and adverse-media replay in the `corpus:` adapter (test-context-corpus §§12-14);
  - H09 (adverse media) built.
- **C3, relationships in packs.** When the relationship catalog lands:
  - agent packs gain a `relationships` section, built with the same rules as the case relationship projection (admitted sections only, typed resolution, unresolved reasons, bounds, completeness false);
  - agents' `reads:` gain relationship paths (for example `ExtractedAssertion.subject → Identity`, `OfficerRole → Entity`, `OwnershipInterest`);
  - a per-subject scope for skills invoked per party.
- **C4:** per-record trust labels from provenance: `BANK_RECORD`, `APPLICANT_SUPPLIED`, `AUTHORITATIVE_SOURCE`, `SKILL_PROPOSAL`, `AGENT_DERIVED`.
- **C5:** `maxAgeSeconds` per record selector from the source's freshness contract.
- **S7:** extraction per party: one `contract_extract` execution per document subject, using the classification's subject.

**Tests:**
- Hydration of each hero from an application through `corpus:` replay matches the corpus records (counts, types, subjects).
- Connector records are admitted by the library (subject and purpose).
- A pack with relationships resolves typed edges and reports unresolved ones.
- Trust labels are asserted per record.

**Exit:** a new onboarding case for any corpus hero hydrates with no hand-seeding.

### Wave 4: optional document authenticity

**Deliverables:** section 6.
- The authenticity step in the hydration stage, off by variant and on by default as advisory.
- A CR for artifact-based forensics and tamper requests, and for liveness mapping.
- The FraudSignal mapping with the `ehf.authenticity` extension.
- Agent reads and prompt lines.
- Planted authenticity cases in the corpus: a tampered document (altered text layer and bytes hash mismatch), and a deepfake Session flagged by a recorded detector.

**Tests:**
- INCONCLUSIVE never counts as a pass in the agents' answer key.
- A planted signal is reported.
- Hydration completes with the step disabled or failing.
- Bytes are read hash-checked through the content store.

**Exit:** the step runs in every variant where it's enabled. With simulators, agents report the checks as not established; with a recorded vendor fixture, they report the planted signal.

### Wave 5: agents, all ten tested

**Deliverables:**
- **Answer keys per agent, per hero** (planted findings, expected tiers or "not determinable without policy", expected requests). Every key is derived from the scenario facts, never from the system under test, as in production slice 1.
- **The live harness becomes the platform harness:** it runs the compiled plan through the composed services, with the real case store, gateway, host and connectors. The in-process harness stays as a fast development loop.
- **Recorded model fixtures.** Each live run's model answers are recorded (request digest → answer). CI replays the plans deterministically against them, so every agent is exercised in CI without a model.
- **Repetition:**
  - five live runs per agent per hero for variance;
  - a held-out split generated from `CORPUS_HELDOUT_SALT`;
  - `agent.qualification.v1` evidence per agent, binding profile, model, tools and plan digests.
- **Adversarial cases:**
  - prompt injection in document text (quarantine, never followed);
  - conflicting sources;
  - a stale screening run;
  - a missing source;
  - an unreachable tool.
- **Per-agent checks:**
  - **Screening:** acquisition through the stage, disambiguation with ScreeningHit, list freshness.
  - **Ownership:** the layered hero H06 (ranges and cycles); the trust hero H12 recorded as a known gap until the trust sub-variant exists.
  - **QA:** the judge model is independent of every agent it reviews; QA's findings become work items, never QA results.

**Tests:** CI replay of both flows for every hero; a nightly live evaluation with Claude (OpenRouter) and a cost budget.

**Exit:** every agent has qualification evidence on development and held-out splits that meets the owner's thresholds.

### Wave 6: pilot readiness and the KYB trust sub-variant

**Deliverables:**
- **S3, qualification:** the 24 core skills are promoted to `integration_verified` with approved `skill.qualification.v1` records, and the gateway's production profile is green for them.
- **S8, vendors:** one vendor per acquisition family is bound in sandbox (registry, sanctions and PEP, IDV and liveness, adverse media), with contract and acceptance tests.
- **Trust and arrangement ownership** (H12):
  - a skill CR for settlor, trustee and beneficiary control;
  - a KYB trust sub-variant.
- **Operations:**
  - a runbook (stuck cases, checkpoint stops, re-hydration, re-extraction);
  - metrics (time to decision, stops by reason, agent cost per case, human overrides of agent findings);
  - the visual story updated.

**Exit:** a pilot cohort of synthetic onboarding cases runs end to end, in a staging deployment, with the policy layer's packs.

## 8. The interface with the policy layer

The policy engine consolidation plan defines the contracts; this plan consumes them. Until R01 and R02 land, today's single-policy pin and the pack checkpoints stand in. They are marked as interim, and none is extended into a second policy authority (F09).

**What this plan consumes:**
- **An effective policy set** (F12, R03). The case's policy identity becomes an immutable effective-policy-set digest with per-gate bundle bindings. Until then: today's `policyAuthority` pin and per-node `skillPolicy`/`skillPolicies` projections. Unresolved fields are reported, never defaulted.
- **The decision contract** (5.2, R01).
  - Flows route on the decision state (`DECIDED`, `NEEDS_EVIDENCE`, `NEEDS_HUMAN`, `NOT_APPLICABLE`, `UNRESOLVED`) and its scoped actions, not on ALLOW/REVIEW strings.
  - A technical error is an operational stop.
  - `ALLOW` to continue a step never authorizes a business action.
- **Gate nodes.** Each checkpoint in the agentic flows becomes a gate node with a declared gate kind and input profile.
  - The three interim pack checkpoints (`intake-ready`, `decision-ready`, `disposition`) map to the policy plan's gates.
  - The `packGate` transform (`pack-gate.ts`) is retired when they exist, or kept only as a test oracle.
- **Grants and sinks** (5.4, R04). Protected effects are applied only by the owning service, from a stored decision or scoped grant. Flows and agents never write them.
- **Human requirements** (5.5, R05). Human work comes from a gate's NEEDS_HUMAN result: allowed choices, authority, quorum, independence and expiry. The response goes to a post-review gate.
- **Flags and content the policy layer owns:**
  - document authenticity required, enabled or disabled;
  - per-party document requirements;
  - risk weights and tier boundaries;
  - EDD triggers;
  - decision rules;
  - permitted providers;
  - automation eligibility;
  - review authorities and quorum.

**What this plan supplies to the policy layer:**
- **Input profiles' facts:** canonical records with subject, purpose and per-record trust and provenance (waves 3 and 4), including authenticity observations and their limitations.
- **Skill observations kept distinct from interpretations:** agents and skills propose; gates adopt (F10). Agent output fields such as `requiresHumanReview` and decision support's `final: false` are advisory model limitations. Nothing routes on them (F03).
- **Journeys for the policy plan's 9.2 tests:** the corpus heroes with documents, answer keys and recorded model answers, for the individual KYC and corporate KYB journeys.

**What this plan does not do:**
- write policy, pack content, Rego, decision tables or the KYC policy package;
- implement protected-sink enforcement;
- default any unresolved policy field.

### 8.1 Coordination with the policy plan

The policy review used `main` at `0ac60d4b`. This plan's branch, `claude/eloquent-feynman-enwa8q` (not yet merged), adds work that overlaps its findings:

| This branch | Overlap | Proposed resolution |
| --- | --- | --- |
| Archive of KYC v2 and KYB: `domains/kyc/v2` → `domains/archive/kyc-v2-deterministic`, `domains/kyb` → `domains/archive/kyb-deterministic`, with their generators and plans moved | R06 and R07 edit those flows and generators in place | Choose one before either branch merges. **Recommended:** R06 and R07 target the agentic flows (`domains/kyc-agentic`, `domains/kyb-agentic`), which replace the archived ones (agentic plan phase 8); the archived flows keep their legacy semantics for replay (R06's "unchanged v1 replay"). Otherwise this branch rebases the archive onto R06 and R07 |
| Policy packs: `domains/policy`, `packages/policy-engine/src/policy-packs.ts`, `artifacts/policy/packs`. Layered composition, effective-pack digest, per-case selection, TypeScript `evaluatePackGate` | R03 (installation packs and composition), F09 (a TypeScript interpreter), F12 (policy sets) | Hand to R03 as an input. The layer model, tighten-only rules, per-case selection and legal basis become candidate installation modules; `composeEffectivePack` and `evaluatePackGate` become test oracles, then retire |
| `pack-gate.ts` checkpoints in the agentic flows | F07 and F09 pattern (a TypeScript decision transform) | Replace with gate nodes (R05); see above |
| Roster defaults: decision support `requiresHumanReview: always`, `final: false`; completion statuses (`NEEDS_REVIEW`) | F03, F11 | Advisory only; routing and human requirements come from gates. Agent task completion is an operational status, never a business outcome |
| The companion inventory JSON | Not on any branch | Add the agentic flows' 57 skills, three checkpoints and ten agents to it when it is pushed |

**Shared files to sequence:**
- `scripts/lib/library-package.mjs` (routing, inserts);
- `packages/runtime-langgraph/src/index.ts` (gate and transform execution);
- `packages/contracts/src/index.ts`;
- `packages/case-store`;
- `apps/fincrime-host` manifests and locks.

The proposed order is: this plan's wave 0 and the policy plan's R01 in parallel; R02 to R05 before this plan's wave 2 decision interface; R06 and R07 on the agentic flows after the archive decision.

## 9. Test strategy

| Layer | What | Where | When |
| --- | --- | --- | --- |
| Unit and contract | Connector transforms, schema subsets, binding, span location, skill-commit planning, completion | package vitest, pytest | every commit |
| Plan topology | Order, reachability per checkpoint outcome, grants per mode, bindings fail closed, reads and relationships | `agentic-flows.test.ts` | every commit |
| Library | Readiness matrix (every flow skill over every hero, no models); conformance with no skips | context-corpus pytest, `library-host-conformance.sh` | every commit |
| Integration | Gateway + delegation + host; case-store commands and grants; hydration from `corpus:` replay | service tests with Postgres | every commit (CI database job) |
| Deterministic flow replay | Each plan over each hero through the composed services with recorded model answers; answer keys scored | compose job | every commit (CI), about 10 minutes |
| Live evaluation | Claude (OpenRouter or direct) on development and held-out splits, five repetitions, qualification evidence | nightly, budget-capped | nightly, and before a release |
| Adversarial | Injection, staleness, missing sources, conflicting sources, authenticity plants | in replay and live | every commit (replay), nightly (live) |

Policy-gate behaviour is tested by the policy plan's suites (C, P, J, I, A, D, H, R, S, E, U, O, M). This plan's suites feed its journeys (9.2) and assert the boundary:
- no agent or skill node writes a protected command;
- flows route on decision states.

**Definition of done for the pilot:**
- both variants reach a recorded human decision for every corpus hero through the composed platform;
- every agent and core skill has qualification evidence meeting its thresholds;
- every business effect is grant-backed (policy plan R04);
- no unresolved policy field is defaulted;
- every stop and finding leaves a work item for a person.

## 10. Risks

- **The ontology and relationship work lands on its own schedule.** Mitigation: C3 is built against the case relationship projection's contract and switched on when the catalog is vendored.
- **CR-8 and the skill-library change requests** (artifact-based forensics, Control proposals, trust ownership) need the library owners. Mitigation: raise the CRs in wave 0 and keep the platform side ready behind them.
- **Model variance.** Live answers differ run to run (see the first live runs). Mitigation: recorded replay for CI, repetition and held-out evaluation for qualification, and deterministic connector-side validation (span location, binding) rather than relying on the model.
- **Policy-layer churn changes checkpoint outcomes.** Mitigation: the interface in section 8 is the contract; topology tests assert routing per outcome, not per rule.
- **Vendor access** (credentials, contracts) can slip. Mitigation: `corpus:` replay and recorded vendor fixtures keep every wave testable without vendors.
