The Harness Control Plane converts reviewed human-authored packages into immutable, evaluated, signed, and releasable runtime authority. It is the system that proves what a KYC workflow may do before the Execution Control Plane runs it. The United States baseline in this document assumes separate non-production and production environments, US data residency, one platform-issued workload identity per service, private networking, and the governance controls described in the foundation and KYC implementation plan. It names no cloud: any Kubernetes cluster or container platform, PostgreSQL, an OCI registry and object storage satisfy it.

In the code today, release trust is the [artifact registry](artifact-registry.md), not a signature: a policy bundle, release manifest or skill bundle is executable only while its recomputed digest has an approved, unrevoked registry entry approved by someone other than its registrant, and no release-signing key exists. Where this design says "signed release", the implementation reads "registry-approved release".

This design deliberately separates three registries. Git stores authoring history and pull-request evidence. The Harness Registry stores executable authority, immutable artifacts, dependency relationships, attestations, releases, and revocations. An enterprise agent inventory records ownership and organizational governance. Only a released and non-revoked HarnessPlan digest authorizes runtime behavior.

# 1. Mission, boundary, and invariants

The Harness Control Plane owns the path from source package to production release. Its output is a signed release envelope that binds a canonical HarnessPlan digest to every dependency needed to execute it: policies, agent and tool definitions, schemas, model profiles, evaluation attestations, container artifacts, migration definitions, and regional constraints.

It does not own live case state, task dispatch, worker leases, evidence collection, or the commit of business effects. Those belong to the Execution Control Plane. It does not provide a document-of-record for customers or cases. It also does not treat a model deployment, container tag, Git branch, or mutable configuration key as runtime authority.

The following invariants are enforced in code and infrastructure policy:

- A runtime starts work only from a released HarnessPlan digest with a valid signature and no effective revocation.
- Compilation is deterministic: the same source tree, compiler digest, dependency lock, and build parameters produce the same canonical plan digest.
- All executable dependencies are immutable and referenced by digest or immutable version. The string `latest` is rejected.
- Promotion changes a small active-release pointer; it never rewrites an artifact.
- Each case pins its plan, policy, schema, model profile, tool, and skill versions. Pointer changes apply to new cases unless an approved migration says otherwise.
- Policy evaluation, data-flow checks, permission derivation, evaluation, approval, signing, and release remain distinct stages with separate evidence.
- A compiler cannot approve its own output, and a release manager cannot create a signature without an approved evaluation attestation.
- Revocation can immediately fence new dispatches and result commits even when a case is pinned to the revoked digest.
- Every allow or deny result is explainable from source location, overlay lineage, dependency version, rule identifier, and evidence.

# 2. Logical architecture

The control plane is an asynchronous set of services around authoritative PostgreSQL records and immutable artifacts. Synchronous APIs accept commands and return operation identifiers. Workers use an outbox in PostgreSQL, signalled with `NOTIFY` and recovered by polling, to advance long-running builds, evaluations, deployments, and releases.

```text
Authors / PRs / CI identity
          |
          v
  ingress -> Control API ----------------------------+
          |                                          |
          v                                          v
  PostgreSQL                                active-release pointers
  packages, builds, dependencies,            (registry projection)
  attestations, releases, approvals                    |
          |                                             v
          +--> outbox --> NOTIFY/poll --> workers --> Runtime resolvers
                          |      |      |
                          |      |      +--> Release manager / revoker
                          |      +---------> Evaluation orchestrator
                          +----------------> Compiler workers
                                              |
                       +----------------------+------------------+
                       v                      v                  v
                object storage          OCI registry      runtime image
                plan bundles            artifacts         digests
                       |                      |                  |
                       +---------- release envelope ------------+
                                        |
                             artifact registry approval
```

| Component | Responsibility | Scale and isolation |
|---|---|---|
| Control API | Package, build, evaluation, approval, release, pointer, and revocation commands; registry queries | Container deployment; min 2 production replicas; internal ingress |
| Compiler worker | Parse, validate, resolve, qualify, compile, canonicalize, and produce unapproved artifacts | Dedicated job; no production data access; pinned compiler image |
| Evaluation orchestrator | Construct evaluation run, dispatch suites, collect metrics and evidence, issue candidate attestation | Separate workload identity; calls test environments only |
| Agent deployer | Build and push OCI artifacts; deploy runtime-host images by digest; capture deployed identifiers | Dedicated identity scoped to approved registries and runtime deployments |
| Release manager | Validate approvals and attestations, register and approve the release, promote pointer, roll back | Separate identity and deployment; production commands require step-up role |
| Revocation service | Publish high-priority revocations and notify runtime resolvers | Minimum two replicas; independent queue and alert path |
| Registry projector | Maintain dependency graph, searchable projections, pointer projections, and regional replicas | Idempotent consumers; rebuildable from the event log |
| PostgreSQL | Authoritative metadata, state machines, locks, outbox, approvals, and audit sequence | Zone-redundant production server with private endpoint |
| Object storage | Immutable source bundles, canonical plans, reports, evidence manifests, SBOMs, and provenance | Versioning, soft delete, immutability policies for released artifacts |
| OCI registry | OCI images and OCI artifact bundles addressed by digest | Private access, replication if required |
| Artifact registry | Approval and revocation of each artifact digest (`harness_control.artifact_registry`) | Approver differs from registrant; append-only events |

# 3. Trust zones and data classification

There are four trust zones. The authoring zone contains developer workstations, Git hosting, pull requests, and CI. Source is untrusted until validation. The build zone compiles and evaluates packages without access to production customer data. The release zone contains artifact-registry approval, release records, and production pointer mutation. The runtime zone consumes signed plans and exposes only minimal status back to the registry.

The build zone uses synthetic and approved de-identified KYC evaluation data. Production PII, identity documents, biometric images, Social Security numbers, and live vendor responses are prohibited. Evaluation evidence contains scenario identifiers, hashes, metrics, redacted traces, and result classifications. Raw prompts or outputs are retained only when the suite explicitly permits them and the storage classification supports them.

| Data | Classification | Allowed stores | Retention baseline |
|---|---|---|---|
| Source package and schemas | Internal | Git, object storage | Repository policy plus released-artifact retention |
| Canonical HarnessPlan | Internal controlled | Object storage, registry cache | Release life plus seven years |
| Registry approval, provenance, SBOM | Audit | PostgreSQL, object storage | Seven years minimum |
| Synthetic evaluation inputs | Internal test | Evaluation bucket | One year or suite policy |
| Redacted evaluation traces | Confidential | Object storage, log backend with field controls | 180 days hot; archive per compliance |
| Approval and release audit | Audit | PostgreSQL and immutable export | Seven years minimum |
| Production customer data | Restricted | Prohibited in control-plane build and evaluation services | Not applicable |

# 4. Authoring model and repository structure

A domain package is the smallest independently versioned source unit. The KYC package owns workflow intent, jurisdiction overlays, policy mappings, schemas, evaluations, and migration definitions. Foundation packages provide shared capabilities, schemas, policies, and profiles. A package manifest declares every dependency and compatibility range; the generated lock file resolves each range to an immutable digest.

```text
/packages
  /foundation
    /capabilities
    /schemas
    /policies
    /model-profiles
    /execution-profiles
  /domains/kyc-us
    harness.yaml
    package.yaml
    /agents
    /skills
    /tools
    /policies
    /schemas
    /prompts
    /workflows
    /evaluations
      /golden
      /adversarial
      /metamorphic
      /fault
    /migrations
    /overlays
      /jurisdiction/us
      /environment/nonprod
      /environment/prod
  /locks
  /compiler
  /registry-api
  /release
  /infra
```

`package.yaml` includes package name, semantic version, owners, risk class, minimum compiler version, dependencies, allowed regions, data classes, evaluation requirements, and compatibility claims. `harness.yaml` is the human-readable entry point. It can reference declared package objects but cannot embed executable code, scripts, network addresses, or secrets.

Every pull request runs formatting, safe YAML parsing, schema validation, dependency resolution, static authority analysis, data-flow analysis, workflow checks, policy tests, schema compatibility checks, and the fast evaluation suite. Protected branches require CODEOWNERS review from the KYC domain and platform control owners when a change expands authority.

# 5. HarnessSpec and HarnessPlan

HarnessSpec expresses intent. HarnessPlan is the normalized runtime contract. A plan has no templates, inheritance, environment substitution, unbounded version ranges, or unresolved names. Every reference is a stable object identifier plus digest. Every action includes its derived permissions, required evidence, allowed data classes, budget, timeout, retry class, and assurance conditions.

```yaml
apiVersion: harness.factory/v1
kind: HarnessSpec
metadata:
  name: kyc-us-individual
  version: 1.4.0
spec:
  workflow: kyc.individual.v3
  overlays: [jurisdiction.us, environment.prod]
  capabilities:
    - identity.document.verify
    - identity.ssn.verify
    - screening.sanctions.search
  policies:
    - kyc.us.acceptance.v7
  assurance:
    minimum: high
  outcomes: [approved, rejected, manual_review]
```

The corresponding plan contains resolved workflow nodes, input and output schema digests, concrete capability providers, policy bundle digest, permissions, evidence producers, side-effect classes, release constraints, and a dependency closure. The compiler serializes the plan using a documented canonical JSON profile, hashes the exact bytes with SHA-256, and stores both bytes and digest. A digest is never calculated over display YAML.

Required plan envelope fields are `planId`, `planDigest`, `packageDigest`, `compilerDigest`, `dependencyLockDigest`, `policyDigest`, `schemaSetDigest`, `modelProfileDigests`, `toolDigests`, `skillDigests`, `evaluationRequirementSet`, `regionSet`, `dataClassSet`, `createdAt`, and `buildProvenanceDigest`. The signed release envelope later adds approval, attestation, signature, release, and activation data.

# 6. Deterministic compiler architecture

> **Implemented today:** the compiler is `harnessc` in `packages/compiler` (`@ehf/compiler`,
> TypeScript). It validates the package rules and the workflow against the Ladder Graph IR
> rules of the pinned `lgir-core` revision, and emits canonical JSON (keys in UTF-8 byte
> order) whose SHA-256 is the plan digest. The control API calls it in-process
> (`compilePackage`); `make compile` and `make fixtures` run its CLI
> (`node --import tsx packages/compiler/src/cli.ts compile <dir> --out <file>`, or
> `validate <dir>`). The plan's `compiler` block records `name`, `version`,
> `lgirCoreRevision` and `compatibilityVersion`, and their digest feeds
> `buildProvenanceDigest`. `packages/compiler/src/plans.test.ts` pins every committed plan
> byte for byte. The rest of this section is the target design.

The compiler runs as a pinned OCI image with a read-only root filesystem, no general internet access, a fixed locale and timezone, and explicit resource limits. It accepts a source-bundle digest, dependency-lock digest, compiler digest, target overlay set, and build nonce used only for operation correlation. Time, nonce, worker hostname, and database identifiers cannot enter canonical output.

| Stage | Input and output | Enforced rules |
|---|---|---|
| 1. Safe parse | Source bytes to typed syntax tree | Duplicate keys, aliases, custom tags, executable YAML, invalid UTF-8, excessive nesting, and oversized fields fail |
| 2. Schema validate | Typed objects | API version, required fields, enum values, ownership, risk class, and naming rules |
| 3. Resolve dependencies | Manifest and lock to immutable closure | No `latest`, branches, mutable tags, unresolved ranges, hidden transitive dependencies, or digest mismatch |
| 4. Apply overlays | Base objects to resolved objects plus lineage | Fixed precedence; broadening authority requires explicit entitlement and approval class |
| 5. Qualify capabilities | Abstract capability to provider/version | Region, assurance, data class, availability, certification, and interface compatibility |
| 6. Compile policy | Policy source to executable decision bundle | Deterministic rule set, rule IDs, obligations, denial reasons, and test coverage |
| 7. Derive permissions | Workflow plus providers to least privilege | Each node gets explicit commands, resources, scopes, data classes, and effect classes |
| 8. Analyze data flow | Graph edges and schemas | Residency, purpose, retention, model-input, telemetry, and vendor-transfer restrictions |
| 9. Analyze workflow | Directed graph | Cycles, missing producers, unreachable outcomes, orphan nodes, unbounded fan-out, and invalid compensation fail |
| 10. Check evidence | Outcome and policy obligations | Every claim and decision has an acceptable evidence producer and schema |
| 11. Check assurance | Agent, model, tool, skill combination | Requested assurance cannot exceed weakest certified dependency |
| 12. Check migration | Existing released plans and proposed definitions | State mapping, evidence reuse, policy compatibility, rollback, and cohort constraints |
| 13. Bound execution | Plan graph | Time, cost, token, call, retry, concurrency, and side-effect budgets |
| 14. Canonicalize | Fully resolved object | Stable key order, numeric and string encoding, set ordering, and null rules |
| 15. Digest and package | Canonical bytes and reports | Create plan digest, manifest, authority report, graph, and compile attestation candidate |

The compiler emits diagnostics as stable machine-readable records: code, severity, object path, source file and line, overlay lineage, dependency identity, rule identifier, and remediation hint. A future compiler version may add diagnostics but cannot silently reinterpret an existing API version. Semantic changes require a new compiler compatibility version and replay of affected packages.

```text
compile(request):
  source = verify_blob_digest(request.source_digest)
  lock = verify_dependency_lock(request.lock_digest)
  ast = safe_parse(source)
  objects = schema_validate(ast)
  closure = resolve_immutable(objects, lock)
  resolved, lineage = apply_overlays(closure, request.overlay_set)
  qualified = qualify_capabilities(resolved)
  policy = compile_policy(qualified)
  permissions = derive_least_privilege(qualified, policy)
  assert_data_flows(qualified, permissions)
  assert_workflow_graph(qualified)
  assert_evidence_and_assurance(qualified)
  assert_migration_compatibility(qualified)
  bounded = attach_budgets(qualified, permissions)
  bytes = canonical_json(bounded)
  return sha256(bytes), bytes, diagnostics, dependency_graph
```

# 7. Overlay resolution and explainability

Configuration resolves in this fixed order: platform, domain, jurisdiction, business unit, tenant, environment, and case policy context. Later overlays may tighten timeouts, budgets, data access, eligibility, or required evidence. An overlay that broadens a capability, data class, side effect, provider, outcome, or budget must declare `authorityExpansion`, cite an entitlement, and receive the approval class associated with the expanded risk.

The compiler writes an origin map for every resolved field. An explain request for `/workflow/nodes/document_check/timeoutSeconds` returns the base value, each overlay operation, the final value, the authority classification, and source locations. The release UI uses this data to show semantic differences between two plan digests rather than a raw text diff.

Overlay operations are restricted to `set`, `remove`, `appendUnique`, `intersect`, and `tighten`. Arbitrary patch scripts and environment-variable interpolation are prohibited. Collection ordering rules are part of the schema. A conflict without an explicit resolution rule fails compilation.

# 8. Registry object model

The Harness Registry stores immutable objects and mutable lifecycle records. Immutable objects include source bundles, compiled plans, policy bundles, schemas, tools, skills, prompts, model profiles, execution profiles, evaluation suites, capability definitions, migration definitions, SBOMs, and provenance statements. Lifecycle records include builds, evaluation runs, attestations, approvals, releases, active pointers, deprecations, and revocations.

| Object | Stable identity | Required metadata |
|---|---|---|
| PackageVersion | package name + semantic version + digest | Owner, risk class, source commit, dependency lock, compiler minimum |
| HarnessPlan | plan digest | Package digest, compiler digest, overlay set, dependency closure, authority report |
| CapabilityVersion | capability name + version + digest | Interface schemas, providers, regions, assurance, data classes, certification |
| ToolVersion | tool name + version + digest | Commands, effects, schemas, scopes, network destinations, image digest |
| SkillVersion | skill name + version + digest | Inputs, outputs, required tools, evidence, budgets, evaluation suite |
| ModelProfileVersion | profile name + version + digest | Deployment class, region, data policy, allowed tasks, fallback rules |
| EvaluationAttestation | attestation ID + content digest | Subject digests, suite digests, metrics, thresholds, environment, expiry |
| Release | release ID | Plan digest, approvals, attestation, signature, state, cohort, region |
| ActivePointer | scope + generation | Release ID, plan digest, activation time, ETag, prior generation |
| Revocation | revocation ID | Subject digest, scope, effective time, reason, replacement, issuer |

Artifact metadata never substitutes for content verification. A reader obtains the expected digest from the signed envelope, downloads the bytes, computes the digest locally, verifies the signature and trust chain, and checks revocation status before caching.

# 9. PostgreSQL schema and state machines

Use one PostgreSQL server per environment boundary, with separate databases or schemas for registry metadata and operational jobs. Production uses zone-redundant high availability, private access, passwordless authentication (`PGPASSFILE` or TLS client certificates), customer-managed backup controls where required, and geo-redundant backup to the approved paired US region.

```sql
create table artifact (
  artifact_digest text primary key,
  artifact_type text not null,
  media_type text not null,
  uri text not null,
  size_bytes bigint not null,
  created_at timestamptz not null,
  provenance_digest text not null,
  metadata jsonb not null
);

create table build (
  build_id uuid primary key,
  package_digest text not null,
  compiler_digest text not null,
  lock_digest text not null,
  overlay_set_digest text not null,
  state text not null,
  plan_digest text,
  diagnostics_uri text,
  idempotency_key text not null unique,
  row_version bigint not null default 0,
  created_at timestamptz not null,
  updated_at timestamptz not null
);

create table dependency_edge (
  subject_digest text not null,
  predicate text not null,
  object_digest text not null,
  edge_metadata jsonb not null,
  primary key (subject_digest, predicate, object_digest)
);

create table evaluation_attestation (
  attestation_id uuid primary key,
  subject_digest text not null,
  suite_set_digest text not null,
  result_digest text not null,
  status text not null,
  issued_at timestamptz not null,
  expires_at timestamptz,
  environment_digest text not null,
  signature_uri text
);

create table release_record (
  release_id uuid primary key,
  plan_digest text not null,
  attestation_id uuid not null,
  state text not null,
  signature_uri text,
  cohort jsonb not null,
  activation_time timestamptz,
  previous_release_id uuid,
  idempotency_key text not null unique,
  row_version bigint not null default 0
);

create table active_pointer (
  scope_key text primary key,
  generation bigint not null,
  release_id uuid not null,
  plan_digest text not null,
  activation_time timestamptz not null,
  etag uuid not null,
  prior_release_id uuid
);

create table revocation (
  revocation_id uuid primary key,
  subject_digest text not null,
  scope jsonb not null,
  effective_at timestamptz not null,
  reason_code text not null,
  replacement_digest text,
  issued_by text not null,
  signature_uri text not null,
  unique (subject_digest, effective_at)
);
```

Build states are `QUEUED`, `RESOLVING`, `COMPILING`, `SUCCEEDED`, `FAILED`, and `CANCELLED`. Evaluation states are `QUEUED`, `PROVISIONING`, `RUNNING`, `ASSESSING`, `PASSED`, `FAILED`, `EXPIRED`, and `CANCELLED`. Release states are `DRAFT`, `VALIDATED`, `COMPILED`, `EVALUATED`, `APPROVED`, `SIGNED`, `RELEASED`, `CANARY`, `PRODUCTION`, `DEPRECATED`, and `REVOKED`. State changes use compare-and-swap on `row_version`, append an audit event, and write an outbox record in the same transaction.

# 10. Dependency graph and blast-radius analysis

Every artifact is a vertex and every typed dependency is an edge. Predicates include `COMPILED_FROM`, `DEPENDS_ON`, `USES_POLICY`, `USES_SCHEMA`, `USES_TOOL`, `USES_SKILL`, `USES_MODEL_PROFILE`, `PROVIDES_CAPABILITY`, `EVALUATED_BY`, `DEPLOYED_AS`, `SIGNED_BY`, `SUPERSEDES`, and `MIGRATES_FROM`.

The graph supports release gates and incident response. A proposed tool revocation queries all plans that transitively depend on its digest, then identifies active pointers, pinned cases, regions, tenants, and migration paths. A model-profile change identifies evaluation suites and certifications that must be rerun. A schema change identifies consumers, producers, stored evidence, and migration compatibility.

PostgreSQL adjacency tables and recursive queries are sufficient initially. Materialized transitive-closure projections are maintained for common blast-radius queries. Adopt a graph database only if measured query latency or relationship volume justifies it; the source of truth remains the append-only registry model.

# 11. Evaluation and certification

Evaluation determines whether a precise dependency closure is fit for a release scope. It does not certify a name or mutable endpoint. An attestation binds the plan digest, compiler digest, policy digest, tool and skill digests, model profile and deployment class, suite digests, dataset digests, evaluator image digest, environment digest, metrics, thresholds, exceptions, and expiry.

| Layer | Purpose | Release gate example |
|---|---|---|
| Schema and contract | Validate types, compatibility, required evidence, and error contracts | Zero breaking consumer errors |
| Tool | Command allowlists, side effects, retries, timeouts, redaction, and failure mapping | 100 percent restricted-command denial |
| Skill | Input/output, evidence, deterministic rules, and bounded model use | Required evidence completeness at threshold |
| Agent | Delegation, stop conditions, prompt-injection resistance, and escalation | No unauthorized tool call in adversarial set |
| Policy | Golden allow/deny/obligation decisions | 100 percent high-risk policy cases pass |
| Workflow | Paths, outcomes, compensation, and manual review | All reachable terminal outcomes covered |
| Golden KYC | Known identities, documents, sanctions, PEP, fraud, and edge cases | Domain-approved accuracy thresholds |
| Adversarial | Prompt injection, forged evidence, schema confusion, and tool coercion | Zero critical control bypasses |
| Metamorphic | Equivalent input transformations preserve required outcome | No unexplained high-severity variance |
| Fault | Vendor timeout, throttling, stale data, partial response, and region failure | Safe retry or manual-review behavior |
| Replay and shadow | Compare candidate with approved history using de-identified fixtures | Difference budget within approved bounds |
| Canary | Restricted production cohort with guardrails | Error, latency, cost, and outcome guardrails hold |

External evaluation tooling may run structured agent tests, but the Harness evaluation manifest remains the authoritative suite definition and is versioned with the package. The control plane records the runtime image digest and execution-profile digest as dependencies rather than treating a mutable deployment name as authority.

An attestation expires when its declared date is reached or any bound dependency is revoked. Changes classified as documentation-only may reuse an attestation only if the compiler proves that the canonical plan digest and evaluated dependency closure are unchanged.

# 12. Release trust and provenance

After approvals and a passing attestation, the release manager builds a canonical release envelope. It contains the plan digest, complete dependency manifest digest, attestation digest, provenance digest, release scope, and activation constraints. Its digest is registered in the artifact registry and approved by an identity other than the registrant; readers recompute the digest from content before asking the registry. Revocation is per artifact, so revoking one release never disables others ([artifact registry](artifact-registry.md)). No release-signing key exists to protect, rotate, or compromise.

The keys that do exist authorize individual invocations, not artifacts: the runtime grant, execution envelope, integration envelope and delegated skill envelope. Under `ENVELOPE_SIGNER=private_key` each is an RSA key mounted as a file for its one signer; verifiers hold only public keys.

Compiler images, evaluator images, and tool images are stored in an OCI registry by digest and published with provenance and an SBOM (`scripts/publish-images.sh`); deployments pull by digest.

The provenance statement records Git commit, repository, source bundle digest, CI workflow identity, compiler image digest, dependency lock, build parameters, timestamps, SBOM digest, and output digest. Timestamps appear in provenance, never in canonical plan content.

# 13. Approval and separation of duties

Approval policy is derived from semantic change classification. A policy restriction, bug fix without authority change, or non-executable documentation update has a lower approval set than a new side effect, expanded data class, new vendor, new model task, weaker evidence requirement, or broader release cohort.

| Role | Allowed actions | Prohibited combination |
|---|---|---|
| Package author | Propose source and respond to diagnostics | Cannot approve own release |
| Domain owner | Approve KYC behavior and evaluation thresholds | Cannot approve an artifact they registered |
| Policy owner | Approve policy semantics and authority expansion | Cannot operate compiler identity |
| Security approver | Approve new data flow, network destination, or effect class | Cannot promote without domain approval |
| Evaluation service | Produce signed result candidate | Cannot waive failed threshold |
| Release manager | Validate gates, approve the release in the registry, and promote | Cannot modify source or attestation |
| Emergency revoker | Revoke a digest and fence runtime | Cannot create a replacement release alone |
| Auditor | Read source-to-release evidence | No mutation permissions |

Identity-provider groups, surfaced in the OIDC roles claim, map to these roles. Services use platform-issued workload identity. Human production roles are granted just in time, require multifactor authentication and justification, and have short activation duration. Database roles use stored procedures or narrowly scoped permissions; the API never connects as server administrator.

# 14. Release, canary, promotion, and rollback

A release is a transaction across authoritative metadata and a small pointer projection. It never copies or modifies plan content.

1. Freeze the candidate dependency closure and verify all content digests.
2. Confirm the required evaluation attestation is passing, unexpired, and bound to the exact closure.
3. Confirm required human and machine approvals and their separation-of-duty rules.
4. Verify image digests, SBOM, provenance, vulnerability policy, region, and assurance constraints.
5. Create the canonical release envelope and approve its digest in the artifact registry.
6. Insert the `RELEASED` record and audit event.
7. Create a canary scope with an explicit cohort, time window, and guardrails.
8. Publish the pointer using a compare-and-swap on the pointer generation.
9. Observe runtime telemetry and business outcome guardrails.
10. Expand cohort by new pointer generation until production scope is reached.

A pointer projection holds active pointer generations for low-latency resolution. This design permits a pointer change only after the registry release transaction. Runtime auto-refresh cannot alter an in-flight case's authority; the case record continues to use its pinned digest.

Rollback creates a new pointer generation that references a previously approved, non-revoked release. It does not delete the bad release or restore a database backup. The action is idempotent, records the observed prior generation, verifies compatibility with cases that have not started, and preserves a complete audit chain.

# 15. Revocation and emergency control

Revocation takes precedence over pinning. It is used for compromised invocation keys, unsafe policies, vulnerable tools, invalid evidence producers, defective models, regulatory orders, or critical evaluation escapes. Deprecation prevents new adoption after a date; revocation immediately changes execution eligibility.

The revoker writes a revocation record in PostgreSQL (an artifact-registry revocation for artifacts) and in immutable object storage, signals resolvers with `NOTIFY`, updates the regional revocation projection, and triggers blast-radius analysis. Runtime resolvers poll and listen. Maximum revocation staleness is 60 seconds; a resolver unable to refresh beyond that bound fails closed for new high-assurance dispatches.

At runtime, revocation is checked when resolving a new case, before each command dispatch, and before committing any externally meaningful result. The response can stop, place the case in manual review, or migrate it to an approved replacement plan according to the revocation directive. Emergency migration never silently reinterprets prior evidence.

Invocation-key compromise has a dedicated runbook: roll the affected signer's mounted key and key ID, distribute the new public key to verifiers first, revoke outstanding grants and envelopes by fencing affected runs, and verify every runtime has advanced its revocation generation. Artifact compromise is a per-artifact registry revocation.

# 16. APIs and events

The control API exposes versioned internal APIs. Every mutating command requires an idempotency key, an authenticated OIDC or workload identity, correlation ID, and explicit expected version where a mutable lifecycle record is involved.

| Endpoint | Semantics | Key response |
|---|---|---|
| `POST /v1/packages:ingest` | Store verified source bundle and manifest | Package digest and operation ID |
| `POST /v1/builds` | Compile a source and lock for an overlay set | Build ID |
| `GET /v1/builds/{id}` | Read state, diagnostics, outputs, and lineage | Build representation |
| `POST /v1/evaluations` | Evaluate an exact plan dependency closure | Evaluation run ID |
| `POST /v1/approvals` | Record scoped approval over a subject digest | Approval ID |
| `POST /v1/releases` | Assemble, verify, and register candidate release | Release ID and envelope digest |
| `POST /v1/releases/{id}:promote` | Create new active-pointer generation | Pointer generation |
| `POST /v1/scopes/{scope}:rollback` | Point to approved prior release | New pointer generation |
| `POST /v1/revocations` | Revoke artifact, release, key, or capability scope | Revocation ID and generation |
| `GET /v1/resolve` | Resolve approved release for scope and context | Release envelope and cache metadata |
| `GET /v1/graph/impact` | Return transitive dependents and active use | Impact report |
| `GET /v1/explain/{digest}` | Explain compilation, overlays, authority, and release gates | Structured explanation |

Event subjects use `harness.control.<aggregate>.<event>`, including `build.succeeded`, `evaluation.passed`, `release.approved`, `pointer.activated`, `artifact.deprecated`, and `subject.revoked`. Payloads carry identifiers, digests, generations, scopes, correlation data, and schema version. They do not carry package bytes or secrets.

# 17. Concurrency, idempotency, and failure recovery

The database is the authority for command acceptance and state. A mutating API transaction inserts or reuses an idempotency record, changes aggregate state with an expected version, appends the audit event, and writes the outbox message. Duplicate requests return the original result. Queue delivery is at least once; consumers use inbox deduplication by event ID.

Compiler and evaluation jobs use leases with fencing tokens. A stale worker may upload content-addressed bytes but cannot publish a build or attestation after its lease is superseded. Artifact upload uses temporary paths, digest verification, and atomic registration. Orphan temporary objects are swept after a retention interval.

Promotion uses compare-and-swap on the database pointer generation. If the projection update fails after the registry transaction, reconciliation completes it. A resolver validates the generation against the registry and never trusts a pointer that names a release absent from the registry cache.

Dead-lettered outbox events are monitored. Replay is safe because events are facts and consumers are idempotent. Operators repair the cause, record an incident reference, and replay by event ID range; they do not edit consumer projections directly.

# 18. Deployment topology and configuration

The initial production topology uses one approved US primary region and one US recovery candidate, subject to service availability and organizational region policy. Non-production uses separate accounts or projects, networks, identities, keys, registries, storage and databases. No production key or registry approval exists in non-production.

| Component | Production baseline | Configuration |
|---|---|---|
| Network | Segmented per environment | Private DNS; controlled egress through an egress proxy or firewall; no worker public IPs |
| Ingress | Private ingress in front of the control API | OIDC JWT validation, mTLS for selected automation, quotas, schema validation |
| Container platform | Kubernetes cluster or equivalent | Zone spread where supported; internal ingress; one workload identity per service; min replicas for APIs and revoker |
| PostgreSQL | Sized after load test; also the work queue | Private access, zone-redundant HA, PITR, passwordless auth, TLS |
| Object storage | Bucket per artifact class | Private access, versioning, soft delete, immutability for release evidence |
| OCI registry | Registry per environment | Private access, digests only, retention and quarantine workflow |
| Secret manager | Per environment and purpose | Invocation signing keys and provider secrets mounted as files |
| OTLP collector and backends | Per environment | Alert rules, immutable audit export |

Key configuration values are maintained in IaC and policy, not in this narrative. Initial sizing is API min/max replicas 2/20, compiler concurrent jobs 10, release manager 2 replicas, revoker 2 replicas, PostgreSQL 4 to 8 vCores after load testing. Load tests determine final values.

# 19. Network and identity flows

Inbound authoring automation reaches the control API over the approved private or enterprise ingress path and authenticates with a federated OIDC token. The Control API verifies the token itself, reauthorizes the action and records the identity. Workers present their projected workload identity tokens and use private paths to PostgreSQL, object storage, the OCI registry and mounted secrets.

Egress rules allow only named destinations: deployment control APIs, approved package mirrors, and vulnerability services. Compiler jobs have no general outbound internet. Dependency artifacts are pre-fetched through an approved mirror and verified by digest. DNS resolution is private and centrally logged.

Each service gets its own workload identity. The compiler can read source and dependency artifacts and write candidate artifacts, but cannot approve, promote, or read production secrets. The evaluator can invoke test deployments and write evaluation evidence. The release approver can approve a registered digest it did not register; it cannot alter source or pointers. The projector can update pointer projections but cannot approve releases.

# 20. CI/CD and infrastructure pipeline

Infrastructure and control-plane software use independent pipelines. Infrastructure is Terraform, OpenTofu, Pulumi or equivalent, maintained outside this repository, with reviewed modules, environment parameter files, static security scanning, what-if or plan review, policy checks, and drift detection. Application images are built once, scanned, given provenance and an SBOM, and promoted by digest across environments.

```text
pull request
  -> format + unit + schema + policy tests
  -> safe compile + authority diff
  -> IaC lint/security/what-if where applicable
  -> build compiler/API/worker images
  -> SBOM + provenance + vulnerability gate
  -> deploy nonprod by digest
  -> integration + fault + replay + performance tests
  -> publish candidate release evidence
  -> production approval
  -> deploy production by same image digests
  -> smoke test + observe + automatic rollback threshold
```

The domain release pipeline is separate:

```text
commit -> source bundle -> schema validation -> deterministic compile
       -> authority/data-flow/dependency reports -> policy and contract tests
       -> golden/adversarial/metamorphic/fault evaluations
       -> OCI image digests -> EvaluationAttestation
       -> approvals -> artifact-registry approval -> canary pointer
       -> shadow/guardrails -> staged production promotion
```

The CI system uses OIDC workload federation; long-lived client secrets are prohibited. Production jobs target a protected environment and run from an allowlisted reusable workflow. The pipeline submits commands to the Control API rather than writing database rows, storage objects, or pointers directly.

# 21. Observability, audit, and service objectives

All services emit OpenTelemetry traces, metrics, and structured logs with operation ID, build ID, release ID, plan digest prefix, package, environment, region, stage, state transition, and result code. Logs never include secrets, raw evaluation data, prompts, documents, or unrestricted model output.

| Objective | Proposed target | Alert condition |
|---|---|---|
| Registry resolve availability | 99.95 percent monthly in primary region | Multi-window burn-rate alert |
| Cached resolution latency | p95 under 50 ms | 15-minute p95 above 75 ms |
| Uncached resolution latency | p95 under 300 ms | 15-minute p95 above 500 ms |
| Revocation propagation | 99.9 percent under 60 seconds | Any production resolver exceeds 60 seconds |
| Promotion projection | 99 percent under 30 seconds | Registry and pointer-projection generations diverge for 60 seconds |
| Compile queue start | p95 under 2 minutes | Backlog age above 5 minutes |
| Determinism | 100 percent identical digest on replay | Any mismatch pages platform engineering |
| Audit completeness | 100 percent lifecycle transitions linked to identity and evidence | Reconciliation detects a gap |

Dashboards cover build throughput and failures by diagnostic code, evaluation pass rate and flaky tests, authority expansions, approval age, registry approval errors, pointer generations, release cohort, revocation lag, registry cache age, outbox lag, dead-letter depth, dependency blast radius, and infrastructure saturation.

Audit events use a monotonic aggregate sequence and hash chaining in immutable daily exports. A daily reconciliation verifies PostgreSQL records against object-storage manifests, artifact-registry entries, pointer generations, and image digests.

# 22. Resilience and disaster recovery

The design distinguishes runtime continuity from authoring continuity. Runtime resolvers hold verified releases and revocations in regional caches so a control-plane outage does not stop already authorized work inside cache bounds. New high-assurance work fails closed when the revocation view is stale beyond 60 seconds.

PostgreSQL uses zone-redundant HA and tested point-in-time restore. Object storage uses the approved redundancy option plus immutable release evidence. The OCI registry replicates if the runtime recovery region requires local pull. Pointer projections are reproducible from the registry, and queued work lives in PostgreSQL itself.

Proposed control-plane targets are RPO at most 5 minutes for mutable lifecycle metadata and RTO at most 60 minutes for authoring and release operations. Revocation capability receives a stricter recovery path: pre-provisioned regional service, replicated registry state, and runbook target of 15 minutes. New approvals may remain unavailable during a regional event; existing approved releases continue to resolve.

Quarterly exercises restore PostgreSQL to an isolated environment, reconstruct projections, verify a sample of artifact digests against the registry, rotate a test invocation key, revoke a plan, promote a prior release, and prove runtime cache behavior. Recovery is complete only when registry, pointer, revocation, image, object-storage and audit generations reconcile.

# 23. KYC-specific control-plane rules

The United States KYC package defines customer types, policy outcomes, evidence requirements, and vendor capabilities without embedding vendor credentials or production endpoints. Initial customer types are individual and sole proprietor; legal-entity KYB remains a separate package or explicitly versioned extension.

Required KYC compile rules include:

- An approval or rejection outcome must cite policy rules and evidence schemas; unreasoned model output cannot be a decision basis.
- Sanctions, PEP, adverse media, identity, SSN, document, liveness, fraud, and address capabilities declare jurisdiction, data class, freshness, assurance, and fallback behavior.
- Restricted identifiers cannot be sent to a model profile unless that exact purpose and region are allowed.
- Each vendor command declares whether it is read-only, externally visible, billable, or irreversible.
- A manual-review path is required for inconclusive evidence, vendor unavailability beyond retry budget, policy conflict, and assurance shortfall.
- Policy bundles distinguish deterministic eligibility rules from model-assisted extraction or summarization.
- Evidence reuse across plan versions requires matching schema, freshness, provenance, and migration policy.
- No released path can produce `approved` when a mandatory evidence producer is absent or revoked.

Golden suites cover known document types, supported and unsupported states, name and address variations, SSN mismatch, duplicate identity, sanctions and PEP matches, deceased identity, synthetic identity indicators, expired documents, and vendor partial responses. Adversarial suites attempt evidence forgery, prompt injection inside OCR text, tool-name spoofing, schema smuggling, and manipulation of policy citations.

# 24. Implementation plan

| Phase | Duration | Deliverables and exit criteria |
|---|---|---|
| 0. Decisions and threat model | 2 weeks | ADRs for authority, canonicalization, artifact trust, registries, regions, tenancy, data classification, and failure posture; approved threat model |
| 1. Platform foundation | 3 weeks | Accounts, networks, private DNS, ingress, container platform, workload identity, PostgreSQL, object storage, OCI registry, secret manager, OTLP collector, policies, and IaC validation |
| 2. Registry core | 4 weeks | Artifact, package, build, dependency, audit, idempotency, outbox, and query APIs; backup and reconciliation tested |
| 3. Compiler MVP | 6 weeks | Safe parser, schemas, dependency lock, overlays, capability and policy compiler, permission and graph analysis, canonicalization, diagnostics, deterministic replay |
| 4. Evaluation system | 5 weeks | Suite manifest, runner adapters, evidence store, threshold engine, attestation format, KYC golden/adversarial/fault suites |
| 5. Registry approval and release | 4 weeks | Provenance, SBOM binding, artifact registry approval, release state machine, pointer projection, canary and rollback |
| 6. Runtime image integration | 3 weeks | Image digest verification, runtime-host deployment by digest, immutable identifiers, deployment attestation, runtime resolver contract |
| 7. Revocation and impact | 3 weeks | Dependency projection, impact API, registry revocation, 60-second runtime propagation, compromised-key runbook |
| 8. KYC pilot | 4 weeks | Individual KYC package, evaluation thresholds, canary cohort, shadow comparison, production readiness review |
| 9. Hardening and DR | 3 weeks | Performance, fault injection, restore, regional recovery, audit evidence, SLO alerts, operational handoff |

The phases overlap after interfaces stabilize. A practical minimum team is one control-plane lead, two compiler and registry engineers, two platform engineers, two evaluation/domain engineers, one security engineer, one SRE, and fractional KYC policy and compliance owners.

# 25. Prioritized engineering backlog

| ID | Work item | Acceptance criterion |
|---|---|---|
| HC-01 | Define canonical HarnessPlan JSON profile | Independent implementations produce identical bytes and digest for conformance fixtures |
| HC-02 | Implement safe YAML parser limits | Malicious tags, aliases, duplicate keys, oversized and deeply nested inputs fail with stable codes |
| HC-03 | Build immutable dependency resolver and lock | All transitive dependencies resolve by digest; mutable references fail |
| HC-04 | Implement overlay engine and origin map | Every resolved field has source lineage; unauthorized expansion fails |
| HC-05 | Build capability qualifier | Region, data, assurance, interface, certification, and availability constraints produce deterministic choice or error |
| HC-06 | Compile policy and obligations | Golden allow, deny, and obligation cases are complete and explainable |
| HC-07 | Derive least-privilege node permissions | Runtime can validate every command against compiled authority |
| HC-08 | Implement data-flow and workflow analysis | Residency violations, missing producers, cycles, unsafe effects, and unreachable outcomes fail |
| HC-09 | Create registry API and artifact verification | Metadata cannot register until content digest and provenance verify |
| HC-10 | Add evaluation manifest and attestation | Attestation binds complete closure, metrics, thresholds, environment, and expiry |
| HC-11 | Verify image digests and provenance | An image without approved digest and provenance cannot build or release |
| HC-12 | Integrate artifact registry release approval | Only a fully gated release envelope can be approved, and never by its registrant |
| HC-13 | Implement pointer generations and reconciliation | Promotion and rollback are atomic, idempotent, and recover after projection failure |
| HC-14 | Implement registry revocation | All production resolvers enforce revocation in under 60 seconds |
| HC-15 | Build dependency impact query | Active releases and pinned cases are returned for any transitive dependency |
| HC-16 | Deliver KYC pilot package | Individual KYC passes policy, golden, adversarial, fault, shadow, and canary gates |

# 26. Verification strategy

Unit tests cover canonicalization, schema validation, overlay operators, dependency resolution, policy compilation, permission derivation, graph algorithms, release envelopes, state transitions, and idempotency. Property tests generate equivalent source orderings and assert identical canonical bytes. Fuzz tests target YAML parsing, schemas, graph size, and diagnostic stability.

Integration tests use real PostgreSQL, object storage, OCI registry and secret-manager instances in an isolated test environment. They verify private DNS, workload identities, digest checking, approver restrictions, outbox replay, pointer reconciliation, and runtime resolution. Runtime adapters test image digest capture and invoke behavior.

End-to-end tests exercise commit through production-like canary: compile a KYC package, run evaluations, approve, register, promote, start a case with a pinned digest, promote a successor, prove the first case remains pinned, revoke a shared tool, and verify both new dispatch and result commit are fenced.

Fault injection terminates compiler workers, duplicates and reorders messages, expires leases, blocks object storage, fails registry approval, makes runtime deployment time out, introduces a database failover, and delays revocation events. Success means no invalid release is approved, no pointer advances without an authoritative release, no stale worker publishes, and every failure is observable and recoverable.

Performance tests measure dependency graphs up to the forecast three-year size, burst pull-request builds, concurrent evaluation suites, resolve load, and mass-revocation impact. Production readiness requires capacity at twice expected peak with target latency and no exhausted connection, queue, or API limits.

# 27. Operational runbooks

The initial runbook set covers compile backlog, deterministic digest mismatch, failed evaluation infrastructure, flaky suite quarantine, registry approval failure, expired attestation, promotion conflict, registry/pointer divergence, image digest mismatch, runtime deployment failure, database failover, outbox backlog, dead-letter replay, stale resolver cache, artifact corruption, plan revocation, dependency mass revocation, invocation-key compromise, and regional recovery.

Every runbook states detection, customer and release impact, immediate containment, diagnostic queries, permitted repair operations, rollback or revocation criteria, evidence to preserve, escalation contacts, and completion checks. Direct database or pointer edits are excluded. Emergency actions go through the revocation or release APIs and preserve the audit chain.

# 28. Architecture decisions and definition of done

The first architecture decision records approve PostgreSQL as lifecycle authority, object storage and an OCI registry as content-addressed artifact stores, a pointer projection rebuilt from the registry, the artifact registry as the trust anchor, canonical JSON plus SHA-256 as plan identity, at-least-once signalling with idempotent consumers, digest-pinned cases, and revocation precedence.

The Harness Control Plane is ready for the KYC production pilot when all of the following are demonstrated:

- Two clean environments can be created from IaC with private access, workload identity, policy, logging, backup, and no manual resource configuration.
- Independent compiler replays produce byte-identical plans and stable diagnostic codes.
- A release cannot be approved without exact passing attestation, required approvals, verified provenance, acceptable SBOM and vulnerability status, and non-revoked dependencies.
- Runtime resolution validates registry approval, digest, scope, pointer generation, time constraints, and revocation.
- Promotion, rollback, reconciliation, and duplicate delivery pass fault tests.
- Revocation fences production dispatch and commit within 60 seconds and reports complete blast radius.
- KYC golden, adversarial, metamorphic, fault, shadow, and canary gates meet domain-approved thresholds.
- Restore and regional exercises meet RPO and RTO, and all authoritative and projected generations reconcile.
- Security, KYC policy, privacy, platform, SRE, and audit owners approve the evidence package and operational ownership.

The result is a control plane in which editable configuration becomes executable only after deterministic compilation, explicit authority analysis, evidence-backed evaluation, independent approval, registry-anchored trust, controlled promotion, and continuously enforceable revocation.
