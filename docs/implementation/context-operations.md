# Context refresh, mapping extensions, document retrieval and Application contracts

Implemented 2026-11-09. These extend [source setup](context-source-setup.md); the original [experience](context-experience.md) remains the product direction.

## Scheduled refresh and checkpoints

The source workbench includes **Scheduled refresh and checkpoints**. An operator selects the enabled mapping's released acquisition plan, case, node, explicit source subject keys (at most 20), interval (5 minutes–30 days), and a maximum of three attempts. Configuration revisions and batch history are retained in the control database. The workbench shows the current checkpoint, last success, due time, run ID, failures and recent batches. Pausing changes the schedule revision; pausing an in-flight schedule requires first settling/canceling its run and reconciling its batch. Mapping pause immediately blocks future source acquisition.

This is bounded **snapshot refresh**, not CDC or incremental source-offset ingestion. Each slot refreshes the selected subjects through the existing gateway and authorized case command path. Missing subjects, invalid rows, truncation, schema drift, changed mapping/enablement, revoked source access or inactive releases fail closed. No checkpoint advances on a failed or incomplete batch. A completed run must also have the acquisition node's committed `RecordCanonicalRecords` event. `completedThrough` describes accounted schedule slots; canonical records retain their own source observation times. Missed intervals coalesce into one refresh. A replay retries the exact failed slot under the same pinned schedule, with a stable attempt-specific run key and the configured attempt ceiling; it reads the source's current snapshot. It does not claim historical source reconstruction. Failed inputs are not copied into a second ungoverned quarantine store: run diagnostics and bounded source re-tests support repair.

Refresh plans are dedicated, unconditional four-node graphs:

```text
input → transform(operation=project, fields=[subjects]) → acquisition tool → output
```

The tool uses `context.records.fetch.v1`, `context-postgres:<mappingId>`, `usePredecessorInput: true`, the appropriate case context selectors, and one declarative write with payload `{ "records": "{{output.records}}" }`. Ordinary admission, source-policy approval and release activation remain required. Schedules cannot start general business workflows or add undeclared effects. Concurrent ticks serialize; the deterministic run key repairs a crash between run admission and batch persistence. Reconfiguring mapping/case/plan starts a new schedule revision; toggling only enabled state retains the checkpoint.

Apply control migration `049_context_snapshot_refresh.sql` and reapply its grants. Configure a tenant-bound `Context.Refresh` workload principal and `CONTEXT_REFRESH_SERVICE_TOKEN` (or the platform workload identity mechanism) on control-api and the refresh worker. Start `pnpm --filter @ehf/control-api context:refresh`, build the `context-refresh` service, or run `docker compose --profile context-refresh up context-refresh`. The worker only calls `/internal/context/refresh:tick`; it holds no database or source credentials. Operator API operations are `/v1/context/refresh-schedules`, `/:id/tick`, and `/:id/retry`. A deployment must run the worker for unattended scheduling.

## Richer deterministic mapping

The v2 mapping compiler adds `coalesce`, `concat`, `split`, strict `integer`, `boolean`, calendar `date`, and a reviewed identity `crosswalk`. Crosswalk values are pinned by digest and reviewer attribution; changing values requires re-sealing and retesting. An absent key fails rather than inventing an identity. Review metadata is author attribution; normal source/plan release approvals remain separate. The visual, relationship and code editors use the same expression representation. Fallback lineage identifies the selected source path. Canonical field search and customer, transaction, risk, Application and holding templates are available from setup.

Templates do not infer cross-system joins or ownership. Transaction endpoints and application/holding references must be explicit canonical identities or reviewed crosswalks. Database joins belong in approved source views within the existing identifier/column allowlist. No arbitrary code or user SQL executes in a mapping. The compiler change invalidates earlier compilation qualification: rerun live samples and update the approved source-binding compilation pin before using older mappings.

## Document search and exact citations

Open `/context/documents` with a selected case, permitted purpose, and optional subject subset. **Build / refresh index** reads committed `DocumentVersion` and `DocumentPage` records tied to captured uploaded evidence. It never parses bytes or promotes extracted assertions. The existing capture/parse flow must have produced the pages. Captured upload subject labels can supply missing legacy page labels. Unlabeled subjects remain unavailable. Existing explicit canonical purpose restrictions always apply; legacy unlabeled captured pages use the server's configured retrieval profile, never an arbitrary requested purpose.

Context database migrations `004_document_search.sql` and `005_release_document_index.sql` add a rebuildable lexical index and include it in closed-case context release. Case API needs `CONTEXT_DATABASE_URL` using the narrow `ehf_svc_document_index` group; it cannot write context packs through this role. The development case-api login includes that group. Keep durable evidence under its existing retention/legal-hold controls.

Configure `DOCUMENT_SEARCH_ROLES`, `DOCUMENT_SEARCH_PURPOSES`, and `DOCUMENT_SEARCH_RESIDENCIES` on case-api. Defaults are existing case/harness reading roles, `kyc.review`, and `US`. The profile accepts PUBLIC, INTERNAL and CONFIDENTIAL records; unknown or more restrictive classification labels are excluded. Source-backed documents remain unavailable in this first profile because it does not delegate their current source-use authority.

The index filters tenant, case collection, authorized subject set, current roles, purpose, residency, and an authorization digest of current canonical page versions **before ranking or returning text**. A document spanning additional subjects is unavailable to a narrower subject selection. Index coverage counts only documents eligible for that profile and current parsed scope. The screen shows missing expected documents and index lag; zero matches never establishes absence. Lexical search is supported; semantic/hybrid retrieval and embedding claims are not exposed.

Each result carries document/artifact version, parser/chunker version, generation, canonical page record version, page and Unicode-code-point span, chunk digest and a citation ID. Text coverage distinguishes full extracted pages, cited quotes, and unknown representations. Relevance and extraction confidence are separate. Citation resolution repeats current authorization and artifact metadata checks. Changed permissions/page versions invalidate access even before reindexing. Reindexing withdraws old generations and removes their derived text; withdrawal does the same without deleting durable evidence. Historical citation identifiers stay version-bound and cannot resolve silently to replacement text. Explicit rebuild keys support restoration as a new generation.

The HTTP APIs live under `/v2/cases/:caseId/documents/{index,search,citations/resolve}`, with an index withdrawal operation. The BFF exposes `/v1/context/documents/:caseId/...`. To use retrieval at runtime, enable gateway module `context-documents`, give its workload the case API's `GATEWAY_CASE_SERVICE_TOKEN`/identity, and admit the read capability `context.documents.search.v1` or `context.documents.citation.v1` with the corresponding `context-documents:search` or `context-documents:citation` binding. Signed node grants must project the needed subjects, evidence metadata and document fields. Case API performs that projection before constructing retrieval authority. The normal context-plane tool-observation path marks results `UNTRUSTED_EXTERNAL` and applies quarantine, budgets and manifest recording. No gateway case-database credential is added.

## Application and holding contracts

`packages/contracts/src/application-context.ts` admits closed, independently versioned platform contracts (`contract_version: 1.0.0`):

| Contract | Semantics |
| --- | --- |
| Application | Stable source application ID, exactly one primary applicant plus joint/other roles, explicit requested Product versions, channel, submission/lifecycle/effective times, evidence, optional prior Application reference, attributed historical source decisions. |
| ProductHolding | Explicit Party, Product and Account versions, holder role/status, effective interval and supporting evidence versions. Product type coincidence never creates a holding. |
| ApplicationAccountLink | Explicit Application and Account versions, origination/refinancing/conversion relation, linkage time and evidence versions. |

References must resolve within the tenant/case or the same atomic case-write batch; foreign or missing versions reject the transaction. A resubmission naming a prior application requires a distinct application identity. Ordinary status changes retain the same application ID with immutable superseding record versions. Withdrawal is a lifecycle observation, not deletion. Historical decisions are source observations and cannot authorize platform approvals or case disposition.

These are platform additions beside the pinned FinCrime library schema, with their own contract version and compilation digest. Existing records need no rewrite. Existing library skills retain their current requirements and do not automatically consume these new objects. A generic platform context selector may explicitly project them; adding an application product or library skill consumption still requires its own catalog/consumer release. Metadata and mapping templates label this boundary.

## Verification

Tests cover mapping conversions/crosswalk pins/templates, contract semantics and reference admission, database refresh overlap/replay/checkpoint behavior, index RLS and pre-ranking filters, stale citations, withdrawal/rebuild, case-derived authorization, and existing regression suites. HTTP Playwright journeys cover mapping repair and document index/search/citation/withdrawal with accessibility checks. No local fixture or passing test qualifies a production source or activates an enterprise release.

Further experience work includes asynchronous sample jobs, autosave/session recovery, staged-sample packet previews, richer subscription/ceiling authoring, CDC/paged incremental ingestion, source-backed document-use delegation and semantic/hybrid retrieval.
