## Business outcome

Enumerate bounded relationship paths with an explicit output limit. Use `network.path.find` for this bounded operation in the parent business workflow. The supplied context must come from authorized canonical producers. A result describes the admitted records as of the invocation time; it does not independently establish facts outside those records.

## Procedure

1. Identify the target subject/relationship and the workflow requirement this operation addresses. Confirm that its required inputs are present: Relationship (source, target, relation, verified). Preserve gaps instead of copying values from an unrelated party or historical assessment.
2. Validate `source`, `target`, `max_hops` against the input contract. Resolve the pinned policy fields only the declared authorization/freshness fields. Unsupported applicability or a missing required rule must remain visible; use only the handler's defined result or error, never a model-invented default.
3. Perform the stated bounded behavior: Enumerate bounded relationship paths with an explicit output limit. Execute the registered implementation rather than recreating financial calculations or verification in model prose. Shared helper logic does not grant permission to invoke undeclared providers.
4. Inspect `paths`, `truncated`. Retain uncertainty, candidates, conflicts and supporting record references. Check the actual payload meaning before the workflow treats execution completion as satisfying its requirement.
5. Hand off unresolved evidence or judgment to the appropriate producer/reviewer. Effects mode is `read_only`: proposed or queued changes require the executor's effect controls, and human-gated work cannot execute on the strength of this document.

## Evidence and uncertainty

Use only selected source versions and their admitted policy/context basis. Preserve original values alongside normalization and derived results. Evidence references locate support; they do not by themselves prove authenticity, identity or semantic truth. `COMPLETED` means execution completed under this contract; the parent workflow must inspect the business payload and remaining requirements.

## Variations

Apply the domain guidance below to institution, legal form/role, product, jurisdiction, lifecycle, source and time. Only combinations supported by the pinned policy, data contracts and qualified integration may be selected. Unknown applicability is a review/evidence gap. Provider coverage and verification standards are configuration/evidence, not assumptions inferred from a vendor or document name.

## Examples and acceptance

- Normal input: acct-a to acct-c, `max_hops` 3, over rel-1 acct-a→acct-b (verified) and rel-2 acct-b→acct-c (unverified): `paths` `[[acct-a, acct-b, acct-c]]`, `truncated` false, `COMPLETED`.
- Beyond the hop limit: `max_hops` 1 is `paths` `[]` and `PARTIAL` with an `EVIDENCE_INSUFFICIENT` item for acct-c.
- Direction: with rel-3 recorded acct-d→acct-c, acct-a reaches acct-d only against it: `paths` `[]` and `NEEDS_REVIEW` with a `HUMAN_REVIEW_REQUIRED` item for acct-d.
- Not covered: acct-z, in no relationship, is `paths` `[]` and `NEEDS_EVIDENCE` with an `EVIDENCE_INSUFFICIENT` item for acct-z.
- Budget: four fully linked layers of six nodes between s and t (1296 paths, `max_hops` 5) return the first 1000 paths with `truncated` true and status `PARTIAL`.

## Limitations

This package is an implemented synthetic reference, not a qualified production service. Its scope is the behavior stated above and the typed input/output contracts. Independent representative evaluation, approved institution policy and supported source mappings remain required. No independent real-source accuracy or institution-specific acceptance authority is established by the bundled examples.
