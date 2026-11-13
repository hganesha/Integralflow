## Business outcome

Normalize and deduplicate a complete canonical transaction window. Use `transaction.ingest` for this bounded operation in the parent business workflow. The supplied context must come from authorized canonical producers. A result describes the admitted records as of the invocation time; it does not independently establish facts outside those records.

## Procedure

1. Identify the target subject/relationship and the workflow requirement this operation addresses. Confirm that its required inputs are present: Transaction (source, target, amount, currency, timestamp, event_id, status); DatasetScope (start, end, complete, expected_count, watermark). Preserve gaps instead of copying values from an unrelated party or historical assessment.
2. Validate no business parameters against the input contract. Resolve the pinned policy fields only the declared authorization/freshness fields. Unsupported applicability or a missing required rule must remain visible; use only the handler's defined result or error, never a model-invented default.
3. Perform the stated bounded behavior: Normalize and deduplicate a complete canonical transaction window. Execute the registered implementation rather than recreating financial calculations or verification in model prose. Shared helper logic does not grant permission to invoke undeclared providers.
4. Inspect `transactions`, `totals`. Retain uncertainty, candidates, conflicts and supporting record references. Check the actual payload meaning before the workflow treats execution completion as satisfying its requirement.
5. Hand off unresolved evidence or judgment to the appropriate producer/reviewer. Effects mode is `read_only`: proposed or queued changes require the executor's effect controls, and human-gated work cannot execute on the strength of this document.

## Evidence and uncertainty

Use only selected source versions and their admitted policy/context basis. Preserve original values alongside normalization and derived results. Evidence references locate support; they do not by themselves prove authenticity, identity or semantic truth. `COMPLETED` means execution completed under this contract; the parent workflow must inspect the business payload and remaining requirements.

## Variations

Apply the domain guidance below to institution, legal form/role, product, jurisdiction, lifecycle, source and time. Only combinations supported by the pinned policy, data contracts and qualified integration may be selected. Unknown applicability is a review/evidence gap. Provider coverage and verification standards are configuration/evidence, not assumptions inferred from a vendor or document name.

## Examples and acceptance

- Normal input: settled SYN transfers tx-1 acct-a→acct-b 60, tx-2 acct-a→acct-b 60 and tx-3 acct-b→acct-a 110 on 2026-11-02 in the complete window 2026-11-01 to 2026-11-07: transactions tx-1, tx-2, tx-3 and `totals` `{SYN: 230}`, `COMPLETED`.
- Duplicate: tx-9 repeating `event-tx-1` with identical values is counted once: still three transactions and `{SYN: 230}`.
- Contradictory input: a second record of `event-tx-1` with amount 61 (or any other differing field) is `SOURCE_CONFLICT` / `NEEDS_REVIEW`; neither record is preferred.
- Outside the window: tx-0 dated 2026-10-31 and counted in `expected_count` 4 is `EVIDENCE_INSUFFICIENT` / `NEEDS_EVIDENCE`; it never stands in for a missing in-window record.
- Missing evidence: a DatasetScope with `complete` false, or `expected_count` 4 for three records, is `EVIDENCE_INSUFFICIENT` / `NEEDS_EVIDENCE`; a watermark before the window end is `CONTEXT_STALE`.

## Limitations

This package is an implemented synthetic reference, not a qualified production service. Its scope is the behavior stated above and the typed input/output contracts. Independent representative evaluation, approved institution policy and supported source mappings remain required. No independent real-source accuracy or institution-specific acceptance authority is established by the bundled examples.
