# External provider switchboard

The External Capabilities catalog now has a **Providers** section at
`/catalogs/external-capabilities?inventory=provider`.

It adapts the API switchboard concept into provider browsing, configuration proposals and
readiness inspection using EHF components. The existing capability definitions, provider
bindings, model-provider administration and integration delivery surfaces retain their roles.

## User flow

1. Search providers by name, ID, capability or domain, and filter by setup status.
2. Open a provider to inspect Overview, Connections, Capabilities, Readiness and Activity.
3. Choose **Add provider** to configure an existing catalog source or create a custom draft.
4. Add a connection: name and stable ID, environment, adapter, operation, proposed endpoint,
   authentication reference, intended capability mappings, semantic jurisdiction and coverage.
5. Review remaining blockers and save the draft. Reopen a saved connection to edit it.

Unsupported providers can be recorded with **New adapter required**. Missing scope and mappings
remain visible as blockers. No provider endpoint is inferred or called during onboarding.

## Authority and persistence

- `capability.read` permits inventory reads; `admin.write` permits draft creation and editing.
  The BFF requires an interactive session and CSRF protection on mutations. The control API
  independently checks authorization and validates the request.
- Migration `037_external_provider_drafts.sql` adds tenant-owned providers, connection drafts
  and configuration activity under `harness_admin`. All three tables enforce tenant RLS;
  persistence uses explicit tenant predicates and transaction-local tenant context.
- Provider IDs are unique within the tenant and cannot shadow checked-in provider records.
  Connection IDs are unique within a provider. An edit must include the revision originally
  read; conflicting creation or stale edits return HTTP 409 without overwriting newer content.
- Connection writes and activity events commit together. Both catalog quarantine and current
  connector-registry quarantine block new configuration writes.
- Credential fields accept variable names only. Endpoint fields require HTTPS without
  embedded credentials, query strings or fragments. These values are configuration proposals;
  the gateway continues to obtain actual credentials from deployment configuration.

Apply the normal persistence migrations before using this surface with an existing database:

```sh
pnpm --filter @ehf/persistence migrate
```

## Data and API boundaries

The BFF combines the source catalog snapshot, the tenant's saved drafts and all pages of the
gateway connector inventory. Adapter options come from the gateway's advertised connector
templates, with its current enablement and credential state. The control API validates binding
patterns and supported capability IDs against the shipped connector catalog. This also works
in the bundled control API image, which ships `config/` rather than the atlas development tools.

| Experience API | Behavior |
| --- | --- |
| `GET /api/v1/external-providers` | Catalog and custom providers, proposed capabilities, connection drafts, gateway bindings, adapter templates and recent activity |
| `POST /api/v1/external-providers` | Create a custom provider draft |
| `POST /api/v1/external-providers/:providerId/connections` | Create or revise a connection proposal; `expectedRevision: null` creates, an integer checks an edit |

The two mutations relay to the corresponding `/v1/external-providers` control API routes. The
OpenAPI generator, generated client types and mock implement the same operations. The mock
shares the BFF's provider projection and confines its synthetic gateway inventory to mock mode.

**Execution remains deployment-managed.** Saved drafts are never read by invocation routing.
They do not provision credentials, repoint deployed adapters, register executable connectors,
activate a route or change a signed plan. A supported adapter still needs the reviewed
deployment configuration, connector registration and release binding described in
[capability-adapters.md](capability-adapters.md). New transports or normalizers require adapter
implementation first. Multiple independently configured resources per adapter remain a gateway
enhancement; recording several drafts does not add that runtime capability.

Imported connector placeholders remain **Needs setup**. A provider only receives **Gateway
marked ready** when a returned binding has `live_ready` status with no declared blockers.
This is a registry assertion, not a health test or provider acceptance claim. Gateway outages
show unknown readiness while retaining catalog and tenant-draft access; a tenant-registry outage
returns an error rather than substituting an empty registry.

## Verification

- Nine focused tests cover API authority, CSRF, invalid credentials/endpoints, incompatible
  mappings, quarantine, duplicate creation, concurrent revision conflicts, tenant isolation,
  transactional activity, unchanged runtime connector inventory, gateway pagination, degraded
  readiness and mock response contracts. The persistence integration test ran against a
  disposable PostgreSQL 17 database with the repository migrations applied.
- Type checks pass for contracts, UI contracts, persistence, projections, mock, control API,
  BFF and web. The HTTP frontend build and mock-exclusion check pass; the bundled control API
  build passes.
- Browser verification used the live BFF, control API, gateway and disposable PostgreSQL:
  custom-provider creation, supported-adapter configuration, existing-catalog-provider setup,
  the new-adapter draft path, full-reload persistence, revision-2 editing, required-field errors,
  modal keyboard focus and a 390px viewport. Phone-width document overflow was corrected.
- The selected-package suites pass: 383 tests and eight skipped tests, including a final
  rerun of the mock suite (50 tests). The focused run separately exercises PostgreSQL persistence.
- No upstream provider requests or live credential checks were performed.

## Admin editing of capability bindings

Every imported provider binding, including unresolved and quarantined bindings, has an **Edit binding** action in its catalog inspector for users with `admin.write`. Administrators can change the capability assignment, supported actions, semantic jurisdiction, jurisdiction evidence references, coverage status, subject and account countries, issuing authorities, datasets, exclusions, coverage evidence and freshness policy reference. Provider identity and the binding's opaque ID remain stable. Shared capability definitions remain source-owned.

Edits save as tenant catalog revisions and immediately appear in catalog search, domain grouping, inspectors and provider capability lists. The proposed capability key is recalculated from the selected definition and jurisdiction; the jurisdiction basis comes from the definition. Jurisdictions and country scope must belong to the canonical registry. Coverage claims other than unknown require evidence references, and global scope requires jurisdiction evidence. The current registry includes 44 jurisdiction tokens; adding registry entries remains a source change.

Migration `039_external_capability_binding_revisions.sql` stores immutable revisions with tenant RLS, author, timestamp, reason, source digest and full edited scope. The editor shows recent history. Expected revisions prevent conflicting saves, including simultaneous first edits; the source digest prevents saving an editor opened against an older source. Source changes after a saved edit are explicitly flagged for review. A storage failure returns an error rather than silently reverting the catalog to imported values.

`GET` and `POST /api/v1/external-capability-bindings/{bindingId}` load the editor/history and save a revision through the control API. Mutations require CSRF and independently enforced admin authorization. Catalog reads load the latest tenant revisions from the internal control API inventory. The mock uses the same semantic validation and projection.

Editing never enables execution, grants approval or removes quarantine. Reassigning a capability clears claimed request/response mapping validation in the edited projection. Gateway connectors, credentials, release bindings and signed plans remain managed by their existing execution controls. The imported catalog and its provenance remain available as the source baseline.

The UI contract gate retains pinned schema/legacy-route validation and also inspects the current source-policy, provider and binding route modules. New endpoints are therefore checked against their implementations without discarding the historical contract baseline.
