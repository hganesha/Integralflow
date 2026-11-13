# Experience UI gap closure

2026-11-10 · source implementation

The remaining unavailable Experience API operations are implemented or explicitly retired.
This change integrates with current main's service-backed health reporting and runtime admission
controls. It does not certify a production tenant, provider, identity deployment or runtime.

| Former exclusion | Current behavior |
| --- | --- |
| Platform overview | Paginates authorized plan/run records; all-time counts, a defined 24-hour cost window and a bounded active-run list. Unavailable metrics are null. |
| System health | Retains main’s dependency reporting and control-plane operational telemetry; unavailable worker metrics remain explicit. |
| Trace reader | Checks control-plane tenant ownership before reading a configured Jaeger query endpoint; normalizes recorded spans and removes credential-shaped tags. |
| Mission Control | Authorized run counts and human-work queue statistics, with queue bounds and agent attribution scope disclosed. |
| Ownership workbench | Canonical Entity, OwnershipGraph, OwnershipInterest and BeneficialOwner records. Source assertions are not promoted to verified ownership; no threshold is invented. |
| Contradiction comparison | Resolves referenced claims/extracted assertions. Missing comparison records are disclosed; no invented resolution command is offered. |
| Screening workbench/comparison | Canonical screening executions, hits, entities and watchlist entries. Incomplete coverage, unknown freshness and absent recommendations remain explicit. No universal clearance. |
| Lineage | Traces recorded disposition/recommendation support through actual references. A recommendation is labelled as such; absent support remains a gap. |
| Recorder / entry / causality | Merges authorized case/run events and human decisions, preserves raw records and failed ledger verification, and uses explicit causation identifiers for edges. |
| Document extraction rerun | Reuses the existing document-only plan validator and version-bound case authorization. Starts a run only after the case service accepts the authorization. |
| Runtime administration (2) | Retains main’s service-backed stop/resume admission, revision checks and active-run policy. |
| Generated presentation proposal (3) | Retired. No shipped screen consumed these unowned APIs. Canonical views continue using the authored presentation registry. |

The final route audit also corrected two older contract mismatches: authoring skill requests
relay to the existing agent-instruction registry, and ledger verification maps the case service's
`valid` field to the UI's `verified` field without losing a failed sequence. The obsolete signing-key
revocation form now targets exact artifact-registry entries on Releases, matching the platform's actual trust
anchor and existing `release.revoke` authorization. Operators can reach it on Published processes without administration access.
The route validator includes modular draft-test
routes and recognizes Fastify's escaped literal colons.

Uploaded originals remain browsable before parsing. They have zero known parsed pages and no
extracted assertions until a successful document run records them.

The optional Compose `web` profile builds `Dockerfile.platform`, serves the HTTP SPA and BFF
on the same origin, and connects them to the platform APIs. It uses the same edge credential
already accepted by the local upstream services. `docker compose --profile web up --build web`
exposes the service on loopback port 4200 by default. Set `WEB_PORT` and `BFF_PUBLIC_ORIGIN`
together when changing the browser-facing port/origin.

## Configuration

| Setting | Purpose |
| --- | --- |
| `BFF_JAEGER_QUERY_URL` | Fixed internal Jaeger query base URL, including any base path. HTTPS is required under the production security profile. |
| `BFF_TRACE_TOKEN_FILE` | Optional mounted bearer credential for the trace reader; never forwarded to the browser. |
| `BFF_TRACE_VIEWER_URL` | Optional browser-facing viewer base URL. |
| `BFF_DOCUMENT_PLAN_DIGEST` | Admitted, released document-only extraction plan, prepared using `scripts/prepare-document-extraction.ts`. A general KYC plan is refused. |
| `BFF_DOCUMENT_SOURCE_CONTEXT_DIGEST` | Optional approved source-context pin; required when the deployment's run admission/source policy requires it. Upstream checks tenant and policy scope. |

Document reruns require `case.read`, `evidence.read`, `case.review`, `run.start`, a CSRF session
and an idempotency key. The BFF resolves evidence and original bytes from the tenant-scoped
document version, records `DOCUMENT_EXTRACTION_AUTHORIZATION`, then admits the run with the
same authorization request key. Runtime and commit paths enforce the existing document scope.
Missing configuration returns a specific conflict; it does not simulate extraction.

The trace adapter targets Jaeger's [JSON query API](https://www.jaegertracing.io/docs/2.23/architecture/apis/).
It bounds response bytes/span counts and rejects redirects, wrong trace IDs and parent cycles.
Other trace backends require an adapter; exporting OTLP alone does not provide query access.

## Remaining boundaries

Metrics need their owning observability sources. Human-work aggregation/history is bounded
to 500 queue items and says so at the boundary; event/run scans refuse overflow rather than
presenting truncated totals. No causal edge is inferred from timestamps. Missing lineage support and screening entries stay
visible. Ownership thresholds/effective ownership and accepted screening dispositions need
released policy/business projections; this change does not manufacture them.

Context ingestion, retrieval and policy extensions remain governed by their component plans;
Experience API route coverage does not imply those product capabilities are qualified.

Production still needs shared session storage or sticky routing, durable skill-host execution,
provider/document qualification and the operational readiness evidence in the production plan.

## Verification

- All 199 supported non-mock operations register at their client URLs, with no blanket
  unavailable exclusions. Registration does not certify upstream health.
- BFF: 23 files / 75 tests pass, including tenant rejection, pagination loops, failed ledger
  verification, trace-store authorization, document version/CSRF checks and stable rerun retries.
- 37 browser checks pass across evidence, screening, assurance, overview, runs, traces,
  unknown worker metrics and operator artifact revocation; relevant checks include automated
  serious/critical accessibility assertions.
- The Document Studio HTTP browser journey passes after integration, covering configuration,
  annotated source spans, schema inspection, export and mobile accessibility. Its three
  control-API tests also pass.
- The mock GET response-validity matrix passes.
- Web, BFF and control API type checks pass. HTTP SPA and bundled BFF builds pass; the HTTP
  bundle scan finds no mock code. Compose configuration validates with the `web` profile.
- Contract validation: 1,135 checks, zero failures; Redocly lint is clean and generated outputs
  are current. Previously acknowledged source/schema drift remains explicit.

Browser acceptance uses a fixed local mock build. BFF coverage includes controlled upstreams
and real HTTP transport; these checks do not qualify a deployed provider or production tenant.
