## Business outcome

Return a document version's full page text with lineage, from admitted full-text pages or an admitted OCR provider, and say whether every page is present. Use `document.parse.artifact` for this bounded operation in the parent business workflow. The supplied context must come from authorized canonical producers. A result describes the admitted records as of the invocation time; it does not independently establish facts outside those records.

## Procedure

1. Identify the target subject/relationship and the workflow requirement this operation addresses. Confirm that its required inputs are present: DocumentVersion (document_id, artifact_hash, media_type, artifact_ref, page_count). Preserve gaps instead of copying values from an unrelated party or historical assessment.
2. Validate `document_version` against the input contract. Resolve the pinned policy fields `permitted_providers`. Unsupported applicability or a missing required rule must remain visible; use only the handler's defined result or error, never a model-invented default.
3. Perform the stated bounded behavior: Return a document version's full page text with lineage, from admitted full-text pages or an admitted OCR provider, and say whether every page is present. Execute the registered implementation rather than recreating financial calculations or verification in model prose. Shared helper logic does not grant permission to invoke undeclared providers.
4. Inspect `pages`, `parser`, `complete`, `document_version`. Retain uncertainty, candidates, conflicts and supporting record references. Check the actual payload meaning before the workflow treats execution completion as satisfying its requirement.
5. Hand off unresolved evidence or judgment to the appropriate producer/reviewer. Effects mode is `read_only`: proposed or queued changes require the executor's effect controls, and human-gated work cannot execute on the strength of this document.

## Evidence and uncertainty

Use only selected source versions and their admitted policy/context basis. Preserve original values alongside normalization and derived results. Evidence references locate support; they do not by themselves prove authenticity, identity or semantic truth. `COMPLETED` means execution completed under this contract; the parent workflow must inspect the business payload and remaining requirements.

## Variations

Apply the domain guidance below to institution, legal form/role, product, jurisdiction, lifecycle, source and time. Only combinations supported by the pinned policy, data contracts and qualified integration may be selected. Unknown applicability is a review/evidence gap. Provider coverage and verification standards are configuration/evidence, not assumptions inferred from a vendor or document name.

## Examples and acceptance

- Normal input without admitted full-text pages: the OCR provider returns every page with its hash, `text_basis: ocr`, the provider's parser name and version, `complete: true`, `COMPLETED`.
- Admitted full-text pages are used in page order with parser `admitted_pages` and no provider call; pages without a `full_text` basis are ignored.
- Missing evidence: fewer pages than the version's `page_count`, a gap (pages 1 and 3 of 3), an empty OCR result or an unknown page count (`page_count` 0) gives `complete: false`, `NEEDS_EVIDENCE`; pages are not renumbered or filled.
- Contradictory provider output: OCR pages not numbered 1..n in order ([2], [1, 1], [2, 1]) is `INTEGRITY_FAILURE` / `BLOCKED`.
- An artifact hash with no admitted DocumentVersion is `CONTEXT_MISSING` / `NEEDS_EVIDENCE`; no full text and no OCR provider is `SOURCE_UNAVAILABLE` / `NEEDS_EVIDENCE`.

## Limitations

This package is an implemented synthetic reference, not a qualified production service. Its scope is the behavior stated above and the typed input/output contracts. Independent representative evaluation, approved institution policy and supported source mappings remain required. Uses admitted full-text pages when present; otherwise an admitted OCR provider. OCR accuracy is the provider's; local tests use synthetic recordings.
