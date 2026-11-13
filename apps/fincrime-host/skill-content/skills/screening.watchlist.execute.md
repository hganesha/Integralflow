## Business outcome

Evaluate admitted watchlist search records, retain candidates and identify incomplete subject coverage. Use `screening.watchlist.execute` for this bounded operation in the parent business workflow. The supplied context must come from authorized canonical producers. A result describes the admitted records as of the invocation time; it does not independently establish facts outside those records.

## Procedure

1. Identify the target subject/relationship and the workflow requirement this operation addresses. Confirm that its required inputs are present: Entity (name, identifiers). Preserve gaps instead of copying values from an unrelated party or historical assessment.
2. Validate no business parameters against the input contract. Resolve the pinned policy fields `screening_threshold`. Unsupported applicability or a missing required rule must remain visible; use only the handler's defined result or error, never a model-invented default.
3. Perform the stated bounded behavior: Evaluate admitted watchlist search records, retain candidates and identify incomplete subject coverage. Execute the registered implementation rather than recreating financial calculations or verification in model prose. Shared helper logic does not grant permission to invoke undeclared providers.
4. Inspect `hits`, `coverage`, `universal_clearance`. Retain uncertainty, candidates, conflicts and supporting record references. Check the actual payload meaning before the workflow treats execution completion as satisfying its requirement.
5. Hand off unresolved evidence or judgment to the appropriate producer/reviewer. Effects mode is `read_only`: proposed or queued changes require the executor's effect controls, and human-gated work cannot execute on the strength of this document.

## Evidence and uncertainty

Use only selected source versions and their admitted policy/context basis. Preserve original values alongside normalization and derived results. Evidence references locate support; they do not by themselves prove authenticity, identity or semantic truth. `COMPLETED` means execution completed under this contract; the parent workflow must inspect the business payload and remaining requirements.

## Variations

Apply the domain guidance below to institution, legal form/role, product, jurisdiction, lifecycle, source and time. Only combinations supported by the pinned policy, data contracts and qualified integration may be selected. Unknown applicability is a review/evidence gap. Provider coverage and verification standards are configuration/evidence, not assumptions inferred from a vendor or document name.

## Examples and acceptance

- Normal input: an exact-name watchlist match (Ivan Petrov) is a REVIEW hit with score 0.7, `NEEDS_REVIEW`; universal_clearance is always false.
- Only watchlist entries are screened: same-name sanctions and PEP entries are not watchlist hits; with a completed search for every subject the run is `COMPLETED` with no hits.
- Missing evidence: a truncated, failed, unscoped, future-dated or missing search, or a list with incomplete coverage, is `NEEDS_EVIDENCE`, never a completed no-hit.
- Contradictory input: the same name with a different identifier (date of birth) is kept as a REVIEW hit with identifier_conflict true, never cleared or confirmed.
- Policy unresolved: no `screening_threshold` is `POLICY_UNRESOLVED` / `BLOCKED`, no payload. No admitted Entity is `CONTEXT_MISSING`.

## Limitations

This package is an implemented synthetic reference, not a qualified production service. Its scope is the behavior stated above and the typed input/output contracts. Independent representative evaluation, approved institution policy and supported source mappings remain required. Consumes admitted search records; does not acquire lists or query providers. Local matching is an uncalibrated synthetic heuristic, not a match probability. Does not evaluate ownership/control or authorize final disposition.
