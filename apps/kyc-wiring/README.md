# Separate KYC API Wiring Service
**Python / FastAPI • Version 2.0 • 15 October 2026**

This is a separate, runnable integration service built around the earlier provider catalog and common host schema. It includes its own source, catalog snapshot, schemas, synthetic fixtures, tests, configuration templates and deployment files. The earlier bundle is not required at runtime.

## New: documented real vendor transports

**42 vendor/source clients · 732 concrete native operations · 843 passing local tests · 0 external vendor tests.**

**334 of the 376 catalog records are still unimplemented. This release does not complete the all-vendor requirement.** The old 824 disabled bindings are not counted as connections. Product coverage is partial within individual vendors, and most new native fields are not deeply normalized yet.

Start with **[Vendor Testing Guide](docs/Vendor_Testing_Guide.md)** for private credential testing without prior sandbox attestation. Inspect **[full coverage workbook](Vendor_Connection_Coverage.xlsx)** or **[JSON inventory](docs/vendor-connection-coverage.json)** for every provider. The new **[real-call Postman collection](docs/Documented_Vendor_Connections.postman_collection.json)** contains editable wrappers for each native operation; running them can incur fees/create resources.

The code in `vendor_connections/` includes pinned vendor definitions, eight official OpenAPI snapshots, authentication/signing, native JSON/form/multipart transport, tenant-bound durable idempotency and encrypted native evidence. Source URLs and hashes accompany the implementation. No runtime spec downloads or invented missing-provider endpoints.

**Do not enable real calls on the public demo.** Use `WIRING_MODE=live`, your own host/admin credentials, `VENDOR_TEST_ENABLED=1` and an explicit test-tenant allowlist on a private deployment. `/v1/checks` production readiness gates are unchanged. User testing does not mark an integration vendor-accepted or production-ready.

## Original host-service layer — still included
| Layer | Delivered status |
|---|---|
| Provider/capability registration | All **376 catalog records / 824 bindings** imported |
| Host API → queue → worker → mapping → storage → events | Implemented and exercised end to end |
| Non-quarantined binding simulation | **822 / 822** exercised through the HTTP API and durable worker |
| Historical quarantined bindings | **2**, rejected rather than connected |
| Representative native-payload normalizers | **9**, using synthetic fixture subsets |
| Original host-worker native HTTP client subsets | **6**; the new separate testing layer has **42 clients / 732 operations** |
| Generic JSON-over-HTTPS / declarative mapping | Implemented; requires a verified, approved contract per binding |
| Verified external vendor connections | **0 live-ready** — no credentials, contracted entitlements or actual vendor sandbox acceptance supplied |

**Neither layer makes every external provider API complete.** The catalog includes unverified providers, legacy product families, registries, restricted networks, managed services and sources without public JSON APIs. The service deliberately refuses unapproved connections. It does not invent endpoints, credentials, payload mappings or bank-adoption evidence.

## Start the demo
Tested with Python 3.13 and 3.14. Install dependencies in your own virtual environment.
```bash
python -m pip install -r requirements.txt -c requirements-tested.txt
uvicorn wiring.app:create_app --factory --host 0.0.0.0 --port 8000
```
Open `http://localhost:8000` on the machine running the service. In Arena use the **KYC API Wiring Console** live preview. The UI uses relative API URLs, so the proxied preview works without browser localhost calls.

Demo API token: `demo-token-local-only` (synthetic demonstration only, not a vendor credential).

**Do not upload real customer data to the demo.** Demo mode never performs upstream vendor calls. It writes encrypted synthetic requests/results/evidence to a local SQLite database and runs a background worker. It creates a local demonstration encryption key only when no key is supplied.

```bash
curl http://localhost:8000/healthz
curl http://localhost:8000/v1/connections?limit=1000 \
  -H 'Authorization: Bearer demo-token-local-only'
curl -X POST http://localhost:8000/v1/demo/run \
  -H 'Authorization: Bearer demo-token-local-only' \
  -H 'Content-Type: application/json' \
  -d '{"operation_id":"sumsub:identity.person.verify"}'
```
Use the returned `check.id` with `/v1/checks/{id}/results`. Inspect `/v1/events` for the durable result-change event. Interactive Swagger documentation is at `/docs` in demo mode; `docs/openapi.json` is the exported OpenAPI contract.

## Implemented wiring
- Tenant-bound bearer authentication; reader/operator/admin roles and per-process rate limiting.
- Strict host request and result validation; explicit provider allowlist and subject validation.
- Idempotency scoped to tenant; conflicting reuse returns 409.
- Policy, country, residency, purpose, legal-basis, entitlement, consent-reference and secret-availability gates for live connections.
- Encrypted JSON persistence with SQLAlchemy; SQLite demo and PostgreSQL deployment configuration.
- Database-backed jobs, compare-and-swap worker leases, retries, dead letters and restricted replay.
- No blind repetition of ambiguous live upstream calls: timeout/lost lease can require reconciliation.
- Real HTTPS transport, response size bounds, TLS verification, no redirects and controlled endpoints.
- Six native request/authentication subsets: Persona inquiry retrieval, Companies House profile, OpenCorporates company lookup, GLEIF LEI lookup, OpenSanctions matching and Plaid Identity Match.
- Strict declarative request/response templates with JSON pointers, array mapping and explicit enum translation; no evaluation of arbitrary code.
- Synchronous, bounded polling and callback workflows for approved JSON contracts.
- Raw-body HMAC webhook verification, signed-timestamp option, resource correlation, deduplication and stale-state rejection.
- Immutable result/evidence versions, audited restricted artifact access and tenant-scoped event retrieval.
- Transactional outbox, static approved callback destinations, signed delivery, bounded retries and delivery dead letters.
- Batch submissions with independent per-item idempotency and partial error responses.
- Searchable live demonstration console and machine-readable readiness for every binding.

## Tests
```bash
python -m pytest tests -q
```
**843 tests passed** (813 on Python 3.14.4 in the October 2026 review; re-run with 30 capability-mapping and normalization tests on Python 3.13.18 in November 2026), including 732 isolated mocked native-operation serialization cases, independent signing/native-schema/testing-profile tests, and the original host-service coverage, including a test that submits all 822 non-quarantined bindings through the HTTP API, worker, encrypted persistence and transactional event creation. Tests also cover six HTTP client subsets, declarative mapping, async polling, signed webhook replay/state handling, signed outbound events, tenant isolation, encryption, concurrency, idempotency, schema drift, retry/dead-letter behavior, egress checks, batch submission and body limits.

The original six host-worker native subsets were tested against `httpx.MockTransport`, **not actual vendor sandboxes**. Synthetic test configurations marked approved are test fixtures only, not real acceptance evidence. Browser smoke testing also verified the console, synthetic check completion, event inspection and mobile layout with no JavaScript errors.

## Files to review
- `Connection_Readiness.xlsx` — every binding and its blockers.
- `docs/connection-readiness.json` / `.csv` — machine-readable export.
- `docs/Operator_Guide.md` — deployment, security, adapter contracts, operations and remaining production gates.
- `docs/openapi.json` — actual exported host API schema.
- `docs/KYC_API_Wiring.postman_collection.json` — runnable local/demo API requests.
- `config/connection-templates.json` — 824 **disabled** contract templates; null native fields are intentional unknowns.
- `config/native-six.examples.json` — disabled configuration examples for the six HTTP subsets.
- `config/declarative.example.json` — synthetic contract/mapping example, not a real vendor API.
- `config/contracts.json` — active operator-owned contract file; shipped empty.
- `config/destinations.json` — approved event destinations; shipped empty.
- `wiring/` — API, registry, persistence, transport and workers.
- `vendor/atlas/` — source catalog, canonical schemas, representative normalizers, fixtures and source references.
- `compose.yaml`, `Dockerfile`, `.env.example` — deployment scaffolding.

## Proposed v2 capability mappings
Every documented vendor operation now has a proposed `NativeOperationMapping` in `vendor_connections/mappings/operation-mappings.json`, built by `scripts/build_capability_mappings.py` from the reviewed `operation-review.json` and the vendored atlas registries (`vendor/atlas/capability-model/`, `vendor/atlas/schemas/v2/`). Each record keeps the native ID, method, path and original semantics, and gives a primary capability family, a lifecycle role and blockers. All records are `proposed` or `blocked`, and none `produces` a check outcome. Vendor-test normalization (`vendor_connections/normalization.py`) now takes each operation's capability and role from these mappings, step 4 of the [design](../docs/CANONICAL_EXTERNAL_CAPABILITY_MODEL.md#62-implementation-sequence). An incompatible `canonical_request.capability` is rejected before anything is sent. Operations the v1 host envelope cannot represent honestly return a typed `operation_receipt` instead of `host`. Production `/v1/checks` routing still resolves v1 `provider:capability` bindings; moving it to v2 bindings is step 5.

## Separate worker and PostgreSQL
For separate processes, use the same database, encryption key, host API-key configuration, contract files and required secret references.
```bash
# API process
WORKER_ENABLED=0 uvicorn wiring.app:create_app --factory --host 0.0.0.0 --port 8000
# Worker process
python -m wiring.worker
```
Local Docker Compose defines PostgreSQL, API and worker services. Generate `ENCRYPTION_KEY`, `API_KEYS_JSON` and a URL-safe `POSTGRES_PASSWORD` before `docker compose up --build`. The deployment layout is provided but **Docker/PostgreSQL were not exercised in this sandbox**; the automated persistence tests used SQLite.

Do not enable real vendor calls by changing only `WIRING_MODE`. Production `/v1/checks` routing still requires approved binding contracts. The separate vendor-testing endpoints instead require private non-demo configuration, admin credentials, an enabled test tenant and the vendor credentials; they do not require prior sandbox attestation. See `docs/Vendor_Testing_Guide.md`.

## Important remaining work
This is a tested integration starter, not a certified bank production deployment. You still need actual provider contracts and schemas, credentials delivered through your secret manager, independently confirmed entitlements, provider-specific webhook profiles, real sandbox acceptance, security/privacy/compliance review, infrastructure egress enforcement, retention/key-rotation procedures, identity/consent verification and production database hardening. Other SOAP/SFTP, unsupported bulk formats and manual sources still require their own transports/decoders; three documented XML sanctions feeds are included in the new testing layer.

No adapter issues a final bank approval. Every normalizer and simulation emits `bank_decision=not_evaluated`.
