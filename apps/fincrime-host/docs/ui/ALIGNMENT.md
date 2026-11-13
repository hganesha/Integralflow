# Alignment: one UI for the EHF platform and the FinCrime domain

**Status:** authoritative · 2026-11-07 · supersedes the contract assumptions in BUILD-SPEC v1
**Decision recorded:** this UI **replaces `ehfconcept/apps/control-ui` (Next.js) completely**, including its BFF.
**Pinned sources:** `contracts/SOURCES.lock.json` (kyc 0.3.0 by file digest; ehfconcept `249ab42`).

This file explains what changed since the first UI pack, who owns each contract, how the 22 control-ui pages map onto the new information architecture, and how we keep up with the two repositories as they move.

---

## 1. What changed

The first pack (BUILD-SPEC v1) was written against kyc 0.2 and invented the contracts it couldn't find: TaskSpec, AgentMandate, ContextProfile, an approvals API, a revisioned case and an action pipeline. Since then, three things have happened.

1. **kyc 0.3.0 integrated with EHF.** EHF now owns work identity, scheduling, leases, human decisions and every canonical case mutation. The Python Bridge only *proposes* outcomes (`BridgeOutcome.effects_committed` is always false). kyc publishes real `TaskSpec`s, six `BusinessAgent` profiles and twelve context products, and EHF admits them as one catalog artifact.
2. **EHF has a working platform.** It has control-api, case-api and capability-gateway, a zod contract package, a role-to-action table, a human-work queue with dual control, releases, deployments and integrations. A Next.js control UI fronts it today.
3. **You decided this UI replaces that control UI.** So the UI must reach parity with every control-ui page and BFF route, and its BFF must take over control-ui's session, CSRF and delegated-identity duties.

v2 of the pack follows from that:

| Area | v1 | v2 |
|---|---|---|
| API | 62 invented operations | **151 operations**: 103 relay an EHF route 1:1, 7 compose EHF data (run detail, case detail, trace, model tiers, and 3 cloud-discovery reads since removed with PLT-13), 24 FinCrime read models, 3 auth, 4 session/shell, 3 presentation (proposed), 7 mock-only (`experience-api.openapi.yaml`) |
| Shapes | `proposed/` schemas | `$ref` to **`upstream/ehf-contracts.schema.json`** (110 zod schemas, exported), **`upstream/control-ui-views.schema.json`** (65 frozen view models) and kyc `schemas/integration/*` |
| Human actions | `/actions/preview → commit`, `/approvals/{id}/approve` | EHF human work: **claim → decide (APPROVE · REJECT · RETURN) → resolve**, plus case-api **business commands** with a BFF-computed preview |
| Agents | 16 invented agents | the **6 BusinessAgents** and **6 TaskSpecs** from the admitted catalog |
| Context | 13 banks + ContextProfile | the **12 context products** × agent ceilings (`context_fields`, `policy_fields`) |
| Freshness | SSE-first | **Polling-first with ETag** (EHF 03); SSE optional later |
| Fixtures | view models only | EHF-shaped store + FinCrime projections + platform views, all validated (1,027 checks) |
| Stack | Node 22, pnpm 9 | **Node ≥ 24, pnpm 11.9, TS 5.9, vitest 4, zod 4, fastify 5** to match ehfconcept |
| Drift | none | `SOURCES.lock.json` + `check_sources.py` + exporters |

---

## 2. Who owns what

Rule: **the UI repository owns presentation and BFF composition, and nothing else.** Every shape that crosses a service boundary has exactly one owner. The pack `$ref`s it and never copies it.

| Concern | Owner | Source of truth | How the pack consumes it |
|---|---|---|---|
| Work items, leases, human decisions, dual control | EHF | `packages/contracts` (`executionWorkItem`, `humanWorkDecision`), `packages/persistence/src/execution-work.ts` | `upstream/ehf-contracts.schema.json#/$defs/*`; `HumanQueueItem` mirrors the TS type (flagged `x-upstream-shape`) |
| Case store: snapshot, sequence, commands, events, ledger, exports | EHF case-api | `caseSnapshot`, `businessCommand`, `commandOutcome`, `kycCaseStatus` | relay ops under `/v1/cases/**` |
| Runs, events, attempts, traces | EHF control-api | `runRecord`, `runtimeEvent`, `runStatus` | relay ops under `/v1/runs/**`, `/v1/traces/**` |
| Drafts, policies, releases, deployments, integrations, admin | EHF control-api | zod contracts + control-ui view models | relay ops; view models from `upstream/control-ui-views.schema.json` |
| Capability registry, adapters, model tiers | EHF capability-gateway | `capabilityRegistration`, `ModelTierProfileView` | relay ops under `/v1/gateway/**` |
| Roles → platform actions | EHF identity | `packages/identity/src/authorization.ts` | `fixtures/personas.json#roleActions` (generated from the pinned file); `Session.actions` |
| Business agents, tasks, skills, context products | kyc | `profiles/agent.*.json`, `tasks/*.json`, `catalog/catalog.json`, `catalog/context-products.json`, `catalog/context-matrix.json` → `catalog/ehf-catalog.json` | admitted in EHF via `POST /v1/authoring/import/fincrime`, read back from `GET /v1/authoring/catalogs/fincrime/{digest}`; `$ref`s to `schemas/integration/*` |
| Canonical domain records | kyc | `schemas/runtime/Record`, `schemas/context/types/*` | `$ref`s; `fixtures/records.kyb-1042.json` |
| **FinCrime read models** (case room, ownership, screening, decision desk, recorder, lineage, atlas, readiness) | **UI repo — FinCrime module of the BFF** | `experience-api.openapi.yaml` components with `x-owner: fincrime-module` | composed from EHF + kyc; never stored |
| Session, search, overview/system aggregation, error envelope | **UI repo — BFF** | components with `x-owner: experience-bff` | |
| A2UI presentation (surfaces, intents, events, component catalog) | **unowned (proposed)** | `contracts/proposed/` (5 schemas kept) | `x-status: proposed` |

**Precedence when sources disagree:** pinned upstream code and contracts (EHF zod/routes, kyc schemas) **>** `experience-api.openapi.yaml` **>** BUILD-SPEC **>** STYLE-GUIDE **>** UI-ARCHITECTURE **>** mockups **>** concept drawings. A disagreement between EHF *design docs* (`docs/new-arch`) and EHF *code* is a gap (§7). Build against the code and keep the target in view, as the human-decision `basis` field does.

---

## 3. Superseded and retired

| v1 artifact | Replaced by | Disposition |
|---|---|---|
| `proposed/TaskSpec` | kyc `schemas/integration/TaskSpec` + `tasks/*.json` | retired (F2 resolved upstream: identity_ownership runs entity ∥ registry → UBO resolve → verify) |
| `proposed/AgentMandate`, 16 agents A01–A16 | kyc `BusinessAgent` + 6 profiles | retired. The mockup `agt-01` shows 16 cards; build 6 |
| `proposed/ContextProfile`, 13 banks | 12 context products; readiness = product × agent ceiling | retired. "Entity" folds into `identity.intelligence` |
| `proposed/AuditCorrelation` | EHF case events + runtime events + `AssignmentScope` IDs | retired |
| `proposed/Publication` | EHF drafts (compile → evaluate → approve → publish) + releases | retired |
| `/actions/preview`, `/actions/commit`, `/objects/{type}/{id}/actions` | `POST /v1/fincrime/cases/{id}/commands:preview` + `POST /v1/cases/{id}/commands`; `CommandAffordance` lists on read models | removed |
| `/approvals/{id}`, `/approve`, `/reject`, `ApprovalView` (hash-bound) | `/v1/operations/human-work/{id}/claim · decisions · resolve` | removed. The trusted sheet stays and now submits a human decision |
| SSE `/stream` | polling with `ETag` + `x-poll` intervals | removed from v2; may return as an optimisation |
| `fixtures/studio.json`, `work.json`, `skill-index.json` | `fincrime.catalog.json`, `ehf.kyb-1042.json`, `scenario.kyb-1042.json`, `platform.json` | removed |
| Kept | `proposed/ComponentDescriptor`, `PresentationEvent`, `PresentationIntent`, `SurfaceInstance`, `SurfacePatch` | A2UI has no upstream owner yet |

---

## 4. Parity with control-ui

Every control-ui page and BFF route has a home. Nothing is dropped. Where control-ui was defective (ui-specs.md §10), the new contract fixes it.

### 4.1 Pages → routes

| control-ui page | New route | Surface | Notes |
|---|---|---|---|
| `/` | `/` | hub | redirects to `persona.landingRoute` |
| `/overview` | `/platform` | PLT-01 Overview | `GET /v1/overview` |
| `/author` | `/platform/drafts` | PLT-02 Drafts | |
| `/author/[draftId]` | `/platform/drafts/$draftId` (`?tab=`) | PLT-03 Draft workspace | 7 tabs per ui-specs §4.2–4.10 |
| `/author/[draftId]/policies`, `/author/policies` | `/platform/drafts/$draftId/policies`, `/platform/policies` | PLT-04 Policy Studio | revision workspaces relayed as typed ops (no `governance/[...path]` catch-all) |
| `/harnesses`, `/harnesses/[planDigest]`, `/operate`, `/operate/[planDigest]` | `/platform/plans`, `/platform/plans/$planDigest` | PLT-05 Plans | one surface; control-ui had two near-duplicates |
| `/runs` | `/platform/runs` | PLT-06 Runs | |
| `/runs/[runId]` | `/platform/runs/$runId` | PLT-07 Run detail | |
| `/traces/[traceId]` | `/platform/traces/$traceId` | PLT-08 Trace | authority-checked |
| `/cases` | `/platform/cases` | PLT-09 Cases | business users land in `/work` instead |
| `/cases/[caseId]` | `/platform/cases/$caseId` | PLT-09 Case (platform view) | links to `/work/cases/$caseId` for the FinCrime room |
| `/operate/human-work` | `/platform/human-work` | PLT-10 Human work | domain-neutral queue; `/work` is the FinCrime queue over the same API |
| `/operate/releases` | `/platform/releases` | PLT-11 Releases | |
| `/system`, `/gateway` | `/platform/system` (`?tab=services\|gateway\|runtime`) | PLT-12 Health | |
| `/deployments`, `/deployments/[deploymentId]` | — | PLT-13 Deployment Studio (removed) | the platform no longer deploys itself from the console (CONTRACT-GAPS GAP-116) |
| `/admin` | `/platform/admin` (`?tab=`) | PLT-14 Administration | |
| `/operate/integrations` | `/platform/integrations` | PLT-15 Integrations | |

### 4.2 BFF routes → operations

| control-ui BFF route(s) | v2 operation(s) | Change |
|---|---|---|
| `GET/POST /v1/authoring/drafts`, `GET/PUT …/{id}`, `POST …/{id}/[action]` | same paths; `compile`, `evaluate`, `approve`, `publish`, **`validate`** as separate typed ops | `validate` newly exposed; 422 diagnostics forwarded |
| `…/graph`, `…/orchestration-nodes`, `…/nodes/{id}/case-writes`, `…/agents/{id}/attach` | same | `caseWrites[].commandType` typed as `businessCommandType` |
| *(missing)* `…/context-selectors`, `…/context-classification-policies` | **added** | ui-specs §10.1 |
| `/v1/authoring/{agents,skills,templates,import/github}` | same | |
| *(not exposed)* `import/fincrime`, `catalogs/fincrime/{digest}` | **added** | the FinCrime module reads its catalog here |
| `/v1/authoring/policies` (GET template, POST compile) | `GET /v1/authoring/policies`, `POST …/compile`, **`POST …/evaluate`** | blockers forwarded instead of a flat 502 |
| `/v1/governance/[...path]` (allow-listed) | typed: `…/policies/workspaces/{ws}/revisions[/{rev}/{compile,approve,publish}]`, `/v1/operations/human-work[/{id}/{claim,decisions,resolve}]`, `/v1/releases[/{id}/transition]`, `/v1/signing-keys/revoke` | catch-all removed |
| `/v1/integrations/[...path]` (allow-listed) | typed connectors, bindings (`:test`, `:activate`, `:pause`), deliveries (`:replay`), human actions (`:execute`) | catch-all removed |
| `/v1/deployments/**` (allow-listed, 19 routes) | — | removed with the deployment studio (GAP-116) |
| `/v1/gateway/{registry,adapters,profiles,status,capabilities,decisions,openrouter/test}` | same | `maxInputTokens` reported, not hard-coded 0 |
| `/v1/admin/**` | same | upstream status codes kept (no flattening to 400) |
| `/v1/plans`, `/v1/plans/{digest}[/runs]`, `/v1/runs[/{id}[/events]]`, `/v1/traces/{id}` | same + `cancel`, `attempts`, `trace` | |
| `/v1/cases[/{id}[/exports…]]` | same + `snapshot`, `events`, **`commands`**, `ledger:verify`, `/v1/evidence/{id}` | business commands now reachable from the UI |
| `/v1/overview`, `/v1/system` | same (BFF aggregations) | ETag + poll interval declared |
| *(missing)* session/roles/config | **`GET /v1/session`** | ui-specs §10.3 |

Runtime-internal control-api routes (`/v1/runtime/**`, `/v1/integrations/internal/events`, `/v1/integrations/ingress/**`, `/v1/cases/{id}/integration-authority`, `/v2/policy/evaluate`, `/v1/invoke`) are for workloads, never for a browser. The BFF does not relay them.

### 4.3 Defects that must not come back

The following are acceptance criteria in BUILD-SPEC v2 §10:

- **Shell readiness:** no hard-coded "Fixture", "Recorded", `v0.1.0`, `local` or telemetry text. Values come from `Session.environment` and `/v1/system`.
- **Unauthenticated page shells:** every route requires a session, not just the data calls.
- **Permissions:** controls are hidden or disabled with a reason from `Session.actions`, and the server is still the authority.
- **Errors:** the reason code, message and `details` are shown. A 422 shows its diagnostics, never a bare "HTTP 409".
- **Polling:** the last good data is kept, with a stale banner and "Retry now".
- **Canvas edits:** a drag is not a revision per pixel. Moves are batched and committed on drop.
- **Separation of duties:** "guided release" never assumes one identity can approve what it authored.
- **Admin:** draft edits survive a tab switch. The model Capabilities tab round-trips `model`-kind entries.

---

## 5. Information architecture

The concept drawings of 7 Nov ("Enterprise Agentic Operating System") name four experiences on top of the **Workflow & Execution Plane**: Contextboard, Agent Studio, KYC Workspace and Assurance Studio. EHF's rule is that the platform UI stays domain-neutral and domain packages supply labels and forms (an invoice domain already exists). The app therefore has two layers.

```
┌ Shell (domain-neutral): chrome, session, search, studio switcher, layouts, design system ┐
│                                                                                           │
│  Domain module: FinCrime (registered by manifest)          Platform console (always)       │
│  ├─ KYC Workspace     /work/**          BIZ-01…09          /platform/**   PLT-01…15        │
│  ├─ Agent Studio      /agents/**        AGT-01…07          overview, drafts, policies,     │
│  ├─ Contextboard      /context/**       CXT-01…04          plans, runs, traces, cases,     │
│  └─ Assurance Studio  /assurance/**     ASR-01…05          human work, releases, health,   │
│                                                            deployments, admin, integrations│
└───────────────────────────────────────────────────────────────────────────────────────────┘
```

- **Domain module contract:** `{id, label, studios[], routes, decisionLabels(workType, gate) → DecisionOption[], commandLabels, stateLabels, searchProviders}`. FinCrime is the first module. Another domain plugs in without touching the shell or the platform console.
- **Assurance Studio** (concept slide 1) has four parts: Mission Control (ASR-01), Flight Recorder (ASR-02), Decision Lineage (ASR-03) and Assurance Lab (ASR-04). All draw on one evidence model (case store, evidence store, case ledger and OTel). The recorder's tabs are **Chronology · Causality · Traces** (slide 2).
- **Case Room desktop layout** (slide 4): *My Work* (current task, documents, screening, risk, handoffs, case timeline) | *Specialist Canvas* (graph + findings/discrepancies + verification/evidence) | *Case Intelligence* (AI findings, review needed, evidence sources, policy requirements, uncertainty, **Human action**) above a bottom bar (case history · task status · agent activity). This is the existing four-region template: orient | main | inspector | rail. The rail becomes the bottom bar at ≥ 1440 px.
- **KYC Workspace home** (slide 5): persona picker (mock only), attention queue, the identity and ownership dossier, and *AI-prepared work* with an **accountable human step** card naming the expected work product. These map to `AttentionQueue` + `CaseRoom` + the human work item's `objective` + `DecisionOption`s.
- **Token reconciliation:** control-ui's palette (`evergreen #1f6b4f`, `warn #8a6314`, `danger #a23f2f`, `active #2e6f91`) is within ΔE ≈ 3 of ours (`emerald-700 #2E6B4F`, `ochre-700 #8A5A0F`, `coral-700 #A3412F`, `slate-700 #3D5A82`). Ours replaces it. See STYLE-GUIDE §2. The concept drawings are dark. Dark mode is a later token set, not part of v2.

---

## 6. Stack alignment

The UI lives in **ehfconcept** and replaces `apps/control-ui`:

| | v1 | v2 (matches ehfconcept) |
|---|---|---|
| Location | `kyc/ui/` | `ehfconcept/apps/web` (SPA) + `ehfconcept/apps/experience-bff` (fastify) + `ehfconcept/packages/ui-*` |
| Node / pnpm | 22 / 9 | **≥ 24 / 11.9** (root `engines`, `packageManager`) |
| TypeScript | 5.x | **5.9.3** |
| Tests | Vitest | **vitest 4.1** (+ Playwright) |
| Runtime validation | Ajv | Ajv for OpenAPI/JSON Schema; **zod 4.6.5 `@ehf/contracts` directly in the BFF** |
| BFF | — (mock only) | **fastify 5.12**, same as control-api/case-api |
| React, router, query | React 19, TanStack | React 19.2, TanStack Router/Query (control-ui used Next 16 + React 19.2.6) |
| Graphs | elkjs + SVG | elkjs + SVG. `@xyflow/react` remains allowed for the **draft canvas** only (PLT-03), as control-ui used it |
| Icons | own sprite | own sprite (lucide-react dropped) |

The kyc repo keeps the **spec** (`docs/ui/**`). The ehfconcept repo gets the **code**. `pnpm sync` in ehfconcept copies `docs/ui/contracts/**` and the pinned kyc files into `packages/ui-contracts/vendor/` and refuses to run if `check_sources.py` reports drift.

---

## 7. Open gaps

Each gap has an owner and a way the UI behaves until it closes. BUILD-SPEC §13.2 pre-populates `CONTRACT-GAPS.md` with these.

| # | Gap | Owner | UI behaviour until closed |
|---|---|---|---|
| G1 | `caseSnapshot.data` is untyped. FinCrime read models (claims, contradictions, ownership, screening) are BFF projections over command payloads with no shared schema. | kyc + EHF | BFF owns the projection and tests it against fixtures. Propose `fincrime.case-data/v1`. |
| G2 | EHF 17 requires `claimVersion` + `basisDigest` on decide (409 `human.basis_stale`). Code accepts neither yet. | EHF | UI always sends `basis`. Mock enforces staleness, so the UI is ready. BFF forwards it once case-api accepts it. |
| G3 | Dual control counts decision **rows**. Distinct principals aren't visibly enforced in `submitHumanWorkDecision`. | EHF | Mock refuses a second decision by the same principal (409). The UI never offers it. Verify a DB constraint exists. |
| G4 | No non-dispatching Bridge preview of the `ContextPacket` an agent would receive. | kyc | CXT-04 and the AGT-05 "dry run" render their frame plus a "preview not available" disclosure (`x-status: needs-upstream`). |
| G5 | Canonical external capability model (`<path>.intelligence.<jurisdiction>`, bindings, coverage) is a proposal, untracked in ehfconcept. | EHF | CXT-03 shows gateway registry/adapters and `capabilityReadiness: pending_upstream`. Watched by the lock (`ehf.proposals`). |
| G6 | `businessCommand.authority` (plan, permission envelope and policy snapshot digests) for **human** commands isn't specified. | EHF | BFF fills it from the case snapshot. Confirm with case-api owners. |
| G7 | EHF 20 requires an OBO delegated token per API. control-ui uses an edge service token + `x-actor-*` headers. | EHF | BFF supports both behind `BFF_IDENTITY_MODE=delegated\|edge`; production requires `delegated`. |
| G8 | Human-work items carry no domain labels or forms for APPROVE/REJECT/RETURN. | EHF + kyc | FinCrime module supplies `DecisionOption`s keyed by work type and gate. Propose `constraints.decisionUi` (reuse `humanActionUi`). |
| G9 | No step-up re-authentication for consequential decisions upstream (v1 sheet had a 6-digit re-auth). | EHF | Dropped from the sheet. Attestation checkbox stays. Propose OIDC `max_age`/`acr` step-up. |
| G10 | No release diff (catalog/plan delta between releases). | EHF | AGT-07 shows the two manifests side by side and links to PLT-11. |
| G11 | EDD, AML, QA policy-diff, periodic-review and lab-cluster views have no contract. | kyc | BIZ-04/05/08 (diff), BIZ-09 (reviews), ASR-04 render frames with a gap disclosure. |
| G12 | A2UI presentation contracts have no owner. | Platform | Kept as `proposed/`; slot falls back to canonical cards. |
| G13 | EHF 03 still says "refactor/host the Next.js app". | EHF | Update 03 to "SPA + fastify BFF" (the BFF still provides server-side sessions, so the "static host alone is insufficient" constraint holds). |
| G14 | `createKycCaseRequest.jurisdiction` is `const "US"`. | EHF | The case-create form fixes jurisdiction to US and says so. |

---

## 8. Drift control

Two repositories move under this pack: kyc (context plane work) and ehfconcept (platform). New concept drawings and the capability-model proposal landed on 7 Nov while this work was in progress. So we pin and check instead of copying shapes by hand.

**Files**

- `contracts/SOURCES.lock.json` pins a sha256 for **257 upstream files** in 12 groups, plus the ehfconcept commit, plus a digest of the exported zod bundle. Each group lists its consumers ("re-check: …").
- `tools/check_sources.py` reports `changed / removed / added` per group, whether ehfconcept has moved off the pin, uncommitted upstream work in watched paths, and whether the zod export is stale. It exits 1 on drift. Run it with `--update` after review.
- `tools/export_ehf_contracts.mts` regenerates `upstream/ehf-contracts.schema.json` from `@ehf/contracts` using EHF's own zod. The output is byte-identical on macOS and Linux.
- `tools/export_control_ui_views.mjs` freezes the replaced BFF's TS view models into `upstream/control-ui-views.schema.json`. After cutover this file is history.
- `tools/validate_contracts.py` checks the OpenAPI conventions, **checks that every `x-upstream` route is registered in the pinned EHF sources**, and validates every fixture against its owner's schema.

**Cadence**

| When | Run | On failure |
|---|---|---|
| Every UI PR (CI in ehfconcept) | `check_sources.py` and `validate_contracts.py --ehf-root .` | Block. Sync the pack in kyc first |
| Every kyc PR touching `schemas/`, `tasks/`, `profiles/` or `catalog/` | `check_sources.py` | Warn with the consumer list |
| Every ehfconcept PR touching `packages/contracts`, `apps/*/src/*routes*`, `apps/*/src/app.ts` or `packages/identity` | `export_ehf_contracts.mts`, then `check_sources.py` | Warn. The PR author updates the pack or files a gap |
| Weekly | `check_sources.py --json` posted to the team channel | — |

**Re-pinning procedure:** read the report → update the generators (`contracts/gen/openapi_v2.py`, `contracts/gen/fixtures_v2.py`) or BUILD-SPEC as the consumer list says → re-export → `validate_contracts.py` green → `check_sources.py --update` → commit the lock with the reason.

**Watched, not pinned:** `ehf.proposals` (the capability model) reports `watch` rather than drift. Concept drawings in `docs/ui-constructs/` are reviewed by a human when they change and are never contracts.
