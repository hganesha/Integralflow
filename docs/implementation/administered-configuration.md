# Administered platform configuration

## The problem

A deployment's model profiles lived in `config/model-profiles.json`, baked into every
image. Changing which model a tier resolves to, or where a provider is reached, meant
editing a file, rebuilding, and redeploying — and left no record of who changed what.
The same was true of a second class of value: operational knobs that existed as literals
in the services, some with an environment override and some without.

This document is the inventory of those values, the rule that decides where each one
belongs, and what was built.

## The rule

Three kinds of value, distinguished by their relationship to the plan trust root.

| Kind | Example | Where it belongs | Why |
| --- | --- | --- | --- |
| **Compiled** | A model profile document; `maxTransitions`; the pinned LGIR (`lgir-core`) rule revision | Immutable, digested into the plan | `harnessc` (`packages/compiler`) digests it. A plan records the digest, so changing it in place would make the plan's own record of what it was compiled against false. |
| **Bound** | A provider endpoint, a credential reference, provider status | Administered, mutable, not digested | Where a provider is reached is not what the plan was compiled against. Repointing it must not invalidate every admitted plan. |
| **Operational** | Lease duration, retry backoff, envelope TTL, evidence ceiling | Administered, mutable | No plan is compiled against it at all. |

A fourth kind — bootstrap identity and secrets — stays in the environment, because it
cannot live in the datastore it is needed to reach.

The consequence for a model profile is that **editing is not an update**. Saving mints a
new immutable revision with a new digest; the previous revision is marked superseded and
kept, because a plan that pinned its digest still has to resolve it.

## Inventory

### Now administered

| Value | Was | Now | Takes effect |
| --- | --- | --- | --- |
| Model profile `model`, `maxOutputTokens`, `timeoutMs`, `maxConcurrency`, `provider` | `config/model-profiles.json`, in the image | `harness_admin.model_profile_revisions`, revisioned by digest | New revision; resolved at compile and at invocation |
| Provider endpoint (`baseUrl`) | Implicit SDK default, not settable | `harness_admin.providers` | Next invocation |
| Provider credential *reference* | `OPENROUTER_API_KEY`, hardwired in the gateway | `providers.credentialRef` names the variable; the gateway resolves it | Next invocation |
| Provider attribution (`siteUrl`, `appName`) | `OPENROUTER_SITE_URL`, `OPENROUTER_APP_NAME` | Provider record, env still honoured | Next invocation |
| Provider availability | Not expressible | `providers.status` | Next invocation |
| Recorded-adapter fallback | `MODEL_RECORDED_FALLBACK`, read at boot | `gateway.recordedFallback` | Live, per invocation |
| Connector entitlement, jurisdiction coverage and list provenance (per tenant) | Not expressible | `gateway.connectorCoverage` (`CONNECTOR_COVERAGE_JSON`; lowest-precedence file `CONNECTOR_COVERAGE_PATH`) | Live, per skill-bound invocation |
| Execution envelope TTL | Literal `60`, `EXECUTION_ENVELOPE_TTL_SECONDS` read at boot | `envelope.ttlSeconds` | Live, per mint |
| New-draft budgets | Literal `{120000, 0.25, 2, 4}` in `authoring.ts` | `authoring.defaultBudgets` | Live, per draft creation |
| Agent runtime: default target, local endpoint, named runtime bindings | `RUNTIME_PROVIDER`, `RUNTIME_LOCAL_ENDPOINT`, `RUNTIME_BINDINGS_JSON` | `runtime` section (`provider`, `localEndpoint`, `bindings`) | Live, per claimed run |
| Runtime checkpoint backend | `RUNTIME_CHECKPOINT_BACKEND` | `runtime.checkpointBackend` | **Stored; read at runtime-host start** |
| Trace viewer deep link | `TRACE_VIEWER_BASE_URL`, read per request from env | `observability.traceViewerBaseUrl` | Live, per request |
| Trace export, sampling, resource attributes | `OTEL_*`, `DEPLOYMENT_ENVIRONMENT`, `CLOUD_REGION` | `observability` section | **Stored; read at each service's start** |
| Evidence artifact backend | `CASE_ARTIFACT_BACKEND` | `caseStore.artifactBackend` | **Stored; read at case-api start** |
| Connection pool sizing and timeouts | `DB_POOL_MAX`, `DB_*_TIMEOUT_MS` | `database` section | **Stored; read at each service's start** |
| Dispatcher poll, lease, concurrency, retry backoff | `WORKER_*`, literals `750 / 60 / 1 / 2000 / 60000` | `dispatcher` section | **Stored; read at dispatcher start** |
| Outbox drain and retention | `OUTBOX_*`, literals `5000 / 7` | `outbox` section | **Stored; read at case-api start** |
| Evidence ceiling and scan requirement | `CASE_EVIDENCE_*`, literals `1048576 / false` | `evidence` section | **Stored; read at case-api start** |

Restart-scoped values are stored and audited but still read once at process start, so the
control panel says so per field rather than implying a saved value is in force. Making the
dispatcher and the case API re-read their sections per poll is the natural follow-up and
needs no schema change.

### Why `appliesAt` is per field, not per section

`observability` decides it. Its trace viewer URL is re-read by the control plane on every
request, while the OTLP exporter beside it is constructed before the process can reach a
database at all. Labelling the section either way would be a lie about one of them. A
section whose fields disagree reports `mixed`, and each field states its own scope.

Each field also carries its type, options, help text, the environment variable it falls
back to, and which service reads it. That catalogue is the single source: the control
surface renders from it, and the environment fallback is computed from it, so a field
added in one place cannot silently lose its override in the other.

### Agent runtime and the plan's authority

A plan node may declare its own `runtimeTarget`. That still wins. The dispatcher applies
the administered binding first and the node's target last, so an administered default
never moves a node an author placed deliberately.

The dispatcher already rebuilt its provider per run, which is why this section is live
rather than restart-scoped: repointing a runtime binding reaches the next run. `ClaimedRun` carries its tenant for the same reason — a
dispatcher serves every tenant, and taking the binding from its own environment would give
one tenant another tenant's runtime.

The runtime section carries the binding only, never a credential: `RUNTIME_HOST_AUTH_TOKEN`
and the dispatcher's workload identity stay in the process environment, and a Databricks
binding names the variables that hold its client ID and secret. The dispatcher validates the
endpoint shape when it builds a provider; the schema additionally refuses a
half-configured `databricks_oauth_m2m` binding at save time, because an endpoint the
dispatcher cannot get a token for is one it cannot call. The former `runtime.foundry`
section was removed; migration `041_cloud_neutral.sql` dropped it from stored settings.

### Deliberately not administered

| Value | Where it stays | Why |
| --- | --- | --- |
| `maxTransitions`, engine kind, adapter version, execution profile | `harnessc` | Digested into the plan. Changing one is a compiler release. |
| Pinned LGIR (`lgir-core`) rule revision | `harnessc` | The trust root: the compiler implements that revision's rules. |
| Role→action table | `packages/identity/src/authorization.ts` | Authorization policy. A UI that could grant roles would let an administrator grant themselves anything; changing it should require review and a deploy. |
| Simulator fixtures | `packages/adapters` | Test doubles, not configuration. |
| Worker deadline padding (`lease + 30s`, `abort + 5s`) | `worker.ts` | Derived from the plan's own budgets. |
| `DATABASE_URL`, ports, case schema names, service tokens, signing keys, `RUNTIME_HOST_AUTH_TOKEN` | Environment | Bootstrap identity and secrets. Cannot live in the datastore they are needed to reach, and a schema name is needed to build the very queries that would read it. |
| OIDC issuer, audience, roles claim, allowed client IDs; workload identity issuer and `WORKLOAD_IDENTITIES` | Environment | Identity configuration decides who an administrator *is*. Administering it would be a privilege-escalation path. |
| `SECURITY_PROFILE` and the mechanism settings `IDENTITY_PROVIDER`, `WORKLOAD_AUTH`, `ENVELOPE_SIGNER`, `ENVELOPE_VERIFIER`, `DATABASE_AUTH`, `TELEMETRY_EXPORTER` | Environment, read at start | They decide how a service authenticates callers, obtains credentials, signs and verifies envelopes and reaches its database, before it can read the administered store, and an administrator who could lower the posture could disable the checks that bound administration. They are not in `PLATFORM_SETTING_FIELDS`. See README "Deployment settings". |
| The OpenRouter catalog probe URL in `/v1/openrouter/test` | `capability-gateway` | Still hardcoded. It probes one provider by name and should follow the provider record; noted as an open item. |

## Resolution order

Every administered value resolves newest-authority-first:

```
stored admin value  →  environment this process started with  →  built-in default
```

The built-in defaults are exactly the literals the services had before, so an empty admin
store reproduces today's behaviour. The resolved source travels with the value, and the
control panel shows it, so an operator can tell a stored value from one an environment
variable is still overriding.

Model profiles resolve differently, because a plan pins them:

```
revision whose digest the plan recorded  →  active revision  →  registry file in the image
```

The first branch is new behaviour that closes an existing gap: a plan already recorded
`modelProfiles[].digest`, and nothing verified it. Resolving by that digest means an edit
made after compilation cannot change what a run already in flight invokes.

## Schema

`harness_admin`, created by `packages/persistence/migrations/015_admin_control_plane.sql`, with
`016_admin_setting_sections.sql` widening the allowed sections:

- `providers` — one row per binding, keyed `(tenant_id, provider_id)`. Holds `kind`,
  `baseUrl`, `credentialRef`, attribution and status. **No credential value.**
- `model_profile_revisions` — append-mostly; keyed `(tenant_id, profile_id, revision)`,
  with a partial unique index allowing one `active` revision per profile. `definition`
  holds exactly the six-field document the compiler digests; `definition_digest` is that
  digest.
- `platform_settings` — one row per section per tenant.
- `change_log` — append-only. Every write lands here, with actor, roles, before/after
  documents, before/after digests and an optional reason, before the change is visible.

The migration seeds `providers` and `model_profile_revisions` from
`config/model-profiles.json` when the tenant has nothing. Seeding is additive, so
re-running migrations never reverts an administered change. The file stays in the
repository as that seed and as the offline fallback; it is no longer the authority.

### Under the production security profile

`SECURITY_PROFILE=production` narrows live administration to what cannot change a
deployment's trust boundary. The `runtime` and `observability` sections are reported as
deployment-managed and refuse writes (`admin.immutable_infrastructure_requires_deployment`);
a provider's kind, endpoint or credential reference and a profile's provider or model cannot
change (`admin.immutable_provider_binding_requires_deployment`,
`admin.model_deployment_change_requires_deployment`); `gateway.recordedFallback` cannot be set
to `allow` (`admin.recorded_fallback_forbidden_in_production`), and `platform_default` denies;
and every permitted write requires a reason. They follow the security posture, wherever the
services run.

## Credential handling

`credentialRef` is the **name** of an environment variable, constrained to
`^[A-Z][A-Z0-9_]{2,64}$` — a pasted key does not match and is rejected with a 400. The
capability gateway resolves that name against its own environment. The control plane, the
admin API and the browser never hold a provider credential, which is the same boundary the
gateway had before. An operator changes which credential is used by naming a different
variable.

## Authorization

Two new actions, `admin.read` and `admin.write`, and one new role, `Platform.Admin`.
`Platform.Auditor` gains `admin.read` — "what was this run actually configured to do" is
unanswerable without it.

Administration is deliberately **not** a superset of authoring, approval, operation or
case work, and none of those grant it: repointing a provider is a different authority from
publishing a plan or starting a run.

## Surfaces

Control API, all guarded on the actions above and tenant-scoped to the caller's assignment:

```
GET  /v1/admin/providers
PUT  /v1/admin/providers/:providerId
GET  /v1/admin/model-profiles                        # active revisions + full history
PUT  /v1/admin/model-profiles/:profileId             # 201 on a new revision, 200 when unchanged
POST /v1/admin/model-profiles/:profileId/activate    # roll back to a kept revision
GET  /v1/admin/settings                              # value + source + per-field descriptors
PUT  /v1/admin/settings/:section
GET  /v1/admin/change-log
```

Web UI: **Administration** (PLT-14) at `/platform/admin`, with tabs for Model profiles, Providers,
Platform settings and Change history. The gateway's `/v1/model-profiles` now answers from
the administered store and reports `source` so a file-derived profile is never presented as
an administered one.

Compilation goes through the administered store too: the control API materializes the
tenant's active revisions into the registry document it hands to `harnessc` (in-process).
Without that step an edit would change what an invocation resolves but not what a plan is
compiled against, and the two would drift apart silently.

## Open items

1. Make the dispatcher, the case API and the telemetry bootstrap re-read their sections,
   so `dispatcher`, `outbox`, `evidence`, `database` and the exporter half of
   `observability` become live rather than restart-scoped.
2. Point the gateway's provider probe at the provider record instead of the hardcoded
   OpenRouter catalog URL, so a repointed endpoint is what gets tested.
3. Decide whether a profile revision may ever be hard-deleted. Today nothing deletes one,
   which is what keeps a pinned plan resolvable; a retention policy needs to reckon with
   plans that outlive it.
4. `observability.traceViewerPublicUrl` is stored and audited, but nothing reads it from
   the control plane yet: the browser-facing trace link is the experience BFF's to compose
   (BUILD-SPEC v2 §5), and the BFF is still a scaffold. When it lands it should take the
   value from the control plane, which makes it live at the cost of a request per run view.
