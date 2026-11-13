## Business outcome

Expose supported exculpatory evidence alongside unresolved adverse indicators. Use `alert.false_positive.assess` for this bounded operation in the parent business workflow. The supplied context must come from authorized canonical producers. A result describes the admitted records as of the invocation time; it does not independently establish facts outside those records.

## Procedure

1. Identify the target subject/relationship and the workflow requirement this operation addresses. Confirm that its required inputs are present: Finding (status, evidence_ids, claim). Preserve gaps instead of copying values from an unrelated party or historical assessment.
2. Validate no business parameters against the input contract. Resolve the pinned policy fields only the declared authorization/freshness fields. Unsupported applicability or a missing required rule must remain visible; use only the handler's defined result or error, never a model-invented default.
3. Perform the stated bounded behavior: Expose supported exculpatory evidence alongside unresolved adverse indicators. Execute the registered implementation rather than recreating financial calculations or verification in model prose. Shared helper logic does not grant permission to invoke undeclared providers.
4. Inspect `exculpatory`, `contradictory`, `final_clearance`. Retain uncertainty, candidates, conflicts and supporting record references. Check the actual payload meaning before the workflow treats execution completion as satisfying its requirement.
5. Hand off unresolved evidence or judgment to the appropriate producer/reviewer. Effects mode is `read_only`: proposed or queued changes require the executor's effect controls, and human-gated work cannot execute on the strength of this document.

## Evidence and uncertainty

Use only selected source versions and their admitted policy/context basis. Preserve original values alongside normalization and derived results. Evidence references locate support; they do not by themselves prove authenticity, identity or semantic truth. `COMPLETED` means execution completed under this contract; the parent workflow must inspect the business payload and remaining requirements.

## Variations

Apply the domain guidance below to institution, legal form/role, product, jurisdiction, lifecycle, source and time. Only combinations supported by the pinned policy, data contracts and qualified integration may be selected. Unknown applicability is a review/evidence gap. Provider coverage and verification standards are configuration/evidence, not assumptions inferred from a vendor or document name.

## Examples and acceptance

- Normal input: f1 EXCULPATORY citing admitted evidence-1 is in `exculpatory`; `contradictory` []; `final_clearance` false; `COMPLETED`.
- Unsupported: f1 EXCULPATORY citing evidence-9, which is not admitted, is left out of `exculpatory`: `NEEDS_EVIDENCE` with `EVIDENCE_INSUFFICIENT` for f1.
- Contradicted: f1 EXCULPATORY (admitted) with f2 DISPUTED keeps both (f2 in `contradictory`), `NEEDS_REVIEW` with `SOURCE_CONFLICT` for f2, `final_clearance` false.
- Only f2 INDICATOR: `exculpatory` [], `contradictory` [f2], `final_clearance` false, `COMPLETED`. INDICATOR, UNRESOLVED, DISPUTED and UNVERIFIED findings are all contradictory.

## Limitations

This package is an implemented synthetic reference, not a qualified production service. Its scope is the behavior stated above and the typed input/output contracts. Independent representative evaluation, approved institution policy and supported source mappings remain required. No independent real-source accuracy or institution-specific acceptance authority is established by the bundled examples.
