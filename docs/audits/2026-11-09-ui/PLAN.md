# UI improvement implementation plan

Date: 2026-11-09. Scope: the current `ehf-concept` working tree. This is an implementation plan; product source has not been changed by the audit.

## Required outcome

Every skill and capability collection retains its category structure in every display mode, search result, relationship list, and selection control. Every category and every skill/capability has a descriptive product icon. Links must reach both a registered screen and a working, authorized BFF operation. Presentation uses semantic tokens, consistent alignment, and consistent product language.

Preserve canonical identifiers, authorization, version pins, dependency order, and the distinction between a source definition, a provider binding, and proven runtime availability.

## Delivery order

| Phase | Work | Dependencies | Acceptance gate | Suggested owner |
| --- | --- | --- | --- | --- |
| 0 | Establish a reproducible preview and the registered-operation baseline | None | Current-source preview provenance recorded; route coverage inventory reproducible | Frontend + platform |
| 1 | Define category/presentation metadata and shared grouped components | 0 | All 229 skills, 56 capability definitions, and 825 bindings resolve a category and icon; no unknown icon names | Frontend + catalog owner |
| 2 | Apply persistent grouping and icon coverage across every collection | 1 | Board/table/search/related/picker/profile presentations preserve categories and counts under filtering and pagination | Frontend |
| 3 | Repair BFF coverage and navigation destinations | Start after 0; parallel with 1–2 | Every exposed feature has registered routes, authorized data, correct errors, and meaningful HTTP journey coverage | BFF + upstream owners |
| 4 | Align semantic tokens, responsive layout, and copy | 1; finish after 2–3 | No unresolved design-token references; reviewed copy matrix; verified widths/density/focus states | Frontend + design |
| 5 | Run acceptance and update contract-gap documentation | 2–4 | Mock and HTTP journeys pass; explicit disclosures for genuinely unsupported upstream functions | Frontend + platform |

Suggested PR sequence: (1) route coverage and preview baseline, (2) presentation metadata and grouped primitives, (3) catalog/profile/search adoption, (4) authoring/context/picker adoption, (5) BFF relays and FinCrime projections split by service boundary, (6) token/copy/layout consistency, (7) end-to-end acceptance. Merge the BFF fixes required by a feature before representing that feature as working in HTTP mode.

## Phase 0 — reproducible baseline

- Record the working-tree revision and dirty-state context. Bind the preview to this checkout, on a dedicated port; do not reuse a port without checking its process working directory.
- Repair the installed runtime/dependency problem that prevents Vite and Vitest from starting (`TypeError: pico is not a function`). Check the `tsx`/Ajv failure separately (`Name is not a constructor`). Do not classify these as application behavior.
- Fix mock worker resolution in `apps/web/vite.config.ts`: `createRequire(import.meta.url).resolve('msw/mockServiceWorker.js')` relies on a package not declared by `@ehf/web`. Resolve through the owning package or declare the development dependency explicitly.
- Replace the scaffold test that merely counts operation metadata with a test of actual `app.hasRoute` registration at client-addressed URLs. Baseline: 171 non-mock contract operations, 56 registered at those URLs, 115 mismatches; 112 lack handlers and three auth handlers exist at the unprefixed `/auth/*` base. Of the 115 mismatches, 108 are directly referenced by UI source.
- Keep a reviewed exclusion list for intentionally unavailable operations, including an owner and user-visible unavailable state. No silent blanket allow-list.

## Phase 1 — one presentation registry

Use the existing catalog domain/category as the source of category membership. Do not introduce a second taxonomy based on ad-hoc ID splitting in each component. Category labels can differ from stable keys. Normalize display aliases such as `Monitor`/`Monitoring`, retaining their original identities.

Add a shared, typed presentation resolver with: canonical ID, display name, short description, category ID/label/order, category icon, optional item-icon override, and an explicit fallback. Keep presentation metadata outside execution manifests unless the contract owners intentionally add it to the catalog projection. Never infer authority from the icon or category.

Use [proposed-icon-map.json](proposed-icon-map.json) as the concrete starting proposal: 32 category labels and all 1,110 skill/capability/binding entries map to existing icon names. These mappings are proposals for review, not shipped changes. Category inheritance is sufficient for initial full coverage; add item overrides when an action-specific symbol improves recognition. Each entry must resolve intentionally; do not replace every missing assignment with `grid` or `layers`.

Build reusable presentation units in the existing UI architecture:

- A category heading: descriptive icon, label, filtered/total counts, optional collapse control with `aria-expanded` and a named region.
- An item identity: descriptive icon, authored title, optional category context, secondary canonical ID and version.
- A grouped collection renderer that supports board, table, related list, and picker bodies without removing category headings.
- A shared category/icon resolver usable by catalog, agent studio, context, authoring, and search without duplicating copy maps.

Keep the existing 24px outline family and 1.6 stroke. The current 14/16/20/24px display sizes are coherent. Use text alongside category icons; icons should not encode runtime state. Review whether finance, crypto, credential, and questionnaire categories need more specific product-owned assets after the existing-icon proposal is reviewed. Three brand PNGs total 3.76MB; the two directly imported by chrome/session UI total 2.79MB before transfer compression. Export appropriately sized variants or use an approved vector original, and verify the visual result at normal and high pixel densities. Keep the unused wordmark asset out of the initial load.

Acceptance: total mapping coverage for the current inventory; missing/new categories produce a visible “Other” group plus a development diagnostic. The UI must remain usable for unknown catalog entries rather than hiding them.

## Phase 2 — grouping is invariant

| Surface | Required change | Acceptance example |
| --- | --- | --- |
| Catalog skills | Add skills to `catalogGrouping`; default to category browsing; grouped table and board | Searching “ownership” can show Ownership and Screening sections; no flat alphabetic list |
| Capability definitions and bindings | Preserve domain sections in Table and Board; directory is one view of the same grouping | Selecting Table retains domain headings, icons, and counts |
| Global search | Partition skills/capabilities by category within result type; distinguish definitions from bindings | “Ownership” results do not interleave Account, Business, and Financial entries in one undifferentiated capability list |
| Catalog inspector relationships | Group related skills and capabilities by their actual category; include icons and authored labels | An agent inspector shows grouped allowed skills instead of a single kind-only list |
| Agent profile | Group allowed skills by catalog category; display authored title, ID second, pin intact | Entity, Ownership, and Registry each have a heading/icon |
| Skill contract/guardrails | Resolve dependencies and permitted capability IDs into grouped references | Missing definitions stay visible as unresolved references under an explicit group |
| Context consumers and Engineer tables | Group consuming skills and capabilities with the same registry | Switching from catalog to context does not change category labels/icons |
| Authoring skill/capability registries | Group registries, allowed-skill checkboxes, and permitted-capability checkboxes | Filtering preserves optgroup/fieldset/category context and keyboard access |
| Taskboard / execution graph | Preserve execution and dependency order; add category/icon context to each skill node and a grouped skill inventory | Category grouping never changes execution semantics |

Sort controls sort categories and members separately. “Name A–Z” must not flatten the collection. Search, status filters, saved views, direct links, and clearing filters retain grouping. Migrate saved `view=table` URLs to grouped tables without breaking the URL.

Pagination must preserve stable category order, accurate filtered/total counts, and a category heading when a category continues on another page. Either paginate within categories or explicitly mark continuations. Do not imply that the first 30 entries are the complete category. Derive counts before pagination with authorization applied first, using the existing BFF projection order.

## Phase 3 — BFF and navigation

Work from [bff-operation-coverage.json](bff-operation-coverage.json), not the number returned by `servedOperations()`.

1. Implement or explicitly retire exposed reads first: global search; workspace and human work; agent atlas/profile, task and skill projections; platform overview, plans, runs, cases, releases, system/admin, integrations, and assurance. Existing source catalogs/context/intelligence/provider routes should keep their behavior.
2. Add the corresponding authorized mutations by bounded feature: claims/decisions, case commands, authoring operations, run actions, integration/admin changes. Retain CSRF, delegated identity, tenant isolation, idempotency, and concurrency/basis checks. Use contract `xUpstream` metadata only for reviewed relay operations; composed FinCrime responses require real projections.
3. For every operation verify request mapping, query/path encoding, success/error schema, ETags and caller-specific responses, binary/stream handling where needed, and upstream outage behavior. A route that exists but always returns fixtures is not an HTTP completion.
4. Return contract-shaped errors with correlation IDs for unsupported operations. Health readiness must reflect the intended service readiness; the number of declared operations is not a coverage signal.
5. Decouple catalog home from external-binding availability. `loadSnapshot()` currently overlays bindings for a capability reader's unfiltered catalog-home request, so a binding-registry outage can hide all catalog tiles. Preserve independently readable catalogs and expose the affected source state truthfully.
6. Verify navigation by role and destination: screen exists, role can enter, data route exists, and detail identity loads. The 258 snapshot workspace URLs currently match route patterns and no relationships dangle; that does not establish live service behavior.
7. Remove the duplicate Intelligence navigation entry/ID in `apps/web/src/platform/routes.ts`. Validate nav IDs and destinations for uniqueness.
8. Reconcile unsupported-route disclosures and stale copy with current HTTP capabilities. Context preview now requires explicit case/plan/node authority; generic “needs a Bridge preview hook upstream” text in taskboard context links no longer describes every mode accurately.
9. Align auth URLs and response semantics. The shared client prepends `/api` to contract `/auth/*` paths, while session routes register `/auth/*`. In particular, sign-out calls `/api/auth/logout`, catches its failure, and presents the session-ended UI anyway. Use the correct auth transport/URL and acknowledge sign-out only after session invalidation succeeds; failed sign-out needs a recoverable error.

HTTP acceptance examples: source catalog → agent profile → grouped allowed skill → skill contract; search → correct typed destination; case workspace → human work → existing decision flow; capability domain → definition → binding → actual configuration; current-source context preview with explicit target. Use local test services/fixtures at service boundaries; do not execute consequential production actions as part of audit verification.

## Phase 4 — tokens, alignment, and language

### Tokens and layout

- Replace undefined `--font-body` with the established `--font-ui` or add a deliberate semantic alias at the token source. It currently invalidates three font declarations across onboarding and intelligence UI.
- Replace the undefined `--space-7` references with an approved spacing token or deliberately add it to the source. Its current fallback is 32px; `--space-8` already represents that size. Do not patch generated token output.
- Keep `--extraction-width` and `--object-color` as documented, component-local runtime properties; they are set in TSX and are not missing global tokens.
- Review the 22 CSS lines that use palette tokens directly. Introduce/reuse semantic action, selection, graph, and trusted-surface aliases. Selection alone should not borrow success/positive meaning, as the workflow outline currently does.
- Preserve the existing token pipeline: source `tokens.json` → sync/vendor → generated CSS/types. The audited source and vendor token JSON hashes match.
- Standardize title/body/metadata baselines, icon boxes, category header spacing, toolbar labels, numeric column alignment, badge placement, and definition/inspector widths using existing controls and density tokens.
- Check the 1,440px inspector transition, 1,200px/768px layout changes, and a 390px viewport. Check long skill names, long categories, empty states, sticky chrome/sidebars, horizontal table overflow, and 200% zoom. Table scrolling may be intentional; page-level clipping is not.
- Replace compressed catalog description rows with content-aware row spacing. Give the profile's canonical-ID column a usable width so IDs do not break mid-token. For the default ontology graph, use a readable initial focus/zoom or promote the object-list alternative; preserve Fit graph as an overview action.

### Copy matrix

| Current inconsistency | Target convention |
| --- | --- |
| Skills described as “capability” | “Skill” for an executable skill; “External capability” for the provider contract |
| “External capabilities 881” | “56 capability definitions · 825 provider bindings”, or section-specific counts |
| Documents total combines types/fields | Separate document-type and field-library counts |
| Agent catalog short titles vs atlas/profile mandate sentences | Same short authored title; mandate as supporting description |
| Raw `agent.*`, `task.*`, `skill.*` strings as primary names | Authored name first, canonical ID secondary; keep IDs in contract/technical views |
| Domain / group / bank / intelligence area | “Skill category” and “Capability domain” in browsing; retain “Context product” for context objects |
| “Waiting human” | “Awaiting human review” |
| “Implemented synthetic” | “Implemented · synthetic data” if that accurately expresses two independent facts |
| “Dry run”, “context preview”, and obsolete preview-hook notes | “Preview context packet”, with mode-specific requirements/unavailable reason |
| “Open workspace” | Name the destination when known: “Open agent profile”, “Configure provider binding”, etc. |
| Internal GAP/M-number references in ordinary task guidance | Plain explanation and next action; technical details available in diagnostics |

Centralize the glossary and shared labels; keep technical source contracts intact. Every error, empty state, disabled action, and unavailable state should explain what happened and the available next action.

## Phase 5 — completion checks

- Catalog invariants: complete group/icon coverage; stable category order; no flattening through table/search/filter/saved view; correct counts before and after pagination.
- Routing: registered-route coverage checked against exposed contract operations; actual authorized response and error shapes; nav IDs unique; all catalog workspace and relationship destinations checked.
- Mock/HTTP parity: key journeys run in both modes. A passing mock journey is insufficient evidence for BFF wiring.
- Accessibility: category headings/regions, named grouped search options, labeled icon-only buttons, decorative icons hidden from assistive technology, keyboard selection/collapse, focus restoration, loading/error announcements, measured text contrast and 200% zoom. Screenshots alone cannot certify compliance.
- Layout: review current captures at desktop/narrow/mobile widths with long content, selected detail, empty/error state, and compact density.
- Verification commands after implementation: focused tests for the changed packages; `pnpm ui:test`; `pnpm ui:test:e2e`; relevant HTTP journeys with the BFF and upstream test services. Run contract generation/validation when schemas or generated presentation metadata change.
- Update `apps/web/CONTRACT-GAPS.md` only after each gap's real implementation is verified. Keep unresolved upstream work explicit, with owners.

Start implementation with Phase 0 and the BFF route-registration/auth-path defects, then adopt the presentation registry across grouped skill and capability collections.
