# Business skills

Status: the business-skill registry is the financial-crime skill library's catalog (release
0.5.0, 229 skills including seven document extensions, all `implemented_synthetic`), vendored in `config/skill-library/`. The
Phase-1 spec-derived placeholders (29 hand-written manifests at maturity `catalogued`) are gone.
The KYB and KYC domain packages run library skills through a skill host; no skill is
production-qualified, and production refuses every one of them. Production requires active,
integration-verified implementations with current independently approved, artifact- and scope-bound
qualification evidence. See the [catalog foundation](skill-catalog-implementation.md) for
authored content, explicit policy contracts, immutable versions and qualification APIs.

A *business skill* is a versioned business contract from the Financial Crime Canonical
Skills catalog (222 skills in 20 domains), named by a catalog ID such as `entity.resolve`
or `screening.sanctions.execute`. Workflow nodes bind business skills; the existing
capability and connector registry ([capability-naming.md](capability-naming.md),
[capability-adapters.md](capability-adapters.md)) is the implementation layer beneath them.

## Agent profiles and business skills

"Skill" means a business skill. What v2 plans used to call skills (agent playbooks) are
now the `instructions` of an agent profile ([agent-profiles.md](agent-profiles.md)).

| | Agent profiles | Business skills |
| --- | --- | --- |
| What | One agent: prompt, instructions, allowed capabilities and business skills, context purposes, loop limits | A business outcome with input/output contracts, required context, failure codes, evidence and authorization rules (spec §4) |
| IDs | `agent.kyc.case-assessment.v2` (instruction ids such as `skill.kyc.case-assessment.v2` are kept from the playbooks they came from) | `screening.sanctions.execute` (never versioned in the ID; `semver` is separate) |
| Code names | `agentProfileSchema`, `packageAgentProfileSchema`, plan `agentProfiles`, node `config.agentRef`, `/v1/authoring/agent-instructions` | `businessSkill*` schemas, `harness_control.business_skill_registry`, plan `skillBindings`, node `config.skillId`, `/v1/business-skills` |
| Consumed by | The context plane (prompt and instructions), the compiler and the agent loop (capability, skill, purpose and limit bounds) | The compiler (pinning), the runtime (selection), the gateway (receipt) |

A profile names the business skills it may run in `allowedSkills`; a node that has both
`agentRef` and `skillId` must use one of them (harnessc rule 5 in
[agent-profiles.md](agent-profiles.md)).

A legacy name remains where renaming would change stored data: the authoring registry
still stores instructions as `skillRegistrationSchema` rows in
`harness_control.skill_registry` with agents' `skillIds` naming them.

## Layers

```
business skill      screening.sanctions.execute@0.2.0   (library catalog entry, manifest digest)
  └ resolver        pinned candidate set + resolution policy (plan skillBindings)
      └ capability  skill.screening.sanctions.execute.v0 (skills:<skill_id>, served by a skill host)
                    or a canonical capability such as screening.sanctions.v1
          └ connector  skills:screening.sanctions.execute | opensanctions:sanctions | wiring:…
              └ adapter  gateway adapter module (skills, opensanctions, wiring, evidence, agents, …)
```

A package binds a skill to its candidates explicitly (`skillBindings`, below). The library
skills are served by the `skills` gateway adapter
([skill-library-integration-contract.md](skill-library-integration-contract.md) §15); a skill
can also be bound to platform capabilities directly (the `skill-bound` fixture).

## Pin at compile, select at run

A v2 domain package declares the skills its nodes use, and a node names one:

```yaml
skillBindings:
  - skillId: screening.sanctions.execute
    semver: 0.1.0
    manifestDigest: sha256:<manifestDigest from config/business-skills.json>
    candidates:
      - capabilityId: screening.sanctions.v1                 # connector defaults to the capability's binding
        equivalentCoverageGroup: opensanctions.sanctions
      - capabilityId: screening.sanctions.v1
        connectorId: wiring:opensanctions:screening.sanctions
        equivalentCoverageGroup: opensanctions.sanctions
    policy: { require_entitlement: true, require_list_freshness: true,
              require_jurisdiction_coverage: true, allow_fallback: true, log_selected_implementation: true }
# workflow.yaml node:  config: { skillId: screening.sanctions.execute }
```

Candidates may also be bare capability IDs. `harnessc` validates the binding (catalog-style
ID, semver, digest, every candidate capability declared in the package, connector IDs well
formed, candidates in one coverage group share kind and effect, all five policy flags) and
that the node's skill is declared. It pins the manifest digest, the ordered candidates (each
with an explicit connector) and the policy into the plan's `skillBindings`, adds every
candidate capability to the node's permission envelope (as `config.loop.tools` does), and
sets `config.capabilityId` to the first candidate when the node has no explicit binding (an
explicit binding must be a candidate, or the node's planning model). Only bindings a node
references are emitted; a plan without skill-bound nodes has no `skillBindings` key and
compiles byte-identically (the agent-profile fixture plan, `packages/contracts/test-fixtures/agent-profiles.plan.json`, is unchanged). The TypeScript plan
schema declares `skillBindings` optional rather than defaulted to `[]`: a zod default would
add the key on parse and break digest verification of every existing plan. Fixture:
`packages/contracts/test-fixtures/skill-bound/`.

At run time `invokeCapability` on a skill-bound node selects the first pinned candidate the
node's envelope permits. If, and only if, the policy has `allow_fallback`, the failure is
transient (`TIMEOUT`, `RATE_LIMITED`, `SOURCE_UNAVAILABLE`) and a later candidate is in the
**same** equivalent-coverage group as the primary, it retries on that candidate under a
distinct deterministic invocation ID. It never falls back across coverage groups and never
on any other error: sanctions coverage and authorization are not traded for cost (§9).
Admission (`admitHarnessPlanV2`) rejects skill-bound nodes whose binding is missing or whose
envelope does not cover every candidate. The request carries `skill: {skillId,
skillVersion, selectedCapabilityId, selectedConnectorId, candidateIndex, reason}`; the
gateway refuses it (`gateway.skill_selection_denied`) unless it is exactly a pinned
candidate of the admitted plan for that node, calls that candidate's pinned connector, and
stores the record in `harness_gateway.receipts.skill_selection` (migration 032, returned by
`GET /v1/gateway/receipts`). An agent loop that calls a candidate capability itself is
recorded with reason `agent_selected`. A call to a candidate capability without a selection
record is refused too, so the checks below cannot be skipped by leaving it out.

### Coverage-checked selection

`require_entitlement`, `require_jurisdiction_coverage` and `require_list_freshness` are
checked against what the operator attests, not against provider metadata (catalogue coverage
is empty for every connector, and a licence is a contract, not an API field). The attestation
is the per-tenant administered setting `gateway.connectorCoverage` (environment
`CONNECTOR_COVERAGE_JSON`; a deployment may ship a lowest-precedence file named by
`CONNECTOR_COVERAGE_PATH`, which local Compose sets to `config/connector-coverage.sandbox.json`):

```jsonc
{
  "wiring:opensanctions:*": {                    // exact connector ID, or a prefix ending in *
    "entitled": true,                            // the tenant holds a licence for it
    "jurisdictions": ["US", "GB"],               // ISO alpha-2; ["*"] is an explicit any-jurisdiction claim
    "lists": { "mode": "snapshot",               // or { "mode": "provider_hosted", "attestedBy": "…" }, or null
               "items": [{ "id": "us-ofac-sdn", "asOf": "2026-11-07T06:00:00Z", "maxAgeHours": 24 }] }
  }
}
```

The runtime sends the subject jurisdiction it established for the node (the root input's
`jurisdiction`, else the first snapshot subject's `attributes.country`; the same value as the
context envelope) in the selection record. For each candidate the gateway checks, in order and
only for what the binding's policy requires: an entry exists (`coverage_unregistered`), it is
entitled (`entitlement_missing`), the jurisdiction is known (`jurisdiction_unknown`) and
covered (`jurisdiction_not_covered`), lists are declared (`list_freshness_unknown`) and every
snapshot list is within `maxAgeHours` (`list_stale`). A refusal is
`403 gateway.skill_coverage_denied:<reason>`, before any receipt or provider call.

The runtime then tries the next permitted candidate in pinned order, whatever its coverage
group and whatever `allow_fallback` says: a refused candidate never served the call, so this
is selection by jurisdiction and entitlement, not fallback. The selected candidate becomes
the primary that later transient fallbacks are measured against. The selection reason is
`skipped_<reason>:candidate_<n>`. With no eligible candidate the node fails with the last
refusal, mapped to `ACCESS_DENIED` (entitlement), `CONTEXT_MISSING` (unknown jurisdiction),
`CONTEXT_STALE` (lists) or `POLICY_UNRESOLVED` (unregistered or not covered). Nothing is
assumed: an empty setting attests nothing, so every policy requirement fails closed. Production
deployments ship no file; the operator must attest coverage per tenant before skill-bound
plans can run.

`toSkillResult` (runtime-core) wraps an outcome as `SkillResult.v1`: `COMPLETED` only when
the implementation completed with a result; wiring outcomes `unknown | not_checked |
inconclusive | resubmit`, an UNKNOWN result or an empty output are `NEEDS_EVIDENCE`; a
review outcome is `NEEDS_REVIEW`; a partial check is `PARTIAL`; denials are `BLOCKED` and
failures `FAILED`, each with a §4.3 code. Missing evidence never reads as a pass.

## Context envelope

`assembleContextPack` also emits `ContextEnvelope.v1` (§3.3): tenant and case from the
snapshot; subject refs, jurisdiction, actor, policy snapshot ref and as-of time from the
caller (`envelope` input); purpose from the node's selectors; object/evidence refs from the
admitted sections; `permitted_providers` = the node's pinned candidates' connectors (or its
envelope's connectors); a redaction profile ref; a token budget; and a correlation ID.
`context_hash` is the pack digest, which covers the envelope fields. A field that cannot
be established is listed in `contextGaps` (`CONTEXT_MISSING`) and the envelope is `null`;
nothing is filled with an empty placeholder. Missing required selectors still fail the
node, as before.

## Registry, maturity and ingestion

`harness_control.business_skill_registry` (migration 031) holds one row per
`(skill_id, semver)`: manifest, manifest digest, `status` (`draft | active | deprecated`,
the lifecycle), `maturity` (`catalogued | designed | implemented_synthetic |
integration_verified | production_qualified`, how far it is proven), source `{path,
revision}` and owner. `migrate.ts` seeds the table from `config/business-skills.json`
additively: an operator's `active`/`deprecated` and a raised maturity are never lowered, and
unchanged manifests are not rewritten. The seed also deletes the retired Phase-1 placeholder
rows an earlier seed wrote (manifest `source: spec-derived-placeholder`). Read with
`GET /v1/business-skills?status=&maturity=&domain=` and
`GET /v1/business-skills/:skillId?semver=` (authority `capability.read`); each record also
carries `effects` and `dependencies`, derived from the manifest on read.

### Source: the vendored library catalog

`config/skill-library/` is a byte-for-byte snapshot of the library's `catalog/catalog.json`
and `catalog/release-lock.json`, plus `source.json` (library name, where it was taken from:
`path: apps/fincrime-host` for the in-repository library or the commit of an external checkout,
and each file's sha256). The catalog records its own `version`, `source_hash` and
`bundle_code_hash`; the release lock its `catalog_hash`.

`node scripts/sync-business-skills.mjs [--library <dir>] [--check]` refreshes the snapshot from
the library (default `apps/fincrime-host`; an external `--library` checkout records its commit
from its `.git` files) and builds the seed; `--check` compares instead of writing. The script refuses an inconsistent snapshot (file digests differ
from `source.json`; the release lock's `catalog_hash`, `bundle_code_hash` or `skill_count`
do not match the catalog; an entry's `bundle_code_hash` is not the catalog's) and an entry
the library schema does not allow (`librarySkillManifestSchema`: all 40 fields required,
unknown fields refused, failure codes must be §4.3 codes). Each catalog entry becomes:

| Registry field | From the catalog entry |
| --- | --- |
| `manifest` | the entry, verbatim |
| `manifestDigest` | `businessSkillManifestDigest(entry)` (below) |
| `maturity` | `maturity` (`implemented_synthetic` for all 222) |
| `status` | `draft` |
| `owner` | `owner` |
| `effects` | `businessSkillEffects`: CR-5 mapping (below) |
| `dependencies` | `businessSkillDependencies`: `dependencies.capabilities` ∪ `permitted_capabilities`, `dependencies.skills` |
| `source` | `{ path: config/skill-library/catalog.json, revision: <library commit> }` |

`generatedFrom` records the catalog version, source hash, bundle digest (`sha256:` +
`bundle_code_hash`), catalog hash and library commit. The entry schema re-derives the digest,
effects and dependencies, so an edited seed that disagrees with its manifest does not parse.

**Manifest digest (one rule, both sides).** `businessSkillManifestDigest(manifest)` in
`packages/contracts` = sha256 over the canonical JSON (keys sorted, no insignificant
whitespace) of the catalog entry exactly as the catalog states it. It is the same function as
the library's own `digest()`: `businessSkillManifestDigest(catalog)` equals the release lock's
`catalog_hash` (a test checks it). The KYB/KYC generators (`scripts/lib/library-package.mjs`)
pin `sha256:<digest>` with the same function, and refuse a vendored package manifest that is
not identical to its `config/skill-library` entry (`assertRegistrySnapshot`), so every pinned
`manifestDigest` names a registry entry.

**Effects (CR-5).** Library `read_only` (207), `internal_write` (8), and `proposal` /
`external_write` if they appear, map to themselves. `human_gated` (7) maps to
`external_write` for `regulatory.filing.submit` and `evidence.retention.enforce` and to
`internal_write` for the other five, with `approval: required`. A human-gated skill not on
that list gets `internal_write`, the narrower mode, which cannot request an external action.
The gateway checks the lock entry's `effects` against this mode, and the skill-bundle route
refuses a lock whose mode differs. Case commands an `internal_write` skill may request must be
listed in its `authorization` as `case_command:<Type>`; the library lists none yet, so every
case-command effect is refused (fail closed).

**Write authority in plans (skill.execution.v1 §6.2–6.3).** The compiler cannot read the
registry, so the generators pin each skill binding's write authority from its registry entry:
`effects: { mode, approval, caseCommands }` (`bindingEffects` in
`scripts/lib/library-package.mjs`; `caseCommands` = `businessSkillCaseCommands(manifest)`, the
manifest's `case_command:<Type>` entries, for the write modes only). Each skill node then gets
exactly the grants those effects allow, as `config.caseWrites` entries with `skillGrant`
(`skillGrantsFor`):

| Pinned effects | Node grants |
| --- | --- |
| `read_only` (or no `effects`) | none: any proposed record or effect fails the commit (the gateway refuses it first) |
| `proposal` and higher | `proposal`: `LinkEvidence`, `ProposeClaim`, `RecordScreeningFinding`, `RaiseContradiction`, `ProposeWorkItem`, `RecordCanonicalRecords` |
| write mode, `approval: none` | plus `effect`: each case command |
| write mode, `approval: required` | plus `held`: each case command, and `release` grants on the release node after the approval |

harnessc refuses a grant beyond the pin (`workflow.skill_grant_exceeds_manifest`), a grant on a
node without a skill (except the release node), `FinalizeDisposition`, `RecordReview`,
`RecordQAResult`, `RecordGateResult`, `RecordPolicyEvaluation`, `AcceptClaimAsFact` and `RecordFinancialCrimeOutcome` on a
skill node at all (as a grant or a declarative write), a pinned case command among those, case
commands for `read_only`/`proposal`, a held command that is also directly writable on the node,
and a release node (`config.skillEffectRelease`) for a skill whose approval is not required.
`held`/`release` grants are signed into the envelope's `case_writes_held`, never `case_writes`.
Every library skill in today's catalog is `read_only` except `case.create`,
`monitor.customer.schedule` (`internal_write`) and `decision.disposition.record`
(`internal_write`, approval required); none lists a case command, so the KYB/KYC skill nodes
carry `proposal` grants on those three only. See [canonical records](canonical-records.md#skill-originated-records).

**Bundle lock.** `librarySkillBundleLock(catalog, {imageDigest, sbomDigest})` is the lock the
platform expects a host to serve for a catalog release: bundle `financial-crime-skills`,
version = catalog version, `bundle_digest` = `sha256:` + `bundle_code_hash` (what the
packages pin), and per skill `manifest_digest`, `instructions_digest` (`instruction_hash`),
`code_digest` (`code_hash`), schema digests, dependencies and the mapped effect mode.
`POST /v1/registry/skill-bundles` accepts such a lock only when every `(id, version,
manifest_digest)` is in the registry with the same effect mode.

Platform-authored manifests (spec §4 names plus a `package` block,
`platformSkillManifestSchema`) are still accepted by the registry schema for the reference
skill host's three synthetic samples, whose bundle digest the compiler's `skill-hosted`
fixture pins. Nothing seeds them.

## Library skills over canonical records (KYB and KYC)

The two domain packages run the library's skills: every library step is a node bound to its
skill-hosted capability `skill.<skill_id>.v0` (`skills:<skill_id>`), pinned to the registry
entry's manifest digest and the catalog's bundle digest. Connectors acquire data into
canonical case records, and library skills reason over the records the context plane selects
for their manifest requirements. Both packages are generated by the shared generator
(`scripts/lib/library-package.mjs`) from a library-format workflow, the vendored manifests of
the skills they use (`library/skills.json`, a slice of the same catalog release as
`config/skill-library`) and a small platform overlay.

- `domains/archive/kyb-deterministic` runs the library's 29-step synthetic KYB workflow
  ([README](../../domains/archive/kyb-deterministic/README.md)); no OPA gate. Each skill's `policy` context section is the vendored synthetic policy pack projected to its `policy_context_fields`, resolved by the same `packages/context-plane/src/policy.ts` as KYC.
- `domains/archive/kyc-v2-deterministic` runs a platform-authored 22-step individual CDD onboarding workflow in the
  library format ([README](../../domains/archive/kyc-v2-deterministic/README.md)). The pinned US KYC policy bundle
  gates the stages (OPA decision tables `screening-ready`, `decision-ready`, `disposition`) and
  hydrates each skill's `policy` context section (`packages/context-plane/src/policy.ts`): the
  bundle projected to the manifest's `policy_context_fields`, computed per risk cohort by the
  policy engine where needed. A field the bundle cannot supply blocks the skill
  (NEEDS_EVIDENCE, `POLICY_UNRESOLVED`).

`apps/capability-gateway/src/library-skills.test.ts` runs a KYB skill node through the gateway
against the registry seeded from the catalog and a host serving the catalog's lock: the pinned
digest, the approved lock and the effect mode agree and the host is called; with
`RELEASE_ENVIRONMENT=production` the same call is refused (`maturity_insufficient_denied`).

See [canonical records](canonical-records.md).

## Not done yet

- The library does not serve a bundle lock yet (CR-7): a deployment must register and approve
  a lock (`librarySkillBundleLock` shows the expected content) and run a host that serves
  exactly it. The image and SBOM digests come from the host's build.
- Package `skillBindings` are generated (library packages) or written by hand (fixtures); the
  compiler does not check `manifestDigest`, `bundleDigest` or `dependencyCapabilities`
  against the registry at compile time. The generators do, against `config/skill-library`.
- Library dependency capabilities use library names (`document.entities`, …), not canonical
  capability IDs (CR-8), so the eleven provider/model skills cannot be delegated a capability yet.
- The commit path exists (§6.2–6.3, [canonical records](canonical-records.md#skill-originated-records)),
  but the catalog gives it little to commit: 207 library skills are `read_only`, including the
  ones whose payloads are the records later steps need (`ownership.ubo.resolve`,
  `risk.factor.evaluate`, `case.tasks.plan`, …), and no write skill lists a
  `case_command:<Type>` (CR-5, CR-9).
- Coverage is operator-attested only. List `asOf` values are not updated by an ingestion
  job yet, and nothing cross-checks a provider's response (list versions, coverage
  qualifiers) against the attestation. The runtime reports the jurisdiction; the gateway
  does not re-derive it from the case store.
- Done since: the v2 runtime passes envelope inputs (tenant, case, subjects, jurisdiction,
  actor, policy snapshot, as-of time, correlation) derived from the run and admitted
  snapshot, and every skill-bound node journals `skill.result.<status>` with its
  `SkillResult.v1` digest and codes; `BLOCKED` fails the node closed. The SkillResult is
  journalled, not yet persisted as a case-store record.
