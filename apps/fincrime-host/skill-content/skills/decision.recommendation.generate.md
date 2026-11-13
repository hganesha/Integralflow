## Business outcome

Map admitted control outcomes to a pinned policy recommendation while retaining the source controls as reasons. This skill recommends; it cannot record an authorized final decision.

## Procedure

1. Identify applicable controls and their requirement IDs. A parent gate must establish that required controls exist and refer to the current subject/product/policy/relationship basis.
2. Reduce the admitted outcomes under the current handler: any FAIL selects FAIL, otherwise UNKNOWN selects UNKNOWN, otherwise PASS. Preserve the actual reasons; absent/expired/not-applicable controls require explicit parent semantics rather than assumed sufficiency.
3. Read the approved recommendations map and select its recommendation for the reduced outcome. The current safe default is REVIEW when mapping is absent; never invent an automatic acceptance rule.
4. Return recommendation with all source controls. The parent workflow must independently enforce complete applicable requirements, exception scope, high-risk authority and review.
5. Use existing independent human review and protected final-command boundaries. Approval must bind to the exact action/context and cannot survive material changes without reassessment.

## Evidence and uncertainty

Keep source record versions, selected fields, as-of/knowledge-cutoff, policy snapshot and context/instruction hashes. Preserve contradictory claims and optional gaps. Source references support traceability but do not themselves establish truth or qualification. COMPLETED is an execution status; inspect domain outputs and parent requirements before a business conclusion.

## Variations

Acceptance eligibility, automatic/human authority, exception duration, risk tier, product and jurisdiction belong to approved policy/workflow gates. A recommendation under one control set is not a reusable approval for another relationship/product.

## Examples and acceptance

- At least one FAIL: use mapped FAIL recommendation with source reasons.
- No FAIL and at least one UNKNOWN: preserve UNKNOWN route.
- Recommendation mapping absent: REVIEW, never invented approval.
- Control stale or missing from required scope: parent gate blocks its business acceptance even if this mapping executes.
- Reviewer is also author/requestor: independent approval control refuses final authorization.

## Limitations

Bounded mapping over admitted controls, not complete applicability/requirement evaluation or final disposition. Parent gates must establish completeness and current control basis. Current maturity remains implemented_synthetic. Independent evaluation, policy/source approvals and operating qualification are required before production.
