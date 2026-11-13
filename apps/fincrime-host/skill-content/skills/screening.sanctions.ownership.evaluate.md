## Business outcome

Evaluate the pinned sanctions ownership regime for a target and explicit blocked IDs. Keep sanctions blocking propagation distinct from economic-interest multiplication and control rules.

## Procedure

1. Require sanctions_ownership configuration and a supported rule: synthetic_aggregate or ofac_50_percent. Unsupported or absent policy raises POLICY_UNRESOLVED; do not infer a regime from jurisdiction text.
2. Use exact decimal OwnershipInterest values and retain graph/source identity. For synthetic_aggregate, use the supported economic-interest helper and configured threshold. For ofac_50_percent, require threshold 0.5 and use the dedicated fixed-point propagation helper.
3. Preserve cycles/incomplete graph findings and add unresolved items for OwnershipRange inputs. Do not turn uncertain percentages into an exact edge or assert clearance because known edges fall below threshold.
4. Return aggregate_interest, threshold_met and unresolved. A threshold flag describes the selected supported calculation only. Control rights, required-party identity, full graph sufficiency and actual restrictions/decisions remain separate.

## Evidence and uncertainty

Keep source record versions, selected fields, as-of/knowledge-cutoff, policy snapshot and context/instruction hashes. Preserve contradictory claims and optional gaps. Source references support traceability but do not themselves establish truth or qualification. COMPLETED is an execution status; inspect domain outputs and parent requirements before a business conclusion.

## Variations

Qualify each regime and version independently against approved legal/policy interpretation. Current support for a named rule does not qualify other jurisdictions, control tests, trusts/nominees or legal exceptions. Changes to blocked identities or ownership invalidate prior calculation basis.

## Examples and acceptance

- Fixed-point examples: a blocked intermediate can propagate blocking under the supported regime independently of economic path products.
- Two distinct blocked owners aggregate their direct interest; duplicate edges cannot double count.
- Ranged interests/cycles: unresolved/PARTIAL remains visible.
- Unsupported rule or incorrect ofac_50_percent threshold: POLICY_UNRESOLVED.

## Limitations

Computes a bounded policy-selected ownership result. It does not establish the blocked list, legal applicability, full graph completeness, control restrictions or execution authority. Current maturity remains implemented_synthetic. Independent evaluation, policy/source approvals and operating qualification are required before production.
