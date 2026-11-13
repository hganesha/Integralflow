# Policy packs

Layered, content-addressed policy for the agentic KYC and KYB flows
([docs/implementation/policy-packs.md](../../docs/implementation/policy-packs.md)).

| Path | What it holds |
| --- | --- |
| `packs/baseline.yaml` | Jurisdiction-neutral starting values; every layer above may only tighten them |
| `packs/jurisdictions/{us,uk}.yaml` | Each regulator's requirements, with the legal basis of every value and the stated differences where platform mechanics are stricter than the law |
| `packs/institutions/synthetic-bank.yaml` | The corpus bank's risk appetite (`bank.synthetic`); not a real institution |
| `packs/products/*.yaml` | Extra controls for a product or a node of the product taxonomy (`pay.yaml` targets `PAY`, the whole payments family) |
| `selection.yaml` | The effective packs to compile: jurisdiction × institution × product set (and, optionally, business line) |
| `diligence/*.yaml` | Each institution's due-diligence design: base levels by party type and product, the overlays that raise them, and what each level requires |

```sh
node scripts/sync-policy-packs.mjs          # writes artifacts/policy/packs/<id>.json and index.json
node scripts/sync-policy-packs.mjs --check  # CI
```

Layers compose baseline → jurisdiction → institution → business line (`business_line`, optional) →
product. Product layers may name a legacy product id or any taxonomy node
(`domains/products`); for each product they apply most general first (`PAY`, then `PAY.CARDS`, then
`card`), and each may only tighten what came before. So a regulatory value is protected all the way
down. `effectivePolicy` in `packages/policy-engine` lists, for one product, every control with the
layer that set it and whether it is protected, inherited or modified there.

All layers are `CANDIDATE`. Composition grants nothing: approving a layer is its owner role's
decision, and an effective pack is `APPROVED` only when every layer in it is.
