> **Version 2 addition:** this guide describes the original production-host layer. For the new 42-client / 732-operation private credential-testing layer, its separate execution profile, and the 334 still-unimplemented records, read [Vendor_Testing_Guide.md](Vendor_Testing_Guide.md). Historical 52-test/six-client counts below refer to the original layer; the current combined suite has 804 passing tests.

# API Wiring — Operator and Integration Guide
**Version 1.0 • Research/catalog snapshot: 15 October 2026**

## 1. Acceptance boundary
The delivered service completes the **host-side orchestration path** for all catalog bindings. It does not complete every external vendor implementation. Current exports contain 376 catalog records, 824 proposed provider/capability bindings, 822 simulatable bindings, two quarantined historical bindings and zero approved live connections.

The original catalog's evidence limits still apply: the majority of provider/capability claims are discovery candidates; many records represent products, legacy names, networks or source families rather than independent active vendors. A route being cataloged does not establish a native API, licensing rights or bank adoption.

### Completion levels
1. **Registered:** provider/capability has a canonical request/result family.
2. **Simulated:** synthetic data can traverse the host API, durable worker, validation, encrypted storage and event path.
3. **Native mapped:** authorized native contract and versioned request/response mapping exist.
4. **Transport tested:** HTTP/authentication/signature/error handling tested against a controlled test server.
5. **Vendor sandbox accepted:** actual sandbox credentials, entitlements, product/country coverage and all required scenarios validated.
6. **Production validated:** legal, security, privacy, compliance and operational acceptance plus a monitored canary.

The service automates levels 1–2 throughout the catalog, includes nine representative fixture normalizers, and supplies six HTTP client subsets exercised with mocked HTTP responses. It does not claim levels 5–6 for any provider. `live_ready` is a check of **operator-declared configuration prerequisites**, not independent verification of a vendor's acceptance or licensing.

## 2. Runtime architecture
```text
Authenticated caller
       |
 POST /v1/checks (or per-item batch submission)
       |
 host schema + tenant + idempotency + routing / entitlement gates
       |
 encrypted request + database-backed job
       |
 compare-and-swap worker lease
       |
 simulation OR native subset / approved declarative connector
       |
 bounded HTTPS transport -> JSON decode -> host normalization
       |
 host JSON Schema + semantic reference validation
       |
 transaction: current check + immutable result/evidence + outbox event
       |                         |
 GET results / restricted artifact    approved signed event destination
```

SQLAlchemy is used for SQLite and PostgreSQL. Database tables are created idempotently at startup for this starter; there is no production-grade versioned migration system. API and worker processes must share the same database, encryption key, binding configuration and required secrets. The provided Compose file starts the worker after the API's health check to avoid concurrent first-install schema creation.

### Implementation files
| Module | Responsibility |
|---|---|
| `wiring/core.py` | Configuration, authentication lookup, catalog, host validators, readiness and strict mapping templates |
| `wiring/store.py` | Encrypted payload columns, idempotency, database jobs, leases, result history, inbox/outbox and audit |
| `wiring/connectors.py` | Simulation, native request/auth subsets, generic JSON transport, polling and declarative response mapping |
| `wiring/worker.py` | Job execution, fail-closed normalization, retries, reconciliation states and signed event delivery |
| `wiring/app.py` | FastAPI host endpoints, authorization, body bounds, batch handling, tenant isolation and verified webhook ingress |
| `vendor/atlas/normalizers.py` | Representative original fixture normalizers; not complete native product coverage |

## 3. API contract
Bearer credentials resolve to an authenticated tenant and role. Clients cannot select another tenant by changing a request body or opaque check ID.

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/healthz` | Public runtime mode/counts; not a comprehensive dependency readiness probe |
| GET | `/v1/providers` | Search and page the catalog |
| GET | `/v1/providers/{provider_id}` | Provider record and binding readiness |
| GET | `/v1/capabilities` | Canonical capability vocabulary |
| GET | `/v1/connections` | Every binding and explicit live blockers |
| GET | `/v1/schemas/{name}` | Host/request/adapter/event JSON Schema |
| POST | `/v1/checks` | Submit one canonical check; operator/admin |
| POST | `/v1/checks/batch` | Up to 50 independent per-item submissions; HTTP 207 with per-item outcomes |
| GET | `/v1/checks` | Tenant-scoped recent checks |
| GET | `/v1/checks/{id}` | Current operation state, attempt count and safe error code |
| GET | `/v1/checks/{id}/results` | Immutable canonical result versions, newest first; `limit`/`offset` pagination |
| GET | `/v1/checks/{id}/artifact` | Admin-only decrypted latest restricted evidence; optional `result_id` selects an archived version |
| POST | `/v1/checks/{id}/retry` | Admin replay of failed/dead-letter operations; ambiguous calls are refused |
| POST | `/v1/webhooks/{id}` | Unauthenticated at bearer layer; requires approved cryptographic vendor profile and registered resource match |
| GET | `/v1/events` | Tenant result-change events, oldest first; offset pagination |
| POST | `/v1/event-subscriptions` | Admin subscription to a preconfigured destination reference |
| GET | `/v1/deliveries` | Tenant delivery state and retry/dead-letter status |
| GET | `/v1/audit` | Admin audit of tenant operational and restricted evidence actions |
| POST | `/v1/demo/run` | Demo only; generates a synthetic request for a selected catalog operation |

`docs/openapi.json` is exported from the actual FastAPI application. The exported snapshot includes demo routes. A live application does not register `/v1/demo/run` and does not expose the Swagger HTML page. The OpenAPI JSON remains available and contains no secrets.

### Submit a canonical request
```json
{
  "provider_id": "persona",
  "request": {
    "schema_version": "1.0.0",
    "request_id": "your-request-reference",
    "tenant_id": "your-authenticated-tenant",
    "idempotency_key": "your-unique-idempotency-key",
    "capability": "identity.person.verify",
    "subject_entity_id": "customer-1",
    "entities": [{
      "entity_id": "customer-1", "entity_type": "person",
      "names": [{"full":"Alex Example","kind":"legal"}],
      "identifiers": []
    }],
    "purpose": "customer_due_diligence",
    "legal_basis": "institution-approved-basis",
    "policy": {
      "policy_id":"bank-cdd", "policy_version":"1",
      "jurisdictions":["GB"], "data_residency_allowlist":["GB"]
    },
    "routing": {
      "provider_allowlist":["persona"], "required_datasets":[],
      "allow_fallback":false
    },
    "input": {"provider_record_id":"inq_synthetic"},
    "extensions": {}
  }
}
```
Send `Idempotency-Key` equal to the body key. The same tenant/key with the identical request/provider returns the existing check; changed content returns 409. The default demo principal belongs to `demo-tenant`, so adapt the example tenant or configure your own API key. Actual vendor inquiry IDs must be created through an authorized onboarding flow; the native Persona subset here retrieves existing inquiries only.

The provider is chosen explicitly for each check. `provider_allowlist` is enforced; the starter **does not automatically rank or fall back across vendors**, even if the request permits fallback. This avoids pretending two services perform equivalent checks. An institution-specific approved fallback/ranking policy is a separate extension.

## 4. Canonical semantics and consumer behavior
The previous common schema is embedded as a local snapshot: `vendor/atlas/schemas/host.schema.json`. It covers 37 capabilities and 18 result families with entities, relationships, assertions, coverage, provenance and provider-native scores.

- A host job `completed` means the submitted retrieval/mapping operation finished, not that KYC, screening or a bank relationship was approved.
- Check `execution`, `assessment`, `coverage`, `result.kind`, errors and warnings before using an output.
- All source normalizers and declarative mappings have bank decisions forcibly reset to `not_evaluated` by the host connector.
- A Persona completed inquiry is not an approved customer. A Middesk approved status can be a client workflow state. A screening candidate is unresolved until disposition.
- Generic simulations use `not_checked` or unknown coverage and label `extensions.execution_mode=simulation`. They are not synthetic approximations of undocumented vendor wire formats.
- Preserve namespaced identifiers, original statuses, unknowns, original-script names and vendor score semantics. Do not average scores or auto-merge name/shared-device matches.
- The service is an integration layer, not a bank policy engine, entity-mastering platform, consent ledger, UBO calculator or regulatory filing authority.

## 5. Configure a live binding
`config/contracts.json` ships empty. `config/connection-templates.json` contains 824 disabled templates with unknown native fields left null. Copy **only a verified binding** into the active file, then fill its documented contract and institution-approved scope.

Example contract identity:
```json
{
  "persona:identity.person.verify": {
    "enabled": false,
    "approved": false,
    "maturity": "documented_subset",
    "connector": "native_subset",
    "base_url": "https://api.withpersona.com",
    "approved_base_urls": ["https://api.withpersona.com"],
    "product": "CONFIRM_CONTRACTED_PRODUCT",
    "api_version": "2026-09-29",
    "mapping_version": "bank-persona-1",
    "tenant_ids": [],
    "countries": [],
    "residency_regions": [],
    "processing_regions": [],
    "purposes": [],
    "legal_bases": [],
    "policy_refs": [],
    "upstream_datasets": [],
    "entitlement_ref": null,
    "required_secret_env": ["PERSONA_API_KEY"],
    "api_key_env": "PERSONA_API_KEY",
    "async_mode": "sync"
  }
}
```

A binding is denied until it is enabled, operator-approved, has declared sandbox/production acceptance, a product/API/mapping version, tenant assignment, country/residency/processing scope, policy references, lawful-purpose/basis scope, datasets, entitlement and required secrets. Empty lists mean deny.

Request-time checks additionally compare the caller tenant, purpose, legal basis, jurisdictions, residency restrictions, policy version, required datasets, consent reference where configured, provider allowlist and deadline.

These checks validate references and configuration membership; they do **not** independently verify the existence/validity of a customer's consent, your legal basis or a licensing contract. Integrate authoritative institution policy/consent/entitlement systems before real customer processing.

After obtaining actual vendor sandbox evidence and internal approvals, change the relevant declared maturity to `sandbox_tested` or `production_validated` and enable the binding. Do not mark those fields merely to bypass readiness. Restart the API and worker to load updated configuration; hot reload is not implemented.

### Six native subsets
| Adapter | Operation | Authentication implemented | Important restriction |
|---|---|---|---|
| Persona | GET `/api/v1/inquiries/{id}` | Bearer + version + kebab key headers | Existing inquiry retrieval only |
| Companies House | GET `/company/{number}` | Basic API key, blank password | Registry lookup is not applicant KYC |
| OpenCorporates | GET `/v0.4/companies/{jurisdiction}/{number}` | API token query parameter | Redact URL query strings in all HTTP/proxy logs |
| GLEIF | GET `/api/v1/lei-records/{lei}` | Public endpoint | Parent relationships are not natural-person UBO proof; checksum verification remains external |
| OpenSanctions | POST `/match/default` | ApiKey authorization | Single-query response subset; no automatic pagination retrieval |
| Plaid | POST `/identity/match` | Client ID, secret and approved account access token | Account token reference must resolve through tenant-approved configuration; consent required by request planner |

Authentication and mappings are request subsets, not complete provider product SDKs. Required product-specific steps, onboarding sessions, document upload, SDK capture and provider account provisioning may exist outside these retrieval operations. Sumsub, Veriff and Middesk remain fixture-normalizer examples here, not live HTTP connectors.

### Secret references
No real vendor keys are in the bundle. Native clients load environment variable names specified by operator configuration. Generic adapters can inject fixed header prefixes plus values from named environment variables. Plaid's `account_token_refs` maps approved opaque request references to secret environment variable names. A client cannot choose an arbitrary environment variable to read.

For a production institution, replace environment injection with a tenant-aware secret-manager interface, short-lived credentials and access auditing. API keys in `API_KEYS_JSON` are host credentials, not provider keys. They are static environment values, so rotation/revocation and external identity federation must be integrated separately.

## 6. Generic JSON API wiring
For an authorized provider not covered by the six subsets, use `connector=declarative`, a fixed approved HTTPS base URL and documented method/path. `request_template` builds a native JSON body from the canonical request. `response_template` builds a **complete host envelope** from native data and trusted context.

Supported template forms:
```json
{"$request":"/entities/0/names/0/full"}
{"$native":"/verification/id"}
{"$context":"/subject_entity_id"}
{"$each":"/matches","template":{"id":{"$item":"/id"}}}
{"$enum":{"path":"/status","values":{"approved":"passed","rejected":"failed"},"unknown":"unknown"}}
```
Missing required pointers fail closed. String values are literals: no Python evaluation, dynamic code loading or arbitrary HTTP expression execution occurs. Provider-returned tenant/request IDs cannot override trusted host context. Operator-controlled templates are trusted integration code and must be reviewed, versioned and tested.

Dynamic paths use a `path_segments` list. Each segment is individually percent encoded. Absolute URLs, protocol-relative URLs, traversal segments, query strings and fragments are denied in relative path fields. Source-provided URLs are not followed. The transport verifies TLS, disables redirects and environment proxies, limits payload size and uses timeouts.

**Not supplied generically:** OAuth token exchange/refresh flows, mutual TLS provisioning, vendor-specific asymmetric signatures, SOAP/WSDL, SFTP, binary document upload, file/bulk parsing, network-specific PKI, SDK capture, paid data provisioning or manual EDD service delivery. Add dedicated plugins from authorized contracts rather than pretending JSON templates cover these transports.

## 7. Async workflows
### Synchronous
`async_mode=sync` maps the immediate JSON response. An upstream 2xx is not a passed KYC outcome. For retrieval operations whose vendor resource remains pending, the result preserves pending/inconclusive semantics; the host retrieval operation itself can still be complete.

### Polling
`async_mode=poll` requires:
- `submission_resource_pointer`: native JSON pointer to the provider resource ID;
- `completion_pointer` and `completion_value`: documented completion condition;
- `poll_path_segments`: fixed segments plus trusted resource ID;
- `poll_seconds` and `max_polls`: bounded polling schedule.

The first submission artifact and provider ID are persisted. Later runs issue GET to the polling resource, not another paid creation request. A deadline or max-poll failure requires operational review. Native polling-completion values must be mapped from a verified vendor contract; they are not guessed.

### Webhook
`async_mode=webhook` persists the submission artifact and provider resource ID, then enters `awaiting_webhook`. The callback URL uses the random host check ID. A configured profile must declare an approved signing scheme, secret environment variable, signature header and resource ID pointer.

Implemented verifier primitives:
- `raw_body_hmac_sha256`: signature covers exact callback bytes;
- `timestamp_dot_body_hmac_sha256`: signature covers `timestamp + '.' + raw_bytes` and requires a signed timestamp within five minutes.

These are primitives, **not a statement that every vendor uses these exact conventions**. Provider-specific encodings, prefixes, headers, versions, canonicalization, asymmetric signatures, rotations and timestamp semantics must be implemented/validated before approving that vendor profile. A raw-body-only scheme cannot prove freshness; it relies on exact duplicate detection, resource matching and legal state transitions, and may be insufficient for your provider.

The signature is verified before JSON parsing. The signed resource ID must match the provider resource registered by the host, not a tenant identifier from the callback. The durable inbox deduplicates exact callback-byte digests. A duplicate is acknowledged without changing state; new callbacks after completion are rejected for reconciliation instead of silently overwriting newer results. Ongoing multi-update monitoring events require a separately designed event-order/version model; this starter's callback path is one-shot completion.

A callback acknowledgement follows durable inbox/job persistence, not completion of downstream normalization. Original callback bytes and their hash are retained encrypted, separately from the submission response. Signature failure messages do not leak the expected signature or secret.

## 8. Retries, leasing and reconciliation
Jobs have `queued`, `running`, `retry_wait`, `awaiting_webhook`, `authorization_required`, `completed`, `partial`, `failed`, `dead_letter` and `reconciliation_required` states. A worker atomically claims a job through a state/version compare-and-swap and leases it. The default lease is 90 seconds; the network timeout is shorter. Expired demo leases may be retried. An expired live lease is not blindly repeated.

Live admission and worker attempts require the gateway's signed `X-Source-Authorization` proof. Configure `SOURCE_AUTHORIZATION_VERIFY_KEY` with the gateway's RSA public PEM or the matching shared secret; the signing key belongs only to the gateway. An expired proof holds work in `authorization_required`, preserving the provider record and artifact. The gateway renews authority by idempotently submitting the same business request; renewal cannot change its binding or upstream contract. See the repository's `docs/implementation/jurisdiction-source-policy.md` for the approval sequence and evidence mapping requirements.

429 and eligible GET/idempotent-call network/5xx failures receive bounded delay/jitter retries. A non-idempotent live call with an ambiguous timeout/5xx enters reconciliation. `upstream_idempotency_validated` and `idempotency_header` may only be set if the vendor actually supports the documented idempotency behavior.

Admin replay only accepts failed/dead-letter jobs. `reconciliation_required` cannot be requeued through the public replay endpoint; an operator must reconcile with the vendor and implement an institution-approved recovery procedure. No automatic vendor status search, financial compensation or destructive cancellation is implemented.

Each result is stored immutably with its evidence, and the check points at the latest result. A retry may produce another result version; history remains available. Consumers must inspect the current operation status and not mistake a historic result for the active retry's outcome.

## 9. Events and downstream consumption
Successful or failed normalization commits the result and event in the same transaction. Subscriptions create delivery jobs for future events. Destinations are static, operator-approved references scoped to tenants; the API never accepts a caller-supplied callback URL.

Deliveries carry:
- `X-Wiring-Event-Id`;
- `X-Wiring-Timestamp`;
- `X-Wiring-Signature`, hex HMAC-SHA256 over `timestamp + '.' + exact_body_bytes`.

Receivers should verify the signature and signed timestamp, deduplicate by event ID, compare resource versions and fetch current state if events arrive out of order. Deliveries are at-least-once; retries can duplicate a successfully received event. Up to five delivery attempts are made before dead-letter state. Demo mode disables callback networking; inspect `/v1/events` instead.

A subscription does not replay historic events. Recovery/replay of outbound delivery dead letters, delete/unsubscribe operations, long-term queue pruning and production event-broker integration remain extensions. The event retrieval API permits paged pull consumption without outbound callbacks.

## 10. Deployment and privacy
### Environment
| Variable | Meaning |
|---|---|
| `WIRING_MODE` | `demo` for synthetic only; use `live` for approved real transport |
| `DATABASE_URL` | SQLite demo or `postgresql+psycopg://...` |
| `ENCRYPTION_KEY` | Fernet key shared by API/workers; mandatory in live mode |
| `API_KEYS_JSON` | Host token → tenant/role mapping; mandatory in live mode |
| `WORKER_ENABLED` | `1` for in-process demo worker, `0` for separate worker deployment |
| `CONTRACTS_PATH` | Approved active binding file |
| `DESTINATIONS_PATH` | Approved event destination file |

Generate local credentials yourself:
```bash
python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
python -c "import secrets; print(secrets.token_urlsafe(32))"
```
Do not paste real secrets into the conversation. The package includes no private `.env`, local database or demo encryption key. In demo mode `.local/` holds the generated key and SQLite database. Those are local runtime artifacts, not portable backups. Back up and manage keys and encrypted data together under an approved procedure.

### Docker Compose
`compose.yaml` defines PostgreSQL 17, an API process and a separate worker. API/worker share environment and mounted read-only configuration. Set generated host keys, a Fernet key and a URL-safe database password before `docker compose up --build`. If you use reserved URI characters in the password, encode them in an appropriate connection URL or adapt the compose configuration.

An optional `.provider-secrets.env` supplies operator-owned vendor/webhook/delivery secret variables to both API and worker. It is git- and Docker-build-ignored. In production, use your approved orchestration/secret manager instead of a local secrets file. Protect access to the Docker host/environment.

The Docker/PostgreSQL layout was **not executed here**. SQLite persistence, restart behavior, competing worker claims and transactions were exercised by automated tests. Conduct PostgreSQL migration, locking, isolation, backup and failover acceptance before deployment. SQLAlchemy's automatic table creation is not a substitute for reviewed production migrations.

### Security boundaries still requiring deployment work
- Enforce TLS termination, host authentication, perimeter limits and request logging policy. The current rate limiter is per process, not a distributed gateway.
- DNS/IP destination checks and exact operator-approved URLs are defense in depth. They do not eliminate DNS rebinding or replace an egress firewall, fixed proxy or private network policy.
- Tenant filters are enforced at the application layer and tested. PostgreSQL row-level security, per-tenant keys, IAM and database privileges are not deployed by this starter.
- Fernet encrypts payload JSON; operational IDs, provider IDs, capability names, statuses and timing metadata remain queryable. This is not a managed KMS envelope-encryption deployment. Add key rotation/retirement and tenant-specific key policy.
- Runtime contracts and secret resolution trust the operator. Verify legal basis, consent validity, entitlements, data residency, license restrictions, SAR/STR restrictions and retention independently.
- Implement durable audit tamper-evidence, legal holds, deletion/retention, evidence export and incident response under institution policy. The database audit table is not WORM storage.
- Do not enable verbose HTTP/proxy logging where URLs may carry vendor query tokens, national IDs or other PII. OpenCorporates token parameters require explicit query-log redaction.
- Conduct security/privacy assessments, adversarial matching tests, dependency pinning, load testing, failover/recovery exercises and bank change approval. The tested direct-dependency constraints are not a fully hashed transitive lockfile or vulnerability attestation.

## 11. Test evidence
`docs/test-results.txt`: **52 automated tests passed**. One exhaustive integration test exercises every non-quarantined binding (822) through the actual FastAPI API, database queue, worker, result archive and event creation, with two quarantine denials.

Additional tests cover six mocked native HTTP clients, generic mapping, poll-create-once behavior, signed callback verification and state/replay rules, signed outbound deliveries, cross-tenant denial, idempotency, encrypted persistence, restart, concurrent claims, ambiguous-call reconciliation, dead letters, admin evidence audit, egress/path rejection, schema drift, batch partial errors and request size bounds.

`docs/browser-test-results.json` records desktop/mobile console smoke testing, synthetic job completion, event viewing and no JavaScript errors. Screenshots are evidence of the demonstration console, not third-party API certification.

No real vendor sandbox, paid API, restricted dataset, Docker or PostgreSQL deployment was tested. Operational readiness must not be inferred from passing synthetic tests.

## 12. Inputs needed to finish actual external wiring
For each binding selected for live use, supply through approved secure channels:
1. Contracted vendor/legal entity/product and account/environment.
2. Authorized OpenAPI/WSDL/file specification, native samples and change-event schemas.
3. Sandbox credentials and authentication/signature/rotation procedure.
4. Country/document/entity-type coverage, dataset entitlements and upstream source lineage.
5. Residency, permitted purposes, retention, commercial-use and redistribution restrictions.
6. Positive, negative, empty, partial, error, retry, timeout and status-change acceptance cases.
7. Institution-approved policies, authoritative consent checks, operational owners and production acceptance.

Promote connections individually. Some catalog records may never support direct programmatic access or may be unavailable under your lawful scope; record those as unavailable/not applicable rather than making a false claim of complete wiring.
