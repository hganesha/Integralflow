# Skill library contracts (`@ehf/library-contracts`)

Status: implemented against financial-crime-skills **0.2.0** (context schema **2.0.0**), synthetic
reference. Nothing here makes a library skill production-qualified.

Library release 0.2.0 replaced open record shapes with closed, versioned contracts. The platform
vendors those contracts and enforces them on its side of the boundary:

| Contract | Vendored file | Used for |
| --- | --- | --- |
| 89 canonical context types (closed, `additionalProperties: false`) | `src/vendor/ontology.schema.json` | `validateRecordData` / `assertRecordData`: every canonical record a connector normalizer emits ([canonical-records.md](canonical-records.md)) |
| Effect command variants (`state` / `outbox`) | `src/vendor/effect-command.schema.json` | `mapLibraryEffects`: library commands → skill.execution.v1 §6.3 `requested_effects` (CR-5) |
| Nine provider capabilities (request + response) | `src/vendor/providers/*.schema.json` | `validateProviderPayload`, `LIBRARY_CAPABILITIES`: canonical capability IDs and sandbox connectors (CR-8) |

The policy pack the KYB skills read is vendored separately with the KYB package
(`domains/archive/kyb-deterministic/library/policy.synthetic-neutral.json`, see [Policy slice](#policy-slice-cr-4)).

**One release, two snapshots.** The library's catalog (`catalog/catalog.json`,
`catalog/release-lock.json`) is vendored in `config/skill-library/` and *is* the business-skill
registry ([business-skills.md](business-skills.md)); its closed schemas are vendored here. Both
must come from the same library release: `lock.json`'s version, `catalog_source_hash` and
`bundle_code_hash` equal the catalog's (a package test checks it), and every snapshot is checked
in CI (`sync-library-contracts.mjs --check`, `sync-business-skills.mjs --check`,
`sync-kyb-package.mjs --check`, `sync-kyc-package.mjs --check`). Refresh all of them from one
checkout.

## Refreshing

```sh
# The library lives in apps/fincrime-host; every script reads it by default (--library <dir> overrides).
node scripts/sync-library-contracts.mjs            # copy the closed contracts, write lock.json
node scripts/sync-library-contracts.mjs --check    # CI: vendored files match lock.json and the library
node scripts/sync-business-skills.mjs              # config/skill-library + config/business-skills.json
node scripts/sync-kyb-package.mjs                  # KYB snapshot, manifests and policy pack
node scripts/sync-kyc-package.mjs                  # KYC manifests
make compile                                       # artifacts/archive/kyb.plan.json, artifacts/archive/kyc-v2.plan.json
```

Files are copied byte for byte. `lock.json` records the library version, context schema version,
catalog source and bundle hashes and the sha256 of each file; `--check` (and the package's own test)
fails on any drift. A library upgrade is a reviewed change: the closed schemas decide what every
normalizer may emit.

## Records

`data` holds canonical fields only. A source field without a canonical field goes under
`data.extensions["ehf.connector"] = { schema_version: "1.0.0", value: { … } }` — the ontology's
versioned extension mechanism. No library skill consumes extension values; they keep the source
detail for people and audit. Records carry `schema_version: "2.0.0"`.

`NegativeSearchEvidence` is the one platform-only type (`PLATFORM_RECORD_SCHEMAS`). The library has
no negative-search type: a completed provider search with no candidate is not a list capture, so it
is never a `WatchlistEntry` and never "clear". It is validated against its own closed schema built
from the ontology's shared definitions, and the screening skills still answer NEEDS_EVIDENCE on a
clean screen (open item for the library team).

## Effects (CR-5)

The library's 15 write or gated skills (the other 207 are `read_only`) are declared in
`LIBRARY_SKILL_EFFECTS`: platform effect mode, the case commands each may request (its manifest
`authorization` carries `case_command:<Type>`, `caseCommandAuthorizations()`), external actions and
whether approval is required (all 7 `human_gated` skills).

| Library command (skill) | Requested effect |
| --- | --- |
| state `case` `OPEN` (`case.create`) | absorbed: the platform opens the case before the run; case creation is not a business command |
| state `case` `REVIEW` (`case.state.transition`) | `RequestHumanReview` |
| state `case` `CLOSED` (`case.state.transition`, `case.close`) | `TransitionCaseStatus` → `CLOSED` |
| state `case` + `disposition` (`decision.disposition.record`) | `RecordReview` (`disposition`), after approval |
| state `assignment` (`case.tasks.assign`) | `ProposeWorkItem` (`assignment`) |
| state `escalation` (`case.escalate`) | `RequestHumanReview` (priority `HIGH`) |
| state `feedback` (`alert.feedback.capture`) | `RecordReview` (`alert_feedback`) |
| state `schedule` (`monitor.customer.schedule`, `screening.rescreen.schedule`) | `ProposeWorkItem` with `dueAt` |
| state `screening_disposition` (`screening.alert.disposition`) | `RecordReview` (`screening_disposition`), after approval |
| state `review` (`monitor.review.close`) | `RecordReview` (`monitoring_review`), after approval |
| outbox `execute_skill` (`monitor.review.execute`) | `ProposeWorkItem` (`skill_execution`, `requiredCapability: skill.<id>`) |
| outbox `submit_filing` (`regulatory.filing.submit`) | external action `regulatory.filing.submit`, after approval |
| outbox `delete_artifact` (`evidence.retention.enforce`) | external action `evidence.retention.delete`, after approval |

Every command is validated against the vendored schema first. A command the skill is not declared to
emit, or one with no platform mapping, refuses the whole execution (`EffectMappingError`) rather
than being dropped. Idempotency keys are `lib:<skill>:<digest of the command>`, so a retried
execution requests the same effect. Case-level state commands carry the library's
`expected_revision` as `payload.expected_case_sequence`.

Differences from the change request's first draft: there is no `CreateCase` business command (the
case exists before a run, so `case.create` is absorbed), and alert feedback is a `RecordReview`
rather than a screening finding.

**One effect rule.** `LIBRARY_SKILL_EFFECTS` declares only what each skill's library commands map
to (case commands, external actions); its `mode` and `approval` come from `librarySkillEffectMode`
in `@ehf/contracts`, the same CR-5 rule `businessSkillEffects` applies to registry entries, and a
test checks the table against `config/business-skills.json`. The mapping is not write authority:
what a skill may commit is its binding's pinned effects (`effects: { mode, approval, caseCommands }`,
from the registry entry; `caseCommands` = the manifest's `case_command:<Type>` authorizations,
none in today's catalog), enforced by the gateway, the compiler and the case API's commit path
([canonical records](canonical-records.md#skill-originated-records)); the mapped `RecordReview`
effects (dispositions, alert feedback, screening dispositions, review closure) are refused outright
there, since a skill never creates a review or disposition record (§6.2): those decisions stay
with the durable human approval. Generated nodes no longer
carry a separate `config.skillEffects`; they carry the commit grants (`caseWrites` with
`skillGrant`) those pinned effects allow.

## Provider capabilities (CR-8)

| Library | Platform capability | Kind | Sandbox connector |
| --- | --- | --- | --- |
| `document.entities` | `document.entities.extract.v1` | model | none: bind a model connector |
| `document.translate` | `document.translate.v1` | model | none: bind a model connector |
| `document.forensics` | `document.forensics.assess.v1` | tool | `simulator:library.document.forensics` |
| `fraud.synthetic_identity` | `fraud.identity.synthetic.v1` | tool | `simulator:library.fraud.synthetic_identity` |
| `fraud.identity_theft` | `fraud.identity.theft.v1` | tool | `simulator:library.fraud.identity_theft` |
| `fraud.document_tamper` | `fraud.document.tamper.v1` | tool | `simulator:library.fraud.document_tamper` |
| `fraud.deepfake` | `fraud.media.deepfake.v1` | tool | `simulator:library.fraud.deepfake` |
| `fraud.account_takeover` | `fraud.account_takeover.v1` | tool | `simulator:library.fraud.account_takeover` |
| `fraud.liveness` | `identity.biometric.verify.v1` (existing) | tool | existing wiring connectors |

The sandbox connectors check each request against the library's request schema and always answer
`INCONCLUSIVE` with an uninformative score and the limitation "no detector executed". They never
pass and never raise a signal. Live detectors replace them with the same response shape.

`identity.biometric.verify.v1` connectors return the wiring `verification` result family, not the
library's `DetectorAssessment`. The library's `fraud.liveness.verify` needs that mapping before it
can use them.

## Policy slice (CR-4)

**One policy mechanism.** KYB and KYC pin the same `config.skillPolicy` shape
(`skillPolicyConfigSchema`, `packages/context-plane/src/policy.ts`) and one resolver builds the
`policy` section: `policyRef`, `policyVersion`, `bundleDigest`, the manifest's `fields`, their
`values` (and, for KYC, per-cohort `computed` values), `sources` and `unresolved`. KYB's policy is
the vendored synthetic pack (bundle digest = sha256 of its bytes); KYC's is the US KYC OPA
bundle. The stricter rules of the two former implementations apply to both: the section is sent
only when the case is pinned to exactly that policy id and bundle digest, and only when every
declared field resolves; otherwise the skill is not called (NEEDS_EVIDENCE, `POLICY_UNRESOLVED`,
with the reason). The section's value is the flat field map the library projects
(`{field: value}`), provenance `policy-snapshot:<case policy snapshot digest>`.

`scripts/sync-kyb-package.mjs` pins, on each skill node, the projection of the vendored policy pack the
skill declares in `policy_context_fields` (`config.skillPolicy`: policy id, version, digest of the
pack, fields, and `unresolved` for any declared field the pack lacks). `permissions` is scoped to
the grants that execution's own check reads (`skill:<id>`, `effect:<effects>` for a write skill,
`skill:<target>` for `case.context.hydrate`). The 29 KYB skills read 19 policy fields between them.

A KYB case is therefore opened under policy `policy.synthetic.neutral` with the pack's digest as
its policy bundle digest. A case under another policy or bundle gets no section and its
policy-reading skills are not called (NEEDS_EVIDENCE, `POLICY_UNRESOLVED`, explanation naming the
policy the case is pinned to).
