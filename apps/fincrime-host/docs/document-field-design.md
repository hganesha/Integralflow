# KYC document field contracts

Version 0.1.0 · 2026-11-08 · Draft semantic field contracts

This work identifies the important extractable fields across the document universe discussed for individuals, businesses, beneficial ownership, trusts, tax, EDD and ongoing review. It supplies portable field definitions, instructions, schemas and deterministic validation. It does not implement OCR, run a model, determine which documents a jurisdiction requires, or certify real-world extraction quality.

## Design reference: DocuBricks

Reviewed repository: [hganesha/DocuBricks](https://github.com/hganesha/DocuBricks/tree/3de54e97437d284ea898a2e0e4367efd1ba97851), revision `3de54e97437d284ea898a2e0e4367efd1ba97851`.

The implementation and architecture proposal were read separately. The v2 architecture is a proposal, not evidence that every proposed feature is running. This package adopts the useful authoring structure without copying provider defaults, arbitrary confidence cutoffs, SQL execution rules or regulatory assertions from that repository.

| DocuBricks pattern | Application here |
| --- | --- |
| Canonical `fields.json` inventories | Shared authored semantic library plus an explicit selection for every document type |
| Sections and field categories | Authored sections; sensitivity and semantics are explicit rather than inferred from field names |
| Repeatable `item_schema` | Closed, named nested structures for parties, ownership edges, accounts, financial lines, control rights and other rows |
| Completeness checklist | Selected keys must be emitted; absent source values remain null with a status; key-field gaps require policy-specific review |
| Extraction prompts | Generated from the same field definitions, version-bound and hashed with their contract |
| Per-field confidence settings | No default acceptance thresholds; an optional external policy identifies its own evaluation reference and cutoffs |
| Golden cases | Six authored synthetic source/answer fixtures prove contract and span behavior; real extraction evaluations are still required |
| Versioned schema bundle | Independent field catalog version, deterministic artifacts and a drift check |

Inspected sources include `docs/schema-authoring.md`, `docs/schema-architecture-v2.md` and the KYC/CDD, trust-account, merchant-onboarding and invoice schema assets. The resulting field definitions are new KYC-specific authoring, not an import of the older flat KYC form.

## Coverage and review

- **293 document/evidence types in 38 families.** Variants remain distinct where their meaning differs, including CBDDQ versus FCCQ and the different W-8 forms.
- **236 shared top-level semantic fields; 21 closed nested structures with 160 member declarations.** A shared field can appear in several document types; this is reuse, not another distinct concept.
- **4,413 document-to-field assignments** across the first authored catalog.
- **21 coverage categories**, traceable to the earlier document universe.
- **20 candidate entity packages** and **13 event-driven refresh selections**. These provide discovery options, not mandatory or sufficient collection checklists.

Start with the [document index](document-field-catalog.md). Each row links to its detailed fields, output schema and instructions. [Coverage](../src/kyc_documents/resources/coverage.json) maps the earlier categories to document IDs. The [shared library](../src/kyc_documents/resources/field-library.json) includes descriptions, types, normalization rules, sensitivity and candidate context destinations.

Key fields are evidence-review anchors. A certificate may omit one, and a task may legitimately use only a subset. Absence produces a review gap rather than a fabricated value or an assertion of legal noncompliance. The first draft deliberately exposes more possible evidence than a single institution should collect from every applicant.

## Authoring and files

Authoritative source files:

- `src/kyc_documents/fields.py`: shared semantic fields, nested types, descriptions and conservative classifications.
- `src/kyc_documents/profiles.py`: document-specific selections, review anchors, aliases, notes, coverage and candidate packages.
- `src/kyc_documents/runtime.py`: schema/instruction compilation, contract hashing and source/result validation.
- `src/kyc_documents/model.py`: closed result, observation, source-page and optional confidence-policy contracts.
- `scripts/document_catalog_examples.py`: authored synthetic source/answer pairs.

Generated assets. The compact resources are committed; the per-type bundle is generated on demand
(`python scripts/build_document_catalog.py --export <dir>` or `kyc-documents export --output <dir>`) and is not committed:

```text
src/kyc_documents/resources/      # committed, loaded at runtime
  catalog.json                    # identities, versions, hashes, provenance, qualification
  field-library.json              # all semantic fields and nested definitions
  coverage.json                   # prior category -> document types
  entity-packages.json            # candidate evidence options by legal structure
  review-events.json              # candidate refresh options by event
<export dir>/<document_type>/     # generated, not committed
  fields.json                     # sections, fields, nested types, key fields, checklist
  extraction.schema.json          # complete, closed extraction response
  instructions.md                 # extraction instructions from the same source
```

Build with `make documents` or `python scripts/build_document_catalog.py`. Use `--check` to detect stale or unexpected committed assets; it also renders the full bundle in memory. `make check` checks both the skill catalog and the document catalog and runs the tests. The existing skill bundle remains separately hashed and its contracts are unchanged.

The installed wheel includes the `kyc_documents` package and compact catalog/library/coverage resources. Schemas and instructions can be compiled or exported outside the repository. No additional dependencies beyond the project's existing Pydantic and JSON Schema packages are required. No model endpoint or cloud credential is embedded.

## Extraction contract

Every result binds:

1. Canonical document type and profile version.
2. Hash of the selected field definitions, nested schemas and instructions.
3. Exact document version and digest of the captured source pages.
4. `extracted_fields`, with every selected key emitted, including nested members.
5. One observation for every scalar, null, string-list member or explicitly empty list.

Observation status distinguishes present, not present, illegible, redacted, ambiguous and not applicable. Present values require exact page/character spans. Source offsets are **Python Unicode code points**, start inclusive/end exclusive, in the supplied decoded text version. OCR geometry and binary-artifact hashes belong to the upstream parser/document store; this package does not fabricate them.

Money and percentages use decimal strings, not binary floating-point numbers. Ownership percentages use the source's 0–100 percent scale, preserve their basis and are not indirect-ownership calculations. Partial dates retain year or month precision. Invalid calendar dates are rejected. Ambiguous dates, currencies and identifiers stay unresolved; masked identifiers remain masked. Source-stated booleans and empty lists need explicit evidence.

Financial statements preserve currency, source scaling and consolidated/standalone basis. Trusts preserve role, power and beneficiary-class distinctions. Declared beneficial owners, risk scores, PEP status, provider results and historical approvals remain attributed source claims.

## API and CLI

```python
from kyc_documents.runtime import contract, extraction_schema, source_digest, validate_extraction

specification = contract("shareholder_register")
schema = extraction_schema("shareholder_register")

# The host obtains authorized, version-pinned source pages independently of
# the model output. This function is not an authorization or retrieval service.
pages = [{"page_id": "page-1", "document_version": "version-7", "text": "..."}]
digest = source_digest(pages)

# Send only the admitted fields, instructions and source pages to an approved
# extraction provider, then validate its response. No provider is invoked here.
# report = validate_extraction("shareholder_register", provider_result, pages)
```

```sh
kyc-documents list --coverage 11_trust
kyc-documents show trust_deed
kyc-documents schema w8bene
kyc-documents export --output /tmp/kyc-document-contracts
kyc-documents audit
```

`python -m kyc_documents.cli` provides the same commands without installing the console script. `validate` takes `--result` and `--pages` JSON files and optionally `--confidence-policy`. Exit status 1 means a result failed validation; status 2 means an input/configuration error. All results retain `review_required: true` and `promotion_allowed: false` while these contracts remain drafts.

Report status is `FAILED` for structural/integrity failures, `NEEDS_EVIDENCE` for key-field gaps, and otherwise `NEEDS_REVIEW`. A valid result is never reported as completed business verification.

## Validation and interpretation

The deterministic validator rejects unknown fields, malformed nested rows, stale contracts, source/version mismatches, invalid spans, missing or duplicate observations, inconsistent missingness, invalid dates and unsupported numeric shapes. A fatal integrity error yields no candidate assertions.

It reports review gaps for absent key fields and literal-to-normalized value differences. Optional caller-supplied confidence policies can add review findings, but a reference string does not itself prove a policy is qualified or authorized. Host admission remains necessary.

**An exact source span proves the location of a quote. It does not prove that a model interpreted the quote correctly, that a document is authentic, or that a claim is true.** `semantic_verification` is explicitly `not_performed`. A syntactically valid assertion remains `UNVERIFIED`; it never changes a canonical record or commits an action.

## Connecting skills and runtimes

The sidecar is importable and portable, but is not automatically dispatched by the existing `document.fields.extract` skill. That skill currently extracts explicit `label: value` lines using its existing API. Replacing its output or silently extending its request schema would break the released skill contract.

An integration should:

1. Admit the document type/version, task purpose, field allowlist, source versions and extraction provider.
2. Compile the selected contract and preserve its hash; use a separately versioned profile if the institution needs a narrower field selection.
3. Parse/OCR the authorized artifact, retaining binary/version hashes and page/geometry lineage.
4. Invoke a qualified provider with source content treated as untrusted data.
5. Validate structured output and spans, route gaps and semantic ambiguity to review, and retain the execution trace.
6. Commit proposed evidence/assertions through the governed case/evidence service.
7. Corroborate claims and perform policy checks before authorized canonical fact promotion.

These steps are runtime-neutral and can be called from EHF, the skill.execution.v1 host or another admitted executor. No automatic provider deployment or skill registration is included. See [context mapping and gaps](document-context-mapping.md).

## Qualification work still required

The next qualification unit is one document type and one actual document population: issuer/jurisdiction, form edition, language, delivery channel and scan quality. Use authorized real or independently annotated representative documents, field-level accuracy metrics, source-span accuracy, missingness and negative cases. Include masked IDs, ambiguous dates/currencies, amended legal instruments, multi-page tables, indirect ownership and prompt-injection content.

The six synthetic fixtures and contract tests do not measure OCR accuracy, recall, model hallucination rates, authenticity detection, or legal sufficiency. Institution-specific collection and acceptance policy, edition-specific tax-form coverage, provider/model routing, calibrated confidence thresholds, independent reviews and production release gates remain separate work.
