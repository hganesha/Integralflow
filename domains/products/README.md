# Canonical product taxonomy

The financial-services product ontology behind the Product Policy Studio
([plan](../../docs/implementation/product-policy-studio-plan.md)). All content is CANDIDATE:
synthetic, platform-authored, and not an official regulatory classification.

| Path | What it holds |
| --- | --- |
| `taxonomy/<CODE>.yaml` | One domain (L2) with its classes (L3) and, for deposits, payments, lending, brokerage, custody and wealth, its types (L4). Sectors (L1) are a classification on the domain. |
| `attributes.yaml` | Cross-cutting typed attributes: eligibility, jurisdiction, account arrangement, funding, behaviour, channels, exposure, intermediaries, risk, monitoring, lifecycle. |
| `legacy-mapping.yaml` | How today's case `productType` values map onto the taxonomy. |
| `institutions/<id>.yaml` | Seed institution catalogs (synthetic): legal entities, business lines and offerings mapped to canonical products. The control API serves a seed as an institution's starting draft; every change after that is a revision there, approved and published by someone other than its author. |

Ids are dotted codes whose ancestors are their prefixes: `BRK.PRIME.INSTITUTIONAL` sits under
`BRK.PRIME` and `BRK`. Institution variants (L5) and SKUs (L6) belong to institution catalogs,
not the taxonomy. Products carry facts for policy, never a due-diligence decision.

```sh
node --import tsx scripts/sync-product-taxonomy.ts          # writes artifacts/products/taxonomy.json and institutions.json
node --import tsx scripts/sync-product-taxonomy.ts --check  # CI
```
