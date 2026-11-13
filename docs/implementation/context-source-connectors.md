# Enterprise context sources

Implementation on `codex/context-source-connectors`. This extends the existing capability gateway and context pipeline; it does not replace the Databricks serving/UC/vector, HTTP operation, pgvector or domain adapters.

## User journey

Open **Platform → Context sources**, or follow the link from **Contextboard → Engineer** or the provider switchboard.

1. Add a connection or import a connection from an exported onboarding deployment profile. Review its endpoint, identity, credential reference and resource scope.
2. Map a context product to a pinned connection revision. Declare source parameters, canonical object type, stable record key, observation timestamp, field mapping and freshness limits. Canonical types and required fields come from the pinned ontology. Use the keyboard-accessible mapping table or its equivalent JSON code view; deterministic transformations include trimming, case conversion, JSON decoding, decimal validation and timezone-qualified timestamp parsing.
3. Discover the schema, preview the mapping, and qualify a bounded read. Preview records are validated in memory; only field metadata, fingerprints, counts, outcome and actor are retained in the check report.
4. Activate the qualified revision with a reason. Configure the resulting connector ID in a process-flow capability binding, and approve the workflow's source artifacts and release through the existing governance process.
5. For refresh, first publish a process flow pinned to the active connector. Configure its plan digest, approved source-context digest, case ID and interval in the binding review. Refresh configuration has its own durable state, so enabling a schedule does not require changing the source binding digest.

Administration can configure connections. Enabling refresh additionally requires `integration.activate` and `run.start`. Reads require `capability.read`. Browser identity and tenant fields are never accepted as authority; the BFF resolves the session and applies CSRF protection.

## Contracts and persistence

`packages/contracts/src/context-sources.ts` owns the schemas. `scripts/sync-context-source-contracts.ts` exports the API JSON Schema; OpenAPI references that file, and `pnpm ui:sync` generates the client and browser types. Do not edit generated client files.

Migration `045_context_sources.sql` adds tenant-scoped connection/binding heads, immutable revisions, immutable check reports, immutable audit events and durable refresh jobs. The declarative grant matrix separates configuration writes (control API), qualification writes (gateway) and refresh claims (integration worker). RLS is forced on the new tables. The worker can inspect run identity/status columns, not run input.

Connections can support multiple bindings without copying secret values. Bindings pin exact connection revisions. Draft changes preserve active revisions. Activation pins a specific successful qualification report, including the schema fingerprint; later checks cannot change an active workflow's expected schema. Restoring a prior qualified revision uses the same activation API and freshness check on qualification evidence. Disabling a source prevents subsequent adapter reads, including reads through older plan pins.

Connector IDs contain a tenant-derived prefix and the immutable binding revision:

```text
context-source:<tenant-hash>:<binding-id>.r<revision>
```

Qualification registers technical readiness. Activation enables the source revision. Neither operation supplies source-policy approval or an executable workflow release. Quarantined/retired connector status is never lifted by requalification.

## Supported execution

| Connector | Transport | Discovery and execution |
| --- | --- | --- |
| PostgreSQL | PostgreSQL wire over verified TLS | Scoped `information_schema` discovery and parameterized reads in a read-only transaction |
| Microsoft Fabric | TDS over verified TLS | Scoped column discovery and parameterized, bounded SELECT using an Entra access-token reference; read-only database grants remain required |
| Databricks SQL | HTTPS | Unity Catalog column discovery and parameterized SQL Statement Execution reads |
| OpenAPI/REST | HTTPS GET | Pinned operation path, JSON OpenAPI document, local schema references and typed path/query parameters; response arrays may be top-level or under a named field |
| Snowflake | HTTPS SQL API | Parameterized reads; schema obtained from the bounded query response |
| BigQuery | HTTPS query API | Named parameters and bounded Standard SQL; schema obtained from the query response |
| Kafka / object storage | Approved external connector gateway over HTTPS | Bounded gateway discovery/read contract; the external gateway owns native transport and stream/object checkpoint semantics |

SQL uses a deliberately small grammar: `SELECT columns FROM object [WHERE column = :parameter [AND ...]]`. The driver quotes the scoped relation and identifiers and binds values separately. Functions, expressions, CTEs, comments and multiple statements are refused. `SELECT *` expands to mapped fields plus the record key and observation timestamp. Reads are capped at 200 records, 60 seconds and a 2 MiB serialized result; truncation prevents qualification and runtime admission. Asynchronous cloud queries that do not complete in the bounded request fail explicitly.

Delegated identity is represented as configuration, but the gateway does not yet wire provider token exchange. It fails closed; it never substitutes the service credential. Use service identity for executable bindings and refresh.

This implementation adapts the patterns reviewed in Lattice at `cbf6282d29ae7e16b46e94c2e361080ab3c8935e`; it does not claim identical coverage for every provider API or SQL dialect.

## Deployment and secrets

Enable the optional adapter with `GATEWAY_ADAPTERS=default,context-source`. Give the gateway an exact, tenant-scoped destination/credential allowlist:

```json
{
  "tenant_demo": [
    {
      "provider": "postgresql",
      "endpoint": "postgresql://customer-db.internal:5432/customer",
      "credentialRef": "env:CUSTOMER_SOURCE_CREDENTIAL"
    }
  ]
}
```

Set this JSON as `CONTEXT_SOURCE_TARGETS_JSON`. The referenced PostgreSQL credential is a secret JSON value containing `username` and `password`. HTTPS/Fabric references resolve a bearer/access token. Supply optional private PostgreSQL CA trust as `CONTEXT_SOURCE_CA_PEM`; certificates are always verified. Configure provider token rotation through the deployment's secret delivery and gateway lifecycle.

The Azure runtime recipe accepts optional `contextSources` and `contextSourceCaPem` in its private operator inputs. Only the gateway receives destination grants, source credentials and additional trust. Reserved service/environment variable names are refused. Other hosting recipes must supply the same gateway configuration explicitly. Imported onboarding proposals grant no destination access by themselves.

For an external connector gateway, `POST /v1/context/read` receives provider, operation (`discover` or `read`), scoped resource, parameters and maximum row count. It must return JSON `rows`, stable typed `fields` (`name`, `type`, `nullable`) and an explicit `truncated` flag when applicable. Stream consumers and object readers must supply real source observation timestamps. A gateway URL and a saved catalog entry are not proof of a working native Kafka/object-store connection.

## Runtime and security

Workload reads use the existing signed execution envelope and common acquire/transport/use source-policy evaluator. PostgreSQL and TDS destinations are checked by exact protocol, host, port and database before opening a socket; HTTPS retains origin/path checks and redirect refusal. Deployment destination grants are also checked on every connector call. Metadata probes and administrative test reads use the same destination grants; they are technical qualification, not case-purpose authorization.

The adapter validates mapped data against the pinned closed canonical schemas and supplies their actual context-schema version. It checks its pinned source schema fingerprint before returning records. Missing required fields, invalid/future/stale observation timestamps, truncation and schema drift fail explicitly. Canonical records carry binding and qualification lineage and the gateway adds source-decision provenance. Existing process-flow case-write contracts materialize records through `RecordCanonicalRecords`; context assembly remains network-free and treats these records as `UNTRUSTED_EXTERNAL`.

Refresh jobs have expiring claims, fencing by claim/revision, stable dispatch idempotency keys, overlap suppression and a five-failure pause. They start normal governed workflow runs using the integration worker's signed envelope. They do not fetch source data or mutate cases directly. The UI reports schedule state, current run, last successful workflow and stable failure codes; a successful flow is not presented as an independently measured dataset watermark. Refresh case input is restricted to the case ID.

## Validation and release limits

- Unit tests cover query restrictions, source parameters, target isolation, fail-closed delegation, OpenAPI discovery, response limits, mappings, stale data and native endpoint authorization.
- Database tests cover service grants, tenant isolation, immutable revisions, concurrent edits, pinned qualification and refresh claim recovery.
- `@ehf/e2e-connectors` exercises real BFF/control/gateway HTTP calls, a local HTTPS source, source-policy approval/revocation, schema drift, canonical records and context-pack integrity. A separate native PostgreSQL test uses verified TLS and a read-only database login.
- Browser tests cover the source configuration/qualification/activation journey, read-only access and accessibility alongside Contextboard/catalog regressions.

The PostgreSQL/HTTPS fixtures are automated acceptance evidence. Live Databricks, Fabric, Snowflake, BigQuery and external-gateway environments require their own scoped qualification before production activation. No live-provider certification is implied by the implementation or synthetic tests.
