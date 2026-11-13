# Policy engine v2: implementation and verification evidence

Verified locally on 2026-11-09, local Node 26.7.0 / pnpm 11.9.0 (CI targets Node 24), PostgreSQL with restricted service logins and the checksum-verified official OPA 1.9.0 binary. Baseline: `65c8283fc77efb273fd06be646b7e1ea99476790`. The implementation was isolated from concurrent context/ontology work, then merged and reverified against main `703e4f8d`. The merge preserves application/reference validation and reserves control migration numbers 050–051 after the new context migrations. [Usage, authority boundaries and rollout](policy-engine-v2.md).

## Delivery trace

| Plan stages | Implemented software | Release/qualification boundary |
| --- | --- | --- |
| R01 | Typed result, input basis, exact actions/grants, effective sets, human intent and retained input; exhaustive command classification regression | Baseline 229-skill inventory remains historical; no claim that synthetic skills are production-qualified |
| R02 | Deterministic source→Rego/data compilation, pinned real OPA, same simulation/runtime contract, no v2 fixed human/automation default | Candidate output cannot acquire sink authority |
| R03 | Four existing layered pack pins projected into scoped v2 sets; closed content register; installation package compiler rebinds all skills/gates/plan | 37 blockers per shipped template; owner-supplied content and independent release approval required |
| R04 | Common case-store guard, process-local authority, fresh release/lease checks, transactional receipt/actions/ledger, exact consumption and external outbox | Qualified idempotent external adapters must be provided by the installation delivery service |
| R05 | Six real gates and typed routes; worker parks/re-arms policy human work; fresh post-human evaluation with exact reviewed intents | Verified node-execution contract; whole-graph/external transport qualification is not inferred from it |
| R06–R07 | Active KYC/KYB packages migrated through their shared generator; US/GB × individual/corporate gate→sink tests; output checks applied disposition | Full live nine/ten-agent replay, hydration and qualified core skill scope remain onboarding acceptance work |
| R08 | Source acquisition/use and banking requirement/readiness execute OPA; old TypeScript evaluators retained as frozen parity oracles | Existing v1 rule semantics preserved; installation changes belong to new immutable policy releases |
| R09 | Fact/control/document/risk interpretations require explicit adoption or protected actions; activated work/schedules use protected work commands; filing/retention use outbox | Producer schema/quality and future action kinds require their own versioned handoff and qualification |
| R10 | Current templates, blockers and sample runner in Studio; original-input/intents in human sheet; generated contracts; mandatory real-OPA CI | No production release, shadow deployment, live provider certification or owner approval is claimed |

## Executed checks

| Check | Result and evidence |
| --- | --- |
| Whole workspace typecheck | Passed across all 46 projects; final changed web/case-api/e2e projects checked again after browser fixes |
| Whole workspace tests | The merged `pnpm check` workspace test phase passed: 1,627 tests, 112 configuration-dependent skips, including the exhaustive classification assertion. The subsequent expanded gate-profile and recorded-agent replay checks also passed (31 focused tests). Database-backed tests were run separately below |
| Whole workspace build | Passed, including production web bundle scan: no mock code in the HTTP build |
| UI contracts | 1,093 checks, zero failures; Redocly lint clean; generated files current. Only the repository's previously documented identity/routes/design drift acknowledgements remain |
| Broad real database regressions | 93 files passed, two skipped; 490 tests passed, three skipped, covering persistence, case-store, case/control APIs, gateway, runtime host and worker. The final database run used two file workers to avoid oversubscribing the shared host; assertions were unchanged. Test roles had no superuser or RLS-bypass authority |
| Final business authority conformance | **19/19 passed** against real OPA and PostgreSQL. Required CI mode refuses missing database configuration |
| Browser and accessibility | 41/41 Studio, authoring, source-policy, operations, human-work, ontology and case-traversal scenarios passed in the final merged run. Two changed-copy expectations were updated; a sample error live-region and policy choice fallback were fixed. Axe found no serious/critical violations in checked journeys |
| Real browser→HTTP→OPA journey | Actual Fastify authoring handlers and OPA compile/evaluate the installation template; browser receives/rendered `UNRESOLVED` result, exact repeated receipt and blockers. Invalid JSON produces an announced error and no extra API evaluation. Identity/navigation use the explicit isolated mock seam; this is not production identity/provider qualification |
| Human UI contract journey | Original evaluated input, exact action intents, three-person quorum, permitted choices and response hashes verified. This uses a marked contract fixture; backend human authority is proven separately by the database conformance suite |
| Generation and archives | `make compile`, agentic generator `--check`, UI sync `--check` and `git diff --check` passed. Archived KYC `c3807e14…`, archived KYB `dffd5892…`, transition KYB-screening `b9172590…` unchanged relative to current main; earlier pins changed in the incoming onboarding/library work |
| Migrations/grants | New control/case migrations applied and reapplied successfully in isolated databases; separate control/case regression fixtures pass with admitted-plan enforcement |

OPA-backed unit tests also exercise installation automation differences, explicit decline, missing evidence, deterministic replay, altered bundle/set/scope/profile/version rejection, one-pass action templates, empty/partial correlated party×screening coverage, freshness boundaries, source-policy parity, and the nine-hero banking corpus under candidate/approved/reuse and satisfied/tampered controls.

The final integration preserves onboarding waves 0–5 and the existing recorded-agent answer keys. New generator regressions ensure every gate receives document/finding/control/proposal/adoption inputs and that callback wiring cannot clear unresolved provider permission content. A fresh disposable database was used after the library manifest update: previously qualified versions correctly refuse in-place content replacement.

## Authority conformance scenarios

`apps/case-api/src/business-decisions.integration.test.ts` proves:

- Automatic approve and decline apply as attributed SYSTEM policy actions without fabricated human actors.
- Every protected direct command fails before any gate executes; importing an otherwise valid grant also fails.
- Authenticated human roles, distinct-principal quorum and response idempotency are enforced. Responses leave case disposition untouched until fresh OPA evaluation.
- Exact reviewed human actions cannot be changed by a post-human rule.
- Receipts, actions, consumptions and ledger roll back together if a later action fails.
- Candidate and revoked bundle authority cannot apply an otherwise successful OPA result.
- US/GB individual/corporate scope is enforced using the corresponding active onboarding plan.
- Exact receipt replay adds no second disposition; concurrent evaluations serialize on the case.
- Canonical adoption binds the exact selected object/version; an unseen version cannot be adopted.
- `NEEDS_EVIDENCE` can create policy-authorized collection work without accepting or declining the case.
- External delivery is idempotent; revoked authority cancels before calling the adapter; ambiguous delivery parks for reconciliation.
- Missing server read proof or a changed snapshot clock cannot hide newer evidence.
- Policy human work parks with the authored requirement, rejects generic completion/conflict overrides, and re-arms the same gate/run.

## Reproduction

Use the pinned `OPA_BIN` and a freshly migrated disposable PostgreSQL database. Never run the suite against a production database.

```sh
pnpm ui:sync
pnpm ui:contracts
make compile
pnpm check
EHF_REQUIRE_POLICY_DB_TESTS=1 EHF_TEST_DATABASE_URL="$POLICY_TEST_DATABASE_URL" \
  pnpm --filter @ehf/case-api exec vitest run src/business-decisions.integration.test.ts
pnpm --filter @ehf/e2e-ui exec playwright test policy-v2.spec.ts plt-authoring.spec.ts \
  plt-operations.spec.ts policy-tree.spec.ts plt-source-policies.spec.ts
```

CI provisions the pinned OPA image before the code checks and mandatory database conformance. Browser screenshots are test artifacts; the real policy-sample screen was visually inspected. Full production onboarding acceptance must add the companion plan's hydrated fixtures, callable-skill/model/provider qualification, owner-approved policy content, human pilot, automation variant and deployment evidence before activation.
