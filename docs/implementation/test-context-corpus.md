# Test context corpus: research, design and plan

Status: **approved for implementation (Phase 0 closed 2026-11-08)**. Decisions are in §11. Nothing
else in this note is built yet. It covers what test context the agents and skills need, what
exists today, which public sources to collect from, how to generate the rest, and how to load
it into the platform.

## 1. Goal

Agents, skills and workflows need a small number of **strong, diverse parties**, each with a
complete and internally consistent context: identity and registry data, ownership, documents,
a customer 360 profile, accounts, transactions, counterparties, screening results, a
monitoring history, and an **answer key**. With that, we can run any skill or workflow against
a realistic case and check the result. Every planted signal should be detectable, every clean
case should stay clean, and every expected outcome should be written down.

"Done" means:

- every library skill that reads records has at least one party where its signal is present
  (positive) and one where it is absent or must be resolved as a false alarm (negative);
- the KYC v2 and KYB workflows run end to end on several parties without falling back to
  `CONTEXT_MISSING` because a record type has no producer;
- the 25 transaction skills, and the AML, network, alert, investigation and SAR chain, have
  realistic data for the first time;
- the corpus is deterministic, content-addressed, license-clean, and fits the existing
  `skill.qualification.v1` evidence (`datasetDigest`, `sampleCount`, metrics).

## 2. Research: what exists today

### 2.1 What skills consume

Skills take almost no parameters. Their real input is `required_context`: canonical records
(`records.<ObjectType>`, library context schema 2.0.0, closed schemas vendored in
`packages/library-contracts/src/vendor/ontology.schema.json`), plus a policy snapshot. A
missing or stale required record blocks the skill (`CONTEXT_MISSING` / `CONTEXT_STALE`). So
**the corpus is a set of canonical records**, plus the case bootstrap (subjects,
`BankingRelationship`) and the source artifacts those records cite.

Record types most often required (from `config/skill-library/catalog.json`, 229 skills):

| Required records | Skills |
| --- | ---: |
| Transaction + DatasetScope | 25 |
| Finding | 14 |
| Entity, Relationship, DocumentPage | 10 each |
| Alert, Evidence | 8 each |
| OwnershipInterest, Control | 7 each |
| Party, RegistryRecord | 6 each |
| Session, Device, AuthenticationEvent, Payment, FraudSignal | fraud family |
| ExpectedActivity, Product, GeographyExposure, Counterparty, SourceOfFunds/Wealth | party360 / EDD |
| TradeRecord, Invoice, Shipment | `aml.trade_based.detect` |

52 skills need no records at all.

The library already groups record types into context products (`PRODUCT_OBJECTS`,
`apps/fincrime-host/src/financial_crime/tasks.py`): party360, transaction.intelligence,
identity, ownership, document, registry, screening, network, risk, case, policy and evidence.
The corpus is organised by the same products.

### 2.2 What test data exists

| Asset | Shape | Limitation |
| --- | --- | --- |
| `apps/fincrime-host/examples/records.json` (from `synthetic.py`) | 69 records, about 60 types, one each | 3 transactions (60/60/110 in currency `SYN`), 2 accounts, "Acme" / `SYN-0001` |
| KYB-1042 UI fixtures (`apps/fincrime-host/docs/ui/contracts/fixtures/*`, `packages/fincrime-views/src/fixtures/documents.kyb-1042.json`) | 50 records + view models for 5 states | The files disagree: `records` says Harbor Holdings BV owns 60%, `scenario` says Northwind Holdings Ltd owns 45%, and the documents belong to "Example Trading" / `subject-meridian` |
| KYC golden corpus (`domains/kyc/policy/fixtures/corpus`) | 346 adjudicated `kyc.case-aggregate.v1` cases, `harness.factory/corpus-v1` manifest + JSONL | Tests the OPA gates, not skills; every subject is "Corpus Subject", US, individual |
| Provider fixtures (`domains/kyc/policy/fixtures/providers`) | 22 screening fixtures with `expected` blocks | Screening only |
| Document examples (`apps/fincrime-host/examples/documents`) | 6 decoded documents with expected outcomes | Text only, currency `XTS`, unrelated parties |
| evidence-pipeline examples | 22 short synthetic text files; real Berkshire Hathaway and Disney 2024 annual reports (PDF) with 8 source-checked gold facts | The only real public material in the repository |
| Simulators (`packages/adapters` `invokeSimulator`, kyc-wiring simulation mode) | Regex on the subject name (`/sanction/` → match) | No per-party data; transaction monitoring stubs are empty |

There are three separate synthetic universes (KYB-1042, evidence-pipeline, fincrime-host)
that share no parties. There is no PaySim, AMLSim, IBM AML, ICIJ or ISO 20022 data anywhere.

### 2.3 What cannot run today

- **No producer** (connector normalizer) exists for Transaction, DatasetScope, Account,
  Counterparty, Relationship, ExpectedActivity, Product, GeographyExposure, RiskFactor,
  Control, SourceOfFunds/Wealth, Alert, TradeRecord/Invoice/Shipment or the fraud types.
  `packages/adapters/src/canonical-records.ts` emits only registry, ownership, screening,
  verification and document records. The connector catalog defines `financial.transactions.v1`,
  `transaction.monitor.v1` and `crypto.transaction.monitor.v1`, but none is wired to a
  normalizer.
- Neither the KYC nor the KYB workflow invokes any transaction, AML, network, alert,
  investigation, fraud, regulatory or monitoring-deviation skill.
- Inside KYC and KYB, `risk.customer.assess` (RiskFactor), `decision.recommendation.generate`
  (Control), `ownership.ubo.verify` (BeneficialOwner) and `evidence.sufficiency.assess`
  (verified Evidence) are blocked for lack of producers.
- `skill.qualification.v1` records a dataset digest but no dataset exists. Every manifest
  names an `evaluation_profile: <id>-synthetic-v1` that has no data behind it.

### 2.4 Public sources

| Source | Use in the corpus | License (confirm before committing) | Commit? |
| --- | --- | --- | --- |
| **GLEIF** Golden Copy, Level 1 + Level 2 | Real legal entities, LEIs, parent chains; templates for synthetic ownership trees | CC0 (GLEIF's own terms to confirm) | Yes |
| **UK Companies House** API + bulk PSC snapshot; **Open Ownership BODS** (BODS 0.4) | Real registry records, officers, PSCs, filings; structural templates | Open Government Licence / open | Yes, for the public anchors |
| **SEC EDGAR** (10-K, DEF 14A, 13D/G, Forms 3/4/5, Exhibit 21, 8-K) | Real documents for extraction and ownership (dual-class voting vs economic interest) | US government public data; fair-access rules (declared user agent, rate limit) | Yes, small excerpts and selected filings |
| **OFAC SDN**, **UN**, **UK** and **EU** consolidated lists | True-positive screening targets and near-miss name pairs | Public domain / open publications | Yes, a pinned subset |
| **OpenSanctions** | Cross-list linking, PEP structures | CC BY-NC 4.0; commercial use needs a license | **No.** Stay on the live adapter or the official lists |
| **IBM AMLworld** (Kaggle) | Calibration of transaction marginals and laundering patterns; optional benchmark | CDLA-Sharing-1.0 (to confirm) | No. Fetch locally for benchmarks; keep only statistics |
| **AMLSim** (IBM) | Reference for simulator design and typology graph shapes | Apache 2.0 | Ideas yes; we write our own generator |
| **SAML-D** (28 typologies) | Typology catalog and parameter ranges | CC BY-NC (paper) | No. Cite definitions only |
| **PaySim** | Mobile-money fraud patterns | GPL-3.0 code | No |
| **FATF / FinCEN / Egmont typology reports** | Scenario design | Public reports | Cited, not copied |

The evidence pipeline already has live clients for GLEIF, Companies House and OpenSanctions,
and an OFAC SDN CSV parser (`apps/evidence-pipeline/src/kyc_pipeline/{registry,screening}.py`).
The collectors reuse them.

**Network.** The cloud environment's egress policy blocked GLEIF, SEC, Companies House,
OpenSanctions, the sanctions list hosts and Kaggle at the time of research; only GitHub raw
content was reachable. Decision 5 collects in this environment, so those hosts must be
allowed before Phase 3 (see §11).

## 3. Design principles

1. **Records first, contract-valid.** Every generated record uses the library `Record`
   envelope with `schema_version: "2.0.0"` and passes `validateRecordData`. Source fields with
   no canonical home go under `data.extensions["ehf.connector"]`.
2. **Facts once, rendered many times.** Each party has one **scenario spec**; records,
   documents, provider payloads, UI fixtures and the answer key are all derived from it.
   Deliberate contradictions are planted in the spec and recorded in the answer key.
3. **Ground truth by construction.** Every planted signal has an ID, the record IDs it
   touches, a time window, the skills expected to detect it, and the expected outcome. Every
   clean party has the expected non-findings.
4. **Real where real is safe, fictional where risk is asserted.** Real public entities are
   used only with their own public facts, faithfully and with citations. **No fabricated
   derogatory signal is ever attached to a real person or company.** Real sanctioned
   designations appear only as list data, exactly as published. Fictional names are checked
   against the official lists before release.
5. **Deterministic and pinned.** Every generator is seeded; regenerating produces identical
   bytes; CI checks drift with `--check`. Model-authored text is generated once, reviewed and
   committed. Nothing calls a model at test time.
6. **Bitemporal.** One corpus clock (as-of `2026-09-30`, 24 months of history).
   `observed_at`, `valid_from`/`valid_to` and `supersedes` are populated.
7. **Realistic imbalance.** Hero parties sit inside a background crowd; detectors must find
   signals at realistic base rates.
8. **Dev split vs held-out split.** Developer fixtures are committed. The held-out split,
   generated from different seeds and parameter draws, lives in a blob store with only its
   digest committed (finding F6 of the skill-catalog production plan).
9. **Safe documents.** Identity documents are marked SPECIMEN, use fictional issuers and
   data, and are not usable as forgery templates. MRZ check digits are valid.

## 4. The party portfolio

### 4.1 Hero parties (fictional)

| ID | Party | Type / jurisdiction | Products | What it exercises | Expected outcome |
| --- | --- | --- | --- | --- | --- |
| H01 | Ingrid Halvorsen | Individual, US | Deposit, card | Clean control: payroll, rent and card spend matching declared activity; full ID set | Approve, no alerts. Tests false-positive rate |
| H02 | Mateo Ríos Calderón | Individual, ES/MX dual national | Deposit, payments | Sanctions name near-miss with transliteration and alias; DOB and identifier conflict | Review, then clear (identifier conflict) |
| H03 | Adaeze Okonkwo-Bell | Individual, UK | Private banking, custody | Close family member of a fictional PEP; source-of-wealth claims with one inconsistent document | EDD required; one contradiction raised |
| H04 | Thistlewood Fabrication Ltd | Private company, UK | Deposit, payments, lending, merchant acquiring | Clean SME KYB: two-level ownership, PSCs, directors, about 40 B2B counterparties, seasonal flows | Approve. KYB baseline |
| H05 | Corvane Trading FZE | Free-zone company, UAE | Trade finance, payments | Trade-based laundering: invoice over/under pricing, shipment quantity mismatch, transshipment routing, high-risk geographies | Alert, then investigation; SAR candidate |
| H06 | Bellmont Atlantic Holdings Inc. | Corporate group: BVI → Cyprus → Luxembourg → US operating company | Payments, correspondent, custody | Layered ownership; circular holding; ranged interests; nominee directors; two blocked owners aggregating ≥50% (OFAC 50% rule); voting vs economic interest | Sanctions ownership block; UBO unresolved where ranges exist |
| H07 | QuickParcel Couriers LLC | LLC, US (cash-intensive) | Deposit, payments | Structuring across branches; funnel account fed by 8 mule accounts; rapid outbound wires; CTR obligations | Alerts → investigation → SAR draft; CTR prepared |
| H08 | Aurelia Digital Assets OÜ | VASP, EE | Digital assets, custody, payments | Pass-through and layering via other VASPs; mixer exposure; travel-rule gaps | High risk; EDD; alert on pass-through |
| H09 | St. Brendan's Community Relief Foundation | Charity, IE | Deposit, payments | Legitimate NPO with disbursements to conflict-adjacent regions; charity label grants no exemption | EDD, **no** SAR. Hard negative for over-alerting |
| H10 | Devon Achterberg | Individual, NL | Deposit, card, payments | Account takeover: credential reset, new device, impossible travel, new payee, payment to a mule | Fraud signals; payment held |
| H11 | Banco Meridional del Atlántico | Respondent bank, PA | Correspondent | Nested correspondent relationships; respondent's customers visible in payment chains | Correspondent controls; EDD |
| H12 | Marchetti Family Trust | Discretionary trust, JE with a UK settlor | Private banking, custody | Settlor, trustees, protector, beneficiaries; a beneficiary added mid-history (`ownership_change`); trust deed | Periodic review triggers reassessment |

Coverage: legal forms (individual, private company, LLC, free-zone company, corporate group,
VASP, charity, bank, trust); all 11 banking product families; lifecycle events (onboarding,
additional product, periodic review, ownership change, risk change, exit); hard negatives H01,
H04 and H09.

### 4.2 Public anchors (real, facts only)

| ID | Entity | Sources | What it exercises |
| --- | --- | --- | --- |
| A1 | Berkshire Hathaway Inc. | 2024 annual report (in repo), EDGAR 10-K / 13F / 13G, GLEIF Level 2 | Extraction on a real 150-page report; very large subsidiary tree; holdings as owner |
| A2 | The Walt Disney Company | 2024 annual report (in repo), EDGAR, GLEIF | Second real extraction case; named officers |
| A3 | **Tesco PLC** (selected; verify Companies House number and PSC position at collection) | Companies House profile, officers, PSC statements, filing history; GLEIF | Real UK registry, PSC and filing records through the real normalizers. A widely held PLC exercises the "no registrable PSC" path |
| A4 | **Alphabet Inc.** (selected; Class A/B/C) | DEF 14A ownership table, Exhibit 21, Forms 4 | Voting interest ≠ economic interest (`ControlRight` vs `OwnershipInterest`) |
| A5 | Pinned set of real designations from OFAC SDN, UN, UK and EU | Official list files | True-positive screening targets; near-miss pairs for H02 and H06 |

Anchors have **no synthetic transactions and no risk narrative.**

### 4.3 Background crowd

About 1,500 ordinary parties with accounts and about 250,000 transactions over 24 months,
forming the counterparty universe. Base rate about 0.1–0.5% of transactions in a planted
pattern, calibrated to published AMLworld/SAML-D marginals (statistics only). The crowd is
**not committed**; it is regenerated from its seed and its digest recorded in the manifest.

## 5. Per-party context: the dossier

| Layer | Contents | Record types | Exercises |
| --- | --- | --- | --- |
| L0 Case bootstrap | Case subjects, `BankingRelationship`, policy authority | (case request), BankingRelationship, ControlAssessment | Every workflow |
| L1 Identity and registry | Names, aliases, addresses, identifiers, registry records, officers, licences | Entity, Identity, IdentityIdentifier, Alias, Address, RegistryRecord, OfficerRole, Registration, License, VerificationRecord | entity.*, registry.*, KYC identity |
| L2 Ownership and control | Equity edges (exact and ranged), voting and control rights, BO declarations | OwnershipInterest, OwnershipRange, ControlRight, BeneficialOwner, OwnershipGraph | ownership.*, screening.sanctions.ownership.evaluate |
| L3 Documents | Rendered PDFs, pages, evidence spans | DocumentVersion, DocumentPage, Evidence, ExtractedAssertion (answer key only) | document.* (19) |
| L4 Party 360 | Profile, accounts, products, declared vs observed activity, geography, counterparties, SoF/SoW | Party, PartyProfile, CustomerRelationship, Account, Product, ExpectedActivity, GeographyExposure, Counterparty, SourceOfFunds, SourceOfWealth | party.*, risk.*, edd.* |
| L5 Transactions | Ledger with scope; payment rails; trade documents | Transaction, DatasetScope, Payment, PaymentRail, TradeRecord, Invoice, Shipment | transaction.* (12), aml.* (12), regulatory.ctr.*, monitor.transaction.deviation |
| L6 Network | Relationships between parties and accounts; PEP relationships | Relationship, NetworkGraph, PEPRelationship | network.* (10), investigation.relationship.analyze, ownership.nominee.detect |
| L7 Screening | List entries, hits, executions, negative searches, adverse media | WatchlistEntry, ScreeningHit, ScreeningExecution, NegativeSearchEvidence, AdverseMediaEvent | screening.* (14) |
| L8 Digital and fraud | Sessions, devices, authentication events, fraud signals | Session, Device, AuthenticationEvent, FraudSignal | fraud.* (12) |
| L9 History | Prior alerts and cases, timeline, monitoring plan | Alert, Case, TimelineEvent, MonitoringPlan, Finding | alert.*, investigation.*, monitor.*, regulatory.sar.* |
| L10 Answer key | Planted signals, expected skill and workflow outcomes | EvaluationCase, ExpectedOutcome | qualification, regression |

Each layer exists as **source form** (provider-native payloads: Companies House JSON, GLEIF
records, screening vendor responses, ISO 20022 `camt.053` / `pacs.008`, PDFs) and **normalized
form** (canonical records). Rough size per hero: 300–3,000 records, 8–25 documents, 1,000–20,000
transactions (H07 and H05 largest). H06 is deliberately larger than the 60,000-character
context budget so section selection and budget failure are exercised.

## 6. Generation architecture

```
scenario spec (YAML, one per party)          public sources (pinned, licensed)
        │                                              │
        ▼                                              ▼
  world model ──── generators ───────────────── collectors + templates
  (clock, ids,     identity · registry · ownership · accounts · behaviour
   geography,      typology injectors · trade · fraud · screening · documents · media
   institutions)                │
                                ▼
                   validators (schema · consistency · detectability · names · licence · PII)
                                │
          ┌──────────────┬──────┴───────┬───────────────┬────────────────┐
          ▼              ▼              ▼               ▼                ▼
   canonical records  provider       documents       answer key       UI / library
   (JSONL)            payloads       (PDF + text)    (expectations)   exports
          └──────────────┴──────┬───────┴───────────────┴────────────────┘
                                ▼
                     manifest (digests, seeds, licences, sources)
                                │
              loaders: direct seed · connector replay · library-native · ui-mock
```

### 6.1 Layout

```
tools/context-corpus/                 Python generator (locked dependencies)
  src/context_corpus/
    sources/      gleif.py, edgar.py, companies_house.py, bods.py, sanctions_lists.py
    world/        clock, ids, names, geography, institutions, calendars
    gen/          identity, registry, ownership, accounts, behaviour, trade, fraud,
                  screening, media, documents/ (templates, render, degrade)
    typologies/   structuring, smurfing, funnel, mule, layering, round_trip,
                  pass_through, trade_based, shell, ato, nested_correspondent
    emit/         records, provider_payloads, iso20022, library_native, ui_mock
    validate/     schema, consistency, detectability, names, licensing, pii
  scenarios/      H01-halvorsen.yaml … H12-marchetti-trust.yaml, A1…A5, crowd.yaml
fixtures/context-corpus/              generated, committed (dev split)
  manifest.json                       harness.factory/context-corpus-v1
  SOURCES.json                        every public input: URL, retrieved_at, sha256, licence
  parties/<id>/
    case.json  records.jsonl  provider/  documents/ (*.pdf, pages.json)  expectations.yaml
packages/context-corpus/              TypeScript: manifest types, record validation
                                      (via @ehf/library-contracts), loaders
```

Python generator (library and schemas are Python-first; `pydantic`, `networkx` already
locked), validating against the same vendored `ontology.schema.json` as the TypeScript side.
Two new development dependencies: `Faker` (MIT) and `jsonschema`. Loaders are TypeScript.

### 6.2 Scenario spec

Declarative: facts and planted signals, never records.

```yaml
id: H07
seed: 7007
party:
  kind: company
  legal_form: llc
  name: QuickParcel Couriers LLC
  formation: { jurisdiction: US-NJ, date: 2019-03-14 }
  industry: courier_services
officers:
  - { ref: p.owner, name: generated, role: managing_member }
ownership:
  - { owner: p.owner, owned: self, interest: "1" }
products: [deposit, payments]
expected_activity:
  monthly_inflow: { USD: "45000" }
  counterparty_countries: [US]
  rails: [ach, cash, wire]
behaviour: courier_smb_baseline
typologies:
  - id: SIG-H07-STRUCT
    type: structuring
    window: [2026-03-01, 2026-05-31]
    params: { threshold: "10000", band: ["8200", "9900"], branches: 4, per_week: 3 }
    expect: { detected_by: [aml.structuring.detect, regulatory.ctr.evaluate], outcome: INDICATOR }
  - id: SIG-H07-FUNNEL
    type: funnel
    params: { feeders: 8, feeder_profile: mule_student, out: { rail: wire, country: MX } }
    expect: { detected_by: [aml.funnel.detect, aml.mule.detect, network.beneficiary.trace] }
documents: [articles_of_organization, ein_letter, operating_agreement, bank_statement x6, owner_passport]
timeline:
  - { at: 2026-06-15, event: alert, rule: STRUCT-01 }
  - { at: 2026-07-02, event: risk_change, tier: HIGH }
expected:
  workflow: { kyb: APPROVE_AT_ONBOARDING, monitoring: SAR_CANDIDATE }
  non_findings: [screening.sanctions.execute, screening.pep.execute]
```

### 6.3 Transaction engine

- **Baseline behaviour models** per segment (salaried individual, student, retiree, SME by
  industry, cash-intensive business, NPO, VASP, respondent bank): recurring flows,
  discretionary flows, seasonality and noise; balances respected.
- **Typology injectors** take a parameter block and window, write extra transactions,
  accounts and relationships, and record touched IDs. Graph shapes follow AMLSim/SAML-D:
  fan-in, fan-out, cycle, scatter-gather, bipartite, stacked bipartite.
- **Realism:** business-day calendars, cut-off times, dated FX, reversals, duplicates,
  mixed currencies and time zones.
- **DatasetScope** per party and window, including deliberately incomplete scopes
  (`complete: false`, watermark gaps).
- **Source form:** ISO 20022 `camt.053` and `pacs.008`.

### 6.4 Documents

- HTML templates per document type from `apps/fincrime-host/src/kyc_documents/resources/catalog.json`
  (293 types), rendered to PDF with Chromium; `pages.json` records exact page text.
- Variants: born-digital, scanned (rasterised, skewed, noisy), multilingual (Spanish for H02,
  Arabic and English for H05, German for H06's Luxembourg entity).
- Narrative documents authored once by a model from scenario facts, human-reviewed, committed,
  and round-trip checked against the spec.
- Planted defects: date inconsistency (H03), registered-address mismatch (H06), expired ID,
  missing page, font-substitution anomaly, and prompt-injection lines in an adverse-media
  article and a bank-statement memo.
- Real anchor documents: existing Berkshire and Disney PDFs, plus pinned EDGAR and Companies
  House filings, cited in `SOURCES.json`.

### 6.5 Screening and media

- **List data:** pinned subset of real OFAC, UN, UK, EU designations (A5), plus fictional list
  entries for fictional PEPs, who are never real office holders.
- **Provider-shaped responses** per hero, in shapes the kyc-wiring and OpenSanctions
  normalizers accept, including partial, truncated and stale executions.
- **Adverse media:** in-window, out-of-window, irrelevant category, ambiguous subject,
  retraction follow-up, extending existing fixture IDs (AM-IN-WINDOW, AM-AMBIGUOUS-SUBJECT).

### 6.6 Adversarial and failure pack

Homoglyph and transliteration variants; conflicting documents; stale list version; truncated
screen; incomplete DatasetScope; duplicate transactions; missing field (`CONTEXT_MISSING`);
record older than `maxAgeSeconds` (`CONTEXT_STALE`); superseded ownership version; injection
text in untrusted sections. Tagged in the answer key with the KYC golden corpus cohort names
(`FC-CONTRADICTION`, `FC-EVIDENCE-EXPIRED`, …).

## 7. Validating the corpus itself

| Check | How |
| --- | --- |
| Schema | Every record passes `validateRecordData` and the vendored JSON Schema; every provider payload passes its schema in `packages/library-contracts/src/vendor/providers` |
| Consistency | Documents, provider payloads and records agree with the spec except planted contradictions; extract fields back from `pages.json` and compare |
| Detectability | An independent reference implementation of each planted signal finds it at `policy.synthetic-neutral.json` thresholds and finds nothing on hard negatives |
| Base rates | Crowd statistics stay inside configured bands |
| Names | Fictional names and identifiers checked against pinned official lists; no accidental match to a designated or well-known person (except intended near misses) |
| PII | No real natural person's data, except public office holders and executives as in the anchors' own filings |
| Licence | Every file under `fixtures/context-corpus` traces to a generated source or a `SOURCES.json` entry with a licence that allows committing it |
| Determinism | Regenerating from the same seeds reproduces manifest digests; CI runs `--check` |
| Answer-key review | A financial-crime SME signs off each hero's `expectations.yaml`; reviewer recorded in the manifest |

## 8. Loading: four paths

1. **Direct seed** (unit and integration tests, compose stack). Open the case
   (`POST /v1/cases`), add subjects, write `BankingRelationship` and `RecordCanonicalRecords`
   in batches of at most 200, register documents as evidence (`POST /v1/evidence:register`).
   Command: `pnpm corpus:seed --party H07 [--as-of …]`. Case API refuses agent and
   integration actors without an envelope, so the loader acts as the **initial deployer**
   principal in development (decision 6); confirm in Phase 1 that this principal may write
   `RecordCanonicalRecords` outside a run.
2. **Connector replay** (end-to-end provenance). A `corpus:` adapter binding in the
   capability gateway, alongside `simulator:` and `opensanctions:`, serves each party's
   provider payloads keyed by capability and subject. Real normalizers produce the records
   with gateway receipts, evidence lineage and `synthetic: true`. New normalizers are needed
   for `financial.transactions.v1` and `transaction.monitor.v1` (Phase 2).
3. **Library-native.** `records.json` and `invocations.json` per party in the library's format,
   so Python skills and `fc-skills` tests run on hero data with no platform.
4. **UI mock.** Export hero scenarios into `packages/ui-mock` fixtures so the web UI demos
   real parties (decision 7: rebuild on H06 **and** fix KYB-1042 in place).

## 9. How tests use it

- **Skill coverage matrix** (skill × party → positive / negative / not applicable), generated
  from answer keys and published as a CI artifact.
- **Workflow runs.** KYC v2: H01, H02, H03, H10. KYB: H04, H06, H09, H11, H12 and A1–A4.
  A new monitoring and investigation workflow (alert → investigation → SAR / CTR) on H05, H07
  and H08.
- **Context-plane tests:** budget (H06), quarantine (injected pages and articles), staleness
  and as-of (H12 ownership change, H03 PEP status change), record gaps (adversarial pack).
- **Qualification:** the twelve phase-2 exemplar skills get dev and held-out EvaluationCases;
  `skill.qualification.v1.evidence` references the held-out dataset digest, sample count and
  metrics.
- **Regression:** runs recorded and compared per party; a changed hero outcome is a
  reviewable diff.

## 10. Plan

| Phase | Scope | Deliverables | Acceptance |
| --- | --- | --- | --- |
| **0. Decisions** | Settle §11 | Approved hero list, licence policy, held-out storage, egress hosts | Sign-off below (done) |
| **1. Skeleton + 2 heroes** | Spec format, world model, records emitter, schema validator, manifest, direct-seed loader; H01 and H04, without transactions | `tools/context-corpus`, `fixtures/context-corpus/parties/{H01,H04}`, `packages/context-corpus` seed loader | KYC v2 runs on H01 and KYB on H04 against seeded cases with no `CONTEXT_MISSING` on producible types; `--check` deterministic |
| **2. Transactions (done 2026-11-08)** | Behaviour models, typology injectors, DatasetScope, ISO 20022, crowd; H07 and H05; answer keys; `financial.transactions.v1` normalizer | Transaction engine, crowd generator, two heroes | All 25 Transaction + DatasetScope skills run on H07, H05, H01; planted signals found by reference detectors; H01 and H04 raise nothing |
| **3. Ownership and screening (done 2026-11-09, see §13)** | Collectors for GLEIF, BODS/PSC templates, official lists; H06, H02, H03, H12; provider payloads; `corpus:` replay binding | Collectors with `SOURCES.json`, four heroes, replay adapter | ownership.* and screening.* produce expected outcomes, including OFAC 50% aggregation (H06) and identifier-conflict clearing (H02); replayed records carry gateway receipts |
| **4. Documents and anchors** | Template renderer, scan degradation, multilingual output, reviewed narratives; A1–A4 real filings | PDFs + `pages.json` per hero; anchor dossiers | Document chain measured against `pages.json`; planted defects found |
| **5. Remaining heroes + adversarial pack** | H08–H11; fraud and digital records; perturbation pack | Complete hero set | Every record-reading skill has positive and negative parties; quarantine tests pass |
| **6. Held-out split + integration** | Held-out generation, CI drift checks, coverage report, ui-mock export, **monitoring/investigation workflow package with test-context data** | Held-out digest in manifest, CI job, UI demo on heroes | One exemplar skill carries a `skill.qualification.v1` record backed by the held-out digest |

Phases 2 and 3 are independent after Phase 1. Phase 4 can start its renderer in parallel with
Phase 2.

## 11. Decisions (signed off 2026-11-08)

1. **Hero list.** Twelve heroes and five anchors accepted as written. A3 = Tesco PLC, A4 =
   Alphabet Inc. (chosen by the assistant on the owner's delegation; confirm entity details
   at collection time and swap if a source is unsuitable).
2. **Real-entity policy.** Principle 4 confirmed.
3. **Licences.** GLEIF, Companies House/BODS, EDGAR and official lists may be committed.
   OpenSanctions, IBM AMLworld and SAML-D stay out of the repository (statistics and
   templates, or local benchmark use only).
4. **Held-out storage.** Blob store; only the digest is committed. Read access: to be named
   when the store is provisioned (open sub-item, owner TBD).
5. **Collection egress.** Collect in this cloud environment. Required: allow the source hosts
   (GLEIF, SEC, Companies House, official sanctions lists); SEC EDGAR needs a declared project
   contact in the user agent (open sub-item, contact TBD).
6. **Loader authority.** The initial deployer principal seeds cases in development.
7. **KYB-1042.** Both: rebuild the UI demo on a hero (H06) and fix KYB-1042 in place.
8. **Monitoring workflow.** In scope for Phase 6, implemented with test-context data
   (not only skill-level tests).

## 12. Phase 2 status and findings (2026-11-08)

Built: ledger engine, typology injectors (structuring, funnel with same-day pass-through, layering round trip,
trade-based, high-cash days), reference detectors and the `policy.corpus-v1` thresholds, `DatasetScope`, ISO 20022
`camt.053` source form, a 1,500-party / about 238,000-transaction crowd (digest and statistics only), heroes H05 and
H07, ledgers for H01 and H04, and the `financial.transactions.v1` normalizer
(`packages/adapters/src/transaction-records.ts`).

Acceptance, as verified: all 25 Transaction + DatasetScope skills complete on H01, H04, H05 and H07 using the
library's own executor (`pytest -m slow`); the library's structuring, funnel and pass-through detectors agree with the
reference detectors; H01 and H04 raise nothing; the crowd's planted rate is 0.24% with full recall of planted clusters.

Findings that change how the corpus is used:

1. **Context budget is a profile property.** The default `AgentProfile.max_objects` is 1,000, so a skill cannot read
   H07 (1,380 transactions) or H04 (2,300) under it; runs use the contract maximum of 10,000. A ledger above that needs
   windowed contexts, which the one-`DatasetScope`-per-context rule makes a record-set choice, not a filter.
2. **Authorisation covers counterparties.** A record is readable only if every subject on it is in the principal's
   subject set, so the analyst principal must be authorised for each counterparty entity a transaction names.
3. **The library's structuring and funnel rules are crude.** They group by source (resp. target) account and do not
   look at amounts near the threshold, so thresholds had to be tuned (structuring at least 5 sub-threshold payments
   from one account in 24 hours totalling the threshold; funnel at least 8 distinct sources in 24 hours) and baseline
   flows capped per day. A production policy would need richer rules; this corpus only proves the planted signals are
   separable under the stated policy.
4. **No ids leak the answer key.** Counterparty refs for planted networks are opaque (`ext-<hash>`), and a test checks
   record ids, subjects and data for signal ids.

Follow-up completed the same day:

- `transaction.monitor.v1` normalizer (`packages/adapters/src/monitoring-records.ts`): monitoring alerts to `Alert`
  records; a run with no alerts is a gap, never a clear result. Alerts are raised by the reference detectors
  (`monitoring.py`), clustered per burst, and emitted both as `Alert` history records and as the provider payload
  `provider/transaction.monitor.v1/alerts.json`.
- `corpus:` replay binding (`apps/capability-gateway/src/adapters/corpus.ts`): serves `financial.transactions.v1`
  and `transaction.monitor.v1` through the real normalizers. Synthetic, never enabled by default
  (`GATEWAY_ADAPTERS=default,corpus`, `CORPUS_ROOT=fixtures/context-corpus`); an account-restricted replay never
  claims a complete scope; source files are checked against the manifest digest.
- Loader against a live case API (`apps/case-api/src/corpus-seed.database.test.ts`, opt in with
  `EHF_RUN_CORPUS_DB_TESTS=1`, uses local Postgres binaries): seeds H04 and H07 through the real API, idempotently.
  Findings: a human principal reaches the API as an `Edge.Delegate` service token plus `x-actor-id` and
  `x-actor-roles` (the loader now sends them); and a rerun must replay commands with the original preconditions
  (start from sequence 1), otherwise the request digest differs and the API returns `command.idempotency_conflict`.

Fraud layer and ownership replay (2026-11-09):

- **H10 (Devon Achterberg)** and a fraud negative layer on **H01**. L8 records: `Device`, `Session`, `AuthenticationEvent`,
  `Payment`, `FraudSignal` and their `Evidence`. Baseline sessions (three a month on H10, two on H01) sit inside the
  customer's own bounds; the planted account takeover is one session on a new device (credential reset, impossible
  travel, four failed attempts), a probe payment that settles, a EUR 4,800 payment that is held (`pending`), and a mule
  payee whose phone number is shared with two people who never transact.
- Fraud signals are scored by a transparent rule model (`corpus-fraud-rules-v1`, in `digital.py`), so the answer key can
  say why each score is what it is. Independent reference detectors (`detectors.py`) must find exactly the planted
  session, payment, signals and phone group, and nothing on any other party.
- Library check (`pytest -m slow`): the six deterministic fraud skills complete on H10 and H01 and match the answer key.
  `fraud.account_takeover.detect` is provider-mode, so it runs against a **recorded** response built from the reference
  scores in the test; that is the recording speaking, not a detector. The other specialist skills (synthetic identity,
  identity theft, deepfake, liveness, document tamper) need artifact hashes, identity-theft models and document pages
  and are not covered.
- **Ownership replay**: `business.ownership.discover.v1` on the `corpus:` binding. The generator emits a
  `CanonicalHostResult` (`provider_payloads.py`) per party from the same spec edges; the replay runs it through the real
  `normalizeWiringResult` ownership path (marked synthetic, citing the gateway invocation). A test checks the replayed
  edges equal the committed `OwnershipInterest` records by entity name and percentage.
  Replayed records carry provider-style ids (`entity:corpus:...`), not the corpus record ids; equivalence is semantic.

Not done: screening and registry replay (`business.registry.lookup.v1`, `screening.*`), `ownership` ranges and
voting/economic splits (they need H06 and A4), a gateway route-level test of the `corpus:` binding, and the other
specialist fraud providers.

## 13. Phase 3 status and findings (2026-11-09)

Built: collectors (`context-corpus collect`) with provenance in `SOURCES.json`; heroes **H06, H02, H03, H12**; ownership
ranges, circular holdings, nominee relationships, voting vs economic interest, trust party roles with a mid-history
change; list data (pinned real subsets plus clearly fictional lists); screening hits, executions and provider payloads;
replay of `screening.sanctions.v1`, `screening.pep.v1` and `business.ownership.discover.v1` on the `corpus:` binding.

Sources, as collected on 2026-11-09 (all from this environment, certificate checks on):

| Source | Result |
| --- | --- |
| OFAC SDN, UN consolidated, UK sanctions list | Collected; a deterministic subset of 17 entries is pinned as published. The full-download sha256 and retrieval time are in `SOURCES.json`. |
| EU consolidated list | **Not collected.** The endpoint returned HTTP 500 on every variant tried; recorded as `unavailable`. EU screening scope is therefore not claimed. |
| GLEIF Level 1/2 | Collected as a structural sample (43 parent chains, names not retained). It shows 2-4 level chains and many cross-border steps, but **does not evidence** any of H06's own steps (VG to CY, CY to LU, LU to US). H06 is plausible, not template-backed. |
| Companies House, BODS | **Not collected.** Companies House needs an API key (the API returned 401) and the BODS snapshot is large; both are needed only for anchor A3 (Phase 4). |

Real designations appear only as list entries. H06's two "designated" owners are **fictional** list entries
(`synthetic-designations`), as principle 4 requires; the real entries serve as screening noise and as the H02
near miss. `validate_real_names` rejects a fictional name that matches a pinned real designation, except those a hero
declares as intended near misses.

- **H06** (BVI, Cyprus, Luxembourg, US). Two designated persons hold 30% and 20% of the Cyprus holding, exactly 50%
  together. OFAC's 50% rule blocks Cyprus, then Luxembourg (60% from Cyprus), then the US customer, while path-product
  ownership puts them at 30%: the library gives `threshold_met` true under `ofac_50_percent` and false (0.30) under
  `synthetic_aggregate`. The group is also circular (5% back into Cyprus), has a 25-40% nominee range in Luxembourg
  (40% unaccounted) and exactly one UBO (27% through Seabright). Not done: the over-budget context exercise for H06.
- **H02**: published near miss (OFAC 38296) with conflicting identifiers. The local scorer produces no hit, the
  provider's candidate keeps the screen in `NEEDS_REVIEW`, and `screening.match.disambiguate` says
  `FALSE_MATCH_CANDIDATE` (never final).
- **H03**: customer unlisted; her brother is on the fictional PEP list; `PEPRelationship` resolves; two source-of-wealth
  claims, one unverified. The inconsistent document needs Phase 4.
- **H12**: discretionary trust; every defined party is a beneficial owner; the beneficiary added 2025-03-14 is invisible
  to `party.role.resolve` as of 2025-01-01 and visible as of today.

Findings:

1. **Screening and ownership invocations must name the case's subjects.** A record is read only when it shares a subject
   with the invocation, so invoking with the customer alone sees none of the owners, directors or screened persons.
   With the case's subjects, H04's UBO resolves cleanly and H06's sanctions screen finds both designated owners.
2. **The connector path cannot carry an identifier comparison.** `normalizeWiringResult` writes
   `features: { identifier_conflict: false }` for every screening hit, so a replayed H02 hit reads as `REVIEW`, while the
   committed record (conflict true) reads `FALSE_MATCH_CANDIDATE`. That is a gap in the normalizer, not the corpus.
3. **The live seeding test needed the ledger-hardening grants.** Migration 013 moved event writes behind
   `append_event`, owned by `ehf_ledger_writer`, which needs table privileges before a case can be created; the test
   grants them, and skips the pgvector migrations. All of H04, H06, H07, H10 and H12 seed idempotently.

Not done: registry replay, adverse media (H09), the specialist fraud providers, anchors A1-A4 and documents (Phase 4),
and a route-level test of the `corpus:` binding.

## 14. Production slice 1 evaluation (2026-11-09)

`context-corpus evaluate` runs the twelve skills of the KYB screening-and-ownership slice on the dev
heroes and on a salted, procedurally generated held-out split (`heldout.py`, `CORPUS_HELDOUT_SALT`,
never written to the repository), against reference implementations over the scenario facts. Results,
case mix and findings are in [production-slice-1.md](production-slice-1.md) §9. Corpus changes made for
it: screening provider payloads carry birth dates (so the connector path can establish an identifier
conflict) and RegistryRecord status is upper case, as the platform normalizer writes it.
