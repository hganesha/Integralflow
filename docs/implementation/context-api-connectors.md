# On-demand bank API context connectors

Status: implemented foundation, 2026-11-09. Salesforce and Fenergo drivers, qualification, reviewed case bindings, explicit case pulls and canonical commits are implemented. Tests use synthetic vendor responses and an isolated PostgreSQL database. Bank-specific schemas, credentials, mapping profiles and consumer acceptance still need live qualification. The [v2 plan](context-connectors-v2-plan.md) describes the wider portfolio and pilot acceptance criteria.

## Implemented behavior

An operator saves an API connection and resource, discovers its schema, maps selected source fields to the pinned ontology, runs an authorized live sample, and enables the exact tested revisions. A release approver then binds that mapping to one case, one acquisition plan/node, its approved source context and an explicit canonical-subject/source-key crosswalk. The case's Pull context action submits canonical subjects; the service derives vendor keys and starts a normal acquisition run.

The gateway performs a bounded source read and deterministic mapping. The existing `RecordCanonicalRecords` command atomically records the bundle and its immutable lineage. The UI reports committed only after the run completes with its canonical-write receipt. Viewing a case, refreshing status and previewing context perform no vendor reads or case writes. Retry is an explicit new request; transport retries remain within the same bounded invocation.

A dedicated acquisition plan can commit observations into a case whose main workflow uses another plan. Migration 053 authorizes this through an execute-only function that resolves current reviewed binding, mapping, resource, connection and enablement pins. The case API exposes only case metadata to that acquisition plan. Its commands can contain only mapped source observation types for approved subjects with the correct connector provenance. It cannot issue workflow, approval or decision commands. The case's main plan remains unchanged.

Source values remain untrusted external context under the existing assembler. No ontology types or semantic relationships were added. Identity, source-evidence and existing mapping templates use the pinned canonical schemas; declared references resolve through the existing relationship catalogue. Unsupported workflow states and incomplete assessments belong in `SourceRecord`, whose template explicitly marks coverage incomplete. The compiler now uses v3; recompile, resample and re-enable existing mappings before runtime use.

## Deploy and qualify

1. Apply control migrations through `053_context_pull_authority.sql`, the control grant matrix, and the normal case-store migrations/grants. The case API execution principal receives EXECUTE on the narrow authority function; it receives no control-table read grant. Keep the control, gateway and binding environment names consistent (`EHF_ENVIRONMENT`, falling back to `RELEASE_ENVIRONMENT`, then `local`).
2. Enable `context-salesforce` and/or `context-fenergo` in `GATEWAY_ADAPTERS` alongside the deployment's existing adapters. They are disabled by default. Register and release the bank's connector binding `context-salesforce:<mappingId>` or `context-fenergo:<mappingId>` for `context.records.fetch.v1` with read effect.
3. Mount the credential JSON below under the connection's `CONTEXT_SOURCE_*` reference in both control and gateway services. The browser config contains only that reference. Rotate `credentialGeneration` and requalify dependent revisions when the identity changes.
4. In Context setup, choose the bank API template and replace its example org/instance, API version, field paths, resource operation and response paths. The Fenergo template is a starting point for the deployed tenant specification, not a portable DTO contract. Discover and pin the live schema before a live sample. Define approved source/access/policy artifacts covering the dataset, actual source field paths, API origin and exact token URL.
5. Create the mapping with required canonical fields and approved enum/status translations. A reviewed `crosswalk` expression can map different vendor keys to the same canonical identity; its values are digest-bound. Set the case binding's subject ID to the mapping's resulting subject, not an independently guessed ID. Configure ownership collection outputs explicitly and retain direct versus aggregate basis. No fuzzy identity merge, Person Account deduplication or risk-label inference is automatic.
6. Compile and release a dedicated acquisition plan as described below. Run a live sample under its approved source authority and enable the exact eligible mapping revision. Uploaded samples and fixtures cannot enable a live source.
7. Save an approved case binding, including the source-context artifact for that specific case. The setup UI permits a separate case source-context digest; the sample's source context is only a default. Pull from the case, inspect the committed records and then preview the consumer node under the case's main plan.

Credential JSON (placeholders, never commit actual secrets):

```json
{
  "tenantId": "tenant_example",
  "connectorId": "context-salesforce:crm-identity",
  "generation": "v1",
  "instanceId": "bank-org",
  "baseUrl": "https://bank.my.salesforce.com/",
  "tokenUrl": "https://bank.my.salesforce.com/services/oauth2/token",
  "clientId": "<operator-managed client ID>",
  "clientSecret": "<operator-managed client secret>"
}
```

OAuth client credentials are the implemented authentication profile. Optional OAuth scope belongs in `connection.api.scope`. Credential tenant, connector, generation, instance and endpoint values must exactly match the connection. Both API and token destinations must be approved by source policy. Redirects are refused. Other authentication profiles require a separate driver extension and qualification.

## Acquisition plan and case binding

Use four nodes with three unconditional data edges:

```text
input → transform(project fields=["subjects"]) → tool(context.records.fetch.v1) → output
```

The tool uses the vendor's mapping binding and `usePredecessorInput: true`. Its only declarative case write is:

```json
{
  "commandType": "RecordCanonicalRecords",
  "payload": { "records": "{{output.records}}" }
}
```

Declare a nonempty case-metadata selector on the tool (`source: "case"`, `path: "case"` or a field beneath it), with one purpose, appropriate classification policy, agent field ceiling and case-read grant. The normal compiler supplies the node's permission envelope and RecordCanonicalRecords grant. No prompt, skill, model context, evidence capture, conditional edge or additional case effect is permitted. The signed metadata snapshot supplies policy authority; the runtime reads only the current sequence through signed `/v2/cases/:caseId/sequence` before committing. Normal sequence conflicts fail the pull and require a new explicit attempt.

`POST /v1/context/cases/:caseId/bindings` requires an interactive release approver plus case-read authority. Body:

```json
{
  "binding": {
    "kind": "case-binding",
    "id": "case-crm-identity",
    "caseId": "CASE-123",
    "mappingId": "crm-identity",
    "mappingDigest": "<64-character mapping digest>",
    "enablementRevision": 1,
    "planDigest": "<64-character released acquisition plan digest>",
    "nodeId": "fetch",
    "sourceContextDigest": "<64-character approved case source-context digest>",
    "subjects": [{ "subjectId": "<mapped canonical entity ID>", "sourceKey": "<approved vendor ID>" }],
    "enabled": true
  },
  "expectedRevision": 0,
  "reason": "Approve case subject crosswalk"
}
```

Bindings are immutable revisions. Saving `enabled: false` pauses a binding; source mapping pause also blocks pulls. A changed binding, mapping, resource, connection or enablement invalidates the existing pin. Case-binding keys are absent from general source inventory and sanitized from case status responses. An approver must supply the reviewed crosswalk when changing it.

`GET /v1/context/cases/:caseId/bindings` returns case-specific binding metadata and canonical subjects. `POST /v1/context/cases/:caseId/pulls` requires interactive run-start and case-read authority and accepts only:

```json
{
  "bindingId": "case-crm-identity",
  "expectedBindingDigest": "<digest returned by the binding endpoint>",
  "subjects": ["<approved canonical subject ID>"],
  "idempotencyKey": "<unique request key>"
}
```

`GET /v1/context/cases/:caseId/pulls` returns the last 20 run outcomes and commit-receipt metadata. HTTP success or run completion without the matching write receipt is not reported as a committed bundle. The ordinary runtime run/events retain detailed execution diagnostics. A new explicit pull creates new observation versions; replay within the existing invocation/command identity remains idempotent.

## Driver and mapping boundaries

| Area | Implemented contract |
| --- | --- |
| Salesforce | Selected-field Describe fingerprint, pinned REST version, escaped subject-filtered SOQL, complete same-version query-locator pagination. Relationship dot-walking and nested SOQL are refused; configure separate resources for relationship objects, with the reviewed parent subject key projected into each row. Installed FSC object names and Person Account identity rules require bank mappings. |
| Fenergo | A tenant OpenAPI-pinned GET operation under selected query services, one `{subject}` path parameter, selected JSON field projections, optional records/continuation paths. Array results require an explicit continuation contract; continuation must retain the subject path and origin. Command APIs, Supergraph and legacy/on-premises profiles are not implemented. |
| Limits | At most 20 subjects, 100 source rows, 40 HTTP requests including retries, 512,000 aggregate response bytes and 30 seconds per acquisition. Collections expand at most 64 members per row/output; at most 200 canonical candidates may commit. Oversize, missing subject, invalid schema/mapping/reference or incomplete pagination fails the bundle. |
| Precision and lineage | Data JSON numbers preserve their original lexemes before JavaScript rounding. Decimal and percent-to-fraction transforms operate on strings. Collection paths retain member-index lineage. Source observation timestamps remain distinct from fetch time; pulling does not make an old assessment newly assessed. |
| Canonical authority | Only mapped observation types in `BANK_CONTEXT_RECORD_TYPES` can enter through the API acquisition path. Required fields and enums still come from canonical validation. Partial risk/screening details remain source evidence. Platform execution, approval, decision, Application/holding and source-document capture contracts are outside this path. |

Multi-source consumers should be started only after every required bundle commits, using a new case snapshot. This increment provides individual case pull runs and the existing explicit acquisition-node mechanism; it does not add a multi-source coordinator or automatic missing/stale acquisition scheduler. Existing context requirements still enforce what a consuming task may use. There is no continuous source consistency guarantee between separate REST reads.

Core banking, document bytes/citations and source-use delegation, packaged bank-specific FSC/Fenergo profiles, and broader portfolio adapters remain later delivery gates. CDC, webhooks, source cursors, fanout, deletion propagation and scheduled SaaS synchronization are deferred. Existing PostgreSQL snapshot refresh remains independent.

## Verification

Driver tests cover selected-field acquisition, schema drift, scope and destination rejection, complete pagination, missing subjects, row/byte limits, exact numeric lexemes and tenant OpenAPI GET qualification. Mapping tests cover atomic nested ownership outputs, fractions, lineage and unresolved relationships. Control/gateway tests cover exact pins, reviewed subject resolution, uncommitted run status and source-key redaction. PostgreSQL tests exercise immutable tenant-isolated bindings, execute-only authority, foreign-plan canonical commit, unchanged case workflow plan, denied business commands and revocation after binding changes. Case API/runtime tests verify signed metadata-only sequence reads. Playwright checks API templates, non-mutating case/status views and accessibility.

Live bank acceptance must additionally establish real scopes, verified/draft semantics, Person Account/FSC models, ownership basis, source-time semantics, consumer coverage and complete case task previews over both source bundles. Synthetic fixtures and a healthy OAuth response are not that evidence.
