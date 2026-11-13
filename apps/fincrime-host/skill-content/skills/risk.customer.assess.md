## Business outcome

Calculate a pinned weighted risk score with factor contributions and a recommended tier, while retaining unknown inputs. It is a deterministic assessment of supplied factor scores, not an acceptance decision or a trained predictor.

## Procedure

1. Collect RiskFactor rows and their source/model basis. Read risk_weights, risk_model_version and risk_tiers from the admitted policy. Keep the configured factor set separate from whatever data happens to be available.
2. Require nonnegative weights with a positive sum. For every configured factor, calculate its exact decimal contribution. Do not supply zero for a missing factor or silently drop its weight.
3. If any configured factor is absent, leave score unknown and return NEEDS_EVIDENCE with missing names. Otherwise compute the supported weighted average and retain contributions/model version.
4. Map the score through descending minimum tier boundaries. An unmatched tier remains UNKNOWN. The parent decision must not treat score presence or COMPLETED as an approved risk tier or acceptance.
5. Keep explanations tied to captured contributions. Changes to factor definitions, weights, tier boundaries, sources or population require evaluated model/policy qualification; the skill cannot self-promote a calibration.

## Evidence and uncertainty

Keep source record versions, selected fields, as-of/knowledge-cutoff, policy snapshot and context/instruction hashes. Preserve contradictory claims and optional gaps. Source references support traceability but do not themselves establish truth or qualification. COMPLETED is an execution status; inspect domain outputs and parent requirements before a business conclusion.

## Variations

Supported models depend on institution, customer type, product, geography, lifecycle and observation window. Verify that inputs use the same scale/definition as the configured model. Duplicate/conflicting factor records and absent model/tier metadata require parent reconciliation; do not infer approved model status.

## Examples and acceptance

- All configured factors present: reproducible contributions and weighted score under the pinned model.
- Missing one factor: score unknown, NEEDS_EVIDENCE, no zero imputation.
- Negative/zero-sum weights: POLICY_UNRESOLVED.
- Score outside all configured tiers: UNKNOWN tier; no customer acceptance.
- Same score in a different product/segment: qualification does not transfer automatically.

## Limitations

No independent evidence acquisition, learned prediction or proof that supplied factor scores are valid. The supported arithmetic does not establish real-world calibration, population fitness or acceptance authority. Current maturity remains implemented_synthetic. Independent evaluation, policy/source approvals and operating qualification are required before production.
