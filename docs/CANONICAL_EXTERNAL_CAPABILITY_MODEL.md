# Canonical external capability model and complete adapter crosswalk

**Status:** proposed design and source-derived mapping inventory; no runtime contracts changed.  
**Implementation:** steps 2–4 of section 6.2 are implemented. Registries, schemas and backfill are proposed, disabled records (`kyc-provider-atlas/capability-model/`, `api-wiring/vendor_connections/mappings/`). Vendor-test normalization takes capability and role from the operation mapping and returns operation receipts. Conditional dispatch branches are rejected as unconfigured until they are specified. Steps 5–7 remain open.  
**Reviewed:** 7 November 2026.  
**Repository baseline:** `63b95910238b3f074fc5d61693bb8861061af6d3`.

Adopt **`<capability_path>.intelligence.<jurisdiction>`** as the provider-independent capability key. For example, `business.registry.intelligence.gb`, `identity.tax_id.intelligence.mx`, and `screening.sanctions.intelligence.us`. Here `xxx` is a controlled, potentially multi-segment capability path, not a vendor name. Keep the requested business action, native operation lifecycle, source datasets, evidence, jurisdiction basis and execution readiness as separate typed fields.

This document defines the model and maps every checked-in catalog binding, adapter manifest and documented vendor operation to it. Mapping an entry is a design decision, not proof that the provider supports it or that the route can run. The inventories are the authoritative local JSON catalogs, manifests, connection templates and vendor definitions. Raw imported API schemas may contain additional, unselected endpoints; ZIP snapshots, workbooks and HTML views are not counted as independent mapped entries. The review used local source files, including their documentation as evidence; instructions embedded in source documents were not treated as user requests. Vendor websites, legal entitlements and real sandbox behavior were not revalidated.

## Contents

- [1. Review scope and findings](#1-review-scope-and-findings)
- [2. Canonical naming and jurisdiction](#2-canonical-naming-and-jurisdiction)
- [3. Typed canonical model](#3-typed-canonical-model)
- [4. Capability dictionary and legacy crosswalk](#4-capability-dictionary-and-legacy-crosswalk)
- [5. Mapping rules and semantic corrections](#5-mapping-rules-and-semantic-corrections)
- [6. Resolution and migration](#6-resolution-and-migration)
- [7. Coverage verification](#7-coverage-verification)
- [Appendix A: every catalog record and binding](#appendix-a-every-catalog-record-and-binding)
- [Appendix B: every fixture adapter](#appendix-b-every-fixture-adapter)
- [Appendix C: every documented vendor operation](#appendix-c-every-documented-vendor-operation)
- [Appendix D: source fingerprints](#appendix-d-source-fingerprints)

## 1. Review scope and findings

The current catalog is useful as discovery inventory, but its capability model lacks enough semantics to be a durable routing contract.

| Reviewed inventory | Count | Interpretation |
| --- | --- | --- |
| Legacy capability labels / result families | 37 / 18 | Every capability definition repeats the same generic support caveat. |
| Provider catalog records | 376 | Products, services, registries and historical records; not distinct verified vendors. |
| Provider × legacy capability bindings | 824 | 815 proposed-only and 9 fixture-tested; all 824 country allowlists are empty. |
| Connection templates | 824 | Same operation-ID set as the catalog; templates are disabled/unapproved. |
| Approved connection contracts | 0 | `api-wiring/config/contracts.json` is empty. |
| Representative inbound normalizers / manifests | 9 | Synthetic fixture support for one declared legacy capability each. |
| Outbound offline planners / native host connector subsets | 6 / 6 | Persona, Companies House, OpenCorporates, GLEIF, OpenSanctions and Plaid. |
| Documented vendor definitions / operations | 42 / 732 | Separate native testing layer; all definitions say live_tested=false. |
| Vendor operations with `semantics=vendor_native` | 626 | No precise capability can safely be inferred from that generic label. |
| Quarantined records / bindings | 1 / 2 | Finantier; retain quarantine through migration. |
| Proposed canonical families | 56 | 37 legacy-compatible paths plus 19 adjacent/data/control paths. |

### Findings that drive the design

1. **Definitions do not define the contract.** All 37 entries in [capabilities.json](../tools/kyc-provider-atlas/catalog/capabilities.json) use “Host-controlled capability; provider support must be proven separately.” Result-family membership does not establish inputs, outputs, success conditions or coverage. Section 4 supplies distinct meanings.
2. **Capability inference is too broad.** [vendor_connections/normalization.py](../api-wiring/vendor_connections/normalization.py) defaults `account_data` to `account.ownership.verify`, `screening` to `screening.sanctions`, `business_data` to `business.registry.lookup`, and most other semantics, including `vendor_native`, to `identity.person.verify`. The envelope is conservative about findings, but the capability label itself can be misleading. A balance call is not an ownership comparison; an adverse-media call is not sanctions screening; an LEI lookup is not a business-registry check.
3. **Caller context can supply a legacy capability without an operation-specific semantic allowlist.** The same normalizer reads `context.capability` before its coarse fallback. Canonical mapping must be selected from a versioned operation contract, with explicit allowed subjects/actions, rather than accepting a label as proof of a native operation's semantics.
4. **Country and jurisdiction are conflated.** Every catalog `country_allowlist` is empty. Provider `market_orientation_unverified` contains values such as Global, Europe and US / Global subjects. These do not establish eligible subject countries, issuing authorities, sanctioned-list authorities or processing residency. National-source hints can help a proposal, but do not enable a binding.
5. **Some proposed catalog bindings conflict with the catalog's own notes.** RENAPO, Saudi Elm and Bahrain BENEFIT eKYC appear under `business.registry.lookup`; their notes describe person identity/eKYC sources. FinCEN BOI is ownership information, CKYCR is an existing KYC record source, and Wolfsberg publishes questionnaire standards. Section 5 records explicit corrections instead of copying the original label.
6. **Provider IDs differ across layers.** The vendor definition `entrust-onfido` is absent from the provider catalog, which uses `entrust-identity-verification`. The Companies House manifest/adapter ID is `companies_house`, while the provider ID is `companies-house`. Preserve these separate identities with an explicit alias table; do not globally replace punctuation or merge legal contracting entities by name.
7. **Implementation is narrower than catalog membership.** Each fixture normalizer declares one capability. Persona/Sumsub/Veriff having document/biometric catalog rows does not prove a field mapper for each row. GLEIF normalizes to `reference.identifier.lookup`; its vendor definition uses coarse `business_data`. Only specific vendor operations use the deep normalizers. The operation appendix does not promote all calls to fixture-tested status.
8. **Two copies and generated sources can drift.** The three atlas catalog JSON files currently match their vendored copies byte for byte. Changes must be made in the generators as well as published artifacts. Persona's manifest/planner and vendor definition also pin different API versions (`2026-09-29` versus `2023-01-05`); they need separate versioned bindings until reconciled.

These are findings about the checked-in model and mapping behavior. They are not claims that the named vendors lack a product or that live vendor endpoints are currently incorrect.

## 2. Canonical naming and jurisdiction

### 2.1 Key grammar

```text
capability_id = capability_path + ".intelligence." + jurisdiction
capability_path = a registered lower_snake_case path of one or more dot-separated tokens
jurisdiction = a registered country/subdivision/authority token, "global", or "unresolved"

Shape regex (registry membership is additionally required):
^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*\.intelligence\.(?:[a-z]{2}(?:_[a-z0-9]+)?|global|unresolved)$
```

Examples:

| Key | Meaning |
| --- | --- |
| `business.registry.intelligence.gb` | United Kingdom registry facts; registry namespace remains explicit. |
| `business.registry.intelligence.us_de` | A Delaware registry contract, if specifically defined and entitled; a US family record does not prove this binding. |
| `identity.tax_id.intelligence.mx` | Mexican-issued tax-identifier verification; calculated identifiers use `identity.identifier.derivation` instead. |
| `screening.sanctions.intelligence.us` | Screening against explicitly named US-authority sanctions datasets; it can concern subjects in any country. |
| `reference.list.intelligence.un` | A UN-published list acquisition contract; not a subject screening result. |
| `risk.jurisdiction.intelligence.global` | An explicitly defined cross-border country-risk publication/assessment contract, with target countries supplied separately. |
| `account.profile.intelligence.unresolved` | A catalog proposal whose account-servicing jurisdiction is not established; never live-routable. |

The suffix is **one declared semantic jurisdiction**, selected according to the capability definition. It is never simultaneously the provider headquarters, subject residence, policy jurisdiction and storage region. Capability IDs do not include provider, API operation, API version, environment, tenant or product. Versions belong in fields; national identifier namespaces and document types belong in selectors. Do not create `persona.intelligence.us` or a wildcard country binding.

### 2.2 Jurisdiction basis

A `CapabilityDefinition.jurisdiction_basis` fixes how to interpret the suffix. It cannot vary between bindings for the same definition.

| Basis | Use | Other necessary scope fields |
| --- | --- | --- |
| `registry_authority` | Business registry/verification, officers, ownership filings and financial-institution reference | registry_namespace; incorporation/registration jurisdiction; local identifier scheme |
| `issuer_authority` | Person/document/digital-ID/tax-ID/credential/vehicle checks | issuing country/authority; document/identifier/credential type; eligible subject countries |
| `dataset_authority` | Sanctions, enforcement and official-list acquisition | publisher authority; dataset IDs/categories/versions; applicable regimes |
| `policy_jurisdiction` | PEP/media/custom watchlist, risk, entity resolution, workflow/case/monitoring/reporting, signatures and questionnaires | policy jurisdiction; publisher/source locations; subject countries; legal report regime where relevant |
| `financial_source_authority` | Income/employment evidence | income-source authority and source country; employer/source institution; subject countries |
| `account_servicing` | Account, financial evidence/transactions/balances/analytics/personal-finance functions | institution and account-servicing country; account/identifier namespace; source institution country |
| `integration_scope` | Platform controls and synthetic testing | binding to one parent scope or explicitly defined global integration; deployment/processing region stays separate |

Every dictionary row fixes its kind and jurisdiction basis. Commercial-provider mappings with that basis unresolved stay blocked; the suffix cannot be interpreted differently by the resolver.

For mixed-authority screening, create one parent composite request and independently scoped child results, or select a registered `global` composite definition with an explicit dataset set. Never infer US sanctions coverage from an endpoint hosted in the US. A sanctions list's publisher jurisdiction does not restrict subject nationality.

A jurisdiction registry maps canonical tokens to source-native codes. Use lowercase two-letter country tokens (`gb`, not `uk`); subdivisions such as `us_de` require a registry entry. `eu` and `un` are explicitly registered authority tokens, not asserted to be countries. Cross-border bodies such as FATF/World Bank require an explicit authority registry record or an approved global definition; do not invent ISO codes. Preserve original codes, for example OpenCorporates `us_de`, alongside normalized authority identifiers.

- **`unresolved`** is permitted only in inventory/proposals. It means the semantic jurisdiction has not been established and is blocked from execution. It is not an alias for global and cannot be requested for a live check.
- **`global`** means a deliberately defined cross-border contract with explicit source/dataset and entitlement scope. A “Global” marketing orientation and an empty country list never justify it. No current binding is promoted to global by this review.
- **Concrete suffixes in the appendices are proposed source scope.** For single-country national-source records they come from the catalog's explicitly unverified market hint; official lists use publisher identity. Neither establishes approved runtime coverage. Every migrated catalog binding remains disabled.
- **Multiple countries** expand to separate child bindings after validation. AAMVA's US/Canada family, EU BRIS's federation and a provider's regional footprint remain unresolved until their actual sources are selected.
- **Residency** is always separate: use storage/processing regions and cross-border policy fields, never overload the suffix.

## 3. Typed canonical model

Treat these as separate records with stable IDs and referential integrity. The YAML below is a proposed data contract, not an implementation claim or an accepted payload for the current v1 API.

### 3.1 CapabilityDefinition: what an interchangeable capability promises

```yaml
capability_path: account.ownership
model_version: 2.0.0
definition_version: 1.0.0
kind: intelligence                         # intelligence | operational | reference | testing
jurisdiction_basis: account_servicing
subject_types: [account, person, organization]
allowed_actions: [verify]
input_schema_ref: schemas/v2/account-ownership-request.schema.json
output_schema_ref: schemas/v2/account-ownership-result.schema.json
required_inputs:
  - subject_entity_id
  - account_identifier_or_token_ref
  - comparison_fields
  - purpose
  - policy_ref
required_outputs:
  - compared_fields
  - field_comparisons
  - comparison_method
  - source_account_ref
  - evidence_refs
  - requested_scope
  - checked_scope
  - coverage_status
success_semantics: comparison_executed         # does not imply matched or institution approved
invariants:
  - no_ownership_outcome_without_holder_comparison
  - account_profile_retrieval_does_not_satisfy_this_contract
  - scores_keep_native_scale_and_threshold_provenance
  - technical_success_is_not_verification_success
legacy_aliases: [account.ownership.verify]
owner: capability-governance
```

`required_inputs` and `required_outputs` are machine-validated requirements encoded in the referenced JSON schemas, not free-text labels used as a substitute for schemas. Each of the 56 dictionary entries must receive its own schemas and invariants before implementation. Versioned references above are intended future paths and do not yet exist. Sections 3.2–3.4 define the common fields those schemas compose.

The 18 existing host result unions are reusable payload families, not capability definitions. New result kinds in section 4 are proposed schemas; they are not valid under the existing host schema. Operational capabilities (case management, reporting, exchange, subscriptions, workflow and platform controls) retain the requested `.intelligence.` namespace but use `kind=operational`; the name itself grants no evidence status. List/identifier/template contracts use `kind=reference`, and sandbox contracts use `kind=testing`.

### 3.2 ProviderCapabilityBinding: who can supply which scoped contract

```yaml
binding_id: binding:plaid:identity-match:us:v1   # stable opaque ID; example, not current entitlement
provider_record_id: plaid
provider_family_id: plaid
contracting_entity_id: null                  # must be resolved for enablement
product_id: identity_match
capability_id: account.ownership.intelligence.us
capability_definition_ref: account.ownership@1.0.0
model_version: 2.0.0
actions: [verify]
subject_types: [person, account]
selectors:
  account_identifier_schemes: []
  comparison_fields: [legal_name]
  document_types: []
  identifier_schemes: []
  registry_namespaces: []
  protocols: []
jurisdiction:
  code: us
  basis: account_servicing
  resolution_status: proposed                # proposed | evidence_supported | approved
  evidence_refs: []
coverage:
  status: unknown                           # unknown | partial | complete | not_supported
  eligible_subject_countries: []             # [] means none established
  eligible_account_countries: []
  issuing_authorities: []
  dataset_refs: []                           # publisher + dataset ID + category + version/as-of
  excluded_scopes: []
  freshness_policy_ref: null
  assessed_at: null
  coverage_evidence_refs: []
operation_mapping_refs: [operation-map:plaid:identityMatch:v1]
versions:
  native_api: null
  native_schema_digest: null
  adapter: null
  request_mapping: null
  response_mapping: null
  host_schema: null
implementation:
  transport: documented_unverified
  request_mapping: proposed
  response_mapping: fixture_tested_subset
  validation: synthetic_fixture               # never treat as real sandbox acceptance
  accepted_test_evidence_refs: []
access:
  tenant_ids: []
  environments: []
  allowed_purposes: []
  policy_refs: []
  entitlement_ref: null
  consent_requirement_ref: null
  secret_ref: null
  approved_endpoints: []
  processing_regions: []
  storage_regions: []
  permitted_dataset_refs: []
governance:
  enabled: false
  approval_ref: null
  quarantine: false
  blockers: [jurisdiction_not_approved, coverage_unknown, entitlement_missing, sandbox_acceptance_missing]
lineage:
  legacy_binding_ids: [plaid:account.ownership.verify]
  source_file: kyc-provider-atlas/catalog/provider-capabilities.json
```

The example's `us` is illustrative, not a claim of current Plaid scope. `binding_id` is not calculated solely as `provider_id:capability_id`: one provider can expose multiple products, source datasets, tenants, versions or transports for the same capability. Keep history instead of overwriting the binding. Coverage evidence, transport implementation, field mapping and execution authorization are independent dimensions. A documented HTTP client must not make a proposed field mapper look validated.

### 3.3 NativeOperationMapping: what one vendor call actually does

```yaml
operation_mapping_id: operation-map:plaid:identityMatch:v1
vendor_definition_id: plaid
native_operation_id: identityMatch             # preserve source operation ID exactly
native_method: POST
native_path: /identity/match
native_semantics_original: vendor_native
primary_capability_path: account.ownership
jurisdiction_source: binding.account_servicing_country
operation_role: verify
operation_kind: subject_comparison
mapping_relation: proposed_semantic_mapping
mapping_evidence_refs: []
request_schema_ref: null
response_schema_ref: null
request_mapping_ref: null
response_mapping_ref: null
preconditions: [subject_fields_present, account_token_entitled]
enables: []
produces: [field_comparisons]                  # only after actual mapped response validation
conditional_dispatch: []
status: proposed
```

Allowed operation roles in this inventory are `lookup`, `retrieve`, `verify`, `validate`, `derive`, `extract`, `assess`, `screen`, `enrich`, `ingest`, `upload`, `submit`, `control` and `simulate`. The role describes the operation, while the definition's `allowed_actions` describes the consuming business contract. For example, a `submit` call may **enable** an identity verification contract without **producing** a verification result. The mapping schema enforces that `upload`, `submit`, `control` and `simulate` have no completed check outcome in `produces`. A status retrieval can yield an empty/pending state; it need not produce findings.

For the grouped `platform.integration` family, require `operation_kind` from: `authentication`, `authorization`, `consent`, `subject_resource`, `session`, `webhook`, `health`, `catalog_metadata`, `audit`, `queue`, `communication`, `manual_review`, `retention_delete`, `scheduling`, `resource_configuration` or `reconciliation_metadata`. These are controlled subtypes, not permission to return an arbitrary payload as intelligence. Preserve the original method/path/operation ID; define separate typed control request/result schemas. Use `enables[]` to identify known downstream capability bindings. A native provider `approve` operation is a workflow/manual-review control, never an institution approval.

The appendix gives a primary family and lifecycle role, not a completed NativeOperationMapping record. Before enablement, each operation also needs its operation_kind, enables/produces, schemas, field pointers, dispatch predicates, version and evidence references populated and validated. Control rows may enable the family they are grouped under, but cannot satisfy its default business action by themselves.

A generic `/checks` operation must have `conditional_dispatch` keyed by native check type, report name or template ID. Each branch names allowed subject types, a capability definition and its mapping schemas. Until those branches are specified, it is inventory-only even if the appendix shows its provisional aggregate family. A caller cannot override the primary contract through `context.capability`.

### 3.4 Request and result contracts

```yaml
# CanonicalCapabilityRequest v2 (future schema)
request_id: req-001
tenant_id: tenant-001
capability_id: business.registry.intelligence.gb
capability_definition_version: 1.0.0
action: lookup
subject_entity_id: organization-001
input:
  identifier: {scheme: company_registration, jurisdiction: gb, value: '01234567'}
  registry_namespace: companies_house
scope:
  requested_jurisdictions: [gb]
  requested_dataset_refs: [companies_house_company_profile]
  subject_countries: []
  as_of: null
  freshness_policy_ref: registry-current
purpose: customer_due_diligence
policy_ref: policy:kyb:version-1
consent_ref: null
routing:
  provider_allowlist: [companies-house]
  binding_allowlist: []
  permitted_processing_regions: []
  permitted_storage_regions: []
  fallback_policy_ref: null
idempotency_key: req-001
```

```yaml
# CanonicalCapabilityResult v2 (future schema)
result_id: res-001
request_id: req-001
tenant_id: tenant-001
capability_id: business.registry.intelligence.gb
capability_definition_version: 1.0.0
binding_id: binding:companies-house:profile:gb:v1
operation_mapping_id: operation-map:companies-house:get-company:v1
execution: {status: completed}
assessment:
  outcome: not_applicable                     # successful data retrieval need not be a verification pass
  provider_outcome_original: null
  bank_decision: not_evaluated
coverage:
  status: partial
  requested_scope: [company_profile, beneficial_owners]
  checked_scope: [company_profile]
  not_checked_scope: [beneficial_owners]
  dataset_versions: []
  reason_codes: [ownership_not_requested_from_source]
result:
  kind: business
  organization_entity_id: organization-001
assertions: []
relationships: []
evidence_refs: []
raw_payload_ref: null
warnings: []
```

Examples illustrate envelope structure; they omit actual findings/evidence and are not accepted fixtures. Add the existing entity graph, timestamps, errors, raw-byte digest, provider provenance and evidence-vault fields through shared schemas. Every finding references source evidence, retrieval time, effective/as-of time where supplied, authority and mapping version. Preserve restricted native material through vault references.

Keep these dimensions independent:

| Dimension | Example | Meaning |
| --- | --- | --- |
| Execution | `pending`, `completed`, `failed`, `reconciliation_required` | Technical lifecycle; ambiguous paid calls retain reconciliation state. |
| Assessment | `unknown`, `not_checked`, `inconclusive`, `matched`, `not_matched`, `not_applicable` | Capability-specific finding; current verification values such as `passed`, `failed`, `resubmit` require an explicit versioned translation. |
| Coverage | `unknown`, `partial`, `complete`, `not_supported` | What requested sources/checks were actually covered; completeness is relative to a declared scope. |
| Evidence status | proposed mapping / fixture / sandbox / production evidence | Strength and provenance of the adapter implementation, not a subject's risk. |
| Institution decision | `not_evaluated` in the adapter layer | Downstream policy/analyst responsibility. |

For screening, an empty candidate list means only no candidates returned within the successfully checked, versioned scope. It is never a legal clearance. For ownership, missing edges cannot establish no beneficial owner. For risk, scores with different native scales must not be compared without a governed transformation. For a composite operation, preserve child capability IDs and independent coverage; partial upstream success cannot be silently promoted to complete.

## 4. Capability dictionary and legacy crosswalk

The following 37 rows exhaust the existing capability enum. Each row defines a provider-independent family, default business action and semantic output requirement. Append a jurisdiction according to section 2. Actions such as monitoring update/cancel or regulatory draft/submit need explicit allowed-action contracts during schema implementation; they are not inferred from the family name.

| Legacy capability | Canonical template | Kind / jurisdiction basis | Subjects | Business action | Result family | Definition |
| --- | --- | --- | --- | --- | --- | --- |
| `identity.person.verify` | `identity.person.intelligence.[jurisdiction]` | `intelligence` / `issuer_authority` | person | `verify` | `verification` | Corroborate a person against named identity sources; return individual checks, matched fields and gaps. |
| `identity.document.verify` | `identity.document.intelligence.[jurisdiction]` | `intelligence` / `issuer_authority` | document | `verify` | `verification` | Assess document authenticity and validity; state document type, issuer, expiry and the checks actually performed. |
| `identity.biometric.verify` | `identity.biometric.intelligence.[jurisdiction]` | `intelligence` / `issuer_authority` | person | `verify` | `verification` | Return face/fingerprint comparison, liveness or presentation-attack findings with method, reference and thresholds; distinguish 1:1 from 1:N. |
| `identity.address.verify` | `identity.address.intelligence.[jurisdiction]` | `intelligence` / `issuer_authority` | person, organization | `verify` | `verification` | Corroborate an address using a named source and method; address parsing alone is insufficient. |
| `identity.digital_id.verify` | `identity.digital_id.intelligence.[jurisdiction]` | `intelligence` / `issuer_authority` | person, organization | `verify` | `verification` | Validate a digital-identity assertion, issuer, audience, trust scheme and assurance; session login alone is insufficient. |
| `identity.tax_id.verify` | `identity.tax_id.intelligence.[jurisdiction]` | `intelligence` / `issuer_authority` | person, organization | `verify` | `verification` | Validate a tax identifier in its issuer namespace and return any evidenced name/status match; syntax calculation is not validation. |
| `business.verify` | `business.verification.intelligence.[jurisdiction]` | `intelligence` / `registry_authority` | organization | `verify` | `business` | Verify specified business facts against evidenced sources; registry retrieval alone is not a verified business outcome. |
| `business.registry.lookup` | `business.registry.intelligence.[jurisdiction]` | `intelligence` / `registry_authority` | organization | `lookup` | `business` | Retrieve a registered organization, status and filing references in an explicit registry namespace. |
| `business.ownership.discover` | `business.ownership.intelligence.[jurisdiction]` | `intelligence` / `registry_authority` | organization | `discover` | `ownership` | Return dated ownership/control edges, interest types, source and completeness; distinguish legal ownership, control and accounting parents. |
| `business.officers.lookup` | `business.officers.intelligence.[jurisdiction]` | `intelligence` / `registry_authority` | organization, person | `lookup` | `ownership` | Retrieve officer roles, appointments, resignations and disqualification facts with dates and source. |
| `screening.sanctions` | `screening.sanctions.intelligence.[jurisdiction]` | `intelligence` / `dataset_authority` | person, organization, vessel, account | `screen` | `screening` | Match against explicitly named sanctions datasets and versions; return candidates and coverage, without a legal clearance decision. |
| `screening.pep` | `screening.pep.intelligence.[jurisdiction]` | `intelligence` / `policy_jurisdiction` | person | `screen` | `screening` | Return political-exposure candidates, roles, relationships and time intervals under an explicit PEP definition. |
| `screening.adverse_media` | `screening.adverse_media.intelligence.[jurisdiction]` | `intelligence` / `policy_jurisdiction` | person, organization | `screen` | `screening` | Return attributed media findings with publication date, language and allegation/proceeding status; do not imply sanctions coverage. |
| `screening.enforcement` | `screening.enforcement.intelligence.[jurisdiction]` | `intelligence` / `dataset_authority` | person, organization | `screen` | `screening` | Return regulator, court, debarment or enforcement candidates with action type and source; distinguish these from financial sanctions. |
| `screening.payment` | `screening.payment.intelligence.[jurisdiction]` | `intelligence` / `policy_jurisdiction` | payment | `screen` | `screening` | Screen payment parties and structured/unstructured payment fields under named lists and policy; not payment execution. |
| `risk.device` | `risk.device.intelligence.[jurisdiction]` | `intelligence` / `policy_jurisdiction` | device, session | `assess` | `risk` | Return device identifiers, behavioral/integrity signals, observation times and provider scores; collection is a separate action. |
| `risk.email` | `risk.email.intelligence.[jurisdiction]` | `intelligence` / `policy_jurisdiction` | email | `assess` | `risk` | Return email validity, reputation and linked-risk signals with observation times and score provenance. |
| `risk.phone` | `risk.phone.intelligence.[jurisdiction]` | `intelligence` / `policy_jurisdiction` | phone | `assess` | `risk` | Return telephone line, carrier, validity and risk signals; possession/OTP assurance must be explicitly evidenced. |
| `risk.network` | `risk.network.intelligence.[jurisdiction]` | `intelligence` / `policy_jurisdiction` | ip, network | `assess` | `risk` | Return network/IP location, proxy and reputation signals; geolocation is probabilistic and not residence verification. |
| `risk.jurisdiction` | `risk.jurisdiction.intelligence.[jurisdiction]` | `intelligence` / `policy_jurisdiction` | jurisdiction | `assess` | `risk` | Retrieve or assess country/jurisdiction risk under a named methodology, publisher and as-of date; separate publication authority from target country. |
| `risk.customer.assess` | `risk.customer.intelligence.[jurisdiction]` | `intelligence` / `policy_jurisdiction` | person, organization, session | `assess` | `risk` | Return provider risk factors and scores with methodology, scale and input scope; preserve the institution decision separately. |
| `account.ownership.verify` | `account.ownership.intelligence.[jurisdiction]` | `intelligence` / `account_servicing` | account, person, organization | `verify` | `account` | Compare a named subject against account-holder evidence; return per-field comparisons, account namespace and match method. |
| `financial.evidence.retrieve` | `financial.evidence.intelligence.[jurisdiction]` | `intelligence` / `account_servicing` | account, person, organization | `retrieve` | `financial` | Retrieve financial documents or extracted financial facts with institution, period, currency and provenance; not account ownership or transaction surveillance. |
| `transaction.monitor` | `transaction.monitoring.intelligence.[jurisdiction]` | `intelligence` / `policy_jurisdiction` | transaction, account | `monitor` | `monitoring` | Evaluate fiat transaction activity under explicit scenarios/time windows and return alerts, observation coverage and rule versions. |
| `case.manage` | `case.management.intelligence.[jurisdiction]` | `operational` / `policy_jurisdiction` | case | `manage` | `case` | Manage investigation cases, assignments, dispositions and audit history; this is an operational service contract. |
| `regulatory.report` | `regulatory.reporting.intelligence.[jurisdiction]` | `operational` / `policy_jurisdiction` | report, case | `report` | `report` | Create, validate or submit regulator-specific reports; distinguish draft, submitted, acknowledged, accepted and rejected. |
| `crypto.wallet.screen` | `crypto.wallet.intelligence.[jurisdiction]` | `intelligence` / `policy_jurisdiction` | wallet | `screen` | `crypto` | Return wallet attribution/exposure by chain, asset, counterparty and hop policy; a wallet address requires a chain namespace. |
| `crypto.transaction.monitor` | `crypto.transaction.intelligence.[jurisdiction]` | `intelligence` / `policy_jurisdiction` | crypto_transaction, wallet | `monitor` | `crypto` | Return blockchain transaction alerts and exposure with chain, transaction hash, block/time and asset units. |
| `travel_rule.exchange` | `travel_rule.exchange.intelligence.[jurisdiction]` | `operational` / `policy_jurisdiction` | transfer, counterparty | `exchange` | `travel_rule` | Exchange originator/beneficiary information with protocol and counterparty state; delivery does not prove counterparty acceptance. |
| `edd.report.retrieve` | `edd.report.intelligence.[jurisdiction]` | `intelligence` / `policy_jurisdiction` | person, organization, vessel | `retrieve` | `edd` | Retrieve an attributed investigation/due-diligence report with scope, author, dates, evidence and unresolved findings. |
| `entity.resolve` | `entity.resolution.intelligence.[jurisdiction]` | `intelligence` / `policy_jurisdiction` | entity_set | `resolve` | `resolution` | Return identity-resolution candidates and supporting identifiers; preserve candidate versus confirmed links and avoid automatic merges. |
| `monitoring.subscribe` | `monitoring.subscription.intelligence.[jurisdiction]` | `operational` / `policy_jurisdiction` | subject, capability_binding | `subscribe` | `subscription` | Create or manage a change subscription to a specified parent capability, datasets and scope; an active subscription is not a fresh check. |
| `reference.identifier.lookup` | `reference.identifier.intelligence.[jurisdiction]` | `reference` / `issuer_authority` | identifier | `lookup` | `reference` | Resolve a namespaced identifier to reference records; LEI/BIC/reference identity is not beneficial ownership proof. |
| `reference.list.ingest` | `reference.list.intelligence.[jurisdiction]` | `reference` / `dataset_authority` | dataset | `ingest` | `reference` | Acquire a versioned list/snapshot/delta with publisher, category, digest and effective time; ingesting a list does not screen a subject. |
| `workflow.orchestrate` | `workflow.orchestration.intelligence.[jurisdiction]` | `operational` / `policy_jurisdiction` | workflow | `orchestrate` | `workflow` | Run a governed workflow and preserve child capability results; an orchestrator is not assumed to own upstream datasets. |
| `credential.verify` | `credential.verification.intelligence.[jurisdiction]` | `intelligence` / `issuer_authority` | credential | `verify` | `verification` | Validate a credential issuer, signature, trust chain, expiry and revocation state; issuance/retrieval is distinct. |
| `questionnaire.collect` | `questionnaire.collection.intelligence.[jurisdiction]` | `intelligence` / `policy_jurisdiction` | questionnaire, organization | `collect` | `questionnaire` | Collect or retrieve versioned questionnaire responses with respondent and attestation provenance; a template is not an answered questionnaire. |

### 4.1 Additional families required by the native-operation inventory

These 19 additions prevent a native-only or adjacent function from masquerading as one of the existing 37. They do not assert that every provider has implemented the listed business action. There is no implicit conversion from account profile to ownership, extraction to document verification, transactions to AML monitoring, or artifact retrieval to credential verification.

| Canonical template | Kind / jurisdiction basis | Subjects | Default action | Proposed result kind | Definition |
| --- | --- | --- | --- | --- | --- |
| `identity.profile.intelligence.[jurisdiction]` | `intelligence` / `issuer_authority` | person, organization | `retrieve` | `profile` | Retrieve source identity fields or a stored KYC record without asserting corroboration or identity verification. |
| `identity.document.extraction.intelligence.[jurisdiction]` | `intelligence` / `issuer_authority` | document | `extract` | `extraction` | Extract text, barcode/NFC or document fields with field confidence and source pointers; extraction is not authenticity verification. |
| `identity.identifier.derivation.intelligence.[jurisdiction]` | `intelligence` / `issuer_authority` | identifier | `derive` | `reference` | Calculate an identifier or perform syntax derivation; output must not be reported as authoritative identifier validation. |
| `identity.vehicle.intelligence.[jurisdiction]` | `intelligence` / `issuer_authority` | vehicle | `validate` | `verification` | Validate vehicle identifiers/vehicle facts; this adjacent capability is not person identity verification. |
| `credential.issuance.intelligence.[jurisdiction]` | `operational` / `issuer_authority` | credential | `issue` | `credential` | Issue or manage a credential and expose its lifecycle; issuing does not independently verify underlying facts. |
| `document.evidence.intelligence.[jurisdiction]` | `intelligence` / `issuer_authority` | document, media | `retrieve` | `artifact` | Upload, obtain or export documents/media and their provenance; possession of an artifact is not a check outcome. |
| `document.signature.intelligence.[jurisdiction]` | `operational` / `policy_jurisdiction` | document | `sign` | `signature` | Create/retrieve electronic signatures, receipts or attestations with scheme and signer provenance; not identity verification. |
| `screening.watchlist.intelligence.[jurisdiction]` | `intelligence` / `policy_jurisdiction` | person, organization | `screen` | `screening` | Represent a composite/custom watchlist operation whose categories are parameterized; emit atomic sanctions/PEP/media results only for evidenced categories. |
| `account.control.intelligence.[jurisdiction]` | `intelligence` / `account_servicing` | account | `validate` | `account_control` | Validate access/control of an account using microdeposits or account credentials; does not establish that the named subject is its legal holder. |
| `account.profile.intelligence.[jurisdiction]` | `intelligence` / `account_servicing` | account | `retrieve` | `account_profile` | Retrieve account metadata or holder details without a subject comparison; not account ownership verification. |
| `financial.transactions.intelligence.[jurisdiction]` | `intelligence` / `account_servicing` | account, transaction | `retrieve` | `transactions` | Retrieve, enrich or categorize financial transactions; no AML monitoring conclusion is implied. |
| `financial.balance.intelligence.[jurisdiction]` | `intelligence` / `account_servicing` | account | `retrieve` | `balance` | Retrieve balance snapshots with amount, currency, balance type and timestamp. |
| `financial.income.intelligence.[jurisdiction]` | `intelligence` / `financial_source_authority` | person, organization | `retrieve` | `financial` | Retrieve or assess income/employment evidence with period, source and verification method. |
| `financial.analytics.intelligence.[jurisdiction]` | `intelligence` / `account_servicing` | account, person, organization | `assess` | `risk` | Retrieve financial features, insights or credit/lending metrics; preserve provider methodology and distinguish computed features from verified evidence. |
| `financial.institution.intelligence.[jurisdiction]` | `intelligence` / `registry_authority` | financial_institution | `lookup` | `reference` | Retrieve supported financial institution, routing and merchant reference metadata; support catalogs are not customer checks. |
| `financial.personal_management.intelligence.[jurisdiction]` | `operational` / `account_servicing` | user, account | `manage` | `resource` | Manage budgets, goals, tags, categories, rewards or other personal-finance resources; adjacent product functionality, not financial-crime evidence. |
| `questionnaire.template.intelligence.[jurisdiction]` | `reference` / `policy_jurisdiction` | questionnaire | `retrieve` | `template` | Retrieve questionnaire definitions/standards; a blank template is not a response or attestation. |
| `platform.integration.intelligence.[jurisdiction]` | `operational` / `integration_scope` | integration, session, subject_resource | `manage` | `operation` | Manage authentication, sessions, consent, subject records, webhooks, audit logs, queues, diagnostics and native controls. Require an operation_kind and, where known, enables[]; produce no intelligence assertion merely from control success. |
| `platform.testing.intelligence.[jurisdiction]` | `testing` / `integration_scope` | test_resource | `simulate` | `operation` | Perform sandbox/test setup or webhook simulation; results remain explicitly synthetic and cannot satisfy a live intelligence requirement. |

## 5. Mapping rules and semantic corrections

### 5.1 Rules used for this complete crosswalk

1. Start with the declared legacy contract, not the provider category. Map vocabulary explicitly using section 4, then apply the source-specific corrections below.
2. Keep each original catalog `operation_id` as a lineage key. One old entry can map conditionally to multiple proposed targets. A conditional split never means execute all branches or claim both results.
3. Use concrete proposed scope only for national-source hints or known publisher identities. Do not derive commercial-provider country coverage from headquarters, marketing orientation, URL deployment region or a word such as “global” in a path. All other targets end in `.unresolved`.
4. Map each of the 732 native operations separately using its locally stored method, path, semantics and summary. Keep a native operation's role separate from a completed capability result. This is a semantic review proposal; it is not a generated native field mapper.
5. Generic watchlist APIs map to `screening.watchlist`; dispatch to sanctions, PEP, enforcement or media only when product configuration, dataset entitlement and response evidence establish the category. Dilisense media operations map to adverse media. List downloads map to `reference.list`, not subject screening.
6. Account-holder/source fields map to `account.profile` or `identity.profile`. Only an evidenced comparison maps to `account.ownership`. Financial transaction data maps to `financial.transactions`; monitoring requires scenario evaluation and alerts.
7. Fixture evidence applies only to its exercised normalizer and native payload subset. A fixture-tested legacy row does not validate the new jurisdiction suffix, corrected semantics or new schemas. No migration increases readiness or removes quarantine.
8. Native controls always have typed operation receipts and audit history, with no fabricated checked scope or assertions. Generic configurable checks remain conditional proposals until dispatch branches are pinned.

### 5.2 Explicit source-specific corrections

All rows below require review of the specific product contract before activation. The evidence basis is the existing provider's `notes` field in [providers.json](../tools/kyc-provider-atlas/catalog/providers.json); no additional vendor capabilities were inferred from a homepage.

| Provider | Current binding | Proposed capability path(s) | Reason |
| --- | --- | --- | --- |
| `fincen-boi` | `business.registry.lookup` | `business.ownership` | BOI is ownership/control information; restricted source, not a general company registry. |
| `mexico-renapo` | `business.registry.lookup` | `identity.person` | Catalog notes identify CURP/person identity, not a business registry. |
| `saudi-elm` | `business.registry.lookup` | `identity.person` | Catalog notes identify Yakeen identity service, not a business registry. |
| `bahrain-benefit-ekyc` | `business.registry.lookup` | `identity.person` | Catalog notes identify national eKYC, not a business registry. |
| `mexico-sat` | `business.registry.lookup` | `identity.tax_id` | Catalog notes identify RFC/tax data; identifier type and authorized product must be pinned. |
| `argentina-arca` | `business.registry.lookup` | `identity.tax_id` | Catalog notes identify tax data; treat as a tax-source hypothesis pending product contract. |
| `gstn` | `business.registry.lookup` | `identity.tax_id` | GST is a tax-registration source; not a substitute for a corporate incorporation registry. |
| `protean-egov` | `identity.person.verify` | `identity.tax_id` | Catalog notes specifically name PAN/identity services; route PAN validation to tax-ID and require a separate contract for wider identity checks. |
| `brazil-receita-federal` | `business.registry.lookup` | `business.registry`, `identity.tax_id` | Conditional split: CNPJ business facts versus CPF/CNPJ tax-identifier checks; select by identifier/product, never emit both by default. |
| `cersai-ckycr` | `identity.person.verify` | `identity.profile` | Retrieving a central KYC record does not perform a new identity verification. |
| `digilocker` | `identity.digital_id.verify` | `document.evidence` | Catalog establishes a consent-based document ecosystem; document retrieval does not establish a verified digital-identity assertion. |
| `wolfsberg-group` | `questionnaire.collect` | `questionnaire.template` | Catalog describes CBDDQ/FCCQ standards; template availability does not collect completed responses. |
| `gleif-vlei-ecosystem` | `reference.identifier.lookup` | `credential.verification` | Credential trust ecosystem is not an ordinary identifier lookup; candidate contract only, no issuer/verifier API is established. |

The 13 corrected entries are not reversible aliases. The other 811 catalog entries receive a vocabulary mapping, which preserves their existing proposal status and still requires capability evidence. Broad EDD, bureau, fraud and orchestration catalog memberships remain discovery hypotheses rather than being silently promoted to narrower vendor promises.

### 5.3 Identity and version reconciliation

| Source identifier | Canonical identity relationship | Treatment |
| --- | --- | --- |
| vendor definition `entrust-onfido` | Proposed alias of provider record `entrust-identity-verification` | Use an explicit reviewed alias; preserve native definition ID, product, source provenance and contracting entity separately. |
| adapter `companies_house` | Adapter belonging to provider `companies-house` | Keep adapter and provider IDs separate; do not use universal underscore/hyphen replacement. |
| Persona manifest/planner `2026-09-29` versus native definition `2023-01-05` | Different versioned native contracts | Keep separate binding/mapping records until payload/request-header differences are reconciled and tested. |
| Any catalog `family_id` | Discovery/deduplication relationship only | Do not assume shared credentials, legal ownership, entitlements or identical capability coverage. |
| Finantier | Historical quarantined catalog record | Map both legacy entries for inventory completeness; quarantine continues to prohibit execution. |

### 5.4 Representative operation mappings

These examples explain the full operation appendix. Commercial examples stay unresolved because capability-specific jurisdiction is not proven.

| Native operation | Primary proposed target | Role | Interpretation |
| --- | --- | --- | --- |
| `companies-house:get_company_companynumber` | `business.registry.intelligence.gb` | `lookup` | Registry facts/PSC disclosures; no independent beneficial-owner verification. |
| `companies-house:get_company_company_number_persons_with_significant_control` | `business.ownership.intelligence.gb` | `lookup` | Registry facts/PSC disclosures; no independent beneficial-owner verification. |
| `plaid:identityMatch` | `account.ownership.intelligence.unresolved` | `verify` | Per-field holder comparison, not a bank decision. |
| `plaid:accountsGet` | `account.profile.intelligence.unresolved` | `retrieve` | Account metadata, not ownership comparison. |
| `plaid:transactionsGet` | `financial.transactions.intelligence.unresolved` | `retrieve` | Transaction retrieval/enrichment/refresh, not AML monitoring. |
| `plaid:identityVerificationCreate` | `identity.person.intelligence.unresolved` | `submit` | Identity-verification workflow; child check evidence remains explicit. |
| `gleif:get_lei` | `reference.identifier.intelligence.unresolved` | `lookup` | LEI reference data; Level-2 parents are not natural-person UBOs. |
| `dilisense:individual_media` | `screening.adverse_media.intelligence.unresolved` | `screen` | Media endpoints are adverse-media searches; dataset exports require explicit categories. |
| `incode:generaterfc` | `identity.identifier.derivation.intelligence.mx` | `derive` | RFC derivation is not authoritative tax-ID verification. |
| `prembly:documented_national_id` | `identity.profile.intelligence.unresolved` | `retrieve` | BLOCKED: local definition says Zambia example versus /verification/gb/id path conflict; do not infer GB or ZM support. |
| `unit21:create_entity` | `platform.integration.intelligence.unresolved` | `control` | Create entity resource for monitoring; does not monitor a transaction. |
| `entrust-onfido:ping` | `platform.integration.intelligence.unresolved` | `control` | Applicant/workflow/task, consent, authentication token/passkey, webhook, address picker or health operation; select operation_kind and enables[] explicitly. |

## 6. Resolution and migration

### 6.1 Resolution contract

Resolve a live request using **capability ID + definition version + action + subject type + selectors + required source scope**. Then filter bindings by tenant entitlement, environment, approved jurisdiction evidence, dataset rights, permitted use, consent requirements, API/mapping versions, freshness, processing/storage policy and current readiness. `unresolved`, empty approved scope, quarantine or a missing operation dispatch branch is a hard blocker. Global definitions still require explicit coverage and approved countries/authorities where relevant.

Choose among semantically equivalent eligible bindings using policy. A fallback must satisfy the same contract and requested source scope; an account profile fallback cannot satisfy account ownership, and another sanctions list cannot silently replace a required legal regime. For multiple jurisdictions, create scoped child checks and aggregate their independent outcomes and coverage. A provider label or successful HTTP call is never a resolver input that overrides semantics.

The final result must echo the resolved capability ID, definition version, binding ID, native operation mapping and actual scope checked. Validate response schema and semantic references before publishing. Preserve the current fail-closed handling, tenant isolation, idempotency, evidence encryption and reconciliation behavior.

### 6.2 Implementation sequence

1. **Land this design/crosswalk as a proposal.** Assign owners to the 56 definitions, jurisdiction registry and 13 semantic corrections. Confirm the Entrust alias. Keep current runtime behavior unchanged while reviewing.
2. **Implement versioned registries and schemas.** Create definitions, bindings, native mappings and jurisdiction schemas with foreign keys and unknown-field rejection. Use shared entity/evidence/result envelope components, with explicit per-capability input/output invariants. Retain a controlled extension namespace for native remnants.
3. **Backfill records without upgrading evidence.** Import all 824 lineage IDs and all 732 native operation IDs. Preserve empty country/residency scopes, quarantine, original source IDs, original semantics, native API versions and validation provenance. Conditional/corrected entries require explicit approval before they become runtime aliases. Review all `.unresolved` keys and pin source jurisdiction per binding.
4. **Replace coarse semantic defaults.** In `vendor_connections/normalization.py`, obtain the capability/role from the versioned operation mapping. Reject missing mappings and incompatible `context.capability`. Controls return operation receipts; pending/submitted checks never receive completed assertions. Add dispatch contracts for configurable checks and composite watchlists.
5. **Update the host model and registry together.** Add the new request/result/adapter/event schema versions, change `Registry.resolve` from `provider:legacy-capability` lookup to versioned binding resolution, and index approval by scoped binding ID. Preserve existing v1 clients through an explicit legacy resolver. A legacy call without sufficient jurisdiction/source context must ask for scope through a validation error, not select global. Corrected mappings return a migration-required error until the client contract is updated.
6. **Update generators before republishing.** `kyc-provider-atlas/build_bundle.py` owns the generated catalog/schemas; related generators produce API/examples/explorers. Update `api-wiring/scripts/generate_inventory.py`, vendor-definition generators/importers, readiness exports, bundled schemas/OpenAPI and vendored atlas copy consistently. Do not hand-edit generated JSON as the sole implementation. Do not run network research or repack release zips as part of this document-only change.
7. **Validate the seam before enabling routes.** Check referential integrity and coverage counts; test exact per-operation dispatch, ambiguous and empty scopes, multi-jurisdiction fan-out, non-equivalent fallbacks, missing/partial fields, source drift, control receipts and quarantine. Test real sandbox acceptance only for explicitly contracted bindings, independently of synthetic fixtures.

### 6.3 Compatibility and acceptance criteria

- Every old capability has an explicit vocabulary mapping, definition version and migration disposition. No blind string concatenation determines jurisdiction.
- Each of 376 provider records and 824 old binding IDs survives with lineage. Conditional splits preserve the old ID but receive new binding IDs per branch after validation.
- Each of 42 native definitions and 732 operation IDs resolves to a mapping or an explicitly blocked proposal. No native operation silently falls back to person verification.
- All nine fixture adapters retain their actual implemented scope. Six offline planners and six host native subsets remain distinct from the 42 native testing clients.
- `global` is registered and evidenced, `.unresolved` is denied in live requests, empty lists do not mean worldwide, and provider processing regions do not change legal scope.
- Profile retrieval, OCR, list acquisition, session creation, resource edits, provider approvals and synthetic calls cannot satisfy verification/screening/monitoring success contracts.
- Corrected semantics, new result kinds and assessment values require versioned client migration. Replays of old results preserve the original capability and model version; do not rewrite historical evidence.
- The v2 registry, schemas and resolver are not implemented by this Markdown file. Approval of the model is distinct from enabling any real provider route.

## 7. Coverage verification

The document was assembled from the full JSON inventories rather than sampling the provider list. Structural checks verify that all 37 capability labels are defined; every one of 376 provider IDs has a mapping; all 824 original binding IDs and all 732 native operation IDs appear exactly once in their authoritative appendix; every mapped path belongs to the 56-family dictionary; all nine manifests are covered; and connection-template keys match catalog binding keys. The three source/vendored catalog JSON pairs match byte for byte.

The mappings are source-derived proposals with explanations, not certified API contracts. No external data call, credentials check or existing service test suite was run for this documentation-only change. Required future schema and behavior tests are described in section 6.

| Check | Observed |
| --- | --- |
| Source provider records / unique IDs | 376 / 376 |
| Source bindings / unique legacy operation IDs | 824 / 824 |
| Connection template IDs absent from bindings | 0 |
| Bindings absent from connection templates | 0 |
| Legacy definitions missing from dictionary | 0 |
| Catalog semantic correction rows | 13 |
| Native definitions / unique native operations | 42 / 732 |
| Fixture manifests | 9 |
| Canonical families | 56 |
| Catalog bindings with unresolved proposed suffix | 748 |
| Catalog bindings with concrete proposed source suffix | 76 |
| Approved live bindings established by this review | 0 |

| Native operation role | Count |
| --- | --- |
| assess | 15 |
| control | 285 |
| derive | 1 |
| enrich | 1 |
| extract | 6 |
| ingest | 5 |
| lookup | 57 |
| retrieve | 225 |
| screen | 15 |
| simulate | 14 |
| submit | 45 |
| upload | 32 |
| validate | 3 |
| verify | 28 |

### 7.1 Inventory coverage by canonical family

Counts describe proposed mapping membership, not working adapters. A catalog binding with a conditional split contributes to each candidate family (825 target memberships across 824 original rows). Native operations have exactly one primary family (732 memberships). Zero means no mapped entry in that source layer; it does not mean a vendor cannot offer the capability.

| Canonical capability path | Catalog binding memberships | Native operation memberships |
| --- | --- | --- |
| `identity.person` | 112 | 45 |
| `identity.document` | 91 | 4 |
| `identity.biometric` | 94 | 14 |
| `identity.address` | 0 | 1 |
| `identity.digital_id` | 8 | 0 |
| `identity.tax_id` | 6 | 2 |
| `business.verification` | 30 | 5 |
| `business.registry` | 72 | 20 |
| `business.ownership` | 36 | 14 |
| `business.officers` | 1 | 7 |
| `screening.sanctions` | 24 | 0 |
| `screening.pep` | 24 | 0 |
| `screening.adverse_media` | 23 | 3 |
| `screening.enforcement` | 1 | 0 |
| `screening.payment` | 0 | 0 |
| `risk.device` | 19 | 11 |
| `risk.email` | 19 | 1 |
| `risk.phone` | 20 | 4 |
| `risk.network` | 2 | 2 |
| `risk.jurisdiction` | 2 | 0 |
| `risk.customer` | 45 | 16 |
| `account.ownership` | 25 | 3 |
| `financial.evidence` | 21 | 30 |
| `transaction.monitoring` | 32 | 0 |
| `case.management` | 32 | 0 |
| `regulatory.reporting` | 0 | 0 |
| `crypto.wallet` | 15 | 0 |
| `crypto.transaction` | 15 | 0 |
| `travel_rule.exchange` | 7 | 0 |
| `edd.report` | 18 | 0 |
| `entity.resolution` | 2 | 4 |
| `monitoring.subscription` | 0 | 4 |
| `reference.identifier` | 4 | 2 |
| `reference.list` | 13 | 10 |
| `workflow.orchestration` | 7 | 0 |
| `credential.verification` | 1 | 0 |
| `questionnaire.collection` | 1 | 1 |
| `identity.profile` | 1 | 7 |
| `identity.document.extraction` | 0 | 8 |
| `identity.identifier.derivation` | 0 | 1 |
| `identity.vehicle` | 0 | 1 |
| `credential.issuance` | 0 | 1 |
| `document.evidence` | 1 | 66 |
| `document.signature` | 0 | 20 |
| `screening.watchlist` | 0 | 38 |
| `account.control` | 0 | 8 |
| `account.profile` | 0 | 33 |
| `financial.transactions` | 0 | 35 |
| `financial.balance` | 0 | 4 |
| `financial.income` | 0 | 10 |
| `financial.analytics` | 0 | 16 |
| `financial.institution` | 0 | 14 |
| `financial.personal_management` | 0 | 56 |
| `questionnaire.template` | 1 | 0 |
| `platform.integration` | 0 | 197 |
| `platform.testing` | 0 | 14 |

## Appendix A: every catalog record and binding

**Authoritative source:** [providers.json](../tools/kyc-provider-atlas/catalog/providers.json) and [provider-capabilities.json](../tools/kyc-provider-atlas/catalog/provider-capabilities.json). The vendored copies and the 824 connection-template IDs currently match these inventories.

There is one subsection per provider record and one row per original provider × capability entry: **376 subsections, 824 rows**. Provider IDs, original binding IDs, names, family relationships, market hints, evidence level and source references are retained. The legacy capability is the portion after `:` in the original binding ID. The legacy result family is available in section 4; corrected rows use the new family's semantics. Each table's `Migration` is `vocabulary_mapping`, `semantic_correction` or `conditional_split`, never a statement of proven vendor support.

**Common state for every row:** proposed canonical mapping; live execution disabled; original country/residency allowlists empty; jurisdiction approval and contracted coverage not established. `fixture_tested` below is the old synthetic normalizer's maturity, not v2 validation. National-source suffixes inherit the explicitly unverified catalog hint; official-list suffixes describe publisher authority. `.unresolved` blocks live resolution. Provider quarantine takes priority over any displayed target.

### A.001 Entrust Identity Verification — `entrust-identity-verification`

Category: `identity`. Family: `entrust-identity-verification`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Onfido legacy brand; consolidate under Entrust IDV

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `entrust-identity-verification:identity.person.verify` | `identity.person.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `entrust-identity-verification:identity.document.verify` | `identity.document.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `entrust-identity-verification:identity.biometric.verify` | `identity.biometric.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.002 Jumio — `jumio`

Category: `identity`. Family: `jumio`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Identity verification

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `jumio:identity.person.verify` | `identity.person.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `jumio:identity.document.verify` | `identity.document.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `jumio:identity.biometric.verify` | `identity.biometric.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.003 Veriff — `veriff`

Category: `identity`. Family: `veriff`. Evidence: `public_docs_reviewed`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: `S02`. Notes: Identity verification

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `veriff:identity.person.verify` | `identity.person.intelligence.unresolved` | `vocabulary_mapping` | `fixture_tested` | `veriff` | Legacy semantic proposal retained; support must be established per binding. |
| `veriff:identity.document.verify` | `identity.document.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `veriff:identity.biometric.verify` | `identity.biometric.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.004 Trulioo — `trulioo`

Category: `identity`. Family: `trulioo`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Person and business verification

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `trulioo:identity.person.verify` | `identity.person.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `trulioo:identity.document.verify` | `identity.document.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `trulioo:identity.biometric.verify` | `identity.biometric.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.005 Persona — `persona`

Category: `identity`. Family: `persona`. Evidence: `public_docs_reviewed`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: `S03`, `S04`, `S05`. Notes: Configurable identity workflows

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `persona:identity.person.verify` | `identity.person.intelligence.unresolved` | `vocabulary_mapping` | `fixture_tested` | `persona` | Legacy semantic proposal retained; support must be established per binding. |
| `persona:identity.document.verify` | `identity.document.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `persona:identity.biometric.verify` | `identity.biometric.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.006 Sumsub — `sumsub`

Category: `identity`. Family: `sumsub`. Evidence: `public_docs_reviewed`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: `S01`. Notes: KYC KYB and AML platform

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `sumsub:identity.person.verify` | `identity.person.intelligence.unresolved` | `vocabulary_mapping` | `fixture_tested` | `sumsub` | Legacy semantic proposal retained; support must be established per binding. |
| `sumsub:identity.document.verify` | `identity.document.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `sumsub:identity.biometric.verify` | `identity.biometric.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.007 Socure — `socure`

Category: `identity`. Family: `socure`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): US / Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Identity data and fraud

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `socure:identity.person.verify` | `identity.person.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `socure:identity.document.verify` | `identity.document.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `socure:identity.biometric.verify` | `identity.biometric.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.008 GBG — `gbg`

Category: `identity`. Family: `gbg`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: IDology ID3global and identity products; not separate vendors

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `gbg:identity.person.verify` | `identity.person.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `gbg:identity.document.verify` | `identity.document.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `gbg:identity.biometric.verify` | `identity.biometric.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.009 AU10TIX — `au10tix`

Category: `identity`. Family: `au10tix`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Document and identity verification

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `au10tix:identity.person.verify` | `identity.person.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `au10tix:identity.document.verify` | `identity.document.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `au10tix:identity.biometric.verify` | `identity.biometric.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.010 Incode — `incode`

Category: `identity`. Family: `incode`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Identity platform

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `incode:identity.person.verify` | `identity.person.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `incode:identity.document.verify` | `identity.document.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `incode:identity.biometric.verify` | `identity.biometric.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.011 Mitek — `mitek`

Category: `identity`. Family: `mitek`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: MiVIP HooYu ID R&D product families

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `mitek:identity.person.verify` | `identity.person.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `mitek:identity.document.verify` | `identity.document.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `mitek:identity.biometric.verify` | `identity.biometric.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.012 IDnow — `idnow`

Category: `identity`. Family: `idnow`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Europe / Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Video and automated identity; IDcheck.io Ariadnext legacy

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `idnow:identity.person.verify` | `identity.person.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `idnow:identity.document.verify` | `identity.document.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `idnow:identity.biometric.verify` | `identity.biometric.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.013 WebID — `webid`

Category: `identity`. Family: `webid`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Europe. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Video and digital identification

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `webid:identity.person.verify` | `identity.person.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `webid:identity.document.verify` | `identity.document.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `webid:identity.biometric.verify` | `identity.biometric.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.014 Nect — `nect`

Category: `identity`. Family: `nect`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Europe. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Digital identity

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `nect:identity.person.verify` | `identity.person.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `nect:identity.document.verify` | `identity.document.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `nect:identity.biometric.verify` | `identity.biometric.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.015 Fourthline — `fourthline`

Category: `identity`. Family: `fourthline`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Europe. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: KYC platform

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `fourthline:identity.person.verify` | `identity.person.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `fourthline:identity.document.verify` | `identity.document.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `fourthline:identity.biometric.verify` | `identity.biometric.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.016 Signicat — `signicat`

Category: `identity`. Family: `signicat`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Europe. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Digital identity; Electronic IDentification legacy

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `signicat:identity.person.verify` | `identity.person.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `signicat:identity.document.verify` | `identity.document.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `signicat:identity.biometric.verify` | `identity.biometric.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.017 ID-Pal — `id-pal`

Category: `identity`. Family: `id-pal`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Europe / US. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Identity verification

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `id-pal:identity.person.verify` | `identity.person.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `id-pal:identity.document.verify` | `identity.document.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `id-pal:identity.biometric.verify` | `identity.biometric.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.018 ComplyCube — `complycube`

Category: `identity`. Family: `complycube`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Identity and compliance

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `complycube:identity.person.verify` | `identity.person.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `complycube:identity.document.verify` | `identity.document.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `complycube:identity.biometric.verify` | `identity.biometric.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.019 iDenfy — `idenfy`

Category: `identity`. Family: `idenfy`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: KYC and KYB

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `idenfy:identity.person.verify` | `identity.person.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `idenfy:identity.document.verify` | `identity.document.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `idenfy:identity.biometric.verify` | `identity.biometric.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.020 Shufti — `shufti`

Category: `identity`. Family: `shufti`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Shufti Pro legacy naming

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `shufti:identity.person.verify` | `identity.person.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `shufti:identity.document.verify` | `identity.document.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `shufti:identity.biometric.verify` | `identity.biometric.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.021 Ondato — `ondato`

Category: `identity`. Family: `ondato`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Europe / Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Identity and compliance

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `ondato:identity.person.verify` | `identity.person.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `ondato:identity.document.verify` | `identity.document.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `ondato:identity.biometric.verify` | `identity.biometric.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.022 GetID — `getid`

Category: `identity`. Family: `getid`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Europe / Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Identity verification; ownership to confirm

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `getid:identity.person.verify` | `identity.person.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `getid:identity.document.verify` | `identity.document.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `getid:identity.biometric.verify` | `identity.biometric.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.023 Identomat — `identomat`

Category: `identity`. Family: `identomat`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Identity verification

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `identomat:identity.person.verify` | `identity.person.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `identomat:identity.document.verify` | `identity.document.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `identomat:identity.biometric.verify` | `identity.biometric.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.024 Authenteq — `authenteq`

Category: `identity`. Family: `authenteq`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Europe. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Candidate; current availability requires confirmation

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `authenteq:identity.person.verify` | `identity.person.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `authenteq:identity.document.verify` | `identity.document.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `authenteq:identity.biometric.verify` | `identity.biometric.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.025 AuthenticID — `authenticid`

Category: `identity`. Family: `incode`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): US / Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Identity proofing | Official homepage metadata says AuthenticID is now part of Incode; contracting and product migration still require verification

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `authenticid:identity.person.verify` | `identity.person.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `authenticid:identity.document.verify` | `identity.document.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `authenticid:identity.biometric.verify` | `identity.biometric.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.026 Intellicheck — `intellicheck`

Category: `identity`. Family: `intellicheck`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): US. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: ID validation

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `intellicheck:identity.person.verify` | `identity.person.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `intellicheck:identity.document.verify` | `identity.document.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `intellicheck:identity.biometric.verify` | `identity.biometric.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.027 IDScan.net — `idscan-net`

Category: `identity`. Family: `idscan-net`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): US / Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Document and identity checks

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `idscan-net:identity.person.verify` | `identity.person.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `idscan-net:identity.document.verify` | `identity.document.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `idscan-net:identity.biometric.verify` | `identity.biometric.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.028 Acuant / IDology product family — `acuant-idology-product-family`

Category: `identity`. Family: `gbg`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): US / Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Legacy Acuant products; parent GBG; not incremental vendor count

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `acuant-idology-product-family:identity.person.verify` | `identity.person.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `acuant-idology-product-family:identity.document.verify` | `identity.document.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `acuant-idology-product-family:identity.biometric.verify` | `identity.biometric.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.029 Regula — `regula`

Category: `identity`. Family: `regula`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Document and biometric SDKs

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `regula:identity.person.verify` | `identity.person.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `regula:identity.document.verify` | `identity.document.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `regula:identity.biometric.verify` | `identity.biometric.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.030 Innovatrics — `innovatrics`

Category: `identity`. Family: `innovatrics`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Digital onboarding and biometrics

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `innovatrics:identity.person.verify` | `identity.person.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `innovatrics:identity.document.verify` | `identity.document.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `innovatrics:identity.biometric.verify` | `identity.biometric.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.031 FaceTec — `facetec`

Category: `identity`. Family: `facetec`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Liveness and face verification component

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `facetec:identity.biometric.verify` | `identity.biometric.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.032 iProov — `iproov`

Category: `identity`. Family: `iproov`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Biometric verification component

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `iproov:identity.biometric.verify` | `identity.biometric.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.033 Daon — `daon`

Category: `identity`. Family: `daon`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Identity proofing and biometrics

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `daon:identity.person.verify` | `identity.person.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `daon:identity.document.verify` | `identity.document.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `daon:identity.biometric.verify` | `identity.biometric.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.034 TECH5 — `tech5`

Category: `identity`. Family: `tech5`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Biometric identity component

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `tech5:identity.biometric.verify` | `identity.biometric.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.035 Veridas — `veridas`

Category: `identity`. Family: `veridas`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Europe / Americas. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Biometric and document verification

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `veridas:identity.person.verify` | `identity.person.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `veridas:identity.document.verify` | `identity.document.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `veridas:identity.biometric.verify` | `identity.biometric.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.036 Facephi — `facephi`

Category: `identity`. Family: `facephi`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Europe / Latin America / APAC. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Biometric onboarding

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `facephi:identity.person.verify` | `identity.person.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `facephi:identity.document.verify` | `identity.document.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `facephi:identity.biometric.verify` | `identity.biometric.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.037 Aware — `aware`

Category: `identity`. Family: `aware`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Biometric verification component

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `aware:identity.biometric.verify` | `identity.biometric.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.038 Trust Stamp — `trust-stamp`

Category: `identity`. Family: `trust-stamp`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): US / Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Identity technology

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `trust-stamp:identity.person.verify` | `identity.person.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `trust-stamp:identity.document.verify` | `identity.document.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `trust-stamp:identity.biometric.verify` | `identity.biometric.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.039 Bureau — `bureau`

Category: `identity`. Family: `bureau`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Asia / Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Identity and fraud

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `bureau:identity.person.verify` | `identity.person.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `bureau:identity.document.verify` | `identity.document.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `bureau:identity.biometric.verify` | `identity.biometric.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.040 HyperVerge — `hyperverge`

Category: `identity`. Family: `hyperverge`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): India / Southeast Asia. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Identity and onboarding

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `hyperverge:identity.person.verify` | `identity.person.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `hyperverge:identity.document.verify` | `identity.document.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `hyperverge:identity.biometric.verify` | `identity.biometric.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.041 Signzy — `signzy`

Category: `identity`. Family: `signzy`. Evidence: `public_material_reviewed`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): India / US / MENA / Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: `S26`. Notes: KYC KYB and financial APIs

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `signzy:identity.person.verify` | `identity.person.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `signzy:identity.document.verify` | `identity.document.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `signzy:identity.biometric.verify` | `identity.biometric.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.042 IDfy — `idfy`

Category: `identity`. Family: `idfy`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): India / Asia. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Identity and business verification

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `idfy:identity.person.verify` | `identity.person.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `idfy:identity.document.verify` | `identity.document.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `idfy:identity.biometric.verify` | `identity.biometric.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.043 Karza — `karza`

Category: `identity`. Family: `karza`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): India. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Perfios product family; validate current packaging

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `karza:identity.person.verify` | `identity.person.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `karza:identity.document.verify` | `identity.document.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `karza:identity.biometric.verify` | `identity.biometric.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.044 Perfios — `perfios`

Category: `identity`. Family: `perfios`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): India / Asia. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Financial and identity data

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `perfios:identity.person.verify` | `identity.person.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `perfios:identity.document.verify` | `identity.document.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `perfios:identity.biometric.verify` | `identity.biometric.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.045 Digitap — `digitap`

Category: `identity`. Family: `digitap`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): India. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Identity and financial data

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `digitap:identity.person.verify` | `identity.person.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `digitap:identity.document.verify` | `identity.document.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `digitap:identity.biometric.verify` | `identity.biometric.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.046 Decentro — `decentro`

Category: `identity`. Family: `decentro`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): India. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Verification and banking APIs

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `decentro:identity.person.verify` | `identity.person.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `decentro:identity.document.verify` | `identity.document.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `decentro:identity.biometric.verify` | `identity.biometric.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.047 AuthBridge — `authbridge`

Category: `identity`. Family: `authbridge`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): India. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Identity and background verification

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `authbridge:identity.person.verify` | `identity.person.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `authbridge:identity.document.verify` | `identity.document.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `authbridge:identity.biometric.verify` | `identity.biometric.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.048 OnGrid — `ongrid`

Category: `identity`. Family: `ongrid`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): India. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Identity and background verification

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `ongrid:identity.person.verify` | `identity.person.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `ongrid:identity.document.verify` | `identity.document.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `ongrid:identity.biometric.verify` | `identity.biometric.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.049 Surepass — `surepass`

Category: `identity`. Family: `surepass`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): India. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Verification APIs

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `surepass:identity.person.verify` | `identity.person.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `surepass:identity.document.verify` | `identity.document.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `surepass:identity.biometric.verify` | `identity.biometric.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.050 SprintVerify — `sprintverify`

Category: `identity`. Family: `sprintverify`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): India. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Verification APIs

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `sprintverify:identity.person.verify` | `identity.person.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `sprintverify:identity.document.verify` | `identity.document.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `sprintverify:identity.biometric.verify` | `identity.biometric.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.051 IDcentral — `idcentral`

Category: `identity`. Family: `idcentral`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): India / Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Identity verification

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `idcentral:identity.person.verify` | `identity.person.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `idcentral:identity.document.verify` | `identity.document.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `idcentral:identity.biometric.verify` | `identity.biometric.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.052 arya.ai — `arya-ai`

Category: `identity`. Family: `arya-ai`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): India / Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Banking AI and identity components

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `arya-ai:identity.person.verify` | `identity.person.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `arya-ai:identity.document.verify` | `identity.document.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `arya-ai:identity.biometric.verify` | `identity.biometric.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.053 Advance.AI — `advance-ai`

Category: `identity`. Family: `advance-ai`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Southeast Asia. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Identity and risk

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `advance-ai:identity.person.verify` | `identity.person.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `advance-ai:identity.document.verify` | `identity.document.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `advance-ai:identity.biometric.verify` | `identity.biometric.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.054 VIDA — `vida`

Category: `identity`. Family: `vida`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Indonesia. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Digital identity

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `vida:identity.person.verify` | `identity.person.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `vida:identity.document.verify` | `identity.document.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `vida:identity.biometric.verify` | `identity.biometric.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.055 Privy — `privy`

Category: `identity`. Family: `privy`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Indonesia. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Digital identity and signing

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `privy:identity.person.verify` | `identity.person.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `privy:identity.document.verify` | `identity.document.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `privy:identity.biometric.verify` | `identity.biometric.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.056 VIDOS — `vidos`

Category: `identity`. Family: `vidos`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Europe / Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Digital identity wallet verification

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `vidos:identity.person.verify` | `identity.person.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `vidos:identity.document.verify` | `identity.document.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `vidos:identity.biometric.verify` | `identity.biometric.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.057 Innov8tif — `innov8tif`

Category: `identity`. Family: `innov8tif`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Southeast Asia. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Digital onboarding

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `innov8tif:identity.person.verify` | `identity.person.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `innov8tif:identity.document.verify` | `identity.document.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `innov8tif:identity.biometric.verify` | `identity.biometric.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.058 CTOS eKYC — `ctos-ekyc`

Category: `identity`. Family: `ctos-ekyc`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Malaysia / Asia. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Bureau and eKYC family

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `ctos-ekyc:identity.person.verify` | `identity.person.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `ctos-ekyc:identity.document.verify` | `identity.document.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `ctos-ekyc:identity.biometric.verify` | `identity.biometric.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.059 Liquid — `liquid`

Category: `identity`. Family: `liquid`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Japan / Asia. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: LIQUID eKYC

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `liquid:identity.person.verify` | `identity.person.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `liquid:identity.document.verify` | `identity.document.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `liquid:identity.biometric.verify` | `identity.biometric.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.060 TRUSTDOCK — `trustdock`

Category: `identity`. Family: `trustdock`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Japan. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: eKYC

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `trustdock:identity.person.verify` | `identity.person.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `trustdock:identity.document.verify` | `identity.document.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `trustdock:identity.biometric.verify` | `identity.biometric.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.061 Polarify — `polarify`

Category: `identity`. Family: `polarify`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Japan. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Biometric identity

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `polarify:identity.person.verify` | `identity.person.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `polarify:identity.document.verify` | `identity.document.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `polarify:identity.biometric.verify` | `identity.biometric.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.062 GMO GlobalSign identity — `gmo-globalsign-identity`

Category: `identity`. Family: `gmo-globalsign-identity`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Japan / Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Identity services; KYC applicability to confirm

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `gmo-globalsign-identity:identity.person.verify` | `identity.person.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `gmo-globalsign-identity:identity.document.verify` | `identity.document.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `gmo-globalsign-identity:identity.biometric.verify` | `identity.biometric.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.063 China Financial Certification Authority — `china-financial-certification-authority`

Category: `identity`. Family: `china-financial-certification-authority`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): China. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Identity and certification; access restricted

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `china-financial-certification-authority:identity.person.verify` | `identity.person.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `china-financial-certification-authority:identity.document.verify` | `identity.document.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `china-financial-certification-authority:identity.biometric.verify` | `identity.biometric.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.064 Tencent Cloud FaceID — `tencent-cloud-faceid`

Category: `identity`. Family: `tencent-cloud-faceid`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Asia / Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Face and document verification

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `tencent-cloud-faceid:identity.person.verify` | `identity.person.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `tencent-cloud-faceid:identity.document.verify` | `identity.document.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `tencent-cloud-faceid:identity.biometric.verify` | `identity.biometric.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.065 Alibaba Cloud ID Verification — `alibaba-cloud-id-verification`

Category: `identity`. Family: `alibaba-cloud-id-verification`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Asia / Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Identity verification service

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `alibaba-cloud-id-verification:identity.person.verify` | `identity.person.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `alibaba-cloud-id-verification:identity.document.verify` | `identity.document.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `alibaba-cloud-id-verification:identity.biometric.verify` | `identity.biometric.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.066 Baidu AI identity — `baidu-ai-identity`

Category: `identity`. Family: `baidu-ai-identity`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): China. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Identity components; permission and locality restrictions

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `baidu-ai-identity:identity.person.verify` | `identity.person.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `baidu-ai-identity:identity.document.verify` | `identity.document.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `baidu-ai-identity:identity.biometric.verify` | `identity.biometric.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.067 Smile ID — `smile-id`

Category: `identity`. Family: `smile-id`. Evidence: `public_material_reviewed`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Africa. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: `S24`. Notes: Smile Identity; includes Appruve legacy family

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `smile-id:identity.person.verify` | `identity.person.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `smile-id:identity.document.verify` | `identity.document.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `smile-id:identity.biometric.verify` | `identity.biometric.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.068 Prembly — `prembly`

Category: `identity`. Family: `prembly`. Evidence: `public_material_reviewed`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Africa / emerging markets. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: `S23`. Notes: IdentityPass and Peleza product families

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `prembly:identity.person.verify` | `identity.person.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `prembly:identity.document.verify` | `identity.document.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `prembly:identity.biometric.verify` | `identity.biometric.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.069 Youverify — `youverify`

Category: `identity`. Family: `youverify`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Africa / Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: KYC KYB and compliance

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `youverify:identity.person.verify` | `identity.person.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `youverify:identity.document.verify` | `identity.document.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `youverify:identity.biometric.verify` | `identity.biometric.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.070 Dojah — `dojah`

Category: `identity`. Family: `dojah`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Africa. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Verification APIs

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `dojah:identity.person.verify` | `identity.person.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `dojah:identity.document.verify` | `identity.document.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `dojah:identity.biometric.verify` | `identity.biometric.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.071 QoreID — `qoreid`

Category: `identity`. Family: `qoreid`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Africa. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: VerifyMe family; confirm contracting entity

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `qoreid:identity.person.verify` | `identity.person.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `qoreid:identity.document.verify` | `identity.document.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `qoreid:identity.biometric.verify` | `identity.biometric.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.072 Seamfix — `seamfix`

Category: `identity`. Family: `seamfix`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Africa. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Digital identity

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `seamfix:identity.person.verify` | `identity.person.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `seamfix:identity.document.verify` | `identity.document.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `seamfix:identity.biometric.verify` | `identity.biometric.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.073 iiDENTIFii — `iidentifii`

Category: `identity`. Family: `iidentifii`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Africa. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Biometric verification

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `iidentifii:identity.person.verify` | `identity.person.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `iidentifii:identity.document.verify` | `identity.document.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `iidentifii:identity.biometric.verify` | `identity.biometric.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.074 ThisIsMe — `thisisme`

Category: `identity`. Family: `thisisme`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): South Africa. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Identity and compliance

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `thisisme:identity.person.verify` | `identity.person.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `thisisme:identity.document.verify` | `identity.document.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `thisisme:identity.biometric.verify` | `identity.biometric.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.075 WhoYou — `whoyou`

Category: `identity`. Family: `whoyou`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): South Africa. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Biometric identity

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `whoyou:identity.person.verify` | `identity.person.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `whoyou:identity.document.verify` | `identity.document.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `whoyou:identity.biometric.verify` | `identity.biometric.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.076 MetaMap — `metamap`

Category: `identity`. Family: `metamap`. Evidence: `public_material_reviewed`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Latin America / Africa / Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: `S25`. Notes: Mati legacy brand

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `metamap:identity.person.verify` | `identity.person.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `metamap:identity.document.verify` | `identity.document.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `metamap:identity.biometric.verify` | `identity.biometric.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.077 Inscribe — `inscribe`

Category: `identity`. Family: `inscribe`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): US / Europe. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Document fraud and financial evidence

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `inscribe:identity.person.verify` | `identity.person.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `inscribe:identity.document.verify` | `identity.document.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `inscribe:identity.biometric.verify` | `identity.biometric.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.078 Invoid — `invoid`

Category: `identity`. Family: `bureau`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): India. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Candidate; current availability requires confirmation | Reference redirects to Bureau; treat as legacy/family candidate, not separate live vendor

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `invoid:identity.person.verify` | `identity.person.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `invoid:identity.document.verify` | `identity.document.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `invoid:identity.biometric.verify` | `identity.biometric.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.079 Unico — `unico`

Category: `identity`. Family: `unico`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Brazil / Latin America. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Identity platform

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `unico:identity.person.verify` | `identity.person.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `unico:identity.document.verify` | `identity.document.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `unico:identity.biometric.verify` | `identity.biometric.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.080 idwall — `idwall`

Category: `identity`. Family: `idwall`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Brazil. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Identity and compliance

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `idwall:identity.person.verify` | `identity.person.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `idwall:identity.document.verify` | `identity.document.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `idwall:identity.biometric.verify` | `identity.biometric.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.081 CAF — `caf`

Category: `identity`. Family: `caf`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Brazil / Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Combate a Fraude legacy naming | Official homepage metadata identifies rebrand to Certta; preserve CAF as alias

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `caf:identity.person.verify` | `identity.person.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `caf:identity.document.verify` | `identity.document.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `caf:identity.biometric.verify` | `identity.biometric.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.082 Neoway — `neoway`

Category: `identity`. Family: `neoway`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Brazil. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: B3 family; data and compliance

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `neoway:identity.person.verify` | `identity.person.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `neoway:identity.document.verify` | `identity.document.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `neoway:identity.biometric.verify` | `identity.biometric.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.083 BigDataCorp — `bigdatacorp`

Category: `identity`. Family: `bigdatacorp`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Brazil. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Person and business data

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `bigdatacorp:identity.person.verify` | `identity.person.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `bigdatacorp:identity.document.verify` | `identity.document.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `bigdatacorp:identity.biometric.verify` | `identity.biometric.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.084 Serpro — `serpro`

Category: `identity`. Family: `serpro`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Brazil. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Government data validation; lawful access required

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `serpro:identity.person.verify` | `identity.person.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `serpro:identity.document.verify` | `identity.document.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `serpro:identity.biometric.verify` | `identity.biometric.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.085 Truora — `truora`

Category: `identity`. Family: `truora`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Latin America. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Identity and background checks

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `truora:identity.person.verify` | `identity.person.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `truora:identity.document.verify` | `identity.document.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `truora:identity.biometric.verify` | `identity.biometric.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.086 TOC Biometrics — `toc-biometrics`

Category: `identity`. Family: `toc-biometrics`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Latin America. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Identity verification

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `toc-biometrics:identity.person.verify` | `identity.person.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `toc-biometrics:identity.document.verify` | `identity.document.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `toc-biometrics:identity.biometric.verify` | `identity.biometric.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.087 MobbScan / Mobbeel — `mobbscan-mobbeel`

Category: `identity`. Family: `mobbscan-mobbeel`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Europe / Latin America. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Biometrics and ID capture

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `mobbscan-mobbeel:identity.person.verify` | `identity.person.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `mobbscan-mobbeel:identity.document.verify` | `identity.document.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `mobbscan-mobbeel:identity.biometric.verify` | `identity.biometric.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.088 VU — `vu`

Category: `identity`. Family: `vu`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Latin America. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Digital identity and fraud

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `vu:identity.person.verify` | `identity.person.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `vu:identity.document.verify` | `identity.document.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `vu:identity.biometric.verify` | `identity.biometric.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.089 Verifik — `verifik`

Category: `identity`. Family: `verifik`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Latin America. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Identity and KYB APIs

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `verifik:identity.person.verify` | `identity.person.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `verifik:identity.document.verify` | `identity.document.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `verifik:identity.biometric.verify` | `identity.biometric.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.090 ReconoSer ID — `reconoser-id`

Category: `identity`. Family: `reconoser-id`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Latin America. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Identity and biometrics

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `reconoser-id:identity.person.verify` | `identity.person.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `reconoser-id:identity.document.verify` | `identity.document.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `reconoser-id:identity.biometric.verify` | `identity.biometric.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.091 Valify — `valify`

Category: `identity`. Family: `valify`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): MENA. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Digital identity

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `valify:identity.person.verify` | `identity.person.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `valify:identity.document.verify` | `identity.document.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `valify:identity.biometric.verify` | `identity.biometric.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.092 Digified — `digified`

Category: `identity`. Family: `digified`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): MENA. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Digital identity

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `digified:identity.person.verify` | `identity.person.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `digified:identity.document.verify` | `identity.document.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `digified:identity.biometric.verify` | `identity.biometric.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.093 Uqudo — `uqudo`

Category: `identity`. Family: `uqudo`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): MENA / Africa. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Identity verification

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `uqudo:identity.person.verify` | `identity.person.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `uqudo:identity.document.verify` | `identity.document.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `uqudo:identity.biometric.verify` | `identity.biometric.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.094 Lean identity services — `lean-identity-services`

Category: `identity`. Family: `lean-identity-services`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): MENA. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Account identity via open banking; verify product

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `lean-identity-services:identity.person.verify` | `identity.person.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `lean-identity-services:identity.document.verify` | `identity.document.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `lean-identity-services:identity.biometric.verify` | `identity.biometric.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.095 LSEG World-Check — `lseg-world-check`

Category: `screening`. Family: `lseg-world-check`. Evidence: `public_material_reviewed`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: `S20`. Notes: Refinitiv legacy; World-Check One and On Demand product family

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `lseg-world-check:screening.sanctions` | `screening.sanctions.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `lseg-world-check:screening.pep` | `screening.pep.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `lseg-world-check:screening.adverse_media` | `screening.adverse_media.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.096 Dow Jones Risk & Compliance — `dow-jones-risk-compliance`

Category: `screening`. Family: `dow-jones-risk-compliance`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Sanctions PEP adverse media ownership

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `dow-jones-risk-compliance:screening.sanctions` | `screening.sanctions.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `dow-jones-risk-compliance:screening.pep` | `screening.pep.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `dow-jones-risk-compliance:screening.adverse_media` | `screening.adverse_media.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.097 LexisNexis Risk Solutions — `lexisnexis-risk-solutions`

Category: `screening`. Family: `lexisnexis-risk-solutions`. Evidence: `public_material_reviewed`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: `S21`. Notes: WorldCompliance Bridger Firco and identity products

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `lexisnexis-risk-solutions:screening.sanctions` | `screening.sanctions.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `lexisnexis-risk-solutions:screening.pep` | `screening.pep.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `lexisnexis-risk-solutions:screening.adverse_media` | `screening.adverse_media.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.098 Moody's Compliance — `moody-s-compliance`

Category: `screening`. Family: `moody-s-compliance`. Evidence: `public_material_reviewed`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: `S22`. Notes: Grid RDC Orbis Bureau van Dijk kompany PassFort legacy families

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `moody-s-compliance:screening.sanctions` | `screening.sanctions.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `moody-s-compliance:screening.pep` | `screening.pep.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `moody-s-compliance:screening.adverse_media` | `screening.adverse_media.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.099 ComplyAdvantage — `complyadvantage`

Category: `screening`. Family: `complyadvantage`. Evidence: `public_docs_reviewed`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: `S16`. Notes: Screening and monitoring

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `complyadvantage:screening.sanctions` | `screening.sanctions.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `complyadvantage:screening.pep` | `screening.pep.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `complyadvantage:screening.adverse_media` | `screening.adverse_media.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.100 OpenSanctions — `opensanctions`

Category: `screening`. Family: `opensanctions`. Evidence: `public_docs_reviewed`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: `S13`, `S14`, `S15`. Notes: API and licensed data

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `opensanctions:screening.sanctions` | `screening.sanctions.intelligence.unresolved` | `vocabulary_mapping` | `fixture_tested` | `opensanctions` | Legacy semantic proposal retained; support must be established per binding. |
| `opensanctions:screening.pep` | `screening.pep.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `opensanctions:screening.enforcement` | `screening.enforcement.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.101 Castellum.AI — `castellum-ai`

Category: `screening`. Family: `castellum-ai`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Screening and risk data

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `castellum-ai:screening.sanctions` | `screening.sanctions.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `castellum-ai:screening.pep` | `screening.pep.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `castellum-ai:screening.adverse_media` | `screening.adverse_media.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.102 Sanction Scanner — `sanction-scanner`

Category: `screening`. Family: `sanction-scanner`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Screening and AML

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `sanction-scanner:screening.sanctions` | `screening.sanctions.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `sanction-scanner:screening.pep` | `screening.pep.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `sanction-scanner:screening.adverse_media` | `screening.adverse_media.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.103 sanctions.io — `sanctions-io`

Category: `screening`. Family: `sanctions-io`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Screening API

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `sanctions-io:screening.sanctions` | `screening.sanctions.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `sanctions-io:screening.pep` | `screening.pep.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `sanctions-io:screening.adverse_media` | `screening.adverse_media.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.104 NameScan — `namescan`

Category: `screening`. Family: `namescan`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: MemberCheck family; confirm product relationship

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `namescan:screening.sanctions` | `screening.sanctions.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `namescan:screening.pep` | `screening.pep.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `namescan:screening.adverse_media` | `screening.adverse_media.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.105 MemberCheck — `membercheck`

Category: `screening`. Family: `membercheck`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Screening service family

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `membercheck:screening.sanctions` | `screening.sanctions.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `membercheck:screening.pep` | `screening.pep.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `membercheck:screening.adverse_media` | `screening.adverse_media.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.106 dilisense — `dilisense`

Category: `screening`. Family: `dilisense`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Screening API

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `dilisense:screening.sanctions` | `screening.sanctions.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `dilisense:screening.pep` | `screening.pep.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `dilisense:screening.adverse_media` | `screening.adverse_media.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.107 AML Watcher — `aml-watcher`

Category: `screening`. Family: `aml-watcher`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Screening intelligence

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `aml-watcher:screening.sanctions` | `screening.sanctions.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `aml-watcher:screening.pep` | `screening.pep.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `aml-watcher:screening.adverse_media` | `screening.adverse_media.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.108 Acuris Risk Intelligence — `acuris-risk-intelligence`

Category: `screening`. Family: `acuris-risk-intelligence`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Legacy/product family; current ownership and feed availability not verified | Historical reference currently presents KYC6 in page metadata; current entity and product lineage need investigation.

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `acuris-risk-intelligence:screening.sanctions` | `screening.sanctions.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `acuris-risk-intelligence:screening.pep` | `screening.pep.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `acuris-risk-intelligence:screening.adverse_media` | `screening.adverse_media.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.109 AML Intelligence — `aml-intelligence`

Category: `screening`. Family: `aml-intelligence`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Europe / Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: News and compliance intelligence; not presumed screening API

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `aml-intelligence:edd.report.retrieve` | `edd.report.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.110 FinScan / Innovative Systems — `finscan-innovative-systems`

Category: `screening`. Family: `finscan-innovative-systems`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Screening engine

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `finscan-innovative-systems:screening.sanctions` | `screening.sanctions.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `finscan-innovative-systems:screening.pep` | `screening.pep.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `finscan-innovative-systems:screening.adverse_media` | `screening.adverse_media.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.111 Neterium — `neterium`

Category: `screening`. Family: `neterium`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Screening engine; upstream data license separate

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `neterium:screening.sanctions` | `screening.sanctions.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `neterium:screening.pep` | `screening.pep.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `neterium:screening.adverse_media` | `screening.adverse_media.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.112 Vneuron — `vneuron`

Category: `screening`. Family: `vneuron`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Africa / MENA / Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Reis screening and AML

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `vneuron:screening.sanctions` | `screening.sanctions.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `vneuron:screening.pep` | `screening.pep.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `vneuron:screening.adverse_media` | `screening.adverse_media.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.113 Vixio — `vixio`

Category: `screening`. Family: `vixio`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Regulatory intelligence adjacent to AML

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `vixio:screening.sanctions` | `screening.sanctions.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `vixio:screening.pep` | `screening.pep.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `vixio:screening.adverse_media` | `screening.adverse_media.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.114 Kharon — `kharon`

Category: `screening`. Family: `kharon`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Ownership networks and sanctions-linked intelligence

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `kharon:screening.sanctions` | `screening.sanctions.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `kharon:screening.pep` | `screening.pep.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `kharon:screening.adverse_media` | `screening.adverse_media.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.115 Sayari — `sayari`

Category: `screening`. Family: `sayari`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Corporate networks and ownership intelligence

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `sayari:entity.resolve` | `entity.resolution.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `sayari:business.ownership.discover` | `business.ownership.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `sayari:risk.network` | `risk.network.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.116 Altana — `altana`

Category: `screening`. Family: `altana`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Trade and ownership intelligence

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `altana:screening.sanctions` | `screening.sanctions.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `altana:screening.pep` | `screening.pep.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `altana:screening.adverse_media` | `screening.adverse_media.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.117 Ripjar — `ripjar`

Category: `screening`. Family: `ripjar`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Risk intelligence and screening

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `ripjar:screening.sanctions` | `screening.sanctions.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `ripjar:screening.pep` | `screening.pep.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `ripjar:screening.adverse_media` | `screening.adverse_media.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.118 Silent Eight — `silent-eight`

Category: `screening`. Family: `silent-eight`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Screening alert resolution

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `silent-eight:screening.sanctions` | `screening.sanctions.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `silent-eight:screening.pep` | `screening.pep.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `silent-eight:screening.adverse_media` | `screening.adverse_media.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.119 Sensa / SymphonyAI — `sensa-symphonyai`

Category: `screening`. Family: `sensa-symphonyai`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: NetReveal legacy and financial crime

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `sensa-symphonyai:screening.sanctions` | `screening.sanctions.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `sensa-symphonyai:screening.pep` | `screening.pep.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `sensa-symphonyai:screening.adverse_media` | `screening.adverse_media.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.120 Datactics — `datactics`

Category: `screening`. Family: `datactics`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Data quality and matching component

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `datactics:screening.sanctions` | `screening.sanctions.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `datactics:screening.pep` | `screening.pep.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `datactics:screening.adverse_media` | `screening.adverse_media.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.121 Dun & Bradstreet — `dun-bradstreet`

Category: `kyb`. Family: `dun-bradstreet`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: D&B Direct+ Bisnode legacy; corporate data

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `dun-bradstreet:business.verify` | `business.verification.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `dun-bradstreet:business.registry.lookup` | `business.registry.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `dun-bradstreet:business.ownership.discover` | `business.ownership.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.122 Creditsafe — `creditsafe`

Category: `kyb`. Family: `creditsafe`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Graydon legacy; business data

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `creditsafe:business.verify` | `business.verification.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `creditsafe:business.registry.lookup` | `business.registry.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `creditsafe:business.ownership.discover` | `business.ownership.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.123 OpenCorporates — `opencorporates`

Category: `kyb`. Family: `opencorporates`. Evidence: `public_docs_reviewed`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: `S10`. Notes: Corporate registry aggregation

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `opencorporates:business.verify` | `business.verification.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `opencorporates:business.registry.lookup` | `business.registry.intelligence.unresolved` | `vocabulary_mapping` | `fixture_tested` | `opencorporates` | Legacy semantic proposal retained; support must be established per binding. |
| `opencorporates:business.ownership.discover` | `business.ownership.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.124 GLEIF — `gleif`

Category: `kyb`. Family: `gleif`. Evidence: `public_docs_reviewed`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: `S11`, `S12`. Notes: LEI records and accounting consolidation parents; not universal UBO

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `gleif:reference.identifier.lookup` | `reference.identifier.intelligence.unresolved` | `vocabulary_mapping` | `fixture_tested` | `gleif` | Legacy semantic proposal retained; support must be established per binding. |
| `gleif:business.ownership.discover` | `business.ownership.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.125 Middesk — `middesk`

Category: `kyb`. Family: `middesk`. Evidence: `public_docs_reviewed`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): US / international product to verify. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: `S06`, `S07`, `S08`. Notes: Business verification

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `middesk:business.verify` | `business.verification.intelligence.unresolved` | `vocabulary_mapping` | `fixture_tested` | `middesk` | Legacy semantic proposal retained; support must be established per binding. |
| `middesk:business.registry.lookup` | `business.registry.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `middesk:business.ownership.discover` | `business.ownership.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.126 Kyckr — `kyckr`

Category: `kyb`. Family: `kyckr`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Company registry data

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `kyckr:business.verify` | `business.verification.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `kyckr:business.registry.lookup` | `business.registry.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `kyckr:business.ownership.discover` | `business.ownership.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.127 Encompass — `encompass`

Category: `kyb`. Family: `encompass`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Corporate digital identity; kompany not assumed owned here

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `encompass:business.verify` | `business.verification.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `encompass:business.registry.lookup` | `business.registry.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `encompass:business.ownership.discover` | `business.ownership.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.128 Know Your Customer — `know-your-customer`

Category: `kyb`. Family: `know-your-customer`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: KYB platform; distinguish from Swift KYC Registry

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `know-your-customer:business.verify` | `business.verification.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `know-your-customer:business.registry.lookup` | `business.registry.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `know-your-customer:business.ownership.discover` | `business.ownership.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.129 FullCircl — `fullcircl`

Category: `kyb`. Family: `fullcircl`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): UK / Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: SmartSearch and W2 legacy/product brands; current parent confirm

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `fullcircl:business.verify` | `business.verification.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `fullcircl:business.registry.lookup` | `business.registry.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `fullcircl:business.ownership.discover` | `business.ownership.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.130 SmartSearch — `smartsearch`

Category: `kyb`. Family: `smartsearch`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): UK / Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Product-family row; corporate relationship review required

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `smartsearch:business.verify` | `business.verification.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `smartsearch:business.registry.lookup` | `business.registry.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `smartsearch:business.ownership.discover` | `business.ownership.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.131 W2 — `w2`

Category: `kyb`. Family: `w2`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): UK / Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Legacy/product-family row; FullCircl relationship review

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `w2:business.verify` | `business.verification.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `w2:business.registry.lookup` | `business.registry.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `w2:business.ownership.discover` | `business.ownership.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.132 Detected — `detected`

Category: `kyb`. Family: `detected`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: KYB; current GBG relationship to confirm

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `detected:business.verify` | `business.verification.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `detected:business.registry.lookup` | `business.registry.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `detected:business.ownership.discover` | `business.ownership.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.133 AsiaVerify — `asiaverify`

Category: `kyb`. Family: `asiaverify`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): APAC. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Corporate and ownership data

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `asiaverify:business.verify` | `business.verification.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `asiaverify:business.registry.lookup` | `business.registry.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `asiaverify:business.ownership.discover` | `business.ownership.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.134 Handshakes — `handshakes`

Category: `kyb`. Family: `handshakes`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): APAC. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Corporate intelligence

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `handshakes:business.verify` | `business.verification.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `handshakes:business.registry.lookup` | `business.registry.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `handshakes:business.ownership.discover` | `business.ownership.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.135 CRIF — `crif`

Category: `kyb`. Family: `crif`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: SkyMinder and bureau/business data

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `crif:business.verify` | `business.verification.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `crif:business.registry.lookup` | `business.registry.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `crif:business.ownership.discover` | `business.ownership.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.136 Coface — `coface`

Category: `kyb`. Family: `coface`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Business information

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `coface:business.verify` | `business.verification.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `coface:business.registry.lookup` | `business.registry.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `coface:business.ownership.discover` | `business.ownership.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.137 Creditreform — `creditreform`

Category: `kyb`. Family: `creditreform`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Europe / Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Business information

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `creditreform:business.verify` | `business.verification.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `creditreform:business.registry.lookup` | `business.registry.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `creditreform:business.ownership.discover` | `business.ownership.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.138 NorthRow — `northrow`

Category: `kyb`. Family: `id-pal`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): UK / Europe. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: KYB KYC monitoring | Official homepage metadata describes ID-Pal acquisition; verify current contract

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `northrow:business.verify` | `business.verification.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `northrow:business.registry.lookup` | `business.registry.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `northrow:business.ownership.discover` | `business.ownership.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.139 Vespia — `vespia`

Category: `kyb`. Family: `vespia`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Europe / Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: KYB

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `vespia:business.verify` | `business.verification.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `vespia:business.registry.lookup` | `business.registry.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `vespia:business.ownership.discover` | `business.ownership.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.140 The KYB — `the-kyb`

Category: `kyb`. Family: `the-kyb`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Business verification

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `the-kyb:business.verify` | `business.verification.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `the-kyb:business.registry.lookup` | `business.registry.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `the-kyb:business.ownership.discover` | `business.ownership.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.141 Kompli-Global — `kompli-global`

Category: `kyb`. Family: `kompli-global`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): UK / Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Corporate due diligence; current availability confirm

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `kompli-global:business.verify` | `business.verification.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `kompli-global:business.registry.lookup` | `business.registry.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `kompli-global:business.ownership.discover` | `business.ownership.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.142 Ubisecure — `ubisecure`

Category: `kyb`. Family: `ubisecure`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Europe / Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: LEI identity and corporate identity

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `ubisecure:business.verify` | `business.verification.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `ubisecure:business.registry.lookup` | `business.registry.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `ubisecure:business.ownership.discover` | `business.ownership.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.143 Global Database — `global-database`

Category: `kyb`. Family: `global-database`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Company information

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `global-database:business.verify` | `business.verification.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `global-database:business.registry.lookup` | `business.registry.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `global-database:business.ownership.discover` | `business.ownership.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.144 InfobelPRO — `infobelpro`

Category: `kyb`. Family: `infobelpro`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Company information

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `infobelpro:business.verify` | `business.verification.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `infobelpro:business.registry.lookup` | `business.registry.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `infobelpro:business.ownership.discover` | `business.ownership.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.145 CompanyData.com — `companydata-com`

Category: `kyb`. Family: `companydata-com`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Company data

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `companydata-com:business.verify` | `business.verification.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `companydata-com:business.registry.lookup` | `business.registry.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `companydata-com:business.ownership.discover` | `business.ownership.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.146 Bureau van Dijk Orbis — `bureau-van-dijk-orbis`

Category: `kyb`. Family: `moodys-compliance`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Moody's product-family row; not incremental vendor

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `bureau-van-dijk-orbis:business.verify` | `business.verification.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `bureau-van-dijk-orbis:business.registry.lookup` | `business.registry.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `bureau-van-dijk-orbis:business.ownership.discover` | `business.ownership.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.147 kompany — `kompany`

Category: `kyb`. Family: `moodys-compliance`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Moody's product-family row; not incremental vendor

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `kompany:business.verify` | `business.verification.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `kompany:business.registry.lookup` | `business.registry.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `kompany:business.ownership.discover` | `business.ownership.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.148 Kontomatik — `kontomatik`

Category: `kyb`. Family: `kontomatik`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Europe. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Open banking and business financial evidence

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `kontomatik:business.verify` | `business.verification.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `kontomatik:business.registry.lookup` | `business.registry.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `kontomatik:business.ownership.discover` | `business.ownership.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.149 Compliancely — `compliancely`

Category: `kyb`. Family: `compliancely`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): US. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Business and tax checks

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `compliancely:business.verify` | `business.verification.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `compliancely:business.registry.lookup` | `business.registry.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `compliancely:business.ownership.discover` | `business.ownership.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.150 Valid8Me — `valid8me`

Category: `kyb`. Family: `valid8me`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Europe / Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: CDD document exchange

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `valid8me:business.verify` | `business.verification.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `valid8me:business.registry.lookup` | `business.registry.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `valid8me:business.ownership.discover` | `business.ownership.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.151 KYC Portal — `kyc-portal`

Category: `kyb`. Family: `kyc-portal`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: CDD orchestration

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `kyc-portal:business.verify` | `business.verification.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `kyc-portal:business.registry.lookup` | `business.registry.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `kyc-portal:business.ownership.discover` | `business.ownership.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.152 Experian — `experian`

Category: `bureau`. Family: `experian`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Identity fraud and consumer/business bureau products

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `experian:identity.person.verify` | `identity.person.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `experian:risk.customer.assess` | `risk.customer.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.153 Equifax — `equifax`

Category: `bureau`. Family: `equifax`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Identity bureau and employment products

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `equifax:identity.person.verify` | `identity.person.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `equifax:risk.customer.assess` | `risk.customer.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.154 TransUnion — `transunion`

Category: `bureau`. Family: `transunion`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: TruValidate iovation Neustar and bureau products

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `transunion:identity.person.verify` | `identity.person.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `transunion:risk.customer.assess` | `risk.customer.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.155 Prove — `prove`

Category: `bureau`. Family: `prove`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): US / Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Phone-centric identity

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `prove:identity.person.verify` | `identity.person.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `prove:risk.customer.assess` | `risk.customer.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.156 Ekata / Mastercard — `ekata-mastercard`

Category: `bureau`. Family: `mastercard-ekata`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Identity data product family

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `ekata-mastercard:identity.person.verify` | `identity.person.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `ekata-mastercard:risk.customer.assess` | `risk.customer.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.157 Early Warning Services — `early-warning-services`

Category: `bureau`. Family: `early-warning-services`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): US. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Account and identity network; restricted access

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `early-warning-services:identity.person.verify` | `identity.person.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `early-warning-services:risk.customer.assess` | `risk.customer.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.158 ChexSystems / FIS — `chexsystems-fis`

Category: `bureau`. Family: `chexsystems-fis`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): US. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Deposit-account consumer reporting; restricted permissible purpose

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `chexsystems-fis:identity.person.verify` | `identity.person.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `chexsystems-fis:risk.customer.assess` | `risk.customer.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.159 Innovis — `innovis`

Category: `bureau`. Family: `innovis`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): US. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Consumer identity and bureau

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `innovis:identity.person.verify` | `identity.person.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `innovis:risk.customer.assess` | `risk.customer.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.160 SentiLink — `sentilink`

Category: `bureau`. Family: `sentilink`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): US. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Synthetic identity and identity risk

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `sentilink:identity.person.verify` | `identity.person.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `sentilink:risk.customer.assess` | `risk.customer.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.161 Giact / LSEG — `giact-lseg`

Category: `bureau`. Family: `giact-lseg`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): US. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Account and identity verification

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `giact-lseg:identity.person.verify` | `identity.person.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `giact-lseg:risk.customer.assess` | `risk.customer.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.162 Trustfull — `trustfull`

Category: `bureau`. Family: `trustfull`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Digital identity risk

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `trustfull:identity.person.verify` | `identity.person.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `trustfull:risk.customer.assess` | `risk.customer.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.163 TrustCloud — `trustcloud`

Category: `bureau`. Family: `trustcloud`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Europe / Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Digital identity; distinct from similarly named security vendors

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `trustcloud:identity.person.verify` | `identity.person.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `trustcloud:risk.customer.assess` | `risk.customer.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.164 Sprinque — `sprinque`

Category: `bureau`. Family: `sprinque`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Europe. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Business payment risk adjacent; current availability confirm

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `sprinque:identity.person.verify` | `identity.person.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `sprinque:risk.customer.assess` | `risk.customer.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.165 SEON — `seon`

Category: `fraud`. Family: `seon`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Device email phone risk and AML product family

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `seon:risk.device` | `risk.device.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `seon:risk.email` | `risk.email.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `seon:risk.phone` | `risk.phone.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.166 Sift — `sift`

Category: `fraud`. Family: `sift`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Digital fraud signals; not a substitute for AML

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `sift:risk.device` | `risk.device.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `sift:risk.email` | `risk.email.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `sift:risk.phone` | `risk.phone.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.167 Fingerprint — `fingerprint`

Category: `fraud`. Family: `fingerprint`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Device intelligence component

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `fingerprint:risk.device` | `risk.device.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `fingerprint:risk.email` | `risk.email.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `fingerprint:risk.phone` | `risk.phone.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.168 IPQS — `ipqs`

Category: `fraud`. Family: `ipqs`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: IP email phone intelligence

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `ipqs:risk.device` | `risk.device.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `ipqs:risk.email` | `risk.email.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `ipqs:risk.phone` | `risk.phone.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.169 MaxMind — `maxmind`

Category: `fraud`. Family: `maxmind`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: minFraud and GeoIP

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `maxmind:risk.device` | `risk.device.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `maxmind:risk.email` | `risk.email.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `maxmind:risk.phone` | `risk.phone.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.170 IPinfo — `ipinfo`

Category: `fraud`. Family: `ipinfo`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: IP enrichment component

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `ipinfo:risk.device` | `risk.device.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `ipinfo:risk.email` | `risk.email.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `ipinfo:risk.phone` | `risk.phone.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.171 Telesign — `telesign`

Category: `fraud`. Family: `telesign`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Phone intelligence

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `telesign:risk.device` | `risk.device.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `telesign:risk.email` | `risk.email.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `telesign:risk.phone` | `risk.phone.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.172 Twilio Lookup — `twilio-lookup`

Category: `fraud`. Family: `twilio-lookup`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Phone intelligence; product row

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `twilio-lookup:risk.device` | `risk.device.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `twilio-lookup:risk.email` | `risk.email.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `twilio-lookup:risk.phone` | `risk.phone.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.173 Vonage Identity Insights — `vonage-identity-insights`

Category: `fraud`. Family: `vonage-identity-insights`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Phone and network signals

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `vonage-identity-insights:risk.device` | `risk.device.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `vonage-identity-insights:risk.email` | `risk.email.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `vonage-identity-insights:risk.phone` | `risk.phone.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.174 CAMARA / GSMA Open Gateway — `camara-gsma-open-gateway`

Category: `fraud`. Family: `camara-gsma-open-gateway`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: API ecosystem not one provider; national operators required

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `camara-gsma-open-gateway:risk.phone` | `risk.phone.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.175 BioCatch — `biocatch`

Category: `fraud`. Family: `biocatch`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Behavioral intelligence

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `biocatch:risk.device` | `risk.device.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `biocatch:risk.email` | `risk.email.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `biocatch:risk.phone` | `risk.phone.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.176 ThreatMetrix / LexisNexis — `threatmetrix-lexisnexis`

Category: `fraud`. Family: `lexisnexis-risk-solutions`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Product-family row; not incremental vendor

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `threatmetrix-lexisnexis:risk.device` | `risk.device.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `threatmetrix-lexisnexis:risk.email` | `risk.email.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `threatmetrix-lexisnexis:risk.phone` | `risk.phone.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.177 TruNarrative / LexisNexis — `trunarrative-lexisnexis`

Category: `fraud`. Family: `lexisnexis-risk-solutions`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Product-family row; not incremental vendor

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `trunarrative-lexisnexis:risk.device` | `risk.device.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `trunarrative-lexisnexis:risk.email` | `risk.email.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `trunarrative-lexisnexis:risk.phone` | `risk.phone.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.178 Transmit Security — `transmit-security`

Category: `fraud`. Family: `transmit-security`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Identity risk and authentication component

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `transmit-security:risk.device` | `risk.device.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `transmit-security:risk.email` | `risk.email.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `transmit-security:risk.phone` | `risk.phone.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.179 DataVisor — `datavisor`

Category: `fraud`. Family: `datavisor`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Fraud and AML risk

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `datavisor:risk.device` | `risk.device.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `datavisor:risk.email` | `risk.email.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `datavisor:risk.phone` | `risk.phone.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.180 Forter — `forter`

Category: `fraud`. Family: `forter`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Commerce fraud adjacent

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `forter:risk.device` | `risk.device.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `forter:risk.email` | `risk.email.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `forter:risk.phone` | `risk.phone.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.181 Incognia — `incognia`

Category: `fraud`. Family: `incognia`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Location and device intelligence

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `incognia:risk.device` | `risk.device.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `incognia:risk.email` | `risk.email.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `incognia:risk.phone` | `risk.phone.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.182 Deduce — `deduce`

Category: `fraud`. Family: `deduce`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): US / Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Identity network signals

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `deduce:risk.device` | `risk.device.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `deduce:risk.email` | `risk.email.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `deduce:risk.phone` | `risk.phone.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.183 Emailage / LexisNexis — `emailage-lexisnexis`

Category: `fraud`. Family: `lexisnexis-risk-solutions`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Product-family row; not incremental vendor

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `emailage-lexisnexis:risk.device` | `risk.device.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `emailage-lexisnexis:risk.email` | `risk.email.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `emailage-lexisnexis:risk.phone` | `risk.phone.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.184 Darwinium — `darwinium`

Category: `fraud`. Family: `darwinium`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Digital risk component

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `darwinium:risk.device` | `risk.device.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `darwinium:risk.email` | `risk.email.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `darwinium:risk.phone` | `risk.phone.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.185 Plaid — `plaid`

Category: `account`. Family: `plaid`. Evidence: `public_material_reviewed`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): US / Europe. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: `S17`, `S18`. Notes: Identity Match and Identity Verification; Cognito legacy

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `plaid:account.ownership.verify` | `account.ownership.intelligence.unresolved` | `vocabulary_mapping` | `fixture_tested` | `plaid` | Legacy semantic proposal retained; support must be established per binding. |
| `plaid:identity.person.verify` | `identity.person.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `plaid:financial.evidence.retrieve` | `financial.evidence.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.186 Tink — `tink`

Category: `account`. Family: `tink`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Europe. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Open banking and account evidence

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `tink:account.ownership.verify` | `account.ownership.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `tink:financial.evidence.retrieve` | `financial.evidence.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.187 TrueLayer — `truelayer`

Category: `account`. Family: `truelayer`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Europe. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Account verification and open banking

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `truelayer:account.ownership.verify` | `account.ownership.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `truelayer:financial.evidence.retrieve` | `financial.evidence.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.188 Yapily — `yapily`

Category: `account`. Family: `yapily`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Europe. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Open banking

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `yapily:account.ownership.verify` | `account.ownership.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `yapily:financial.evidence.retrieve` | `financial.evidence.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.189 Token.io — `token-io`

Category: `account`. Family: `token-io`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Europe. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Open banking

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `token-io:account.ownership.verify` | `account.ownership.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `token-io:financial.evidence.retrieve` | `financial.evidence.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.190 Salt Edge — `salt-edge`

Category: `account`. Family: `salt-edge`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Europe / Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Open banking data

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `salt-edge:account.ownership.verify` | `account.ownership.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `salt-edge:financial.evidence.retrieve` | `financial.evidence.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.191 Finicity / Mastercard — `finicity-mastercard`

Category: `account`. Family: `mastercard-open-banking`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): US. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Open banking product family

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `finicity-mastercard:account.ownership.verify` | `account.ownership.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `finicity-mastercard:financial.evidence.retrieve` | `financial.evidence.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.192 MX — `mx`

Category: `account`. Family: `mx`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): US. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Account data and verification

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `mx:account.ownership.verify` | `account.ownership.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `mx:financial.evidence.retrieve` | `financial.evidence.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.193 Akoya — `akoya`

Category: `account`. Family: `akoya`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): US. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Permissioned financial data

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `akoya:account.ownership.verify` | `account.ownership.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `akoya:financial.evidence.retrieve` | `financial.evidence.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.194 Yodlee — `yodlee`

Category: `account`. Family: `yodlee`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Account data; current parent confirm

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `yodlee:account.ownership.verify` | `account.ownership.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `yodlee:financial.evidence.retrieve` | `financial.evidence.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.195 Flinks — `flinks`

Category: `account`. Family: `flinks`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Canada / US. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Account data and verification

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `flinks:account.ownership.verify` | `account.ownership.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `flinks:financial.evidence.retrieve` | `financial.evidence.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.196 Belvo — `belvo`

Category: `account`. Family: `belvo`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Latin America. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Open finance data

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `belvo:account.ownership.verify` | `account.ownership.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `belvo:financial.evidence.retrieve` | `financial.evidence.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.197 Prometeo — `prometeo`

Category: `account`. Family: `prometeo`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Latin America. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Account and bank data

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `prometeo:account.ownership.verify` | `account.ownership.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `prometeo:financial.evidence.retrieve` | `financial.evidence.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.198 Fintoc — `fintoc`

Category: `account`. Family: `fintoc`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Latin America. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Open banking

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `fintoc:account.ownership.verify` | `account.ownership.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `fintoc:financial.evidence.retrieve` | `financial.evidence.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.199 Finverse — `finverse`

Category: `account`. Family: `finverse`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Asia. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Financial account data

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `finverse:account.ownership.verify` | `account.ownership.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `finverse:financial.evidence.retrieve` | `financial.evidence.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.200 Brankas — `brankas`

Category: `account`. Family: `brankas`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Southeast Asia. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Open finance

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `brankas:account.ownership.verify` | `account.ownership.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `brankas:financial.evidence.retrieve` | `financial.evidence.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.201 Finantier — `finantier`

Category: `account`. Family: `finantier`. Evidence: `candidate_unverified`. Original routing state: `quarantined_unrelated_reference_content`.  
Market hint (unverified): Southeast Asia. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Candidate; current availability requires confirmation | Retrieved historical domain returned unrelated gambling content. DO NOT use this domain for provider access; historical inventory only.

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `finantier:account.ownership.verify` | `account.ownership.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `finantier:financial.evidence.retrieve` | `financial.evidence.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.202 Mono — `mono`

Category: `account`. Family: `mono`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Africa. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Financial account data

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `mono:account.ownership.verify` | `account.ownership.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `mono:financial.evidence.retrieve` | `financial.evidence.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.203 Okra — `okra`

Category: `account`. Family: `okra`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Africa. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Candidate; current availability requires confirmation

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `okra:account.ownership.verify` | `account.ownership.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `okra:financial.evidence.retrieve` | `financial.evidence.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.204 Stitch — `stitch`

Category: `account`. Family: `stitch`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Africa. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Account data and payments; product confirm

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `stitch:account.ownership.verify` | `account.ownership.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `stitch:financial.evidence.retrieve` | `financial.evidence.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.205 Moneyhub — `moneyhub`

Category: `account`. Family: `moneyhub`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): UK. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Open finance

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `moneyhub:account.ownership.verify` | `account.ownership.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `moneyhub:financial.evidence.retrieve` | `financial.evidence.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.206 SurePay — `surepay`

Category: `account`. Family: `surepay`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Europe. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Confirmation of Payee / verification of payee

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `surepay:account.ownership.verify` | `account.ownership.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.207 Trustpair — `trustpair`

Category: `account`. Family: `trustpair`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Bank account validation

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `trustpair:account.ownership.verify` | `account.ownership.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.208 iPiD — `ipid`

Category: `account`. Family: `ipid`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Payee verification

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `ipid:account.ownership.verify` | `account.ownership.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.209 Swift Payment Pre-validation — `swift-payment-pre-validation`

Category: `account`. Family: `swift-payment-pre-validation`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Network product; contracted access

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `swift-payment-pre-validation:account.ownership.verify` | `account.ownership.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.210 LexisNexis Bankers Almanac — `lexisnexis-bankers-almanac`

Category: `account`. Family: `lexisnexis-risk-solutions`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Bank reference data; LexisNexis product-family row

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `lexisnexis-bankers-almanac:reference.identifier.lookup` | `reference.identifier.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.211 NICE Actimize — `nice-actimize`

Category: `monitoring`. Family: `nice-actimize`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: AML screening monitoring and investigations

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `nice-actimize:transaction.monitor` | `transaction.monitoring.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `nice-actimize:case.manage` | `case.management.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `nice-actimize:risk.customer.assess` | `risk.customer.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.212 Nasdaq Verafin — `nasdaq-verafin`

Category: `monitoring`. Family: `nasdaq-verafin`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): North America / Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Financial crime platform

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `nasdaq-verafin:transaction.monitor` | `transaction.monitoring.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `nasdaq-verafin:case.manage` | `case.management.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `nasdaq-verafin:risk.customer.assess` | `risk.customer.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.213 SAS — `sas`

Category: `monitoring`. Family: `sas`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: AML and fraud analytics

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `sas:transaction.monitor` | `transaction.monitoring.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `sas:case.manage` | `case.management.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `sas:risk.customer.assess` | `risk.customer.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.214 Oracle Financial Services — `oracle-financial-services`

Category: `monitoring`. Family: `oracle-financial-services`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: FCCM and AML

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `oracle-financial-services:transaction.monitor` | `transaction.monitoring.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `oracle-financial-services:case.manage` | `case.management.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `oracle-financial-services:risk.customer.assess` | `risk.customer.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.215 FICO — `fico`

Category: `monitoring`. Family: `fico`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: SirOn family; current availability / ownership confirm

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `fico:transaction.monitor` | `transaction.monitoring.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `fico:case.manage` | `case.management.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `fico:risk.customer.assess` | `risk.customer.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.216 BAE Systems Digital Intelligence — `bae-systems-digital-intelligence`

Category: `monitoring`. Family: `sensa-symphonyai`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: NetReveal legacy; SymphonyAI product family not separate incumbent

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `bae-systems-digital-intelligence:transaction.monitor` | `transaction.monitoring.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `bae-systems-digital-intelligence:case.manage` | `case.management.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `bae-systems-digital-intelligence:risk.customer.assess` | `risk.customer.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.217 Fiserv — `fiserv`

Category: `monitoring`. Family: `fiserv`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Financial crime risk products

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `fiserv:transaction.monitor` | `transaction.monitoring.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `fiserv:case.manage` | `case.management.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `fiserv:risk.customer.assess` | `risk.customer.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.218 FIS — `fis`

Category: `monitoring`. Family: `fis`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Financial crime products

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `fis:transaction.monitor` | `transaction.monitoring.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `fis:case.manage` | `case.management.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `fis:risk.customer.assess` | `risk.customer.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.219 ACI Worldwide — `aci-worldwide`

Category: `monitoring`. Family: `aci-worldwide`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Payments fraud and compliance

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `aci-worldwide:transaction.monitor` | `transaction.monitoring.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `aci-worldwide:case.manage` | `case.management.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `aci-worldwide:risk.customer.assess` | `risk.customer.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.220 Temenos — `temenos`

Category: `monitoring`. Family: `temenos`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Financial crime mitigation

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `temenos:transaction.monitor` | `transaction.monitoring.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `temenos:case.manage` | `case.management.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `temenos:risk.customer.assess` | `risk.customer.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.221 Napier AI — `napier-ai`

Category: `monitoring`. Family: `napier-ai`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Screening monitoring and client risk

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `napier-ai:transaction.monitor` | `transaction.monitoring.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `napier-ai:case.manage` | `case.management.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `napier-ai:risk.customer.assess` | `risk.customer.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.222 Hawk — `hawk`

Category: `monitoring`. Family: `hawk`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Hawk AI legacy naming

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `hawk:transaction.monitor` | `transaction.monitoring.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `hawk:case.manage` | `case.management.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `hawk:risk.customer.assess` | `risk.customer.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.223 Feedzai — `feedzai`

Category: `monitoring`. Family: `feedzai`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Fraud and AML

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `feedzai:transaction.monitor` | `transaction.monitoring.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `feedzai:case.manage` | `case.management.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `feedzai:risk.customer.assess` | `risk.customer.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.224 ThetaRay — `thetaray`

Category: `monitoring`. Family: `thetaray`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: AML transaction monitoring

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `thetaray:transaction.monitor` | `transaction.monitoring.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `thetaray:case.manage` | `case.management.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `thetaray:risk.customer.assess` | `risk.customer.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.225 Tookitaki — `tookitaki`

Category: `monitoring`. Family: `tookitaki`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Asia / Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: FinCense AML

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `tookitaki:transaction.monitor` | `transaction.monitoring.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `tookitaki:case.manage` | `case.management.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `tookitaki:risk.customer.assess` | `risk.customer.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.226 Unit21 — `unit21`

Category: `monitoring`. Family: `unit21`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): US / Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Monitoring and case management

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `unit21:transaction.monitor` | `transaction.monitoring.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `unit21:case.manage` | `case.management.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `unit21:risk.customer.assess` | `risk.customer.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.227 Sardine — `sardine`

Category: `monitoring`. Family: `sardine`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Fraud and AML

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `sardine:transaction.monitor` | `transaction.monitoring.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `sardine:case.manage` | `case.management.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `sardine:risk.customer.assess` | `risk.customer.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.228 Flagright — `flagright`

Category: `monitoring`. Family: `flagright`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: AML monitoring

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `flagright:transaction.monitor` | `transaction.monitoring.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `flagright:case.manage` | `case.management.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `flagright:risk.customer.assess` | `risk.customer.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.229 Oscilar — `oscilar`

Category: `monitoring`. Family: `oscilar`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Risk decisioning and AML

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `oscilar:transaction.monitor` | `transaction.monitoring.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `oscilar:case.manage` | `case.management.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `oscilar:risk.customer.assess` | `risk.customer.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.230 Lucinity — `lucinity`

Category: `monitoring`. Family: `lucinity`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Investigations and AML

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `lucinity:transaction.monitor` | `transaction.monitoring.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `lucinity:case.manage` | `case.management.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `lucinity:risk.customer.assess` | `risk.customer.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.231 Hummingbird — `hummingbird`

Category: `monitoring`. Family: `hummingbird`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Investigations and reporting

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `hummingbird:transaction.monitor` | `transaction.monitoring.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `hummingbird:case.manage` | `case.management.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `hummingbird:risk.customer.assess` | `risk.customer.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.232 Alessa — `alessa`

Category: `monitoring`. Family: `alessa`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: AML monitoring and reporting

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `alessa:transaction.monitor` | `transaction.monitoring.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `alessa:case.manage` | `case.management.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `alessa:risk.customer.assess` | `risk.customer.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.233 AML Partners — `aml-partners`

Category: `monitoring`. Family: `aml-partners`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): US / Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: RegTechONE

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `aml-partners:transaction.monitor` | `transaction.monitoring.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `aml-partners:case.manage` | `case.management.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `aml-partners:risk.customer.assess` | `risk.customer.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.234 IMTF — `imtf`

Category: `monitoring`. Family: `imtf`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: SirOn family; confirm regional product rights

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `imtf:transaction.monitor` | `transaction.monitoring.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `imtf:case.manage` | `case.management.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `imtf:risk.customer.assess` | `risk.customer.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.235 Eastnets — `eastnets`

Category: `monitoring`. Family: `eastnets`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Screening and AML

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `eastnets:transaction.monitor` | `transaction.monitoring.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `eastnets:case.manage` | `case.management.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `eastnets:risk.customer.assess` | `risk.customer.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.236 Intix — `intix`

Category: `monitoring`. Family: `vyntra`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Transaction data intelligence; current Vyntra brand confirm | Reference now presents Vyntra transaction observability; preserve Intix as legacy/product alias

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `intix:transaction.monitor` | `transaction.monitoring.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `intix:case.manage` | `case.management.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `intix:risk.customer.assess` | `risk.customer.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.237 Vyntra — `vyntra`

Category: `monitoring`. Family: `vyntra`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Financial crime and transaction intelligence

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `vyntra:transaction.monitor` | `transaction.monitoring.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `vyntra:case.manage` | `case.management.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `vyntra:risk.customer.assess` | `risk.customer.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.238 Clari5 — `clari5`

Category: `monitoring`. Family: `clari5`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): India / Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Enterprise fraud and AML

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `clari5:transaction.monitor` | `transaction.monitoring.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `clari5:case.manage` | `case.management.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `clari5:risk.customer.assess` | `risk.customer.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.239 AML RightSource — `aml-rightsource`

Category: `monitoring`. Family: `aml-rightsource`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Managed services and technology; Arachnys legacy family

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `aml-rightsource:transaction.monitor` | `transaction.monitoring.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `aml-rightsource:case.manage` | `case.management.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `aml-rightsource:risk.customer.assess` | `risk.customer.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.240 Quantifind — `quantifind`

Category: `monitoring`. Family: `quantifind`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Graphyte investigations and intelligence

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `quantifind:transaction.monitor` | `transaction.monitoring.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `quantifind:case.manage` | `case.management.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `quantifind:risk.customer.assess` | `risk.customer.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.241 Quantexa — `quantexa`

Category: `monitoring`. Family: `quantexa`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Entity resolution and network analytics

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `quantexa:entity.resolve` | `entity.resolution.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `quantexa:business.ownership.discover` | `business.ownership.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `quantexa:risk.network` | `risk.network.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.242 Fenergo — `fenergo`

Category: `monitoring`. Family: `fenergo`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: CLM KYC and AML; Sentinels legacy family

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `fenergo:transaction.monitor` | `transaction.monitoring.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `fenergo:case.manage` | `case.management.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `fenergo:risk.customer.assess` | `risk.customer.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.243 Appway / FNZ — `appway-fnz`

Category: `monitoring`. Family: `appway-fnz`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Onboarding workflow family

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `appway-fnz:transaction.monitor` | `transaction.monitoring.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `appway-fnz:case.manage` | `case.management.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `appway-fnz:risk.customer.assess` | `risk.customer.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.244 Alloy — `alloy`

Category: `orchestration`. Family: `alloy`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): US / Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Identity orchestration and decisioning

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `alloy:workflow.orchestrate` | `workflow.orchestration.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.245 Taktile — `taktile`

Category: `orchestration`. Family: `taktile`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Decisioning and data orchestration

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `taktile:workflow.orchestrate` | `workflow.orchestration.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.246 Oscilar orchestration — `oscilar-orchestration`

Category: `orchestration`. Family: `oscilar`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Same provider as monitoring row

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `oscilar-orchestration:workflow.orchestrate` | `workflow.orchestration.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.247 Provenir — `provenir`

Category: `orchestration`. Family: `provenir`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Risk decisioning orchestration

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `provenir:workflow.orchestrate` | `workflow.orchestration.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.248 Atfinity — `atfinity`

Category: `orchestration`. Family: `atfinity`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Europe / Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Onboarding and KYC orchestration

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `atfinity:workflow.orchestrate` | `workflow.orchestration.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.249 Camunda — `camunda`

Category: `orchestration`. Family: `camunda`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Generic workflow component not KYC data source

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `camunda:workflow.orchestrate` | `workflow.orchestration.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.250 Pega — `pega`

Category: `orchestration`. Family: `pega`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: CLM and KYC workflow

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `pega:workflow.orchestrate` | `workflow.orchestration.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.251 Chainalysis — `chainalysis`

Category: `crypto`. Family: `chainalysis`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: KYT Reactor and blockchain intelligence

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `chainalysis:crypto.wallet.screen` | `crypto.wallet.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `chainalysis:crypto.transaction.monitor` | `crypto.transaction.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.252 TRM Labs — `trm-labs`

Category: `crypto`. Family: `trm-labs`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Wallet screening and monitoring

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `trm-labs:crypto.wallet.screen` | `crypto.wallet.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `trm-labs:crypto.transaction.monitor` | `crypto.transaction.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.253 Elliptic — `elliptic`

Category: `crypto`. Family: `elliptic`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Blockchain screening and intelligence

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `elliptic:crypto.wallet.screen` | `crypto.wallet.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `elliptic:crypto.transaction.monitor` | `crypto.transaction.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.254 Merkle Science — `merkle-science`

Category: `crypto`. Family: `merkle-science`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global / APAC. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Blockchain intelligence

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `merkle-science:crypto.wallet.screen` | `crypto.wallet.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `merkle-science:crypto.transaction.monitor` | `crypto.transaction.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.255 Crystal Intelligence — `crystal-intelligence`

Category: `crypto`. Family: `crystal-intelligence`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Blockchain intelligence

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `crystal-intelligence:crypto.wallet.screen` | `crypto.wallet.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `crystal-intelligence:crypto.transaction.monitor` | `crypto.transaction.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.256 Scorechain — `scorechain`

Category: `crypto`. Family: `scorechain`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Europe / Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Blockchain compliance

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `scorechain:crypto.wallet.screen` | `crypto.wallet.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `scorechain:crypto.transaction.monitor` | `crypto.transaction.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.257 Lukka — `lukka`

Category: `crypto`. Family: `lukka`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Coinfirm legacy family

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `lukka:crypto.wallet.screen` | `crypto.wallet.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `lukka:crypto.transaction.monitor` | `crypto.transaction.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.258 CipherTrace / Mastercard — `ciphertrace-mastercard`

Category: `crypto`. Family: `ciphertrace-mastercard`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Legacy product; current availability requires confirmation

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `ciphertrace-mastercard:crypto.wallet.screen` | `crypto.wallet.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `ciphertrace-mastercard:crypto.transaction.monitor` | `crypto.transaction.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.259 Coinfirm — `coinfirm`

Category: `crypto`. Family: `lukka`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Lukka product-family row; not incremental vendor

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `coinfirm:crypto.wallet.screen` | `crypto.wallet.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `coinfirm:crypto.transaction.monitor` | `crypto.transaction.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.260 AnChain.AI — `anchain-ai`

Category: `crypto`. Family: `anchain-ai`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Blockchain risk and investigations

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `anchain-ai:crypto.wallet.screen` | `crypto.wallet.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `anchain-ai:crypto.transaction.monitor` | `crypto.transaction.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.261 Uppsala Security — `uppsala-security`

Category: `crypto`. Family: `uppsala-security`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Asia / Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Blockchain intelligence

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `uppsala-security:crypto.wallet.screen` | `crypto.wallet.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `uppsala-security:crypto.transaction.monitor` | `crypto.transaction.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.262 AMLBot — `amlbot`

Category: `crypto`. Family: `amlbot`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Crypto AML tools

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `amlbot:crypto.wallet.screen` | `crypto.wallet.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `amlbot:crypto.transaction.monitor` | `crypto.transaction.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.263 Global Ledger — `global-ledger`

Category: `crypto`. Family: `global-ledger`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Europe / Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Blockchain intelligence

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `global-ledger:crypto.wallet.screen` | `crypto.wallet.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `global-ledger:crypto.transaction.monitor` | `crypto.transaction.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.264 Blockaid — `blockaid`

Category: `crypto`. Family: `blockaid`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: On-chain security; AML applicability product-specific

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `blockaid:crypto.wallet.screen` | `crypto.wallet.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `blockaid:crypto.transaction.monitor` | `crypto.transaction.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.265 Solidus Labs — `solidus-labs`

Category: `crypto`. Family: `solidus-labs`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Crypto market surveillance adjacent

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `solidus-labs:crypto.wallet.screen` | `crypto.wallet.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `solidus-labs:crypto.transaction.monitor` | `crypto.transaction.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.266 Notabene — `notabene`

Category: `travel_rule`. Family: `notabene`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Travel Rule counterparty and messaging

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `notabene:travel_rule.exchange` | `travel_rule.exchange.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.267 Sygna — `sygna`

Category: `travel_rule`. Family: `sygna`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): APAC / Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Travel Rule messaging

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `sygna:travel_rule.exchange` | `travel_rule.exchange.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.268 VerifyVASP — `verifyvasp`

Category: `travel_rule`. Family: `verifyvasp`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): APAC / Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Travel Rule messaging

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `verifyvasp:travel_rule.exchange` | `travel_rule.exchange.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.269 TRISA — `trisa`

Category: `travel_rule`. Family: `trisa`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Open protocol and network not one data vendor

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `trisa:travel_rule.exchange` | `travel_rule.exchange.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.270 TRUST network — `trust-network`

Category: `travel_rule`. Family: `trust-network`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Travel Rule network not unrestricted public API

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `trust-network:travel_rule.exchange` | `travel_rule.exchange.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.271 21 Analytics — `21-analytics`

Category: `travel_rule`. Family: `21-analytics`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Europe / Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Travel Rule and self-hosted wallet proof

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `21-analytics:travel_rule.exchange` | `travel_rule.exchange.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.272 Shyft / Veriscope — `shyft-veriscope`

Category: `travel_rule`. Family: `shyft-veriscope`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Travel Rule protocol and messaging

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `shyft-veriscope:travel_rule.exchange` | `travel_rule.exchange.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.273 Control Risks — `control-risks`

Category: `edd`. Family: `control-risks`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: EDD and investigations; managed service not presumed API

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `control-risks:edd.report.retrieve` | `edd.report.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.274 Kroll — `kroll`

Category: `edd`. Family: `kroll`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: EDD and investigations

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `kroll:edd.report.retrieve` | `edd.report.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.275 Exiger — `exiger`

Category: `edd`. Family: `exiger`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: DDIQ and supply chain risk

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `exiger:edd.report.retrieve` | `edd.report.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.276 S-RM — `s-rm`

Category: `edd`. Family: `s-rm`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: EDD investigations

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `s-rm:edd.report.retrieve` | `edd.report.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.277 Mintz Group — `mintz-group`

Category: `edd`. Family: `mintz-group`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: EDD investigations

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `mintz-group:edd.report.retrieve` | `edd.report.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.278 LSEG Due Diligence — `lseg-due-diligence`

Category: `edd`. Family: `lseg-world-check`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Product-family row; not incremental vendor

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `lseg-due-diligence:edd.report.retrieve` | `edd.report.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.279 Diligent — `diligent`

Category: `edd`. Family: `diligent`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Third-party risk and due diligence

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `diligent:edd.report.retrieve` | `edd.report.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.280 GAN Integrity — `gan-integrity`

Category: `edd`. Family: `gan-integrity`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Third-party compliance

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `gan-integrity:edd.report.retrieve` | `edd.report.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.281 RepRisk — `reprisk`

Category: `edd`. Family: `reprisk`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Business conduct risk intelligence; adjacent

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `reprisk:edd.report.retrieve` | `edd.report.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.282 S&P Global Market Intelligence — `s-p-global-market-intelligence`

Category: `edd`. Family: `s-p-global-market-intelligence`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Entity ownership and maritime data products

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `s-p-global-market-intelligence:edd.report.retrieve` | `edd.report.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.283 Lloyd's List Intelligence — `lloyd-s-list-intelligence`

Category: `edd`. Family: `lloyd-s-list-intelligence`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Maritime and trade risk intelligence

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `lloyd-s-list-intelligence:edd.report.retrieve` | `edd.report.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.284 Windward — `windward`

Category: `edd`. Family: `windward`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Maritime risk intelligence

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `windward:edd.report.retrieve` | `edd.report.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.285 Pole Star Global — `pole-star-global`

Category: `edd`. Family: `pole-star-global`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: PurpleTRAC maritime screening

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `pole-star-global:edd.report.retrieve` | `edd.report.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.286 VesselBot — `vesselbot`

Category: `edd`. Family: `vesselbot`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Maritime data; AML product suitability confirm

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `vesselbot:edd.report.retrieve` | `edd.report.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.287 RavenPack — `ravenpack`

Category: `edd`. Family: `ravenpack`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: News analytics component

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `ravenpack:edd.report.retrieve` | `edd.report.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.288 Factiva / Dow Jones — `factiva-dow-jones`

Category: `edd`. Family: `dow-jones-risk-compliance`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Product-family row; licensed news not screening clearance

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `factiva-dow-jones:edd.report.retrieve` | `edd.report.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.289 LexisNexis Nexis Diligence — `lexisnexis-nexis-diligence`

Category: `edd`. Family: `lexisnexis-nexis-diligence`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Different business line from Risk Solutions; contracting entity confirm

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `lexisnexis-nexis-diligence:edd.report.retrieve` | `edd.report.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.290 Companies House — `companies-house`

Category: `registry`. Family: `companies-house`. Evidence: `public_docs_reviewed`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): UK. Proposed jurisdiction: `gb` (national-source hint from catalog; unverified).  
Source IDs: `S09`. Notes: Company profiles PSC officers filings; API public with key

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `companies-house:business.registry.lookup` | `business.registry.intelligence.gb` | `vocabulary_mapping` | `fixture_tested` | `companies_house` | Legacy semantic proposal retained; support must be established per binding. |
| `companies-house:business.officers.lookup` | `business.officers.intelligence.gb` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `companies-house:business.ownership.discover` | `business.ownership.intelligence.gb` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.291 US state Secretaries of State — `us-state-secretaries-of-state`

Category: `registry`. Family: `us-state-secretaries-of-state`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): US. Proposed jurisdiction: `us` (national-source hint from catalog; unverified).  
Source IDs: none. Notes: Registry family; state-by-state inventory needed; no common national API

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `us-state-secretaries-of-state:business.registry.lookup` | `business.registry.intelligence.us` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.292 SEC EDGAR — `sec-edgar`

Category: `registry`. Family: `sec-edgar`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): US. Proposed jurisdiction: `us` (national-source hint from catalog; unverified).  
Source IDs: none. Notes: Public company filings; not full private company registry

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `sec-edgar:business.registry.lookup` | `business.registry.intelligence.us` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.293 FinCEN BOI — `fincen-boi`

Category: `registry`. Family: `fincen-boi`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): US. Proposed jurisdiction: `us` (national-source hint from catalog; unverified).  
Source IDs: none. Notes: Restricted authorization; not an open KYC lookup API; legal scope must be checked

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `fincen-boi:business.registry.lookup` | `business.ownership.intelligence.us` | `semantic_correction` | `proposed_contract_only` | — | BOI is ownership/control information; restricted source, not a general company registry. |

### A.294 IRS TIN Matching — `irs-tin-matching`

Category: `registry`. Family: `irs-tin-matching`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): US. Proposed jurisdiction: `us` (national-source hint from catalog; unverified).  
Source IDs: none. Notes: Authorized participants and permissible purposes only

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `irs-tin-matching:identity.tax_id.verify` | `identity.tax_id.intelligence.us` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.295 SSA eCBSV — `ssa-ecbsv`

Category: `registry`. Family: `ssa-ecbsv`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): US. Proposed jurisdiction: `us` (national-source hint from catalog; unverified).  
Source IDs: none. Notes: Consent-based restricted SSN verification

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `ssa-ecbsv:identity.person.verify` | `identity.person.intelligence.us` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.296 AAMVA DLDV — `aamva-dldv`

Category: `registry`. Family: `aamva-dldv`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): US / Canada. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Restricted driver license data verification network

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `aamva-dldv:identity.person.verify` | `identity.person.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.297 Corporations Canada — `corporations-canada`

Category: `registry`. Family: `corporations-canada`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Canada. Proposed jurisdiction: `ca` (national-source hint from catalog; unverified).  
Source IDs: none. Notes: Federal registry; provinces separate

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `corporations-canada:business.registry.lookup` | `business.registry.intelligence.ca` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.298 SEDAR+ — `sedar`

Category: `registry`. Family: `sedar`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Canada. Proposed jurisdiction: `ca` (national-source hint from catalog; unverified).  
Source IDs: none. Notes: Issuer filings; not full KYB registry

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `sedar:business.registry.lookup` | `business.registry.intelligence.ca` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.299 INPI RNE — `inpi-rne`

Category: `registry`. Family: `inpi-rne`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): France. Proposed jurisdiction: `fr` (national-source hint from catalog; unverified).  
Source IDs: none. Notes: Company register data; access and UBO rights constrained

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `inpi-rne:business.registry.lookup` | `business.registry.intelligence.fr` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.300 INSEE Sirene — `insee-sirene`

Category: `registry`. Family: `insee-sirene`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): France. Proposed jurisdiction: `fr` (national-source hint from catalog; unverified).  
Source IDs: none. Notes: Business register and APIs

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `insee-sirene:business.registry.lookup` | `business.registry.intelligence.fr` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.301 German Handelsregister — `german-handelsregister`

Category: `registry`. Family: `german-handelsregister`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Germany. Proposed jurisdiction: `de` (national-source hint from catalog; unverified).  
Source IDs: none. Notes: Registry portal; API not assumed

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `german-handelsregister:business.registry.lookup` | `business.registry.intelligence.de` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.302 Unternehmensregister — `unternehmensregister`

Category: `registry`. Family: `unternehmensregister`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Germany. Proposed jurisdiction: `de` (national-source hint from catalog; unverified).  
Source IDs: none. Notes: Business register; API not assumed

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `unternehmensregister:business.registry.lookup` | `business.registry.intelligence.de` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.303 EU BRIS — `eu-bris`

Category: `registry`. Family: `eu-bris`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): EU / EEA. Proposed jurisdiction: `unresolved` (EU/EEA federation; select actual member registry jurisdiction).  
Source IDs: none. Notes: Registry interconnection; not unrestricted universal API

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `eu-bris:business.registry.lookup` | `business.registry.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.304 KVK — `kvk`

Category: `registry`. Family: `kvk`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Netherlands. Proposed jurisdiction: `nl` (national-source hint from catalog; unverified).  
Source IDs: none. Notes: Business register; data rights and UBO restrictions apply

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `kvk:business.registry.lookup` | `business.registry.intelligence.nl` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.305 CBE / KBO — `cbe-kbo`

Category: `registry`. Family: `cbe-kbo`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Belgium. Proposed jurisdiction: `be` (national-source hint from catalog; unverified).  
Source IDs: none. Notes: Crossroads Bank for Enterprises; bulk and access terms verify

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `cbe-kbo:business.registry.lookup` | `business.registry.intelligence.be` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.306 Bolagsverket — `bolagsverket`

Category: `registry`. Family: `bolagsverket`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Sweden. Proposed jurisdiction: `se` (national-source hint from catalog; unverified).  
Source IDs: none. Notes: Registry and beneficial ownership access restricted

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `bolagsverket:business.registry.lookup` | `business.registry.intelligence.se` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.307 Brønnøysund Register Centre — `br-nn-ysund-register-centre`

Category: `registry`. Family: `br-nn-ysund-register-centre`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Norway. Proposed jurisdiction: `no` (national-source hint from catalog; unverified).  
Source IDs: none. Notes: Entity register and APIs

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `br-nn-ysund-register-centre:business.registry.lookup` | `business.registry.intelligence.no` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.308 PRH — `prh`

Category: `registry`. Family: `prh`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Finland. Proposed jurisdiction: `fi` (national-source hint from catalog; unverified).  
Source IDs: none. Notes: Trade register and company data

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `prh:business.registry.lookup` | `business.registry.intelligence.fi` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.309 Danish Business Authority CVR — `danish-business-authority-cvr`

Category: `registry`. Family: `danish-business-authority-cvr`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Denmark. Proposed jurisdiction: `dk` (national-source hint from catalog; unverified).  
Source IDs: none. Notes: CVR registry data

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `danish-business-authority-cvr:business.registry.lookup` | `business.registry.intelligence.dk` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.310 Registro Imprese / InfoCamere — `registro-imprese-infocamere`

Category: `registry`. Family: `registro-imprese-infocamere`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Italy. Proposed jurisdiction: `it` (national-source hint from catalog; unverified).  
Source IDs: none. Notes: Registry and commercial data access

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `registro-imprese-infocamere:business.registry.lookup` | `business.registry.intelligence.it` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.311 Registradores — `registradores`

Category: `registry`. Family: `registradores`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Spain. Proposed jurisdiction: `es` (national-source hint from catalog; unverified).  
Source IDs: none. Notes: Company registry; contracted access

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `registradores:business.registry.lookup` | `business.registry.intelligence.es` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.312 CRO — `cro`

Category: `registry`. Family: `cro`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Ireland. Proposed jurisdiction: `ie` (national-source hint from catalog; unverified).  
Source IDs: none. Notes: Company registry

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `cro:business.registry.lookup` | `business.registry.intelligence.ie` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.313 Luxembourg Business Registers — `luxembourg-business-registers`

Category: `registry`. Family: `luxembourg-business-registers`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Luxembourg. Proposed jurisdiction: `lu` (national-source hint from catalog; unverified).  
Source IDs: none. Notes: Registry; beneficial ownership access controlled

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `luxembourg-business-registers:business.registry.lookup` | `business.registry.intelligence.lu` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.314 Zefix — `zefix`

Category: `registry`. Family: `zefix`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Switzerland. Proposed jurisdiction: `ch` (national-source hint from catalog; unverified).  
Source IDs: none. Notes: Company index

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `zefix:business.registry.lookup` | `business.registry.intelligence.ch` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.315 ASIC — `asic`

Category: `registry`. Family: `asic`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Australia. Proposed jurisdiction: `au` (national-source hint from catalog; unverified).  
Source IDs: none. Notes: Company registry; paid extracts and terms verify

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `asic:business.registry.lookup` | `business.registry.intelligence.au` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.316 Australian Business Register — `australian-business-register`

Category: `registry`. Family: `australian-business-register`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Australia. Proposed jurisdiction: `au` (national-source hint from catalog; unverified).  
Source IDs: none. Notes: ABN Lookup; not beneficial ownership verification

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `australian-business-register:business.registry.lookup` | `business.registry.intelligence.au` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.317 New Zealand Companies Office — `new-zealand-companies-office`

Category: `registry`. Family: `new-zealand-companies-office`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): New Zealand. Proposed jurisdiction: `nz` (national-source hint from catalog; unverified).  
Source IDs: none. Notes: Company and NZBN records

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `new-zealand-companies-office:business.registry.lookup` | `business.registry.intelligence.nz` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.318 ACRA — `acra`

Category: `registry`. Family: `acra`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Singapore. Proposed jurisdiction: `sg` (national-source hint from catalog; unverified).  
Source IDs: none. Notes: Bizfile and data products; restricted beneficial ownership access

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `acra:business.registry.lookup` | `business.registry.intelligence.sg` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.319 Hong Kong Companies Registry — `hong-kong-companies-registry`

Category: `registry`. Family: `hong-kong-companies-registry`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Hong Kong. Proposed jurisdiction: `hk` (national-source hint from catalog; unverified).  
Source IDs: none. Notes: Registry search; access conditions apply

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `hong-kong-companies-registry:business.registry.lookup` | `business.registry.intelligence.hk` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.320 MCA — `mca`

Category: `registry`. Family: `mca`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): India. Proposed jurisdiction: `in` (national-source hint from catalog; unverified).  
Source IDs: none. Notes: Company and LLP registry

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `mca:business.registry.lookup` | `business.registry.intelligence.in` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.321 UIDAI — `uidai`

Category: `registry`. Family: `uidai`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): India. Proposed jurisdiction: `in` (national-source hint from catalog; unverified).  
Source IDs: none. Notes: Aadhaar regulated authentication / offline verification; not open lookup

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `uidai:identity.person.verify` | `identity.person.intelligence.in` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.322 DigiLocker — `digilocker`

Category: `registry`. Family: `digilocker`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): India. Proposed jurisdiction: `in` (national-source hint from catalog; unverified).  
Source IDs: none. Notes: Consent-based document ecosystem

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `digilocker:identity.digital_id.verify` | `document.evidence.intelligence.in` | `semantic_correction` | `proposed_contract_only` | — | Catalog establishes a consent-based document ecosystem; document retrieval does not establish a verified digital-identity assertion. |

### A.323 CERSAI CKYCR — `cersai-ckycr`

Category: `registry`. Family: `cersai-ckycr`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): India. Proposed jurisdiction: `in` (national-source hint from catalog; unverified).  
Source IDs: none. Notes: Restricted central KYC registry

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `cersai-ckycr:identity.person.verify` | `identity.profile.intelligence.in` | `semantic_correction` | `proposed_contract_only` | — | Retrieving a central KYC record does not perform a new identity verification. |

### A.324 Protean eGov — `protean-egov`

Category: `registry`. Family: `protean-egov`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): India. Proposed jurisdiction: `in` (national-source hint from catalog; unverified).  
Source IDs: none. Notes: PAN and identity services; authorized access only

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `protean-egov:identity.person.verify` | `identity.tax_id.intelligence.in` | `semantic_correction` | `proposed_contract_only` | — | Catalog notes specifically name PAN/identity services; route PAN validation to tax-ID and require a separate contract for wider identity checks. |

### A.325 GSTN — `gstn`

Category: `registry`. Family: `gstn`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): India. Proposed jurisdiction: `in` (national-source hint from catalog; unverified).  
Source IDs: none. Notes: GST data; authorized partner rules

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `gstn:business.registry.lookup` | `identity.tax_id.intelligence.in` | `semantic_correction` | `proposed_contract_only` | — | GST is a tax-registration source; not a substitute for a corporate incorporation registry. |

### A.326 SSM — `ssm`

Category: `registry`. Family: `ssm`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Malaysia. Proposed jurisdiction: `my` (national-source hint from catalog; unverified).  
Source IDs: none. Notes: Company registry

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `ssm:business.registry.lookup` | `business.registry.intelligence.my` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.327 Indonesia AHU — `indonesia-ahu`

Category: `registry`. Family: `indonesia-ahu`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Indonesia. Proposed jurisdiction: `id` (national-source hint from catalog; unverified).  
Source IDs: none. Notes: Legal entity registry

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `indonesia-ahu:business.registry.lookup` | `business.registry.intelligence.id` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.328 Philippines SEC — `philippines-sec`

Category: `registry`. Family: `philippines-sec`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Philippines. Proposed jurisdiction: `ph` (national-source hint from catalog; unverified).  
Source IDs: none. Notes: Company registry

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `philippines-sec:business.registry.lookup` | `business.registry.intelligence.ph` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.329 China GSXT — `china-gsxt`

Category: `registry`. Family: `china-gsxt`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): China. Proposed jurisdiction: `cn` (national-source hint from catalog; unverified).  
Source IDs: none. Notes: Enterprise publicity; locality and access restrictions

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `china-gsxt:business.registry.lookup` | `business.registry.intelligence.cn` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.330 Japan Corporate Number Publication Site — `japan-corporate-number-publication-site`

Category: `registry`. Family: `japan-corporate-number-publication-site`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Japan. Proposed jurisdiction: `jp` (national-source hint from catalog; unverified).  
Source IDs: none. Notes: Corporate identifiers; not UBO verification

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `japan-corporate-number-publication-site:business.registry.lookup` | `business.registry.intelligence.jp` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.331 Taiwan MOEA — `taiwan-moea`

Category: `registry`. Family: `taiwan-moea`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Taiwan. Proposed jurisdiction: `tw` (national-source hint from catalog; unverified).  
Source IDs: none. Notes: Business registry

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `taiwan-moea:business.registry.lookup` | `business.registry.intelligence.tw` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.332 Korea DART — `korea-dart`

Category: `registry`. Family: `korea-dart`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): South Korea. Proposed jurisdiction: `kr` (national-source hint from catalog; unverified).  
Source IDs: none. Notes: Issuer filings and open data; not all private entities

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `korea-dart:business.registry.lookup` | `business.registry.intelligence.kr` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.333 Brazil Receita Federal — `brazil-receita-federal`

Category: `registry`. Family: `brazil-receita-federal`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Brazil. Proposed jurisdiction: `br` (national-source hint from catalog; unverified).  
Source IDs: none. Notes: CPF/CNPJ data; lawful access and scope verify

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `brazil-receita-federal:business.registry.lookup` | `business.registry.intelligence.br`<br>`identity.tax_id.intelligence.br` | `conditional_split` | `proposed_contract_only` | — | Conditional split: CNPJ business facts versus CPF/CNPJ tax-identifier checks; select by identifier/product, never emit both by default. |

### A.334 Mexico SAT — `mexico-sat`

Category: `registry`. Family: `mexico-sat`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Mexico. Proposed jurisdiction: `mx` (national-source hint from catalog; unverified).  
Source IDs: none. Notes: Tax data; RFC scope and authorization verify

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `mexico-sat:business.registry.lookup` | `identity.tax_id.intelligence.mx` | `semantic_correction` | `proposed_contract_only` | — | Catalog notes identify RFC/tax data; identifier type and authorized product must be pinned. |

### A.335 Mexico RENAPO — `mexico-renapo`

Category: `registry`. Family: `mexico-renapo`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Mexico. Proposed jurisdiction: `mx` (national-source hint from catalog; unverified).  
Source IDs: none. Notes: CURP / identity; lawful access only

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `mexico-renapo:business.registry.lookup` | `identity.person.intelligence.mx` | `semantic_correction` | `proposed_contract_only` | — | Catalog notes identify CURP/person identity, not a business registry. |

### A.336 Colombia RUES — `colombia-rues`

Category: `registry`. Family: `colombia-rues`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Colombia. Proposed jurisdiction: `co` (national-source hint from catalog; unverified).  
Source IDs: none. Notes: Business registry

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `colombia-rues:business.registry.lookup` | `business.registry.intelligence.co` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.337 Argentina ARCA — `argentina-arca`

Category: `registry`. Family: `argentina-arca`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Argentina. Proposed jurisdiction: `ar` (national-source hint from catalog; unverified).  
Source IDs: none. Notes: AFIP legacy name; tax data permission required

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `argentina-arca:business.registry.lookup` | `identity.tax_id.intelligence.ar` | `semantic_correction` | `proposed_contract_only` | — | Catalog notes identify tax data; treat as a tax-source hypothesis pending product contract. |

### A.338 Chile Registro de Empresas y Sociedades — `chile-registro-de-empresas-y-sociedades`

Category: `registry`. Family: `chile-registro-de-empresas-y-sociedades`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Chile. Proposed jurisdiction: `cl` (national-source hint from catalog; unverified).  
Source IDs: none. Notes: Business registry

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `chile-registro-de-empresas-y-sociedades:business.registry.lookup` | `business.registry.intelligence.cl` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.339 South Africa CIPC — `south-africa-cipc`

Category: `registry`. Family: `south-africa-cipc`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): South Africa. Proposed jurisdiction: `za` (national-source hint from catalog; unverified).  
Source IDs: none. Notes: Company registry; access terms apply

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `south-africa-cipc:business.registry.lookup` | `business.registry.intelligence.za` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.340 Nigeria CAC — `nigeria-cac`

Category: `registry`. Family: `nigeria-cac`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Nigeria. Proposed jurisdiction: `ng` (national-source hint from catalog; unverified).  
Source IDs: none. Notes: Company registry

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `nigeria-cac:business.registry.lookup` | `business.registry.intelligence.ng` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.341 Nigeria NIMC — `nigeria-nimc`

Category: `registry`. Family: `nigeria-nimc`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Nigeria. Proposed jurisdiction: `ng` (national-source hint from catalog; unverified).  
Source IDs: none. Notes: Restricted identity verification; authorized access

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `nigeria-nimc:identity.person.verify` | `identity.person.intelligence.ng` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.342 Nigeria NIBSS — `nigeria-nibss`

Category: `registry`. Family: `nigeria-nibss`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Nigeria. Proposed jurisdiction: `ng` (national-source hint from catalog; unverified).  
Source IDs: none. Notes: Restricted BVN and account verification network

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `nigeria-nibss:identity.person.verify` | `identity.person.intelligence.ng` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.343 Kenya BRS — `kenya-brs`

Category: `registry`. Family: `kenya-brs`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Kenya. Proposed jurisdiction: `ke` (national-source hint from catalog; unverified).  
Source IDs: none. Notes: Company registry

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `kenya-brs:business.registry.lookup` | `business.registry.intelligence.ke` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.344 Ghana ORC — `ghana-orc`

Category: `registry`. Family: `ghana-orc`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Ghana. Proposed jurisdiction: `gh` (national-source hint from catalog; unverified).  
Source IDs: none. Notes: Company registry

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `ghana-orc:business.registry.lookup` | `business.registry.intelligence.gh` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.345 Saudi Wathq / Thiqah — `saudi-wathq-thiqah`

Category: `registry`. Family: `saudi-wathq-thiqah`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Saudi Arabia. Proposed jurisdiction: `sa` (national-source hint from catalog; unverified).  
Source IDs: none. Notes: Authorized business data services

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `saudi-wathq-thiqah:business.registry.lookup` | `business.registry.intelligence.sa` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.346 Saudi ELM — `saudi-elm`

Category: `registry`. Family: `saudi-elm`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Saudi Arabia. Proposed jurisdiction: `sa` (national-source hint from catalog; unverified).  
Source IDs: none. Notes: Yakeen identity service; regulated access

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `saudi-elm:business.registry.lookup` | `identity.person.intelligence.sa` | `semantic_correction` | `proposed_contract_only` | — | Catalog notes identify Yakeen identity service, not a business registry. |

### A.347 UAE PASS — `uae-pass`

Category: `registry`. Family: `uae-pass`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): UAE. Proposed jurisdiction: `ae` (national-source hint from catalog; unverified).  
Source IDs: none. Notes: Consented digital identity; relying party onboarding

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `uae-pass:identity.digital_id.verify` | `identity.digital_id.intelligence.ae` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.348 Bahrain BENEFIT eKYC — `bahrain-benefit-ekyc`

Category: `registry`. Family: `bahrain-benefit-ekyc`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Bahrain. Proposed jurisdiction: `bh` (national-source hint from catalog; unverified).  
Source IDs: none. Notes: Restricted national eKYC service

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `bahrain-benefit-ekyc:business.registry.lookup` | `identity.person.intelligence.bh` | `semantic_correction` | `proposed_contract_only` | — | Catalog notes identify national eKYC, not a business registry. |

### A.349 Singapore MyInfo / Singpass — `singapore-myinfo-singpass`

Category: `registry`. Family: `singapore-myinfo-singpass`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Singapore. Proposed jurisdiction: `sg` (national-source hint from catalog; unverified).  
Source IDs: none. Notes: Consent-based digital identity; relying party approval

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `singapore-myinfo-singpass:identity.digital_id.verify` | `identity.digital_id.intelligence.sg` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.350 BankID Sweden — `bankid-sweden`

Category: `registry`. Family: `bankid-sweden`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Sweden. Proposed jurisdiction: `se` (national-source hint from catalog; unverified).  
Source IDs: none. Notes: Digital identity network; relying party onboarding

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `bankid-sweden:identity.digital_id.verify` | `identity.digital_id.intelligence.se` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.351 itsme — `itsme`

Category: `registry`. Family: `itsme`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Europe. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Digital identity network

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `itsme:identity.digital_id.verify` | `identity.digital_id.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.352 Norwegian BankID — `norwegian-bankid`

Category: `registry`. Family: `norwegian-bankid`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Norway. Proposed jurisdiction: `no` (national-source hint from catalog; unverified).  
Source IDs: none. Notes: Digital identity network

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `norwegian-bankid:identity.digital_id.verify` | `identity.digital_id.intelligence.no` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.353 SwissID — `swissid`

Category: `registry`. Family: `swissid`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Switzerland. Proposed jurisdiction: `ch` (national-source hint from catalog; unverified).  
Source IDs: none. Notes: Digital identity network

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `swissid:identity.digital_id.verify` | `identity.digital_id.intelligence.ch` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.354 Yoti — `yoti`

Category: `registry`. Family: `yoti`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): UK / Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Digital identity and document verification

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `yoti:identity.digital_id.verify` | `identity.digital_id.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |
| `yoti:identity.document.verify` | `identity.document.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.355 ConnectID — `connectid`

Category: `registry`. Family: `connectid`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Australia. Proposed jurisdiction: `au` (national-source hint from catalog; unverified).  
Source IDs: none. Notes: Digital identity network

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `connectid:identity.digital_id.verify` | `identity.digital_id.intelligence.au` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.356 OFAC Sanctions List Service — `ofac-sanctions-list-service`

Category: `official_lists`. Family: `ofac-sanctions-list-service`. Evidence: `public_docs_reviewed`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): US / Global subjects. Proposed jurisdiction: `us` (publisher authority from local source identity; proposed).  
Source IDs: `S19`. Notes: SDN and non-SDN lists; data publisher not a bank decision engine

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `ofac-sanctions-list-service:reference.list.ingest` | `reference.list.intelligence.us` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.357 UN Security Council Consolidated List — `un-security-council-consolidated-list`

Category: `official_lists`. Family: `un-security-council-consolidated-list`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `un` (publisher authority from local source identity; proposed).  
Source IDs: none. Notes: Official sanctions publisher

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `un-security-council-consolidated-list:reference.list.ingest` | `reference.list.intelligence.un` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.358 UK Sanctions List — `uk-sanctions-list`

Category: `official_lists`. Family: `uk-sanctions-list`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): UK / Global subjects. Proposed jurisdiction: `gb` (publisher authority from local source identity; proposed).  
Source IDs: none. Notes: FCDO source; current OFSI migration and list scope must be checked

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `uk-sanctions-list:reference.list.ingest` | `reference.list.intelligence.gb` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.359 EU Financial Sanctions Files — `eu-financial-sanctions-files`

Category: `official_lists`. Family: `eu-financial-sanctions-files`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): EU / Global subjects. Proposed jurisdiction: `eu` (publisher authority from local source identity; proposed).  
Source IDs: none. Notes: Official consolidated financial sanctions data; licensing and endpoint confirm

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `eu-financial-sanctions-files:reference.list.ingest` | `reference.list.intelligence.eu` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.360 Canada Consolidated Autonomous Sanctions — `canada-consolidated-autonomous-sanctions`

Category: `official_lists`. Family: `canada-consolidated-autonomous-sanctions`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Canada / Global subjects. Proposed jurisdiction: `ca` (publisher authority from local source identity; proposed).  
Source IDs: none. Notes: Autonomous list not all Canadian legal sanctions obligations

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `canada-consolidated-autonomous-sanctions:reference.list.ingest` | `reference.list.intelligence.ca` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.361 Australia DFAT Consolidated List — `australia-dfat-consolidated-list`

Category: `official_lists`. Family: `australia-dfat-consolidated-list`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Australia / Global subjects. Proposed jurisdiction: `au` (publisher authority from local source identity; proposed).  
Source IDs: none. Notes: Official sanctions publisher

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `australia-dfat-consolidated-list:reference.list.ingest` | `reference.list.intelligence.au` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.362 Switzerland SECO Sanctions — `switzerland-seco-sanctions`

Category: `official_lists`. Family: `switzerland-seco-sanctions`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Switzerland / Global subjects. Proposed jurisdiction: `ch` (publisher authority from local source identity; proposed).  
Source IDs: none. Notes: Official sanctions publisher

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `switzerland-seco-sanctions:reference.list.ingest` | `reference.list.intelligence.ch` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.363 Japan MOF Sanctions — `japan-mof-sanctions`

Category: `official_lists`. Family: `japan-mof-sanctions`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Japan / Global subjects. Proposed jurisdiction: `jp` (publisher authority from local source identity; proposed).  
Source IDs: none. Notes: Official sanctions notices; machine format verify

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `japan-mof-sanctions:reference.list.ingest` | `reference.list.intelligence.jp` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.364 Singapore MAS targeted financial sanctions — `singapore-mas-targeted-financial-sanctions`

Category: `official_lists`. Family: `singapore-mas-targeted-financial-sanctions`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Singapore / Global subjects. Proposed jurisdiction: `sg` (publisher authority from local source identity; proposed).  
Source IDs: none. Notes: Official notices; not presumed single API

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `singapore-mas-targeted-financial-sanctions:reference.list.ingest` | `reference.list.intelligence.sg` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.365 World Bank Debarment — `world-bank-debarment`

Category: `official_lists`. Family: `world-bank-debarment`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Debarment is not identical to financial sanctions

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `world-bank-debarment:reference.list.ingest` | `reference.list.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.366 US SAM Exclusions — `us-sam-exclusions`

Category: `official_lists`. Family: `us-sam-exclusions`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): US. Proposed jurisdiction: `us` (publisher authority from local source identity; proposed).  
Source IDs: none. Notes: Government procurement exclusions; API access terms verify

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `us-sam-exclusions:reference.list.ingest` | `reference.list.intelligence.us` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.367 US BIS Consolidated Screening List — `us-bis-consolidated-screening-list`

Category: `official_lists`. Family: `us-bis-consolidated-screening-list`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): US / Global subjects. Proposed jurisdiction: `us` (publisher authority from local source identity; proposed).  
Source IDs: none. Notes: Trade/export controls; distinct from AML sanctions

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `us-bis-consolidated-screening-list:reference.list.ingest` | `reference.list.intelligence.us` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.368 FinCEN Section 314(a) — `fincen-section-314-a`

Category: `official_lists`. Family: `fincen-section-314-a`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): US. Proposed jurisdiction: `us` (publisher authority from local source identity; proposed).  
Source IDs: none. Notes: Confidential restricted bank information-sharing; no public catalog of subjects

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `fincen-section-314-a:reference.list.ingest` | `reference.list.intelligence.us` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.369 FATF high-risk and monitored jurisdictions — `fatf-high-risk-and-monitored-jurisdictions`

Category: `official_lists`. Family: `fatf-high-risk-and-monitored-jurisdictions`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Jurisdiction risk publications not name-screening list

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `fatf-high-risk-and-monitored-jurisdictions:risk.jurisdiction` | `risk.jurisdiction.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.370 Basel AML Index — `basel-aml-index`

Category: `official_lists`. Family: `basel-aml-index`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Country risk indicator; commercial terms verify

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `basel-aml-index:risk.jurisdiction` | `risk.jurisdiction.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.371 Swift KYC Registry — `swift-kyc-registry`

Category: `network`. Family: `swift-kyc-registry`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Financial institution KYC exchange; contracted access

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `swift-kyc-registry:questionnaire.collect` | `questionnaire.collection.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.372 SwiftRef — `swiftref`

Category: `network`. Family: `swiftref`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: BIC bank reference and identifier data

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `swiftref:reference.identifier.lookup` | `reference.identifier.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.373 Wolfsberg Group — `wolfsberg-group`

Category: `network`. Family: `wolfsberg-group`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: CBDDQ and FCCQ standards; not a KYC screening API

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `wolfsberg-group:questionnaire.collect` | `questionnaire.template.intelligence.unresolved` | `semantic_correction` | `proposed_contract_only` | — | Catalog describes CBDDQ/FCCQ standards; template availability does not collect completed responses. |

### A.374 GLEIF vLEI ecosystem — `gleif-vlei-ecosystem`

Category: `network`. Family: `gleif`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Credential trust ecosystem; GLEIF family not separate vendor

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `gleif-vlei-ecosystem:reference.identifier.lookup` | `credential.verification.intelligence.unresolved` | `semantic_correction` | `proposed_contract_only` | — | Credential trust ecosystem is not an ordinary identifier lookup; candidate contract only, no issuer/verifier API is established. |

### A.375 Open Ownership — `open-ownership`

Category: `network`. Family: `open-ownership`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Beneficial ownership standards and data; register availability verify

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `open-ownership:business.ownership.discover` | `business.ownership.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

### A.376 Open Supply Hub — `open-supply-hub`

Category: `network`. Family: `open-supply-hub`. Evidence: `candidate_unverified`. Original routing state: `disabled_unvalidated`.  
Market hint (unverified): Global. Proposed jurisdiction: `unresolved` (no capability-specific jurisdiction evidence).  
Source IDs: none. Notes: Facility identities; trade due diligence adjacent

| Original binding ID | Proposed canonical capability ID(s) | Migration | Original maturity | Fixture adapter | Mapping note |
| --- | --- | --- | --- | --- | --- |
| `open-supply-hub:reference.identifier.lookup` | `reference.identifier.intelligence.unresolved` | `vocabulary_mapping` | `proposed_contract_only` | — | Legacy semantic proposal retained; support must be established per binding. |

## Appendix B: every fixture adapter

**Authoritative source:** [adapter manifests](../tools/kyc-provider-atlas/adapters/manifests/) and [runtime.py](../tools/kyc-provider-atlas/adapters/runtime.py). All nine manifest `enabled` flags are false and country scopes empty. The proposed targets below do not imply v2 schemas have been implemented.

| Adapter ID | Provider ID | Declared legacy capability | Proposed target | Manifest native subset | Offline planner / host native connector | Limit |
| --- | --- | --- | --- | --- | --- | --- |
| `companies_house` | `companies-house` | `business.registry.lookup` | `business.registry.intelligence.gb` | `GET /company/{company_number}` | yes / yes | Single declared capability and representative inbound payload subset. |
| `gleif` | `gleif` | `reference.identifier.lookup` | `reference.identifier.intelligence.unresolved` | `GET /api/v1/lei-records/{lei}` | yes / yes | Single declared capability and representative inbound payload subset. LEI identity reference, not natural-person ownership. |
| `middesk` | `middesk` | `business.verify` | `business.verification.intelligence.unresolved` | `not declared` | no / no | Single declared capability and representative inbound payload subset. |
| `opencorporates` | `opencorporates` | `business.registry.lookup` | `business.registry.intelligence.unresolved` | `GET /v0.4/companies/{jurisdiction_code}/{company_number}` | yes / yes | Single declared capability and representative inbound payload subset. |
| `opensanctions` | `opensanctions` | `screening.sanctions` | `screening.sanctions.intelligence.unresolved` | `POST /match/{dataset}` | yes / yes | Single declared capability and representative inbound payload subset. Current sanctions-labeled fixture must stay dataset-scoped; generic vendor operations use screening.watchlist until categories are proven. |
| `persona` | `persona` | `identity.person.verify` | `identity.person.intelligence.unresolved` | `GET /api/v1/inquiries/{inquiry-id}` | yes / yes | Single declared capability and representative inbound payload subset. Reconcile its 2026-09-29 contract with vendor definition 2023-01-05. |
| `plaid` | `plaid` | `account.ownership.verify` | `account.ownership.intelligence.unresolved` | `POST /identity/match` | yes / yes | Single declared capability and representative inbound payload subset. |
| `sumsub` | `sumsub` | `identity.person.verify` | `identity.person.intelligence.unresolved` | `not declared` | no / no | Single declared capability and representative inbound payload subset. |
| `veriff` | `veriff` | `identity.person.verify` | `identity.person.intelligence.unresolved` | `not declared` | no / no | Single declared capability and representative inbound payload subset. |

## Appendix C: every documented vendor operation

**Authoritative source:** [vendor_connections/definitions](../api-wiring/vendor_connections/definitions/). There is one subsection per definition and one row per native operation: **42 definitions, 732 operations**. This is a semantic mapping proposal for every entry, including controls and adjacent features; it is not a claim that 732 field-level normalizers exist.

Each row shows the unchanged native ID, method/path, original semantics, proposed target, operation role and rationale. All rows remain `proposed_semantic_mapping`; definitions report `implemented_unverified` and `live_tested=false`. A `control`, `upload` or `submit` row cannot produce a completed check merely because its primary family is identity/document/account. `.unresolved` requires a scoped binding before execution. Concrete native issuer/publisher hints do not supply approval or entitlements. Generic check/template rows require explicit conditional dispatch and are blocked until configured.

The shared `platform.integration` family is intentionally operational. Its source operation ID/path and typed `operation_kind` distinguish authentication, consent, resource management, health and other controls; it is never a default identity contract. The currently unrecognized definition ID `entrust-onfido` is mapped through the proposed alias in section 5.3.

### C.01 `belvo` — 6 operations

Provider record: `belvo`. Native version: `documented-public`. Maturity: `implemented_unverified`. Live tested: `false`.  
Source: [definition JSON](../api-wiring/vendor_connections/definitions/belvo.json).

| Native operation ID | Method / path | Original semantics | Proposed canonical capability ID | Role | Mapping rationale / unresolved requirement |
| --- | --- | --- | --- | --- | --- |
| `belvo:owners` | `GET /api/owners/` | `account_data` | `account.profile.intelligence.unresolved` | `retrieve` | Permissioned financial/source data; no account-holder match or AML monitoring conclusion. |
| `belvo:accounts` | `GET /api/accounts/` | `account_data` | `account.profile.intelligence.unresolved` | `retrieve` | Permissioned financial/source data; no account-holder match or AML monitoring conclusion. |
| `belvo:transactions` | `GET /api/transactions/` | `account_data` | `financial.transactions.intelligence.unresolved` | `retrieve` | Permissioned financial/source data; no account-holder match or AML monitoring conclusion. |
| `belvo:bills` | `GET /api/bills/` | `account_data` | `financial.evidence.intelligence.unresolved` | `retrieve` | Permissioned financial/source data; no account-holder match or AML monitoring conclusion. |
| `belvo:investments` | `GET /api/investments/` | `account_data` | `financial.evidence.intelligence.unresolved` | `retrieve` | Permissioned financial/source data; no account-holder match or AML monitoring conclusion. |
| `belvo:investment_transactions` | `GET /api/investment-transactions/` | `account_data` | `financial.transactions.intelligence.unresolved` | `retrieve` | Permissioned financial/source data; no account-holder match or AML monitoring conclusion. |

### C.02 `br-nn-ysund-register-centre` — 2 operations

Provider record: `br-nn-ysund-register-centre`. Native version: `documented-public`. Maturity: `implemented_unverified`. Live tested: `false`.  
Source: [definition JSON](../api-wiring/vendor_connections/definitions/br-nn-ysund-register-centre.json).

| Native operation ID | Method / path | Original semantics | Proposed canonical capability ID | Role | Mapping rationale / unresolved requirement |
| --- | --- | --- | --- | --- | --- |
| `br-nn-ysund-register-centre:search_entities` | `GET /enhetsregisteret/api/enheter` | `business_data` | `business.registry.intelligence.no` | `lookup` | National-source scope; SEC operation returns issuer filings, not all private businesses. |
| `br-nn-ysund-register-centre:get_entity` | `GET /enhetsregisteret/api/enheter/{organisasjonsnummer}` | `business_data` | `business.registry.intelligence.no` | `lookup` | National-source scope; SEC operation returns issuer filings, not all private businesses. |

### C.03 `companies-house` — 34 operations

Provider record: `companies-house`. Native version: `1.0.0`. Maturity: `implemented_unverified`. Live tested: `false`.  
Source: [definition JSON](../api-wiring/vendor_connections/definitions/companies-house.json).

| Native operation ID | Method / path | Original semantics | Proposed canonical capability ID | Role | Mapping rationale / unresolved requirement |
| --- | --- | --- | --- | --- | --- |
| `companies-house:get_company_companynumber_registered_office_address` | `GET /company/{company_number}/registered-office-address` | `vendor_native` | `business.registry.intelligence.gb` | `lookup` | Registry facts/PSC disclosures; no independent beneficial-owner verification. |
| `companies-house:get_company_companynumber` | `GET /company/{company_number}` | `vendor_native` | `business.registry.intelligence.gb` | `lookup` | Registry facts/PSC disclosures; no independent beneficial-owner verification. |
| `companies-house:get_search` | `GET /search` | `vendor_native` | `business.registry.intelligence.gb` | `lookup` | Registry facts/PSC disclosures; no independent beneficial-owner verification. |
| `companies-house:get_search_companies` | `GET /search/companies` | `vendor_native` | `business.registry.intelligence.gb` | `lookup` | Registry facts/PSC disclosures; no independent beneficial-owner verification. |
| `companies-house:get_search_officers` | `GET /search/officers` | `vendor_native` | `business.officers.intelligence.gb` | `lookup` | Registry facts/PSC disclosures; no independent beneficial-owner verification. |
| `companies-house:get_search_disqualified_officers` | `GET /search/disqualified-officers` | `vendor_native` | `business.officers.intelligence.gb` | `lookup` | Registry facts/PSC disclosures; no independent beneficial-owner verification. |
| `companies-house:get_dissolved_search_companies` | `GET /dissolved-search/companies` | `vendor_native` | `business.registry.intelligence.gb` | `lookup` | Registry facts/PSC disclosures; no independent beneficial-owner verification. |
| `companies-house:get_alphabetical_search_companies` | `GET /alphabetical-search/companies` | `vendor_native` | `business.registry.intelligence.gb` | `lookup` | Registry facts/PSC disclosures; no independent beneficial-owner verification. |
| `companies-house:get_advanced_search_companies` | `GET /advanced-search/companies` | `vendor_native` | `business.registry.intelligence.gb` | `lookup` | Registry facts/PSC disclosures; no independent beneficial-owner verification. |
| `companies-house:get_company_company_number_officers` | `GET /company/{company_number}/officers` | `vendor_native` | `business.officers.intelligence.gb` | `lookup` | Registry facts/PSC disclosures; no independent beneficial-owner verification. |
| `companies-house:get_company_company_number_appointments_appointment_id` | `GET /company/{company_number}/appointments/{appointment_id}` | `vendor_native` | `business.officers.intelligence.gb` | `lookup` | Registry facts/PSC disclosures; no independent beneficial-owner verification. |
| `companies-house:get_company_company_number_registers` | `GET /company/{company_number}/registers` | `vendor_native` | `business.ownership.intelligence.gb` | `lookup` | Registry facts/PSC disclosures; no independent beneficial-owner verification. |
| `companies-house:get_company_company_number_filing_history_transaction_id` | `GET /company/{company_number}/filing-history/{transaction_id}` | `vendor_native` | `business.registry.intelligence.gb` | `lookup` | Registry facts/PSC disclosures; no independent beneficial-owner verification. |
| `companies-house:get_company_company_number_filing_history` | `GET /company/{company_number}/filing-history` | `vendor_native` | `business.registry.intelligence.gb` | `lookup` | Registry facts/PSC disclosures; no independent beneficial-owner verification. |
| `companies-house:get_company_company_number_exemptions` | `GET /company/{company_number}/exemptions` | `vendor_native` | `business.ownership.intelligence.gb` | `lookup` | Registry facts/PSC disclosures; no independent beneficial-owner verification. |
| `companies-house:get_disqualified_officers_natural_officer_id` | `GET /disqualified-officers/natural/{officer_id}` | `vendor_native` | `business.officers.intelligence.gb` | `lookup` | Registry facts/PSC disclosures; no independent beneficial-owner verification. |
| `companies-house:get_disqualified_officers_corporate_officer_id` | `GET /disqualified-officers/corporate/{officer_id}` | `vendor_native` | `business.officers.intelligence.gb` | `lookup` | Registry facts/PSC disclosures; no independent beneficial-owner verification. |
| `companies-house:get_officers_officer_id_appointments` | `GET /officers/{officer_id}/appointments` | `vendor_native` | `business.officers.intelligence.gb` | `lookup` | Registry facts/PSC disclosures; no independent beneficial-owner verification. |
| `companies-house:get_company_company_number_charges` | `GET /company/{company_number}/charges` | `vendor_native` | `business.registry.intelligence.gb` | `lookup` | Registry facts/PSC disclosures; no independent beneficial-owner verification. |
| `companies-house:get_company_company_number_charges_charge_id` | `GET /company/{company_number}/charges/{charge_id}` | `vendor_native` | `business.registry.intelligence.gb` | `lookup` | Registry facts/PSC disclosures; no independent beneficial-owner verification. |
| `companies-house:get_company_company_number_insolvency` | `GET /company/{company_number}/insolvency` | `vendor_native` | `business.registry.intelligence.gb` | `lookup` | Registry facts/PSC disclosures; no independent beneficial-owner verification. |
| `companies-house:get_company_company_number_uk_establishments` | `GET /company/{company_number}/uk-establishments` | `vendor_native` | `business.registry.intelligence.gb` | `lookup` | Registry facts/PSC disclosures; no independent beneficial-owner verification. |
| `companies-house:get_company_company_number_persons_with_significant_control` | `GET /company/{company_number}/persons-with-significant-control` | `vendor_native` | `business.ownership.intelligence.gb` | `lookup` | Registry facts/PSC disclosures; no independent beneficial-owner verification. |
| `companies-house:get_company_company_number_persons_with_significant_control_individual_notification_id` | `GET /company/{company_number}/persons-with-significant-control/individual/{notification_id}` | `vendor_native` | `business.ownership.intelligence.gb` | `lookup` | Registry facts/PSC disclosures; no independent beneficial-owner verification. |
| `companies-house:get_company_company_number_persons_with_significant_control_individual_beneficial_owner_notification_id` | `GET /company/{company_number}/persons-with-significant-control/individual-beneficial-owner/{notification_id}` | `vendor_native` | `business.ownership.intelligence.gb` | `lookup` | Registry facts/PSC disclosures; no independent beneficial-owner verification. |
| `companies-house:get_company_company_number_persons_with_significant_control_corporate_entity_notification_id` | `GET /company/{company_number}/persons-with-significant-control/corporate-entity/{notification_id}` | `vendor_native` | `business.ownership.intelligence.gb` | `lookup` | Registry facts/PSC disclosures; no independent beneficial-owner verification. |
| `companies-house:get_company_company_number_persons_with_significant_control_corporate_entity_beneficial_owner_notification_id` | `GET /company/{company_number}/persons-with-significant-control/corporate-entity-beneficial-owner/{notification_id}` | `vendor_native` | `business.ownership.intelligence.gb` | `lookup` | Registry facts/PSC disclosures; no independent beneficial-owner verification. |
| `companies-house:get_company_company_number_persons_with_significant_control_legal_person_notification_id` | `GET /company/{company_number}/persons-with-significant-control/legal-person/{notification_id}` | `vendor_native` | `business.ownership.intelligence.gb` | `lookup` | Registry facts/PSC disclosures; no independent beneficial-owner verification. |
| `companies-house:get_company_company_number_persons_with_significant_control_legal_person_beneficial_owner_notification_id` | `GET /company/{company_number}/persons-with-significant-control/legal-person-beneficial-owner/{notification_id}` | `vendor_native` | `business.ownership.intelligence.gb` | `lookup` | Registry facts/PSC disclosures; no independent beneficial-owner verification. |
| `companies-house:get_company_company_number_persons_with_significant_control_statements` | `GET /company/{company_number}/persons-with-significant-control-statements` | `vendor_native` | `business.ownership.intelligence.gb` | `lookup` | Registry facts/PSC disclosures; no independent beneficial-owner verification. |
| `companies-house:get_company_company_number_persons_with_significant_control_statements_statement_id` | `GET /company/{company_number}/persons-with-significant-control-statements/{statement_id}` | `vendor_native` | `business.ownership.intelligence.gb` | `lookup` | Registry facts/PSC disclosures; no independent beneficial-owner verification. |
| `companies-house:get_company_company_number_persons_with_significant_control_super_secure_super_secure_id` | `GET /company/{company_number}/persons-with-significant-control/super-secure/{super_secure_id}` | `vendor_native` | `business.ownership.intelligence.gb` | `lookup` | Registry facts/PSC disclosures; no independent beneficial-owner verification. |
| `companies-house:get_company_company_number_persons_with_significant_control_super_secure_beneficial_owner_super_secure_id` | `GET /company/{company_number}/persons-with-significant-control/super-secure-beneficial-owner/{super_secure_id}` | `vendor_native` | `business.ownership.intelligence.gb` | `lookup` | Registry facts/PSC disclosures; no independent beneficial-owner verification. |
| `companies-house:get_persons_with_significant_control_psc_id_notifications` | `GET /persons-with-significant-control/{psc_id}/notifications` | `vendor_native` | `business.ownership.intelligence.gb` | `lookup` | Registry facts/PSC disclosures; no independent beneficial-owner verification. |

### C.04 `complyadvantage` — 2 operations

Provider record: `complyadvantage`. Native version: `documented-public`. Maturity: `implemented_unverified`. Live tested: `false`.  
Source: [definition JSON](../api-wiring/vendor_connections/definitions/complyadvantage.json).

| Native operation ID | Method / path | Original semantics | Proposed canonical capability ID | Role | Mapping rationale / unresolved requirement |
| --- | --- | --- | --- | --- | --- |
| `complyadvantage:create_search` | `POST /searches` | `screening` | `screening.watchlist.intelligence.unresolved` | `screen` | Program/product/dataset determines categories; split atomic results only with mapped evidence. |
| `complyadvantage:get_search` | `GET /searches/{id}` | `screening` | `screening.watchlist.intelligence.unresolved` | `screen` | Program/product/dataset determines categories; split atomic results only with mapped evidence. |

### C.05 `complycube` — 5 operations

Provider record: `complycube`. Native version: `documented-public`. Maturity: `implemented_unverified`. Live tested: `false`.  
Source: [definition JSON](../api-wiring/vendor_connections/definitions/complycube.json).

| Native operation ID | Method / path | Original semantics | Proposed canonical capability ID | Role | Mapping rationale / unresolved requirement |
| --- | --- | --- | --- | --- | --- |
| `complycube:create_client` | `POST /clients` | `resource` | `platform.integration.intelligence.unresolved` | `control` | Create subject resource; not person verification. |
| `complycube:create_document` | `POST /documents` | `resource` | `document.evidence.intelligence.unresolved` | `upload` | Artifact/resource creation only. |
| `complycube:upload_front` | `POST /documents/{id}/upload/front` | `submission` | `document.evidence.intelligence.unresolved` | `upload` | Artifact/resource creation only. |
| `complycube:create_check` | `POST /checks` | `submission` | `identity.person.intelligence.unresolved` | `submit` | CONDITIONAL: check type must dispatch to identity document/person/biometric/address or screening contract; current definition does not pin it. |
| `complycube:get_check` | `GET /checks/{id}` | `check_result` | `identity.person.intelligence.unresolved` | `retrieve` | CONDITIONAL: check type must dispatch to identity document/person/biometric/address or screening contract; current definition does not pin it. |

### C.06 `dilisense` — 5 operations

Provider record: `dilisense`. Native version: `documented-public`. Maturity: `implemented_unverified`. Live tested: `false`.  
Source: [definition JSON](../api-wiring/vendor_connections/definitions/dilisense.json).

| Native operation ID | Method / path | Original semantics | Proposed canonical capability ID | Role | Mapping rationale / unresolved requirement |
| --- | --- | --- | --- | --- | --- |
| `dilisense:individual_media` | `GET /v1/media/checkIndividual` | `screening` | `screening.adverse_media.intelligence.unresolved` | `screen` | Media endpoints are adverse-media searches; dataset exports require explicit categories. |
| `dilisense:entity_media` | `GET /v1/media/checkEntity` | `screening` | `screening.adverse_media.intelligence.unresolved` | `screen` | Media endpoints are adverse-media searches; dataset exports require explicit categories. |
| `dilisense:search_media` | `GET /v1/media/search` | `screening` | `screening.adverse_media.intelligence.unresolved` | `screen` | Media endpoints are adverse-media searches; dataset exports require explicit categories. |
| `dilisense:consolidated_file` | `GET /v1/getConsolidatedFile` | `dataset` | `reference.list.intelligence.unresolved` | `ingest` | Media endpoints are adverse-media searches; dataset exports require explicit categories. |
| `dilisense:consolidated_delta` | `GET /v1/getConsolidatedDelta` | `dataset` | `reference.list.intelligence.unresolved` | `ingest` | Media endpoints are adverse-media searches; dataset exports require explicit categories. |

### C.07 `dojah` — 3 operations

Provider record: `dojah`. Native version: `documented-public`. Maturity: `implemented_unverified`. Live tested: `false`.  
Source: [definition JSON](../api-wiring/vendor_connections/definitions/dojah.json).

| Native operation ID | Method / path | Original semantics | Proposed canonical capability ID | Role | Mapping rationale / unresolved requirement |
| --- | --- | --- | --- | --- | --- |
| `dojah:lookup_nin` | `GET /api/v1/kyc/nin` | `identity_data` | `identity.profile.intelligence.ng` | `retrieve` | NIN source fields; add identity.person only when input-to-source comparison is evidenced. |
| `dojah:nuban_status` | `GET /api/v1/kyc/nuban/status` | `account_data` | `account.profile.intelligence.ng` | `retrieve` | NUBAN account/status data does not prove holder match. |
| `dojah:address_result` | `GET /api/v1/kyc/address` | `address_data` | `identity.address.intelligence.unresolved` | `retrieve` | Address-result retrieval; require verification method before a verified outcome. |

### C.08 `entrust-onfido` — 85 operations

Provider record: `entrust-identity-verification` (proposed reviewed alias required). Native version: `v3.6`. Maturity: `implemented_unverified`. Live tested: `false`.  
Source: [definition JSON](../api-wiring/vendor_connections/definitions/entrust-onfido.json).

| Native operation ID | Method / path | Original semantics | Proposed canonical capability ID | Role | Mapping rationale / unresolved requirement |
| --- | --- | --- | --- | --- | --- |
| `entrust-onfido:create_applicant` | `POST /applicants` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Applicant/workflow/task, consent, authentication token/passkey, webhook, address picker or health operation; select operation_kind and enables[] explicitly. |
| `entrust-onfido:list_applicants` | `GET /applicants` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Applicant/workflow/task, consent, authentication token/passkey, webhook, address picker or health operation; select operation_kind and enables[] explicitly. |
| `entrust-onfido:find_applicant` | `GET /applicants/{applicant_id}` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Applicant/workflow/task, consent, authentication token/passkey, webhook, address picker or health operation; select operation_kind and enables[] explicitly. |
| `entrust-onfido:update_applicant` | `PUT /applicants/{applicant_id}` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Applicant/workflow/task, consent, authentication token/passkey, webhook, address picker or health operation; select operation_kind and enables[] explicitly. |
| `entrust-onfido:delete_applicant` | `DELETE /applicants/{applicant_id}` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Applicant/workflow/task, consent, authentication token/passkey, webhook, address picker or health operation; select operation_kind and enables[] explicitly. |
| `entrust-onfido:restore_applicant` | `POST /applicants/{applicant_id}/restore` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Applicant/workflow/task, consent, authentication token/passkey, webhook, address picker or health operation; select operation_kind and enables[] explicitly. |
| `entrust-onfido:find_applicant_consents` | `GET /applicants/{applicant_id}/consents` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Applicant/workflow/task, consent, authentication token/passkey, webhook, address picker or health operation; select operation_kind and enables[] explicitly. |
| `entrust-onfido:create_workflow_run` | `POST /workflow_runs` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Applicant/workflow/task, consent, authentication token/passkey, webhook, address picker or health operation; select operation_kind and enables[] explicitly. |
| `entrust-onfido:list_workflow_runs` | `GET /workflow_runs` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Applicant/workflow/task, consent, authentication token/passkey, webhook, address picker or health operation; select operation_kind and enables[] explicitly. |
| `entrust-onfido:find_workflow_run` | `GET /workflow_runs/{workflow_run_id}` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Applicant/workflow/task, consent, authentication token/passkey, webhook, address picker or health operation; select operation_kind and enables[] explicitly. |
| `entrust-onfido:download_signed_evidence_file` | `GET /workflow_runs/{workflow_run_id}/signed_evidence_file` | `vendor_native` | `document.evidence.intelligence.unresolved` | `retrieve` | Evidence/media lifecycle; no verification outcome from artifact availability. |
| `entrust-onfido:download_evidence_folder` | `GET /workflow_runs/{workflow_run_id}/evidence_folder` | `vendor_native` | `document.evidence.intelligence.unresolved` | `retrieve` | Evidence/media lifecycle; no verification outcome from artifact availability. |
| `entrust-onfido:list_documents` | `GET /documents` | `vendor_native` | `document.evidence.intelligence.unresolved` | `retrieve` | Evidence/media lifecycle; no verification outcome from artifact availability. |
| `entrust-onfido:upload_document` | `POST /documents` | `vendor_native` | `document.evidence.intelligence.unresolved` | `upload` | Evidence/media lifecycle; no verification outcome from artifact availability. |
| `entrust-onfido:find_document` | `GET /documents/{document_id}` | `vendor_native` | `document.evidence.intelligence.unresolved` | `retrieve` | Evidence/media lifecycle; no verification outcome from artifact availability. |
| `entrust-onfido:download_document` | `GET /documents/{document_id}/download` | `vendor_native` | `document.evidence.intelligence.unresolved` | `retrieve` | Evidence/media lifecycle; no verification outcome from artifact availability. |
| `entrust-onfido:download_nfc_face` | `GET /documents/{document_id}/nfc_face` | `vendor_native` | `document.evidence.intelligence.unresolved` | `retrieve` | Evidence/media lifecycle; no verification outcome from artifact availability. |
| `entrust-onfido:download_document_video` | `GET /documents/{document_id}/video/download` | `vendor_native` | `document.evidence.intelligence.unresolved` | `retrieve` | Evidence/media lifecycle; no verification outcome from artifact availability. |
| `entrust-onfido:list_signing_documents` | `GET /signing_documents` | `vendor_native` | `document.signature.intelligence.unresolved` | `retrieve` | Signature artifact/lifecycle; no separate identity assurance inferred. |
| `entrust-onfido:upload_signing_document` | `POST /signing_documents` | `vendor_native` | `document.signature.intelligence.unresolved` | `upload` | Signature artifact/lifecycle; no separate identity assurance inferred. |
| `entrust-onfido:find_signing_document` | `GET /signing_documents/{signing_document_id}` | `vendor_native` | `document.signature.intelligence.unresolved` | `retrieve` | Signature artifact/lifecycle; no separate identity assurance inferred. |
| `entrust-onfido:download_signing_document` | `GET /signing_documents/{signing_document_id}/download` | `vendor_native` | `document.signature.intelligence.unresolved` | `retrieve` | Signature artifact/lifecycle; no separate identity assurance inferred. |
| `entrust-onfido:list_live_photos` | `GET /live_photos` | `vendor_native` | `document.evidence.intelligence.unresolved` | `retrieve` | Evidence/media lifecycle; no verification outcome from artifact availability. |
| `entrust-onfido:upload_live_photo` | `POST /live_photos` | `vendor_native` | `document.evidence.intelligence.unresolved` | `upload` | Evidence/media lifecycle; no verification outcome from artifact availability. |
| `entrust-onfido:find_live_photo` | `GET /live_photos/{live_photo_id}` | `vendor_native` | `document.evidence.intelligence.unresolved` | `retrieve` | Evidence/media lifecycle; no verification outcome from artifact availability. |
| `entrust-onfido:download_live_photo` | `GET /live_photos/{live_photo_id}/download` | `vendor_native` | `document.evidence.intelligence.unresolved` | `retrieve` | Evidence/media lifecycle; no verification outcome from artifact availability. |
| `entrust-onfido:list_live_videos` | `GET /live_videos` | `vendor_native` | `document.evidence.intelligence.unresolved` | `retrieve` | Evidence/media lifecycle; no verification outcome from artifact availability. |
| `entrust-onfido:find_live_video` | `GET /live_videos/{live_video_id}` | `vendor_native` | `document.evidence.intelligence.unresolved` | `retrieve` | Evidence/media lifecycle; no verification outcome from artifact availability. |
| `entrust-onfido:download_live_video` | `GET /live_videos/{live_video_id}/download` | `vendor_native` | `document.evidence.intelligence.unresolved` | `retrieve` | Evidence/media lifecycle; no verification outcome from artifact availability. |
| `entrust-onfido:download_live_video_frame` | `GET /live_videos/{live_video_id}/frame` | `vendor_native` | `document.evidence.intelligence.unresolved` | `retrieve` | Evidence/media lifecycle; no verification outcome from artifact availability. |
| `entrust-onfido:list_tasks` | `GET /workflow_runs/{workflow_run_id}/tasks` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Applicant/workflow/task, consent, authentication token/passkey, webhook, address picker or health operation; select operation_kind and enables[] explicitly. |
| `entrust-onfido:find_task` | `GET /workflow_runs/{workflow_run_id}/tasks/{task_id}` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Applicant/workflow/task, consent, authentication token/passkey, webhook, address picker or health operation; select operation_kind and enables[] explicitly. |
| `entrust-onfido:complete_task` | `POST /workflow_runs/{workflow_run_id}/tasks/{task_id}/complete` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Applicant/workflow/task, consent, authentication token/passkey, webhook, address picker or health operation; select operation_kind and enables[] explicitly. |
| `entrust-onfido:list_motion_captures` | `GET /motion_captures` | `vendor_native` | `document.evidence.intelligence.unresolved` | `retrieve` | Evidence/media lifecycle; no verification outcome from artifact availability. |
| `entrust-onfido:find_motion_capture` | `GET /motion_captures/{motion_capture_id}` | `vendor_native` | `document.evidence.intelligence.unresolved` | `retrieve` | Evidence/media lifecycle; no verification outcome from artifact availability. |
| `entrust-onfido:download_motion_capture` | `GET /motion_captures/{motion_capture_id}/download` | `vendor_native` | `document.evidence.intelligence.unresolved` | `retrieve` | Evidence/media lifecycle; no verification outcome from artifact availability. |
| `entrust-onfido:download_motion_capture_frame` | `GET /motion_captures/{motion_capture_id}/frame` | `vendor_native` | `document.evidence.intelligence.unresolved` | `retrieve` | Evidence/media lifecycle; no verification outcome from artifact availability. |
| `entrust-onfido:list_biometric_tokens` | `GET /biometric_tokens/{user_id}` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Applicant/workflow/task, consent, authentication token/passkey, webhook, address picker or health operation; select operation_kind and enables[] explicitly. |
| `entrust-onfido:invalidate_biometric_tokens` | `DELETE /biometric_tokens/{user_id}` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Applicant/workflow/task, consent, authentication token/passkey, webhook, address picker or health operation; select operation_kind and enables[] explicitly. |
| `entrust-onfido:find_biometric_token` | `GET /biometric_tokens/{user_id}/{token_uuid}` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Applicant/workflow/task, consent, authentication token/passkey, webhook, address picker or health operation; select operation_kind and enables[] explicitly. |
| `entrust-onfido:update_biometric_token` | `PUT /biometric_tokens/{user_id}/{token_uuid}` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Applicant/workflow/task, consent, authentication token/passkey, webhook, address picker or health operation; select operation_kind and enables[] explicitly. |
| `entrust-onfido:invalidate_biometric_token` | `DELETE /biometric_tokens/{user_id}/{token_uuid}` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Applicant/workflow/task, consent, authentication token/passkey, webhook, address picker or health operation; select operation_kind and enables[] explicitly. |
| `entrust-onfido:create_watchlist_monitor` | `POST /watchlist_monitors` | `vendor_native` | `monitoring.subscription.intelligence.unresolved` | `control` | Subscription/review/report trigger; not a new atomic screening result. |
| `entrust-onfido:list_watchlist_monitors` | `GET /watchlist_monitors` | `vendor_native` | `screening.watchlist.intelligence.unresolved` | `retrieve` | Composite watchlist program and category coverage must be pinned. |
| `entrust-onfido:find_watchlist_monitor` | `GET /watchlist_monitors/{monitor_id}` | `vendor_native` | `screening.watchlist.intelligence.unresolved` | `retrieve` | Composite watchlist program and category coverage must be pinned. |
| `entrust-onfido:delete_watchlist_monitor` | `DELETE /watchlist_monitors/{monitor_id}` | `vendor_native` | `monitoring.subscription.intelligence.unresolved` | `control` | Subscription/review/report trigger; not a new atomic screening result. |
| `entrust-onfido:list_watchlist_monitor_matches` | `GET /watchlist_monitors/{monitor_id}/matches` | `vendor_native` | `screening.watchlist.intelligence.unresolved` | `retrieve` | Composite watchlist program and category coverage must be pinned. |
| `entrust-onfido:update_watchlist_monitor_match` | `PATCH /watchlist_monitors/{monitor_id}/matches` | `vendor_native` | `monitoring.subscription.intelligence.unresolved` | `control` | Subscription/review/report trigger; not a new atomic screening result. |
| `entrust-onfido:force_report_creation_from_watchlist_monitor` | `POST /watchlist_monitors/{monitor_id}/new_report` | `vendor_native` | `monitoring.subscription.intelligence.unresolved` | `control` | Subscription/review/report trigger; not a new atomic screening result. |
| `entrust-onfido:list_watchlist_mesh_alert_risks` | `GET /complyadvantage_watchlists/alerts/{alert_id}/risks` | `vendor_native` | `screening.watchlist.intelligence.unresolved` | `retrieve` | Composite watchlist program and category coverage must be pinned. |
| `entrust-onfido:list_id_photos` | `GET /id_photos` | `vendor_native` | `document.evidence.intelligence.unresolved` | `retrieve` | Evidence/media lifecycle; no verification outcome from artifact availability. |
| `entrust-onfido:upload_id_photo` | `POST /id_photos` | `vendor_native` | `document.evidence.intelligence.unresolved` | `upload` | Evidence/media lifecycle; no verification outcome from artifact availability. |
| `entrust-onfido:find_id_photo` | `GET /id_photos/{id_photo_id}` | `vendor_native` | `document.evidence.intelligence.unresolved` | `retrieve` | Evidence/media lifecycle; no verification outcome from artifact availability. |
| `entrust-onfido:download_id_photo` | `GET /id_photos/{id_photo_id}/download` | `vendor_native` | `document.evidence.intelligence.unresolved` | `retrieve` | Evidence/media lifecycle; no verification outcome from artifact availability. |
| `entrust-onfido:download_qes_document` | `GET /qualified_electronic_signature/documents` | `vendor_native` | `document.signature.intelligence.unresolved` | `retrieve` | Signature artifact/lifecycle; no separate identity assurance inferred. |
| `entrust-onfido:download_aes_document` | `GET /advanced_electronic_signature/documents` | `vendor_native` | `document.signature.intelligence.unresolved` | `retrieve` | Signature artifact/lifecycle; no separate identity assurance inferred. |
| `entrust-onfido:download_ses_document` | `GET /simple_electronic_signature/documents` | `vendor_native` | `document.signature.intelligence.unresolved` | `retrieve` | Signature artifact/lifecycle; no separate identity assurance inferred. |
| `entrust-onfido:create_timeline_file` | `POST /workflow_runs/{workflow_run_id}/timeline_file` | `vendor_native` | `document.evidence.intelligence.unresolved` | `upload` | Evidence/media lifecycle; no verification outcome from artifact availability. |
| `entrust-onfido:find_timeline_file` | `GET /workflow_runs/{workflow_run_id}/timeline_file/{timeline_file_id}` | `vendor_native` | `document.evidence.intelligence.unresolved` | `retrieve` | Evidence/media lifecycle; no verification outcome from artifact availability. |
| `entrust-onfido:list_passkeys` | `GET /passkeys/{username}` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Applicant/workflow/task, consent, authentication token/passkey, webhook, address picker or health operation; select operation_kind and enables[] explicitly. |
| `entrust-onfido:delete_passkeys` | `DELETE /passkeys/{username}` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Applicant/workflow/task, consent, authentication token/passkey, webhook, address picker or health operation; select operation_kind and enables[] explicitly. |
| `entrust-onfido:find_passkey` | `GET /passkeys/{username}/{passkey_id}` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Applicant/workflow/task, consent, authentication token/passkey, webhook, address picker or health operation; select operation_kind and enables[] explicitly. |
| `entrust-onfido:update_passkey` | `PUT /passkeys/{username}/{passkey_id}` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Applicant/workflow/task, consent, authentication token/passkey, webhook, address picker or health operation; select operation_kind and enables[] explicitly. |
| `entrust-onfido:delete_passkey` | `DELETE /passkeys/{username}/{passkey_id}` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Applicant/workflow/task, consent, authentication token/passkey, webhook, address picker or health operation; select operation_kind and enables[] explicitly. |
| `entrust-onfido:ping` | `GET /ping` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Applicant/workflow/task, consent, authentication token/passkey, webhook, address picker or health operation; select operation_kind and enables[] explicitly. |
| `entrust-onfido:list_webhooks` | `GET /webhooks` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Applicant/workflow/task, consent, authentication token/passkey, webhook, address picker or health operation; select operation_kind and enables[] explicitly. |
| `entrust-onfido:create_webhook` | `POST /webhooks` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Applicant/workflow/task, consent, authentication token/passkey, webhook, address picker or health operation; select operation_kind and enables[] explicitly. |
| `entrust-onfido:find_webhook` | `GET /webhooks/{webhook_id}` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Applicant/workflow/task, consent, authentication token/passkey, webhook, address picker or health operation; select operation_kind and enables[] explicitly. |
| `entrust-onfido:update_webhook` | `PUT /webhooks/{webhook_id}` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Applicant/workflow/task, consent, authentication token/passkey, webhook, address picker or health operation; select operation_kind and enables[] explicitly. |
| `entrust-onfido:delete_webhook` | `DELETE /webhooks/{webhook_id}` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Applicant/workflow/task, consent, authentication token/passkey, webhook, address picker or health operation; select operation_kind and enables[] explicitly. |
| `entrust-onfido:resend_webhooks` | `POST /webhooks/resend` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Applicant/workflow/task, consent, authentication token/passkey, webhook, address picker or health operation; select operation_kind and enables[] explicitly. |
| `entrust-onfido:find_addresses` | `GET /addresses/pick` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Applicant/workflow/task, consent, authentication token/passkey, webhook, address picker or health operation; select operation_kind and enables[] explicitly. |
| `entrust-onfido:generate_sdk_token` | `POST /sdk_token` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Applicant/workflow/task, consent, authentication token/passkey, webhook, address picker or health operation; select operation_kind and enables[] explicitly. |
| `entrust-onfido:list_repeat_attempts` | `GET /repeat_attempts/{report_id}` | `vendor_native` | `risk.customer.intelligence.unresolved` | `retrieve` | Repeat-attempt signals/feedback, not person verification. |
| `entrust-onfido:extract` | `POST /extractions` | `vendor_native` | `identity.document.extraction.intelligence.unresolved` | `extract` | Autofill extraction is not document authenticity verification. |
| `entrust-onfido:post_results_feedback` | `POST /results_feedback` | `vendor_native` | `risk.customer.intelligence.unresolved` | `control` | Repeat-attempt signals/feedback, not person verification. |
| `entrust-onfido:list_checks` | `GET /checks` | `identity_result` | `identity.person.intelligence.unresolved` | `retrieve` | CONDITIONAL: report names select document/biometric/address/watchlist child contracts; generic check is a workflow aggregate. |
| `entrust-onfido:create_check` | `POST /checks` | `identity_result` | `identity.person.intelligence.unresolved` | `submit` | CONDITIONAL: report names select document/biometric/address/watchlist child contracts; generic check is a workflow aggregate. |
| `entrust-onfido:find_check` | `GET /checks/{check_id}` | `identity_result` | `identity.person.intelligence.unresolved` | `retrieve` | CONDITIONAL: report names select document/biometric/address/watchlist child contracts; generic check is a workflow aggregate. |
| `entrust-onfido:resume_check` | `POST /checks/{check_id}/resume` | `identity_result` | `identity.person.intelligence.unresolved` | `control` | CONDITIONAL: report names select document/biometric/address/watchlist child contracts; generic check is a workflow aggregate. |
| `entrust-onfido:download_check` | `GET /checks/{check_id}/download` | `identity_result` | `identity.person.intelligence.unresolved` | `retrieve` | CONDITIONAL: report names select document/biometric/address/watchlist child contracts; generic check is a workflow aggregate. |
| `entrust-onfido:list_reports` | `GET /reports` | `identity_result` | `identity.person.intelligence.unresolved` | `retrieve` | CONDITIONAL: report names select document/biometric/address/watchlist child contracts; generic check is a workflow aggregate. |
| `entrust-onfido:find_report` | `GET /reports/{report_id}` | `identity_result` | `identity.person.intelligence.unresolved` | `retrieve` | CONDITIONAL: report names select document/biometric/address/watchlist child contracts; generic check is a workflow aggregate. |
| `entrust-onfido:resume_report` | `POST /reports/{report_id}/resume` | `identity_result` | `identity.person.intelligence.unresolved` | `control` | CONDITIONAL: report names select document/biometric/address/watchlist child contracts; generic check is a workflow aggregate. |
| `entrust-onfido:cancel_report` | `POST /reports/{report_id}/cancel` | `identity_result` | `identity.person.intelligence.unresolved` | `control` | CONDITIONAL: report names select document/biometric/address/watchlist child contracts; generic check is a workflow aggregate. |

### C.09 `fingerprint` — 6 operations

Provider record: `fingerprint`. Native version: `4`. Maturity: `implemented_unverified`. Live tested: `false`.  
Source: [definition JSON](../api-wiring/vendor_connections/definitions/fingerprint.json).

| Native operation ID | Method / path | Original semantics | Proposed canonical capability ID | Role | Mapping rationale / unresolved requirement |
| --- | --- | --- | --- | --- | --- |
| `fingerprint:analyzeRequestForAutomationIntelligence` | `POST /edge` | `vendor_native` | `risk.device.intelligence.unresolved` | `assess` | Device/automation signals, not person identity verification. |
| `fingerprint:getEvent` | `GET /events/{event_id}` | `vendor_native` | `risk.device.intelligence.unresolved` | `retrieve` | Device/automation signals, not person identity verification. |
| `fingerprint:updateEvent` | `PATCH /events/{event_id}` | `vendor_native` | `risk.device.intelligence.unresolved` | `control` | Feedback/deletion changes a device resource; produces no new verified finding. |
| `fingerprint:submitEventFeedback` | `POST /events/{event_id}/feedback` | `vendor_native` | `risk.device.intelligence.unresolved` | `control` | Feedback/deletion changes a device resource; produces no new verified finding. |
| `fingerprint:searchEvents` | `GET /events` | `vendor_native` | `risk.device.intelligence.unresolved` | `retrieve` | Device/automation signals, not person identity verification. |
| `fingerprint:deleteVisitorData` | `DELETE /visitors/{visitor_id}` | `vendor_native` | `risk.device.intelligence.unresolved` | `control` | Feedback/deletion changes a device resource; produces no new verified finding. |

### C.10 `fintoc` — 2 operations

Provider record: `fintoc`. Native version: `v1`. Maturity: `implemented_unverified`. Live tested: `false`.  
Source: [definition JSON](../api-wiring/vendor_connections/definitions/fintoc.json).

| Native operation ID | Method / path | Original semantics | Proposed canonical capability ID | Role | Mapping rationale / unresolved requirement |
| --- | --- | --- | --- | --- | --- |
| `fintoc:accounts` | `GET /v1/accounts` | `account_data` | `account.profile.intelligence.unresolved` | `retrieve` | Permissioned financial/source data; no account-holder match or AML monitoring conclusion. |
| `fintoc:movements` | `GET /v1/accounts/{account_id}/movements` | `transaction_data` | `financial.transactions.intelligence.unresolved` | `retrieve` | Permissioned financial/source data; no account-holder match or AML monitoring conclusion. |

### C.11 `flagright` — 3 operations

Provider record: `flagright`. Native version: `documented-public`. Maturity: `implemented_unverified`. Live tested: `false`.  
Source: [definition JSON](../api-wiring/vendor_connections/definitions/flagright.json).

| Native operation ID | Method / path | Original semantics | Proposed canonical capability ID | Role | Mapping rationale / unresolved requirement |
| --- | --- | --- | --- | --- | --- |
| `flagright:create_business_user` | `POST /business/users` | `submission` | `platform.integration.intelligence.unresolved` | `control` | Entity submission/event receipt; monitoring/customer-risk outcome is not established by this operation. |
| `flagright:get_transaction_event` | `GET /events/transaction/{eventId}` | `resource` | `platform.integration.intelligence.unresolved` | `control` | Entity submission/event receipt; monitoring/customer-risk outcome is not established by this operation. |
| `flagright:get_business_user_event` | `GET /events/business/user/{eventId}` | `resource` | `platform.integration.intelligence.unresolved` | `control` | Entity submission/event receipt; monitoring/customer-risk outcome is not established by this operation. |

### C.12 `flinks` — 34 operations

Provider record: `flinks`. Native version: `3.0.0`. Maturity: `implemented_unverified`. Live tested: `false`.  
Source: [definition JSON](../api-wiring/vendor_connections/definitions/flinks.json). Definition notes: Set the customer-specific instance BASE_URL and approved HTTPS base. Optional x-api-key security is supported when enabled by Flinks. Session credentials and customerId remain native documented parameters.

| Native operation ID | Method / path | Original semantics | Proposed canonical capability ID | Role | Mapping rationale / unresolved requirement |
| --- | --- | --- | --- | --- | --- |
| `flinks:getPartnerData` | `GET /v3/{customerId}/partnerdata/{LoginId}/{AccountId}` | `vendor_native` | `financial.evidence.intelligence.unresolved` | `retrieve` | Account/financial detail bundle; split account profile, balance and transactions only when fields are mapped. |
| `flinks:generateAuthSecret` | `GET /v3/{customerId}/partnerdata/authsecret/{nameofpartner}` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Authorization/MFA/partner permissions/refresh scheduling/status or prepayment control; not a customer check result. |
| `flinks:disableAuthSecret` | `GET /v3/{customerId}/partnerdata/authsecret/disable/{permissionId}` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Authorization/MFA/partner permissions/refresh scheduling/status or prepayment control; not a customer check result. |
| `flinks:enableAuthSecret` | `GET /v3/{customerId}/partnerdata/authsecret/enable/{permissionId}` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Authorization/MFA/partner permissions/refresh scheduling/status or prepayment control; not a customer check result. |
| `flinks:partnerAccess` | `GET /partneraccess/{accesstoken}` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Authorization/MFA/partner permissions/refresh scheduling/status or prepayment control; not a customer check result. |
| `flinks:oauthAuthorize` | `GET /v3/oauth/authorize` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Authorization/MFA/partner permissions/refresh scheduling/status or prepayment control; not a customer check result. |
| `flinks:answerMFAQuestions` | `PATCH /v3/{customerId}/BankingServices/AnswerMFAQuestions` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Authorization/MFA/partner permissions/refresh scheduling/status or prepayment control; not a customer check result. |
| `flinks:getAccountsSummary` | `POST /v3/{customerId}/BankingServices/GetAccountsSummary` | `vendor_native` | `financial.evidence.intelligence.unresolved` | `retrieve` | Account/financial detail bundle; split account profile, balance and transactions only when fields are mapped. |
| `flinks:getAccountsDetail` | `POST /v3/{customerId}/BankingServices/GetAccountsDetail` | `vendor_native` | `financial.evidence.intelligence.unresolved` | `retrieve` | Account/financial detail bundle; split account profile, balance and transactions only when fields are mapped. |
| `flinks:getStatements` | `POST /v3/{customerId}/BankingServices/GetStatements` | `vendor_native` | `financial.evidence.intelligence.unresolved` | `retrieve` | Bank statement evidence. |
| `flinks:getInstitutions` | `GET /v3/{customerId}/BankingServices/Institutions` | `vendor_native` | `financial.institution.intelligence.unresolved` | `lookup` | Institution/routing reference metadata. |
| `flinks:deleteCard` | `DELETE /v3/{customerId}/BankingServices/DeleteCard/{loginId}` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Authorization/MFA/partner permissions/refresh scheduling/status or prepayment control; not a customer check result. |
| `flinks:attributes` | `POST /v3/{customerId}/insight/login/{loginId}/attributes/{requestId}` | `vendor_native` | `financial.analytics.intelligence.unresolved` | `submit` | Financial features; retain feature library/methodology version. |
| `flinks:categories` | `GET /v3/{customerId}/BankingServices/Categories/{CountryCode}` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Feature/category library metadata; not customer-specific evidence. |
| `flinks:consumerLibrary` | `GET /v3/{customerId}/attributes/library` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Feature/category library metadata; not customer-specific evidence. |
| `flinks:businessLibrary` | `GET /v3/{customerId}/attributes/library/business` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Feature/category library metadata; not customer-specific evidence. |
| `flinks:generateAuthorizeToken` | `POST /v3/{customerId}/BankingServices/GenerateAuthorizeToken` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Authorization/MFA/partner permissions/refresh scheduling/status or prepayment control; not a customer check result. |
| `flinks:post_v3_customerid_bankingservices_authorize` | `POST /v3/{customerId}/BankingServices/Authorize` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Authorization/MFA/partner permissions/refresh scheduling/status or prepayment control; not a customer check result. |
| `flinks:getUserAnalysisAttributes` | `GET /v3/{customerId}/insight/login/{loginId}/attributes/{requestId}/GetUserAnalysisAttributes` | `vendor_native` | `financial.analytics.intelligence.unresolved` | `retrieve` | Financial features; retain feature library/methodology version. |
| `flinks:getAllAttributes` | `GET /v3/{customerId}/insight/login/{loginId}/attributes/{requestId}/GetAllAttributes` | `vendor_native` | `financial.analytics.intelligence.unresolved` | `retrieve` | Financial features; retain feature library/methodology version. |
| `flinks:getAllBusinessAttributes` | `GET /v3/{customerId}/insight/login/{loginId}/attributes/{requestId}/GetAllBusinessAttributes` | `vendor_native` | `financial.analytics.intelligence.unresolved` | `retrieve` | Financial features; retain feature library/methodology version. |
| `flinks:getBusinessAnalysisAttributes` | `GET /v3/{customerId}/insight/login/{loginId}/attributes/{requestId}/GetBusinessAnalysisAttributes` | `vendor_native` | `financial.analytics.intelligence.unresolved` | `retrieve` | Financial features; retain feature library/methodology version. |
| `flinks:prepayment` | `POST /v3/{customerId}/prepayment/login/{LoginId}/{RequestId}` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Authorization/MFA/partner permissions/refresh scheduling/status or prepayment control; not a customer check result. |
| `flinks:getCategorization` | `GET /v3/{customerId}/categorization/login/{loginId}/requestid/{requestId}` | `vendor_native` | `financial.transactions.intelligence.unresolved` | `retrieve` | Transaction categories, not transaction monitoring. |
| `flinks:getCreditRiskAttributes` | `GET /v3/{customerId}/insight/login/{loginId}/attributes/{requestId}/GetCreditRiskAttributes` | `vendor_native` | `financial.analytics.intelligence.unresolved` | `retrieve` | Financial features; retain feature library/methodology version. |
| `flinks:getIncomeAttributes` | `GET /v3/{customerId}/insight/login/{loginId}/attributes/{requestId}/GetIncomeAttributes` | `vendor_native` | `financial.income.intelligence.unresolved` | `retrieve` | Income-derived attributes; evidence versus estimate must be distinguished. |
| `flinks:getLendingAttributes` | `GET /v3/{customerId}/insight/login/{loginId}/attributes/{requestId}/GetLendingAttributes` | `vendor_native` | `financial.analytics.intelligence.unresolved` | `retrieve` | Financial features; retain feature library/methodology version. |
| `flinks:getAccountsSummaryAsync` | `GET /v3/{customerId}/BankingServices/GetAccountsSummaryAsync/{requestId}` | `vendor_native` | `financial.evidence.intelligence.unresolved` | `retrieve` | Account/financial detail bundle; split account profile, balance and transactions only when fields are mapped. |
| `flinks:getAccountsDetailAsync` | `GET /v3/{customerId}/BankingServices/GetAccountsDetailAsync/{requestId}` | `vendor_native` | `financial.evidence.intelligence.unresolved` | `retrieve` | Account/financial detail bundle; split account profile, balance and transactions only when fields are mapped. |
| `flinks:getMfaQuestions` | `GET /v3/{customerId}/BankingServices/GetMFAQuestions/{loginId}` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Authorization/MFA/partner permissions/refresh scheduling/status or prepayment control; not a customer check result. |
| `flinks:getNightlyRefreshStatus` | `GET /v3/{customerId}/BankingServices/GetNightlyRefreshStatus` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Authorization/MFA/partner permissions/refresh scheduling/status or prepayment control; not a customer check result. |
| `flinks:getInstitutionByRoutingNumber` | `GET /v3/{customerId}/BankingServices/Institutions/RoutingNumber/{routingNumber}` | `vendor_native` | `financial.institution.intelligence.unresolved` | `lookup` | Institution/routing reference metadata. |
| `flinks:setScheduledRefresh` | `PATCH /v3/{customerId}/BankingServices/SetScheduledRefresh` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Authorization/MFA/partner permissions/refresh scheduling/status or prepayment control; not a customer check result. |
| `flinks:fieldMatch` | `POST /v3/{customerId}/BankingServices/FieldMatch` | `vendor_native` | `account.ownership.intelligence.unresolved` | `verify` | Field comparison; pin compared fields/reference subject and native match semantics. |

### C.13 `gleif` — 2 operations

Provider record: `gleif`. Native version: `v1`. Maturity: `implemented_unverified`. Live tested: `false`.  
Source: [definition JSON](../api-wiring/vendor_connections/definitions/gleif.json).

| Native operation ID | Method / path | Original semantics | Proposed canonical capability ID | Role | Mapping rationale / unresolved requirement |
| --- | --- | --- | --- | --- | --- |
| `gleif:search_lei` | `GET /api/v1/lei-records` | `business_data` | `reference.identifier.intelligence.unresolved` | `lookup` | LEI reference data; Level-2 parents are not natural-person UBOs. |
| `gleif:get_lei` | `GET /api/v1/lei-records/{lei}` | `business_data` | `reference.identifier.intelligence.unresolved` | `lookup` | LEI reference data; Level-2 parents are not natural-person UBOs. |

### C.14 `idenfy` — 1 operations

Provider record: `idenfy`. Native version: `documented-public`. Maturity: `implemented_unverified`. Live tested: `false`.  
Source: [definition JSON](../api-wiring/vendor_connections/definitions/idenfy.json).

| Native operation ID | Method / path | Original semantics | Proposed canonical capability ID | Role | Mapping rationale / unresolved requirement |
| --- | --- | --- | --- | --- | --- |
| `idenfy:generate_token` | `POST /api/v2/token` | `session` | `identity.person.intelligence.unresolved` | `submit` | Token/session generation enables verification; no verification result. |

### C.15 `incode` — 207 operations

Provider record: `incode`. Native version: `0.0.1-SNAPSHOT`. Maturity: `implemented_unverified`. Live tested: `false`.  
Source: [definition JSON](../api-wiring/vendor_connections/definitions/incode.json).

| Native operation ID | Method / path | Original semantics | Proposed canonical capability ID | Role | Mapping rationale / unresolved requirement |
| --- | --- | --- | --- | --- | --- |
| `incode:updateeditableocrdatasecondid` | `PUT /omni/update/editable-ocr-data-second-id` | `vendor_native` | `identity.document.extraction.intelligence.unresolved` | `control` | OCR/manual edits/cross-field comparison do not establish document authenticity. |
| `incode:updateeditableocrdata` | `PUT /omni/update/editable-ocr-data` | `vendor_native` | `identity.document.extraction.intelligence.unresolved` | `control` | OCR/manual edits/cross-field comparison do not establish document authenticity. |
| `incode:updateinterview` | `PUT /omni/update` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Onboarding/session, queue/conference, consent/OTP, audit, identity-resource edit, manual review or provider approval control. No institution decision or check outcome may be inferred. |
| `incode:addToQueue` | `PUT /omni/queue/conference/add` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Onboarding/session, queue/conference, consent/OTP, audit, identity-resource edit, manual review or provider approval control. No institution decision or check outcome may be inferred. |
| `incode:updatemanualreview` | `PUT /omni/manual-review` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Onboarding/session, queue/conference, consent/OTP, audit, identity-resource edit, manual review or provider approval control. No institution decision or check outcome may be inferred. |
| `incode:finishInterview` | `PUT /omni/finish` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Onboarding/session, queue/conference, consent/OTP, audit, identity-resource edit, manual review or provider approval control. No institution decision or check outcome may be inferred. |
| `incode:authenticate` | `POST /omni/stateless-authentications/provide/reference-selfie` | `vendor_native` | `identity.biometric.intelligence.unresolved` | `verify` | Biometric reference, comparison mode, liveness and thresholds must be explicit; authentication is not broad KYC. |
| `incode:oneToNIdentify` | `POST /omni/oneToN/v2/identify` | `vendor_native` | `identity.biometric.intelligence.unresolved` | `verify` | Biometric reference, comparison mode, liveness and thresholds must be explicit; authentication is not broad KYC. |
| `incode:oneToNMfa` | `POST /omni/oneToN/mfa` | `vendor_native` | `identity.biometric.intelligence.unresolved` | `verify` | Biometric reference, comparison mode, liveness and thresholds must be explicit; authentication is not broad KYC. |
| `incode:oneToNIdentify_1` | `POST /omni/oneToN/identify` | `vendor_native` | `identity.biometric.intelligence.unresolved` | `verify` | Biometric reference, comparison mode, liveness and thresholds must be explicit; authentication is not broad KYC. |
| `incode:authenticate_1` | `POST /omni/frame-analysis/analyze` | `vendor_native` | `identity.biometric.intelligence.unresolved` | `verify` | Biometric reference, comparison mode, liveness and thresholds must be explicit; authentication is not broad KYC. |
| `incode:authenticate_2` | `POST /omni/frame-analysis/analyze/third-party` | `vendor_native` | `identity.biometric.intelligence.unresolved` | `verify` | Biometric reference, comparison mode, liveness and thresholds must be explicit; authentication is not broad KYC. |
| `incode:auditLogs` | `POST /omni/executive-events/find` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Onboarding/session, queue/conference, consent/OTP, audit, identity-resource edit, manual review or provider approval control. No institution decision or check outcome may be inferred. |
| `incode:b2bIntegratorBatchWatchlistRecord` | `POST /omni/b2b/v1/watchlist/integrator/batch` | `vendor_native` | `reference.list.intelligence.unresolved` | `control` | Custom watchlist maintenance; not subject screening. |
| `incode:b2bContinueSession` | `POST /omni/b2b/v1/sessions/continue` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Onboarding/session, queue/conference, consent/OTP, audit, identity-resource edit, manual review or provider approval control. No institution decision or check outcome may be inferred. |
| `incode:addSelfieToIdentityTemplate` | `POST /omni/b2b/v1/authentications/add-selfie-to-identity` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Onboarding/session, queue/conference, consent/OTP, audit, identity-resource edit, manual review or provider approval control. No institution decision or check outcome may be inferred. |
| `incode:requestNewOnboarding` | `POST /omni/b2b/onboarding/request-new` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Onboarding/session, queue/conference, consent/OTP, audit, identity-resource edit, manual review or provider approval control. No institution decision or check outcome may be inferred. |
| `incode:authenticationAttempts` | `POST /omni/authentications/external/search` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Onboarding/session, queue/conference, consent/OTP, audit, identity-resource edit, manual review or provider approval control. No institution decision or check outcome may be inferred. |
| `incode:adminLogin` | `POST /executive/log-in` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Onboarding/session, queue/conference, consent/OTP, audit, identity-resource edit, manual review or provider approval control. No institution decision or check outcome may be inferred. |
| `incode:validateVin` | `POST /api/validate/vin` | `vendor_native` | `identity.vehicle.intelligence.unresolved` | `validate` | Vehicle identifier check; issuer scope not established. |
| `incode:validateSsn` | `POST /api/validate/ssn` | `vendor_native` | `identity.person.intelligence.us` | `verify` | US identifier source check; no broader identity checks inferred. |
| `incode:validaterfc` | `POST /api/validate/rfc` | `vendor_native` | `identity.tax_id.intelligence.mx` | `verify` | Mexican RFC source check; pin actual source/matched fields. |
| `incode:validaterfcbycurpv2` | `POST /api/validate/rfc-by-curp/v2` | `vendor_native` | `identity.tax_id.intelligence.mx` | `verify` | Mexican RFC source check; pin actual source/matched fields. |
| `incode:validateRegistraduria` | `POST /api/validate/registraduria` | `vendor_native` | `identity.person.intelligence.co` | `verify` | Colombian source/document type must be pinned. |
| `incode:validateRegistraduriaPPT` | `POST /api/validate/registraduria-ppt` | `vendor_native` | `identity.person.intelligence.co` | `verify` | Colombian source/document type must be pinned. |
| `incode:validateIne` | `POST /api/validate/ine` | `vendor_native` | `identity.person.intelligence.mx` | `verify` | Mexican identity-source operation; source access and comparison semantics require validation. |
| `incode:validatecurp4` | `POST /api/validate/curp/v4` | `vendor_native` | `identity.person.intelligence.mx` | `verify` | Mexican identity-source operation; source access and comparison semantics require validation. |
| `incode:validateCurp3` | `POST /api/validate/curp/v3` | `vendor_native` | `identity.person.intelligence.mx` | `verify` | Mexican identity-source operation; source access and comparison semantics require validation. |
| `incode:validatecurpbydata4` | `POST /api/validate/curp-by-data/v4` | `vendor_native` | `identity.person.intelligence.mx` | `verify` | Mexican identity-source operation; source access and comparison semantics require validation. |
| `incode:validateCurpByData3` | `POST /api/validate/curp-by-data/v3` | `vendor_native` | `identity.person.intelligence.mx` | `verify` | Mexican identity-source operation; source access and comparison semantics require validation. |
| `incode:validateAccountStatement` | `POST /api/validate/bank-statement` | `vendor_native` | `financial.evidence.intelligence.unresolved` | `verify` | Bank-statement validation; not bank-account ownership verification. |
| `incode:validateAccountStatementv2` | `POST /api/validate/bank-statement/v2` | `vendor_native` | `financial.evidence.intelligence.unresolved` | `verify` | Bank-statement validation; not bank-account ownership verification. |
| `incode:generaterfc` | `POST /api/calculate/rfc` | `vendor_native` | `identity.identifier.derivation.intelligence.mx` | `derive` | RFC derivation is not authoritative tax-ID verification. |
| `incode:getWatchlistResult` | `POST /omni/watchlist-result` | `vendor_native` | `screening.watchlist.intelligence.unresolved` | `retrieve` | Global/custom watchlist scope is a configured composite, not automatically sanctions. |
| `incode:getvideoselfiehash` | `POST /omni/videoselfie/hash` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Onboarding/session, queue/conference, consent/OTP, audit, identity-resource edit, manual review or provider approval control. No institution decision or check outcome may be inferred. |
| `incode:videoSelfieCompareOcrV2` | `POST /omni/videoselfie/compare-ocr/v2` | `vendor_native` | `identity.document.extraction.intelligence.unresolved` | `extract` | OCR/manual edits/cross-field comparison do not establish document authenticity. |
| `incode:uploadVideoSelfiePart` | `POST /omni/video-selfie/upload/part` | `vendor_native` | `document.evidence.intelligence.unresolved` | `upload` | Evidence collection only; not verification. |
| `incode:initiateVideoSelfieUpload` | `POST /omni/video-selfie/upload/initiate` | `vendor_native` | `document.evidence.intelligence.unresolved` | `upload` | Evidence collection only; not verification. |
| `incode:completeVideoSelfieUpload` | `POST /omni/video-selfie/upload/complete` | `vendor_native` | `document.evidence.intelligence.unresolved` | `upload` | Evidence collection only; not verification. |
| `incode:recognize` | `POST /omni/verifyFace` | `vendor_native` | `identity.biometric.intelligence.unresolved` | `verify` | Biometric reference, comparison mode, liveness and thresholds must be explicit; authentication is not broad KYC. |
| `incode:addFraudCandidate` | `POST /omni/trust-graph/report` | `vendor_native` | `risk.customer.intelligence.unresolved` | `control` | Risk result versus fraud-report feedback must remain distinct. |
| `incode:defraudInterviewBatch` | `POST /omni/trust-graph/defraud` | `vendor_native` | `risk.customer.intelligence.unresolved` | `control` | Risk result versus fraud-report feedback must remain distinct. |
| `incode:startInterview` | `POST /omni/start` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Onboarding/session, queue/conference, consent/OTP, audit, identity-resource edit, manual review or provider approval control. No institution decision or check outcome may be inferred. |
| `incode:signStringNom151` | `POST /omni/sign-string/nom151` | `vendor_native` | `document.signature.intelligence.unresolved` | `control` | Signature/contract/consent artifact operation; no identity verification inferred. |
| `incode:signHashNom151` | `POST /omni/sign-hash/nom151` | `vendor_native` | `document.signature.intelligence.unresolved` | `control` | Signature/contract/consent artifact operation; no identity verification inferred. |
| `incode:signDocumentNom151` | `POST /omni/sign-document/nom151` | `vendor_native` | `document.signature.intelligence.unresolved` | `control` | Signature/contract/consent artifact operation; no identity verification inferred. |
| `incode:signcombinedconsent` | `POST /omni/sign-combined-consent` | `vendor_native` | `document.signature.intelligence.unresolved` | `control` | Signature/contract/consent artifact operation; no identity verification inferred. |
| `incode:setSessionStatus` | `POST /omni/session/status/set` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Onboarding/session, queue/conference, consent/OTP, audit, identity-resource edit, manual review or provider approval control. No institution decision or check outcome may be inferred. |
| `incode:downloadPdfV2` | `POST /omni/session/downloadpdf/v2` | `vendor_native` | `document.evidence.intelligence.unresolved` | `retrieve` | Media/summary/artifact retrieval; no authenticity/biometric outcome implied. |
| `incode:importRecording` | `POST /omni/recordings/import/third-party` | `vendor_native` | `document.evidence.intelligence.unresolved` | `upload` | Evidence collection only; not verification. |
| `incode:importRecording_1` | `POST /omni/recordings/import` | `vendor_native` | `document.evidence.intelligence.unresolved` | `upload` | Evidence collection only; not verification. |
| `incode:interviewStopRecord` | `POST /omni/record-stop` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Onboarding/session, queue/conference, consent/OTP, audit, identity-resource edit, manual review or provider approval control. No institution decision or check outcome may be inferred. |
| `incode:interviewStartRecord` | `POST /omni/record-start` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Onboarding/session, queue/conference, consent/OTP, audit, identity-resource edit, manual review or provider approval control. No institution decision or check outcome may be inferred. |
| `incode:customerDisconnect` | `POST /omni/queue/conference/disconnect` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Onboarding/session, queue/conference, consent/OTP, audit, identity-resource edit, manual review or provider approval control. No institution decision or check outcome may be inferred. |
| `incode:validateqrcodeuuid` | `POST /omni/qr/validate` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Onboarding/session, queue/conference, consent/OTP, audit, identity-resource edit, manual review or provider approval control. No institution decision or check outcome may be inferred. |
| `incode:refreshqrcodevalue` | `POST /omni/qr/refresh` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Onboarding/session, queue/conference, consent/OTP, audit, identity-resource edit, manual review or provider approval control. No institution decision or check outcome may be inferred. |
| `incode:processincodewatchlistrecord` | `POST /omni/process/watchlist` | `vendor_native` | `screening.watchlist.intelligence.unresolved` | `submit` | Global/custom watchlist scope is a configured composite, not automatically sanctions. |
| `incode:processSecondId` | `POST /omni/process/second-id` | `vendor_native` | `identity.document.intelligence.unresolved` | `submit` | Document processing/consistency checks; actual authenticity checks must be evidenced. |
| `incode:obtainLaborHistoryCallback` | `POST /omni/process/payment-proof` | `vendor_native` | `financial.income.intelligence.mx` | `submit` | Income/employment evidence; IMSS source indicates Mexico only. |
| `incode:processImss` | `POST /omni/process/imss` | `vendor_native` | `financial.income.intelligence.mx` | `submit` | Income/employment evidence; IMSS source indicates Mexico only. |
| `incode:processId` | `POST /omni/process/id` | `vendor_native` | `identity.document.intelligence.unresolved` | `submit` | Document processing/consistency checks; actual authenticity checks must be evidenced. |
| `incode:processgovernmentvalidation` | `POST /omni/process/government-validation` | `vendor_native` | `identity.person.intelligence.unresolved` | `submit` | Configured government/identity checks require source and jurisdiction selection. |
| `incode:processGlobalWatchlist` | `POST /omni/process/global-watchlist` | `vendor_native` | `screening.watchlist.intelligence.unresolved` | `submit` | Global/custom watchlist scope is a configured composite, not automatically sanctions. |
| `incode:processfacevssecondid` | `POST /omni/process/face-vs-second-id` | `vendor_native` | `identity.biometric.intelligence.unresolved` | `submit` | Biometric reference, comparison mode, liveness and thresholds must be explicit; authentication is not broad KYC. |
| `incode:processface` | `POST /omni/process/face` | `vendor_native` | `identity.biometric.intelligence.unresolved` | `submit` | Biometric reference, comparison mode, liveness and thresholds must be explicit; authentication is not broad KYC. |
| `incode:approve` | `POST /omni/process/approve` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Onboarding/session, queue/conference, consent/OTP, audit, identity-resource edit, manual review or provider approval control. No institution decision or check outcome may be inferred. |
| `incode:getgetphone` | `GET /omni/phone` | `vendor_native` | `identity.profile.intelligence.unresolved` | `retrieve` | Stored contact/identity fields, not external verification. |
| `incode:postaddphone` | `POST /omni/phone` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Onboarding/session, queue/conference, consent/OTP, audit, identity-resource edit, manual review or provider approval control. No institution decision or check outcome may be inferred. |
| `incode:authenticate_3` | `POST /omni/onboarding-authentications/authenticate/third-party` | `vendor_native` | `identity.biometric.intelligence.unresolved` | `verify` | Biometric reference, comparison mode, liveness and thresholds must be explicit; authentication is not broad KYC. |
| `incode:authenticate_4` | `POST /omni/onboarding-authentications/authenticate` | `vendor_native` | `identity.biometric.intelligence.unresolved` | `verify` | Biometric reference, comparison mode, liveness and thresholds must be explicit; authentication is not broad KYC. |
| `incode:getEvents` | `GET /omni/interview-events` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Onboarding/session, queue/conference, consent/OTP, audit, identity-resource edit, manual review or provider approval control. No institution decision or check outcome may be inferred. |
| `incode:submitidentityreuse` | `POST /omni/identity-reuse/submit` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Onboarding/session, queue/conference, consent/OTP, audit, identity-resource edit, manual review or provider approval control. No institution decision or check outcome may be inferred. |
| `incode:identityCrosscheck` | `POST /omni/identity-crosscheck` | `vendor_native` | `identity.person.intelligence.unresolved` | `verify` | Configured government/identity checks require source and jurisdiction selection. |
| `incode:getimageslinks` | `POST /omni/get/images/v2` | `vendor_native` | `document.evidence.intelligence.unresolved` | `retrieve` | Media/summary/artifact retrieval; no authenticity/biometric outcome implied. |
| `incode:getimageslinksforsecondid` | `POST /omni/get/images-second-id/v2` | `vendor_native` | `document.evidence.intelligence.unresolved` | `retrieve` | Media/summary/artifact retrieval; no authenticity/biometric outcome implied. |
| `incode:getimagessecondid` | `POST /omni/get/images-second-id` | `vendor_native` | `document.evidence.intelligence.unresolved` | `retrieve` | Media/summary/artifact retrieval; no authenticity/biometric outcome implied. |
| `incode:getimages` | `POST /omni/get/images` | `vendor_native` | `document.evidence.intelligence.unresolved` | `retrieve` | Media/summary/artifact retrieval; no authenticity/biometric outcome implied. |
| `incode:getconcatenatedimages` | `POST /omni/get/concatenated-images` | `vendor_native` | `document.evidence.intelligence.unresolved` | `retrieve` | Media/summary/artifact retrieval; no authenticity/biometric outcome implied. |
| `incode:finishsession` | `GET /omni/finish-status` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Onboarding/session, queue/conference, consent/OTP, audit, identity-resource edit, manual review or provider approval control. No institution decision or check outcome may be inferred. |
| `incode:finishsession_1` | `POST /omni/finish-status` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Onboarding/session, queue/conference, consent/OTP, audit, identity-resource edit, manual review or provider approval control. No institution decision or check outcome may be inferred. |
| `incode:finalizeDocument` | `POST /omni/finalize/document` | `vendor_native` | `identity.document.intelligence.unresolved` | `submit` | Document processing/consistency checks; actual authenticity checks must be evidenced. |
| `incode:externalverificationincome` | `POST /omni/externalVerification/income` | `vendor_native` | `financial.income.intelligence.unresolved` | `retrieve` | Income/employment evidence; IMSS source indicates Mexico only. |
| `incode:unifiedEkyc` | `POST /omni/externalVerification/ekyc/unified` | `vendor_native` | `identity.person.intelligence.unresolved` | `submit` | Configured government/identity checks require source and jurisdiction selection. |
| `incode:externalverificationekyc` | `POST /omni/externalVerification/ekyc` | `vendor_native` | `identity.person.intelligence.unresolved` | `submit` | Configured government/identity checks require source and jurisdiction selection. |
| `incode:externalverificationekyb` | `POST /omni/externalVerification/ekyb` | `vendor_native` | `business.verification.intelligence.unresolved` | `submit` | Business-verification package; split actual child checks and jurisdictions. |
| `incode:sendsmsexternal` | `POST /omni/external/send-sms` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Onboarding/session, queue/conference, consent/OTP, audit, identity-resource edit, manual review or provider approval control. No institution decision or check outcome may be inferred. |
| `incode:expireOnboardingSessionsByIds` | `POST /omni/expire/interviews` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Onboarding/session, queue/conference, consent/OTP, audit, identity-resource edit, manual review or provider approval control. No institution decision or check outcome may be inferred. |
| `incode:ekybchecks` | `POST /omni/ekybChecks` | `vendor_native` | `business.verification.intelligence.unresolved` | `submit` | Business-verification package; split actual child checks and jurisdictions. |
| `incode:updateBehavioralStats` | `POST /omni/device/stats` | `vendor_native` | `risk.device.intelligence.unresolved` | `control` | Device-data retrieval/collection, not a completed person verification. |
| `incode:deleteincodewatchlistrecord` | `POST /omni/delete/watchlist/single-record` | `vendor_native` | `reference.list.intelligence.unresolved` | `control` | Custom watchlist maintenance; not subject screening. |
| `incode:cleanOnboardingSessionsByIds` | `POST /omni/delete/interviews` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Onboarding/session, queue/conference, consent/OTP, audit, identity-resource edit, manual review or provider approval control. No institution decision or check outcome may be inferred. |
| `incode:issuemdl` | `POST /omni/credentials/mdl` | `vendor_native` | `credential.issuance.intelligence.unresolved` | `control` | Credential issuance; no validation of underlying facts implied. |
| `incode:reportIssue` | `POST /omni/conference/report-issue` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Onboarding/session, queue/conference, consent/OTP, audit, identity-resource edit, manual review or provider approval control. No institution decision or check outcome may be inferred. |
| `incode:storePhotos` | `POST /omni/conference/photo` | `vendor_native` | `document.evidence.intelligence.unresolved` | `upload` | Evidence collection only; not verification. |
| `incode:addConferenceEvent` | `POST /omni/conference/add/event` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Onboarding/session, queue/conference, consent/OTP, audit, identity-resource edit, manual review or provider approval control. No institution decision or check outcome may be inferred. |
| `incode:verifyInterviewCode` | `POST /omni/code/verify` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Onboarding/session, queue/conference, consent/OTP, audit, identity-resource edit, manual review or provider approval control. No institution decision or check outcome may be inferred. |
| `incode:saveChat` | `POST /omni/chat` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Onboarding/session, queue/conference, consent/OTP, audit, identity-resource edit, manual review or provider approval control. No institution decision or check outcome may be inferred. |
| `incode:calculateNom151Signature` | `POST /omni/calculate-contract-nom151-signature` | `vendor_native` | `document.signature.intelligence.unresolved` | `control` | Signature/contract/consent artifact operation; no identity verification inferred. |
| `incode:batchAuthStats` | `POST /omni/batch/auth-stats` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Onboarding/session, queue/conference, consent/OTP, audit, identity-resource edit, manual review or provider approval control. No institution decision or check outcome may be inferred. |
| `incode:addFraudCandidateB2B` | `POST /omni/b2b/trust-graph/report` | `vendor_native` | `risk.customer.intelligence.unresolved` | `control` | Risk result versus fraud-report feedback must remain distinct. |
| `incode:verifyauthattempt` | `POST /omni/authentication/verify` | `vendor_native` | `identity.biometric.intelligence.unresolved` | `verify` | Biometric reference, comparison mode, liveness and thresholds must be explicit; authentication is not broad KYC. |
| `incode:addStampToPdfOnAnnotation` | `POST /omni/attach-stamp-on-annotation` | `vendor_native` | `document.signature.intelligence.unresolved` | `control` | Apply a document stamp; no identity verification inferred. |
| `incode:addsignaturetopdffilev2` | `POST /omni/attach-signature-to-pdf/v2` | `vendor_native` | `document.signature.intelligence.unresolved` | `control` | Signature/contract/consent artifact operation; no identity verification inferred. |
| `incode:addSignatureToPdfFile` | `POST /omni/attach-signature-to-pdf` | `vendor_native` | `document.signature.intelligence.unresolved` | `control` | Signature/contract/consent artifact operation; no identity verification inferred. |
| `incode:addsignaturetopdfonannotation` | `POST /omni/attach-signature-on-annotation` | `vendor_native` | `document.signature.intelligence.unresolved` | `control` | Signature/contract/consent artifact operation; no identity verification inferred. |
| `incode:insertincodewatchlistrecord` | `POST /omni/add/watchlist/single-record` | `vendor_native` | `reference.list.intelligence.unresolved` | `control` | Custom watchlist maintenance; not subject screening. |
| `incode:insertwatchlistrecordfromsession` | `POST /omni/add/watchlist/session` | `vendor_native` | `reference.list.intelligence.unresolved` | `control` | Custom watchlist maintenance; not subject screening. |
| `incode:insertwatchlistrecordfromidentity` | `POST /omni/add/watchlist/identity` | `vendor_native` | `reference.list.intelligence.unresolved` | `control` | Custom watchlist maintenance; not subject screening. |
| `incode:adduserconsent` | `POST /omni/add/user-consent` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Onboarding/session, queue/conference, consent/OTP, audit, identity-resource edit, manual review or provider approval control. No institution decision or check outcome may be inferred. |
| `incode:addqrcodetext` | `POST /omni/add/qr-code-text` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Onboarding/session, queue/conference, consent/OTP, audit, identity-resource edit, manual review or provider approval control. No institution decision or check outcome may be inferred. |
| `incode:addphone` | `POST /omni/add/phone` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Onboarding/session, queue/conference, consent/OTP, audit, identity-resource edit, manual review or provider approval control. No institution decision or check outcome may be inferred. |
| `incode:addName` | `POST /omni/add/name` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Onboarding/session, queue/conference, consent/OTP, audit, identity-resource edit, manual review or provider approval control. No institution decision or check outcome may be inferred. |
| `incode:addGeolocation` | `POST /omni/add/geolocation` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Onboarding/session, queue/conference, consent/OTP, audit, identity-resource edit, manual review or provider approval control. No institution decision or check outcome may be inferred. |
| `incode:addFrontSecondIdV2` | `POST /omni/add/front-second-id/v2` | `vendor_native` | `document.evidence.intelligence.unresolved` | `upload` | Evidence collection only; not verification. |
| `incode:addFrontIdV2` | `POST /omni/add/front-id/v2` | `vendor_native` | `document.evidence.intelligence.unresolved` | `upload` | Evidence collection only; not verification. |
| `incode:addfiscalqrimage` | `POST /omni/add/fiscal-qr-url-image` | `vendor_native` | `document.evidence.intelligence.unresolved` | `upload` | Evidence collection only; not verification. |
| `incode:addfiscalqrurl` | `POST /omni/add/fiscal-qr-url` | `vendor_native` | `document.evidence.intelligence.unresolved` | `upload` | Evidence collection only; not verification. |
| `incode:addFingerprints` | `POST /omni/add/fingerprints` | `vendor_native` | `document.evidence.intelligence.unresolved` | `upload` | Evidence collection only; not verification. |
| `incode:addFaceByThirdParty` | `POST /omni/add/face/third-party` | `vendor_native` | `document.evidence.intelligence.unresolved` | `upload` | Evidence collection only; not verification. |
| `incode:addemail` | `POST /omni/add/email` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Onboarding/session, queue/conference, consent/OTP, audit, identity-resource edit, manual review or provider approval control. No institution decision or check outcome may be inferred. |
| `incode:adddocumentv3` | `POST /omni/add/document/v3` | `vendor_native` | `document.evidence.intelligence.unresolved` | `upload` | Evidence collection only; not verification. |
| `incode:adddocumentv2` | `POST /omni/add/document/v2` | `vendor_native` | `document.evidence.intelligence.unresolved` | `upload` | Evidence collection only; not verification. |
| `incode:adddocumentasync` | `POST /omni/add/document/async` | `vendor_native` | `document.evidence.intelligence.unresolved` | `upload` | Evidence collection only; not verification. |
| `incode:addDocumentId` | `POST /omni/add/document-id` | `vendor_native` | `document.evidence.intelligence.unresolved` | `upload` | Evidence collection only; not verification. |
| `incode:addDocument` | `POST /omni/add/document` | `vendor_native` | `document.evidence.intelligence.unresolved` | `upload` | Evidence collection only; not verification. |
| `incode:addDiagnosticsData` | `POST /omni/add/diagnostics-data` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Onboarding/session, queue/conference, consent/OTP, audit, identity-resource edit, manual review or provider approval control. No institution decision or check outcome may be inferred. |
| `incode:addDeviceFingerprintSignals` | `POST /omni/add/device-fingerprint-signals` | `vendor_native` | `risk.device.intelligence.unresolved` | `control` | Device-data retrieval/collection, not a completed person verification. |
| `incode:addDeviceFingerprint` | `POST /omni/add/device-fingerprint` | `vendor_native` | `risk.device.intelligence.unresolved` | `control` | Device-data retrieval/collection, not a completed person verification. |
| `incode:addcustomfields` | `POST /omni/add/custom-fields` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Onboarding/session, queue/conference, consent/OTP, audit, identity-resource edit, manual review or provider approval control. No institution decision or check outcome may be inferred. |
| `incode:addcurp2` | `POST /omni/add/curp/v2` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Onboarding/session, queue/conference, consent/OTP, audit, identity-resource edit, manual review or provider approval control. No institution decision or check outcome may be inferred. |
| `incode:addcurp` | `POST /omni/add/curp` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Onboarding/session, queue/conference, consent/OTP, audit, identity-resource edit, manual review or provider approval control. No institution decision or check outcome may be inferred. |
| `incode:addNotes` | `POST /omni/add/conference/notes` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Onboarding/session, queue/conference, consent/OTP, audit, identity-resource edit, manual review or provider approval control. No institution decision or check outcome may be inferred. |
| `incode:addNotes_1` | `POST /omni/add/notes` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Onboarding/session, queue/conference, consent/OTP, audit, identity-resource edit, manual review or provider approval control. No institution decision or check outcome may be inferred. |
| `incode:addConferenceFeedback` | `POST /omni/add/conference/feedback` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Onboarding/session, queue/conference, consent/OTP, audit, identity-resource edit, manual review or provider approval control. No institution decision or check outcome may be inferred. |
| `incode:addConferenceModule` | `POST /omni/add/conference-module` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Onboarding/session, queue/conference, consent/OTP, audit, identity-resource edit, manual review or provider approval control. No institution decision or check outcome may be inferred. |
| `incode:addConferenceConsent` | `POST /omni/add/conference-consent` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Onboarding/session, queue/conference, consent/OTP, audit, identity-resource edit, manual review or provider approval control. No institution decision or check outcome may be inferred. |
| `incode:addbarcodev3` | `POST /omni/add/barcode/v3` | `vendor_native` | `document.evidence.intelligence.unresolved` | `upload` | Evidence collection only; not verification. |
| `incode:addbarcodev2` | `POST /omni/add/barcode/v2` | `vendor_native` | `document.evidence.intelligence.unresolved` | `upload` | Evidence collection only; not verification. |
| `incode:addbarcode` | `POST /omni/add/barcode` | `vendor_native` | `document.evidence.intelligence.unresolved` | `upload` | Evidence collection only; not verification. |
| `incode:addBackSecondIdV2` | `POST /omni/add/back-second-id/v2` | `vendor_native` | `document.evidence.intelligence.unresolved` | `upload` | Evidence collection only; not verification. |
| `incode:addBackIdV2` | `POST /omni/add/back-id/v2` | `vendor_native` | `document.evidence.intelligence.unresolved` | `upload` | Evidence collection only; not verification. |
| `incode:addproofofaddressv2` | `POST /omni/add/address-statement/v2` | `vendor_native` | `document.evidence.intelligence.unresolved` | `upload` | Evidence collection only; not verification. |
| `incode:addproofofaddress` | `POST /omni/add/address-statement` | `vendor_native` | `document.evidence.intelligence.unresolved` | `upload` | Evidence collection only; not verification. |
| `incode:oneToOneIdentify` | `POST /omni/1to1/v2/identify` | `vendor_native` | `identity.biometric.intelligence.unresolved` | `verify` | Biometric reference, comparison mode, liveness and thresholds must be explicit; authentication is not broad KYC. |
| `incode:oneToOneIdentify_1` | `POST /omni/1to1/identify` | `vendor_native` | `identity.biometric.intelligence.unresolved` | `verify` | Biometric reference, comparison mode, liveness and thresholds must be explicit; authentication is not broad KYC. |
| `incode:getcustomersessions` | `GET /omni/identity/{customerId}/sessions` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Onboarding/session, queue/conference, consent/OTP, audit, identity-resource edit, manual review or provider approval control. No institution decision or check outcome may be inferred. |
| `incode:getCustomerSessionIds` | `GET /omni/identity/{customerId}/sessionIds` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Onboarding/session, queue/conference, consent/OTP, audit, identity-resource edit, manual review or provider approval control. No institution decision or check outcome may be inferred. |
| `incode:b2bSessionListing` | `GET /omni/b2b/v1/sessions/listing` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Onboarding/session, queue/conference, consent/OTP, audit, identity-resource edit, manual review or provider approval control. No institution decision or check outcome may be inferred. |
| `incode:identitydata` | `GET /omni/b2b/v1/identities/{id}` | `vendor_native` | `identity.profile.intelligence.unresolved` | `retrieve` | Stored contact/identity fields, not external verification. |
| `incode:b2bDeviceInfo` | `GET /omni/b2b/v1/devices/info` | `vendor_native` | `risk.device.intelligence.unresolved` | `retrieve` | Device-data retrieval/collection, not a completed person verification. |
| `incode:fetchIne` | `GET /api/fetch/ine` | `vendor_native` | `identity.person.intelligence.mx` | `retrieve` | Mexican identity-source operation; source access and comparison semantics require validation. |
| `incode:fetchCurp3` | `GET /api/fetch/curp/v3` | `vendor_native` | `identity.person.intelligence.mx` | `retrieve` | Mexican identity-source operation; source access and comparison semantics require validation. |
| `incode:getAsyncVendorVerificationResult` | `GET /omni/verification/async/{referenceId}` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | CONDITIONAL: async result source/check type is not pinned; dispatch to the corresponding verification contract before producing findings. |
| `incode:getupdatedwatchlistresult` | `GET /omni/updated-watchlist-result` | `vendor_native` | `screening.watchlist.intelligence.unresolved` | `retrieve` | Global/custom watchlist scope is a configured composite, not automatically sanctions. |
| `incode:getReasonCategories` | `GET /omni/trust-graph/reason-categories` | `vendor_native` | `risk.customer.intelligence.unresolved` | `retrieve` | Risk result versus fraud-report feedback must remain distinct. |
| `incode:getSessionStatus` | `GET /omni/session/status/get` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Onboarding/session, queue/conference, consent/OTP, audit, identity-resource edit, manual review or provider approval control. No institution decision or check outcome may be inferred. |
| `incode:sendOTP` | `GET /omni/send/sms-otp` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Onboarding/session, queue/conference, consent/OTP, audit, identity-resource edit, manual review or provider approval control. No institution decision or check outcome may be inferred. |
| `incode:getOTP` | `GET /omni/send/otp` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Onboarding/session, queue/conference, consent/OTP, audit, identity-resource edit, manual review or provider approval control. No institution decision or check outcome may be inferred. |
| `incode:getNext` | `GET /omni/queue/conference/next` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Onboarding/session, queue/conference, consent/OTP, audit, identity-resource edit, manual review or provider approval control. No institution decision or check outcome may be inferred. |
| `incode:getQueueIndex` | `GET /omni/queue/conference/index` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Onboarding/session, queue/conference, consent/OTP, audit, identity-resource edit, manual review or provider approval control. No institution decision or check outcome may be inferred. |
| `incode:connectToConference` | `GET /omni/queue/conference/connection-details` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Onboarding/session, queue/conference, consent/OTP, audit, identity-resource edit, manual review or provider approval control. No institution decision or check outcome may be inferred. |
| `incode:getantifraudresult` | `GET /omni/process/antifraud` | `vendor_native` | `risk.customer.intelligence.unresolved` | `retrieve` | Risk result versus fraud-report feedback must remain distinct. |
| `incode:getonboardingurl` | `GET /omni/onboarding-url` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Onboarding/session, queue/conference, consent/OTP, audit, identity-resource edit, manual review or provider approval control. No institution decision or check outcome may be inferred. |
| `incode:getDictionary` | `GET /omni/interview-events/dictionary` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Onboarding/session, queue/conference, consent/OTP, audit, identity-resource edit, manual review or provider approval control. No institution decision or check outcome may be inferred. |
| `incode:getidentityreusedocuments` | `GET /omni/identity-reuse/documents` | `vendor_native` | `document.evidence.intelligence.unresolved` | `retrieve` | Previously captured identity-reuse documents; retrieval is not new verification. |
| `incode:getuserconsent` | `GET /omni/get/user-consent` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Onboarding/session, queue/conference, consent/OTP, audit, identity-resource edit, manual review or provider approval control. No institution decision or check outcome may be inferred. |
| `incode:getSigningCeremonyUrl` | `GET /omni/get/signing-ceremony-url` | `vendor_native` | `document.signature.intelligence.unresolved` | `retrieve` | Signature/contract/consent artifact operation; no identity verification inferred. |
| `incode:getSignedContracts` | `GET /omni/get/signed-contracts-links` | `vendor_native` | `document.signature.intelligence.unresolved` | `retrieve` | Signature/contract/consent artifact operation; no identity verification inferred. |
| `incode:getscores` | `GET /omni/get/score` | `vendor_native` | `risk.customer.intelligence.unresolved` | `retrieve` | Risk result versus fraud-report feedback must remain distinct. |
| `incode:getrawidvresults` | `GET /omni/get/raw-idv-results` | `vendor_native` | `identity.person.intelligence.unresolved` | `retrieve` | Configured government/identity checks require source and jurisdiction selection. |
| `incode:getQuestionAndAnswer` | `GET /omni/get/questionAndAnswer` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Onboarding/session, queue/conference, consent/OTP, audit, identity-resource edit, manual review or provider approval control. No institution decision or check outcome may be inferred. |
| `incode:getprocessbatchstatus` | `GET /omni/get/process-batch-status` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Onboarding/session, queue/conference, consent/OTP, audit, identity-resource edit, manual review or provider approval control. No institution decision or check outcome may be inferred. |
| `incode:checkIfPostProcessingIsFinished` | `GET /omni/get/postprocess/isfinished` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Onboarding/session, queue/conference, consent/OTP, audit, identity-resource edit, manual review or provider approval control. No institution decision or check outcome may be inferred. |
| `incode:getphone` | `GET /omni/get/phone` | `vendor_native` | `identity.profile.intelligence.unresolved` | `retrieve` | Stored contact/identity fields, not external verification. |
| `incode:getonboardingstatus` | `GET /omni/get/onboarding/status` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Onboarding/session, queue/conference, consent/OTP, audit, identity-resource edit, manual review or provider approval control. No institution decision or check outcome may be inferred. |
| `incode:getocrdatav2` | `GET /omni/get/ocr-data/v2` | `vendor_native` | `identity.document.extraction.intelligence.unresolved` | `extract` | OCR/manual edits/cross-field comparison do not establish document authenticity. |
| `incode:getOcrDataSecondId` | `GET /omni/get/ocr-data-second-id` | `vendor_native` | `identity.document.extraction.intelligence.unresolved` | `extract` | OCR/manual edits/cross-field comparison do not establish document authenticity. |
| `incode:getOcrData` | `GET /omni/get/ocr-data` | `vendor_native` | `identity.document.extraction.intelligence.unresolved` | `extract` | OCR/manual edits/cross-field comparison do not establish document authenticity. |
| `incode:getInterviewerInfo` | `GET /omni/get/interviewer-info` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Onboarding/session, queue/conference, consent/OTP, audit, identity-resource edit, manual review or provider approval control. No institution decision or check outcome may be inferred. |
| `incode:getLaborHistoryInfo` | `GET /omni/get/imss` | `vendor_native` | `financial.income.intelligence.mx` | `retrieve` | Income/employment evidence; IMSS source indicates Mexico only. |
| `incode:getIdSummary` | `GET /omni/get/id-summary` | `vendor_native` | `document.evidence.intelligence.unresolved` | `retrieve` | Media/summary/artifact retrieval; no authenticity/biometric outcome implied. |
| `incode:getfingerprints` | `GET /omni/get/fingerprints` | `vendor_native` | `document.evidence.intelligence.unresolved` | `retrieve` | Media/summary/artifact retrieval; no authenticity/biometric outcome implied. |
| `incode:getEmail` | `GET /omni/get/email` | `vendor_native` | `identity.profile.intelligence.unresolved` | `retrieve` | Stored contact/identity fields, not external verification. |
| `incode:getdeviceinfo` | `GET /omni/get/device-info` | `vendor_native` | `risk.device.intelligence.unresolved` | `retrieve` | Device-data retrieval/collection, not a completed person verification. |
| `incode:getcustomfields` | `GET /omni/get/custom-fields` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Onboarding/session, queue/conference, consent/OTP, audit, identity-resource edit, manual review or provider approval control. No institution decision or check outcome may be inferred. |
| `incode:getContracts` | `GET /omni/get/contracts-links` | `vendor_native` | `document.signature.intelligence.unresolved` | `retrieve` | Signature/contract/consent artifact operation; no identity verification inferred. |
| `incode:getconferencenotes` | `GET /omni/get/conference/notes` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Onboarding/session, queue/conference, consent/OTP, audit, identity-resource edit, manual review or provider approval control. No institution decision or check outcome may be inferred. |
| `incode:getconferencefeedback` | `GET /omni/get/conference/feedback` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Onboarding/session, queue/conference, consent/OTP, audit, identity-resource edit, manual review or provider approval control. No institution decision or check outcome may be inferred. |
| `incode:getconferencedetails` | `GET /omni/get/conference-status` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Onboarding/session, queue/conference, consent/OTP, audit, identity-resource edit, manual review or provider approval control. No institution decision or check outcome may be inferred. |
| `incode:getcombinedconsent` | `GET /omni/get/combined-consent` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Onboarding/session, queue/conference, consent/OTP, audit, identity-resource edit, manual review or provider approval control. No institution decision or check outcome may be inferred. |
| `incode:getchats` | `GET /omni/get/chat` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Onboarding/session, queue/conference, consent/OTP, audit, identity-resource edit, manual review or provider approval control. No institution decision or check outcome may be inferred. |
| `incode:geturlarchives` | `GET /omni/get/archives` | `vendor_native` | `document.evidence.intelligence.unresolved` | `retrieve` | Media/summary/artifact retrieval; no authenticity/biometric outcome implied. |
| `incode:generatevideoselfiedownloadurl` | `GET /omni/generateVideoSelfieDownloadUrl` | `vendor_native` | `document.evidence.intelligence.unresolved` | `retrieve` | Media/summary/artifact retrieval; no authenticity/biometric outcome implied. |
| `incode:generatesessionrecordingdownloadurl` | `GET /omni/generateSessionRecordingDownloadUrl` | `vendor_native` | `document.evidence.intelligence.unresolved` | `retrieve` | Media/summary/artifact retrieval; no authenticity/biometric outcome implied. |
| `incode:fetchFormAnswers` | `GET /omni/form/answers` | `vendor_native` | `questionnaire.collection.intelligence.unresolved` | `retrieve` | Form responses; preserve form version and respondent provenance. |
| `incode:getfiscalqrurlresponse` | `GET /omni/fiscal-qr-url-response/{interviewId}` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Onboarding/session, queue/conference, consent/OTP, audit, identity-resource edit, manual review or provider approval control. No institution decision or check outcome may be inferred. |
| `incode:externalVerificationEkycSession` | `GET /omni/externalVerification/ekyc/session` | `vendor_native` | `identity.person.intelligence.unresolved` | `retrieve` | Configured government/identity checks require source and jurisdiction selection. |
| `incode:externalVerificationEkybSession` | `GET /omni/externalVerification/ekyb/session` | `vendor_native` | `business.verification.intelligence.unresolved` | `retrieve` | Business-verification package; split actual child checks and jurisdictions. |
| `incode:getSignedDocumentsV2` | `GET /omni/es/documents/signed/v2` | `vendor_native` | `document.signature.intelligence.unresolved` | `retrieve` | Signature/contract/consent artifact operation; no identity verification inferred. |
| `incode:cross-doc-check-results` | `GET /omni/cross-doc-data-check/results` | `vendor_native` | `identity.document.intelligence.unresolved` | `retrieve` | Document processing/consistency checks; actual authenticity checks must be evidenced. |
| `incode:getConferenceEvents` | `GET /omni/conference/get/events` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Onboarding/session, queue/conference, consent/OTP, audit, identity-resource edit, manual review or provider approval control. No institution decision or check outcome may be inferred. |
| `incode:compareOTP` | `GET /omni/compare/sms-otp` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Onboarding/session, queue/conference, consent/OTP, audit, identity-resource edit, manual review or provider approval control. No institution decision or check outcome may be inferred. |
| `incode:generateInterviewCode` | `GET /omni/code/generate` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Onboarding/session, queue/conference, consent/OTP, audit, identity-resource edit, manual review or provider approval control. No institution decision or check outcome may be inferred. |
| `incode:getTrustGraphCheckResult` | `GET /omni/b2b/trust-graph/result` | `vendor_native` | `risk.customer.intelligence.unresolved` | `retrieve` | Risk result versus fraud-report feedback must remain distinct. |
| `incode:cleansingleonboardingsessionwithexternalid` | `DELETE /omni/session/externalId` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Onboarding/session, queue/conference, consent/OTP, audit, identity-resource edit, manual review or provider approval control. No institution decision or check outcome may be inferred. |
| `incode:cleanallonboardingsessions` | `DELETE /omni/interviews` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Onboarding/session, queue/conference, consent/OTP, audit, identity-resource edit, manual review or provider approval control. No institution decision or check outcome may be inferred. |
| `incode:cleansingleonboardingsession` | `DELETE /omni/interview` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Onboarding/session, queue/conference, consent/OTP, audit, identity-resource edit, manual review or provider approval control. No institution decision or check outcome may be inferred. |

### C.16 `ipinfo` — 1 operations

Provider record: `ipinfo`. Native version: `documented-public`. Maturity: `implemented_unverified`. Live tested: `false`.  
Source: [definition JSON](../api-wiring/vendor_connections/definitions/ipinfo.json).

| Native operation ID | Method / path | Original semantics | Proposed canonical capability ID | Role | Mapping rationale / unresolved requirement |
| --- | --- | --- | --- | --- | --- |
| `ipinfo:lookup` | `GET /lookup/{ip}` | `network_data` | `risk.network.intelligence.unresolved` | `assess` | Signal/score contract; endpoint deployment region does not establish jurisdiction coverage. |

### C.17 `ipqs` — 3 operations

Provider record: `ipqs`. Native version: `documented-public`. Maturity: `implemented_unverified`. Live tested: `false`.  
Source: [definition JSON](../api-wiring/vendor_connections/definitions/ipqs.json).

| Native operation ID | Method / path | Original semantics | Proposed canonical capability ID | Role | Mapping rationale / unresolved requirement |
| --- | --- | --- | --- | --- | --- |
| `ipqs:ip` | `POST /api/json/ip/` | `risk` | `risk.network.intelligence.unresolved` | `assess` | Signal/score contract; endpoint deployment region does not establish jurisdiction coverage. |
| `ipqs:email` | `POST /api/json/email/` | `risk` | `risk.email.intelligence.unresolved` | `assess` | Signal/score contract; endpoint deployment region does not establish jurisdiction coverage. |
| `ipqs:phone` | `POST /api/json/phone/` | `risk` | `risk.phone.intelligence.unresolved` | `assess` | Signal/score contract; endpoint deployment region does not establish jurisdiction coverage. |

### C.18 `maxmind` — 3 operations

Provider record: `maxmind`. Native version: `2.0`. Maturity: `implemented_unverified`. Live tested: `false`.  
Source: [definition JSON](../api-wiring/vendor_connections/definitions/maxmind.json).

| Native operation ID | Method / path | Original semantics | Proposed canonical capability ID | Role | Mapping rationale / unresolved requirement |
| --- | --- | --- | --- | --- | --- |
| `maxmind:score` | `POST /minfraud/v2.0/score` | `risk` | `risk.customer.intelligence.unresolved` | `assess` | Signal/score contract; endpoint deployment region does not establish jurisdiction coverage. |
| `maxmind:insights` | `POST /minfraud/v2.0/insights` | `risk` | `risk.customer.intelligence.unresolved` | `assess` | Signal/score contract; endpoint deployment region does not establish jurisdiction coverage. |
| `maxmind:factors` | `POST /minfraud/v2.0/factors` | `risk` | `risk.customer.intelligence.unresolved` | `assess` | Signal/score contract; endpoint deployment region does not establish jurisdiction coverage. |

### C.19 `middesk` — 2 operations

Provider record: `middesk`. Native version: `documented-public`. Maturity: `implemented_unverified`. Live tested: `false`.  
Source: [definition JSON](../api-wiring/vendor_connections/definitions/middesk.json).

| Native operation ID | Method / path | Original semantics | Proposed canonical capability ID | Role | Mapping rationale / unresolved requirement |
| --- | --- | --- | --- | --- | --- |
| `middesk:create_business` | `POST /businesses` | `submission` | `business.verification.intelligence.unresolved` | `submit` | Requested product/check package and evidenced findings determine verification scope. |
| `middesk:get_business` | `GET /businesses/{id}` | `business_data` | `business.verification.intelligence.unresolved` | `retrieve` | Requested product/check package and evidenced findings determine verification scope. |

### C.20 `mono` — 2 operations

Provider record: `mono`. Native version: `v2`. Maturity: `implemented_unverified`. Live tested: `false`.  
Source: [definition JSON](../api-wiring/vendor_connections/definitions/mono.json).

| Native operation ID | Method / path | Original semantics | Proposed canonical capability ID | Role | Mapping rationale / unresolved requirement |
| --- | --- | --- | --- | --- | --- |
| `mono:exchange_code` | `POST /v2/accounts/auth` | `session` | `platform.integration.intelligence.unresolved` | `control` | Exchange authorization code/session credential. |
| `mono:get_identity` | `GET /v2/accounts/{id}/identity` | `identity_data` | `account.profile.intelligence.unresolved` | `retrieve` | Account-holder identity data without an input comparison is not ownership verification. |

### C.21 `mx` — 164 operations

Provider record: `mx`. Native version: `20250224`. Maturity: `implemented_unverified`. Live tested: `false`.  
Source: [definition JSON](../api-wiring/vendor_connections/definitions/mx.json).

| Native operation ID | Method / path | Original semantics | Proposed canonical capability ID | Role | Mapping rationale / unresolved requirement |
| --- | --- | --- | --- | --- | --- |
| `mx:requestAuthorizationCode` | `POST /authorization_code` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | User/member, credentials, aggregation, challenge, widget, token or notification lifecycle; not a person identity result. |
| `mx:listDefaultCategories` | `GET /categories/default` | `vendor_native` | `financial.personal_management.intelligence.unresolved` | `retrieve` | Personal-finance/catalog/resource function; not AML intelligence. |
| `mx:readDefaultCategory` | `GET /categories/{category_guid}` | `vendor_native` | `financial.personal_management.intelligence.unresolved` | `retrieve` | Personal-finance/catalog/resource function; not AML intelligence. |
| `mx:listInstitutions` | `GET /institutions` | `vendor_native` | `financial.institution.intelligence.unresolved` | `lookup` | Institution/merchant reference metadata. |
| `mx:listFavoriteInstitutions` | `GET /institutions/favorites` | `vendor_native` | `financial.institution.intelligence.unresolved` | `lookup` | Institution/merchant reference metadata. |
| `mx:readInstitution` | `GET /institutions/{institution_code}` | `vendor_native` | `financial.institution.intelligence.unresolved` | `lookup` | Institution/merchant reference metadata. |
| `mx:listInstitutionCredentials` | `GET /institutions/{institution_identifier}/credentials` | `vendor_native` | `financial.institution.intelligence.unresolved` | `lookup` | Institution/merchant reference metadata. |
| `mx:listManagedInstitutions` | `GET /managed_institutions` | `vendor_native` | `financial.institution.intelligence.unresolved` | `lookup` | Institution/merchant reference metadata. |
| `mx:readMerchantLocation` | `GET /merchant_locations/{merchant_location_guid}` | `vendor_native` | `financial.institution.intelligence.unresolved` | `lookup` | Institution/merchant reference metadata. |
| `mx:listMerchants` | `GET /merchants` | `vendor_native` | `financial.institution.intelligence.unresolved` | `lookup` | Institution/merchant reference metadata. |
| `mx:readMerchant` | `GET /merchants/{merchant_guid}` | `vendor_native` | `financial.institution.intelligence.unresolved` | `lookup` | Institution/merchant reference metadata. |
| `mx:enhanceTransactions` | `POST /transactions/enhance` | `vendor_native` | `financial.transactions.intelligence.unresolved` | `enrich` | Financial transactions/enrichment/manual edits; manually edited values retain user-supplied provenance. |
| `mx:listUsers` | `GET /users` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | User/member, credentials, aggregation, challenge, widget, token or notification lifecycle; not a person identity result. |
| `mx:createUser` | `POST /users` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | User/member, credentials, aggregation, challenge, widget, token or notification lifecycle; not a person identity result. |
| `mx:deleteUser` | `DELETE /users/{user_identifier}` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | User/member, credentials, aggregation, challenge, widget, token or notification lifecycle; not a person identity result. |
| `mx:readUser` | `GET /users/{user_identifier}` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | User/member, credentials, aggregation, challenge, widget, token or notification lifecycle; not a person identity result. |
| `mx:updateUser` | `PUT /users/{user_identifier}` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | User/member, credentials, aggregation, challenge, widget, token or notification lifecycle; not a person identity result. |
| `mx:listUserAccounts` | `GET /users/{user_identifier}/accounts` | `vendor_native` | `account.profile.intelligence.unresolved` | `retrieve` | Account metadata/resource lifecycle; manual account creation is not external corroboration. |
| `mx:createManualAccount` | `POST /users/{user_identifier}/accounts` | `vendor_native` | `account.profile.intelligence.unresolved` | `control` | Account metadata/resource lifecycle; manual account creation is not external corroboration. |
| `mx:readAccount` | `GET /users/{user_guid}/accounts/{account_guid}` | `vendor_native` | `account.profile.intelligence.unresolved` | `retrieve` | Account metadata/resource lifecycle; manual account creation is not external corroboration. |
| `mx:deleteManualAccount` | `DELETE /users/{user_guid}/accounts/{account_guid}` | `vendor_native` | `account.profile.intelligence.unresolved` | `control` | Account metadata/resource lifecycle; manual account creation is not external corroboration. |
| `mx:listAccountNumbersByAccount` | `GET /users/{user_identifier}/accounts/{account_identifier}/account_numbers` | `vendor_native` | `account.profile.intelligence.unresolved` | `retrieve` | Account metadata/resource lifecycle; manual account creation is not external corroboration. |
| `mx:listInsightsByAccount` | `GET /users/{user_guid}/accounts/{account_guid}/insights` | `vendor_native` | `financial.analytics.intelligence.unresolved` | `retrieve` | Financial insight/profile, not AML monitoring or approved creditworthiness. |
| `mx:mergeAccounts` | `POST /users/{user_guid}/accounts/merge` | `vendor_native` | `account.profile.intelligence.unresolved` | `control` | Account metadata/resource lifecycle; manual account creation is not external corroboration. |
| `mx:createManualTransaction` | `POST /users/{user_guid}/accounts/{account_guid}/transactions` | `vendor_native` | `financial.transactions.intelligence.unresolved` | `control` | Financial transactions/enrichment/manual edits; manually edited values retain user-supplied provenance. |
| `mx:listTransactionsByAccount` | `GET /users/{user_guid}/accounts/{account_guid}/transactions` | `vendor_native` | `financial.transactions.intelligence.unresolved` | `retrieve` | Financial transactions/enrichment/manual edits; manually edited values retain user-supplied provenance. |
| `mx:listTransactionsByAccountPerMember` | `GET /users/{user_guid}/members/{member_guid}/accounts/{account_guid}/transactions` | `vendor_native` | `financial.transactions.intelligence.unresolved` | `retrieve` | Financial transactions/enrichment/manual edits; manually edited values retain user-supplied provenance. |
| `mx:listCategories` | `GET /users/{user_guid}/categories` | `vendor_native` | `financial.personal_management.intelligence.unresolved` | `retrieve` | Personal-finance/catalog/resource function; not AML intelligence. |
| `mx:createCategory` | `POST /users/{user_guid}/categories` | `vendor_native` | `financial.personal_management.intelligence.unresolved` | `control` | Personal-finance/catalog/resource function; not AML intelligence. |
| `mx:listDefaultCategoriesByUser` | `GET /users/{user_guid}/categories/default` | `vendor_native` | `financial.personal_management.intelligence.unresolved` | `retrieve` | Personal-finance/catalog/resource function; not AML intelligence. |
| `mx:deleteCategory` | `DELETE /users/{user_guid}/categories/{category_guid}` | `vendor_native` | `financial.personal_management.intelligence.unresolved` | `control` | Personal-finance/catalog/resource function; not AML intelligence. |
| `mx:readCategory` | `GET /users/{user_guid}/categories/{category_guid}` | `vendor_native` | `financial.personal_management.intelligence.unresolved` | `retrieve` | Personal-finance/catalog/resource function; not AML intelligence. |
| `mx:updateCategory` | `PUT /users/{user_guid}/categories/{category_guid}` | `vendor_native` | `financial.personal_management.intelligence.unresolved` | `control` | Personal-finance/catalog/resource function; not AML intelligence. |
| `mx:listInsightsUser` | `GET /users/{user_guid}/insights` | `vendor_native` | `financial.analytics.intelligence.unresolved` | `retrieve` | Financial insight/profile, not AML monitoring or approved creditworthiness. |
| `mx:listCategoriesInsight` | `GET /users/{user_guid}/insights/{insight_guid}/categories` | `vendor_native` | `financial.personal_management.intelligence.unresolved` | `retrieve` | Personal-finance/catalog/resource function; not AML intelligence. |
| `mx:listAccountsInsight` | `GET /users/{user_guid}/insights/{insight_guid}/accounts` | `vendor_native` | `financial.analytics.intelligence.unresolved` | `retrieve` | Financial insight/profile, not AML monitoring or approved creditworthiness. |
| `mx:listMerchantsInsight` | `GET /users/{user_guid}/insights/{insight_guid}/merchants` | `vendor_native` | `financial.institution.intelligence.unresolved` | `lookup` | Institution/merchant reference metadata. |
| `mx:listTransactionsInsight` | `GET /users/{user_guid}/insights/{insight_guid}/transactions` | `vendor_native` | `financial.analytics.intelligence.unresolved` | `retrieve` | Financial insight/profile, not AML monitoring or approved creditworthiness. |
| `mx:readInsightUser` | `GET /users/{user_guid}/insights/{insight_guid}` | `vendor_native` | `financial.analytics.intelligence.unresolved` | `retrieve` | Financial insight/profile, not AML monitoring or approved creditworthiness. |
| `mx:updateInsight` | `PUT /users/{user_guid}/insights/{insight_guid}` | `vendor_native` | `financial.analytics.intelligence.unresolved` | `control` | Financial insight/profile, not AML monitoring or approved creditworthiness. |
| `mx:listManagedMembers` | `GET /users/{user_guid}/managed_members` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | User/member, credentials, aggregation, challenge, widget, token or notification lifecycle; not a person identity result. |
| `mx:createManagedMember` | `POST /users/{user_guid}/managed_members` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | User/member, credentials, aggregation, challenge, widget, token or notification lifecycle; not a person identity result. |
| `mx:deleteManagedMember` | `DELETE /users/{user_guid}/managed_members/{member_guid}` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | User/member, credentials, aggregation, challenge, widget, token or notification lifecycle; not a person identity result. |
| `mx:readManagedMember` | `GET /users/{user_guid}/managed_members/{member_guid}` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | User/member, credentials, aggregation, challenge, widget, token or notification lifecycle; not a person identity result. |
| `mx:updateManagedMember` | `PUT /users/{user_guid}/managed_members/{member_guid}` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | User/member, credentials, aggregation, challenge, widget, token or notification lifecycle; not a person identity result. |
| `mx:listManagedAccounts` | `GET /users/{user_guid}/managed_members/{member_guid}/accounts` | `vendor_native` | `account.profile.intelligence.unresolved` | `retrieve` | Account metadata/resource lifecycle; manual account creation is not external corroboration. |
| `mx:createManagedAccount` | `POST /users/{user_guid}/managed_members/{member_guid}/accounts` | `vendor_native` | `account.profile.intelligence.unresolved` | `control` | Account metadata/resource lifecycle; manual account creation is not external corroboration. |
| `mx:deleteManagedAccount` | `DELETE /users/{user_guid}/managed_members/{member_guid}/accounts/{account_guid}` | `vendor_native` | `account.profile.intelligence.unresolved` | `control` | Account metadata/resource lifecycle; manual account creation is not external corroboration. |
| `mx:readManagedAccount` | `GET /users/{user_guid}/managed_members/{member_guid}/accounts/{account_guid}` | `vendor_native` | `account.profile.intelligence.unresolved` | `retrieve` | Account metadata/resource lifecycle; manual account creation is not external corroboration. |
| `mx:updateManagedAccount` | `PUT /users/{user_guid}/managed_members/{member_guid}/accounts/{account_guid}` | `vendor_native` | `account.profile.intelligence.unresolved` | `control` | Account metadata/resource lifecycle; manual account creation is not external corroboration. |
| `mx:listManagedTransactions` | `GET /users/{user_guid}/managed_members/{member_guid}/accounts/{account_guid}/transactions` | `vendor_native` | `financial.transactions.intelligence.unresolved` | `retrieve` | Financial transactions/enrichment/manual edits; manually edited values retain user-supplied provenance. |
| `mx:createManagedTransaction` | `POST /users/{user_guid}/managed_members/{member_guid}/accounts/{account_guid}/transactions` | `vendor_native` | `financial.transactions.intelligence.unresolved` | `control` | Financial transactions/enrichment/manual edits; manually edited values retain user-supplied provenance. |
| `mx:deleteManagedTransaction` | `DELETE /users/{user_guid}/managed_members/{member_guid}/accounts/{account_guid}/transactions/{transaction_guid}` | `vendor_native` | `financial.transactions.intelligence.unresolved` | `control` | Financial transactions/enrichment/manual edits; manually edited values retain user-supplied provenance. |
| `mx:readManagedTransaction` | `GET /users/{user_guid}/managed_members/{member_guid}/accounts/{account_guid}/transactions/{transaction_guid}` | `vendor_native` | `financial.transactions.intelligence.unresolved` | `retrieve` | Financial transactions/enrichment/manual edits; manually edited values retain user-supplied provenance. |
| `mx:updateManagedTransaction` | `PUT /users/{user_guid}/managed_members/{member_guid}/accounts/{account_guid}/transactions/{transaction_guid}` | `vendor_native` | `financial.transactions.intelligence.unresolved` | `control` | Financial transactions/enrichment/manual edits; manually edited values retain user-supplied provenance. |
| `mx:listMembers` | `GET /users/{user_identifier}/members` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | User/member, credentials, aggregation, challenge, widget, token or notification lifecycle; not a person identity result. |
| `mx:createMember` | `POST /users/{user_identifier}/members` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | User/member, credentials, aggregation, challenge, widget, token or notification lifecycle; not a person identity result. |
| `mx:deleteMember` | `DELETE /users/{user_identifier}/members/{member_identifier}` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | User/member, credentials, aggregation, challenge, widget, token or notification lifecycle; not a person identity result. |
| `mx:readMember` | `GET /users/{user_identifier}/members/{member_identifier}` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | User/member, credentials, aggregation, challenge, widget, token or notification lifecycle; not a person identity result. |
| `mx:updateMember` | `PUT /users/{user_identifier}/members/{member_identifier}` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | User/member, credentials, aggregation, challenge, widget, token or notification lifecycle; not a person identity result. |
| `mx:listAccountNumbersByMember` | `GET /users/{user_guid}/members/{member_guid}/account_numbers` | `vendor_native` | `account.profile.intelligence.unresolved` | `retrieve` | Account metadata/resource lifecycle; manual account creation is not external corroboration. |
| `mx:listAccountOwnersByMember` | `GET /users/{user_identifier}/members/{member_identifier}/account_owners` | `vendor_native` | `account.profile.intelligence.unresolved` | `retrieve` | Holder details only; require a separate evidenced ownership comparison. |
| `mx:listMemberAccounts` | `GET /users/{user_identifier}/members/{member_identifier}/accounts` | `vendor_native` | `account.profile.intelligence.unresolved` | `retrieve` | Account metadata/resource lifecycle; manual account creation is not external corroboration. |
| `mx:readAccountByMember` | `GET /users/{user_identifier}/members/{member_identifier}/accounts/{account_identifier}` | `vendor_native` | `account.profile.intelligence.unresolved` | `retrieve` | Account metadata/resource lifecycle; manual account creation is not external corroboration. |
| `mx:updateAccountByMember` | `PUT /users/{user_identifier}/members/{member_identifier}/accounts/{account_identifier}` | `vendor_native` | `account.profile.intelligence.unresolved` | `control` | Account metadata/resource lifecycle; manual account creation is not external corroboration. |
| `mx:aggregateMember` | `POST /users/{user_identifier}/members/{member_identifier}/aggregate` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | User/member, credentials, aggregation, challenge, widget, token or notification lifecycle; not a person identity result. |
| `mx:listMemberChallenges` | `GET /users/{user_identifier}/members/{member_identifier}/challenges` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | User/member, credentials, aggregation, challenge, widget, token or notification lifecycle; not a person identity result. |
| `mx:checkBalances` | `POST /users/{user_identifier}/members/{member_identifier}/check_balance` | `vendor_native` | `financial.balance.intelligence.unresolved` | `submit` | Balance acquisition; preserve timestamp and asynchronous state. |
| `mx:listMemberCredentials` | `GET /users/{user_identifier}/members/{member_identifier}/credentials` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | User/member, credentials, aggregation, challenge, widget, token or notification lifecycle; not a person identity result. |
| `mx:extendHistory` | `POST /users/{user_identifier}/members/{member_identifier}/extend_history` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | User/member, credentials, aggregation, challenge, widget, token or notification lifecycle; not a person identity result. |
| `mx:fetchStatements` | `POST /users/{user_identifier}/members/{member_identifier}/fetch_statements` | `vendor_native` | `financial.evidence.intelligence.unresolved` | `submit` | Statements/holdings lifecycle; control success is not a completed financial finding. |
| `mx:listHoldingsByMember` | `GET /users/{user_guid}/members/{member_guid}/investment_holdings` | `vendor_native` | `financial.evidence.intelligence.unresolved` | `retrieve` | Statements/holdings lifecycle; control success is not a completed financial finding. |
| `mx:listHoldings` | `GET /users/{user_guid}/investment_holdings` | `vendor_native` | `financial.evidence.intelligence.unresolved` | `retrieve` | Statements/holdings lifecycle; control success is not a completed financial finding. |
| `mx:readHolding` | `GET /users/{user_guid}/investment_holdings/{holding_guid}` | `vendor_native` | `financial.evidence.intelligence.unresolved` | `retrieve` | Statements/holdings lifecycle; control success is not a completed financial finding. |
| `mx:listHoldingsByAccount` | `GET /users/{user_guid}/accounts/{account_guid}/investment_holdings` | `vendor_native` | `financial.evidence.intelligence.unresolved` | `retrieve` | Statements/holdings lifecycle; control success is not a completed financial finding. |
| `mx:deactivateUser` | `GET /users/{user_guid}/investment_holdings_deactivate` | `vendor_native` | `financial.evidence.intelligence.unresolved` | `retrieve` | Statements/holdings lifecycle; control success is not a completed financial finding. |
| `mx:identifyMember` | `POST /users/{user_identifier}/members/{member_identifier}/identify` | `vendor_native` | `account.profile.intelligence.unresolved` | `submit` | Initiates holder-data collection; not an input-to-holder match. |
| `mx:requestOAuthWindowURI` | `GET /users/{user_identifier}/members/{member_identifier}/oauth_window_uri` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | User/member, credentials, aggregation, challenge, widget, token or notification lifecycle; not a person identity result. |
| `mx:resumeAggregation` | `PUT /users/{user_identifier}/members/{member_identifier}/resume` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | User/member, credentials, aggregation, challenge, widget, token or notification lifecycle; not a person identity result. |
| `mx:listStatementsByMember` | `GET /users/{user_guid}/members/{member_guid}/statements` | `vendor_native` | `financial.evidence.intelligence.unresolved` | `retrieve` | Statements/holdings lifecycle; control success is not a completed financial finding. |
| `mx:readStatementByMember` | `GET /users/{user_guid}/members/{member_guid}/statements/{statement_guid}` | `vendor_native` | `financial.evidence.intelligence.unresolved` | `retrieve` | Statements/holdings lifecycle; control success is not a completed financial finding. |
| `mx:downloadStatementPDF` | `GET /users/{user_guid}/members/{member_guid}/statements/{statement_guid}.pdf` | `vendor_native` | `financial.evidence.intelligence.unresolved` | `retrieve` | Statements/holdings lifecycle; control success is not a completed financial finding. |
| `mx:readMemberStatus` | `GET /users/{user_identifier}/members/{member_identifier}/status` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | User/member, credentials, aggregation, challenge, widget, token or notification lifecycle; not a person identity result. |
| `mx:listTransactionsByMember` | `GET /users/{user_identifier}/members/{member_identifier}/transactions` | `vendor_native` | `financial.transactions.intelligence.unresolved` | `retrieve` | Financial transactions/enrichment/manual edits; manually edited values retain user-supplied provenance. |
| `mx:verifyMember` | `POST /users/{user_identifier}/members/{member_identifier}/verify` | `vendor_native` | `account.control.intelligence.unresolved` | `submit` | Account control/microdeposit verification; no name-to-holder comparison is established. |
| `mx:createSpendingPlanIterationItem` | `POST /users/{user_guid}/spending_plans/{spending_plan_guid}/iterations/current/iteration_items` | `vendor_native` | `financial.personal_management.intelligence.unresolved` | `control` | Personal-finance/catalog/resource function; not AML intelligence. |
| `mx:listSpendingPlanIterationItems` | `GET /users/{user_guid}/spending_plans/{spending_plan_guid}/iterations/current/iteration_items` | `vendor_native` | `financial.personal_management.intelligence.unresolved` | `retrieve` | Personal-finance/catalog/resource function; not AML intelligence. |
| `mx:createSpendingPlan` | `POST /users/{user_guid}/spending_plans` | `vendor_native` | `financial.personal_management.intelligence.unresolved` | `control` | Personal-finance/catalog/resource function; not AML intelligence. |
| `mx:listSpendingPlans` | `GET /users/{user_guid}/spending_plans` | `vendor_native` | `financial.personal_management.intelligence.unresolved` | `retrieve` | Personal-finance/catalog/resource function; not AML intelligence. |
| `mx:deleteSpendingPlanAccount` | `DELETE /users/{user_guid}/spending_plans/{spending_plan_guid}/spending_plan_accounts/{spending_plan_account_guid}` | `vendor_native` | `financial.personal_management.intelligence.unresolved` | `control` | Personal-finance/catalog/resource function; not AML intelligence. |
| `mx:readSpendingPlanAccount` | `GET /users/{user_guid}/spending_plans/{spending_plan_guid}/spending_plan_accounts/{spending_plan_account_guid}` | `vendor_native` | `financial.personal_management.intelligence.unresolved` | `retrieve` | Personal-finance/catalog/resource function; not AML intelligence. |
| `mx:deleteSpendingPlanIterationItem` | `DELETE /users/{user_guid}/spending_plans/{spending_plan_guid}/iterations/current/iteration_items/{iteration_item_guid}` | `vendor_native` | `financial.personal_management.intelligence.unresolved` | `control` | Personal-finance/catalog/resource function; not AML intelligence. |
| `mx:readSpendingPlanIterationItem` | `GET /users/{user_guid}/spending_plans/{spending_plan_guid}/iterations/current/iteration_items/{iteration_item_guid}` | `vendor_native` | `financial.personal_management.intelligence.unresolved` | `retrieve` | Personal-finance/catalog/resource function; not AML intelligence. |
| `mx:updateSpendingPlanIterationItem` | `PUT /users/{user_guid}/spending_plans/{spending_plan_guid}/iterations/current/iteration_items/{iteration_item_guid}` | `vendor_native` | `financial.personal_management.intelligence.unresolved` | `control` | Personal-finance/catalog/resource function; not AML intelligence. |
| `mx:deleteSpendingPlan` | `DELETE /users/{user_guid}/spending_plans/{spending_plan_guid}` | `vendor_native` | `financial.personal_management.intelligence.unresolved` | `control` | Personal-finance/catalog/resource function; not AML intelligence. |
| `mx:readSpendingPlanUser` | `GET /users/{user_guid}/spending_plans/{spending_plan_guid}` | `vendor_native` | `financial.personal_management.intelligence.unresolved` | `retrieve` | Personal-finance/catalog/resource function; not AML intelligence. |
| `mx:listSpendingPlanAccounts` | `GET /users/{user_guid}/spending_plans/{spending_plan_guid}/spending_plan_accounts` | `vendor_native` | `financial.personal_management.intelligence.unresolved` | `retrieve` | Personal-finance/catalog/resource function; not AML intelligence. |
| `mx:listSpendingPlanIterations` | `GET /users/{user_guid}/spending_plans/{spending_plan_guid}/iterations` | `vendor_native` | `financial.personal_management.intelligence.unresolved` | `retrieve` | Personal-finance/catalog/resource function; not AML intelligence. |
| `mx:readCurrentSpendingPlanIteration` | `GET /users/{user_guid}/spending_plans/{spending_plan_guid}/iterations/current` | `vendor_native` | `financial.personal_management.intelligence.unresolved` | `retrieve` | Personal-finance/catalog/resource function; not AML intelligence. |
| `mx:readSpendingPlanIteration` | `GET /users/{user_guid}/spending_plans/{spending_plan_guid}/iterations/{iteration_number}` | `vendor_native` | `financial.personal_management.intelligence.unresolved` | `retrieve` | Personal-finance/catalog/resource function; not AML intelligence. |
| `mx:listTaggings` | `GET /users/{user_guid}/taggings` | `vendor_native` | `financial.personal_management.intelligence.unresolved` | `retrieve` | Personal-finance/catalog/resource function; not AML intelligence. |
| `mx:createTagging` | `POST /users/{user_guid}/taggings` | `vendor_native` | `financial.personal_management.intelligence.unresolved` | `control` | Personal-finance/catalog/resource function; not AML intelligence. |
| `mx:deleteTagging` | `DELETE /users/{user_guid}/taggings/{tagging_guid}` | `vendor_native` | `financial.personal_management.intelligence.unresolved` | `control` | Personal-finance/catalog/resource function; not AML intelligence. |
| `mx:readTagging` | `GET /users/{user_guid}/taggings/{tagging_guid}` | `vendor_native` | `financial.personal_management.intelligence.unresolved` | `retrieve` | Personal-finance/catalog/resource function; not AML intelligence. |
| `mx:updateTagging` | `PUT /users/{user_guid}/taggings/{tagging_guid}` | `vendor_native` | `financial.personal_management.intelligence.unresolved` | `control` | Personal-finance/catalog/resource function; not AML intelligence. |
| `mx:listTags` | `GET /users/{user_guid}/tags` | `vendor_native` | `financial.personal_management.intelligence.unresolved` | `retrieve` | Personal-finance/catalog/resource function; not AML intelligence. |
| `mx:createTag` | `POST /users/{user_guid}/tags` | `vendor_native` | `financial.personal_management.intelligence.unresolved` | `control` | Personal-finance/catalog/resource function; not AML intelligence. |
| `mx:deleteTag` | `DELETE /users/{user_guid}/tags/{tag_guid}` | `vendor_native` | `financial.personal_management.intelligence.unresolved` | `control` | Personal-finance/catalog/resource function; not AML intelligence. |
| `mx:readTag` | `GET /users/{user_guid}/tags/{tag_guid}` | `vendor_native` | `financial.personal_management.intelligence.unresolved` | `retrieve` | Personal-finance/catalog/resource function; not AML intelligence. |
| `mx:updateTag` | `PUT /users/{user_guid}/tags/{tag_guid}` | `vendor_native` | `financial.personal_management.intelligence.unresolved` | `control` | Personal-finance/catalog/resource function; not AML intelligence. |
| `mx:listTransactionsByTag` | `GET /users/{user_identifier}/tags/{tag_guid}/transactions` | `vendor_native` | `financial.personal_management.intelligence.unresolved` | `retrieve` | Personal-finance/catalog/resource function; not AML intelligence. |
| `mx:listTransactionRules` | `GET /users/{user_guid}/transaction_rules` | `vendor_native` | `financial.personal_management.intelligence.unresolved` | `retrieve` | Personal-finance/catalog/resource function; not AML intelligence. |
| `mx:createTransactionRule` | `POST /users/{user_guid}/transaction_rules` | `vendor_native` | `financial.personal_management.intelligence.unresolved` | `control` | Personal-finance/catalog/resource function; not AML intelligence. |
| `mx:deleteTransactionRule` | `DELETE /users/{user_guid}/transaction_rules/{transaction_rule_guid}` | `vendor_native` | `financial.personal_management.intelligence.unresolved` | `control` | Personal-finance/catalog/resource function; not AML intelligence. |
| `mx:readTransactionRule` | `GET /users/{user_guid}/transaction_rules/{transaction_rule_guid}` | `vendor_native` | `financial.personal_management.intelligence.unresolved` | `retrieve` | Personal-finance/catalog/resource function; not AML intelligence. |
| `mx:updateTransactionRule` | `PUT /users/{user_guid}/transaction_rules/{transaction_rule_guid}` | `vendor_native` | `financial.personal_management.intelligence.unresolved` | `control` | Personal-finance/catalog/resource function; not AML intelligence. |
| `mx:listTransactions` | `GET /users/{user_identifier}/transactions` | `vendor_native` | `financial.transactions.intelligence.unresolved` | `retrieve` | Financial transactions/enrichment/manual edits; manually edited values retain user-supplied provenance. |
| `mx:readTransaction` | `GET /users/{user_guid}/transactions/{transaction_guid}` | `vendor_native` | `financial.transactions.intelligence.unresolved` | `retrieve` | Financial transactions/enrichment/manual edits; manually edited values retain user-supplied provenance. |
| `mx:updateTransaction` | `PUT /users/{user_guid}/transactions/{transaction_guid}` | `vendor_native` | `financial.transactions.intelligence.unresolved` | `control` | Financial transactions/enrichment/manual edits; manually edited values retain user-supplied provenance. |
| `mx:deleteManualTransactions` | `DELETE /users/{user_guid}/transactions/{transaction_guid}` | `vendor_native` | `financial.transactions.intelligence.unresolved` | `control` | Financial transactions/enrichment/manual edits; manually edited values retain user-supplied provenance. |
| `mx:readTransactionByAccount` | `GET /users/{user_identifier}/members/{member_identifier}/accounts/{account_identifier}/transactions/{transaction_identifier}` | `vendor_native` | `financial.transactions.intelligence.unresolved` | `retrieve` | Financial transactions/enrichment/manual edits; manually edited values retain user-supplied provenance. |
| `mx:updateTransactionByAccount` | `PUT /users/{user_identifier}/members/{member_identifier}/accounts/{account_identifier}/transactions/{transaction_identifier}` | `vendor_native` | `financial.transactions.intelligence.unresolved` | `control` | Financial transactions/enrichment/manual edits; manually edited values retain user-supplied provenance. |
| `mx:requestWidgetURL` | `POST /users/{user_guid}/widget_urls` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | User/member, credentials, aggregation, challenge, widget, token or notification lifecycle; not a person identity result. |
| `mx:autoGenerateBudgets` | `POST /users/{user_guid}/budgets/generate` | `vendor_native` | `financial.personal_management.intelligence.unresolved` | `control` | Personal-finance/catalog/resource function; not AML intelligence. |
| `mx:createBudget` | `POST /users/{user_guid}/budgets` | `vendor_native` | `financial.personal_management.intelligence.unresolved` | `control` | Personal-finance/catalog/resource function; not AML intelligence. |
| `mx:listAllBudgets` | `GET /users/{user_guid}/budgets` | `vendor_native` | `financial.personal_management.intelligence.unresolved` | `retrieve` | Personal-finance/catalog/resource function; not AML intelligence. |
| `mx:readSpecificBudget` | `GET /users/{user_guid}/budgets/{budget_guid}` | `vendor_native` | `financial.personal_management.intelligence.unresolved` | `retrieve` | Personal-finance/catalog/resource function; not AML intelligence. |
| `mx:updateSpecificBudget` | `PUT /users/{user_guid}/budgets/{budget_guid}` | `vendor_native` | `financial.personal_management.intelligence.unresolved` | `control` | Personal-finance/catalog/resource function; not AML intelligence. |
| `mx:deleteBudget` | `DELETE /users/{user_guid}/budgets/{budget_guid}` | `vendor_native` | `financial.personal_management.intelligence.unresolved` | `control` | Personal-finance/catalog/resource function; not AML intelligence. |
| `mx:createGoal` | `POST /users/{user_guid}/goals` | `vendor_native` | `financial.personal_management.intelligence.unresolved` | `control` | Personal-finance/catalog/resource function; not AML intelligence. |
| `mx:listGoals` | `GET /users/{user_guid}/goals` | `vendor_native` | `financial.personal_management.intelligence.unresolved` | `retrieve` | Personal-finance/catalog/resource function; not AML intelligence. |
| `mx:deleteGoal` | `DELETE /users/{user_guid}/goals/{goal_guid}` | `vendor_native` | `financial.personal_management.intelligence.unresolved` | `control` | Personal-finance/catalog/resource function; not AML intelligence. |
| `mx:readGoal` | `GET /users/{user_guid}/goals/{goal_guid}` | `vendor_native` | `financial.personal_management.intelligence.unresolved` | `retrieve` | Personal-finance/catalog/resource function; not AML intelligence. |
| `mx:updateGoal` | `PUT /users/{user_guid}/goals/{goal_guid}` | `vendor_native` | `financial.personal_management.intelligence.unresolved` | `control` | Personal-finance/catalog/resource function; not AML intelligence. |
| `mx:repositionGoals` | `PUT /users/{user_guid}/goals/reposition` | `vendor_native` | `financial.personal_management.intelligence.unresolved` | `control` | Personal-finance/catalog/resource function; not AML intelligence. |
| `mx:createNotification` | `POST /users/{user_guid}/notifications` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | User/member, credentials, aggregation, challenge, widget, token or notification lifecycle; not a person identity result. |
| `mx:listNotifications` | `GET /users/{user_guid}/notifications` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | User/member, credentials, aggregation, challenge, widget, token or notification lifecycle; not a person identity result. |
| `mx:readNotifications` | `GET /users/{user_guid}/notifications/{notification_guid}` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | User/member, credentials, aggregation, challenge, widget, token or notification lifecycle; not a person identity result. |
| `mx:repeatingTransactions` | `GET /users/{user_guid}/repeating_transactions` | `vendor_native` | `financial.transactions.intelligence.unresolved` | `retrieve` | Financial transactions/enrichment/manual edits; manually edited values retain user-supplied provenance. |
| `mx:specificRepeatingTransaction` | `GET /users/{user_guid}/repeating_transactions/{repeating_transaction_guid}` | `vendor_native` | `financial.transactions.intelligence.unresolved` | `retrieve` | Financial transactions/enrichment/manual edits; manually edited values retain user-supplied provenance. |
| `mx:listInsightsByTransaction` | `GET /users/{user_guid}/transactions/{transaction_guid}/insights` | `vendor_native` | `financial.analytics.intelligence.unresolved` | `retrieve` | Financial insight/profile, not AML monitoring or approved creditworthiness. |
| `mx:deleteSplitTransactions` | `DELETE /users/{user_guid}/transactions/{transaction_guid}/split` | `vendor_native` | `financial.transactions.intelligence.unresolved` | `control` | Financial transactions/enrichment/manual edits; manually edited values retain user-supplied provenance. |
| `mx:createSplitTransactions` | `POST /users/{user_guid}/transactions/{transaction_guid}/split` | `vendor_native` | `financial.transactions.intelligence.unresolved` | `control` | Financial transactions/enrichment/manual edits; manually edited values retain user-supplied provenance. |
| `mx:deleteSplitTransactionByAccount` | `DELETE /users/{user_identifier}/members/{member_identifier}/accounts/{account_identifier}/transactions/{transaction_identifier}/split` | `vendor_native` | `financial.transactions.intelligence.unresolved` | `control` | Financial transactions/enrichment/manual edits; manually edited values retain user-supplied provenance. |
| `mx:createSplitTransactionsByAccount` | `POST /users/{user_identifier}/members/{member_identifier}/accounts/{account_identifier}/transactions/{transaction_identifier}/split` | `vendor_native` | `financial.transactions.intelligence.unresolved` | `control` | Financial transactions/enrichment/manual edits; manually edited values retain user-supplied provenance. |
| `mx:readMonthlyCashFlowProfile` | `GET /users/{user_identifier}/monthly_cash_flow_profile` | `vendor_native` | `financial.analytics.intelligence.unresolved` | `retrieve` | Financial insight/profile, not AML monitoring or approved creditworthiness. |
| `mx:updateMonthlyCashFlowProfile` | `PUT /users/{user_identifier}/monthly_cash_flow_profile` | `vendor_native` | `financial.analytics.intelligence.unresolved` | `control` | Financial insight/profile, not AML monitoring or approved creditworthiness. |
| `mx:listTokens` | `GET /tokens` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | User/member, credentials, aggregation, challenge, widget, token or notification lifecycle; not a person identity result. |
| `mx:requestAccountNumber` | `GET /account/account_numbers` | `vendor_native` | `account.profile.intelligence.unresolved` | `retrieve` | Account metadata/resource lifecycle; manual account creation is not external corroboration. |
| `mx:checkRealTimeAccountBalance` | `POST /account/check_balance` | `vendor_native` | `financial.balance.intelligence.unresolved` | `submit` | Balance acquisition; preserve timestamp and asynchronous state. |
| `mx:getAccountOwnerInfo` | `GET /account/transactions` | `vendor_native` | `account.profile.intelligence.unresolved` | `retrieve` | Holder details only; require a separate evidenced ownership comparison. |
| `mx:listUserMicrodeposits` | `GET /users/{user_guid}/micro_deposits` | `vendor_native` | `account.control.intelligence.unresolved` | `retrieve` | Account control/microdeposit verification; no name-to-holder comparison is established. |
| `mx:createMicrodeposit` | `POST /users/{user_guid}/micro_deposits` | `vendor_native` | `account.control.intelligence.unresolved` | `submit` | Account control/microdeposit verification; no name-to-holder comparison is established. |
| `mx:deleteMicrodeposit` | `DELETE /users/{user_guid}/micro_deposits/{micro_deposit_guid}` | `vendor_native` | `account.control.intelligence.unresolved` | `control` | Account control/microdeposit verification; no name-to-holder comparison is established. |
| `mx:readUserMicrodeposit` | `GET /users/{user_guid}/micro_deposits/{micro_deposit_guid}` | `vendor_native` | `account.control.intelligence.unresolved` | `retrieve` | Account control/microdeposit verification; no name-to-holder comparison is established. |
| `mx:verifyMicrodeposit` | `PUT /micro_deposits/{micro_deposit_guid}/verify` | `vendor_native` | `account.control.intelligence.unresolved` | `validate` | Account control/microdeposit verification; no name-to-holder comparison is established. |
| `mx:listUserVerifications` | `GET /users/{user_guid}/account_verifications` | `vendor_native` | `account.control.intelligence.unresolved` | `retrieve` | Account control/microdeposit verification; no name-to-holder comparison is established. |
| `mx:fetchRewards` | `POST /users/{user_identifier}/members/{member_identifier}/fetch_rewards` | `vendor_native` | `financial.personal_management.intelligence.unresolved` | `control` | Personal-finance/catalog/resource function; not AML intelligence. |
| `mx:listRewards` | `GET /users/{user_guid}/members/{member_guid}/rewards` | `vendor_native` | `financial.personal_management.intelligence.unresolved` | `retrieve` | Personal-finance/catalog/resource function; not AML intelligence. |
| `mx:readRewards` | `GET /users/{user_guid}/members/{member_guid}/rewards/{reward_guid}` | `vendor_native` | `financial.personal_management.intelligence.unresolved` | `retrieve` | Personal-finance/catalog/resource function; not AML intelligence. |
| `mx:creditCard` | `GET /credit_card_products/{credit_card_product_guid}` | `vendor_native` | `financial.personal_management.intelligence.unresolved` | `retrieve` | Personal-finance/catalog/resource function; not AML intelligence. |
| `mx:getIdentityData` | `GET /vc/users/{user_guid}/members/{member_guid}/customers` | `vendor_native` | `account.profile.intelligence.unresolved` | `retrieve` | Holder details only; require a separate evidenced ownership comparison. |
| `mx:getAccountsData` | `GET /vc/users/{user_guid}/members/{member_guid}/accounts` | `vendor_native` | `account.profile.intelligence.unresolved` | `retrieve` | Account metadata/resource lifecycle; manual account creation is not external corroboration. |
| `mx:getTransactionsData` | `GET /vc/users/{user_guid}/accounts/{account_guid}/transactions` | `vendor_native` | `financial.transactions.intelligence.unresolved` | `retrieve` | Financial transactions/enrichment/manual edits; manually edited values retain user-supplied provenance. |

### C.22 `namescan` — 10 operations

Provider record: `namescan`. Native version: `3.1`. Maturity: `implemented_unverified`. Live tested: `false`.  
Source: [definition JSON](../api-wiring/vendor_connections/definitions/namescan.json).

| Native operation ID | Method / path | Original semantics | Proposed canonical capability ID | Role | Mapping rationale / unresolved requirement |
| --- | --- | --- | --- | --- | --- |
| `namescan:create_person_emerald` | `POST /v3.1/person-scans/emerald` | `screening` | `screening.watchlist.intelligence.unresolved` | `screen` | Program/product/dataset determines categories; split atomic results only with mapped evidence. |
| `namescan:get_person_emerald` | `GET /v3.1/person-scans/emerald/{scanId}` | `screening` | `screening.watchlist.intelligence.unresolved` | `screen` | Program/product/dataset determines categories; split atomic results only with mapped evidence. |
| `namescan:create_person_sapphire` | `POST /v3.1/person-scans/sapphire` | `screening` | `screening.watchlist.intelligence.unresolved` | `screen` | Program/product/dataset determines categories; split atomic results only with mapped evidence. |
| `namescan:get_person_sapphire` | `GET /v3.1/person-scans/sapphire/{scanId}` | `screening` | `screening.watchlist.intelligence.unresolved` | `screen` | Program/product/dataset determines categories; split atomic results only with mapped evidence. |
| `namescan:person_risk_check` | `POST /v3.1/risk-check/person` | `risk` | `risk.customer.intelligence.unresolved` | `assess` | Program/product/dataset determines categories; split atomic results only with mapped evidence. |
| `namescan:create_organisation_emerald` | `POST /v3.1/organisation-scans/emerald` | `screening` | `screening.watchlist.intelligence.unresolved` | `screen` | Program/product/dataset determines categories; split atomic results only with mapped evidence. |
| `namescan:get_organisation_emerald` | `GET /v3.1/organisation-scans/emerald/{scanId}` | `screening` | `screening.watchlist.intelligence.unresolved` | `screen` | Program/product/dataset determines categories; split atomic results only with mapped evidence. |
| `namescan:create_organisation_sapphire` | `POST /v3.1/organisation-scans/sapphire` | `screening` | `screening.watchlist.intelligence.unresolved` | `screen` | Program/product/dataset determines categories; split atomic results only with mapped evidence. |
| `namescan:get_organisation_sapphire` | `GET /v3.1/organisation-scans/sapphire/{scanId}` | `screening` | `screening.watchlist.intelligence.unresolved` | `screen` | Program/product/dataset determines categories; split atomic results only with mapped evidence. |
| `namescan:organisation_risk_check` | `POST /v3.1/risk-check/organisation` | `risk` | `risk.customer.intelligence.unresolved` | `assess` | Program/product/dataset determines categories; split atomic results only with mapped evidence. |

### C.23 `ofac-sanctions-list-service` — 1 operations

Provider record: `ofac-sanctions-list-service`. Native version: `documented-public`. Maturity: `implemented_unverified`. Live tested: `false`.  
Source: [definition JSON](../api-wiring/vendor_connections/definitions/ofac-sanctions-list-service.json).

| Native operation ID | Method / path | Original semantics | Proposed canonical capability ID | Role | Mapping rationale / unresolved requirement |
| --- | --- | --- | --- | --- | --- |
| `ofac-sanctions-list-service:download_sdn` | `GET /api/PublicationPreview/exports/SDN.XML` | `dataset` | `reference.list.intelligence.us` | `ingest` | Publisher jurisdiction; not subject residence or screening clearance. |

### C.24 `opencorporates` — 2 operations

Provider record: `opencorporates`. Native version: `v0.4`. Maturity: `implemented_unverified`. Live tested: `false`.  
Source: [definition JSON](../api-wiring/vendor_connections/definitions/opencorporates.json).

| Native operation ID | Method / path | Original semantics | Proposed canonical capability ID | Role | Mapping rationale / unresolved requirement |
| --- | --- | --- | --- | --- | --- |
| `opencorporates:company_search` | `GET /v0.4/companies/search` | `business_data` | `business.registry.intelligence.unresolved` | `lookup` | Expand jurisdiction from the namespaced company identifier/selected registry; search may span jurisdictions. |
| `opencorporates:get_company` | `GET /v0.4/companies/{jurisdiction}/{company_number}` | `business_data` | `business.registry.intelligence.unresolved` | `lookup` | Expand jurisdiction from the namespaced company identifier/selected registry; search may span jurisdictions. |

### C.25 `opensanctions` — 12 operations

Provider record: `opensanctions`. Native version: `yente 5.5.0`. Maturity: `implemented_unverified`. Live tested: `false`.  
Source: [definition JSON](../api-wiring/vendor_connections/definitions/opensanctions.json).

| Native operation ID | Method / path | Original semantics | Proposed canonical capability ID | Role | Mapping rationale / unresolved requirement |
| --- | --- | --- | --- | --- | --- |
| `opensanctions:match_match__dataset__post` | `POST /match/{dataset}` | `screening` | `screening.watchlist.intelligence.unresolved` | `screen` | Dataset-conditional composite: do not assume the selected dataset is sanctions-only. |
| `opensanctions:search_search__dataset__get` | `GET /search/{dataset}` | `vendor_native` | `screening.watchlist.intelligence.unresolved` | `screen` | Dataset-conditional composite: do not assume the selected dataset is sanctions-only. |
| `opensanctions:fetch_entity_entities__entity_id__get` | `GET /entities/{entity_id}` | `vendor_native` | `entity.resolution.intelligence.unresolved` | `retrieve` | Source entities/relationships/statements; not a confirmed subject match or merge. |
| `opensanctions:Fetch_Adjacent_Entities__entities__entity_id__adjacent_get` | `GET /entities/{entity_id}/adjacent` | `vendor_native` | `entity.resolution.intelligence.unresolved` | `retrieve` | Source entities/relationships/statements; not a confirmed subject match or merge. |
| `opensanctions:Fetch_Adjacent_by_Property__entities__entity_id__adjacent__property_name__get` | `GET /entities/{entity_id}/adjacent/{property_name}` | `vendor_native` | `entity.resolution.intelligence.unresolved` | `retrieve` | Source entities/relationships/statements; not a confirmed subject match or merge. |
| `opensanctions:reconcile_reconcile__dataset__get` | `GET /reconcile/{dataset}` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Index health, catalog, algorithm, reconciliation-service metadata or index update; not a subject screening result. |
| `opensanctions:healthz_healthz_get` | `GET /healthz` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Index health, catalog, algorithm, reconciliation-service metadata or index update; not a subject screening result. |
| `opensanctions:readyz_readyz_get` | `GET /readyz` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Index health, catalog, algorithm, reconciliation-service metadata or index update; not a subject screening result. |
| `opensanctions:catalog_catalog_get` | `GET /catalog` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Index health, catalog, algorithm, reconciliation-service metadata or index update; not a subject screening result. |
| `opensanctions:algorithms_algorithms_get` | `GET /algorithms` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Index health, catalog, algorithm, reconciliation-service metadata or index update; not a subject screening result. |
| `opensanctions:force_update_updatez_post` | `POST /updatez` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Index health, catalog, algorithm, reconciliation-service metadata or index update; not a subject screening result. |
| `opensanctions:statements_statements_get` | `GET /statements` | `vendor_native` | `entity.resolution.intelligence.unresolved` | `retrieve` | Source entities/relationships/statements; not a confirmed subject match or merge. |

### C.26 `persona` — 2 operations

Provider record: `persona`. Native version: `2023-01-05`. Maturity: `implemented_unverified`. Live tested: `false`.  
Source: [definition JSON](../api-wiring/vendor_connections/definitions/persona.json).

| Native operation ID | Method / path | Original semantics | Proposed canonical capability ID | Role | Mapping rationale / unresolved requirement |
| --- | --- | --- | --- | --- | --- |
| `persona:get_inquiry` | `GET /api/v1/inquiries/{id}` | `identity_result` | `identity.person.intelligence.unresolved` | `retrieve` | Template controls which checks exist; session creation is pending, not verified. |
| `persona:create_inquiry` | `POST /api/v1/inquiries` | `session` | `identity.person.intelligence.unresolved` | `submit` | Template controls which checks exist; session creation is pending, not verified. |

### C.27 `plaid` — 99 operations

Provider record: `plaid`. Native version: `2020-09-14_1.762.0`. Maturity: `implemented_unverified`. Live tested: `false`.  
Source: [definition JSON](../api-wiring/vendor_connections/definitions/plaid.json).

| Native operation ID | Method / path | Original semantics | Proposed canonical capability ID | Role | Mapping rationale / unresolved requirement |
| --- | --- | --- | --- | --- | --- |
| `plaid:assetReportCreate` | `POST /asset_report/create` | `vendor_native` | `financial.evidence.intelligence.unresolved` | `submit` | Financial/asset-report artifact lifecycle; retain institution, period and permitted use. |
| `plaid:assetReportGet` | `POST /asset_report/get` | `vendor_native` | `financial.evidence.intelligence.unresolved` | `retrieve` | Financial/asset-report artifact lifecycle; retain institution, period and permitted use. |
| `plaid:assetReportPdfGet` | `POST /asset_report/pdf/get` | `vendor_native` | `financial.evidence.intelligence.unresolved` | `retrieve` | Financial/asset-report artifact lifecycle; retain institution, period and permitted use. |
| `plaid:assetReportRefresh` | `POST /asset_report/refresh` | `vendor_native` | `financial.evidence.intelligence.unresolved` | `submit` | Financial/asset-report artifact lifecycle; retain institution, period and permitted use. |
| `plaid:assetReportFilter` | `POST /asset_report/filter` | `vendor_native` | `financial.evidence.intelligence.unresolved` | `submit` | Financial/asset-report artifact lifecycle; retain institution, period and permitted use. |
| `plaid:assetReportRemove` | `POST /asset_report/remove` | `vendor_native` | `financial.evidence.intelligence.unresolved` | `control` | Financial/asset-report artifact lifecycle; retain institution, period and permitted use. |
| `plaid:assetReportAuditCopyCreate` | `POST /asset_report/audit_copy/create` | `vendor_native` | `financial.evidence.intelligence.unresolved` | `submit` | Financial/asset-report artifact lifecycle; retain institution, period and permitted use. |
| `plaid:assetReportAuditCopyGet` | `POST /asset_report/audit_copy/get` | `vendor_native` | `financial.evidence.intelligence.unresolved` | `retrieve` | Financial/asset-report artifact lifecycle; retain institution, period and permitted use. |
| `plaid:assetReportAuditCopyPdfGet` | `POST /asset_report/audit_copy/pdf/get` | `vendor_native` | `financial.evidence.intelligence.unresolved` | `retrieve` | Financial/asset-report artifact lifecycle; retain institution, period and permitted use. |
| `plaid:assetReportAuditCopyRemove` | `POST /asset_report/audit_copy/remove` | `vendor_native` | `financial.evidence.intelligence.unresolved` | `control` | Financial/asset-report artifact lifecycle; retain institution, period and permitted use. |
| `plaid:itemActivityList` | `POST /item/activity/list` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Link/item/user/token, permission/consent or webhook operation; no identity verification inferred. |
| `plaid:itemApplicationList` | `POST /item/application/list` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Link/item/user/token, permission/consent or webhook operation; no identity verification inferred. |
| `plaid:itemApplicationUnlink` | `POST /item/application/unlink` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Link/item/user/token, permission/consent or webhook operation; no identity verification inferred. |
| `plaid:itemApplicationScopesUpdate` | `POST /item/application/scopes/update` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Link/item/user/token, permission/consent or webhook operation; no identity verification inferred. |
| `plaid:itemGet` | `POST /item/get` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Link/item/user/token, permission/consent or webhook operation; no identity verification inferred. |
| `plaid:authGet` | `POST /auth/get` | `vendor_native` | `account.profile.intelligence.unresolved` | `retrieve` | Account/routing credential/auth validation, not subject-to-holder ownership comparison. |
| `plaid:authVerify` | `POST /auth/verify` | `vendor_native` | `account.control.intelligence.unresolved` | `validate` | Account/routing credential/auth validation, not subject-to-holder ownership comparison. |
| `plaid:transactionsGet` | `POST /transactions/get` | `vendor_native` | `financial.transactions.intelligence.unresolved` | `retrieve` | Transaction retrieval/enrichment/refresh, not AML monitoring. |
| `plaid:transactionsRefresh` | `POST /transactions/refresh` | `vendor_native` | `financial.transactions.intelligence.unresolved` | `submit` | Transaction retrieval/enrichment/refresh, not AML monitoring. |
| `plaid:sandboxTransactionsCreate` | `POST /sandbox/transactions/create` | `vendor_native` | `platform.testing.intelligence.unresolved` | `simulate` | Synthetic/test operation only. |
| `plaid:transactionsRecurringGet` | `POST /transactions/recurring/get` | `vendor_native` | `financial.transactions.intelligence.unresolved` | `retrieve` | Transaction retrieval/enrichment/refresh, not AML monitoring. |
| `plaid:transactionsSync` | `POST /transactions/sync` | `vendor_native` | `financial.transactions.intelligence.unresolved` | `retrieve` | Transaction retrieval/enrichment/refresh, not AML monitoring. |
| `plaid:transactionsEnrich` | `POST /transactions/enrich` | `vendor_native` | `financial.transactions.intelligence.unresolved` | `retrieve` | Transaction retrieval/enrichment/refresh, not AML monitoring. |
| `plaid:userTransactionsRefresh` | `POST /user/transactions/refresh` | `vendor_native` | `financial.transactions.intelligence.unresolved` | `submit` | Transaction retrieval/enrichment/refresh, not AML monitoring. |
| `plaid:userFinancialDataRefresh` | `POST /user/financial_data/refresh` | `vendor_native` | `financial.evidence.intelligence.unresolved` | `submit` | Refresh financial data; no completed evidence result yet. |
| `plaid:institutionsGet` | `POST /institutions/get` | `vendor_native` | `financial.institution.intelligence.unresolved` | `lookup` | Institution catalog metadata; not customer evidence. |
| `plaid:institutionsSearch` | `POST /institutions/search` | `vendor_native` | `financial.institution.intelligence.unresolved` | `lookup` | Institution catalog metadata; not customer evidence. |
| `plaid:institutionsGetById` | `POST /institutions/get_by_id` | `vendor_native` | `financial.institution.intelligence.unresolved` | `lookup` | Institution catalog metadata; not customer evidence. |
| `plaid:itemRemove` | `POST /item/remove` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Link/item/user/token, permission/consent or webhook operation; no identity verification inferred. |
| `plaid:itemProductsTerminate` | `POST /item/products/terminate` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Link/item/user/token, permission/consent or webhook operation; no identity verification inferred. |
| `plaid:accountsGet` | `POST /accounts/get` | `vendor_native` | `account.profile.intelligence.unresolved` | `retrieve` | Account metadata, not ownership comparison. |
| `plaid:sandboxPublicTokenCreate` | `POST /sandbox/public_token/create` | `vendor_native` | `platform.testing.intelligence.unresolved` | `simulate` | Synthetic/test operation only. |
| `plaid:sandboxItemFireWebhook` | `POST /sandbox/item/fire_webhook` | `vendor_native` | `platform.testing.intelligence.unresolved` | `simulate` | Synthetic/test operation only. |
| `plaid:sandboxUserFireWebhook` | `POST /sandbox/user/fire_webhook` | `vendor_native` | `platform.testing.intelligence.unresolved` | `simulate` | Synthetic/test operation only. |
| `plaid:accountsBalanceGet` | `POST /accounts/balance/get` | `vendor_native` | `financial.balance.intelligence.unresolved` | `retrieve` | Timestamped balance evidence. |
| `plaid:identityGet` | `POST /identity/get` | `vendor_native` | `account.profile.intelligence.unresolved` | `retrieve` | Account-holder identity data alone does not compare the requested subject. |
| `plaid:identityDocumentsUploadsGet` | `POST /identity/documents/uploads/get` | `vendor_native` | `document.evidence.intelligence.unresolved` | `retrieve` | Uploaded-document evidence only. |
| `plaid:identityMatch` | `POST /identity/match` | `vendor_native` | `account.ownership.intelligence.unresolved` | `verify` | Per-field holder comparison, not a bank decision. |
| `plaid:identityMatchList` | `POST /identity/match/list` | `vendor_native` | `account.ownership.intelligence.unresolved` | `retrieve` | Per-field holder comparison, not a bank decision. |
| `plaid:identityRefresh` | `POST /identity/refresh` | `vendor_native` | `account.profile.intelligence.unresolved` | `submit` | Account-holder identity data alone does not compare the requested subject. |
| `plaid:identityVerificationCreate` | `POST /identity_verification/create` | `identity_result` | `identity.person.intelligence.unresolved` | `submit` | Identity-verification workflow; child check evidence remains explicit. |
| `plaid:identityVerificationGet` | `POST /identity_verification/get` | `identity_result` | `identity.person.intelligence.unresolved` | `retrieve` | Identity-verification workflow; child check evidence remains explicit. |
| `plaid:identityVerificationList` | `POST /identity_verification/list` | `identity_result` | `identity.person.intelligence.unresolved` | `retrieve` | Identity-verification workflow; child check evidence remains explicit. |
| `plaid:identityVerificationRetry` | `POST /identity_verification/retry` | `identity_result` | `identity.person.intelligence.unresolved` | `submit` | Identity-verification workflow; child check evidence remains explicit. |
| `plaid:watchlistScreeningEntityCreate` | `POST /watchlist_screening/entity/create` | `vendor_native` | `screening.watchlist.intelligence.unresolved` | `submit` | Composite configured watchlist categories; history and hits retain original run scope. |
| `plaid:watchlistScreeningEntityGet` | `POST /watchlist_screening/entity/get` | `vendor_native` | `screening.watchlist.intelligence.unresolved` | `retrieve` | Composite configured watchlist categories; history and hits retain original run scope. |
| `plaid:watchlistScreeningEntityHistoryList` | `POST /watchlist_screening/entity/history/list` | `vendor_native` | `screening.watchlist.intelligence.unresolved` | `retrieve` | Composite configured watchlist categories; history and hits retain original run scope. |
| `plaid:watchlistScreeningEntityHitList` | `POST /watchlist_screening/entity/hit/list` | `vendor_native` | `screening.watchlist.intelligence.unresolved` | `retrieve` | Composite configured watchlist categories; history and hits retain original run scope. |
| `plaid:watchlistScreeningEntityList` | `POST /watchlist_screening/entity/list` | `vendor_native` | `screening.watchlist.intelligence.unresolved` | `retrieve` | Composite configured watchlist categories; history and hits retain original run scope. |
| `plaid:watchlistScreeningEntityProgramGet` | `POST /watchlist_screening/entity/program/get` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Screening-program configuration metadata; not a checked subject. |
| `plaid:watchlistScreeningEntityProgramList` | `POST /watchlist_screening/entity/program/list` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Screening-program configuration metadata; not a checked subject. |
| `plaid:watchlistScreeningEntityReviewCreate` | `POST /watchlist_screening/entity/review/create` | `vendor_native` | `screening.watchlist.intelligence.unresolved` | `control` | Review/disposition change; do not produce a new screening outcome. |
| `plaid:watchlistScreeningEntityReviewList` | `POST /watchlist_screening/entity/review/list` | `vendor_native` | `screening.watchlist.intelligence.unresolved` | `retrieve` | Composite configured watchlist categories; history and hits retain original run scope. |
| `plaid:watchlistScreeningEntityUpdate` | `POST /watchlist_screening/entity/update` | `vendor_native` | `screening.watchlist.intelligence.unresolved` | `control` | Review/disposition change; do not produce a new screening outcome. |
| `plaid:watchlistScreeningIndividualCreate` | `POST /watchlist_screening/individual/create` | `vendor_native` | `screening.watchlist.intelligence.unresolved` | `submit` | Composite configured watchlist categories; history and hits retain original run scope. |
| `plaid:watchlistScreeningIndividualGet` | `POST /watchlist_screening/individual/get` | `vendor_native` | `screening.watchlist.intelligence.unresolved` | `retrieve` | Composite configured watchlist categories; history and hits retain original run scope. |
| `plaid:watchlistScreeningIndividualHistoryList` | `POST /watchlist_screening/individual/history/list` | `vendor_native` | `screening.watchlist.intelligence.unresolved` | `retrieve` | Composite configured watchlist categories; history and hits retain original run scope. |
| `plaid:watchlistScreeningIndividualHitList` | `POST /watchlist_screening/individual/hit/list` | `vendor_native` | `screening.watchlist.intelligence.unresolved` | `retrieve` | Composite configured watchlist categories; history and hits retain original run scope. |
| `plaid:watchlistScreeningIndividualList` | `POST /watchlist_screening/individual/list` | `vendor_native` | `screening.watchlist.intelligence.unresolved` | `retrieve` | Composite configured watchlist categories; history and hits retain original run scope. |
| `plaid:watchlistScreeningIndividualProgramGet` | `POST /watchlist_screening/individual/program/get` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Screening-program configuration metadata; not a checked subject. |
| `plaid:watchlistScreeningIndividualProgramList` | `POST /watchlist_screening/individual/program/list` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Screening-program configuration metadata; not a checked subject. |
| `plaid:watchlistScreeningIndividualReviewCreate` | `POST /watchlist_screening/individual/review/create` | `vendor_native` | `screening.watchlist.intelligence.unresolved` | `control` | Review/disposition change; do not produce a new screening outcome. |
| `plaid:watchlistScreeningIndividualReviewList` | `POST /watchlist_screening/individual/review/list` | `vendor_native` | `screening.watchlist.intelligence.unresolved` | `retrieve` | Composite configured watchlist categories; history and hits retain original run scope. |
| `plaid:watchlistScreeningIndividualUpdate` | `POST /watchlist_screening/individual/update` | `vendor_native` | `screening.watchlist.intelligence.unresolved` | `control` | Review/disposition change; do not produce a new screening outcome. |
| `plaid:identityVerificationAutofillCreate` | `POST /identity_verification/autofill/create` | `identity_result` | `identity.document.extraction.intelligence.unresolved` | `extract` | Autofill is not an identity verification result. |
| `plaid:itemWebhookUpdate` | `POST /item/webhook/update` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Link/item/user/token, permission/consent or webhook operation; no identity verification inferred. |
| `plaid:itemAccessTokenInvalidate` | `POST /item/access_token/invalidate` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Link/item/user/token, permission/consent or webhook operation; no identity verification inferred. |
| `plaid:sandboxItemResetLogin` | `POST /sandbox/item/reset_login` | `vendor_native` | `platform.testing.intelligence.unresolved` | `simulate` | Synthetic/test operation only. |
| `plaid:sandboxItemApplicationSeed` | `POST /sandbox/item/application/seed` | `vendor_native` | `platform.testing.intelligence.unresolved` | `simulate` | Synthetic/test operation only. |
| `plaid:sandboxFdxConsentSeed` | `POST /sandbox/fdx/consent/seed` | `vendor_native` | `platform.testing.intelligence.unresolved` | `simulate` | Synthetic/test operation only. |
| `plaid:sandboxItemSetVerificationStatus` | `POST /sandbox/item/set_verification_status` | `vendor_native` | `platform.testing.intelligence.unresolved` | `simulate` | Synthetic/test operation only. |
| `plaid:sandboxUserResetLogin` | `POST /sandbox/user/reset_login` | `vendor_native` | `platform.testing.intelligence.unresolved` | `simulate` | Synthetic/test operation only. |
| `plaid:itemPublicTokenExchange` | `POST /item/public_token/exchange` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Link/item/user/token, permission/consent or webhook operation; no identity verification inferred. |
| `plaid:itemCreatePublicToken` | `POST /item/public_token/create` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Link/item/user/token, permission/consent or webhook operation; no identity verification inferred. |
| `plaid:userCreate` | `POST /user/create` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Link/item/user/token, permission/consent or webhook operation; no identity verification inferred. |
| `plaid:userGet` | `POST /user/get` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Link/item/user/token, permission/consent or webhook operation; no identity verification inferred. |
| `plaid:userIdentityRemove` | `POST /user/identity/remove` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Link/item/user/token, permission/consent or webhook operation; no identity verification inferred. |
| `plaid:userUpdate` | `POST /user/update` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Link/item/user/token, permission/consent or webhook operation; no identity verification inferred. |
| `plaid:userRemove` | `POST /user/remove` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Link/item/user/token, permission/consent or webhook operation; no identity verification inferred. |
| `plaid:userProductsTerminate` | `POST /user/products/terminate` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Link/item/user/token, permission/consent or webhook operation; no identity verification inferred. |
| `plaid:userItemsGet` | `POST /user/items/get` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Link/item/user/token, permission/consent or webhook operation; no identity verification inferred. |
| `plaid:userItemsAssociate` | `POST /user/items/associate` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Link/item/user/token, permission/consent or webhook operation; no identity verification inferred. |
| `plaid:userItemsRemove` | `POST /user/items/remove` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Link/item/user/token, permission/consent or webhook operation; no identity verification inferred. |
| `plaid:userThirdPartyTokenCreate` | `POST /user/third_party_token/create` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Link/item/user/token, permission/consent or webhook operation; no identity verification inferred. |
| `plaid:userThirdPartyTokenRemove` | `POST /user/third_party_token/remove` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Link/item/user/token, permission/consent or webhook operation; no identity verification inferred. |
| `plaid:itemImport` | `POST /item/import` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Link/item/user/token, permission/consent or webhook operation; no identity verification inferred. |
| `plaid:linkTokenCreate` | `POST /link/token/create` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Link/item/user/token, permission/consent or webhook operation; no identity verification inferred. |
| `plaid:linkTokenGet` | `POST /link/token/get` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Link/item/user/token, permission/consent or webhook operation; no identity verification inferred. |
| `plaid:linkOauthCorrelationIdExchange` | `POST /link/oauth/correlation_id/exchange` | `vendor_native` | `platform.integration.intelligence.unresolved` | `control` | Link/item/user/token, permission/consent or webhook operation; no identity verification inferred. |
| `plaid:incomeVerificationCreate` | `POST /income/verification/create` | `vendor_native` | `financial.income.intelligence.unresolved` | `submit` | Income evidence/eligibility; deprecated operations remain disabled until product review. |
| `plaid:incomeVerificationPaystubsGet` | `POST /income/verification/paystubs/get` | `vendor_native` | `financial.income.intelligence.unresolved` | `retrieve` | Income evidence/eligibility; deprecated operations remain disabled until product review. |
| `plaid:incomeVerificationDocumentsDownload` | `POST /income/verification/documents/download` | `vendor_native` | `financial.income.intelligence.unresolved` | `retrieve` | Income evidence/eligibility; deprecated operations remain disabled until product review. |
| `plaid:incomeVerificationTaxformsGet` | `POST /income/verification/taxforms/get` | `vendor_native` | `financial.income.intelligence.unresolved` | `retrieve` | Income evidence/eligibility; deprecated operations remain disabled until product review. |
| `plaid:incomeVerificationPrecheck` | `POST /income/verification/precheck` | `vendor_native` | `financial.income.intelligence.unresolved` | `submit` | Income evidence/eligibility; deprecated operations remain disabled until product review. |
| `plaid:sandboxIncomeFireWebhook` | `POST /sandbox/income/fire_webhook` | `vendor_native` | `platform.testing.intelligence.unresolved` | `simulate` | Synthetic/test operation only. |
| `plaid:sandboxBankIncomeFireWebhook` | `POST /sandbox/bank_income/fire_webhook` | `vendor_native` | `platform.testing.intelligence.unresolved` | `simulate` | Synthetic/test operation only. |
| `plaid:sandboxCraCashflowUpdatesUpdate` | `POST /sandbox/cra/cashflow_updates/update` | `vendor_native` | `platform.testing.intelligence.unresolved` | `simulate` | Synthetic/test operation only. |
| `plaid:sandboxCraServicingSimulate` | `POST /sandbox/cra/servicing/simulate` | `vendor_native` | `platform.testing.intelligence.unresolved` | `simulate` | Synthetic/test operation only. |
| `plaid:sandboxOauthSelectAccounts` | `POST /sandbox/oauth/select_accounts` | `vendor_native` | `platform.testing.intelligence.unresolved` | `simulate` | Synthetic/test operation only. |

### C.28 `prembly` — 3 operations

Provider record: `prembly`. Native version: `documented-public`. Maturity: `implemented_unverified`. Live tested: `false`.  
Source: [definition JSON](../api-wiring/vendor_connections/definitions/prembly.json). Definition notes: The national-id source labels its example Zambia but documents /verification/gb/id. This country/path inconsistency is preserved, not interpreted as UK coverage. Confirm this product path with Prembly before submitting personal data.

| Native operation ID | Method / path | Original semantics | Proposed canonical capability ID | Role | Mapping rationale / unresolved requirement |
| --- | --- | --- | --- | --- | --- |
| `prembly:documented_national_id` | `POST /verification/gb/id` | `identity_data` | `identity.profile.intelligence.unresolved` | `retrieve` | BLOCKED: local definition says Zambia example versus /verification/gb/id path conflict; do not infer GB or ZM support. |
| `prembly:ghana_passport` | `POST /verification/gh/passport` | `identity_data` | `identity.person.intelligence.gh` | `verify` | Country-specific passport/source check; actual checked fields require a contract. |
| `prembly:company_search` | `POST /identitypass/verification/global/company/search_with_string` | `business_data` | `business.registry.intelligence.unresolved` | `lookup` | Global in a path is not proven all-country coverage. |

### C.29 `prh` — 1 operations

Provider record: `prh`. Native version: `v3`. Maturity: `implemented_unverified`. Live tested: `false`.  
Source: [definition JSON](../api-wiring/vendor_connections/definitions/prh.json).

| Native operation ID | Method / path | Original semantics | Proposed canonical capability ID | Role | Mapping rationale / unresolved requirement |
| --- | --- | --- | --- | --- | --- |
| `prh:search_companies` | `GET /opendata-ytj-api/v3/companies` | `business_data` | `business.registry.intelligence.fi` | `lookup` | National-source scope; SEC operation returns issuer filings, not all private businesses. |

### C.30 `sec-edgar` — 1 operations

Provider record: `sec-edgar`. Native version: `documented-public`. Maturity: `implemented_unverified`. Live tested: `false`.  
Source: [definition JSON](../api-wiring/vendor_connections/definitions/sec-edgar.json). Definition notes: USER_AGENT must identify organization and contact email. Zero-pad CIK to 10 digits. SEC rate/fair-access rules apply.

| Native operation ID | Method / path | Original semantics | Proposed canonical capability ID | Role | Mapping rationale / unresolved requirement |
| --- | --- | --- | --- | --- | --- |
| `sec-edgar:submissions` | `GET /submissions/CIK{cik}.json` | `business_data` | `business.registry.intelligence.us` | `lookup` | National-source scope; SEC operation returns issuer filings, not all private businesses. |

### C.31 `seon` — 2 operations

Provider record: `seon`. Native version: `documented-public`. Maturity: `implemented_unverified`. Live tested: `false`.  
Source: [definition JSON](../api-wiring/vendor_connections/definitions/seon.json). Definition notes: EU uses v2.0; US/ME use v2/. Choose matching operation and region.

| Native operation ID | Method / path | Original semantics | Proposed canonical capability ID | Role | Mapping rationale / unresolved requirement |
| --- | --- | --- | --- | --- | --- |
| `seon:fraud_eu` | `POST /SeonRestService/fraud-api/v2.0` | `risk` | `risk.customer.intelligence.unresolved` | `assess` | Signal/score contract; endpoint deployment region does not establish jurisdiction coverage. |
| `seon:fraud_us_me` | `POST /SeonRestService/fraud-api/v2/` | `risk` | `risk.customer.intelligence.unresolved` | `assess` | Signal/score contract; endpoint deployment region does not establish jurisdiction coverage. |

### C.32 `shufti` — 2 operations

Provider record: `shufti`. Native version: `documented-public`. Maturity: `implemented_unverified`. Live tested: `false`.  
Source: [definition JSON](../api-wiring/vendor_connections/definitions/shufti.json). Definition notes: Basic authentication; post-2023-03-15 SHA256-secret response signature. Legacy signature accounts need an explicit documented change, not silent fallback.

| Native operation ID | Method / path | Original semantics | Proposed canonical capability ID | Role | Mapping rationale / unresolved requirement |
| --- | --- | --- | --- | --- | --- |
| `shufti:verify` | `POST /` | `session` | `identity.person.intelligence.unresolved` | `submit` | Configured workflow; verify actual child checks and requested country. |
| `shufti:get_status` | `POST /status` | `identity_result` | `identity.person.intelligence.unresolved` | `retrieve` | Configured workflow; verify actual child checks and requested country. |

### C.33 `sumsub` — 4 operations

Provider record: `sumsub`. Native version: `documented-public`. Maturity: `implemented_unverified`. Live tested: `false`.  
Source: [definition JSON](../api-wiring/vendor_connections/definitions/sumsub.json).

| Native operation ID | Method / path | Original semantics | Proposed canonical capability ID | Role | Mapping rationale / unresolved requirement |
| --- | --- | --- | --- | --- | --- |
| `sumsub:create_applicant` | `POST /resources/applicants` | `session` | `identity.person.intelligence.unresolved` | `submit` | Provider workflow status is separate from individual check evidence and bank decision. |
| `sumsub:get_applicant` | `GET /resources/applicants/{applicantId}/one` | `resource` | `identity.profile.intelligence.unresolved` | `retrieve` | Stored applicant resource, not a verification result. |
| `sumsub:review_status` | `GET /resources/applicants/{applicantId}/status` | `identity_result` | `identity.person.intelligence.unresolved` | `retrieve` | Provider workflow status is separate from individual check evidence and bank decision. |
| `sumsub:aml_case` | `GET /resources/api/applicants/{applicantId}/amlCase` | `screening` | `screening.watchlist.intelligence.unresolved` | `retrieve` | AML case may contain multiple categories; cannot default to sanctions. |

### C.34 `telesign` — 2 operations

Provider record: `telesign`. Native version: `documented-public`. Maturity: `implemented_unverified`. Live tested: `false`.  
Source: [definition JSON](../api-wiring/vendor_connections/definitions/telesign.json).

| Native operation ID | Method / path | Original semantics | Proposed canonical capability ID | Role | Mapping rationale / unresolved requirement |
| --- | --- | --- | --- | --- | --- |
| `telesign:phone_score` | `POST /v1/score/{phone}` | `risk` | `risk.phone.intelligence.unresolved` | `assess` | Signal/score contract; endpoint deployment region does not establish jurisdiction coverage. |
| `telesign:phone_id` | `POST /v1/phoneid/{phone}` | `identity_data` | `risk.phone.intelligence.unresolved` | `assess` | Signal/score contract; endpoint deployment region does not establish jurisdiction coverage. |

### C.35 `truelayer` — 4 operations

Provider record: `truelayer`. Native version: `documented-public`. Maturity: `implemented_unverified`. Live tested: `false`.  
Source: [definition JSON](../api-wiring/vendor_connections/definitions/truelayer.json).

| Native operation ID | Method / path | Original semantics | Proposed canonical capability ID | Role | Mapping rationale / unresolved requirement |
| --- | --- | --- | --- | --- | --- |
| `truelayer:accounts` | `GET /data/v1/accounts` | `account_data` | `account.profile.intelligence.unresolved` | `retrieve` | Permissioned financial/source data; no account-holder match or AML monitoring conclusion. |
| `truelayer:account` | `GET /data/v1/accounts/{account_id}` | `account_data` | `account.profile.intelligence.unresolved` | `retrieve` | Permissioned financial/source data; no account-holder match or AML monitoring conclusion. |
| `truelayer:balance` | `GET /data/v1/accounts/{account_id}/balance` | `account_data` | `financial.balance.intelligence.unresolved` | `retrieve` | Permissioned financial/source data; no account-holder match or AML monitoring conclusion. |
| `truelayer:transactions` | `GET /data/v1/accounts/{account_id}/transactions` | `transaction_data` | `financial.transactions.intelligence.unresolved` | `retrieve` | Permissioned financial/source data; no account-holder match or AML monitoring conclusion. |

### C.36 `truora` — 4 operations

Provider record: `truora`. Native version: `documented-public`. Maturity: `implemented_unverified`. Live tested: `false`.  
Source: [definition JSON](../api-wiring/vendor_connections/definitions/truora.json).

| Native operation ID | Method / path | Original semantics | Proposed canonical capability ID | Role | Mapping rationale / unresolved requirement |
| --- | --- | --- | --- | --- | --- |
| `truora:create_check` | `POST /v1/checks` | `submission` | `identity.person.intelligence.unresolved` | `submit` | CONDITIONAL: type/country select actual person/business check; reject an incompatible subject type and rebind before execution. |
| `truora:list_checks` | `GET /v1/checks` | `resource` | `platform.integration.intelligence.unresolved` | `control` | Inventory of checks; not a new verification. |
| `truora:get_check` | `GET /v1/checks/{check_id}` | `check_result` | `identity.person.intelligence.unresolved` | `retrieve` | CONDITIONAL: type/country select actual person/business check; reject an incompatible subject type and rebind before execution. |
| `truora:check_details` | `GET /v1/checks/{check_id}/details` | `check_result` | `identity.person.intelligence.unresolved` | `retrieve` | CONDITIONAL: type/country select actual person/business check; reject an incompatible subject type and rebind before execution. |

### C.37 `twilio-lookup` — 1 operations

Provider record: `twilio-lookup`. Native version: `v2`. Maturity: `implemented_unverified`. Live tested: `false`.  
Source: [definition JSON](../api-wiring/vendor_connections/definitions/twilio-lookup.json).

| Native operation ID | Method / path | Original semantics | Proposed canonical capability ID | Role | Mapping rationale / unresolved requirement |
| --- | --- | --- | --- | --- | --- |
| `twilio-lookup:lookup_phone` | `GET /v2/PhoneNumbers/{phone}` | `phone_data` | `risk.phone.intelligence.unresolved` | `assess` | Signal/score contract; endpoint deployment region does not establish jurisdiction coverage. |

### C.38 `uk-sanctions-list` — 1 operations

Provider record: `uk-sanctions-list`. Native version: `documented-public`. Maturity: `implemented_unverified`. Live tested: `false`.  
Source: [definition JSON](../api-wiring/vendor_connections/definitions/uk-sanctions-list.json).

| Native operation ID | Method / path | Original semantics | Proposed canonical capability ID | Role | Mapping rationale / unresolved requirement |
| --- | --- | --- | --- | --- | --- |
| `uk-sanctions-list:download_consolidated` | `GET /docs/UK-Sanctions-List.xml` | `dataset` | `reference.list.intelligence.gb` | `ingest` | Publisher jurisdiction; not subject residence or screening clearance. |

### C.39 `un-security-council-consolidated-list` — 1 operations

Provider record: `un-security-council-consolidated-list`. Native version: `documented-public`. Maturity: `implemented_unverified`. Live tested: `false`.  
Source: [definition JSON](../api-wiring/vendor_connections/definitions/un-security-council-consolidated-list.json).

| Native operation ID | Method / path | Original semantics | Proposed canonical capability ID | Role | Mapping rationale / unresolved requirement |
| --- | --- | --- | --- | --- | --- |
| `un-security-council-consolidated-list:download_consolidated` | `GET /resources/xml/en/consolidated.xml` | `dataset` | `reference.list.intelligence.un` | `ingest` | Publisher jurisdiction; not subject residence or screening clearance. |

### C.40 `unit21` — 1 operations

Provider record: `unit21`. Native version: `documented-public`. Maturity: `implemented_unverified`. Live tested: `false`.  
Source: [definition JSON](../api-wiring/vendor_connections/definitions/unit21.json). Definition notes: Use customer-specific API_ENDPOINT. Optional Fernet transport mode is not enabled; only ordinary documented TLS JSON mode is implemented.

| Native operation ID | Method / path | Original semantics | Proposed canonical capability ID | Role | Mapping rationale / unresolved requirement |
| --- | --- | --- | --- | --- | --- |
| `unit21:create_entity` | `POST /v1/entities/create` | `submission` | `platform.integration.intelligence.unresolved` | `control` | Create entity resource for monitoring; does not monitor a transaction. |

### C.41 `veriff` — 5 operations

Provider record: `veriff`. Native version: `documented-public`. Maturity: `implemented_unverified`. Live tested: `false`.  
Source: [definition JSON](../api-wiring/vendor_connections/definitions/veriff.json). Definition notes: Customer integration HTTPS base must be explicitly configured. Response HMAC required; session creation is not a decision.

| Native operation ID | Method / path | Original semantics | Proposed canonical capability ID | Role | Mapping rationale / unresolved requirement |
| --- | --- | --- | --- | --- | --- |
| `veriff:create_session` | `POST /v1/sessions/` | `session` | `identity.person.intelligence.unresolved` | `submit` | Session lifecycle/decision retrieval; provider decision is not institution approval. |
| `veriff:get_decision` | `GET /v1/sessions/{id}/decision` | `identity_result` | `identity.person.intelligence.unresolved` | `retrieve` | Session lifecycle/decision retrieval; provider decision is not institution approval. |
| `veriff:get_watchlist` | `GET /v1/sessions/{id}/watchlist-screening` | `screening` | `screening.watchlist.intelligence.unresolved` | `retrieve` | Watchlist categories must be proven from configured program/results. |
| `veriff:upload_media` | `POST /v1/sessions/{id}/media` | `submission` | `document.evidence.intelligence.unresolved` | `upload` | Upload only; no document/biometric result. |
| `veriff:submit_session` | `PATCH /v1/sessions/{id}` | `submission` | `identity.person.intelligence.unresolved` | `submit` | Session lifecycle/decision retrieval; provider decision is not institution approval. |

### C.42 `yapily` — 2 operations

Provider record: `yapily`. Native version: `documented-public`. Maturity: `implemented_unverified`. Live tested: `false`.  
Source: [definition JSON](../api-wiring/vendor_connections/definitions/yapily.json).

| Native operation ID | Method / path | Original semantics | Proposed canonical capability ID | Role | Mapping rationale / unresolved requirement |
| --- | --- | --- | --- | --- | --- |
| `yapily:accounts` | `GET /accounts` | `account_data` | `account.profile.intelligence.unresolved` | `retrieve` | Permissioned financial/source data; no account-holder match or AML monitoring conclusion. |
| `yapily:transactions` | `GET /accounts/{accountId}/transactions` | `transaction_data` | `financial.transactions.intelligence.unresolved` | `retrieve` | Permissioned financial/source data; no account-holder match or AML monitoring conclusion. |

## Appendix D: source fingerprints

SHA-256 fingerprints bind this review to the local inventories. A subsequent inventory change requires rechecking completeness and semantics; it must not silently inherit this review's scope. The definition-set digest is calculated from each definition's repo-relative path, a newline, its file SHA-256, and a newline, sorted by path; manifests use the same algorithm.

| Source | SHA-256 |
| --- | --- |
| `kyc-provider-atlas/catalog/providers.json` | `41dbe111cf70b80b7945d5d78be6a4c3e5d8d06ab55bdcc8d753051f0d10a8b8` |
| `kyc-provider-atlas/catalog/provider-capabilities.json` | `975677a4c6f5e03aeeca9aaeb36ef2280b62c151d5e30bca3a5edb866deca089` |
| `kyc-provider-atlas/catalog/capabilities.json` | `773c10f28d02bdc91243d17f36a9e32c9f79fd54e074f19932a749f123cc832b` |
| `api-wiring/config/connection-templates.json` | `7d65fd746fdc68cbfea19d9a95cb9de39dee1325dee8815763a7131e1f0b41cb` |
| `api-wiring/config/contracts.json` | `ca3d163bab055381827226140568f3bef7eaac187cebd76878e0b63e9e442356` |
| `kyc-provider-atlas/adapters/runtime.py` | `b3ce78661ece6f4fcb0e872baba353b4fdfe3bf6fb70b54a66dd0ba6f0c768aa` |
| `api-wiring/vendor_connections/normalization.py` | `a34b6193b6480e489c906f394981551aef3364a3f3dabe10b3f8d70cd170e5ac` |
| `api-wiring/wiring/core.py` | `9f6e31fede63de7ca92b3bc1e647a58aa64dbed183b47296151aff2f6ccc09bd` |
| `api-wiring/vendor_connections/definitions/*.json` (42 files) | `aa761168acb4a79b7f6aacb7a1eb50546af8d8fa606583b983b6c122d883a41c` |
| `kyc-provider-atlas/adapters/manifests/*.json` (9 files) | `26157d93bdaa6efd4eb6e891bf900d53fea99d2e3d92bbe1d11f3e3a4eca731f` |

