## Business outcome

Verify captured legal status only when registry coverage is complete. Use `registry.company.verify` for this bounded operation in the parent business workflow. The supplied context must come from authorized canonical producers. A result describes the admitted records as of the invocation time; it does not independently establish facts outside those records.

## Procedure

1. Identify the target subject/relationship and the workflow requirement this operation addresses. Confirm that its required inputs are present: RegistryRecord (registration_id, status, coverage). Preserve gaps instead of copying values from an unrelated party or historical assessment.
2. Validate no business parameters against the input contract. Resolve the pinned policy fields `active_registry_statuses`. Unsupported applicability or a missing required rule must remain visible; use only the handler's defined result or error, never a model-invented default.
3. Perform the stated bounded behavior: Verify captured legal status only when registry coverage is complete. Execute the registered implementation rather than recreating financial calculations or verification in model prose. Shared helper logic does not grant permission to invoke undeclared providers.
4. Inspect `verifications`. Retain uncertainty, candidates, conflicts and supporting record references. Check the actual payload meaning before the workflow treats execution completion as satisfying its requirement.
5. Hand off unresolved evidence or judgment to the appropriate producer/reviewer. Effects mode is `read_only`: proposed or queued changes require the executor's effect controls, and human-gated work cannot execute on the strength of this document.

## Evidence and uncertainty

Use only selected source versions and their admitted policy/context basis. Preserve original values alongside normalization and derived results. Evidence references locate support; they do not by themselves prove authenticity, identity or semantic truth. `COMPLETED` means execution completed under this contract; the parent workflow must inspect the business payload and remaining requirements.

## Variations

Apply the domain guidance below to institution, legal form/role, product, jurisdiction, lifecycle, source and time. Only combinations supported by the pinned policy, data contracts and qualified integration may be selected. Unknown applicability is a review/evidence gap. Provider coverage and verification standards are configuration/evidence, not assumptions inferred from a vendor or document name.

## Examples and acceptance

- Normal input: registration SYN-0001 with status `ACTIVE` (in `active_registry_statuses`) and complete coverage is `verified: true`, `COMPLETED`, with the registry record in the evidence references.
- `DISSOLVED`, `PENDING`, lower-case `active`, or incomplete coverage is `verified: false` with the captured status kept; each registration is verified on its own.
- A policy without `active_registry_statuses` verifies nothing.
- Conflicting statuses: `ACTIVE` and `DISSOLVED` captures for SYN-0001 both give `verified: false`, status `NEEDS_REVIEW` and a `SOURCE_CONFLICT` item for SYN-0001.
- Coverage that does not state completeness is rejected at admission with `CONTEXT_INVALID`.
- Missing evidence: no admitted RegistryRecord is `CONTEXT_MISSING` / `NEEDS_EVIDENCE`, no payload; a stale capture is `CONTEXT_STALE`.

## Limitations

This package is an implemented synthetic reference, not a qualified production service. Its scope is the behavior stated above and the typed input/output contracts. Independent representative evaluation, approved institution policy and supported source mappings remain required. No independent real-source accuracy or institution-specific acceptance authority is established by the bundled examples.
