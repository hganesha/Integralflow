# Platform health and source workbench

Implemented against `main` at `9741752f`. This closes the requested Services telemetry, worker, admission, runtime readiness and source authoring gaps. Process Studio and the consolidated Data sources workspace are documented in the [navigation audit](../navigation/README.md).

| Area | Delivered behavior |
| --- | --- |
| Services | Real service dependency reports, tenant queue counts, healthy worker replicas, migration version and reported build metadata. Missing metadata is explicit, never a fabricated version or zero. |
| Telemetry | Checks an explicit collector health endpoint or sends an empty OTLP HTTP export to the configured receiver. Credentials stay in the service. A gRPC receiver needs `TELEMETRY_HEALTH_URL`. |
| Workers | Runtime and integration workers record per-replica heartbeat, last successful loop, concurrency, in-flight count and draining/stopped lifecycle. Health distinguishes absent, stale and draining replicas. |
| Runtime readiness | Reads the checkpoint store/schema, calls the invocation journal with the runtime workload identity, and probes the gateway and case API. The gateway also checks its configured model/adapter dependencies and reports missing model execution as degraded. Memory checkpoints are degraded; failed checks return 503. |
| Admission | Operator-only stop/resume with reason, expected revision and durable audit evidence. Drain preserves admitted runs. Cancel advances run fencing epochs, immediately cancels queued work and requests cancellation of active invocations. The existing admission lock also protects run creation. |
| Source browsing | `/studio/skills` and `/studio/agents` open separate source inventories and complete text bundles for canonical skills and business/runtime agents. Legacy `/platform/workbench` links redirect by source/workspace kind. Skill imports include their manifest, Markdown, schemas, implementation, shared library resources and tests. Readers can browse without creating a workspace. |
| Source editing | File tree and filter, Markdown preview, code/config editing, comparison, file/folder creation, moves and deletion. Workflow draft extra source files use the same editor. Local source deltas survive reload; stale saves preserve edits and require explicit rebasing. |
| Revisions | Immutable, tenant-scoped snapshots with content digests, actor/message/history, historical browsing, restore as a new revision, JSON bundle import/export and separate published revision. |
| Evaluations | Durable jobs run exact saved source against uploaded or edited versioned JSON datasets. Each case needs expected output or JSON Pointer assertions. Actual source executes in bounded disposable containers. Results retain source/dataset/model digests, expected/actual values, failures, duration, available tokens/cost, trace IDs and executed skill receipts. |
| Agents | Template or imported `AGENT.md`, instruction files, model profile selection, I/O schemas and exact attached skill digests. The model selects only attached tools; those tools execute edited source using supplied test fixtures. Model credentials remain in the gateway. |
| Publication | A different author must approve and publish an exact passing source revision. Attached skill digests require published evidence. Published releases and completed evaluation evidence cannot be rewritten. |

## Source contract

`workbench.json` is the execution definition: `kind`, `name`, `version`, `description`, `engine`, `entrypoint`, `inputSchema`, `outputSchema`, `modelProfileId` and `skillRefs`. Python uses `module:function`; JavaScript uses `file.mjs:export`; agents use a Markdown entrypoint. Imported `agent.json` and `skill.yaml` remain reference/deployment artifacts; changes to evaluation behavior belong in `workbench.json`, the selected source entrypoint and instruction files. Canonical business skill execution uses the library fixture adapter.

Example dataset:

```json
{
  "name": "Name normalization",
  "version": "1",
  "cases": [{
    "id": "trim-and-lower",
    "input": {"name": " Alice "},
    "expected": {"normalized": "alice"}
  }]
}
```

Assertions use `path` (JSON Pointer), `operator` (`equals`, `contains`, `exists`) and optional `value`. A library skill accepts its normal input, or an object with `parameters`, `records`, `policy`, `providers` and `state`, or an `execution` fixture containing a library execution context. Fixtures do not authorize live case writes or outbound access from edited code.

## Deployment boundary

Publishing releases a source bundle. It does not change canonical catalog files, runtime agent registry entries, model-profile activation or the pins of admitted plans. Export the reviewed release and deploy it through the existing reviewed artifact/plan lifecycle. The existing agent/instruction and model-profile forms remain available, with agent instructions labelled separately from business skills. This work adds neither a Git branch/commit/push client nor an arbitrary live case editor. The source history is a persisted revision workflow with bundle import/export.

A trace ID is shown when tracing is active; open it in the deployment's monitoring tool. The existing combined trace-store reader and other explicitly unavailable assurance/overview projections remain outside this requested scope.

## Evaluation isolation and limits

Local Docker runs have no network, credentials or Docker socket, use a read-only source mount and root filesystem, drop capabilities and use UID 65534. Each case has CPU, memory, process, wall-time and output limits. Azure uses a trusted blob coordinator and an unprivileged source child with an empty environment, socket/ptrace restrictions and read-only source. Its signed URLs each authorize one blob and never reach the child. Azure job retries are disabled.

Evaluations allow at most 100 dataset cases, 8 model steps per case, 10 queued/running jobs per tenant and 15 minutes per job. Retained case results and tool receipts are each bounded to 1 MB per evaluation. The browser loads the latest ten reports plus release evidence for the selected revision. Lost worker leases fail explicitly rather than replaying paid calls. Completed model steps are reused by exact evaluation/case/step identity. Per-evaluation budgets reserve against the environment monthly meter when configured, and reported spend blocks further model steps; a provider that omits price data reports unknown cost. These controls do not guarantee a hard provider billing cap. Use Azure/provider quotas and a small test dataset for initial live testing.

## Verification

The local acceptance stack uses actual BFF, control API, gateway, runtime host, case API, runtime/integration workers, PostgreSQL control/checkpoint storage, pgvector/AGE case/context stores, and a Jaeger OTLP receiver. Its test identity resolver is loopback-only and is not part of a production service.

- API integration: real HTTP, PostgreSQL with service roles, actual Docker source execution, revision conflicts, cross-tenant denial, self-approval denial, exact publication evidence, cancellation and runtime admission fencing.
- Agent integration: actual gateway and SDK transport, real pinned skill execution and model/source revision changes. The provider transport is a deterministic test fixture; this is not a live Azure model invocation.
- Azure adapter: real Azure Blob SDK and signed blob URLs against Azurite; the ARM transport launches the real restricted job image locally and verifies source/request binding and cleanup.
- Kernel sandbox: actual UID/environment/socket/parent-process/source-permission checks with Docker networking enabled.
- Browser: source editing, folder moves, Markdown preview, reload recovery, dataset persistence across tabs, real evaluation, independent review/publication, full canonical source browsing, Services and runtime controls. Desktop/mobile screenshots and automated accessibility checks accompany the tests.
- Contract generation/lint, touched package type checks, regression suites, HTTP web bundle, service builds and Bicep compilation are recorded in the PR.

Run the isolated HTTP acceptance stack after migrating disposable stores and building the web/evaluator image:

```sh
SECURITY_PROFILE=development WORKBENCH_TEST_DATABASE_URL=postgresql://USER:PASSWORD@127.0.0.1:5558/workbench node --import tsx e2e/ui/support/workbench-http-server.mts
CONTEXT_HTTP_URL=http://127.0.0.1:5314 WORKBENCH_HTTP_URL=http://127.0.0.1:5314 pnpm --filter @ehf/e2e-ui exec playwright test workbench-http.spec.ts
```

The helper expects sibling `ehf_case` and `ehf_context` databases, the evaluator image `ehf-workbench-evaluator:local`, and an OTLP receiver (`WORKBENCH_TELEMETRY_URL`, default port 5320). Test integration suites use `WORKBENCH_TEST_DATABASE_URL`; the Azure adapter suite uses `WORKBENCH_AZURITE_URL`. All must target disposable stores.

See the [verification record](VERIFICATION.md) and [Azure test setup](AZURE.md). No Azure deployment or paid model call has been performed for this change.
