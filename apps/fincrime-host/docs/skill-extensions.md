# EHF extension skills

The canonical catalog has exactly the 222 skills of `financial_crime_canonical_skills_spec_v1.md`.
Extension skills are added beside it for EHF. Each one wraps a canonical skill: it declares the
wrapped skill as a dependency, keeps that skill's semantics, and adds capabilities the canonical
contract cannot carry without a breaking change: the document field contracts (`kyc_documents`) and
the per-requirement control outcomes the decision steps read.

Rules for an extension skill:

- It never changes a canonical skill's ID, version, parameters, outputs or behavior.
- Its ID extends the wrapped skill's domain (`document.*`, `decision.*`, `risk.*`) and does not reuse a canonical ID.
- It has a design row below, used for its `SKILL.md` procedure, and an `#### \`id\`` heading
  that `scripts/build_catalog.py` reads to admit it.
- Its outputs follow the canonical conventions. Gaps and conflicts are reported in the payload.
  Nothing here verifies, approves or promotes a value.

## Document intelligence

Wraps `document.*` with the document field catalog (293 document types, `src/kyc_documents`). See
`docs/document-field-design.md` and EHF's `docs/implementation/document-intelligence.md`.

#### `document.classify.catalog`
Wraps `document.classify`. Classifies each document version into the catalog by exact title, name and alias matches, with spans.

#### `document.parse.artifact`
Wraps `document.parse`. Returns a document version's full page text with lineage, from admitted full-text pages or an admitted OCR provider (`document.ocr`).

#### `document.fields.contract_extract`
Wraps `document.fields.extract`. Extracts every field of a catalog contract through an admitted provider (`document.fields`), then validates it deterministically with `kyc_documents.runtime.validate_extraction`.

#### `document.fields.adjudicated_extract`
Wraps `document.fields.extract`. Extracts a catalog contract through the LLM route (`document.fields`) as `document.fields.contract_extract` does and, for types the route policy runs in shadow, through a provider extraction model (`document.model`); adjudicates the two routes field by field with `kyc_documents.adjudication.adjudicate`. The LLM route's values are proposed; each outcome is recorded beside its assertion and disagreements raise `DOCUMENT_FIELD_CONFLICT` questions.

#### `document.validity.assess`
Wraps `document.validity.check`. Assesses extracted issue and expiry dates at the as-of time, keeping their stated precision.

#### `document.consistency.assess`
Wraps `document.consistency.check`. Compares a subject's extracted top-level fields across document versions after case and whitespace normalization.

#### `document.requirements.resolve`
Wraps `document.requirements.evaluate`. Resolves the policy's required document types onto the catalog and lists candidate evidence options from an entity package or review event.

#### `document.request.compose`
Wraps `document.request.generate`. Writes request text from catalog display names and key fields. It sends nothing.

## Designs

| Skill | Baseline mode | Wave | Proposed implementation behavior and acceptance focus |
| --- | --- | --- | --- |
| `document.classify.catalog` | deterministic | EHF-1 | Match catalog display names, IDs and aliases with word boundaries; a single title-area match or a single overall match decides; several candidates stay `UNKNOWN` with every match span. |
| `document.parse.artifact` | provider | EHF-1 | Prefer admitted `full_text` DocumentPages for the version; otherwise call `document.ocr` for the DocumentVersion artifact; pages must be numbered 1..n; `complete` only when the page count matches. |
| `document.fields.contract_extract` | model-assisted | EHF-1 | Use admitted whole pages (EHF never emits cited fragments as pages); send the compiled contract, schema, instructions and pages as untrusted data; validate schema, source binding, spans and dates; integrity failures yield no assertions; key-field gaps return NEEDS_EVIDENCE; nothing is promoted. |
| `document.fields.adjudicated_extract` | model-assisted | EHF-1 | As `document.fields.contract_extract` for the LLM route; in shadow, the model route's candidates must name the same document version and type and are anchored on the page text before `adjudicate` (deterministic rules R1–R9); a model route that cannot run is recorded as not run; proposed values are the LLM route's; outcomes go in the `ehf.document.adjudication` extension; conflicts, failed validators and OCR disagreements add review; nothing is promoted. |
| `document.validity.assess` | deterministic | EHF-1 | Apply `issued_at <= as_of < expires_at` to the range of days a stated date can mean; a partial date decides only when the whole range agrees; an absent expiry is `EXPIRY_NOT_EXTRACTED`, never "valid". |
| `document.consistency.assess` | deterministic | EHF-1 | Group by subject and field (EHF records only top-level scalar fields as ExtractedAssertion); report every differing value with its document version and source reference. |
| `document.requirements.resolve` | deterministic | EHF-1 | Resolve policy types and present types through catalog IDs and aliases; uncataloged policy types are never satisfied; package and event documents are options, not obligations. |
| `document.request.compose` | deterministic | EHF-1 | Only catalog types produce request text; unknown types are listed; `sent` is always false. |

## Decision controls

Wraps `decision.*` with the control outcomes `decision.recommendation.generate`, `decision.gaps.evaluate`
and `quality.policy.compliance` read as `Control` records, which no canonical skill produces.

#### `decision.controls.assess`
Wraps `decision.requirements.compile`. Compiles each requirement's applicability the same way, then evaluates the pinned policy's `control` predicates (`pass`, optional `fail`) over the bound facts: PASS only on the pass condition, FAIL only on the stated failure condition, UNKNOWN otherwise.

## Risk factors

#### `risk.factors.derive`
Wraps `risk.factor.evaluate`. Scores every factor the pinned `risk_weights` name from the case's recorded values through the pinned `risk_factor_maps` (the highest score of a factor's values); a value without a score, or no recorded value, leaves the factor unscored and the result NEEDS_EVIDENCE.
