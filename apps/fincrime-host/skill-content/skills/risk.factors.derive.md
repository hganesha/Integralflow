## Business outcome

Turn the case's recorded exposures into the risk factors the risk model weighs: for each factor the pinned `risk_weights` name (geography, product, industry, customer type, behaviour), score the values the case records through the pinned `risk_factor_maps`, taking the highest score when there are several (a case with deposit and payments products carries the payments score). It extends `risk.factor.evaluate`, which scores one value; the workflow records each scored factor as a `RiskFactor` that `risk.customer.assess` reads.

## Procedure

1. Confirm the admitted identity and pinned policy. `risk_weights` and `risk_factor_maps` must both be stated: without them the skill is `POLICY_UNRESOLVED`, never an empty or zero score.
2. For each weighted factor, collect the values its source records carry: GeographyExposure countries, Product types, the Party's industry and customer type, ExpectedActivity behaviour categories.
3. Score each value through the factor's map. The factor's score is the highest of them. A value the map does not score, or no recorded value at all, leaves the factor unscored (`score: null`) with the reason.
4. The result is `COMPLETED` when every weighted factor is scored and `NEEDS_EVIDENCE` otherwise; an unscored factor is never treated as low risk.
5. Effects mode is `read_only`: the workflow records each scored factor as a `RiskFactor` citing this execution.

## Evidence and uncertainty

Scores come only from the pinned maps and the case's recorded values; the result lists the values each score rests on. A factor whose source records are missing or carry an unmapped value stays unscored, and the risk assessment that reads the factors stays open.

## Variations

Which factors are weighted, and the score of every value, vary by institution, customer type and jurisdiction and are read only from the pinned policy. A natural person has no industry, so an industry factor is only weighted for legal entities.

## Examples and acceptance

- Normal input: GB geography and deposit and payments products with weights on geography and product give geography `0.05` and product `0.30` (the higher of deposit `0.05` and payments `0.30`), `COMPLETED`.
- Missing evidence: no recorded Product leaves product unscored (`score: null`, "No Product product_type is recorded."), `NEEDS_EVIDENCE`.
- Unsupported input: a country the map does not score (`ZZ`) leaves geography unscored with "No score for ZZ.", `NEEDS_EVIDENCE`; it is never scored as zero.
- Policy unresolved: no `risk_weights` or no `risk_factor_maps` is `POLICY_UNRESOLVED` / `BLOCKED`.
- A weighted factor with no source or table (for example `pep_proximity`) is unscored with that reason.

## Limitations

This package is an implemented reference over pinned placeholder maps, not a qualified risk model. It scores recorded values only; it does not establish exposures, weigh factors or assign a tier, which `risk.customer.assess` and `risk.tier.assign` do.
