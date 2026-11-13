# Data stores plan: workflow, context, case, ledger, catalog, evidence

Status: phases 1 to 4 are built (database roles, grant matrix and tenant row-level
security; separate control and case databases; the hardened ledger; the context store with
pgvector and Apache AGE), see §4.4; phases 5 and 6 are proposals. It covers which store owns which records, where each store physically
lives, the tables each store needs, and how separation of duties is enforced in the
database and around it. The "today" sections describe the code at the time of writing;
where this note and the code disagree, the code wins.

Related notes: [canonical-case-ledger-evidence-store.md](canonical-case-ledger-evidence-store.md)
(case, ledger, evidence target model), [execution-control-plane.md](execution-control-plane.md)
(workflow), [context-plane.md](context-plane.md) (context packs and manifests),
[artifact-registry.md](artifact-registry.md) and [business-skills.md](business-skills.md) (catalog).

## 1. Decisions

1. **Six logical stores, two databases, three blob boundaries.** One store is one Postgres
   schema (or schema group), owned by exactly one service that writes it.

   | Store | Answers | Database | Schema(s) | Bytes |
   | --- | --- | --- | --- | --- |
   | Catalog | What may run, at which version, approved by whom? | `ehf_control` | `catalog` (today `harness_control` registries, `harness_gateway` registries) | — |
   | Workflow | What work exists, who holds it, what runs next? | `ehf_control` | `workflow`, `harness_runtime` | — |
   | Context | What is the model working from on an open case? (released at close) | `ehf_context` (pgvector + Apache AGE) | `context`, graph `context_graph` | packs in `context.packs` until phase 5, then the `executions` account |
   | Case | What is effective now? | `ehf_case` | `case_core` | — |
   | Ledger | How did it change, under what authority? | `ehf_case` | `case_ledger` | `ledger-export` (separate account) |
   | Evidence | What was observed, and where are the bytes? | `ehf_case` (metadata) | `evidence` | `evidence`, `staging`, `quarantine` |

2. **Case, ledger and evidence metadata share one database.** A case mutation and its ledger
   event must commit in one ACID transaction (canonical store §1), and evidence links are
   foreign keys into `case_core.cases`. They cannot be split without giving up that
   invariant.

3. **Workflow stays in the control database, not on the case server.** This deliberately
   departs from execution-control-plane.md §7, which puts `workflow` on the case PostgreSQL
   server "for transactional proximity". The code already keeps workflow in the control
   database, and `apps/case-api/src/security.database.test.ts` already runs the two as
   separate databases. Keeping them apart turns the rule "the workflow module cannot update
   case tables" from a grant convention into a physical fact: no workflow credential can
   reach `ehf_case`. The cost is that handoffs between the two are asynchronous
   (outbox → inbox, §5), which the design already requires for Service Bus.

4. **Context is a working store, released when the case closes.** Today a context pack
   exists only as a digest in the run journal. While a case is open, `context` holds every
   manifest and rendered pack the runtime builds. When the case accepts a proposal that a
   model produced, the key details of that context (the manifest, the content that is not
   already durable elsewhere, and references to evidence it included) are promoted into the
   evidence store as a `model_context` evidence object, and the proposal cites that
   evidence id. Once the case is closed, nothing in `context` is needed for the decision
   record, so a release job deletes the case's context rows and packs (§3.3). Retrieval
   indexes (`knowledge_chunks`) also move to `context`, because they are derived and
   rebuildable rather than case truth.

5. **Evidence bytes leave Postgres.** `evidence.artifacts.content bytea` is the only
   backend today (`case_store.artifact_backend_unsupported` for anything else). The row
   stays as the metadata and authorization record; the bytes move to content-addressed blob
   storage. Postgres bytea remains the local/dev backend.

6. **Separation of duties is enforced in four layers**, each assuming the one above it can
   fail: physical (separate databases and storage accounts), database roles (one non-owner
   login role per service, no superuser, no BYPASSRLS), row-level security on tenant,
   and domain rules (author ≠ approver, recommender ≠ final decider) checked by the owning
   service and re-checked by a database trigger. Section 4 has the matrix.

## 2. What exists today and the gaps this plan closes

Verified in the migrations and compose file:

| Area | Today | Gap |
| --- | --- | --- |
| Databases | One database `ehf`; `DATABASE_URL` and `CASE_DATABASE_URL` both point at it (`compose.yaml`) | Two-database split exists only in a security test |
| DB identity | Every service connects as `postgres` | **Superuser bypasses RLS even with FORCE ROW LEVEL SECURITY**, so all tenant policies are currently inert outside the security test. No grant matrix is in the repo (`migrate-entrypoint.sh` defers it to the deployment target). *Closed by phase 1 (§4.4).* |
| Workflow RLS | Policies allow `tenant_id = app.tenant_id OR app.workflow_controller = 'true'`; `packages/persistence/src/execution-work.ts:23` sets the latter (the integration tables had the same `app.integration_controller` flag) | Any client can `set_config('app.workflow_controller','true')`; it is a bypass, not a control. *Closed by phase 1.* |
| Catalog | Spread over `harness_control.{skill_registry, agent_registry, business_skill_registry, canonical_catalogs, artifact_registry, plans, policy_revisions, release_manifests}` and `harness_gateway.{capability_registry, connector_registry}` | No single place to ask "what is approved to run"; global registries (`skill_registry`, `agent_registry`, `connector_registry`) have no tenant column and no approver |
| Context | `packages/context-plane` is a pure library; digests go to the run journal | Manifests not persisted (context-plane.md "Not yet done"); recommendations do not cite what the model saw |
| Retrieval | `case_core.knowledge_chunks` (pgvector); the capability gateway reads it through `CASE_DATABASE_URL` | The gateway holds a case-database credential only to reach a derived index |
| Ledger | `case_events`, `event_chain_heads`, `command_receipts`, `outbox` | No `ledger_segments` (signed export); `audit_exports` sits in `case_core`; no trigger forbidding UPDATE/DELETE on events |
| Evidence | `artifacts` (bytea), `evidence_objects`, `transformations`, `lineage_edges`, `registration_receipts`, `outbox` | No blob backend, `retention_assignments`, `legal_holds`; evidence tables have no RLS (*RLS closed by phase 1*) |
| Case | `case_core.*` broad and mature; RLS only on `skill_effects`, `canonical_records`, `financial_crime_outcomes` | Most case tables have no RLS policy. *Closed by phase 1.* |

## 3. Store designs

Conventions for every table: `tenant_id text not null` first in the primary key and in every
index; composite `(tenant_id, case_id)` foreign keys within a database; opaque text ids;
`created_at`, `created_by jsonb`, `schema_version`, and `classification` where the row holds
business data. References that cross a database boundary are by id **and digest**, never by
foreign key. Immutable rows are protected by a trigger that rejects UPDATE/DELETE (the
pattern `canonical_records_immutable()` already uses), not only by grants.

### 3.1 Catalog (`ehf_control.catalog`)

Owner: control-api (authoring, governance, release). Readers: runtime-host, capability
gateway, case-api (policy snapshot lookup), studio.

Every catalogued thing (plan, agent profile, business skill, library skill bundle, connector,
capability, policy revision, canonical catalog, model profile) follows one lifecycle:
an immutable **version** addressed by digest, plus an append-only **lifecycle event** stream
that records who drafted, evaluated, approved, published, deprecated or revoked it. Keep the
per-kind tables (their shapes differ), move them under `catalog`, and add the shared spine:

```sql
create table catalog.versions (
  tenant_id     text not null,            -- '_global' for platform-wide entries, never null
  kind          text not null check (kind in ('plan','agent_profile','business_skill',
                  'skill_bundle','connector','capability','policy','canonical_catalog','model_profile')),
  entry_id      text not null,            -- e.g. 'kyc.screening', 'plan:kyc-v2'
  version       text not null,            -- semver or monotonic revision
  digest        char(64) not null,        -- digest of the canonical definition bytes
  definition_ref text not null,           -- row in the per-kind table, or artifact:// for large bodies
  authored_by   text not null,
  created_at    timestamptz not null default clock_timestamp(),
  primary key (tenant_id, kind, entry_id, version),
  unique (tenant_id, kind, digest)
);

create table catalog.lifecycle_events (
  tenant_id   text not null,
  kind        text not null,
  entry_id    text not null,
  version     text not null,
  sequence    bigint not null,
  event_type  text not null check (event_type in ('drafted','evaluated','approved',
                'published','deprecated','revoked','quarantined')),
  actor       text not null,
  evidence_ref text,                      -- evaluation report / conformance run digest
  reason      text,
  occurred_at timestamptz not null default clock_timestamp(),
  primary key (tenant_id, kind, entry_id, version, sequence),
  foreign key (tenant_id, kind, entry_id, version) references catalog.versions
);

-- Effective view: what the runtime may resolve. Runtime roles read only this view.
create view catalog.published as ...;   -- latest 'published' with no later 'revoked'/'deprecated'
```

Duty rule enforced by trigger on `lifecycle_events`: an `approved` event's actor must not be
`authored_by` or the actor of any `evaluated` event for the same version, and `published`
requires a prior `approved`. This generalizes the check `005_tenancy_and_duties.sql` added for
authoring drafts.

Migration of existing tables: `harness_control.skill_registry`, `agent_registry` and
`harness_gateway.connector_registry` gain `tenant_id` (`'_global'`) and are moved with
`alter table ... set schema catalog`; compatibility views stay in the old schemas for one
release.

### 3.2 Workflow (`ehf_control.workflow`, `ehf_control.harness_runtime`)

Owner: runtime-host (kernel, dispatcher, reconciler). Writers through procedures only:
control-api (operator commands: cancel, suspend, reassign). Case-api gets `execute` on
`harness_runtime.lock_case_execution` and `matches_fincrime_outcome` and nothing else (the
pattern already in `028_case_execution_authority.sql`).

Keep the existing tables (`work_items`, `work_item_dependencies`, `work_item_transitions`,
`dispatch_outbox`, `durable_timers`, `reconciliation_cases`, `human_decisions`,
`human_assignments`, `human_conflict_resolutions`, `node_outputs`, `execution_outcomes`,
`runs`, `run_events`, `node_attempts`, `runtime_invocations`). Add:

```sql
-- Idempotent consumption of case-ledger events (case created, evidence linked,
-- finding accepted, review decided). This is the only path from the case store to workflow.
create table workflow.inbox_receipts (
  tenant_id      text not null,
  source         text not null check (source in ('case_ledger','evidence','integration')),
  source_event_id text not null,
  case_id        text,
  case_sequence  bigint,                  -- lets the kernel detect gaps per case
  event_digest   char(64) not null,
  received_at    timestamptz not null default clock_timestamp(),
  processed_at   timestamptz,
  primary key (tenant_id, source, source_event_id)
);

-- Per case: the highest ledger sequence the workflow has applied. Work items already
-- carry case_sequence_basis; this makes staleness checks a single lookup.
create table workflow.case_cursors (
  tenant_id     text not null,
  case_id       text not null,
  applied_sequence bigint not null,
  updated_at    timestamptz not null,
  primary key (tenant_id, case_id)
);
```

Fix the RLS bypass: replace `current_setting('app.workflow_controller', true) = 'true'` with
`pg_has_role(current_user, 'ehf_workflow_controller', 'member')` in every `workflow_tenant_scope`
policy, and drop the `set_config` call in `execution-work.ts`. Role membership cannot be
claimed by a client; a GUC can.

Several workflow and runtime columns hold case content. They are classified as case data
for access while the case is open, and they are redacted by the case release (§3.3):

| Table | Content columns | Kept after release |
| --- | --- | --- |
| `workflow.work_items` | `document`, `result` | Row, status, timings, budgets, `document_digest`, `result_digest` |
| `workflow.node_outputs` | `output` | Row, `output_digest` |
| `workflow.execution_outcomes` | `outcome` | Row, `outcome_digest` |
| `harness_runtime.runs` | `input`, `output` | Row, status, cost, counters |
| `harness_runtime.run_events` | `values` | Row, `code`, `status`, `node_id` |
| `harness_gateway.receipts` | request and `result` | Row, `receipt_digest` |
| `langgraph_checkpoint.*` | Entire checkpoint state | Nothing; deleted (a terminal run is never resumed) |

Redaction replaces a content column with the tombstone
`{"released": true, "releasedAt": ..., "digest": <original digest>}`. Execution history
(what ran, when, at what cost, with which result digest) survives; the content does not.
Anything that mattered was accepted into the case through a command and is in `ehf_case`.

### 3.3 Context (`ehf_context.context`)

As built (phase 4, §4.4) the context store is its own database, `ehf_context`, with pgvector
and Apache AGE, and the tables below are keyed by pack digest (`context.packs`,
`pack_sections`, `quarantine_signals`) rather than manifest digest, because every agent node
gets a pack but only nodes with a case snapshot get a manifest. The design below is the one
agreed; §4.4 lists where the build differs.

Owner: the context coordinator inside runtime-host (`assembleContextPack` callers) and the
future `POST /v2/cases/:id/context:resolve` endpoint. Readers: studio/flight recorder while
the case is open. Case-api never reads `context`; it sees only what was promoted to
evidence.

`context` is working data scoped to an open case, not a record. Its lifecycle is:

```text
 built ──► (cited by an accepted proposal) ──► promoted to evidence ──┐
   │                                                                  ├──► released after case CLOSED
   └──► (never cited: retries, failed or superseded attempts) ────────┘
```

What lasts after release is the `model_context` evidence objects (§3.6) and the ledger
events that cite them. Run-journal digests in `harness_runtime` stay too; they contain no
content.

```sql
create table context.manifests (
  tenant_id        text not null,
  manifest_digest  char(64) not null,     -- ContextManifest digest (timestamp-free, replayable)
  pack_digest      char(64) not null,
  case_id          text not null,
  run_id           text not null,
  work_item_id     text,
  node_id          text not null,
  execution_id     text,
  plan_digest      text not null,
  agent_profile_ref text not null,        -- catalog entry_id@version
  agent_profile_digest char(64) not null,
  snapshot_id      text not null,
  snapshot_digest  char(64) not null,
  case_sequence    bigint not null,       -- case state the pack was built from
  permission_envelope_digest char(64) not null,
  budget           jsonb not null,        -- limit, used, unit ('chars' today, 'tokens' later)
  manifest         jsonb not null,        -- schema harness.factory/context-manifest-v1, no content
  pack_artifact_ref text,                 -- artifact://executions/... rendered pack (has content)
  quarantined      boolean not null,
  created_at       timestamptz not null default clock_timestamp(),
  primary key (tenant_id, manifest_digest)
);
create index manifests_case_idx on context.manifests(tenant_id, case_id, created_at desc);
create index manifests_run_idx on context.manifests(tenant_id, run_id, node_id);

create table context.manifest_sections (
  tenant_id       text not null,
  manifest_digest char(64) not null,
  section_id      text not null,
  trust           text not null check (trust in ('TRUSTED_DATA','UNTRUSTED_EXTERNAL','UNTRUSTED_DATA')),
  disposition     text not null check (disposition in ('INCLUDED','DROPPED_BUDGET','QUARANTINED')),
  required        boolean not null,
  classification  text not null,
  purpose         text not null,
  provenance      text not null,          -- case:<id>@<seq>/<source>:<path> or evidence/chunk ref
  content_digest  char(64) not null,
  char_count      integer not null,
  primary key (tenant_id, manifest_digest, section_id),
  foreign key (tenant_id, manifest_digest) references context.manifests
);

create table context.quarantine_signals (
  tenant_id       text not null,
  manifest_digest char(64) not null,
  section_id      text not null,
  signal          text not null,          -- ignore_previous_instructions, role_override, ...
  detector_version text not null,
  primary key (tenant_id, manifest_digest, section_id, signal),
  foreign key (tenant_id, manifest_digest, section_id) references context.manifest_sections
);

-- Moved from case_core.knowledge_chunks. Derived and rebuildable; every chunk names its source.
-- Chunks built from one case's evidence carry case_id and are released with the case;
-- policy, procedure and reference chunks (case_id null) are shared and kept.
create table context.knowledge_chunks (
  tenant_id     text not null,
  chunk_id      text not null,
  case_id       text,
  source_kind   text not null check (source_kind in ('policy','procedure','evidence','reference')),
  source_ref    text not null,            -- evidence_id / policy digest / artifact ref
  source_digest char(64) not null,
  title         text not null,
  content       text not null,
  classification text not null,
  metadata      jsonb not null default '{}'::jsonb,
  embedding_model text not null,
  embedding     vector(1536) not null,
  created_at    timestamptz not null default clock_timestamp(),
  primary key (tenant_id, chunk_id)
);

-- One row per case whose context has been, or is being, released. Holds no content and
-- is never deleted, so "was this case's context released, when, and what survived" stays
-- answerable after the rows above are gone.
create table context.case_releases (
  tenant_id          text not null,
  case_id            text not null,
  closed_sequence    bigint not null,     -- ledger sequence of the CLOSED transition
  eligible_at        timestamptz not null, -- closed_at + grace period
  state              text not null check (state in ('SCHEDULED','BLOCKED','RELEASED','CANCELLED')),
  blocked_reason     text,                -- legal_hold | unpromoted_citation | case_reopened | active_execution
  manifests_released integer,
  packs_released     integer,
  chunks_released    integer,
  runtime_rows_redacted integer,          -- workflow / harness_runtime / gateway rows (§3.2)
  checkpoints_released integer,
  promoted_evidence  jsonb,               -- [{manifestDigest, evidenceId, bundleDigest}]
  released_at        timestamptz,
  released_by        text,
  primary key (tenant_id, case_id, closed_sequence)
);
```

Rows in `manifests`, `manifest_sections` and `quarantine_signals` are never updated
(trigger). The only delete path is the release function below.

**Promotion (at acceptance, not at close).** Before runtime-host submits a BusinessCommand
that carries model output (a finding, claim, recommendation or skill effect), it promotes
the manifest that produced it:

1. Build a canonical **context bundle**: the manifest, the agent profile reference and
   digest, the renderer version, and for each section either its content or, for
   `UNTRUSTED_EXTERNAL` sections that are already evidence, the `evidence_id` and content
   digest only. Case-record and predecessor-output sections are carried as content, because
   they are not otherwise kept in the form the model saw.
2. Re-render the pack from the bundle (pulling referenced evidence by digest) and check it
   reproduces `pack_digest`. A bundle that cannot reproduce the pack is not promoted.
3. Register the bundle through evidence intake as evidence type `model_context` (§3.6). The
   bundle is written to the evidence account, not referenced in place, so releasing
   `context-packs` can never remove it.
4. The command cites `context_evidence_id` and `context_manifest_digest`. Case-api links the
   evidence to the case in the same transaction as the proposal, and the CaseEvent payload
   carries both, so the ledger permanently records what the model was shown.

Promoting at acceptance means a decision record is complete the moment it is committed.
Nothing depends on a close-time batch succeeding.

**Release (after close).** A release job in runtime-host, running as `svc_context_release`:

1. Consumes the case's `CLOSED` ledger event through `workflow.inbox_receipts` and inserts
   a `case_releases` row with `eligible_at = closed_at + grace` (configurable, §7). A durable
   timer fires at `eligible_at`.
2. Asks case-api for release eligibility (`GET /v2/cases/:id/context-release`, new): the
   case is still `CLOSED` at `closed_sequence` (no reopen), no legal hold covers the case,
   and the list of `(manifest digest, evidence id)` pairs cited by accepted case records.
3. Checks that every cited manifest has a matching promoted bundle. Any failure sets
   `BLOCKED` with a reason and raises a reconciliation case. A legal hold is not a failure;
   the release waits until the hold is released.
4. Checks that no run or work item for the case is still live (non-terminal status or an
   unexpired lease). A live one blocks the release (`active_execution`).
5. Calls `context.release_case(tenant, case, closed_sequence)`, a security-definer function
   owned by `ehf_context_releaser`, in one control-database transaction. It deletes the
   case's `manifests`, `manifest_sections`, `quarantine_signals` and case-scoped
   `knowledge_chunks`. It redacts the workflow and runtime content columns listed in §3.2
   for the case's work items and runs (runs are matched on `input->>'caseId'`), deletes their
   LangGraph checkpoints, and records all counts on the `case_releases` row. The job then
   deletes the case's blobs under `context-packs/` and the case's `executions/` artifacts.
6. Submits `RecordContextReleased` to case-api. This is an allowed post-close command, so
   the ledger shows that the case's working data was released, when, and which promoted
   evidence ids remain.

Every step is idempotent: a retry after a crash re-runs the function, which finds nothing
left to delete or redact, and resubmits the command under the same idempotency key.

A case reopened after release starts with an empty context store, and new packs are built
from the current snapshot. The promoted bundles from before the reopen remain as evidence.
Earlier runs stay redacted; reopened work runs fresh.

### 3.4 Case (`ehf_case.case_core`)

Owner: case-api (the case command gateway). Nothing else writes `case_core`. Keep the
current tables. Changes:

- Enable and force RLS on every `case_core` table (today only three have it), using the
  existing `app.tenant_id` policy shape. RLS is defense in depth; case-api authorization
  stays mandatory.
- Move `knowledge_chunks` to `context` (§3.3) and `audit_exports` to `case_ledger` (§3.5).
- Add `context_evidence_id text` and `context_manifest_digest char(64)` to
  `case_decision_recommendations`, `case_findings`, `case_claims` and `skill_effects`
  (§3.3). An agent-originated proposal without both is rejected; the evidence id must name
  a `model_context` evidence object of the same case whose manifest digest matches.
- Add a duty trigger on `case_final_dispositions`: when the policy required human review,
  the disposing actor must differ from the actor of the cited recommendation and of any
  review that approved it. The case command gateway checks this first; the trigger catches
  a gateway bug.
- `status` changes only through commands: revoke UPDATE on `cases.status` from every role,
  and grant column-level UPDATE on the remaining mutable columns to `svc_case_api`.

### 3.5 Ledger (`ehf_case.case_ledger`)

Owner: case-api writes events in the same transaction as the case mutation. The ledger
exporter reads it. Nobody updates or deletes.

Keep `case_events`, `event_chain_heads`, `command_receipts`, `outbox`. Add:

```sql
create table case_ledger.ledger_segments (
  segment_id      text primary key,
  tenant_id       text not null,
  from_recorded_at timestamptz not null,
  to_recorded_at  timestamptz not null,
  event_count     bigint not null,
  case_heads      jsonb not null,         -- [{caseId, fromSequence, toSequence, headDigest}]
  merkle_root     char(64) not null,
  manifest_digest char(64) not null,
  signature       text not null,
  signing_key_id  text not null,
  export_ref      text not null,          -- artifact://ledger-export/... in the audit account
  immutability_state text not null,
  created_at      timestamptz not null default clock_timestamp()
);

-- Moved from case_core.audit_exports (per-case export documents).
alter table case_core.audit_exports set schema case_ledger;

create table case_ledger.rejected_commands (   -- command audit for rejections (canonical §3:
  tenant_id   text not null,                    -- rejections are not ledger events)
  case_id     text not null,
  command_id  text not null,
  command_type text not null,
  actor       jsonb not null,
  reason_code text not null,
  request_digest char(64) not null,
  rejected_at timestamptz not null default clock_timestamp(),
  primary key (tenant_id, case_id, command_id)
);
```

Triggers reject UPDATE and DELETE on `case_events`, `command_receipts`, `ledger_segments`,
`rejected_commands`, regardless of role. `outbox` allows UPDATE only of `published_at` and
`publish_attempts`, and only for `svc_outbox_relay` (column-level grant). `event_chain_heads`
is updated only by the append function. Partition `case_events` by `recorded_at` month once
load tests justify it.

Append path: a `security definer` function `case_ledger.append_event(...)` owned by
`ehf_ledger_writer` (NOLOGIN) that locks the chain head, checks
`previous_event_digest`, inserts the event and the outbox row, and advances the head.
`svc_case_api` gets EXECUTE on it and SELECT on the tables, and **no INSERT on
`case_events`**. The chain cannot then be forked by a direct insert.

### 3.6 Evidence (`ehf_case.evidence` + blob)

Owner: the evidence intake path under its own role, `svc_evidence_intake`. Today
registration is `registerEvidence` in `packages/case-store`, reached through case-api;
it should run as a separate intake component (or at least a separate pool and role inside
case-api). `apps/evidence-pipeline` keeps its own working store (SQLite or its own Postgres
schema) and is treated as an external producer: its output enters only through intake. Linking evidence to a case is a case command
(case-api), per canonical store §16: an uploaded blob is not accepted evidence, and a
registered evidence object does not change case truth.

Keep `artifacts`, `evidence_objects`, `transformations`, `lineage_edges`,
`registration_receipts`, `outbox`. Changes:

```sql
alter table evidence.artifacts
  add column storage_account text,
  add column container text,
  add column blob_name text,            -- evidence/sha256/ab/cd/<digest>
  add column blob_version_id text,
  add column retention_until timestamptz,
  add column verified_at timestamptz;   -- last server-side digest/property check
-- content bytea stays nullable and is used only when backend = 'postgres' (local/dev).

create table evidence.retention_assignments (
  tenant_id     text not null,
  artifact_digest char(64) not null,
  retention_class text not null check (retention_class in ('KYC_REGULATED','DECISION_RECORD',
                    'EXECUTION_SUPPORT','TRANSIENT_UPLOAD','QUARANTINE')),
  basis         text not null,          -- case closed at / policy rule / decision
  retain_until  timestamptz,            -- null until the triggering event (e.g. case closure)
  storage_policy_state text not null,   -- PENDING | APPLIED | LOCKED | FAILED
  assigned_by   text not null,
  assigned_at   timestamptz not null default clock_timestamp(),
  primary key (tenant_id, artifact_digest, assigned_at)
);

create table evidence.legal_holds (
  tenant_id   text not null,
  hold_id     text not null,
  matter_ref  text not null,            -- opaque; matter detail lives with legal, not here
  scope       jsonb not null,           -- case ids, subject ids, date ranges
  authority   jsonb not null,
  placed_by   text not null,
  placed_at   timestamptz not null,
  released_by text,
  released_at timestamptz,
  primary key (tenant_id, hold_id),
  check (released_by is null or released_by <> placed_by)
);

create table evidence.legal_hold_targets (
  tenant_id   text not null,
  hold_id     text not null,
  artifact_digest char(64) not null,
  storage_state text not null,          -- PENDING | APPLIED | FAILED
  applied_at  timestamptz,
  primary key (tenant_id, hold_id, artifact_digest),
  foreign key (tenant_id, hold_id) references evidence.legal_holds
);

create table evidence.reconciliation_runs (  -- daily blob inventory vs metadata
  run_id      text primary key,
  started_at  timestamptz not null,
  finished_at timestamptz,
  checked     bigint,
  missing_blob bigint,
  orphan_blob bigint,
  digest_mismatch bigint,
  policy_mismatch bigint,
  report_ref  text
);
```

**`model_context` evidence** (promoted context bundles, §3.3). `evidence_type =
'model_context'`; `source` = `{type: 'CONTEXT', manifestDigest, packDigest, runId, nodeId,
executionId, agentProfileRef, rendererVersion}`; `trust.instructionTrust =
'UNTRUSTED_DATA'`; retention `DECISION_RECORD`. Lineage edges record
`model_context -INCLUDES-> evidence` for each referenced evidence section and
`proposal -PRODUCED_FROM-> model_context` for the case record that cites it. Context
selectors must never select `model_context` evidence into a new pack: a model is never shown
an earlier model's prompt as data.

Enable and force RLS on all evidence tables. `artifacts` is keyed `(tenant_id, artifact_digest)`,
so identical bytes uploaded by two tenants are two rows and two authorizations, while the
blob itself can be shared.

Blob layout (canonical store §17), one storage account per boundary:

| Account | Containers | Writer | Immutability |
| --- | --- | --- | --- |
| `evidence` | `staging/{tenant}/{upload}`, `quarantine/{tenant}/{artifact}`, `evidence/sha256/..`, `normalized/sha256/..` | `svc_evidence_intake` | Version-level WORM on `evidence`, `normalized`; none on `staging` |
| `executions` | `executions/{yyyy}/{mm}/{execution}/{digest}`; `context-packs/{tenant}/{case}/{manifest}` | runtime-host; `svc_context_release` deletes `context-packs` | No WORM. `context-packs` is deleted at release; a lifecycle rule (closure + grace + 30 days) catches anything the job missed. Decision copies live in the `evidence` account, never here |
| `audit` (separate admin boundary) | `ledger-export/{yyyy}/{mm}/{dd}/{segment}`, `manifests/` | `svc_ledger_exporter` | Locked container WORM |

Clients never get a raw storage URI: downloads go through case-api, or through a
single-object, short-lived user-delegation SAS issued for a stated purpose.

## 4. Separation of duties

### 4.1 Database roles

Role scheme for both databases:

- **Owner roles** (NOLOGIN): `ehf_control_owner`, `ehf_case_owner`. They own schemas,
  tables and security-definer functions. Only the migrator assumes them.
- **Function-owner roles** (NOLOGIN): `ehf_ledger_writer` (owns `append_event`),
  `ehf_workflow_controller` (RLS bypass by membership, §3.2), `ehf_context_releaser`
  (owns `context.release_case`, the only delete path in `context`).
- **Service login roles**: one per workload, NOSUPERUSER, NOBYPASSRLS, NOCREATEROLE,
  never owners. Authenticated in production by the database's own mechanism (client
  certificate or a mounted password file); services take only a connection URL
  (`DATABASE_AUTH=url`).
- **Human roles**: no standing write access to either database. Break-glass is time-bound
  (PIM) and audited.

Grant matrix. R = select, I = insert, U = update (column-limited where noted), X = execute
named functions only, — = no access (and for a whole database, no CONNECT).

| Service role | catalog | workflow / harness_runtime | context | case_core | case_ledger | evidence |
| --- | --- | --- | --- | --- | --- | --- |
| `svc_migrator` | owner (migrations only, not at runtime) | owner | owner | owner | owner | owner |
| `svc_control_api` | R I (versions, lifecycle events); U on drafts | X operator procedures | R | — | — | — |
| `svc_runtime_host` (kernel, dispatcher) | R `published` view | R I U, member of `ehf_workflow_controller` | R I | — | — | — |
| `svc_reconciler` | R | X sweep/recovery procedures | R | — | — | — |
| `svc_capability_gateway` | R `published` view | R I U D own receipts only (`harness_gateway.receipts`; abandon deletes today) | R `knowledge_chunks` | — | — | — |
| `svc_context_release` | — | R `inbox_receipts`, `work_items`, `runs` (status and lease only); I `durable_timers`; redaction only through `release_case` | R; I U `case_releases`; X `release_case` | — | — | — |
| `svc_case_api` | R `published` (policy lookup) | X `lock_case_execution`, `matches_fincrime_outcome` | — | R I U (column-limited, no DELETE) | R; X `append_event`; I `command_receipts`, `rejected_commands` | R; I `lineage_edges` |
| `svc_evidence_intake` | — | — | — | R `cases` (existence and tenant check only) | — | R I; U `artifacts` storage/verification columns |
| `svc_outbox_relay` | — | I `inbox_receipts` | — | — | R `outbox`; U `published_at`, `publish_attempts` | R `outbox`; U same columns |
| `svc_ledger_exporter` | — | — | — | — | R; I `ledger_segments` | — |
| `svc_legal_hold` | — | — | — | — | R | R; I `legal_holds`, `legal_hold_targets`; U `released_*` and `storage_state` |
| `svc_projector` (search, read models) | R | R | R | R | R | R metadata |
| `ro_audit_verifier` | R | R | R | R | R | R metadata |
| Agent / worker runtimes | — | — | — | — | — | — |

What the matrix guarantees:

- **Workflow cannot change business truth.** runtime-host has no login on `ehf_case`.
  Work results reach the case only as BusinessCommands over case-api's HTTP API.
- **Case cannot drive execution.** case-api can only ask, through one security-definer
  function, whether an execution still holds its lease. It cannot read or write work items.
- **Agents hold no data credentials.** Workers reach models and tools through the
  capability gateway with a short-lived execution token. They have no database, storage or
  key access (execution-control-plane §12).
- **The gateway loses its case-database credential** once `knowledge_chunks` moves to
  `context`.
- **Only the append function writes the ledger,** and triggers forbid UPDATE/DELETE even for
  the owner outside migrations.
- **No identity can both alter ledger data and erase its export.** The ledger exporter writes
  to the audit account but has no delete right there, and the audit account is administered
  by a different team from the database.
- **Evidence intake cannot accept evidence into a case.** It registers bytes and metadata;
  the link and its ledger event are a case-api command.
- **Releasing context cannot damage the decision record.** `svc_context_release` can delete
  only in `context` (through one function) and in the `context-packs` container. It has no
  login on `ehf_case` and no rights on the `evidence` account, where the promoted bundles
  are under WORM. It cannot release a case that case-api reports as open, reopened or
  under legal hold.

### 4.2 Human duties

| Duty | Held by | Must not also hold | Enforced by |
| --- | --- | --- | --- |
| Author a plan, agent profile, skill or policy | Author | Approver of the same version | `catalog.lifecycle_events` trigger; existing authoring check |
| Approve and publish to the catalog | Approver / release manager | Author or evaluator of that version | Same trigger |
| Deploy services and run migrations | Platform engineer | Policy approval, case decisions | CI/CD environment protections; migrator role used only by the pipeline |
| Propose a disposition (agent or analyst) | Analyst, agent | Final disposition when review is required | Case command gateway plus `case_final_dispositions` trigger |
| Review or QA a case | Reviewer | Recommender on the same case | Case command gateway (`case_reviews`) |
| Place a legal hold | Legal hold officer | Release of the same hold | `legal_holds` check constraint plus case-api authorization |
| Administer databases | DBA | Storage administration of the audit account; key administration | Infrastructure IAM, separate accounts/projects |
| Administer keys | Key administrator | Database or storage data-plane access | Key management service access policy |
| Verify the audit trail | Auditor | Any write role | `ro_audit_verifier` only |

### 4.3 Row-level security

Keep the `app.tenant_id` policy shape. It becomes effective only once services stop
connecting as a superuser, which is phase 1 of §6. Every tenant-scoped table in all six
stores gets `enable` + `force row level security`. The service sets `app.tenant_id` with
`set_config(..., true)` at the start of every transaction (transaction-scoped, so it is
safe under PgBouncer transaction pooling). A transaction that forgets to set it sees no
rows rather than all rows, because `nullif(...,'')` yields null.

### 4.4 As built

Phase 1 is implemented. Where this section and §4.1 differ, this section describes the code.

| Piece | Where |
| --- | --- |
| Control-database groups and controller roles; workflow and integration policies check role membership, not a session flag | `packages/persistence/migrations/036_service_roles.sql` |
| Case-database groups; forced tenant policy on every case, ledger and evidence table; relay functions | `packages/case-store/migrations/012_service_roles_and_tenant_isolation.sql` |
| Grant matrices, revoked and re-applied in one transaction on every migration run | `packages/persistence/grants.sql`, `packages/case-store/grants.sql` |
| Every case-store read and write binds `app.tenant_id` in its transaction | `bindCaseTenant`, `withCaseTenant` in `packages/case-store/src/index.ts` |
| Local logins, one per service, created by the migrate job; compose services connect with them | `packages/persistence/src/dev-logins.ts`, `compose.yaml` |
| Tests: every table is in the matrix, each service can do its work and is refused outside its row, tenants are isolated, the old flag no longer works | `packages/persistence/src/grants.test.ts`, `packages/case-store/src/grants.test.ts`, CI job `database` |

The case API also maintains the rebuildable document index under `ehf_svc_document_index` in the context database; that group grants no access to context packs. See [context operations](context-operations.md) for retrieval scope and lifecycle.

Groups are NOLOGIN; a deployment creates one login role per workload (authenticated by
certificate or a mounted password file) and grants it its group:

```sql
grant ehf_svc_control_api        to "svc-control-api";
grant ehf_svc_runtime_dispatcher to "svc-runtime-worker";
grant ehf_svc_runtime_checkpoint to "svc-runtime-host";
grant ehf_svc_capability_gateway, ehf_svc_case_retrieval to "svc-capability-gateway";
grant ehf_svc_integration_worker to "svc-integration-worker";
grant ehf_svc_case_api, ehf_svc_case_outbox_relay, ehf_svc_case_execution, ehf_svc_document_index to "svc-case-api";
```

Roles are cluster-wide, so one PostgreSQL cluster serves one environment. No principal may
be a superuser or have BYPASSRLS; the migration identity is the only one that owns objects.

Differences from §4.1, and what is left for later phases:

- **Relay.** The outbox relay runs inside case-api. Rather than give case-api a cross-tenant
  exception, the relay's four operations (claim, mark published, release claim, purge) are
  security-definer functions owned by `ehf_case_relay_controller`, and the relay role may
  only execute them. They return outbox metadata, never payloads.
- **Integration controller.** control-api is a member of `ehf_integration_controller`
  because it resolves an inbound event's binding before it knows the tenant. Moving that
  lookup into a function would let control-api drop the membership.
- **Table grants instead of procedures.** Operator commands on workflow (control-api) and
  the ledger append (case-api) are still table grants (`select, insert` on `case_events`,
  no update or delete). The `append_event` function and immutability triggers are phase 3.
- **Control-plane tables without RLS.** `harness_runtime.runs`, `run_events`,
  `node_attempts`, `harness_control.plans`, `authoring_*`, the budget tables,
  `harness_admin.*` and `harness_gateway.receipts` have a tenant column but no policy yet.
  Grants already limit who reaches them; tenant policies on them are follow-up work.
- **Gateway.** It still holds a case-database login, now limited to `select` on
  `knowledge_chunks`. It loses it in phase 4 when the index moves to `context`.
- **Two tables are granted to nobody** because no code uses them:
  `harness_control.signing_key_revocations`, `harness_control.release_allocations`.

**Phase 2: separate databases.** The control store (catalog, workflow, runtime,
integration, checkpoints) lives in `ehf_control` and the case store (case, ledger,
evidence) in `ehf_case`.

| Piece | Where |
| --- | --- |
| Each grant file also controls who may connect: `PUBLIC` loses CONNECT and TEMP, and only the database's own groups get CONNECT | `packages/*/grants.sql` |
| The migrate job creates both databases when missing, through a maintenance-database URL (`DATABASE_BOOTSTRAP_URL`); a cloud deployment provisions them instead | `packages/persistence/src/ensure-databases.ts`, `migrate-entrypoint.sh`, `pnpm db:migrate` |
| Compose gives each service only the URLs it uses; superuser URLs exist only on the migrate job | `compose.yaml` (`x-runtime-env` carries no database URL) |
| Test: both databases built from scratch, each schema set in its own database, control-plane logins refused by the case database, case-api checking a lease in one database while writing the other | `packages/case-store/src/split-databases.test.ts`, CI job `database` |

Who reaches which database:

| Service | `ehf_control` | `ehf_case` |
| --- | --- | --- |
| control-api, runtime-worker, integration-worker | `DATABASE_URL` | cannot connect |
| runtime-host (checkpoints) | `RUNTIME_CHECKPOINT_DATABASE_URL` | cannot connect |
| capability-gateway | `DATABASE_URL` | `CASE_DATABASE_URL`, retrieval index only |
| case-api | `EXECUTION_DATABASE_URL`, two lease functions only | `CASE_DATABASE_URL` |

There is no distributed transaction. case-api holds a shared lock on the run (and work
item) row in the control database while it commits to the case database, so a cancelled
run or a replaced lease cannot commit, as before. Case events reach the control plane
through the outbox relay over HTTP. Running both schema sets in one database still works
(the grants union), which the remaining database tests use.

On an existing local volume the old single database `ehf` keeps its data; the stack now
reads `ehf_control` and `ehf_case`, which start empty. Remove the volume
(`docker compose down -v`) for a clean start.

**Phase 3: the hardened ledger.**

| Piece | Where |
| --- | --- |
| `case_ledger.append_event`, owned by `ehf_ledger_writer`, is the only way into `case_events`; it locks the chain head, requires the next sequence linked to the current head, refuses a reused digest or an unbound tenant, and writes the event, the outbox row and the new head together | `packages/case-store/migrations/013_ledger_hardening.sql`, `appendCaseEvent` |
| case-api lost INSERT on `case_events`, `event_chain_heads` and the case outbox; it executes `append_event` instead | `packages/case-store/grants.sql` |
| Triggers refuse UPDATE, DELETE and TRUNCATE on `case_events`, `command_receipts`, `rejected_commands`, `ledger_segments` and `audit_exports`, for every role including the table owner | migration 013 |
| `audit_exports` moved from `case_core` to `case_ledger`; `rejected_commands` records every refused command (4xx) with its reason, best effort | migration 013, `recordRejectedCommand` |
| Signed segments: per tenant, each case's events after its export cursor, as canonical NDJSON plus a manifest (case ranges, Merkle root, bytes digest, link to the previous segment) signed RS256; recorded in `ledger_segments`, cursors in `export_cursors` | `packages/case-store/src/ledger-export.ts`, `ledger-segment.ts` |
| Offline verification with only the public key: signature, bytes, every event digest recomputed, every case chain within and across segments, Merkle root, unbroken series from segment 1 | `ledger-segment.ts` (`verifyLedgerSegments`), `pnpm --filter @ehf/case-store ledger:verify <dir> <public-key.pem>` |
| Exporter role `ehf_svc_ledger_exporter` (reads events, inserts segments, moves its cursors); local login and a one-shot compose job (`--profile ledger-export`) | `grants.sql`, `dev-logins.ts`, `compose.yaml` |
| Tests: every runtime role refused direct ledger writes, the owner refused changes, forks and replays refused, refused commands recorded, segments verify and tampering, a wrong key or a missing segment is reported | `packages/case-store/src/ledger.test.ts` |

Choices and limits:

- **Digest checked on verification, not on append.** The canonical JSON that event digests
  are computed over is defined in TypeScript (`stableDigest`), so `append_event` enforces
  the chain (sequence, link, uniqueness) and the digest itself is recomputed by
  `verifyCaseLedger` and by the offline verifier. A forged digest cannot rewrite history;
  it is reported as a content mismatch.
- **Timestamps.** Event digests now cover `occurredAt` and `recordedAt` in the form they
  are read back (`toISOString()`). Before this, a caller-supplied `occurredAt` without
  milliseconds made a genuine event fail verification.
- **Segments follow per-case sequences, not time.** Sequences are gapless and assigned
  under the case lock, so an event that commits late is picked up by the next run instead
  of falling between two time windows. Runs for one tenant are serialized.
- **What a superuser can still do.** A superuser can disable triggers. That is why the
  signed segments exist: a change made that way no longer matches what was exported.
- **Not yet:** the exporter is told which tenants to export
  (`LEDGER_EXPORT_TENANTS`) rather than discovering them; production signs with a mounted
  private key (`LEDGER_EXPORT_SIGNER=private_key`, `LEDGER_EXPORT_PRIVATE_KEY_FILE`).

**Phase 4: the context store.**

| Piece | Where |
| --- | --- |
| `ehf_context`: pgvector and Apache AGE; `context.packs`, `pack_sections`, `quarantine_signals` (forced tenant policies); the retrieval index `context.knowledge_chunks` moved out of the case database | `packages/context-store/migrations/001_context_store.sql` |
| Provenance graph `(Pack)-[:DRAWS_ON {sectionId, trust, disposition}]->(Source)`: each pack linked to the case reads, evidence objects, predecessor outputs and receipts it drew on. Services reach it only through security-definer functions that take the tenant from the bound transaction (`graph_link_pack`, `graph_packs_drawing_on`, `graph_sources_of`) | migration 001, `packsDrawingOn`, `sourcesOfPack` |
| Every pack a model is shown is recorded before the model sees it: at assembly, and each pack an agent loop re-seals after a tool observation. A pack that cannot be recorded is not shown | `runtime-langgraph`, `POST /v1/runtime/context-packs` (control-api: runtime grant, live fence, run, plan, case and node must match, `verifyContextPackDigest`) |
| Promotion: before an agent node's case writes, the runtime registers the pack its model answered from as `model_context` evidence (`DECISION_RECORD`) and every command cites `contextEvidenceId` and `contextPackDigest`; the ledger event carries both | `executeCaseWrites` |
| Enforcement: the envelope broker marks agent reasoning nodes `context_required`; case-store refuses an agent command without a citation under it, and a citation to anything but `model_context` evidence of the case, created by an agent, whose content recomputes to the cited digest for this run and node. Only the node's own envelope can register `model_context` evidence | `requireContextCitation`, `assertModelContextPromotion` |
| Snapshots, which models are shown, never contain `model_context` evidence | `modelVisibleEvidence` |
| Release: after a case has been closed for the grace period (`CONTEXT_RELEASE_GRACE_DAYS`, default 30, per tenant `CONTEXT_RELEASE_GRACE_DAYS_BY_TENANT`), unless a citation is unpromoted or a run or work item is still live, the job deletes the case's packs, sections, signals, case-scoped chunks and graph nodes, redacts the control database's working content to digest markers, and records `context.released` in the case's ledger. Each case is tracked in `context.case_releases` | `packages/context-store/src/release.ts`, `context.release_case`, `harness_runtime.release_case_working_data`, case-api `/v1/context-release/cases`, `/v1/cases/:id/context-release` |
| Roles: `ehf_svc_context_writer` (control-api), `ehf_svc_context_retrieval` (gateway, which now has no case-database access), `ehf_svc_context_release` and `ehf_svc_case_data_release` (the release job: functions, no tables), workload role `Context.Release` in case-api (release endpoints and case reads, no writes) | `grants.sql` files, `authorization.ts` |

Choices and limits:

- **AGE is preloaded per database.** Preloaded server-wide, AGE's drop hook breaks `DROP
  TABLE` in databases without the extension, so the migration sets
  `session_preload_libraries = 'age'` on `ehf_context` only. That needs a superuser. Managed
  PostgreSQL services that offer only the server-wide setting and no superuser: there, host `ehf_context` on its own server (or confirm the AGE version has fixed
  the drop hook) and preload AGE server-wide.
- **AGE 1.5 quirks** shaped the graph functions: values from `UNWIND` over a parameter list
  do not bind and `SET` after `MERGE` does not persist, so the functions loop per source and
  put every property in the `MERGE` pattern; `WHERE NOT (pattern)` is not supported, so
  orphan sources are found with `OPTIONAL MATCH` and a count. CI and local development use
  AGE 1.5 (Ubuntu); the compose image builds 1.6.0 from a pinned commit (not built here).
- **What is promoted is the whole pack.** It recomputes to its digest on its own, which is the
  "re-render check"; storing evidence sections by reference instead of content is a later
  optimisation.
- **Legal hold.** The eligibility endpoint reports whether an active hold covers the case
  (phase 5), and the job blocks while one does.
- **Checkpoints.** LangGraph's tables are created by the control migrations
  (`043_langgraph_checkpoint_tables.sql`, the saver's own migrations recorded in its ledger) and
  owned by the migration identity. The runtime host does not run the saver's `setup()`, whose
  `CREATE SCHEMA IF NOT EXISTS` needs CREATE on the whole database; it checks the ledger is at
  the version its package expects and holds DML on the tables only. `grants.sql` grants the
  release function select and delete on them.
- **Not yet:** the release job is told which tenants to process (`CONTEXT_RELEASE_TENANTS`); `ehf_context` has no signed
  export (it is working data, and what decisions relied on is in the ledger and evidence).

**Phase 5: evidence, segments and packs on blob storage; retention, holds, reconciliation.**

| Piece | Where |
| --- | --- |
| `@ehf/blob-store`: one S3-compatible bucket per purpose (`EVIDENCE`, `LEDGER_EXPORT`, `CONTEXT_PACK`, each from `<PURPOSE>_BLOB_*`). Writes never overwrite: the same name with the same bytes is a no-op, other bytes are refused. Retention is never shortened and stays locked once locked. Without object lock (`<PURPOSE>_BLOB_IMMUTABILITY=none`, a bucket created without it) policy calls answer `NOT_ENFORCED` instead of pretending. Under the production profile the endpoint must be https, object lock is required, and the secret key must come from a mounted file | `packages/blob-store` |
| Evidence bytes in the evidence container (`CASE_ARTIFACT_BACKEND=object_store`, required under the production profile): content-addressed per tenant (`tenants/<tenant hash>/sha256/ab/cd/<digest>`), bytes before the row, the row as metadata, and every read (content, citation checks, audit export) verified against the recorded digest | case migrations 015 and 018, `artifactBytes` |
| Retention: each evidence object gets an assignment from its class's rule at registration (a trigger, so every path). `KYC_REGULATED` and `DECISION_RECORD` run seven years from closure, locked; `EXECUTION_SUPPORT` two years from closure; `TRANSIENT_UPLOAD` one day and `QUARANTINE` 90 days from registration. A date only ever moves later (trigger, even for the owner). Retention classes are a closed set in the contract | case migration 016, `evidence.retention_rules`, `retention_assignments` |
| Legal holds over cases: placed by a person with `Legal.HoldOfficer` through case-api, released by a different officer (check constraint and store); a hold record changes only by its release and is never deleted. Every artifact of a held case, including evidence registered under the hold, is a target. The case ledger records `legal_hold.placed` / `legal_hold.released` without the matter reference | `evidence.legal_holds`, `legal_hold_targets`, `placeLegalHold`, `releaseLegalHold`, case-api `/v1/legal-holds` |
| The evidence governance job (`ehf_svc_evidence_retention`): dates closure-based assignments, gives storage the longest date each artifact needs (while the case is open, at least registration plus the period), sets and clears blob legal holds (a blob stays held while any active hold targets it), and records what storage was told on the artifact row. A storage failure marks the row `FAILED` for the next run | `packages/case-store/src/governance.ts` (`pnpm --filter @ehf/case-store evidence:govern`, compose `evidence-governance`) |
| Reconciliation, after each governance pass: the tenant's blob listing against its artifact rows (missing, orphan, length and recorded-digest mismatches; with version-level immutability, retention, lock or hold that storage does not carry), plus a sample downloaded and hashed (`EVIDENCE_VERIFY_SAMPLE`). Each run is recorded with counts and the first findings; it never deletes | case migration 017, `reconcileTenantEvidence`, `evidence.reconciliation_runs` |
| Signed ledger segments in the ledger export container (required under the production profile), verifiable from the container as from a directory | `createBlobSegmentStore`, `segmentStoreFromEnv`, `verifyLedgerContainer` |
| Context pack bodies in the pack container under a per-case prefix; the row keeps the location (no database fallback under the production profile). The release job deletes a case's pack blobs before its rows and counts them in the ledger's release event | context migration 003, `recordContextPack`, `deleteCasePackBlobs` |

Choices and limits:

- **Where object lock is tested.** Store tests run against an in-memory container with the
  same rules (`@ehf/blob-store/testing`). The blob-store contract suite also runs against a
  real S3-compatible server when `EHF_TEST_S3_ENDPOINT` is set (CI job `object-store`, RustFS
  with object lock), which covers retention, compliance-mode locking and legal holds.
- **Retention is applied, not enforced as deletion.** Nothing deletes evidence when its date
  passes: that is the human-gated `evidence.retention.enforce` skill. Reconciliation reports
  orphan blobs (usually a registration whose transaction failed after the bytes were written)
  and leaves them.
- **Holds name cases.** Subject and date-range scopes from the original design are not built;
  `matter_ref` is opaque and stays out of the ledger.
- **The ledger export container is WORM by container policy**, provisioned with the account;
  the exporter sets no per-blob retention. Pack containers carry no WORM: they are working
  data, deleted at release (a lifecycle rule as a backstop is a deployment setting).
- **Local development keeps the database backends** unless a developer runs the `blob`
  compose profile and sets the connection strings in `.env.local` (see `.env.local.example`);
  no emulator key is committed.
- **Not yet:** evidence intake still runs inside case-api (not a separate component and role);
  downloads go through case-api only (no user-delegation SAS); jobs are told which tenants to
  process (`EVIDENCE_RETENTION_TENANTS`).

## 5. How the stores interact

There are no distributed transactions. Every cross-store handoff is an outbox write in the
source transaction, an idempotent inbox write in the destination, and a reference by id
plus digest.

```text
            ehf_control                               ehf_case
 ┌──────────────────────────────┐        ┌──────────────────────────────────┐
 │ catalog ── published view    │        │ case_core ◄── case-api (only)    │
 │   │                          │        │    │  same txn                   │
 │   ▼                          │  HTTP  │    ▼                              │
 │ workflow ── runtime-host ────┼───────►│ case_ledger.append_event ─ outbox ┼──┐
 │   ▲   ▲                      │ cmds   │ evidence ◄── intake               │  │
 │   │   └ inbox_receipts ◄─────┼────────┼─────────────── outbox relay ◄─────┼──┘
 │   │                          │        └──────────────────────────────────┘
 │ context ── manifests         │                 │ artifact://
 └──────────────────────────────┘                 ▼
            │ artifact://              blob: evidence | executions | audit
            ▼
```

A KYC step end to end:

1. case-api creates the case: `case_core` rows, a ledger event and an outbox row in one
   transaction.
2. The relay publishes; runtime-host records `workflow.inbox_receipts` and creates work
   items with `case_sequence_basis` set to the event's sequence.
3. The dispatcher leases a work item (fencing epoch incremented).
4. The context coordinator reads the purpose-bound snapshot from case-api over HTTP,
   assembles the pack, writes it to `context-packs`, and writes `context.manifests`
   and `manifest_sections`.
5. The worker calls tools through the gateway; provider output is registered as
   evidence by intake (blob first, then metadata, then the evidence outbox).
6. runtime-host promotes the manifest behind the result: it builds the context bundle,
   checks that it re-renders to the same pack digest, and registers it through intake as
   `model_context` evidence.
7. runtime-host submits a BusinessCommand (for example, record finding) citing evidence
   ids, the `model_context` evidence id, the manifest digest and its lease. case-api checks
   the lease through `lock_case_execution`, checks the `model_context` evidence, applies the
   change, links the evidence and appends the ledger event in one transaction.
8. The outbox event advances `workflow.case_cursors`; the kernel recomputes readiness.
9. Human review and disposition follow the same command path, with the duty checks in §4.2.
10. The case closes. After the grace period, the release job confirms the case is still
    closed, not under hold, and that every cited manifest was promoted. It then deletes the
    case's context rows and packs and records `RecordContextReleased` in the ledger (§3.3).

## 6. Delivery phases

Each phase can ship on its own and leaves the system working.

| Phase | Change | Done when |
| --- | --- | --- |
| 1. Roles and RLS (**done**, §4.4) | Add a `grants` migration step per database that creates the roles in §4.1 and applies the matrix; services connect as their own role; replace the `app.workflow_controller` GUC with role membership; enable RLS on remaining `case_core` and `evidence` tables | A security test (extending `security.database.test.ts`) shows each role is refused everything outside its row of the matrix, and cross-tenant reads return no rows |
| 2. Two databases (**done**, §4.4) | Compose and deploy run `ehf_control` and `ehf_case`; `CASE_DATABASE_URL` and `EXECUTION_DATABASE_URL` differ from `DATABASE_URL` | Full local stack and e2e pass with the split; runtime-host has no case-database URL |
| 3. Ledger hardening (**done**, §4.4) | `append_event` function, immutability triggers, `ledger_segments`, move `audit_exports`, `rejected_commands` | Direct INSERT/UPDATE/DELETE on `case_events` fails for every runtime role; an exported segment verifies offline |
| 4. Context store (**done**, §4.4) | `context` schema, persist manifests and packs, promotion to `model_context` evidence with re-render check, context evidence id and digest on proposals, release job with `case_releases`, move `knowledge_chunks`, gateway drops `CASE_DATABASE_URL` | After a closed case is released, its `context` rows and packs are gone, its workflow and runtime content is redacted to digests, and every model-produced record in the case still resolves, through evidence alone, to a bundle that re-renders the exact pack the model saw. A case under legal hold or reopened is not released |
| 5. Evidence on blob (**done**, §4.4) | Blob artifact backend, retention assignments, legal holds, daily reconciliation | New evidence lands in WORM blob; reconciliation reports zero mismatches on the test corpus |
| 6. Catalog consolidation | `catalog` schema, `versions` and `lifecycle_events` spine, approval trigger, compatibility views | The runtime resolves only from `catalog.published`; self-approval is rejected by the database |

## 7. Decided

1. **Context release grace period.** 30 days after `CLOSED`, configurable per tenant, to
   leave time for post-close QA.
2. **What is promoted.** Only context cited by accepted case records is promoted to
   `model_context` evidence. Uncited attempts (retries, failed or superseded runs) are
   released with nothing kept but their content-free digests.
3. **Release covers all case working data in the control database**, not only `context`:
   workflow and runtime content columns are redacted and checkpoints deleted (§3.2, §3.3).
4. **Workflow stays in the control database** (§1 decision 3), separate from case truth.
   execution-control-plane.md §7 is updated to match.

## 8. Open decisions

1. **Retention sign-off.** Compliance to confirm the periods now in `evidence.retention_rules`
   (seven years from closure, locked, for `KYC_REGULATED` and `DECISION_RECORD`, including
   `model_context` bundles; two years for `EXECUTION_SUPPORT`; one day for `TRANSIENT_UPLOAD`;
   90 days for `QUARANTINE`), and that redacting execution content after release meets record
   keeping obligations. A locked retention cannot be shortened once applied, so this should be
   settled before production data is written.
2. **Global catalog entries.** `tenant_id = '_global'` versus a separate global schema.
   The sentinel keeps one RLS policy shape (`tenant_id in (app.tenant_id, '_global')`) for
   reads.
3. **Search/analytics projections** (a search index, a lake) are out of scope. They are
   derived, read-only from `svc_projector`, and rebuildable from these stores.
4. **Tenant isolation tier.** Shared tables with RLS are assumed throughout. Dedicated databases
   per regulated tenant would reuse the same schemas and roles unchanged.
