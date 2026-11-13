## Business outcome

Evaluate the pinned synthetic threshold, preserving exact decimal comparisons. Use `ownership.threshold.evaluate` for this bounded operation in the parent business workflow. The supplied context must come from authorized canonical producers. A result describes the admitted records as of the invocation time; it does not independently establish facts outside those records.

## Procedure

1. Identify the target subject/relationship and the workflow requirement this operation addresses. Confirm that its required inputs are present: the admitted identity and pinned policy. Preserve gaps instead of copying values from an unrelated party or historical assessment.
2. Validate `interests` against the input contract. Resolve the pinned policy fields `ownership_threshold`. Unsupported applicability or a missing required rule must remain visible; use only the handler's defined result or error, never a model-invented default.
3. Perform the stated bounded behavior: Evaluate the pinned synthetic threshold, preserving exact decimal comparisons. Execute the registered implementation rather than recreating financial calculations or verification in model prose. Shared helper logic does not grant permission to invoke undeclared providers.
4. Inspect `qualifying`, `threshold`. Retain uncertainty, candidates, conflicts and supporting record references. Check the actual payload meaning before the workflow treats execution completion as satisfying its requirement.
5. Hand off unresolved evidence or judgment to the appropriate producer/reviewer. Effects mode is `read_only`: proposed or queued changes require the executor's effect controls, and human-gated work cannot execute on the strength of this document.

## Evidence and uncertainty

Use only selected source versions and their admitted policy/context basis. Preserve original values alongside normalization and derived results. Evidence references locate support; they do not by themselves prove authenticity, identity or semantic truth. `COMPLETED` means execution completed under this contract; the parent workflow must inspect the business payload and remaining requirements.

## Variations

Apply the domain guidance below to institution, legal form/role, product, jurisdiction, lifecycle, source and time. Only combinations supported by the pinned policy, data contracts and qualified integration may be selected. Unknown applicability is a review/evidence gap. Provider coverage and verification standards are configuration/evidence, not assumptions inferred from a vendor or document name.

## Examples and acceptance

- Normal input: interests alice `0.30`, bob `0.30`, carol `0.4` with policy `ownership_threshold` `0.25` give `qualifying: [alice, bob, carol]`, `threshold: "0.25"`, `COMPLETED`.
- Exact boundary: `0.25` qualifies at `0.25`; `0.2499` does not.
- Incomplete interests: alice `0.6` alone leaves `0.4` unaccounted, which could be a qualifying owner: `qualifying: [alice]`, `PARTIAL` with an `EVIDENCE_INSUFFICIENT` item. Alice `0.2` and bob `0.7` is also `PARTIAL` (0.1 unaccounted could lift alice to 0.3). Alice `0.1` and bob `0.85` is `COMPLETED` with `[bob]`: 0.05 unaccounted cannot lift anyone to 0.25.
- Missing evidence: an empty `interests` map is `EVIDENCE_INSUFFICIENT` / `NEEDS_EVIDENCE`, never "nobody qualifies".
- Contradictory input: interests summing above 1 (0.7 + 0.4) are `SOURCE_CONFLICT` / `NEEDS_REVIEW`.
- Policy unresolved: no `ownership_threshold` is `POLICY_UNRESOLVED` / `BLOCKED`.

## Limitations

This package is an implemented synthetic reference, not a qualified production service. Its scope is the behavior stated above and the typed input/output contracts. Independent representative evaluation, approved institution policy and supported source mappings remain required. No independent real-source accuracy or institution-specific acceptance authority is established by the bundled examples.
