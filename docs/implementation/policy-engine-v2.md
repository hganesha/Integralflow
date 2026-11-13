# Released business policy v2

Implemented 2026-11-09 against `65c8283fc77efb273fd06be646b7e1ea99476790`, then reconciled with current main `703e4f8d` (context connectors, applications, ontology/case traversal and onboarding delivery waves 0–5). This is the implementation companion to the [remediation plan](policy-engine-remediation-plan.md) and [onboarding delivery plan](agentic-onboarding-delivery-plan.md). The latter continues to own hydration, qualified observation producers, live model/provider access and pilot acceptance.

## Authority and execution

Both active onboarding packages now have three actual OPA gates: `intake-ready`, `decision-ready` and `disposition`. They use `canonical.onboarding.v2`, bind their exact bundle and effective policy sets, and route on `DECIDED`, `NEEDS_EVIDENCE`, `NEEDS_HUMAN`, `NOT_APPLICABLE` or `UNRESOLVED`. A completed agent task is an observation; it does not authorize case disposition. The terminal onboarding output requires an applied `FinalizeDisposition` action matching the case result.

```mermaid
sequenceDiagram
    participant R as Leased runtime node
    participant C as Case API
    participant O as OPA 1.9.0
    participant A as Release authority
    participant D as Case database
    R->>C: Read signed, selected canonical snapshot
    C-->>R: Snapshot and short-lived server read proof
    R->>C: Evaluate bound gate
    C->>C: Re-read evidence and verify scope, digest, sequence, clock and lease
    C->>O: Exact input and immutable installation bundle
    O-->>C: Typed result and exact actions
    C->>A: Lock active release and independent approvals
    C->>D: Lock case; atomically store input, receipt, actions and ledger
    C-->>R: Applied decision receipt
```

The canonical input profile retains the pack selectors and adds the canonical types read by the enabled skills/agents, explicit ControlAssessment/Application/Product/Party records, and case lifecycle, subjects, claims, facts, contradictions, findings, recommendations, work, evidence metadata and prior adoptions. Inputs are available under `facts.selected` with stable compiled selector IDs (for example `policyRecordFinding` and `policyCaseClaims`). Missing observations remain missing; their presence does not adopt their conclusions.

OPA simulation emits the same result/receipt contract but cannot mint process-local sink authority. The trusted Case API evaluates stored sources; there is no public receipt-import endpoint. Command authority additionally requires the exact internally constructed command, decision, action index and action digest. Receipt hashes alone are insufficient.

The protected registry covers fact acceptance, contradiction resolution, activated work creation/completion, gate/QA/review results, human/business status transitions and disposition. All ingress paths converge on the case-store guard, including direct API calls, integration writes and expanded skill output. Production also refuses new legacy cases and protected legacy writes. Historical development replay remains versioned.

Canonical records preserve producer attribution. A `ControlAssessment`, risk recommendation, document interpretation or screening proposal does not become an adopted conclusion merely because its payload contains `PASS`, `verified` or a tier. `adopt_assessment` names the selected immutable object/version and interpretation; its separately retained adoption is an OPA action. Observation producers must not fabricate human provenance.

The service retains tenant isolation, identity, leases, schema/provenance checks, immutable history and idempotency. Business rules choose automation, disposition, evidence response, adoption, thresholds and human requirements. An installation cannot disable service integrity through policy configuration.

## Installation policy lifecycle

Start with `domains/kyc-agentic/policy.yaml` or `domains/kyb-agentic/policy.yaml`. The four effective sets reuse the existing baseline → US/GB jurisdiction → institution → product layer identities. Pack composition, executable bundle and effective-set digests are distinct. Scope includes institution, jurisdiction, products, customer type and purpose. Selection must match the case's pinned pack and canonical BankingRelationship; absent or ambiguous scope cannot authorize an action.

Each active template currently has **37 release blockers**: two candidate sets, 32 unresolved scoped content entries and three unauthored gate defaults. Candidate templates deliberately return `UNRESOLVED / INSTALLATION_POLICY_RULES_REQUIRED`. Their sample output is not onboarding approval. Technical callback wiring also leaves `permitted_providers` unresolved until explicitly supplied by the policy owner; it cannot silently authorize the gateway as a provider. Existing baseline values retain their provenance and candidate status; this change does not invent legal criteria, risk weights, provider eligibility or production approvals.

1. Copy the policy source into an installation workspace. Review inherited layer pins and scope.
2. Resolve every enabled skill's content demand. Each field needs an owner, review basis, closed library schema version and value. Explicitly reviewed empty arrays are allowed where the closed schema permits them; absent values remain unresolved. Unknown fields, invalid nested types and attempts to replace reserved authority fields fail compilation.
3. Author explicit gate rules and action payloads. Set configuration such as `automatic_approval_enabled` or `automatic_decline_enabled` according to the installation's decisions. The compiler has no v2 fixed-false automation rule. A boolean alone never authorizes anything: a matching rule must emit a permitted action.
4. Test facts in Policy Studio. Select the current KYC/KYB template, edit Library source, compile the candidate and inspect blockers. The Test corpus tab runs a JSON sample through the actual authoring API and OPA. Keep the evaluation time fixed to reproduce a receipt. Simulation never mutates a case.
5. Compile policy, skill projections and gates into a new plan together:

   ```sh
   node --import tsx scripts/compile-installation-policy.ts \
     domains/kyc-agentic /path/to/installation-policy.yaml \
     --out /path/to/new-installation-package --release production
   ```

   The output directory must be new. `--release candidate` permits review of incomplete content. Production compilation rejects unresolved content, candidate sets and placeholder gates. The compiler reprojects all enabled skill bindings and refuses erased content demands or incompatible gate/customer profiles. It writes `domain/`, `plan.json` and `policy-bundle.json`; it does not publish or activate them.
6. Use the existing persisted revision workflow: save, compile, obtain independent approval, publish; admit the matching new plan; register/approve its release manifest and activate it in the intended environment. Runtime revalidates the full manifest hash, tenant, plan, gate, bundle, registry status and published unblocked revision at the effect boundary. Relabeling YAML as approved is insufficient.

The rule DSL supports typed comparisons, membership, existence, counts, freshness, `all`/`any` and non-vacuous quantified coverage. Correlated parent references allow a rule to require every party × screening type with matching subject/type rather than accepting any one clear result. `$input/...` action references resolve once against the exact evaluated input; strings returned from a fact are not recursively interpreted as templates. Defaults cannot emit business effects. Facts/observations can have installation-defined JSON schemas.

## Humans and delivery

`NEEDS_HUMAN` supplies roles, quorum, independence, choices, TTL and an exact action intent for each permitted choice. The queue is bound to the retained decision and original OPA input. Case API records authenticated, uniquely attributed responses against the original request/input hashes. Duplicate principals cannot satisfy quorum. Changed basis, expired requests, revoked releases, disallowed roles and altered intents fail.

The human response re-arms the same gate; it cannot complete the work through legacy approval/conflict endpoints. A fresh OPA result must explicitly reference the original decision/choice, meet quorum and emit exactly the reviewed actions. Conflicting responses remain policy facts. Human authorship is never fabricated to satisfy a legacy human-only finalizer.

Filing and retention use a durable outbox. `dispatchBusinessEffect` is the trusted delivery-service integration point, with allowlisted, installation-qualified adapters. It rechecks release and case authority, passes a stable provider idempotency key, and parks ambiguous delivery in `RECONCILIATION`. A stale/revoked action is cancelled. Direct agent/gateway external or destructive invocation cannot bypass the outbox. **Live filing/deletion adapters and their provider qualification are installation delivery obligations; this PR supplies and tests the authority/outbox boundary, not live provider credentials or delivery certification.**

## Compatibility, rollout and operational limits

Source acquisition/use and legacy banking requirement/readiness evaluation now execute pinned OPA modules. TypeScript implementations remain parity oracles. The frozen v1 module rules preserve historical behavior; new installation business rules use the editable v2 source. This policy change preserves the archived KYC/KYB and transition-slice plans supplied by current main. The incoming onboarding library updates changed their earlier pins independently; policy generation does not rewrite the current archive outputs.

Apply control migrations 050–051 and case migration 019, including their grant matrices, before deploying the services. Reapplication is supported. Deploy schema/readers before v2 writers, compile a new immutable installation plan, qualify in a non-production environment and activate that release explicitly. Read proofs expire after 60 seconds; refresh the snapshot on stale authority. The original decision input is retained independently of expiring transport proofs.

Rollback means stopping admission and deactivating/revoking the affected release, then activating a reviewed prior compatible v2 release. Previously applied decisions and effects remain immutable audit history. Do not downgrade an existing case to v1 to bypass enforcement, delete migrations, erase receipts or blindly retry an ambiguous external delivery. Existing cases remain pinned; migration to another plan needs an explicit admitted migration workflow.

The incoming onboarding hydration stages, optional authenticity checks, attributed proposal writes, stop/result evidence links and recorded-agent replay are preserved. Fixed human-only routing is replaced by gate-owned requirements. The recorded observation walk deliberately passes over acquisitions and gates; it is not a policy-authority acceptance test.

The tested execution contract is a leased node evaluation through Case API, used by the durable worker and runtime gate adapter. The policy work does not certify full live nine/ten-agent onboarding, every one of the 229 synthetic skill implementations, trust/H12 variants, production provider quality or all external runtime transports. Hydration and qualified callable-skill scope must meet the companion onboarding plan before a pilot is released. The Cases mock UI's legacy creation flow is not evidence of live onboarding delivery.

## Verification

See [implementation evidence](policy-engine-v2-verification.md) for executed checks and their limits. Required real-OPA tests fail when the pinned binary is unavailable. CI runs them in the code job and requires the database conformance suite in the database job; absence of database configuration cannot silently satisfy that job.
