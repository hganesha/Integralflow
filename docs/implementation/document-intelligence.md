# Document intelligence

Status: implementation notes for the plan in [document-intelligence-plan.md](document-intelligence-plan.md).
Each section describes what is built; open items are listed at the end.

Nothing here verifies a document. Every extracted value stays an `EXTRACTED_ASSERTION`, and only an
authorized human decision turns one into a fact.

## Document Studio

Open **Platform → Document Studio** (`/platform/document-studio`), or choose **Test in
Document Studio** on a document type in the Documents catalog. All built-in document
definitions are available, with their existing field contracts. Upload a sample or paste
document text, then run the document skills. The selected type is the extraction test
target; the automatic classifier's result is reported separately, including `UNKNOWN`.

Studio uses the existing evidence pipeline's pure `prepare` operation, the active
`document.fields.extract.v1` capability's `openrouter:document_fields.<profile-id>` binding (by default `model.document.v1`),
the tenant's administered model profile/provider, and the library's
`document.classify.catalog`, `document.fields.contract_extract` and `document.validity.assess`
functions. The existing extraction adapter performs live inference without recorded fallback.
The library validates the schema, source digest, document version and exact Unicode spans.
Invalid source bindings or citations produce issues and no field assertions.

Results reuse `SourceViewer` and `ExtractionPanel`: source annotations, linked field
selection, page navigation, fields/JSON/schema tabs, mobile source/data switching and a
JSON export containing the tested model profile digest, extraction, citations and skill
outputs. Studio has no case review or fact acceptance controls. Tests never call a case
command or store an uploaded sample as case evidence. Scanned documents require parser/OCR
support; the Studio does not invent page geometry or OCR results.

The control API admits asynchronous tests and exposes progress; the BFF applies human
session, CSRF and permission checks and composes the existing document view. Reading
requires `draft.read` and `evidence.read`; starting requires `draft.evaluate` and
`evidence.read`. Test IDs are scoped to both tenant and author. Idempotency keys bind to
the complete sample request. Up to four tests run per process. Results are process-local,
expire approximately 30 minutes after completion, and are lost on restart; replicated
deployments need sticky routing for these preview tests. Samples are never returned by
the result API, and credentials stay on the server. Mock mode reports that HTTP services
are required and does not fabricate a live extraction.

Set these on **control-api** (Compose supplies the service URLs and host token; enable
the `skills` profile to run `library-skill-host`):

| Setting | Purpose |
| --- | --- |
| `EVIDENCE_PIPELINE_URL`, `EVIDENCE_PIPELINE_TOKEN` | Existing document parser's authenticated endpoint |
| `DOCUMENT_STUDIO_SKILL_HOST_URL` | Financial-crime library skill host, not the three-skill reference host |
| `DOCUMENT_STUDIO_SKILL_HOST_TOKEN` | Credential accepted by that host's `SKILL_HOST_AUTH_TOKEN` |
| Provider credential environment variable | The active provider's `credentialRef`; otherwise `OPENROUTER_API_KEY` |

The authenticated library host provides stateless `/v1/document-studio/prepare` and
`/v1/document-studio/evaluate` helpers, with bounded bodies and pages. These helpers own no
credentials and cannot dispatch providers or commit proposals. They reuse the wrapper
functions and field validator; they are previews, not released `skill.execution.v1` runs.
The image starts `python -m kyc_document_studio`, a separate preview module that extends
the HTTP handler while preserving the released `financial_crime` package and bundle digest.
When running the host outside Docker, use that entry point to enable Studio endpoints.

Validation covers every built-in type, Unicode citations, tampered spans and source
binding, isolated/idempotent admission, unavailable configuration, BFF CSRF and roles,
contract-valid annotated output, and browser source/field/schema/export interactions.
Browser inference uses an explicit provider fixture; a live provider smoke test requires
the deployment's configured services and credentials.

## Where the code lives

| Part | Path |
| --- | --- |
| Document field contracts (293 types, validator) | `apps/fincrime-host/src/kyc_documents` |
| Document skills, base and wrappers | `apps/fincrime-host/src/financial_crime/skills/documents.py`, `document_wrappers.py` |
| Parsing, chunking, extraction, evidence store and HTTP API | `apps/evidence-pipeline` (`kyc-evidence-server`) |
| Package → canonical records | `packages/adapters/src/canonical-records.ts` (`normalizeEvidencePackage`) |
| Case document upload and content | `apps/case-api` (`/v1/cases/:caseId/documents`, `/v1/evidence/:id/content`) |

## Document extraction model profile

`model.document.v1` is the default profile behind `document.fields.extract.v1` in every profile set
(`config/model-profiles*.json`). It has a 16,000-token output budget and a 150-second timeout, and runs Claude
Sonnet in every set (`anthropic/claude-sonnet-5.5` through OpenRouter in the default set), chosen on the factory's
Phase 0 comparison ([document-factory.md](document-factory.md#claude-sonnet-comparison-2026-11-12)). The budget fits a complete field-contract answer (every leaf with an observation and spans), which runs to about
650–2,500 tokens before any reasoning. The Phase 0 factory baseline found `model.standard.v1`'s 2,400-token
budget left most answers empty ([document-factory.md](document-factory.md#phase-0-baseline)). The agentic flows'
capability timeout is 150 seconds to match, and the document-reextraction plan is pinned to this connector.

## OCR and layout for scans and images

The evidence pipeline's stateless `POST /v1/cases/{case_id}/documents/prepare` decodes one hash-bound original
(`document_version` must be the sha256 of the bytes) into full page text in the evidence package's shape, and stores
nothing. Document Studio and the document-reextraction plan (`evidence:prepare`) call it through
`prepareDocument` (`packages/adapters/src/document-prepare.ts`):

- **Born-digital text documents** are parsed natively.
- **Images** go to the layout provider first. With no provider configured they fail closed with
  `adapter.document_layout_not_configured`.
- **PDFs** are parsed natively first. When the pipeline reports `layout_recommended` (image-only or text-poor pages),
  the provider analyzes the original and the pipeline prepares again from that layout. Without a provider the native
  result is kept and flagged.

The provider runs in the platform, never in the pipeline. `analyzeLayoutAzure` calls Azure AI Document Intelligence
`prebuilt-layout` (API 2024-11-30, code-point offsets) and maps the result to the canonical `document.layout.v1`
(`packages/contracts/src/document-layout.ts`). The pipeline (`kyc_pipeline/layout.py`) checks that the layout is bound
to the same bytes, refuses a malformed one, and turns it into page text. It also produces:

- **segment regions**, in points for inch-based pages or in pixels;
- **page geometry**, which drives the workspace's source-region overlays (no overlay on a page whose text is angled);
- **parse issues** for low-confidence words, handwriting, figures and merged table cells.

| Setting (capability gateway and control-api) | Purpose |
| --- | --- |
| `DOCUMENT_LAYOUT_PROVIDER` | `none` (default) or `azure_document_intelligence` |
| `DOCUMENT_LAYOUT_REMOTE_ALLOWED` | Must be `true` to send originals to the provider; default `false` |
| `AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT` | The resource origin (`https://<name>.cognitiveservices.azure.com`); other hosts are refused |
| `AZURE_DOCUMENT_INTELLIGENCE_AUTH` | `managed_identity` (default; Container Apps / App Service identity endpoint, then instance metadata; `AZURE_CLIENT_ID` picks a user-assigned identity) or `key` |
| `AZURE_DOCUMENT_INTELLIGENCE_KEY` | The resource key when `AUTH=key`; a secret, never committed (`AZURE_DOCUMENT_INTELLIGENCE_KEY_ENV` names another variable) |
| `DOCUMENT_LAYOUT_TIMEOUT_MS` | Analysis budget, default 90000, at most 300000 |

With managed identity, grant the gateway's and control-api's identities the *Cognitive Services User* role on the
Document Intelligence resource. The document-reextraction plan allows 120 seconds for preparation and 300 seconds
overall. The adapter is tested against recorded-style responses and was run live on 2026-11-12
([document-factory.md](document-factory.md#phase-1-live-run-azure-layout-2026-11-12)). Azure throttles per resource, so the
adapter honours `Retry-After` on HTTP 429 for up to six retries within its deadline. Paragraphs keep the line breaks of
Azure's `lines`, because Azure joins a paragraph's lines with spaces, and a form's label and value are often separated
only by a line boundary.

## Two extraction routes

For the pilot types with an Azure prebuilt model (`passport`, `national_identity_card` and `bank_statement`), a
second route reads the original beside the LLM (document factory plan §4, Phases 2 and 4). The route policy
(`kyc_documents.route_policy`, version 0.2.0) sets each type's mode from the measured results:

| Type | Mode | Why |
| --- | --- | --- |
| `passport` | `selective` | The prebuilt model met the release gates (key-field precision 1.00 on the sealed test set) |
| `national_identity_card` | `shadow` | Its key-field recall was 0.71, below the gate |
| `bank_statement` | `llm_only` | Precision 0.84, with wrong values read |
| any other type | `llm_only` | No model route |

- **`shadow`**: both routes run. The LLM route's values are proposed; the comparison is recorded and adds review
  where the routes disagree.
- **`selective`**: the LLM route runs first, and the model route runs only when the LLM route missed a key field
  (`KEY_FIELD_GAP`, recorded in `route_triggers`). If the model route then reads that field and the page text grounds
  it (`SINGLE_ROUTE`), its reading is proposed instead of raising the gap (`secondary_fills`), and awaits review like
  any value. A value the LLM route proposed is never replaced.
- **`llm_only`**: the LLM route alone, as `contract_extract`.

The rest of this section describes how the routes run.

- **Route A.** `extractModelFieldsAzure` (`packages/adapters/src/document-model-azure.ts`) runs the type's prebuilt model
  and maps its fields to catalog pointers as `document.model_fields.v1` candidates: the value, the printed text and
  Azure's confidence. Only types listed in `AZURE_PREBUILT_ROUTES` are routed. W-9 has no prebuilt model on this API version.
- **Skill.** `document.fields.adjudicated_extract` reads the route mode from `kyc_documents.route_policy`. When the
  model route runs it calls `document.model` (platform `document.model.extract.v1`) and anchors each candidate on the page text. A value
  that is not on the page is never cited. It then runs `adjudicate` (rules R1–R9). Each assertion carries an
  `ehf.document.adjudication` extension with the outcome, rule, review depth, both routes' values, and the policy and
  input digests. A conflict, a failed validator or an OCR disagreement on a proposed value raises a
  `DOCUMENT_FIELD_CONFLICT` question that names the value's assertion (`subject_ref`); one with nothing proposed (a
  nested row, or no LLM value) is a `DOCUMENT_FIELD_REVIEW` instead.
  A route that can't run (no model for the type, a timeout, candidates for another document) is recorded as `not_run`
  with its reason.
- **Document Studio.** Studio always runs the prebuilt types in shadow, whatever the case policy, so the Test Bench
  compares both routes. It runs Route A on the uploaded original at the same time as the LLM call, and passes the
  result to the library host as `modelRoute`. The test then shows `skillOutputs.modelRoute`, `skillOutputs.adjudication`
  and the extension on each assertion. A failure of Route A never fails the test.
- **Test Bench view.** When Route A ran, Document Studio shows an **Extraction routes** panel below the annotated
  source (`apps/web/src/documents/RouteComparison.tsx`). The BFF projects it from the skill outputs as `routes`
  (`DocumentRouteComparison` in the experience API). The panel shows:
  - each route with its provider, model and status, including why a route did not run;
  - the outcome counts and the policy version;
  - a field table with each route's reading (value, whether it is cited on the page, confidence, which one was
    selected), the outcome, its rule and the review depth.

  The table lists fields that need review first, and can show all fields. Choosing a field opens its citation in
  the source viewer. The proposed values are always the LLM route's. The panel says so, and never calls agreement
  verification. The test export includes `routes`.

| Setting (control-api) | Purpose |
| --- | --- |
| `DOCUMENT_MODEL_PROVIDER` | `none` (default) or `azure_document_intelligence` |
| `DOCUMENT_MODEL_REMOTE_ALLOWED` | Must be `true` to send originals to the extraction model; separate from the layout consent |
| `DOCUMENT_MODEL_TIMEOUT_MS` | Analysis budget, default 90000, at most 300000 |

The Azure resource settings (`AZURE_DOCUMENT_INTELLIGENCE_*`) are shared with layout.

### Route A in case runs

The document-reextraction plan runs `document.fields.adjudicated_extract`. Its model route goes through the gateway's
`document-model:azure_document_intelligence` connector (`apps/capability-gateway/src/adapters/document-model.ts`),
the default for `document.model.extract.v1`. The connector adds no new way to read raw evidence:

- It serves only an admitted **adjudicated** document pipeline, and reads only the original that run was started
  with: the run's own input, which the BFF verified against the stored evidence and the case store authorized
  (`documentRunScope`). The bytes must hash to the run's document version, and the request must name that version.
- It uses the model of the Document Factory release in effect in `DOCUMENT_MODEL_RELEASE_ENVIRONMENT` for the type (a
  custom, composed or released prebuilt model, read with select-only grants through `releasedDocumentModel`). With no
  release for the type, it uses the prebuilt route. A type a release keeps on `llm_only` is refused, and the wrapper
  records the route as not run.

| Setting (capability-gateway) | Purpose |
| --- | --- |
| `DOCUMENT_MODEL_PROVIDER`, `DOCUMENT_MODEL_REMOTE_ALLOWED` | As for control-api; both needed before an original is sent |
| `DOCUMENT_MODEL_RELEASE_ENVIRONMENT` | The Factory environment whose release in effect case runs use; empty means prebuilt models only |

In the KYC and KYB agentic case plans, A03 also runs the adjudicated wrapper, but the model route is not admitted
there: those runs have no original of their own. The route is recorded as not run, and the LLM values are proposed
as before.

**Rollback.** `scripts/document-extraction-plan.ts` compiles two admitted variants: `adjudicated`
(`artifacts/document-extraction.plan.json`) and `contract` (`artifacts/document-extraction-contract.plan.json`, the
LLM-only plan). `isDocumentExtractionPlan` accepts both, each with only its own routes, and
`scripts/prepare-document-extraction.ts --variant contract` prepares the contract plan. Rolling back means pointing
`BFF_DOCUMENT_PLAN_DIGEST` at the contract plan; reviews and work items already recorded are unaffected.

### Route conflicts and review feedback

- **In the workspace.** Document detail carries each value's route outcome (`routes`) and the document's work items
  (`workItems`: those naming its assertions, and those whose question names its version). The extraction panel lists
  the work items, shows how the routes compared on each value, and on an open conflict offers **Keep this reading**
  for each route's value. Editing the value is the other way to resolve a conflict.
- **Resolving.** A review can name the conflicts it resolves (`resolvedWorkItems`), and each entry can say whose
  reading it kept (`selectedRoute`: `llm`, `azure_di` or `manual`). The case store completes a conflict only if the
  same review decides that conflict's own assertion, in the same transaction.
- **Feedback store.** `document_feedback` (case-store migration 021) receives a row for every correction, rejection
  and resolved conflict, written with the review. Each row holds the proposed value, the final value, the proposing
  route, the routes' readings and policy digests, and the conflicts the review resolved. Confirming an uncontested
  value is not feedback. Rows are append-only. `training_use` is fixed at `prohibited`: no release job reads them,
  and a case document reaches training only through an explicit, revocable authorization (factory plan §7.4). The
  rows are there for quality and drift reporting (Phase 5).

## Records

A parsed document produces three canonical record types (library context schema 2.0.0, unchanged):

| Record | Content |
| --- | --- |
| `DocumentVersion` | `document_id` (the pipeline's), `artifact_hash` (source file sha256), `media_type`, `artifact_ref` (`kyc-evidence-pipeline:<document_id>`), `page_count`. The `ehf.connector` extension holds the file name, format, family, profile, parser, run, and `page_count_basis` (`parser`, `decoded_pages`, or `cited_pages_lower_bound`) |
| `DocumentPage` | One per 1-based page, only from the evidence server's full page text (`text_basis: full_text`, with `segments` offsets). `document_version` is the source sha256: every span and assertion binds to exact content through it. Cited quotes are never stitched into a page, because a skill would read fragments as the whole page. A package without `pages` (an older server) yields Evidence records only |
| `Evidence` | One per cited span: `verified: false`, `requirement_ids: []`, and `page_start`/`page_end` when the page text is known |

Offsets are Unicode code points (Python string indices), start inclusive, end exclusive, in the
pipeline's normalized text, not the original file's bytes. TypeScript code must not slice strings
with them, because JavaScript indexes UTF-16 code units. They are checked in Python (the evidence
server's tests, `document.evidence.link`, `kyc_documents.validate_extraction`).

`Document` records (`issued_at`, `expires_at` required timestamps) are emitted only when both dates
are stated and complete. Unknown, partial or absent dates stay in versioned extensions, as kyc's
`docs/document-context-mapping.md` requires. The core context types are not changed, because all 222
skills share them.

## Evidence server pages

`GET /v1/cases/{case_id}/package` on `kyc-evidence-server` returns the CLI's evidence package plus
`pages`: each current document's full page text, made from its normalized segments in reading order
and joined by a blank line, with each segment's start offset. An evidence span `(segment_id, start, end)`
maps to the page span `(start + offset, end + offset)`. Its test checks that every evidence quote
is found exactly at its mapped page span.

## Case document upload

`POST /v1/cases/:caseId/documents` (a person with `evidence.write`; workloads use
`/v1/evidence:register` under an execution envelope) takes `{filename, mediaType, contentBase64,
declaredDigest?, documentType?, subjectRefs?, residency?}` (`documentUploadSchema`). It stores the
bytes content-addressed as `DOCUMENT` evidence from an `UPLOAD` source, as `UNTRUSTED_EXTERNAL`
customer-provided content, and returns the evidence plus `{documentId, sha256, filename, mediaType,
documentType, status: "UPLOADED_UNPARSED"}`. `documentType` is the uploader's claim, not a
classification. A retry with the same `Idempotency-Key`, case, file name and bytes returns the first
registration. Any other reuse of the key is `409 evidence.idempotency_conflict`.

`GET /v1/evidence/:evidenceId/content` (a person with `evidence.read`) returns the bytes after
re-hashing them against the recorded digest, with `cache-control: no-store`.

## Wrapper skills

The document field catalog (`kyc_documents`) reaches the skill library through eight EHF extension
skills (`apps/fincrime-host/docs/skill-extensions.md`, `src/financial_crime/skills/document_wrappers.py`).
Each one wraps exactly one canonical `document.*` skill: it declares that skill as a dependency and keeps
its conventions. The 222 canonical skills, their versions and contracts are unchanged. The library
release is 0.5.0 with 232 skills. `scripts/build_catalog.py` admits an extension only when it has a
heading in `skill-extensions.md` and wraps one canonical skill.

| Skill | Wraps | Does |
| --- | --- | --- |
| `document.classify.catalog` | `document.classify` | Classifies each document version into the 293 catalog types by exact title, ID and alias matches with spans. A single title-area match decides, otherwise a single overall match; anything else stays `UNKNOWN` with every candidate |
| `document.parse.artifact` | `document.parse` | Returns a version's full page text from admitted `full_text` pages, or else from the `document.ocr` provider. `complete` only when pages run 1..n and match `page_count` |
| `document.fields.contract_extract` | `document.fields.extract` | Sends the compiled contract (schema, instructions, contract hash) and the pages to the `document.fields` provider, then runs `validate_extraction`. Integrity failures fail with no assertions, and key-field gaps are `NEEDS_EVIDENCE`. Valid results are `COMPLETED` with `review_required: true`, `promotion_allowed: false`, unverified candidate assertions and mapping candidates |
| `document.fields.adjudicated_extract` | `document.fields.extract` | The same LLM extraction and validation as `contract_extract`. Where the route policy runs the model route (shadow, or selective on a missed key field) it also calls `document.model`, anchors those candidates on the page text and adjudicates the two routes. The LLM values are proposed (selective mode also proposes the model route's grounded reading of a missed key field), outcomes go in `ehf.document.adjudication`, and disagreements raise `DOCUMENT_FIELD_CONFLICT` questions ([two extraction routes](#two-extraction-routes)) |
| `document.validity.assess` | `document.validity.check` | Applies `issued_at <= as_of < expires_at` to the whole range a stated date can mean (day, month, year). An undecidable partial date is `UNDETERMINED_PRECISION`, and no expiry is `EXPIRY_NOT_EXTRACTED` |
| `document.consistency.assess` | `document.consistency.check` | Reports a subject's field stated differently across document versions (case and whitespace normalized), with every value and its source reference |
| `document.requirements.resolve` | `document.requirements.evaluate` | Resolves the policy's `required_document_types` onto the catalog. An uncataloged type is never satisfied. Entity-package and review-event documents are options, not obligations |
| `document.request.compose` | `document.request.generate` | Writes request text from the catalog's display name and key fields. Unknown types are listed, and `sent` is always false |

The three provider capabilities map to platform capabilities `document.fields.extract.v1` (model),
`document.model.extract.v1` (tool) and `document.ocr.extract.v1` (tool) in `@ehf/library-contracts` and the connector catalog. Wrappers
read canonical record fields only. The context compiler projects records to their declared fields
and treats an absent one as missing, so optional `extensions` cannot be required.

## Library skill host and the commit path

`apps/fincrime-host` serves library skills to the gateway's `skills:` adapter over
`skill.execution.v1` (`src/financial_crime/runtimes/skill_host.py`). Before this there was no host
for library skills, so every library skill call in a KYC or KYB run was refused.

- **Bundle lock.** `scripts/sync-library-bundle-lock.mjs` generates
  `resources/bundle.lock.json` from the catalog with the platform's `librarySkillBundleLock`. The
  host refuses to start when the lock, catalog and installed code disagree, and refuses any request
  for another bundle digest or skill version. CI checks the lock is current.
- **Scope.** A skill reads only the request's context sections. Record sections become library
  records, selected by explicit reference to exactly those records. The `policy` section becomes the
  pinned policy, with `permissions` limited to the skill and its effect, and with providers limited
  to the gateway for the capabilities the request permits.
- **Gateway calls.** A provider capability goes to `POST /v1/invoke` on the request's gateway with
  the delegated envelope, under the request's call budget. CR-8 maps library names to platform
  capability IDs. Anything but a succeeded call with an output establishes nothing.
- **Results.** A library business gap (`CONTEXT_MISSING`, `POLICY_UNRESOLVED`, `SOURCE_UNAVAILABLE`,
  and so on) is a completed execution with that business status and an unresolved item, never a
  pass. Other errors are `FAILED_EXECUTION` with the §4.3 code.
- **Proposals.** A skill whose output declares `proposed_records` (today only
  `document.fields.contract_extract`, effect mode `proposal`) has them lifted into the computation.
  Each proposal's evidence is the execution's gateway receipts, or else its context sections.
- **Conformance.** `scripts/library-host-conformance.sh` (CI job `library-host`) runs the platform's
  nine checks against the host with document-skill fixtures
  (`apps/fincrime-host/scripts/skill_host_conformance_fixtures.py`). All pass, except two sub-checks
  that are skipped: there is no slow-parameter fixture, and executions run synchronously and live in
  memory, so a restart answers 404.

What `document.fields.contract_extract` proposes, and what the platform commits (the same
skill-commit path as any skill, atomic and idempotent per execution):

| Proposal | Command | Lands as |
| --- | --- | --- |
| `CanonicalRecord` ExtractedAssertion per present top-level scalar field: `subject` = the case subject parameter, `field` = the catalog field, the contract and spans in the `ehf.document` extension, `verification: UNVERIFIED`, `review_state: PENDING_REVIEW` | `RecordCanonicalRecords` | a record version, provenance `skill_proposal` |
| `UnresolvedQuestion` per key-field gap (`DOCUMENT_EVIDENCE_GAP`) | `ProposeWorkItem` | an analyst work item |
| `UnresolvedQuestion` per field with candidate canonical destinations (`DOCUMENT_FIELD_REVIEW`) | `ProposeWorkItem` | an analyst work item to check the value against its span before use |

Nothing is promoted. A canonical fact still needs `AcceptClaimAsFact` by a permitted actor or rule.
Nested rows (parties, ownership edges, accounts) stay in the skill payload and are reviewed as units.
`packages/runtime-core/src/skill-commit.test.ts` maps a proposal captured from the Python wrapper
through the platform's commit planner.

## Agent, task and workflows

- **A03 Document Intelligence** (`agent.document_intelligence`, `task.document_intelligence` in
  `apps/fincrime-host/src/financial_crime/tasks.py`): classify, extract with the document field
  contracts, assess validity and consistency, resolve requirements and compose requests. It subscribes
  to the `document.intelligence` context product. Intake keeps the canonical requirement and request
  skills. A TaskSpec binds parameters only from task inputs, so the task takes `classifications` and
  `subject` as inputs. The library catalog exports seven agents and tasks.
- **A03 extracts with `document.fields.adjudicated_extract`** (agent definition 1.3.0) under the route policy above;
  the KYC and KYB agentic flows bind it like `contract_extract`.
- **`document.fields.contract_extract` takes the classifier's output** (`classifications`, the
  `document.classify.catalog` payload) and extracts every classified document in one execution. An
  `UNKNOWN` document is not extracted: it becomes a `DOCUMENT_CLASSIFICATION` work item and makes the
  result `NEEDS_EVIDENCE`.
- **KYC v2** (`domains/archive/kyc-v2-deterministic/source/kyc-workflow.json`, 28 library steps) and **KYB** (the library's
  synthetic KYB template, 33 steps) run `document-classify-catalog` → `document-fields-contract-extract`
  → `document-validity-assess` → `document-consistency-assess` after the canonical document steps.
  The extraction node binds `classifications` from the classifier's payload and `subject` from
  `subjects.0.subject_id`, fails closed when either is unbound, and is granted only the proposal
  commands. The validity and consistency nodes read the ExtractedAssertion records it committed, in
  the same run.
- `scripts/sync-library-all.sh` regenerates everything derived from the library, in order. Use
  `--check` to fail on the first stale artifact.

## Requirements policy and provider bindings

**Requirements.** `document.requirements.resolve` reads `document_requirements`, a list of any-of
groups, from the pinned policy's `ehf.document` extension. The Policy context type is shared and
closed, so the field cannot go on it directly. Each flat `required_document_types` entry is a group
of one. A group is satisfied when any accepted catalog type is among the classified documents. An
uncataloged type is never satisfied. `request_types` lists the accepted types of every unsatisfied
group, for `document.request.compose`. In KYC, `domains/kyc/policy/catalog/document-requirements.yaml`
maps the documentary obligations (`EVD-CIP-IDENTITY-DOCUMENT`, `EVD-CIP-ADDRESS`, `EVD-CIP-TIN`) to
accepted catalog types. It is a **draft for the policy owner** (owner input D05, status
`draft_pending_owner_review`). `scripts/sync-kyc-package.mjs` puts it into the requirements node's
pinned policy, and `apps/control-api/src/kyc-package.test.ts` checks that every type exists in the
catalog and every obligation in `evidence-obligations.yaml`. KYC v2 runs `document-requirements-resolve`
(package `individual`) and `document-request-compose` after the consistency step. Composing a request
sends nothing.

**Providers.**

| Library capability | Platform capability | Default connector | Behavior |
| --- | --- | --- | --- |
| `document.ocr` | `document.ocr.extract.v1` | `evidence:pages` | `GET /v1/documents/{document_id}/pages?sha256=` on `kyc-evidence-server`: the parsed document's numbered page text, refused when the hash differs. Output is the library's response contract, unwrapped. Only artifacts the pipeline parsed (`kyc-evidence-pipeline:<document_id>`) are served |
| `document.fields` | `document.fields.extract.v1` | `openrouter:document_fields.model.document.v1` (one connector per model profile) | `invokeDocumentFieldsModel`: the request's own contract schema and instructions, with the pages as untrusted data, as a structured-output call. Observation paths written in dot or bracket notation (`extracted_fields.accounts[0].currency`) are rewritten to the contract's JSON Pointers before validation; nothing else in the answer is changed. The answer must meet the library's response contract, and the library then re-checks every span against the exact pages it sent. There is **no recorded fallback**: without a credential, or with a `recorded` provider binding, the call fails and the skill reports `NEEDS_EVIDENCE` |

Forensics and tamper detection stay on the INCONCLUSIVE sandbox connectors until a vendor is chosen.

## Integrated workflow and document workspace

The supplied Facet workflow and document applications are references for interaction and functionality. EHF owns the routes, design tokens, identity, contracts and persistence; source-document instructions do not grant authority to change EHF behavior.

- **Authoring:** the workflow canvas supports inline names and notes, contextual insertion, insertion on a selected connection, connections, movement, deletion and layout. Mutations use the server's current revision. A conflict retains the author's text until they explicitly rebase. Inserting on a conditional connection preserves its guard and sibling branches.
- **Execution:** the run detail has an immutable, zoomable graph plus an accessible table and selected-step inspector. States come from recorded attempts and fencing epochs. Users can inspect prior attempts, human handoffs, errors, trace references and step configuration. Missing observations remain “Not observed”; cancellation is a recorded status. Agent and skill links lead to authorized catalog entries.
- **Document evidence:** the case Documents lens opens a resizable source/extraction workspace. It provides document selection, page navigation, original PDFs and images, normalized source text, zoom/fit, annotations, linked source citations, field search and review filtering. Document review uses the full workspace width, with case navigation and intelligence in drawers. Small screens switch between source and extracted data. Document, field, page and view are deep-linkable URL state.
- **Extraction:** fields are grouped by the document catalog contract. Nested object arrays render as tables and can be corrected as JSON. JSON and schema views, original download, JSON/CSV export, copy and share preserve source version and review provenance. Confidence is shown only when recorded. Coordinate overlays use recorded page geometry; text citations always use exact Unicode code-point offsets. No coordinates are fabricated for documents without geometry.
- **Review:** checked, corrected, rejected and reset decisions require a rationale and `case.review`. They are persisted as audited `RecordReview` commands with case-sequence, source-hash and assertion-version preconditions. Corrections supplement immutable assertions. Completing the document requires every current assertion to be checked or corrected. Re-extraction invalidates reviews of changed assertion versions. A correction never accepts a case fact.
- **Catalog:** the Documents catalog retains document families, type contracts, field-library browsing, search, filters, board/table views and provenance. The evidence workspace links directly to the selected document type. Catalog access remains permission-filtered.

### Live API and local setup

`apps/experience-bff` now serves document list/detail/content, upload, review, rerun, run execution and plan/run compositions, with an allow-listed relay for native platform operations. Document records, reviews and sequence are read from one strongly consistent canonical case snapshot. The case API verifies original bytes against their stored hash. Run graph reads are authorized through the run's bound plan, so a run reader does not need unrestricted plan access.

Apply case-store migrations, including `012_document_reviews.sql`, with `pnpm --filter @ehf/case-store migrate`. Start the existing case/control/runtime/gateway services, then `pnpm dev:bff` and `pnpm --filter @ehf/web dev:http`. Mock mode remains available through `pnpm dev:web`.

BFF configuration:

| Setting | Purpose |
| --- | --- |
| `BFF_PUBLIC_ORIGIN` | Exact browser origin used for CSRF validation |
| `CONTROL_API_INTERNAL_URL`, `CASE_API_INTERNAL_URL` | Service endpoints; HTTPS in production |
| `EDGE_SERVICE_TOKEN` or service-specific `*_TOKEN_SCOPE` | Trusted service credential for upstream calls; never exposed to the browser |
| `BFF_LOCAL_SUBJECT`, `BFF_LOCAL_ROLES`, `LOCAL_DEFAULT_TENANT_ID` | Explicit development sign-in identity; local sign-in is disabled in production |
| `CASE_EVIDENCE_MAX_BYTES` | Match the case API's configured file limit; JSON upload limits allow base64 overhead |
| `BFF_DOCUMENT_PLAN_DIGEST` | An admitted document-processing plan; required for live extraction reruns |

Production sign-in uses the configured verified identity ingress. The BFF holds an opaque HttpOnly session cookie and a session-bound CSRF token; it forwards the verified subject, tenant and roles through trusted service credentials. It does not implement a new OIDC provider or grant authority through browser-supplied actor headers. Session storage is process-local, so production replicas need sticky routing or a shared session-store implementation.

The rerun action uses the compiled **document-reextraction** plan from `scripts/document-extraction-plan.ts`. It verifies and forwards the selected original bytes, not an entire case upload folder. The pipeline is input → hash-bound parsing → catalog classification → contract extraction → output. Native preparation supports text-based PDF, TXT/Markdown, HTML and CSV. Scans, images and PDFs without a usable text layer go through the configured layout provider (below); the evidence pipeline itself has no OCR and reads no provider setting. Supplied page dimensions and regions are retained only when their coordinate basis is usable. Its model dependency uses the administered `model.document.v1` document-fields connector; no recorded fallback is permitted for document fields.

Before starting the run, the BFF records a human `DOCUMENT_EXTRACTION_AUTHORIZATION` review requiring `case.review` as well as `run.start`. This binds the case, document ID, original evidence ID, source hash, admitted plan and retry key. Native case-store checks that grant against the immutable run input. Secondary execution reads are projected to the selected document, and writes are limited to its DocumentVersion, DocumentPage and unverified ExtractedAssertion records, evidence links and manual document-review work. It cannot supersede another document's record, promote a fact or dispatch another skill. Active leases, cancellation and fencing still apply; the case's root plan and policy authority are retained. Nested field arrays are persisted as reviewable assertion units with their validated leaf citations.

The runtime migration `042_document_extraction_authority.sql` adds narrow security-definer lookups. A deployment using a restricted Case API execution database principal must grant that principal schema usage and EXECUTE on these functions (no runtime table SELECT is needed):

```sql
GRANT USAGE ON SCHEMA harness_runtime TO your_case_execution_role;
GRANT EXECUTE ON FUNCTION harness_runtime.document_extraction_run(text,text,text,text) TO your_case_execution_role;
GRANT EXECUTE ON FUNCTION harness_runtime.document_extraction_plan(text,text) TO your_case_execution_role;
```

Local preparation, with the EHF database URL supplied through the environment:

```sh
pnpm db:migrate
pnpm documents:compile
pnpm documents:prepare
pnpm dev:bff:documents
```

`documents:prepare` is restricted to a local database. It admits the verified native plan, registers its exact skill bundle lock, registers a **development release candidate** backed by `artifacts/document-extraction.validation.json`, and saves the plan digest and local database URLs in ignored `.env.local`. Existing settings are preserved. `dev:bff:documents` loads that file; other services can load it through their existing environment setup. The candidate and bundle require approval by an identity other than `codex:document-integration`; preparation never approves itself. Activate the approved development release through the normal Releases flow. Bundle approval is `POST /v1/registry/skill-bundles/{digest}/approve`, requiring `release.approve`. Configure the existing evidence pipeline, skill host, gateway callback/broker, runtime credentials and model provider before executing. An absent binding, pending release, unapproved bundle or missing provider credential fails explicitly.

### Policy tree adaptation

The `facet-policy` download supplied interaction references: selectable cards, AND/OR grouping, graph navigation and a node inspector. Its demo evaluator, sample policy, generated Rego and editing authority were not imported. `apps/web/src/policies` projects EHF's canonical Policy and DecisionTable sources into read-only trees and keyboard-accessible outlines using EHF components and design tokens. It preserves source row order and hit policies, defaults, nested assertions, declared failure outcomes, rule priorities, table references and exact source pointers. The inspector retains the complete source for each node; evaluation stays in the native policy engine.

The viewer is available in Policy Studio's **Tree viewer** tab and the policy catalog's **Policy tree** detail view. Studio can follow table references and return to the selected YAML source. The catalog now includes the root acceptance policy and its declared table relationships. Parsing has source-size, node-count, alias and nesting limits; malformed or unsupported sources retain their original contract view.

### Verification

Playwright covers inline workflow editing, guarded edge insertion, revision conflicts, read-only roles, source/field linking, audited correction, deep links, mobile switching, multi-page PDF rendering and the run table/inspector. Those journeys include WCAG checks. Unit tests cover attempt/epoch selection, source geometry, review invalidation, structured corrections and safe CSV exports. `e2e/live/document-workspace.test.ts` and `e2e/live/document-extraction.test.ts` exercise BFF → native control/case APIs → PostgreSQL in isolated schemas when `EHF_TEST_DATABASE_URL` is set, including persistence, idempotency, stale versions, CSRF, upload and case-scoped original bytes.

## Open items

- The prepared skill bundle and development release need independent approval before execution; preparation registers them without granting execution authority.
- In cases on the v2 decision contract (the agentic KYC/KYB plans), `RecordReview`, `ProposeWorkItem` and
  `CompleteWorkItem` are protected commands that need a policy action grant. The document review and re-extraction
  flows do not request one yet, so they work only on v1 cases (the live Phase 4 run used a KYC v2 case).
- No live route conflict has occurred on the pilot documents yet. Conflict resolution is verified through BFF → case
  API → PostgreSQL and in the browser.
- Document requirements for KYC are a draft awaiting the policy owner (D05). KYB still runs on the
  library's synthetic policy pack.
- No document field contract is qualified on real documents. Production needs per-type evaluations
  on authorized samples (kyc `docs/document-field-design.md`, "Qualification work still required").
- The skill host keeps executions in memory and runs them synchronously. A production deployment
  needs a durable execution store, so that a status read after a restart is not a 404.
