# Implementation status

Date: 2026-11-07. Release: 0.2.0; context schema: 2.0.0. Baseline: jurisdiction-neutral synthetic policies and local test providers, as requested.

## Delivered

| Area | Implemented behavior / artifact |
| --- | --- |
| Skill coverage | All 222 canonical IDs resolve to executable handlers; exact coverage checked against the source specification. |
| Skill packages | 222 instruction packages, each with manifest, parameter schema, payload schema, context declaration and an importable entrypoint. Shared domain modules and primitives avoid duplicating algorithms. |
| Registry and profiles | Version-pinned allowlists, actor/profile/policy permission intersection, trusted instructions, code/instruction hashes, explicit provider identities and entitlement checks before data leaves the executor. |
| Context | 1,705 skill/field declarations: 718 business fields and 987 scoped policy fields. Reverse consumers identify change impact. The source's 81 names are inventoried; the ontology exports 87 data shapes including six supplemental types. All 87 canonical data types are now closed, including the 27 formerly generic envelopes. Full records validate at ingestion; separate projections validate selected fields. Institution/source additions use versioned namespaced extensions. |
| Contract hardening | 444 closed skill input/output schemas; named nested objects, typed maps and array elements, nine provider request/response pairs, typed runtime locks/errors/metrics and discriminated effect commands. Build audits all 1,013 current schema files including bundle copies. |
| Version migration | Explicit context 1.0.0 to 2.0.0 business-record translator, preserved source versions/access metadata and extension provenance; no automatic approval/execution migration. Archived original contracts and direction-specific compatibility reports. |
| Context compilation | Tenant, actor, purpose, classification, field and subject/reference checks; bitemporal selection; required/optional gaps; freshness and size guards; immutable manifests; policy/source hashes; retained-input replay. |
| Deterministic library | Matching features, identifier formats/checksums, exact ownership path math, bounded graph traversal, text extraction/source spans, captured-source queries, weighted risk, rule predicates, complete-window transaction analytics, synthetic typologies and evidence checks. |
| Provider integration | Request-bound local recordings, capability/tenant provider admission, response identity/coverage checks, admitted citations and immutable provider invocation captures. Missing providers cannot produce success. |
| State and effects | Repository interface plus SQLite reference implementation; idempotent jobs, revision-checked commands, authenticated independent approvals, code/runtime/context binding, cancellation, operator recovery, audit chains and an outbox. |
| Agents and workflows | Bounded two-stage planner interface with progressive instruction/schema loading; explicit workflow DAGs with bindings, success gates, checkpoints and approval resume. |
| KYB example | A real 29-step synthetic no-EDD path, with independent reviewer identity, disposition recording and review scheduling. Required EDD blocks for an explicit workflow handoff. |
| Reporting example | Cited synthetic drafts and validation, permissioned submission intent, a local receiver with idempotent receipts and uncertain acknowledgment reconciliation. |
| Foundry | Official Invocations SDK adapter, native status/cancel routes, approval/resume/replay operations, identity resolver injection, non-root Linux x86_64 container and protocol declaration. |
| Distribution | Installable wheel with bundled instructions/manifests/schemas, exact dependency locks, catalog builder/checker, CLI, examples, Make targets and repeatable wheel/container smoke scripts. |

The implementation is a synthetic reference library with concrete supported behaviors. A successful execution does not establish real-world verification, detection accuracy, regulatory compliance or delivery of a queued command. Consequential effects on context that is not explicitly synthetic are rejected in this release. `Record.synthetic` defaults to false; synthetic fixtures opt in explicitly.

## Verification

- **1,620 tests passed on macOS/Python 3.14.4.** [JUnit report](test-results.xml).
- **The same 1,620 tests passed inside the Linux amd64/Python 3.12.16 image**, using the installed package and a read-only checkout for test assets. [Linux JUnit report](test-results-linux.xml).
- Every skill executes through the executor with its synthetic example and validates its result. Every skill rejects ungranted execution and undeclared parameters. Every mandatory context collection has a missing-data test.
- New contract tests validate independent examples for all 87 context types, unknown-field rejection, nested shape/range errors, exact result dispatch, projection/full-record separation, scalar and timestamp strictness, local schema references, migration preservation and conservative compatibility.
- Targeted tests cover exact ownership and currency math, cycles, duplicate events, incomplete datasets, unknown rules/factors, document spans, stale data, historical corrections, cross-process replay, field/tenant/actor denial, provider gaps and entitlement, approval/case/code changes, workflow restart, cancellation and uncertain receipts.
- The official SDK HTTP adapter matches local execution in ASGI tests. A real container HTTP test confirmed readiness, authenticated execution/status, anonymous denial and rejection of body-supplied permissions. [Runtime smoke receipt](runtime-smoke.json).
- The wheel was installed into an isolated target outside this checkout. Bundle integrity, the 29-step workflow and profile-bound agent succeeded there. [Wheel smoke receipt](wheel-smoke.json).
- Generated artifacts pass `scripts/build_catalog.py --check`; all manifests and published JSON Schemas validate.

These are correctness/control and synthetic contract results, not measured false-positive rates, biometric/forensic accuracy, recall or model calibration on real institution data.

## Integration work that remains separate

1. Add licensed live registry, screening, document/OCR, model and specialist fraud adapters. Current specialist responses are labeled recordings; decoded text parsing is the implemented document format.
2. Supply approved institution/jurisdiction packs, evidence verification criteria, real evaluation datasets, quantitative release thresholds and operating targets. The bundled monetary/ownership/reporting constants are synthetic test policy.
3. Inject an independently validated production identity resolver and shared repository adapter. SQLite and synthetic bearer-hash bootstrap prove the interfaces; they do not implement enterprise identity, cross-worker fencing or shared cross-session storage.
4. Supply host delivery workers for review-dispatch and retention commands, durable timers, and the institution's full conditional EDD and other workflow templates. The included delivery worker handles local filing tests only. Queued commands do not claim completed external action.
5. Qualify model/token/cost accounting, residency, licenses, retention/deletion adapters and production observability. Character budgets and captured source metadata are implemented reference controls.
6. Deploy to an actual Foundry project and verify its identity/network/storage/recovery behavior. The tested artifact is the local official SDK and Linux container; no Azure deployment or real filing occurred.

See the [contract and migration guide](schema-contracts.md), [schema inventory/audit](schema-contract-report.json) and [compatibility report](schema-compatibility.json). Previous release evidence is retained in [0.1.0 history](history/0.1.0/implementation-status.md).

See [integration guide](integration-guide.md) for APIs and adapter responsibilities, and [README](../README.md) for installation and demos. The original design targets remain available for deeper per-skill qualification.
