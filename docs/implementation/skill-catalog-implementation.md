# Skill catalog implementation

Status: implemented local foundation, 2026-11-08. Library release `0.5.0`, skill contracts `0.3.0`, context schema `2.0.0`. All 232 skills (222 canonical plus 10 extensions) remain `implemented_synthetic`. Regeneration creates no production qualification or release approval.

This implements repository-controlled foundations from the [audit and roadmap](skill-catalog-production-plan.md). The audit CSV remains the historical 0.4.0 baseline. Commercial scope, institution policy, licensed integrations, representative evaluation and complete journey qualification remain separate work.

## Content and policy contracts

All 232 skills have editable [source procedures](../../apps/fincrime-host/skill-content/README.md) with shared guidance for 20 domains. Twelve pilot procedures include dedicated business branches, variation boundaries and acceptance cases. Both content layers are inlined into the existing instruction digest and runtime context budget. Every skill exposes authored limitations in structured metadata.

The builder rejects missing/extra source coverage, missing domains, duplicate/missing sections, symlinks and unpinned references. Runtime instruction reads verify bytes against the released catalog; host startup checks every served package. Explicit per-skill policy-field declarations replace source-regex inference, including helper dependencies.

`edd.trigger.evaluate` and `party.profile.completeness` now return `BLOCKED`/`POLICY_UNRESOLVED` when governing configuration is absent. An explicit empty list in an admitted policy remains distinct. Executor/workflow tests verify that missing policy cannot advance to scheduling or produce a favorable payload. Screening descriptions distinguish admitted-record evaluation from acquisition, ownership/control and disposition.

## Immutable versions

Migration `035_skill_catalog_qualification.sql` permanently freezes content when a version becomes active, deprecated, integration-verified or production-qualified. Lowering lifecycle/maturity cannot unlock it. Frozen content cannot be updated or deleted; changed behavior needs a new version. Content cannot change without changing its declared digest.

Draft edits remain possible and invalidate inherited status/maturity. Unchanged operator decisions survive seeding. New `0.3.0` versions do not rewrite released `0.2.0` records. Old plans need compatible old hosts/bundles, or migration through ordinary review and release.

## Qualification evidence

`skill.qualification.v1` binds evidence to exact skill/version, manifest, complete bundle lock, bundle, admitted plan, policy snapshot reference and selected policy-section content. Scope includes explicit ISO jurisdictions, purpose, validity interval and independent reviewer. Evidence includes report/dataset digests, positive sample count, passed control attestation and named metrics meeting declared thresholds.

Thresholds come from accountable reviewers, not platform defaults. A supplied report reference is not automatic verification of its contents. Independent approval uses existing release authority and the artifact registry's separation of duties; no parallel trust/signing system is added.

| Control API | Behavior |
| --- | --- |
| `GET /v1/registry/skill-qualifications` | Tenant-scoped evidence/status using capability-read authority |
| `POST /v1/registry/skill-qualifications` | Register evidence for an integration-verified version matching an admitted tenant plan |
| `POST /v1/registry/skill-qualifications/:digest/approve` | Approve as the named independent reviewer before expiry |
| `POST /v1/registry/artifacts/skill-qualification/:digest/revoke` | Existing reasoned artifact-revocation path |

Content is immutable and tenant-isolated. Every production invocation checks current approval/revocation, validity and exact scope without caching the decision. Production applies when either security profile or release environment is production. Synthetic maturity and inactive lifecycle are denied; integration verification alone is insufficient. Receipt output includes the selected `qualification_digest`.

Policy hashing sorts policy sections by ID, retains each section's `id`, `provenance_ref` and `value`, and applies canonical `stableDigest`. Input/context policy references must agree; missing policy sections cannot qualify. Changed policy content, bundle/image lock, skill content, plan, jurisdiction or purpose requires matching evidence.

Product/legal-form/role support belongs to the exact admitted plan and policy gates. Free-form scope descriptions grant no authority. Live provider/model changes outside pinned artifacts still require operational change control and requalification/revocation; this foundation does not independently establish live-source effectiveness or qualify arbitrary dynamic provider versions.

## Validation and rollout

Regressions cover absent versus explicit-empty policy, workflow stopping, authored-source coverage, unpinned references, instruction tampering, schema version identity, metric constraints, exact qualification scope, production gateway denial/receipts, expiry/revocation and PostgreSQL tenant isolation/immutability.

Apply the migration through normal deployment procedures, deploy the new host/catalog, and review regenerated plans/bundles. New digests require normal independent approval. Existing installations should retain compatible hosts for old plan pins during rollout. All business/source/policy and operational gates in the roadmap remain in force.

## Verification results

- Python library: 2,098 tests passed, including all skill contracts and public policy-gap regressions.
- Workspace TypeScript tests: 1,197 passed; workspace typecheck and build passed.
- Focused gateway, qualification API and PostgreSQL regressions: 16 passed against a disposable database with real migrations.
- Catalog generation: 2,473 artifacts checked; library snapshots, bundle lock and both domain packages pass drift checks.
- Experience API: 1,040 contract checks passed, Redocly lint passed, generated UI contracts are current. Existing acknowledged historical EHF drift remains documented in GAP-015.
- Wheel distribution: release 0.5.0 was built and installed outside the checkout; all 229 runtime manifests, instruction hashes, explicit policy contracts and structured limitations match the installed release.

Host startup now compares computed runtime manifests against the released catalog as well as checking bundle/instruction hashes. This catches tampering with installed policy declarations or other metadata. Schema IDs follow each skill's version rather than a hard-coded prior version.

These results establish executable/package/control consistency. They do not constitute independent real-world accuracy evaluation, approved institutional policy or enterprise operational qualification.
