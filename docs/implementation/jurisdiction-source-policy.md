# Jurisdiction source authorization

Implemented 2026-11-08. The [catalog review and design plan](jurisdiction-source-policy-plan.md) supplies the rationale and research. This document describes the implemented behavior and deployment sequence.

External capability authorization now combines independently approved source bindings, institutional access, jurisdiction policies and case context. Technical connector readiness alone cannot authorize a source. Acquisition, evidence acceptance and subsequent runtime use have separate decisions.

## Authority model

| Artifact | What its approval establishes |
| --- | --- |
| `source-binding` | Exact capability, effective connector digest, provider/product/operation, source jurisdiction and its semantic basis, subject coverage, datasets, fields, evidence roles, approved endpoints and data flow. Wiring bindings also pin the upstream contract digest. |
| `source-access` | Access basis, legal basis, consent requirement and institutional entitlement for the exact binding, booking entities, products, purposes and datasets. |
| `source-policy` | Applicable institutional jurisdictions and explicit allow, deny or review rules, including evidence requirements, recipients, freshness, retention and redistribution. |
| `source-context` | Reviewed tenant/case/plan facts: institution, booking entity, branch, product, purpose, applicable regimes, subject countries, registration/issuer/account jurisdictions, consent and fact provenance. |

All four artifacts are strict, content-addressed contracts. Registration is a candidate state. Approval uses the existing tenant-scoped artifact registry and requires a different actor from the registrant. Artifacts and decision records are immutable; revocation stays in the registry. No catalog entry, sandbox coverage file or test fixture creates an approval.

The context is explicitly authored and reviewed in this version. It is not automatically inferred from caller-supplied country strings. Registration, issuer and account authority remain distinct from residence, dataset authority and institutional policy geography. The source-jurisdiction vocabulary follows the existing atlas, with the explicit `us_de` subdivision; subject countries use ISO alpha-2 codes.

The deterministic evaluator lives in [policy-engine](../../packages/policy-engine/src/source-policy.ts), identified as `ehf-source-policy-v1`. It requires coverage of every applicable regime, applies explicit denies first, intersects permitted roles and recipients, unions required datasets and fields, and uses the tightest freshness and retention bounds. Missing facts, conflicting obligations, expired artifacts and incomplete evidence never produce `ALLOW`. These source policies execute in TypeScript; the existing OPA case-gate policy bundles retain their separate execution path.

## Enforcement

1. **Compilation and admission:** a package may supply `sourceAuthorization` with approved policy digests and an exact binding/access pin for each external candidate. Internal capabilities must be declared explicitly for compiler completeness. Gateway adapter classification remains authoritative about whether a call crosses an external boundary. Admission verifies the pinned artifacts.
2. **Run creation:** `sourceContextDigest` binds an approved context to the tenant, case and admitted plan in the run transaction. The digest is immutable and part of the start request's idempotency identity.
3. **Acquisition:** the gateway applies the same source boundary to direct, skill-selected and delegated external invocations. It reloads current approvals, connector readiness and digests, records the decision, and denies before provider transport when scope is absent or invalid.
4. **Transport:** per-invocation asynchronous scope prevents concurrent tenants from sharing authorization. Each provider fetch rechecks current authority and the actual HTTPS endpoint; redirects are refused. Endpoint, processing/storage region, subprocessor and transfer requirements must agree across binding, access and policy.
5. **Evidence release:** a successful external response needs a separate use decision. Business evidence must provide a complete structured observation of actual datasets, fields, role and observation time. Acquisition permission does not supply this observation. Processing-only results may attest computation without claiming datasets or business verification. Governed outputs require object envelopes to preserve lineage.
6. **Reuse:** gateway receipt replay and governed runtime selections recheck current approvals and evidence age. Canonical record provenance and predecessor outputs carry decision references. A provider response withheld after a use denial completes a denied receipt; retrying that invocation does not repeat the provider effect.

Production security profiles and `RELEASE_ENVIRONMENT=production` require source authorization for external calls and reject synthetic adapters. Development plans without `sourceAuthorization` retain the existing compatibility coverage path. Governed development plans use the new boundary too. Platform-internal skill and financial-crime bridges retain their existing controls; their delegated external dependencies go through the gateway boundary.

## Deployment and first approved scope

1. Apply [migration 038](../../packages/persistence/migrations/038_jurisdiction_source_policy.sql) before deploying the updated services. It adds tenant-isolated immutable artifact/decision storage, the immutable run context pin and the receipt decision link. It seeds no approvals.
2. Select one concrete institution, booking entity, product, purpose and source operation. Review its existing catalog definition, semantic jurisdiction, entitlement, dataset coverage, evidence mapping and processing route. Proposed/unresolved or quarantined catalog entries cannot be promoted by a policy alone.
3. Construct the binding using the effective connector object/digest returned by the registry. For `wiring:` connectors, obtain `upstream_contract_digest` from wiring readiness and pin it as `upstreamContractDigest`. Approved endpoints must include the wiring service and the actual upstream source route. Changes require new reviewed artifacts and plan pins.
4. Validate, register and independently approve binding, access and policy artifacts. Put their digests into the domain package, compile it and admit the resulting plan. For example, the package field has this shape; values below are placeholders, not executable grants:

   ```json
   {
     "sourceAuthorization": {
       "policyDigests": ["<approved-policy-sha256>"],
       "internalCapabilityIds": ["<internal-capability-id>"],
       "bindings": [{
         "capabilityId": "<capability-id>",
         "connectorId": "<connector-id>",
         "bindingDigest": "<approved-binding-sha256>",
         "accessDigest": "<approved-access-sha256>"
       }]
     }
   }
   ```

5. Register and independently approve a case context referencing that plan digest and reviewed case facts. Start the run with `planDigest`, `input`, an idempotency key and `sourceContextDigest`. Policy Studio's **Sources** tab supports artifact validation, registration, independent approval/revocation, live eligibility checks, simulations and run decision history. The run-start sheet accepts the context digest. The artifact matrix currently lists the latest 500 records.
6. Inspect acquisition and evidence-use decisions for the approved scope. Expand to another source or jurisdiction through new reviewed artifacts. Existing sandbox attestations and the [synthetic test fixture](../../packages/contracts/test-fixtures/source-policy.json) are examples only.

### Wiring transport proof

Live wiring admission and every queued worker attempt require a short-lived gateway proof binding the exact raw submission, tenant, operation and approved source scope. Configure `SOURCE_AUTHORIZATION_SIGNING_KEY` only in the capability gateway and `SOURCE_AUTHORIZATION_VERIFY_KEY` in wiring. Supported pairs are an RSA private/public PEM pair (`RS256`) or a shared secret of at least 24 characters (`HS256`), supplied through the deployment's existing secret mechanism. These are distinct from execution-envelope keys. The proof has issuer `ehf-source-policy`, audience `ehf-kyc-wiring` and a maximum lifetime of 60 seconds; it carries authority references, not the subject payload. It is a transport attestation and cannot approve an artifact.

The adapter renews authority by idempotently resubmitting the same business request while polling. Wiring excludes the rotating proof from business idempotency, preserves the provider record/artifact and refuses renewal against a changed binding or upstream contract. An expired queued proof places the check in `authorization_required`; fresh authority resumes the held operation without discarding native progress. Ambiguous live executions retain the existing reconciliation behavior. Live batch submission requires individual scoped requests, and the native vendor-testing API is disabled in production.

An approved wiring contract can declare an exact native response mapping:

```json
{
  "source_evidence_mapping": {
    "dataset_ids_pointer": "/metadata/datasets",
    "observed_at_pointer": "/metadata/as_of",
    "complete_pointer": "/metadata/complete",
    "field_pointers": { "registered_name": "/company/name" },
    "role": "primary"
  }
}
```

Pointers must reflect the actual provider response; observation timestamps use UTC ISO date-time strings. This mapping is part of the pinned upstream contract. Missing or invalid mapping does not manufacture evidence. The direct OpenSanctions adapter also requires its configured dataset to be within the approved binding; it does not currently produce the structured native freshness observation needed to release primary business evidence under a governed policy.

## API surface

The interactive BFF exposes these control API operations under `/api`, using the existing principal, action and CSRF checks:

| Method/path | Purpose |
| --- | --- |
| `GET /v1/source-policies/artifacts?kind=…` | Tenant artifact matrix and approval state |
| `POST /v1/authoring/source-policies/compile` | Strict candidate validation and digest; no authority |
| `POST /v1/source-policies/artifacts` | Register `{artifact, expectedDigest}` |
| `POST /v1/source-policies/artifacts/:kind/:digest/approve` | Independent registry approval |
| `POST /v1/source-policies/artifacts/:kind/:digest/revoke` | Revoke with `reasonCode` |
| `POST /v1/authoring/source-policies/simulate` | Network-free candidate evaluator |
| `POST /v1/source-policies/eligibility` | Preview approved run scope; optionally recheck a stored evidence decision |
| `GET /v1/source-policies/decisions/:runId` | Append-only acquisition, transport and use audit |

The gateway's `POST /v1/evidence/use` is workload-only and requires the existing execution envelope, current fence, tenant/case/plan scope and pinned binding. It returns authorization decisions; it does not grant raw evidence read access. The mock UI permits inspection but rejects source-policy mutations with `live_backend_required`, preventing simulated approvals from looking real.

## Verification and scope

Tests cover multi-regime decisions, semantic source geography, exact entitlement and transport scope, independent approval, tenant isolation, revocation, direct/selected/delegated calls, receipt replay, evidence reuse, incomplete/stale/overbroad evidence, signed wiring admission and expired worker renewal. Database tests apply the migration and seed catalogs in an isolated Postgres instance. Browser checks cover the Sources surface at desktop and narrower widths, invalid candidate handling and accessibility.

This change supplies runtime enforcement and authoring tools. It does not grant a real institution permission to use any vendor. Reviewed institutional facts and actual source contracts remain inputs. Retention bounds prevent further governed use after expiry; physical deletion scheduling and integration of every non-runtime export/read consumer remain separate work.
