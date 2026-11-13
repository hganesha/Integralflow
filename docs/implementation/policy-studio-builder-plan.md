# Policy Studio builder: plan

Status: phases 1–4 implemented 2026-11-11. The section 7 recommendations were
accepted: a party taxonomy mapped onto the two customer types, one level per matrix cell, one
matrix per policy with jurisdiction floors, and SDD off until a policy owner resolves it.

The Policy Studio (PLT-04, `apps/web/src/platform/surfaces/policy-studio.tsx`) exposes the policy
engine as an engineer's tool: a policy is a set of YAML files, edited in a text area, compiled to
OPA, and moved through four lifecycle buttons. A policy owner cannot answer the question they
actually own, "which customers get SDD, CDD or EDD, and why", without reading predicates and
JSON pointers.

The target is a business-shaped builder in the spirit of the reference mock (not its visual style):
building blocks on the left, a **party type × product decision matrix** of base diligence levels in
the middle, **risk overlays** that can only escalate on the right, and a **what-if** strip at the
bottom that runs the real engine. YAML, Rego and digests stay available but move behind an
Advanced tab.

The engine's guarantees do not change: the server compiles and evaluates, bundles are
digest-pinned OPA, approval needs a different person, and nothing defaults when an input is
missing.

## 1. What exists today

| Concern | Where it lives | What the user sees |
| --- | --- | --- |
| Installation policy (current) | `domains/{kyc,kyb}-agentic/policy.yaml`, `harness.factory/business-policy-v2`, compiled by `packages/policy-engine/src/business-policy.ts` | YAML text area. `policySets` (jurisdiction × institution × product set × customer type), `configuration` (pack values plus 20 installation content fields, most `UNRESOLVED`) and three gates (`intake-ready`, `decision-ready`, `disposition`) whose rules are first-match predicates over JSON pointers |
| Layered packs | `domains/policy/packs` (baseline → US/GB → institution → product layers), `policy-packs.ts` | Not visible in the studio. Layers may only tighten |
| Archived decision tables | `domains/kyc/policy/catalog`, `decision-table/*` | Composer tab: YAML. Tree viewer: one row per branch |
| Diligence level | Not a policy concept. Risk tier comes from `risk_tiers` and `risk_factor_maps`; EDD from `edd_triggers` (both unresolved content fields), read by the `risk_edd.py` skills; the Risk and EDD agent proposes EDD scope | Nowhere |
| Simulation | `BusinessSampleRunner`: set, gate, timestamp and a raw JSON facts box | A JSON result |
| Lifecycle | Revision save → compile → approve → publish (`postAuthoringPolicies…`), with separation of duties | Template select, revision select, four stage cards, seven tabs |

The seven tabs today are Composer, Tree viewer, Test corpus, Library, Activity, Compiled bundle
and Jurisdiction sources. Three of them (Composer, Library, Test corpus) are the same file
browser and text area with different filters.

## 2. Mapping the mock onto the engine

| Mock element | Engine concept | Fit |
| --- | --- | --- |
| Products | Pack product layers (`card`, `deposit`, `lending`, `merchant_acquiring`, `payments`) and `scope.products` | Direct. Wealth/private banking would be a new product layer |
| Party types | `scope.customerTypes` is only `individual` \| `corporate`, derived from `legalForm` in `casePolicyContextFromRelationship` | **Gap.** The matrix needs a finer taxonomy (private company, listed company, trust, nonprofit…) that maps onto the two customer types used for pack selection |
| Risk factors | Facts in the `canonical.onboarding.v2` input profile: open findings (`PEP_SIGNAL`, `ADVERSE_MEDIA`, sanctions), `risk.jurisdictionRisk`, ownership complexity, `risk_factor_maps` | Good. Each factor is a named, typed reference to an input-profile selector |
| Diligence levels | None | **New.** An ordered list `SDD < CDD < EDD`, with SDD permitted only where the pack allows it |
| Diligence requirements | `requirements`, `required_document_types`, evidence obligations | Good. Requirements are keyed by level, so the level selects the obligations |
| Decision matrix | Nothing direct. The closest are the decision tables (conditions → tokens → first-match rows) | **New source block** (section 3) |
| Business rules | Gate rules (`gates.*.rules`, predicate → result) | Direct. Needs a plain-language renderer instead of YAML |
| Decision flow | `PolicyTree` / `PolicyGraph` | Direct. Reused unchanged |
| Risk overlays (toggles) | `edd_triggers` (predicate + tasks), pack `pep_scope` | Good, with one rule added: an overlay can only escalate. This is the same monotonic rule the packs already enforce |
| What-if | `postAuthoringPoliciesEvaluate` behind `BusinessSampleRunner` | Good. Replace the JSON box with pickers that build the facts |
| View rationale | `ruleIds`, `reasonCodes` on the decision receipt | Partial. First-match returns one rule; a rationale needs every contributor (section 3.3) |
| Draft status, Simulate, Publish | Revision status and save/compile/approve/publish | Direct. Collapse the four stage cards into one status chip and one next-step button |
| Tabs: Rules, Requirements, Approvals, Monitoring, Versions | Gates, content fields, release blockers and approval, policy evaluation receipts, revisions | Monitoring needs a read model over stored decisions (phase 4) |

## 3. Engine change: a diligence block

### 3.1 Source

Add an optional `diligence` block to `BusinessPolicy`. It is part of the same revision, digest and
approval as the rest of `policy.yaml`. It is not a separate file and has no separate lifecycle.
The example below is illustrative: legal forms and fact paths would come from the canonical
records and the `canonical.onboarding.v2` selectors, and the obligation IDs are the existing ones
in `domains/kyc/policy/catalog/evidence-obligations.yaml`.

```yaml
diligence:
  levels: [SDD, CDD, EDD]                  # ordered, lowest first
  partyTypes:
    - id: corporation_private
      label: Corporation (private)
      customerType: corporate              # used for pack selection
      legalForms: [private_limited_company, llc]
    - id: trust
      label: Trust / complex entity
      customerType: corporate
      legalForms: [trust, foundation]
  products: [deposit, lending, payments]   # must be product layers
  matrix:                                  # party type × product → base level
    corporation_private: { deposit: CDD, lending: CDD, payments: CDD }
    trust:               { deposit: CDD, lending: CDD, payments: EDD }
  overlays:
    - id: overlay.pep
      label: Politically exposed person
      enabled: true
      requires: [/facts/selected/policyRecordFinding]     # absent input → unresolved
      when: { some: { path: /facts/selected/policyRecordFinding, where: { path: /findingType, op: eq, value: PEP_SIGNAL } } }
      effect: { escalateTo: EDD }
    - id: overlay.high-risk-geography
      label: High-risk geography
      enabled: true
      requires: [/facts/selected/risk/jurisdictionRisk]
      when: { path: /facts/selected/risk/jurisdictionRisk, op: eq, value: HIGH }
      effect: { escalateBy: 1 }
  requirements:                            # level → obligations
    SDD: [EVD-CIP-IDENTITY-DOCUMENT, EVD-SANCTIONS-SCREENING]
    CDD: [EVD-CIP-IDENTITY-DOCUMENT, EVD-CIP-ADDRESS, EVD-SANCTIONS-SCREENING, EVD-BENEFICIAL-OWNERSHIP, EVD-RELATIONSHIP-PURPOSE]
    EDD: [EVD-CIP-IDENTITY-DOCUMENT, EVD-CIP-ADDRESS, EVD-SANCTIONS-SCREENING, EVD-BENEFICIAL-OWNERSHIP, EVD-RELATIONSHIP-PURPOSE, EVD-SOURCE-OF-FUNDS, EVD-EDD-NARRATIVE]
```

`when` reuses the existing `PolicyPredicate` grammar, so overlays need no new predicate language.

### 3.2 Semantics, checked at compile time

- **Cells hold one level.** The mock's "CDD / EDD" cells are a base of CDD with overlays that are
  likely to fire. The builder shows that as a hint on the cell; the source holds one value. A
  deterministic engine cannot hold two levels in one cell.
- **Overlays only escalate.** The level is `max(base, every overlay that fired)`. No overlay can
  lower a level, and `escalateBy` stops at the highest level.
- **Several products take the tightest level**, the same rule the product layers already follow.
- **Missing input fails closed.** An unmapped legal form, a product missing from the matrix or an
  overlay whose `requires` input is absent gives `UNRESOLVED` with a gap. The level never falls
  back to the base. The `requires` list exists because today's predicates treat a missing value as
  false, which for an overlay would read as "not a PEP".
- **Packs can set floors.** New pack fields (`diligence_floors`, `mandatory_overlays`) let a
  jurisdiction layer lock a cell's minimum or force an overlay on; for example, the UK layer can
  require PEP → EDD. Composition uses the existing tightening rules (`min` on floors, `superset`
  on mandatory overlays). In the builder, a locked overlay shows its legal basis and cannot be
  switched off.
- **SDD needs a pack permission.** A `simplified_due_diligence_permitted` field that layers may
  only switch off. A matrix cell set to SDD where the effective pack forbids SDD refuses to compile.
- **Every requirement must exist in the catalog**, and a higher level's requirements must contain
  the lower level's (`superset`).

### 3.3 Compilation and output

Do not lower the matrix into first-match gate rules. One rule per cell × overlay combination would
produce a large diff of generated predicates that nobody reviews, and first-match reports only one
contributor. Instead, follow the decision-table precedent in the package README: a small, pinned
Rego interpreter (`harness/business/diligence.rego`) plus the block as data. A policy change is
then a diff of cells and toggles.

The interpreter backs a generated gate, `diligence-level`, which returns:

- `state: DECIDED` with a new optional typed field on the result,
  `outputs: { diligenceLevel: "EDD", baseLevel: "CDD", requirements: [...] }`. This is the one
  contract change, in `packages/contracts/src/business-decisions.ts`.
- `ruleIds` lists **every** contributor (`diligence.cell.trust.payments`, `overlay.pep`, …), which
  is the rationale the UI shows.
- `UNRESOLVED` with gaps when an input is missing (section 3.2).

The same compile step projects the overlays into the existing `edd_triggers` content field and
the level requirements into `requirements`. The `edd.trigger.evaluate` skill and the Risk and EDD
agent keep their contracts, and the builder is the only place these values are authored.

## 4. Studio redesign

```
┌ KYC policy: customer due diligence  [v2.0.0 · Draft ▾]      [Simulate] [Next step ▸] ┐
│ Policy builder | Rules (n) | Requirements | Approvals | Versions | Advanced            │
├────────────────┬───────────────────────────────────┬───────────────────────────────────┤
│ Building blocks│ Matrix | Business rules | Flow     │ Risk overlays                     │
│ Products    6 ›│      Deposit Lending Payments …   │ PEP → EDD         [●] UK: locked  │
│ Party types 5 ›│ Ind.   CDD    CDD     CDD ↑       │ High-risk geo +1  [●]             │
│ Risk factors ›│ Trust  CDD    CDD     EDD         │ Complex ownership [●]             │
│ Levels       ›│ …                                 │ + Add overlay                     │
│ Requirements ›│ ↑ = overlays are likely to escalate│                                   │
├────────────────┴───────────────────────────────────┴───────────────────────────────────┤
│ What-if: [Party type ▾] [Product ▾] [Risk factors ×] → EDD   View rationale            │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

- **Header.** The policy picker replaces the template select. A scope chip
  (`US · Synthetic Bank · Personal banking`) replaces the raw policy-set ids. The status chip shows
  the revision status, and one **Next step** button walks save → compile → request approval →
  publish. When the next step is not allowed, the button is disabled and gives the reason, using
  the same separation-of-duties checks as today (`approveReason`, `publishReason`). Approval itself
  happens on the Approvals tab, by a different person.
- **Policy builder.** The three columns plus the what-if strip. Building-block cards open side
  sheets with structured lists; there is no YAML here. Matrix cells are selects limited to the
  levels the pack permits, and locked floors show a lock and their basis. "Add overlay" opens a
  structured condition builder (risk factor, operator, value) that writes a `PolicyPredicate`.
- **Matrix | Business rules | Flow.** Business rules renders `gates.*.rules` as sentences ("When
  an open sanctions finding is confirmed → needs a person: Sanctions reviewer"). Flow is the
  existing `PolicyTree` and `PolicyGraph`.
- **What-if.** Pickers build `facts` for the generated gate and call the existing evaluate
  endpoint. The result shows the level, the base cell, the overlays that fired and the
  requirements. The JSON sample runner moves to Advanced.
- **Rules (n).** The three onboarding gates, as readable rule lists with a structured editor.
- **Requirements.** Obligations per level, plus the unresolved installation content fields as a
  checklist with owners. Today those fields only appear as compile blockers.
- **Approvals.** Release blockers, approvers, separation of duties, approve and publish.
- **Versions.** Today's Activity tab, plus a diff between two revisions rendered as matrix and
  toggle changes rather than YAML.
- **Advanced.** Today's Library (YAML), Compiled bundle, Test corpus, JSON runner and Jurisdiction
  sources. Nothing is removed; it is moved out of the policy owner's path.
- **Monitoring** (phase 4). Distribution of levels per cell, overlay hit rates and human overrides,
  read from stored business decisions (`case-store` `business_decisions`, migration 019).

Editing round-trips through `yaml`'s `Document` API, so comments and ordering in `policy.yaml`
survive edits made in the builder. The UI never evaluates. As `tree-model.ts` already says, matching
and compilation stay on the server.

## 5. Phases

| Phase | Scope | Main files | Engine change |
| --- | --- | --- | --- |
| **1. Simplify the shell** | Header with status chip and Next step; tabs consolidated to Rules / Approvals / Versions / Advanced; Business rules renderer over the existing gates; what-if pickers over the existing gates | `policy-studio.tsx` (split into `policy-studio/` per tab), `authoring/policy.ts`, new `policies/rule-sentences.ts`, `ui-mock` handlers | None |
| **2. Diligence engine** | `diligence` schema and checks; interpreter Rego; `diligence-level` gate; `outputs` on the result; projection into `edd_triggers` and `requirements`; pack floors, mandatory overlays and SDD permission; golden corpus per cell × overlay | `policy-engine/src/diligence/{schema,compile,evaluate}.ts`, `rego/harness/business/diligence.rego`, `contracts/src/business-decisions.ts`, `policy-packs.ts`, `domains/policy/packs/*`, `domains/{kyc,kyb}-agentic/policy.yaml` | Additive |
| **3. Builder UI** | Building-block sheets, matrix editor, overlay toggles and condition builder, rationale drawer, Requirements tab, matrix diff in Versions | `apps/web/src/policies/builder/*`, `ui-contracts` (typed `outputs`), `ui-mock` | None |
| **4. Consumers and monitoring** | `diligence-level` node before risk/EDD in both agentic workflows; skills read the level; Monitoring tab and its read endpoint | `domains/*-agentic/workflow.yaml`, `scripts/sync-agentic-flows.ts`, `case-api`, `experience-bff` | Additive |

Phase 1 ships alone and removes most of the perceived complexity without touching the engine.

### Phase 1 as built

- **Header.** The policy name and version, the revision status and one next-step button
  (`nextStep` in `apps/web/src/policies/rulebook.ts`): Save revision → Compile revision → Approve
  revision → Publish. When a step is unavailable, the button is disabled and its reason is shown
  and linked as the button's description. Simulate opens the what-if.
- **Context bar.** Policy (KYC onboarding, KYB onboarding, archived KYC decision tables) and,
  for an installation policy, its policy set (jurisdiction · customer type · products), held in
  the URL (`set=`).
- **Rules.** Every gate (or archived decision table) as numbered "when … then …" rules with
  reason codes and the default result (`RuleList`), or the existing tree as Flow. The
  what-if underneath picks gate, party type, products and the case facts the gate's rules
  read (`gateFactInputs`). It compiles the candidate on first use and shows the outcome, the
  rule that matched, reasons, gaps, the person needed and the receipt.
- **Requirements.** For the selected set: the installation content fields resolved or waiting,
  with owner and basis, and the pack settings in words.
- **Approvals.** Release checks (compile candidate, production eligibility, blockers) and the
  four lifecycle steps, unchanged in behaviour.
- **Versions.** The working-copy picker and revision activity.
- **Advanced.** Source files, test corpus (corpus runner or JSON sample), compiled bundle and
  jurisdiction sources. The old `?tab=` links (`library`, `tree`, `tests`, `bundle`, `sources`,
  `activity`, `composer`) resolve to their new place (`resolveStudioTab`).
- **Mock.** `getAuthoringPolicies` honours `template` like the control API and serves the agentic
  `policy.yaml` files; compile and evaluate return business-v2 bundles, policy sets and decisions
  for them (`packages/ui-mock/src/handlers/business-policy.ts`). The mock's evaluation handles
  equality, membership and presence only; http mode evaluates with OPA.

### Phase 2 as built

Where this differs from sections 3.1–3.3, this section is what the code does.

- **Source.** The institution's design lives in `domains/policy/diligence/bank-synthetic.yaml`
  (`harness.factory/diligence-design-v1`, CANDIDATE). `scripts/sync-agentic-flows.ts` copies into
  each agentic `policy.yaml` the party types and products that flow's policy sets serve, as the
  optional `diligence` block of `harness.factory/business-policy-v2`. Schema, checks and design
  projection: `packages/policy-engine/src/diligence/schema.ts`.
- **Party types.** Eight, mapped from the canonical `legalForm` vocabulary: individual, sole
  proprietor, company (corporation, LLC), partnership, trust or foundation, nonprofit or charity,
  fund or pension, government. Legal form `unknown`, or any unmapped form, leaves the level
  unresolved. The canonical records do not distinguish listed from private companies, so the mock's
  "public listed" row needs a listing attribute first.
- **Legal form and products** come from the verified scope, not from facts: `casePolicyContextFromRelationship`
  now also returns `legalForm`, the case API passes it as `basis.scope.legalForm` (optional in the
  contract), and every OPA input now carries `scope`. `businessPolicyInput` builds that input; the
  case API uses it so the stored input still matches the receipt digest.
- **Pack controls** (`packages/policy-engine/src/policy-packs.ts`): `diligence_floors`, keyed by
  `<customer type or *>:<product or *>` (packs do not know an institution's party types), may only
  rise (`perKeyLevelMax`); `mandatory_overlays` may only grow (`superset`);
  `simplified_due_diligence_permitted` may only be withdrawn (`falseWins`). The baseline permits SDD
  and sets no floors or mandatory overlays; the UK layer makes PEP and high-risk-geography overlays
  mandatory (MLR 2017 regs 35 and 33(1)(b)); the institution withdraws SDD until its owner decides.
- **SDD is applied, not refused.** A cell at the simplified level in a set that does not permit it is
  raised one level at evaluation and listed as a `permission` contributor, so one matrix can serve
  sets with different permissions. Compilation refuses a set that leaves the permission unset.
- **Compile-time refusals**: every party type × product cell, unambiguous legal forms, known levels,
  cumulative requirements, overlay ids outside `diligence.*`, valid overlay conditions, no clash with
  an authored gate id, no `outputs` on authored results, and coverage of every product, customer type
  and mandatory overlay a policy set needs.
- **Evaluation.** A fixed Rego interpreter (`diligence/rego.ts`) reads the block as data; only each
  overlay's condition is generated, by the same predicate emitter the gates use. The gate
  (`diligence-level`, outcomes `DECIDED` or `UNRESOLVED`) returns `outputs.diligence` (level, base
  level, party type, products, requirements, contributors) and lists every contributor in `ruleIds`.
  `diligence/evaluate.ts` is the independent reference; a corpus of more than 200 cases holds OPA and
  the reference equal, and the Policy Studio mock evaluates with the reference.
- **Studio.** The Rules tab shows the matrix (with SDD cells marked "applied as CDD" where the set
  withholds SDD) and the overlays (On, Off, Required by pack). The what-if defaults to the diligence
  gate: party type, products and risk-factor chips, whose facts are derived from each overlay's
  condition (`predicateWitness`). The Requirements tab lists obligations by level. Editing all of this
  is phase 3.
- **Not yet wired.** No workflow node evaluates `diligence-level` yet, and no skill reads the level
  (phase 4). `edd_triggers` and `requirements` are not projected from the block yet: their library
  formats differ from the policy predicates, so the projection belongs with phase 4's skill wiring.

### Phase 3 as built

- **Builder.** For anyone holding `draft.write`, the Rules tab's diligence section becomes the
  three-column builder: building blocks (products, party types, risk overlays, levels,
  requirements), the matrix with a level select in every cell, and the overlays with a switch each.
  An overlay a pack makes mandatory shows its switch on and locked. Readers without
  `draft.write` see the same view read only.
- **Edits are source edits.** Every change rewrites the working copy's `policy.yaml` through the
  YAML document API (`apps/web/src/policies/edit.ts`), so comments, key order and everything
  outside the `diligence` block survive. The working copy then saves, compiles, is approved and is
  published as before; nothing is applied until then.
- **Sheets.** Overlays: name, id, status, effect and a condition builder for the two shapes in
  use, "a record in a list matches" and "a list has at least N records". A hand-written condition,
  like the PEP overlay's either/or, keeps its condition and can still be renamed, switched or
  re-pointed at another level. Party types: name, customer type and canonical legal forms; a new
  party type starts every product at CDD. Requirements: what each level adds, stored cumulatively.
- **Problems while editing.** The engine's own schema and coverage checks
  (`@ehf/policy-engine/diligence`) run on every edit and are listed in words above the builder,
  for example "A legal form belongs to more than one party type". The server still refuses the
  same things when it compiles, and so does the mock.
- **What-if and rationale.** The what-if compiles the edited working copy before it runs, and says
  so when the copy does not compile. "View rationale" explains every contributor, the evidence
  the level requires, and the bundle and receipt it came from.
- **Versions.** Compare any two of the template, the saved revisions and the working copy. Changes
  read as "Company × deposit: CDD → EDD", "Confirmed adverse media switched on" or "Added
  Cash-intensive business", with one line for any change outside the diligence design.
- **Not in phase 3.** Products and levels stay read only: products come from the pack layers, and
  the level order is the packs' floor vocabulary. The design file in `domains/policy/diligence`
  is still the source the generator uses; studio edits live in the workspace's revisions.

### Phase 4 as built

- **Diligence gate in both flows.** `scripts/sync-agentic-flows.ts` inserts a `diligence-level` gate
  node after the investigation agent's review and before the risk agent's first skill, in the KYC
  and KYB agentic flows. It reads the same selectors as the pack checkpoints, continues on
  `DECIDED` and stops for a person otherwise. A case API integration test runs it from the compiled
  plans through OPA into the case store.
- **Skills read the level.** `edd.trigger.evaluate` and `decision.requirements.compile` bind
  `facts.diligence_level` to `diligence-level.result.outputs.diligence.level`. A gate that did not
  decide leaves the binding unresolved, so the skill reports missing input instead of assuming a
  lower level. Their policy content is now derived from the same block: an installation content
  field may be `DERIVED` (`from: diligence`), and compilation writes its value into the compiled
  policy set (`packages/policy-engine/src/diligence/derive.ts`). `edd_triggers` gets one trigger per
  level above CDD, whose tasks are that level's extra obligations; `requirements` lists each
  obligation with the levels that require it. Both are validated against the library's contract,
  and an edit in the builder reaches the skills on the next compile. The risk agent's instruction
  says the trigger sees the level.
- **Authoring policy gates.** In the Process Studio, a policy gate's Gate ID is chosen from the
  bound business policy's gates, including its diligence gate. The control API completes the gate
  (`apps/control-api/src/authoring-gates.ts`): `business-v2`, the policy's input profile, the
  relationship selector, the policy sets' digests and the selectors of the process's other policy
  gates. It continues on `DECIDED`, and every other outcome the gate can return goes where those
  gates stop. A diligence gate's settings list the steps that read its level.
- **Monitoring.** A new Experience API operation, `getAuthoringPoliciesMonitoringDiligence`, is
  relayed to case-api `GET /v1/policy/monitoring/diligence`. That route reads the tenant's stored
  decisions for the gate, optionally only for some customer types, and summarises them with
  `summarizeDiligenceDecisions`. The result covers totals, levels, party type × product cells,
  overlays that fired and that decided the outcome, escalations, floor and SDD raises, unresolved
  reasons and jurisdictions. The Policy Studio's Monitoring tab shows it for the customer types the
  policy serves, to anyone holding `case.read`. In mock mode, a fixed set of synthetic cases is
  evaluated with the reference evaluation.
- **Still open.** The Process Studio has no editor for parameter bindings, so binding another skill
  to the level means editing `workflow.yaml` under Sources. Monitoring counts receipts; it does not
  yet compare a level with the person's final decision.

## 6. Tests

- `policy-engine`: every compile-time check in section 3.2 has a refusal test. The golden corpus
  covers every cell, every overlay alone and in pairs, multiple products, and each missing input
  (expected `UNRESOLVED`). The TypeScript oracle and OPA agree on every case.
- Packs: floors and mandatory overlays only tighten; a loosening layer refuses with
  `policy_pack.loosens:<layer>:<field>`.
- Web: rule-sentence rendering and YAML round-trip (comments preserved) as unit tests; an
  `e2e/ui` journey that edits a cell, runs a what-if, saves, compiles, approves as a second user
  and publishes.

## 7. Decisions needed

1. **Party taxonomy.** Introduce `partyTypes` mapped from `legalForm` onto the two customer types
   (recommended), or widen `customerTypes` in the contract (touches pack selection everywhere)?
2. **Two-value cells.** Accept one level per cell with an "overlays likely" hint (recommended), or
   model a conditional cell?
3. **Matrix scope.** One matrix per policy, with jurisdiction differences expressed as pack floors
   (recommended), or one matrix per effective policy set?
4. **New products.** Wealth/private banking needs a pack product layer and a selection entry.
5. **SDD.** Which jurisdictions and institution layers permit it at launch? The recommended
   default is that none do until a policy owner resolves it.
