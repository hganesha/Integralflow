# Production delivery plan

This roadmap replaces the original POC framing. Estimates are work-package sizing, not calendar commitments. The v1 plan pipeline has since been removed: only v2 packages compile and only v2 plans admit and run; v1 packages and plans are refused (`package.v1_removed`, `plan.v1_removed`).

The lane descriptions below predate the current code and are not a completion checklist; the component notes in this directory describe what is built.

## Locked decisions

- Policy source is reviewed YAML compiled deterministically to pinned OPA/Rego v1.
- Case Store is the coordination authority; agents receive purpose-bound snapshots, never ambient graph state or database access.
- Agent output remains a proposal. Deterministic gates record authority; final decline remains human-only. Only a separately approved low-risk approval path may become automatic.
- Production agent execution requires a hosted runtime (`hosted_http` or `databricks`). `local_http` remains a development/test adapter.
- No cloud is a mode of the platform: production mechanisms are open standards (OIDC, workload identity, mounted private keys, `env:`/`file:` secrets, OTLP), selected per concern (README "Deployment settings").
- US KYC is the first production domain. Institution-specific settings and the rule catalog must be approved before promotion.

## Phase 1 — contracts and trust boundaries

Status: implemented in this branch.

- Versioned PolicyBundle, CaseSnapshot, ContextManifest, PolicyEvaluation, ExecutionWorkItem, ReleaseManifest/ReleaseRecord, DomainPackage v2 and HarnessPlan v2 contracts.
- v2 compiler output with policy/context/release bindings and bounded gate/fanout validation (v1 output since removed).
- Strict policy parser, deterministic Rego/data output, pinned OPA compatibility metadata, golden-decision enforcement and production blocker checks.
- KYC candidate policy with 21 unique rule/config IDs, six explicit institution blockers and 13 golden cases.
- Repeatable-read purpose-bound case snapshots, canonical v2 fail-closed authority path and runtime selector isolation.
- Compiled-plan authority checks for capability envelopes, case-write schemas and prohibited agent writes.

Exit evidence: workspace typecheck/tests/build (compiler tests included), repeat UI build, deployment parity, deterministic policy bundle digest.

## Phase 2 — durable control and release plane

Lane C status: the durable work kernel, v2 lowering/conformance kernel and the
`local_http`, `hosted_http` and `databricks` runtime adapters are implemented
([runtime conformance](runtime-conformance.md)). Certification of the hosted runtime in
the target environment remains an exit gate; local conformance tests do not substitute
for it.

- Persist policy bundles and release manifests trusted through the [artifact registry](artifact-registry.md), with revocation, canary activation and rollback.
- Admit and execute HarnessPlan v2, including deterministic gate nodes and bounded fanout/subgraph primitives.
- Materialize durable ExecutionWorkItems with lease/fence/idempotency semantics, approval tasks, queues, SLAs, dual control and escalation.
- Persist ContextManifests and PolicyEvaluation receipts and apply policy decisions atomically through Case Store commands.
- Add event/webhook delivery (HMAC or OAuth 2.0 client credentials) with outbox/inbox deduplication and replay-safe consumers.
- Extend the authoring UI for policy bindings, selectors, schemas, release evidence and evaluation results.

Parallel lanes: compiler/runtime; release/security; work-item/human-task service; authoring UI; evaluation infrastructure. Contract conformance suites are the merge boundary.

## Phase 3 — advanced US KYC

Lane D status: started. Authoring and deployed-harness operations now have distinct entry
points. A plan-digest-scoped operations workspace limits navigation and queries to one
harness, while Policy Studio edits and compiles the canonical multi-file KYC catalog
through the guarded decision-table compiler. Policy revision persistence, approval,
signing/publication, durable human queues and exports remain open Lane D work.

- Resolve and approve institution type, applicable rule catalog, CDD threshold, account-opening relief, document-validity policy and automatic-approval authority.
- Implement real identity, sanctions, PEP, adverse-media, internal-search and OCR adapters with coverage/freshness/provider-error evidence.
- Add entity/beneficial-ownership handling, EDD, QA, dual control, periodic review, material-change rescreening and downstream handoff.
- Run golden, adversarial, fault, stale-snapshot, replay, shadow and canary suites. Automatic decline remains disabled; low-risk approval requires explicit release evidence and policy-owner approval.

Parallel-agent boundary: a separate agent may build provider simulators/contracts, synthetic corpora, UI views or documentation in parallel. It must not change canonical command authority, policy outcomes, digest rules or release schemas without the owning lane's contract tests.

## Phase 4 — production NFR and operations

- Separate control, case operational and read/audit stores; add read replicas/CDC/data-lake projections and case-file JSON/HTML/PDF generation.
- Move evidence bytes to malware-scanned immutable object storage with WORM retention, legal hold, reconciliation and recovery verification.
- Complete the OTLP collector pipeline (redaction, tail sampling, routing), structured error taxonomy, SLOs, alert ownership, cost/quota controls and security/audit dashboards.
- Prove load/soak limits, PgBouncer/connection budgets, autoscaling, backpressure and per-tenant fairness.
- Execute backup/restore, regional failover, key rotation, break-glass, incident response and vendor/model outage drills.
- Require hosted runtime attestation, private networking, US residency, image provenance/SBOMs and promotion evidence before production activation.

Exit is an operational readiness decision with security, policy, privacy, KYC operations, SRE and audit sign-off; deployed infrastructure alone is not evidence of readiness.
