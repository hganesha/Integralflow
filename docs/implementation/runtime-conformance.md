# Runtime conformance

Lane C separates durable execution authority from execution adapters. PostgreSQL work
items, leases, fences, timers and reconciliation records are authoritative. A queue
notification, a LangGraph checkpoint or a runtime's reply is never sufficient evidence
that work may start, retry or commit.

## Implemented contract

- Runtime invocations are versioned. The `runtime.invocation.v2` envelope carries an
  immutable `HarnessPlan v2` with an exact plan-digest binding; the v1 envelope and v1
  plans were removed.
- The v2 kernel admits only engine/adapter-version pairs whose semantics it implements
  (`harness-runtime` / `harness-runtime-v2`). It rejects unsupported node kinds and
  non-case-store coordination instead of coercing them. Migration `041_cloud_neutral.sql`
  and the recompiled plans moved stored plans onto that pair.
- Canonical case snapshots are verified by digest and plan identity before selectors
  are applied. Gates receive only compiled selections and authority metadata.
- Gate evaluations are correlated to the exact case, sequence, snapshot, dependency,
  policy bundle, gate and input digest.
- Fan-out enforces compiled item, concurrency and transition bounds before work starts.
  Approval nodes use checkpointed suspension and resume only with a validated human
  decision. A production release must bind that seam to the durable controller; the
  runtime's memory checkpointer is not restart-durable.
- Node work uses generation-specific dispatch, application leases, monotonic fencing,
  bounded attempts, durable timers and journaled transitions. Each node transition
  carries its journal event (`node.started`, `node.completed`, `node.failed`) in the same
  write. An expired running lease becomes a reconciliation case rather than an automatic
  retry with an unknown effect.

## The protocol every adapter speaks

Every runtime adapter (`local_http`, `hosted_http`, `databricks`, or one registered with
`registerRuntimeAdapter`) hosts the same runtime-host image and speaks the same protocol:

| Route | Purpose |
| --- | --- |
| `POST /invocations` | Run one node under a `runtime.invocation.v2` request; the result must echo `invocationId` and `runId` (`runtime.result_correlation_mismatch` otherwise) |
| `GET /invocations/:invocationId` | Status for reconciliation; `unknown` when the runtime cannot answer, never a guess |
| `POST /invocations/:invocationId/cancel` | Cancellation; an unknown invocation counts as already stopped |
| `GET /health/live`, `GET /health/ready` | Liveness and readiness (readiness reports `runtime.invocation.v2`) |

Status and cancellation are reached with the same identity as invocation. Adapters
differ only in hosting and in how the dispatcher authenticates:

| Adapter | Endpoint | Dispatcher credential | Hosted |
| --- | --- | --- | --- |
| `local_http` | `RUNTIME_LOCAL_ENDPOINT` (development); production requires `RUNTIME_HOSTED_ENDPOINT` | its own workload credential (`RUNTIME_HOST_AUTH_TOKEN` or projected token) | no |
| `hosted_http` | `RUNTIME_HOSTED_ENDPOINT` or a binding; verified HTTPS, no userinfo or fragment | its own workload credential, read fresh per call | yes |
| `databricks` | `DATABRICKS_RUNTIME_ENDPOINT` or a binding; Databricks-hosted domains only | OAuth M2M token for a service principal; the Apps proxy forwards the caller and the host admits only `RUNTIME_HOST_DATABRICKS_PRINCIPALS` | yes |

Every provider pins an execution-profile digest that is recorded on the invocation. The
runtime host carries no grant-signing key, execution-envelope key or run-journal
database credential: it exchanges the per-invocation grant at the control plane's
envelope broker and journals through it. Callback URLs for the capability gateway, case
API and control plane must use HTTPS under the production security profile.

## Certification gate

`packages/runtime-provider/src/conformance.test.ts`, `lifecycle.test.ts` and
`registry.test.ts` prove request shape, credential use, correlation, profile pinning,
lifecycle behaviour, cancellation semantics and failure behaviour for every shipped
adapter with deterministic test doubles. Production certification still requires the
target environment and is not implied by local tests.

Before activating a release, record evidence that:

1. the pinned runtime-host image digest is deployed at the bound endpoint;
2. public ingress, direct model/data access and cross-environment identity use are
   denied;
3. the runtime's callbacks reach only the gateway, case API and control-plane audiences,
   and the runtime host admits only the dispatcher's identity;
4. invoke, status and cancel pass against the deployed host, including lost-response and
   duplicate-request cases;
5. execution-profile mismatches fail closed;
6. a dispatcher crash after remote invocation creates reconciliation work and does not
   repeat an effect; and
7. readiness, graceful termination and telemetry correlation are captured in the release
   evidence.

Private networking, residency, image provenance/SBOMs and production operational testing
remain Phase 4 release gates.

## Case-read authority at node start

A `node-started` write may set `issueCaseReadEnvelope: true`. After re-checking the grant and fence for the write, the control plane mints the node's case-read envelope under exactly the rules of `POST /v1/runtime/envelopes` (including the `envelope.mint` permission) and returns it with `200` instead of `204`. The runtime uses it once for the node's snapshot read, and asks for a fresh envelope instead if it is within ten seconds of expiry. Gateway and commit envelopes are still requested at the moment of use: the gateway envelope's ID is derived from the input computed from the snapshot (so a resumed run replays the same receipt), and the commit envelope must be issued after the skill has run, against the fence as it is then.

