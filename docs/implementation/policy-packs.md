# Policy packs

Status: implemented 2026-11-09 (agentic KYC/KYB plan, phase 2). All layers are candidates.

A case is governed by one **effective policy pack**, chosen from the packs its plan pinned by the
case's jurisdiction, bank, products and customer type. Packs are built from layers that may only
tighten one another.

## Layers and composition

```
baseline ─▶ jurisdiction (US · GB) ─▶ institution (bank.synthetic) ─▶ product layers (one per product in the set)
```

Sources: `domains/policy` (layers and `selection.yaml`). Compiler: `packages/policy-engine/src/policy-packs.ts`
(`composeEffectivePack`), run by `scripts/sync-policy-packs.mjs` into `artifacts/policy/packs/` (CI checks drift).

- **Fields and rules.** Every field has a tightening rule: thresholds may only go down (`min`), required
  sets may only grow (`superset`), accepted sets may only shrink (`subset`), freshness per record type
  may only shorten (`perKeyMin`), PEP scope may only widen (`ordered`), dual control may only switch
  on (`trueWins`), the jurisdiction and the sanctions-ownership rule are set once (`fixed`), and
  automatic approval and decline must be false in every layer (`falseFixed`). The one carve-out is
  `automatic_approval_low_risk`, which a layer may grant and any layer above may only withdraw
  (`falseWins`), with its risk ceiling `low_risk_max_factor_score` only going down (`min`). The
  synthetic bank grants it as a SYNTHETIC placeholder. Diligence controls tighten too:
  `diligence_floors` (`<customer type or *>:<product or *>` → minimum level) may only rise
  (`perKeyLevelMax`), `mandatory_overlays` may only grow, and `simplified_due_diligence_permitted`
  may only be withdrawn (`falseWins`); see the [Policy Studio builder plan](policy-studio-builder-plan.md).
  A layer that loosens a field refuses the composition: `policy_pack.loosens:<layer>:<field>`.
- **Basis.** Every value carries the reason and, for regulatory values, the source. An effective pack
  records which layer set each value.
- **Product sets.** An effective pack covers a named product set (`business-banking`: deposit,
  lending, merchant acquiring, payments). Each product's layer is checked against the institution
  values and the product layers merge by their tightest value, so their order does not matter.
- **Known differences.** Where the platform's mechanics cannot express a rule exactly, the layer says
  so, and the platform is stricter than the law: the UK beneficial-ownership test is "more than 25%"
  but the library counts "25% or more"; OFSI does not aggregate different designated persons'
  holdings but the library's 50% rule does.
- **Digest and status.** An effective pack is content-addressed (`digest`) and `CANDIDATE` until every
  one of its layers is `APPROVED`.

Four effective packs are compiled today: US and GB, each with personal banking (individuals) and
business banking (corporates), for the synthetic corpus bank.

## Selection per case

`casePolicyContextFromRelationship` reads the case's canonical `BankingRelationship`: policy
jurisdiction (not booking jurisdiction), institution, products, and customer type from the customer
entity's legal form. `selectPolicyPack` returns the one pinned pack whose jurisdiction and
institution match, whose product set holds every product of the case, and whose customer types
include the case's. No match, more than one, or a missing fact stops the case for a person
(`none`, `ambiguous`, `context_incomplete`); nothing defaults.

## What reads a pack

| Consumer | How |
| --- | --- |
| Skills | `projectPackForSkill` projects the pack to a skill's `policy_context_fields` (the shape of `config.skillPolicy`; unset fields are `unresolved`, never defaulted). A node may carry one projection per pinned pack (`config.skillPolicies`, also on loop skills); at run time the case's pin chooses (`chooseSkillPolicy`), so a case is only ever governed by a pack its plan pinned |
| Pack checkpoints | A transform with `config.packGate` (`intake-ready`, `decision-ready`, `disposition`) evaluates the pinned pack over the case's canonical records (`evaluatePackGate`): relationship and required party roles; every party in a screening role screened for every required type on the required lists; evidence freshness; ownership for corporates; disposition always routes to a person, with dual control where the pack requires it. No pin, a tampered pack or missing inputs is `UNKNOWN` |

Production slice 1's candidate policy is reproduced exactly by the US pack for its products
(deposit and payments): a test checks every field.

## Boundary with OPA

Pack checkpoints follow the banking-product readiness pattern: deterministic TypeScript over
canonical records, not an OPA bundle. This phase deliberately does not touch the OPA decision-table
machinery (compiler, case-API policy evaluator, `domains/kyc/policy`, `artifacts/policy/kyc`), which is
being reworked separately. Packs can reference compiled OPA bundles by policy id and digest
(`gateBundles`, checked against `artifacts/policy` by the sync script); no layer does yet. Binding the
flows' gates to OPA bundles, and a KYB decision-table catalog with its corpus, are open and belong
with that work.
