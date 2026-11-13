## Business outcome

Apply an explicit externally estimated amount baseline to a single currency. Use `transaction.anomaly.detect` for this bounded operation in the parent business workflow. The supplied context must come from authorized canonical producers. A result describes the admitted records as of the invocation time; it does not independently establish facts outside those records.

## Procedure

1. Identify the target subject/relationship and the workflow requirement this operation addresses. Confirm that its required inputs are present: Transaction (source, target, amount, currency, timestamp, event_id, status); DatasetScope (start, end, complete, expected_count, watermark). Preserve gaps instead of copying values from an unrelated party or historical assessment.
2. Validate `mean`, `standard_deviation`, `z_threshold`, `currency` against the input contract. Resolve the pinned policy fields only the declared authorization/freshness fields. Unsupported applicability or a missing required rule must remain visible; use only the handler's defined result or error, never a model-invented default.
3. Perform the stated bounded behavior: Apply an explicit externally estimated amount baseline to a single currency. Execute the registered implementation rather than recreating financial calculations or verification in model prose. Shared helper logic does not grant permission to invoke undeclared providers.
4. Inspect `anomalies`, `calibrated`. Retain uncertainty, candidates, conflicts and supporting record references. Check the actual payload meaning before the workflow treats execution completion as satisfying its requirement.
5. Hand off unresolved evidence or judgment to the appropriate producer/reviewer. Effects mode is `read_only`: proposed or queued changes require the executor's effect controls, and human-gated work cannot execute on the strength of this document.

## Evidence and uncertainty

Use only selected source versions and their admitted policy/context basis. Preserve original values alongside normalization and derived results. Evidence references locate support; they do not by themselves prove authenticity, identity or semantic truth. `COMPLETED` means execution completed under this contract; the parent workflow must inspect the business payload and remaining requirements.

## Variations

Apply the domain guidance below to institution, legal form/role, product, jurisdiction, lifecycle, source and time. Only combinations supported by the pinned policy, data contracts and qualified integration may be selected. Unknown applicability is a review/evidence gap. Provider coverage and verification standards are configuration/evidence, not assumptions inferred from a vendor or document name.

## Examples and acceptance

- Normal input: `mean` 50, `standard_deviation` 10, `z_threshold` 2, `currency` SYN over settled SYN transfers tx-1 acct-a→acct-b 60, tx-2 acct-a→acct-b 60 and tx-3 acct-b→acct-a 110 on 2026-11-02 in the complete window 2026-11-01 to 2026-11-07: `anomalies` `[{id: tx-3, z_score: 6}]`, `calibrated` false, `COMPLETED`.
- Other currency: adding tx-4 EUR 5000 keeps the same anomalies, but the result is `PARTIAL` with an `EVIDENCE_INSUFFICIENT` item for EUR, which was not scored.
- Nothing scored: `currency` EUR with only SYN transactions is `anomalies` `[]` and `NEEDS_EVIDENCE` with items for EUR and SYN, never "no anomaly".
- Invalid input: `standard_deviation` 0 is `INPUT_INVALID` / `FAILED`.

## Limitations

This package is an implemented synthetic reference, not a qualified production service. Its scope is the behavior stated above and the typed input/output contracts. Independent representative evaluation, approved institution policy and supported source mappings remain required. No independent real-source accuracy or institution-specific acceptance authority is established by the bundled examples.
