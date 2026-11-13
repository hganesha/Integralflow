## Business outcome

Classify each document version into the document field catalog by exact title, name and alias matches with spans; ambiguity stays UNKNOWN. Use `document.classify.catalog` for this bounded operation in the parent business workflow. The supplied context must come from authorized canonical producers. A result describes the admitted records as of the invocation time; it does not independently establish facts outside those records.

## Procedure

1. Identify the target subject/relationship and the workflow requirement this operation addresses. Confirm that its required inputs are present: DocumentPage (text, page, document_version). Preserve gaps instead of copying values from an unrelated party or historical assessment.
2. Validate no business parameters against the input contract. Resolve the pinned policy fields only the declared authorization/freshness fields. Unsupported applicability or a missing required rule must remain visible; use only the handler's defined result or error, never a model-invented default.
3. Perform the stated bounded behavior: Classify each document version into the document field catalog by exact title, name and alias matches with spans; ambiguity stays UNKNOWN. Execute the registered implementation rather than recreating financial calculations or verification in model prose. Shared helper logic does not grant permission to invoke undeclared providers.
4. Inspect `classifications`, `catalog_hash`. Retain uncertainty, candidates, conflicts and supporting record references. Check the actual payload meaning before the workflow treats execution completion as satisfying its requirement.
5. Hand off unresolved evidence or judgment to the appropriate producer/reviewer. Effects mode is `read_only`: proposed or queued changes require the executor's effect controls, and human-gated work cannot execute on the strength of this document.

## Evidence and uncertainty

Use only selected source versions and their admitted policy/context basis. Preserve original values alongside normalization and derived results. Evidence references locate support; they do not by themselves prove authenticity, identity or semantic truth. `COMPLETED` means execution completed under this contract; the parent workflow must inspect the business payload and remaining requirements.

## Variations

Apply the domain guidance below to institution, legal form/role, product, jurisdiction, lifecycle, source and time. Only combinations supported by the pinned policy, data contracts and qualified integration may be selected. Unknown applicability is a review/evidence gap. Provider coverage and verification standards are configuration/evidence, not assumptions inferred from a vendor or document name.

## Examples and acceptance

- Normal input: a page starting "Certificate of incorporation" is `certificate_of_incorporation` with basis `title` and the match span (page 1, characters 0–28), plus the catalog hash, `COMPLETED`.
- A page naming no catalog type is `UNKNOWN` with basis `ambiguous_or_unmatched` and no candidates.
- Ambiguous input: a title naming both a certificate of incorporation and articles of association is `UNKNOWN`, with both candidates and their exact spans.
- A certificate title with a body mention of articles of association stays a certificate by title; the articles are kept as a candidate. Each document version is classified on its own pages.
- Missing evidence: no admitted DocumentPage is `CONTEXT_MISSING` / `NEEDS_EVIDENCE`, no payload.

## Limitations

This package is an implemented synthetic reference, not a qualified production service. Its scope is the behavior stated above and the typed input/output contracts. Independent representative evaluation, approved institution policy and supported source mappings remain required. Deterministic title and alias matching; uncalibrated, no model, no layout. A document naming several catalog types stays UNKNOWN with its candidates.
