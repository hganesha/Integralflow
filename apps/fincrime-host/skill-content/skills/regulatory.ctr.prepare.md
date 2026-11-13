## Business outcome

Prepare a synthetic CTR dataset of each customer-day cash total that meets its threshold, without submission. Use `regulatory.ctr.prepare` for this bounded operation in the parent business workflow. The supplied context must come from authorized canonical producers. A result describes the admitted records as of the invocation time; it does not independently establish facts outside those records.

## Procedure

1. Identify the target subject/relationship and the workflow requirement this operation addresses. Confirm that its required inputs are present: Transaction (source, target, amount, currency, timestamp, event_id, status, transaction_type); DatasetScope (start, end, complete, expected_count, watermark); Account (entity_id) for every account in the selected transactions, naming its holder; and a BusinessCalendar when the policy rolls activity off non-working days. Preserve gaps instead of copying values from an unrelated party or historical assessment.
2. Validate no business parameters against the input contract. Resolve the pinned policy fields `ctr_thresholds`, `ctr_time_zone`, `ctr_business_day` and `ctr_transaction_types`. Unsupported applicability or a missing required rule must remain visible; use only the handler's defined result or error, never a model-invented default.
3. Perform the stated bounded behavior: aggregate exactly as `regulatory.ctr.evaluate` does and keep the totals that meet their threshold. Execute the registered implementation rather than recreating financial calculations or verification in model prose. Shared helper logic does not grant permission to invoke undeclared providers.
4. Inspect `report_type`, `reportable`, `transaction_ids`, `time_zone`, `calendar_basis`, `synthetic`. Retain uncertainty, candidates, conflicts and supporting record references. Check the actual payload meaning before the workflow treats execution completion as satisfying its requirement.
5. Hand off unresolved evidence or judgment to the appropriate producer/reviewer. Effects mode is `read_only`: proposed or queued changes require the executor's effect controls, and human-gated work cannot execute on the strength of this document.

## Evidence and uncertainty

Use only selected source versions and their admitted policy/context basis. Preserve original values alongside normalization and derived results. Evidence references locate support; they do not by themselves prove authenticity, identity or semantic truth. `COMPLETED` means execution completed under this contract; the parent workflow must inspect the business payload and remaining requirements.

## Variations

Apply the domain guidance below to institution, legal form/role, product, jurisdiction, lifecycle, source and time. Only combinations supported by the pinned policy, data contracts and qualified integration may be selected. Unknown applicability is a review/evidence gap. Provider coverage and verification standards are configuration/evidence, not assumptions inferred from a vendor or document name.

## Examples and acceptance

- Normal input: the seeded dataset: `reportable` holds the four customer-day totals that meet 100 (acme in 110 and out 120, alice in 120 and out 110), `transaction_ids: [tx-1, tx-2, tx-3]`, `time_zone: UTC`, `synthetic: true`, `COMPLETED`.
- Below threshold: 60 + 39.99: `reportable: []`, `transaction_ids: []`, `COMPLETED`; the totals were evaluated and none is reportable. With c-2 (40) reversed, 60 remains: `reportable: []`.
- No cash activity: every transaction reversed, or none of a pinned CTR type, in the complete scope: `reportable: []`, `COMPLETED`. A DatasetScope with `complete: false`: `EVIDENCE_INSUFFICIENT` / `NEEDS_EVIDENCE`, never "nothing to report".
- Gaps: a payment to acct-z with no Account record: acme's side is prepared, `NEEDS_EVIDENCE` with `EVIDENCE_INSUFFICIENT` for acct-z. A currency with no threshold: `NEEDS_REVIEW` with `POLICY_UNRESOLVED`.

## Limitations

This package is an implemented synthetic reference, not a qualified production service. Its scope is the behavior stated above and the typed input/output contracts. Independent representative evaluation, approved institution policy and supported source mappings remain required. No independent real-source accuracy or institution-specific acceptance authority is established by the bundled examples. It shares `regulatory.ctr.evaluate`'s aggregation and limits; it prepares the dataset only, and filing stays with `regulatory.filing.prepare` and a human decision.
