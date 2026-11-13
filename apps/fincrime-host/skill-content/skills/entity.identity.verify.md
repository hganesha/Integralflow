## Business outcome

Evaluate captured VerificationRecord assertions against the pinned allowed verification methods and evidence presence. Use after approved acquisition. This handler consumes verification records; it performs no biometric, issuer or document investigation itself.

## Procedure

1. Collect the admitted VerificationRecord rows with subject, status, method and evidence IDs. Reconcile each subject with the parent relationship; do not verify a different related party by copying the customer result.
2. Read verification_methods from the pinned policy. The handler marks a record verified only when its status is VERIFIED, its method is allowed and evidence IDs are present. An absent allowlist yields no positive verification; it must remain a policy gap in the parent decision.
3. Return one verification result per admitted record, preserving its source reference as the basis. Do not combine contradictory records into an invented consensus or treat a syntactically valid identifier as verified identity.
4. Have the parent workflow establish source qualification, evidence authenticity, freshness and required-subject coverage. A captured VERIFIED label alone is not an independent assessment. Route conflicting, unqualified or insufficient records to evidence collection/review.

## Evidence and uncertainty

Keep source record versions, selected fields, as-of/knowledge-cutoff, policy snapshot and context/instruction hashes. Preserve contradictory claims and optional gaps. Source references support traceability but do not themselves establish truth or qualification. COMPLETED is an execution status; inspect domain outputs and parent requirements before a business conclusion.

## Variations

Qualify allowed methods separately by institution, customer type, issuer, jurisdiction, product and lifecycle. Remote identity checks, in-person evidence and existing-customer reliance are distinct methods. Legal-entity/related-party authority is outside this bounded identity-record evaluation.

## Examples and acceptance

- Allowed method + VERIFIED + source evidence: verified true for that record; preserve basis.
- Disallowed method or missing evidence IDs: verified false despite a provider status of VERIFIED.
- Two records disagree about one subject: preserve both outcomes and require parent reconciliation.
- A signatory result supplied for an owner: it cannot satisfy the owner requirement without the correct subject binding.

## Limitations

Consumes captured assertions; no independent identity proof, source qualification or canonical fact promotion. Qualified producer mappings and authorized assessment remain prerequisites. Current maturity remains implemented_synthetic. Independent evaluation, policy/source approvals and operating qualification are required before production.
