# Document Model Factory

Status: implementation notes for Phases 0–3 of [document-intelligence-factory-plan.md](document-intelligence-factory-plan.md).
Each section describes what is built. Open items are listed at the end.

Nothing here runs in a case, writes a case record or promotes a value. The Factory decides where documents come
from, builds labelled datasets, measures extraction routes, and (Phase 3) trains, evaluates and releases document
models through a tenant-scoped control plane. A release only changes which model a type's Route A uses, in shadow.

## Where the code lives

| Part | Path |
| --- | --- |
| Sourcing manifest, datasets, synthetic samples, evaluation, CLI (`document-factory`) | `apps/fincrime-host/src/document_factory` |
| Human sourcing decisions | `apps/fincrime-host/src/document_factory/resources/sourcing-reviews.yaml` |
| Generated sourcing manifest (committed, drift-checked) | `apps/fincrime-host/src/document_factory/resources/sourcing-manifest.json` |
| Value comparators shared by evaluation and the Phase 2 adjudicator | `apps/fincrime-host/src/kyc_documents/comparators.py` |
| Baseline runner for the LLM route | `scripts/document-factory-baseline.ts` |
| Tests | `apps/fincrime-host/tests/test_document_factory_*.py` |
| Phase 3 contracts: strategies, datasets, models, gates, reports, release manifest, planner | `packages/contracts/src/document-factory.ts` |
| Phase 3 registry (migration 064, tenant RLS, append-only history) | `packages/persistence/src/document-factory.ts` |
| Phase 3 API (people and the worker) | `apps/control-api/src/document-factory-routes.ts` |
| Phase 3 worker, Azure training files, Azure client, renderer, Blob container | `apps/fincrime-host/src/document_factory/{worker,azure_training,azure_di,render,blob,model_fields}.py` |
| Phase 3 surface (PLT-23) | `apps/web/src/platform/surfaces/document-factory.tsx` |

The package lives beside `kyc_documents` because it needs the catalog and `validate_extraction`, which stay the
single implementation of document contracts and span validation. The Factory worker wraps this package rather
than reimplementing it.

## Sourcing manifest

One record per catalog document type (293). Each record has the type's contract hash, its pilot membership, a
strategy hypothesis (`azure_prebuilt`, `azure_neural`, `azure_template`, `layout_llm`, `llm_only` or
`structured_input`), sample needs per split, candidate sources, and the comparator that measures each key field.

Sources come from a registry (`sec_edgar`, `companies_house_documents`, `courtlistener_recap`,
`regulator_publications`, `irs_990_filings`, `irs_forms`, `wolfsberg_questionnaires`, `prado_specimens`,
`synthetic_render`, `partner_samples`, `tenant_provided`). Each source carries its kind, collection method, purposes,
privacy handling, structured truth (XBRL, the Companies House API, by construction or none) and rights.

Defaults come from a per-family table, then three adjustments:

- **Partial families.** Only some types in a family get authentic public sources (plan §8.2).
- **The 10 model-pilot types and the 20 further sourcing-pilot types** (plan §8.6) get their specific sources.
- **Non-document artifact kinds** get no layout-model strategy.

The current split is 55 types with authentic public samples, 13 template-based and 15 specimen-based. 163 types
rely on synthetic and partner samples, and 47 on tenant-provided documents.

**Rights.** Every use (`training_use`, `evaluation_use`, `redistribution`) starts as `pending_review`. A decision
needs `reviewed_by` and `reviewed_at`. Committing samples to the repository needs `redistribution: allowed`. The one
standing rule allows generated synthetic content. A type can't move beyond `planned` until some source's rights
allow a use.

**Reviews.** People record decisions in `sourcing-reviews.yaml`. Regeneration never overwrites them, and unknown
types, sources or keys are refused. Regenerate and check with:

```sh
python apps/fincrime-host/scripts/build_sourcing_manifest.py
python apps/fincrime-host/scripts/build_sourcing_manifest.py --check   # run by scripts/python-check.sh
```

Inspect it with `document-factory sourcing summary`, `sourcing list --pilot model` and `sourcing show <type>`.

## Datasets

A dataset directory holds sample bytes under `samples/<sha256>`, one record per sample in `samples.jsonl`, and
one approved gold label per sample in `labels/<sha256>.json`.

**Sample records.** Each records:

- the source and source kind;
- the rights snapshot taken at intake;
- the capture (born digital, scanned or photo) and language;
- a **group key**: the issuing entity or template, which is the unit of splitting.

**Gold labels.** A gold label is a catalog extraction result: values, observations and exact Unicode spans. It
must pass `validate_extraction` against its pages. Provenance is recorded per field: `by_construction`,
`structured_crosscheck_and_human`, `human` or `human_double` (two distinct labellers). An unreviewed model
pre-label is never a dataset label.

**Building a version.** `document-factory dataset build` produces a digest-pinned version:

- **Splits per group** come from a salted hash, so no group spans two splits. The first version pins the salt and
  weights, and a later version is refused if any sample would change split.
- **Rights.** A sample whose rights don't allow its split's purpose is excluded, not moved.
- **Duplicates.** Exact and normalized-text duplicates collapse to one sample. The same bytes under two groups is a
  grouping error and excludes both.
- **Other exclusions.** Unknown sources, missing labels and invalid labels are excluded, each with a recorded
  reason.
- **Sealed test split.** The version records exactly which samples it holds.
- **Readiness flags** show whether there are enough samples for training, validation, a pipeline proof (10 test
  documents) and qualification (the type's full test need, normally 30).

## Synthetic pilot samples

`document-factory synthetic generate --type <type> --count N --dir D` renders the ten model-pilot types, two layouts
each. Labels are known by construction: rendering records the exact span of every value it places. Every label is
checked with `validate_extraction` before it is written.

The data is fictional and marked as such:

- SYNTHETIC or SPECIMEN headers;
- the ICAO specimen state "Utopia";
- `SY` registry numbers and `00-` tax identifiers;
- names built from Example, Sample and Mock words.

Identity samples carry no security features. Phase 0 renders text documents; scans and photos follow the
layout adapter in Phase 1.

## Evaluation

`document-factory evaluate` scores one route's predictions on a dataset version's sealed test split, or on a
declared first-N subset when a run is limited for cost. The subset is recorded.

- **Abstentions.** A missing or failed prediction counts as an abstention.
- **Integrity failures.** Every answer is validated with `validate_extraction` against the gold pages. An invalid
  answer is an integrity failure that yields no values, as it would in production. Integrity issues are counted by
  code.
- **Comparison.** Leaves are compared with the manifest's comparators (`kyc_documents.comparators`). Each answers
  `equivalent`, `different` or `ambiguous`; anything but `equivalent` counts as wrong. Rows of array fields
  (ownership, accounts, signatures) are aligned by content, not position.
- **Metrics.** Field precision and recall, key-field recall with Wilson 95% intervals, the rate of documents with
  every key field correct, abstention and integrity-failure rates, p50/p95 latency, cost, and accuracy by
  confidence band where a route records confidence.
- **Claim level.** Fewer test documents than the type's qualification need gives a report labelled
  `pipeline_proof`.

## Baseline runner

```sh
python -m document_factory.cli baseline-requests --type passport --dataset v.json --dir data --limit 10 --out requests.jsonl
NODE_USE_ENV_PROXY=1 node --import tsx scripts/document-factory-baseline.ts --requests requests.jsonl --out predictions.jsonl
python -m document_factory.cli evaluate --type passport --dataset v.json --dir data --predictions predictions.jsonl \
  --route llm --run-id <id> --limit 10 --model-profile model.document.v1 --model-profile-digest <digest> --out report.json
```

The requests come from the skill host's own builder (`kyc_document_studio.prepare`). Each call goes through the
platform's `document.fields` connector (`invokeDocumentFieldsModel`), so prompt, schema, structured output and answer
binding are the production ones. Failures are recorded, not retried until they succeed.

## Phase 0 baseline

First live run on 2026-11-12. It used 60 synthetic samples per model-pilot type, scored on the first 10 of each
type's sealed test split (`pipeline_proof`). Calls went through the production `document.fields` connector with
`model.standard.v1` (`openai/gpt-5.6-terra`, `maxOutputTokens` 2400, profile digest `4deae5bd…`).

| Type | Valid answers | Integrity failures | Failed calls | All key fields correct | Key-field recall |
| --- | --- | --- | --- | --- | --- |
| passport | 2 | 6 | 2 | 0 | 0.15 |
| national_identity_card | 0 | 3 | 7 | 0 | 0.00 |
| w9 | 0 | 0 | 10 | 0 | 0.00 |
| w8bene | 0 | 0 | 10 | 0 | 0.00 |
| certificate_of_incorporation | 0 | 5 | 5 | 0 | 0.00 |
| articles_of_association | 1 | 1 | 8 | 1 | 0.10 |
| annual_return | 0 | 0 | 10 | 0 | 0.00 |
| substantial_shareholder_disclosure | 0 | 0 | 10 | 0 | 0.00 |
| bank_statement | 0 | 0 | 10 | 0 | 0.00 |
| utility_bill | 0 | 2 | 8 | 0 | 0.00 |

3 of 100 answers were valid. **This measures the route's configuration, not the model's reading accuracy.** Where
an answer was valid, every key value it gave was correct (precision 1.0).

**Findings:**

1. **Output-token limit (likely cause of 69 failed calls).** The AI SDK reported "No object generated" for 69 calls.
   - A minimal correct answer is about 650–2,500 tokens of compact JSON per document. `model.standard.v1` allows 2,400
     output tokens, and a reasoning model spends part of that on reasoning.
   - The types that failed on every call are the larger ones.
   - The runner now records the finish reason and output-token usage, so the next run can confirm this.
   - Fixing it needs a document-extraction profile with a larger limit (Document Studio and case runs use the same
     connector and profile), or another profile set such as `config/model-profiles.claude-openrouter.json`.
2. **Observation path format (17 integrity failures).** The model wrote observation paths as `extracted_fields.x`
   instead of the JSON pointers `/extracted_fields/x` that the contract requires.
   - The compiled instructions never state the format; only the schema's `pattern` does, and structured output did not
     enforce it.
   - Stating the format in the instructions would change every contract hash. Normalizing paths in the connector would
     be a syntactic repair before validation. Either is a decision for the catalog owner.
3. **Passport number field.** The two valid passport answers put the passport number in `document_number`, which
   matches its definition ("identifier of this document"). The catalog makes `identity_number` the passport's key
   field, and its own example and these gold labels put the number there. The contract needs a ruling.
4. **Provider credit.** 11 calls were refused because the OpenRouter account had no available credit left. Recorded
   cost was $0.56; failed calls report no cost, so actual spend may be higher.

**Changes made from these findings (2026-11-12):** `model.document.v1` (16,000 output tokens, 150 s) is now the default
`document.fields` profile, and the connector rewrites dot or bracket observation paths to JSON Pointers. The passport
number is now `document_number`, the passport's key field (decided 2026-11-12, following ICAO 9303's "document
number"). `identity_number` holds only a separate personal or national number. On passports, `document_number` maps to
the canonical `IdentityIdentifier` (`identifier_type` passport_number, `issuer` from `issuing_jurisdiction`) through a
context target scoped to passports. Only the passport contract hash changed. Provider credit remains open. A rerun is needed to measure the effect.

### Rerun with `model.document.v1` (2026-11-12)

The same 100 sealed test documents and the same scoring, with `model.document.v1` (`openai/gpt-5.6-terra`, 16,000
output tokens, digest `3c9dddca…`). Cost was about $4.30.

The first pass gave 76 valid answers, 36 documents with every key field correct, and 2 failed calls. Auditing its
errors found three measurement faults in the gold labels and comparators, not in the model:

- **Form designations.** `Form W-9` and `W-9` name the same form. `tax_form_type` now uses a `form_designation`
  comparator.
- **Values the contract asks for twice from one statement.** A 13G or confirmation-statement row's
  `owned_entity_name` is the named issuer, and a typed signature is both `signer_name` and `signature_text`. Gold
  labels now fill them, citing the same span.
- **The synthetic bill's "Supply address".** It was labelled `subject_address`, but the contract's
  `service_address` fits it. The bill layout now prints a billing address with its stated `address_role`.

The connector also gained the bare-path rule. These corrections were made on contract grounds, but they were found
by inspecting this test split, so treat the corrected figures below as a pipeline proof only. Qualification needs a
fresh sealed set. Nine types were re-scored from the same answers, after applying the connector's current path
normalization. The utility bills (whose text changed) were rerun.

| Type | Valid | Integrity failures | Failed calls | All key fields correct | Key precision | Key recall | All-field precision | All-field recall |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| passport | 10 | 0 | 0 | 10 | 1.00 | 1.00 | 0.85 | 0.92 |
| national_identity_card | 10 | 0 | 0 | 10 | 1.00 | 1.00 | 0.80 | 0.74 |
| w9 | 10 | 0 | 0 | 10 | 1.00 | 1.00 | 0.71 | 0.80 |
| w8bene | 7 | 3 | 0 | 5 | 0.98 | 0.68 | 0.56 | 0.59 |
| certificate_of_incorporation | 10 | 0 | 0 | 8 | 1.00 | 0.95 | 0.72 | 0.83 |
| articles_of_association | 10 | 0 | 0 | 9 | 0.90 | 0.90 | 0.54 | 0.70 |
| annual_return | 5 | 4 | 1 | 2 | 0.88 | 0.47 | 0.61 | 0.45 |
| substantial_shareholder_disclosure | 10 | 0 | 0 | 0 | 0.78 | 1.00 | 0.69 | 0.93 |
| bank_statement | 9 | 1 | 0 | 4 | 0.93 | 0.90 | 0.83 | 0.83 |
| utility_bill | 9 | 1 | 0 | 2 | 0.76 | 0.82 | 0.86 | 0.83 |
| **All** | **90** | **9** | **1** | **60** | **0.90** | **0.81** | **0.72** | **0.75** |

Compared with the first run (3 valid answers, 0 documents with every key field correct), the token budget and the
connector's path normalization account for most of the change.

**Open:**

- **Integrity failures that remain.** Five answers still have invalid paths. Two answers mark a value present
  without one, or the reverse. One omits a status note, and one gives a value without a span.
- **Annual return** (multi-row ownership tables) is the weakest type.
- **13G rows.** All rows are found (recall 1.0), but some carry members the gold leaves empty.
- **All-field precision** is lower than key-field precision, because the model fills optional fields the synthetic
  layouts don't state.

These need error analysis on a fresh split before any change.

### Claude Sonnet comparison (2026-11-12)

The same 100 documents and corrected labels, scored the same way, with `model.document.v1` from
`config/model-profiles.claude-openrouter.json` (`anthropic/claude-sonnet-5.5` through OpenRouter, 16,000 output tokens).

| | GPT (`openai/gpt-5.6-terra`) | Claude Sonnet (`anthropic/claude-sonnet-5.5`) |
| --- | --- | --- |
| Valid answers | 90 | **100** |
| Integrity failures / failed calls | 9 / 1 | **0 / 0** |
| Documents with every key field correct | 60 | 64 |
| Key-field precision / recall | 0.90 / 0.81 | **0.93 / 0.98** |
| All-field precision / recall | 0.72 / 0.75 | **0.83 / 0.90** |
| Median latency per document | 20–38 s | 16–33 s |
| Cost (100 documents) | $4.29 | $5.08 |

Claude produced a contract-valid answer for every document, including all ten annual returns, where GPT produced
five. It also had the higher recall on every type.

The "every key field correct" count understates it. That metric fails a document for any extra value in a key row.
Claude's extras are stated in the documents, but the synthetic gold leaves them empty:

- the owned company's registration number in annual-return rows (`owned_entity_identifier`);
- "of the class" as a 13G row's `percentage_basis`.

Its W-8BEN-E misses are `signature_text`, which is the label convention adopted after reviewing GPT's answers on
this split. Field-level precision and recall are the more reliable comparison here. Label conventions should be
settled on a fresh split, not tuned further on this one.

**Decision (2026-11-12):** the default set's `model.document.v1` now runs `anthropic/claude-sonnet-5.5`, so Document
Studio and case extraction use it. The Claude profile sets already did. The document-reextraction plan pins the
profile digest and was recompiled. Deployments with profiles already in their database need the profile updated
there.

### Phase 1 live run: Azure layout (2026-11-12)

Rendering. Each model-pilot type's first 10 sealed-test samples were rendered from their gold text:

- the first five as image-only scanned PDFs (150 dpi, greyscale), with no text layer;
- the next five as skewed "photos": PNG at 110 dpi, text rotated 2°, grey background.

Path. Each went through the real path:

1. A local evidence pipeline server, called by `prepareDocument`.
2. Native parsing, which recommended layout for every scan.
3. The Azure `prebuilt-layout` adapter against a live test resource, then the pipeline's layout parser.
4. Extraction with Claude Sonnet (`model.document.v1`).

Scoring. Values were compared with the gold labels, and citations were checked against the OCR'd pages the model
read (`evaluate --source-pages`).

What the run found. Two adapter faults were fixed before the final numbers:

- Azure throttled the resource (HTTP 429 on 46 of 100 first attempts). The adapter now keeps honouring `Retry-After`
  within its deadline, and the throttled documents then all succeeded.
- Azure joins a paragraph's lines with spaces, so label and value ran together. For example, "Utopia" on one line
  became part of the next line's name. Paragraphs now keep Azure's line breaks. National identity cards and
  incorporation certificates were rerun after that fix.

| | Valid | All key fields correct | Key precision / recall | Wrong key values |
| --- | --- | --- | --- | --- |
| Scans, OCR via Azure | 49 / 50 | 33 | 0.94 / 0.95 | 0 |
| Same documents as text | 50 / 50 | 33 | 0.94 / 0.98 | 1 |
| Photos, OCR via Azure | 50 / 50 | 35 | 0.96 / 0.98 | 0 |
| Same documents as text | 50 / 50 | 31 | 0.93 / 0.98 | 0 |

- **Extraction quality.** From Azure's OCR it matches extraction from the original text on these synthetic renderings.
  The one invalid scan is a failed model call.
- **Geometry.** Every scan page had upright geometry (612 × 792 points, converted from inches) with region boxes.
  Every photo page was marked rotated, so the workspace draws no boxes on it, as designed for skewed pages.
- **Review flags.** Seven documents were flagged for low-confidence words.
- **Latency.** Layout plus preparation took a median of 14 s and a p95 of 52 s per document at concurrency 2–4,
  including throttling waits.
- **Limits.** These are clean synthetic renderings. Real scans (noise, stamps, handwriting, multi-page) still need
  partner or tenant samples.

### Phase 2 route benchmark: Azure prebuilt and adjudication (2026-11-12)

The three pilot types with an Azure prebuilt model were used: passport and national identity card
(`prebuilt-idDocument`) and bank statement (`prebuilt-bankStatement.us`). There is no prebuilt W-9 on API 2024-11-30.
Each type used the same 10 live renderings per type (5 scans, 5 photos) and the same OCR pages and gold labels as the
Phase 1 run.

- **Route A:** Azure prebuilt field candidates, anchored on the OCR page text (`kyc_documents.route_answers`).
- **Route B:** the Claude Sonnet answers from the Phase 1 run.
- **Adjudication:** `kyc_documents.adjudication` with the default policy. The adjudicated answer holds only the
  selected values.

| Configuration | All key fields correct | Key precision / recall | Wrong key values |
| --- | --- | --- | --- |
| 1. LLM only | 29 / 30 | 0.99 / 1.00 | 0 |
| 2. Azure prebuilt only | 12 / 30 | 0.96 / 0.60 | 0 |
| 3. Azure + selective LLM | 25 / 30 | 0.97 / 0.99 | 0 |
| 4. Parallel + adjudication | 25 / 30 | 0.97 / 0.99 | 0 |

By type:

- **Passport:** every configuration was perfect. Every key field in the parallel run was `AGREED_GROUNDED` with no
  review required, which is the evidence a qualified light-review policy would rest on.
- **National identity card:**
  - Azure alone missed names. It misread the surname ("Alex Example\nExample"), which cannot be anchored, so the joined
    `person_name` was dropped as well.
  - Adjudication recovered full recall.
  - Eight of ten documents need review, because a name came from one route only.
- **Bank statement:**
  - Azure's prebuilt model found few fields: no holder name, partial accounts.
  - It read the account type as "SYNTHETIC SAMPLE". That text is on the page, so it is grounded, and adjudication
    selected it under R3 when the LLM stated the field absent.
  - Adding Azure therefore lowered precision compared with the LLM alone.

Findings:

- **Selective trigger.** "Missing key field, or key-field confidence below 0.8" fired on all 30 documents, because
  Azure's confidences on these renderings were mostly below 0.8. So configurations 3 and 4 were identical. Trigger
  thresholds need calibration on the type's evaluation data.
- **Route mode per type.** On these synthetic documents:
  - Azure prebuilt adds agreement evidence for identity documents (passport: full agreement) but no accuracy.
  - It adds noise for bank statements.
  - A per-type route mode is warranted: parallel for identity documents (agreement signal), LLM only for bank
    statements until real samples say otherwise.
- **R3 risk.** R3 can select a grounded but wrong value from a weaker route. Per-type route modes, or requiring
  review on R3 for every criticality, limit that.
- **Status.** All of this is synthetic and a pipeline proof only. Qualification needs real samples.

The scored reports, predictions and requests are working files, not committed. Rerun with the commands above, using
`--profile model.document.v1`.

### Phase 2 System 1 advisory shadow (2026-11-13)

`kyc_documents.advisory` builds the §6.5 questions (question set `document.advisory.v1`) from the 30 parallel
adjudications above:

- `span_support` for each critical value that came from one route or was selected over another;
- `same_value` for agreement on different raw text.

All 65 questions were `span_support` on `SINGLE_ROUTE` (R3) values: 14 from identity cards and 51 from bank statements.
They were sent live, one question per request, through the `document.advisory.jev` binding (OpenRouter Decisions,
`typesafe/jev-1.13`, returned revision `typesafe/jev-1.13-20260917`). Truth is whether the selected value matches the gold label.

| Truth | Answered `supported` | Answered `not_supported` | Abstained |
| --- | --- | --- | --- |
| Value correct (61) | 61 | 0 | 0 |
| Value wrong (4) | 0 | 4 | 0 |

- **Every wrong value was flagged.** The four wrong values are the bank-statement account types R3 selected from
  Azure ("SYNTHETIC SAMPLE" or "SAMPLE": printed on the page, but not an account type). `not_supported` had a
  probability of 0.77 to 0.91.
- **No correct value was flagged**, so no reviewer was sent a false alarm.
- **Cost and speed.** Median latency 177 ms (p90 237 ms) and $0.0015 for all 65 questions. The returned model always
  matched the pinned revision.
- **Status.** Under §6.5, `not_supported` only attaches a hint. These values already needed review, so the answers
  changed no outcome. The run is the shadow measurement that rule 5 requires before reviewers see an answer.
  - It is small and synthetic.
  - The distributions are not calibrated.
  - No `same_value` question arose, because no pair of routes agreed on differently written text.
- **Foundry.** The Foundry bindings have not run live, because this environment has no Foundry resource. Both pass
  the conformance suite with recorded responses.

## Phase 3: the Factory control plane

A release moves through five steps, and three different people take part. Every step is recorded in
`harness_control.factory_events`, and the database refuses to change history.

| Step | Who | What happens |
| --- | --- | --- |
| Plan (`release.create`) | An author | **New release** resolves the selection against the registry. It shows readiness per type (a blocked type says what is missing) and the estimate with its pricing basis, then records a job that waits for spend approval |
| Approve spend (`factory.train`) | An operator who did not plan the job | Over `FACTORY_BUDGET_LIMIT_USD`, a third person (the budget owner) must approve too |
| Run | The worker (`Factory.Worker`) | Claims the job and runs it as below, reporting every step under its lease |
| Approve the release (`release.approve`) | Not the planner, who is the release's registrant | Recorded in the artifact registry (`document-model-release`) |
| Activate or roll back (`release.activate`) | An operator | Activation needs the release's report with every type's gates met. Rollback puts the previous executable release back in effect |

The worker runs these steps for each job:

1. **Train or reuse.** It trains a model for each `train` type, from training folders it writes to the Blob container
   (rendered PDF, layout `.ocr.json`, gold `.labels.json`, `fields.json`). It reuses ready models built from the same
   dataset and contract, uses the prebuilt model for prebuilt types, and skips LLM-only types.
2. **Classify and compose.** Custom models are composed under a classifier that has an `other` class.
3. **Evaluate.** Each type is evaluated on its sealed test documents, anchored exactly as Route A is in production.
4. **Report and release.** It records the gated report and registers a release that holds only the types whose gates
   were met, in `shadow` mode.

Running it:

1. **Start the worker.** Use `docker compose --profile factory up document-factory-worker`, or
   `python -m document_factory.worker run|once` with `CONTROL_API_URL`, `FACTORY_WORKER_SERVICE_TOKEN`,
   `FACTORY_DATASET_ROOT`, `AZURE_DOCUMENT_INTELLIGENCE_*` and, for custom models, `FACTORY_TRAINING_CONTAINER_URL`.
2. **Register datasets.** `python -m document_factory.worker sync` registers each type's dataset version from the store,
   plus the manifest's strategy where none is registered.
3. **Run a release.** Then use **Platform → Document Factory**.

**Training container.** A Blob container SAS URL with read, write and list permission. The Document Intelligence
resource reads the same URL. It is a secret: keep it in `.env.local` or the deployment's secret store, never in a
committed file. Without it, prebuilt-only releases still run, and a type that needs training fails with that reason.

### Phase 3 live run and rollback drill (2026-11-13)

The live run used control-api on a local PostgreSQL (migration 064), the worker, and the Azure test resource
(`prebuilt-idDocument`, `prebuilt-bankStatement.us`, API 2024-11-30).

**Data.** The dataset store held 40 synthetic samples each for passport, national identity card, bank statement and
W-9, rendered to PDF by the worker. People acted through the same control-api routes the Document Factory surface
relays: an author (planner), an operator (spend, activation) and an approver.

**Release job 1** (all four types; estimate: no training cost, 109 layout pages, $4.36 evaluation):

| Type | Plan | Sealed test documents | Key precision | Key recall | All key fields correct | Outcome |
| --- | --- | --- | --- | --- | --- | --- |
| Passport | prebuilt | 38 | 1.00 | 0.98 | 35 | Gates met, released |
| National identity card | prebuilt | 35 | 1.00 | 0.71 | 7 | Excluded (recall) |
| Bank statement | prebuilt | 36 | 0.84 | 0.32 | 0 | Excluded (precision, recall, 3 wrong values) |
| W-9 | blocked | — | — | — | — | Not run: 11 training samples, fewer than the type needs |

Gates were the defaults: at least 10 sealed test documents, key precision ≥ 0.95, key recall ≥ 0.80, no wrong key values,
no integrity failures. The outcomes match the Phase 2 benchmark. Azure's prebuilt models alone read passports well
and miss names on identity cards and most bank-statement fields. The gates kept those types out.

**Separation of duties, checked live:**
- The planner was refused as spend approver (`factory.separation_of_duties`), even with an operator role.
- Activation before approval was refused (`factory.release_not_approved`).
- The planner was refused as release approver (`factory.separation_of_duties`).

**Rollback drill:**
1. Release A (job 1, passport): approved by the approver, activated in `test`.
2. Release B (job 2, passport only, the same results): approved and activated in `test`, which put B in effect.
3. `POST /v1/document-factory/environments/test/rollback` with a reason put A back in effect at once. The activation
   history shows A activated, B activated and A rolled back, each with actor and reason. Rollback is refused when there is no earlier
   release, or when the earlier release has been revoked since.

To repeat the drill from the surface, open **Platform → Document Factory → Releases → Roll back** for the environment.

**Not run live.** Custom-model training (template and neural) needs a Blob training container (see above). The worker's
training, classifier and compose path is tested with recorded Azure behaviour. It was checked live up to the
training files: Azure layout read the rendered PDFs of all 10 pilot types, and every gold value was labelled on their words.

## Open items

- Sourcing reviews: no source other than synthetic has a rights decision yet. Collection from SEC, Companies House,
  CourtListener and PRADO waits for reviews and for collection access (SEC declared contact, Companies House API key,
  egress) — plan §12, decisions 7–8.
- Verify the target Azure resource's limits and prebuilt availability (plan §11, Phase 0).
- Synthetic samples are text only and two layouts per type. They prove the harness; they don't qualify a route.
