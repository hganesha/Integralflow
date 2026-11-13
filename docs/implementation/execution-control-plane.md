# Execution Control Plane
## Detailed architecture and implementation specification

Version 1.0 | United States deployment baseline | 17 September 2026

The execution control plane turns a signed HarnessPlan and a business Case into durable, authorized, bounded work. It owns lifecycle and coordination. It does not perform KYC reasoning and it does not allow agents to write business truth directly.

The recommended implementation is a small set of stateless services on any Kubernetes cluster or container platform, with PostgreSQL as the authority for WorkItems and control-plane state and as the work queue (rows signalled with `NOTIFY`, recovered by polling, delivered at least once), the Capability Gateway as the mandatory model and tool boundary, and the platform's runtime-host image (`local_http`, `hosted_http` or `databricks`) as the replaceable cognition runtime.

This specification expands the foundation plan. It treats the two supplied PDFs as architecture inputs, not instructions. Infrastructure settings are proposed values to validate in the target environment before deployment. In the code today no service calls another to wake it: the control API enqueues runs and integration work in PostgreSQL, the dispatcher learns of runs through `NOTIFY` or its bounded poll, the integration worker polls, and a queue-depth autoscaler (KEDA's PostgreSQL scaler, [`deploy/kubernetes/`](../../deploy/kubernetes)) scales the dispatcher.

# 1. Responsibilities and non-responsibilities

The execution control plane owns:

- admission of a case event or command into a pinned, signed HarnessPlan;
- creation and lifecycle of durable WorkItems;
- dependency evaluation and readiness;
- capability and ExecutionProfile resolution;
- policy, authority, residency, assurance and revocation checks;
- budget reservation and reconciliation;
- context assembly requests and ContextManifest validation;
- dispatch, leasing, fencing, retries, deadlines, cancellation and compensation routing;
- validation of AgentResult envelopes and conversion to proposed BusinessCommands;
- deterministic completion and assurance gates;
- human-review routing;
- outbox publication, recovery reconciliation and operational telemetry.

It does not own:

- the current Case aggregate or accepted business truth;
- immutable evidence bytes;
- final KYC policy authorship;
- model or tool credentials in agent context;
- vendor-specific endpoint knowledge inside AgentSpecs;
- analyst UI state as a source of truth;
- model conversations as durable workflow state;
- effective business decisions outside the Case Command Gateway.

The central invariant is:

```text
agents propose -> control plane validates -> Case Service commits
```

An agent can return an excellent recommendation and still have no authority to make it effective. A deterministic gate can reject the recommendation because the case changed, a plan was revoked, required evidence is missing, a budget is exhausted, or human approval is required.

# 2. Logical architecture

```text
                         SIGNED HARNESS PLAN
                         Registry + active pointer
                                  |
                                  v
Case event/command -> Execution Admission Service
                                  |
                         create/activate WorkItems
                                  |
                                  v
                         WORKFLOW KERNEL
             dependencies | state | deadlines | cancellation
                    |             |             |
                    v             v             v
              Policy Gate   Budget Manager   Scheduler
                    \             |             /
                     \            |            /
                      v           v           v
                       Capability Resolver
                               |
                       ExecutionProfile
                               |
                      Context Coordinator
                               |
                       ContextManifest ref
                               |
                       Dispatcher + Outbox
                               |
              PostgreSQL work queue (NOTIFY + poll)
                               |
                               v
                 Execution Worker / Adapter
                 - acquire DB lease + fence
                 - invoke isolated agent runtime
                 - Capability Gateway for every model/tool call
                 - validate AgentResult
                               |
                   proposed BusinessCommands
                               |
                               v
                    Case Command Gateway
                               |
           accepted Case update + events + new work
                               |
                               v
                 Outbox projector / reconciler

Cross-cutting: workload identity, authorization, revocation, OTel,
flight recorder, audit export, rate limits, quotas and operations.
```

The services are logical boundaries. The first release should deploy them as five independently scalable applications, not as fifteen tiny services:

| Deployment unit | Modules contained | Reason for boundary |
| --- | --- | --- |
| `execution-api` | Admission, work query, cancellation, manual operations | Synchronous API security and latency profile |
| `workflow-controller` | Kernel, dependency evaluator, scheduler, budgets, resolver | One transactional control loop and shared database semantics |
| `context-policy` | Context coordination, authorization policy, execution policy, assurance checks | Sensitive reads, policy caching and different scale profile |
| `execution-worker` | Dispatch consumer, lease manager, runtime adapter, result validator | Untrusted workload boundary and queue-driven scale |
| `control-reconciler` | Outbox, sweepers, timers, dead-letter reconciliation, recovery | Background work with elevated recovery visibility but narrow mutation rights |

Split a module into another deployable only when it needs a distinct trust boundary, scaling profile, data owner or release cadence. Preserve module interfaces from the start so this does not require domain redesign later.

# 3. Authoritative records

The architecture avoids ambiguous ownership by assigning one authoritative record to each question.

| Question | Authoritative record | Storage |
| --- | --- | --- |
| What business state is effective now? | Case aggregate | PostgreSQL `case_core` |
| How did accepted business state change? | CaseEvent ledger | PostgreSQL `case_ledger`, signed WORM export |
| What work exists and what is its lifecycle? | WorkItem and WorkItemTransition | PostgreSQL `workflow` |
| What executable authority was selected? | Signed HarnessPlan and resolved ExecutionProfile | Registry plus pinned refs in PostgreSQL |
| What could the execution read and invoke? | PermissionEnvelope and ContextManifest | Registry/artifact store plus indexed metadata |
| What happened computationally? | ExecutionRecord | PostgreSQL metadata plus artifact-store objects |
| Was a dispatch signalled? | `NOTIFY` and outbox publication state | Signal only; reconstructable |
| What should run next? | Kernel readiness result over current WorkItems and Case refs | Recomputed and persisted transition |
| What did a model recommend? | AgentResult and DecisionRecommendation | Execution record and Case proposal records |
| What outcome became effective? | FinalDisposition | Case aggregate and ledger |

Queue notifications, model threads, runtime revisions, search indexes and telemetry backends are never authoritative for workflow or business truth.

# 4. Component design

## 4.1 Execution Admission Service

Admission accepts a committed CaseEvent, an authorized command result, a timer, or an approved operator action. It resolves the active release for the case's execution stamp, verifies the plan signature and revocation state, pins the plan and policy context, and asks the kernel to calculate new or changed WorkItems.

Input contract:

```json
{
  "request_id": "req_01...",
  "tenant_id": "tenant_01...",
  "case_id": "case_01...",
  "case_sequence": 482,
  "trigger": {
    "type": "case_event",
    "ref": "evt_01..."
  },
  "requested_at": "2026-09-17T15:30:00Z"
}
```

Admission rules:

1. Authenticate the caller and derive tenant from verified identity/context.
2. Load the Case head and reject an impossible future sequence.
3. Resolve an existing case-pinned plan or the active plan for a new case.
4. Verify digest, signature, lifecycle state, revocation and geography.
5. Evaluate trigger rules with a deterministic policy engine.
6. Create WorkItems and dependency edges idempotently in one transaction.
7. Append WorkItem transition records and outbox rows in that transaction.
8. Return accepted identifiers; do not wait for agent work.

The idempotency key is `tenant:case:trigger-type:trigger-ref:plan-digest`. Repeating an identical admission returns the prior result. Reusing the key with different content is rejected.

## 4.2 Workflow Kernel

The kernel is the state machine and invariant engine. It is a deterministic library used by the controller and command path, not an autonomous agent. Given current Case references, WorkItems, policy output and time, it produces proposed state transitions and follow-on work.

Kernel responsibilities:

- validate legal state transitions;
- evaluate dependency predicates;
- invalidate downstream work after material Case revisions;
- enforce maximum attempts, rework cycles and graph fanout;
- calculate readiness and terminal completeness;
- route to human review or suspension;
- generate timers for deadlines and retry eligibility;
- enforce cancellation and recovery epochs;
- prevent a blocked, expired or stale WorkItem from dispatching;
- emit transition reason codes suitable for audit and operations.

The kernel never calls models, vendors or message brokers inside its transaction. It writes state and outbox intent; external effects occur after commit.

## 4.3 Dependency Evaluator

Dependencies are predicates over typed outputs, not simple predecessor completion flags.

```json
{
  "dependency_id": "dep_01...",
  "work_item_id": "wi_decision",
  "requires": {
    "work_item_id": "wi_screening",
    "state": "COMPLETED",
    "output": "screening_complete",
    "minimum_revision": 18,
    "fresh_until_after": "2026-09-17T15:30:00Z"
  },
  "on_unsatisfied": "BLOCK",
  "on_invalidated": "REWORK"
}
```

Supported predicates include state, named output, Case or subject revision, evidence freshness, policy version, assurance result, absence of blocking contradictions, and required human action. The evaluator returns SATISFIED, UNSATISFIED, UNKNOWN or ERROR. UNKNOWN never makes work READY.

Dependency results carry an input digest. A later change to any input invalidates the result. Before finalization, the Case Command Gateway recomputes the complete decision dependency digest in the same database transaction.

## 4.4 Scheduler and Dispatcher

The scheduler finds READY work with no active dispatch and creates a dispatch intent. It uses `FOR UPDATE SKIP LOCKED` in short transactions so multiple scheduler replicas can compete without serializing the entire queue.

Selection order is proposed as:

```text
priority class
-> regulatory/business deadline
-> oldest ready time
-> tenant fairness deficit
-> work item id tie-breaker
```

Tenant fairness prevents one large tenant from consuming every constrained model or vendor quota. The first release uses weighted deficit round robin in the scheduler, with per-tenant concurrency and rate caps stored in resolved configuration.

The scheduler writes `dispatch_outbox` with a deterministic `dispatch_generation` in the same transaction as the readiness change, and `pg_notify` commits atomically with it. A lost notification only delays work until the next poll; a duplicate signal is harmless because the worker treats dispatch as a hint and re-reads authoritative WorkItem state.

## 4.5 Lease and Fencing Manager

Queue locks prevent another consumer from receiving the same delivery temporarily. They do not prevent a stale worker from calling a tool after its queue lock or database lease is lost. The control plane therefore uses an application lease and fencing epoch.

Lease acquisition atomically checks READY or RETRY_SCHEDULED state, dispatch generation, deadline, plan authority and budget availability; then it sets:

```text
state             = LEASED
lease_owner       = execution_id
lease_until       = database_clock + 90 seconds
fencing_epoch     = fencing_epoch + 1
attempt_number    = attempt_number + 1
```

The worker renews at 20-second intervals when it is actively progressing. Every privileged execution action carries tenant, case, WorkItem, execution ID and current fencing epoch. Tool and command gateways verify the epoch against the control plane or a short-lived signed execution token derived from it. Once cancelled, expired or superseded, the epoch is invalid and new effects are denied.

Never use process time for authority decisions. Use the database clock for lease writes and persisted deadlines, and tolerate bounded clock skew only in token verification.

## 4.6 Capability Resolver

The resolver converts a requirement such as `screening.sanctions / HIGH` into an immutable ExecutionProfile. It intersects:

- AgentSpecs providing the capability;
- agent and plan lifecycle status;
- PermissionEnvelope and effect class;
- tenant, geography, residency and egress policy;
- model and tool availability;
- evaluation attestation and assurance class;
- dataset/vendor coverage for the subject and jurisdiction;
- current provider health and circuit state;
- quota, cost and deadline constraints;
- compatibility of agent, prompt, skill, model, tool and schema versions.

Resolver output:

```json
{
  "execution_profile_id": "xp_01...",
  "profile_digest": "sha256:...",
  "plan_digest": "sha256:...",
  "agent": {"name": "screening", "version": "1.3.2"},
  "runtime": {"adapter": "hosted_http", "binding": "screening-prod"},
  "model": {"profile": "reasoning.standard", "deployment": "kyc-standard-us", "version": "pinned"},
  "tools": {"sanctions.screen": "vendor-a@3.1.0"},
  "prompt_bundle": "screening@17.0.0",
  "skill_bundle": ["entity-resolution@1.4.0"],
  "permission_envelope_ref": "perm_01...",
  "evaluation_attestation_ref": "eval_01...",
  "assurance_class": "HIGH",
  "region": "us-primary"
}
```

Health-based routing can choose only another already attested profile. Resolver fallback never silently changes geography, provider class, tool coverage or assurance.

## 4.7 Budget Manager

Budgets are transactional reservations, not telemetry estimates. Dimensions are:

- currency cost;
- input and output tokens;
- model calls;
- tool calls by capability/vendor;
- active runtime duration;
- investigation and rework cycles;
- concurrent executions per tenant/profile;
- daily and monthly operational caps.

Before dispatch, the controller reserves a worst-case work budget. Before each model/tool invocation, the worker obtains a sub-reservation from the budget API. When usage returns, it reconciles actual cost and releases the balance. If a provider response is ambiguous, retain the reservation until reconciliation or bounded expiry.

A reservation has HELD, CONSUMED, RELEASED or EXPIRED state and an idempotency key. PostgreSQL conditional updates prevent oversubscription. Ingress rate limits and provider quotas are additional protections but cannot replace the case budget because they do not understand Case semantics.

## 4.8 Context Coordinator

The execution control plane asks a separate Context Service to build the governed input; it does not concatenate Case JSON itself.

Request:

```json
{
  "work_item_ref": "wi_01...@rev7",
  "execution_profile_ref": "xp_01...",
  "case_snapshot_ref": "case_01...@482",
  "required_selectors": ["subject.identity", "evidence.identity"],
  "optional_selectors": ["findings.prior_screening"],
  "token_budget": 24000,
  "purpose": "sanctions_screening"
}
```

The Context Service authenticates the control-plane identity, independently authorizes tenant/case/purpose, reads canonical data, queries derived retrieval only when allowed, applies redaction and minimization, and stores a ContextManifest. The control plane validates that all mandatory selectors resolved, the snapshot and plan match, the manifest is within size/budget, and no prohibited data class/provider combination exists.

If mandatory context cannot fit, the result is CONTEXT_TOO_LARGE or CONTEXT_INCOMPLETE. The system must not silently truncate mandatory evidence. Optional omission is recorded with reason and counts.

## 4.9 Policy and Assurance Coordinator

The coordinator calls a deterministic policy service at these gates:

1. admission;
2. transition to READY;
3. ExecutionProfile resolution;
4. context acceptance;
5. each tool effect;
6. AgentResult acceptance;
7. BusinessCommand submission;
8. WorkItem completion;
9. decision readiness and finalization.

Every result includes bundle digest, input digest, rules evaluated, rules fired, outcome and explanation data. Outcomes are PASS, FAIL, UNKNOWN and ERROR. Only PASS authorizes the requested transition. A rule can explicitly map UNKNOWN to HUMAN_REQUIRED, but absence of a rule never means allow.

Semantic QA is scheduled as another WorkItem. Deterministic assurance remains in the control plane and checks schemas, references, required work, freshness, contradictions, policy snapshots and disposition preconditions.

## 4.10 Execution Worker and runtime adapter

The execution worker consumes a dispatch, loads current state, acquires a database lease, obtains an ExecutionProfile and ContextManifest, and invokes a runtime adapter. Runtime adapters implement one interface:

```text
execute(profile, request, manifest_ref, execution_token, deadline)
  -> AgentResult | typed execution error
```

Initial adapters:

- `local_http`: the runtime-host container beside the dispatcher (development);
- `hosted_http`: the same image as its own HTTPS service on any container platform;
- `databricks`: the same image as a Databricks App;
- the recorded model adapter in the gateway supplies deterministic model results for tests.

The adapter cannot read PostgreSQL, object storage or search indexes directly. It receives only the ContextManifest payload authorized for that execution. Every model and tool request goes through the Capability Gateway. The control plane maintains the same contracts when the runtime changes ([runtime conformance](runtime-conformance.md)).

A hosted runtime must prove private routing, gateway mediation for model/tool calls, its own workload identity, cancellation, deadline handling, telemetry correlation and denial of direct resource access in the target environment before production use.

## 4.11 Result Validator and Command Submitter

Validation order:

1. execution identity, lease and fencing epoch;
2. AgentResult contract and maximum size;
3. profile, plan, prompt, skill, model and tool references;
4. evidence existence, hashes and allowed provenance;
5. claim/finding/assumption/contradiction schemas;
6. policy and permission compliance;
7. required-output completeness;
8. cost and usage reconciliation;
9. deterministic QA applicable to this work type.

Valid proposals are translated into typed BusinessCommands. The control plane never generates database paths. The Case Command Gateway reauthenticates, reauthorizes, checks current Case/entity revisions and commits accepted changes with CaseEvents. A rejected command returns a typed result to the kernel, which chooses rework, failure, human review or recomputation.

## 4.12 Timer, sweeper and reconciliation services

PostgreSQL stores durable timers with `due_at`, purpose, target revision and status. The timer poller claims due rows with `SKIP LOCKED`, writes outbox signals and marks them fired idempotently. Timers cover retries, deadlines, human escalation, lease expiry, periodic review and delayed policy actions.

Sweepers identify:

- READY work without a live dispatch;
- expired leases;
- outbox rows without a dispatch claim;
- execution records missing a terminal WorkItem transition;
- budget reservations past expiry;
- staged artifact objects not registered as evidence;
- dead-lettered WorkItems requiring classification;
- cases pinned to revoked dependencies;
- WorkItems stuck beyond operational thresholds.

Sweepers emit repair commands through the same domain APIs. They do not update arbitrary state with ad hoc SQL.

# 5. WorkItem model and state machine

Minimum WorkItem fields:

| Group | Fields |
| --- | --- |
| Identity | tenant_id, case_id, work_item_id, type, capability, assurance_class |
| Versioning | revision, case_sequence_basis, plan_digest, policy_context_ref, schema_version |
| Objective | objective, subject_refs, required_outputs, constraints |
| Dependencies | dependency set, dependency_digest, invalidation policy |
| Lifecycle | state, reason_code, priority, ready_at, deadline_at, terminal_at |
| Dispatch | dispatch_generation, queue, published_at, claimed_at |
| Lease | execution_id, lease_owner, lease_until, fencing_epoch, attempt_number |
| Limits | budget_definition, reservation refs, max_attempts, max_rework_cycles |
| Result | AgentResult ref, accepted command refs, completion outputs, failure detail |
| Audit | created_by, transition sequence, timestamps, trace and execution refs |

State transitions:

```text
PROPOSED
  -> BLOCKED              dependencies or policy not satisfied
  -> READY                all deterministic readiness gates pass

BLOCKED
  -> READY                dependency becomes satisfied
  -> CANCELLED            parent/case/policy cancels need
  -> EXPIRED              deadline passes with no permitted continuation

READY
  -> LEASED               worker acquires DB lease and budget
  -> CANCELLED / EXPIRED  authority changes before acquisition

LEASED
  -> RUNNING              runtime invocation accepted
  -> READY                lease expires before side effect; safe redispatch
  -> RETRY_SCHEDULED      typed transient failure
  -> HUMAN_REQUIRED       policy or ambiguity requires a person
  -> FAILED               nonretryable error or attempt limit

RUNNING
  -> COMPLETED            required outputs accepted by command/gates
  -> PARTIAL              useful accepted output, requirements still incomplete
  -> RETRY_SCHEDULED      permitted transient failure
  -> REWORK_REQUIRED      output rejected or dependency changed
  -> HUMAN_REQUIRED       judgment or exception path
  -> CANCELLED            cancellation acknowledged; late effects fenced
  -> FAILED               terminal technical/policy failure

PARTIAL / REWORK_REQUIRED
  -> BLOCKED / READY      kernel creates or activates remaining work

HUMAN_REQUIRED
  -> WAITING_HUMAN        review task created and assigned
  -> READY / COMPLETED    authorized human action accepted
  -> SUSPENDED            operational pause

Any nonterminal state
  -> CANCELLED / EXPIRED  when policy permits
```

Store every transition in `work_item_transitions` with from/to, revision, reason, actor, input digest and time. Enforce allowed transitions in one shared kernel package and database constraints. Do not let each worker implement its own state machine.

# 6. Runtime sequences

## 6.1 Normal agent execution

```text
1. Scheduler writes dispatch_outbox for READY WorkItem generation 4.
2. The same transaction signals `NOTIFY` with the WorkItem key tenant:work:4.
3. Worker claims the row (`FOR UPDATE SKIP LOCKED`) and reads WorkItem.
4. Worker atomically acquires application lease, epoch 9, and budget reservation.
5. Resolver returns a pinned, attested ExecutionProfile.
6. Context Service creates ContextManifest for Case sequence 482.
7. Worker starts ExecutionRecord and invokes runtime adapter.
8. Agent calls model/tools only through the Capability Gateway with scoped execution token.
9. Worker validates AgentResult and submits typed BusinessCommands.
10. Case Gateway commits accepted changes, CaseEvents and new outbox rows.
11. Kernel verifies required outputs and marks WorkItem COMPLETED.
12. Worker closes ExecutionRecord, releases unused budget and marks the dispatch done.
13. CaseEvent outbox signals the kernel for dependent WorkItems.
```

The Case commit occurs before the dispatch is marked done. If the worker crashes after step 10, the next claim finds the stored command receipt and terminal WorkItem result rather than duplicating the business effect.

## 6.2 Tool call with evidence

```text
Agent -> Capability Gateway: ToolRequest + execution token + semantic operation key
Capability Gateway -> Tool adapter: verified caller, fixed capability route
Tool Gateway -> Control Plane: validate epoch, permission, budget and policy
Tool Gateway -> Vendor: scoped credential; provider idempotency when supported
Vendor -> Tool Gateway: raw response or typed failure
Tool Gateway -> artifact staging: raw bytes
Evidence service: malware/content checks, exact hash, immutable version, read-back
Evidence service -> Case Gateway: RegisterEvidence command
Case Gateway: evidence metadata + CaseEvent + outbox commit
Tool Gateway -> Agent: ToolResult with evidence ref, status and bounded content
```

SUCCESS_EMPTY means a successful covered query returned no candidates. TIMEOUT, RATE_LIMITED, AUTH_FAILURE, PROVIDER_ERROR and INVALID_RESPONSE never become empty evidence. If the provider may have committed an irreversible effect but the response is unknown, return RECONCILIATION_REQUIRED and prohibit blind retry.

## 6.3 Lease loss during execution

```text
worker heartbeat fails
-> database lease expires
-> sweeper transitions WorkItem to READY and increments dispatch generation
-> new worker acquires epoch 10
-> old worker tries tool/command with epoch 9
-> gateway rejects STALE_FENCE
-> old execution closes as superseded when connectivity returns
```

If epoch 9 already completed an external action, its operation receipt and provider identifier are reconciled. Epoch 10 reuses the semantic operation key and first queries the receipt/provider instead of repeating the action.

## 6.4 Cancellation

Cancellation is a durable command:

1. authorize the requester and reason;
2. increment case/work authority epoch;
3. mark eligible WorkItems CANCELLED and revoke active execution tokens;
4. publish cancellation signals after commit;
5. deny new model/tool/command calls for old epochs;
6. wait for workers to acknowledge or leases to expire;
7. reconcile effects already accepted externally;
8. schedule compensation only through an authorized compensating command.

Cancellation cannot make an already accepted external effect disappear. The audit record distinguishes requested, effective and reconciled cancellation.

## 6.5 Human review

The kernel creates a HumanReview WorkItem with the same dependency, snapshot and deadline model. The analyst UI loads a review packet through the Context Service. The submitted action includes Case sequence and dependency digest. The Case Gateway rejects stale actions after evidence, policy or identity changes. Four-eyes rules are authorization policy, not UI convention.

# 7. Database implementation

The `workflow` schema lives in the control database (`ehf_control`), not on the Case database: no workflow credential can connect to `ehf_case`, which makes "the workflow module cannot update Case tables directly" a physical fact rather than a grant convention (data-stores-plan.md §1 and §4.4). Case state reaches workflow through the case outbox; the Case Service checks an execution's lease through two functions in the control database while it commits. The controller uses its own database role (`DATABASE_AUTH=url` with `PGPASSFILE` or a TLS client certificate) and PgBouncer transaction pooling after driver validation; the `LISTEN` connection is direct ([production performance](../../deploy/performance.md)).

Core tables:

```sql
workflow.work_items
workflow.work_item_dependencies
workflow.work_item_transitions
workflow.dispatch_outbox
workflow.inbox_receipts
workflow.execution_leases
workflow.budget_accounts
workflow.budget_reservations
workflow.durable_timers
workflow.provider_operation_receipts
workflow.reconciliation_cases
workflow.dead_letter_cases
execution.execution_records
execution.execution_artifacts
assurance.policy_results
assurance.assurance_results
```

Important constraints:

- composite tenant and case foreign keys on every child table;
- unique `(tenant_id, work_item_id)` and immutable ID generation;
- unique `(tenant_id, semantic_idempotency_key)` for command/effect receipts;
- unique `(tenant_id, work_item_id, dispatch_generation)` for dispatch;
- unique `(tenant_id, work_item_id, transition_sequence)` for history;
- check constraints for legal timestamps, positive budgets and valid enum values;
- FORCE ROW LEVEL SECURITY on tenant-scoped tables;
- runtime roles are nonowner and cannot BYPASSRLS;
- indexes begin with tenant_id and match scheduler/query order;
- append-only transition and result artifacts for runtime roles;
- database functions use fixed `search_path` and least privilege.

Lease acquisition pseudocode:

```sql
BEGIN;
SELECT state, revision, dispatch_generation, fencing_epoch
FROM workflow.work_items
WHERE tenant_id = :tenant
  AND work_item_id = :work
FOR UPDATE;

-- Application verifies state, generation, deadline, revocation and budget.
UPDATE workflow.work_items
SET state = 'LEASED',
    revision = revision + 1,
    execution_id = :execution,
    lease_until = transaction_timestamp() + interval '90 seconds',
    fencing_epoch = fencing_epoch + 1,
    attempt_number = attempt_number + 1
WHERE tenant_id = :tenant
  AND work_item_id = :work
  AND state IN ('READY', 'RETRY_SCHEDULED')
  AND dispatch_generation = :generation;

INSERT INTO workflow.work_item_transitions (...);
INSERT INTO execution.execution_records (...);
COMMIT;
```

The real implementation uses a stored command function or repository transaction with strict row-count checks. It obtains no model/tool data while the row is locked.

Scheduler query approach:

```sql
SELECT tenant_id, work_item_id
FROM workflow.work_items
WHERE state = 'READY'
  AND ready_at <= transaction_timestamp()
  AND deadline_at > transaction_timestamp()
  AND no_live_dispatch = true
ORDER BY priority_rank, deadline_at, ready_at, work_item_id
FOR UPDATE SKIP LOCKED
LIMIT :batch;
```

Update selected rows and insert outbox entries in the same transaction. The actual fairness algorithm should preselect eligible tenant buckets so a global priority query cannot starve small tenants.

# 8. Work signalling

PostgreSQL is both the authority and the queue. Work becomes visible when its row commits; `pg_notify` on `harness_run_queue` and `harness_execution_work` commits atomically with it, so a listener learns of new work at once, and each consumer's bounded poll (`WORKER_POLL_MS`) recovers anything a dropped connection missed. Consumers claim rows with `FOR UPDATE SKIP LOCKED`, so delivery is at least once and duplicates are expected. `RUN_QUEUE_MAX_PENDING` bounds admission so a backlog becomes backpressure, not memory growth.

Separate work classes (screening, search, investigation, decision, QA, platform) are separate claim predicates or worker deployments over the same tables, so quotas, CPU/memory, network permissions and rollout can differ without another broker. Cancellation is a durable state change plus a best-effort runtime cancel call; it never depends on a signal being delivered.

The 90-second application lease, not the claim, is the execution authority; a claim lost after successful work is safe because the next claim re-reads the terminal state. Business idempotency is retained for the relevant business retention.

Order is not needed for correctness: Case mutations are ordered by database transaction and preconditions. A capability with a proven per-case FIFO requirement gets a per-case claim predicate and accepts reduced concurrency for a busy case.

Dead-letter handling:

1. alert on any persistent dead-lettered WorkItem and on increasing oldest age;
2. record the reason in `dead_letter_cases`;
3. classify contract, poison data, authorization, expired work, repeated transient or platform defect;
4. fix root cause or create an approved exception;
5. create a new dispatch generation through the controller;
6. close the dead-letter case only after the durable recovery record is committed.

Never re-dispatch dead-lettered work without rechecking current WorkItem authority.

# 9. Deployment topology

The proposed production stamp uses one approved US primary region and one US recovery region, pending model, policy and records validation. Any Kubernetes cluster or container platform that can project a workload identity token, mount secrets as files and reach PostgreSQL privately is sufficient.

| Component | Execution-control-plane configuration |
| --- | --- |
| Platform services | Internal-only deployments for control API, case API, dispatcher and reconciler; zone spread; critical minimum 3 replicas |
| Runtime host | Separate deployment (`hosted_http`) or Databricks App; no data roles; 0-50 replicas; egress only to the gateway, case API and control plane |
| Capability Gateway | Holds provider credentials as `env:`/`file:` references; workload identity to skill hosts and HTTP operations; no KYC response caching |
| PostgreSQL | HA with synchronous standby; per-service roles; `PGPASSFILE` or TLS client certificates; PgBouncer; 35-day PITR; also the work queue |
| Administered settings | Active plan pointers, circuit and feature flags in `harness_admin`; never secrets or full business policy |
| Signing keys | RSA private keys mounted as files per signer; agents have no secret access |
| Object storage (when used) | Execution records and context artifacts separate from evidence; private access, versions/immutability by record class |
| OTLP collector | PII-free operational telemetry; durable records unsampled elsewhere |

Networking:

```text
trusted platform network
  control-api / case-api / dispatcher / reconciler
       | private TLS
       +-> PostgreSQL / object storage / secret mounts
       +-> Capability Gateway internal endpoint

runtime network
  agent execution only (runtime host)
       +-> Capability Gateway, case API, control plane
       X  no PostgreSQL, object storage, search, secrets or vendor data roles

connector network
  typed adapters inside the gateway
       +-> private routes to internal APIs
       +-> approved vendor FQDNs through the egress proxy
```

## 9.1 Scaling

Control and case APIs scale on HTTP concurrency/CPU with minimum three production replicas. The dispatcher scales on PostgreSQL queue depth with KEDA's PostgreSQL scaler ([`deploy/kubernetes/`](../../deploy/kubernetes)); `WORKER_CONCURRENCY` bounds executions per replica.

Use separate dispatcher deployments for screening, search, investigation, decision and QA where quotas, CPU/memory, network permissions or rollout must differ. A global semaphore in PostgreSQL/Budget Manager caps model/vendor concurrency even if KEDA scales more replicas than downstream capacity.

## 9.2 Service identities and roles

Each service has one workload identity (README "Service identity"); roles are granted by the callee, never carried in the token.

| Identity | Required access | Explicit denial by absence of role |
| --- | --- | --- |
| `control-api` | Run journal, plan admission, envelope signing; calls case API with `Edge.Delegate` for human-work actions | Case table DML, model/tool invoke |
| `runtime-dispatcher` | Lease, fence, runtime-grant signing; calls the runtime host | Envelope signing, provider credentials |
| `harness-runtime` | `Runtime.State.Write` at the control API, `Capability.Invoke` at the gateway, case API access | Direct database tables, secrets, model resource roles |
| `capability-gateway` | Provider credentials; calls skill hosts and HTTP operations; issues delegated skill envelopes | Case writes, release approval |
| `case-api` | Case, ledger and evidence stores; `Case.Outbox.Publish` and `Policy.Authority.Read` at the control API | Plan authorship, provider credentials |
| `integration-worker` | Integration envelope signing; `Integration.Dispatch` at control and case APIs | Arbitrary business mutation and finalization |

Infrastructure RBAC protects resources; the signed PermissionEnvelope and application policy enforce tenant, case, field, purpose and effect restrictions.

# 10. API and event contracts

Synchronous APIs:

| Endpoint | Purpose | Idempotency / concurrency |
| --- | --- | --- |
| `POST /execution-admissions` | Admit committed trigger | Required request key and content digest |
| `GET /cases/{caseId}/work-items` | Authorized work view | Read snapshot sequence returned |
| `POST /work-items/{id}:cancel` | Request cancellation | Reason + expected revision |
| `POST /work-items/{id}:lease` | Acquire application lease | Dispatch generation and expected revision |
| `POST /work-items/{id}:heartbeat` | Renew lease | Execution ID + fencing epoch |
| `POST /work-items/{id}:result` | Submit AgentResult ref | Execution ID + fencing epoch + result digest |
| `POST /budgets:reserve` | Hold work/effect budget | Semantic reservation key |
| `POST /budgets/{id}:reconcile` | Consume/release against actual use | Usage receipt digest |
| `POST /profiles:resolve` | Resolve immutable ExecutionProfile | Work/plan/policy digest |
| `POST /contexts` | Request ContextManifest | Work/profile/snapshot digest |
| `POST /policy:evaluate` | Deterministic policy decision | Bundle/input digest |
| `POST /reconciliation-cases` | Open unknown-effect recovery | Operation key unique |

All write APIs require `Idempotency-Key`, `If-Match` or equivalent expected revision where applicable, correlation ID, tenant-scoped identity and a bounded request size. Error responses use stable codes such as STALE_REVISION, STALE_FENCE, PLAN_REVOKED, DEPENDENCY_UNKNOWN, BUDGET_EXHAUSTED, POLICY_BLOCKED, CONTEXT_INCOMPLETE and RECONCILIATION_REQUIRED.

Dispatch message:

```json
{
  "schema": "workflow.dispatch.v1",
  "message_id": "tenant_01:wi_01:4",
  "tenant_id": "tenant_01",
  "case_id": "case_01",
  "work_item_id": "wi_01",
  "dispatch_generation": 4,
  "capability_family": "screening",
  "priority": "P1",
  "deadline_at": "2026-09-17T15:35:00Z",
  "traceparent": "00-..."
}
```

Do not include PII, evidence, prompts, model configuration, secrets or trusted policy values in queue messages. The consumer rehydrates everything under current authority.

# 11. Concurrency, idempotency and effect safety

The system promises at-least-once delivery and effectively-once accepted business effects through receipts and transactional boundaries. It does not claim distributed exactly-once execution.

Idempotency scopes:

| Boundary | Key |
| --- | --- |
| Admission | tenant + case + trigger ref + plan digest |
| Dispatch | tenant + WorkItem + dispatch generation |
| Execution attempt | WorkItem + attempt number + fencing epoch |
| BusinessCommand | tenant + case + WorkItem + semantic operation + logical target |
| Read-only tool query | tenant + case + WorkItem + query purpose + normalized input digest + dataset/version expectation |
| External write | tenant + business operation + logical external target; provider key when supported |
| Outbox publication | event/dispatch ID + destination |
| Inbox consumption | consumer + message/event ID |

An idempotency record stores the canonical request digest. A repeated key with different content is a conflict, not a retry.

Concurrency strategy:

- use short row locks only for transition/receipt/commit boundaries;
- use optimistic entity revisions for agent proposals;
- allow commutative append of independent evidence after validation;
- invalidate dependent screening/decisions after identity or ownership changes;
- recompute final dependencies in the Case transaction;
- never hold a database transaction across network calls;
- partition scheduling and indexes by tenant/stamp before considering database sharding;
- use fencing for late workers and recovery-region writers.

Effect classes:

| Effect | Retry behavior |
| --- | --- |
| READ_ONLY | Bounded retry for typed transient failures; persist successful evidence once |
| IDEMPOTENT_WRITE | Retry with stable provider/application key and receipt lookup |
| REVERSIBLE_WRITE | Retry only with stable key; define explicit authorized compensation |
| IRREVERSIBLE_WRITE | No blind retry; query provider state or human reconcile on ambiguity |
| EXTERNAL_COMMUNICATION | Stable message intent, dedupe and approval; delivery result is separate from content approval |
| FINANCIAL_OR_LEGAL_EFFECT | Strong human/policy authorization, receipt and reconciliation path |

# 12. Security model

Trust zones:

1. trusted deterministic platform: controller, Case/Command, context/policy and reconciler;
2. bounded cognition: the runtime host (local, hosted or Databricks);
3. controlled capability adapters: tool services holding narrow credentials;
4. enterprise and external systems;
5. human analyst and administrator channels.

The agent runtime is treated as untrusted compute even when the organization owns the code. It receives no database credential, storage role, signing key, vendor secret or broad OAuth token.

Execution token claims:

```json
{
  "iss": "harness-execution-authority",
  "aud": "harness-capability-gateway",
  "sub": "agent:screening",
  "tenant_id": "tenant_01",
  "case_id": "case_01",
  "work_item_id": "wi_01",
  "execution_id": "exec_01",
  "plan_hash": "sha256:...",
  "permission_hash": "sha256:...",
  "fencing_epoch": 9,
  "capabilities": ["model.reasoning.standard", "sanctions.screen"],
  "exp": 1789668720
}
```

Maximum token lifetime is proposed at two minutes. Renewal requires a live lease. The gateway verifies the caller's workload identity, then the execution token and current authority; caller-supplied tenant/principal headers are ignored unless the caller holds `Edge.Delegate`. Never authorize a tenant from an arbitrary header or request body.

Security tests include direct calls from the executor to PostgreSQL/object storage/search/model endpoints, forged tenant/case/token claims, replay after lease loss, cross-tenant identifiers, SSRF through a tool request, prompt injection attempting to grant capabilities, plan revocation during execution, and leakage through telemetry/error bodies.

# 13. Reliability and failure semantics

Standard execution outcomes:

```text
COMPLETED
PARTIAL
BLOCKED
RETRYABLE_ERROR
NON_RETRYABLE_ERROR
POLICY_BLOCKED
HUMAN_REQUIRED
CANCELLED
DEADLINE_EXCEEDED
BUDGET_EXHAUSTED
SUPERSEDED
RECONCILIATION_REQUIRED
```

Failure mapping:

| Failure | Control-plane response |
| --- | --- |
| PostgreSQL unavailable before lease | No claim; no authority acquired; retry on the next poll |
| PostgreSQL unavailable after external effect | Do not repeat blindly; persist/recover provider receipt and open reconciliation |
| Notification lost after DB commit | Bounded poll finds the row; sweeper monitors age |
| Worker crash before effect | Lease expires; redispatch new generation/epoch |
| Worker crash after command commit | Next claim finds command receipt and terminal result |
| Gateway/model rate limit | Release/retain budget as appropriate; scheduled backoff within deadline |
| Tool timeout | Typed failure; bounded retry only if effect class permits |
| Context Service incomplete | Block execution; create remediation/rework, never silently omit mandatory input |
| Plan/model/tool revoked | Stop new dispatches; fence affected calls; identify in-flight and historical impact |
| Policy service unavailable | Fail closed for transitions requiring authorization; existing safe waits continue |
| Dead-lettered WorkItem | Create durable operational case; reauthorize before new dispatch |
| Recovery-region activation | Increment stamp authority epoch and fence primary before enabling writes |

Circuit breakers exist per provider/profile/tenant where appropriate. They protect shared dependencies, but opening a circuit is not evidence of a negative KYC result. The resolver can choose only an approved attested alternative or route work to waiting/human handling.

# 14. Observability and flight recorder

OTel hierarchy:

```text
harness.run
  workflow.admission
  workflow.transition
  profile.resolve
  budget.reserve
  context.assemble
  work.dispatch
  work.lease
  agent.execution
    model.inference
    tool.execution
    result.validate
  case.command
  assurance.check
  review.route
```

Stable operational fields include service, region, environment, tenant pseudonym, case/work/execution/trace IDs, plan/profile/policy digests, capability, state transition, outcome, error type, attempt, queue age, lease age, tokens, cost and latency. Never place names, birth dates, documents, evidence content, prompts, responses, access tokens or secrets in span attributes.

Durable ExecutionRecord contains the exact resolved dependency versions, ContextManifest, model/tool calls, AgentResult, proposed and accepted commands, policy results, usage, timing and terminal reason. Large permitted artifacts live in the artifact store by exact version/hash. It records observable inputs and outputs, not private model chain-of-thought.

Dashboards:

- WorkItems by state, capability, priority and age;
- READY-to-lease and end-to-end latency percentiles;
- queue active/dead-letter/oldest age and publish lag;
- lease acquisition, expiry, heartbeat and stale-fence rates;
- retry, rework, partial, human and reconciliation rates;
- model/tool error, throttle, cost and token usage;
- budget held/consumed/expired and reconciliation lag;
- policy outcomes and revocation freshness;
- controller/database saturation and scheduler batch duration;
- tenant fairness and quota consumption.

Initial alerts: any unauthorized finalization or cross-tenant access; outbox age over 60 seconds; READY or queue age over 120 seconds; any persistent dead letter; lease-expiry surge; stale revocation cache; budget anomaly; reconciliation case past SLA; database CPU above 70% for 15 minutes; storage above 80%; provider error rate above 5% for 5 minutes. Tune with preproduction data.

# 15. Capacity and performance

Planning load from the foundation document is 1,000 cases/day, 12 executions/case, 10x hourly burst and about 28,000 maximum tokens/execution. This yields 12,000 executions/day. At 30 seconds mean active time, average concurrency is about 4.2 and the 10x planning burst is about 42.

Initial limits:

| Control | Value | Purpose |
| --- | --- | --- |
| Worker concurrency per replica | 2 | Bound memory and concurrent model/tool use |
| Worker max replicas across queues | 50 per stamp | Match 10x planning concurrency with headroom |
| Lease | 90 seconds, heartbeat 20 seconds | Fast recovery with enough heartbeat tolerance |
| Scheduler batch | 100 rows every 1 second when backlog exists | Avoid long locks; tune from DB metrics |
| Outbox batch | 100 rows, 10 concurrent sends | Bound in-flight memory and downstream calls |
| Context cap | 24k input tokens initial | Force selection/minimization |
| Output cap | 4k tokens initial | Bound latency/cost |
| Case budget | $20, 200 tools, 30 active machine minutes | Source-derived planning guardrail, pending validation |
| Max rework cycles | 2 initial | Stop loops and route to human |

Autoscaling is limited by the smallest downstream capacity: model TPM/RPM, vendor requests, database connections, connector throughput or approved case budget. Worker scaling must not outrun those limits.

Load tests:

1. sustain expected hourly peak for two hours;
2. run 10x burst for one hour, then measure drain time;
3. inject 5% long investigations and 2% vendor timeouts;
4. force controller replica turnover and database HA failover;
5. create duplicate dispatches and lost notifications;
6. verify tenant fairness under one noisy tenant;
7. test runtime revision rollout capacity headroom;
8. verify no unsafe bypass when quota/budget is exhausted.

# 16. Disaster recovery

The database is the recovery anchor and holds the queue itself; there is no broker to rebuild. Signed plan and policy artifacts must exist in the recovery region before production release.

Recovery procedure:

1. declare incident and stop new ingress/dispatch;
2. increment the global stamp authority epoch in an independently available authority;
3. fence or disable primary gateway/runtime identities and confirm no primary writers;
4. determine PostgreSQL recovery point and promote/restore recovery database;
5. validate signed registry, plan, policy and revocation data;
6. restore private DNS/routes/identities for the recovery stamp;
7. verify Case/WorkItem/ledger sequence and evidence durability watermarks;
8. expire all old leases and create new dispatch generations;
9. re-signal READY and RETRY_SCHEDULED work from database state;
10. reconcile external operations spanning the lost interval;
11. run synthetic admission, execution, command and audit tests;
12. reopen limited analyst traffic, then controlled automation.

Never enable the recovery writer while the old stamp might still accept writes. An async database replica can lack a command whose external provider effect succeeded; provider operation reconciliation is mandatory before replay.

Proposed targets are zone-event RPO 0 for committed PostgreSQL under synchronous HA, regional RPO at most five minutes and RTO at most four hours. These remain targets until timed drills demonstrate them. Recovery-region writes are disabled during normal operation.

# 17. Code structure and implementation interfaces

```text
runtime/execution-control/
  api/                     admission, work query, cancellation
  kernel/                  state machine, dependencies, invalidation
  scheduler/               fairness, eligibility, dispatch planning
  leases/                  acquisition, heartbeat, fencing
  budgets/                 accounts, reservations, reconciliation
  resolver/                capabilities and ExecutionProfile
  coordinator/             context, policy and assurance calls
  dispatch/                outbox publisher and queue contracts
  worker/                  consumer and execution lifecycle
  adapters/                local_http, hosted_http, databricks (packages/runtime-provider)
  results/                 AgentResult validation and command mapping
  timers/                  durable timer poller
  reconciliation/          sweepers, dead letters and unknown effects
  contracts/               OpenAPI/JSON Schema/event schemas
  persistence/             repositories and migrations
  telemetry/               OTel conventions and recorder
```

Key interfaces:

```text
WorkflowKernel.evaluate(snapshot) -> TransitionPlan
DependencyEvaluator.evaluate(work, inputs) -> DependencyResult[]
Scheduler.select(now, capacity) -> DispatchIntent[]
LeaseService.acquire(work, generation, execution) -> Lease
LeaseService.renew(lease, epoch) -> Lease
CapabilityResolver.resolve(requirement, authority, health) -> ExecutionProfile
BudgetService.reserve(scope, maximum, key) -> Reservation
ContextCoordinator.assemble(request) -> ContextManifestRef
PolicyCoordinator.evaluate(gate, refs) -> PolicyResult
RuntimeAdapter.execute(envelope) -> AgentResult
ResultValidator.validate(result, authority) -> ValidatedProposals
CommandSubmitter.submit(commands, lease) -> CommandReceipt[]
Reconciler.scan(category, watermark) -> RepairProposal[]
```

Use one canonical serialization library for digests and idempotency hashes. Every interface returns machine-readable reason codes and correlation references. No interface returns a raw exception as a business result.

# 18. Implementation plan

| Phase | Duration | Work | Exit evidence |
| --- | --- | --- | --- |
| E0 - Decisions and prototypes | Weeks 1-2 | ADRs, WorkItem/state contracts, PostgreSQL locking and NOTIFY prototype, hosted runtime and gateway spike | Runtime path chosen; state/authority invariants approved |
| E1 - Persistence and kernel | Weeks 3-5 | Workflow schema, transitions, dependencies, admission, timers, RLS, idempotency | Deterministic lifecycle tests; duplicate/stale transition denial |
| E2 - Dispatch and leases | Weeks 5-7 | Scheduler fairness, outbox, NOTIFY/poll signalling, lease/heartbeat/fencing, cancellation | Crash/redelivery/stale-worker tests pass |
| E3 - Resolution and budgets | Weeks 6-8 | Capability resolver, attestations, health, budget reservations, circuit state | Only qualified profiles resolve; concurrency/cost caps enforced |
| E4 - Context/policy integration | Weeks 7-9 | ContextManifest orchestration, deterministic gates, assurance results | Missing/oversized/unauthorized context blocked |
| E5 - Runtime and results | Weeks 8-10 | Hosted and Databricks runtime adapters, execution token, gateway calls, result validation, command submission | End-to-end synthetic WorkItem completes with no direct data access |
| E6 - Reconciliation and operations | Weeks 10-12 | Sweepers, dead letters, unknown-effect workflow, dashboards, alerts, audit/flight recorder | Failure matrix and operational runbooks exercised |
| E7 - Scale and recovery | Weeks 12-14 | Load, HA, regional recovery, fairness, quota and cost tests | Timed recovery and 10x burst evidence |
| E8 - KYC integration | Weeks 14-16 | Bind all eight KYC AgentSpecs/work types and human review | Full KYC golden cases traverse control plane |

Detailed engineering backlog:

| ID | Deliverable | Acceptance criterion |
| --- | --- | --- |
| EC01 | WorkItem, transition and dependency schemas | Compatibility fixtures and illegal-transition tests |
| EC02 | Admission API and plan pinning | Repeated trigger returns same WorkItems; revoked plan rejected |
| EC03 | Kernel library | Same snapshot produces same TransitionPlan and digest |
| EC04 | PostgreSQL roles/RLS/migrations | Actual runtime identities fail cross-tenant and owner-bypass tests |
| EC05 | Transactional dispatch outbox | Crash before/after send produces no lost authoritative work |
| EC06 | Scheduler/fairness | Small tenant meets latency target under noisy-tenant load |
| EC07 | PostgreSQL queue claims and signalling | Lost notification, retry, dead-letter and duplicate scenarios verified |
| EC08 | Lease/fencing/token authority | Stale worker cannot call tool or submit command |
| EC09 | Durable timers | Retry/deadline events fire once effectively under replica turnover |
| EC10 | Capability resolver | Residency, revocation, coverage and attestation exclusions tested |
| EC11 | Budget accounts/reservations | Parallel reservations cannot overspend; ambiguous usage reconciles |
| EC12 | Context coordinator | Mandatory omission blocks; trust/redaction manifest is auditable |
| EC13 | Policy/assurance coordinator | UNKNOWN/ERROR cannot authorize transition |
| EC14 | Hosted runtime adapter | Private gateway-mediated path and identity proof passes |
| EC15 | Databricks runtime adapter | Same contracts and denial tests pass |
| EC16 | Result validator/command mapper | Malformed, stale, unsupported and evidence-free findings rejected |
| EC17 | Flight recorder | Every terminal execution reconstructs versions, context and outcomes |
| EC18 | Sweepers/dead letters/reconciliation | Repairs use typed commands; unknown effects are not blindly repeated |
| EC19 | OTel dashboards/alerts | Failure injection creates owned, actionable alert without PII |
| EC20 | Load/HA/DR | Peak, failover and regional drill meet approved targets |

# 19. Test strategy

Unit and property tests:

- every legal and illegal state transition;
- dependency truth tables including UNKNOWN and revision invalidation;
- canonical digest stability;
- retry classification and backoff bounds;
- budget arithmetic, parallel reservations and release;
- capability resolution exclusion reasons;
- idempotency key/content digest conflicts;
- schedule fairness and deadline ordering.

Integration tests:

- PostgreSQL transaction plus outbox crash points;
- notification loss and poll recovery;
- duplicate claim before and after command commit;
- application lease versus claim loss;
- plan revocation during each execution phase;
- workload identity propagation and delegated-header stripping;
- ContextManifest authorization and search-filter bypass attempts;
- evidence durability before command acceptance;
- connection recovery through PgBouncer and HA failover;
- runtime adapter contract parity.

Fault and adversarial tests:

- worker kill at every lifecycle boundary;
- database failover during lease, result and command phases;
- model/vendor throttle, timeout, malformed and delayed responses;
- poison WorkItem and oversized AgentResult;
- injected instructions requesting tools, secrets or approval;
- forged tenant/case/work/epoch values;
- cancellation racing with tool and command submission;
- recovery with an ambiguous external side effect;
- duplicate human action against a changed Case snapshot.

Release gates:

1. zero cross-tenant data access in negative tests;
2. zero stale-fence accepted effects;
3. zero duplicate semantic business effects in crash/redelivery suite;
4. zero deterministic-policy UNKNOWN or ERROR converted to PASS;
5. complete durable record for every accepted command and disposition;
6. 10x load test meets approved queue/latency and fairness targets;
7. hosted runtime route proof passes;
8. restore and regional recovery drills meet approved RPO/RTO;
9. KYC golden cases pass through decision, QA and human review;
10. on-call, dead-letter, reconciliation and cancellation runbooks are exercised.

# 20. Operational runbooks

Required runbooks:

- high READY/queue age;
- repeated lease expiry or stale fences;
- dead-letter classification and controlled replay;
- model or tool provider outage;
- budget/quota exhaustion;
- plan, prompt, model, tool or skill revocation;
- policy service unavailable or stale policy cache;
- Context Service unavailable or unauthorized retrieval alert;
- unknown external side effect;
- PostgreSQL HA failover and connection recovery;
- queue backlog or listener loss and dispatch re-signalling;
- regional activation and split-brain prevention;
- suspicious agent/tool behavior and execution-token revocation;
- audit/ledger sequence gap.

Every runbook defines trigger, severity, owner, immediate containment, diagnostic queries, safe recovery command, evidence to retain and closure criteria. Operators invoke versioned admin commands through the execution API; direct database modification is emergency-only, dual-controlled and followed by an immutable incident record.

# 21. Architecture decisions to close before production

| Decision | Recommended baseline | Must be confirmed by |
| --- | --- | --- |
| Agent runtime | `hosted_http` runtime host; `databricks` where the deployment standardises on Databricks | AI platform + security, week 2 |
| Workflow authority | PostgreSQL WorkItems and transitions | Architecture review, week 1 |
| Queue ordering | No sessions initially; add isolated session queue only for proven FIFO need | Runtime lead, week 4 |
| Policy engine | OPA/Rego or equivalent pinned deterministic engine | Security/policy engineering, week 2 |
| Database topology | Workflow schema colocated with Case server; control-plane registry separate | DBA + architecture, week 2 |
| Multi-tenant isolation | Shared regulated stamp with composite keys/RLS; dedicated stamp option | Security + product, week 2 |
| Regional pair | Two approved US regions | Platform + records, week 1 |
| Recovery authority | Independently available stamp epoch/fencing mechanism | SRE + security, week 4 |
| Model profiles/quotas | Regional U.S. deployments, no global routing | AI risk + platform, week 3 |
| Effect authorization | Typed effect classes and approval/compensation matrix | KYC operations + security, week 4 |

# 22. Definition of done

The execution control plane is production-ready when a signed KYC plan can admit a case, construct dependent work, select only authorized and attested profiles, reserve budgets, build governed context, run through any supported runtime adapter, mediate all models/tools through the Capability Gateway, reject stale workers, accept only validated commands, route required human review, and recover from duplicate delivery or worker death without losing work or duplicating a semantic business effect.

It must also demonstrate that lost queue signals are recovered from PostgreSQL authority, a revoked dependency stops new affected work, an ambiguous external effect enters reconciliation, a changed Case invalidates stale decisions, and a regional recovery cannot produce two active writers. Operations must reconstruct every accepted outcome from the Case ledger, WorkItem transitions, ContextManifest, policy results and ExecutionRecord.

This keeps cognition replaceable while making lifecycle, authority, evidence and recovery deterministic.
