# Intelligence switchboard implementation

The administrative switchboard is available at `/platform/intelligence` for principals with `admin.read`. It combines current providers, immutable model profile revisions and administered runtime targets with persisted intelligence configuration proposals. `admin.write` permits proposal revisions and offline configuration checks. The BFF requires a human session and CSRF; the control API independently checks authority.

## Implemented experience

- Bindings: four canonical reasoning slots, available model profiles, current runtime targets, named runtime proposals, typed ML inference proposals, Document Intelligence, System 1 Decisions and MCP servers/tools. Fast/standard/deep profiles are explicit suggestions; judge is separate from XHigh.
- Connections: current administered model providers and an adapter coverage catalog distinguishing implemented transports from planned adapters.
- Common adapters: six versioned canonical protocol families, provider mappings and honest implementation/lifecycle status.
- Access and trust: proposal identities, audiences, environment-variable references and network boundaries. No credentials are entered or resolved by this surface.
- Activation: exact-revision configuration reports and explicit unresolved execution/approval gates.
- Operations: inventory availability and truthful unknown states for live health and consumer impact.
- Activity: proposal/check audit events; details include immutable revision history, digests and before/after field changes.

The four-step editor supports AWS, Google Cloud, Databricks, direct APIs, enterprise gateways and private resources. Reasoning effort is separate from tier intent. Runtime forms include immutable revision, lifecycle and callback configuration. ML forms include versioned feature/output/preprocessing/calibration references, score range/direction, horizon, maximum feature age and abstention behavior.

The catalog is cloud-neutral: there is no vendor-specific runtime or identity mode. Runtimes are `local_http`, `hosted_http` (any HTTPS endpoint the platform dispatches to with a platform token or workload identity) and `databricks` (OAuth M2M); a hosted runtime on any cloud is a `hosted_http` target. Workload authentication is `workload_identity` (a federated token for a named service and audience) or a platform token.

## Document Intelligence and System 1 Decisions

Document bindings use `document.*` aliases and the `document.analysis.v1` common adapter. The editor captures operation (OCR/layout/extract/classify/split), processor/model/API versions, canonical output schema, requested features, locale, processing mode, byte/page limits, timeout/poll budget, logical result-store reference, field confidence threshold and evaluation evidence. Source/page provenance is mandatory; missing confidence and partial results require review. Multipage Textract proposals fail offline readiness checks when configured synchronously. Provider feature combinations and actual limits remain target-specific conformance checks.

System 1 bindings use `decision.*` aliases and `decision.system1.v1`. They configure atomic questions over typed state, choice labels or ordered score levels, model/version, state/question/output artifacts, maximum questions, latency budget, confidence source/evidence, evaluation and decision-use policy. Primitives are choice, score, Noul (truth probability) and box. Choice/score labels must be unique and bounded. Probability, rubric score and confidence remain separate. Timeouts, invalid answers, unknown labels and unmet confidence thresholds abstain. No automatic reasoning fallback or business action is authorized.

The provider catalog includes AWS Textract, Databricks document parsing, LlamaIndex/LlamaParse, Google Document AI, private document endpoints and enterprise gateways. System 1 targets include TypeSafe Jev, OpenAI structured decisions, Databricks and private/gateway endpoints. Every new provider is a **configuration target requiring implementation**, including document integrations already present elsewhere in the repository: this control plane does not claim those separate paths implement its canonical adapter.

`packages/contracts/src/intelligence-adapters.ts` provides browser-safe canonical request/result schemas, document job states and provenance rules, typed System 1 answers, and a bounded-answer/confidence check. These are reusable adapter contracts and validation utilities, not live SDK transports. System 1 is the exception. A choice answer may carry `probabilities` over the declared options, and a batch result abstains with an explicit reason. One validator, `validateSystem1Answers`, checks every provider's answer. Three transports implement the contract: OpenRouter Decisions (switchboard `jev`), and Azure AI Foundry's OpenAI and Anthropic APIs (`azure_decision`). They pass one conformance suite and are served by the gateway's `decisions` adapter ([capability-adapters.md](capability-adapters.md#system-1-decisions-decisions)). Activation through this control plane is still unavailable. A binding is a gateway connector pinned in a compiled plan. Provider serializers, entitlement checks, polling workers, cancellation and evidence verification remain implementation work. Common adapter IDs and lifecycle families are returned by the inventory and shown under **Common adapters**. The same enterprise connection/authentication, revision, audit and offline-check machinery serves all six classes.

Provider semantics are based on [TypeSafe's introduction](https://docs.typesafe.ai/introduction), [TypeSafe confidence](https://docs.typesafe.ai/confidence), [OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs), [Textract asynchronous processing](https://docs.aws.amazon.com/textract/latest/dg/async.html), [Databricks document parsing](https://docs.databricks.com/aws/en/agents/agent-bricks/document-parsing), and [LlamaParse](https://developers.llamaindex.ai/llamaparse/parse/). OpenAI entries describe schema-constrained LLM adapters; they do not assert a separately marketed native System One model or calibrated confidence.

## Persistence and setup

Apply the normal persistence migrations before using the live page:

```sh
pnpm --filter @ehf/persistence migrate
```

Migration `040_intelligence_candidates.sql` creates tenant-scoped heads, append-only revisions, immutable check reports and activity events under `harness_admin`. All tables enforce tenant RLS; persistence also uses explicit tenant/environment predicates and transaction-local tenant context. A mutation and its audit event commit atomically. Expected-revision checks reject competing updates with HTTP 409.

The control API selects environment from `EHF_ENVIRONMENT`, then `RELEASE_ENVIRONMENT`, then `local`. Request bodies cannot override it. Credential fields accept environment variable names only. Endpoints require HTTPS without embedded credentials, query parameters or fragments. Unknown fields are rejected. Behavior proposals use `intelligence.binding.v1`; legacy model-profile shapes and digest resolution are unchanged. See the [contract decision](intelligence-control-plane-adr.md).

| Experience API | Behavior |
| --- | --- |
| `GET /api/v1/intelligence` | Current scoped configuration, proposals, ten most recent revisions per binding, last 100 activity events, latest reports, adapter catalog and gateway inventory availability |
| `POST /api/v1/intelligence/candidates` | Create/revise an immutable proposal with `expectedRevision` and reason |
| `POST /api/v1/intelligence/bindings/:bindingId/checks` | Persist offline checks against an exact current revision |

The BFF joins the control API inventory with gateway adapter availability. A registry failure returns an error; gateway failure preserves the inventory with unknown gateway state. The generated OpenAPI/client and mock implement the same operations. The mock uses the shared proposal schema and configuration-check function through a browser-safe package entry point.

## Execution boundary and remaining work

Proposals never mutate provider records, model profiles, runtime settings or executable connectors. Offline checks never contact the configured endpoint, fetch credentials or invoke a business operation. Reports always state `executionVerified: false`, with identity/network/live-contract/activation evidence unknown. Editing creates a new revision and invalidates the prior revision's report, even if the content reverts to an earlier digest.

Production workload verification workers, resource discovery, evidence expiry, independent approvals, signed deployment handoff, acknowledged activation/rollback/suspension, invocation-generation snapshots and authoring eligibility selectors are not implemented by this increment. Planned AWS/Google/ML and document transports, and the System 1 targets other than `jev` and `azure_decision`, are configurable proposals, not executable adapters. Consumer impact is explicitly unavailable rather than inferred from the globally scoped authoring registry.

These are the remaining Phases 3–6 of the [delivery plan](intelligence-control-plane-plan.md). Activation must remain unavailable until those paths are implemented and qualified against the target environment. Existing administration/deployment/release authority continues to control current execution configuration.

## Verification

Focused tests cover legacy schema compatibility; unsafe URLs/secrets; class/tier IDs; transport configuration; unknown verification gates; score semantics; CSRF and roles; optimistic concurrency; tenant/environment isolation; immutable history; exact-revision evidence invalidation; and unchanged runtime/profile configuration.

The migration and persistence/control API integration tests run against a disposable PostgreSQL database with repository migrations applied. Browser verification uses the live BFF, control API and that database, including creation, full-reload persistence, offline checks and a subsequent revision. Contract generation, affected-package type checks and the HTTP frontend build/mock-exclusion check are part of the validation workflow. Live cloud authentication or inference is not claimed by these tests.

## MCP server and tool registration

The sixth category, **MCP servers & tools**, stores `mcp.*` server bindings with the `mcp.tools.v1` common contract. Register remote services on AWS, Google Cloud, Databricks, SaaS, private networks or an enterprise gateway. A private stdio target references a reviewed deployment launch profile; the page never accepts raw commands/arguments, resolves credentials or starts processes.

The configuration pins transport (Streamable HTTP, legacy HTTP+SSE, or managed stdio), protocol/server versions, catalog artifact/digest, identity mode, OAuth scopes, policy/evaluation references, timeout, concurrency and result-size budget. Delegated OAuth uses the existing issuer/resource audience plus client-ID reference; per-user authorization and token lifecycle belong to the execution identity broker. Stdio uses its workload launch profile and process principal rather than HTTP authorization.

Each of up to 50 exact tool names maps to a unique versioned EHF capability, input/output schema references, effect class and approval mode. An output contract is required by EHF even when the provider does not publish `outputSchema`. No wildcard tools or duplicate mappings are accepted. Catalog discovery is represented as a proposal requiring a worker and review; saving does not perform discovery or imply a verified catalog. Tool-list/schema changes block eligibility. The shared registration lookup denies unpinned catalogs, mismatched catalog digests and unregistered tools; a matching registration still requires normal capability grants and approval policy.

All MCP adapters remain implementation targets. Offline checks flag missing server/catalog/tool/policy metadata and identity mismatches; discovery, execution-network verification and activation stay unknown. The same immutable revisions, tenant/environment isolation, CSRF, human admin authority and audit history cover MCP. Request limits allow the bounded multi-tool configuration; no business tool is invoked by registration or checks.

These choices follow the existing [MCP governance architecture](agent-runtime-capability-gateway.md) and official [MCP tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools), [authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization), and [Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http) specifications. Protocol revision is explicit because transport/discovery semantics differ by revision. Resources, prompts, sampling and elicitation are outside this tools-only registration.
