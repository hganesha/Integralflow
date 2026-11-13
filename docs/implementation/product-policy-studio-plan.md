# Product Policy Studio and product taxonomy: plan

Status: phase A implemented 2026-11-11; phases B–G proposed. The section 8 recommendations were accepted the same day. It builds on the
[Policy Studio builder](policy-studio-builder-plan.md) (phases 1–4, PR #76) and the
[policy packs](policy-packs.md).

The goal is a three-pane **Product Policy Studio**: a product tree, the product's rules, and a
live effective-policy and simulation panel. It sits on a **canonical financial-services
product taxonomy** that each institution personalises. A product is treated as a regulated
relationship that supplies facts to the policy engine. It never carries a hard-coded SDD, CDD or
EDD decision.

## 1. What exists, and what is missing

| Target concept | Today | Gap |
| --- | --- | --- |
| Canonical product taxonomy (L0–L6) | `bankingProductSchema` in `packages/contracts/src/financial-crime.ts`: 11 flat banking values. The library's `Product` record has `product_type`, `channel` and `active` | No hierarchy, no securities, insurance or asset-management products, no attributes, no versioning |
| Institution catalog (SKUs mapped to canonical products) | `domains/policy/selection.yaml` names product sets (`personal-banking`, `business-banking`) for `bank.synthetic` | No institution profile, business lines, SKUs, variants or enablement |
| Product attributes (eligibility, funding, channels, capabilities) | The relationship's `products[]` carries currencies, countries, channels and expected activity per case | No product-level definition of capabilities or eligible party types |
| Policy inheritance (regulatory → institution → business line → family → product → segment → case) | Pack layers baseline → jurisdiction → institution → product. They only tighten, and every value records the layer that set it and why | No business-line or family layers; product layers match flat ids only |
| Product-specific rules with Inherited / Override / Conditional | Diligence overlays are policy-wide; packs can make an overlay mandatory | Overlays have no product scope and cannot add requirements or approvals |
| Effective policy inspector | Requirements tab (installation fields, pack settings, requirements by level) | No per-product list of controls with source layer, status and basis |
| Policy coverage matrix (controls × products) | Diligence matrix (party type × product → level) | No control-by-product view |
| Simulator with generated requirements | Diligence what-if: party type, products, risk factors, rationale | No "assessed risk" input, no SKU picker, no full trace of tasks and approvals |
| Impact simulation before publishing | Versions compare (design diff); Monitoring (stored outcomes) | No re-evaluation of representative cases under the candidate policy |
| Governed publishing | Save → compile → approve → publish, with separation of duties | No effective dates, scheduled activation or rollback in the studio |
| Agent integration (product resolver, task planner) | Static `requirementsPackage` per flow (`individual`, `private_company`); the diligence gate feeds the EDD and requirements skills | No product resolver; task scope does not follow the product |

The engine pieces this needs mostly exist: tighten-only layers with basis, an escalate-only
diligence evaluation with contributors, a reference evaluation held equal to OPA, YAML-preserving
edits, and stored decision receipts. The missing piece is a product model with depth.

## 2. Architectural decisions

1. **Products are a versioned ontology artifact**, like packs. They are platform-owned,
   content-addressed and CANDIDATE until approved. Canonical ids are dotted codes
   (`BRK.PRIME.INSTITUTIONAL`) whose ancestors are their prefixes. That makes "applies to
   BRK.PRIME and everything under it" a prefix check, in Rego and in TypeScript alike.
2. **Product, instrument, service and account structure stay separate.** Omnibus, nominee and
   fiduciary are `accountArrangement` attributes, not product leaves. Private banking is a bundle.
   Risk combinations (nonresident, offshore) are attributes, never extra leaves.
3. **Three configuration layers**:
   - (A) the canonical catalog, which the platform owns;
   - (B) the institution catalog: SKUs, names, variants and enablement, mapped onto A;
   - (C) policy overlays (regulatory, institution, business line, family, product, segment).

   A cannot be edited by a customer. B and C are versioned per institution.
4. **Inheritance is the existing tighten-only composition, extended down the taxonomy.** Product
   layers may target any taxonomy node. They compose from general to specific (family → class →
   type → variant), each only tightening, before the institution's product overrides. A
   regulatory value is **protected**: no lower layer can loosen it, which the composition already
   enforces. The studio labels it "Protected".
5. **Rules carry scope and effects, and never decide on their own.** Diligence overlays become
   scoped rules:
   - `appliesTo` lists products (taxonomy nodes), party types, jurisdictions and segments;
   - effects are `escalateTo`, `escalateBy`, `addRequirements` (evidence obligations) and
     `requireApproval` (a role and quorum).

   The diligence gate's output gains `requirements` with provenance and `approvals`. The
   disposition gate turns approvals into a person's decision (`NEEDS_HUMAN`), so an approval is
   a human requirement, never an automatic grant.
6. **The effective policy is computed, not stored.** For a product, party type, jurisdiction and
   segment, the engine returns every control with its source layer, status (Protected, Inherited,
   Modified, Conditional, Not applicable), basis, version and approver. The studio's inspector,
   coverage matrix and simulator all read this one function.
7. **Cases name canonical products.** `BankingRelationship.products[]` gains optional
   `canonicalProductId` and `offeringId` beside `productType`, which stays for compatibility.
   A product resolver maps legacy `productType` values and institution SKUs to canonical ids, and
   policy scope uses the canonical id with its ancestors. A case whose product does not resolve
   stays unresolved, never defaulted.

## 3. Data model

New contracts in `packages/contracts/src/products.ts` (browser-safe):

| Entity | Purpose | Key fields |
| --- | --- | --- |
| `ProductNode` | One node of the canonical taxonomy (sector, family, class, type) | `id`, `level`, `parent`, `name`, `definition`, `regulatedActivities[]`, `capabilities{}`, `eligiblePartyTypes[]`, `riskDimensions[]`, `aliases[]`, `alsoClassifiedAs[]` |
| `ProductAttributeDefinition` | Typed, reusable attributes | `id`, `group` (identity, eligibility, regulatory, jurisdiction, structure, ownership, funding, behaviour, channel, exposure, intermediary, asset, risk, monitoring, lifecycle), `type`, `enum`, `canonicalSource` |
| `ProductTaxonomy` | A versioned release of nodes and attributes | `version`, `status`, `digest`, `nodes[]`, `attributes[]` |
| `InstitutionOffering` | An institution's SKU | `offeringId`, `institution`, `name`, `canonicalProductId`, `variantAttributes{}`, `bookingEntities[]`, `jurisdictions[]`, `eligiblePartyTypes[]`, `bundle[]`, `status` |
| `InstitutionCatalog` | Versioned set of offerings and business lines | `institution`, `version`, `businessLines[]`, `offerings[]`, `digest` |
| `RegulatedActivity` | Licensed activity behind an offering | `id`, `regime` (banking, broker-dealer, adviser, insurer, VASP, MSB), `jurisdictions[]` |
| `PartyProductRelationship` | A party's role in a product relationship | `partyId`, `offeringId`, `role` (customer, underlying investor, counterparty, intermediary) |
| `EffectiveControl` | One row of the effective-policy inspector | `controlId`, `source{layer, id, version}`, `status`, `conditions`, `evidence[]`, `basis`, `approvedBy` |

Existing contracts change additively:
- **Pack layers:** `appliesTo.products` accepts taxonomy nodes, plus a new layer kind,
  `business_line`.
- **Diligence block:** `matrix` columns become taxonomy nodes. Rows and columns still resolve by
  the most specific match, then floors.
- **Overlays:** they gain `appliesTo` and the new effects.

## 4. Seed content

- **All 18 domains, at family level** (about 129 families): deposits, payments, lending, trade
  finance, treasury, brokerage, instruments, asset management, wealth, custody, fund services,
  insurance, retirement, corporate & investment banking, correspondent & FI, digital assets,
  fintech, specialised.
- **Banking and Securities down to type level first:** deposits, payments, lending, brokerage,
  custody and wealth. That covers today's 11 `productType` values plus the mock's Securities &
  Brokerage tree (cash, margin and prime brokerage, institutional custody). The other domains
  deepen in later releases.
- **Legacy mapping.** Each current `productType` maps to one node, for example
  `deposit → DEP.TRANSACTION`, `custody → CUS.SAFEKEEPING`, `digital_assets → DIG.CUSTODY`.
  `correspondent`, `fbo` and `private_banking` map to bundles.
- **Two synthetic institutions,** neither a real firm. `bank.synthetic` keeps today's banking
  products. A synthetic securities firm offers brokerage, custody and prime services under a
  US broker-dealer regime.
- Every node and value is CANDIDATE, with a basis, and is not an official regulatory
  classification. Taxonomy content lives in `domains/products/` and is compiled by
  `scripts/sync-product-taxonomy.mjs` into `artifacts/products/`, with a drift check in CI.

## 5. The studio

The guided top bar, Business → Products → Policies → Simulate → Publish, wraps the existing tabs
rather than replacing them.

| Step | Screen | Built from |
| --- | --- | --- |
| Business | Institution profile: legal entities, booking entities, business lines, jurisdictions, regulated activities | New; administered configuration in control-api, with revisions |
| Products | Catalog: enable canonical products, name SKUs, map aliases, set variant attributes and eligible party types; bundles | New, plus a seventh catalog kind `products` in the Catalogs experience |
| Policies | **Three-pane Product Policy Explorer.** Left: product tree with Inherited / *n overrides* badges. Centre: the product's rules (Inherited, Override, Conditional, Protected) with switches, a rule builder ("When … then …", optional approval, human-readable sentence), and Requirements, Inheritance, Simulation and Change-history tabs. Right: the effective-policy inspector with an inheritance trail (Regulatory › Institution › Securities › Brokerage › Prime) and a pinned simulator | Today's Rules, Requirements and builder sheets, with product scope added |
| Policies (power view) | Coverage matrix: controls × products, bulk edit, inheritance-aware warnings | New; reads the effective policy |
| Simulate | Scenario simulator (product or SKU, party type, assessed risk, risk factors), the outcome and generated requirements, a full trace (rules, versions, evidence, tasks, approvals); **impact simulation** of candidate vs published policy over a regression set | Today's what-if and rationale, plus an impact runner |
| Publish | Validate → Simulate → Compare → Approve → Activate, with effective date, scheduled activation, rollback and immutable history | Today's Approvals and Versions, plus effective dating |

Progressive disclosure follows the roles in the identity table:
- `Case.Analyst` sees products and requirements;
- `Harness.Author` edits rules;
- `Harness.Approver` approves;
- Advanced keeps the YAML and the compiled bundle.

## 6. Agentic flow integration

1. **Product resolver.** A deterministic step at intake maps each relationship product (SKU or
   legacy type) to a canonical id and offering. It records a gap for anything unmapped, and the
   diligence gate reads canonical ids.
2. **Requirement-driven planning.** The static `requirementsPackage` per flow becomes
   requirements resolved from product, party type and level. The resolved requirements and
   approvals from the diligence gate select document requirements, screening scope and EDD
   tasks, which extends phase 4's `DERIVED` content.
3. **Relationship roles.** `PartyProductRelationship` lets one party be a customer for one
   offering and an underlying investor for another, each with its own requirements.
4. **Python library.** Securities and insurance product types reach the library's `Product`
   record through a change request (`skill-library-change-request.md`), not a local fork.

## 7. Phases

| Phase | Deliverable | Main changes | Tests |
| --- | --- | --- | --- |
| **A. Taxonomy** | Product contracts; `domains/products` seed (18 domains, Banking and Securities to type level); legacy mapping; sync script and CI check; Catalogs kind `products` | `packages/contracts/src/products.ts`, `scripts/sync-product-taxonomy.mjs`, `artifacts/products/`, catalog BFF and UI | Schema, unique ids, prefix ancestry, every legacy type mapped, drift |
| **B. Institution catalog** | Business profile and product catalog editors, with revisions; synthetic bank and securities-firm seeds | control-api administered configuration, Experience API operations, mock, studio steps 1–2 | Revision conflicts, tenant isolation, SKU → canonical resolution |
| **C. Inheritance on the taxonomy** | Pack layers at any node and a `business_line` kind; diligence matrix and overlays scoped to nodes; effective-policy function | `policy-packs.ts`, `diligence/*`, OPA interpreter, reference evaluation | Tighten-only at every level, protected values, most-specific matching, OPA = reference corpus extended to scoped rules |
| **D. Rules with effects** | `addRequirements` and `requireApproval` effects; approvals routed to people at disposition; rule builder with human-readable sentence | Diligence schema, Rego, case API, builder sheets | Approval never grants; requirements carry provenance; no rule can disable a protected control |
| **E. Three-pane studio** | Product tree with override counts, product rule list, effective-policy inspector with inheritance trail, coverage matrix, guided top bar | `apps/web/src/policies/*`, Policy Studio shell | Browser journey: enable product → override rule → see inspector change → simulate |
| **F. Simulation and publishing** | Assessed-risk input and full trace; impact runner over a regression set; effective dates, scheduled activation and rollback | Policy engine batch evaluation, control-api releases, Approvals | Impact diff is reproducible; rollback restores the exact prior digests |
| **G. Flow integration** | Product resolver step, requirement-driven planning, relationship roles; library change request | Agentic flow generator, runtime, case API, library | Compiled-plan tests; case API integration with a securities case |

A and B do not depend on C. C is the engine change everything later builds on. E can start on
the mock as soon as A and the effective-policy contract exist.

### Phase A as built

- **Taxonomy sources** are in `domains/products`, all CANDIDATE:
  - `taxonomy/<CODE>.yaml`: 18 domains and 129 classes, plus 123 types for deposits, payments,
    lending, brokerage, custody and wealth;
  - `attributes.yaml`: 35 typed attributes across 16 groups, each saying whether the product, the
    offering or the relationship sets it;
  - `legacy-mapping.yaml`: all 11 of today's `productType` values mapped onto the taxonomy.
- **Levels.** Sectors are a classification on each domain; L2 domain, L3 class and L4 type are
  nodes. The 129 "families" listed under the 18 domains are the L3 classes. Variants (L5) and SKUs
  (L6) are left to institution catalogs (phase B).
- **Contracts** live in `packages/contracts/src/products.ts`, browser-safe and also exported as
  `@ehf/contracts/products`. They cover node, domain, attribute and mapping schemas, regulated
  activities, party classifications, risk dimensions, and `productLineage` / `productWithin`
  (prefix ancestry).
- **Compiler.** `compileProductTaxonomy` in `packages/policy-engine/src/products.ts` composes ids,
  ancestry and children, checks every cross-reference (`alsoClassifiedAs`, `bundle`), and refuses a
  legacy type that is unmapped or invented. It digests each domain and the whole taxonomy.
  `scripts/sync-product-taxonomy.ts` writes `artifacts/products/taxonomy.json`, and CI runs it
  with `--check`.
- **Products catalog.** A seventh catalog kind, `products` (readable with `draft.read` or
  `case.read`), shows every node grouped by domain. Each entry carries level, sectors, regulated
  activities, capabilities, risk dimensions and eligible party types, links to its parent,
  children, other classifications and bundle members, and says that a product never decides a
  due-diligence level. Global search returns products too.
- **Not yet.** Cases do not carry `canonicalProductId` (phase G with the resolver), and policy scope
  still uses the flat product ids (phase C).

### Phase B as built

- **Contract.** `packages/contracts/src/products.ts` adds the institution catalog
  (`harness.factory/institution-catalog-v1`): the institution's jurisdictions, legal entities with
  their regulatory regimes, business lines with a product scope (any taxonomy node), and
  offerings. An offering is the institution's own product (L6): it names one canonical product,
  its business line, legal entity and jurisdictions, may narrow eligible party types, sets
  offering-level attributes as its variant (L5), bundles other offerings, and may claim today's case
  `productType` values. The catalog records the taxonomy version and digest it was written against.
- **Problems, not refusals.** `institutionCatalogProblems` lists everything an approver must see
  resolved: unknown products, entities, business lines or scope nodes; an offering outside its
  business line's scope or the institution's jurisdictions; eligibility wider than the canonical
  product's (`effectiveEligibility`: the nearest ancestor that lists party types); attributes that
  are unknown, set at the wrong level or invalid; bundles that name no other offering; a legacy
  type claimed twice; duplicate ids; and an outdated taxonomy. A draft with problems can be saved
  but not approved.
- **Resolution.** `resolveCaseProduct` maps a case product to the taxonomy: an exact offering id;
  else the one active offering that claims the legacy `productType`; else the taxonomy's own legacy
  mapping. Anything else, including a retired offering or a type two offerings claim, stays
  unresolved (null) and is never defaulted. Phase G's resolver step will call it.
- **Seeds.** `domains/products/institutions/` holds `bank.synthetic` (two banking entities in the US
  and GB, personal and business banking, eight offerings including the legacy card, lending,
  merchant acquiring and payments types) and `securities.synthetic` (a US broker-dealer and a trust
  company, brokerage, prime services, custody and wealth, six offerings). Both are synthetic.
  `loadProductTaxonomy` and `loadInstitutionSeeds` in `packages/policy-engine/src/products.ts`
  compile them; the sync script writes `artifacts/products/institutions.json` and refuses a seed
  with any problem, and CI checks it for drift.
- **Administered configuration.** Migration `058_institution_catalogs.sql` adds
  `harness_admin.institution_catalog_revisions` and `institution_catalog_events`, both with
  tenant row-level security. Revisions are append-only; only their status moves. The database
  itself refuses an approver or publisher who is the author, an approved or published revision
  with problems, and a second published revision for one institution. The control API's service
  role may select, insert and update revisions and append events; the audit reader may read both.
- **Lifecycle** (`packages/persistence/src/institution-catalogs.ts`). Saving names the latest
  revision the author started from; a concurrent save is `409 institution.revision_conflict`. A
  new draft supersedes any unpublished revision. Approval needs a DRAFT, someone other than the
  author and no problems against the taxonomy at approval time. Publishing needs an APPROVED
  revision and someone other than the author, and supersedes the published revision in the same
  transaction. Every step appends an event with the actor and reason.
- **Control API** (`apps/control-api/src/product-catalog-routes.ts`): `GET /v1/authoring/products/taxonomy`,
  `GET /v1/authoring/institutions`, `GET /v1/authoring/institutions/:id/catalog` (seed, latest,
  published, revision history, problems as of now and how each legacy product type resolves), and
  `POST …/catalog/revisions`, `…/revisions/:revision/approve` and `…/publish`, guarded by
  `draft.read`, `draft.write`, `draft.approve` and `draft.publish`. The taxonomy and seeds are
  compiled from `domains/products`, which the image already carries.
- **Experience API and mock.** Six operations under `PolicyStudio` relay to the control API. The
  mock holds revisions in session state with the same rules, so the studio works on the mock.
- **Studio.** Policy Studio gains **Business** and **Products** tabs ahead of Rules (Rules stays the
  landing tab). Both share one working copy of the selected institution's catalog, with the
  problems shown in plain language as you edit and the save → approve → publish lifecycle with a
  reason. Business edits the profile, legal entities and business lines; Products lists offerings
  with their canonical path, eligibility and status, adds offerings within a business line's scope
  (eligibility may only narrow the product's), and shows how today's case product types resolve.
- **Tests.** Contract tests for problems, eligibility and resolution; database tests for revision
  conflicts, separation of duties, publishing and tenant isolation; control API route tests; mock
  tests; and a browser journey (author adds a business line and an offering, a second person
  approves and publishes) plus the problems view.
- **Not yet.** Policy scope still uses the flat product ids and cases do not carry
  `canonicalProductId` (phases C and G). Bundles and variant attributes are kept and checked but have
  no editor yet. Adding an institution that has no seed is an API capability without a studio form.

### Phase C as built

- **Pack layers on the taxonomy** (`packages/policy-engine/src/policy-packs.ts`). A product layer's
  `appliesTo.products` may name a legacy id or any taxonomy node. `productLineageOf` gives each
  product its lineage, most specific first: a legacy id, then the node the taxonomy's legacy mapping
  names, then that node's ancestors (`card` → `PAY.CARDS` → `PAY`). `composePolicyLayers` applies,
  per product, every product layer that targets a node of its lineage, most general first, and each
  must tighten what came before (`policy_pack.loosens:<layer>:<field>`). Two layers at the same node
  are ambiguous; a product needs a layer somewhere in its lineage. Products then merge by their
  tightest values as before. Without the legacy mapping a legacy id has no ancestors, so composition
  over legacy ids is exactly what it was.
- **Business lines.** A new `business_line` layer kind sits between the institution and the products.
  It must name `appliesTo.businessLines`; a selection entry may name its `businessLine`, and the
  effective pack's scope records it. Layers may not name scopes that are not theirs
  (`policy_pack.products_misplaced`, `policy_pack.business_lines_misplaced`).
- **Protected values.** Nothing new is needed to protect a regulatory value: every layer below
  tightens only, at every depth. Tests cover a family layer, a class layer and a product layer each
  refusing to loosen what is above, and the UK's mandatory overlays surviving every level.
- **Diligence on the taxonomy** (`diligence/schema.ts`, `evaluate.ts`, `rego.ts`). Matrix columns may
  be taxonomy nodes, and `productAliases` (the taxonomy's legacy mapping, added when the flows are
  generated) gives legacy ids their lineage. A case product takes the most specific column in its
  lineage. A floor key may name a node (`corporate:BRK`), which covers every product beneath it.
  Overlays gain `appliesTo` (products, party types, jurisdictions): outside its scope an overlay
  neither fires nor asks for its inputs. An unresolved party type does not narrow an overlay. The
  Rego interpreter computes the same lineage, column, floors and scope; a second corpus of about
  2,900 cases over node columns, node floors and scoped overlays (three configurations, US and GB)
  holds OPA equal to the reference evaluation, beside the original corpus.
- **Effective policy** (`packages/policy-engine/src/effective-policy.ts`, contract
  `effectivePolicySchema` in `@ehf/contracts/products`). For a jurisdiction, institution, optional
  business line, product and optional party type it returns the inheritance trail (the layers that
  apply, general to specific) and every control: each pack value, and with a diligence block the
  matrix cell, the floors that reach the product and every overlay. A control carries its value,
  status, source layer and target node, basis, full history and, when a lower layer tightened a
  regulatory value, the regulatory value. A control's source is the layer that last changed it,
  since tighten-only sets and maps make lower layers repeat values. Statuses:
  - **PROTECTED**: set by the baseline or a jurisdiction, or a value no layer may change.
  - **INHERITED**: set above the product (institution, business line, an ancestor node).
  - **MODIFIED**: set for the product itself.
  - **CONDITIONAL**: an overlay that applies here. `enforced` says when a pack made it mandatory.
  - **NOT_APPLICABLE**: an overlay outside its scope or switched off, or a product outside the
    matrix, with the `reason`.
  A test holds its values equal to the effective pack for a one-product set.
- **Seeds.** `packs/products/pay.yaml` (`pack.product.family.pay`, at `PAY`) now holds the attorney
  screening that the payments layer held, so cards and merchant acquiring inherit it. The effective
  values are unchanged; provenance and digests moved. `overlay.high-transaction-risk` is scoped to
  `PAY` (still off). The agentic policies carry `productAliases` and were regenerated.
- **Studio.** An overlay's scope shows under it ("Only for products under PAY"). Editing an overlay
  in the builder keeps its scope; the builder does not edit scopes yet (phase D/E).
- **Not yet.** Cases still carry legacy product ids, so node-only columns apply to canonical ids
  only (phase G). Overlay effects beyond escalation and the inspector screen are phases D and E.
  (Done after phase G: a canonical product also takes what applies to the legacy type it falls under.)

### Phase D as built

- **Effects** (`packages/policy-engine/src/diligence/schema.ts`). A rule's (overlay's) `effect` may
  combine:
  - `escalateTo` or `escalateBy` (not both);
  - `addRequirements` (evidence obligations);
  - `requireApproval` (`role`, a platform role such as `Case.Reviewer`; `quorum` 1–5; `reason`).

  Every effect only adds. The schema is strict, so an effect that would lower a level, remove a
  requirement, switch a control off or grant anything cannot be written, and an empty or
  contradictory effect is refused. A rule that does not escalate leaves the level where the floors
  put it.
- **Outputs with provenance.** A decided diligence result now carries:
  - `requirements`: the level's requirements, then those the fired rules add, each once;
  - `requirementSources`: each requirement with its sources (`diligence.level.<LEVEL>` and the rule ids);
  - `approvals`: one per fired rule that requires one, by rule id.

  Both new fields are optional in the contract, so receipts from before this phase stay valid. The
  Rego interpreter computes the same; a corpus of rules with every effect holds OPA equal to the
  reference evaluation.
- **Approvals enforced at disposition** (`diligence/approvals.ts`). When any rule requires an
  approval, the compiler names the authored result `authored_result` and routes the approval gate
  (`approvalGateId`, default `disposition`, which must exist) through a fixed guard:
  - no diligence outcome known: a decided result becomes UNRESOLVED (`DILIGENCE_DECISION_MISSING`);
  - nothing pending: the authored result stands;
  - approvals pending and an automatic decision: NEEDS_HUMAN for the approval roles at the highest
    quorum, with the authored actions as what APPROVE would allow. Once that review reaches its
    quorum, APPROVE lets the authored decision stand with exactly those actions; REJECT decides
    with no action;
  - a decision that already records a person's intent stands only if that review covered every
    approval role and the quorum;
  - an authored NEEDS_HUMAN gains the approval roles and quorum.

  An approval therefore never grants: it adds no action and only lets an authored decision through.
  Roles combine as one review (any of the roles, the highest quorum). The reference implementation
  and OPA agree on a corpus of 160 combinations of authored result, approvals and review, which also
  asserts the never-grant properties directly. Rule ids may not collide with authored rule ids.
- **Case API.** At the approval gate it supplies `facts.diligence`: the level and approvals of the
  case's latest diligence decision under the same policy set and release
  (`getLatestDiligenceOutcome`; an undecided latest decision counts as unknown). An integration
  test on real OPA and PostgreSQL covers the whole path:
  1. a disposition before any diligence decision stops;
  2. after one, an installation that would approve automatically asks two reviewers instead;
  3. once both approve, the case is approved with the reviewed actions.
- **Effective policy.** An overlay control's evidence is the requirements it adds; its value shows
  the approval.
- **Builder.** The overlay sheet edits every effect (level, added requirements, approval role, number
  and reason) and the scope (products or taxonomy nodes, party types, jurisdictions). It shows the
  rule as one sentence ("When …, for products under PAY, raise the level by 1 step, require … and
  require approval by 1 case reviewer (…)"). The overlay list shows each rule's effects. The what-if
  shows the approvals beside the level, and the rationale gives each requirement's sources. The mock
  applies the same guard.
- **Seeds.** The PEP rule requires two case reviewers' approval (candidate, until a senior-management
  role exists), and confirmed adverse media adds `EVD-PUBLIC-SOURCE-RESEARCH`. The agentic policies
  were regenerated; their disposition gates are still installation placeholders (UNRESOLVED), so
  nothing is decided automatically today.
- **Not yet.** Requirements a rule adds are not yet planned as work for skills: the derived
  installation content still follows the level only (phase G). Approvals by several distinct roles
  (each with its own quorum) would need a richer human requirement than one review.

### Phase E as built

- **Browser-safe composition.** Pack layers and their tighten-only composition moved to
  `packages/policy-engine/src/pack-composition.ts`, which has no Node built-ins.
  `policy-packs.ts` re-exports it and keeps digests, effective packs, selection and checkpoints.
  `@ehf/policy-engine/effective` exports the composition and `effectivePolicy`, so the studio and its
  mock compute a product's effective policy exactly as the packs compile.
- **Pack layers served.** `GET /v1/authoring/policies/packs` (control-api, `draft.read`) returns the
  repository's layers (`domains/policy/packs`), with an Experience API operation and a mock handler
  reading the same files.
- **Guided steps.** Above Policy Studio's tabs, Business → Products → Policies → Simulate → Publish.
  Each step opens its tab (Policies opens the new explorer; Simulate runs the what-if; Publish opens
  Approvals) and shows which step the current tab belongs to. The tabs stay as they were.
- **Policy explorer** (`apps/web/src/policies/PolicyExplorer.tsx`, model in `explorer.ts`), a new tab with
  three panes:
  - **Products** (left): the set's products on the taxonomy (`card` sits under
    Payments › Cards), each with "Inherited" or its override count. The count is values set at its
    own node, its own matrix column, and rules scoped to it by name. Beneath each node are the
    institution's offerings mapped there, including unsaved ones from the Products step.
  - **Product rules** (centre): for one product and party type, its base level, the floors that reach
    it, every rule and every pack control, each with its status (Protected, Inherited, Override,
    Conditional, Not applicable). Editors can:
    - set the product's own base level, or give it its own column starting from the one it
      inherits ("Override for Cards");
    - switch rules on or off, and edit them;
    - add a rule scoped to the product, which opens the rule builder with the product filled in.
  - **Inspector** (right): the inheritance trail ("Baseline › Regulatory (US) › Institution ›
    Payments & money movement › Cards") and the selected control:
    - its value, the layer and node that set it, and its basis;
    - the regulatory value it may not loosen past;
    - why it does not apply here, what it requires, the rule as a sentence, and how it got its value.
  - **Simulator**: below the panes, the what-if with the selected product chosen.
  - The side panes stay in view while the centre scrolls.
- **Coverage** (a view of the explorer): controls × products, each cell with its value and status;
  pack rows say when a value differs by product. For rules, each cell is a checkbox that changes
  where the rule applies (bulk scope editing). A rule that reaches a product through a family node is
  changed in its builder instead.
- **Tests.**
  - Model tests on the repository's packs, taxonomy and seeds cover the tree, the trail, override
    counts, column overrides, and a product that cannot be composed.
  - A browser journey: enable a product (a card offering) → see it in the tree → inspect an
    inherited control → add a rule for Cards → see the count and inspector change and the rule not
    apply to deposits → override the base level → simulate (EDD) → switch the rule on for deposits
    in Coverage.
  - The step buttons are named "Step n: …" so they do not collide with the header's Simulate and
    Publish.
- **Not yet.**
  - Pack values are read-only in the studio: packs change through their repository pipeline.
  - Offerings are shown under their node but evaluated through the set's legacy products until
    cases carry canonical ids (phase G).
  - Effective dates, scheduled activation and impact runs are phase F.

### Phase F as built

- **Regression set** (`domains/policy/regression/bank-synthetic.yaml`): 20 synthetic cases for the
  corpus bank, personal and business, in the US and GB, with and without each signal the diligence
  rules read. Signals are PEP (verified or an open signal), countries, ownership interests, adverse
  media, transaction risk and assessed risk. `regressionFacts` maps them onto the selected facts of
  `canonical.onboarding.v2`. Every case is evaluated at the set's fixed as-of time.
- **Impact runner** (`packages/policy-engine/src/impact.ts`, browser-safe, also
  `@ehf/policy-engine/impact`).
  - `runImpact` takes each case through a baseline and a candidate policy, in set order. Each side
    picks its own policy set by scope; a case none covers is NO_POLICY_SET, never forced into one.
    Only cases one side serves are run.
  - For each case it records the outcome (policy set, state, level, requirements, approvals, rules)
    and what changed: policy set, outcome, level raised or lowered, requirements or approvals added
    or removed, rules.
  - The evaluation is injected: the control API (`POST /v1/authoring/policies/impact`,
    `draft.evaluate`) runs the compiled bundles in OPA and returns the report with its digest. The
    mock runs the reference evaluation. Nothing is stored and no case is touched.
  - Tests hold the OPA and reference reports equal and the digest identical across runs (including
    from re-serialised sources), and find exactly the cases a change affects. The endpoint gives the
    same digest twice.
- **Activation** (migration `059_policy_activations.sql`).
  - `harness_control.policy_activations` is append-only history (tenant-scoped; the control API may
    insert and read, the auditor read). Publishing adds a PUBLISH activation, a future date a
    SCHEDULE, a rollback a ROLLBACK. Already-published revisions were backfilled as taking effect
    when published.
  - `harness_control.policy_revision_in_effect` says whether a revision is PUBLISHED with an
    activation that has started. `lock_business_policy_authority` now requires it, so a scheduled
    revision's bundle decides nothing before its date, and a rolled-back one nothing after.
  - SUPERSEDED revisions keep their compiled bundle: the table's check now allows it.
- **Persistence and routes.**
  - `publishPolicyRevision` takes an optional `effectiveFrom` (not in the past) and `reason`.
  - `rollbackPolicyRevision` needs a reason and a PUBLISHED target whose bundle is still approved in
    the registry. It puts the target back in effect now with its exact files, source digest and
    bundle digest, supersedes every later published or scheduled revision, and records the events.
  - `activationState` gives the revision in effect and those scheduled. The revisions route returns
    them with the history; the publish route takes the date; a new rollback route needs
    `draft.publish`.
  - Tests:
    - publishing now;
    - scheduling (not in effect until its time, then in effect);
    - rollback restoring the exact prior digests and superseding the later revision;
    - refusals (no reason, nothing to undo, not published, a past date);
    - the history.
- **Studio** (Approvals, the Publish step).
  - **Impact panel**: compare the working copy with the template or any published revision. It
    shows the summary by change, a table of changed cases (or all of them), and the report digest.
  - **Takes effect** field: publishes now when empty, or schedules on a date.
  - **Activation panel**: what is in effect and since when, what is scheduled, the history, and
    rollback with a reason.
- **What-if.** An **Assessed risk** input (Low, Medium, High) sets `facts.assessedRisk`, a sandbox
  input; in real cases the risk skills report the tier. The rationale now ends with a **trace**:
  - the policy, its version and bundle;
  - the policy set and its digest;
  - the pack pin and every layer;
  - the gate and input profile;
  - the inputs (legal form, products, assessed risk, risk factors);
  - the rules that decided, and the approvals with their roles and reasons.
- **Seed.** `overlay.assessed-high-risk` (HIGH → EDD) is in the design but switched off. It requires
  the tier, which real cases do not yet carry (phase G), so it is simulated through the what-if.
- **Tests.** Browser journeys cover:
  - a matrix change simulated on the regression set ("US trust using payments", level lowered);
  - publish, then schedule a second revision for next year, then roll back (the history shows each
    step and nothing stays scheduled);
  - the what-if with an assessed risk and its trace.
- **Not yet.**
  - Activation is per policy workspace. Releases still choose which plan and bundles run.
  - Impact covers the diligence gate, the one gate the agentic policies decide today.

### Phase G as built

- **Case records** (decision 2, additive). `BankingRelationship.products[]` gains optional
  `canonicalProductId` and `offeringId` beside `productType`, which stays and is now optional; a
  product names at least one. `productRoles` (optional) gives a party's role in a product:
  CUSTOMER, UNDERLYING_INVESTOR, COUNTERPARTY, INTERMEDIARY or AUTHORIZED_USER
  (`partyProductRelationshipSchema`). The library-contracts descriptors were regenerated.
- **Product resolver** (`resolveRelationshipProducts`, `packages/contracts/src/products.ts`).
  1. A legacy `productType` keeps today's scope id; its canonical product comes from the taxonomy.
  2. Otherwise a `canonicalProductId` is used as given.
  3. Otherwise an `offeringId` resolves through the institution's published catalog.

  Only the customer's own products (CUSTOMER, or no role recorded) enter the customer's scope. An
  underlying investor's product is resolved and kept beside the scope, not in it.
  `casePolicyContextFromRelationship` reads products through the resolver, so bank cases read
  exactly as before.
- **Case API.** It resolves before building a decision's scope:
  - It reads the published catalog through `harness_runtime.published_institution_catalog`
    (migration 060, a definer function granted to the case execution role), since the case
    service cannot read control tables.
  - It loads the taxonomy from `domains/products`; `productSourceRoot` moved into the policy
    engine for this.
  - A product that does not resolve stops the gate with `policy.product_unresolved:<ids>`; it is
    never defaulted.
- **Sets on taxonomy nodes.** A policy set, an effective pack or a regression case may name a
  taxonomy node (`BRK`): `productCovered` accepts a product beneath it. The decision authority
  check, pack selection and impact set selection use it. `projectDiligenceDesign` keeps columns
  beneath a served node, so a set serving `BRK` keeps `BRK.PRIME`.
- **Securities.** `domains/policy/diligence/securities-synthetic.yaml` is the synthetic firm's design,
  with columns on taxonomy nodes and its rules:
  - PEP, requiring approval;
  - high-risk geography;
  - complex ownership, for companies, partnerships and trusts;
  - leveraged trading risk, for prime brokerage and financing.

  Case API integration tests on real OPA and PostgreSQL:
  - A fund's case with a prime brokerage offering, an institutional custody product and an
    underlying-investor position resolves through the published catalog. Its scope is
    `BRK.PRIME.INSTITUTIONAL` and `CUS.SAFEKEEPING.INSTITUTIONAL_CUSTODY`, and the gate decides
    from the `BRK.PRIME` and `CUS` columns.
  - An unknown offering stops the gate, and so does an offering with no published catalog.
- **Requirement-driven planning.** The diligence readers (`decision.requirements.compile`,
  `edd.trigger.evaluate`) are bound `facts.diligence_requirements` (the decision's resolved
  requirements, level and rules) as well as the level. The derived content plans from that list:
  - each requirement applies when the list `contains` it;
  - rules that add obligations get their own EDD triggers (`diligence-rule-adverse-media`).

  The library's predicate language already has `contains` and `any`. The compiled-plan tests check
  both the binding and that every requirement in each plan keys off the list.
- **Library change request:** [product-policy-library-change-request.md](product-policy-library-change-request.md)
  asks for `canonical_product_id`, `offering_id`, a `PartyProductRelationship` type, lineage-based
  product branching and, optionally, the risk tier as `facts.assessedRisk`. Until it lands,
  securities and insurance products are policy-only (decision 7).
- **Not yet** (all four finished below).

### Phase G follow-ups as built

The four items phase G left open.

- **Taxonomy products in the bank's flows.** A legacy type is its taxonomy node, and a node is
  preceded by the legacy types that map to it (`aliasLineage`, `packages/contracts/src/products.ts`).
  `PAY.CARDS.DEBIT` reads PAY.CARDS.DEBIT, card, PAY.CARDS, payments, PAY, so a debit card offering
  takes everything set for `card`:
  - the card column and floors in the diligence reference and Rego (`diligence_lineage`);
  - the card pack layer in pack composition (packs regenerated; only the layer order changed);
  - the bank's sets in the authority check and pack selection (`productCovered` with the aliases).

  A case API integration test decides a bank case with a `debit-card` offering through the
  published catalog under the card column.
- **A securities flow.** `domains/securities-agentic` (`node --import tsx scripts/sync-agentic-flows.ts`,
  `make compile`) runs the roster's agents over the firm's own pack:
  - the institution layer `pack.institution.securities-synthetic`;
  - product family layers on BRK (attorneys screened), CUS and WLT (adverse media);
  - selection entry `policy.pack.us.securities-synthetic.institutional-securities`, serving BRK,
    CUS and WLT for corporate clients in the US;
  - the firm's diligence design, with its own diligence gate.

  The Policy Studio offers it as "Securities onboarding" (control API, Experience API enum, mock).
  Compiled-plan tests and a browser journey cover it.
- **Screening scope follows the decision.** The diligence block maps screening types to the
  obligations that require them (`screening`); the decision lists `screeningTypes` its resolved
  requirements imply (reference and Rego, held equal on a corpus).
  - Every gate after the diligence gate now reads the case's latest diligence decision as
    `facts.diligence`: level, requirements, screening types and approvals. Before a decision exists
    the fact is absent, never empty. An installation's decision-ready rules can require
    `/facts/diligence/screeningTypes`.
  - Pack checkpoints (`evaluatePackGate`) add the decision's screening types to the pack's own.
- **Assessed risk in the flows.** At the diligence gate the case API reads the risk tier recorded on
  the relationship (`BankingRelationship.riskTier`) as `facts.assessedRisk` when it is LOW, MEDIUM or
  HIGH. UNKNOWN or absent stays absent, so a rule that needs it stops for a person. Writing the
  risk skills' own tier back to the relationship needs a platform command; until then the record's
  tier is the source (change request PT-4).
- **Requirements by party role.** The diligence block lists obligations per role
  (`roleRequirements`: UNDERLYING_INVESTOR, COUNTERPARTY, INTERMEDIARY, AUTHORIZED_USER).
  - The case API puts the products the customer holds in another role in the scope
    (`scope.relatedProducts`); one that does not resolve stops the gate.
  - The decision adds each listed role's obligations, attributed `diligence.role.<ROLE>`.
  - A role the block does not list leaves the decision unresolved (`DILIGENCE_ROLE_REQUIREMENTS_MISSING`).
  - The derived requirements content includes role obligations, so the skills plan them.

  The securities firm lists all four roles. The bank lists only authorised users, so a bank case
  naming a counterparty stops for a person.
- **With main's flow composer and due-diligence variants.** Flow composition moved into
  `@ehf/flow-composer`, and main added SDD, CDD and EDD as process variants with SYNTHETIC placeholder
  content and checkpoint rules. The two fit together like this:
  - Every composed flow whose institution has a diligence design (`loadDiligenceInputs`) gets the
    `diligence-level` gate before the risk agent, and its readers are bound the decision's level and
    requirements.
  - The derivable fields (`edd_triggers`, `requirements`) are `DERIVED` with the SYNTHETIC
    placeholder as their `base`. When the policy compiles, the placeholders are kept and the design's
    entries are added (`combineDiligenceContent`). A requirement both name applies when either says
    so, and requirements only a rule or role adds apply when the decision lists them. So a derived EDD
    level fires an EDD trigger, and main's escalation moves the case to the enhanced process.
  - The disposition gate's approval guard needs the case's diligence decision, which the case API
    supplies to every gate after diligence.
  - The securities flow is a process scope (`institution: securities.synthetic`, products on
    taxonomy nodes). Scopes accept taxonomy nodes, and another institution's flows are named after it.
- **Still open** after phase G: the seven items phase H finished (below).

### Phase H as built

The open items of earlier phases, each its own commit.

- **Offerings evaluated as themselves.** Each offering in the explorer's product tree is selectable
  when the policy set serves it, and the explorer evaluates its canonical product. A debit card
  offering is `PAY.CARDS.DEBIT`, which takes what applies to `card` through the alias lineage. This
  covers the rules, the inspector and the what-if. An offering the set does not serve is shown as such.
- **A new institution from the studio.** The Business step's New institution form creates a working
  copy with the profile, jurisdictions, first legal entity and first business line, checked against
  the catalog contract. It is saved as revision 1 and a second person approves and publishes it.
- **Bundle and variant attribute editors.** Each offering's details sheet sets its variant
  attributes and its bundle (the other offerings sold or serviced with it).
  - Only the taxonomy's offering-level attributes can be set, each with an input of its type.
  - The catalog's own checks run as the change is made.
- **Impact at any gate.** The impact runner takes a gate.
  - At a gate after the diligence gate, each side first decides the case's diligence under its own
    policy, and the gate reads it as `facts.diligence`.
  - Regression cases carry the checkpoint evidence: relationship, screenings, verification, agent
    task outcomes and risk factors. Each case is clean by default, with a signal for each part.
  - Outcomes say what the gate would do (approve, decline, ask people).
  - The reference gate evaluation moved into the policy engine (`gate-reference.ts`), and OPA agrees
    with it at every gate.
- **Approvals by several roles.** A human requirement may carry `roleQuorums`.
  - Each listed role needs that many distinct people holding it; one person fills one slot.
  - The approval guard (reference and Rego) keeps each role's quorum.
  - The case store reports per choice whether the votes meet it (`humanReview.satisfied`), by matching
    voters to role slots.
  - The studio and the reviewer's decision sheet say who must decide, in words.
- **Release-level activation** (migration 061). Releases have an append-only activation history.
  - A release is in effect when it is active, its activation has started, and it is the most recent
    start among its line's active releases. A line is the environment plus the plan's process.
  - The business-policy authority, the runtime's executable-release check and case plan selection
    honour only the release in effect.
  - Activation may be scheduled. Rollback puts an earlier release back in effect now and deprecates
    the line's other active releases.
- **Pack layers edited in the studio** (migration 062). A layer is edited as revisions: a draft, a
  second person's approval, then publication.
  - The edit is checked by composing every selected pack with it (`packCompositionProblems`), in the
    studio as values change and on the server at save and approval.
  - A published revision replaces the repository's layer for the tenant: in the explorer and
    effective policy, and in processes composed for the tenant (`withPublishedLayers`).
  - The repository's layers stay the starting point and keep their drift-checked pipeline.

## 8. Decisions

Accepted 2026-11-11, as recommended:

1. **Product ids** are dotted canonical codes whose ancestors are their prefixes
   (`BRK.PRIME.INSTITUTIONAL` is under `BRK.PRIME` and `BRK`).
2. **Case records** gain optional `canonicalProductId` and `offeringId` beside `productType`, which
   stays. The change is additive; existing cases and the corpus remain valid.
3. **Seed depth:** all 18 domains at family level, with Banking and Securities to type level in the
   first release. Other domains deepen later.
4. **Institution catalogs** (business profile, business lines, offerings) are administered
   configuration in control-api, with revisions, separation of duties and history. The repository
   holds seeds only.
5. **Assessed risk** is an input fact in sandbox simulations. In real cases the policy reads the
   risk skills' tier.
6. **Approvals** are carried by the diligence decision (`outputs.diligence.approvals`) and enforced
   at disposition as a human requirement. There is no separate approval gate per product.
7. **Securities and insurance in the Python library:** a library change request is raised now for
   the `Product` record's product types, so the case records and skills can carry them. Until it
   lands, those products are policy-only (taxonomy, studio and diligence gate).
