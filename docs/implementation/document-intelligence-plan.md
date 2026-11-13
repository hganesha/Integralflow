# Document intelligence: bringing the kyc code into EHF

Status: plan, 2026-11-08. Nothing in this document is implemented yet.

Source reviewed: `hganesha/kyc` at `3d6db6f` (main, including PR #2 "document field catalog").

Decisions already made:

1. All kyc code moves into this repository. EHF stops depending on a sibling `../kyc` checkout or a
   separately built kyc container.
2. Wrapper skills are allowed. A wrapper is a new, separately versioned skill that composes an
   existing skill with additional steps. It never changes a released skill's contract.

## 1. What kyc contains

| Part | Contents | Size |
| --- | --- | --- |
| `src/financial_crime` | The skill library, release 0.3.0: 222 skills (12 `document.*`), executor, context compiler, store, providers, EHF bridge (`ehf.py`), skill host and bridge host | ~5.8k lines of Python, 6.7 MB of resources |
| `src/kyc_documents` | **New.** Document field contracts: 293 document types in 38 families, 236 shared fields, 21 nested structures, 4,413 field assignments, 20 entity packages, 13 review events. Compiles schemas and instructions, computes a contract hash, and validates extraction results against source spans | ~1.8k lines of Python, 672 KB of resources |
| `catalog/documents/<type>/` | Generated per-type `fields.json`, `extraction.schema.json`, `instructions.md` (894 files) | 20 MB |
| `skills/`, `catalog/`, `schemas/`, `profiles/`, `tasks/`, `policies/`, `workflows/` | Skill packages and generated catalogs | 5.5 MB of skills |
| `tests/` | 2,002 tests, 331 of them for documents | |
| `docs/` | Document field design, context mapping and gaps, field catalog index, UI build spec, UX spec | |

The document field contracts (`kyc_documents`) are what turn document handling from "classify by keyword,
extract `Label: value` lines" into a complete, typed extraction contract. Key properties, which this plan
preserves:

- Every result binds the document type, profile version, contract hash, document version and source digest.
- Every selected key is emitted. Each leaf has one observation with a status (`present`, `not_present`,
  `illegible`, `redacted`, `ambiguous`, `not_applicable`) and exact Unicode code-point spans.
- `validate_extraction` is deterministic and makes no model or network calls. Results are always
  `review_required: true`, `promotion_allowed: false`, `semantic_verification: not_performed`. Status is
  `FAILED`, `NEEDS_EVIDENCE` (key-field gap) or `NEEDS_REVIEW`. Never completed verification.
- 13 fields declare candidate canonical destinations (`Entity.name`, `Registration.*`, `OwnershipInterest`,
  `BeneficialOwner`, `SourceOfFunds.claim`, …). They are mapping candidates, never records.
- `kyc_documents` does no OCR and runs no model. It is not wired to `document.fields.extract`, on purpose: replacing that skill's output
  would break its released contract. Wrappers solve this (section 4).

## 2. What EHF has today

- **Partial copies of kyc, at two versions.** The root `catalog/`, `schemas/`, `profiles/` and `tasks/` match kyc 0.3.0
  byte for byte. `config/skill-library/catalog.json` and `config/business-skills.json` are still 0.2.0.
  `packages/library-contracts/src/vendor/` holds the provider schemas. `docs/new-ui/` is a copy of the kyc docs.
  None of the Python source is here.
- **Execution goes through an external Python host.** `@ehf/fincrime-integration` (`FinancialCrimeClient`) and the
  `skills` gateway adapter call it over authenticated HTTP. `scripts/smoke-fincrime.ts` needs `../kyc`.
- **Workflows use 3 of the 12 document skills.** KYC v2 and KYB run `document.classify`, `document.fields.extract`
  and `document.evidence.link`.
- **Binary documents go to doc-resolve.** The `evidence:*` adapters call the sibling doc-resolve service, and
  `normalizeEvidencePackage` (`packages/adapters/src/canonical-records.ts`) builds DocumentPage records. Those
  pages contain only the cited quotes, not the full page text.
- **Providers are mostly unbound.** Forensics and tamper detection are simulators. `document.entities.extract.v1`
  and `document.translate.v1` have no binding. `identity.ocr.extract.v1` is a placeholder.
- **case-api** has `evidence:register` and an evidence read endpoint, but no document or version model and no upload.
- **UI:** `apps/web` is a scaffold.
- **Document universe as prose.** `docs/document-evidence/document-evidence-canonical` is the prose document
  universe that `kyc_documents` was authored from (`conversation:kyc-document-universe-2026-11-07`).
  `docs/docu-evidence/` duplicates it and adds a stray `.textClipping`.

## 3. Target layout

```
apps/fincrime-host/              Python service (moved from kyc), the single source of truth
  pyproject.toml, requirements-*.lock
  src/financial_crime/           skill library + EHF bridge + host
  src/kyc_documents/             document field contracts
  skills/  policies/  workflows/  examples/  scripts/  tests/
  package.json                   thin: `check`, `test`, `catalog` scripts call the venv, so `pnpm check` covers Python
  Dockerfile                     the host image, built by scripts/publish-images.sh
packages/document-contracts/     TypeScript: loads the compact document catalog and field library, exposes
                                 types and contract lookups for the gateway, BFF and UI; no second validator
```

Generated outputs (`catalog/*.json`, `config/skill-library/`, `config/business-skills.json`,
`packages/library-contracts/src/vendor/`) are regenerated from `apps/fincrime-host` by one script and checked
for drift in CI. The root `catalog/`, `schemas/`, `profiles/` and `tasks/` copies are removed once nothing reads
them.

The extraction validator stays in Python only. It is the only implementation, and it runs inside the wrapper
skill, so the gateway receipt already covers it. A TypeScript port would be a second oracle to keep in sync.

The 894 per-type files (20 MB) are not committed. They are generated by `kyc-documents export` and checked in
CI. The compact resources (672 KB) are committed. *(Open question 2.)*

## 4. Wrapper skills

Wrappers are registered in the same library (`financial_crime/skills/document_wrappers.py`) with
`composition_type: composite`. The catalog pins them by instruction and code hash like every other skill,
so they go through the same admission, receipt and replay path. Base skills keep their 0.2.0 contracts.

| Wrapper (new ID) | Wraps | What it adds |
| --- | --- | --- |
| `document.parse.artifact` | `document.parse` | Takes an authorized DocumentVersion artifact. Calls the OCR/parse capability. Returns full-text DocumentPages with parser version, geometry lineage and binary hash as extensions. Text-only input still uses the base skill |
| `document.classify.catalog` | `document.classify` | Classifies into the 293 catalog types (IDs and aliases) using a model provider with page spans. Falls back to the base keyword rules. Ambiguous stays `UNKNOWN` |
| `document.fields.contract_extract` | `document.fields.extract` | Resolves the profile, compiles the contract and hash, and sends schema, instructions and pages to a model capability. Runs `validate_extraction`. Returns candidate assertions, mapping candidates, issues and status. Never promotes |
| `document.validity.assess` | `document.validity.check` | Uses extracted issue and expiry dates with their precision. Keeps unknown or absent expiry distinct from expired. Calls the base skill only when both dates are complete |
| `document.consistency.assess` | `document.consistency.check` | Compares candidate assertions by catalog field path across documents. Keeps nested rows (ownership edges, parties) as units |
| `document.requirements.resolve` | `document.requirements.evaluate` | Resolves a case's applicable documents from entity packages, review events and policy into the base skill's flat list, plus key fields per type |
| `document.request.compose` | `document.request.generate` | Writes request text from catalog display names and key fields. Sending stays a separately approved held effect |

Untouched: `entities.extract`, `authenticity.assess`, `translation.normalize`, `evidence.link` and
`version.compare` are used as they are, with providers bound in Phase 5.

## 5. Context and record changes

These come from the gaps listed in kyc `docs/document-context-mapping.md`.

> **Implemented differently (Phase 1):** the core context types stay at 2.0.0. Lifecycle and
> provenance go into versioned `extensions`, and `Document` is emitted only when both dates are stated.
> All 222 skills share those types, so changing them would change every skill's contract. See
> [document-intelligence.md](document-intelligence.md#records).

- **Document lifecycle.** Issue and expiry dates can be unknown, date-only or partial, and "no stated expiry" is
  separate from "expired". Never invent an expiry.
- **Extraction provenance.** An `ehf.document/v1` extension on ExtractedAssertion carries the catalog field path,
  raw and normalized values, spans, observation status, contract ID/version/hash, provider/model invocation and
  review state.
- **DocumentVersion.** `artifact_hash`, `artifact_ref` (case-store evidence store), `media_type`, `page_count`,
  parser/OCR version.
- **`document.intelligence` context product** gains the extension fields and catalog type.
- **Not in scope:** the larger missing record types (trusts as fiduciary arrangements, account mandates, CRS/FATCA tax
  profiles, financial statements, wealth chronology). Their fields stay in typed extracted assertions until a
  record type is designed separately. Nothing is discarded for lack of a mapping.

## 6. Phases

Each phase ends with `pnpm check` green, including the Python tests.

**Phase 0: Move the code in (no behavior change).**
- Copy kyc into `apps/fincrime-host`, keeping its history if possible (`git subtree add` or a filtered merge).
- Add the Python CI job: locked install, `make check` (catalog drift, document catalog drift, 2,002 tests).
- Build the host image from this repo and point `compose.yaml` and `scripts/smoke-fincrime.ts` at it.
- Add one generator for the vendored catalogs. Bring `config/skill-library` and `config/business-skills.json`
  up to 0.3.0. Delete the root copies and `docs/docu-evidence/`. Fold `docs/new-ui` kyc-only docs into
  `apps/fincrime-host/docs`.
- *Accept when:* the smoke passes with no `../kyc`, and the plan and catalog digests are unchanged apart from the
  intended 0.2.0 → 0.3.0 move.

**Phase 1: Document records end to end.**
- case-api: document upload and version endpoints. Bytes go into the content-addressed evidence store, and a
  DocumentVersion record is written through the business command path.
- `normalizeEvidencePackage`: emit Document, DocumentVersion and full-text DocumentPage. Keep `text_basis`, and
  label results from quote-only pages as partial.
- Context schema 2.1.0 and migration (section 5).
- *Accept when:* a fixture document produces Document, DocumentVersion and DocumentPage with a matching source digest.

**Phase 2: Wrapper skills.**
- Implement the seven wrappers in section 4, with tests built on the six kyc golden fixtures (passport, bank
  statement, commercial invoice, shareholder register, trust deed, W-8BEN-E) plus negative and prompt-injection cases.
- Regenerate the catalog. Register the new provider capabilities (`document.fields.contract_extract`,
  `document.classify.catalog`) in `library-contracts`.
- *Accept when:* every wrapper is pinned in the catalog, and validation failures yield no candidate assertions.

**Phase 3: Commit path and review.**
- Candidate assertions become ExtractedAssertion CanonicalRecord proposals through the existing skill-commit path.
- Mapping candidates and key-field gaps become human-work items. Nothing moves to a verified fact without a
  corroboration step and an authorized decision.
- *Accept when:* the case ledger shows proposals with contract hash and spans, and promotion is refused without
  a decision.

**Phase 4: Agent, task and workflows.**
- Add `agent.document_intelligence` and `task.document_intelligence` (A03), owning the `document.intelligence`
  product and the wrapper and base document skills. Narrow `agent.intake_profile` to requirements and requests.
- KYC v2 and KYB: replace the three current nodes with requirements.resolve → parse.artifact → classify.catalog →
  fields.contract_extract → evidence.link → validity.assess → consistency.assess. Translation runs only when
  needed. Tamper and authenticity run on the risk/EDD branch. Documents run in parallel with registry checks.
  Recompile the plans.
- Extend the smoke from 6 tasks to 7.

**Phase 5: Policy and providers.**
- Requirements policy: compile entity packages, review events and institution rules into the OPA bundle, with
  golden-decision cases. No default confidence cutoffs. A `ConfidencePolicy` is admitted only with a
  qualification reference.
- Bind the extraction and classification model capabilities to gateway model profiles (recorded mode with no key,
  fail closed under production). Bind OCR to doc-resolve `ingest`. Forensics and tamper stay simulators until a
  vendor is chosen.

**Phase 6: UI** (can start against mocks once Phase 1 shapes are fixed).
- Intake: requirement checklist from `requirements.resolve`, submitted-document tracker, upload.
- Case room evidence section: page viewer with span highlights per observation, status chips, and an
  "extracted, unverified" label on every value.
- BIZ-03 reconciliation: registry vs declaration vs extracted assertion.
- Experience API contract: document, version, page and assertion endpoints. Mock fixtures from the golden examples.

**Phase 7: Qualification** (separate from this build). One document type and one real population at a time, as
kyc `docs/document-field-design.md` describes. Field accuracy, span accuracy, missingness and negative cases.
No production release before this.

Order: 0 → 1 → 2 → 3 → 4, with 5 alongside 3–4 and 6 alongside 2–5.

## 7. Open questions

1. **Sibling services:** should doc-resolve (`kyc-evidence-pipeline`) and data-adapters (`api-wiring`) also move
   in under "all code comes into EHF"? This plan currently keeps them as sibling services behind the
   `kyc-adapters` compose profile.
2. **Generated assets:** commit the 20 MB of per-type generated files, or generate them in CI (recommended)?
3. **Afterwards:** archive the kyc repository read-only once Phase 0 lands, or keep it for the UI design docs?
