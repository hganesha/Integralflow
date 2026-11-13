## Business outcome

Find admitted adverse-media events matching a requested subject name while preserving allegation status, source scope and negative-search limitations. This is captured-record evaluation, not a live web search or an independent finding of wrongdoing.

## Procedure

1. Validate the requested name and retain original/normalized forms. The handler compares normalized name to captured subjects in AdverseMediaEvent; it does not independently disambiguate the identity.
2. Inspect matching captured ScreeningExecution records for adverse_media with the same query. Completion requires completed untruncated searches with dataset versions, scope and query time not after as-of.
3. Return matching events and captured coverage. Preserve article status and source. Events can complete the bounded retrieval operation; without events or completed searches, preserve review/evidence-needed behavior.
4. Do not count syndicated/repeated stories as independent corroboration. Use correlation/classification and investigation steps to assess relevance, identity, source reliability, allegations versus adjudicated outcomes and competing evidence.
5. Route unresolved provider candidates, missing source coverage and disputed identity to review. The parent screening requirement must establish all required subject/query/language scopes.

## Evidence and uncertainty

Keep source record versions, selected fields, as-of/knowledge-cutoff, policy snapshot and context/instruction hashes. Preserve contradictory claims and optional gaps. Source references support traceability but do not themselves establish truth or qualification. COMPLETED is an execution status; inspect domain outputs and parent requirements before a business conclusion.

## Variations

Qualify supported languages, source types, search depth, dates, subject aliases, jurisdictions and relevance categories. A negative licensed dataset query is not proof that no public adverse information exists. EDD triggers and exposure interpretation belong to approved policy.

## Examples and acceptance

- Captured event with matching normalized subject: retain its allegation status and source.
- Zero events with completed scoped query: bounded negative-search evidence only.
- Provider candidates without matching event material: review/evidence gap remains.
- Same story across outlets: correlated evidence, not independent corroboration.

## Limitations

Exact normalized subject matching over captured records; no live discovery, semantic relevance classifier, identity verification or final adverse finding. Current maturity remains implemented_synthetic. Independent evaluation, policy/source approvals and operating qualification are required before production.
