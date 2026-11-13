# KYC v2: individual CDD reference domain

Status: synthetic library skills under candidate US policies. Not production-qualified.

KYC runs 28 skill steps (22 canonical plus six document wrappers), deterministic acquisition,
three pinned OPA gates and independent dual-control human approval. There is no agent loop or
model capability in the compiled domain. The seven library business profiles remain separate.

## Sources and generation

- `source/kyc-workflow.json`: authored skill topology and upstream data bindings.
- `scripts/sync-kyc-package.mjs`: connectors, OPA gates, case context, approval and policy projection.
- `scripts/lib/library-package.mjs`: shared generator; selects required and optional skill context.
- `library/skills.json`: exact library catalog manifests.
- `policy-binding.yaml`: digest of the compiled candidate US KYC bundle.
- `domains/fincrime/banking-policy.json`: additional candidate party/product requirements.

```sh
node scripts/sync-kyc-package.mjs
node scripts/sync-kyc-package.mjs --check
node --import tsx packages/compiler/src/cli.ts compile domains/kyc/v2 --out artifacts/kyc-v2.plan.json
```

Edit sources and generators, then regenerate; do not hand-edit generated package/workflow files.
Policy edits require corpus regeneration, bundle compilation and an updated binding digest before
regenerating this package. New digests need normal approval and release; generation grants none.

## Regulatory and party semantics

The US policy excludes sole proprietors from legal-entity beneficial-ownership certification and
separately assesses their business identity. Unknown legal form/applicability is not an exemption.
The banking relationship model separates entities, legal capacity, related-party roles,
booking/policy jurisdictions, product access, expected use, evidence and authorized controls.

Sanctions, PEP and adverse-media acquisition screens every case subject with stable per-party
gateway calls and receipts, bounded at 50 subjects. Missing/partial results remain visible gaps.
A primary customer must be unambiguous for the legacy individual case aggregate; additional
parties are not silently treated as its first subject or as automatically verified customers.

ScreeningExecution captures query completion, scope, candidates, dataset versions, truncation
and source publication time. Completed negative searches can be consumed without fabricated list
entries or universal clearance. Missing list publication/version data remains unknown. The gate
projection preserves all accepted evidence purposes and never turns retrieval time into list
publication. Multi-party coverage requires results for each required subject.

## Product readiness and evidence authority

Before decision-ready, `banking-product-readiness` evaluates canonical BankingRelationship and
ControlAssessment records against the plan-pinned candidate banking policy. It compiles
role-specific identity/authority/screening requirements, customer classification, relationship
purpose, risk and provider qualification, eleven product families and monitoring handoff.

Assessments must match their subject, product, policy digest and relationship digest and remain
current. A changed relationship or conflicting current assessments require reassessment. The
case store accepts a ControlAssessment only from the named human assessor, never a skill or
provider that labels its own output as human. The checkpoint produces a readiness recommendation,
not a final acceptance, transaction restriction release or filing authorization.

The three existing OPA gates remain authoritative for their individual-case controls:

| Gate | Continuation |
| --- | --- |
| screening-ready | ALLOW only; validates pinned authority and intake prerequisites |
| decision-ready | ALLOW only; validates evidence, investigation and screening state |
| disposition | ALLOW/REVIEW/ERROR lead to independent human review; BLOCK/UNKNOWN stop |

The library recommendation adapter always submits REVIEW with requiresHumanReview. No library
skill records a final reviewer decision. Held effects use the existing approval-bound release
path. An EDD-required result creates durable EDD_REVIEW work; a successful review schedule creates
a due PERIODIC_CDD_REVIEW work item. Neither substitutes for evidence or an operating monitor.
D09 monitoring/review configuration now blocks production release alongside other owner inputs.

## Documents and unresolved inputs

The 293 document contracts are draft extraction contracts, not universal collection checklists.
Document requirements remain pending owner review. Assertions and nested source values remain
unverified until an authorized assessment; validity checks establish stated date currency, not
legal authenticity, authority or regulatory sufficiency.

The US bundle still does not invent library risk weights/maps, EDD triggers, recommendation
maps, verification standards or approved source qualification. Missing Party, RiskFactor, Control,
verified owner/evidence records and public-source investigation inputs remain explicit gaps.
The banking policy remains CANDIDATE; the reference source connectors and real document/monitoring
integrations require qualification. Seven specialist library profiles have updated mandates;
adding a model loop does not discharge these obligations. Production refuses synthetic skills.

The implementation and regulatory boundary tests live in policy-engine/banking.test.ts,
runtime-langgraph/subject-acquisition.test.ts, case-api/policy-evaluator.test.ts and the financial
crime library's test_banking_semantics.py. External data accuracy and institutional policy
approval are separate acceptance criteria.
