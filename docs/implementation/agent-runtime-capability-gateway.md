The Agent Runtime and Capability Gateway execute bounded cognitive work without granting an agent direct authority over enterprise systems. The runtime receives a signed, resolved ExecutionProfile and a minimized ContextManifest. It may reason, call only compiled capabilities through the gateway, and return a typed AgentResult. The gateway independently authenticates the runtime, validates the PermissionEnvelope, applies data and effect controls, obtains downstream credentials, invokes approved providers, and returns normalized evidence.

This United States baseline extends the foundation, KYC domain, Harness Control Plane, and Execution Control Plane designs. It assumes separate non-production and production environments, US data residency, private networking, one platform-issued workload identity per service, the platform's runtime-host image as the agent substrate (on any Kubernetes cluster or container platform, or as a Databricks App), and the Capability Gateway as the only capability ingress, optionally behind an operator-chosen API gateway. Sizing values are planning values that must be validated in the target environment.

In the code today: the runtime host is selected per node through the runtime adapters `local_http`, `hosted_http` and `databricks` ([runtime adapters](runtime-adapters.md)); the gateway loads capability adapter modules selected by `GATEWAY_ADAPTERS` ([capability adapters](capability-adapters.md)); services authenticate with `WORKLOAD_AUTH` and sign envelopes with `ENVELOPE_SIGNER` ([identity](identity-authorization-observability.md)). The gateway issues delegated skill envelopes in-process (`@ehf/execution-auth` `issueDelegatedEnvelope`) after re-checking the run, fence, release, work lease, node permission and pinned skill manifest; it signs them with its own key under `ENVELOPE_SIGNER=private_key` (`DELEGATED_ENVELOPE_PRIVATE_KEY_FILE`) and is their only verifier.

# 1. Mission, boundary, and invariants

The Agent Runtime is replaceable cognitive compute. It does not own workflow state, case truth, policy truth, tool credentials, release pointers, or final business decisions. The Capability Gateway is the boundary between that untrusted compute and models, APIs, tools, MCP servers, enterprise connectors, and external providers.

The Execution Control Plane owns WorkItems, readiness, leases, deadlines, cancellation, budgets, retries, and completion. The Context Assembler owns the authorized data view. The Case Command Gateway owns acceptance of proposed business changes. The Harness Control Plane owns signed executable authority. The Agent Runtime and Capability Gateway consume those contracts and produce a complete computational record.

The following invariants are enforced:

- Every invocation references a released, signed, and non-revoked HarnessPlan digest and a resolved ExecutionProfile digest.
- An agent receives only the ContextManifest selected for that WorkItem and never reads the case database directly.
- An agent knows logical capability names; it never receives provider endpoints, API keys, client secrets, refresh tokens, or database credentials.
- Every model or tool call passes through the Capability Gateway.
- The gateway authorizes each call from compiled permission, case and tenant scope, purpose, data class, residency, effect class, budget, and current revocation state.
- Agent output is a proposal. Only the Case Command Gateway can make business state effective.
- Runtime conversation and framework state are noncanonical and disposable. The ExecutionRecord and referenced artifacts preserve the auditable computation.
- At-least-once execution never becomes duplicate business effect. Idempotency exists at the WorkItem, runtime, gateway, adapter, and provider boundaries.
- External content remains typed untrusted evidence and cannot become policy, system instruction, or authorization.
- Cancellation, deadline, budget exhaustion, lease fencing, or revocation stops further calls and prevents result acceptance.

# 2. Logical architecture

```text
Execution Control Plane
  WorkItem + lease + budgets + signed profile
                  |
                  v
           Runtime Dispatcher
                  |
        +---------+----------+
        |                    |
        v                    v
 Hosted runtime host    Databricks App
 (hosted_http)          (databricks)
        |                    |
        +------ Agent Runtime SDK ------+
                       |                 |
              ContextManifest      CapabilityRequest
                       |                 |
                       v                 v
               Model Gateway       Tool Gateway
                       \              /
                        Capability Gateway
                authn | authz | policy | budgets
                schema | data | effect | identity
                       |                 |
            +----------+---------+-------+---------+
            v                    v                 v
       Model providers      Adapter services   MCP / APIs
                                                 |
                                       enterprise / vendors

AgentResult + ExecutionRecord
           |
           v
Case Command Gateway -> canonical Case and Ledger
```

| Component | Responsibility | Canonical state |
|---|---|---|
| Runtime dispatcher | Accept leased WorkItem, verify authority, choose execution stamp, start invocation | Invocation acceptance and dispatch reference only |
| Agent Runtime SDK | Validate envelope, run bounded reasoning loop, mediate model and tool calls, construct typed result | None; emits ExecutionRecord |
| Hosted agent or worker | Isolated compute for one invocation or session | Ephemeral session state only |
| Model gateway | Authorize model profile, apply token and content controls, route to approved deployment | Invocation and usage record |
| Tool gateway | Authorize capability, validate request, enforce effect semantics, route to adapter | Invocation, idempotency, and effect journal |
| Capability authorization service | Evaluate signed permission, context, policy, revocation, scope, and budget | Decision record with rule IDs |
| Credential broker | Present the gateway's workload identity, or acquire an OAuth client-credentials token or an `env:`/`file:` secret | No reusable credential returned to agent |
| Adapter service | Translate canonical capability contract to provider protocol and normalize response | Provider correlation and evidence references |
| Evidence writer | Store approved raw response and normalized evidence with digest and lineage | Immutable evidence artifact |
| Execution recorder | Assemble computational history and telemetry references | ExecutionRecord and artifact manifest |

# 3. Trust model

Treat the agent, model, prompts, retrieved content, tool output, and remote MCP descriptions as untrusted inputs. Trust is conferred only by signed HarnessPlan authority, verified schemas, deterministic policy, authenticated identity, gateway enforcement, and accepted evidence provenance.

The runtime may decide how to analyze an allowed problem, which allowed capability to request, and when it has enough evidence. It may not expand its data access, select an undeclared provider, increase its budget, waive a policy obligation, construct credentials, or declare a business decision effective.

The Capability Gateway is a policy enforcement point, not the source of policy. It consumes a pinned PermissionEnvelope and current emergency controls. API Management handles transport-level authentication, routing, quotas, and policy. A gateway authorization service handles domain-specific permission, purpose, data-flow, effect, evidence, idempotency, and revocation checks that would be unsafe to encode only in portal configuration.

| Input | Trust label | Permitted use |
|---|---|---|
| System instructions from signed plan | `TRUSTED_INSTRUCTION` | Runtime behavior within compiled authority |
| Context facts from accepted case state | `TRUSTED_CASE_FACT` | Reasoning and evidence correlation |
| Claims and findings | `GOVERNED_ASSERTION` | Reasoning with provenance and confidence |
| External documents and web text | `UNTRUSTED_EXTERNAL` | Evidence and analysis input only |
| Tool descriptions | `SIGNED_CAPABILITY_METADATA` | Discovery of already authorized operations |
| Model output | `UNTRUSTED_PROPOSAL` | Schema validation and downstream gate review |
| Tool response | `PROVIDER_RESPONSE` | Normalization and evidence validation |

# 4. Generic agent contract

One runtime contract supports screening, investigation, evidence extraction, policy analysis, decision recommendation, and QA. Domain behavior comes from the resolved profile rather than framework-specific code.

```text
execute_agent(
  AgentRequest,
  ExecutionProfile,
  ContextManifest,
  CancellationToken
) -> AgentResult
```

An `AgentSpec` declares role, provided capabilities, model profile, input and output contracts, context selectors, allowed tools, skills, case commands, policies, limits, completion rules, and escalation triggers. The resolved `ExecutionProfile` binds all names to immutable versions and adds region, runtime stamp, model deployment class, tool provider bindings, evaluation attestation, PermissionEnvelope, budgets, and assurance.

The runtime implementation excludes vendor SDK selection, SQL, case writes, secrets, provider retry rules, policy definitions, workflow state transitions, and unbounded arbitrary code. Those concerns remain in gateway adapters and deterministic platform services.

# 5. AgentRequest envelope

The dispatcher sends a structured envelope instead of an arbitrary prompt. The runtime verifies the envelope signature, digest references, audience, deadline, lease fencing token, and revocation generation before loading any context.

```json
{
  "contractVersion": "agent.request.v2",
  "execution": {
    "executionId": "exec_01...",
    "workItemId": "wi_01...",
    "caseId": "case_01...",
    "attempt": 2,
    "leaseId": "lease_01...",
    "fencingToken": 19,
    "deadlineAt": "2026-09-17T17:30:00Z",
    "traceparent": "00-..."
  },
  "authority": {
    "planDigest": "sha256:...",
    "executionProfileDigest": "sha256:...",
    "permissionEnvelopeDigest": "sha256:...",
    "policyDigest": "sha256:...",
    "revocationGeneration": 4812
  },
  "context": {
    "manifestDigest": "sha256:...",
    "expiresAt": "2026-09-17T17:30:00Z"
  },
  "budgets": {
    "maxRuntimeSeconds": 120,
    "maxModelCalls": 6,
    "maxToolCalls": 20,
    "maxInputTokens": 60000,
    "maxOutputTokens": 12000,
    "maxCostUsd": 1.50
  },
  "requiredOutput": "kyc.screening.result.v3"
}
```

The full case is never embedded. The envelope contains identifiers and content digests. The runtime retrieves the immutable ContextManifest through a short-lived, audience-bound authorization or receives it in the invocation only when size and transport policy allow.

# 6. ContextManifest and prompt construction

The Context Assembler produces a canonical manifest from the WorkItem, case snapshot, policy context, AgentSpec selectors, and PermissionEnvelope. Each item includes a schema, classification, trust label, purpose, provenance reference, content digest, and optional expiry.

The runtime converts this manifest into framework-specific messages through a deterministic prompt adapter. Trusted instructions and untrusted evidence occupy separate protocol fields where supported. When a framework has only text roles, the adapter wraps untrusted content in explicit data delimiters, escapes control sequences, and repeats that the content cannot authorize tools or modify instructions.

Prompt construction records prompt bundle digest, adapter version, item ordering, redaction actions, token estimate, and final message digest. Raw restricted content is not copied into logs. Reproduction uses the stored manifests and digests under controlled access.

Context overflow follows declared policy: deterministic prioritization, approved summarization with lineage, chunked subwork, or escalation. Silent truncation is prohibited. A summary is a new governed assertion with references to the source items; it never replaces raw evidence.

# 7. Runtime lifecycle

1. Authenticate the dispatcher and validate the AgentRequest schema.
2. Resolve and verify the signed HarnessPlan, ExecutionProfile, PermissionEnvelope, and revocation view.
3. Confirm WorkItem lease and fencing token with the Execution Control Plane.
4. Retrieve and digest-check the ContextManifest.
5. Initialize local budgets, cancellation, trace context, and append-only execution journal.
6. Build the model request from signed prompt bundle and governed context.
7. Send model calls through the Model Gateway.
8. Convert requested tool calls to typed CapabilityRequests; reject undeclared names locally.
9. Send each request through the Tool Gateway; consume normalized CapabilityResults.
10. Repeat within call, time, token, cost, and depth limits.
11. Validate the final result schema, evidence references, completion obligations, and unresolved contradictions.
12. Persist the ExecutionRecord and artifacts by digest.
13. Return AgentResult to the Execution Control Plane.
14. The Case Command Gateway independently validates any proposed commands before case-state mutation.

The runtime checks cancellation, deadline, lease, budget, and revocation before every model call, capability call, and final return. Local checks improve speed, but the gateway and result boundary recheck independently.

# 8. Reasoning loop and stop conditions

The runtime implements a bounded state machine rather than an open-ended chat loop.

```text
START -> LOAD_CONTEXT -> MODEL_REQUEST -> ASSESS_RESPONSE
                              ^                 |
                              |                 +-> TOOL_REQUEST -> TOOL_RESULT --+
                              |                                                 |
                              +-------------------------------------------------+
                                                |
                                                +-> FINAL_VALIDATE -> COMPLETE
                                                +-> ESCALATE
                                                +-> CANCELLED / TIMED_OUT / FAILED
```

The plan defines maximum iterations, model calls, tool calls, parallel calls, wall time, tokens, cost, repeated-call detection, and tool-call depth. The runtime stops when required outputs and evidence obligations are met, a declared escalation condition occurs, the model requests an unauthorized action, progress stalls, or any governing limit is reached.

Repeated identical calls with unchanged inputs are blocked after the configured threshold. The runtime detects self-delegation cycles and nested-agent depth. An orchestrator may propose more WorkItems but cannot spawn hidden background work outside the Execution Control Plane.

# 9. AgentResult and ExecutionRecord

AgentResult is small, typed, and safe for deterministic processing. It contains outcome class, structured findings, evidence references, contradictions, uncertainty, proposed case commands, escalation reason, budget usage, and the ExecutionRecord digest. Free-form explanation is optional supporting material, not the accepted business command.

```json
{
  "contractVersion": "agent.result.v3",
  "executionId": "exec_01...",
  "status": "COMPLETED",
  "outputSchema": "kyc.screening.result.v3",
  "findings": [{"type":"sanctions", "classification":"NO_MATCH", "evidenceRefs":["ev_..."]}],
  "contradictions": [],
  "proposedCommands": [{"type":"RecordScreeningEvidence", "payloadDigest":"sha256:..."}],
  "completion": {"mandatoryScreeningCompleted": true, "evidenceReferenced": true},
  "usage": {"modelCalls":2, "toolCalls":3, "costUsd":0.42},
  "executionRecordDigest": "sha256:..."
}
```

The ExecutionRecord binds the request, plan, profile, permission, context, prompt, model invocation, capability calls, normalized results, artifacts, output, runtime image, framework, region, timing, budget, and telemetry correlation. It preserves computational provenance without claiming that every internal token or provider implementation detail is durable business truth.

# 10. Runtime portability

The runtime is the platform's own runtime-host image. In production it runs as its own HTTPS service (`hosted_http`) on any Kubernetes cluster or container platform, or as a Databricks App (`databricks`); `local_http` is the development container. All adapters speak the same `runtime.invocation.v2` protocol (`POST /invocations`, status, cancel) and differ only in hosting and in how the dispatcher authenticates. A third-party runtime is added with `registerRuntimeAdapter` and must speak the same protocol.

All adapters must pass the same conformance suite ([runtime conformance](runtime-conformance.md)). A node's `runtimeTarget` selects an adapter or a named administered binding, not the workflow. Runtime choice cannot weaken PermissionEnvelope, network, evaluation, logging, or result-gate requirements. Vendor-native agents and models are reached as capabilities through the gateway, never as runtimes.

# 11. Runtime isolation and configuration

Run separate runtime deployments for production and non-production, and partition production when residency, contractual isolation, tenant scale, model availability, or risk requires it. A deployment is a security and lifecycle boundary.

Planning configuration:

| Setting | Production baseline | Reason |
|---|---|---|
| Region | One approved US primary region; approved US recovery region | Align runtime, data, and model processing |
| Deployment model | Regulated shared plus tenant-dedicated runtime deployments where required | Balance isolation and operations |
| Image | Runtime-host image from a private registry, deployed by digest | Controlled agent image supply chain |
| Public network access | None; the dispatcher reaches the runtime over private TLS | Prevent ungoverned paths |
| Runtime identity | The `harness-runtime` workload identity plus a per-invocation grant it cannot mint | Least privilege and attribution |
| Checkpoints | `RUNTIME_CHECKPOINT_BACKEND=memory` outside the platform trust boundary | No database credential in the runtime |
| Telemetry | OpenTelemetry over OTLP to the environment's collector | End-to-end execution correlation |

Runtime session state is not the canonical WorkItem, case, or execution record. A lost session can be reconstructed from the AgentRequest and governed artifacts. New runtime images are immutable dependencies pinned through the execution-profile digest recorded on each invocation.

# 12. Capability model

A capability is a stable business operation with one canonical request and response contract. Providers are replaceable implementations. Examples include `identity.document.verify`, `identity.ssn.verify`, `screening.sanctions.search`, `screening.pep.search`, `adverse_media.search`, `customer.internal.search`, `model.reasoning.standard`, and `case.command.propose`.

```yaml
apiVersion: harness.factory/v1
kind: CapabilityVersion
metadata:
  name: screening.sanctions.search
  version: 3.2.0
spec:
  requestSchema: kyc.sanctions.request.v2
  responseSchema: kyc.sanctions.result.v3
  effectClass: READ_ONLY
  data:
    accepts: [PII]
    returns: [PII, SCREENING_RESULT]
    residency: US
    egress: EXTERNAL_APPROVED
  reliability:
    timeoutMs: 8000
    attempts: 3
    retryOn: [429, 502, 503, 504]
  evidence:
    produces: screening_result
    rawResponseRetention: required
  telemetry:
    payloadLogging: prohibited
```

The Capability Resolver in the Execution Control Plane selects an eligible provider binding using region, tenant, data class, assurance, evaluation certification, provider health, contract, cost, and SLO. The gateway validates that binding and may fail over only within a precompiled equivalent-provider set. It does not invent a provider because one appears healthy.

# 13. CapabilityRequest contract

```json
{
  "contractVersion": "capability.request.v2",
  "invocationId": "cinv_01...",
  "executionId": "exec_01...",
  "workItemId": "wi_01...",
  "caseId": "case_01...",
  "tenantId": "tenant_01...",
  "capability": "screening.sanctions.search",
  "capabilityVersion": "3.2.0",
  "providerBindingDigest": "sha256:...",
  "permissionEnvelopeDigest": "sha256:...",
  "purpose": "KYC_SCREENING",
  "dataClasses": ["PII"],
  "effectClass": "READ_ONLY",
  "deadlineAt": "2026-09-17T17:29:10Z",
  "idempotencyKey": "tenant_01:case_01:wi_01:sanctions:subject_01",
  "inputSchema": "kyc.sanctions.request.v2",
  "input": {"subjectRef":"subject_01", "name":"...", "dateOfBirth":"..."},
  "traceparent": "00-..."
}
```

The runtime authenticates the request with its workload identity and presents the node's signed execution envelope. The gateway derives agent and runtime identity from the token rather than accepting identity fields as proof. It resolves the PermissionEnvelope by digest and compares the request with allowed capability, input fields, data classes, purpose, region, effect, provider set, deadlines, and remaining budget.

# 14. Capability Gateway request path

1. The gateway verifies the caller's workload token: issuer, audience, signature, time, and subject mapped to a logical service.
2. An optional ingress gateway, then the service itself, applies network restrictions, request size, media type, schema, rate, concurrency, and basic quota policy.
3. The gateway service verifies the signed plan and PermissionEnvelope, release scope, revocation generation, lease, deadline, and fencing token.
4. The authorization engine evaluates capability, version, provider binding, purpose, data classes, residency, tenant, assurance, effect class, and budget.
5. The idempotency service returns an existing terminal result or atomically reserves the operation.
6. The data guard validates allowed fields, tokenizes or redacts where specified, and writes a request digest.
7. The credential broker obtains the provider identity without exposing it to the runtime.
8. The adapter invokes the provider using capability-specific timeout, retry, circuit, and concurrency rules.
9. The response is schema-validated, normalized, classified, and checked for provider errors or unsafe content.
10. Required raw response and normalized evidence are stored with digest and provenance.
11. The invocation and effect journal are committed; the gateway returns a typed CapabilityResult.

A commodity API gateway can add token validation, rate limiting, backend pools, and circuit breaking in front of the service. The domain authorization and effect journal remain in the Capability Gateway because they require authoritative Harness and case context.

# 15. CapabilityResult contract

```json
{
  "contractVersion": "capability.result.v2",
  "invocationId": "cinv_01...",
  "status": "SUCCEEDED",
  "capability": "screening.sanctions.search",
  "providerBindingDigest": "sha256:...",
  "outputSchema": "kyc.sanctions.result.v3",
  "output": {"matchClass":"NO_MATCH", "candidates":[]},
  "evidence": [{"evidenceId":"ev_01...", "digest":"sha256:...", "type":"screening_result"}],
  "authorizationDecisionId": "authz_01...",
  "effectJournalId": "eff_01...",
  "providerCorrelationHash": "sha256:...",
  "usage": {"durationMs":412, "billableUnits":1},
  "cache": {"status":"MISS", "freshUntil":"2026-09-17T18:00:00Z"}
}
```

Errors use stable classes: `UNAUTHORIZED`, `REVOKED`, `INVALID_INPUT`, `DATA_POLICY_DENIED`, `BUDGET_EXCEEDED`, `DEADLINE_EXCEEDED`, `RATE_LIMITED`, `PROVIDER_UNAVAILABLE`, `PROVIDER_REJECTED`, `INVALID_PROVIDER_RESPONSE`, `AMBIGUOUS_EFFECT`, and `INTERNAL_ERROR`. The runtime uses the class and compiled retry policy; it never infers retry behavior from free-form text.

# 16. Effect classes and authorization strength

| Effect class | Examples | Required controls |
|---|---|---|
| `READ_ONLY` | Search sanctions, retrieve approved record | Standard permission, bounded retries, evidence and freshness |
| `IDEMPOTENT_WRITE` | Upsert vendor case by stable key | Mandatory idempotency key, provider support or gateway effect journal |
| `REVERSIBLE_WRITE` | Add watchlist subscription that can be removed | Explicit command, compensation definition, stronger approval |
| `IRREVERSIBLE_WRITE` | Submit regulatory filing | Human or deterministic approval gate, no blind retry, receipt reconciliation |
| `EXTERNAL_COMMUNICATION` | Send customer notice or analyst email | Approved template, recipient control, content policy, preview and approval |
| `FINANCIAL_OR_LEGAL_EFFECT` | Freeze account, reject customer, file SAR-related action | Separate business command, dual control, strict evidence and audit |

Agents are normally restricted to read-only capabilities and proposals. A plan may authorize a stronger effect only when the workflow includes the required approval, compensation, evidence, provider idempotency, and result reconciliation. The runtime cannot upgrade an effect class by choosing a different endpoint or MCP tool alias.

# 17. Idempotency and ambiguous outcomes

The gateway stores an idempotency record before invoking any billable or effecting operation. Its key scope includes tenant, capability, provider binding, business operation key, and relevant request digest. A duplicate with identical input returns the prior terminal result. A duplicate key with different input fails as a conflict.

For provider timeout after request transmission, the operation becomes `OUTCOME_UNKNOWN`. Read-only calls may retry when the plan permits. Writes enter reconciliation: query provider status by idempotency key or correlation reference, wait, compensate, or route to human review. The gateway never reports success solely because the HTTP request was accepted.

```sql
create table capability_invocation (
  invocation_id uuid primary key,
  execution_id uuid not null,
  capability text not null,
  provider_binding_digest text not null,
  request_digest text not null,
  idempotency_scope text not null,
  state text not null,
  authorization_decision_id uuid not null,
  effect_class text not null,
  provider_correlation_hash text,
  result_digest text,
  attempt_count integer not null,
  deadline_at timestamptz not null,
  row_version bigint not null default 0,
  unique (idempotency_scope)
);

create table effect_journal (
  effect_journal_id uuid primary key,
  invocation_id uuid not null unique,
  effect_class text not null,
  state text not null,
  requested_at timestamptz not null,
  acknowledged_at timestamptz,
  reconciled_at timestamptz,
  receipt_artifact_digest text,
  compensation_invocation_id uuid
);
```

# 18. Model Gateway

The Model Gateway is a specialization of the Capability Gateway. The agent requests a logical profile such as `model.reasoning.standard`; the ExecutionProfile binds it to an approved deployment and fallback set. The gateway enforces model, region, content, data-class, token, cost, request-rate, and concurrency policy.

Model providers are administered bindings (`openrouter`, `openai_compatible`, `recorded`) resolved only inside the gateway; the binding names the environment variable that holds the credential.

The gateway records model profile, provider and deployment identifiers, API version, sampling configuration, prompt and response digests, content-safety decisions, token counts, latency, cost estimate, cache state, and fallback. Raw prompts and outputs follow the ContextManifest classification and are not placed in request logs.

Fallback is compiled, not opportunistic. It requires equivalent data handling, region, interface, evaluation certification, and assurance. A lower-cost or available model is not a valid fallback if the exact agent-model-tool combination lacks the required attestation.

# 19. Tool, connector, and MCP Gateway

Enterprise connectors sit behind adapters. Agents do not call SAP, Salesforce, ServiceNow, SharePoint, Microsoft Graph, core banking, customer master, document management, email, or vendor APIs directly. An adapter limits the operation set, translates schemas, applies provider-specific identity, and normalizes evidence.

MCP is a transport and discovery protocol, not authorization. The gateway publishes only approved tools, pins server and schema versions where possible, validates every invocation against the PermissionEnvelope, and ignores remote tool descriptions as sources of authority.

A capability name maps to a controlled adapter binding, such as an allowlisted `http-operation` operation, or an MCP tool identifier. Namespace collisions, dynamic remote tool discovery, unapproved server redirects, schema changes, and tool-list expansion fail closed. The Harness Control Plane reevaluates and releases any executable tool catalog change.

# 20. Identity and credential brokerage

Five principal classes remain separate: human operators, Harness platform services, agent identities, gateway and adapter identities, and delegated end-user identities. Each runtime deployment presents its own workload identity; the gateway verifies it itself and maps the subject to a logical service.

The credential order is workload identity, OAuth client credentials or token exchange, client certificate, then secret. Secrets that cannot be eliminated are referenced as `env:NAME` or `file:/path` and mounted by the operator's secret manager. An agent never sees the downstream credential. The gateway or adapter acquires it immediately before the call and sends it only to the intended audience.

Delegated user authority is used only when the downstream action genuinely requires that user. The PermissionEnvelope must allow delegation, the original user token must have the required authentication context, and the gateway obtains an audience-specific token through OAuth 2.0 token exchange. A service identity cannot silently impersonate a user, and a user token cannot expand the agent's compiled authority.

RBAC roles separate ingress policy administration, capability registry changes, adapter deployment, credential configuration, runtime invocation, production diagnostics, and audit. Anyone able to change which identity the gateway presents downstream is treated as privileged.

# 21. Ingress configuration

An API gateway in front of the Capability Gateway is optional defense in depth; the gateway service enforces every control below itself. When one is used, it is configured as code.

| Policy layer | Controls |
|---|---|
| Global | Correlation ID, payload size, allowed TLS, generic headers, telemetry redaction, default deny |
| Caller | Workload identity subjects, environment, tenant partition, quotas |
| API | Token validation, audience, capability family, schema version |
| Operation | Capability and effect metadata, request schema, deadline, rate and concurrency limit |
| Backend | Timeout, connection, load pool, circuit breaker |
| Outbound | Response size and schema, forbidden headers, classification, correlation |
| Error | Stable error mapping, retry hints, sanitized diagnostics |

IaC owns routes, policies, backends, diagnostics, private networking, and role assignments. Console edits in production are denied or continuously detected.

Ingress metadata logging includes request ID, capability, version, identity subject hash, tenant hash, decision ID, provider binding digest, response class, latency, token or billable units, and trace context. Payload and authorization tokens are excluded.

# 22. Network architecture

The runtime and gateway use private network paths wherever supported. The production topology separates the runtime network, the platform services network, the data network, and controlled egress through an egress proxy or firewall.

```text
Enterprise ingress / Execution Control Plane
                 |
        private runtime endpoint (hosted_http / databricks)
                 |
        runtime-host deployment
                 |
        Capability Gateway (optional ingress gateway in front)
      |        |         |          |
 private       |   private link /   | controlled egress
 data services |   on-prem APIs     | approved vendors
               |
        secret manager / object storage / PostgreSQL
```

Private DNS is managed centrally. Network policies permit only documented flows. Egress rules allow approved vendor domains; IP rules are used where FQDN control is insufficient. DNS, egress, ingress, and gateway logs correlate with execution IDs without storing payloads.

Direct runtime egress is denied for enterprise tools; the agent calls the Capability Gateway. Network reachability never substitutes for application authorization.

# 23. Data protection and evidence

The PermissionEnvelope specifies allowed input and output data classes, purpose, processing region, provider class, retention, and egress. The gateway compares those declarations with the capability and provider binding before the call. It rejects combinations such as US-only evidence with an EU-only endpoint or restricted PII with a model profile that lacks permission.

Request transformations remove fields the provider does not need. Stable references replace raw identifiers when an adapter can resolve them internally. Logs hash or tokenize tenant, case, subject, and provider references. Diagnostics expose classifications and digests rather than raw values.

Raw provider responses are retained only when evidence policy requires them. They are written to the evidence store with content digest, provider correlation, request digest, collection time, classification, retention, legal-hold eligibility, and encryption context. The normalized CapabilityResult references the evidence and records the transformation version.

Cache entries are permitted only for capabilities with declared cache semantics. The cache key binds tenant, provider, input digest, purpose, data policy, capability version, and freshness class. Restricted cross-tenant caching is prohibited. Revocation and provider-data corrections can invalidate entries by tag.

# 24. Reliability, retries, and backpressure

The runtime is stateless between invocations except for disposable framework session state. It checkpoints only at governed boundaries: model invocation, capability result, and final result. A worker crash causes the Execution Control Plane to retry the WorkItem with the same business idempotency keys and a new execution attempt.

The gateway owns provider-specific retry policy. It honors the caller deadline, subtracts elapsed time, uses exponential backoff with jitter, and never retries beyond the compiled attempt or cost budget. Circuit breakers protect providers. Bulkheads isolate model, screening, search, document, and enterprise connector pools. Tenant quotas prevent a noisy tenant from exhausting shared capability capacity.

Work is queued in PostgreSQL and signalled with `NOTIFY`, with a bounded poll as the fallback; delivery is at least once. Business idempotency remains authoritative.

Backpressure begins at the dispatcher. Queue age, provider concurrency, ingress capacity, runtime replica capacity, model quotas, token rate, and cost budget feed admission control. Low-priority investigations pause before high-priority sanctions or analyst-response work is affected.

# 25. Cancellation, fencing, and revocation

The runtime receives a cancellation channel and polls the Execution Control Plane at bounded intervals. Every gateway call carries execution, lease, attempt, and fencing data. The gateway rejects a stale token before invoking a provider. Result acceptance performs the same check after the call, preventing a timed-out worker from publishing late work.

Revocation is checked at invocation start, before each model or capability call, and before final result return. A new revocation generation invalidates cached authorization. Maximum propagation staleness is 60 seconds. High-assurance work fails closed when revocation status cannot be refreshed inside that bound.

For an in-flight irreversible effect, cancellation does not claim the external action vanished. The gateway records the actual state, attempts configured compensation or reconciliation, and returns `AMBIGUOUS_EFFECT` or the verified outcome. The WorkItem routes to human review when required.

# 26. Persistence model

Runtime metadata and gateway operations use separate PostgreSQL schemas from the canonical case. Large prompts, responses, raw evidence, and execution artifacts live in the artifact store behind a replaceable storage boundary and are referenced by digest.

```sql
create table runtime.execution_record (
  execution_id uuid primary key,
  work_item_id uuid not null,
  attempt integer not null,
  plan_digest text not null,
  profile_digest text not null,
  permission_digest text not null,
  context_manifest_digest text not null,
  runtime_image_digest text not null,
  state text not null,
  result_digest text,
  artifact_manifest_digest text,
  started_at timestamptz not null,
  completed_at timestamptz,
  usage jsonb not null,
  unique (work_item_id, attempt)
);

create table gateway.authorization_decision (
  decision_id uuid primary key,
  invocation_id uuid not null,
  subject_id_hash text not null,
  permission_digest text not null,
  capability text not null,
  provider_binding_digest text not null,
  outcome text not null,
  reason_codes text[] not null,
  policy_digest text not null,
  revocation_generation bigint not null,
  decided_at timestamptz not null
);
```

State transitions use optimistic concurrency and an outbox in the same transaction. The evidence writer registers an artifact only after upload, server-side encryption, digest verification, malware controls where applicable, and required metadata succeed.

# 27. Deployment topology and sizing

| Component | Production baseline | Initial configuration |
|---|---|---|
| Runtime host (`hosted_http` or `databricks`) | Separate deployment per environment; private ingress | Runtime-host image by digest, `harness-runtime` identity, memory checkpoints |
| Capability Gateway | Replicated service, zone-spread where supported | Workload identity, provider credentials as `env:`/`file:` references, internal ingress |
| Runtime dispatcher | Replicated worker scaled on queue depth | KEDA PostgreSQL scaler ([`deploy/kubernetes/`](../../deploy/kubernetes)), lease and fence in PostgreSQL |
| PostgreSQL | Separate runtime/gateway database or schemas, PgBouncer | HA, private access, PITR, `PGPASSFILE` or TLS client certificates |
| Object storage (when used) | Separate evidence and runtime-artifact buckets | Private access, versioning, lifecycle and immutability policies |
| Secret manager | Per environment and purpose | Provider secrets and signing keys mounted as files; rotation by rollout |
| Container registry | Registry per environment | Private access, image digests, SBOM and provenance, vulnerability gate |
| OTLP collector | Per environment | Redaction, sampling, routing to the operator's backends |
| Egress proxy/firewall | Central controlled egress | FQDN rules, stable vendor source IP where required |

Initial settings are runtime-host replicas min 0 and max 100 per workload class, gateway min 3 and max 50, adapter services min 2 for critical providers, and recorder min 2. Scale the dispatcher on PostgreSQL queue depth and the runtime and gateway on HTTP concurrency and latency where supported. Connection budgets follow [the production performance guide](../../deploy/performance.md).

# 28. Observability and flight recorder

OpenTelemetry spans follow the WorkItem through dispatch, context load, prompt construction, model calls, capability authorization, adapter calls, evidence writes, result validation, and case-command submission. The trace ID is correlation, not business identity.

Required semantic attributes include environment, region, plan digest, profile digest, execution ID, WorkItem ID, attempt, agent version, runtime stamp, model profile, capability, provider binding digest, policy digest, assurance, outcome, error class, latency, token counts, tool counts, billable units, and cost estimate. Tenant and case identifiers are hashed or access-controlled.

| Objective | Proposed target | Alert |
|---|---|---|
| Runtime invocation availability | 99.9 percent monthly | Multi-window burn rate |
| Gateway availability | 99.95 percent monthly | Multi-window burn rate |
| Gateway authorization latency | p95 under 40 ms excluding provider | p95 above 75 ms for 15 minutes |
| Read-only capability overhead | p95 under 100 ms excluding provider | p95 above 175 ms |
| Revocation enforcement | 99.9 percent under 60 seconds | Any resolver stale over 60 seconds |
| Unauthorized capability denial | 100 percent | Any accepted unauthorized test or production event |
| Duplicate external effects | Zero | Any effect-journal reconciliation mismatch |
| Execution record completeness | 100 percent terminal executions | Reconciliation finds missing manifest |

Dashboards separate platform reliability, model behavior, tool behavior, policy outcomes, KYC business outcomes, and human-review consistency. A single agent-accuracy metric cannot explain the system.

# 29. Security threats and controls

| Threat | Primary controls |
|---|---|
| Prompt injection in documents or web results | Trust labels, context separation, gateway authorization independent of prompt, adversarial tests |
| Tool-name or schema spoofing | Signed capability catalog, exact version, schema digest, namespace and provider binding validation |
| Credential theft | Workload identity, gateway brokerage, no secret in context or response, mounted secrets with narrow file access |
| Data exfiltration | PermissionEnvelope, field allowlists, provider classification, private network, controlled egress, payload redaction |
| Excessive agency | Bounded loop, budgets, effect classes, approval gates, no direct case writes |
| Cross-tenant access | Tenant-bound tokens, context manifests, database row controls, cache partitioning, adapter validation |
| Replay and duplicate effects | Nonces where required, idempotency scope, effect journal, provider reconciliation, fencing |
| Stale worker result | Lease and fencing checks at gateway and Case Command Gateway |
| Compromised provider or MCP server | Signature and schema pinning, response validation, evidence quarantine, revocation and provider isolation |
| Supply-chain compromise | Pinned images, SBOM, OCI signature, vulnerability gates, restricted build provenance |
| Telemetry leakage | Attribute allowlist, payload logging off, DLP tests, access-controlled diagnostics |
| Budget denial of service | Admission control, per-tenant/model/tool quotas, concurrency bulkheads, cost reservations |

# 30. KYC capability catalog baseline

| Capability | Effect | Key controls | Failure behavior |
|---|---|---|---|
| `identity.document.verify` | Read-only, billable | PII and document class, US processing, vendor consent, raw-response evidence | Retry bounded; manual review on inconclusive or outage |
| `identity.ssn.verify` | Read-only, billable | SSN minimization/tokenization, strict purpose, field allowlist | No fallback outside approved US providers |
| `screening.sanctions.search` | Read-only | Freshness, list version, alias inputs, match evidence | Approved equivalent-provider failover or manual review |
| `screening.pep.search` | Read-only | Jurisdiction and data-source version, match rationale | Manual review for high-confidence match |
| `adverse_media.search` | Read-only external | Public-data-only query, untrusted content labels, source provenance | Escalate if evidence insufficient |
| `customer.internal.search` | Read-only internal | Tenant scope, case purpose, security filters, no cross-customer bulk export | Deny on scope ambiguity |
| `investigation.web.search` | Read-only external | Query DLP, approved provider, result trust labeling, domain controls | Deny restricted identifiers or prohibited domain |
| `document.ocr.extract` | Read-only processing | Approved storage reference, malware scan, model profile and retention | Quarantine malformed document |
| `notification.customer.preview` | Proposal only | Approved template and recipient reference; no send effect | Return preview for deterministic approval |
| `regulatory.submission.propose` | Proposal only | Evidence and dual-control requirements | Never submit directly from agent runtime |

# 31. CI/CD and release integration

The runtime SDK, gateway services, and adapters are versioned independently but certified as compatible combinations. Images are built once, scanned, given an SBOM, signed, and promoted by digest. The Harness Control Plane records runtime and adapter digests in evaluation attestations and ExecutionProfiles.

```text
pull request
 -> unit + contract + policy tests
 -> prompt-injection and schema fuzz tests
 -> build image + SBOM + vulnerability gate + OCI signature
 -> deploy isolated nonprod by digest
 -> runtime/gateway conformance suite
 -> provider sandbox + fault + idempotency tests
 -> KYC golden/adversarial/replay evaluations
 -> performance and network validation
 -> update Harness dependency + evaluation attestation
 -> canary ExecutionProfile release
 -> staged production promotion
```

Ingress configuration, policies, backends, diagnostics, and networking are IaC. Capability catalog records and provider bindings flow through Harness release controls. A console hotfix requires incident authority, is exported to source immediately, and triggers drift reconciliation.

# 32. Implementation plan

| Phase | Duration | Deliverables and exit criteria |
|---|---|---|
| 0. Contracts and threats | 2 weeks | AgentRequest, AgentResult, ExecutionRecord, CapabilityRequest/Result, effect classes, threat model, ADRs |
| 1. Platform foundation | 3 weeks | Cluster or container platform, workload identity issuer, PostgreSQL, object storage, secret manager, registry, OTLP collector |
| 2. Runtime SDK MVP | 5 weeks | Envelope verification, context adapter, bounded loop, cancellation, budgets, model/tool client, typed result |
| 3. Gateway core | 5 weeks | Gateway ingress, authorization service, permission/revocation checks, schema guard, idempotency, evidence and errors |
| 4. Model gateway | 3 weeks | Logical profiles, routing, quotas, token/cost controls, content policy, telemetry, fallback enforcement |
| 5. KYC adapters | 5 weeks | Identity, SSN, sanctions, PEP, adverse media, internal search, OCR adapters and sandbox tests |
| 6. Hosted runtime | 3 weeks | `hosted_http` deployment, private network, identities, invoke contract, telemetry, revision and capacity tests |
| 7. Effect and credential hardening | 3 weeks | Credential broker, token exchange, effect journal, ambiguous-outcome reconciliation, compensation hooks |
| 8. End-to-end KYC pilot | 4 weeks | Screening and investigation flows, case-command gating, replay, shadow, canary, human review |
| 9. Resilience and DR | 3 weeks | Load, chaos, provider outage, region exercise, runbooks, SLO alerts, security review |

# 33. Prioritized engineering backlog

| ID | Work item | Acceptance criterion |
|---|---|---|
| AR-01 | Publish runtime protocol and schemas | `local_http`, `hosted_http` and `databricks` adapters pass the same conformance fixtures |
| AR-02 | Verify signed invocation authority | Altered digest, scope, audience, deadline, lease, or revocation fails before context load |
| AR-03 | Implement governed context adapter | Trust labels and classifications survive prompt construction; silent truncation impossible |
| AR-04 | Build bounded reasoning state machine | Limits, cancellation, stall detection, and stop rules pass deterministic tests |
| AR-05 | Create complete ExecutionRecord | Every model/tool call and artifact is digest-bound without restricted payload leakage |
| CG-01 | Configure private gateway ingress | Only approved identities and networks reach capability APIs |
| CG-02 | Implement authorization engine | Permission, purpose, data, region, effect, budget, lease, and revocation are independently checked |
| CG-03 | Implement idempotency and effect journal | Duplicate calls return stable result; ambiguous writes reconcile without duplicate effect |
| CG-04 | Build credential broker | Agent never receives provider credential; workload identity is preferred and audited |
| CG-05 | Implement schema and data guard | Extra fields, wrong classes, and prohibited provider combinations fail closed |
| CG-06 | Build model-profile gateway | Logical profile routes only to attested deployment with token and cost controls |
| CG-07 | Deliver sanctions and PEP adapters | Canonical results, evidence, retries, freshness, and provider errors pass KYC tests |
| CG-08 | Deliver identity and SSN adapters | Restricted data is minimized, US-bound, and absent from telemetry |
| CG-09 | Govern MCP exposure | Only released tools and schemas are visible and invocable through the gateway |
| OPS-01 | Implement revocation propagation | Runtime and gateway deny a revoked subject within 60 seconds |
| OPS-02 | Add end-to-end OTel and dashboards | One trace follows dispatch through case-command result with redacted metadata |
| OPS-03 | Run capacity tests | Two-times forecast peak meets latency, connection, quota, and cost targets |
| KYC-01 | Execute production-like pilot | Golden, adversarial, fault, replay, shadow, and canary gates pass |

# 34. Verification strategy

Unit tests cover envelopes, signatures, schema validation, context ordering, budget accounting, stop conditions, permission decisions, effect classes, idempotency, error mapping, retry rules, cache partitioning, and evidence manifests. Property tests generate equivalent call orderings and duplicate deliveries. Fuzzing targets JSON, MCP schemas, provider responses, prompt boundaries, and oversized inputs.

Integration tests use a real non-production deployment: hosted runtime, gateway, PostgreSQL queues, object storage, secret manager, registry, and provider sandboxes. They verify private DNS, identity audiences, policy deployment, token expiry, cancellation, scale, digest checking, evidence writes, and complete traces.

Adversarial tests place instructions in OCR, documents, search results, tool descriptions, tool output, and schema fields. They request undeclared capabilities, alternate endpoints, stronger effects, extra PII fields, cross-tenant references, stale fencing tokens, and revoked providers. Every attempt must fail at a deterministic boundary with an audit decision.

Fault tests terminate runtime instances, duplicate messages, expire leases, delay revocation, exhaust model quota, fail the ingress, time out adapters, return malformed provider data, lose a response after an external write, block evidence storage, and fail database over. Success means no authority expansion, no duplicate effect, no accepted stale result, and recoverable evidence.

Performance tests cover peak WorkItem bursts, long-running investigations, parallel tool calls, ingress capacity, authorization latency, provider pools, PostgreSQL connections, queue backlog, artifact-store throughput, runtime replica capacity, and per-tenant fairness.

# 35. Operational runbooks

Required runbooks cover runtime backlog, runtime capacity exhaustion, runtime image rollout failure, context retrieval failure, model quota exhaustion, token or cost anomaly, ingress capacity, authorization latency, provider circuit open, connector credential failure, secret-manager outage, duplicate-effect alarm, ambiguous write, evidence-write failure, malformed provider response, MCP catalog drift, revocation lag, stale lease rejection, database failover, DLQ replay, and regional recovery.

Each runbook states detection, affected capabilities and cases, immediate containment, diagnostic queries, safe replay conditions, rollback or revocation threshold, evidence preservation, communications, and completion verification. Operators do not bypass the gateway, issue vendor calls from personal tools, expose credentials to the runtime, or edit effect-journal rows directly.

# 36. Architecture decisions and definition of done

The initial decisions approve a generic runtime contract; the platform's runtime-host image as the substrate, hosted on any container platform or Databricks; agents as untrusted compute; the domain Capability Gateway as the capability boundary; compiled PermissionEnvelope as runtime authority; separate model and tool policies under one capability abstraction; gateway-owned credentials; typed trust labels; effect-class controls; at-least-once transport with layered idempotency; and Case Command Gateway validation before business mutation.

Production pilot readiness requires all of the following:

- Every runtime adapter passes the same AgentRequest and AgentResult conformance suite.
- An agent cannot access case storage, provider endpoint, model deployment, enterprise connector, or credential outside the gateway path.
- Permission, data, residency, purpose, assurance, effect, budget, lease, and revocation checks independently deny invalid calls.
- Every successful capability call has a decision record, request and result digest, provider binding, evidence references, usage, and trace correlation.
- Duplicate and ambiguous provider operations cannot produce an untracked duplicate business effect.
- Prompt injection in any context or tool field cannot authorize a capability, alter policy, or write case state.
- Revocation fences model and tool calls in under 60 seconds and stale worker results cannot pass the Case Command Gateway.
- KYC identity, SSN, sanctions, PEP, adverse-media, internal-search, and OCR capabilities pass contract, golden, adversarial, fault, replay, and canary tests.
- Private networking, workload identities, logging redaction, backup, recovery, ingress policy drift, capacity, and provider outage runbooks are validated.
- Platform, security, privacy, KYC policy, SRE, audit, and operations owners approve evidence and ownership.

The result is a runtime in which agents can reason flexibly while every meaningful interaction remains bounded by compiled authority, minimized context, independent gateway enforcement, explicit effect semantics, controlled credentials, durable evidence, and deterministic business acceptance.
