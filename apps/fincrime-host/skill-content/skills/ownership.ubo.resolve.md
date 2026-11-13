## Business outcome

Produce candidate individual beneficial owners for a target using the configured interest threshold and verified control rights. Economic-interest calculation, candidate-owner identity and an authorized ownership/control determination are separate outcomes.

## Procedure

1. Confirm target and admitted OwnershipInterest graph scope. Preserve source edge IDs, ownership direction, exact decimal percentages and effective dates. Entity records identify individual versus organization nodes.
2. Expand economic interests through the supported ownership helper. Preserve paths, cycles and unresolved structures. Ranged interests remain unresolved and cannot be replaced with their midpoint, lower bound or a fabricated exact percentage.
3. Require the pinned ownership_threshold. Include individual interest candidates under that threshold rule and verified individual control-right candidates. Preserve the basis distinguishing interest from control.
4. Return candidates with the calculation, and preserve PARTIAL when graph/range gaps exist. A candidate is not a verified owner or a final legal determination. Schedule identity verification and required corroboration separately.
5. If the parent workflow needs sanctions ownership, invoke its dedicated regime; do not reuse path-product economic interest as sanctions blocking propagation.

## Evidence and uncertainty

Keep source record versions, selected fields, as-of/knowledge-cutoff, policy snapshot and context/instruction hashes. Preserve contradictory claims and optional gaps. Source references support traceability but do not themselves establish truth or qualification. COMPLETED is an execution status; inspect domain outputs and parent requirements before a business conclusion.

## Variations

Customer legal form and jurisdiction determine applicable owner/control roles. Trusts, funds, charities, nominees, chains across jurisdictions and opaque structures need approved policies and evidence. Unsupported legal applicability must stop the overall ownership conclusion.

## Examples and acceptance

- A qualifying individual interest path: candidate retains calculated interest and paths; owner identity remains unverified.
- Verified individual control below the economic threshold: preserve the control basis separately.
- Ranged edge or cycle: calculation remains unresolved/PARTIAL and cannot support an exact clearance.
- Threshold missing: POLICY_UNRESOLVED, not an assumed percentage.

## Limitations

Limited to the supported graph/threshold/control computation. It does not retrieve registries, establish graph completeness, interpret arbitrary legal arrangements or verify owner identity. Current maturity remains implemented_synthetic. Independent evaluation, policy/source approvals and operating qualification are required before production.
