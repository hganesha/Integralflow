# Canonical records

Status: implemented for the KYB slice (`domains/archive/kyb-deterministic`) and individual KYC (`domains/archive/kyc-v2-deterministic`), and
for records proposed by hosted skills ([below](#skill-originated-records));
synthetic library skills, not production-qualified.

The financial-crime skill library reasons over typed business records (RegistryRecord,
WatchlistEntry, OwnershipInterest, Entity, Party, DocumentPage, Evidence, …; 58 consumed types).
Its skills are deterministic reasoning, not provider callers. On the platform the work is split:

```
connector (gateway adapter) ──► normalizer ──► output.records ──► RecordCanonicalRecords ──► case_core.canonical_records
                                                                                                        │
library skill node ◄── SkillCapabilityInput.v1 ◄── context plane (requirement check) ◄── snapshot data.records.<Type> (projected)
        │                                                                                               ▲
        └── CanonicalRecord proposals ──► runtime ──► case API skill-commit ──► RecordCanonicalRecords ─┘
```

## Record contract (`packages/contracts`, append-only block)

`canonicalRecordSchema` follows the library's `Record` (`schemas/runtime/Record.schema.json`)
field for field — `object_type`, `version_id`, `schema_version`, `data`, `subject_ids`,
`valid_from`/`valid_to`, `observed_at`/`recorded_at`, `source_refs` (library `Ref`s),
`classification`, `purposes`, `synthetic`, `supersedes` — with these differences:

| Library | Platform | Why |
| --- | --- | --- |
| `id` | `object_id` | Same key as the library's own `Ref.object_id`. |
| `tenant_id` | `tenant_id`, plus `case_id` | A record belongs to one case. |
| — | `provenance` | How it was produced: `connector_normalizer` + normalizer version, capability, connector, gateway invocation id, provider check id, execution mode; or `skill_proposal` + skill id, version, execution id, gateway receipt digest and manifest digest. |
| `recorded_at` (caller) | `recorded_at` (store) | Recorded time is the case store's transaction time, never the caller's. |
| — | `record_digest` | sha256 of the canonical record without `recorded_at`/`record_digest`: the identity of a version. |
| `purposes` | `purposes` | Kept (the brief called them purpose tags). |

`recordCanonicalRecordsPayloadSchema` is the `RecordCanonicalRecords` payload: 1–200 records plus
optional `evidenceRefs`. Outside the block, two additive edits: `RecordCanonicalRecords` in
`businessCommandTypeSchema`, and an optional `record` requirement on `caseReadGrantSchema`.

## Case store (`packages/case-store`, migration `010_canonical_records.sql`)

- Table `case_core.canonical_records`, primary key (tenant, case, object_type, object_id,
  version_id); a trigger refuses UPDATE/DELETE (versions are immutable); tenant RLS
  (`app.tenant_id`, forced), which the store binds per transaction.
- `RecordCanonicalRecords` runs inside the normal command transaction (idempotency key, case
  sequence, plan/policy authority, envelope `case_writes`), appends a `records.recorded` ledger
  event (hash-chained like every event) and `Evidence → CanonicalRecord` lineage
  (`NORMALIZED_INTO`). Per record: an identical version replays as `UNCHANGED`; different content
  under an existing version is `409 record.version_conflict`; a new version supersedes the
  object's current head — implicitly when `supersedes` is omitted, or only if `supersedes` names
  that head (`409 record.supersession_conflict`).
- Snapshots (`getCanonicalCaseSnapshot(…, {asOf, knowledgeCutoff})`, both defaulting to capture
  time): versions recorded by the cutoff, minus versions a known later version supersedes, valid
  at as-of (`[valid_from, valid_to)`), latest per object by (recorded_at, version_id) — the
  library compiler's rule plus explicit supersession. They appear under `data.records.<Type>`
  with `data.recordsAsOf`; a case without records keeps its previous snapshot bytes.
- Projection: a record selector returns only its object type and the union of the requested
  fields (`data` keys); envelope fields (ids, times, sources, provenance, synthetic, digest) stay.
  A type with nothing selected projects as `[]`.

## Selectors

```yaml
- id: recRegistryRecord-registry-company-verify
  source: case
  path: records.RegistryRecord          # no new source kind was needed
  purpose: KYB_ONBOARDING
  classification: CONFIDENTIAL
  required: true                        # = !requirement.optional
  record: { objectType: RegistryRecord, fields: [registration_id, status, coverage], minCount: 1, maxAgeSeconds: null }
```

`recordSelectorRequirement()` converts a library `Requirement` (`object_type`, `fields`,
`min_count`, `max_age_seconds`, `optional`).

## Context plane (`packages/context-plane/src/records.ts`)

Applied to what the store projected, exactly as the library's context compiler does: a record
missing a field (absent or null) → excluded, `CONTEXT_MISSING`; older than `maxAgeSeconds` at the
as-of time, or observed after it → excluded, `CONTEXT_STALE`; fewer than `minCount` usable →
`CONTEXT_MISSING`. Record sections are `UNTRUSTED_EXTERNAL` (normalized provider data) and pass the
injection tripwire. Packs of record-reading nodes carry `recordGaps` (others keep their digests).
`buildSkillCapabilityInput()` builds `SkillCapabilityInput.v1`, or returns `blocked` when a
required record gap exists (any stale → `CONTEXT_STALE`, as the library) or the envelope is
incomplete. The v2 runtime then does not call the skill and journals
`skill.result.needs_evidence` with that code (skill.execution.v1 §3 step 2).

## Normalizers (`packages/adapters/src/canonical-records.ts`)

**Where normalization runs:** in the gateway adapters, so the connector's output carries
`records` and `recordGap`, and the connector node's case writes stay declarative
(`RecordCanonicalRecords` with `records: "{{ output.records }}"` when `output.records.0`; an
`EVIDENCE_GAP` finding when `output.recordGap`). The receipt digest is computed over that output,
so records cite the receipt by gateway **invocation id** (`GatewayInvocation` ref), not by digest;
the captured provider output is also linked as case evidence and as lineage.

| Source | Records |
| --- | --- |
| wiring `business` | RegistryRecord (registration id, upper-cased status, `coverage`), Entity, Party (`customer`, `customer_type: corporate`), OfficerRole (officer/director relationships) |
| wiring `ownership` | OwnershipInterest (`interest` as a decimal fraction in [0, 1]; exact or lower bound, the basis as an extension), ControlRight, Entity |
| wiring `screening` | WatchlistEntry + ScreeningHit (`list_type` sanctions, pep, or watchlist for every other list); AdverseMediaEvent (`status: ALLEGATION`); NegativeSearchEvidence when the completed screen had no candidate |
| wiring `verification` | VerificationRecord (`passed` → VERIFIED, `failed` → FAILED, `review` → UNVERIFIED) |
| wiring `reference` | Entity (an LEI record is not a company-registry record) |
| OpenSanctions match API | WatchlistEntry + ScreeningHit per candidate (coverage never `complete`; `identifier_conflict` when an identifier field conflicts), else NegativeSearchEvidence |
| evidence pipeline `package` | DocumentVersion per parsed document (`artifact_hash` = source sha256, `page_count` with its basis); DocumentPage per 1-based page, the full decoded page text (`text_basis: full_text`, segment offsets) when the package carries `pages`, else the page's cited quotes (`text_basis: evidence_quotes`); Evidence per span (`content_hash`, `requirement_ids: []`, `verified: false`, `page_start`/`page_end` in Unicode code points when the page text is known) |

**Data contract (library context 2.0.0).** `data` is the library's closed schema for the object
type, vendored in `@ehf/library-contracts` ([library-contracts.md](library-contracts.md)), and
`schema_version` is `2.0.0`. Source fields with no canonical field go under
`data.extensions["ehf.connector"]` (`schema_version: "1.0.0"`), which no library skill consumes.
Each record is validated in `Builder.add` before it leaves the adapter, so a record the library
cannot ingest never reaches the case store. Values are mapped onto the library's vocabulary without
overstating them: a provider entity type the library does not know becomes `unknown`; a wiring hit
with no identifier comparison has `identifier_conflict: false` (the library then recommends REVIEW,
never a false-match candidate); a cited quote satisfies no requirement and is not verified.
`NegativeSearchEvidence` is platform-only, with its own closed schema.

Rules: unknown / not_checked / inconclusive / resubmit / not_applicable outcomes, transport or
result errors and unknown families yield **no records** and a `recordGap` — never an empty
"clear" record. `synthetic: true` when the connector ran in simulation/fixture mode or warned
`DEMO_ONLY*`. Object ids are stable per provider record; `version_id` is a digest of the content
and observation, so a replayed invocation re-submits the same version and a new acquisition adds
one.

## Skill-originated records

What a hosted skill returns (skill.execution.v1 §6.2 proposed records, §6.3 requested effects)
becomes case state through the platform's commit path; the skill host never holds write
credentials.

**Where it runs.** In the runtime, inside the skill node's attempt, right after the gateway
returned a validated `SkillCapabilityOutput.v1` and before `SkillResult.v1` is built
(`commitSkillComputation`, `packages/runtime-core/src/index.ts`; mapping in
`packages/runtime-core/src/skill-commit.ts`). The runtime already holds the validated
computation, the node's admitted plan (the binding's pinned effects, the release node) and the
node's execution envelope; the case API has none of the gateway's receipts. Authority stays
server-side: the runtime submits one request to `POST /v1/cases/{caseId}/skill-commits` with the
node's envelope, and the case API (`apps/case-api/src/app.ts`,
`packages/case-store/src/skill-commits.ts`) refuses a delegated (skill host) envelope, a human
or integration caller, a command type not in the envelope's `case_writes`, a held effect not in
its `case_writes_held`, a record mapped to anything but a §6.2 command, and any of
`FinalizeDisposition`, `RecordReview`, `RecordQAResult`, `RecordGateResult`,
`RecordPolicyEvaluation`, `AcceptClaimAsFact`, `RecordFinancialCrimeOutcome`.

**Atomic and idempotent.** One case-store transaction per node attempt: the evidence link, every
mapped record, the immediate effects, the held effects and a `skill.execution.committed` event
(skill id@version, execution id, gateway receipt digest, manifest digest, binding digest, the
commands with their created identifiers, held effects, uncommitted records), under the run's
case-execution lock. Every command's idempotency key is `skill:<execution id>:<local ref>`; the
commit's is `skill-commit:<execution id>`, so a replayed attempt returns the original response
and a different output under the same execution is `409 skill_commit.idempotency_conflict`.
Ids (`claim_skill_…`, `finding_skill_…`) derive from execution id and `local_ref`.

**Provenance.** Records land with an `AGENT` actor `skills:<skill_id>@<semver>` whose
`executionId` is the run. The validated computation is registered as evidence
(`skill_computation`, source `DERIVED`, idempotent per execution) and linked under purpose
`SKILL_COMPUTATION`; every committed record cites it (its section and receipt citations are in
it, and the gateway has already verified them against this execution's sections and receipts).
A canonical record's `provenance` is `{ method: "skill_proposal", skill_id, skill_version,
execution_id, receipt_digest, manifest_digest, connector_id: "skills:<id>" }`.

| Record type | Command | Lands as |
| --- | --- | --- |
| `CanonicalRecord` (amendment) | `RecordCanonicalRecords` | a record version (same rules as connector records: identical version unchanged, conflicting version refused, supersession chained) |
| `Assertion` | `ProposeClaim` | claim, status `PROPOSED` (the case store's pending-review status) |
| `Fact` | `ProposeClaim`, value `{ asserted, verificationCriteria }` | a claim; a fact only through `AcceptClaimAsFact` by a permitted actor or rule, never by a skill |
| `Finding`, `RiskIndicator` | `RecordScreeningFinding` | finding citing the skill-computation evidence |
| `Conflict` | `RaiseContradiction` | open contradiction |
| `UnresolvedQuestion` | `ProposeWorkItem` | open work item; the question is its `work_item.created` description |
| `Hypothesis` | — | not committed (listed as uncommitted in the event) |

A `CanonicalRecord` body is a canonical record without the store-set fields (no tenant, case,
provenance, recorded time or digest). The gateway requires mode `proposal` or higher, an object
type the manifest says it `produces` when it says (a library manifest says nothing yet, so any
valid ontology type), `synthetic: true` while the registry has the skill at
`implemented_synthetic`, and `data` that meets the same closed contract as connector records
(`validateRecordData`: library context 2.0.0, or a platform-only type such as
`NegativeSearchEvidence`; refused otherwise as `integrity_record_data_invalid`). The skill
conformance suite (check 6) applies the same rule, so one record contract governs every record the
store holds, whoever produced it.

**Effects.** A `case_command` of a skill without approval is committed with the records, with
optimistic concurrency: the commit carries the case sequence the skill computed against (the
effect's `expected_case_sequence`, else the node snapshot's), and a moved case is
`409 skill_commit.case_sequence_stale`, which fails the node (re-run the skill on fresh
context); nothing is overwritten. A `case_command` of an approval-required skill, and every
`external_action`, is held (`case_core.skill_effects`, status `HELD`) bound to the run, the
skill, approval and release nodes, the execution and its binding (request, context and code
digests, receipt), the case sequence after the hold and an expiry (`expires_at`, default seven
days, at most thirty).

**Release.** The generated packages put a release node (`transform` with
`config.skillEffectRelease: { skillNodeId, approvalNodeId }`) after every durable approval. It
presents the approval node's output (the human work queue's decision ids and reviewers) to
`POST /v1/cases/{caseId}/skill-executions/{executionId}/release`. The case API checks the caller
is that release node of that run, the binding digest is the held one, an APPROVE names its
reviewers and none of them created the case; then expiry (`EXPIRED`, `409
skill_release.approval_expired`) and case sequence (`STALE`, `409
skill_release.case_sequence_stale`) — both refusals are recorded with an audit event. On
APPROVE it commits each held case command (`COMMITTED`), writes each routed external action as
a case event `external_action.<action>` — and so a case outbox row, in the same transaction —
(`QUEUED`), and keeps an action whose id no plan publication routes as a pending intent
(`NO_ROUTE`, journalled `skill.effects.no_route`, never reported as delivered); a
`skill.effects.released` event records the approval binding. On REJECT it marks everything
`DISCARDED` with a `skill.effects.discarded` event. `GET /v1/cases/{caseId}/skill-effects`
lists held and settled effects for reviewers.

**Downstream reads.** The v2 runtime loads a fresh, purpose-bound snapshot for every node, and
canonical selection defaults its knowledge cutoff to capture time, so a record committed by
skill N is in skill N+1's `records.<ObjectType>` selection in the same run
(`packages/runtime-langgraph/src/skill-commit.test.ts`; `packages/case-store/src/skill-commits.test.ts`
against PostgreSQL). Records the next skill reads must still meet its requirement (fields,
`min_count`, freshness at the as-of time).

## Gaps

See [domains/archive/kyb-deterministic/README.md](../../domains/archive/kyb-deterministic/README.md#gaps-honest-state) and
[domains/archive/kyc-v2-deterministic/README.md](../../domains/archive/kyc-v2-deterministic/README.md#gaps-honest-state): record types no
connector produces (the platform commits skill-proposed records now, but the library catalog
marks the producing skills `read_only` and returns those records only inside payloads), provider
searches vs. list captures, OpenSanctions/evidence records lacking the invocation ref,
quote-only document pages, run-level as-of, and the missing library bundle lock and host.
A node re-executed after a crash between its commit and its work-item completion reads a newer
case sequence, so it is a new skill execution: its canonical records dedupe by version, but its
claims and findings are proposed again. Records committed under normalizer version 1 (context
1.0.0 shapes) are not rewritten: versions are immutable, and a re-acquisition records a new
version that supersedes them.
