## Business outcome

Suspend for an authenticated independent human review. Use `decision.human.review` for this bounded operation in the parent business workflow. The supplied context must come from authorized canonical producers. A result describes the admitted records as of the invocation time; it does not independently establish facts outside those records.

## Procedure

1. Identify the target subject/relationship and the workflow requirement this operation addresses. Confirm that its required inputs are present: the admitted identity and pinned policy. Preserve gaps instead of copying values from an unrelated party or historical assessment.
2. Validate `action` against the input contract. Resolve the pinned policy fields only the declared authorization/freshness fields. Unsupported applicability or a missing required rule must remain visible; use only the handler's defined result or error, never a model-invented default.
3. Perform the stated bounded behavior: Suspend for an authenticated independent human review. Execute the registered implementation rather than recreating financial calculations or verification in model prose. Shared helper logic does not grant permission to invoke undeclared providers.
4. Inspect `action`, `review_required`. Retain uncertainty, candidates, conflicts and supporting record references. Check the actual payload meaning before the workflow treats execution completion as satisfying its requirement.
5. Hand off unresolved evidence or judgment to the appropriate producer/reviewer. Effects mode is `human_gated`: proposed or queued changes require the executor's effect controls, and human-gated work cannot execute on the strength of this document.

## Evidence and uncertainty

Use only selected source versions and their admitted policy/context basis. Preserve original values alongside normalization and derived results. Evidence references locate support; they do not by themselves prove authenticity, identity or semantic truth. `COMPLETED` means execution completed under this contract; the parent workflow must inspect the business payload and remaining requirements.

## Variations

Apply the domain guidance below to institution, legal form/role, product, jurisdiction, lifecycle, source and time. Only combinations supported by the pinned policy, data contracts and qualified integration may be selected. Unknown applicability is a review/evidence gap. Provider coverage and verification standards are configuration/evidence, not assumptions inferred from a vendor or document name.

## Examples and acceptance

- Normal input: action ACCEPT is suspended: `NEEDS_REVIEW` / `WAITING_FOR_HUMAN` with payload action ACCEPT and `review_required` true, and one `HUMAN_REVIEW_REQUIRED` item carrying the pending approval ID. Nothing is committed.
- An independent reviewer in the policy's compliance role, holding the approval permission, approves; the same request then resumes once as `COMPLETED` and the approval is consumed. A second resume is `ACCESS_DENIED`.
- Self-approval: the requester cannot approve their own review, and nor can someone outside the policy role (`ACCESS_DENIED`); the approval stays pending.
- Changed basis: after the policy is revised, the earlier approval no longer authorizes the request (`ACCESS_DENIED` / `BLOCKED`). A changed action on the same idempotency key is `IDEMPOTENCY_CONFLICT`.
- Context not marked synthetic is `CONTROL_FAILED` / `BLOCKED` in this release.

## Limitations

This package is an implemented synthetic reference, not a qualified production service. Its scope is the behavior stated above and the typed input/output contracts. Independent representative evaluation, approved institution policy and supported source mappings remain required. No independent real-source accuracy or institution-specific acceptance authority is established by the bundled examples.
