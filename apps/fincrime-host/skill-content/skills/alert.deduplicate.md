## Business outcome

Group exact duplicate subject/rule/event sets without destructive consolidation. Use `alert.deduplicate` for this bounded operation in the parent business workflow. The supplied context must come from authorized canonical producers. A result describes the admitted records as of the invocation time; it does not independently establish facts outside those records.

## Procedure

1. Identify the target subject/relationship and the workflow requirement this operation addresses. Confirm that its required inputs are present: Alert (subject, event_ids, rule_id). Preserve gaps instead of copying values from an unrelated party or historical assessment.
2. Validate no business parameters against the input contract. Resolve the pinned policy fields only the declared authorization/freshness fields. Unsupported applicability or a missing required rule must remain visible; use only the handler's defined result or error, never a model-invented default.
3. Perform the stated bounded behavior: Group exact duplicate subject/rule/event sets without destructive consolidation. Execute the registered implementation rather than recreating financial calculations or verification in model prose. Shared helper logic does not grant permission to invoke undeclared providers.
4. Inspect `groups`. Retain uncertainty, candidates, conflicts and supporting record references. Check the actual payload meaning before the workflow treats execution completion as satisfying its requirement.
5. Hand off unresolved evidence or judgment to the appropriate producer/reviewer. Effects mode is `read_only`: proposed or queued changes require the executor's effect controls, and human-gated work cannot execute on the strength of this document.

## Evidence and uncertainty

Use only selected source versions and their admitted policy/context basis. Preserve original values alongside normalization and derived results. Evidence references locate support; they do not by themselves prove authenticity, identity or semantic truth. `COMPLETED` means execution completed under this contract; the parent workflow must inspect the business payload and remaining requirements.

## Variations

Apply the domain guidance below to institution, legal form/role, product, jurisdiction, lifecycle, source and time. Only combinations supported by the pinned policy, data contracts and qualified integration may be selected. Unknown applicability is a review/evidence gap. Provider coverage and verification standards are configuration/evidence, not assumptions inferred from a vendor or document name.

## Examples and acceptance

- Normal input: alert-1 (events tx-1, tx-2) and alert-2 (events tx-2, tx-1) with the same subject, rule and severity give `groups` [[alert-1, alert-2]]; alert-3 on tx-3 is not grouped; `COMPLETED`.
- Material difference: the same subject, rule and events but alert-2 is LOW; they are not grouped (`groups` []), `NEEDS_REVIEW` with `SOURCE_CONFLICT` for alert-1.
- Missing evidence: two acme alerts that name no event are not compared (`groups` []), `NEEDS_EVIDENCE` with `EVIDENCE_INSUFFICIENT` for each.
- No admitted Alert is `CONTEXT_MISSING` / `NEEDS_EVIDENCE`.

## Limitations

This package is an implemented synthetic reference, not a qualified production service. Its scope is the behavior stated above and the typed input/output contracts. Independent representative evaluation, approved institution policy and supported source mappings remain required. No independent real-source accuracy or institution-specific acceptance authority is established by the bundled examples.
