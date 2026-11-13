## Business outcome

Assess, for each requirement the pinned policy states, whether its control is satisfied on the facts the workflow binds, and record the outcome as a `Control` the decision and quality steps read. Use `decision.controls.assess` after `decision.requirements.compile` has the same facts. It extends that skill: applicability is compiled the same way, and each applicable requirement's `control` (a `pass` predicate and an optional `fail` predicate) is then evaluated. A result describes the bound facts as of the invocation time; it does not independently establish facts outside them.

## Procedure

1. Confirm the admitted identity and pinned policy, and that `facts` carries what the policy's `when` and `control` predicates read (for example the tier, identity verification results, missing document requirements, screening hits and owner verification results). A fact the workflow could not bind is absent, never defaulted.
2. Resolve the pinned policy field `requirements`. A policy that states none is unresolved (`POLICY_UNRESOLVED`), never "nothing required".
3. For each requirement: a `when` that does not hold makes it `NOT_APPLICABLE`; a `when` that cannot be evaluated leaves its control `UNKNOWN`. Otherwise the control is `PASS` when its `pass` predicate holds and its `fail` predicate does not, `FAIL` when its `fail` predicate holds and its `pass` predicate does not, and `UNKNOWN` in every other case, including a requirement with no stated control.
4. Inspect `controls`: one entry per requirement with its outcome, applicability and basis. An unmet control without a stated failure condition is `UNKNOWN` (evidence still to collect), not `FAIL`.
5. Effects mode is `read_only`. The workflow records each entry as a `Control` record citing this execution; the checkpoints and people decide what the outcomes mean for the case.

## Evidence and uncertainty

The outcome rests only on the bound facts and the pinned policy's predicates; the basis says which condition held. Evidence references of the steps that produced the facts locate support; this skill does not re-verify them. A `PASS` here never approves a case.

## Variations

Requirements, applicability and controls vary by institution, customer type, jurisdiction, product and due-diligence level, and are read only from the pinned policy. Simplified due diligence makes ownership requirements not applicable through their `when`; enhanced due diligence brings source-of-funds requirements into scope through the tier.

## Examples and acceptance

- Normal input: identity verified, no missing document requirement, no screening hit: those requirements' controls `PASS`.
- Missing evidence: a document requirement still missing, or a screening hit not yet disposed: its control is `UNKNOWN`, never `PASS`.
- Contradictory or unsupported input: identity verification results that include a failure: the identity control `FAIL`s when the policy states that failure condition; pass and fail conditions that both hold leave it `UNKNOWN`.
- A requirement whose `when` does not hold (an EDD obligation on a LOW tier) is `NOT_APPLICABLE`; one whose `when` cannot be evaluated is `UNKNOWN`.
- A policy without requirements is `POLICY_UNRESOLVED`.

## Limitations

This package is an implemented synthetic reference, not a qualified production service. It evaluates the pinned policy's predicates over bound facts; it does not collect evidence, dispose screening hits or decide a case. The synthetic control predicates are placeholders an installation's policy owner replaces.
