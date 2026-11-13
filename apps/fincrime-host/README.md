# Financial crime skills

A Python reference library implementing all **222 canonical skill IDs**, with instructions, schemas, field-scoped context, deterministic domain logic, governed provider contracts and a portable HTTP host. The current release uses jurisdiction-neutral synthetic policies and test sources. It is ready for local code integration; production source/model/policy qualification is separate.

## Run locally

Release `0.5.0` contains 229 skills with `0.3.0` skill contracts. Edit procedures in [skill-content](skill-content/README.md); generated `SKILL.md` files include domain guidance and integrity checks. See the [catalog foundation](../../docs/implementation/skill-catalog-implementation.md) for immutable versions and production qualification.

Use Python 3.12 or later:

```sh
python3.12 -m venv .venv
.venv/bin/python -m pip install -r requirements-dev.lock
.venv/bin/python -m pip install --no-deps -e .
.venv/bin/fc-skills validate
.venv/bin/fc-skills demo
.venv/bin/python -m pytest -q
```

The demo executes a 33-step synthetic KYB path (29 canonical steps plus four EHF document wrappers), pauses for approval, uses a separate synthetic reviewer identity, resumes, records the disposition and schedules review. It also runs a profile-bound agent that progressively loads selected skill instructions. Required EDD stops this example for workflow handoff; the template never bypasses it. No regulator, customer or external service is contacted.

## Integrate the library

```python
import asyncio
from financial_crime import synthetic
from financial_crime.execution import Executor
from financial_crime.store import Store

async def main():
    store = Store()  # SQLite reference repository; use a trusted file path for persistence
    synthetic.seed(store)
    executor = Executor(store, [synthetic.profile()], synthetic.router())
    request = synthetic.invocation("ownership.interest.calculate")
    result = await executor.run(request, synthetic.principal())
    print(result.status, result.payload)
    store.close()

asyncio.run(main())
```

Real applications inject trusted `Principal` identities, version-pinned `AgentProfile`s, a repository implementing [Repository](src/financial_crime/repositories.py), and capability providers implementing [Provider](src/financial_crime/providers.py). HTTP payloads cannot grant permissions. Every invocation is admitted against actor, profile and tenant policy, and every provider is entitled before receiving data.

`Record.synthetic` defaults to false. This release rejects consequential effects on non-synthetic context; production effects require a separately qualified release and policy/provider integration.

`AgentRunner` accepts a trusted planner implementation with `choose()` and `prepare()` methods. Selection sees a compact skill index; preparation receives only the selected instructions and parameter schema. The bundled `ScriptedPlanner` proves control flow without model inference. Actual model clients must be configured by the hosting application under its approved model/data policy.

Release **0.3.0** retains skill API **0.2.0** and context schema **2.0.0**. The [EHF integration](docs/ehf-integration.md) adds six business profiles, six TaskSpecs, twelve context products and a proposal-only execution bridge. See the [contract and migration guide](docs/schema-contracts.md) before upgrading from 0.1.0.

## Packages and context

- [skills/](skills/) contains 222 skill packages: `SKILL.md`, manifest, input/output schemas and context declaration. Entry points live in the importable Python package and share primitives.
- [catalog/catalog.json](catalog/catalog.json) is the executable registry. Exact skill versions, instruction hashes and code hashes are pinned; arbitrary runtime code installation is prohibited.
- [catalog/context-matrix.json](catalog/context-matrix.json) declares business fields and scoped policy consumption per skill. [Reverse consumers](catalog/context-consumers.json) identify skills affected by source-field changes.
- [schemas/](schemas/) contains runtime, context and workflow JSON Schemas. The original 81 context names are inventoried; all 87 canonical context types and all 444 skill input/output contracts use closed, named shapes. Source-specific additions use versioned, namespaced extensions.
- [profiles/](profiles/) and [workflows/](workflows/) contain an executable profile and explicit workflow DAG. This initial bundle contains one exact version per skill.

The compiler performs tenant/purpose/field checks, bitemporal selection, source freshness, explicit missingness and object/model budgets. It persists immutable manifests and exact references; `Executor.replay()` reconstructs retained inputs and scoped policy. Structured transaction calculations require a complete dataset window and do not use token-truncated samples. Model budgets are character limits in this reference implementation; model-specific token accounting belongs in the model adapter.

Run `make catalog` after changing implementation contracts or instructions, and `make check` to detect stale generated artifacts and validate behavior. The wheel includes all skill resources and runs independently of the source checkout.

## Document field contracts

The [document field catalog](docs/document-field-catalog.md) defines **293 document/evidence types**, **236 shared fields**, and **21 typed nested structures** covering the document universe discussed for individuals, businesses, trusts, EDD and ongoing reviews. Each type has a field inventory, key review fields, source-grounded extraction instructions and a closed JSON Schema. These are draft field contracts, independently versioned at `0.1.0`; no OCR/model accuracy or jurisdictional sufficiency is implied.

```sh
python -m kyc_documents.cli list --coverage 07_ownership
python -m kyc_documents.cli show shareholder_register
python -m kyc_documents.cli schema trust_deed
python scripts/build_document_catalog.py --check
```

The package also installs `kyc-documents`. Read the [design and integration guide](docs/document-field-design.md), [context mapping and gaps](docs/document-context-mapping.md) and [synthetic examples](examples/documents/README.md). This field-contract sidecar does not change or automatically dispatch the existing skill APIs. Providers and context assemblers consume it through explicit integration.

## Container hosting

The container runs the [skill.execution.v1 host](src/financial_crime/runtimes/skill_host.py), the HTTP host EHF's capability gateway calls for library skills. It serves `GET /healthz` (unauthenticated), `GET /v1/bundle`, `POST /v1/skills/{skill_id}/executions`, `GET /v1/skills/executions/{execution_id}` and `POST /v1/skills/executions/{execution_id}/cancel`. Every route except `/healthz` requires the capability gateway's identity in `Authorization: Bearer ...`; request bodies never grant permissions. Identity follows the platform's `WORKLOAD_AUTH` setting ([workload_identity.py](src/financial_crime/runtimes/workload_identity.py)): under `static_token` (development) the gateway presents its development token, which the host knows as `SKILL_HOST_AUTH_TOKEN`; under `workload_identity` (required by `SECURITY_PROFILE=production`) the host verifies the gateway's projected token against the issuer and accepts only the subject `WORKLOAD_IDENTITIES` names as `capability-gateway`, and presents its own projected token when calling the gateway back.

```sh
docker build --platform linux/amd64 -t financial-crime-skills:local .
docker run --rm --platform linux/amd64 -p 127.0.0.1:8090:8090 \
  -e SKILL_HOST_AUTH_TOKEN="$(openssl rand -hex 24)" financial-crime-skills:local
python scripts/smoke_container.py --image financial-crime-skills:local
```

| Variable | Meaning |
| --- | --- |
| `SKILL_HOST_AUTH_TOKEN` | Development (`static_token`): required, at least 16 characters; the gateway's token. The host refuses to start without it. No default is supplied. |
| `SKILL_HOST_GATEWAY_TOKEN` | Development: the token the host presents when a skill's provider calls go back to the platform gateway. |
| `SKILL_HOST_PORT` / `SKILL_HOST_BIND` | Listen port (default `8090`) and address (default `0.0.0.0`). |
| `SECURITY_PROFILE` / `WORKLOAD_AUTH` | `development`/`static_token` (default) or `production`/`workload_identity`. Production refuses static tokens. |
| `WORKLOAD_IDENTITY_ISSUER`, `WORKLOAD_IDENTITY_AUDIENCE` | Workload identity: the issuer and audience of service tokens (e.g. the cluster's service-account issuer). |
| `WORKLOAD_IDENTITY_JWKS_URI` / `WORKLOAD_IDENTITY_JWKS_FILE` | Optional issuer keys; discovered from the issuer when neither is set. Asymmetric algorithms only (`WORKLOAD_IDENTITY_ALGORITHMS`, default `RS256,PS256,ES256`). |
| `WORKLOAD_IDENTITIES` | JSON map of logical service to token subject, shared by every platform service. |
| `WORKLOAD_TOKEN_FILE` | The host's own projected token, re-read as the platform rotates it. |

The host owns no data and no authority: everything a skill reads arrives in the request, and the platform validates and commits what it returns. It refuses to start when the bundle lock does not match the installed catalog. Production integration that embeds the library directly must inject an application-owned shared repository and validated identity/model/provider adapters; session-local SQLite is a reference backend, not shared cross-session case storage. No cloud resources are provisioned by this repository.

## Supported behavior and qualification

Deterministic implementations cover matching features, ownership math, text parsing/source spans, captured registry/list queries, weighted risk, rule evaluation, complete-window transaction analytics, graph/typology detection, workflow state, approval controls and evidence checks. Specialist fraud, translation, entity extraction and forensics use exact-request provider recordings in local tests; absent providers return evidence gaps.

Document parsing currently supports decoded text pages. Matching heuristics and synthetic detectors are uncalibrated. Evidence/citation validation does not establish semantic truth. Review dispatch and retention emit governed commands for host delivery; the bundled outbox driver implements local filing receipts and uncertain-acknowledgment reconciliation. No live provider coverage, biometric accuracy, regulatory threshold, real filing acceptance or cloud deployment is claimed.

See [implementation status](docs/implementation-status.md), [integration guide](docs/integration-guide.md), [context design](docs/context-specification.md), [build plan](docs/skill-implementation-plan.md) and [per-skill design targets](docs/skill-design-backlog.md).
