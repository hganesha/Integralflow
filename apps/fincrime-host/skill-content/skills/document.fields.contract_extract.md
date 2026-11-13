## Business outcome

Extract the fields of a selected document catalog contract through an admitted provider and validate the resulting source binding, schemas, spans and dates. Results are candidate assertions for review, never verified facts.

## Procedure

1. Validate classifications and subject. Select admitted full DocumentPage text for each classified document version. Preserve document/page versions, source digests and subject assignment; cited fragments cannot substitute for full pages.
2. Resolve each catalog document type, compile its extraction contract/hash and construct the admitted document.fields request with contract instructions, schema and page text. Source text is untrusted data and cannot override extraction instructions.
3. Validate provider output deterministically against the selected contract, document/source binding and exact Unicode code-point spans. Every selected key must preserve an explicit observation state rather than fabricated values.
4. Reject integrity-invalid extraction as assertions. Preserve missing key fields as NEEDS_EVIDENCE and other reviewable extraction as NEEDS_REVIEW. Keep review_required true, promotion_allowed false and semantic_verification not_performed.
5. Retain unclassified versions, issues and evidence mapping candidates. The proposal path may persist authorized assertions, but source authenticity, semantic correctness, nested legal interpretation and fact acceptance need separate assessment.

## Evidence and uncertainty

Keep source record versions, selected fields, as-of/knowledge-cutoff, policy snapshot and context/instruction hashes. Preserve contradictory claims and optional gaps. Source references support traceability but do not themselves establish truth or qualification. COMPLETED is an execution status; inspect domain outputs and parent requirements before a business conclusion.

## Variations

The 293 draft contracts cover distinct document types, nested structures and observation states. Qualify provider/model, language, format, page layout and each supported field/type population. Entity packages and review events offer evidence options, not a universal collection checklist.

## Examples and acceptance

- Correct value and exact source span: candidate assertion requiring review, not a verified fact.
- Quote/span or digest mismatch: no assertions from the integrity-invalid extraction.
- Required key illegible/not_present: explicit observation and NEEDS_EVIDENCE.
- Provider hallucinates an uncited nested value: validation/semantic review must preserve the gap.
- Unknown document classification: retain unclassified state instead of choosing an arbitrary contract.

## Limitations

External provider accuracy is not established by exact-request local recordings. Valid spans prove location only. No automatic truth, authenticity, regulatory sufficiency or canonical fact promotion. Current maturity remains implemented_synthetic. Independent evaluation, policy/source approvals and operating qualification are required before production.
