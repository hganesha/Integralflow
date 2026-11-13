## Business outcome

Return the admitted context manifest without recursive compilation. Use `case.context.hydrate` for this bounded operation in the parent business workflow. The supplied context must come from authorized canonical producers. A result describes the admitted records as of the invocation time; it does not independently establish facts outside those records.

## Procedure

1. Identify the target subject/relationship and the workflow requirement this operation addresses. Confirm that its required inputs are present: the admitted identity and pinned policy. Preserve gaps instead of copying values from an unrelated party or historical assessment.
2. Validate `target_skill` against the input contract. Resolve the pinned policy fields only the declared authorization/freshness fields. Unsupported applicability or a missing required rule must remain visible; use only the handler's defined result or error, never a model-invented default.
3. Perform the stated bounded behavior: Return the admitted context manifest without recursive compilation. Execute the registered implementation rather than recreating financial calculations or verification in model prose. Shared helper logic does not grant permission to invoke undeclared providers.
4. Inspect `manifest`, `context_hash`. Retain uncertainty, candidates, conflicts and supporting record references. Check the actual payload meaning before the workflow treats execution completion as satisfying its requirement.
5. Hand off unresolved evidence or judgment to the appropriate producer/reviewer. Effects mode is `read_only`: proposed or queued changes require the executor's effect controls, and human-gated work cannot execute on the strength of this document.

## Evidence and uncertainty

Use only selected source versions and their admitted policy/context basis. Preserve original values alongside normalization and derived results. Evidence references locate support; they do not by themselves prove authenticity, identity or semantic truth. `COMPLETED` means execution completed under this contract; the parent workflow must inspect the business payload and remaining requirements.

## Variations

Apply the domain guidance below to institution, legal form/role, product, jurisdiction, lifecycle, source and time. Only combinations supported by the pinned policy, data contracts and qualified integration may be selected. Unknown applicability is a review/evidence gap. Provider coverage and verification standards are configuration/evidence, not assumptions inferred from a vendor or document name.

## Examples and acceptance

- Normal input: `target_skill` `entity.resolve`: the manifest of that skill's context (`skill_id` `entity.resolve`, references to the Entity records `acme` and `alice`, no gaps) and its `context_hash`, `COMPLETED`.
- Missing evidence: no Entity records for `entity.resolve`: `CONTEXT_MISSING` / `NEEDS_EVIDENCE`.
- Partial context: target `regulatory.deadline.calculate` with its optional BusinessCalendar `calendar-1` older than a pinned one-day freshness: the record is left out of the manifest and the result is `PARTIAL` with a `CONTEXT_STALE` item for `calendar-1`.
- Edge: no BusinessCalendar at all for that optional requirement is not a gap: `COMPLETED`, empty `refs` and `gaps`.
- Unsupported input: `target_skill` `case.context.hydrate` itself, or an unregistered skill: `ACCESS_DENIED` / `BLOCKED`.

## Limitations

This package is an implemented synthetic reference, not a qualified production service. Its scope is the behavior stated above and the typed input/output contracts. Independent representative evaluation, approved institution policy and supported source mappings remain required. No independent real-source accuracy or institution-specific acceptance authority is established by the bundled examples.
