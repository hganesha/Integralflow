# EHF integration — release 0.3.0

The financial-crime library now plugs into EHF's control plane. EHF owns work identity, scheduling, leases, retries, human decisions and canonical case mutations. Python evaluates pinned skills against authorized snapshots and returns results and proposed actions.

This release preserves skill API `0.2.0` and canonical record schema `2.0.0`. Its new integration contracts use `fincrime.ehf/*-v1`. The EHF changes are in the companion checkout `ehfconcept`, based on commit `63874109c2ad9c4405e9337c66ec3c87886ddce7`.

## Installed artifacts

| Artifact | Purpose |
| --- | --- |
| [EHF catalog](../catalog/ehf-catalog.json) | All 222 skill manifests, executable entrypoints, schemas, dependencies, instructions and hashes; six business profiles and TaskSpecs. |
| [Context products](../catalog/context-products.json) | Twelve shared subscription categories covering the 87 canonical context types. |
| [Profiles](../profiles/) | Intake & Profile, Identity & Ownership, Screening, Risk & EDD, Decision Support, QA & Assurance. |
| [Task specifications](../tasks/) | Bounded objectives, explicit inputs, step dependencies, pinned skills, completion checks and failure policies. |
| [Integration schemas](../schemas/integration/) | Assignment scope, planning requests/plans, context packets and typed execution outcomes. |

Profiles declare both context-field and policy-field ceilings. The compiler intersects these with principal authorization and the selected skill's requirements. Subscriptions do not grant access by themselves. Context remains a per-skill projection; an agent does not receive an entire customer record.

Corporate ownership uses `ownership.ubo.resolve` once; it does not separately repeat the interest calculation returned by that skill. Screening and identity tasks expose independent branches with explicit synchronization. Case creation happens in EHF before assignment. Decision Support ends in durable independent human review; completing that task does not finalize customer acceptance.

## Catalog import

```sh
.venv/bin/fc-skills export-ehf --output catalog/ehf-catalog.json
```

EHF's new `@ehf/fincrime-integration.importCanonicalCatalog(artifact, expectedDigest)` verifies a caller-pinned SHA-256 and every embedded manifest/profile/task artifact. Exact canonical source strings preserve cross-language numeric serialization and source hashes. Import does not run entrypoints, install dependencies, activate providers or publish a release.

The companion Control API exposes:

- `POST /v1/authoring/import/fincrime` with `{artifact, expectedDigest}` under `agent.register` authorization.
- `GET /v1/authoring/catalogs/fincrime/:digest` under draft-read authorization.

Imports are immutable tenant-scoped drafts. Existing prompt-oriented GitHub imports remain separate; canonical skill IDs and versions are preserved. Registered/compiled contracts retain executable metadata through the Rust compiler. Production authoring still requires approved runtime/model/release bindings and normal publication controls.

## Execution boundary

`financial_crime.ehf.Bridge` accepts an assignment pinned to task, profile, skill, instruction and bundle hashes. The scope also contains tenant, case, case sequence, snapshot digest, run, node, work item, execution ID and run/work fencing epochs.

The hosting application supplies an `Authority`:

```python
class Authority:
    async def resolve(self, scope):
        # Return a trusted Principal and ContextPacket for the live EHF assignment.
        ...

    async def assert_current(self, scope):
        # Recheck release, live work/run fences, cancellation and reviewed basis.
        ...
```

`ContextPacket` contains validated canonical records, exact policy/time/subject scope, explicit state snapshots and the parameters authorized by that work item. Request parameters must match those authorized values. `resolve` must obtain authority and data from trusted platform services; it must not build a Principal, records or permissions from arbitrary invocation-body fields. The bridge checks live authority before and after evaluation, uses a read-only repository, validates outputs and evidence, and never commits proposed commands or creates its own approval queue.

The initial `SyntheticAuthority` is explicitly local and fixture-only. A production adapter must map EHF selectors/case data into the canonical records without inventing evidence, preserve case sequence and immutable source versions, and implement live authority checks. Domain-specific ingestion mappings are application-owned; similarly named EHF snapshots and library records are not interchangeable.

## Runtime and controller integration

`create_bridge_host(bridge, authenticate)`, a standard-library HTTP server, exposes the bridge at `/invocations`, with injected authentication. `FinancialCrimeClient` validates scope correlation and typed outcomes over HTTP. The EHF capability registry supports `financial-crime:<canonical-skill-id>@<skill-version>` bindings when a trusted `financialCrime` binding is injected into `buildGateway`.

The gateway derives task/run/work authority from the admitted plan and verified execution envelope. `resolveBasis` is an application-owned context-source callback; runtime input cannot supply the case sequence or snapshot digest. Tool parameters are still validated by the Python skill contract. Production provider routing must retain the EHF capability boundary; the bundled Python router only supplies synthetic recordings.

`FinancialCrimeClient.plan` calls the authenticated planning operation. EHF's `dispatchCanonicalTask` materializes that bounded TaskPlan into existing Postgres work items and uses the same lease, dispatch, outcome and human-review machinery. It requires an application-supplied `authorize` callback after release admission, including the admitted catalog digest; a changed startup catalog cannot replace the published bundle. Its optional `commitObservation` hook runs under the live work lease before completion/suspension. It is a callable controller integration point, not a second autonomous scheduler or public authorization endpoint.

The companion EHF runtime changes provide:

- Database-wall-time checks before leased transitions and renewal; expired owners cannot complete before a sweeper advances their fence.
- Bounded ready-node execution and draining of active siblings before suspension/finalization.
- Immutable per-execution observations, including rejected/all-settled branch outcomes.
- Checkpoint isolation by run/work/attempt/work fence.
- Postgres invocation claims, retained results, status and cancellation intent, accessed through the Control API; runtime hosts receive no SQL credentials.
- New `runtime.invocation.v3` and `runtime.result.v2` contracts for settlement transport, with legacy v1/v2 request and v1 result readers retained. Update companion producers/consumers together.

Human decisions remain EHF records. Resume reads the durable decision; it does not change the original skill observation or manufacture a Python approval. Declined decisions stop the task.

## Canonical writeback

`outcomeCaseCommand` creates `RecordFinancialCrimeOutcome`. The Case API requires live run/work authority and checks that the submitted observation matches the controller's retained outcome. The transaction stores the immutable evaluation, increments case sequence, and appends the ledger event, command receipt and outbox event.

This records an evaluation observation, not an accepted identity/risk fact or a final disposition. Proposed commands remain explicit and uncommitted. Fact promotion, external delivery and final decisions use their separately authorized domain commands and policy controls. Recording an older basis does not make it fresh; decision gates must evaluate the current material case basis.

## Reproduce the local integration proof

Install both repositories' locked dependencies, build EHF's pinned Rust compiler and generate this catalog. From the EHF checkout:

```sh
pnpm exec tsx scripts/smoke-fincrime.ts ../kyc ../kyc/docs/ehf-smoke.json
```

The script creates one disposable, loopback-only Postgres 16 container and an authenticated Python host, then removes them. It imports all 222 contracts, executes the six tasks, resumes completed work under another worker, exercises two independent reviewers, verifies outcome writeback/receipts/ledger, rejects expired-lease completion, and checks shared runtime status/result replay across replicas.

The smoke applies all control-plane migrations and the case migrations excluding the unrelated vector-search extension. It uses EHF's existing US-labelled legacy case envelope solely as a storage fixture; the financial-crime policy and records remain synthetic and jurisdiction-neutral. It performs no cloud deployment, live provider call or real customer decision.

Production rollout additionally needs application identity/context adapters, approved source and policy packs, runtime/provider qualification, operation and recovery testing, and deployment-specific credentials/network/storage configuration. No default production authority or credential is supplied.
