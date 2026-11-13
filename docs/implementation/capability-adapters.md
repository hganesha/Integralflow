# Capability adapters

Status: implemented (gateway adapter module SPI; Databricks adapters; the allowlisted `http-operation` adapter; the `skills` skill-host adapter). Related:
[capability-naming.md](capability-naming.md), [agent-runtime-capability-gateway.md](agent-runtime-capability-gateway.md).

## Principle

Agent runtimes are pluggable, and so are capabilities. A vendor-native model, agent, index or
function (a Databricks Mosaic AI serving endpoint, a Databricks Vector Search index, a Unity
Catalog function, an OpenRouter or OpenAI-compatible model, an allowlisted operation of an
internal HTTP API) is a **capability**: a runtime asks the capability gateway
for it with `POST /v1/invoke` and never calls the vendor itself. The gateway alone holds the
credentials, verifies the execution envelope and the permission envelope, reserves budget,
writes the receipt and records cost and token usage. Adding a provider is adding adapter modules;
nothing in the runtime, the compiler or the plan format changes.

## Module SPI

`apps/capability-gateway/src/adapters/types.ts`:

```ts
type CapabilityAdapterModule = {
  id: string;                          // the <adapter> in <adapter>:<binding>
  cloud: "local" | "databricks" | "vendor" | "any";
  label: string;
  supportedKinds: ("model" | "tool" | "deterministic")[];
  enabledByDefault: boolean;           // true only when no cloud configuration is needed
  connectorTemplate?: { bindingPattern: RegExp; capabilityIds: string[]; configEnv: string[]; description: string };
  create(deps: { env; fetch; db; modelProfilesPath; workloadToken; delegate; sleep?; now? }): ExecutableAdapter;
};
```

`ExecutableAdapter` is unchanged (`descriptor`, `normalizeBinding?`, `acceptsBinding?`,
`invoke`) plus an optional `assertCapability(capability)` that refuses a contract the adapter
must not serve; it runs at registration (`POST /v1/capabilities` with `status: active`) and
at every invocation. The invocation context may carry `execution` (the verified node envelope,
its claims, the admitted plan, a traceparent and an abort signal); the gateway passes it only to
`skills:` bindings, the one adapter that acts on the caller's behalf beyond a single provider call. One module per file under `src/adapters/`; `src/adapters/index.ts`
holds the ordered `ADAPTER_MODULES` list. `deps.workloadToken` is the gateway's own service
credential (`GATEWAY_SERVICE_TOKEN` under `WORKLOAD_AUTH=static_token`, its projected
workload-identity token otherwise), the same one for every service it calls; `deps.delegate`
issues delegated skill envelopes in-process. Tests inject both. Provider wire code lives in
`@ehf/adapters` (`databricks.ts`, `http-operation.ts`, `skill-host.ts`, shared transport in
`cloud-http.ts`), so it is unit-testable with an injected `fetch` and has no gateway
dependencies.

### Enabling adapters

`GATEWAY_ADAPTERS` is a comma list of module IDs; the entry `default` stands for every
`enabledByDefault` module. Unset means the default set — `simulator, opensanctions, wiring,
evidence, pgvector, openrouter`. Examples:

```
GATEWAY_ADAPTERS=default,databricks-serving,databricks-vector
GATEWAY_ADAPTERS=default,http-operation,skills
```

An unknown ID fails gateway startup (`gateway.adapter_module_unknown: <id>`); a disabled
adapter's bindings are refused (`gateway.capability_adapter_unsupported`) exactly as an
unknown adapter's. An enabled adapter without configuration reports `credentialState:
"Missing"` and every invocation fails closed.

`GET /v1/adapters` returns `adapters` (the enabled adapters' descriptors, each with `cloud`
and `enabled: true`) and `modules` (every loadable module with `cloud`, `enabled`,
`enabledByDefault` and its connector template).

## Transport rules (every remote adapter)

- Injectable `fetch`; every request has an `AbortSignal.timeout` bound by the capability's
  `timeoutMs`; polling adapters bound the *whole* call, including polling, by it.
- `redirect: "error"` and any 3xx is refused (a redirect could carry a bearer token
  elsewhere). Endpoints must be `https` with no userinfo, query or fragment; the development profile alone
  accepts `http://localhost`/`127.0.0.1` (tests, emulators).
- Fail closed: transport errors, non-2xx, bodies over 8 MiB, non-JSON and unexpected shapes
  throw `adapter.<adapter>_<reason>` codes (`_http_<status>`, `_timeout`, `_unreachable`,
  `_redirect_refused`, `_response_invalid`, …). Nothing is fabricated; no response body,
  token or secret ever appears in an error, a result or a log line.
- Tokens are cached until 60 s before expiry with one shared in-flight refresh. A projected
  workload-identity token is re-read from its file as the platform rotates it.
- Model-shaped adapters use the same prompt rule as the OpenRouter adapter (`promptFor`: a
  context-plane prompt carrying `contextPackDigest` is sent as-is) and the same
  `parseModelOutput` (JSON, optionally fenced, else `{ text }`). Token usage is mapped into
  the receipt when the provider reports it; `costUsd` is `null` (no list price is assumed).
- Search results are returned as `{ matches: [{ id, score, fields }], instructionTrust:
  "UNTRUSTED_EXTERNAL" }`: retrieved text is data, never instructions, and the context plane
  must fence it as such.

## Databricks

One workspace connection per gateway, shared by the three modules (one cached token).

| Env | Meaning |
| --- | --- |
| `DATABRICKS_HOST` | Workspace URL; https on a Databricks-hosted domain for whichever cloud the workspace runs on |
| `DATABRICKS_AUTH` | `oauth_m2m` (the only mode) |
| `DATABRICKS_CLIENT_ID`, `DATABRICKS_CLIENT_SECRET` | Service principal for OAuth M2M |
| `DATABRICKS_WAREHOUSE_ID` | SQL warehouse for `databricks-uc` |
| `DATABRICKS_VECTOR_COLUMNS` | Columns `databricks-vector` returns; first is the match ID (default `id,text`) |
| `DATABRICKS_SERVING_MAX_OUTPUT_TOKENS` | `max_tokens` for chat endpoints (default 2048) |

**Auth.** OAuth M2M: `POST https://<host>/oidc/v1/token` with
`grant_type=client_credentials&scope=all-apis` and HTTP Basic client authentication. The
client secret is an `env:` or `file:` secret like any other.

**`databricks-serving:<endpoint>[:chat|:responses]`** (kinds `model`, `tool`) —
`POST /serving-endpoints/<endpoint>/invocations`. The binding suffix names the wire protocol,
so one gateway can serve both kinds of endpoint and the choice is pinned in the plan with the
binding: `chat` (default) sends the OpenAI-compatible `{ messages: [{ role: "user", content }],
max_tokens }` that foundation-model, external-model and custom chat endpoints accept;
`responses` sends the Mosaic AI ResponsesAgent `{ input: [{ role: "user", content }] }` that
an agent deployed with `agents.deploy` accepts, and reads the last assistant `message` item's
`output_text`. Usage: `prompt_tokens`/`completion_tokens` or `input_tokens`/`output_tokens`.

**`databricks-vector:<catalog.schema.index>`** (kind `tool`) —
`POST /api/2.0/vector-search/indexes/<name>/query` with `{ query_text, num_results, columns }`
(`num_results` from input `topK`, 1–50, default 5). Rows are mapped through the result
manifest; the trailing `score` column becomes `score`.

**`databricks-uc:<catalog.schema.function>`** (kinds `tool`, `deterministic`) — the function
name must match `^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$` and is quoted per
part; the statement is fixed as ``SELECT `c`.`s`.`f`(:p1, …, :pn) AS result``. Input
`arguments: [...]` (≤ 32) is bound **only** as named parameters (`STRING`, `BIGINT`,
`DOUBLE`, `BOOLEAN`; objects as JSON strings; `null` as typed NULL) — input is never
interpolated into SQL. `POST /api/2.0/sql/statements` (`wait_timeout` up to 50 s,
`on_wait_timeout: CONTINUE`, `INLINE`/`JSON_ARRAY`, `row_limit` 1000), then
`GET /api/2.0/sql/statements/<id>` until `SUCCEEDED`; `FAILED`/`CANCELED`/`CLOSED` fail with
the error code only; at the deadline the statement is cancelled (best effort) and the call
fails with `_timeout`. Returns `{ function, statementId, columns, rows, rowCount, truncated }`.
A table-valued function needs a separate binding shape (`SELECT * FROM fn(...)`) — not
implemented.

## Azure Foundry prompt agent (`foundry-agent`)

The Azure deployment enables this adapter with a reviewed project binding, a pinned prompt agent version,
a qualified Application Insights destination, and a dedicated gateway managed identity. The adapter
verifies the destination and agent version before sending a prompt. The first supported agent definition
uses the standard prompt harness and has no provider tools. The platform can use its existing gateway
tool capabilities for separate admitted steps.

Register the connector `foundry-agent:<agentName>` from its gateway template. Register
`foundry.agent.prompt.v1` as a paid model capability with `idempotent: false`, `maxAttempts: 1`,
a bounded timeout, input schema for `{ "prompt": string }`, and output schema for
`{ "text": string }`. Admit it through the existing plan, permission, budget and source-policy
workflow. The network source binding must cover the reviewed project endpoint. Configure only a
test prompt where the binding permits synthetic traffic.

The gateway sends W3C trace context to the pinned Responses endpoint and stores the native response ID
in a restricted correlation table, atomically with the gateway receipt. The deployed Azure reader uses
the receipt linkage and tenant trace authority to find native spans. A paid request that crosses the
provider boundary settles a replayable failure receipt if the outcome is unknown. Production
invocations require current deployment-owned content isolation verification. See the
[Azure observability design](azure-observability-design.md) for the content and trace access policy.

## Vector search (`pgvector`)

`pgvector:knowledge.search` (kind `tool`; enabled by default) searches the case store's
tenant-scoped `knowledge_chunks` (`CASE_DATABASE_URL`, `CASE_CORE_SCHEMA`) after embedding the
query with any OpenAI-compatible `/embeddings` endpoint. The administered provider binding named
by `EMBEDDING_PROVIDER` (default `embeddings`, kind `openai_compatible` or `openrouter`) is the
authority for the endpoint and credential; without one, `EMBEDDING_BASE_URL` and
`EMBEDDING_API_KEY` are the deployment-time fallback. `EMBEDDING_MODEL` defaults to
`text-embedding-3-small`.

## HTTP operations (`http-operation`)

`http-operation:<operation-id>` (kind `tool`; not enabled by default) realizes the
`integration.http.operation.v1` placeholder for an internal or partner HTTP API, behind any API
gateway (Kong, NGINX, Envoy, Apigee, a cloud API gateway) or none. Wire code:
`packages/adapters/src/http-operation.ts`.

| Env | Meaning |
| --- | --- |
| `HTTP_OPERATIONS_BASE_URL` | Base URL; a path is allowed (`https://api.internal/core`) |
| `HTTP_OPERATIONS_JSON` | The allowlist: `{"getCustomer":{"method":"GET","path":"/customers/{customerId}"}}` |
| `HTTP_OPERATIONS_AUTH` | `workload_identity` (default: the gateway's own service credential as a bearer) or `api_key` |
| `HTTP_OPERATIONS_API_KEY_HEADER`, `HTTP_OPERATIONS_API_KEY` | A static key header (default `x-api-key`), sent in addition to the workload token; alone (`api_key`) only under the development profile (`gateway.http_operations_api_key_only_forbidden`) |

Only allowlisted operations are accepted, advertised as binding options and callable. Input
`{ pathParams, query, body }`: path parameters are percent-encoded, `.`/`..` and missing values
are refused, query values must be primitives, a body is sent only for POST/PUT/PATCH. A non-GET
operation requires a capability effect other than `none`/`read`. The response must be JSON; it
is returned as `{ operationId, status, body }`.

## Skill host (`skills`)

`skills:<skill_id>` (kinds `tool`, `deterministic`, `model`; effect never `external` or
`destructive`; not enabled by default: `GATEWAY_ADAPTERS=default,skills`) runs one business skill
on a skill host over skill.execution.v1. Normative protocol and design:
[skill-library-integration-contract.md](skill-library-integration-contract.md) (§15 lists what is
implemented). Wire code: `packages/adapters/src/skill-host.ts`; module:
`apps/capability-gateway/src/adapters/skills.ts`.

| Env | Meaning |
| --- | --- |
| `SKILL_HOST_URL` | The host's base URL (https; plain http only under the development profile) |
| `SKILL_HOST_AUTH` | `platform_token` (default: the gateway's own service credential — `GATEWAY_SERVICE_TOKEN` locally, its workload-identity token in production; the host verifies it, locally as `SKILL_HOST_AUTH_TOKEN`) or `databricks_app` (the gateway's `DATABRICKS_*` workspace identity, for a host deployed as a Databricks App) |
| `SKILL_HOST_GATEWAY_URL` | The gateway URL the host calls back for dependency capabilities |
| `DELEGATED_ENVELOPE_PRIVATE_KEY_FILE`, `DELEGATED_ENVELOPE_KEY_ID` | Under `ENVELOPE_SIGNER=private_key`: the gateway's own key for delegated envelopes, which only it verifies |
| `SKILL_HOST_GATEWAY_TOKEN` | Local only: the bearer the host presents to the gateway (role `Skill.Host`); in production the host's workload identity maps to `skill-host` |
| `SKILL_BUNDLE_CACHE_SECONDS` | Bundle-lock cache, at most 60 s (default 60) |

Per invocation the adapter: reads the node's pinned binding from the admitted plan
(`skillBindings[].semver`, `manifestDigest`, `bundleDigest`; the binding name must be the node's
skill and the capability one of its candidates) and the manifest from the business-skill registry
(digest must match); validates the capability input (`skillCapabilityInputV1Schema`: SkillInput.v1
plus the assembled context, for the envelope's tenant and case) and the parameters against the
manifest's input schema; checks `GET /v1/bundle` (cached ≤ 60 s): same `bundle_digest` as the
plan, an approved, unrevoked `skill-bundle` registry entry whose reference names exactly this
lock, the pinned skill/version/manifest digest present with the manifest's effect mode; issues a
delegated envelope in-process (`issueDelegatedEnvelope` from `@ehf/execution-auth`, after
re-checking the run, fence, release, work lease, node permission and pinned skill manifest),
narrowed to the declared dependencies the node may call; sends
`POST /v1/skills/{skill_id}/executions` with `Idempotency-Key` = the gateway invocation id and the
gateway span's `traceparent`; polls a 202 (`GET /v1/skills/executions/{id}`) until a terminal
lifecycle or the capability's `timeoutMs`, cancelling the execution at the deadline or when the
caller disconnects; treats a status 404 as unknown (`adapter.skills_execution_unknown`, never a
result); and validates the response: schema, `execution_id`, payload against the manifest's output
schema, effect-mode rules (§6.3), and evidence that cites either a section digest of this request
or a gateway receipt of this execution's delegated calls. Errors follow §10 and are named so the
runtime's §4.3 mapping reads them (`…_denied` ACCESS_DENIED, `…_integrity_…` INTEGRITY_FAILURE,
`…_timeout`, `…_429…` RATE_LIMITED, `…_unavailable` SOURCE_UNAVAILABLE, `…_invalid` INPUT_INVALID).

The result's `output` is `SkillCapabilityOutput.v1` (the host response plus the pins and the
dependency receipt digests); `provider` is `skill-host:<bundle_id>`, `model` is
`<skill_id>@<semver>`, `providerRequestId` the execution id.

The gateway also accepts **delegated envelopes** on `/v1/invoke`, from a `Skill.Host` caller only,
for invocation ids `<execution_id>:<key>`, within the narrowed capability list, and never for a
`skills:` capability. Locally, `docker compose --profile skills up` adds the reference host
(`apps/skill-host-reference`); `packages/skill-conformance` is the host conformance suite.

## System 1 decisions (`decisions`)

`decisions:<binding id>` (kind `model`; not enabled by default: `GATEWAY_ADAPTERS=default,decisions`) asks a pinned
System 1 decision model bounded multiple-choice questions (`decision.system1.v1`; document factory plan §6.5–6.6).
Bindings are listed in `config/decision-bindings.json`. Each one pins:

- the adapter, the model and the model revision the provider must report;
- the question set (`document.advisory.v1` serves `decision.document.advisory.v1`);
- the timeout and the maximum number of questions;
- for Foundry, the variable that holds the resource and the deployment type, which decides where data is processed.

Because the adapter is off by default, the catalog publishes a connector template, not connectors. An operator
registers `decisions:<binding id>` for the bindings a deployment uses (see [Registering a connector](#registering-a-connector)).
Switching provider means choosing another binding's connector in the plan. No skill, question set or plan source
changes. Wire code: `packages/adapters/src/decision-system1.ts`; module: `apps/capability-gateway/src/adapters/decisions.ts`.

| Adapter | Transport | Distribution |
| --- | --- | --- |
| `openrouter_decisions` | `POST https://openrouter.ai/api/alpha/decisions` (alpha) | Native, per question |
| `foundry_openai` | `<resource>/openai/v1/chat/completions`, strict JSON schema of single-letter option codes | From token log-probabilities of the code token, only when the deployment returns them; otherwise null |
| `foundry_anthropic` | `<resource>/anthropic/v1/messages`, forced tool call | None (null) |

| Env | Meaning |
| --- | --- |
| `DECISION_BINDINGS_PATH` | The bindings file (default `config/decision-bindings.json`) |
| `OPENROUTER_API_KEY` | OpenRouter Decisions bindings |
| `DECISION_FOUNDRY_ENDPOINT` | The Foundry resource origin `https://<resource>.services.ai.azure.com`; other hosts are refused before any credential is sent |
| `DECISION_FOUNDRY_AUTH` | `managed_identity` (default; audience `https://cognitiveservices.azure.com`) or `key` |
| `DECISION_FOUNDRY_KEY_ENV` | With `key`: the variable holding the resource key (default `DECISION_FOUNDRY_KEY`) |

Every answer passes one validator (`validateSystem1Answers` in `@ehf/contracts/intelligence-adapters`). It refuses
model substitution, a missing or unknown question, an undeclared option and a distribution that doesn't cover the
options, sum to 1 or favour the chosen option. Every fault becomes an abstention with its reason, and an abstention
changes nothing. The same applies to refusals, content filters, 429s and outages, which are all `unavailable`. A
`cannot_tell` answer abstains for that question only. An adapter never synthesizes a distribution and never retries
until the model agrees. Responses are capped at 256 KB. `decision-system1.conformance.test.ts` runs the same fixtures
against every adapter. An adapter is `implemented` in the switchboard only while it passes them.

## Document extraction models (`document-model`)

`document-model:azure_document_intelligence` is the default connector for `document.model.extract.v1`, the skill
library's `document.model`, which is Route A of the adjudicated document extraction (document factory plan Phase 4).
It is registered by default and reports `Missing` until `DOCUMENT_MODEL_PROVIDER` and
`DOCUMENT_MODEL_REMOTE_ALLOWED=true` are set.

- **Input.** The connector reads exactly one original: the one the calling run was started with. The gateway takes it
  from the run's own input, and only for an admitted adjudicated document pipeline (`documentOfRun`). The bytes must
  hash to the run's document version, and the request's `artifact_hash` must match it. Any other call is refused with
  `gateway.document_model_source_denied` or `gateway.document_model_plan_denied`.
- **Model.** The release in effect in `DOCUMENT_MODEL_RELEASE_ENVIRONMENT` (the Document Factory registry, read-only)
  chooses the model for the type: custom, composed or prebuilt. Otherwise the type's prebuilt route is used. A type
  with neither is refused (`adapter.document_model_route_unsupported`), and the skill records the route as not run.
- **Output and cost.** Field candidates in `document.model_fields.v1`, which the library anchors and adjudicates.
  Nothing is promoted. Cost is estimated per page at the Factory's analysis prices.

## Registering a connector

Bindings for these adapters are deployment-specific, so `config/connector-catalog.json`
lists **connector templates** (`connectorTemplates`: `adapterId`, `cloud`, `bindingPattern`,
`capabilityIds`, `configEnv`, `description`) rather than connectors. Template → canonical
capability:

| Capability | Templates |
| --- | --- |
| `model.general.inference.v1` | `databricks-serving` |
| `knowledge.vector.search.v1` | `databricks-vector` (the built-in `pgvector:knowledge.search` serves it too) |
| `function.uc.invoke.v1` | `databricks-uc` |
| `integration.http.operation.v1` | `http-operation` |
| `skill.business.execute.v1` | `skills` |
| `decision.document.advisory.v1` | `decisions` |

`integration.apim.operation.v1` is deprecated in favour of `integration.http.operation.v1`
(migration `041_cloud_neutral.sql`); connectors of the removed `azure-openai`,
`foundry-agent`, `azure-search` and `apim` adapters were deleted by the same migration.

An operator registers a concrete connector:

```http
POST /v1/connectors
{ "adapterId": "databricks-serving", "binding": "kyc-llm:responses",
  "capabilityId": "model.general.inference.v1", "status": "available" }
```

Authority is the same as `POST /v1/capabilities` (`capability.register`, or `admin.write` when
`AUTHORING_MODE=disabled`). The gateway refuses an unknown template (400
`gateway.connector_template_unknown`), a binding outside the pattern or not accepted by the
adapter (400 `gateway.connector_binding_mismatch`; for `http-operation`, an operation not in
the allowlist), a capability the template does not serve (400
`gateway.connector_capability_unsupported`) and an adapter not enabled here (409
`gateway.connector_adapter_disabled`). The connector is persisted with
`upsertCapabilityConnector` (`harness_gateway.connector_registry`), which never lifts an
operator's `quarantined`/`retired`. A release then binds it by setting a capability's
`adapterBindingId` to the connector ID (`databricks-serving:kyc-llm:responses`).

`scripts/sync-connector-catalog.mjs` mirrors the module templates; the gateway test
`cloud-adapters.test.ts` fails if they drift.

## Follow-up

- **Deployment** (the repository carries no infrastructure code). Give the gateway
  `GATEWAY_ADAPTERS` and the per-adapter endpoint variables, mount secrets such as
  `DATABRICKS_CLIENT_SECRET` or `HTTP_OPERATIONS_API_KEY` from the secret manager, map the
  gateway's workload identity at each HTTP API it calls, and add the Databricks service
  principal to the workspace with the UC/serving/vector grants it needs. The egress allowlist
  must cover the configured hosts.
- Per-connection configuration (several Databricks workspaces or HTTP APIs per gateway)
  would need connection-scoped env prefixes; today there is one connection per adapter.
- Cost: providers do not return prices; `costUsd` stays `null` and budgets count calls and
  tokens until a price table is administered.
- Databricks adapters are not exercised against live services; the request/response shapes follow the providers'
  public REST documentation (see the assumptions recorded in the delivering change).
