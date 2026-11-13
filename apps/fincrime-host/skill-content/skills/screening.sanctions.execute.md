## Business outcome

Evaluate admitted sanctions search records, retain candidates and identify incomplete subject coverage. Use after approved source acquisition. Source retrieval, ownership/control evaluation and final disposition belong to separately declared workflow steps.

## Procedure

1. Establish the required subject scope in the parent workflow. Preserve entity IDs, roles, original names, identifiers and query provenance. Shared names cannot merge distinct parties.
2. Require screening_threshold in the pinned policy. Select sanctions WatchlistEntry records and use the deterministic matcher. Preserve name score, shared identifiers and contradictions; the synthetic score is not match probability.
3. Keep any recorded provider candidates visible even if local matching finds no hit. Candidate existence routes to NEEDS_REVIEW; the local heuristic cannot authorize a false-positive disposition.
4. Evaluate search-completion evidence for admitted subjects. The current predicate recognizes completed untruncated executions with dataset versions, scope and query time at or before as-of. The alternative list-coverage predicate is bounded reference behavior, not proof of full institution-required subject/list coverage.
5. Return NEEDS_EVIDENCE when no candidate exists and completion cannot be established. Return COMPLETED only as execution completion, retain captured coverage and universal_clearance false.
6. The qualified parent workflow must establish list publication/freshness, applicable datasets, entitlement, jurisdiction and all related parties, and complete required ownership/control steps before a business conclusion. Human disposition and consequential actions use separate authority.

## Evidence and uncertainty

Keep source record versions, selected fields, as-of/knowledge-cutoff, policy snapshot and context/instruction hashes. Preserve contradictory claims and optional gaps. Source references support traceability but do not themselves establish truth or qualification. COMPLETED is an execution status; inspect domain outputs and parent requirements before a business conclusion.

## Variations

Jurisdiction, required party roles, lists, languages/aliases, product and lifecycle alter the required screening scope. Equivalent provider fallback needs approved comparable coverage. Retrieval time cannot substitute for list publication; unsupported source scope remains a gap.

## Examples and acceptance

- Completed zero-candidate searches for every required subject: scoped negative evidence, no fabricated watchlist entry and no universal clearance.
- Provider candidate_count positive with no local hit: NEEDS_REVIEW.
- One related party missing or execution truncated: parent coverage remains unresolved.
- Contradictory identifiers on a possible match: preserve contradiction and route review.
- Ownership or control question: invoke the correct separate skill and preserve unresolved state.

## Limitations

No provider acquisition, ownership/control evaluation or final disposition in this handler. Synthetic local matching is uncalibrated. Additional source/publication and full subject/list-scope controls require enclosing workflow qualification. Current maturity remains implemented_synthetic. Independent evaluation, policy/source approvals and operating qualification are required before production.
