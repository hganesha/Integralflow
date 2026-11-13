## Business outcome

Extract the fields of a selected document catalog contract through the LLM route and, for document types the route policy runs in shadow, through a provider extraction model, then compare the two routes field by field. The LLM route's values are the candidate assertions for review; the comparison tells the reviewer where the routes agree, where only one route found a grounded value and where they disagree. Nothing becomes a verified fact.

## Procedure

1. Validate classifications and subject. Select admitted full DocumentPage text for each classified document version, as document.fields.contract_extract does. Cited fragments cannot substitute for full pages.
2. Build and send the admitted document.fields request with the compiled contract, schema, instructions and page text, and validate the answer deterministically. An integrity-invalid LLM answer yields no assertions and fails the extraction, exactly as in document.fields.contract_extract.
3. Read the route mode for the document type from the route policy. In llm_only mode stop here. In shadow mode, call document.model for the admitted DocumentVersion artifact. Candidates for another document version or type, a missing DocumentVersion, or a provider that cannot answer leave the model route recorded as not run with its reason.
4. Anchor each model candidate on the page text: the value itself, then the text as printed, must occur in the pages. A value that does not occur is ambiguous, never given an invented span. Validate the anchored answer like any other answer.
5. Adjudicate the routes with the deterministic rules R1–R9 under the pinned adjudication policy. Propose the LLM route's values unchanged. Record each field's outcome, rule, review depth, candidates and the policy and input digests in the ehf.document.adjudication extension of its assertion. Raise a DOCUMENT_FIELD_CONFLICT question for every conflict, failed policy validator and OCR disagreement.
6. Keep review_required true, promotion_allowed false and semantic_verification not_performed.

## Evidence and uncertainty

Keep source record versions, page digests, the contract hash, both routes' answer digests, the adjudication and route policy digests and the as-of date. Agreement between routes is not truth: two routes that read the same wrong OCR agree on the wrong value. A grounded value is located on the page; it is not shown to be correctly interpreted.

## Variations

Route modes are per document type. Shadow mode covers the types with a provider model; every other type behaves as document.fields.contract_extract with no model call. A mode that proposes adjudicated values needs per-type benchmark evidence first.

## Examples and acceptance

- Both routes read the same grounded value: AGREED_GROUNDED, standard review, LLM value proposed.
- Routes read different grounded values: CONFLICT, a DOCUMENT_FIELD_CONFLICT question, LLM value still proposed.
- Model route unavailable: route not_run with its reason; the LLM values are proposed with SINGLE_ROUTE outcomes.
- Model candidate not on the page: ambiguous, ungrounded, never cited.
- Selected date fails a policy validator (for example an issue date before birth): VALIDATION_FAILED and a question.

## Limitations

External provider accuracy is not established by exact-request local recordings. Valid spans prove location only. In shadow mode the provider model route only adds review; its accuracy per type is measured by the document factory benchmark, not assumed. No automatic truth, authenticity, regulatory sufficiency or canonical fact promotion. Current maturity remains implemented_synthetic.
