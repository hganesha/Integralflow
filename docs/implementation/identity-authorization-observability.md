Identity, authorization, and observability form one control and proof fabric for the Harness Factory. Identity establishes who or what is acting. Authorization proves what that principal may do under a specific case, purpose, policy, and signed plan. Observability shows how a request moved through the platform. Durable correlation records connect operational spans to WorkItems, executions, commands, evidence, ledger events, and final dispositions without treating telemetry as the business source of truth.

This United States baseline extends the foundation, KYC domain, Harness Control Plane, Execution Control Plane, Agent Runtime and Capability Gateway, and Canonical Case Service specifications. It assumes only open standards: an OpenID Connect identity provider for people, platform-issued workload identity for services (Kubernetes service-account tokens, SPIFFE JWT-SVIDs or OIDC client-credentials tokens), signing keys mounted as files, OpenTelemetry exported over OTLP to a collector the operator chooses, PostgreSQL correlation metadata, private networking, and immutable execution/ledger records. No part of it depends on a particular cloud.

# 0. What the code implements today

`packages/identity` selects one mechanism per concern at startup; every setting refuses an unknown value and `SECURITY_PROFILE=production` refuses the development values (README "Deployment settings").

| Concern | Setting | Development | Production |
|---|---|---|---|
| People | `IDENTITY_PROVIDER` | `local_headers` | `oidc`: `OIDC_ISSUER`, `OIDC_AUDIENCE`, roles from `OIDC_ROLES_CLAIM` (default `roles`), JWKS discovered from the issuer unless `OIDC_JWKS_URI`/`OIDC_JWKS_FILE` is set |
| Services | `WORKLOAD_AUTH` | `static_token` (`<SERVICE>_SERVICE_TOKEN`) | `workload_identity`: the projected token in `WORKLOAD_TOKEN_FILE`, verified against `WORKLOAD_IDENTITY_ISSUER`/`WORKLOAD_IDENTITY_AUDIENCE`; `WORKLOAD_IDENTITIES` maps each logical service to a distinct token subject |
| Envelope signing | `ENVELOPE_SIGNER` / `ENVELOPE_VERIFIER` | `hmac` / `hmac` | `private_key` / `public_key`: each signer reads `<KIND>_PRIVATE_KEY_FILE` and `<KIND>_KEY_ID` (kinds `RUNTIME_GRANT`, `EXECUTION_ENVELOPE`, `INTEGRATION_ENVELOPE`, `DELEGATED_ENVELOPE`); verifiers hold `*_PUBLIC_KEY_PEM` |
| Secrets | reference syntax | `env:NAME` | `env:NAME` or `file:/path` (any secret manager that mounts a file; `SECRETS_DIR` confines `file:`) |
| Database | `DATABASE_AUTH` | `url` | `url` without a password: `PGPASSFILE` or a TLS client certificate |
| Telemetry | `TELEMETRY_EXPORTER` | `otlp` | `otlp` with an explicit `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` |

Each service has exactly one identity and presents it to every service it calls; the callee maps the verified subject to a logical service name and grants roles from its own declarations, never from token claims (README "Service identity"). Narrow roles replace borrowed credentials: the case API calls the control API as `case-api` with `Case.Outbox.Publish` and `Policy.Authority.Read`, and the control API calls the case API as `control-api` with `Edge.Delegate`. The rest of this document is the target design those mechanisms serve.

# 1. Mission, boundary, and invariants

The identity and authorization plane governs human users, platform workloads, agents, adapters, automation, external integrations, and delegated users. The observability plane captures service behavior and correlated execution paths. They cooperate, but authentication logs and spans do not replace authorization decisions, ExecutionRecords, or the Case Ledger.

The following invariants are enforced:

- Every accepted action has an authenticated principal, actor class, tenant, audience, and authorization decision.
- Human, service, agent, gateway, adapter, deployment, and emergency identities remain distinct.
- Production workloads use platform-issued workload identity; static service tokens and shared signing secrets are refused under the production security profile.
- Authorization is evaluated from signed authority and current context, never from prompt text, agent self-assertion, network location, or trace attributes.
- The compiled PermissionEnvelope limits an agent even when its workload identity has infrastructure reachability.
- Deny, revocation, expired authority, tenant mismatch, and stale fencing take precedence over allow.
- A trace ID is an operational correlation value. It is not the case ID, command ID, idempotency key, authorization proof, or audit record.
- Every material boundary propagates W3C Trace Context and a constrained correlation envelope.
- Durable records store trace references, while telemetry stores only approved opaque business references or hashes.
- Operational spans may be sampled. Business events, authorization decisions required for proof, ExecutionRecords, and Case Ledger events are never lost through telemetry sampling.
- Raw PII, credentials, tokens, prompts, documents, model output, and unrestricted tool payloads never appear in span attributes or ordinary logs.
- A privileged operator cannot both grant access and erase the evidence of that grant.

# 2. Logical architecture

```text
OIDC identity provider          Workload identity issuer
 users | groups | roles claim    service accounts | SPIFFE | OIDC clients
                         |
                         v
                 Authentication edge
     optional ingress gateway + per-service token validation
                         |
                         v
                 Authorization service
  RBAC + ABAC + assignment + purpose + policy + PermissionEnvelope
                         |
               decision + obligations
                         v
 Harness services / agents / gateways / case and control planes
                         |
               OpenTelemetry SDKs
        trace context | spans | metrics | logs
                         v
             OTLP collector
                         |
       operator-chosen trace, metric and log backends

Durable proof stores, linked from every material action:
  Identity Registry + AuthorizationDecision + TraceLink index (PostgreSQL)
  ContextManifest + ExecutionRecord (PostgreSQL/object storage)
  CaseEvent + Evidence lineage (Case Ledger/Evidence Store)
```

| Component | Responsibility | Source of truth |
|---|---|---|
| OIDC identity provider | Human authentication, token issuance, groups and roles claim | Directory identity and token claims |
| Workload identity issuer | Short-lived tokens for each service (Kubernetes API server, SPIRE, or an OIDC client-credentials issuer) | Token subject per service |
| Identity Registry | Map OIDC and workload subjects and deployment identities to Harness actor IDs, owners, lifecycle, and risk | Harness actor metadata |
| Ingress/auth middleware | Validate token, issuer, audience, signature, time, tenant, and required claims | Request authentication result |
| Authorization service | Evaluate action, resource, purpose, tenant, policy, assignment, compiled authority, and emergency state | AuthorizationDecision |
| PermissionEnvelope resolver | Resolve signed execution authority by digest | Runtime authority projection |
| OpenTelemetry SDK | Create and propagate spans, metrics, and structured log correlation | None; operational signal producer |
| OTLP collector | Redact, enrich, sample, batch, and route telemetry to backends | Pipeline configuration |
| Trace backend | Distributed trace, dependency, error, and performance analysis | Operational telemetry only |
| TraceLink service | Persist durable mapping among case/work/execution/command/event/evidence and traces | Correlation index |
| ExecutionRecord | Reproducible computational history | Forensic execution record |
| Case Ledger | Accepted business-state history | Business audit record |

# 3. Principal classes

| Principal class | Examples | Identity pattern |
|---|---|---|
| Human workforce | KYC analyst, supervisor, auditor, developer, SRE | OIDC user, groups and roles claim, IdP-enforced MFA and conditional access, just-in-time elevation for privileged roles |
| Platform workload | Control API, Case API, dispatcher, integration worker, compiler | One workload identity per service (service-account token, SPIFFE ID or OIDC client) |
| Agent | Screening, investigation, decision, QA agent | The runtime host's workload identity plus a per-invocation runtime grant and immutable AgentSpec; the agent holds no credential |
| Gateway/adapter | Capability Gateway, skill host, screening adapter | Separate workload identity per trust boundary; provider credentials only in the gateway |
| Automation | CI/CD, IaC deployment, security scanner | OIDC federation from the CI system, tied to repository/workflow/environment |
| External system | Business application, partner integration | OAuth 2.0 client credentials with explicit audience and role, or an HMAC-signed inbound webhook |
| Delegated user | Analyst action propagated to downstream API | The edge asserts the user under its own identity (`Edge.Delegate`); OAuth 2.0 token exchange only where the downstream must apply user authority itself |
| Emergency | Break-glass administrator, emergency revoker | Dedicated cloud-only identity, strong controls, no routine use |

One broad service principal for the platform is prohibited. Sharing identity across agents, services, tenants, or environments prevents least privilege, attribution, targeted revocation, and blast-radius control.

# 4. Identity Registry

The Identity Registry connects identity-provider and workload subjects to durable Harness actors. It does not replace the identity provider. It records ownership, actor type, environment, tenant scope, associated service/agent version, risk, approval status, credential mode, role assignments expected by IaC, and lifecycle.

```sql
create table identity.actor (
  actor_id uuid primary key,
  actor_type text not null,
  display_name text not null,
  environment text not null,
  tenant_scope jsonb not null,
  owner_group_id text not null,
  risk_class text not null,
  status text not null,
  created_at timestamptz not null,
  retired_at timestamptz
);

create table identity.principal_binding (
  binding_id uuid primary key,
  actor_id uuid not null references identity.actor(actor_id),
  issuer text not null,
  subject text not null,
  client_id text,
  principal_kind text not null,
  deployment_digest text,
  valid_from timestamptz not null,
  valid_to timestamptz,
  unique (issuer, subject, valid_from)
);
```

A token proves the active principal (issuer and subject). The registry explains which Harness actor that principal represents at that time. Actor bindings are versioned; retirement closes validity rather than deleting history. Ledger and authorization records store both actor ID and token principal identifiers or protected hashes.

# 5. Human identity lifecycle

Human access follows joiner, mover, and leaver automation from the enterprise identity source. Business roles map to identity-provider groups surfaced in the roles claim (`OIDC_ROLES_CLAIM`); direct user assignments are exceptional. Case assignments and purpose remain application data because infrastructure RBAC cannot express KYC queue and case semantics by itself.

Analysts use phishing-resistant multifactor authentication where policy requires it, and the identity provider's device, location and conditional-access policies. Supervisors, policy owners, release managers, auditors, privacy/legal users, developers, and SREs have separate roles. Production diagnostics and administrative actions use just-in-time elevation with justification, approval where configured, short activation, and access review.

Termination disables sign-in and group eligibility promptly. The platform invalidates sessions and refresh tokens according to risk. Open WorkItems are reassigned through business commands, preserving the former analyst as historical actor.

# 6. Workload and agent identity lifecycle

Workloads use platform-issued identity because token issuance and rotation are platform-managed: the orchestrator projects a short-lived token into each service (`WORKLOAD_TOKEN_FILE`, re-read as it rotates), and callees verify it against the issuer's JWKS. `WORKLOAD_IDENTITIES` maps every logical service to its subject; two services sharing a subject fail startup. Each service receives only the infrastructure roles and callee-declared platform roles needed for its function. Agents run inside the runtime host under its identity and remain constrained by the per-invocation runtime grant and the compiled PermissionEnvelope.

The lifecycle is `REQUESTED`, `PROVISIONED`, `ATTESTED`, `ACTIVE`, `SUSPENDED`, `REVOKED`, and `RETIRED`. Provisioning is IaC. Activation requires owner, environment, purpose, role review, network placement, expected deployment digest, and monitoring. Drift between the registry, the identity provider, orchestrator service accounts, `WORKLOAD_IDENTITIES`, and IaC generates an alert.

Agent identity is not agent authorization. The same agent identity may reach the Capability Gateway, but the gateway authorizes a capability only for the signed plan, WorkItem, tenant, case, purpose, data class, provider binding, budget, and revocation generation supplied in the request.

# 7. CI/CD workload federation

CI/CD presents the CI system's OIDC token to the deployment target (OIDC federation) rather than stored credentials. Trust is constrained by repository or project, branch/tag or protected environment, workflow identity, issuer, subject, and audience. Production deployment has a distinct federated trust and role assignment from non-production. This repository carries no delivery pipelines; they belong to the deployment.

The deployment identity may deploy images by digest and IaC but cannot approve Harness releases, register or approve artifacts, read production cases, or use KYC vendor tools unless an explicit separate duty requires it. Pipeline traceability stores source commit, workflow run, federated subject, deployment operation, artifact digest, and resulting infrastructure changes.

# 8. Authentication flows

| Scenario | Flow | Required checks |
|---|---|---|
| Analyst to Case API | Authorization code with PKCE | Tenant, issuer, audience, signature, time, role/scope, IdP authentication context |
| Service to service | Projected workload identity token | Issuer, audience, signature, time, subject mapped through `WORKLOAD_IDENTITIES`, callee-declared role |
| Runtime host to Capability Gateway | Runtime host workload identity plus signed execution envelope | Deployment/version, audience, envelope signature, plan, node, fence |
| CI/CD to deployment target | OIDC federation | Federated issuer/subject/audience and protected environment |
| Partner integration | OAuth 2.0 client credentials or HMAC-signed webhook | Tenant allowlist, role, client binding, quotas |
| User-delegated downstream action | Edge delegation (`Edge.Delegate`) or OAuth 2.0 token exchange | Original user authority plus service authority and downstream audience |

Token exchange is reserved for a middle tier calling a downstream API that must itself apply the requesting user's authority. It is not used when application authority is sufficient. A service identity cannot silently impersonate a user, and delegated identity cannot expand the service or PermissionEnvelope authority.

# 9. Token validation standard

Every API validates token signature from trusted metadata, issuer, exact audience, tenant, `nbf`, `iat`, `exp`, allowed client/application, subject/object ID, and required scopes or app roles. Multi-tenant acceptance is explicit. Clock skew is bounded. Tokens are never logged or persisted in telemetry.

The edge produces an internal AuthenticationContext with actor binding, token principal, client application, tenant, authentication method/context where available, issued and expiry times, delegation status, and validation result. Downstream services receive a signed or integrity-protected form over mutually authenticated/private channels and reauthorize locally.

Validation at an ingress gateway is defense in depth, not the only validation for internal services. High-value boundaries such as Case Command Gateway, Capability Gateway, Harness release, legal hold, and authorization administration validate independently.

# 10. Authorization model

Authorization combines several layers:

```text
Authenticated principal
  + platform/application role
  + tenant membership and resource assignment
  + action and object type
  + purpose of use
  + case/work assignment
  + data classification and jurisdiction
  + signed PermissionEnvelope for machine execution
  + pinned policy snapshot
  + current revocation/emergency controls
  + environment, region, deadline, lease and fencing
  = AuthorizationDecision + obligations
```

Infrastructure RBAC (cloud IAM, Kubernetes RBAC, database roles) controls resource and data-plane reachability. Identity-provider groups and the roles claim control coarse application roles. Neither is a replacement for domain authorization: the Harness authorization service enforces case, purpose, policy, evidence, command, capability, and effect semantics.

# 11. Policy decision contract

```json
{
  "decisionId": "authz_01...",
  "decisionVersion": "authorization.decision.v2",
  "principal": {
    "actorId": "actor_01...",
    "type": "AGENT",
    "issuer": "https://idp.example.com/realms/ehf",
    "subjectHash": "sha256:..."
  },
  "request": {
    "action": "capability.invoke",
    "resource": "screening.sanctions.search@3.2.0",
    "tenantId": "tenant_01...",
    "caseId": "case_01...",
    "purpose": "KYC_SCREENING",
    "dataClasses": ["PII"],
    "effectClass": "READ_ONLY"
  },
  "authority": {
    "planDigest": "sha256:...",
    "permissionEnvelopeDigest": "sha256:...",
    "policyDigest": "sha256:...",
    "revocationGeneration": 4812
  },
  "outcome": "ALLOW",
  "reasonCodes": ["ROLE_ALLOWED", "PURPOSE_ALLOWED", "PROVIDER_ALLOWED"],
  "obligations": ["REDACT_TELEMETRY", "RETAIN_EVIDENCE_7Y"],
  "evaluatedAt": "...",
  "expiresAt": "...",
  "traceId": "..."
}
```

The durable record excludes raw token and payload. It stores policy and authority digests, protected principal reference, target, decision, reasons, and obligations. A span records the decision ID and outcome but not the full policy input.

# 12. PermissionEnvelope

The Harness compiler creates a PermissionEnvelope for each resolved ExecutionProfile. It contains case selectors, allowed commands, tools, skills, capabilities, data classes, purposes, regions, provider classes, egress, retention, budgets, effect classes, and explicit prohibitions.

The envelope is signed or included by digest in the signed plan. Runtime services retrieve it by digest, verify signature and release scope, check revocation, and intersect it with current policy and actor authority. They do not broaden it through local configuration.

Human users normally receive dynamic domain authorization from roles, assignments, queue, purpose, and policy rather than an agent PermissionEnvelope. High-risk human workflows can issue a short-lived access grant with similar explicit scope and obligations.

# 13. Decision precedence and failure posture

Evaluation order is designed for safe and explainable denial:

1. Invalid authentication, issuer, audience, tenant, or token time denies.
2. Revoked actor, release, plan, capability, provider, policy, or key denies.
3. Environment, tenant, region, case, assignment, deadline, lease, or fencing mismatch denies.
4. Explicit prohibition denies.
5. Missing required role, scope, purpose, data-class, capability, command, effect, or evidence authority denies.
6. Policy rule evaluates allow/deny and obligations.
7. Budget, rate, concurrency, and risk controls may deny or step up.

Authorization outages fail closed for mutations, restricted data, model/tool calls, and high-assurance work. Low-risk read-only views may use a short-lived previously evaluated decision only if policy explicitly permits it and revocation freshness remains inside the bound.

# 14. Authorization enforcement points

| Boundary | Required enforcement |
|---|---|
| Control API | Authoring/release role, package scope, environment, separation of duties |
| Workflow Kernel | Plan, case, WorkItem, capability, assurance, lease, budget, revocation |
| Context Assembler | Case fields, evidence, purpose, data classes, tenant, trust partition |
| Agent Runtime | ExecutionProfile, PermissionEnvelope, allowed tools/commands, limits |
| Capability Gateway | Principal, capability/provider, purpose, data, effect, idempotency, region |
| Case Command Gateway | Principal, command, case, policy, evidence, concurrency, fencing |
| Evidence Store | Case/purpose/classification/retention/legal restriction and exact artifact |
| Human review UI/API | Queue/case assignment, role, authentication context, action, dual control |
| Observability query | Environment, dataset/table, incident/case purpose, field classification |

Network controls and infrastructure roles support these boundaries but do not replace application decisions.

# 15. Separation of duties and privileged access

| Duty | Required separation |
|---|---|
| Create identity | Cannot approve its production role assignment alone |
| Author policy | Cannot promote and waive its own failed evaluation |
| Release HarnessPlan | Cannot create evaluation attestation or alter signing key access |
| Operate Case Service | Cannot edit ledger or immutable audit export |
| Administer evidence storage | Cannot clear legal hold without legal workflow |
| Query production telemetry | Cannot automatically read raw case/evidence content |
| Investigate incident | Gets time-bound case/trace scope, not standing broad access |
| Emergency revoke | Can revoke rapidly but cannot create replacement authority alone |

Use just-in-time elevation, access reviews, approval, justification, time limits, alerts, and break-glass monitoring. Identity-provider administration, infrastructure administration and Harness platform roles are separate assignments and are reviewed separately.

# 16. Identity and access events

Material identity and authorization changes produce governed events: actor provisioned/suspended/retired, binding changed, role assigned/removed, privilege activated, access review decided, policy released/revoked, emergency grant issued/expired, authorization denied at critical boundary, break-glass used, and drift detected.

Identity-provider audit logs, orchestrator audit logs and infrastructure activity logs feed the security monitoring (SIEM) pipeline. Application authorization decisions required for business proof are persisted by the authorization service. Case Ledger events reference actor and decision IDs for accepted business mutations.

Events contain opaque or hashed identity references where broad security distribution does not require full identity. Authorized investigators resolve them through the Identity Registry.

# 17. Four linked records

The platform preserves four records with different guarantees.

| Record | Purpose | Sampling | Retention authority |
|---|---|---|---|
| OpenTelemetry | Performance, reliability, dependency, errors, capacity | Traces may be sampled; metrics not sampled | Observability policy |
| ExecutionRecord | Forensic computation: context, model, tools, output, usage | Never sampled | Execution/evidence policy |
| Case Ledger | Accepted material business transitions | Never sampled | Case retention/legal policy |
| ContextManifest | Exact governed information and trust partitions supplied to an agent | Never sampled for executed work | Execution/evidence policy |

OpenTelemetry alone cannot explain a decision because spans can be sampled, transformed, or expired. The ExecutionRecord alone does not prove that a proposal changed business state. The Case Ledger records acceptance and links the command, authorization decision, execution, evidence, and trace.

# 18. Correlation identifiers

| Identifier | Meaning | Created by | Durable locations |
|---|---|---|---|
| `case_id` | Canonical business aggregate | Case Service | Case, ledger, ExecutionRecord, restricted TraceLink |
| `case_sequence` | Ordered accepted state version | Case Service | Case and CaseEvent |
| `work_item_id` | Durable unit of work | Execution Control Plane | WorkItem, ExecutionRecord, TraceLink |
| `execution_id` | One execution attempt | Runtime dispatcher | ExecutionRecord, spans, TraceLink |
| `command_id` | One business intent submission | Caller/gateway | Command receipt, CaseEvent, TraceLink |
| `authorization_decision_id` | One policy evaluation | Authorization service | Decision store, span, command/capability record |
| `evidence_id` | Governed evidence object | Evidence service | Evidence metadata, lineage, CaseEvent |
| `context_manifest_id` | Governed model input set | Context Assembler | ContextManifest, ExecutionRecord |
| `trace_id` | One distributed operational trace | First instrumented boundary | Spans and TraceLink |
| `span_id` | One timed operation | Instrumented component | Span only, optional durable reference for key boundaries |
| `correlation_id` | Client-visible request support ID | Ingress | Response, logs, TraceLink; may map to trace ID or remain separate |

Business identifiers are stable and authoritative in their own systems. The trace can be missing and the business record remains valid. The business record stores enough trace linkage to locate telemetry when present.

# 19. How traceability to a case is established

Traceability is built at the first case-aware boundary and reinforced at every material transition.

1. Ingress validates the caller, creates or accepts valid W3C `traceparent`, and assigns a correlation ID.
2. The Case Service resolves the opaque case ID and tenant under authorization.
3. A restricted TraceLink row binds case ID, trace ID, root span ID, correlation ID, actor, purpose, service, and time.
4. The root span receives `harness.case.ref`, normally a protected hash or opaque non-PII reference; exact case ID is limited to the restricted telemetry path.
5. WorkItem creation stores source CaseEvent ID and trace ID; the queued message carries `traceparent`, `tracestate`, and the minimal correlation envelope.
6. The worker creates a consumer span linked to the producer span and binds WorkItem and execution IDs.
7. ContextManifest, ExecutionRecord, capability invocations, authorization decisions, evidence objects, command receipts, and CaseEvents store their own durable IDs plus trace ID.
8. The final CaseEvent records command, actor, authorization decision, execution, evidence references, and trace ID.
9. The TraceLink index provides bidirectional queries from case/sequence/event to trace and from trace to business records.

This creates audit-grade lineage even if operational spans are sampled: the CaseEvent and ExecutionRecord remain durable, and the TraceLink reports telemetry availability.

# 20. Correlation envelope

The correlation envelope travels beside W3C trace context. It is integrity-protected within trusted services and contains only routing-safe identifiers.

```json
{
  "version": "harness.correlation.v2",
  "tenantRef": "tn_h_...",
  "caseRef": "case_h_...",
  "caseSequence": 482,
  "workItemId": "wi_01...",
  "executionId": "exec_01...",
  "attempt": 2,
  "planDigestPrefix": "8f19c2a4",
  "purpose": "KYC_SCREENING",
  "classificationCeiling": "CONFIDENTIAL"
}
```

Do not put raw identifiers or authorization claims in W3C baggage because baggage propagates broadly and may reach third parties. The gateway strips internal headers before external provider calls and starts a sanitized dependency span. Provider correlation values are stored as protected hashes.

# 21. Trace topology

```text
harness.case.operation [SERVER root]
  authentication.validate
  authorization.evaluate
  case.query / case.command
  workflow.transition
    workitem.create
    messaging.publish [PRODUCER]
      ... async boundary ...
    messaging.consume [CONSUMER, linked]
      execution.dispatch
      context.assemble
      agent.execute
        model.inference
        skill.execute
        capability.invoke
          authorization.evaluate
          provider.call
          evidence.persist
      result.validate
      case.command
        authorization.evaluate
        ledger.append
        outbox.write
```

A trace represents one operational causal path, not the entire lifetime of a case. A case can have thousands of traces. A long workflow uses links among traces through WorkItem, event, and execution IDs rather than keeping one multi-day trace open.

# 22. W3C propagation and asynchronous messaging

HTTP and gRPC propagate `traceparent` and `tracestate` according to W3C Trace Context. Services reject malformed values and create a new root when trust policy requires it. They never accept business authority from trace headers.

Queued work is a PostgreSQL row (signalled with `NOTIFY`, recovered by polling) that stores trace context beside the WorkItem ID, attempt, deadline, and correlation envelope. The enqueue span is `PRODUCER`; the worker claim/process span is `CONSUMER`. Retries create new consumer spans linked to the same producer context and execution attempt. Dead-letter/replay adds links to the original row and operator/replay operation.

Integration events delivered to external systems carry trace context in CloudEvents extensions when supported. An outbox publisher creates a producer span linked to the database transaction's case-command span. A consumer processing the event creates its own trace or linked span according to retention and latency boundaries.

# 23. Span semantic conventions

Use standard OpenTelemetry attributes first, then a versioned `harness.*` namespace. High-cardinality business attributes are tightly controlled.

| Span family | Required attributes |
|---|---|
| All server/worker | `service.name`, `service.version`, `deployment.environment.name`, `cloud.region`, `harness.operation.id` |
| Case | `harness.case.ref`, `harness.case.type`, `harness.case.sequence.before/after`, command/event type |
| WorkItem | `harness.work_item.id`, type, attempt, priority, lease/fencing outcome |
| Agent | agent name/version/role, profile digest prefix, execution ID, outcome |
| Context | manifest ID, item counts by trust/classification, redaction count, token estimate |
| Model | logical profile, provider/deployment alias, input/output tokens, latency, finish class, cost estimate |
| Capability | capability/version, provider binding digest prefix, effect class, decision ID, status, billable units |
| Authorization | action, resource class, outcome, reason codes, policy digest prefix, cache status |
| Case command | command type, outcome, reason code, sequence before/after, event count |
| Evidence | evidence type, classification, size bucket, digest prefix, retention class, outcome |

Exact prompt, response, query, document, SSN, name, address, email, token, credential, evidence bytes, and policy-sensitive input are prohibited attributes. Digest prefixes identify versions but are not used as security proofs.

# 24. Span events, status, and exceptions

Use span events for meaningful milestones such as `budget.reserved`, `revocation.checked`, `policy.obligation.applied`, `provider.retry`, `evidence.registered`, `command.accepted`, and `ledger.committed`. Events carry bounded enums and counts.

Expected domain denials are recorded as normal authorization or command outcomes and may keep span status unset or `OK` with `harness.outcome=DENIED`. Infrastructure failures, malformed provider responses, unexpected exceptions, and violated platform invariants set error status. This distinction prevents legitimate denials from appearing as service failures while keeping them queryable.

Exception recording uses type, sanitized message, and stack trace according to environment and privacy policy. Exception messages are scrubbed because libraries may include URLs, queries, or identifiers.

# 25. Logs and structured events

Application logs are structured and correlate through trace and span context. Each event uses a stable event name and code, severity, service, environment, operation, outcome, and approved identifiers. Free-form string concatenation is avoided at controlled boundaries.

Logs do not duplicate span lifecycle noise. They record actionable state changes, warnings, retry exhaustion, drift, security signals, and operator actions. Audit-required authorization and business events go to their durable stores first; log export is secondary.

Security logs use a separate collector route and dataset access model. Debug logging in production is time-bound, approved, sampled, and redacted. Changing log level cannot enable payload or token logging.

# 26. Metrics

Metrics provide unsampled service and control health. Key metric families include request rate/error/duration, queue age/depth, WorkItem state, authorization allows/denies by reason class, token validation failure, permission cache age, revocation generation lag, model tokens/cost/latency, capability/provider latency and circuit state, command conflicts, case sequence lag, outbox delay, evidence throughput, trace export failure, dropped spans/logs, and telemetry ingestion volume.

Labels use bounded dimensions. Case ID, WorkItem ID, execution ID, user ID, command ID, trace ID, URL, prompt, provider correlation, and free-form reason are prohibited metric labels.

Service-level objectives derive from metrics and authoritative counters where needed. Billing and decision counts do not rely exclusively on sampled spans.

# 27. Sampling strategy

Metrics are not sampled. Business records are not sampled. Traces use parent-based ratio sampling at the source (`OTEL_TRACES_SAMPLER_ARG`), so the same W3C trace sampling decision propagates across services. Tail sampling in the collector, which keeps errors and slow traces, is the complement; backend ingestion sampling is a last resort.

Initial policy keeps 100 percent of security-sensitive control-plane changes, critical authorization denials, high-risk effect attempts, canary traffic, and incident-scoped traces through explicit routing or durable security events. Routine successful high-volume reads can be sampled. All errors and selected slow traces should be retained through supported processor/routing patterns, validated per language and exporter.

Daily caps are last-resort cost controls because a cap creates an observability gap. Alerts fire well before the cap. A gap never removes business proof because authorization decisions, ExecutionRecords, command receipts, and CaseEvents are separate.

# 28. TraceLink persistence model

```sql
create table observability.trace_link (
  trace_link_id uuid primary key,
  tenant_id uuid not null,
  case_id uuid,
  case_sequence bigint,
  work_item_id uuid,
  execution_id uuid,
  command_id uuid,
  case_event_id uuid,
  evidence_id uuid,
  authorization_decision_id uuid,
  trace_id char(32) not null,
  root_span_id char(16),
  link_type text not null,
  service_name text not null,
  purpose text not null,
  telemetry_class text not null,
  observed_at timestamptz not null,
  expires_at timestamptz,
  unique (trace_id, link_type, service_name, observed_at)
);

create index ix_trace_link_case
  on observability.trace_link (tenant_id, case_id, case_sequence, observed_at);
create index ix_trace_link_execution
  on observability.trace_link (execution_id, observed_at);
create index ix_trace_link_command
  on observability.trace_link (command_id, observed_at);
```

The restricted TraceLink API enforces tenant, case, incident, and purpose authorization. It returns business links even when the telemetry retention window expired, marking the span as unavailable rather than implying the action did not occur.

# 29. End-to-end case trace example

For `case_123`, a sanctions refresh begins with CaseEvent `evt_450` and WorkItem `wi_987`. The outbox publisher creates trace `T1` and a producer span. A worker later consumes the message, links to `T1`, and creates execution `exec_44`. Context assembly creates `ctx_22`. The agent requests capability invocation `cinv_81`; authorization creates decision `authz_66`; the provider result creates Evidence `ev_305`. The agent proposes command `cmd_91`; the Case Command Gateway authorizes and commits CaseEvent `evt_451` at sequence 483.

The durable chain is:

```text
case_123@482 -> evt_450 -> wi_987 -> exec_44 -> ctx_22
             -> authz_66 -> cinv_81 -> ev_305 -> cmd_91
             -> evt_451 -> case_123@483
```

The operational trace shows timing and dependencies for the processing path. If the trace was sampled out or expired, the ExecutionRecord, authorization decision, evidence, command receipt, and ledger events still prove what occurred.

# 30. Authorization observability

Every authorization evaluation emits a low-cardinality metric and a span/event with decision ID, action class, resource class, outcome, reason codes, policy digest prefix, cache state, latency, and revocation generation. The full normalized input and decision are stored only when required in the authorization decision store.

Dashboards show deny rate by boundary and reason, missing/expired authority, tenant mismatch, stale fencing, revoked subject, policy evaluation errors, cache freshness, privileged elevation, emergency access, and role drift. Alerts distinguish attacks, application defects, stale deployment, user entitlement issues, and dependency outages.

An unexpected allow is a critical incident. Reconciliation samples allowed actions and proves a matching actor binding, authority, decision, and downstream record. Test canaries continuously attempt prohibited actions and must be denied.

# 31. Model, agent, and capability observability

Model spans record logical profile, approved deployment alias, model API version, token counts, latency, finish class, safety outcome, retry/fallback, and estimated cost. They do not include prompt or response content. ExecutionRecord references the governed artifacts when retention permits.

Agent spans record AgentSpec and runtime version, ExecutionProfile digest, iteration count, model/tool call counts, budget consumption, stop reason, and result validation. Capability spans record capability version, provider binding digest, effect class, authorization decision, attempt, circuit, provider latency, evidence result, and normalized error class.

Fallback produces explicit child spans and a flight-recorder event. It cannot be hidden in an adapter. The trace and ExecutionRecord show why fallback was allowed and which evaluated provider produced the evidence.

# 32. Data protection for telemetry

Telemetry has a classification profile and attribute allowlist. Default classification is internal operational metadata. Exact case references, user subjects, network details, stack traces, and security events use restricted datasets and narrower retention/access.

A telemetry processor drops or hashes prohibited attributes before export. It normalizes URLs to route templates, strips query strings and headers, scrubs exception messages, limits event size, and rejects dynamic attribute names. Automated tests inject seeded PII and secrets and assert none reaches exported telemetry.

Services export only to the collector over private network paths with TLS. The collector, not each service, holds backend credentials, so a service never carries a vendor ingestion key.

# 33. Telemetry access and investigation

Access separates platform operations, application support, security operations, audit, privacy/legal, and engineering. Most operators see aggregate dashboards and sampled traces without exact case identity. Case-specific investigation requires a ticket/incident, purpose, time-bound role, and TraceLink authorization.

The investigator begins from an approved case, event, command, or execution ID. The TraceLink service returns trace IDs in scope. The trace backend retrieves spans. Artifact access remains a separate Evidence/Execution authorization and is not granted merely because a trace is visible.

Exports for regulators or litigation are assembled from Case Ledger, Evidence, ContextManifest, ExecutionRecord, AuthorizationDecision, Identity Registry, and available traces. The package labels telemetry as operational and identifies sampling/retention limits.

# 34. OTLP collector

Every service exports OTLP (`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`; `OTEL_EXPORTER_OTLP_PROTOCOL` selects `grpc`, `http/protobuf` or the default `http/json`) to an OpenTelemetry Collector run per environment. The platform ships no vendor exporter. The collector applies the redaction processor as a second line behind source instrumentation, tail sampling, batching, and routing to whatever backends the operator runs (Jaeger, Tempo, Prometheus, Loki, Elastic, a commercial APM, or a cloud provider's OTLP endpoint) and to the security pipeline. Production and non-production never share a collector, backend credential, or dataset. Locally the compose stack exports straight to Jaeger.

# 35. OpenTelemetry deployment standard

Services use the OpenTelemetry SDK with the OTLP exporter through one platform bootstrap package (`@ehf/telemetry`). The package configures resource attributes, propagation, sampler, redaction processor, exception policy, HTTP/database/messaging instrumentation, service version, environment, region, and exporter health.

Auto-instrumentation provides baseline HTTP, database, and messaging spans. Manual spans describe Harness semantics such as policy evaluation, context assembly, agent execution, evidence registration, case command, and ledger append. Instrumentation libraries are versioned and tested across languages.

Exporter failure is observable through local metrics/logs and does not fail business processing unless a high-risk workflow explicitly requires a durable proof record, which is written outside telemetry. Buffers are bounded. Telemetry backpressure cannot exhaust service memory or delay case commands indefinitely.

# 36. Alerting and SLOs

| Objective | Proposed target | Alert |
|---|---|---|
| Token validation availability | 99.99 percent at protected boundaries | Burn rate and any broad bypass symptom |
| Authorization service availability | 99.95 percent monthly | Multi-window burn rate |
| Authorization latency | p95 under 40 ms cached; under 150 ms uncached | Sustained threshold by boundary |
| Revocation propagation | 99.9 percent under 60 seconds | Any production component stale over 60 seconds |
| Trace propagation | 99.5 percent of sampled internal requests retain parentage/link | Orphan ratio over threshold |
| Critical durable correlation | 100 percent accepted commands have decision/execution/trace link where applicable | Any reconciliation gap |
| Telemetry PII leakage | Zero known prohibited values | Any DLP canary match |
| Export health | 99.9 percent batches exported inside five minutes | Queue/drop/export error threshold |
| Clock synchronization | Maximum skew within approved bound | Host/service skew alert |

Page immediately on unexpected authorization allow, break-glass use, privilege escalation drift, disabled token validation, revocation staleness, telemetry secret/PII canary, missing ledger-decision linkage, or systemic trace propagation break.

# 37. Cost and cardinality controls

Attribute and metric cardinality budgets are part of service readiness. Case, WorkItem, execution, command, trace, user, and evidence identifiers are not metric dimensions. Span retention and sampling vary by environment and risk. Large stack traces, exception bursts, dependency URLs, and repeated retries are bounded.

Budgets are monitored by service, environment, table, signal type, and release. Sudden ingestion growth creates an engineering incident before daily cap. Data collection transformations can drop unapproved fields, but source instrumentation remains the primary control.

Retention tiers distinguish hot operational analysis, longer security investigation, and durable business/forensic records. Moving all spans to long-term storage is not a substitute for an ExecutionRecord and creates unnecessary privacy and cost exposure.

# 38. KYC identity and traceability rules

KYC analysts have roles for intake, review, enhanced due diligence, disposition approval, quality assurance, audit, and supervision. Queue/case assignment and jurisdiction are checked in the application. High-risk overrides and selected dispositions require step-up or dual control.

Agent identities are separate for screening, investigation, decision recommendation, and QA where deployment permits. Their PermissionEnvelopes differ. A screening agent cannot acquire decision or evidence-download authority merely because it shares a runtime deployment.

For each final disposition, the audit query must return:

- Effective CaseEvent and case sequence.
- Human/system actor and identity-provider/Harness identity binding valid at the action time.
- AuthorizationDecision, policy snapshot, and reason/obligations.
- DecisionRecommendation and DecisionGateResult.
- WorkItems and executions that produced relevant findings.
- ContextManifests, model/tool profiles, capability calls, and evidence lineage.
- Commands accepted or rejected and concurrency/idempotency results.
- Available operational traces and declared sampling/retention status.

# 39. Example forensic query path

An auditor starts with final disposition `disp_77`. The Case Ledger returns `evt_900`, sequence 612, command `cmd_812`, actor `actor_42`, decision `authz_702`, policy digest, recommendation, gate result, evidence references, execution IDs, and trace IDs.

Identity Registry resolves `actor_42` to the principal binding (issuer and subject) that was valid at the event time. Authorization store returns the evaluated action, resource, purpose, role, PermissionEnvelope where applicable, outcome, reason codes, obligations, and revocation generation. ExecutionRecords resolve ContextManifests, model/tool versions, results, and usage. Evidence lineage returns the source chain. TraceLink returns trace IDs for timing and dependency analysis in the trace backend.

Each hop verifies tenant, case, identifier, digest, sequence, and temporal validity. Missing sampled telemetry is reported as `TELEMETRY_NOT_RETAINED`; it does not invalidate the durable audit chain.

# 40. APIs

| Endpoint | Purpose | Authorization |
|---|---|---|
| `GET /v1/actors/{id}` | Resolve actor metadata and historical bindings | Identity auditor or authorized service |
| `POST /v1/authorization:check` | Evaluate one action/resource/context | Authenticated service with allowed policy domain |
| `POST /v1/authorization:batchCheck` | Evaluate bounded field/object set | Strict item and size limits; same tenant/purpose |
| `GET /v1/authorization/decisions/{id}` | Read normalized decision | Resource/case/security purpose |
| `POST /v1/access-grants` | Issue short-lived scoped human grant | Approved privileged workflow |
| `POST /v1/revocations` | Revoke actor/grant/authority | Emergency revoker or governed admin |
| `POST /v1/trace-links` | Register durable business-to-trace relationship | Trusted service identity only |
| `GET /v1/cases/{id}/trace-links` | Find trace links for case/sequence/time | Case-specific diagnostic purpose |
| `GET /v1/traces/{traceId}/business-links` | Resolve governed business records | Restricted diagnostic/audit role |
| `POST /v1/audit-packages` | Assemble cross-record proof package | Audit/legal workflow and case scope |

Authorization check requests require idempotent decision correlation but are not cached solely by caller. Cache keys include principal binding, action, resource, tenant, purpose, authority digests, policy, revocation generation, and relevant context version.

# 41. Persistence model

```sql
create table authorization.decision (
  decision_id uuid primary key,
  actor_id uuid not null,
  action text not null,
  resource_type text not null,
  resource_ref_hash text not null,
  tenant_id uuid not null,
  case_id uuid,
  purpose text not null,
  outcome text not null,
  reason_codes text[] not null,
  obligations jsonb not null,
  policy_digest text not null,
  permission_envelope_digest text,
  revocation_generation bigint not null,
  trace_id char(32),
  evaluated_at timestamptz not null,
  expires_at timestamptz
);

create table authorization.access_grant (
  grant_id uuid primary key,
  actor_id uuid not null,
  scope jsonb not null,
  purpose text not null,
  status text not null,
  issued_by uuid not null,
  approved_by uuid,
  issued_at timestamptz not null,
  expires_at timestamptz not null,
  revoked_at timestamptz
);
```

High-volume read decisions may use shorter durable retention or aggregated evidence according to risk. Mutation, capability effect, evidence access, disposition, release, legal hold, and privileged decisions retain full normalized records for their governing period.

# 42. Deployment identity and observability configuration

| Component | Identity configuration | Observability configuration |
|---|---|---|
| Ingress gateway (optional) | Its own workload identity; OIDC JWT validation; admin roles separated | Payload logging disabled, correlation headers controlled |
| Service containers | One workload identity per service (`WORKLOAD_TOKEN_FILE`), callee-declared roles | OTLP exporter, environment/service version attributes, bounded buffers |
| Runtime host | `harness-runtime` identity plus a per-invocation runtime grant it cannot mint | Execution ID and profile correlation on every span |
| Work queues | PostgreSQL queue tables signalled with `NOTIFY`; a queue-depth autoscaler (KEDA PostgreSQL scaler) | Queue depth/age metrics, dead-letter alerts |
| PostgreSQL | `DATABASE_AUTH=url` with `PGPASSFILE` or a TLS client certificate; per-service database roles | Connection/query metrics, sanitized dependency spans, audit configuration |
| Object storage (when used) | Narrowly scoped credentials for the evidence boundary only | Request/dependency metrics, no object content |
| Signing keys | RSA private key mounted as a file per signer; verifiers receive only the public key | Secret-manager access logs to the security pipeline, alert on unusual reads |
| Integration secrets | `env:` or `file:` references resolved only by the consuming service | Resolution failures as bounded error codes, never values |
| OTLP collector | Holds backend credentials; separate per environment | Redaction, tail sampling, routing, retention/export |

# 43. CI/CD and policy as code

Identity-provider client registrations, CI federation trusts, service accounts and `WORKLOAD_IDENTITIES` mappings, role assignments, ingress policies, collector configuration, dashboards, alerts, and retention settings are IaC, maintained with the deployment rather than in this repository. Application roles and authorization policies are versioned with tests.

```text
pull request
 -> identity/role/policy lint
 -> least-privilege and separation-of-duty tests
 -> OTel semantic and redaction tests
 -> trace propagation integration tests
 -> IaC security + what-if/plan
 -> deploy nonprod through federation
 -> authorization conformance and negative tests
 -> PII/secret telemetry canary
 -> load, sampling, retention and cost tests
 -> production approval and deploy by digest
 -> post-deploy identity/role/diagnostic reconciliation
```

Policy changes include semantic diff: new principals, roles, actions, resources, data classes, purposes, effects, regions, or allow rules. Authority expansion requires additional approval and evaluation.

# 44. Implementation plan

| Phase | Duration | Deliverables and exit criteria |
|---|---|---|
| 0. Taxonomy and threat model | 2 weeks | Principal classes, action/resource model, correlation semantics, data classification, threat model, ADRs |
| 1. Identity foundation | 3 weeks | OIDC client registrations, workload identity issuer and service accounts, groups/roles claim, CI federation, just-in-time elevation, registry |
| 2. Authorization service | 5 weeks | Decision API, policy engine, PermissionEnvelope resolution, cache, revocation, decision store |
| 3. Enforcement integration | 5 weeks | Ingress, control, workflow, context, runtime, capability, case, evidence, human-review boundaries |
| 4. OTel platform | 4 weeks | Bootstrap library, semantic conventions, redaction, propagation, OTLP collector and backends |
| 5. Durable traceability | 4 weeks | TraceLink service, ExecutionRecord/CaseEvent links, case/trace queries, audit package assembly |
| 6. Dashboards and alerts | 3 weeks | SLOs, identity/access dashboards, trace quality, cost, security and KYC views |
| 7. KYC pilot | 4 weeks | Analyst/agent identities, end-to-end authorization and disposition traceability, adversarial tests |
| 8. Hardening and operations | 3 weeks | Load, outage, PII canary, break-glass, access review, incident and recovery exercises |

# 45. Prioritized engineering backlog

| ID | Work item | Acceptance criterion |
|---|---|---|
| IA-01 | Define actor and principal taxonomy | Every human/workload/agent path maps to one versioned actor binding |
| IA-02 | Provision workload identities and roles through IaC | No shared broad production principal; distinct subjects per service; drift is detected |
| IA-03 | Implement CI/CD federation | Production deploys without stored client secret and with protected subject constraints |
| IA-04 | Build Identity Registry | Historical actor-to-subject/deployment binding resolves at event time |
| AZ-01 | Define action/resource/purpose schema | All platform boundaries use stable, versioned authorization vocabulary |
| AZ-02 | Implement decision service | Exact input produces explainable outcome, reasons, obligations, and durable decision ID |
| AZ-03 | Integrate PermissionEnvelope and revocation | Machine authority cannot exceed signed plan and is fenced under 60 seconds |
| AZ-04 | Implement human case/queue authorization | Tenant, assignment, role, purpose, jurisdiction, and field access are enforced |
| AZ-05 | Add just-in-time elevation/access review/emergency controls | Privileged use is time-bound, reviewed, alerted, and correlated |
| OB-01 | Publish Harness OTel semantic convention | Cross-language fixtures emit the same required attributes and span topology |
| OB-02 | Implement redaction processor | Seeded PII, tokens, secrets, payloads, and query strings never export |
| OB-03 | Propagate W3C context over HTTP and messaging | Sampled traces maintain parentage/links across retries and outbox paths |
| OB-04 | Build TraceLink service | Case/event/work/execution/command/decision/evidence resolve bidirectionally to traces |
| OB-05 | Integrate durable records | Accepted CaseEvent links actor, decision, execution, evidence, command, and trace |
| OB-06 | Configure the OTLP collector topology | Production export uses private TLS paths to a per-environment collector that alone holds backend credentials |
| OB-07 | Implement sampling and cost policy | Trace completeness and critical retention meet targets within budget |
| SEC-01 | Build unexpected-allow and PII canaries | Any accepted prohibited action or exported seeded secret pages immediately |
| KYC-01 | Produce disposition audit package | One query reconstructs identity, authority, computation, evidence, ledger, and telemetry links |

# 46. Verification strategy

Unit tests cover token claim validation, actor binding, role/action/resource mapping, policy precedence, PermissionEnvelope intersection, revocation, decision reasons/obligations, cache keys, correlation headers, attribute allowlists, redaction, and TraceLink constraints.

Contract tests run for every enforcement point and identity class. Negative cases include wrong audience, tenant, issuer, expired token, unbound principal, suspended actor, missing role, wrong purpose, cross-case access, stale plan, revoked capability, stale fencing token, stronger effect, and unauthorized telemetry query.

Trace tests exercise synchronous HTTP, nested services, PostgreSQL queue enqueue/claim with `NOTIFY` and poll recovery, duplicate delivery, retries, dead-letter/replay, outbox publishing, model/tool dependencies, and provider header stripping. They verify parentage, links, execution attempts, durable record references, and sampled-trace behavior.

Data-loss tests sample out traces, expire backend retention, fail the exporter, reach a test cap, and make the collector unreachable. Case Ledger, ExecutionRecord, ContextManifest, AuthorizationDecision, and TraceLink still reconstruct the business path and label missing telemetry accurately.

Privacy tests seed SSNs, names, emails, tokens, API keys, prompts, documents, query strings, and provider payloads into all inputs and exceptions. No prohibited value may appear in exported spans, logs, metrics, dashboards, alerts, or workbooks.

# 47. Operational runbooks

Required runbooks cover token validation outage, identity-provider metadata/JWKS refresh, workload token projection failure, CI federation failure, signing-key rotation, unexpected authorization allow, deny spike, authorization latency/cache failure, revocation lag, elevation/break-glass use, role drift, compromised principal, trace propagation break, exporter backlog, dropped spans, collector or backend outage, private DNS failure, ingestion spike/cap risk, PII/secret canary, missing TraceLink, and audit-package inconsistency.

Each runbook states detection, impacted boundaries, immediate containment, identity or policy revocation, safe cache behavior, diagnostic queries, evidence preservation, recovery, communication, and verification. Operators never bypass authorization to restore service or enable payload logging as a first diagnostic step.

# 48. Architecture decisions and definition of done

The initial decisions approve OpenID Connect for people and platform-issued workload identity for services; one identity per service/agent trust boundary; mounted private keys for signing and `env:`/`file:` references for secrets; application authorization layered above infrastructure RBAC; PermissionEnvelope as machine-execution authority; deny/revocation precedence; W3C Trace Context; versioned Harness OTel conventions; a restricted TraceLink index; and separate OpenTelemetry, ExecutionRecord, ContextManifest, and Case Ledger records.

Production pilot readiness requires all of the following:

- Every human, workload, agent, gateway, adapter, and automation path has a unique governed identity and historical actor binding.
- No production service holds a static service token, shared HMAC secret, or password-bearing database URL; the production security profile refuses them at startup.
- Every protected action produces an explainable decision with actor, action, resource, tenant, purpose, policy, authority, outcome, reasons, and obligations.
- Agent authority cannot exceed the signed PermissionEnvelope even when infrastructure access exists.
- Revocation reaches enforcement points in under 60 seconds and stale authority fails closed.
- W3C context propagates across HTTP, messaging, retries, outbox, agent, model, capability, case command, and ledger boundaries.
- Every accepted case mutation links the CaseEvent to actor, authorization decision, command, execution, evidence, and trace where applicable.
- A final disposition can be reconstructed from case and durable proof records without relying on retained sampled spans.
- Telemetry contains no seeded prohibited PII, secret, token, prompt, document, or provider payload.
- SLOs, sampling, collector private paths, access controls, retention, cost alerts, break-glass, incident response, and audit package generation are tested.
- Security, IAM, privacy, KYC policy, audit, platform, SRE, and operations owners approve the evidence and ownership model.

The result is a platform where every consequential action has a known actor, bounded authority, explainable decision, durable business lineage, and an operational trace that can be followed from request to case outcome without confusing telemetry with truth.
