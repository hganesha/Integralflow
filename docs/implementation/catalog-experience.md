# Catalog experience

Catalogs is the primary discovery destination for Context, Skills, Agents, External capabilities, Policies and Documents. Each board uses the same search, filters, sorting, board and table views, selection, source provenance and related-entry navigation. Existing studios remain the places to configure, rehearse, approve and execute work.

The implementation follows the [UI vision](../../apps/fincrime-host/docs/ui/README.md) and its porcelain and graphite palette, self-hosted Instrument fonts and semantic state tokens. Source contracts take precedence over illustrative mockup counts, scores and readiness signals.

## Routes and navigation

| Route | Purpose |
| --- | --- |
| `/catalogs` | Permission-filtered overview and role-specific starting points |
| `/catalogs/context` | Context products, declared fields, consuming skills and agents |
| `/catalogs/skills` | Business outcomes, execution bounds and context requirements |
| `/catalogs/agents` | Mandates, skills, context subscriptions and human review gates |
| `/catalogs/external-capabilities` | Separate inventories for capability definitions and provider bindings |
| `/catalogs/policies` | Policy definitions, decision tables and documentary obligations |
| `/catalogs/documents` | Separate inventories for document types and the field library |
| `/catalogs/{kind}/{encodedId}` | Permanent detail link using canonical identity |

Search, group, status, sort, display mode, inventory, cursor and selection are URL state. Opening an inspector retains the result set; cross-catalog links carry the target inventory. Browser Back restores the previous catalog and filters. The existing `/context`, `/agents`, skill-detail and policy-authoring routes remain available, with links from their catalogs.

Documents and External capabilities start in **Groups** view. Document types browse by their 38 canonical families; fields browse by field-library section. Capability definitions and provider bindings start with nine task-oriented collections. The 20 functional domains derived from canonical capability paths remain available through **Browse by → Technical domains**, and existing `group` links keep their original meaning. Selecting a group opens its entries, with pagination scoped to that group. Search displays matching entries under classification headings. Board and table views remain available.

Provider bindings display their linked capability's canonical definition. Administrators can use **Edit binding** to save tenant revisions of capability assignment and scope; see [binding editing](external-provider-switchboard.md#admin-editing-of-capability-bindings). Jurisdiction is a separate fact: `unresolved` displays as **Not established**, with its semantic basis and proposed status in the inspector. As defined in the [canonical external capability model](../CANONICAL_EXTERNAL_CAPABILITY_MODEL.md), this means the binding's source scope is unknown; it does not mean the capability lacks a definition. Canonical IDs remain intact in the source contract, and proposed jurisdictions do not establish execution readiness.

`CatalogIndex.groupCounts` reports complete authorized counts for the current inventory, search and status before group selection or pagination. Group counts therefore do not depend on the number of rows loaded in the browser. Classification and selected inventory remain separate dimensions.

At 1440 CSS pixels and above, selection opens a side inspector. Smaller screens use a dismissible dialog with focus containment, Escape dismissal and focus return. Workspace navigation and inspectors become drawers below 1080 pixels. Catalog navigation becomes a horizontal list on small screens; dense tables retain contained scrolling.

Case documents lead with the evidence inventory and a link to any missing requirements. Selecting a document opens its source spans and extracted assertions together. Document presence, extraction completion and authorized acceptance remain distinct states.

## Personas and authority

`Session.navigation` is an optional presentation preference containing a landing route and preferred catalogs. Agent architects start with Agents and Skills; context architects start with Context; analysts discover Documents and Policies. When preferences are absent, recommendations derive from granted actions. The shell checks that a preferred landing route is available.

Preferences never grant access. [`catalog-access.ts`](../../packages/ui-contracts/src/catalog-access.ts) is shared by the UI, mock and BFF:

| Catalog | Existing read authority |
| --- | --- |
| Context, Skills, Agents | `draft.read` |
| External capabilities | `capability.read` |
| Policies | `draft.read` or `case.read` |
| Documents | `evidence.read` |

Authorization precedes board counts, facets, search, pagination and relationship projection. The BFF resolves a human principal through `@ehf/identity`, derives actions from roles, and checks direct detail requests independently of navigation visibility.

Saved views contain browser-local filters and display preferences. Storage keys include tenant, subject and catalog. Stored values are validated before use; storage failures leave the catalog usable. These preferences are not shared across browsers or users.

## Source contracts

The generated snapshot currently contains 1,668 entries: 12 context products, 229 skills, 7 agents, 56 external capability definitions, 825 provider bindings, 10 policy definitions, 293 document types and 236 fields. These numbers come from source library release `0.5.0` and remain generated data. Provider metadata describes 376 source records separately from the binding inventory; gateway and tenant providers may extend the runtime provider view.

[`catalog-snapshot.mjs`](../../scripts/catalog-snapshot.mjs) reads the source artifact, provider registries, policy YAML and document catalogs. It validates the artifact digest and emits [`catalogs.json`](../../apps/fincrime-host/docs/ui/contracts/fixtures/catalogs.json). Every entry retains canonical identity, source path, contract, digest and typed relationships. Catalog-owned legacy fixtures are refreshed by `ui-catalog-fixtures.py`, preserving business scenarios and document evidence.

The snapshot describes source definitions. It does not establish an admitted platform release, active execution, coverage verification or policy approval. Provider bindings retain their disabled or quarantined state. Document extraction key fields do not become collection obligations. Unsupported runtime scores and readiness claims are omitted.

The Experience API adds `CatalogSnapshot`, `CatalogIndex`, `CatalogSummary`, `CatalogEntry` and their supporting schemas:

| Operation | Behavior |
| --- | --- |
| `GET /api/v1/catalogs` | Authorized board counts, filtered summaries, facets and cursor pagination |
| `GET /api/v1/catalogs/{kind}/{entryId}` | Authorized detail, source contract and visible relationships |

The BFF and contract mock use the same pure projection in `packages/fincrime-views/src/catalogs.ts`. Cursors bind to the source digest, authority and filters; stale cursors restart the result set. Responses use private ETags. The BFF returns explicit errors for unauthenticated and forbidden reads, invalid queries, missing entries and unavailable sources. Deployments can set `CATALOG_SNAPSHOT_PATH`; otherwise the source fixture is loaded from the host package.

## Provider organization and evidence

External capabilities offers **Capability definitions**, **Provider bindings**, **Providers**, **Sources and networks**, and **Research queue** in the existing route. The provider switchboard retains its connection creation/editing, capability inspector, permission checks, quarantine restrictions, and gateway readiness display.

`config/provider-priorities.json` contains proposed research priorities for all 376 source records: 29 core candidates, 13 specialists, 245 discovery candidates, 88 source/network/eID review records, and one quarantined record. The 49 publicly researched records carry dated source links, observations, and limitations. Family IDs are declared source labels, not verified corporate identities. Custom and gateway-only providers stay unclassified until reviewed. Priorities organize discovery only; they never select a connector, clear a blocker, approve scope, or provide an observed usage ranking.

`config/capability-collections.json` assigns each of the 56 canonical paths to one of nine browsing collections. The snapshot generator validates complete, unique membership and the provider evidence metadata. It attaches collections outside each immutable source contract and publishes optional provider metadata on the snapshot. `collection` is an additive catalog query; `group` retains technical-domain semantics. Collection counts cover all authorized search/status matches before collection selection and pagination; cursors bind to the selected collection. Saved views retain collection and domain preferences.

The provider view filters by research lane, collection, declared family, setup state, and unresolved research need. Its **Research** tab shows the proposed priority, public observations, evidence limitations, and outstanding scope/coverage/mapping/correction needs. Counts distinguish provider records, declared family labels, and proposed bindings. Read-model metadata only enriches visible source/tenant/gateway records; it does not reintroduce source rows filtered out by the caller. Older snapshots and API payloads without discovery metadata remain supported.

Edit the priority/taxonomy sources, run `node scripts/ui-sync.mjs`, and verify `node scripts/ui-sync.mjs --check` plus `node --test scripts/capability-discovery.test.mjs`. Contract changes continue through the OpenAPI generator and UI sync. Provider qualification, evidence-backed canonical corrections, and production-usage aggregation remain separate work. See the [organization proposal and full research inventory](capability-catalog-organization-proposal.md).

## Copy and extension points

Edit board descriptions, questions, navigation names and common catalog copy in [`apps/web/src/catalogs/copy.ts`](../../apps/web/src/catalogs/copy.ts). Edit authored agent, context and policy display names or skill-title overrides in [`config/catalog-presentation.json`](../../config/catalog-presentation.json), then regenerate. Canonical IDs, authority and saved links remain stable when presentation copy changes.

Add contract fields to `apps/fincrime-host/docs/ui/contracts/gen/openapi_v2.py`, regenerate the OpenAPI, and run UI sync. Generated types and vendor files are not hand-edited. Add source-specific projection changes to `catalog-snapshot.mjs` and permission-aware filtering to the shared read model.

```sh
python3 apps/fincrime-host/docs/ui/contracts/gen/openapi_v2.py
node scripts/ui-sync.mjs
node scripts/ui-sync.mjs --check
```

The OpenAPI generator requires PyYAML. Sync uses the repository's Node dependencies and Python standard library. `--check` verifies both catalog projections without modifying them, then verifies generated output freshness.

When intentional host changes affect pinned source groups, review the affected contracts before selectively re-pinning:

```sh
python3 apps/fincrime-host/docs/ui/contracts/tools/check_sources.py \
  --kyc-root apps/fincrime-host --ehf-root . --update \
  --groups kyc.release kyc.tasks kyc.agents kyc.context kyc.integration kyc.records
node scripts/ui-sync.mjs
```

This leaves unrelated historical EHF pins and their existing drift acknowledgments intact.

## Verification and integration boundary

Read-model and BFF tests cover schema validation, canonical relationships, permission-filtered counts, direct-read denial, pagination, ETags and error responses. Browser tests cover all six boards, related-entry navigation, saved views, global search, empty and missing-entry states, responsive dialogs, focus restoration and automated accessibility. Existing shell, workspace, context, agent and policy-authoring journeys remain covered.

The provider-organization extension adds regression coverage for the complete 376-record/825-binding census, all 56 collection memberships, legacy snapshots and domain links, filtered-source authorization, collection-bound cursors, tenant binding revisions, evidence rendering, quarantine, narrow-screen accessibility, and connection draft creation/editing. `scripts/capability-discovery.test.mjs` compares every generated binding contract and digest with its canonical source and runs in the UI-contract CI step. No discovery priority is consulted by runtime connector selection.

The local preview runs in contract-mock mode. Authenticated catalog endpoints read the actual generated source snapshot and are verified through Fastify injection. The broader BFF still needs its pre-existing browser OIDC session, delegated relay and operational compositions before the entire SPA can run against live services. Catalog UI validation does not establish that integration. Existing upstream gaps remain in [CONTRACT-GAPS.md](../../apps/web/CONTRACT-GAPS.md).

Visual comparisons, iterations, viewports and residual validation limits are recorded in [`design-qa.md`](../../design-qa.md).
