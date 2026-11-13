# Production performance envelope

The dispatcher uses `WORKER_CONCURRENCY` bounded slots per replica, PostgreSQL fencing
and `SKIP LOCKED` for exclusive claims, and `LISTEN/NOTIFY` for low-latency wakeups. A
bounded poll remains enabled so delayed retries, failovers, and lost notifications
cannot strand work. `/metrics` on `WORKER_METRICS_PORT` exposes queue depth, queue age,
in-flight work, claims, and iteration failures.

No service calls another to wake it: the control API only enqueues, the dispatcher
learns of runs from the queue, and the integration worker polls its own queue
(`INTEGRATION_POLL_INTERVAL_MS`). Each node transition carries its journal event in the
same write, so a node costs two fewer control-plane writes than a separate journal call.
Scaling is driven by queue depth, never by a caller.

## Connection budget

Put transaction-mode PgBouncer between services and PostgreSQL (the Azure recipe's
`database.pooler` input). Migrations and the dispatcher `LISTEN` connection
(`DATABASE_LISTEN_URL`, set by the recipe) must use direct/session-mode connections because
transaction pooling cannot preserve session state. Reserve 20% of PostgreSQL's
`max_connections` for administration, migrations, and failover, then require:

```text
sum(service_max_replicas × DB_POOL_MAX) + worker_max_replicas + autoscaler_connections <= usable_client_connections
```

The worker term reserves one direct `LISTEN` connection per replica; also reserve the
KEDA PostgreSQL scaler and observability connections. Defaults are five pooled
connections per service and two worker slots; production must set explicit
per-service values and replica ceilings. PgBouncer's server pool must be below the
database budget, while `max_client_conn` may be larger. Monitor pool wait time before
raising application pools.

## Scaling and backpressure

`RUN_QUEUE_MAX_PENDING` rejects new, non-idempotent admissions with HTTP 429 and a
`Retry-After` header once a tenant reaches its active-run ceiling. Idempotent replays
still return the original run. The KEDA example scales on ready queue depth, targets four
ready runs per replica, scales down slowly, and has a failure fallback. Tune only after a
load and soak baseline; worker concurrency must not exceed downstream model, gateway,
or database capacity.

## Performance gates

Run against an isolated stack with a representative admitted plan:

```bash
PERF_PLAN_DIGEST=<digest> PERF_RUN_INPUT='{"subject":"load"}' pnpm perf
PERF_MODE=soak PERF_SOAK_SECONDS=3600 PERF_PLAN_DIGEST=<digest> pnpm perf
```

The test creates concurrent admissions, verifies idempotent admission under contention,
waits for terminal outcomes, enforces admission error-rate and p95 thresholds, and checks
model-call, capability-call, and reported-cost budgets for every completed run. Lower
`RUN_QUEUE_MAX_PENDING` in a dedicated run to exercise 429 backpressure. Never point the
test at a tenant containing production work.

## Images and supply chain

`Dockerfile.platform` builds the single application image: one standalone JavaScript bundle
per entrypoint (the control API's includes the plan compiler), selected at run time by
`SERVICE_NAME`. The image contains Node, those bundles, the built web UI, migrations and
required static configuration; it does
not contain pnpm, TypeScript, `tsx`, workspace sources, or development dependencies, and
run as UID/GID 1001 with the Compose read-only/capability restrictions. The UI uses its
Next.js standalone output. Publish with BuildKit `--sbom=true --provenance=mode=max`, deploy
only `image@sha256:...` references, and retain the attestations with the registry artifact.
