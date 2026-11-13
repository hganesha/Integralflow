# Intelligence binding contracts and authority

Status: Implemented foundation decision, pending production activation design approval.

The Intelligence surface reads existing model/provider/runtime authorities and saves tenant- and deployment-environment-scoped proposals. It does not change execution routing. `intelligence.binding.v1` is a new proposal format, separate from the strict legacy model-profile document. Legacy JSON shapes, hashes and per-node runtime target precedence remain unchanged.

Canonical reasoning IDs are `reasoning.low`, `reasoning.med`, `reasoning.high` and `reasoning.xhigh`. Existing fast/standard/deep profiles are mapping suggestions only; judge is never mapped to XHigh. A proposed native effort parameter is separate from tier intent and requires model/API qualification. Proposed runtime aliases reference existing `<adapter>:<binding>` targets. ML aliases reference versioned business capability IDs and separately versioned feature/output, preprocessing and calibration contracts.

Configuration stores reference existing resource coordinates and environment-variable credential names only. It does not store credentials or advertise an unimplemented vault resolver. Authentication modes discriminate transport requirements; workload identity, inbound permissions and outbound callback connectivity require separate evidence. The production workload-identity and reviewed deployment restrictions remain authoritative.

Every save creates immutable revision content and a digest; a tenant/environment/binding head advances with an expected-revision check. Definition and activity writes commit together. The deployment selects environment server-side. Caller labels cannot switch it. Existing provider/profile administration and runtime settings continue to be the execution sources of truth.

The initial authority is `admin.read` for this administrative inventory and `admin.write` for proposal writes/configuration checks, independently checked at the BFF and control API. No new activation/deployment authority is implied. Existing provider catalog permissions remain unchanged. Future fine-grained verification/approval/activation actions need explicit role mapping and separation of duties.

Configuration checks are offline, bounded and have no network or business side effects. They persist exact-revision results and mark workload identity, network, contract and activation evidence unknown. Unknown or failed evidence never qualifies a candidate as executable. The surface exposes these blockers instead of a misleading activation control. Production verification, approvals, rollout acknowledgment, invocation generation pinning and consumer publication remain later release gates from the delivery plan.
