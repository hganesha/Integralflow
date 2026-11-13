## Business outcome

Evaluate all configured supported transaction typologies and retain each contribution. Use `aml.typology.match` for this bounded operation in the parent business workflow. The supplied context must come from authorized canonical producers. A result describes the admitted records as of the invocation time; it does not independently establish facts outside those records.

## Procedure

1. Identify the target subject/relationship and the workflow requirement this operation addresses. Confirm that its required inputs are present: Transaction (source, target, amount, currency, timestamp, event_id, status); DatasetScope (start, end, complete, expected_count, watermark). Preserve gaps instead of copying values from an unrelated party or historical assessment.
2. Validate no business parameters against the input contract. Resolve the pinned policy fields `aml_detectors`. Unsupported applicability or a missing required rule must remain visible; use only the handler's defined result or error, never a model-invented default.
3. Perform the stated bounded behavior: Evaluate all configured supported transaction typologies and retain each contribution. Execute the registered implementation rather than recreating financial calculations or verification in model prose. Shared helper logic does not grant permission to invoke undeclared providers.
4. Inspect `typologies`, `not_proof`. Retain uncertainty, candidates, conflicts and supporting record references. Check the actual payload meaning before the workflow treats execution completion as satisfying its requirement.
5. Hand off unresolved evidence or judgment to the appropriate producer/reviewer. Effects mode is `read_only`: proposed or queued changes require the executor's effect controls, and human-gated work cannot execute on the strength of this document.

## Evidence and uncertainty

Use only selected source versions and their admitted policy/context basis. Preserve original values alongside normalization and derived results. Evidence references locate support; they do not by themselves prove authenticity, identity or semantic truth. `COMPLETED` means execution completed under this contract; the parent workflow must inspect the business payload and remaining requirements.

## Variations

Apply the domain guidance below to institution, legal form/role, product, jurisdiction, lifecycle, source and time. Only combinations supported by the pinned policy, data contracts and qualified integration may be selected. Unknown applicability is a review/evidence gap. Provider coverage and verification standards are configuration/evidence, not assumptions inferred from a vendor or document name.

## Examples and acceptance

- Normal input: all eight pinned kinds run in name order (funnel, layering, mule, pass_through, roundtrip, smurfing, structuring, velocity); structuring finds `[tx-1, tx-2]` and funnel and smurfing find nothing; `COMPLETED`.
- Threshold currency: a structuring or smurfing transaction outside its rule's `currency` adds a `POLICY_UNRESOLVED` item for that currency and makes the result `PARTIAL`; the other kinds use no amount threshold and evaluate every currency, never summing across them.
- Policy unresolved: `aml_detectors` empty or absent, or a kind no detector supports (`cuckoo`): `POLICY_UNRESOLVED` / `BLOCKED`, never "no typology".
- Cut-off window: only a structuring rule and a lone payment at 2026-11-01T05:00Z: `typologies: [{typology: structuring, indicators: []}]`, `PARTIAL` with `EVIDENCE_INSUFFICIENT` for that payment.

## Limitations

This package is an implemented synthetic reference, not a qualified production service. Its scope is the behavior stated above and the typed input/output contracts. Independent representative evaluation, approved institution policy and supported source mappings remain required. No independent real-source accuracy or institution-specific acceptance authority is established by the bundled examples. Each rule's `amount_threshold` states no currency: it is applied in each currency's own units, and currencies are never summed or converted.
