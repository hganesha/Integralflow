# Catalog experience visual QA

**Findings**

No actionable P0, P1 or P2 findings remain in the reviewed catalog and document flows. The new information architecture is an intentional redesign within the existing visual language; it is not a pixel copy of the older mockup data model.

**Comparison targets and evidence**

Source visual truth:

- [Style guide](apps/fincrime-host/docs/ui/STYLE-GUIDE.md), including typography, tokens, earned success states and absence hatching.
- [Contextboard mockup](apps/fincrime-host/docs/ui/mockups/cxt-01-contextboard.html).
- [Workforce Atlas mockup](apps/fincrime-host/docs/ui/mockups/agt-01-workforce-atlas.html).
- [Skillboard mockup](apps/fincrime-host/docs/ui/mockups/agt-04-skillboard.html).
- The pre-change case-documents capture is a product baseline, not a design mockup. Its source is preserved in the left panel of the documents comparison.

Rendered implementation: `http://127.0.0.1:5174`, Chrome, contract-mock mode, source release `0.4.0`. Context uses the context-architect persona; agent and skill discovery uses the agent architect; document review uses the CDD analyst. The selected skill is `ownership.ubo.resolve`, context product is `ownership.intelligence`, field is `document_number`, and the synthetic case is `KYB-1042`.

| Comparison | Combined source and implementation image |
| --- | --- |
| Context composition and inspector | [Full view](docs/implementation/catalog-experience/evidence/comparison-context.png) |
| Agent card hierarchy | [Full view](docs/implementation/catalog-experience/evidence/comparison-agents.png) |
| Skill discovery and selected detail | [Full view](docs/implementation/catalog-experience/evidence/comparison-skills.png) |
| Case evidence before and after | [Full view](docs/implementation/catalog-experience/evidence/comparison-documents.png) |
| Context typography, spacing, tabs and cards | [Focused comparison](docs/implementation/catalog-experience/evidence/focus-context.png) |
| Document copy, controls and table | [Focused comparison](docs/implementation/catalog-experience/evidence/focus-documents.png) |

The source captures are 1440 × 1000 pixels at a 1440 × 1000 CSS viewport. Implementation captures use the same viewport and `deviceScaleFactor: 1`; no density scaling is applied. Full-view comparisons place source left and implementation right at their original 1440-pixel widths in a 2880 × 1100 image. For longer pages, this compares the initial screen; full-page implementation captures retain the remaining content.

Focused comparisons also retain 1:1 pixels. Context crops each image at x=248, y=70, width=720, height=420, yielding a 1456 × 420 comparison with a 16-pixel gutter. Documents crops x=255, y=300, width=800, height=500, yielding 1616 × 500. These focused views were inspected in addition to the combined full views.

Additional implementation evidence:

- [Catalog overview](docs/implementation/catalog-experience/evidence/catalogs-home.png): 1440 × 1000.
- [Document source and extracted assertions](docs/implementation/catalog-experience/evidence/document-review.png): 1440 × 1000.
- [Field library and searchable relationships](docs/implementation/catalog-experience/evidence/field-library.png): 1440 × 2627 full page, 1440 × 1000 CSS viewport.
- [1366-pixel catalog](docs/implementation/catalog-experience/evidence/catalogs-1366.png): 1366 × 1731 full page.
- [1024-pixel catalog](docs/implementation/catalog-experience/evidence/catalogs-1024.png): 1024 × 2012 full page.
- [320-pixel context catalog](docs/implementation/catalog-experience/evidence/context-320.png): 320 × 4053 full page.
- [Capture manifest](docs/implementation/catalog-experience/evidence/capture.json): all captured routes, displayed text, overflow checks and page errors, including the 390-pixel analyst overview. Responsive captures use a 1000 CSS-pixel height and density 1.

**Comparison history**

| Iteration | Finding and impact | Fix and post-fix evidence |
| --- | --- | --- |
| Initial review — blocked | P1: catalog discovery was divided among studios and administration; document types and skills had no independent discovery boards. P2: Contextboard cards became roughly 129 pixels wide on laptops, while narrow navigation and inspectors followed the entire page. | A primary Catalogs destination, six consistent boards and permission-aware shortcuts establish the hierarchy. Center-width-aware grids and responsive dialogs keep navigation and selection reachable. The catalog overview, Context comparison, 1366 and 1024 captures show the revised structure. |
| First implementation — blocked | P2: stacked documentary requirements pushed the evidence table beneath the activity rail. The default source highlights used native yellow rather than the semantic attention palette. | Evidence now leads the document workspace, with a visible link to missing requirements. Requirements retain a compact grid below it. Source spans use attention tokens. The final documents comparison shows all three evidence rows above the rail; the review-dialog capture shows restrained highlighted spans and unverified assertions together. |
| Second implementation — blocked | P2: a field used by 293 document types created an unbounded inspector list. Source-definition notes also inherited absence hatching, implying missing data. | Related entries are searchable, initially limited to eight, and progressively disclosed. Definition scope uses a plain informational surface. The field-library capture and final selected-skill comparison show the corrected hierarchy and surface treatment. |
| Final comparison — passed | No actionable P0/P1/P2 differences remain in the inspected states. | The final combined full views, focused views, document dialog and responsive captures were reopened and compared after the fixes. |

**Required fidelity surfaces**

| Surface | Evaluation |
| --- | --- |
| Fonts and typography | Self-hosted Instrument Sans carries interface text; Instrument Serif is reserved for the catalog landing display; JetBrains Mono carries IDs, versions and contracts. Focused comparisons show legible headings, labels, line height and wrapping. Long agent mandates are descriptions beneath short authored names. No fallback-font mismatch is visible in the final captures, which wait for `document.fonts.ready`. |
| Spacing and layout rhythm | Shared token spacing, hairlines, restrained radii and consistent toolbars organize dense content. Cards size to the available center width. Selection does not reserve an empty inspector. At smaller widths, dialogs and drawers preserve access to navigation and details. The evidence table has a clear place in the initial document view. |
| Colors and tokens | Porcelain surfaces and graphite hierarchy follow the guide. Neutral states identify definitions; attention identifies disabled bindings and unreviewed assertions. Catalog membership is not styled as verified execution. Absence hatching remains reserved for missing or unsubscribed data. |
| Image and asset fidelity | These screens require no photographic or illustrative assets. The existing shared icon library and self-hosted font assets remain in use. No source logo, illustration or product image has been substituted with generated or handcrafted artwork. |
| Copy and content | Authored names, board questions, explicit source scope and supported next actions replace identifier-heavy headings. Raw contracts are secondary. Document key fields, policy obligations, presence and acceptance remain distinct. Policy approval copy describes approval rather than cryptographic signing. Display names and board copy have explicit editing locations. |

**Intentional differences from the mockups**

The source has 7 agents, 229 skills and 12 context products. The mockups' planned mandates, context profiles, evaluation scores, cognitive-bank assignments and dry-run activity are not restored without supporting contracts. Skills default to a table; Documents and External capabilities now default to classification groups, with table and board alternatives. Catalog browsing and studio configuration remain separate destinations. The global EHF shell is retained across domains.

These differences preserve current contracts and the approved information architecture. Their effects on density and content order are accepted design changes, not unresolved fidelity defects.

**Interaction and accessibility checks**

Ten catalog browser tests cover discovery, related links, Back navigation, account-scoped saved views, field and binding inventory links from global search, empty results, missing definitions, responsive dialogs, Escape, focus return and classification drill-down. The 320 CSS-pixel check waits for the populated board and fonts before checking reflow. The final captures report no document-level horizontal overflow or JavaScript page errors. Horizontally scrolling navigation and tables stay contained.

The 30 shell, workspace and authoring journeys and 18 existing Contextboard and Agent Studio journeys pass. Covered states have no serious or critical automated axe violations. Manual screen-reader testing and actual browser zoom remain outside this run; 320-pixel reflow and keyboard behavior were exercised directly.

Authenticated BFF catalog reads are verified separately against the canonical snapshot. Browser captures use the contract mock because the broader BFF browser session and relay layer remains an existing integration gap; this visual result does not certify live platform integration.

**Implementation checklist**

- [x] Compare source and implementation in combined full and focused views.
- [x] Fix crowded evidence, unbounded relationships and inappropriate hatching.
- [x] Reopen post-fix captures and inspect all five fidelity surfaces.
- [x] Verify keyboard dismissal, focus restoration, permission filtering and 320-pixel reflow.
- [x] Preserve explicit source provenance and unsupported-state disclosures.

**Follow-up polish**

No P3 visual changes are required for this handoff. Broader manual accessibility and live-service integration validation remain separate verification work.

**Classification browsing update**

The earlier flat Document and External capability lists were a P2 discovery issue for these larger inventories. The approved correction makes existing classifications the initial browsing structure: 38 document families, field-library sections and 20 functional capability domains. Capability definitions and provider bindings share domains while retaining separate inventories.

The previous UI and revised UI were captured at the same routes, personas, 1440 × 1000 CSS viewport and density 1. Source and implementation are combined at 1:1 scale, left and right, in 2880 × 1100 comparison images. The comparison shows the initial viewport of each full-page capture:

- [Document comparison](docs/implementation/catalog-experience/evidence/grouping-compare-documents.png).
- [Capability comparison](docs/implementation/catalog-experience/evidence/grouping-compare-capabilities.png).
- [Selected document family](docs/implementation/catalog-experience/evidence/grouping-after-document-family.png).
- [Provider binding domains](docs/implementation/catalog-experience/evidence/grouping-after-binding-domains.png).
- [390-pixel document groups](docs/implementation/catalog-experience/evidence/grouping-after-documents-mobile.png).
- [1024-pixel capability groups](docs/implementation/catalog-experience/evidence/grouping-after-capabilities-laptop.png).

Post-fix inspection confirms consistent Instrument typography, token spacing and porcelain surfaces, neutral counts, standard shared icons and explicit family/domain copy. No image assets were introduced. Classification cards replace repeated record metadata in the initial viewport. Selecting a classification shows its entries; global search still leads directly to matching entries under classification headings. Sorting applies to visible groups, and group counts cover the complete authorized matching inventory before pagination.

The ten catalog journeys pass, including alphabetic group sorting, drill-down, browser Back and provider-binding pagination within a domain. Contract, projection and BFF tests verify complete counts and shared classification between a binding and its capability definition. Eight revised browser states were captured, including mobile and laptop sizes, with no document-level horizontal overflow or page errors. No actionable P0/P1/P2 finding remains in this update.

final result: passed
