## Business outcome

Evaluate approved EDD trigger predicates against supplied facts, retaining unknown inputs as follow-up obligations. Use to decide which triggers require investigation, not to declare that enhanced due diligence is complete.

## Procedure

1. Require an explicit edd_triggers key in the admitted pinned policy. Missing/null configuration raises POLICY_UNRESOLVED. An explicit empty list means only that this approved policy supplies no triggers; it cannot be invented by the caller or model.
2. For every configured trigger, evaluate its predicate against facts using the supported three-valued evaluator. Preserve trigger ID and PASS/FAIL/UNKNOWN result.
3. Set required true when any trigger is PASS or UNKNOWN. Unknown facts must not suppress EDD. Return all trigger outcomes so the next step can distinguish a matched risk condition from missing evidence.
4. Compile investigation scope and durable human work in separate steps. Trigger evaluation does not collect funds/wealth evidence, complete EDD, authorize acceptance or confirm monitoring.
5. Reassess when material customer, ownership, product or source facts change; preserve the original policy and fact basis for the prior decision.

## Evidence and uncertainty

Keep source record versions, selected fields, as-of/knowledge-cutoff, policy snapshot and context/instruction hashes. Preserve contradictory claims and optional gaps. Source references support traceability but do not themselves establish truth or qualification. COMPLETED is an execution status; inspect domain outputs and parent requirements before a business conclusion.

## Variations

Triggers vary by institution, legal form, PEP relationships, ownership complexity, product, geography and lifecycle. Only explicit policy decides applicability. A synthetic trigger list or an approved empty list for one population cannot qualify another.

## Examples and acceptance

- edd_triggers missing: BLOCKED/POLICY_UNRESOLVED, empty favorable result forbidden.
- Explicit approved empty list: triggers empty and required false for that policy scope.
- Matching predicate: PASS and required true.
- Missing predicate fact: UNKNOWN and required true.
- All supported predicates false: required false within this bounded configured trigger set.

## Limitations

Predicate evaluation over supplied facts only. No full EDD investigation, independent fact verification, exception approval or acceptance decision. Current maturity remains implemented_synthetic. Independent evaluation, policy/source approvals and operating qualification are required before production.
