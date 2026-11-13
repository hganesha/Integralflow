# KYB screening and ownership: production slice 1

Status: candidate policy, synthetic library skills. Not production-qualified. The plan, scope,
decisions and exit bar are in
[docs/implementation/production-slice-1.md](../../docs/implementation/production-slice-1.md).

US corporate onboarding, from case identity to an independent human review: legal-entity
existence, ownership and control, beneficial owners, sanctions screening (including the OFAC 50
percent rule) and PEP screening of the customer and its related parties. Identity documents,
adverse media, risk, EDD and the final disposition are out of scope.

## Sources and generation

- `source/workflow.json`: the 13-step skill topology and its upstream bindings.
- `policy/slice-policy.json`: the candidate slice policy (status `CANDIDATE`, owner role
  `kyb-policy-owner`). Its sha256 is pinned into every policy-reading skill node; each value
  records its basis.
- `library/skills.json`: the vendored manifests (refresh with `--library`).
- The library's business agent profiles (`apps/fincrime-host/profiles`) and the KYB connector
  stages (`scripts/lib/kyb-connectors.mjs`).

```sh
node scripts/sync-kyb-screening-package.mjs
node scripts/sync-kyb-screening-package.mjs --check
node --import tsx packages/compiler/src/cli.ts compile domains/kyb-screening --out artifacts/kyb-screening.plan.json
```

Do not edit the generated `package.yaml` or `workflow.yaml`.

## Agents

Every skill node runs as an agent profile imported from the library:

| Profile | Skills |
| --- | --- |
| `agent.decision_support` | `decision.policy.resolve`, `decision.human.review` |
| `agent.identity_ownership` | `entity.resolve`, `registry.company.verify`, `ownership.graph.build`, `ownership.interest.calculate`, `ownership.ubo.resolve`, `ownership.ubo.verify` |
| `agent.screening` | `screening.name.normalize`, `screening.sanctions.execute`, `screening.pep.execute`, `screening.match.disambiguate`, `screening.sanctions.ownership.evaluate` |

Five of these skills are not in the library profile's `allowed_skills`; the generator adds
them explicitly (`SLICE_PROFILE_ADDITIONS`), each within the profile's mandate, as a proposed
library change.

Two advisory loops are the slice's only model use: `ownership-review` and `screening-review`.
They call read-only connectors, return schema-checked proposals (`requiresHumanReview: true`,
screening proposals `final: false`) and may only link their own `AGENT_DERIVED` evidence. They
cannot stop, route or decide anything.

## Controls

- The designated set for the OFAC 50 percent evaluation is the sanctions skill's
  identifier-confirmed hits (`screening-sanctions-execute.payload.hits[*].entity_id`), never an
  authored list.
- `decision.human.review` is human-gated; its approval requires dual control. The slice's result
  is an assessment, not customer acceptance.
- There is no OPA gate yet: that needs the policy owner's decision tables. Until then the human
  approval is the only disposition authority.
