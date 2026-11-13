# Context ontology integration plan

Status: implemented canonical explorer, mapping graph and bounded packet relationships, 2026-11-09. See [implementation notes](context-ontology.md) for delivered behavior and verification; general case-neighborhood traversal remains future work. Scope: replace the Contextboard's primary card presentation with an ontology and relationship workspace using the supplied `facet-context-ontology` component as a reference. This proposal builds on the current working tree, including the source setup and preview integration already in progress.

## Recommendation

Make a canonical object graph the default Contextboard view. Keep the twelve context products as navigation groups and consumer projections over that graph. Adopt the sample's expandable nodes, labeled relationships, search, neighborhood highlighting, layout controls and inspection pattern. Supply its content from the existing canonical contracts and a new explicit relationship catalog.

Deliver the schema explorer first, then source mapping overlays, then authorized case relationships. These are distinct projections: a schema link describes an allowed relationship; a mapping describes how a source populates it; a case link describes a particular observation. Selecting one must never silently change the meaning of the others.

Use native React integration with the existing React Flow installation. Canonical schema changes remain library changes; source mappings remain revisioned setup artifacts; Tune remains a workflow draft editor. Browsing or arranging nodes does not change runtime context.

## Current implementation and integration gaps

| Area | Current evidence | Refactor implication |
| --- | --- | --- |
| Contextboard | [contextboard.tsx](../../apps/web/src/domains/fincrime/surfaces/context/contextboard.tsx) selects agent, product, draft and Play/Tune/Engineer modes. Play uses [InstrumentBanks](../../apps/web/src/domains/fincrime/context/InstrumentBanks.tsx) through [Play.tsx](../../apps/web/src/domains/fincrime/context/Play.tsx). | Replace the main Play presentation while preserving route state and consumer perspective. Add graph/list controls separately from disclosure mode. |
| Product taxonomy | [model.ts](../../apps/web/src/domains/fincrime/context/model.ts) fixes three bays and twelve banks; [context-products.json](../../apps/fincrime-host/catalog/context-products.json) defines object and field projections. | Reuse bays as navigation, product filters and overview groups. Do not render products as if they were canonical entities. |
| Canonical types | [context_types.py](../../apps/fincrime-host/src/financial_crime/context_types.py), [schema_types.py](../../apps/fincrime-host/src/financial_crime/schema_types.py) and [build_catalog.py](../../apps/fincrime-host/scripts/build_catalog.py) produce [ontology.schema.json](../../apps/fincrime-host/schemas/context/ontology.schema.json) and individual type schemas. | Generate node fields from these contracts; never maintain another handwritten field model in React. |
| Schema access | [canonicalSchemaMetadata](../../packages/library-contracts/src/index.ts) already exports pinned definitions, types and lock. [context-source-routes.ts](../../apps/control-api/src/context-setup-routes.ts) exposes `/v1/context/schema` and `/v1/context/catalog`. | Extend this distribution path with explicit relationship metadata and a graph projection. Do not fetch source files directly from the browser. |
| Production experience | [context.ts](../../apps/experience-bff/src/context.ts) registers context APIs and derives product/access views through [fincrime-views](../../packages/fincrime-views/src/context.ts). | Add graph projection here. The older [alignment plan](context-experience-alignment-plan.md) describes a pre-integration baseline and must not be treated as current route coverage. |
| Source setup | [context-setup.tsx](../../apps/web/src/domains/fincrime/surfaces/context/context-setup.tsx), [context-sources.ts](../../packages/contracts/src/context-setup.ts) and [context-mapping](../../packages/context-mapping/src/index.ts) already provide revisioned mapping expressions, sample candidates and lineage. | Show those same mappings on the graph and route edits through the existing compiler, persistence and qualification flow. |
| Runtime context | [case preview](../../apps/case-api/src/context-preview.ts), [preview UI](../../apps/web/src/domains/fincrime/surfaces/context/context-preview.tsx) and [context-plane](../../packages/context-plane/src/index.ts) own actual selection and assembly. | Keep pack assembly there. A graph filter or visible edge cannot broaden a selector, agent ceiling or source authorization. |
| Existing canvas | [GraphCanvas.tsx](../../apps/web/src/platform/surfaces/authoring/GraphCanvas.tsx) already integrates React Flow with server revisions and the design system. | Reuse interaction conventions and tokens without coupling the ontology graph to workflow node mutations. |

Structural checks during this review found **89 canonical types**, **558 schema definitions**, and **12 products covering all 89 types**, with no unknown product object or field references. The canonical ontology file matches the vendored copy and its lock digest. The 558 definitions include shared values and projected rows: only `x-context-types` should become canonical object nodes.

These checks establish schema alignment; they do not establish live source availability or deployed service health.

## Sample component assessment

Reference directory: `/Users/hariganesh/Downloads/facet-context-ontology/src/ontology/`.

The sample has 14 handwritten KYC entities. `OntologyGraph.tsx` combines React Flow, a reducer for schema edits, graph context, search, selection, layout, export and an internal inspector. `EntityNode.tsx`, `RelationEdge.tsx`, `Toolbar.tsx` and `Legend.tsx` provide useful presentation patterns. `layout.ts` uses Dagre and rectangular collision handling; `useForceLayout.ts` animates positions with d3-force. The custom element wrapper mounts its own React root and injects styles into a shadow root.

| Keep or adapt | Required change |
| --- | --- |
| Expandable type nodes and selectable edges | Generate fields and IDs from EHF contracts; support nested schemas, arrays, unions, exact decimals and unresolved target semantics. |
| Neighborhood emphasis, search and layout controls | Search canonical types, nested paths and relation labels; preserve selection and viewport across polling. Default to a focused product graph. |
| Internal inspector pattern | Move domain inspection into the existing `StudioFrame` inspector. Generalize selection to product, object, field, relation and mapping. |
| Category colors and icons | Use EHF tokens and icons. Products are filters/group membership; they do not define inheritance or exclusivity. |
| Multiple layout modes | Ship deterministic horizontal layout and fit controls first. Add radial/organic layouts after bounded performance checks and reduced-motion support. |
| Schema edit callbacks | Replace with typed, authorized commands only where an editor is supported. Schema browsing ships read-only. |

Specific integration issues to resolve:

1. The component defaults to the sample schema and `editable=true`. Production must require explicit data and default to read-only, including loading and error states.
2. `store.ts` only partially enforces the `canonical` flag. Entity deletion and update actions can change canonical entities, while attribute/relation update actions also accept unrestricted patches. A UI flag is insufficient protection for authoritative definitions.
3. The sample's extensions object and JSON export have no EHF revision, admission or enablement semantics. Its `mapping` edge is a label between entities, not the existing executable mapping expression representation.
4. `OntologyGraph.tsx` disables node and edge focus. Add keyboard selection, accessible edge inspection, focus restoration and a searchable list/table alternative. The current bank grid's keyboard support must survive the refactor.
5. The sample uses Tailwind styles and additional animation/icon/layout libraries. The app already pins React Flow `12.8.5`; the sample requests `^12.12.1`. Qualify the port against the app's installed version before proposing an upgrade. Port styles to CSS modules and existing tokens rather than importing the demo's global CSS or dependency manifest.
6. The collision loop compares node pairs, and the simulation updates positions on ticks. Benchmark against all 89 canonical nodes with expanded fields before enabling organic layout globally. Keep physics out of ordinary catalog refreshes.

## Alignment with the canonical ontology

| Sample concept | Canonical representation and required behavior |
| --- | --- |
| Abstract Party with Individual and Organization subclasses | `Entity` carries `entity_type`; `Party.entity_id` references the represented entity. Do not invent schema inheritance between these records. Entity variants may be shown as enum facets. |
| Customer as a Party subtype | `Party` and `CustomerRelationship` carry customer and institutional relationship information. There is no canonical `Customer` record in the current type set. |
| Customer holds Account | `Account.entity_id` identifies an entity. Show the supported reference path; do not replace it with an unqualified Party-to-Account ownership edge. |
| Account is an instance of Product | `Account` has no `product_id`, and `Product` has no account link. Mark this as a semantic extension proposal rather than generating a canonical edge. |
| KYC Profile | Inspect `Party.profile`, `RiskAssessment`, identity and screening context separately; there is no standalone canonical `KYCProfile` record. |
| Beneficial owner and organization control | Retain `OwnershipInterest`, `OwnershipRange`, `ControlRight`, `OfficerRole`, `BeneficialOwner` and `OwnershipGraph`. Ownership and control carry their own attributes and provenance. |
| Identity Document | Use `Document`, `DocumentVersion`, `DocumentPage` and evidence/assertion relationships. The sample's document fields are not a replacement contract. |
| Transaction originates at Account and settles with Counterparty | `Transaction.source` and `.target` are generic IDs. Endpoint namespaces and target types require explicit semantics before drawing typed links. |

The same distinction applies to JSON Schema `$ref`: `Account.entity_id → Id` is a value-type reference, not a machine-readable foreign key to `Entity`. Conversely, an envelope `Ref` contains tenant, object type, object ID and version ID and can support exact record resolution. Do not derive business links from every `$ref` or every field ending in `_id`.

## Relationship catalog and graph contracts

Introduce a domain-owned relationship registry alongside the Python canonical definitions, then emit a versioned `catalog/context-relationships.json` through `build_catalog.py`. Add the artifact to the library contract sync and lock workflow. Keep field shapes in existing schemas; the new artifact supplies semantic links only.

Each relationship definition should carry:

- Stable semantic ID, label, source type, source field/path and target type or permitted target types.
- Representation: direct ID reference, exact `Ref`, association record, subject-scope link or lineage link. UI grouping and source mapping edges remain separate categories.
- Target identity namespace/resolution rule, direction and optional inverse label. Missing target semantics remain explicit.
- Source optionality/multiplicity and target cardinality where established. A required source field does not prove target existence, uniqueness or inverse cardinality; allow unknown values.
- For association records, endpoint paths and the association object type, preserving attributes such as ownership interest and verification.
- Semantic status and schema compatibility pins. Proposed relations are excluded from the canonical edge set by default.

Start with explicit candidates such as `Party.entity_id → Entity`, `Account.entity_id → Entity`, `CustomerRelationship.party_id → Party`, `DocumentVersion.document_id → Document` and `DocumentPage.document_version → DocumentVersion`. Validate their domain meaning and resolution rules against readers/writers and fixtures before admitting them. An ID's spelling alone is not sufficient evidence.

Render association records as nodes initially. For example, show `Entity ← OwnershipInterest → Entity` with owner/owned endpoint labels and expandable interest fields. A later collapsed ownership edge must retain its association record identity, version and provenance. Do not hide the canonical association record from inspection.

Build a pure projection in proposed `packages/fincrime-views/src/ontology.ts`. It combines canonical type metadata, relationships, products and consumer requirements into an `OntologyGraphView`. Its output needs:

- Schema version, ontology digest, catalog digest, relationship version/digest and a combined projection digest.
- Canonical object nodes, expandable schema fields and semantic edges with evidence of their definitions.
- Product memberships, selected consumer requirements and field-ceiling annotations, without merging these into the canonical schema.
- Stable IDs derived from canonical names/paths and semantic relation IDs. Visual positions, selection and expansion remain separate view state.

Serve the relationship artifact through proposed control route `GET /v1/context/relationships`, beside existing schema/catalog routes. Add proposed BFF route `GET /v1/fincrime/context/ontology` for the composed view. Reuse `draft.read` for schema browsing and existing service identity handling. Validate schema/catalog/relationship compatibility before composing; return a specific mismatch error instead of mixing versions.

Declare these operations and closed view schemas in [openapi_v2.py](../../apps/fincrime-host/docs/ui/contracts/gen/openapi_v2.py), regenerate the Experience API and run `ui:sync`. The BFF's current explicit catalog path dispatch needs an ontology branch; new operation metadata alone will not add the required composition behavior. Mock and HTTP implementations must share the view contract.

## Contextboard experience

Use the existing three-pane `StudioFrame`:

- **Left:** consumer perspective plus searchable context products grouped under Subject, Sources and Governance. Selecting a product focuses its objects and adjacent cross-product relationships.
- **Center:** ontology graph by default, with search, one-hop expansion, product/relationship filters, fit controls and an accessible list view. Start with the selected product; provide an explicit full-ontology overview. Show boundary nodes from other products so a product filter does not conceal the target of a visible link.
- **Right:** selected object, field or edge definition; product membership; consumer requirements; ceiling gaps; relevant mappings and qualification evidence; links to Tune, setup and packet preview.

Keep Play/Tune/Engineer as existing disclosure/work modes. Add `view=graph|list|banks` independently, with graph the default after rollout. Preserve `agent`, `product`, `draft` and `mode` links. Add stable `object`, `field` and `relation` selections with validation and mutual exclusion. Use a shared URL-state helper so selection links do not accidentally discard agent or draft context.

Play explains the model and access coverage. Tune continues to edit selectors and classification treatment within the chosen workflow draft. Engineer exposes schema paths, semantic resolution rules, requirements and mapping diagnostics. Selecting an object or relation provides a focused context for these editors; drawing a schema link does not mutate a workflow selector.

Keep access coverage, source qualification, observation freshness, case/task gaps and packet outcome as separately labeled states. The current `ready` cell means field access is within the agent ceiling. It must not become a green canonical entity implying live records or task readiness. A selected agent may highlight its subscribed products and required fields, but subscriptions do not grant current-user data access.

## Source mapping and case relationship integration

### Source mappings

Reuse `ContextDefinitionRevision`, `CanonicalMapping`, `MappingExpression` and sample reports. Display a selected source resource and its columns alongside canonical object fields. A visual connection edits the same field expression used by the current visual/JSON editor. Complex expressions open a rule editor; retain unsupported visual expressions intact.

Keep canonical relationships, column mappings and sample-resolved links visually distinct with text labels and a legend. Show connection/resource/mapping digests, sample origin, qualifications and unresolved identities in the inspector. Existing limits on outputs, rows and subjects still apply. Saving requires the current revision and reason; every changed mapping must be recompiled and retested before enablement.

### Case relationships

Add an explicitly labeled Case relationships projection after the schema and mapping slices. Fetch it from a case-service-owned operation that authorizes and projects records before constructing the graph. Return a bounded neighborhood, its authorized scope, time basis, snapshot digest, continuation state and completeness limitations. The BFF relays or formats this view; it must not fetch an unrestricted snapshot and perform access filtering itself.

Resolve exact `Ref` values with tenant/type/object/version identity. Plain IDs require the admitted resolver and namespace; ambiguous or missing targets produce visible unresolved links without fabricated nodes. Edge traversal must reapply tenant, case/subject, purpose, classification, time and source-use restrictions. Counts, labels, exports and continuation tokens must not expose inaccessible records.

Reuse the preview flow's plan/node selection and source authority proof pattern where relevant. Do not assume that a packet contains every related record, or that preview authorizes arbitrary graph traversal. Preserve the distinction between current case state, time-qualified observations and historical pack references. No graph database is required for the first slices; evaluate an index only if measured authorized traversal costs justify it.

## Implementation sequence

| Slice | Concrete work | Completion condition |
| --- | --- | --- |
| 1. Canonical graph metadata | Add the relationship source and generated artifact, schema/target/path validation, lock distribution, pure view projection, control/BFF operations and generated client contracts. | All 89 canonical types can be represented; product fields resolve; admitted edges have explicit semantics; incompatible pins fail clearly. No UI mock ontology. |
| 2. Graph as the primary experience | Port node/edge presentation into proposed `apps/web/src/domains/fincrime/context/ontology/`; add `OntologyBoard`, shared selection, StudioFrame inspector, product navigation and list alternative. Replace the default Play body. | A user opens Party 360, follows Party to Entity across product boundaries, inspects exact fields and requirements, and shares/restores the URL by mouse or keyboard. Existing Tune, Engineer, setup and preview links work. |
| 3. Source mapping overlay | Refactor the existing setup editor into reusable field/rule controls; add resource-column and expression edges; show sample lineage and issues. | A field mapping edited through the graph has identical JSON and server output to the existing editor; a revision change invalidates prior qualification; no schema edits occur. |
| 4. Authorized case graph | Add the bounded case-service projection and BFF/client contract, time/scope controls, resolver outcomes and record/edge provenance inspector. | Actual records and relationships are visible only under authorized scope, with exact versions, pagination and explicit unresolved/incomplete states. Packet preview still uses runtime assembly. |
| 5. Qualification and rollout | Add feature flag/default transition, accessibility and viewport checks, contract checks, performance measurements and updated experience docs. | HTTP journey passes; graph/list/banks compatibility works; no global style regressions; approved performance limits hold. |

Keep graph presentation local to the FinCrime context feature initially. Extract generic node/edge or viewport primitives into `ui-kit` only when another real consumer needs them. Do not copy the sample's `App.tsx`, custom-element bootstrap, default KYC schema or global stylesheet into the application.

There is no persistence migration for the read-only schema explorer. Relationship metadata belongs to versioned library artifacts. Optional personal graph layout belongs to view preferences, separate from canonical artifacts. Source edits continue to use the current context definition tables. Case traversal storage changes depend on measured query needs.

## Verification and acceptance

1. **Generation and semantics:** Validate every relation source path and target type, distinguish nested value definitions from canonical types, and test optional/array/union fields. Assert deterministic IDs and reject incompatible artifacts. Test that unsupported Account-to-Product and untyped transaction links are not emitted as canonical relationships.
2. **Projection correctness:** Compare all product memberships against the catalog; test cross-product boundary nodes, agent subscriptions/ceilings and required/optional skill context. Schema-required and consumer-required are separate annotations.
3. **Refresh and routing:** Change products and agents, receive a new catalog digest, navigate backward/forward, and open a direct relation URL. Preserve a valid selection/viewport; explain a selection that disappeared rather than retaining stale metadata.
4. **Mapping equivalence:** Test graph → expression JSON → graph without meaning loss. Reuse compiler validation and exercise stale revisions, unknown fields, unresolved IDs, fixture/live distinctions and sample expiry.
5. **Case authorization:** Exercise denied tenants/purposes/subjects, inaccessible endpoints, revoked source authority, ambiguous IDs, superseded versions, bounded traversal and incomplete graphs. An excluded endpoint must not leak through node names, counts or exports.
6. **UI behavior:** Test keyboard navigation and edge inspection, reduced motion, dark/light tokens, focus restoration, narrow screens and an inspector opening beside the graph. Verify graph/list parity for required information.
7. **Performance:** Measure initial projection/render, search, expanding nodes and polling refresh for all 89 types and representative larger case neighborhoods. Set budgets from those measurements; lazy-load graph/layout code and run the existing web bundle check.
8. **End to end:** Extend the existing context HTTP test coverage for product → object → relationship → source mapping → sample issue → repaired revision → case packet preview. Retain unit tests for the existing bank view while it remains a fallback.

During implementation, run the affected library generation/lock checks, `ui:sync` consistency check, view/compiler/API tests and web typecheck/build. Run the HTTP E2E journey with the required services. This planning change does not claim those runtime journeys have been executed.

The first delivery milestone is **a read-only canonical ontology explorer replacing the default card grid, with product and consumer filters, admitted relationship definitions, and useful field/edge inspection**. It should be usable before source editing or case graph traversal is added.
