# Artifact registry (replaces artifact signing)

## Decision

Compiled governance artifacts — policy bundles, release manifests and skill bundles — are
not signed. A signing design would distribute a public-key map to every verifier and
revoke by key version, which makes trust a key-distribution problem and lets one key
revocation disable every artifact it had signed.

Trust is now a registry row.

| Concern | Before | After |
| --- | --- | --- |
| What makes an artifact executable | a valid signature by a trusted key | an `approved`, unrevoked registry entry for its exact digest |
| Separation of duties | approver ≠ author on the revision row | the same, and enforced again by the registry (`approved_by <> registered_by`) |
| Revocation | per key version (collateral damage) | per artifact |
| Configuration | signing key, public-key maps, trust stores | none |
| Integrity | signature over digest | readers recompute the digest from content before asking the registry |

The runtime-grant, execution-envelope, integration-envelope and delegated-envelope keys
are separate: they authorize individual invocations, not artifacts.

## In the control plane

`packages/persistence/migrations/029_artifact_registry.sql` creates
`harness_control.artifact_registry` and an append-only `artifact_registry_events`
table, both tenant-scoped with row-level security. It backfills entries from existing
policy revisions and release manifests (approved where they were approved, revoked
where they were signed by a revoked key), strips the legacy `signature` fields from
stored JSON, and drops `signing_key_revocations`.

`packages/persistence/src/artifact-registry.ts`:

- `registerArtifact` — idempotent; a digest cannot be re-registered under a different reference.
- `approveArtifact` — refuses the registrant and revoked entries.
- `revokeArtifact` — per artifact, reason required.
- `requireApprovedArtifact` — a fresh read at every authority boundary.

Lifecycle wiring (`governance.ts`):

| Transition | Registry effect |
| --- | --- |
| policy revision compiled | `policy-bundle` registered by the author |
| policy revision approved | entry approved by the approver |
| policy revision published | requires approved entry |
| release created | `release-manifest` registered by the creator |
| release approved / revoked | entry approved / revoked |
| release activated | requires approved entries for the manifest and every policy bundle |
| runtime gate (`requireExecutableRelease`) | requires both again, at each call |

Routes: `GET /v1/registry/artifacts`, `GET /v1/registry/artifacts/:kind/:digest`,
`POST /v1/registry/artifacts/:kind/:digest/revoke` (replaces `/v1/signing-keys/revoke`).
The Releases page lists entries and revokes them.

## Kinds

`policy-bundle`, `release-manifest` and `skill-bundle` (a skill host's bundle lock,
migration 033; see [skill-library-integration-contract.md](skill-library-integration-contract.md)
§8). Migration 034 removed the former `deployment-package`, `bootstrap-plan` and
`platform-release` kinds and their entries.

## Operational notes

- Remove any `ARTIFACT_SIGNING_*` / `*_TRUST_STORE_JSON` variables and artifact-signing
  keys from existing environments; nothing reads them.
