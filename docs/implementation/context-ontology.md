# Context ontology

The Contextboard opens an ontology graph backed by the canonical context contracts. Party 360 is the initial product focus. Product navigation keeps Subject, Sources and Governance groups; `product=all` shows the full model. `view=list` provides an accessible object and relationship list, and `view=banks` retains the original access coverage board. Play, Tune and Engineer remain available.

## Lane layout and narrow screens

Desktop graphs use fixed Subject, Sources, Governance and Other lanes. Each canonical type has one visual home, with its product memberships retained as metadata. Card dimensions are measured before painting and on resize; aligned rows reserve routing corridors between cards. Expansion, filtering and new font metrics trigger deterministic layout updates. Nodes cannot be dragged out of their lanes. Relationship labels appear only for the active/selected relationship, within reserved space. Readable view starts at a legible zoom; lane shortcuts and an explicit Fit graph overview handle large ontologies.

At viewport widths of 680 px or less (or an available workspace narrower than 480 px), the ontology becomes a native expandable lane → product → object → field hierarchy. Relationships remain explicit cross-links rather than being represented as invented parent/child relationships. Field/relation selection and expanded objects persist across the switch; explicit Object list remains available at every size.

## Canonical metadata

The graph represents the 89 names in the ontology's `x-context-types`. Shared value definitions and projected row types remain field metadata. Nodes and nested fields come from the pinned schema, including optionality, nullability, enums and constraints. Schema requirements and consumer requirements are displayed separately.

`apps/fincrime-host/ontology/relationships.json` declares 34 semantic relationships. `scripts/build_context_relationships.py` checks their source fields, target types and ID/Ref representation, derives source multiplicity/optionality, and emits `catalog/context-relationships.json` with ontology and content digests. `build_catalog.py` includes the same generator. Target cardinality remains unspecified where the canonical contracts do not constrain it. Association objects such as OwnershipInterest remain nodes.

The relationship artifact is vendored through `scripts/sync-library-contracts.mjs` and included in the library lock. Value-type JSON Schema references do not create business edges. Account-to-Product links, schema inheritance from the sample, and typed Transaction endpoints are not asserted by the current contracts.

## API and projection

The control service exposes `/v1/context/relationships` under `draft.read`, beside its existing schema/catalog reads. The BFF's `/api/v1/fincrime/context/ontology` composes those three artifacts with `contextOntologyView` in `packages/fincrime-views`. Schema/ontology/catalog compatibility, relationship content integrity, fields and targets are checked before returning the view. Mismatches return a specific `context.*` error with HTTP 409.

The view includes exact pins, products, consumer requirements and field ceilings. Mock mode uses the same projection over the pinned artifacts. Browser graph code does not import the canonical schema bundle or assemble runtime packets.

Object, field and relation selections live in URL parameters and retain the current consumer, product, draft and mode. Selecting a product retains adjacent boundary types. Search covers type names, nested field paths and relationship labels. The StudioFrame inspector shows definitions, relationships, consumers, mappings and provenance. Catalog refreshes preserve node positions when the graph structure is unchanged. Layout changes affect only the current view.

React Flow is loaded separately for the canvas. Nodes are read-only, fields can expand, and relationship paths support mouse and keyboard selection. Labels simplify at overview zoom. The list view exposes the same contracts without canvas interactions. Reduced motion is supported; no physics simulation runs during refresh.

## Source mappings

The source setup editor adds a Relationship graph tab. Source columns connect to canonical output fields; selecting an edge opens its current expression. A new connection proposes a direct-field rule. Apply mapping rule updates the editor's existing CanonicalMapping state, after which the existing revision save, compiler, sample and enablement checks apply.

Visual, graph and JSON modes share the same expressions. The common ExpressionEditor preserves advanced expressions it cannot edit visually. Source-column edges reflect nested expression dependencies, including coalesce and concatenation. A graph edge is a mapping expression, distinct from a canonical semantic relationship. Existing sample reports, rejected rows and lineage remain in the source workbench.

## Case relationships

The case preview response includes a bounded relationship projection built in the case service from canonical record sections actually admitted to the task's context pack. It excludes quarantined sections. It performs no additional record reads, model calls, runtime execution or case writes.

The graph resolves typed IDs only when one target version is present in the packet. Exact Refs must match tenant, type, object and version. Missing/out-of-packet, ambiguous and invalid references remain unresolved. The response does not repeat unresolved target IDs. Limits are 200 record versions and 500 resolved/unresolved relationship observations, with explicit truncation.

The preview UI offers the graph and record list with exact versions, projected field names, observation time, snapshot digest and unresolved reasons. Completeness is always false: a task packet is a projection, not the entire case. The separate `/context/cases` explorer provides authorized, paged case-neighborhood traversal beyond a packet. Preview does not grant access to it.

## Verification

Coverage includes real-schema projection and API contract validation; mismatched/tampered relationship artifacts; nested field and recursive schema handling; authorized BFF/control routes; packet relationship tenant/version resolution, ambiguity, missing targets and limits; and non-mutating case preview. Browser tests cover default graph rendering, keyboard relationship selection, cross-product inspection, URL restoration, read-only access, list search and accessibility. The source HTTP journey also exercises graph/JSON/visual round-tripping when `CONTEXT_HTTP_URL` is configured.

Generate relationship metadata with `python3 apps/fincrime-host/scripts/build_context_relationships.py`; verify it with `--check`. Regenerate UI contracts with the existing OpenAPI generator and `pnpm ui:sync`. The ordinary production web build runs the existing check excluding mock code from its output.

## General case traversal

Open `/context/cases?case=<id>&plan=<digest>&node=<step-id>` from Contextboard. Supply the case's pinned, admitted plan and step. For source-backed records also supply the approved source context digest in the scope form (`sourceContext` in the URL). This view performs read-only traversal; it invokes no model, connector acquisition, workflow execution or business command.

Choose an optional object type/ID/exact version, subjects, business valid time, knowledge cutoff, incoming/outgoing/both direction, depth (0–4) and page size (1–50 via API). The UI shows graph and record-list presentations, exact-version metadata, projected attributes, unresolved-reference reasons and completeness limitations. Load more preserves the submitted scope even if form fields are edited. Select a record and use “Explore from this record” to pivot with the same authorized time and plan scope.

### Request path and authority

1. `POST /api/v1/fincrime/cases/:caseId/context:traverse` requires a verified human with `draft.read` and `case.read`, CSRF and a contract-valid request. The BFF gets the tenant's admitted plan from the control service; the browser never supplies executable plan content.
2. `POST /v2/cases/:caseId/context:traverse` repeats identity/action checks, admits the plan, verifies the case's pinned plan digest and uses only that node's canonical-record selectors. Classification policy, field projection, purpose, tenant and case all constrain the read. Denied or masked record classifications are excluded before graph construction.
3. The case store reads the case authority, subjects and canonical records in one read-only repeatable-read transaction under tenant RLS with a five-second statement timeout. It selects the latest known, valid, unsuperseded version before applying visibility filters; a denied latest version never reveals an earlier version. Subject filters require every record subject to belong to the requested set. Unscoped records are included only when no subject filter was requested.
4. Source-backed records require a signed, 30-second proof before graph data or counts leave the case service. The BFF handles the service's metadata-only challenge internally. The control service checks prior source-use lineage, case identity, unchanged source binding and the current approved source policy/access/connector state for every decision, then signs the exact request digest. Missing lineage, revoked access or expired authority fails closed. Every page and pivot repeats this check. Challenges and cursors are signed and work across replicas sharing the cursor key.
5. Traversal resolves declared relationships only inside the authorized projection. Exact references require tenant, type, object ID and exact version (plus schema version when supplied). Missing and inaccessible endpoints share one unresolved reason; no target IDs are added to unresolved metadata. Cycle-safe breadth-first traversal returns deterministic pages. The cursor binds actor, tenant, case, plan, node, query, time, projected snapshot and relationship revision, expires after five minutes and rejects changed snapshots with 409.

Packet token/character budgets do not restrict this explorer. Case scope is still bounded to 1,000 subjects (64 KB IDs), 5,000 selected records / 4 MiB, 300 source decisions, 500 reached nodes and 10,000 relationship observations. Each page bounds record bytes (200 KB), edge bytes (150 KB), unresolved bytes (50 KB) and counts. An oversized single record returns 413; narrow the pinned selector fields. Exceeded graph limits set `truncated`; that flag persists across pages. `complete` means only the requested depth/direction within the authorized projection, never the entire real-world case graph. Records with no admitted canonical selector or no purpose grant cannot be traversed.

## Deployment

The control API verifies the canonical catalog envelope and member digests. The deployment supplies its checked artifact through `FINCRIME_CATALOG_PATH`. Schema/catalog/relationship version mismatches fail closed.

Production proofs use the control API's existing `EXECUTION_ENVELOPE_PRIVATE_KEY_FILE` / `EXECUTION_ENVELOPE_KEY_ID` signer and the case API's `EXECUTION_ENVELOPE_PUBLIC_KEY_PEM`. The proof has a separate issuer/audience from execution and integration envelopes; neither service accepts it as execution authority. Development can use the existing `EXECUTION_ENVELOPE_SECRET`. Explicit `CONTEXT_TRAVERSAL_PRIVATE_KEY_PEM`, `CONTEXT_TRAVERSAL_PUBLIC_KEY_PEM` or development-only `CONTEXT_TRAVERSAL_SECRET` overrides are supported; configure matching signing/verification material. Source-backed reads return 503 if verification/signing material is absent.

Set `CONTEXT_TRAVERSAL_CURSOR_SECRET` to the same high-entropy value (at least 24 characters) on all case-service replicas. Without it, a random process-local key is used: restarts invalidate cursors and multi-replica requests need affinity. Rotating this key invalidates both challenges and cursors. No graph data is cached in the BFF; responses carry `Cache-Control: no-store`.

Mock mode serves canonical schema metadata but returns `context.traversal_service_required` for live traversal. Browser acceptance tests use a test-only transport fixture; they do not add synthetic case graphs to the production application.

## Validation

- Service/package suites cover ontology integrity, projection, pagination, scope tampering, source authorization and RSA proof separation/expiry.
- `EHF_TEST_DATABASE_URL=... pnpm --filter @ehf/case-store exec vitest run src/traversal.test.ts` exercises real PostgreSQL version/time/purpose/subject queries using isolated schemas and the relevant real migrations.
- `EHF_TEST_DATABASE_URL=... pnpm --filter @ehf/e2e-connectors exec vitest run case-traversal-flow.test.ts` runs real HTTP through BFF → case API → PostgreSQL, with an admitted-plan lookup fixture. It checks projected fields, relationships, pagination and changed-snapshot rejection.
- `pnpm --filter @ehf/e2e-ui exec playwright test context-ontology.spec.ts case-traversal.spec.ts` checks ontology navigation, graph/list inspection, frozen pagination, pivots, denied next pages and accessibility.
- Run `python3 apps/fincrime-host/scripts/build_context_relationships.py --check`, `node scripts/sync-library-contracts.mjs --check`, `pnpm ui:contracts`, affected typechecks and the production web build.

The OpenAPI generator preserves the existing source/setup, preview and connector operations alongside traversal.

## Bank API case context

The [Salesforce/Fenergo implementation](context-api-connectors.md) supports reviewed, on-demand case pulls against the pinned ontology. [The v2 plan](context-connectors-v2-plan.md) separates implemented acquisition from bank-specific live qualification and later portfolio work. CDC is deferred.
