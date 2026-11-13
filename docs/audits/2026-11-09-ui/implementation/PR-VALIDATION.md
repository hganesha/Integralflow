# PR scope and validation

2026-11-09 · `codex/ui-product-polish` · base `eee23d030a3bf1b807a410e6dd3f401c182cbd73`

The PR was assembled in an isolated worktree from current `main`. The shared workspace and its unrelated context-source work remain untouched. The earlier audit, plan, screenshots, build manifest and check report are retained as historical evidence; this file records acceptance of the PR branch.

## Included behavior

- Shared source-backed identities and persistent category grouping across catalogs, search, Agent Studio, context requirements, authoring, provider selection and related references.
- Descriptive icons for all 229 skills, 56 capability definitions, 825 provider bindings, 293 document types and 236 document fields. Documents cover 38 families and 18 field sections, with one shared category label. The metadata registry covers all 1,668 catalog entries.
- Consistent copy, semantic token use, responsive chrome, table continuation cues, optimized sign-in/About assets and corrected navigation.
- Correct auth URL bases and CSRF, acknowledged sign-out, binary exports, and affected-read refresh after revision conflicts.
- Reviewed BFF relays and canonical catalog, plan/run, case/document and decision projections. Human commands use verified actor, tenant and case authority. Case creation obtains the released plan's unique published policy pins through a route registered at service startup.
- Reproducible policy/human-work contracts: regeneration preserves the released schemas and operation that had previously been edited only in the generated OpenAPI file.

Existing theme, brand-gradient, ontology, context-source and policy work already on `main` is preserved. The PR adds no unrelated connector implementation or data-store migration.

## Checks

| Check | Result |
| --- | --- |
| Unit suites | 225 tests in 51 files pass across UI contracts, client, mock, tokens, kit, shell, web and BFF. |
| Case-authority HTTP checks | Four additional checks pass: startup registration with authoring disabled; case-write role and tenant isolation; unique, published and released policy pins; missing-plan handling. Total unit checks: **229**. |
| Browser acceptance | **155 unique checks verified**, plus two environment-gated live-context checks skipped. The complete 157-test run passed 151 checks and found four issues. Focused reruns passed all four after aligning two approval-copy assertions, recognizing the recorded-preview blocker, and providing the CI-pinned OPA binary. |
| Real policy evaluation | The focused browser journey uses an actual HTTP authoring server and OPA 1.9.0. The downloaded release binary's checksum was verified before use. |
| Types | Web, experience BFF, control API and case API type checks pass. |
| Contracts | 1,093 checks, zero failures; Redocly lint clean; generated pack and presentation sync current. Existing acknowledged source drift remains explicit. |
| Inventory | [verification.json](verification.json): 1,639 mapped skill/capability/document/field entries; zero missing icons, undefined tokens, direct palette references, broken catalog workspace links, dangling catalog relationships or duplicate platform navigation IDs. All 179 non-mock operations have registered handlers. |
| Build | HTTP web build, BFF service build and mock-code exclusion scan pass. `git diff --check` passes. |

The full-run and rerun counts are intentionally separate; this is not a claim that a single complete run passed 155 tests after the fixes.

## Reproduce

Use the repository's pinned Node/pnpm dependencies and Python contract-validation dependencies. Install OPA 1.9.0 and set `OPA_BIN` to its executable for the policy browser test.

```sh
python3 apps/fincrime-host/docs/ui/contracts/gen/openapi_v2.py
pnpm ui:sync
pnpm --filter @ehf/ui-tokens build
pnpm ui:test
pnpm --filter @ehf/control-api exec vitest run src/case-authority.test.ts
pnpm ui:contracts
node --import tsx docs/audits/2026-11-09-ui/implementation/verify.mts
WEB_E2E_PORT=5321 pnpm ui:test:e2e
pnpm --filter @ehf/web --filter @ehf/experience-bff --filter @ehf/control-api --filter @ehf/case-api typecheck
pnpm --filter @ehf/web build
node scripts/build-service.mjs experience-bff
git diff --check
```

## Boundaries

Eighteen reviewed projections remain explicitly unavailable, with authorized, correlated, nonretryable 501 responses and actionable guidance. Their owners and functions are listed in [the implementation report](README.md#explicitly-unavailable-operations) and [verification.json](verification.json). Registration coverage does not mean every business feature is implemented.

No deployed tenant, external provider, live SSO provider or production service health was certified. The two live-context browser flows require a configured HTTP environment. Legacy per-node budget fields and the bounded search index retain the limitations described in the implementation report.
