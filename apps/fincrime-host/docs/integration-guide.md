# Runtime integration contract

Release: 0.3.0; skill API: 0.2.0; context schema: 2.0.0. Synthetic reference implementation.

For EHF-controlled tasks, use the [EHF integration](ehf-integration.md). EHF owns orchestration and case mutations; the bridge evaluates authorized snapshots and returns proposed actions.

## Invocation boundary

The public data models are in `financial_crime.contracts`; generated JSON Schemas are in `schemas/runtime`. An invocation supplies a canonical skill ID and exact version, tenant/actor/profile IDs, purpose, policy snapshot, subject scope, as-of and knowledge-cutoff timestamps, validated parameters and an idempotency key. Actor permissions are supplied separately by trusted application code.

`Executor.run(invocation, principal)` returns a `SkillResult` containing typed payload, status, lifecycle, source/result references, context hash, execution lock and metrics. A completed read/calculation is not an authorized customer decision. For a human-gated operation, the payload is proposed until independent approval is consumed; `effects_committed` indicates actual committed commands. A queued external command is not proof of delivery; query its receipt/status separately.

Each skill has a closed parameter and payload schema, with named nested objects and typed collection elements. Canonical records validate their complete data at ingestion; the compiler emits separate `RecordView` projections and validates every selected field. All nine provider capabilities validate their request and response shapes. Raw facts/source values and dispatcher parameters use explicit JSON value types; the selected skill contract is enforced before execution. Institution-specific additions belong in versioned, namespaced `extensions`. Source truth, source-system mapping and evidence qualification remain adapter responsibilities. See the [contract and migration guide](schema-contracts.md).

## Context and policy

The executable per-skill declarations are the `requirements` in each manifest, with scoped `policy_context_fields`. The generated context matrix includes both. Common bootstrap policy fields are version, jurisdiction, permissions and optional freshness configuration. Business functions receive only their declared policy slice; the full policy version is hashed and retained separately for audit.

`ContextManifest` records exact object and policy references, selected fields, compiler/requirements/profile/authorization hashes, time cutoffs, gaps, scope and model view. `Executor.replay(hash, principal)` requires matching current authorization and retained immutable versions, and returns reconstructed structured inputs and scoped policy. Changed or missing artifacts cannot silently replay as empty data.

The local compiler supports explicit references and authorized subject slices, with object limits. Graph depth/path limits are applied by the selected graph skills. Transaction scopes require start/end/watermark, completeness and expected record count. These contracts do not make incomplete source systems exhaustive; adapters must declare truthful coverage.

## Repository adapter

Implement `financial_crime.repositories.Repository`. Business skills and the executor use record, state/revision, job, audit and outbox operations without database-driver calls. `transaction()` must atomically commit domain commands, approval consumption and job result persistence. `claim_job()` within that boundary must reject competing owners. State revision checks and immutable record versions must be enforced by the backend, not by model instructions.

The included SQLite adapter is appropriate for local tests and one reference executor. Production adapters need shared persistence, cross-worker fencing/leases, appropriate isolation, indexed access, encryption, residency and retention handling. The recovery API is operator-controlled for abandoned jobs after proving the original worker is stopped; it is not an automatic distributed lease service.

## Capability adapter

Implement `Provider.provider_id` and async `invoke(capability, request)`. Return `ProviderResponse` with the exact request hash, capability, provider identity, typed payload, admitted evidence references, source version, complete/qualified coverage and synthetic flag. The router checks profile capability and tenant provider entitlement before invocation, then verifies identity/request binding and coverage.

Provider responses are captured as immutable `ToolInvocation` records and linked into result evidence. A response cannot cite another tenant or unadmitted evidence. Missing providers/recordings return `NEEDS_EVIDENCE`; a synthetic provider cannot assess non-synthetic context. Add a new captured source through an authorized ingestion/context enrichment operation before citing it; response references do not expand access.

The reference provider intentionally only replays exact requests. Live authority, list, OCR, translation, model and forensic adapters must preserve their own effective dates, licensed coverage, limits and errors. Do not route weaker sources as silent fallback.

## Agent and workflow integration

`AgentRunner` offers a compact profile-filtered skill index, progressively loads selected instructions/schemas, and executes through normal admission. A planner is trusted application code, not dynamically downloaded skill code. Implement model I/O under the profile's approved model configuration and residency policy. Step/time/character bounds stop planning or invocation; the included scripted planner makes no model calls.

`WorkflowRunner` executes explicit DAG steps, validates dependencies, binds prior outputs by data paths, evaluates conditions/success gates and checkpoints after steps. Definition/template/identity changes invalidate a checkpoint. Durable human interruption returns a pending approval ID. The example KYB template covers the no-EDD path and blocks for EDD handoff when required; applications can define the full conditional EDD workflow using the available skills.

Approval flow:

1. Run the human-gated skill and retain the original invocation.
2. Authenticate a different human actor with the policy-authorized role and `approve:<skill_id>` permission.
3. Call `Executor.approve(approval_id, reviewer)`.
4. Resume the original invocation with `approved_task=approval_id`.
5. The executor checks action/input/context hashes, code/instruction/runtime lock, policy, expiry and case revision before consuming approval and committing commands.

Source/policy changes can invalidate a live action even when a historical request remains reproducible. Reevaluate with a new invocation/idempotency key rather than changing the contents of a previously bound request.

## HTTP transports

Two portable hosts wrap the library; both use the Python standard-library HTTP server and no cloud SDK.

- **skill.execution.v1 host** (`python -m financial_crime.runtimes.skill_host`, the container default). EHF's capability gateway calls it for library skills: `GET /healthz`, `GET /v1/bundle`, `POST /v1/skills/{skill_id}/executions`, `GET /v1/skills/executions/{execution_id}` and `POST /v1/skills/executions/{execution_id}/cancel`. Every route but `/healthz` requires `Authorization: Bearer $SKILL_HOST_AUTH_TOKEN` (at least 16 characters). Context and policy arrive in the request; the host owns no data and refuses a bundle lock that does not match the installed catalog.
- **EHF bridge host** (`financial_crime.ehf.create_bridge_host(bridge, authenticate)`). `POST /invocations` takes a `fincrime.ehf/assignment-v1` request or a `fincrime.ehf/plan-request-v1` request; `GET /readiness` is unauthenticated. Bodies are limited to 1 MiB and cannot supply permission fields. `configured_bridge_host()` is the synthetic bootstrap (`FC_EHF_SYNTHETIC=true`, `FC_EHF_BEARER_SHA256`, `PORT`).

An authenticator or identity resolver must validate platform/delegated identity and map it to a trusted tenant principal. The synthetic bootstraps fail closed without an explicit token. Production bootstrap must supply its own resolver and repositories; forwarded headers alone are not trusted.

The container uses Linux x86_64 and a non-root user. Deployment identity, shared storage, networking, model connections and recovery remain deployment integration work for the target platform.

## Release maintenance

Edit Python handlers/declarations and the source-backed design target, then run `scripts/build_catalog.py`. It checks exact coverage of the 222 source IDs, rejects untyped containers in every published schema, validates manifests/catalogs, verifies the archived contract snapshot, and emits the installable resources, manifests, schemas, context matrix, reverse consumers, examples and release hashes. `--check` detects stale generated content. Do not hand-edit generated resource copies.

Use the dependency locks for reproducible runtime/testing environments. The package API supports exact versions within a trusted bundle, not arbitrary semver-range installation at request time. Promote policy/provider/model/runtime combinations only after relevant accuracy and operational evaluations; synthetic contract tests do not establish those results.
