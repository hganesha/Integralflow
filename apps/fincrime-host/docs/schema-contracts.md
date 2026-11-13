# Executable contracts and migration

Release **0.3.0** retains skill API **0.2.0** and canonical context schema **2.0.0**, introduced in release 0.2.0. This is a breaking context upgrade from the 0.1.0 reference bundle. All 222 skills remain jurisdiction-neutral synthetic implementations.

## Contract inventory

| Surface | Executable specification |
| --- | --- |
| 222 skill inputs and 222 outputs | `skills/<domain>/<skill>/input.schema.json` and `output.schema.json`; identical copies are installed in the wheel. |
| 87 canonical context data types | [Per-type schemas](../schemas/context/types/) and the [full record ontology](../schemas/context/ontology.schema.json). This includes all 27 formerly generic envelopes. |
| Full records and projected views | [Record](../schemas/runtime/Record.schema.json) and [RecordView](../schemas/runtime/RecordView.schema.json). |
| Runtime values | [Runtime schemas](../schemas/runtime/) include locks, metrics, errors, unresolved items, effect-command variants, manifests, catalog, profiles and workflows. |
| Nine provider capabilities | [18 request/response schemas](../schemas/providers/) from `financial_crime.payload_types.CAPABILITY_SCHEMAS`, enforced by the provider router; [ProviderResponse](../schemas/runtime/ProviderResponse.schema.json) defines the capture envelope. |
| Field consumption | [Context matrix](../catalog/context-matrix.json) and [reverse consumers](../catalog/context-consumers.json); 1,705 declarations. |

The generated [schema report](schema-contract-report.json) inventories 1,022 published schema files including installed resource copies, with content hashes and zero untyped containers. The definitions are maintained explicitly in `schema_types.py`, `context_types.py` and `payload_types.py`. Schemas are not inferred from sample executions.

## Shape and value rules

Business objects are closed (`additionalProperties: false`), arrays declare their element type, and maps declare their value type. Nested matching candidates, ownership paths, risk contributions, rules, coverage, filing content, provider assessments and commands have named definitions. Required fields, optional fields and nullable fields are distinct. Decimal money and exact ownership values use strings; constrained scores, hashes, timestamps, dates and enumerations validate their formats/ranges.

Dynamic data is deliberate: raw source/assertion/fact values, arbitrary predicate facts, JSON Schema documents and dispatcher payloads use recursive `JsonValue`/`JsonObject` types. They do not establish the truth of the underlying values. Registry-dependent input parameters are validated against the selected skill before execution; computed results and persisted `SkillExecution` payloads are checked against that skill's output contract. Generic comparison/evaluation inputs intentionally accept arbitrary JSON objects.

Canonical context additions belong under `extensions`, for example:

```json
{
  "extensions": {
    "institution.example": {
      "schema_version": "1.0.0",
      "value": {"source_category": "synthetic-test"}
    }
  }
}
```

Each extension needs an explicit version and a valid namespace; it may include a canonical `source_ref`. Existing skill declarations do not automatically consume extension values. A new business field or extension consumer requires an explicit declaration, schema and authorization review.

## Ingestion, projection and execution

`Record` validates the entire canonical data object on construction and again at repository ingestion. Its `object_type` selects the corresponding data schema. Invalid records cannot reach domain calculations through `model_copy` bypasses. Full records need all required canonical fields.

`RecordView` is the compiler's separate projection type. Its data keys must equal its unique `selected_fields`, and each value must satisfy the corresponding canonical field schema. It cannot be stored as a full record. Projection does not relax the source record contract or grant access to omitted fields.

Provider requests validate before dispatch; response payloads validate before capture/use. Effect commands validate against closed state/action variants before repository changes. JSON Schema validation uses a date/time format checker. The `quality.schema.validate` skill supports self-contained local references, rejects remote references, disables retrieval, and reports validation paths without echoing rejected source values.

Some controls depend on application semantics: tenant identity, exact version binding, temporal interval order, authorization, projection key equality, provider entitlement and evidence admission. JSON Schema consumers must also use the executor/ingestion APIs to obtain these checks; parsing a schema alone does not authorize an action.

## Version policy

- Skill versions, profile allowlists and context versions are pinned. This bundle contains one executable version per skill; unknown/old versions fail admission.
- New ingestion uses context `2.0.0`. Old stored records and old active references do not silently match current records by ID.
- Existing approvals, execution results, audit history and idempotency identities retain their original version and hashes. They must not be relabeled as new executions.
- Incompatible required fields, field closures, type changes or decision semantics require a versioned release. Comparison results needing review cannot be promoted automatically.

The original contracts are retained at [0.1.0 snapshot](../schemas/history/0.1.0/contracts.json), with a SHA-256 file checked by the builder. The [per-skill compatibility report](schema-compatibility.json) compares input acceptance and output production separately. The checker is conservative structural analysis, not a general proof of JSON Schema implication. Changes to references, bounds or composition that it cannot establish require review. Release upgrades always require explicit integration review, even where an individual surface compares as compatible.

## Explicit record migration

The pure `financial_crime.migrations.migrate_record(raw)` translator supports only canonical business records from context `1.0.0` to `2.0.0`. It returns a new version and leaves the source unchanged. It requires original identity, timestamps, classification, purposes and synthetic status; it preserves them and sets `supersedes`. Unrecognized top-level data fields are retained under `extensions.legacy.v1`; source hashes and migration provenance are retained under `extensions.migration.v1`. Namespace collisions stop migration.

```sh
.venv/bin/fc-skills migrate-record old-record.json --output new-record.json
```

The CLI refuses to overwrite an existing output. Migration never fabricates a missing required field, repairs an invalid nested value, grants broader access, or marks real evidence synthetic. Such records return `MIGRATION_REQUIRES_EVIDENCE` or `MIGRATION_REQUIRES_REVIEW`. Unsupported versions return `SCHEMA_VERSION_UNSUPPORTED`. Nested canonical references need explicit version mapping; migration normalizes only missing versions on metadata source references as legacy `1.0.0` references. References to old source versions remain historical provenance.

Execution/audit artifacts require their original versioned reader; this translator does not rewrite them. `migrate_invocation` requires new execution and idempotency identities, an explicitly selected profile, newly validated parameters and migrated active references. The caller must re-run normal context compilation, authorization and any required human approval. Old approvals are never carried forward.

For an individual schema comparison:

```sh
.venv/bin/fc-skills contract-diff old-input.json new-input.json --direction acceptance
.venv/bin/fc-skills contract-diff old-output.json new-output.json --direction production
```

Use separate versioned repository snapshots while integrating an upgrade. Migration is opt-in and does not modify an existing database or expand the current synthetic effect restrictions.

## Maintaining the contracts

Edit the explicit definitions and handlers together, add independent fixtures and rejection cases, and run `make catalog` followed by `make check`. The builder validates all published current schemas, rejects untyped/open containers, validates every manifest/catalog and checks the archived baseline hash. Historical schemas are evidence of the previous contract and are intentionally excluded from the current strictness audit.

Contract completeness establishes executable structure and validation. Real provider integration, institution policy approval, model accuracy evaluation and hosted deployment remain separate qualification work.
