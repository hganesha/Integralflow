## Business outcome

Compute configured decaying network exposure with contribution paths, never inherited guilt. Use `network.risk.propagate` for this bounded operation in the parent business workflow. The supplied context must come from authorized canonical producers. A result describes the admitted records as of the invocation time; it does not independently establish facts outside those records.

## Procedure

1. Identify the target subject/relationship and the workflow requirement this operation addresses. Confirm that its required inputs are present: Relationship (source, target, relation, verified). Preserve gaps instead of copying values from an unrelated party or historical assessment.
2. Validate `seed_risks`, `max_hops` against the input contract. Resolve the pinned policy fields `network_decay`. Unsupported applicability or a missing required rule must remain visible; use only the handler's defined result or error, never a model-invented default.
3. Perform the stated bounded behavior: Compute configured decaying network exposure with contribution paths, never inherited guilt. Execute the registered implementation rather than recreating financial calculations or verification in model prose. Shared helper logic does not grant permission to invoke undeclared providers.
4. Inspect `exposures`, `final_decision`. Retain uncertainty, candidates, conflicts and supporting record references. Check the actual payload meaning before the workflow treats execution completion as satisfying its requirement.
5. Hand off unresolved evidence or judgment to the appropriate producer/reviewer. Effects mode is `read_only`: proposed or queued changes require the executor's effect controls, and human-gated work cannot execute on the strength of this document.

## Evidence and uncertainty

Use only selected source versions and their admitted policy/context basis. Preserve original values alongside normalization and derived results. Evidence references locate support; they do not by themselves prove authenticity, identity or semantic truth. `COMPLETED` means execution completed under this contract; the parent workflow must inspect the business payload and remaining requirements.

## Variations

Apply the domain guidance below to institution, legal form/role, product, jurisdiction, lifecycle, source and time. Only combinations supported by the pinned policy, data contracts and qualified integration may be selected. Unknown applicability is a review/evidence gap. Provider coverage and verification standards are configuration/evidence, not assumptions inferred from a vendor or document name.

## Examples and acceptance

- Normal input: `seed_risks` `{acct-a: 0.8}`, `network_decay` 0.5, `max_hops` 3 over rel-1 acct-a→acct-b (verified) and rel-2 acct-b→acct-c (unverified): acct-b 0.40 via `[acct-a, acct-b]` and acct-c 0.200 via `[acct-a, acct-b, acct-c]`, `final_decision` false, `COMPLETED`.
- Beyond the hop limit: `max_hops` 1 gives only acct-b and is `PARTIAL` with an `EVIDENCE_INSUFFICIENT` item for acct-c.
- Seed outside the network: `{acct-a: 0.8, acct-z: 0.9}` keeps acct-a's exposures and is `NEEDS_EVIDENCE` with an `EVIDENCE_INSUFFICIENT` item for acct-z.
- Policy unresolved: no `network_decay` is `POLICY_UNRESOLVED` / `BLOCKED`; a negative seed risk is `INPUT_INVALID` / `FAILED`.

## Limitations

This package is an implemented synthetic reference, not a qualified production service. Its scope is the behavior stated above and the typed input/output contracts. Independent representative evaluation, approved institution policy and supported source mappings remain required. No independent real-source accuracy or institution-specific acceptance authority is established by the bundled examples.
