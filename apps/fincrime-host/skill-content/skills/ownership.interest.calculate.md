## Business outcome

Calculate exact path products; cyclic/unaccounted interests remain unresolved. Use `ownership.interest.calculate` for this bounded operation in the parent business workflow. The supplied context must come from authorized canonical producers. A result describes the admitted records as of the invocation time; it does not independently establish facts outside those records.

## Procedure

1. Identify the target subject/relationship and the workflow requirement this operation addresses. Confirm that its required inputs are present: OwnershipInterest (owner, owned, interest). Preserve gaps instead of copying values from an unrelated party or historical assessment.
2. Validate `target` against the input contract. Resolve the pinned policy fields only the declared authorization/freshness fields. Unsupported applicability or a missing required rule must remain visible; use only the handler's defined result or error, never a model-invented default.
3. Perform the stated bounded behavior: Calculate exact path products; cyclic/unaccounted interests remain unresolved. Execute the registered implementation rather than recreating financial calculations or verification in model prose. Shared helper logic does not grant permission to invoke undeclared providers.
4. Inspect `interests`, `paths`, `cycles`, `unresolved`. Retain uncertainty, candidates, conflicts and supporting record references. Check the actual payload meaning before the workflow treats execution completion as satisfying its requirement.
5. Hand off unresolved evidence or judgment to the appropriate producer/reviewer. Effects mode is `read_only`: proposed or queued changes require the executor's effect controls, and human-gated work cannot execute on the strength of this document.

## Evidence and uncertainty

Use only selected source versions and their admitted policy/context basis. Preserve original values alongside normalization and derived results. Evidence references locate support; they do not by themselves prove authenticity, identity or semantic truth. `COMPLETED` means execution completed under this contract; the parent workflow must inspect the business payload and remaining requirements.

## Variations

Apply the domain guidance below to institution, legal form/role, product, jurisdiction, lifecycle, source and time. Only combinations supported by the pinned policy, data contracts and qualified integration may be selected. Unknown applicability is a review/evidence gap. Provider coverage and verification standards are configuration/evidence, not assumptions inferred from a vendor or document name.

## Examples and acceptance

- Normal input, target acme: hold 60% of acme, alice and bob 50% each of hold, carol 40% direct give alice `0.30`, bob `0.30`, carol `0.4`, paths such as `[acme, hold, alice]`, nothing unresolved, `COMPLETED`.
- Exact decimals: 30% × 30% × 30% is exactly `0.027`; 15% direct plus 50% × 20% indirect aggregates to `0.25` with both paths kept.
- Incomplete graph: acme only 70% held gives `UNACCOUNTED_INTEREST` 0.3 at acme; a target with no edges gives `NO_EDGES`; both are `PARTIAL`.
- Cycle or range: the cyclic share is not distributed and a `CYCLE` gap with path `[acme, hold, acme]` is reported; an OwnershipRange (b holds 10–30%) gives b no interest and an `OWNERSHIP_RANGE_REQUIRES_RESOLUTION` gap; both are `PARTIAL`.
- Contradictory input: direct holdings summing above 100% (0.7 + 0.4) fail with `SOURCE_CONFLICT` / `NEEDS_REVIEW`; a chain deeper than the traversal limit (25 layers) gives a `DEPTH_LIMIT` gap and the deepest owner is not reported.

## Limitations

This package is an implemented synthetic reference, not a qualified production service. Its scope is the behavior stated above and the typed input/output contracts. Independent representative evaluation, approved institution policy and supported source mappings remain required. No independent real-source accuracy or institution-specific acceptance authority is established by the bundled examples.
