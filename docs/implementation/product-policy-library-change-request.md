# Change request: product taxonomy in the skill library

To: skill library team (`hganesha/kyc`, context schema 2.0.0)
From: platform (`ehfconcept`), Product Policy Studio plan, phase G
Status: proposed (decision 7 of the [plan](product-policy-studio-plan.md#8-decisions))

## Why

The platform now has a canonical product taxonomy (`domains/products`, 18 domains, dotted ids such as
`BRK.PRIME.INSTITUTIONAL`) and institution catalogs that map each institution's offerings (SKUs) onto
it. Policy is set on canonical products: the diligence matrix, floors and rules name taxonomy nodes,
and a case's products resolve to canonical ids before any gate decides.

The library's `Product` record (`schemas/context/types/Product.schema.json`) carries only
`product_type`, `channel` and `active`. Its `product_type` values are the eleven banking types of the
platform's legacy `bankingProductSchema`. Securities, custody, wealth and insurance products have no
type there. Until the library can carry them, those products are **policy-only**: the platform
resolves them and the diligence gate decides on them, but no library skill reads them.

## What changes on the platform (done, phase G)

- `BankingRelationship.products[]` gains optional `canonicalProductId` and `offeringId` beside
  `productType`, which stays and is now optional. A product names at least one of the three.
- `BankingRelationship.productRoles` (optional) gives a party's role in a product: CUSTOMER,
  UNDERLYING_INVESTOR, COUNTERPARTY, INTERMEDIARY or AUTHORIZED_USER. Only the customer's own products
  enter the customer's diligence scope.
- The product resolver (`resolveRelationshipProducts` in `packages/contracts/src/products.ts`):
  1. a legacy `productType` keeps today's scope id;
  2. else a `canonicalProductId` is used as given;
  3. else an `offeringId` resolves through the institution's published catalog.

  Anything else stops the gate (`policy.product_unresolved`); it is never defaulted.
- Requirement-driven planning: `decision.requirements.compile` and `edd.trigger.evaluate` are bound
  `facts.diligence_requirements` (the diligence gate's resolved requirements, level and rules) as
  well as `facts.diligence_level`. The derived `requirements` content applies each requirement when
  that list `contains` it, and rules that add obligations get their own EDD triggers. This uses
  the library's existing predicate language (`contains`, `any`); no library change is needed for it.
- Products the customer holds in another role bring that role's obligations
  (`roleRequirements` in the diligence block); the derived `requirements` content includes them.
- The diligence decision lists the screening types its requirements imply (`screeningTypes`), and
  every later gate reads the decision as `facts.diligence`.
- The diligence gate reads the relationship's recorded `riskTier` as `facts.assessedRisk.tier` when it
  is LOW, MEDIUM or HIGH. PT-4 would let the risk skills' own tier take its place.

## What we ask of the library

| # | Request | Why |
| --- | --- | --- |
| PT-1 | Add optional `canonical_product_id` (dotted taxonomy id, `^[A-Z][A-Z0-9_]{0,39}(\.[A-Z][A-Z0-9_]{0,39}){0,2}$`) and `offering_id` to `Product`. Keep `product_type` for compatibility; make it optional when `canonical_product_id` is present. | Securities, custody, wealth and insurance products have no `product_type`. Skills that read products (product eligibility, expected activity, monitoring) can then see them. |
| PT-2 | Add a `PartyProductRelationship` context type: `party_ref`, `product_ref`, `role` (`customer`, `underlying_investor`, `counterparty`, `intermediary`, `authorized_user`). | One party can be the customer for one offering and an underlying investor for another, each with its own requirements. |
| PT-3 | Where a skill branches on `product_type`, branch on the canonical id's lineage instead (a prefix match: `BRK.PRIME.INSTITUTIONAL` is under `BRK`). | Policy, packs and the diligence matrix already apply to every product beneath a node. |
| PT-4 | Optional: let `risk.tier.assign`'s tier reach a later diligence evaluation as `facts.assessedRisk.tier` (`LOW`, `MEDIUM`, `HIGH`). | Decision 5: assessed risk is a sandbox input today. In real cases the policy should read the risk skills' tier. The platform can bind it once the flow evaluates diligence after risk, or re-evaluates it. |

## Compatibility

All changes are additive. Existing cases keep `product_type`, and the platform's resolver keeps
using it as the scope id, so today's banking decisions are unchanged. The platform will vendor the
new context schema through `scripts/sync-library-contracts.mjs` once the library releases it.

## Questions

1. Should `canonical_product_id` live on `Product`, or on a separate `ProductClassification` record
   with its own provenance?
2. Should insurance policies use `Product`, or a separate `InsurancePolicy` type (policyholder,
   insured, beneficiary roles)?
