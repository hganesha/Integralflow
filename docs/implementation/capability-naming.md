# Capability and connector naming (ADR)

Status: accepted. Applies to every capability, connector, agent, skill and model profile
the platform registers.

## Context

Capabilities arrived from several sources with incompatible names: the KYC v2 package
(`screening.sanctions.search`, `registry.company.lookup.v1`), migration placeholders
(`screening.adverse-media.search.v1`), the provider atlas (`screening.adverse_media`) and
agent hosts (`ops.kyc.profile.v1`). Some IDs were unversioned; some named a vendor or a
source. A release could not ask "which connectors can serve this capability?" because
there was no shared vocabulary and no registry of connectors.

## Decision

### 1. Capability ID

```
<namespace>.<subject>[.<qualifier>…].v<major>
^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+\.v[0-9]+$
```

- Lowercase segments `[a-z][a-z0-9_]*` joined by dots (underscores inside a segment, never
  hyphens), at least two segments before the version, always versioned.
- Never contains a provider, vendor, adapter or environment name. It names *what* is done.
- The provider atlas's v2 canonical capability model is the KYC vocabulary (section 4).
  Each of its 56 families has one platform ID: its v1 atlas name + `.v1` when it has one
  (the 37 legacy names, e.g. `identity.document.verify.v1`, `screening.adverse_media.v1`,
  `reference.identifier.lookup.v1`), otherwise its capability path + `.v1`
  (e.g. `account.profile.v1`, `financial.transactions.v1`, `screening.watchlist.v1`).
- Platform capabilities outside the atlas:

| Area | Canonical IDs |
| --- | --- |
| Evidence pipeline | `document.evidence.ingest.v1`, `document.evidence.package.v1`, `document.ownership.graph.v1`, `document.evidence.resume.v1` |
| Retrieval / internal | `knowledge.vector.search.v1`, `customer.internal.search.v1`, `identity.ocr.extract.v1`, `integration.http.operation.v1`, `function.uc.invoke.v1` |
| Simulator-only today | `investigation.web.search.v1` (public-source format), `policy.kyc.lookup.v1`, `procurement.vendor.lookup.v1`, `procurement.purchase_order.lookup.v1` |
| Model tasks | `model.<domain>.<task>.v<major>`, e.g. `model.kyc.case_assessment.v2`; `model.general.inference.v1` holds the shared model-profile connectors |

Validation: `canonicalCapabilityIdSchema` in `@ehf/contracts`.

### 2. Connector ID

A connector is one way to serve a capability. Its ID **is** the gateway
`adapterBindingId`: `<adapter>:<binding>`.

- Multi-provider adapters use `<provider>:<atlas capability>` as the binding, e.g.
  `wiring:companies-house:business.registry.lookup` (the `wiring` adapter accepts any
  binding matching `^[a-z0-9-]+:[a-z_.]+$`).
- Other adapters keep their native bindings: `opensanctions:sanctions`, `opensanctions:pep`,
  `evidence:ingest|package|ownership|resume`, `skills:<skill_id>` (a library skill on the skill host),
  `pgvector:knowledge.search`, `openrouter:<model profile id>`, `simulator:<name>`.
- Adapters whose bindings are deployment-specific publish a *connector template*
  instead of connectors (see [capability-adapters.md](capability-adapters.md)):
  `databricks-serving:<endpoint>[:chat|:responses]` (`model.general.inference.v1`),
  `databricks-vector:<catalog.schema.index>` (`knowledge.vector.search.v1`),
  `databricks-uc:<catalog.schema.function>` (`function.uc.invoke.v1`) and
  `http-operation:<operation-id>` (`integration.http.operation.v1`).
  An operator registers a concrete connector with `POST /v1/connectors`.
- `integration.apim.operation.v1` is deprecated in favour of the gateway-neutral
  `integration.http.operation.v1` (migration `041_cloud_neutral.sql`).
- `function.uc.invoke.v1` is a deliberate, narrow exception to "no vendor names": a Unity
  Catalog function is a governed function *kind* (catalog-scoped, grant-checked), not a
  provider; a function's business meaning belongs in the capability that a release binds to
  it once it has a stable contract (e.g. `risk.customer.assess.v1` →
  `databricks-uc:main.kyc.risk_score`).
- Provider identity lives in the connector, never in the capability ID. One capability has
  many connectors; a release selects one by setting the capability's `adapterBindingId`.
- Model-profile connectors (`openrouter:<profile>`) are shared by every model task; they are
  registered once under `model.general.inference.v1`, and any `kind: model` capability may
  default to one.

Connector status: `available` (registered; usable in demo/simulation, live use blocked by
`liveBlockers`), `live_ready` (implemented against the real system with no catalog blockers;
deployment credentials may still be required), `quarantined` (must not be connected),
`retired`.

### 3. Agents, skills, model profiles

- Agents `agent.<domain>.<role>.v<major>`, skills (agent playbooks)
  `skill.<domain>.<name>.v<major>`.
- Business skills from the financial-crime catalog keep the catalog's unversioned IDs
  (`entity.resolve`, `screening.adverse_media.execute`; version in a separate `semver`) and
  sit above capabilities: see [business-skills.md](business-skills.md).
- Model profiles `model.<tier>.v<major>` (`model.fast.v1`, `model.standard.v1`, …). A
  profile is a connector binding, not a capability.

### 4. v2 canonical capability model

The provider atlas defines a provider-independent model
(`data-adapters/docs/CANONICAL_EXTERNAL_CAPABILITY_MODEL.md`, registries in
`api-wiring/vendor/atlas/capability-model/`). Its keys are
`<capability_path>.intelligence.<jurisdiction>`, e.g. `business.registry.intelligence.gb`.
The platform adopts it additively, as the semantic layer behind its own IDs:

- **Platform IDs are unchanged.** Plans, packages, policies and migrations keep
  `<name>.v<major>`. The jurisdiction of a v2 key is provider scope, so it lives on the
  connector, never in a capability ID. A capability that needs a specific jurisdiction
  selects a connector whose canonical scope covers it.
- **Capabilities carry their v2 definition** (`canonical` in the catalog): capability path,
  kind (`intelligence`, `operational`, `reference`, `testing`), jurisdiction basis and the
  scope fields it requires, subject types, default action, result family, and
  `notSubstitutableFor`. That last field lists the platform capabilities this one can never
  stand in for, even as a fallback; for example `account.profile.v1` never satisfies
  `account.ownership.verify.v1`, and `screening.watchlist.v1` never satisfies
  `screening.sanctions.v1`. Platform-only capabilities have `canonical: null`.
- **The 19 v2 families with no legacy name** become capabilities `<capability_path>.v1`.
  No catalog binding serves them yet, so they have no default connector.
- **Wiring connectors carry their v2 bindings** (`canonical`): the legacy binding ID, the
  v2 binding IDs, canonical capability IDs and jurisdictions, the migration kind and a
  runtime disposition. All are proposals: coverage, entitlements and jurisdiction approval are
  not established, and the connector's `liveBlockers` say so
  (`canonical_jurisdiction_unresolved` or `canonical_jurisdiction_not_approved`).
- **Corrected bindings are kept but cannot be bound.** The model corrects 13 atlas bindings
  whose source does not provide the catalogued capability, e.g. FinCEN BOI (ownership, not a
  registry) or RENAPO (person identity, not a business registry). Their connectors keep their
  legacy capability ID because the wiring operation still executes that legacy contract. They
  have disposition `migration_required` and blocker `canonical_semantic_correction_pending`;
  they are never defaults, and the gateway refuses to bind them. Quarantined connectors are
  refused the same way.
- **A wiring operation serves only its own capability.** `wiring:<provider>:<name>` can be
  the binding of `<name>.v<major>` only (`gateway.wiring_capability_mismatch` otherwise), so a
  release cannot substitute one contract for another by choosing a different operation.
  `packages/adapters` `kycWiringBindingProblem` implements the rule, and
  `KYC_WIRING_BLOCKED_BINDINGS` mirrors the catalog's non-alias dispositions; a gateway test
  fails if the two drift.

- **Routing lookups by v2 key.** `GET /v1/connectors` also filters by `canonicalCapabilityId`
  (e.g. `business.registry.intelligence.gb`), `jurisdiction` (a connector matches only when its
  canonical scope names that token, so an `unresolved` connector never matches `gb`) and
  `bindable=true` (excludes quarantined, retired, corrected and v2-quarantined connectors). A
  release that needs a jurisdiction-specific source picks its connector this way and binds it
  as the capability's `adapterBindingId`; a plan stays pinned to that one connector.
- **Enforced again by the wiring service.** `data-adapters` `/v1/checks` resolves every check
  to its v2 binding. It returns `MIGRATION_REQUIRED` for a corrected binding, and
  `JURISDICTION_OUT_OF_SCOPE` when a jurisdiction-scoped registry or document source gets a
  subject whose identifiers or registration jurisdiction are foreign (e.g. Companies House for a
  German company). A live route needs an operator-approved concrete jurisdiction on its wiring
  contract. Gateway errors carry these codes (`adapter.kyc_wiring_http_<status>:<CODE>`).
- **Results carry canonical provenance.** The wiring adapter output has `canonical`: the v2
  binding, canonical capability ID, definition ref and jurisdiction (with its resolution status
  and approval reference) that served the check, or null when the service did not report one.

Still open: per-capability v2 input/output schemas, a v2-native request endpoint, and
connectors for the 19 v2-only families. The wiring service serves those families only through
its credential-testing layer, which is not a production route. Institutional approval of
jurisdictions and coverage, and vendor sandbox acceptance, are governance steps, not code. The
platform IDs do not change when any of these land.

## Registry

- `config/connector-catalog.json` is generated by `scripts/sync-connector-catalog.mjs`
  from the atlas (`--source <data-adapters>/api-wiring/vendor/atlas`; `--check` verifies the
  committed file). It records the atlas git revision and the canonical model version, and
  requires the atlas's `capability-model/` registries. Every atlas provider × capability
  record becomes a `wiring:` connector; the platform's own connectors are static entries.
- `defaultConnectorId` per capability: explicit choices first (OpenSanctions direct for
  sanctions/PEP; the KYC v2 bindings for registry, LEI, document verification and
  adverse media), otherwise the best-ranked wiring connector: fixture normalizer on a native
  connector, any fixture normalizer, a provider the wiring service reaches natively, a
  provider with any normalizer, then the rest; ties by connector ID. Quarantined and
  `migration_required` connectors are never defaults.
- Migration `030_connector_registry.sql` creates `harness_gateway.connector_registry`;
  `migrate.ts` seeds it from the catalog additively (an operator's `quarantined`/`retired`
  or `live_ready` is never lowered; an upstream quarantine always applies) and registers each
  catalog capability as a `draft` contract in `harness_gateway.capability_registry` when
  none exists. Migration 030 also deprecates the 015 placeholders
  `screening.adverse-media.search.v1` and `integration.apim.approved-operation.v1` (only
  while unedited) and adds `screening.adverse_media.v1` and `integration.apim.operation.v1`.
- Gateway: `GET /v1/connectors?capabilityId=&adapterId=&providerId=&status=&limit=&cursor=`
  and `GET /v1/connectors/:connectorId` (authority `capability.read`).
  `checkConnectorCatalogConsistency` (adapter-registry.ts) verifies every catalog connector
  names a registered adapter and a binding it accepts, and that every `connectorTemplates`
  entry matches the gateway module that publishes it.
- `POST /v1/connectors` `{adapterId, binding, capabilityId, status?}` registers one connector
  from a template (authority as `POST /v1/capabilities`); it is refused unless the binding
  matches the template's `bindingPattern`, the template serves the capability, and the
  adapter is enabled in this gateway (`GATEWAY_ADAPTERS`).

## Mapping from KYC v2 IDs

Historical: the IDs `domains/archive/kyc-v2-deterministic` used before it moved onto library skills (it now binds
only the connectors in [kyc-adapters.md](kyc-adapters.md) and `skills:` capabilities).
The cdd-agent capabilities (`agents:` connectors) were removed with the agent host.

| Before (domains/archive/kyc-v2-deterministic) | Canonical | Current connector |
| --- | --- | --- |
| `screening.sanctions.search` | `screening.sanctions.v1` | `opensanctions:sanctions` |
| `screening.pep.search.v1` | `screening.pep.v1` | `opensanctions:pep` |
| `screening.adverse-media.search.v1` | `screening.adverse_media.v1` | `simulator:screening.adverse-media.search` |
| `investigation.web.search` | `investigation.web.search.v1` | `simulator:investigation.web.search` |
| `model.kyc.case-assessment.v2` | `model.kyc.case_assessment.v2` | `openrouter:model.standard.v1` |
| `registry.company.lookup.v1` | `business.registry.lookup.v1` | `wiring:companies-house:business.registry.lookup` |
| `ownership.lei.lookup.v1` | `reference.identifier.lookup.v1` | `wiring:gleif:reference.identifier.lookup` |
| `identity.document.verify.v1` | `identity.document.verify.v1` (unchanged) | `wiring:persona:identity.document.verify` |
| `evidence.document.ingest.v1` | `document.evidence.ingest.v1` | `evidence:ingest` |
| `evidence.case.package.v1` | `document.evidence.package.v1` | `evidence:package` |

Renaming changes only IDs: each capability keeps its connector unless a release selects
another from `GET /v1/connectors?capabilityId=…`.

## Consequences

- Swapping a provider is a connector change, never a capability rename, so plans, skills
  and policies that reference a capability stay valid.
- The atlas is the vocabulary authority for KYC; a new KYC capability is added there first,
  as a v2 family, before the platform gives it an ID.
- Semantic substitution is refused at the gateway: a release cannot satisfy one capability
  with a wiring operation catalogued for another, or with a corrected operation.
- Regenerate the catalog when the atlas or `config/model-profiles.json` changes, and
  re-run migrations to seed it.
