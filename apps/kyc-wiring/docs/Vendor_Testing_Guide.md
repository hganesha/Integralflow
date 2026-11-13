# Real vendor connections — private credential testing
Version 2.0 · 15 October 2026

## Actual scope, not registry/template coverage

**42 catalog records have documented vendor/source HTTP implementations, totaling 732 concrete operations. 334 catalog records remain unimplemented. No external vendor tests have been performed. This is a partial implementation of the request for every vendor, not an assertion that all 376 are connected.**

The registry's 824 proposed capability bindings are not 824 verified native operations. Native operations are counted from executable, pinned request contracts, not generated catalog skeletons. Some of the 42 records are public registries or sanctions-file sources rather than commercial vendors. One working operation does not establish support for every product/country/capability offered by a provider.

See `Vendor_Connection_Coverage.xlsx`, `vendor-connection-coverage.csv`, and `vendor-connection-coverage.json` for all 376 records and explicit gaps. The remaining records include publicly documented APIs still needing implementation, protected specifications, non-REST/SDK products and managed services. **Do not interpret every gap as “vendor docs unavailable.”** Homepage discovery alone cannot establish API availability or absence.

## Implementations in this release

- Identity and onboarding: Sumsub, Veriff, ComplyCube, iDenfy, Shufti, Persona, Entrust/Onfido, Incode, Dojah, Prembly, Truora.
- Screening and monitoring operations: ComplyAdvantage, NameScan, dilisense, Unit21, Flagright, OpenSanctions.
- Business/identifier data: Middesk, Companies House, OpenCorporates, GLEIF, SEC EDGAR, Brønnøysund Register Centre, PRH.
- Fraud/network/phone intelligence: SEON, MaxMind, IPinfo, IPQS, Telesign, Twilio Lookup, Fingerprint.
- Financial/account data: Plaid, MX, TrueLayer, Yapily, Belvo, Mono, Fintoc, Flinks.
- Bulk sanctions sources: OFAC, United Nations, UK Sanctions List.

### What the code does

`vendor_connections/definitions/*.json` contain vendor-specific methods, paths, version identifiers, authentication modes, required inputs, sources and native schemas where available. `client.py` executes those contracts over real HTTPS, serializes native JSON/form/multipart inputs, injects credentials, signs Sumsub and Veriff requests, and verifies Veriff/Shufti response signatures. It never loads specs or accepts arbitrary URLs from an HTTP caller.

Eight vendor-owned OpenAPI snapshots are bundled: Companies House, Entrust/Onfido, Fingerprint v4, Plaid, MX, OpenSanctions, Incode and Flinks. Their native request schemas and local references are used for input validation. Some source Swagger defects are explicitly corrected in definition metadata, rather than changing actual HTTP paths.

Operation coverage is intentionally selective where a broad platform also supports payments/funds movement or API-key administration. **This is not an implementation of every endpoint in every vendor's full API.**

## Run on your own private machine

Do not enable testing on the public Arena demo. **Demo mode cannot make these calls, even if the testing flag is set.** The original production `/v1/checks` approval gates remain unchanged; testing does not falsely mark a connector sandbox-tested.

```bash
python -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt -c requirements-tested.txt
mkdir -p .local

# Generate your own values; don't copy a production secret into a shared notebook.
export ENCRYPTION_KEY="$(python -c 'from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())')"
export TEST_HOST_TOKEN="$(python -c 'import secrets; print(secrets.token_urlsafe(32))')"
export API_KEYS_JSON="$(python -c 'import os,json; print(json.dumps({os.environ["TEST_HOST_TOKEN"]:{"tenant_id":"vendor-test","role":"admin"}}))')"
export WIRING_MODE=live
export VENDOR_TEST_ENABLED=1
export VENDOR_TEST_TENANTS_JSON='["vendor-test"]'
export ENABLE_API_DOCS=1
export WORKER_ENABLED=0

# Example: your vendor-issued test credentials, not host credentials.
export VENDOR_IDENFY_API_KEY='REPLACE_WITH_YOUR_VENDOR_TEST_API_KEY'
export VENDOR_IDENFY_API_SECRET='REPLACE_WITH_YOUR_VENDOR_TEST_API_SECRET'

uvicorn wiring.app:create_app --factory --host 0.0.0.0 --port 8000
```

The default local DB is encrypted SQLite. Compose uses PostgreSQL and a separate worker for production-host jobs. Direct vendor-testing calls are synchronous, durably reserved and encrypted in the same DB; they do **not** run through the generic production job worker. Production Postgres/Docker deployment was not executed in this environment.

If you use Compose, put upstream credential variables from `config/vendor-secrets.env.example` in your own `.provider-secrets.env`. Set the host/testing variables above in the shell or your private Compose `.env`. The API and worker receive the same protected environment. Never commit either secret file. Use a proper secret manager and private ingress for any real deployment.

### Discover implementations and exact operation IDs

```bash
curl http://localhost:8000/v1/vendor-connections?implemented=true \
  -H "Authorization: Bearer $TEST_HOST_TOKEN"

curl http://localhost:8000/v1/vendor-connections/sumsub \
  -H "Authorization: Bearer $TEST_HOST_TOKEN"

curl http://localhost:8000/v1/vendor-connections/idenfy/operations/generate_token \
  -H "Authorization: Bearer $TEST_HOST_TOKEN"
```

The provider detail lists exact operation IDs; imported OpenAPI IDs retain their original case. Every operation detail includes its native method/path, source, required inputs, and the bundled schema resolution file. Swagger is available at `/docs` only when explicitly enabled outside demo mode.

### Make a real iDenfy test-session call

```bash
curl -X POST http://localhost:8000/v1/vendor-connections/idenfy/operations/generate_token/invoke \
  -H "Authorization: Bearer $TEST_HOST_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: idenfy-test-unique-001' \
  -d '{
    "purpose":"vendor_integration_test",
    "request_id":"test-001",
    "subject_entity_id":"your-test-subject",
    "body":{"clientId":"your-unique-test-user"}
  }'
```

A successful token creation remains **pending / not_checked**, not passed. Complete the vendor SDK/hosted verification flow separately, as required by that vendor. SDK capture flows and app/device UI are not implemented by this server.

### Native input envelope

```json
{
  "purpose": "vendor_integration_test",
  "region": "eu",
  "request_id": "your-test-request-id",
  "subject_entity_id": "your-subject-reference",
  "path": {"applicantId": "your-vendor-resource-id"},
  "query": {},
  "headers": {},
  "body": null,
  "files": {}
}
```

The `region` values are the definition's named bases, not arbitrary locations. For example Sumsub uses `default`, MaxMind uses `sandbox`/`production`, and SEON uses `eu`/`us`/`me`. Omit `region` to select the first documented profile; **select sandbox explicitly wherever supplied**. A profile called `default` does not mean sandbox.

For Sumsub review retrieval use provider `sumsub`, operation `review_status`, omit `region`, and set the `applicantId` path parameter. Required secrets are `VENDOR_SUMSUB_APP_TOKEN` and `VENDOR_SUMSUB_SECRET_KEY`.

For documented multipart operations, `files` maps a native file field to `{"filename":"test.jpg","base64":"...","content_type":"image/jpeg"}`. Put other native multipart fields in `body`. The host inbound request limit is 2 MB, including base64 overhead. Multi-file arrays and unusual content encodings need further implementation; do not assume every multipart variant works.

Native query/body values must follow the cited vendor contract. A catalog capability does not imply the corresponding vendor API accepts a common JSON payload. Generated examples are editing aids, not vendor-validated test records.

### Customer-specific URLs

Veriff, Unit21 and Flinks require the operator to configure the customer endpoint. A vendor-approved alternative base for any provider also requires an explicit allowlist:

```bash
# Example SHAPE ONLY: replace with your contracted vendor-issued endpoint.
export VENDOR_VERIFF_BASE_URL='https://YOUR_VENDOR_ISSUED_HTTPS_HOST'
export VENDOR_VERIFF_APPROVED_BASE_URLS_JSON='["https://YOUR_VENDOR_ISSUED_HTTPS_HOST"]'
export VENDOR_VERIFF_API_KEY='YOUR_TEST_KEY'
export VENDOR_VERIFF_SHARED_SECRET='YOUR_TEST_SHARED_SECRET'
```

The hostname must resolve only to public addresses. HTTP, private IPs, URL credentials, base-URL queries/fragments, redirects and identifier path escapes are denied. Use an outbound firewall/proxy: DNS checking is defense-in-depth, not DNS pinning.

Incode's demo base is documented; your licensed environment may differ. Start onboarding with its API key, then send the returned session token in the explicitly permitted `X-Incode-Hardware-Id` native header on session operations. Some Incode operations require a native Authorization bearer header instead. The API-version header is pinned to the spec's `1.0` default.

Flinks' instance URL is customer-specific; no default instance is invented. Optional `VENDOR_FLINKS_API_KEY` is sent only when configured. Required per-operation `flinks-auth-key` or Authorization headers are listed in that operation's contract. Native session/login credentials remain in the documented body/path.

OAuth-based TrueLayer calls require a valid pre-issued `ACCESS_TOKEN`. Authorization-code consent, refresh-token orchestration and automatic token rotation are not implemented. Similar external consent/SDK prerequisites apply to financial-data providers. Yapily account operations require the per-call `consent` header.

## Returned results, storage and retry behavior

Responses include:

- `native`: decoded vendor JSON or XML metadata, original HTTP status, exact-response-byte hash, base64 evidence, resource/status pointers where documented, signature-verification result and documentation source.
- `capability_mapping`: the reviewed mapping for this operation (`vendor_connections/mappings/operation-mappings.json`). It gives the canonical capability ID, lifecycle role, the v1 capability (if any), mapping status and blockers.
- `host`: common host-schema envelope, or `null`. It is returned only when the operation's mapped family has a v1 capability, its role can produce a finding (not control, upload or simulate) and its mapping is not blocked. Its `capability` is that family's v1 name, never a default derived from native semantics. Its `bank_decision` is always `not_evaluated`.
- `operation_receipt`: returned instead of `host` for every other operation (`vendor/atlas/schemas/v2/operation-receipt.schema.json`): controls, uploads, simulations, blocked conditional checks, and native-only families such as account profiles, transactions, document artifacts and composite watchlists. It records execution status, native status and resource reference, and always has `produces_intelligence: false`.
- `invocation_id`: tenant-scoped durable record, available through `GET /v1/vendor-invocations/{id}` to an authenticated admin.

Both decoded native data and the base64 evidence may contain sensitive identifiers, biometric material, tokens or account data. Only admin callers can invoke or retrieve these test records. Transport responses are returned to the caller and encrypted at rest; protect your terminal/logging, reverse proxy and backups. The encryption key must be durable and protected.

If you send a `canonical_request`, its `capability` must be one the operation can satisfy according to its mapping. Otherwise the call is rejected **before** the idempotency key is reserved or anything is sent upstream: `CAPABILITY_INCOMPATIBLE` (422), `DISPATCH_NOT_CONFIGURED` (409) for configurable checks whose dispatch branches are not configured, or `OPERATION_MAPPING_BLOCKED` (409). An operation with no reviewed mapping fails with `OPERATION_MAPPING_MISSING`.

The common envelope maps execution/source metadata for supported calls; **it does not fully normalize every field of all 732 operations**. Selected shape-specific deep mappings are reused for compatible Persona/Veriff/Middesk/OpenCorporates/GLEIF/Plaid responses, and Sumsub review state is mapped explicitly. Other fields remain in native evidence with `NATIVE_FIELDS_NOT_FULLY_NORMALIZED`. Unknown coverage stays unknown. Empty screening arrays or HTTP 200 do not establish sanctions clearance. Bulk file retrieval is not customer screening.

The test API durably reserves the host Idempotency-Key **before** calling the vendor. Repeating the same key/input returns the saved result without another call. Changing input with the same key returns 409. A reserved/failed request without a saved response requires reconciliation; there are no blind retries of paid or create operations. A new key authorizes a new call. Local preflight failures also consume their reservation conservatively; fix configuration and use a new key only after confirming no upstream call was sent. Original native evidence is preserved if subsequent host mapping fails.

Vendor HTTP errors are not bank decisions. The upstream HTTP status is in `result.native.http_status`; a successfully recorded invocation can itself return host HTTP 200 with an unsuccessful upstream status. A transport timeout, invalid response signature or denied redirect returns an explicit host error and must not be interpreted as “no vendor operation happened.”

JSON/binary response limit: 25 MB. Bulk dataset response limit: 100 MB. XML parsing disables dangerous entities. Large dataset responses include base64 evidence, so protect memory/bandwidth and increase limits only after operational review. Automated bulk refresh schedules, CSV/Excel parsers and customer matching against those files are not implemented here.

## Known source/implementation limits

- **Prembly:** current national-ID documentation labels its example Zambia but shows `/verification/gb/id`. The client retains that documented path under `documented_national_id` and does not claim UK coverage. Confirm with Prembly before submitting personal data. Passport and company-search paths retain the different prefixes shown by their respective official pages.
- **Unit21:** full documentation now redirects to a login. The implemented entity-create subset uses the previously publicly indexed official example; customer-specific fields and optional encrypted transport require authorized documentation review. Optional Unit21 Fernet request/response encryption is not implemented.
- **Shufti:** post-15-March-2023 Basic-auth secret-hash signature mode is implemented. Legacy accounts need a reviewed variant; there is no insecure fallback or TLS disabling.
- **SEON:** EU and US/ME use different documented version paths. Region/operation mismatches are rejected.
- **Fingerprint:** bundled v4 contract, not the older v3 contract approaching deprecation.
- **SEC EDGAR:** configure an identifying organization/contact User-Agent and obey fair-access rules; these public filings are not beneficial-ownership verification.
- Some official docs pages reject automated access or return anti-bot/login pages. A captured HTTP 200 is provenance metadata, not proof that complete documentation was accessible. Search-index evidence was used for specified narrow subsets; source hashes and URLs are preserved, not copied website prose.
- No vendor webhook receivers, automatic polling state machines or user-capture SDKs were added for these new clients. Where documented, native fetch operations can be invoked explicitly. Existing production-host async/webhook machinery is separate and still requires approved contracts.

## Reproduce local validation

```bash
python -m pytest tests -q --disable-warnings
python scripts/export_contracts.py
python scripts/export_vendor_connections.py
python scripts/package_release.py
```

**843 tests pass in the final suite** (813 from the October 2026 review, plus 30 for the v2 capability mappings and mapping-driven normalization). This includes 732 parametrized mocked-transport serialization cases, independent HMAC/signature, schema, egress, tenant, encrypted-storage and idempotency tests, and the original 52 host-service tests. The breadth serialization test deliberately isolates schema validation and uses synthetic placeholders; it is not a demonstration that all 732 vendor payload variants are accepted. Separate tests enforce representative pinned native schemas. No test in this suite establishes real vendor entitlement, account configuration, product availability or production readiness.

## Work still required for “all vendors”

The 334 explicitly unimplemented records need further vendor-specific research/code or authorized materials. For protected integrations provide the official OpenAPI/Swagger/WSDL files, SDK/server contracts or authorized documentation exports plus the applicable product/API version. Do not provide secret values in this conversation. For sources without a public contract, a marketing page is not enough to invent an endpoint. The inventory distinguishes that outstanding work from these implemented calls; none of the old 824 disabled templates are counted as vendor connections.
