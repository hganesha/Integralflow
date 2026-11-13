# KYB reference domain

Status: synthetic skills and candidate banking policy. Not production-qualified.

The platform preserves the library's 33 skill steps (29 canonical and four document wrappers),
but deploys the case-bound workflow in `source/kyb-workflow.json`. The upstream
`library/synthetic-kyb.json` remains a demonstration fixture. Synthetic names, identifiers,
ownership targets, verified-identity flags and low-risk defaults are not executable case inputs.
Requirement compilation follows the actual registry and risk results. Missing bindings block the
skill instead of retaining an authored fallback.

## Sources and generation

- `source/kyb-workflow.json`: case workflow and data dependencies.
- `scripts/sync-kyb-package.mjs`: acquisition, parameter bindings, policy and approval overlay.
- `scripts/lib/library-package.mjs`: shared generator; includes required and optional contexts.
- `library/skills.json`: exact manifests from the in-repository skill catalog.
- `library/policy.synthetic-neutral.json`: synthetic skill policy, never regulatory authority.
- `../fincrime/banking-policy.json`: candidate US banking requirements, pinned into the plan.

Do not edit generated `package.yaml`, `workflow.yaml` or plans directly.

```sh
node scripts/sync-kyb-package.mjs
node scripts/sync-kyb-package.mjs --check
node --import tsx packages/compiler/src/cli.ts compile domains/kyb --out artifacts/kyb.plan.json
```

## Parties, products and control evidence

`packages/contracts/src/financial-crime.ts` defines BankingRelationship, party roles/capacity,
legal-form and legal-entity-customer classification, product relationships, ControlAssessment,
and screening execution contracts. Booking jurisdiction, formation jurisdiction and policy
jurisdiction are separate. A charity, fund or trust label alone establishes no exemption.

The `banking-product-readiness` checkpoint reads canonical BankingRelationship and
ControlAssessment records. `packages/policy-engine/src/banking.ts` compiles applicable identity,
authority, ownership/control, screening, purpose, risk and provider-qualification requirements,
plus product controls and a durable monitoring handoff. Eleven product families are covered:
deposit, card, payments, lending, trade finance, acquiring, private banking, correspondent,
FBO, digital assets and custody.

Each assessment is bound to the subject, product, policy digest and relationship digest, with
versioned evidence references and validity dates. Changed parties, products or relationship facts
invalidate its basis. Multiple current determinations require reconciliation. The case store
accepts ControlAssessment records only from their identified human assessor; skill-proposed or
provider-labelled human assessments are refused. A qualified system-assessment command is not
implemented. No result finalizes acceptance or authorizes a payment or external filing.

The candidate policy and missing/unknown/failed/expired controls route to handoff. The US
account-opening relief is available only after explicit institutional adoption, for reliable
same-institution/same-customer information; ownership-change events require reassessment.
Routine review can reuse reliable prior information. Source, product and monitoring approval
cannot be replaced by a generic customer approval.

## Acquisition and screening

Registry, identifier, officers, ownership and documents are acquired before reasoning. Sanctions,
PEP and adverse-media acquisition includes all case subjects and discovered Entity records in a
stable, bounded scope (50 subjects). Distinct parties are not merged by name. Each call has its
own gateway invocation and receipt. Partial failures retain successful evidence and an explicit
gap; oversized scopes or record sets are refused without truncation.

ScreeningExecution records distinguish query completion, dataset versions, candidate counts,
truncation and list publication time. NegativeSearchEvidence retains the negative search scope;
ScreeningExecution allows the library to consume a completed zero-candidate search without
inventing a WatchlistEntry or universal clearance. Missing dataset/version/publication metadata
is unresolved. Source retrieval time is never a substitute for list publication.

OwnershipRange retains uncertain percentages separately from exact OwnershipInterest. It
cannot become an exact path product or clearance. Voting/control rights are not equity.
The sanctions ownership skill offers an explicit `ofac_50_percent` fixed-point calculation,
separate from synthetic aggregation and economic-interest multiplication, with all five OFAC
FAQ 401 examples tested. Incomplete/cyclic/ranged structures remain unresolved.

## Decisions and lifecycle

KYB has no OPA bundle. The synthetic library rules, banking-product checkpoint and independent
human approval are separate controls. EDD-required results create durable EDD_REVIEW work before
the workflow stops. Review scheduling creates a due PERIODIC_CDD_REVIEW work item. Work completion
alone does not satisfy evidence requirements, authorize EDD acceptance or acknowledge a live
monitoring integration. Skill effects remain governed by the existing commit/release path.

## Remaining qualification and integration work

All library skills remain implemented_synthetic and are refused in production. The banking policy
is CANDIDATE; institution-specific screening scope, legal applicability, relief adoption, source
qualification and controls require approval. The reference acquisition bindings still require
approved native contracts, entitlements, jurisdictions and vendor acceptance.

Missing canonical producers (including verified owner identities, risk factors, controls and
verified evidence-to-requirement mappings) remain evidence gaps. The library's read-only payloads
are not silently promoted to facts. Real document extraction, nested legal interpretation,
external monitoring execution and jurisdiction packs beyond the US baseline need qualification.
The seven library profiles have specialist mandates; this deterministic domain plan has no agent
loop or model capability. Approving the new bundle/release is an operator action, not generation.
