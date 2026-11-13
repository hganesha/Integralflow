# Durable orchestrator, pluggable runtimes, pluggable capabilities

## The shape

```
                 Postgres (system of record)
   runs · leases · fencing epochs · work items · node outputs · human decisions · receipts
                                │
                    ┌───────────┴────────────┐
                    │  Orchestrator          │  apps/runtime-worker (v2 dispatcher)
                    │  walks the plan; each  │  one leased, fenced work item per node;
                    │  node is a durable     │  output committed before successors run;
                    │  work item             │  approvals suspend in Postgres
                    └───────────┬────────────┘
                                │ runtime.invocation.v2 (+ short-lived grant)
          ┌─────────────────────┼─────────────────────┬──────────────────┐
     local_http            hosted_http             databricks          <your adapter>
   runtime-host         runtime image as its      Databricks App        registered at
   container            own HTTPS service         (runtime image)       dispatcher start
          └─────────────────────┼─────────────────────┴──────────────────┘
                                │ execution envelopes (broker) · capability calls
                    ┌───────────┴────────────┐
                    │  Capability gateway    │  credentials, budgets, receipts, permissions
                    └───────────┬────────────┘
     simulator · opensanctions · wiring (849 connectors) · evidence · pgvector ·
     openrouter · databricks-serving · databricks-vector · databricks-uc ·
     http-operation · skills · ...                (capability adapter modules)
```

Three rules keep this flexible without loosening control:

1. **Postgres is the orchestrator.** Durability, retries, fencing, human suspension and
   replay live in the run ledger and work items, not inside any runtime. A runtime can
   crash, be swapped or be hosted elsewhere; the next node still starts from committed
   state.
2. **A runtime hosts the platform's per-node executor.** It receives one node at a time
   with a grant it cannot mint, exchanges it at the envelope broker, and reaches the case
   API and the gateway. Runtimes differ only in hosting and in how the dispatcher
   authenticates to them.
3. **Vendor-native agents and models are capabilities, not runtimes.** A Databricks
   Mosaic AI agent endpoint, a Databricks serving endpoint, an OpenRouter model or an
   allowlisted HTTP operation is called through the gateway like any other capability,
   so it is permissioned per node, budgeted, receipted and replayable. (See
   [capability adapters](capability-adapters.md).)

## Concurrent waves

The dispatcher runs the plan in waves: every node whose predecessors have committed is
leased and invoked concurrently, up to `plan.execution.maxConcurrency`. Each node receives
a frozen copy of the committed values, the heartbeat renews every held work-item lease,
and an approval is requested only after the other ready nodes have committed. A node that
fails while feeding only `allSettled` joins is committed as a rejected settlement
(`{__workflowRejected, reason}`) and reaches the join as `rejected`; any other failure
suspends that work item and fails the run closed once its siblings have settled, so no
in-flight result is abandoned.

## Runtime targets

A node's `config.runtimeTarget` (and an agent's `runtimeTarget`) is
`<adapter>` or `<adapter>:<binding>`:

| Target | Resolves to |
| --- | --- |
| `local_http` | the runtime host container (`RUNTIME_LOCAL_ENDPOINT`; production refuses it and requires `RUNTIME_HOSTED_ENDPOINT`) |
| `hosted_http` | the runtime-host image deployed as its own HTTPS service on any Kubernetes cluster or container platform (`RUNTIME_HOSTED_ENDPOINT`, verified TLS only) |
| `databricks` | `DATABRICKS_RUNTIME_ENDPOINT` with OAuth M2M (`DATABRICKS_HOST`, `DATABRICKS_CLIENT_ID`, `DATABRICKS_CLIENT_SECRET`) |
| `<adapter>:<name>` | the administered runtime binding `<name>`, which must declare the same adapter |

The dispatcher authenticates to `local_http` and `hosted_http` with its own credential
(`RUNTIME_HOST_AUTH_TOKEN` under `WORKLOAD_AUTH=static_token`, its projected workload
token under `workload_identity`); the runtime host verifies it as `runtime-dispatcher`.

Plans resolve **per node**, so one plan can run its investigation agent on Databricks,
its assessment on a hosted runtime and its transforms locally. The compiler requires production agent profiles
to target a hosted adapter (`hosted_http` or `databricks`;
`package.production_agent_profile_requires_hosted_runtime`).

## Runtime bindings (administered)

Settings → Runtime → **Runtime bindings** (`runtime.bindings`, or `RUNTIME_BINDINGS_JSON`):

```json
{
  "kyc-investigator": {
    "adapter": "databricks",
    "endpoint": "https://kyc-runtime-1234.aws.databricksapps.com/invocations",
    "auth": "databricks_oauth_m2m",
    "workspaceHost": "https://dbc-1234.cloud.databricks.com",
    "clientIdEnv": "DATABRICKS_KYC_CLIENT_ID",
    "clientSecretEnv": "DATABRICKS_KYC_CLIENT_SECRET"
  },
  "assessment": {
    "adapter": "hosted_http",
    "endpoint": "https://runtime.internal.example.com/invocations",
    "auth": "platform_token"
  }
}
```

`auth` is `platform_token` (the dispatcher's own workload credential) or
`databricks_oauth_m2m` (a Databricks service principal; `databricks` only). Migration
`041_cloud_neutral.sql` dropped stored Foundry bindings and reset a Foundry default
target to `local_http`. A binding names environment variables for secrets and never contains one. It is re-read
per node, so repointing a binding reaches the next node. A binding cannot change the
adapter a plan named (`runtime.binding_adapter_mismatch`). Every provider pins an
execution profile digest that is recorded on the invocation, so the ledger shows exactly
which runtime served each node.

## Adding a runtime

Implement `RuntimeProvider` (`invoke`, `getStatus`, `cancel`) and register it:

```ts
import { registerRuntimeAdapter } from "@ehf/runtime-provider";
registerRuntimeAdapter({
  id: "aws_agentcore", description: "…", hosted: true,
  fromBinding: (binding, name, context) => new MyProvider(binding, context),
  fromEnvironment: (context) => new MyProvider(fromEnv(context.env)),
});
```

`getStatus` must return `unknown` rather than guess when the runtime cannot answer: the
dispatcher uses it to decide whether a retry could duplicate an effect.

## Databricks specifics

- **Hosting:** deploy the runtime-host image as a Databricks App with
  `RUNTIME_HOST_MODE=databricks_app` and `RUNTIME_HOST_DATABRICKS_PRINCIPALS=<dispatcher
  service principal application id>`. The Apps proxy authenticates the dispatcher's
  workspace OAuth token and forwards its identity (`x-forwarded-email` /
  `x-forwarded-user` / `x-forwarded-preferred-username`); the host trusts those headers
  only in this mode and only for the listed principals. The app reads `DATABRICKS_APP_PORT`.
- **Network:** the app must reach the control API (envelope broker), case API and
  capability gateway. Without that egress it can authenticate but not act.
- **Assumptions to verify on a workspace:** the exact forwarded-identity header the Apps
  proxy sets for a service principal caller, and that M2M tokens with `scope=all-apis` are
  accepted by the app URL. Both are isolated in `apps/runtime-host/src/app.ts` and
  `packages/runtime-provider/src/databricks.ts`.

## Not yet done

- Databricks asset-bundle templates for deploying the runtime image to a Databricks App.
- A `runtime:` view in the control surface listing registered adapters and bindings.

Conformance of every adapter to the `runtime.invocation` protocol is described in
[runtime conformance](runtime-conformance.md).
