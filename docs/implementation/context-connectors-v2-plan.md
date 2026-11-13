# Context plane v2 bank connector plan

Status: v2 design with the pull-only foundation implemented, 2026-11-09. Salesforce/Fenergo API drivers, bounded collection mapping, reviewed case bindings, explicit case pulls and guarded canonical commits are implemented; see [implementation and qualification guide](context-api-connectors.md). Vendor-specific profiles and pilot acceptance below still require live bank qualification. Portfolio priorities, later delivery phases and estimates remain design proposals. No vendor connection has been qualified against a bank tenant.

Build Salesforce and Fenergo first, using one shared acquisition framework and bank-specific mapping profiles. Pull only the identities, relationships and supporting observations needed by an authorized case/task. Add one core banking system selected by the pilot bank, then explicitly selected documents. Reuse the existing ontology and case record path; defer new domain types until an actual consumer requires them.

Treat a connector as a **versioned transport adapter plus a tenant mapping profile plus an explicitly authorized binding to consumers**. A vendor name alone does not identify the bank's object model, accessible fields, deployed product generation or authoritative records.

## Scope change

| Earlier proposal | Current v2 scope |
| --- | --- |
| Bootstrap customer populations and continuously synchronize them | Resolve approved source IDs for subjects already in one case, then fetch a bounded bundle on demand |
| Durable event inbox, CDC offsets, subscriptions and acknowledgment workers | Existing acquisition run/receipt, request idempotency, mapping report and case commit |
| Event lag and consumer watermarks | Last successful pull, source observation times, coverage, freshness and task gaps |
| Five new canonical types as initial contract work | Existing ontology types first; unsupported workflow/review/assessment details remain source evidence |
| Bulk extraction and background reconciliation | Pagination only within the requested case scope and resource budget |
| Periodic refresh and source-change propagation | Explicit Pull context action or a declared acquisition node before a case task |

CDC, webhooks, notification polling, delta feeds, bank-wide replication, scheduled SaaS refresh and writeback are outside this increment. Existing PostgreSQL snapshot scheduling remains an independent implemented feature. Opening a case, browsing the ontology, or requesting a preview does not initiate a source pull.

## Current platform foundation

The repository already has the main downstream path:

```text
approved source and connection
  → authorized case action or released acquisition node
  → gateway pull for explicit case subjects
  → deterministic mapping and canonical validation
  → authorized RecordCanonicalRecords command
  → immutable case records
  → purpose and field projection
  → context requirements, trust treatment and manifest
```

Reuse [source setup](context-source-setup.md), [canonical records](canonical-records.md), [context ontology](context-ontology.md) and [context operations](context-operations.md). The context assembler remains a pure library without vendor networking. Acquisition happens before packet assembly.

| Existing component | What v2 should extend |
| --- | --- |
| `packages/contracts/src/context-setup.ts` | PostgreSQL definitions are preserved alongside discriminated Salesforce/Fenergo API contracts. |
| `packages/context-postgres` | Keep this transport. Add sibling vendor adapters behind a shared source interface rather than inserting SaaS logic into PostgreSQL code. |
| `packages/context-mapping` | Reuse compilation, deterministic expressions, schema pins, samples and field lineage. Add bounded collection expansion and related-object assembly needed for nested APIs. |
| `apps/control-api/src/context-setup-routes.ts` | Extend discovery, sampling and exact-revision enablement to API resources and vendor schema fingerprints. |
| `apps/capability-gateway/src/adapters/context-postgres.ts` | Follow its source-policy, credential-generation and receipt checks for SaaS acquisition. Keep `context.records.fetch.v1` for compatible bounded reads. |
| `packages/contracts/src/context-refresh.ts` and refresh worker | No SaaS scheduling or CDC additions in this increment. Reuse ordinary acquisition run/receipt tracking for case pulls. |
| `packages/case-store` and `packages/context-plane` | Preserve case-scoped commits, immutable versions, exact references and task admission. Add new type validation and consumer contracts through the existing release process. |

The pinned library declares 89 context types. `Application`, `ProductHolding` and `ApplicationAccountLink` additionally exist as independently versioned platform contracts in `packages/contracts/src/application-context.ts`; they are not automatically available to library products or skills. A new connector must state the fields and consumer requirements it actually satisfies.

## Connector portfolio and priority

Priority reflects a proposed customer/KYC pilot, not measured bank demand. Select each bank's installed product and integration route before committing to a vendor adapter.

| Priority | Connector family | Source objects to acquire | Canonical targets | API route and qualification boundary |
| --- | --- | --- | --- | --- |
| P0 | Salesforce CRM and Financial Services Cloud | Business and Person Accounts, Contacts, relationship objects, financial accounts and parties for case subjects | `Entity`, `Party`, `CustomerRelationship`, `IdentityIdentifier`, `Relationship`, `Account`; conditional `Product`; platform `ProductHolding` only with separately released consumers | REST Describe and subject-filtered SOQL. Discover standard versus managed-package FSC models. [Salesforce data models](https://help.salesforce.com/s/articleView?id=sf.fsc_admin_data_model.htm&language=en_US&type=5) |
| P0 | Fenergo SaaS CLM | Verified entities, bounded related parties, selected journey/requirement observations and stored assessments for case subjects | Identity and ownership types; `SourceRecord`, `VerificationRecord`, `RiskAssessment`, `ScreeningExecution`, `ScreeningHit` when complete | Targeted Query APIs and optional read-only Supergraph. Legacy/on-premises Fenergo requires a separate profile and API discovery. [API catalogue](https://docs.fenergonebula.com/developer-hub/api-overview/api-catalogue) |
| P1 | Bank-selected core, initially Temenos Transact | Explicit case customer IDs, accounts, product relationships and a bounded transaction window | `Entity`, `Party`, `CustomerRelationship`, `Account`, `Product`, `Transaction`, `DatasetScope`; platform holdings only with qualified consumers | Targeted Transact reads; pin bank release, local fields and endpoint/authentication profile. Balance details remain source evidence until a typed consumer exists. [Core APIs](https://developer.temenos.com/transact-apis) |
| P1 | SharePoint and OneDrive via Microsoft Graph | Explicit document IDs or an approved case/customer document collection | `SourceRecord`, `Document`, `DocumentVersion`, `Evidence`; `DocumentPage` only after parsing | Graph v1.0 selected item/version/content reads; no drive synchronization. Add source-backed document-use authorization before runtime retrieval. [Get driveItem](https://learn.microsoft.com/en-us/graph/api/driveitem-get?view=graph-rest-1.0) |
| P1 alternative | Dynamics 365 and Dataverse | Accounts, contacts and custom records filtered to case subjects | Customer and relationship types; workflow details as `SourceRecord` | Web API metadata and filtered OData reads. Prefer this over Salesforce when it is the pilot bank's CRM. [OData queries](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/query/overview) |
| P2 | nCino | Selected applications, applicants, requested facilities/deposits and explicit originated-account links | `Entity`, `Party`, `Product`, `SourceRecord`; platform `Application` and `ApplicationAccountLink` only with separately released consumers | Discover the actual product API; Salesforce-backed installations may reuse Salesforce transport with a separate mapping profile. Consumer Banking API details require authenticated access. [Developer platform](https://developer.ncino.com/) |
| P2 | Pega CLM or case management | Selected external cases, assignments and approved case/customer data views | `SourceRecord`; `TimelineEvent` only for actual returned dated events; conditional customer types | DX API cases/assignments and data views. Pin application version, accessible views and service authorization. [DX API](https://docs.pega.com/bundle/platform/page/platform/launchpad/dx-api-preview.html), [data endpoints](https://docs.pega.com/bundle/dx-api/page/platform/dx-api/dx-api-data-endpoints.html) |
| P2 | Reltio MDM | Approved golden-record IDs, relations and source crosswalks for case subjects | `Entity`, `IdentityIdentifier`, `Relationship`; governed identity crosswalk inputs | Targeted entity/relation retrieval, with source keys and merge provenance. No streamed changes in v2. [Object retrieval example](https://docs.reltio.com/en/developer-resources/data-integration-apis/data-integration-apis-at-a-glance/events-api) |
| P2 | ServiceNow | Selected service cases and remediation work related to case subjects | `SourceRecord`; `TimelineEvent` for actual dated source events | Table API with explicit table/field/filter allowlists and instance ACLs. [Table API](https://www.servicenow.com/docs/r/api-reference/rest-apis/c_TableAPI.html) |
| P2 alternative | Mambu | Customer and account context for selected case IDs | Same customer/account family as the core profile; transaction and balance targets require resource mapping | API v2 and downloadable OpenAPI; qualify the selected read resources. [API reference](https://docs.mambu.com/api/) |
| Bank-driven backlog | NICE Actimize, Oracle FCCM, SAS AML; FIS, Fiserv, Oracle FLEXCUBE; Informatica MDM; OpenText and OnBase; bank warehouse views | Selected alerts/investigations; core accounts/transactions; master identities; evidence documents | `Alert`, `Investigation`, customer/account types and evidence, conditional on complete source fields; otherwise `SourceRecord` | Obtain bank-specific specifications and entitlement first. These are candidate families, not verified endpoint implementations. NICE publicly documents REST integration for X-Sight Onboard, which does not establish a portable alert/case API across Actimize products. [NICE integration example](https://www.niceactimize.com/Documents/x-sight-onboard-investec-case-study.pdf) |

Bank warehouse views can be the first approved route when direct vendor access is unavailable. Label them as the bank's view and retain the originating system's lineage and refresh lag. Existing PostgreSQL transport does not imply that Snowflake, Databricks or another warehouse is already supported.

## Salesforce connector specification

### API acquisition

Discover permitted objects and fields with `GET /services/data/vXX.X/sobjects/{object}/describe/`; pin API version, installed package version, record types, field types, relationship targets and picklists. Use bounded `GET /services/data/vXX.X/query?q=...` reads and follow `nextRecordsUrl` through the entire authorized result. Build queries from approved object/field/filter definitions with escaped values. [Describe](https://developer.salesforce.com/docs/platform/api-rest/guide/resources-sobject-describe.html), [SOQL Query API](https://developer.salesforce.com/docs/platform/api-rest/guide/resources-query.html)

Resolve the case's reviewed Salesforce IDs, then read only the approved subject records and bounded relationship expansions. Complete pagination inside that scope or report incomplete coverage. No population bootstrap, Bulk API jobs or Pub/Sub subscriptions are required in this increment. Source-side version/modified fields support lineage and consistent rereads, not CDC checkpoints.

Authenticate with the bank-approved OAuth application and integration identity. Discover actual object/field access and sharing scope under that identity. Customer custom fields and object licences are qualification inputs; an OAuth handshake alone cannot establish mapping coverage.

### Object mappings

| Salesforce object or observation | EHF mapping | Required qualification |
| --- | --- | --- |
| Business `Account` | `Entity` plus `Party` when it has a bank/customer role | `Name` and type/identifier mappings; explicit role, customer type and profile for `Party`. An ordinary CRM account is not a banking `Account`. |
| Person Account and its backing Contact; legacy individual model | One resolved person `Entity`, plus relevant `Party` records | Discover the org's person model and reconcile backing IDs; do not emit duplicate people for Person Account and Contact. |
| `Contact` | Person `Entity`; optional `Party` and `OfficerRole` | Being a contact does not establish that the person is a bank customer, director or account signatory. Require the relevant source relationship. |
| Customer or onboarding custom fields | `CustomerRelationship` | Explicit canonical party, bank institution, relationship type/status and start time. Preserve unknown dates instead of substituting ingestion time. |
| `AccountContactRelation`, `AccountAccountRelation` and bank custom relationship objects | `Relationship`; `OfficerRole`, `ControlRight` or `OwnershipInterest` when their semantics and fields fit | Discover role codes and dates. A relationship is not proof of ownership; distinguish direct shareholding from aggregate/indirect percentages. [AccountAccountRelation](https://developer.salesforce.com/docs/industries/fsc-dev-guide/guide/fsc-sforce-api-objects-accountaccountrelation.html) |
| Standard `FinancialAccount`, or discovered managed-package equivalent | `Account` | Explicit entity crosswalk, account type and status/currency where supplied. Standard `FinancialAccount` is available from API 61.0 with its feature enabled. [FinancialAccount](https://developer.salesforce.com/docs/industries/fsc-dev-guide/guide/fsc-sforce-api-objects-financialaccount.html) |
| `FinancialAccountParty`, or discovered managed-package role object | `ProductHolding` only when a supported holder role, explicit Product and Account versions, dates and evidence exist | Source roles include owner and beneficiary. Unsupported roles require the proposed `AccountPartyRole` contract or preserved source evidence. [FinancialAccountParty](https://developer.salesforce.com/docs/industries/fsc-dev-guide/guide/fsc-sforce-api-objects-financialaccountparty.html) |
| Opportunity or lead | `SourceRecord`; `Application` only through a qualified application profile | A sales stage does not establish an application, applicant set, requested product or credit decision. |
| Salesforce `Case` or `Task` | `SourceRecord`; optional `TimelineEvent` for actual dated source events | Source lifecycle observations cannot create platform workflow authority. Typed workflow contracts are deferred. |

The FSC managed-package and standard models need separate mapping packs over one Salesforce transport. Select concrete names through Describe; do not hard-code one package namespace for every bank. Salesforce documents both financial-account models and different person models. [FSC data models](https://help.salesforce.com/s/articleView?id=sf.fsc_admin_data_model.htm&language=en_US&type=5)

## Fenergo connector specification

### API acquisition

For Fenergo SaaS, use client-credentials authentication and least-privilege query scopes such as `fenx.entitydata.read` and `fenx.journey.read`. Configure tenant/region endpoints and optional mTLS from the bank's deployment. Honor token `expires_in` rather than hard-coding lifetimes across services. Current client management supports self-service secrets and certificates. [Authentication](https://docs.fenergonebula.com/api-docs/fenergo-saas-api-specifications/authentication), [scopes](https://docs.fenergonebula.com/developer-hub/api-and-system-security/api-scopes-and-access-control), [client management](https://docs.fenergonebula.com/user-guides/fenergo-user-guides/api-client-management/)

Use Entity Data Query, Association Query, Journey Query and Document Management Query for the corresponding resources. Stored screening and risk observations require qualified read operations: the API catalogue explicitly says Risk Query can perform calculations, so a Query label does not establish that an operation merely reads an existing assessment. [API catalogue](https://docs.fenergonebula.com/developer-hub/api-overview/api-catalogue)

Evaluate read-only `POST /supergraph` for bounded customer/journey traversal. The documented domains are EntityData, Journey, Associations and Product; Documents, Audit and Users/Teams are described as future additions. Keep REST acquisition for resources outside discovered Supergraph coverage. Pin an approved GraphQL operation, schema and complexity limit; disallow arbitrary client queries. [Supergraph](https://docs.fenergonebula.com/developer-hub/data-extraction/supergraph-query-overview)

Resolve the case's approved Fenergo entity/journey IDs from a reviewed crosswalk or an authorized exact-ID lookup. Pull the current verified entity plus the specifically requested association and journey observations. A caller-supplied vendor ID must resolve to the authorized case scope before acquisition. Draft data is opt-in supporting evidence. No notification polling, acknowledgments, reporting exports or full-population extraction are required.

Obtain and pin the pilot tenant's OpenAPI/GraphQL schemas, policy fields/data groups, association definitions, permissions and example payloads. Public documentation establishes the API families; Entity Data and Journey Swagger pages were not accessible during this review. Exact DTO paths, rate limits, pagination and tenant custom-field mappings remain qualification work.

### Object mappings

| Fenergo source resource | EHF mapping | Required qualification |
| --- | --- | --- |
| Verified entity and policy data groups | `Entity`, `Party`, `IdentityIdentifier`, `Address`, `CustomerRelationship` | Determine person versus organization from source type, not the API's Legal Entity label. Map only present fields; preserve source verification state separately from EHF conclusions. |
| Draft entity | `SourceRecord` and candidate observations | A draft cannot silently replace verified identity context. Draft and verified versions need separate lineage and eligibility. |
| Associations and related parties | `Relationship`, `OfficerRole`, `OwnershipInterest`, `OwnershipRange`, `ControlRight` | Pin direction, role, share class and direct/indirect basis. Convert explicit percentages to decimal fractions; never treat a missing percentage as zero. |
| Journey instance, stage and task | `SourceRecord`; optional `TimelineEvent` for returned dated source events | Preserve source status, stage, assignee and dates as source content. A current status snapshot does not reconstruct workflow history. |
| Onboarding or periodic review | `SourceRecord`; conditional `MonitoringPlan` when its complete current contract fits | Review kind/status and source policy attribution remain inspectable evidence. Do not create a scheduler or fabricate review trigger references. |
| Requirement and evidence fulfillment | `SourceRecord`; conditional existing `Requirement`, `Control`, `VerificationRecord` | Existing `Requirement` requires an executable applicability predicate; a checklist row alone does not supply one. Preserve source policy attribution without activating it as EHF policy. |
| Stored risk assessment | `RiskAssessment` when complete; otherwise `SourceRecord` | Current `RiskAssessment` requires tier, score, contributions and model version. A High/Medium/Low label alone cannot satisfy it. |
| Stored screening result | `ScreeningExecution`, `ScreeningHit` and referenced watchlist evidence when complete | Require actual query scope, dataset versions, times, counts and limitations. A green screening status is insufficient to establish a complete negative search. |
| Document metadata and bytes | `SourceRecord`, then `Evidence`, `Document`, `DocumentVersion` through capture | Hash captured bytes and retain version identity. `Document` requires issue and expiry times; documents without them need an approved contract change or remain source/artifact evidence. `DocumentVersion` requires page count, so complete media inspection before emitting it. |
| Source-of-funds/wealth and expected activity declarations | `SourceOfFunds`, `SourceOfWealth`, `ExpectedActivity` | Require the existing fields and supporting evidence; distinguish declared values from observed behavior and verified conclusions. |

## Canonical entity contract

### Align connector bundles to ontology products

Author mapping packs against the pinned ontology schema, the existing product catalogue and the 34 declared semantic relationships. A vendor resource can emit records into several existing products; the connector does not create a new vendor-specific product or widen a task's subscriptions.

| Existing context product | On-demand bundle | Declared relationships used in the case packet |
| --- | --- | --- |
| `identity.intelligence` | `Entity`, `IdentityIdentifier`, `Alias`, qualified `Address` | `IdentityIdentifier.entity_id → Entity`, `Alias.entity_id → Entity`; no declared Entity-to-Address edge |
| `party360` | `Party`, `CustomerRelationship`, qualified `Account`, `Product`, `ExpectedActivity` | `Party.entity_id → Entity`, `CustomerRelationship.party_id → Party`, `Account.entity_id → Entity` |
| `ownership.intelligence` | `OwnershipInterest`, `OwnershipRange`, `OfficerRole`, `ControlRight`; derived graph only through its existing contract | Owner/owned, officer/organization, controller/controlled references resolve to `Entity` |
| `network.intelligence` | Explicitly qualified `Relationship` rows | `Relationship.source/target` have no declared typed target edges in the current relationship catalogue |
| `risk.intelligence` and `screening.intelligence` | Complete `RiskAssessment`, funds/wealth observations, complete `ScreeningExecution`, hits and entries | `ScreeningHit.entity_id → Entity`, `ScreeningHit.entry_id → WatchlistEntry`; no invented RiskAssessment-to-Party edge |
| `evidence.intelligence` | `SourceRecord`, supporting `Evidence`, complete `VerificationRecord`; optional actual `TimelineEvent` | `VerificationRecord.evidence_ids → Evidence`; source records are scoped using their envelope and source references, not an invented semantic edge |
| `document.intelligence` | Selected captured `Document`, `DocumentVersion`, parsed `DocumentPage` | `DocumentVersion.document_id → Document`, `DocumentPage.document_version → DocumentVersion` |

Related targets enter acquisition only through the approved expansion policy. Emitting a related Entity does not admit it to every task packet: purpose, classification, subject scope and selector projection still apply. The case graph resolves only the target versions actually admitted to the packet. Acquisition coverage is resource-scoped; it does not make the packet graph complete.

First release needs mapping packs and consumer bindings for existing products, with **no new ontology types required**. The platform application/holding contracts and the candidate additions below remain separate release gates.

### Reuse the current types

The initial mapping packs should target these existing contracts, with service-owned record envelopes carrying tenant/case, subjects, observation/effective times, source references, provenance, purpose, classification and immutable version identity.

| Entity | Current required data fields | Meaning for bank connectors |
| --- | --- | --- |
| `Entity` | `name`, `identifiers`, `entity_type` | The person or organization being described. Source IDs are namespaced; identifiers alone do not authorize cross-system merging. |
| `Party` | `entity_id`, `role`, `customer_type`, `profile` | A business role/profile for that entity. Role and customer type come from the bank's vocabulary. |
| `CustomerRelationship` | `party_id`, `institution_id`, `relationship_type`, `status`, `started_at` | The explicit relationship to a particular bank institution. |
| `IdentityIdentifier` | `entity_id`, `identifier_type`, `issuer`, `value`, `verified` | Attributed identifiers, including LEI or bank customer number where supported. |
| `Relationship` | `source`, `target`, `relation`, `verified` | An attributed semantic connection. Source verification does not grant platform approval. |
| `OwnershipInterest` | `owner`, `owned`, `interest` | An explicit fraction between zero and one; retain voting interest and share class when supplied. |
| `OfficerRole` | `entity_id`, `organization_id`, `role` | Director/officer roles established by source evidence. |
| `ControlRight` | `controller`, `controlled`, `basis`, `verified` | Non-equity control relationships with an explicit basis. |
| `Account` | `entity_id`, `account_type` | A financial account. The current type has no typed Product link or balance fields. |
| `Product` | `product_type`, `channel`, `active` | An explicitly identified offering; an account type alone does not establish one. |
| `Transaction` | `source`, `target`, `amount`, `currency`, `timestamp`, `event_id`, `status` | A transaction with resolved endpoint identities. Current endpoint IDs are not typed account references. |
| `RiskAssessment` | `tier`, `score`, `contributions`, `model_version` | A complete source assessment with its original model attribution. |
| `VerificationRecord` | `subject`, `status`, `method`, `evidence_ids` | A source verification and its supporting evidence. |
| `SourceRecord` | `content`, `source`, `coverage` | Preserved source observations and explicit acquisition coverage. |

Map addresses, aliases, registrations, expected activity, funds/wealth and screening objects where their contracts fit. Current `Entity.attributes.address` is an ID, but the semantic relationship catalogue does not currently declare an Entity-to-Address edge; add verified metadata before showing that edge in the ontology. Do not invent relationships merely because two fields have compatible string types.

For transactions, establish the bank's interpretation of the existing endpoint IDs through an approved crosswalk. If the source supplies account IDs but the consumer expects entity IDs, resolve the relationship explicitly. Preserve the original account endpoints in source evidence until typed transaction/account relationships are released.

### Reuse the platform application contracts

`Application` requires a source application ID, exactly one primary applicant, explicit requested Product versions, channel, lifecycle/effective times and evidence. `ProductHolding` requires exact Party, Product and Account versions, a supported role, effective interval and supporting evidence. `ApplicationAccountLink` captures explicit origination/refinance/conversion links. Source decisions remain historical observations.

Do not claim an application product or library-skill readiness until the corresponding library schema, selectors, relationships and consumer releases exist. The current platform contracts provide storage/validation groundwork.

### Deferred ontology extensions

These names and fields are **deferred proposals**, not existing ontology members or prerequisites for the pull-only pilot. Preserve unsupported payloads in authorized `SourceRecord.content` as text or a captured artifact; that schema does not accept an arbitrary JSON object directly. Display source observations as evidence and keep complete-assessment requirements unmet where appropriate.

Retain only the source fields and subjects allowed for that evidence bundle. Serialized `content` is one projected field: it does not inherit field-level access rules for arbitrary JSON keys inside the text. Use separately scoped/redacted source records where purposes, classifications or subject permissions differ; do not use raw payload preservation to bypass canonical field ceilings.

Promote a proposal only when a named consumer needs typed fields that the existing ontology cannot express. Add its closed schema, relationships, product membership, consumer requirements and validation fixtures together. Merely putting data into `SourceRecord` or `extensions` does not make existing skills understand new semantics.

| Proposed type | Proposed minimum data fields | Why it is needed |
| --- | --- | --- |
| `ExternalWorkflowInstance` | `source_system`, `source_workflow_id`, `workflow_kind`, `subject_refs`, `status_raw`, `status_normalized`, `current_stage`, `opened_at`, nullable `completed_at`/`due_at`, `source_record_ref` | Fenergo/Pega/nCino/Salesforce lifecycle context without implying an executable EHF case. |
| `ExternalWorkItem` | `source_work_item_id`, `workflow_ref`, `kind`, `status_raw`, `status_normalized`, nullable `assignee_ref`/`due_at`, `source_record_ref` | External assignments and remediation items without fabricating `Task.skill_id` or skill parameters. |
| `KycReview` | `party_ref`, `review_kind`, `jurisdictions`, `status`, nullable `due_at`/`completed_at`, `workflow_ref`, `source_policy_version`, `source_record_ref` | Onboarding, periodic and event-driven reviews that consumers can inspect directly. |
| `KycRequirementStatus` | `review_ref`, `source_requirement_id`, `requirement_kind`, `status`, `evidence_refs`, `source_policy_version`, `source_record_ref` | Per-review satisfaction, waiver, expiry and missing evidence, separately from policy definitions. |
| `AssessmentObservation` | `subject_ref`, `assessment_kind`, `status_raw`, nullable `tier`/`score`/`model_version`, `coverage`, `assessed_at`, `source_record_ref` | Partial source risk/screening summaries that must not satisfy complete-assessment requirements. |

Normalize statuses through reviewed tenant lookups and retain raw values. Unknown statuses remain unresolved; never map them to successful completion. Optional/missing source times remain unknown. Do not backfill source opening/completion times from ingestion time.

Defer `AccountPartyRole` for roles outside `ProductHolding`, `AccountBalanceSnapshot` for dated booked/available balances, `ConsentRecord` for explicit consent observations, and `ContactPoint`/household contracts until a selected consumer requires them. Consent observations do not confer platform access. Each addition needs a closed schema, validator, semantic relationships, product projection, consumer field requirements and migration/replay fixtures.

## Identity and source authority

Keep an explicit crosswalk scoped by EHF tenant, bank institution, source instance/org, source object type and source ID. This prevents collisions between two Salesforce orgs, two bank legal entities, and similarly numbered accounts. Source-record identity survives mapping updates. Mapping digest and source revision participate in version lineage, not the stable object's identity.

Start with connection-scoped objects and reviewed crosswalks. Permit mastered identity from the bank's approved MDM; otherwise produce candidate links for review. Names, email addresses and a shared household are not sufficient automatic merge rules. If a pull discovers a merged or retired source ID, require crosswalk resolution before committing a replacement identity; preserve historical case references. Extend the current digest-pinned crosswalk mechanism into a governed registry when inline mappings no longer suffice.

Define authority by field and purpose. A bank might designate core banking for account status, CLM for verified KYC fields, CRM for relationship-manager assignments, and MDM for customer identity. This is tenant configuration, not a universal vendor ranking. Keep conflicting assertions with source/version/time attribution and expose a conflict rather than allowing ingestion order to pick a winner.

Imported source status is data. Fenergo completion, a CRM approval field, or an Actimize disposition cannot authorize a platform decision or external effect. Existing Case, Task, Decision and Approval types have execution/policy semantics that an external status row does not establish. Retrieved text and document content retain the existing untrusted context treatment; authenticated transport is not sufficient reason to promote content to instructions.

## On demand case acquisition architecture

### Shared connector contract

Introduce a small source-driver interface with discovery, bounded subject fetch, bounded related-resource reads and health. Pagination belongs to one request and expires with that request; it is not a durable synchronization cursor. The interface does not require bootstrap, subscribe, pollChanges or acknowledgment operations in this increment.

Separate four versioned artifacts:

1. **Connection:** vendor/product generation, tenant/org, region, approved endpoints, identity mode, credential reference and generation.
2. **Resource:** approved API operation, object/view, field allowlist, exact subject filter, relationship expansion, pagination, source revision/time fields and request/result budgets.
3. **Mapping profile:** bank semantic lookups, ID/crosswalk rules, canonical outputs, compiler/schema pins and field lineage.
4. **Case consumer binding:** released acquisition plan/node, permitted case types, subject scope, purpose/classification, existing ontology products, required fields and freshness, and exact sample/enablement qualification.

Use an API-resource union rather than overloading PostgreSQL table names. Discovery and samples use the same driver and mapping implementation as runtime pulls. Pin OAuth token destinations, API hosts and any document-download hosts separately. Validate continuation URLs against approved operations and destinations before following them.

Add bounded collection mapping and declarative parent-child assembly for API arrays. Keep cross-system joins in approved crosswalks or bank views. A mapping cannot execute arbitrary JavaScript, SQL, SOQL or GraphQL. Fetch helpers build approved vendor queries from typed configuration.

### Case pull lifecycle

```text
explicit Pull context action or declared pre-task acquisition node
  → authorize case, released plan/node, purpose and subject scope
  → resolve reviewed source IDs and exact enabled mappings
  → bounded vendor reads and permitted relationship expansion
  → deterministic mapping, field lineage and ontology validation
  → authorized RecordCanonicalRecords commit to this case
  → new immutable case snapshot
  → normal task projection, context requirements and manifest
```

An interactive action uses a dedicated admitted acquisition run through the existing gateway/case-command path. An automatic pre-task pull must already be declared in the case's released plan. Consumer gaps can identify a need for acquisition but cannot authorize an undeclared connector call. A plan without a qualified acquisition path reports that limitation.

A proposed case pull request identifies the case, admitted acquisition plan/node, enabled source binding, canonical case subjects, refresh intent and an idempotency key. Services derive the actual vendor IDs, field list, products and resource limits from the authorized binding and reviewed crosswalk. Preserve the gateway capability's existing bounded source-key input contract inside that authorized orchestration. Do not let a browser or model supply arbitrary source queries, unbound IDs or extra canonical fields.

Reuse existing acquisition run status, gateway receipts, mapping validation and case-command idempotency. Record the pull's mapping/schema/resource/credential pins, source revisions, fetch start/end, selected subjects, resource coverage, validation result and resulting case sequence/snapshot. A successful vendor HTTP response is not completion: the requested canonical bundle must validate and its case command must commit.

Budget related-party depth, subjects, records, requests, bytes and elapsed time per binding. Retain current synchronous ceilings of 20 requested subjects and 100 rows, and cap each committed source bundle at the existing 200-record case-command ceiling. Account for expansions within those ceilings; a related-party graph is not an unlimited escape hatch. A larger case bundle needs an explicitly qualified request limit, not a bank-wide extraction job.

For example, a company review may request its Salesforce customer and permitted contact/account relationships, then its Fenergo verified entity and bounded ownership associations. Each source bundle has its own receipt and coverage. The required task starts only after both required bundles commit and a single post-acquisition case snapshot is captured. Optional source failures remain visible and must be allowed by the task contract.

### Freshness and snapshot rules

| Situation | Proposed behavior |
| --- | --- |
| Case opened, ontology inspected or context preview requested | Read already committed records under current authority; make no vendor call and no case write. |
| Operator selects Pull context | Execute the declared acquisition for the selected case scope; show source-specific progress, gaps and committed snapshot. |
| Task requests missing or stale required context | Use its declared acquisition node if present, then re-evaluate requirements against a new case snapshot. Otherwise return the existing missing/stale evidence outcome. |
| Existing case records satisfy requirements | Reuse only while current source authority, classification/purpose and required revision pins remain valid. A force-pull request still requires a successful new acquisition. |
| Required source fails or only part of its bundle is returned | Retain prior immutable records, mark the current pull incomplete/failed and block the dependent task. Prior data cannot silently satisfy a failed force pull. |
| Case changes while acquisition is running | Recheck case scope and current command preconditions before commit. On conflict, obtain fresh authority; do not bypass the case sequence or replay a stale authorization. |
| Source changes after capture | The task keeps its captured versions and manifest. A later pull produces a new case snapshot; it never replaces data inside an executing task's pack. |

Freshness belongs to the consumer and mapped observation semantics. Record fetch time separately from source modification, assessment and effective times. A successful fetch or HTTP 304 must not overwrite an old assessment date to make it look newly assessed. Current canonical record admission continues to use its configured observation-time and maximum-age rules. Any future check-time-based revalidation needs an explicit contract rather than an implicit timestamp substitution.

The UI should say observed or checked at a particular time, with the source assessment time where applicable. Pull-only context is a captured observation; it does not guarantee that the upstream source remains current between pulls. There is no proactive detection of a source update or deletion in this release.

### Failure and completeness rules

Use rate budgets, bounded concurrency, request deadlines, Retry-After handling and bounded backoff. Retry transient reads under the same acquisition identity; schema drift, unresolved identities and revoked permissions require repair. An interrupted pull can be retried as an explicit request; there is no event queue or source-offset recovery machinery.

Each requested source bundle is a validation/commit unit within the existing case-command record ceiling. Complete the related-resource reads and required references before emitting that bundle. If it cannot fit or a required component is missing, fail the bundle and retain diagnostics; do not partly commit it and report success. Separate source bundles may commit independently, but a required multi-source consumer remains blocked until its complete acquisition barrier succeeds.

Record requested/returned subjects, pages, relationship expansion limits, rejected records and consistency limits. Missing, forbidden, not-found, deleted and incomplete are different outcomes. A 404 or absent list entry does not authorize deleting case history. Record the failure/unavailability, retain the last observation with its age, and prevent unsupported absence claims. Historical evidence retention and any explicit withdrawal remain separate authorized operations.

A sequence of REST calls or a GraphQL response is not automatically a source-transaction snapshot. Preserve each resource's revision and observation time. Re-read changed members where supported; if the binding cannot establish the consistency a consumer requires, report the gap.

Current graph semantics still apply: ID targets must resolve uniquely within the authorized packet; exact Refs must match tenant/type/object/version. Missing or out-of-packet targets remain unresolved. Do not claim a complete ownership network or transaction window from a truncated source bundle, or a complete case graph from a task projection.

## Contextboard and case experience

In Context setup, add Salesforce and Fenergo templates under Connect source. Configure deployed product/version, bank org/tenant, permitted read operations, reviewed subject crosswalk, existing ontology product/type/field mappings and case consumer bindings. Keep visual, graph and code mapping modes on one declarative representation. Samples and enablement remain exact-revision checks.

On a case, show each configured context bundle with its source, mapped ontology products, subject scope, last pull, source observation/assessment time, coverage and consumer gaps. Add Pull context and explicit retry actions only when the case has a qualified acquisition path. Reading the case and previewing context remain non-mutating.

Source indicators attach to existing ontology nodes and fields. The inspector shows the source field/path, transform, source revision, raw status, canonical value and authority/conflict rule. Semantic edges come from the pinned relationship catalogue. Do not add a Fenergo Journey node or inferred Account-to-Product edge as a shortcut for source integration.

After a successful commit, refresh the case snapshot and packet preview so the user can inspect exactly which records and relationships the task can consume. A source sample is not a committed case snapshot. Last pull, mapping qualification, authorization, record freshness, resource coverage and consumer readiness are separate states; there are no CDC lag or reconciliation-watermark controls in v2.

Selected SharePoint/Fenergo documents need a separate delivery gate. Current search is for committed captured evidence and does not yet delegate current source-use authority. Implement authorized on-demand capture, parsing, versioned citations and current source-use checks before connecting source-backed documents to model retrieval. Permission checks happen on use; do not promise immediate push invalidation when no change feed exists.

## Delivery plan

Planning estimates assume two engineers with part-time domain/schema review and available vendor sandbox access. These are proposed engineering ranges, not delivery commitments.

| Phase | Deliverable | Exit evidence | Estimate |
| --- | --- | --- | --- |
| 0 | Select pilot case/task, capture Salesforce/Fenergo schemas/samples, map to existing ontology and source-ID crosswalk | Named products/types/required fields, authority rules, approved expansions and known source gaps | 0.5–1 week |
| 1 | API resource/driver contract, bounded collection mapping, case pull orchestration and receipt/commit tracking | PostgreSQL compatibility; revision-bound discovery/sample/enablement; one authorized case pull and non-mutating preview | 1–2 weeks |
| 2 | Salesforce CRM plus one discovered FSC profile | Correct person/business identities, subject-filtered pagination, approved relationships, immutable case snapshot and failure/retry behavior | 1–2 weeks |
| 3 | Fenergo verified identity, associations and source review evidence | Draft/verified separation, ontology-aligned ownership, partial-assessment handling and a real consumer packet after both source bundles commit | 1.5–2.5 weeks |
| Later pull sources | One bank-selected core and selected document capture | Bounded transaction-window coverage, explicit holdings where qualified, source-backed document authorization and citations | Estimate after selecting resources |

Target approximately **4–6 weeks for the Salesforce + Fenergo pull-only pilot**, with adapter work overlapping once shared contracts stabilize. Allow 6–8 weeks if access, mapping or consumer qualification needs substantial repair. Core/document work and new ontology types are additional scope. Removing CDC eliminates the inbox, subscriptions, durable source cursors, replay-window recovery and reconciliation workers from the critical path.

The implementation sequence is contracts and ontology mapping fixtures → source driver → control/gateway qualification → case acquisition/commit → case action and packet preview. Keep the existing context.records.fetch.v1 capability where request/output semantics remain compatible. The case binding/pull endpoints and shared API resource contracts are now implemented; the implementation guide distinguishes them from bank-specific qualification and later portfolio work.

## Deferred CDC phase

Keep stable source identities, source revision/time metadata, mapping digests, gateway provenance and idempotent case commits now. These are useful for on-demand pulls and provide a clean future event-triggered acquisition path without implementing synchronization abstractions early.

A later phase can add change subscriptions, an authenticated durable inbox, acknowledgment, source cursors, coverage watermarks, explicit case subscriptions/fanout, tombstones, outage reconciliation and background schedules. CDC would trigger the same bounded qualified acquisition and commit path. Its source-position and delivery state will remain distinct from case snapshot/version identity.

Vendor-specific retention and recovery details belong to that later phase: [Salesforce event durability](https://developer.salesforce.com/docs/platform/pub-sub-api/guide/event-message-durability.html), [Fenergo notifications](https://docs.fenergonebula.com/developer-hub/event-notifications/event-notifications-overview), [Dataverse change tracking](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/use-change-tracking-synchronize-data-external-systems), [Graph delta](https://learn.microsoft.com/en-us/graph/api/driveitem-delta?view=graph-rest-1.0). No changes to these feeds are prerequisites for the pilot.

## Pilot acceptance scenarios

1. An authorized operator pulls context for one existing case. Every source read resolves to its allowed subject set, purpose and declared resource fields; an arbitrary vendor ID or another case's subject is rejected.
2. A company exists in Salesforce and Fenergo under different IDs. The reviewed crosswalk and field authority rules select the intended identity while preserving both source lineages. A similarly named company remains distinct.
3. A Person Account and its backing Contact produce one person. Distinct business roles can exist without duplicating that identity.
4. Fenergo draft changes stay source evidence; verified data supplies the qualified canonical identity. A journey completion is source evidence, not an EHF approval or executable task.
5. An owner holds 25 percent directly and another association reports an aggregate 60 percent. The mapping emits 0.25 for the direct interest and preserves the aggregate basis without double-counting.
6. A High risk label or green screening flag is preserved in SourceRecord. It cannot satisfy the current complete RiskAssessment or ScreeningExecution contract.
7. Related parties exceed a budget, a required page is missing, or a source times out. The source bundle does not partly commit; the dependent task reports incomplete context. Retry commits idempotently within existing gateway/case-command rules.
8. Existing context is stale, or the user requests a force pull. The declared acquisition runs before a new task snapshot is captured; failure cannot silently fall back to prior data. A running task's manifest stays bound to its original snapshot.
9. Source access, schema, mapping, credential generation or the case's released plan changes. Acquisition rechecks its pins and authority before committing. Missing declared relationships remain unresolved in the packet graph.
10. Opening a case, inspecting the ontology and previewing context make no vendor call or case write. Another case receives no automatic update when this case is refreshed.

The completion criterion is a **real case task preview over committed Salesforce + Fenergo records, using existing ontology products and declared relationships**, with explicit gaps for unsupported source details. No CDC or new ontology types are needed to prove that slice.
