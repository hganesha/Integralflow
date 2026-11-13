# Document Intelligence Model Factory and dual-route extraction: plan

Status: plan, 2026-11-12. Nothing in this document is implemented yet.

Inputs reviewed: [document-intelligence.md](document-intelligence.md), [document-intelligence-plan.md](document-intelligence-plan.md),
`apps/fincrime-host/src/kyc_documents` (catalog and field library), `apps/evidence-pipeline`, Document Studio
(`apps/web/src/documents/document-studio.tsx`, `packages/contracts/src/document-studio.ts`), the A03 agent
(`domains/agents/document-intelligence.yaml`), the Intelligence switchboard ([intelligence-control-plane.md](intelligence-control-plane.md),
`packages/contracts/src/intelligence*.ts`), the [artifact registry](artifact-registry.md), `compose.yaml` and
`scripts/provision-azure-resources.mjs`. The proposal under review is the "Document Intelligence Model Factory" with an Azure
Document Intelligence (DI) route, an LLM route and a deterministic adjudicator.

## 0. Recommendation in brief

1. **Adopt the proposal's shape, but invert its starting point.** EHF already has the LLM route: `document.fields.contract_extract`
   sends the compiled catalog contract to a model profile and checks every span with `validate_extraction`. Azure DI is the
   *new* route, not the LLM.
2. **Make Azure DI the OCR and layout basis first.** The Azure parser that the docs describe is not implemented (§1.2). Today
   scans, photos and image-only PDFs can't be processed at all. Azure `prebuilt-layout` as the page-text basis is the
   biggest single gain, and it unblocks both routes.
3. **Don't build a new semantic registry.** Extend the one EHF already has. The catalog's 236 shared fields already
   collapse document-specific labels: `entity_name` appears on many document types. The field library's `context_targets`
   is already the mapping to canonical records. It needs more coverage, criticality, comparators and normalizers. It does
   not need a parallel `entity.legal_name` vocabulary.
4. **Train Azure custom models on catalog field names.** Then custom-model output needs no field mapping. Only Azure
   *prebuilt* models need a mapping table, and that table lives in the Factory release manifest.
5. **Adjudicate deterministically in Python, beside `validate_extraction`.** Keep one oracle (the existing decision). The
   adjudication *policy* (criticality, route triggers, thresholds) is versioned administered data that tenants may only
   tighten.
6. **No adjudication outcome is a fact.** Both routes, even when they agree, produce `ExtractedAssertion` proposals that
   stay `UNVERIFIED` and `PENDING_REVIEW`. Adjudication decides what reviewers see and how much review is needed. It
   doesn't decide what is true. `AcceptClaimAsFact` stays the only promotion path.
7. **Evolve Document Studio into the Factory's Test Bench rather than replacing it.** Its preview guarantees (no case
   writes, samples never stored) are worth keeping. The Factory adds governed datasets, training, evaluation and releases
   around it.
8. **First milestone: 10 types end to end, starting with a baseline.** The catalog says `production_qualified: false` and
   `real_document_evaluations: 0`. The evaluation harness and gold set come first, so that the existing LLM route gets
   measured before Azure is added. Every later "does route B add value" claim depends on that baseline.
9. **Build on the related repositories, but don't depend on them.** DocuBricks (Databricks) and pipeline-builder have no
   Azure DI client, second route or adjudicator. They contribute designs: per-field breach semantics, review and audit
   tables, an evaluation scorer, and a strict System 1 decision adapter (§1.4). A System 1 decision model is an advisory
   signal that can only add review. It never replaces the deterministic adjudicator (§6.5). Its provider is switchable
   between OpenRouter Decisions and Azure AI Foundry-hosted models through one `decision.system1.v1` contract, one shared
   validator and a conformance suite, with each binding qualified separately (§6.6).
10. **Source documents through a governed acquisition pipeline, starting with a manifest.** Draw on authentic public filings,
   official templates and specimens, synthetic documents and partner samples, each tagged separately (§8). Begin with a
   sourcing manifest for all 293 catalog types: where each type comes from, whether training is allowed, which fields it
   provides, and how accuracy is measured. Then collect a 30-type sourcing pilot that feeds the 10-type model pilot. Public
   availability is not training rights, and synthetic-only types need authorized real test samples before qualification.
11. **Ship the Factory, not only its models.** The platform ships a rights-cleared corpus pack. Customers add their own
    documents under a recorded training authorization, then start training, evaluation, approval and activation from the
    Document Factory surface. Training runs in the customer's own cloud resources, and the customer's own sealed test set
    gates production mode (§7.4).

## 1. What the review found

### 1.1 What exists and should be reused

| Proposal component | What EHF already has | Gap |
| --- | --- | --- |
| Document catalog (200+ types) | `kyc_documents`: 293 types in 38 families, versioned, a contract hash per type, aliases, key fields | Per-type strategy (prebuilt / neural / template / LLM-only) and the type-to-model binding |
| Document-specific schema | Per-type `fields.json`, `extraction.schema.json` and `instructions.md`, compiled from 236 **shared** fields and 21 nested structures | None for the LLM route. Azure labels must use these names |
| Semantic mapping registry | Field library `context_targets` (`mode: candidate_assertion_only`), with conditions such as "do not merge by name alone" | Only **13 of 236** fields are mapped. Conditions are prose. No criticality, comparator or normalizer IDs |
| Canonical KYC context | Canonical records (`Entity`, `Identity`, `Registration`, `Address`, `OwnershipInterest`, `BeneficialOwner`, …). Context schema 2.0.0 is shared by all 222 skills | Keep it. Put new provenance in versioned extensions, as Phase 1 of the earlier plan did |
| Classifier | `document.classify.catalog`: deterministic title, ID and alias matching with spans, `UNKNOWN` when ambiguous | No learned classifier. Weak on visually identified documents (IDs, utility bills) |
| LLM extraction route | `document.fields.contract_extract` via `document.fields.extract.v1` (OpenRouter model profile), with no recorded fallback | Text only. Has not been evaluated on real documents |
| Grounding check | `validate_extraction`: source digest, document version, exact Unicode code-point spans. Integrity failures emit no assertions | Validates one candidate set. No cross-route comparison |
| Evidence and provenance | `DocumentVersion` and `DocumentPage` (full text, code-point offsets), `Evidence` per span, page geometry only when it is recorded | No geometry source today, because the native parser does no OCR |
| Commit path | Proposals go through `RecordCanonicalRecords` and `ProposeWorkItem`. Promotion needs `AcceptClaimAsFact` | Needs adjudication metadata and a conflict work-item type |
| Review workbench | Case Documents lens: source/extraction workspace, audited checked/corrected/rejected reviews, re-extraction invalidation | Side-by-side candidates per route. Capture of corrections as feedback |
| Model and provider binding | Intelligence switchboard: `document.*` bindings, the `document.analysis.v1` contract, and an `azure_document_intelligence` provider entry (`implemented: false`) | Real adapter. Activation (switchboard Phases 3–6) |
| Versioning, promotion, rollback | Artifact registry (approved digest = executable, approver ≠ registrant, per-artifact revocation). Release-level activation with effective dates and rollback | A `document-model-release` kind |
| Tenant overlays | Policy-pack layers with the tighten-only check | Route and adjudication policy as a layer |
| Test feature | Document Studio: pick a type, upload a sample, run the LLM route, see spans and fields, export JSON. Process-local, about 30 min retention, never stored | Route selection, side-by-side view, Factory surfaces |

### 1.2 Defects and drift found during review

- **The Azure parser was removed, but the docs and deployment still reference it.** An Azure `prebuilt-layout` parser
  (`apps/evidence-pipeline/src/kyc_pipeline/azure_di.py`, 278 lines, API `2024-11-30`, low-confidence words raised as
  parse issues) existed until commit `ff7d3cbd` (2026-11-08) removed it with the other Azure code in the Python apps, to
  keep the platform cloud-neutral. The removal is a deliberate direction, and this plan keeps it: Azure comes back only as a
  provider adapter behind the cloud-neutral intelligence plane (§4.1). Three things were left behind:
  - [document-intelligence.md](document-intelligence.md) still says scans and images use `EVIDENCE_DOCUMENT_PARSER=azure-di`.
  - `scripts/provision-azure-resources.mjs` and `deploy/azure/test-documents.bicep` still set
    `EVIDENCE_DOCUMENT_PARSER=azure_document_intelligence` and pass a key. `compose.yaml` passes the variable too.
  - The onboarding guide (`apps/web/src/onboarding/ResourceSetup.tsx`) still instructs the same setting.
  - The current pipeline reads none of them: `--parser` accepts only `native`, and image documents fail with
    `PDF_IMAGES_NOT_OCR` / `PDF_PAGE_TEXT_INSUFFICIENT`. Azure deployments therefore provision a DI resource that nothing
    calls.

  **Corrected in Phase 0 (2026-11-12):** the docs, the provisioner, the test-documents Bicep, compose and the onboarding
  guide no longer pass a parser setting, endpoint or key to the evidence pipeline. The provisioner still creates the DI
  account for the Phase 1 adapter. Phase 1 restores OCR the cloud-neutral way.
- **The intelligence plane is configuration only.** The switchboard stores document (`document.analysis.v1`) and System 1
  decision (`decision.system1.v1`) bindings, validates them and runs offline checks. Every document and decision provider,
  including `azure_document_intelligence` and `databricks_document`, is `implemented: false`, and activation is not built
  (switchboard Phases 3–6). Executable code exists outside this repository (§1.4).
- **Nothing is qualified.** The catalog, the LLM route and the confidence semantics are all unevaluated on real documents.
  The proposal's promotion thresholds have no baseline to compare against yet.
- **No confidence on the LLM route.** This is correct by design ("confidence is shown only when recorded"). The adjudicator
  therefore cannot compare an Azure confidence with an LLM confidence. It has to use calibrated per-route error rates
  (§6.4).

### 1.3 Mapping the proposal's vocabulary to EHF

| Proposal term | EHF home |
| --- | --- |
| `document.evidence.ingest` skill | Does not exist under that name. The equivalent is the document chain (`parse.artifact` → `classify.catalog` → `fields.contract_extract` → `validity` / `consistency`) and the compiled `document-reextraction` plan |
| "Document Intelligence Gateway" / single endpoint | For agents, a skill (§4.3) that calls provider capabilities through the capability gateway. For applications, an asynchronous experience-API job that runs the compiled document plan (§4.4) |
| `entity.legal_name`-style canonical paths | `Entity.name` (with subject role), `Registration.registration_id`, `Identity.attributes.date_of_birth`, reached through `context_targets` |
| "Accept" in the decision table | "Agreed and grounded": eligible for lighter review under a *qualified* confidence policy. Never an automatic fact |
| Model registry / composition alias | Factory registry tables plus an artifact-registry entry for each release manifest digest, activated through the existing release flow |

### 1.4 Implementations outside this repository

Two related repositories were reviewed on 2026-11-12. Neither has an Azure DI client, a second extraction route, a
deterministic adjudicator, a model registry or a dataset pipeline. Each contributes reusable designs. The code itself is
reference material, not something to align with or depend on.

**`hganesha/docubricks`** is a Databricks document intelligence accelerator. It has one commit (2026-06-10), and its own
mitigation plan says "no phase is gate-complete."

| Part | Status | Use in this plan |
| --- | --- | --- |
| Bronze → silver DLT flow: Autoloader, content-hash ID, `ai_parse_document`, `ai_classify`, per-type `ai_extract` views generated from the catalog | Partial and never run. AI-function return shapes are assumed. Parsing throws away element and bounding-box output. The routed model is stamped on each row but never passed to `ai_extract` | Design sketch for a later `databricks_document` adapter behind `document.analysis.v1` (§4.1). That adapter must keep element geometry and must not use self-reported confidence |
| Schema bundles: 509 catalog entries, 55 available, 1,043 fields. Per field: `min_confidence`, `review_on_breach`, `fail_on_breach`, `regulatory_required`. Also `validation_rules.json`, `model_routing.json` (primary and fallback chain), a prompt catalog with sha256, and `availability` / `rollout_status` flags | Real as data, generated. Per-field thresholds are never read at runtime. The KYC bundle and the KYC extractor disagree on schema and model. KYB, identity and address types are absent | Field-library additions (§3): borrow the per-field breach semantics and the `availability` / `rollout_status` flags. Thresholds still need a qualification reference (§6.4). Not a source of document types: the EHF catalog stays authoritative |
| Lakebase DDL: `review_queue` (reason, priority, SLA, `corrected_json`), `reprocessing_queue`, `extraction_audit` (`ground_truth`, `is_correct`, `eval_run_id`) | DDL is real, but the Streamlit review app's writes don't match it, and nothing feeds corrections back | Field ideas for the feedback store (§7.2 step 8) and the conflict work item. EHF's audited review flow stays the system of record |
| `schema_test_harness.py`: golden cases, field accuracy, gate (≥ 0.85, at least 5 cases), MLflow run, `is_active` promotion | Partial. The golden loader is missing, the model is hard-coded, and the metric is crude | Gate shape only. EHF promotion goes through the artifact registry and release activation (§7.2) |
| Confidence | Model self-reported ("set confidence…" in prompts) | Rejected: no self-reported confidence enters adjudication (§6.4) |
| Licence | No `LICENSE` file. The README claims Apache 2.0 and also a commercial licence | The owner must confirm the licence before any code is copied |

**`hganesha/pipeline-builder`** (Sourceform; one squashed commit, 2026-10-19). Its "document intelligence" extracts
*requirements* from specification documents, not fields from business documents. Its "decision model" is a hosted
probabilistic classifier, not a rules engine.

| Part | Status | Use in this plan |
| --- | --- | --- |
| `OpenRouterDecisionAdapter` and `validateDecisionResponse` (`server/src/documents/intelligence/openrouter.ts`): OpenRouter Decisions API (`/api/alpha/decisions`), tested with `typesafe/jev-1.13`. Rejects a substituted model, missing or unknown questions, probabilities that don't sum to 1 ± 0.02, and a chosen answer that isn't the most probable. 256 KB response cap | Real, contract-tested with a mock. Single provider. Alpha endpoint | **Basis for the first executable `decision.system1.v1` adapter** (choice primitive) in the capability gateway (§6.5) |
| Versioned question catalogue; profile with `off` / `shadow` / `assist` modes; model ID pinned ("latest" and "auto" refused); profile hashed at enqueue; budgets | Real | Pattern for System 1 question sets and pinning (§6.5) |
| Assessment statuses: `insufficient_context`, `unavailable`, `budget_exhausted`, `not_assessable_from_text`, `not_assessed` (abstentions kept separate from negative answers). `effectiveLabels`: model answers can only *add* labels | Real | Adopted as the System 1 safety rule (§6.5) |
| Input hashing (`assessmentHash`, `evidenceHash`, criteria and policy versions) with `assessmentIsCurrent` staleness checks | Real | Adopted for adjudication records (§6.3): an outcome is stale when any pinned input changes |
| `StageStore`: checkpointed stages with lease fencing, attempt and cost ledger, `unknown` outcomes kept | Real | Not needed: the EHF runtime already has leases, fencing and receipts |
| `evals/document-intelligence/evaluate.ts`: accuracy, abstention, precision and recall, Wilson intervals, p50/p95 latency and cost, splits that block leakage, missing predictions counted as abstentions | Scorer real. Data is a 10-item synthetic scaffold with no results | Port the scorer into the evaluation engine (§10). Bring no data over |
| Grounding: verbatim quote containment, drop-not-repair | Real, but no character offsets or boxes | EHF's exact code-point spans are stricter. Nothing to adopt |

## 2. Target architecture

```
                         CONTROL PLANE: Document Model Factory
 ┌───────────────────────────────────────────────────────────────────────────────────────────┐
 │ Catalog (kyc_documents) ─► Type strategy ─► Datasets ─► Labeling ─► Training ─► Evaluation │
 │        ▲                       │                                                │          │
 │        │                       ▼                                                ▼          │
 │  Field library            Release manifest (classifier + composed model(s) + prebuilt      │
 │  context_targets,         routes + prebuilt field maps + route/adjudication policy refs     │
 │  criticality,             + eval report digests) ──► artifact registry (approve ≠ author)  │
 │  comparators                                   ──► release activation (alias, rollback)    │
 └───────────────────────────────────────────────────────────────┬───────────────────────────┘
                                                                 │ active release digest
                         RUNTIME PLANE (case-scoped, receipted)  ▼
 upload ─► DocumentVersion (sha256) ─► parse basis ─► DocumentPage (full text, code points, geometry)
                                      (native | azure prebuilt-layout)
                                                  │
              ┌───────────────────────────────────┼─────────────────────────────────┐
              ▼                                   ▼                                 ▼
   Classification                       Route A: Azure DI                 Route B: LLM (existing)
   catalog classifier (deterministic)   classifier → composed custom      catalog contract →
   + Azure custom classifier            model or prebuilt, via active     model profile, pages as
   → adjudicated type or UNKNOWN        release; fields re-anchored to    untrusted data (optional
                                        canonical page spans              page images for vision)
              └──────────────────────┬────────────┴─────────────────────────────────┘
                                     ▼
            validate_extraction (each route separately) ─► adjudicate (deterministic, versioned policy)
                                     ▼
            ExtractedAssertion proposals (UNVERIFIED, PENDING_REVIEW) + candidates + adjudication
            + work items (gap / field review / conflict / classification)
                                     ▼
            Review workbench ─► AcceptClaimAsFact (permitted actor or qualified rule only)
                                     ▼
            Feedback store (corrections, conflicts, misclassifications) ─► dataset candidates
            (only after authorization and curation) ─► Factory
```

The two routes run independently on the same `DocumentPage` basis. Neither route sees the other's answer.

## 3. Schemas: three layers, built on what exists

| Layer | Source of truth | Change |
| --- | --- | --- |
| Provider schema | Azure custom models: catalog field names *by construction*. Azure prebuilt: a mapping table in the release manifest. LLM: the compiled catalog contract | New: the prebuilt mapping table (for example `prebuilt-idDocument.DocumentNumber → document_number`). Composite transforms such as `FirstName` + `LastName` → `person_name` are named, versioned transforms and are recorded as *derived* |
| Document contract | `kyc_documents` per-type contract (shared field names, nested structures, key fields, contract hash) | Add a per-type `extraction_strategy` and `strategy_rationale`. Contract hash semantics are unchanged |
| Canonical context | Field library `context_targets` → canonical record type and path | Extend from 13 fields to every field that feeds a decision. Make `condition` machine-checkable (`requires: [subject_resolved, jurisdiction_same_evidence]`). Add `criticality` (`critical` / `material` / `informational`), `comparator` (`identifier_exact`, `legal_name_equivalent`, `date_strict`, `address_components`, `amount_currency`, `percent_fraction`) and `normalizer` IDs |

The proposal's bank-statement caveat ("account holder is not automatically the legal entity") is already the rule:
`entity_name` maps to `Entity.name` only after subject resolution, and an account holder is a separate field. The plan
keeps mapping governed by these field definitions and never lets a model decide equivalence.

Comparators and normalizers are pure Python functions in `kyc_documents`, unit-tested, with no network or model calls. A
normalized value always keeps its raw value and spans. Ambiguity (for example `03/12/2021` with no stated date format)
yields `AMBIGUOUS`, not a guess.

## 4. Runtime

### 4.1 Parse basis: one page text per document version

Both routes must cite spans into the **same** text. Otherwise "grounded" means two different things.

- OCR and layout come from a **`document.analysis.v1` provider adapter** in the capability gateway, selected by a
  switchboard binding (for example `document.layout.standard`). It is not a vendor branch inside the evidence pipeline.
  That keeps the 2026-11-08 cloud-neutral decision: the pipeline asks for "layout for this sha256" and receives canonical
  pages, whichever provider is bound.
- The first adapter is Azure `prebuilt-layout`, built from the removed `azure_di.py` mapping (recoverable from history
  before `ff7d3cbd`). It calls the service with `stringIndexType=unicodeCodePoint`, which matches EHF's code-point offsets;
  Azure's default index type would not. It returns page text, segment offsets, page dimensions and word/line polygons as
  recorded geometry, which makes the coordinate overlays in `SourceViewer` real for scans. Parser identity, provider and
  API/model version go into the existing `ehf.connector` extension. A Databricks adapter (`databricks_document`, §1.4) can
  implement the same contract later.
- The evidence pipeline gains one provider-neutral parser mode that calls the bound capability and maps its pages onto its
  segment shape, as `azure_di.py` did.
- Selection: `native` for born-digital text PDFs, TXT, HTML and CSV. The bound layout provider for images, scans, Office
  files and any PDF that has `PDF_IMAGES_NOT_OCR` or thin pages. A version records exactly one parse basis. A re-parse
  creates a new run, never a silent replacement.
- This stays gated by `EVIDENCE_ALLOW_REMOTE_SENSITIVE_DATA` and by the tenant's residency setting, and no raw provider key
  ever reaches the pipeline.

### 4.2 Routes

- **Route A (Azure DI).** Runs the active release's classifier with `split` per policy. It then runs the mapped composed
  custom model, or a prebuilt model the gateway routes to after classification. Prebuilt models are never assumed to sit
  inside a composition. Each Azure field value is **re-anchored** to the canonical page text: exact match within the
  field's reported span or region, then the nearest exact occurrence on the same page. A value that can't be re-anchored
  becomes an `UNGROUNDED` candidate. When the parse basis is also Azure (same `content` string), spans map directly.
- **Route B (LLM).** The existing `document.fields.contract_extract` provider call, unchanged. An optional *vision* variant
  adds page images for selected types or fields. Its quotes must still match page text spans. If the vision model reads a
  value that differs from the OCR text, that is an `OCR_DISAGREEMENT` signal and goes to review. This is the main defence
  against both routes sharing the same OCR error.
- **Classification adjudication.** The catalog classifier and the Azure classifier must agree, or one of them must be
  `UNKNOWN` while the other is above its calibrated threshold, under policy. Otherwise the type is `UNKNOWN`, nothing is
  extracted, and a `DOCUMENT_CLASSIFICATION` work item is raised (existing behaviour). Azure classifiers have no native
  "none of these" output. The Factory trains an explicit `other` class from negative samples, and policy applies a minimum
  confidence.

### 4.3 Skill surface

Released skill contracts don't change (existing rule). Add one wrapper:

| Skill | Wraps | Does |
| --- | --- | --- |
| `document.fields.adjudicated_extract` (new) | `document.fields.extract` | Reads the route policy. Calls `document.model.extract.v1` (Azure, active release) and/or `document.fields.extract.v1` (LLM) through the gateway. Runs `validate_extraction` on each route separately, then `adjudicate`. Emits the same proposal kinds as `contract_extract`, plus an `ehf.document.adjudication/v1` extension. Adds a `DOCUMENT_FIELD_CONFLICT` work-item type |

`document.fields.contract_extract` stays registered, and workflows switch by plan recompilation, so rollback is a plan
choice. A03's skill list gains the new wrapper. Its prompt and its rule of "never facts" don't change.

New provider capabilities in `library-contracts` and the connector catalog:
`document.model.extract.v1` (Azure classifier, composed and prebuilt, via the release alias) and `document.classify.model.v1`
(classifier only, for classification adjudication). `document.ocr.extract.v1` gains the Azure layout connector.

### 4.4 Single endpoint for applications

`POST /api/v1/document-intelligence/jobs` (BFF → control API) is an asynchronous job with an `Idempotency-Key` that runs
the compiled document plan, as the rerun action already does. `GET …/jobs/:id` returns this:

```json
{
  "job_id": "dij_…", "status": "completed",
  "document": { "document_id": "…", "sha256": "…", "parse_basis": "document.layout.standard:azure_document_intelligence/prebuilt-layout@2024-11-30" },
  "classification": { "type": "certificate_of_incorporation", "outcome": "AGREED",
    "candidates": [{ "engine": "catalog_rules", "type": "certificate_of_incorporation" },
                   { "engine": "azure_classifier", "type": "certificate_of_incorporation", "confidence": 0.97 }] },
  "release": { "id": "kyc-docs", "version": 12, "digest": "…" },
  "fields": [{
    "field": "entity_name", "canonical_target": "Entity.name", "criticality": "critical",
    "adjudication": { "outcome": "AGREED_GROUNDED", "rule": "R1", "policy_digest": "…" },
    "selected": { "value": "Acme Holdings Ltd", "raw_value": "ACME HOLDINGS LIMITED", "spans": [{ "page": 1, "start": 120, "end": 141 }] },
    "candidates": [ { "engine": "azure_di", "model": "kyc-incorporation@3", "confidence": 0.96, "raw_value": "ACME HOLDINGS LIMITED" },
                    { "engine": "llm", "model_profile_digest": "…", "raw_value": "ACME HOLDINGS LIMITED" } ],
    "assertion_ref": "record://…", "verification": "UNVERIFIED"
  }],
  "review": { "required": true, "work_items": ["…"] }
}
```

Field values aren't returned to callers that lack `evidence.read`. Studio previews use the same response shape without
`assertion_ref`.

## 5. Execution policy (route modes)

| Mode | Behaviour | Use |
| --- | --- | --- |
| `primary_only` | One route, chosen per type | Types where evaluation shows the other route adds nothing |
| `shadow` | Both routes run. Only the primary's candidates are proposed; the secondary's are stored for evaluation | First release of any type or route |
| `selective` | Primary first. Secondary on triggers: missing key field, low calibrated confidence, unknown or ambiguous class, comparator failure, novelty signal, critical-field validation failure | Recommended production default |
| `parallel` | Both always, then adjudicate | High-risk types (EDD packages, ownership documents) and critical fields |

The policy is administered data (a policy-pack layer). It is pinned by digest into the compiled plan and the release
manifest. Tenants may only tighten it: they can add triggers or move a type toward `parallel`, never relax review.
Selective triggers are evaluated per **field criticality**, not per document.

## 6. Adjudication

### 6.1 Where it runs

`kyc_documents.adjudicate(contract, candidates_by_route, policy) → FieldAdjudication[]` is pure and deterministic. It
runs inside the wrapper skill, so the gateway receipt covers it. There is no LLM judge.

### 6.2 Decision table (per field, after each route's `validate_extraction`)

| # | Route A | Route B | Grounding | Outcome | Lands as |
| --- | --- | --- | --- | --- | --- |
| R1 | value | equivalent value (comparator) | both grounded | `AGREED_GROUNDED` | One assertion; lighter review if a *qualified* confidence policy allows it |
| R2 | value | different value | exactly one grounded | `SELECTED_GROUNDED` | Grounded value proposed, the other kept as a rejected candidate. For `critical` fields, a review work item |
| R3 | value | not present | A grounded | `SINGLE_ROUTE` | Proposed, flagged single-route. Critical fields go to review |
| R4 | not present | value | B grounded | `SINGLE_ROUTE` | Same, under policy |
| R5 | equivalent | equivalent | neither grounded | `UNGROUNDED` | No assertion. Review work item |
| R6 | different | different | both grounded, or `AMBIGUOUS` comparator | `CONFLICT` | One assertion per distinct value in an adjudication group, plus a `DOCUMENT_FIELD_CONFLICT` work item |
| R7 | any | any | normalizer or validation failure on a critical field | `VALIDATION_FAILED` | Escalate |
| R8 | not present | not present | n/a | `NOT_PRESENT` | Key-field gap (existing `DOCUMENT_EVIDENCE_GAP`) |
| R9 | OCR text ≠ vision reading | | | `OCR_DISAGREEMENT` | Review, with both readings |

Agreement is not proof of correctness. R1 still produces an *unverified* assertion. The table only decides what a reviewer
sees and the minimum review depth.

### 6.3 What is stored

Each `ExtractedAssertion` carries `ehf.document.adjudication/v1`: route candidates (engine, model or profile digest, raw
value, normalized value, spans, confidence if recorded), outcome, rule ID, policy digest, comparator and normalizer
versions, and release digest. Rejected candidates are retained, never discarded. Every adjudication record also stores the hashes of its inputs: candidate set, page text, contract, policy and any System 1 answers. A change to any of them marks the outcome stale, following pipeline-builder's `assessmentIsCurrent` pattern. The review UI groups assertions that
share an adjudication group, and the reviewer's existing `checked` / `corrected` / `rejected` action resolves the group.

### 6.4 Confidence

Raw Azure confidence and the (absent) LLM confidence are not compared directly. The evaluation engine produces calibration
tables per (type, field, route, release): the observed error rate by confidence band, and an overall error rate for routes
without confidence. Policy thresholds refer to these tables by digest. As the earlier plan says, no confidence cutoff is
admitted without a qualification reference.

### 6.5 System 1 decision models: advisory, never adjudicating

"Decision model" means two different things in this plan:

- **The adjudicator** (§6.1–6.4) is deterministic. It decides each field's outcome and the minimum review depth.
- **A System 1 decision model** is a hosted model that answers bounded multiple-choice questions with probabilities. It
  is configured as a `decision.*` switchboard binding (`decision.system1.v1`). The first executable adapter is ported from
  pipeline-builder's OpenRouter adapter, with its strict response validation (§1.4). The provider is switchable (§6.6).

A System 1 model answers narrow questions where the deterministic rules can't decide. It never decides the outcome itself.

| Question | When asked | Effect on the outcome |
| --- | --- | --- |
| "Which catalog type is this document?" (choices: the two disagreeing classes plus `other`) | The catalog classifier and the Azure classifier disagree | The answer is shown to the reviewer. The type stays `UNKNOWN` until a person confirms it |
| "Do these two values refer to the same thing?" (`same` / `different` / `cannot_tell`) | A comparator returns `AMBIGUOUS` (name variants, address forms) | It can change `AGREED_GROUNDED` to `CONFLICT`. It can never change `CONFLICT` to agreement |
| "Does this span state this value for this field?" (`supported` / `not_supported` / `cannot_tell`) | `SINGLE_ROUTE` or `SELECTED_GROUNDED` on a critical field | `not_supported` escalates to review. `supported` changes nothing |

Rules:

1. **Answers can only add review.** Adopted from pipeline-builder's `effectiveLabels`: an answer can raise review depth,
   add a conflict or attach a hint. It can't clear a work item, select a value, accept a fact or lower review depth.
2. **Abstention is not an answer.** Timeouts, invalid responses, `cannot_tell`, budget exhaustion and missing context are
   recorded with their own status and change nothing. This is already the switchboard contract: "unmet confidence
   thresholds abstain".
3. **Everything is pinned.** Model ID (never `latest`), question-set version and input hashes, all recorded on the
   adjudication record. A change to any of them makes the answer stale.
4. **Probabilities are not calibrated confidence.** They are reported but not compared with thresholds until the
   evaluation engine has calibrated them per question set (§6.4).
5. **Shadow first.** System 1 answers are measured in the benchmark as another configuration (§10) before they are shown
   to reviewers. The OpenRouter Decisions endpoint is an alpha API, so it must remain removable without affecting
   adjudication.

### 6.6 Switchable decision-model adapters (OpenRouter, Azure AI Foundry)

The System 1 model behind §6.5 can be switched between providers without changing a skill, a question set, the
adjudicator or a workflow plan. Switching is a configuration change: a new revision of a `decision.*` switchboard binding.
It is never a code change in a consumer.

**One contract, several adapters.** Every adapter implements `decision.system1.v1` in the capability gateway, in
TypeScript. None runs in the Python apps (the 2026-11-08 cloud-neutral decision). Each adapter normalizes its provider's
response into the canonical answer, and **one shared validator** checks every answer, whichever provider produced it. The
validator is pipeline-builder's `validateDecisionResponse`, generalized: it rejects model substitution, missing or unknown
questions, invalid options, and distributions that don't sum to 1 or don't favour the chosen option.

| Adapter (switchboard provider) | Transport | Probabilities | Phase |
| --- | --- | --- | --- |
| `jev` via OpenRouter Decisions | `POST /api/alpha/decisions`, ported from pipeline-builder | Native distribution per question | 2 |
| `azure_decision`, mode `foundry_openai` | Azure AI Foundry resource `https://<resource>.services.ai.azure.com/openai/v1`, chat completions with a strict JSON schema whose `choice` is an enum of the question's options | From token log-probabilities over single-token option labels, **only** where the deployment returns them. Otherwise none | 2 |
| `azure_decision`, mode `foundry_anthropic` | The same resource's `/anthropic` Messages API, with a forced tool call for structured output (pipeline-builder's `foundry.ts` pattern) | None | 2, if a Claude deployment is chosen |
| `azure_decision`, mode `foundry_endpoint` | A Foundry or Azure ML managed online endpoint for a model that natively returns a choice distribution (for example a fine-tuned classifier, or a decision model from the Foundry catalog if one is offered), mapped by a declared response mapping | Native, if the model provides them | 4 |

Adapter rules:

- **No synthesized confidence.** An adapter that returns no distribution reports `probabilities: null`, and the binding's
  `confidenceMode` is `none`. Under the existing switchboard check, a threshold then makes the answer abstain. A
  structured-output answer from Foundry or OpenAI is an answer, not a calibrated probability.
- **Pin what Foundry can change.** The binding pins resource, deployment name, the underlying model and version, and API
  version. Deployments must not auto-upgrade their model version. The model the response reports is checked against the
  pin, as the validator already does.
- **Identity and hosts.** Foundry calls use workload identity (managed identity or federated Entra token). An API key is
  allowed only as a credential reference, never stored. The adapter sends the token only to an allowlisted
  `*.services.ai.azure.com` host, following pipeline-builder's `FOUNDRY_HOST` check.
- **Residency.** The binding records the Foundry deployment type (regional, data zone or global), because that decides where
  data is processed. A binding that conflicts with a tenant's residency setting fails its offline check.
- **Content filters and refusals.** Azure content filtering, provider refusals, 429s and timeouts all become the abstention
  status `unavailable`, never a negative answer. Retries are bounded and never repeat a request until the model agrees.

**Contract change.** `system1AnswerSchema` (`packages/contracts/src/intelligence-adapters.ts`) has only a nullable
`confidence` for a choice answer. Add an optional `probabilities` map over the declared options, and an explicit
`abstention` status (§6.5 rule 2). The change is additive: no executable consumer exists yet.

**Switching procedure.**

1. Create the new binding revision, for example `decision.document.advisory` moving from `jev` to
   `azure_decision/foundry_openai`. Run its offline checks.
2. **Dual-binding shadow.** Both bindings answer the same questions on the benchmark, and on live traffic in shadow. The
   evaluation engine compares escalation precision and recall, abstention rate, latency and cost per binding.
3. **Qualify per binding.** Calibration and evaluation are keyed by binding digest and question-set version. Results from
   one provider never carry over to another.
4. **Activate.** Activation uses the same release flow as everything else: a second-identity approval and an effective
   date. Plans resolve the binding alias at run time and record the binding digest on each adjudication record. Answers
   from the previous binding become stale (§6.3).
5. **Roll back** by reactivating the previous binding revision.

**Conformance.** One fixture suite runs against every adapter: schema validity, model substitution, missing answers, an
invalid distribution, timeout and refusal as abstention, content-filter handling, response-size limits and host
allowlisting. An adapter is `implemented: true` in the switchboard only when it passes this suite.

**Dependency.** Switchboard activation is not built yet (switchboard Phases 3–6). Until it is, a decision binding is
registered as a gateway connector, in the same way as today's `openrouter:document_fields.<profile>` connectors, and
pinned in the compiled plan. Switching then means recompiling the plan against a different connector. The same rules
apply. The same pattern covers the document class: `document.analysis.v1` can switch between Azure DI and a Databricks
adapter (§4.1). The LLM extraction route can already use Foundry-hosted models through the implemented `azure_foundry`
reasoning provider.

## 7. The Model Factory (control plane)

### 7.1 Registry (persistence, tenant RLS, append-only events, as for intelligence candidates)

| Entity | Key fields |
| --- | --- |
| `document_type_strategy` | type ID, catalog version and contract hash, strategy (`azure_prebuilt` / `azure_neural` / `azure_template` / `layout_llm` / `llm_only`), model family (a shared model across types or variants), rationale, owner |
| `sourcing_manifest` | One reviewed record per catalog type: variants, needs per split, sources with source kind, rights, privacy handling and structured truth, measurement (§8.3) |
| `dataset_sample` | sha256, source and source kind, `retrieved_at`, collector version, rights snapshot, privacy class, dedup group, quality tags, per-field label provenance |
| `dataset_version` | type or family, sample set digest, split by group (train / validation / sealed test), label set digest, quality checks, storage ref |
| `model_version` | provider model ID, kind, dataset version, catalog field set, training job, cost, status |
| `classifier_version` | classes, dataset versions (including `other`), incremental parent |
| `evaluation_report` | dataset (held-out), release candidate, per-field and per-route metrics, calibration tables, digest |
| `document_model_release` | classifier, compositions (≤ per-composition limit), prebuilt routes and field maps, route and adjudication policy digests, evaluation digests, promotion gates met. Registered in the **artifact registry** as kind `document-model-release` |

### 7.2 Lifecycle

1. **Register type strategy.** Default to the cheapest strategy that could pass: prebuilt where Azure has a prebuilt model
   for the type and region (identity documents, some tax forms, US bank statements), and `layout_llm` for long legal text
   (articles, trust deeds, legal opinions). Use one neural model per *family variant cluster*, not per type. The 38 catalog
   families are the starting clusters, split only when evaluation demands it.
2. **Acquire and curate datasets** through the acquisition pipeline (§8). Production case documents are excluded unless a
   separate, audited authorization exists. Splits are fixed by group hash, so a sample can't move from test to train.
3. **Label.** Route B proposes labels on the canonical page text. A human approves or corrects them in the Test Bench
   labeling view. The Factory then writes Azure's labeling format (`*.labels.json` and `*.ocr.json`) using catalog field
   names, so labels and contracts can't drift.
4. **Estimate and approve cost**, then train. Batch jobs need an approval when the estimated neural training hours exceed
   the allowance.
5. **Train or update the classifier incrementally**, with visually similar negatives and the `other` class.
6. **Evaluate end to end on held-out data**: classification, each route, adjudication, canonical mapping, review rate.
7. **Compose a new immutable release.** Run regression on all previously released types. Register it, approve it with an
   identity other than the registrant, and activate it through release activation (effective date, rollback).
   Production never modifies a composition in place.
8. **Monitor.** Track review rates, conflict rates, overrides and misclassifications per type and field. These become
   retraining *candidates* that a curator triages.

### 7.3 Where the code lives

| Part | Path |
| --- | --- |
| Comparators, normalizers, `adjudicate`, criticality in the field library | `apps/fincrime-host/src/kyc_documents` (Python, the single oracle) |
| Wrapper skill | `apps/fincrime-host/src/financial_crime/skills/document_wrappers.py` |
| Layout adapter (Azure first) | `apps/capability-gateway` (`document.analysis.v1` adapter). The evidence pipeline gets a provider-neutral parser mode that calls it |
| Azure `document.analysis.v1` adapter, release-alias resolution | `apps/capability-gateway` (switchboard provider `azure_document_intelligence` → `implemented: true`) |
| Factory registry, API, migrations | `packages/persistence` (migration 064, `document-factory.ts`), `apps/control-api/src/document-factory-routes.ts`, `packages/contracts/src/document-factory.ts` |
| `decision.system1.v1` adapters (OpenRouter Decisions, Azure AI Foundry), shared validator, conformance suite | `apps/capability-gateway`. Contract extension in `packages/contracts/src/intelligence-adapters.ts` |
| Sourcing manifest, datasets, synthetic samples, evaluation (built in Phase 0, [notes](document-factory.md)) | `apps/fincrime-host/src/document_factory`, beside `kyc_documents` |
| Training and evaluation worker (Azure jobs, label export, metrics) | `document_factory.worker` (Phase 3), run from the fincrime-host image (compose profile `factory`); it reaches the registry only through control-api as workload `Factory.Worker` |
| Datasets | A dedicated Blob container with managed identity, separate from the case evidence store. Never logged |
| UI | `apps/web/src/documents/` (§9) |
| Dataset acquisition (collectors, renderer, screening, pre-labeling) | `apps/document-factory-worker`. It shares collectors and the document renderer with the test context corpus (§8.7) |

### 7.4 Shipping the Factory: base corpus and customer self-service

The platform ships with a document corpus. Customers add their own documents, and they start training, evaluation,
deployment and linking from the Document Factory surface. The Factory code is the same on both sides: the vendor uses it
to build the base corpus and qualify releases, and each customer runs it in their own deployment against their own cloud
resources.

**Day one needs no training.** A new installation already extracts with the LLM route on the bound layout provider, plus
Azure prebuilt models where they apply. Custom models are an upgrade a customer trains when their data justifies it.

#### What ships

The corpus ships as a **corpus pack**: a versioned artifact released with the platform. It is registered in the artifact
registry as kind `document-corpus-pack`. It is not in git or in container images; it is distributed as a release download,
or as a file for offline and air-gapped installs. The pack has three tiers, decided per source by the manifest's rights
review (§8.3). **The right to redistribute is a separate decision from the right to train.**

| Tier | Contents | Why this tier |
| --- | --- | --- |
| **Bundled** | Synthetic samples with labels known by construction. Blank US federal forms (IRS). Public filings whose rights review allows redistribution (for example EDGAR filings, as the test context corpus already decided), with attribution. Labels with per-field provenance. Training recipes (strategy per type, Azure field schemas generated from the catalog). A **reference** test split | Content the vendor may redistribute |
| **Fetch on install** | Manifest entries and collector settings only. The customer's deployment collects the documents itself, under its own access: the SEC declared contact, a Companies House API key, CourtListener. PRADO appears as references, not files | Redistribution isn't cleared, or the documents contain natural persons' data |
| **Not shipped** | `partner_authorized` samples, the vendor's sealed qualification sets (their evaluation *reports* ship instead), and any customer's data | Rights or confidentiality |

Installing the pack runs an import job. It verifies every digest against the pack manifest and writes the samples into the
tenant's dataset store as a read-only `base` collection, pinned to the pack version. Attribution notices appear in the UI.
A new platform release can ship pack v2. The customer is told a new base corpus is available and may retrain. The
active release is never retrained or changed automatically.

**Pre-trained models.** Azure DI can copy custom models between resources (a copy-authorization handshake from the target
resource; verify neural model and classifier support in Phase 0). Version 1 instead trains in the customer's own resource
from the pack's recipes. That avoids a vendor-held source resource and a cross-tenant handshake, and the customer's
releases are evaluated where they run. Neural training isn't deterministic, so a customer's model is never assumed to
match the vendor's measured one. Model copy is a later optimization.

#### What customers add

- **Ways in:**
  - Bulk upload in the Datasets tab.
  - **Propose as dataset sample** from Test Bench (§9).
  - **Promote a case document**, only with a recorded *training authorization*: purpose, legal basis, retention, and
    approval by a person with the data-owner role (`dataset.authorize`). Promotion *copies* the bytes into the dataset store;
    the case evidence is unchanged. Revoking the authorization removes the sample from future dataset versions and flags
    every release trained on it.
- Customer samples go through the same stages as acquired ones (§8.4): quarantine, privacy screen, dedup and grouping,
  quality, LLM pre-label, human review, split by group.
- **Composition.** A tenant dataset version is the pinned base pack version, plus tenant additions, minus tenant
  exclusions (each with a reason). Tenant-specific document types are overlay catalog types built from the shared field
  library (§12, decision 6).
- **Isolation.** Tenant datasets and models stay in the tenant's storage and cloud account. No document content reaches
  the vendor, and product telemetry carries counts and metrics only. Contributing samples back to the base corpus needs a
  separate agreement.
- **The customer's own documents close the public-data gap.** Public and synthetic samples don't look like a given bank's
  customers (§8.2). A type moves to production mode only when the tenant has a sealed test set of its own (≥ 30 documents,
  §8.5).

#### From the platform surface: New release

**Document Factory → Releases → New release** is one guided, resumable flow:

1. **Select** types (or "everything with new data since the active release").
2. **Readiness check** per type: samples per split against needs, label coverage, a rights snapshot on every sample, a sealed
   test set present. Blocked types say exactly what is missing. They don't stop the others.
3. **Plan and estimate.** Shows the strategy per type and which models need training; unchanged models are reused, not
   retrained. Estimates Azure training hours and cost, LLM pre-label and evaluation cost, and duration.
4. **Approve spend** (`factory.train`). Above the tenant's budget threshold, the budget owner must approve too.
5. **Run** a durable, cancellable, resumable job in the Factory worker:
   - train changed models;
   - update the classifier incrementally;
   - compose;
   - evaluate on the sealed tests;
   - run regression on every previously released type.

   A type that fails stays out of the composition; it doesn't fail the whole release.
6. **Review the report:** metrics per type and field against the gates, compared with the active release and the LLM-only
   baseline, plus calibration.
7. **Register and approve.** The candidate is registered as a `document-model-release`. A second identity approves it
   (`release.approve`).
8. **Activate (link).** Choose environment and effective date. Activation points the tenant's `document.model.extract.v1`
   binding at the release. Changed types default to `shadow` mode, then move to the measured mode (§5) as a separate
   policy step. Plans are not recompiled: the adapter resolves the active release at run time, and every adjudication
   record stores the release digest.
9. **Roll back** with one action, which reactivates the previous release.

The Factory *suggests* retraining when a new base pack arrives, when corrections or conflicts on a type cross a threshold,
or when drift appears. It never starts training on its own.

**Permissions.** `dataset.read`, `dataset.curate`, `dataset.authorize` (data owner), `factory.train` and `release.activate`
are new. `release.approve` already exists. The same identity can't both curate a sample and authorize it for training, or
both register a release and approve it.

#### Deployment

Onboarding and the launcher gain an optional **Document Factory** component that extends the existing `documents` resource
kind (`packages/contracts/src/resource-provisioning.ts`, `apps/launcher/src/recipes/azure.ts`). It includes:

- the dataset Blob container, separate from the evidence store;
- the Factory worker;
- an Azure DI resource in a region that supports custom neural training;
- least-privilege workload identities (the DI resource reads training data through its managed identity, never a stored
  SAS);
- the corpus pack import step.

The onboarding guide in `apps/web/src/onboarding/ResourceSetup.tsx` still tells operators to deploy with the removed parser.
It is rewritten along with this component (§1.2). Training backends are adapters: Azure DI comes first. Customers on
other clouds still get the corpus, the LLM route, evaluation and Test Bench.

## 8. Dataset acquisition pipeline

Every phase needs documents. The Phase 0 baseline and the pilot gold set need them first, then training, evaluation and
regression. Acquisition is part of the Factory (control plane). It is fully separate from the runtime evidence pipeline:
no case document enters it, and nothing it collects enters a case.

### 8.1 Source kinds

Every sample carries exactly one source kind. Rights, privacy handling and the trust given to its labels follow from it.

| Source kind | What it is | Typical use | Label basis |
| --- | --- | --- | --- |
| `authentic_public` | Real filings and public records: SEC EDGAR, Companies House filings, court records, regulator publications | Train, validation, test | Human-verified, cross-checked against structured data where it exists (XBRL, Companies House API) |
| `official_template` | Blank official forms (IRS W-9 and W-8 series, 1120, 1040), industry questionnaires (for example, Wolfsberg CBDDQ and FCCQ) | Layout learning and the base for synthetic fills. **Never** a populated-field sample on its own | n/a |
| `specimen` | Issuer or registry specimens (PRADO identity documents, model apostilles) | Classifier classes, layout reference, small test sets | Human |
| `synthetic` | A template or a catalog-type HTML template filled with fictional data, then rendered and degraded | Train, validation, test, and adversarial cases | **By construction** (values are known), with spans anchored on the rendered page text |
| `partner_authorized` | Real samples provided under a written agreement for this purpose | Test sets and production qualification | Human, two independent labelers |
| `tenant_provided` | A tenant's own institution-generated templates and documents | Tenant overlay releases only | Human |

A public document is not automatically licensed for model training. The registry records rights separately from source
kind (§8.3).

### 8.2 Reconciling the sourcing proposal with the catalog

The catalog lists the documents a customer or institution supplies for KYC and KYB, not every public filing type. Most
public sources therefore feed *existing* catalog types. They don't add new ones.

| Proposed source document | Catalog type it feeds | Note |
| --- | --- | --- |
| 10-K, 20-F annual reports | `annual_report`, `audited_financial_statements` | Already used: the Berkshire and Disney PDFs, and anchors A1, A2 and A4 in the context corpus |
| 13D, 13G | `substantial_shareholder_disclosure` | Good authentic source for ownership fields |
| DEF 14A beneficial ownership table | `substantial_shareholder_disclosure` (section), `director_officer_register` (partial) | A section within a larger document. Needs page-range sampling |
| Exhibit 3.1 / 3.2 (charter, bylaws) | `articles_of_association`, `corporate_bylaws`, `certificate_of_incorporation` (state-filed charter text) | A charter is not a registry-issued certificate. Tag the variant |
| Exhibit 4 (share certificate specimens), Exhibit 24 (powers of attorney) | `share_certificate`, `power_of_attorney` | Specimen-like but authentic |
| Exhibit 10 (credit, merger, subscription, shareholder agreements, leases) | `loan_agreement`, `business_acquisition_agreement`, `merger_or_demerger_document`, `share_subscription_agreement`, `shareholder_agreement`, `commercial_lease`, `escrow_agreement` | `layout_llm` candidates: long, variable text |
| Exhibit 21 (subsidiaries) | `ownership_structure_chart` (list variant only) | Not a chart. Tag the variant |
| Fund prospectuses (N-1A, 497) | `fund_prospectus` | |
| Form ADV | `investment_firm_authorization` (partial) | Form CRS has no catalog type |
| 10-Q, 8-K, S-1, indentures | No catalog type | Out of scope unless a workflow (for example `securities-agentic`) needs them. That would be a separate catalog change through normal catalog versioning |
| Companies House: incorporation certificate, articles (MEM/ARTS), CS01, accounts, AP01, PSC, NM01, liquidation filings | `certificate_of_incorporation`, `articles_of_association`, `annual_return`, `audited_financial_statements` / `unaudited_financial_statements`, `appointment_instrument`, `beneficial_ownership_registry_extract`, `company_name_change_certificate`, `liquidator_appointment`, `insolvency_order` | Contains officers' and PSCs' personal data (§8.4) |
| IRS forms | `w9`, `w8ben`, `w8bene`, `w8eci`, `w8exp`, `w8imy`, `corporate_tax_return`, `personal_tax_return` | Templates plus synthetic fill. Form 990 filings are an authentic source for nonprofits |
| CourtListener / RECAP | `court_judgment`, `insolvency_order` | Business entities only. Personal bankruptcy filings are excluded |
| PRADO | `passport`, `national_identity_card`, `residence_permit`, `driving_licence`, `visa` | Specimens: classifier and layout reference, small test sets only |

**First-pass coverage from the 38 families.** This is a planning hypothesis. It is replaced by the reviewed manifest (§8.3).

| Primary source kind | Families (approximate type count) | ≈ Types |
| --- | --- | --- |
| `authentic_public` | entity_formation, constitutional_and_governance, entity_changes; parts of financial_reporting, ownership_records, ownership_transactions_and_control, funding_and_distributions, funds_and_nonprofits, management_and_authority, legal_and_regulatory_context, commercial_and_trade | ~55–60 |
| `official_template` / `specimen` + `synthetic` | us_tax_forms, tax_registration_and_returns, tax_self_certification, personal_identity, residence_and_status, civil_and_representative, certification_and_translation, relationship_and_application, shipping_and_trade_finance, most of sector_licensing | ~80 |
| `synthetic` / `partner_authorized` | address_evidence, bank_and_account_evidence, earnings_and_benefits, employment_and_support, trust_and_fiduciary, estate, wealth_and_edd_declarations, digital_asset_provenance, asset_realization_and_investment, business_operations, and the private remainder of the families above | ~115 |
| `tenant_provided` / vendor output (often structured; may need no extraction model) | institutional_assessments, institutional_controls, digital_and_verification, digital_credentials, physical_evidence | ~35 |

Two consequences follow:

- **Public sources are biased toward large listed companies.** A model trained on Fortune 500 filings may not fit a small
  private company's documents. Test sets must reflect the production population.
- **Synthetic-only types need a `partner_authorized` test set before production qualification.** This applies to
  bank statements, utility bills and trust deeds, among others. Synthetic data alone can prove the pipeline. It can't
  qualify a type.

### 8.3 Sourcing manifest

There is one record per catalog type: 293 records. They are generated from the catalog (family, origins, artifact kind,
key fields, `context_targets`, contract hash), then reviewed by a person. The pilot types are reviewed first. The manifest
answers four questions for each type: where the documents come from, whether they may be used for training, which canonical
fields they provide, and how accuracy is measured.

```yaml
document_type: certificate_of_incorporation
catalog: { version: 0.1.0, contract_hash: "…" }
variants: [gb_registry_certificate, us_state_charter]
strategy_hypothesis: { primary: azure_neural, secondary: llm, rationale: "stable layouts per registry; few fields" }
needs: { train: 15, validation: 5, test: 30 }          # prebuilt and layout_llm types: validation + test only
sources:
  - id: companies_house_documents
    source_kind: authentic_public
    collection: api                                      # api | bulk | download | render | partner
    jurisdiction: GB
    rights:
      licence: "Open Government Licence v3.0"            # as recorded at collection, with the licence URL
      training_use: pending_review                       # allowed | prohibited | pending_review
      redistribution: false
      commit_to_repo: false
      attribution: "Contains public sector information licensed under the OGL v3.0"
      reviewed_by: null
    privacy: { personal_data: officers_and_psc, handling: minimize_and_restrict }
    structured_truth: companies_house_api                # xbrl | companies_house_api | by_construction | none
  - id: synthetic_gb_incorporation
    source_kind: synthetic
    collection: render
    rights: { training_use: allowed, commit_to_repo: true }
measurement:
  key_fields: [entity_name, registration_number, formation_jurisdiction, incorporation_date]
  comparators: { entity_name: legal_name_equivalent, registration_number: identifier_exact, incorporation_date: date_strict }
status: collecting                                       # unreviewed | planned | collecting | labeled | ready | blocked
```

The manifest is administered data: versioned, pinned by digest and stored with the Factory registry. Each source's rights
entry is a reviewed decision. No collector runs against a source whose `training_use` is not `allowed`, except to build a
test-only set when policy permits.

### 8.4 Pipeline stages

```
sourcing manifest ─► collect ─► quarantine ─► rights check ─► privacy screen ─► dedup + grouping ─► quality
       │                                                                                              │
       └── synthetic: template / catalog HTML ─► fictional fill ─► render ─► degrade ─────────────────┤
                                                                                                      ▼
        dataset version (immutable digest) ◄── split by group ◄── human review ◄── cross-check ◄── pre-label (Route B)
```

1. **Collect.** Collectors respect each source's access rules. SEC EDGAR requires a declared User-Agent with a contact the
   operator configures; it is never a person's details taken from the session. SEC also has a request-rate limit.
   Companies House needs an API key (the corpus hit a 401 without one) and has a rate limit. CourtListener uses a token.
   Every fetch records URL, `retrieved_at`, sha256 and collector version, in the same shape as
   `fixtures/context-corpus/SOURCES.json`.
2. **Quarantine.** New files go to a write-only landing container and are parsed in isolation. Downloaded documents are
   untrusted input: prompt-injection text inside them is data, the same rule the runtime applies.
3. **Rights check.** The manifest decision is snapshotted onto the sample. A sample whose rights are `pending_review` can't
   enter a dataset version.
4. **Privacy screen.** Detect and classify personal data. Personal bankruptcy, individual tax and natural-person court
   filings are excluded. Companies House officer and PSC data is minimized and kept under restricted access with a recorded
   purpose and retention. Redaction is avoided where it would corrupt layout labels; such samples are excluded instead.
5. **Deduplicate and group.** Exact (sha256) and near-duplicate (page-image hash) detection. Samples are grouped by **issuing
   entity** and by template, so one company's 2023 and 2024 filings can't land in train and test.
6. **Quality.** Page count, resolution, text layer present or not, language, skew. Tag scan versus born-digital, so the
   benchmark can report them separately.
7. **Synthetic generation.** Reuse the corpus design (§6.4 of [test-context-corpus.md](test-context-corpus.md)): an HTML
   template per catalog type rendered with Chromium, plus born-digital, scanned (rasterized, skewed, noisy) and phone-photo
   variants, multilingual where needed, and planted defects. New in this pipeline:
   - Programmatic filling of official fillable PDFs (IRS AcroForms), so labels are known by construction.
   - Several layout variants per type.
   - Fictional data that follows the corpus real-entity policy.
   - Synthetic identity documents are clearly marked `SPECIMEN`, don't imitate an issuer's security features, and are
     stored with restricted access.
8. **Pre-label.** Route B proposes labels with spans. For `authentic_public` samples, the labels are compared with
   structured truth where it exists: XBRL facts for financial values, the Companies House API for company name, number,
   dates, officers and PSCs. Agreement reduces review effort but never replaces it.
9. **Human review.** A labeler approves or corrects each label in the Test Bench labeling view. Label provenance is
   recorded per field: `by_construction`, `structured_crosscheck_and_human`, `human`, or `human_double` (two independent
   labelers, required for test sets of `partner_authorized` and critical fields).
10. **Split and version.** Splits are assigned by group hash. The dataset version is immutable and identified by digest.

### 8.5 The sealed test set

The independent test set is **sealed**. It isn't used for training, prompt tuning, few-shot examples or developing
adjudication rules. Only evaluation runs read it, and each read is recorded against the evaluation report. Test labels are
never produced by the route under evaluation alone: an LLM pre-label must be independently human-verified, or the label
must come from construction or structured cross-checks.

Size matters for the claims an evaluation can make. With 10 test documents, 9 correct gives a 95% interval of roughly
60–98%. With 30, 27 correct gives roughly 74–97%. So 10 documents prove the pipeline works, and **≥30 per type** (more for
critical fields) is the floor for a qualification claim. Prebuilt and `layout_llm` types need validation and test data
only, which keeps total volume well below "20 per type × 293".

### 8.6 Pilots

There are two pilots, of different sizes and purposes.

**Model pilot (10 types, Phases 0–3).** These types are rechosen so that each source kind and each extraction strategy is
represented, and so that the KYC documentary obligations (identity, address, TIN) are covered:

| Type | Strategy hypothesis | Main source kind |
| --- | --- | --- |
| `passport`, `national_identity_card` | `azure_prebuilt` (test data only) | `specimen` + `synthetic` |
| `w9` | `azure_prebuilt` or template | `official_template` + `synthetic` (fill by construction) |
| `w8bene` | `azure_template` / neural | `official_template` + `synthetic` |
| `certificate_of_incorporation` | `azure_neural` | `authentic_public` (Companies House, state charters) + `synthetic` |
| `articles_of_association` | `layout_llm` | `authentic_public` (Companies House, SEC Exhibit 3) |
| `annual_return` | `azure_neural` | `authentic_public` (Companies House CS01, cross-checked with the API) |
| `substantial_shareholder_disclosure` | `azure_neural` / `layout_llm` | `authentic_public` (SEC 13D/13G) |
| `bank_statement`, `utility_bill` | `azure_prebuilt` where available / `azure_neural` | `synthetic`, plus a `partner_authorized` test set before qualification |

Compared with the first draft, `driving_licence` (the same prebuilt model as the other identity documents),
`shareholder_register` and `trust_deed` (low public availability) move to wave 2.

**Sourcing pilot (30 types, Phase 0).** This covers the 10 model-pilot types plus 20 more. Each gets a reviewed manifest
entry and samples collected, but no training yet. That tests the sources, the rights decisions and the volumes before scale:

- **Companies House:** `company_name_change_certificate`, `beneficial_ownership_registry_extract`, `appointment_instrument`,
  `liquidator_appointment`, `audited_financial_statements`.
- **SEC:** `annual_report`, `corporate_bylaws`, `loan_agreement`, `business_acquisition_agreement`, `shareholder_agreement`,
  `share_certificate`, `power_of_attorney`, `fund_prospectus`, `investment_firm_authorization`.
- **IRS:** `w8ben`, `w8imy`, `corporate_tax_return`.
- **Courts:** `court_judgment`, `insolvency_order`.
- **PRADO:** `residence_permit`.

### 8.7 Reuse of the test context corpus

[test-context-corpus.md](test-context-corpus.md) already settled several of these questions, and this pipeline extends
those decisions rather than duplicating them:

- **Licences.** GLEIF, Companies House/BODS, EDGAR and official lists may be committed. OpenSanctions stays out.
- **Held-out data.** It lives in Blob storage, and only digests are committed.
- **Collection egress.** Collection happens in a controlled environment. It needs the source hosts allowed and a declared
  SEC contact; both are still open sub-items.
- **Clients and design to share.** The pipeline shares the existing Companies House and GLEIF clients
  (`apps/evidence-pipeline/src/kyc_pipeline/registry.py`), the planned EDGAR and Companies House collectors, and the
  document renderer.

The differences are scale and purpose. The corpus holds a few consistent dossiers for testing skills and workflows. The
Factory holds many samples per type, with splits, labels and training rights. **Committing to the repository is not the
same as being allowed for training.** Both are recorded separately.

## 9. Document Studio: evolve, don't replace

Studio becomes **Platform → Document Factory**, and the existing route redirects:

| Tab | Content |
| --- | --- |
| **Test Bench** (today's Studio) | Upload or paste, pick a type or let classification decide, and choose routes: LLM / Azure release / both + adjudication. Side-by-side candidates per field with outcome badges, spans and geometry. Same guarantees as today: preview only, no case writes, samples not stored, process-local results |
| Catalog coverage | 293 types × strategy × release status × qualification |
| Datasets | The base corpus pack (read-only, pinned version) and tenant additions and exclusions. Splits, labeling queue, training authorizations. Adding a sample here is an explicit, authorized act, separate from Test Bench |
| Models and releases | The **New release** flow (§7.4): readiness, estimate, spend approval, training job, report, approval, activation and rollback. Version history and retraining suggestions |
| Evaluations | Benchmark runs, per-field metrics, calibration, net-benefit view (§10) |

The one new connection is **"Propose as dataset sample"** from Test Bench. It requires a source-class and authorization
attestation and creates a pending dataset entry. Without it, Studio's never-store guarantee still holds.

## 10. Proving the second route adds value

The benchmark covers the 10 pilot types, then 20–30. For each type it includes clean documents, unseen layout variants,
poor scans, multilingual documents and deliberately ambiguous documents (dates, names), all held out.

Configurations: (1) LLM only (today's baseline), (2) Azure only, (3) Azure + selective LLM, (4) parallel + adjudication,
(5) LLM + selective Azure, (6) configuration 4 plus System 1 advisory answers (§6.5), measured by how many real errors the
advice escalates against how many correct values it sends to review.

Metrics per type and field: precision and recall, exact match on identifiers, normalized-value accuracy, span accuracy
(`validate_extraction`), unsupported-claim rate, review rate, conflict rate, cost per document, p95 latency, and
**incremental error change**: errors from route X corrected by adding route Y, minus new errors introduced. The net-benefit
view weights avoided errors by field criticality against processing and review cost. The output is the per-type route
mode in §5, so the policy is evidence-based rather than global.

## 11. Phases

Each phase ends with `pnpm check` green, including the Python tests.

**Phase 0: Baseline and decisions.**
- Correct [document-intelligence.md](document-intelligence.md) about the Azure parser, and align the variable value in
  `scripts/provision-azure-resources.mjs`.
- Generate the sourcing manifest for all 293 types from the catalog. Review the 30 sourcing-pilot entries, including their
  rights decisions (§8.3, §8.6).
- Collect, screen, pre-label and human-review samples for the sourcing pilot. Build the gold set for the 10 model-pilot
  types (§8.6), with a sealed test split. Synthetic generation covers the template and synthetic-only types.
- Build the evaluation harness and measure the existing LLM route. This is the first real evaluation.
- Verify the target Azure resource's tier, region, API version, composition and classifier limits, prebuilt availability,
  and neural training allowance and pricing. Record the residency decision.
- *Accept when:* all 293 manifest records exist and the 30 pilot records are reviewed. Every pilot sample has a rights
  snapshot and label provenance. A reproducible baseline report exists for the 10 model-pilot types, using at least 10
  sealed test documents each (the pipeline-proof level of §8.5). The decisions in §12 are recorded.

**Phase 1: Azure layout as the parse basis.**
- A provider-neutral layout parser mode in the evidence pipeline, backed by the switchboard `azure_document_intelligence`
  adapter for `document.analysis.v1` (OCR / layout). Bind `document.ocr.extract.v1`.
- *Accept when:* scanned and photographed pilot documents produce full-text `DocumentPage` records with geometry. The
  existing LLM route extracts from them with spans passing `validate_extraction`. Overlays render in the workspace. Remote
  parsing stays off by default.

**Phase 1 status (2026-11-12):** built, with a live Azure check outstanding.

- The evidence pipeline gained the `prepare` endpoint that Document Studio and the re-extraction plan already called
  but that did not exist.
- The canonical `document.layout.v1` contract and the Azure prebuilt-layout adapter are in place.
- Gateway and Studio preparation routes images, and PDFs without a usable text layer, through the provider. The
  pipeline turns the layout into page text with regions and page geometry.
- It is off by default (`DOCUMENT_LAYOUT_PROVIDER`, `DOCUMENT_LAYOUT_REMOTE_ALLOWED`). Authentication is managed
  identity or a key.
- All of this is tested against recorded-style Azure responses, with a fixture shared by both languages.
- **Live run (2026-11-12):** 100 scanned and photographed pilot documents against a test resource. Extraction from
  Azure's OCR matched extraction from the original text
  ([results](document-factory.md#phase-1-live-run-azure-layout-2026-11-12)).
- **Outstanding:** the provisioner granting the role and setting these variables, real (non-synthetic) scans, and the
  switchboard marking `azure_document_intelligence` implemented once switchboard activation exists. Details in [document-intelligence.md](document-intelligence.md#ocr-and-layout-for-scans-and-images).

**Phase 2: Adjudication core and prebuilt Route A, in shadow.**
- Field-library additions (criticality, comparators, normalizers, `context_targets` for the pilot fields). `adjudicate`
  with golden tests for every table row, including ambiguous dates and OCR disagreement.
- `document.model.extract.v1` for prebuilt models with field maps. The `document.fields.adjudicated_extract` wrapper. Test
  Bench side-by-side view.
- `decision.system1.v1` contract extension (probabilities, abstention). The OpenRouter Decisions adapter (ported from
  pipeline-builder) and the Azure AI Foundry `foundry_openai` adapter, both passing the shared conformance suite (§6.6). The
  three advisory questions in §6.5 run in dual-binding shadow. The evaluation scorer is ported from pipeline-builder's `evaluate.ts`.
- **Status (2026-11-12):** adjudication, Route A on prebuilt models, the configuration 1–4 benchmark
  ([results](document-factory.md#phase-2-route-benchmark-azure-prebuilt-and-adjudication-2026-11-12)) and the
  `document.fields.adjudicated_extract` wrapper are in place. The wrapper runs in shadow in Document Studio draft tests,
  with outcomes recorded on each assertion ([details](document-intelligence.md#two-extraction-routes)).
  `document.model.extract.v1` has no case-run connector yet: a connector needs a governed way for a workload to read
  an original, and the case API serves raw evidence only to people. Until then, case runs keep `contract_extract`.
  The System 1 work is in place too:
  - the `decision.system1.v1` extension (`probabilities`, explicit abstention reasons);
  - the shared validator;
  - the OpenRouter Decisions, `foundry_openai` and `foundry_anthropic` adapters, each passing one conformance suite;
  - the gateway's `decisions` connectors (`config/decision-bindings.json`);
  - `kyc_documents.advisory`, where answers can only add review.

  A live shadow run of `document.advisory.jev` on the benchmark flagged all four wrong R3 values and no correct one
  ([results](document-factory.md#phase-2-system-1-advisory-shadow-2026-11-13)). The Foundry bindings wait for a Foundry
  resource. The advisory questions are not yet asked in skill runs, because rule 5 keeps them in the benchmark first.
  The Test Bench side-by-side view is in Document Studio: routes, per-field readings and outcomes, linked to the
  source citations ([details](document-intelligence.md#two-extraction-routes)).
- *Accept when:* switching the advisory binding between OpenRouter and Foundry requires only a binding or connector change,
  with no skill, question-set or plan-source change, and is recorded on adjudication records. Pilot prebuilt types run in
  shadow mode in a draft test. Candidates and outcomes are persisted on
  assertions. Nothing new is promoted. The benchmark reports configurations 1–4 for these types.

**Phase 3: Factory MVP (control plane).**
- Registry tables and API, the acquisition pipeline as a worker (collectors, screening, synthetic generation), label export
  from approved Route B candidates, training orchestration,
  classifier (including `other`), the composed release, the `document-model-release` artifact kind, activation and
  rollback.
- Built tenant-scoped and driven from the UI from the start: the **New release** flow and the Datasets tab of §7.4, with the
  new permissions.
- *Accept when:* all 10 pilot types run end to end, started from the Document Factory surface. A new release is trained,
  evaluated, approved by a second identity, activated and rolled back. The rollback drill is documented. A release can't activate without its evaluation digests and
  met gates.

- **Status (2026-11-13):** in place.
  - The registry: migration 064, tenant RLS, append-only history.
  - The API.
  - The `document-model-release` artifact kind, with activation gated on the report's met gates.
  - Activation and rollback.
  - The new permissions and the `Data.Owner` role.
  - The worker: label export, Azure builds, classifier with `other`, compose, evaluation, gated release.
  - The PLT-23 surface with New release and Datasets.

  A live prebuilt release ran end to end against the test resource, and so did the rollback drill
  ([results](document-factory.md#phase-3-live-run-and-rollback-drill-2026-11-13)). Not yet live: custom-model
  training, which needs a Blob training container, and so the "all 10 pilot types" criterion. The acquisition worker
  (collectors, screening) and corpus import remain for Phase 5 and Phase 6.

**Phase 4: Production wiring.**
- KYC and KYB plans recompiled with the wrapper in `selective` mode per the measured policy. A03 updated. Conflict work
  items in the case workspace. Corrections and conflicts captured in the feedback store (not training data).
- *Accept when:* a live KYC run on pilot documents produces adjudicated proposals and work items, the review flow resolves
  conflicts, and the old plan remains selectable for rollback.

  **Status (2026-11-13): done, except that no live route conflict has occurred yet.** What is in place:
  - Route policy 0.2.0 by measured result: passports `selective`, national identity cards `shadow`, bank statements
    `llm_only`.
  - The `document-model` gateway connector serves the model of the Factory release in effect, else the prebuilt
    model. It reads only the original the run was started with.
  - The document-reextraction plan is compiled as `adjudicated`, with the LLM-only `contract` plan kept and admitted
    for rollback.
  - A03 and the KYC/KYB agentic plans use the wrapper. In those plans the model route is not admitted, because
    their runs carry no original.
  - Conflict work items name their assertion and are resolved in the document workspace.
  - Every correction, rejection and resolved conflict goes into the append-only `document_feedback` store, marked as
    not training data.

  **Live run.** The full service stack ran as local processes with separate control and case databases and
  per-service login roles, against OpenRouter and Azure Document Intelligence, on a KYC case with 15 synthetic pilot
  documents uploaded and re-extracted through the BFF:
  - Passports (`selective`): the LLM route found every key field, so the model route correctly did not run. Each
    passport got 9–11 proposed assertions.
  - National identity cards (`shadow`), including two crafted hard cases: the model route ran on every card. Each got
    4–6 `AGREED_GROUNDED` and 4–7 `SINGLE_ROUTE` outcomes, and no route conflict.
  - The bank statement was not classified by its title, so it raised a classification work item.
  - A reviewer correction went through the BFF into the feedback store.
  - The rollback drill pointed the BFF at the contract plan, which ran `contract_extract`, and then back.

  No live document produced a route conflict, so conflict resolution is verified through BFF → case API →
  PostgreSQL (`e2e/live/document-workspace.test.ts`) and in the browser, not on a live conflict.

  The run found and fixed seven defects that the tests had not reached (`artifacts/document-extraction.validation.json`):
  - missing execution grants;
  - an authorization read without the tenant bound;
  - a snapshot projection that hid the case subject;
  - demo-mode synthetic marking;
  - a provider callback effect mismatch;
  - document-fields binding validation;
  - payload validation against lifted proposals.

  Open: cases on the v2 decision contract (the agentic KYC/KYB plans) need a policy grant for document reviews and
  run work items, which the document flow does not request yet ([details](document-intelligence.md#route-a-in-case-runs)).

**Phase 5: Scale to 50, then 200+.**
- Manifest-driven collection waves (authentic public first, then template and synthetic), `partner_authorized` test sets for
  synthetic-only types, ≥30 sealed test documents per type in production mode. Batch training with cost approval,
  incremental classifier, regression suites per release, drift dashboards (review and
  conflict rates by type and field), retraining candidate triage, family-level model reuse, tenant overlay releases
  (tenant types and tighter policies over the shared catalog).
- *Accept when:* each scale step adds types through the pipeline without code changes, and per-type qualification reports
  exist for every type in production mode.

**Phase 6: Shipped corpus and customer self-service.** Deferred to the end by the owner (2026-11-12). The Phase 3
**New release** flow and Datasets tab still let a deployment's own users add samples and train in the meantime.
- Corpus pack v1 (bundled and fetch-on-install tiers), the `document-corpus-pack` artifact kind, the import job and
  attribution.
- Customer additions: upload, Test Bench proposals, case-document promotion with training authorization and revocation.
- The tenant sealed-test gate for production mode, retraining suggestions, and the launcher and onboarding Document Factory
  component.
- *Accept when:* a fresh deployment imports the pack, a customer adds samples (including an authorized case document),
  trains and activates a release from the UI in their own Azure resource, and rolls it back. Revoking an authorization
  flags the affected releases. No customer content leaves the tenant.

Order: 0 → 1 → 2 → 3 → 4 → 5 → 6. Phase 3's registry work can start alongside Phase 2.

## 12. Decisions to make early

1. **Residency and remote processing.** Which tenants allow Azure processing, in which regions? Azure is off by default today.
2. **Training data sources.** Is any production document ever eligible, and under what authorization and retention?
   (Recommendation: not in the pilot.)
3. **Default route per family** after the Phase 0 baseline. The LLM could stay primary, with Azure added for scans and
   identity documents.
4. **Multi-document packets.** Use classifier `split` only for packet uploads, with a boundary review. Single-document
   uploads stay unsplit.
5. **Review depth for R1** (`AGREED_GROUNDED` on critical fields). This needs the policy owner and a qualification
   reference. Until then, every field is reviewed.
6. **Tenant overlays.** Tenant-specific types extend the catalog via overlay releases. Tenants never edit shared contracts.
7. **Source rights owner.** Who signs off each source's `training_use`: SEC, Companies House (OGL, plus personal data in
   filings), CourtListener, PRADO (specimen reuse terms), IRS, Wolfsberg templates.
8. **Collection access.** The SEC declared contact, a Companies House API key and egress for the source hosts. These are the
   same open sub-items as in the test context corpus decisions.
9. **Partner samples.** Which partners can provide authorized real bank statements, utility bills and trust documents for
   test sets, and under what agreement.
10. **Synthetic identity documents.** Confirm the `SPECIMEN` marking and restricted-storage guardrails before any are
    generated.
11. **System 1 dependency.** Whether the OpenRouter Decisions alpha API is acceptable for shadow measurement, and which
    model ID to pin. Production use waits for a stable endpoint or a second provider.
12. **DocuBricks licence.** Confirm it before copying any DocuBricks code. Its README states two licences and there is no
    `LICENSE` file.
13. **Foundry decision deployment.** Which Foundry resource, region and deployment type (residency). Which model, and
    whether its deployment returns log-probabilities. Whether any Foundry catalog model natively returns choice
    distributions (`foundry_endpoint`). Verify all of this against the actual subscription in Phase 0.
14. **What the corpus pack may contain.** This is a redistribution decision per source, separate from training rights:
    who signs off, and how attribution is shown.
15. **Model copy.** Whether the vendor later offers pre-trained base models copied into customer resources, and under
    what terms.
16. **Customer contributions.** Whether customers may contribute samples back to the base corpus, and under what agreement.

## 13. Risks

| Risk | Mitigation |
| --- | --- |
| Both routes share an OCR error and agree on it | Vision variant on critical fields (R9), agreement is never a fact, review sampling of R1 outcomes |
| Span mismatch between Azure content and EHF page text | One parse basis per version. `unicodeCodePoint` index type. Re-anchoring, with `UNGROUNDED` on failure |
| 293 neural models: cost and maintenance | Strategy per type, family clusters, prebuilt and `layout_llm` where they pass, cost approval |
| Classifier forced into a wrong type | `other` class, dual-classifier agreement, `UNKNOWN` path (existing) |
| Sensitive data leaking into training or logs | Separate dataset store and permissions, attestation on every sample, no raw values in logs, Test Bench never-store guarantee |
| Silent production change | Immutable releases, artifact-registry approval by a second identity, activation with rollback, plan digests pinned |
| Public availability mistaken for training rights | Per-source rights review recorded in the manifest. Samples without an `allowed` rights snapshot can't enter a dataset version |
| Public samples don't look like customers' documents (large listed companies vs small private ones) | Test sets drawn to match the production population. `partner_authorized` test sets for qualification. Benchmark reported per source kind |
| Leakage between train and test (same issuer, same template, prompt tuning on test) | Group-hash splits, near-duplicate detection, sealed test set with recorded reads |
| Personal data in public filings | Privacy screen, exclusion of natural-person filings, minimization and restricted access for officer and PSC data |
| A probabilistic decision model treated as an adjudicator | System 1 answers can only add review, abstentions change nothing, and answers are pinned and measured in shadow (§6.5) |
| Redistributing content without the right to | A redistribution decision separate from training rights, the bundled versus fetch-on-install tiers, and attribution in the pack and UI |
| Customers train on production documents without authorization | Case-document promotion only with a recorded training authorization by a data owner, a copy rather than a reference, and revocation that flags affected releases |
| Customer models differ from the vendor's measured ones | Training and evaluation run in the customer's resource, against the customer's own sealed test set |
| Unexpected training cost in the customer's subscription | Estimate and spend approval before every run, a budget threshold, and reuse of unchanged models |
| Switching decision providers silently changes behaviour | Per-binding qualification, dual-binding shadow, the binding digest recorded on every adjudication record, and pinned Foundry model versions with no auto-upgrade |
| Reusing untested code from related repositories | Treat DocuBricks and pipeline-builder as references. Port only contract-tested parts (the decision adapter, the scorer) with their tests, and confirm licences first |
| Azure limits or pricing differ from the documentation | Verified in Phase 0 against the actual resource. Limits enforced by the Factory when it composes a release |
