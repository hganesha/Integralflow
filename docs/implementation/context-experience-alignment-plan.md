# Context experience alignment plan

Status: reviewed implementation and proposed delivery plan, 2026-11-09. No application behavior is changed by this document.

Target: [context-experience.md](context-experience.md). This plan turns that experience into implementation work against the current checkout. External Lattice code has not been inspected or qualified in this review; its coverage in the onboarding design is a proposal input, not evidence of executable support here.

Implementation progress is recorded in [context-source-setup.md](context-source-setup.md), including supported flows, deployment prerequisites, verification and remaining extensions. The table below is the pre-implementation review baseline.

## Recommendation

Keep the existing context assembly and canonical record foundations. Build the missing connection, mapping, sampling, assessment, and enablement workflow around them. Start with one structured source and an Entity/Party bundle, retaining the existing twelve products and Contextboard entry point.

Deliver the first complete journey as: select Party 360 → select a shared connection and resource → map Entity/Party fields visually → run a bounded sample → repair a rejected row → inspect subject/task gaps and an actual packet → enable the exact qualified revision. A partial Party 360 source must be described by the fields it supplies; it cannot imply that accounts, holdings, or every subscribed task are enabled.

The first prerequisite is production service wiring. The visible Contextboard experience currently runs through mock handlers, and its product/readiness/preview operations are not registered in the production BFF. Adding studio screens alone would extend the demo without completing the integration.

## Baseline at review

| Area | Evidence in this checkout | Consequence |
| --- | --- | --- |
| Contextboard | [surface](../../apps/web/src/domains/fincrime/surfaces/context/contextboard.tsx), [model](../../apps/web/src/domains/fincrime/context/model.ts), [Play](../../apps/web/src/domains/fincrime/context/Play.tsx) | Preserve the Subject, Sources, and Governance bays and existing product/agent/mode links. Current `ready` describes field access coverage, not connected data or task readiness. |
| Tune | [Tune.tsx](../../apps/web/src/domains/fincrime/context/Tune.tsx), [authoring-context.ts](../../apps/control-api/src/authoring-context.ts) | This is already a revision-aware editor for draft selectors and classification treatments. It does not currently edit product subscriptions or agent ceilings. Keep its release semantics and add source/consumer links explicitly. |
| Engineer | [Engineer.tsx](../../apps/web/src/domains/fincrime/context/Engineer.tsx) | Requirements and gateway capability/adapter inventory are read-only. There is no connection/resource/mapping/sample workspace here yet. |
| Experience API | [BFF registrations](../../apps/experience-bff/src/app.ts), [mock handlers](../../packages/ui-mock/src/handlers/fincrime.ts), [fixture generation](../../apps/fincrime-host/docs/ui/contracts/gen/fixtures_v2.py) | Context product/readiness handlers are mock implementations. Production BFF registration must be added; a list of operation metadata does not establish route coverage. |
| Packet preview | [preview surface](../../apps/web/src/domains/fincrime/surfaces/context/context-preview.tsx), [mock preview](../../packages/ui-mock/src/handlers/fincrime.ts) | Mock preview returns `503` with `bridge.preview_unavailable`; the production context preview route is absent. Even a successful response currently renders only packet existence and gap/exclusion counts. Real packet inspection still needs UI work. |
| Assembly | [context-plane](../../packages/context-plane/src/index.ts), [records](../../packages/context-plane/src/records.ts), [skill input](../../packages/context-plane/src/skill-input.ts), [policy](../../packages/context-plane/src/policy.ts) | Reuse trust labels, instruction resolution, quarantine, character budgets, manifests, envelope gaps, missing/stale record checks, and skill policy/parameter checks. Keep database/network access outside this pure package. |
| Runtime integration | [LangGraph lowering](../../packages/runtime-langgraph/src/index.ts), [pack recording route](../../apps/control-api/src/context-routes.ts), [context store](../../packages/context-store/src/index.ts) | Runtime already assembles packs for model reasoning and hosted skills and invokes the recording seam. Recording authorization is run/fence-bound; it cannot simply serve interactive preview. |
| Canonical records | [canonical records design](canonical-records.md), [record writer](../../packages/adapters/src/record-writer.ts), [library validator](../../packages/library-contracts/src/index.ts) | Existing normalizers already produce closed-schema records and the case store commits immutable versions. They are source-specific code, not a reusable declarative mapping engine. |
| Sources and authorization | [connector registry](../../packages/persistence/src/connectors.ts), [source-policy contracts](../../packages/contracts/src/source-policy.ts), [source-policy persistence](../../packages/persistence/src/source-policy.ts) | Reuse connector identity, authorization artifacts, approvals, and acquire/use decisions. A source-policy `SourceBinding` is not a resource extraction mapping or shared connection. |
| Configuration proposals | [intelligence persistence](../../packages/persistence/src/intelligence.ts), [onboarding design](deployment-onboarding-design.md#connections) | Candidate configuration checks explicitly report `executionVerified: false`. Configuration proposals must not become live-source qualification evidence. Reconcile onboarding proposals into the new connection resource rather than maintaining duplicate credentials/configuration. |
| Existing transports | [adapters](../../packages/adapters/src/index.ts), [Databricks](../../packages/adapters/src/databricks.ts), [HTTP operations](../../packages/adapters/src/http-operation.ts) | Transport code exists, including vector search, but does not provide the proposed shared structured-source discovery/mapping lifecycle. Existing vector search is not the planned permission-filtered document retrieval integration. |

Review verification: `@ehf/context-plane` passed 25 tests across 5 files; `@ehf/experience-bff` passed 19 tests across 7 files. A direct `buildApp()` route/injection probe found all three routes below unregistered and returning 404 with the default BFF configuration: `GET /api/v1/fincrime/context/products`, `GET /api/v1/fincrime/context/readiness`, and `POST /api/v1/fincrime/context/packets:preview`. These checks establish current local behavior, not live connector qualification or deployed environment health.

## Clarifications to carry into implementation

1. **Correct the scope of readiness.** Relabel the current matrix as Access coverage, preserving its existing calculation. Add separate connection, mapping, sample, freshness, and subject/task assessments. Do not reinterpret the existing enum as end-to-end readiness.
2. **Clarify Tune ownership.** The experience's subscription/ceiling goal needs explicit authoring contracts and permissions. The existing selector/classification editor remains valid; a source mapping must never widen its grants. Resolve selector-to-product associations server-side from pinned catalog metadata or an explicit versioned association; the current UI has no such contract ([GAP-105](../../apps/web/CONTRACT-GAPS.md)).
3. **Define preview authority before implementing the hook.** Existing workload snapshot reads and context pack recording depend on live execution authority. Interactive preview needs its own narrow authorization, without creating a run or borrowing a broader service identity.
4. **Define the source-to-case bridge.** Canonical records are case-scoped today. A shared enterprise source does not automatically populate every case or create a global party store. The first release should use bounded, authorized ingestion for explicit existing cases/subjects. Pre-case samples remain isolated candidates.
5. **Define enablement rather than assuming an existing endpoint.** Reuse existing artifact approvals and plan release machinery, but implement the new binding activation transaction, qualification checks, and runtime pins. Registering a source-policy artifact alone does not enable a mapping or schedule ingestion.
6. **Keep initial scope explicit.** PostgreSQL with service identity and an approved customer view is the recommended first structured connector, subject to qualifying the imported implementation. Discovery, execution, delegated identity, refresh, and search support are separate capabilities. Do not promise all Lattice source families in the first milestone.

## Target architecture and ownership

```text
Contextboard / shared Connections / mapping studio / sample report / packet inspector
                                  |
                          Experience BFF
                                  |
              Control API: configuration, revisions, qualification, enablement
                 |                    |                       |
         connector gateway     bounded mapping executor    preview coordinator
                 |                    |                       |
        authorized source     isolated sample store      authorized projection
                 |                    |                       |
                 +---- source rows --> candidates ---> same context assessment

Enabled binding + admitted plan + explicit case/subject scope
                 |
      bounded acquisition + same compiled mapping
                 |
      authorized RecordCanonicalRecords commit
                 |
      case snapshot / selector projection / source-use authorization
                 |
      context-plane assembly + policy/parameter checks
                 |
      recorded runtime pack --> model or hosted skill
```

Use the Control API and persistence package for shared configuration rather than introducing a new deployment service for the first slice. Give the BFF a dedicated context route module. Put FinCrime-specific product/consumer read projections in `packages/fincrime-views`. Implement mapping compilation/execution in a new pure package, provisionally `packages/context-mapping`, using existing contracts and canonical validators; it must not depend on browser code or fetch sources itself.

The gateway owns source transport, identity use, limits, and invocation receipts. The mapping executor produces candidates and field lineage. The case service owns committed record envelopes, versions, and case authority. The context plane owns presentation, admission, trust, budgets, and manifests. Preview coordinates those boundaries without invoking business capabilities.

### New durable artifacts

All names below are proposed. Persist tenant/environment/owner scope, server-set audit metadata, optimistic revision checks, and content digests. Force tenant isolation on configuration and sample storage. Sensitive sample payloads belong in protected storage with expiry; reports and ordinary logs reference them by ID/digest.

| Artifact | Required content and rules |
| --- | --- |
| `Connection` revision | Connector type/version, approved endpoint/resource scope, environment, service/delegated identity mode, server-side credential reference, identity/credential generation, health probe result/time. Reuse across bindings; no raw secrets in definitions, samples, or browser state. |
| `ContextResourceBinding` revision | Connection pin, resource/operation, schema fingerprint, subject/time keys, typed request and parameter schema, query digest, permitted fields, pagination/window/row/byte/time limits. Retrieval remains separate from transformation. |
| `CanonicalMappingRevision` | Pinned canonical schema/catalog, resource binding digest, typed deterministic mapping representation, output types, stable ID and relationship rules, transformations, null/invalid behavior, compilation digest, compiler version. |
| `SampleRunReport` | Exact input pins, identity/access scope, sample origin/selection, source observation/watermark and schema, bounded work/receipt, stage results, issues, lineage, named counts, coverage limitations, retention/expiry, consumer and packet outcomes. |
| `ContextEnablementRevision` | Binding/mapping/connection/schema/catalog/compiler pins, qualifying report digest, source authorization artifact pins, permitted output/product/consumer scope, activation audit, eligible plan/release reference, current enabled revision. |

Represent Draft/Tested/Enabled/Paused/Retired separately from health and latest test outcome. Editing a tested mapping creates a new revision; a failed test is retained and does not erase a prior report or overwrite the enabled revision. Qualification is a predicate over exact revisions, scope, current authority, and evidence validity, not a permanent boolean.

### Proposed service operations

Design contracts before UI integration; route spelling below is illustrative except for the existing preview operation. Keep platform resources generic and the FinCrime product projections domain-specific.

| Operation family | Owner and behavior |
| --- | --- |
| Context products, consumer requirements, Access coverage | Production BFF + pinned catalog projections; implement current catalog/agent/product reads needed by the screens. No source health invented from fixtures. |
| `/v1/context/connections`, `/:id/test`, `/:id/resources`, resource schema | Control API + gateway; revisioned connection setup, bounded access probes and discovery. Unsupported discovery is explicit and permits schema import with Live schema unverified. |
| `/v1/context/resource-bindings`, `/v1/context/mappings`, mapping validation/compilation | Control API + mapping package; save incomplete drafts, reject stale revisions, return typed field diagnostics. |
| `/v1/context/sample-runs`, `/:id`, issues/lineage | Control API + isolated executor/storage; asynchronous bounded execution with timeout, cancellation, idempotency, protected result paging and retention. |
| Consumer assessment | Server coordinator; evaluate selected subjects and task steps against authorized candidates/records, required counts/fields, freshness, policy and parameters. Return explicit unassessed dimensions. |
| `POST /v1/fincrime/context/packets:preview` | Preserve the current experience operation; BFF resolves an authorized preview target and delegates to the server assembly coordinator. Add version/target pins to its contract as required. |
| Enable/pause/retest/history/health | Control API; atomically verify qualification and authorize activation through existing governance. Pause affects future acquisition; it does not remove historical records or manifests. |

Extend the API contract generator and regenerate OpenAPI, vendored UI contracts, client types, and mocks through the existing sync workflow. Do not hand-edit generated definitions. Update role/action policy alongside service routes; browser route guards alone do not authorize source reads, sample inspection, or activation. BFF mutations retain session/CSRF checks and delegated authorization forwarding where supported.

## Delivery sequence

### Milestone 0 — Make the current surface truthful and reachable

Implement production context/catalog/agent/task reads used by Contextboard and preview pickers. Extract deterministic catalog projections from fixture-generation logic into the shared read model where appropriate, tied to the actual pinned catalog. Add a real preview route returning the existing structured unavailable blocker until the hook is ready. Include Engineer's gateway inventory and Tune's required authoring reads/writes in the HTTP dependency inventory; complete only the routes needed by this journey rather than assuming every declared BFF operation is registered.

Relabel Play and inspector copy as Access coverage. Show Sources not configured, Sample not tested, and Task context not assessed where no evidence exists. Preserve existing navigation, keyboard grid behavior, and draft conflict handling. Add capability support as distinct discovery/sample/execution/refresh flags rather than an inferred ready badge.

Primary files: Contextboard/Play/model/Engineer/preview surfaces; new `apps/experience-bff/src/context.ts`; `packages/fincrime-views`; Experience API generator, contracts, and mocks. Record the current route gap and subsequent resolution in `apps/web/CONTRACT-GAPS.md` when implementation lands.

Exit: the Contextboard works in HTTP mode with authenticated service-backed catalog/access data, and unavailable features return explicit blockers. A route registration test must exercise each required operation, not only count operation metadata.

### Milestone 1 — Connection, resource, and mapping foundations

Add the five artifact contracts and scoped persistence migrations. Establish revision/digest conventions and a server-readable canonical schema metadata endpoint derived from `LIBRARY_CONTRACTS_LOCK` and the vendored ontology. Include nested paths, requiredness, enum/type information, product projections, and consumer requirements; the validator alone is not a schema browser API.

Adapt and qualify one PostgreSQL source implementation with service identity, resource selection, schema fingerprinting, bound subject parameters, and hard row/time/byte limits. Start with an approved view and filter builder; defer free-form SQL until read-only execution and resource restrictions are enforced beyond editor validation. Resource identifiers must come from the approved source contract. Schema import/upload remains possible when discovery is unavailable but cannot qualify a live source.

Implement mapping compilation with deterministic direct mapping, trim, approved enum lookup, typed date/decimal conversion, object/array construction, stable IDs, and explicit Entity/Party reference resolution. Define the expression grammar/helper types and resource limits; do not execute arbitrary JavaScript, Python, network requests, clock access, or random values. Add bounded joins only with explicit keys, cardinality, ambiguity handling, and fan-out limits.

Exit: a connection can be reused, an incomplete mapping can be saved, and a compiled mapping emits canonical candidates with field lineage and actionable closed-schema errors. All envelope authority remains server-owned.

### Milestone 2 — Visual/code editor and isolated sample loop

Add `/context/connections`, `/context/sources/:id`, and `/context/mappings/:id`, with product/agent/task/draft return context. Build the six setup steps inside the existing shell. Offer a keyboard-accessible mapping table and field details first; drag connections are an additional interaction. Visual and code modes edit the same typed representation and compiled digest. Unsupported code constructs remain labeled read-only visual blocks; round-tripping must not discard them.

Run Fetch → Transform → Validate/Relationships → Assess → Packet as independently reported stages. Default to 20 subjects or 100 source rows, with server limits adjusted to the connector. Keep subject, source row, emitted record, duplicate, accepted, and rejected denominators distinct. Link every issue to a protected input reference, canonical path, stable issue code, and repair action. Save reports and boundary fixtures, and label uploaded/fixture/live origin prominently.

The existing source-policy eligibility path is run-bound. Add a narrowly scoped sample-read authorization path using the same policy evaluator and approved artifacts, with a retained decision/receipt and sample identity/scope. Do not start a normal runtime run just to obtain source access. Synthetic fixtures cannot qualify live enablement. Preview storage and identities must be distinguishable from committed case records.

Exit: a user completes visual Entity/Party mapping, sees an unknown enum and unresolved reference, repairs both, and reruns successfully. Code mode produces identical candidates. Sample execution leaves case sequence, canonical records, outbox, schedules, and production checkpoints unchanged.

### Milestone 3 — Subject/task assessment and real packet preview

Extract a shared server context preparation seam from runtime wiring: resolve target/authority → load purpose-bound projected data → authorize source use → assemble pack → resolve policy/parameters → build structured skill input or render model view. Keep runtime pack recording and dispatch outside this shared preparation seam. Reuse `assembleContextPack`, record admission, policy resolution, and skill input building without invoking the gateway model/skill.

Resolve catalog agent/task selection to exact admitted plan node(s), agent profile/version, selectors, and policy pins. A task may contain several steps; show the selected step or separate per-step results rather than inventing one runtime packet for the entire task. Missing target mapping, unavailable predecessor output, or unresolved required parameters is a specific blocker. Catalog requirements alone are insufficient to establish runtime execution authority.

Implement interactive preview authority at the case boundary. Do not obtain a full human-readable snapshot and treat the user's read permission as the agent's ceiling: apply the target plan's selectors, classifications, purpose, and field projection server-side, intersected with caller permissions. Reuse acquire/use policy decisions and refuse broader service identity fallback. Define preview grants separately from active execution grants.

Support two clearly labeled input modes: existing case snapshot and isolated mapped sample. Samples can be assessed before a case exists, but a runtime-equivalent packet requires established subject/policy/plan authority. If staged candidate projection is unsupported, report that blocker; do not commit records to manufacture a preview. Where staged projection is supported, preserve its own snapshot/preview namespace and staging lineage.

Show per-subject required fields/counts, relationships, freshness at pinned as-of/knowledge times, exclusions, quarantine, budget drops, unresolved policy/parameters, structured sections, model view, exact record versions and lineage. Global type counts must not allow one subject's records to satisfy another subject's requirement. Reuse current check behavior; any richer subject/semantic validation added for readiness must also be enforced on enabled ingestion/runtime, not only in the UI.

Preview/runtime equivalence means the same prepared authoritative inputs and shared functions produce the same selection, gaps, trust decisions, and rendered content. Compare digests only with identical run/node/snapshot/envelope identity and time inputs: current digests include execution/snapshot identity and cannot be expected to match a later run over a newer snapshot.

Exit: a real preview displays the actual server-produced pack/skill view and blockers. No model/skill call, case write, production run, runtime pack promotion, or checkpoint movement occurs. Preview reports are stored separately from runtime evidence.

### Milestone 4 — Enable the tested revision and acquire into a case

Implement atomic activation using expected configuration revision and exact report/compilation/schema/authorization pins. Recheck current connector operational state, identity/credential generation, permitted resources/purpose, report expiry, and required test outcomes at activation. Connect the artifact to the existing approval/release path; a changed pin or scope requires relevant requalification. Keep service identity and delegated identity eligibility separate.

Bind compiled mapping and source acquisition into an admitted plan/capability with an explicit case/subject scope and authorized case-write envelope. Reuse the canonical command path; do not give the mapping executor general case-store write credentials. Validate candidates again, construct authoritative source refs/provenance, and commit immutable versions in bounded batches. Add mapping/resource/compilation/report lineage through a versioned contract or protected referenced artifact; the present connector-normalizer provenance alone does not describe visual transformation lineage.

Define pause and revision replacement behavior for in-flight work. Existing admitted runs keep exact revision pins; revocation and purpose/access checks still apply. Enabling permits future authorized acquisition and use, it does not declare every customer/task complete. Fetch or observe actual case data before reporting task context available.

Exit: the sample-qualified revision can be released and used for one authorized case; records appear in its projected snapshot and subsequent context. A changed mapping, revoked authorization, expired qualification, concurrent revision change, or unqualified credential generation blocks activation/use. A changed fetch cannot mutate an already recorded pack.

### Milestone 5 — Operate and add structured templates

Add health history, real source observation/watermark, schema fingerprint diffs, impacted mapping fields, retained failures, bounded retry/replay, durable idempotent checkpoints, and quarantine inspection. Advance a checkpoint only after accepted/rejected batch outcomes are durable. Added fields remain unmapped; removed/incompatible fields invalidate affected qualification without rewriting the enabled revision.

Add transaction and risk templates after the first path works. Transactions require endpoint namespaces, explicit time window, duplicates/reversals/late data handling, unit-aware decimal conversion, and honest completeness. Risk scores require model/version, scale, tier rule, effective time, original values, and limitations. Do not fill required semantics with guessed defaults or turn row-limited samples into full-window coverage.

Exit: operators can explain and repair drift and failures while preserving lineage, old versions, and historical context manifests. Configuration changes trigger only the relevant checks but cannot bypass them.

### Milestone 6 — Documents, filtered retrieval, and application semantics

Reuse the structured workflow for document metadata and the existing capture/extraction contracts for content. Add separate Captured/Parsed/Mapped/Indexed/Retrievable states, exact version/hash/page/span lineage, bounded parser work, and a retained extraction receipt. Extraction, indexing, or retrieval never marks an assertion verified.

Treat the planned document/search database as a separate delivery dependency. Implement tenant/subject/purpose/version/access filtering before snippets/content leave retrieval, then recheck access at citation/artifact resolution. Add per-chunk external trust/provenance, injection handling, known-answer and known-denied tests, index lag/deletion/revocation behavior, and historical citation preservation. Existing Databricks vector transport does not satisfy these requirements by itself. Token budgets are a separate context-plane enhancement and are not required to start structured mapping.

Admit Application and richer holding relationships only after canonical schema/catalog/consumer changes and compatibility fixtures are approved. Until then preserve application source evidence and show canonical support pending. Never relabel an application as Product or Case to pass validation.

Exit: experience acceptance scenarios 7–9 are backed by actual contracts and retrieval behavior; unsupported capability remains explicit until implemented.

## Acceptance and verification

| Gate | Required evidence |
| --- | --- |
| Production route coverage | Authenticated HTTP-mode journey with MSW disabled; current context reads return contract-valid responses, and preview returns a real result or structured blocker rather than 404. |
| Mapping parity | Visual → code → visual preserves normalized mapping semantics; same compiled plan and inputs yield identical candidates/lineage. Unknown enums, null required fields, ambiguous references, and join fan-out produce repairable errors. |
| Sample isolation | Database integration checks prove unchanged production case sequence/records/outbox/checkpoints; bounded source receipts and isolated reports account for all inputs and rejects. Cancellation/timeout cannot activate a binding. |
| Subject/task truth | Good access coverage can coexist with stale data or task gaps. Tests include two subjects where only one has required records, and policy/parameter/predecessor gaps. Unknown evidence stays Not assessed/Not tested. |
| Preview equivalence | Compare shared preparation with runtime for identical admitted plan, snapshot, identity, policy, selector and time inputs. Verify structured/model content, exclusions, quarantine and budget behavior without capability dispatch. |
| Activation integrity | Integration tests for stale expected revision, changed mapping/compiler/schema/credentials, expired or synthetic-only report, revoked source artifacts, concurrent enablement, and exact plan pins. |
| Ingestion integrity | Idempotent replay, new version/supersession, unauthorized case/subject/purpose refusal, field projection, source acquire/use receipts, and durable accepted/rejected checkpoint accounting. |
| Accessible complete workflow | Browser journey from Party 360 through repair/sample/preview/enable; keyboard mapping and issue repair, session recovery, revision conflict retention, saved return links, large-schema search, and status text independent of color. |

Carry all twelve scenarios in [context-experience.md](context-experience.md#acceptance-scenarios) into a milestone checklist. The first complete release must satisfy scenarios 1, 2, 6, 10, 11, and 12; transactions/risk/drift and document/application scenarios follow their milestones. A passing fixture journey is not evidence that a live connector or production BFF works.

Run focused mapping/context-plane/contract tests as those components change; run PostgreSQL integration tests for persistence, activation, and ingestion; run both mock and HTTP browser journeys. Regenerate and check UI contracts with the repository workflow, then run affected typechecks/builds. Existing context-plane and BFF suites are a baseline, not coverage of the proposed workflow.

## Suggested implementation pull requests

1. **Production Contextboard reads and truthful Access coverage:** milestone 0, route inventory/tests, structured preview blocker, contract-gap update.
2. **Versioned source/mapping contracts and storage:** milestone 1 artifacts, canonical schema metadata, source-policy references, permissions and migrations.
3. **First connector and deterministic mapping engine:** qualified PostgreSQL bounded fetch, compilation, Entity/Party mapping and lineage.
4. **Mapping studio and sample repair loop:** milestone 2 with persisted drafts, visual/code parity and isolated sample reports.
5. **Shared context preparation and interactive preview:** milestone 3, task/plan target resolution, scoped preview authority, packet inspector and parity tests. Backend preparation work can begin after the contracts are settled rather than waiting for the studio UI.
6. **Qualified enablement and scoped canonical ingestion:** milestone 4 and the first complete HTTP-mode acceptance journey.
7. **Operations, transactions, and risk:** milestone 5, split further by checkpoint/drift and template scope as needed.
8. **Document retrieval and canonical extensions:** milestone 6 in separate document/retrieval and Application contract changes.

Proceed with the first six as one coherent first release. Shared connections plus a successful access probe are useful intermediate work, but the release outcome is a user who can inspect valid records, understand task gaps, preview authorized context, and enable the exact tested binding.
