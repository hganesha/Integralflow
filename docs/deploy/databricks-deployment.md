# Databricks-native deployment: topology and constraints

A first-pass architecture for running the harness stamp on Databricks, on whichever cloud the
workspace runs (AWS, Azure or GCP). It is written against the reference deployment the
README describes: the same images on any Kubernetes cluster or container platform, with
OIDC, workload identity, mounted keys, `env:`/`file:` secrets and OTLP.

Scope is infrastructure only: where each process runs, where each byte lands, which
cloud services remain underneath the workspace, and what in *this* codebase blocks it.
It is a summary for a go/no-go conversation, not a runbook. Everything marked
**(verify)** is a Databricks platform detail that moves faster than this
document — confirm against current docs before planning against it.

---

## 1. The reference deployment

One application image (`Dockerfile.platform`), run once per service with its `SERVICE_NAME`, each with its own workload
identity (README "Service identity"):

| Workload | Shape in the reference deployment |
| --- | --- |
| migrate | run-once job, runs both migrators |
| `control-api` | internal :4100, plan admission, envelope broker, compiles plans in-process (`@ehf/compiler`) |
| `case-api` | internal :4102, case aggregate + ledger + evidence, outbox relay |
| `capability-gateway` | internal :4101, sole holder of provider credentials, writes receipts, issues delegated skill envelopes |
| `runtime-host` | internal :8088, LangGraph executor (`hosted_http`), checkpoints to PG or memory |
| `runtime-dispatcher` | no ingress, leases + fencing epochs, `LISTEN` + bounded poll, scaled on queue depth |
| `integration-worker` | no ingress, governed outbound integrations, `LISTEN` + bounded poll |
| OTLP collector | trace sink and router (Jaeger locally) |
| `experience-bff` + web | the only external ingress |

Everything is TypeScript on Node 24, including the plan compiler (`harnessc`,
`packages/compiler`, run in-process by `control-api`), except one binary baked into
the image: `opa` 1.9.0 (invoked as a CLI by `packages/policy-engine`). Secrets are
`env:` or `file:` references mounted by the deployment's secret manager; signing keys are
files.

---

## 2. Target topology

```text
                 Identity provider (any OIDC IdP; SCIM -> Databricks account)
                             |
                        Databricks OAuth (mandatory in front of every App URL)
                             |
  +--------------------------+-------------------------------------------+
  |              Databricks workspace (any cloud, one region)             |
  |                                                                       |
  |  Databricks Apps (serverless, HTTPS ingress, per-app service principal)|
  |    app: control-surface        <- web SPA + BFF, the only user app     |
  |    app: control-plane-api      <- control-api + case-api + gateway     |
  |                                   (merged; see 4.2)                    |
  |    app: runtime-host           <- LangGraph executor (`databricks`)    |
  |                                                                       |
  |  Lakeflow / Jobs (serverless or classic)                              |
  |    job: dispatcher             <- continuous, leases + fencing        |
  |    job: migrate                <- run-once on deploy, direct session  |
  |    job: plan compile           <- if plan compilation leaves the API   |
  |                                                                       |
  |  Lakebase (managed Postgres, OLTP system of record)                   |
  |    schemas: workflow, harness_control, case_core, case_ledger, evidence|
  |    RLS on tenant_id, advisory xact locks, outbox                      |
  |       |  CDC / synced tables                                          |
  |       v                                                               |
  |  Unity Catalog                                                        |
  |    Delta: case_events, run journal, gateway receipts, audit exports    |
  |    Volumes: evidence artifacts (bytes)                                |
  |    Connections: OpenSanctions (HTTP), credential vending              |
  |    System tables: audit, billing, lineage, serving payloads           |
  |                                                                       |
  |  Mosaic AI Gateway + Model Serving                                     |
  |    external model endpoints (provider keys, rate limits, fallbacks)    |
  |    inference tables -> Delta (payload log alongside gateway receipts)  |
  +-----------------------------------------------------------------------+
            |                    |                        |
   Cloud object storage     KMS / secret store       OTLP collector
   (UC managed +            (CMK, secret-scope       (optional; spans
    external locations,      backing, signing         from app code)
    WORM)                    keys)
```

---

## 3. Component mapping

| Reference deployment | Databricks-native | Notes |
| --- | --- | --- |
| Cluster-internal service networking | Databricks Apps | No private service-to-service mesh; see 5.1 |
| BFF + web behind ingress | App with HTTPS ingress | Databricks OAuth is mandatory and non-bypassable |
| Dispatcher deployment (no ingress) | Job (continuous) or an App that binds a health port | See 5.4 |
| Migrate job | Job task, run-once, gated before app deploy | Needs a *session-mode* connection (5.2) |
| PostgreSQL | **Lakebase** | Postgres-compatible OLTP, OAuth auth, scale-to-zero |
| `evidence.artifacts.content bytea` | **UC Volume** + digest row in Lakebase | `artifacts.backend`/`artifact_ref` already abstract this |
| Audit exports, ledger analytics | **Delta tables in UC**, fed by Lakebase CDC | Time travel replaces bespoke export tables |
| OCI registry + images | Source-based app bundles + DABs | The registry survives only if you keep custom containers (5.5) |
| One workload identity per service | App service principals + job run-as SPs | Per-workload identity is preserved |
| `env:`/`file:` secrets from a secret manager | Databricks secret scopes | The cloud's secret store can back the scopes |
| Model credential in gateway | **Mosaic AI Gateway** external model endpoint | Key never reaches app code |
| OpenSanctions API key | **UC Connection** (HTTP) with credential vending | Governed + audited in UC |
| OTLP collector + trace backend | MLflow Tracing and/or OTLP to an existing collector | No sidecars; see 5.6 |
| Log backend | UC system tables + app logs | |
| IaC for the cluster | DABs/Terraform (Databricks) + Terraform for the cloud substrate | Hybrid, not a replacement |
| CI OIDC federation | CI OIDC -> Databricks SP federation **(verify)** | Same "no client secret in repo" property |

---

## 4. Placement decisions

### 4.1 Lakebase as the system of record

Keep it. The persistence layer is not incidentally Postgres — it is Postgres on
purpose: `pg_advisory_xact_lock` for idempotency (`case-store/src/index.ts`,
`persistence/src/index.ts`), RLS with `current_setting('app.tenant_id')` forced on
every tenant table (migrations 009–013), `SKIP LOCKED` lease claims, a
transactional outbox, and `pg_notify` as a latency optimization over a bounded
poll. Delta cannot serve any of that: it is not an OLTP store, it has no row
locks, no RLS-per-session, no sub-second single-row idempotent upsert.

So: Lakebase holds the live case aggregate, ledger, run journal, leases, and
receipts. Delta holds the analytical and archival copy, fed by CDC. The
`evidence.artifacts` row stays in Lakebase; the bytes move to a Volume.

### 4.2 Merge the three control-plane services into one App

`control-api`, `case-api`, and `capability-gateway` call each other over
cluster-internal URLs in the reference deployment. On Databricks Apps there is no
internal DNS and no private mesh: every cross-app call is a public HTTPS call that must
carry an OAuth token for the target app. Three apps therefore means three OAuth
round trips per hop and three public surfaces for services that were deliberately
internal-only. The removed hops (no wake calls, no integration-authority read, delegated
envelopes issued in the gateway) already cut the cross-service calls to those that carry
authority.

Recommended: one `control-plane-api` App mounting all three routers, keeping the
package boundaries intact so the split can come back when Databricks ships
private app-to-app networking. This is the single largest architectural
concession in the move, and it weakens one real property: the capability gateway
is currently the *sole* holder of provider credentials, enforced by process
isolation. Merging makes that a module boundary, not a process boundary — unless
the credential leaves the app entirely, which is exactly what Mosaic AI Gateway
does (4.4).

### 4.3 Runtime host: App, or Model Serving?

Two options, with a sharp fork:

- **App** — already supported. The `databricks` runtime adapter dispatches to the
  runtime-host image deployed as a Databricks App (`RUNTIME_HOST_MODE=databricks_app`,
  `RUNTIME_HOST_DATABRICKS_PRINCIPALS`), with the dispatcher authenticating by OAuth M2M
  ([runtime adapters](../implementation/runtime-adapters.md)). Checkpoints go to Lakebase,
  or `RUNTIME_CHECKPOINT_BACKEND=memory` removes the last data credential.
- **Mosaic AI Model Serving agent endpoint** — an immutable, versioned, separately
  governed execution surface invoked with a workload token, with payloads logged to
  inference tables. But serving endpoints run **Python** (MLflow `pyfunc` /
  agent framework). The runtime is TypeScript. This is a rewrite, not a
  repackage.

Start with the App. A serving-endpoint runtime would be one more adapter registered with
`registerRuntimeAdapter` and must pass the same [runtime conformance](../implementation/runtime-conformance.md).

### 4.4 Capability gateway and Mosaic AI Gateway

Split the gateway's two jobs:

- **Model calls** → Mosaic AI Gateway external model endpoints, reached through the
  gateway's `databricks-serving` adapter. The provider key lives in the endpoint config,
  not in the app; rate limits, fallbacks, guardrails, and usage tracking come free;
  inference tables give a payload log in Delta. `config/model-profiles.json` maps to
  endpoint names instead of provider model IDs.
- **Everything else** (OpenSanctions, `http-operation` bindings, receipts, envelope
  verification, policy-governed admission) stays in the harness gateway code.
  The API key moves to a UC Connection so the credential is vended and audited
  rather than injected.

The receipt semantics — `receiptDigest`, replay detection, write-before-effect
ordering in `apps/capability-gateway/src/app.ts` — have no Databricks equivalent
and must stay in the harness. Inference tables are a parallel record, not a
substitute.

### 4.5 Evidence in UC Volumes

`evidence.artifacts` already carries `backend`, `artifact_ref`, `byte_length`,
`encryption_metadata`, and `immutability_state`, with `content bytea` nullable —
the abstraction for a non-Postgres backend is in place; only `postgres` is implemented
(`CASE_ARTIFACT_BACKEND`). A `uc_volume` backend writes to
`/Volumes/<catalog>/evidence/<volume>/<tenant>/<digest>` and stores the path as
`artifact_ref`. UC gives lineage, access audit in system tables, and credential
vending, and `CASE_EVIDENCE_MAX_BYTES=1048576` (a limit that exists because the bytes
are in a database row) stops being necessary.

Two things do *not* come with it, and both matter for evidence:

- **WORM / legal hold.** UC has no per-object immutability. Real
  `immutability_state` enforcement needs an *external* volume on a cloud bucket or
  container with the provider's object lock / immutability policy. Managed volumes
  cannot do this.
- **Malware scanning.** `CASE_EVIDENCE_REQUIRE_SCAN` has no Databricks-native
  implementation. The cloud provider's storage malware scanning works on storage you
  control — i.e. again, an external location.

---

## 5. Constraints

Ordered by how likely each is to change the plan.

### 5.1 No private app-to-app networking — **hard**
Cluster-internal service networking with mutual TLS has no Apps equivalent. Every app
URL is public and fronted by OAuth. Drives the merge in 4.2, and removes an
internal-only deployment as an option.

### 5.2 Lakebase connection semantics — **hard, and already half-documented**
`deploy/performance.md` already says the dispatcher's `LISTEN` connection must
be direct/session-mode and that pooled connections must be budgeted against
`max_connections`. On Lakebase the same rules apply with different numbers:

- Session-scoped things need a **direct** endpoint: `pg_advisory_lock` in both
  `migrate.ts` files (session-level, not `_xact_`), and `LISTEN`.
- Transaction-scoped things are pooler-safe: `pg_advisory_xact_lock`,
  `set_config(..., true)`, `SET LOCAL` — which is what the RLS tenant context
  uses, so RLS survives pooling.
- **Scale-to-zero breaks `NOTIFY` delivery and adds cold-start latency.** The
  code already treats `LISTEN` as an optimization behind a bounded poll
  (`persistence/src/index.ts`), so this degrades rather than fails — but the
  dispatcher's poll interval becomes the real latency floor. Consider pinning
  the instance to no-scale-to-zero for the POC.
- Re-verify the pooled connection budget against Lakebase capacity-unit limits.

### 5.3 Auth token expiry vs. a static `DATABASE_URL` — **hard**
Lakebase authenticates with short-lived Databricks OAuth tokens (~1h). Every
service builds a `pg` pool from a connection URL, and `DATABASE_AUTH` has one mechanism,
`url` (a password-free URL with `PGPASSFILE` or a TLS client certificate). A static token
in the URL is wrong twice: it expires, and it defeats per-identity roles. Lakebase needs
a new `DATABASE_AUTH` mechanism whose pool asks a Databricks token source for each new
connection's password.

Silver lining: Lakebase maps Databricks service principals to Postgres roles,
so per-identity database roles are directly achievable, and `SECURITY_PROFILE=production`'s
"no password-bearing database URL" invariant stays satisfiable.

### 5.4 The always-on dispatcher — **medium**
It is a poller with leases, fencing epochs, bounded retry, and no ingress. In the reference
deployment a queue-depth autoscaler (KEDA) scales it. Two placements:

- **Continuous Job** — the right semantic fit (restart-on-failure, run-as SP, no
  ingress). But job task types are notebook/Python/JAR/SQL/dbt; a Node process
  needs a thin Python wrapper that `exec`s it, or a classic cluster with a
  custom container. **(verify** whether a first-class Node task type exists.**)**
- **App** — works today if the worker binds `$DATABRICKS_APP_PORT` for the health
  check; `WORKER_METRICS_PORT=9090` is nearly that already. But Apps are a web
  surface with no documented liveness guarantee for background loops.

At-least-once restarts are safe either way: leases and fencing epochs already
assume it. The integration worker has the same shape and the same options.

### 5.5 One native binary in the hot path — **medium**
The plan compiler runs in-process in `control-api` (TypeScript, `packages/compiler`),
but `packages/policy-engine` shells out to `opa`. Databricks Apps build from source
with no Docker image and no `apt`; a static binary can be shipped in the bundle
and executed from `/tmp` or the app directory, but it is unsupported territory.

Cleanest: build `opa` into a UC Volume artifact or a workspace file and have the
app fetch-and-exec it at startup, or move policy evaluation in-process (Rego/WASM).
If neither is acceptable, keep an OCI registry and use custom containers on classic compute
for the affected workloads — at which point the "Databricks-native" claim gets
narrower.

### 5.6 No Jaeger, no sidecars — **medium**
`packages/telemetry` exports the harness span hierarchy over OTLP
(`TELEMETRY_EXPORTER=otlp`), and the UI links to a trace viewer
(`TRACE_VIEWER_BASE_URL`). Options:

- Keep OTLP and point it at a collector the workspace can reach (egress allowed) —
  smallest change; the collector routes to whatever backend the organisation runs.
- **MLflow Tracing** — native, agent-shaped, gives a trace UI in the workspace.
  Requires mapping the harness span model onto MLflow spans.
- System tables for audit/lineage/serving payloads cover the *governance* half
  of observability but not the per-run trace tree.

### 5.7 Identity plumbing — **medium**
Any OIDC IdP federated to the Databricks account remains the source of people, and
Databricks OAuth in front of every App gives real user identity with no local-autologin
fiction. But:

- Platform roles (`Harness.Author`, `Harness.Approver`, …) are not automatically in the
  token an App receives. Either validate the IdP's own token in-app
  (`IDENTITY_PROVIDER=oidc` with `OIDC_ROLES_CLAIM`), or carry roles as Databricks groups
  and map them in `packages/identity`. Groups are the lower-friction path; the
  separation-of-duties demo (author ≠ approver) works either way.
- **Service identity.** Each App's service principal can be a service's identity, but
  `WORKLOAD_AUTH=workload_identity` expects a token file and an issuer with JWKS; whether
  Databricks OAuth tokens fit that shape (stable subject per SP, verifiable issuer) is
  **(verify)**. The gateway already reaches skill hosts (`SKILL_HOST_AUTH=databricks_app`)
  and the dispatcher reaches the runtime (`databricks` adapter) with OAuth M2M.
- **Signing keys.** `ENVELOPE_SIGNER=private_key` reads each signer's
  `<KIND>_PRIVATE_KEY_FILE`. Secret scopes surface values as environment variables, so an
  App must write the key to a file at startup, or the signer needs a secret-scope or KMS
  adapter with the same shape **(verify)**. Falling back to `hmac` is development-only.

### 5.8 Smaller ones
- **No custom domain on Apps** and nothing can sit in front without breaking
  OAuth — no API gateway or CDN for the control surface.
- **Fixed app sizing** (**verify** current: ~2 vCPU / 6 GB, limited replicas).
  Replica ranges and KEDA scaling have no direct equivalent.
- **No persistent local disk** between restarts. Plan compilation needs no disk
  (it runs in memory); anything assuming disk is not fine.
- **Workspace-region residency.** Lakebase, Volumes, and Apps are all in the
  workspace region, so the `residency` tag stays honest — but check Lakebase
  regional availability before picking the region.
- **Quotas**: apps per workspace, Lakebase instances per workspace, concurrent
  job runs. All small numbers; check before designing per-tenant isolation.

---

## 6. Cloud services still required underneath the workspace

| Service | Still needed? | Why |
| --- | --- | --- |
| **Identity provider** | **Yes** | Account users and groups (SCIM), conditional access, and the OIDC tokens if roles are validated in-app |
| **Cloud object storage** | **Yes** | UC metastore root, managed catalog storage, and external locations. "Managed by Databricks" means governed by UC — the storage is still yours, still where WORM/CMK/lifecycle/scanning are configured |
| **KMS / secret store** | **Yes, reduced** | CMK for workspace and managed services, backing for secret scopes, and the source of mounted signing keys |
| **Storage access identity** | Yes | UC's identity onto storage (the cloud's storage credential for the metastore) |
| **Private networking / egress control** | Depends | Private front-end access to the workspace, private endpoints to storage, and serverless egress control. A public-workspace POC can skip it; a regulated deployment cannot |
| **OTLP collector and trace backend** | Optional | Only if you keep OTLP rather than MLflow Tracing (5.6) |
| **Storage malware scanning** | If scanning is real | `CASE_EVIDENCE_REQUIRE_SCAN` has no native equivalent |
| **OCI registry** | Only as a fallback | Needed if 5.5 forces custom containers on classic compute |
| **Container platform, standalone PostgreSQL** | **No** | Replaced by Apps, Jobs and Lakebase |

Net: identity and storage are structural, KMS shrinks to keys-and-CMK, networking is a
compliance decision, and the compute/database layer goes away.

---

## 7. What actually gets better

Not a wash — three properties improve:

1. **Per-identity database roles become reachable.** Lakebase SP-to-role mapping
   gives every service its own Postgres role without managing client certificates.
2. **Evidence gets governance for free.** Volumes + lineage + access audit in
   system tables is more than a plain object-store adapter would deliver, and it
   removes the 1 MB row-size ceiling.
3. **The model credential can leave the codebase entirely.** Mosaic AI Gateway
   makes "no service holds a provider key" structural rather than conventional,
   and inference tables give a second, independent payload record next to the
   gateway's own receipts.

Against that: one fewer process boundary around the gateway (4.2), no private
mesh (5.1), and the native-binary problem (5.5).

---

## 8. Work items

In dependency order:

| ID | Item | Blocks |
| --- | --- | --- |
| `DBX-001` | Lakebase `DATABASE_AUTH` mechanism: OAuth token source, refresh, direct vs. pooled endpoint selection | everything |
| `DBX-002` | Per-SP Postgres roles + grant table; retire the shared admin credential | `SECURITY_PROFILE=production` |
| `DBX-003` | Merge control-api/case-api/gateway into one App bundle, routers intact | app deploy |
| `DBX-004` | `uc_volume` artifact backend behind the existing `backend`/`artifact_ref` seam | evidence |
| `DBX-005` | Dispatcher and integration worker as continuous Jobs (or Apps with a health port); confirm lease/fencing behaviour under restart | execution |
| `DBX-006` | `opa` distribution: CI build → Volume artifact → fetch-and-exec, or in-process policy evaluation | control-api |
| `DBX-007` | Identity adapter: Databricks OAuth principal + group-to-role mapping in `packages/identity`; decide whether Databricks tokens serve as workload identity | authz |
| `DBX-008` | Mosaic AI Gateway endpoints; `model-profiles.json` maps to endpoint names | gateway |
| `DBX-009` | Tracing: MLflow Tracing adapter or OTLP to an existing collector, plus `TRACE_VIEWER_BASE_URL` | observability |
| `DBX-010` | Lakebase → Delta CDC for ledger/receipts/audit exports | audit |
| `DBX-011` | Envelope signing: provide each signer's private key as a file (or a secret-scope signer adapter) for `ENVELOPE_SIGNER=private_key` | production signing |
| `DBX-012` | DABs for apps/jobs + Terraform for Lakebase/UC and the cloud substrate; CI OIDC → Databricks SP | delivery |
| `DBX-013` | Optional: LangGraph runtime as a Model Serving agent endpoint (Python rewrite) as another runtime adapter | — |

`DBX-001` and `DBX-006` are the two that decide whether this is a port or a
rewrite. Both are worth spiking before committing.

---

## 9. Open questions

- Does Databricks Apps have a first-class Node.js runtime, and what are the
  current CPU/memory/replica limits?
- Is there any supported path for app-to-app private networking, or a custom
  container option for Apps?
- Lakebase: pooler mode defaults, connection ceilings per capacity unit, and
  whether `NOTIFY` survives a scale-to-zero cycle.
- Can an App's service-principal OAuth token be verified like a workload-identity token
  (issuer, JWKS, stable subject), and can a secret-scope value be mounted as a file?
- Job task types: is there a supported way to run a long-lived Node process on
  serverless compute?
