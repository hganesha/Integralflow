# Canonical financial-crime integration

This integration connects the financial-crime Python library (`apps/fincrime-host`, formerly the separate `hganesha/kyc` repository) to EHF. It preserves all 222 canonical skill IDs and executable manifests, adds seven EHF extension skills (the document wrappers, `apps/fincrime-host/docs/skill-extensions.md`), seven business profiles and TaskSpecs (six initial plus A03 document intelligence) and twelve context products. All imports are drafts; no import installs code or publishes a release.

## Local use

Install the library's locked dependencies and generate its catalog (`scripts/python-check.sh fincrime-host`
does the install and runs its checks):

```sh
cd apps/fincrime-host
python3 -m venv .venv && .venv/bin/python -m pip install -r requirements-dev.lock && .venv/bin/python -m pip install --no-deps -e .
.venv/bin/python scripts/build_catalog.py
.venv/bin/fc-skills export-ehf --output catalog/ehf-catalog.json
```

Then, from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm exec tsx scripts/smoke-fincrime.ts apps/fincrime-host apps/fincrime-host/docs/ehf-smoke.json
```

The smoke admits the compiler's conformance fixture (`packages/contracts/test-fixtures/conformance.plan.json`,
a v2 plan compiled in-process by `@ehf/compiler`; nothing to build first) and runs under
`SECURITY_PROFILE=development`.

The smoke uses a disposable Postgres 16 container, real HTTP to the official Python host, synthetic records and separately identified reviewers. It exercises catalog import, all seven tasks, restart/resume, authorized case writeback, stale-lease denial and shared runtime invocation state. It does not contact live providers or provision cloud infrastructure. The unrelated vector-search migration is excluded from this smoke.

## Integration entrypoints

- `@ehf/fincrime-integration.importCanonicalCatalog`: verifies exact source digests, preserves schemas/entrypoints/dependencies and maps registrations without inventing IDs or versions.
- `POST /v1/authoring/import/fincrime`: accepts `{artifact, expectedDigest}` after author authorization; stores an immutable tenant-scoped draft. Read it through `/v1/authoring/catalogs/fincrime/:digest`.
- `FinancialCrimeClient.plan`: compiles a pinned TaskSpec through the authenticated Python service; task inputs are schema-validated there.
- `dispatchCanonicalTask`: callable controller entrypoint using the existing Postgres work kernel. Its `authorize` callback must verify release and task/case basis, and return the admitted catalog digest; it never obtains authority from a serialized Principal in a request.
- `buildGateway({financialCrime})`: enables `financial-crime:<skill>@<version>` bindings. Supply a pinned catalog, its `catalogDigest`, a client and trusted `resolveBasis`; compiled nodes must pin `fincrimeTaskId` and `fincrimeCatalogDigest`. The gateway supplies verified run/node/work authority from the admitted plan and execution envelope.
- `outcomeCaseCommand`: creates `RecordFinancialCrimeOutcome`. Case API validates live execution authority and equality to the controller's retained observation before the normal case/ledger/receipt/outbox transaction. It does not execute proposed commands or finalize a decision. The dispatcher’s `commitObservation` hook runs before terminal/human transition while the work lease is live.

The Python host requires an injected `Authority` and authenticator. The bundled bootstrap only accepts explicit synthetic mode and a configured bearer hash. Production context mapping and identity verification remain application integrations; there is no permissive production fallback.

## Durable changes

Apply migrations before rolling upgraded services. A deployment that gives each service its own
database role must grant Case API `execute` on `harness_runtime.matches_fincrime_outcome` exactly
as it grants `harness_runtime.lock_case_execution` (both revoke PUBLIC in their migration); this
repository no longer ships a cloud-specific grant matrix:

| Migration | Purpose |
| --- | --- |
| `029_canonical_catalogs.sql` | Tenant-scoped, digest-addressed imported catalog artifacts |
| `030_runtime_invocations.sql` | Shared claims, status, cancellation intent and retained runtime results |
| `031_execution_outcomes.sql` | Immutable attempt observations and the narrow Case API verification function |
| Case store `010_financial_crime_outcomes.sql` | Stored evaluation observations under the canonical case transaction |

`harness_runtime.matches_fincrime_outcome` is security-definer, has a fixed search path and revokes PUBLIC execution; only Case API should be granted it. Runtimes access invocation state through the authenticated Control API rather than acquiring SQL credentials.

The runtime server now configures `HttpInvocationStore`. Claim/status/result/cancellation records survive replicas; the in-process map holds only active execution controllers. A lost runtime remains an unresolved running invocation until the controller reconciles it; the store never automatically repeats a possibly effectful invocation.

The v2 graph dispatcher uses bounded ready-node batches. It drains in-flight siblings before suspending/finalizing a run, keeps per-work fences and checkpoints, and retains typed settlements. Parallelism is bounded per graph; global capacity and tenant-fair scheduling still require deployment qualification.

Settlement transport uses **`runtime.invocation.v3`** and **`runtime.result.v2`**. Invocation v2 and result v1 remain readable; invocation v1 carried the removed v1 plan and is refused. Promote producer/consumer services together; strict older hosts will reject the new explicit version rather than silently discard settlements. The invocation status contract remains v1.

Expired work leases cannot renew or complete before reconciliation. Final business commands still check execution authority at commit; HTTP completion alone does not authorize a case mutation. Human suspension and review remain Postgres work records. A rejection stops a canonical task; approval resumes it without relabeling the original skill observation.

## Production boundaries

Newly imported logical profiles need approved deployment/runtime/model bindings and normal compilation, evaluation, approval and publication. No changes to the legacy generic GitHub prompt importer are required for canonical imports.

The case store retains its existing KYC-specific envelope; this integration stores versioned financial-crime observations without promoting them to verified facts. Production ingestion must explicitly map canonical records and preserve evidence versions, case sequence, classification, purpose and policy basis. The library's jurisdiction-neutral synthetic policy is independent of the US-labelled legacy case fixture used by this smoke.

This change does not certify live provider accuracy, unknown-effect financial accounting, tenant fairness, cloud identity/networking, cross-database atomicity or operational disaster recovery. Existing architecture gaps outside this integration retain their separate acceptance gates.
