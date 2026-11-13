# Production skill authoring standard

Status: proposed. Companion to the [audit and delivery plan](../skill-catalog-production-plan.md). This defines content and package changes to implement; it does not alter the current catalog contract.

Every business skill needs a procedure that an authorized operator or agent can apply to its supported cases, plus code, policy and evidence that enforce that procedure. A handler invocation recipe is only the integration section. A longer document is not inherently better: require business-specific decisions, examples and verifiable boundaries, while moving conditional detail into trusted references.

## Source ownership and packaging

Today `apps/fincrime-host/scripts/build_catalog.py` generates every `SKILL.md`. Introduce an authored source tree, for example:

```text
apps/fincrime-host/skill-content/screening/sanctions-execute/
  procedure.md
  references/
    negative-search-evidence.md
    related-party-scope.md
  examples/
    completed-negative.json
    ambiguous-match.json
    missing-publication-metadata.json
```

Use the existing `skills/<domain>/<leaf>/` and installed-resource trees as generated distribution outputs. Keep shared domain code in `src/financial_crime/skills/`; do not create one duplicate implementation module per package. Implementer tests may remain in shared suites with explicit skill/case traceability. Add separate held-out qualification evidence with governed dataset access.

Metadata belongs in the typed manifest, not duplicated free-form frontmatter. Keep the canonical dotted ID and its explicit mapping to the hyphenated harness name. Frontmatter must contain a useful description with selection triggers. Generate version, context and schema links from manifest data; validate authored statements about outcomes, status and authority against that contract.

References and examples need inclusion in the distributable, content hashes, provenance and permitted read paths. Current runtime helpers load one `SKILL.md`; adding references requires an explicit trusted loader, path/size controls, authorization and token/character budgets. Hash the instruction/reference tree into the released content identity and qualification evidence. Do not use unpinned remote links as executable instructions. External source text remains untrusted evidence.

## Required content for each skill

| Section | Content reviewers must be able to verify |
| --- | --- |
| Outcome and selection | Who uses it, business result, when to invoke, when to choose a neighboring skill, explicit non-goals |
| Supported scope | Customer/legal form, party roles, products/channels, jurisdictions, lifecycle, languages/formats, providers and known exclusions |
| Prerequisites | Required input and canonical record producers; policy/applicability requirements; permissions, entitlements and evidence freshness |
| Procedure | Ordered business steps, branch conditions, deterministic calculations versus model/human judgments, stopping conditions and dependent work |
| Evidence interpretation | What establishes each conclusion, claim/source lineage, negative-search scope, conflicting evidence and what remains unverified |
| Outcomes and failures | Meaning of each reachable status and payload flag; unknown/missing/stale distinctions; declared error codes and recovery route |
| Variations | Applicable pack references, configuration constraints and unsupported combinations; no invented legal defaults |
| Human authority and effects | Recommendation versus decision, proposal/commit boundaries, approval binding, changed-basis invalidation and delivery acknowledgment |
| Examples | Normal, adverse, ambiguous, missing-policy, stale/partial-source and changed-context cases with expected status, evidence and rationale |
| Quality and operations | Acceptance cases, independent rubric/dataset references, budgets, idempotency/retry/reconciliation and ownership |
| Limitations and history | Known technical/business exclusions, evaluation scope, semantic version and migration/deprecation notes |

Each section can be short when the skill is a narrow primitive. A normalization primitive needs supported Unicode behavior and collision examples; it does not need a filing runbook. A screening composite needs scope, source completion, disambiguation and handoffs. Review content against the actual business consequence.

## Required machine-readable additions

Design these as versioned contract extensions and migrate Python/TypeScript schemas, snapshots and generated API contracts together. The existing library manifest is strict; arbitrary extra YAML fields will be rejected.

| Contract area | Required semantics |
| --- | --- |
| Business contract | Outcome category; primitive/composite/workflow role; prerequisites and actual dependency closure |
| Policy requirements | Typed field/pack IDs, applicability, required/optional state, explicit approved-empty semantics, effective-time selection and missing/conflict behavior |
| Supported scope | Explicit customer/product/jurisdiction/lifecycle/source combinations and exclusions; references to approved variation packs |
| Evidence rules | Source types, publication/valid-time versus retrieval time, freshness, completeness/truncation, claim support and verified-versus-asserted status |
| Outcomes | Reachable statuses, domain result states, permitted errors and remediation; execution completion cannot imply business clearance |
| Operations | Owner/maintainer/reviewer roles, sensitivity/residency, timeout/size/cost budgets, retry classification and effect reconciliation |
| Content integrity | Authored procedure/reference hashes, reference allowlist, content version and packaging identity |
| Qualification | Separate evidence record naming exact content/code/schema/dependencies, policy/provider/model/workflow versions, supported scope, evaluator, thresholds/results, approval, expiry and revocation |

Do not store real customer examples in publicly distributed packages. Use sanitized synthetic examples for documentation, with controlled access to independent real/representative evaluation data.

## Worked example for sanctions execution

This specimen illustrates the intended depth for `screening.sanctions.execute`. It describes the current bounded record-evaluation handler and identifies proposed production prerequisites. It is not a new released `SKILL.md` or an approved sanctions policy. It introduces no thresholds or legal interpretation.

```yaml
---
name: screening-sanctions-execute
description: Evaluate admitted sanctions search records for the required subject scope, retain possible matches and identify incomplete evidence. Use after approved acquisition; route ownership, control and final disposition to their dedicated steps.
---
```

### Business outcome and selection

Evaluate sanctions candidates and search-completion evidence for the entities supplied in the admitted context. Return possible hits, captured coverage and an execution status that the parent workflow can interpret. A completed scoped search is evidence about that search; it does not establish universal clearance, customer acceptance or authorization to release a transaction.

Use after the workflow determines required subjects and acquires approved source results. Use the dedicated ownership/control skills to evaluate those dimensions; the current `list_screen` handler does not call them. Use a reviewed disposition step to resolve candidate identity or authorize consequential action. If a parent workflow claims an end-to-end sanctions assessment, it must demonstrate these dependencies explicitly.

### Supported scope and prerequisites

Current scope is the synthetic reference implementation over admitted canonical records. Production use remains blocked until the package, sources, applicable policy and workflow have qualified scope-specific evidence.

Required context: `Entity` with name and identifiers. Optional record collections are `WatchlistEntry` and `ScreeningExecution`; their absence is not evidence of a completed negative search. The invocation supplies pinned policy, tenant/case/subject scope, actor and as-of time. `screening_threshold` must be configured. No default threshold may be supplied by the author or model.

The parent production workflow must additionally establish required parties/roles, list/dataset scope, jurisdiction/entitlement, current publication/version metadata, query completion, pagination/truncation, and approved source mappings. These are acceptance prerequisites to implement and qualify across acquisition/gateway/context boundaries; they are not all enforced inside today's handler.

### Procedure and branches

1. Confirm that the invocation is for the pinned skill version and admitted case/subject context. Reject undeclared parameters and permissions through the existing executor/gateway boundaries.
2. Establish which required subjects are represented and where each source result came from. Preserve distinct entity IDs; a shared name does not establish shared identity. Missing required subjects are a workflow coverage gap.
3. Require the pinned matching threshold. Select sanctions entries without repurposing PEP or generic watchlist coverage as sanctions coverage.
4. Use the deterministic matcher for admitted entities and entries. Retain its name/identifier features and contradictions. Its score is a synthetic heuristic, not an evaluated match probability. Preserve possible provider candidates even when the local heuristic produces no hit.
5. Evaluate search-completion evidence for the admitted subjects. Current code recognizes completed, untruncated executions with dataset versions, scope and query time no later than the invocation as-of time. Production qualification must additionally prove applicable publication/freshness/source controls at the correct boundary.
6. Return `NEEDS_REVIEW` when retained local hits or recorded provider candidates exist. Do not turn a contradictory feature or low local score into an authorized false-positive disposition.
7. Return `NEEDS_EVIDENCE` when search completion/coverage cannot be established and no candidate already requires review. Identify the missing work in the parent workflow. Return `COMPLETED` only as execution completion under the bounded current contract.
8. Preserve all captured list versions and coverage; keep `universal_clearance: false`. Trigger separate ownership/control work where the approved workflow requires it, and block the overall business conclusion until that work is resolved.
9. Apply human review and effect release only through the existing authorized decision/approval path. This skill is read-only and cannot record final acceptance, a reviewer decision, a payment release or a filing.

### Interpreting results

| Situation | Current handler behavior | Production workflow obligation |
| --- | --- | --- |
| Possible local hit or provider candidate | `NEEDS_REVIEW` | Preserve candidates, acquire discriminating evidence and route authorized disposition |
| No candidate; current completion predicate satisfied | `COMPLETED`, with no universal clearance | Verify required subject/list coverage and all additional applicable controls before a business conclusion |
| No candidate; no sufficient completion evidence | `NEEDS_EVIDENCE` | Obtain missing source/scope/completion evidence; no negative determination |
| Missing matching threshold | `POLICY_UNRESOLVED` error | Resolve approved policy; do not invent a threshold |
| Truncated or stale source | A truncated execution does not meet the completion predicate; freshness also depends on the enclosing controls | Preserve partial evidence and obtain fresh/complete coverage; test mixed complete/incomplete sources explicitly |
| Ownership ranges, cycles or control questions | Outside this handler's calculation | Invoke the correct qualified ownership/control steps; preserve unresolved state |

The current alternate completion path based on captured `WatchlistEntry.coverage.complete` must be evaluated against the institution's required subject/list scope. Do not assume a complete individual source record proves completeness of the entire business screening requirement. If a stricter predicate changes released semantics, implement a versioned change with migration and evaluation evidence.

### Variations and ambiguity

Required roles depend on approved relationship/product/policy applicability. Customer, owner, signatory, trustee or intermediary are distinct roles. Booking and formation jurisdictions are separate inputs. List inclusion, licenses and source freshness are approved configuration/evidence, not conclusions inferred from vendor branding.

For multilingual names and aliases, retain original script, transformed forms and query provenance. For conflicting identifiers, preserve the contradiction and use the disambiguation/disposition process. For unsupported jurisdictions, absent coverage or unknown applicability, stop the parent conclusion with an explicit gap.

### Examples and acceptance cases

| Case | Expected evidence and decision boundary |
| --- | --- |
| Completed negative source search for every required subject | Query/dataset/scope/completion metadata retained; no fabricated watchlist entries; no universal clearance |
| Shared name with contradictory identifier | Features preserved; possible candidate remains visible; final disposition requires the authorized process |
| Local heuristic finds no hit but provider reports candidates | `NEEDS_REVIEW`; candidate evidence survives |
| One related party has no source result | Parent coverage requirement remains unresolved even if other subjects completed |
| Missing list publication/version metadata | Explicit source-quality gap at acquisition/gateway/policy boundary; retrieval time cannot substitute |
| Candidate source outage after partial success | Successful evidence retained with gaps; fallback only under approved equivalent coverage and entitlement |
| Material ownership or relationship change after review | Prior assessment basis invalidated; reassess relevant parties and ownership/control before acceptance |
| Replay after retry or approval request | Stable request identity, unchanged evidence basis, no duplicate effect or authority widening |

### Quality, operations and limitations

Independent qualification must measure candidate retention/missed matches, adjudicated relevance and subject/list coverage for supported languages and source populations. Control tests must prove denied access, stale/missing coverage, source truncation, invalid input, changed-basis rejection and review routing. Owners set sample sizes, thresholds and latency/cost limits before promotion.

Retries must follow the gateway's admitted candidate/fallback and receipt policy. A timeout or uncertain external response is not a negative search. Reconciliation belongs to the acquisition/delivery boundary. The business owner owns applicability and review rules; the engineering owner owns handler/source correctness; independent QA owns qualification evidence.

Known current limits: synthetic local scoring, no acquisition within the handler, no ownership/control invocation within it, no final disposition authority, and no production qualification. Those limits belong in structured catalog metadata as well as this procedure.

## Author and reviewer acceptance checklist

- The description identifies a business result and selection trigger; it is not a repeated ID.
- Every advertised step exists in code, declared composition or an explicitly named workflow responsibility.
- Each required field has a known authorized producer and defined missing/stale/conflict behavior.
- Missing policy and an approved empty/not-applicable policy have different observable behavior.
- Examples assert business payload meaning, evidence and authority, rather than only schema/status.
- Declared errors, statuses, effects, references and implementation dependencies agree with execution.
- A domain SME reviews semantic accuracy; independent QA reviews evidence; existing release approvers retain their authority.
- The exact content and supported variation scope are included in qualification; changes trigger appropriate re-evaluation.

Review a small representative set before scaling this standard to every entry. Package completion can be tracked across all 229 IDs, but production readiness must be assessed per qualified business slice and supported variant.
