## Business outcome

Use an admitted request-bound specialist detector; absent providers yield evidence gaps. Use `fraud.document.tamper.detect` for this bounded operation in the parent business workflow. The supplied context must come from authorized canonical producers. A result describes the admitted records as of the invocation time; it does not independently establish facts outside those records.

## Procedure

1. Identify the target subject/relationship and the workflow requirement this operation addresses. Confirm that its required inputs are present: DocumentPage (text, document_version). Preserve gaps instead of copying values from an unrelated party or historical assessment.
2. Validate no business parameters against the input contract. Resolve the pinned policy fields `permitted_providers`. Unsupported applicability or a missing required rule must remain visible; use only the handler's defined result or error, never a model-invented default.
3. Perform the stated bounded behavior: Use an admitted request-bound specialist detector; absent providers yield evidence gaps. Execute the registered implementation rather than recreating financial calculations or verification in model prose. Shared helper logic does not grant permission to invoke undeclared providers.
4. Inspect `assessment`, `provider_id`, `synthetic`, `final_decision`. Retain uncertainty, candidates, conflicts and supporting record references. Check the actual payload meaning before the workflow treats execution completion as satisfying its requirement.
5. Hand off unresolved evidence or judgment to the appropriate producer/reviewer. Effects mode is `read_only`: proposed or queued changes require the executor's effect controls, and human-gated work cannot execute on the strength of this document.

## Evidence and uncertainty

Use only selected source versions and their admitted policy/context basis. Preserve original values alongside normalization and derived results. Evidence references locate support; they do not by themselves prove authenticity, identity or semantic truth. `COMPLETED` means execution completed under this contract; the parent workflow must inspect the business payload and remaining requirements.

## Variations

Apply the domain guidance below to institution, legal form/role, product, jurisdiction, lifecycle, source and time. Only combinations supported by the pinned policy, data contracts and qualified integration may be selected. Unknown applicability is a review/evidence gap. Provider coverage and verification standards are configuration/evidence, not assumptions inferred from a vendor or document name.

## Examples and acceptance

- Normal input: the recorded specialist assessment (score 0.25, `INCONCLUSIVE`, model version, limitations) is returned exactly with the provider id and `final_decision: false`; the page and the provider call are in the evidence references. An inconclusive answer settles nothing, so the status is `NEEDS_EVIDENCE` with `EVIDENCE_INSUFFICIENT` for page-1; it never reads as "not tampered".
- A high tamper score (0.97, `TAMPERED`) is returned as a signal, `COMPLETED`; `final_decision` stays false.
- Two pages sent, the answer cites only page-1: `EVIDENCE_INSUFFICIENT` / `NEEDS_EVIDENCE`, no payload. An answer covers only the pages it cites.
- Provider problems: no provider, or a recording made for different page content, is `SOURCE_UNAVAILABLE` / `NEEDS_EVIDENCE`; a provider not permitted by policy is `ACCESS_DENIED`; incomplete coverage is `EVIDENCE_INSUFFICIENT`.
- Malformed output (no limitations, no model version, score above 1 or a float score) or a provider citing a page outside the admitted context is `INTEGRITY_FAILURE`.
- A recorded test response cannot assess pages not marked as test data: `CONTROL_FAILED`.
- Missing evidence: no admitted DocumentPage is `CONTEXT_MISSING` / `NEEDS_EVIDENCE`, no payload; a stale page is `CONTEXT_STALE`.

## Limitations

This package is an implemented synthetic reference, not a qualified production service. Its scope is the behavior stated above and the typed input/output contracts. Independent representative evaluation, approved institution policy and supported source mappings remain required. specialist accuracy requires independent real-data evaluation
