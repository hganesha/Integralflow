# KYC wiring and evidence pipeline adapters

The capability gateway reaches two KYC services, both in this repository, through two adapters. Both are
ordinary gateway adapters: a capability names one in its `adapterBindingId`, the
gateway checks the plan's permission envelope, and only the gateway holds the
service URL and token.

| Adapter | Binding | Service | Code |
| --- | --- | --- | --- |
| `wiring` | `wiring:<provider_id>:<capability>`, e.g. `wiring:opensanctions:screening.pep` | `apps/kyc-wiring` (FastAPI, port 8000) | `packages/adapters/src/kyc-wiring.ts` |
| `evidence` | `evidence:ingest`, `evidence:package`, `evidence:ownership`, `evidence:resume` | `apps/evidence-pipeline` `kyc-evidence-server` (port 8080) | `packages/adapters/src/evidence-pipeline.ts` |

Registration is in `apps/capability-gateway/src/adapter-registry.ts`.

## KYC API wiring (`wiring`)

The binding name after `wiring:` is the wiring catalog's operation ID
(`<provider_id>:<capability>`) and must match `^[a-z0-9-]+:[a-z_.]+$`; the gateway
accepts any well-formed ID and the wiring service rejects one it has not catalogued.
Under the v2 canonical capability model ([naming](capability-naming.md#4-v2-canonical-capability-model)),
the gateway also refuses, at registration and invocation, a wiring operation bound to
any capability other than its own (`gateway.wiring_capability_mismatch`). It likewise
refuses the 13 semantically corrected operations (`gateway.wiring_binding_migration_required`)
and the quarantined ones (`gateway.wiring_binding_quarantined`).

The wiring service applies the same model server-side. Its refusals reach the gateway as
`adapter.kyc_wiring_http_<status>:<CODE>`, for example `adapter.kyc_wiring_http_409:MIGRATION_REQUIRED`
or `adapter.kyc_wiring_http_422:JURISDICTION_OUT_OF_SCOPE`. A single-jurisdiction registry
such as Companies House (`gb`) refuses a subject whose registration number or organization
jurisdiction is foreign; screening sources do not. The adapter output's `canonical` field is
the v2 binding, canonical capability ID and jurisdiction the service reports it executed.
`/v1/adapters` advertises a few examples (OpenSanctions sanctions/PEP, ComplyAdvantage
adverse media, Companies House, GLEIF, Persona).

For each invocation the adapter:

1. Builds a `CanonicalHostRequest` (`vendor/atlas/schemas/request.schema.json`) from the
   capability input: `{ subject: { name, type: person|organization, dob, country,
   registrationNumber, lei }, caseId, purpose, legalBasis, jurisdictions, providerRecordId }`
   or the flat `{ name, country, dateOfBirth }` shape the screening capabilities already
   receive. The provider is the only entry in `routing.provider_allowlist` and fallback is
   off. `tenant_id` is `KYC_WIRING_TENANT_ID`, the tenant the wiring service binds to the token.
2. `POST /v1/checks` with `Idempotency-Key` equal to `request.idempotency_key`, derived
   from the platform tenant, gateway invocation ID and operation, so a retried invocation
   reuses the same check.
3. Polls `GET /v1/checks/{id}` with backoff until `completed`, `partial`, `failed`,
   `dead_letter` or `reconciliation_required`, then reads `GET /v1/checks/{id}/results`.
   Submission, polling and retrieval share one deadline: the capability's `timeoutMs`.
4. Returns `{ outcome, reasonCodes, bankDecision: "not_evaluated", coverage, result,
   assertions, evidenceRefs, warnings, errors, providerCheckId, checkStatus,
   executionMode, error }`.

It fails closed. The provider's outcome passes through only for a completed or partial
check whose result has a recognized outcome and a completed execution. A failed,
dead-lettered or reconciliation-required check, a missing result or an unrecognized
outcome yields `outcome: "unknown"` with an `error`, never `passed`. Transport errors,
HTTP errors from the wiring service and a missed deadline raise `adapter.kyc_wiring_*`
errors, which the gateway records as a failed invocation.

## Evidence pipeline (`evidence`)

| Binding | Input | Service call |
| --- | --- | --- |
| `evidence:ingest` | `{ caseId, filename, contentBase64, profile? }` | `POST /v1/cases/{caseId}/documents` |
| `evidence:package` | `{ caseId }` | `GET /v1/cases/{caseId}/package` |
| `evidence:ownership` | `{ caseId }` | `GET /v1/cases/{caseId}/ownership` |
| `evidence:resume` | `{ runId, decision: { reviewer_id, decisions } }` | `POST /v1/runs/{runId}/resume` |

Case and run IDs are validated before they reach a URL. The output is `{ operation,
caseId, runId, status, reviewRequired, bankDecision: "not_evaluated", data }`, where
`data` is the pipeline's response unchanged. Every fact the pipeline returns stays
`PENDING_HUMAN`; a `PAUSED_FOR_REVIEW` ingest needs a human decision through `resume`.
The pipeline server always runs offline (rules extraction, lexical retrieval), so no
request through the gateway can make it send documents to a model.

## Trust boundaries

- **Credentials only in the gateway.** `KYC_WIRING_TOKEN` and `EVIDENCE_PIPELINE_TOKEN`
  are read from the gateway environment (`.env.local` locally, a secret mounted by the
  deployment's secret manager in production). Vendor credentials live only in the wiring service. Neither token appears in
  outputs, `/v1/status` or `/v1/adapters`.
- **Results never decide.** Wiring results always carry `bankDecision: not_evaluated`; a
  provider-supplied bank decision is dropped and reported in `warnings`. Evidence packages
  are provisional. Disposition remains with the policy gates and independent human review.
- **Fail closed.** Each adapter reports `credentialState: Missing` until both its URL and
  token are set, and refuses to invoke while missing. Under the production security profile
  (`SECURITY_PROFILE=production`) only `https` URLs count as configured. Requests use `redirect: "error"`.
- **Demo modes are synthetic.** The wiring service's demo mode simulates vendors
  (`executionMode: "simulation"`, warning `DEMO_ONLY_NO_VENDOR_CALL`); the evidence server's
  demo mode accepts a published token. Use neither with real customer data.

## Configuration

| Variable | Where | Meaning |
| --- | --- | --- |
| `KYC_WIRING_URL` | gateway | Wiring base URL. Compose default `http://kyc-wiring:8000`. |
| `KYC_WIRING_TOKEN` | gateway, `.env.local` | Bearer token; demo mode accepts `demo-token-local-only`. |
| `KYC_WIRING_TENANT_ID` | gateway | Tenant bound to the token; demo mode uses `demo-tenant` (default). |
| `EVIDENCE_PIPELINE_URL` | gateway | Evidence server base URL. Compose default `http://evidence-pipeline:8080`. |
| `EVIDENCE_PIPELINE_TOKEN` | gateway, `.env.local` | Bearer token; demo mode accepts `evidence-demo-token-local-only`. |

`GET /v1/status` on the gateway reports `kycWiringState` and `evidencePipelineState`
(`Configured` or `Missing`).

Outside Compose the adapters stay `Missing` until an operator provisions the services
behind private https endpoints and gives the gateway the URL and token settings.

## Running locally

```sh
# Built from apps/kyc-wiring and apps/evidence-pipeline.
cp .env.local.example .env.local      # includes the two demo tokens
docker compose --profile kyc-adapters up --build -d
```

Without the profile, the default stack starts unchanged and both adapters fail closed.

Without Docker:

```sh
(cd apps/kyc-wiring && WIRING_MODE=demo uvicorn wiring.app:create_app --factory --port 8000)
(cd apps/evidence-pipeline && EVIDENCE_PIPELINE_MODE=demo EVIDENCE_PIPELINE_PORT=8080 kyc-evidence-server)
KYC_WIRING_URL=http://127.0.0.1:8000 KYC_WIRING_TOKEN=demo-token-local-only \
EVIDENCE_PIPELINE_URL=http://127.0.0.1:8080 EVIDENCE_PIPELINE_TOKEN=evidence-demo-token-local-only \
pnpm --filter @ehf/capability-gateway dev
```

## In the KYC v2 workflow (skill library)

`domains/archive/kyc-v2-deterministic` runs individual KYC on the financial-crime skill library
([README](../../domains/archive/kyc-v2-deterministic/README.md)). The adapters serve its **acquisition** nodes;
library skills then reason over the canonical records those nodes commit
([canonical records](canonical-records.md)). Each connector node links the captured
provider output as case evidence under the purpose the KYC policy's evidence obligations
read, commits the normalized records (`RecordCanonicalRecords`), and records an
incomplete-check finding when the check established nothing:

| Node | Capability | Connector | Evidence purpose | Records | Finding |
| --- | --- | --- | --- | --- | --- |
| `acquire-identity` | `identity.document.verify.v1` | `wiring:persona:identity.document.verify` | `KYC_IDENTITY_VERIFICATION` only for `passed`, else `KYC_IDENTITY_VERIFICATION_ATTEMPT` | VerificationRecord | `IDENTITY_DOCUMENT_NOT_VERIFIED` for anything but `passed` |
| `acquire-documents` | `document.evidence.package.v1` | `evidence:package` | `KYC_DOCUMENT_EVIDENCE` | DocumentVersion, DocumentPage, Evidence | `EVIDENCE_GAP` when nothing was established |
| `acquire-sanctions` | `screening.sanctions.v1` | `opensanctions:sanctions` | `KYC_SANCTIONS_SCREENING` | WatchlistEntry + ScreeningHit, or NegativeSearchEvidence | `SANCTIONS_SCREEN_INCOMPLETE`; a candidate raises `POSSIBLE_SANCTIONS_MATCH` |
| `acquire-pep` | `screening.pep.v1` | `opensanctions:pep` | `KYC_PEP_SCREENING` | as sanctions | `PEP_SCREEN_INCOMPLETE`; a candidate raises `PEP_SIGNAL` |
| `acquire-adverse-media` | `screening.adverse_media.v1` | `wiring:complyadvantage:screening.adverse_media` | `KYC_ADVERSE_MEDIA` | AdverseMediaEvent or NegativeSearchEvidence | `ADVERSE_MEDIA_SCREEN_INCOMPLETE`; `review`/`failed` raise `ADVERSE_MEDIA` |

Outcomes are never read optimistically. The case API's gate input mapping
(`apps/case-api/src/policy-evaluator.ts`) reports a screen with an open incomplete finding
as missing, never as OK, so the OPA readiness gate does not continue. Only a positive
identity verification discharges `EVD-IDENTITY-VERIFICATION`. Evidence-pipeline output is
`TOOL` evidence and cannot discharge the CIP document obligations, which accept only
`UPLOAD`, `HUMAN` or `INTERNAL_SYSTEM` sources.

Offline, adverse media has no fixture normalizer in the provider atlas, so the demo service
returns `not_checked` and the case correctly stops for review. `make up` starts the
`kyc-adapters` profile by default; copy `.env.local.example` to `.env.local` so the gateway
has the demo tokens.

The registry, officers, ownership and LEI connectors (`business.*`,
`reference.identifier.lookup.v1`) serve `domains/archive/kyb-deterministic`; `document.evidence.ingest.v1` is not
wired because a case carries no document upload yet. To add a connector to KYC, add it to the
connector list in `scripts/sync-kyc-package.mjs` (stage, evidence purpose, findings),
regenerate (`node scripts/sync-kyc-package.mjs`), recompile (`make compile`) and publish
through Authoring as usual.
