# UI Build Specification v2 — EHF Control Surface + FinCrime Experience

**Audience:** the UI build agent (and the humans reviewing its work)
**Version:** 2.0 · 2026-11-07 · **Status:** authoritative. Supersedes v1.
**Goal:** build one production-grade web UI and its BFF that **replace `ehfconcept/apps/control-ui` completely**. It covers the 15 platform surfaces the Next.js app has today plus the 25 FinCrime surfaces. It runs entirely on a **contract-generated mock**, and switches to the real BFF by changing one environment variable and no component code.
**Read first:** `ALIGNMENT.md`. It explains why v2 exists and who owns each contract.

---

## 0. Read this first

### 0.1 Reading order

1. `docs/ui/ALIGNMENT.md` — ownership, parity matrix, IA, gaps, drift control.
2. **This file** — what to build, how, and in what order.
3. `docs/ui/contracts/experience-api.openapi.yaml` — the **only** API the browser may call (154 operations). `x-upstream`, `x-action`, `x-poll`, `x-owner` and `x-status` carry the rules.
4. `docs/ui/contracts/upstream/*.schema.json` — EHF zod contracts (exported) and the frozen control-ui view models. **Never edit.**
5. kyc `schemas/integration/*`, `schemas/runtime/*`, `schemas/context/types/*` — FinCrime contracts.
6. `docs/ui/contracts/fixtures/*.json` — the mock seed (validated).
7. `ehfconcept/ui-specs.md` — behavioural spec of the control-ui screens. **PLT surfaces follow it except where §10 says otherwise.**
8. `docs/ui/UI-ARCHITECTURE.md`, `STYLE-GUIDE.md`, `tokens.json`, `style-guide.html` — layout and visual rules.
9. `docs/ui/mockups/*.html` — visual reference for 16 FinCrime surfaces. Match layout, hierarchy and copy. Where a mockup shows v1 data (16 agents, 13 banks, approvals), the contract wins.

### 0.2 Precedence when sources disagree

Pinned EHF code and contracts + kyc schemas **>** `experience-api.openapi.yaml` **>** this BUILD-SPEC **>** `ui-specs.md` **>** STYLE-GUIDE **>** UI-ARCHITECTURE **>** mockups **>** concept drawings.

Don't resolve a conflict silently. Log it in `CONTRACT-GAPS.md` (§13.2) and follow the higher-precedence source.

### 0.3 Non-negotiables (violating any of these fails the build)

| # | Rule |
|---|---|
| N1 | Components get data **only** through the generated `ExperienceClient`. No component, route or hook imports fixtures, `fetch` or MSW. |
| N2 | All API types are **generated** from the OpenAPI bundle. Never hand-write a type that duplicates a contract shape, and never edit generated or `upstream/` files. |
| N3 | **No invented fields.** If a surface needs data the contract lacks, stop, log it in CONTRACT-GAPS.md and render an explicit "not yet available" disclosure. |
| N4 | The API sends **raw enum values**. Tones, colours and glyphs come from `tokens.json → stateMap` via `stateTone()`. No colour literals in components. |
| N5 | A state is **never shown by colour alone**: tone + glyph + text, plus the dimension label wherever ambiguity is possible. |
| N6 | **Nothing appears done before its durable receipt.** A decision, command, compile, publish or transition shows *Committing…* until the response arrives and the follow-up read shows the new state (EHF 03). No optimistic UI. |
| N7 | **Consequential human decisions** (any `human_review` work item, `FinalizeDisposition`, release `approved`/`active`/`revoked`) render only in the application-owned **`TrustedDecisionSheet`**. Agent-composed (A2UI) content never renders a commit control. |
| N8 | **Unknown ≠ pass.** Never round UNKNOWN, missing, unverified or `REVIEW` up to a positive state. Screening "no candidates" is never a clearance. |
| N9 | **Synthetic data is always disclosed** when `Session.environment.synthetic` is true. |
| N10 | Every graph has an accessible **table alternative**, and every interactive element is keyboard-operable (WCAG 2.2 AA). |
| N11 | **The browser holds no tokens and asserts no identity.** It never sends actor, principal, tenant or role fields or headers. The BFF strips them and upstream decides. The UI hides or disables controls from `Session.actions` as a hint only. |
| N12 | **Mock parity.** The mock enforces the same roles→actions table, separation of duties, revision, claim, dual-control, idempotency, basis and CSRF rules that upstream enforces (§6.4), so the UI handles every failure path. |
| N13 | **Domain neutrality.** Nothing under `apps/web/src/platform/**` or `packages/ui-shell/**` may import from a domain module. FinCrime registers through the module contract (§8.5). |

### 0.4 Definition of done (whole build)

- [ ] `pnpm i && pnpm --filter web dev` runs the full app on the mock with no backend.
- [ ] All 40 surfaces are reachable via §8 routes, and each meets its §10 acceptance criteria.
- [ ] `pnpm test`, `pnpm test:e2e` (journeys A–G) and `pnpm test:a11y` pass.
- [ ] Every mock response validates against the OpenAPI schema, in dev and in tests, with zero violations.
- [ ] `pnpm --filter experience-bff test` passes the BFF suite (§11.4), including the EHF 03 list.
- [ ] `VITE_API_MODE=http pnpm build` contains **no MSW code**.
- [ ] `check_sources.py` and `validate_contracts.py --ehf-root .` pass in CI.
- [ ] Cutover checklist (§12, M7) complete. `apps/control-ui` removed in the same PR that routes ingress to the new app.

---

## 1. Inputs inventory

| Path | Contents | Used for |
|---|---|---|
| `kyc/docs/ui/contracts/experience-api.openapi.yaml` | OpenAPI 3.1, 136 paths, 151 ops, 67 BFF-owned schemas | Client, mock router, BFF route table |
| `kyc/docs/ui/contracts/upstream/ehf-contracts.schema.json` | 110 schemas exported from `@ehf/contracts` (zod 4.6.5) | `$ref` target; BFF also imports `@ehf/contracts` directly |
| `kyc/docs/ui/contracts/upstream/control-ui-views.schema.json` | 65 view models of the replaced BFF | PLT surface shapes |
| `kyc/docs/ui/contracts/SOURCES.lock.json` | 258 pinned upstream digests + ehfconcept commit | Sync gate |
| `kyc/docs/ui/contracts/fixtures/` | `personas`, `fincrime.catalog`, `ehf.kyb-1042`, `scenario.kyb-1042`, `platform`, `records.kyb-1042` | Mock seed |
| `kyc/docs/ui/contracts/proposed/` | 5 A2UI schemas (no upstream owner) | Presentation slot |
| `kyc/docs/ui/contracts/tools/` | `validate_contracts.py`, `check_sources.py`, exporters, `gen_appendices.py` | CI gates |
| `kyc/catalog/ehf-catalog.json` | The FinCrime catalog artifact EHF admits | Mock catalog; real catalog arrives through control-api |
| `kyc/schemas/integration/*` | TaskSpec, BusinessAgent, ContextProduct, ContextPacket, BridgeOutcome, AssignmentScope, … | FinCrime types |
| `ehfconcept/ui-specs.md` | Behaviour of every control-ui screen | PLT surfaces |
| `ehfconcept/packages/identity/src/authorization.ts` | Roles → actions | Session, mock auth |
| `kyc/docs/ui/tokens.json`, `assets/*`, `mockups/*` | Tokens, reference CSS, icons, fonts (OFL), mockups | Design system |

---

## 2. Technology stack (pinned to ehfconcept)

| Concern | Choice | Notes |
|---|---|---|
| Runtime | **Node ≥ 24, pnpm 11.9** | ehfconcept root `engines` / `packageManager` |
| Language | **TypeScript 5.9.3**, `strict`, `noUncheckedIndexedAccess`, **`skipLibCheck: true`** | `skipLibCheck` is required: openapi-typescript emits a self-referential `JsonValue` (from kyc ContextPacket) that degrades to raw JSON |
| UI | React 19.2 | Function components and hooks |
| Build | Vite 7 | SPA, served by the BFF |
| Routing / server state | TanStack Router v1, TanStack Query v5 | |
| HTTP client | `openapi-fetch` over generated `paths` | Wrapped by `ExperienceClient` |
| Contract tooling | `@redocly/cli` (bundle + lint with `contracts/redocly.yaml`), `openapi-typescript` 7 | `REDOCLY_TELEMETRY=off` |
| Validation | Ajv 8 (2020) + `ajv-formats` in browser/mock; **zod `@ehf/contracts`** in the BFF | |
| Mock | MSW 2 (browser worker + node) | No SSE in v2 |
| BFF | **fastify 5.12**, `@fastify/cookie`, `@fastify/csrf-protection` (or double-submit), `openid-client` 6, `@fastify/static` | Same framework as control-api |
| Styling | `tokens.css` + CSS Modules | No Tailwind, no CSS-in-JS runtime |
| Graphs | `elkjs` + SVG for domain graphs. **`@xyflow/react` only for the PLT-03 draft canvas** | |
| Workbench / tests | Storybook 8 + a11y addon, **vitest 4.1**, Testing Library, Playwright, `@axe-core/playwright` | |
| Lint | ESLint (typescript-eslint, jsx-a11y, react-hooks) + Prettier | Custom rules §13.3 |

No UI component framework (MUI, Chakra, shadcn). No lucide-react: use our sprite.

---

## 3. Workspace layout (inside ehfconcept)

```
ehfconcept/
├─ apps/
│  ├─ web/                         # SPA: shell, platform console, domain modules
│  │  └─ src/
│  │     ├─ shell/                 # chrome, layouts, guards, search, errors (domain-neutral)
│  │     ├─ platform/              # PLT-01…15 (domain-neutral)
│  │     ├─ domains/fincrime/      # CXT, AGT, BIZ, ASR surfaces + module manifest
│  │     └─ mock-bootstrap.ts      # only file allowed to import @ehf/ui-mock
│  ├─ experience-bff/              # fastify: auth, session, CSRF, relay, compositions, FinCrime module
│  └─ control-ui/                  # DELETED at cutover (M7)
├─ packages/
│  ├─ ui-contracts/                # vendor/ (synced, git-ignored), generated types, Ajv validators, OPERATIONS
│  ├─ ui-client/                   # ExperienceClient, query keys, polling, error mapping
│  ├─ ui-mock/                     # MSW handlers, EHF-shaped store, scenario engine, auth, faults, toolbar
│  ├─ ui-tokens/                   # tokens.json → css/ts, stateMap, fonts
│  ├─ ui-kit/                      # design-system components + Storybook
│  └─ ui-shell/                    # layout templates, module registry (domain-neutral)
├─ e2e/ui/                         # Playwright journeys, acceptance, axe
└─ scripts/ui-sync.mjs
```

### 3.1 Scripts (root `package.json`)

| Script | Does |
|---|---|
| `pnpm ui:sync` | §4.1 |
| `pnpm --filter web dev` | sync if stale → Vite dev in **mock** mode |
| `pnpm --filter web dev:http` | Vite dev, `/api` and `/auth` proxied to `experience-bff` |
| `pnpm --filter experience-bff dev` | BFF on `:4200` against local control-api `:4100`, gateway `:4101`, case-api `:4102` |
| `pnpm ui:build` | type-check + SPA build (http) + `check-bundle` + BFF build |
| `pnpm ui:test` / `ui:test:e2e` / `ui:test:a11y` | §11 |
| `pnpm ui:contracts` | `check_sources.py` + `validate_contracts.py --ehf-root .` |
| `pnpm storybook` | `packages/ui-kit` + surface stories |

### 3.2 Environment

| Variable | Where | Values | Default |
|---|---|---|---|
| `VITE_API_MODE` | web | `mock` \| `http` | `mock` in dev, `http` in build |
| `VITE_MOCK_LATENCY_MS` | web | int | `120` |
| `KYC_DOCS_UI` | sync | path to `kyc/docs/ui` | `../kyc/docs/ui` |
| `BFF_PUBLIC_ORIGIN` | bff | URL | — (required; used for Origin check and redirect URI) |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET_REF` | bff | issuer URL, id, **secret reference** | — |
| `BFF_IDENTITY_MODE` | bff | `delegated` (OBO per API, EHF 20) \| `edge` (edge token + verified actor headers, today's control-ui path) | `delegated` in production |
| `CONTROL_API_INTERNAL_URL`, `CASE_API_INTERNAL_URL`, `CAPABILITY_GATEWAY_INTERNAL_URL`, `JAEGER_API_INTERNAL_URL` | bff | URLs (https, no credentials, not localhost in production — same rule as control-ui `serviceBase`) | local ports |
| `AUTHORING_MODE` | bff | `enabled` \| `disabled` | `enabled` |
| `SESSION_STORE` | bff | `memory` (dev) \| `redis` | `memory` |

---

## 4. Contract pipeline

### 4.1 `scripts/ui-sync.mjs`

1. Run `python3 $KYC_DOCS_UI/contracts/tools/check_sources.py --kyc-root $KYC_DOCS_UI/../.. --ehf-root .`. **Abort on drift** with the report.
2. Copy into `packages/ui-contracts/vendor/`, preserving kyc-relative layout so `$ref`s resolve: `docs/ui/contracts/**`, `schemas/**`, `catalog/{ehf-catalog,context-matrix,context-products,release-lock}.json`, `tasks/*.json`, `profiles/agent.*.json`.
3. `redocly bundle vendor/docs/ui/contracts/experience-api.openapi.yaml -o vendor/bundle.json --ext json`.
4. `openapi-typescript vendor/bundle.json -o src/generated/api.d.ts`.
5. Generate `src/generated/operations.ts`: `{operationId, method, path, tag, xScreens, xUpstream, xAction, xPoll, xOwner, xStatus, mockOnly, csrf}`. The mock router, BFF relay table and coverage tests all read it.
6. Copy `docs/ui/tokens.json` and `assets/fonts/*` to `packages/ui-tokens`.
7. Write `vendor/SYNC.json` (lock digest + generated hashes). `dev` re-syncs when it changes.

`vendor/` and `src/generated/` are git-ignored. Change sources in kyc `docs/ui/contracts/` instead.

### 4.2 `@ehf/ui-contracts` exports

```ts
export type { paths, components, operations } from './generated/api';
export type Schemas = components['schemas'];             // e.g. Schemas['CaseRoom'], Schemas['HumanQueueItem']
export function validatorFor(name: keyof Schemas): Validate;
export function validateResponse(operationId: string, status: number, body: unknown): ValidationResult;
export const OPERATIONS: readonly OperationMeta[];
```

Upstream types (`executionWorkItem`, `runRecord`, `AuthoringDraftView`, `TaskSpec`, …) arrive through the bundle wherever the OpenAPI references them.

### 4.3 `@ehf/ui-client`: ExperienceClient

- `createExperienceClient({ baseUrl: '/api', getCsrf })` wraps `openapi-fetch`, with one method per operationId (e.g. `postOperationsHumanWorkWorkItemIdDecisions`).
- **Mutations:** send `X-CSRF-Token` (from `Session.csrfToken`) on every non-GET request. Send `Idempotency-Key` where declared (`POST /v1/runs`). For human decisions, the **`decisionId` is the idempotency key**: generate it once when the sheet opens and reuse it on retry.
- **Errors:** non-2xx → throw `ApiError` (the schema plus `status`). A network failure → `{error:'bff.upstream_unavailable', retryable:true}`. Keep `X-Correlation-Id` on every error.
- **Polling:** `usePolled(operationId, params)` reads `x-poll` (interval, pause when hidden, keep last good), sends `If-None-Match`, treats 304 as fresh, and backs off ×2 to 60 s on failure. A failed poll never clears data. It sets region state `stale` (§9.1).
- **Query keys:** `[operationId, params]`, except immutable digests (`planDigest`, `catalogDigest`, export `digest`) which cache `Infinity`.

| Data | Key |
|---|---|
| session | `['session']` |
| fincrime case room | `['getFincrimeCasesCaseIdRoom', {caseId}]` (ETag `"seq-<n>"`) |
| any list | `[operationId, filters]` |

- On a successful mutation, invalidate the affected keys, then **wait for the refetch** before closing a sheet (N6).

### 4.4 Portability rules

- `apps/web` never imports `@ehf/ui-mock` except from `mock-bootstrap.ts`, which is dynamically imported only when `VITE_API_MODE === 'mock'`.
- `check-bundle.mjs` fails the http build if `msw`, `ui-mock` or a fixtures path appears.
- The BFF never imports `@ehf/ui-mock`. Its contract tests use the same fixtures through `validateResponse`.

---

## 5. The Experience BFF (`apps/experience-bff`)

The BFF replaces control-ui's route handlers and `proxy.ts`. **It adds no authority** (EHF 03). It authenticates the human, keeps tokens server-side, enforces CSRF, attaches delegated identity, relays and composes. Every decision belongs upstream.

### 5.1 Sessions and auth (EHF 03 / 20)

- `GET /auth/login` → OIDC authorization code + **PKCE** (S256). Use `state` and `nonce`. Store the verifier in a short-lived server-side record.
- `GET /auth/callback` → exchange the code, validate the ID token, create a server-side session `{sessionId, subjectId, tenantId (resolved server-side), roles (resolved server-side), tokens, csrfSecret, expiresAt}` and set `__Host-ehf_session` (Secure, HttpOnly, SameSite=Lax, Path=/). **No token ever reaches the browser.**
- `POST /auth/logout` → revoke, delete the session and clear the cookie.
- **Every SPA route and every `/api` route requires a session** (fixes the unauthenticated page shells, ui-specs §10.4). Unauthenticated: an HTML request → 302 `/auth/login?returnTo=`; an API request → 401 `session.expired`.
- **CSRF:** every non-GET `/api` request needs `X-CSRF-Token` matching the session secret **and** an `Origin` equal to `BFF_PUBLIC_ORIGIN`. Otherwise 403 `csrf.invalid`.
- **Interactive users only:** a session whose actor is not human → 403 `authorization.interactive_user_required` (same as control-ui `proxy.ts`).

### 5.2 Delegated identity

- **Strip** every inbound `x-ehf-authenticated-*`, `x-actor-*`, `x-tenant-id` and `authorization` header from the browser request before relaying.
- `BFF_IDENTITY_MODE=delegated`: obtain an OBO token per audience (control-api, case-api, gateway) and send `Authorization: Bearer <delegated>`. Upstream verifies the token, audience and BFF client (EHF 20).
- `BFF_IDENTITY_MODE=edge` (transitional, matches control-ui `edgeHeaders()`): `Authorization: Bearer <EDGE_SERVICE_TOKEN | token for EDGE_TOKEN_SCOPE>` plus `x-actor-id`, `x-actor-roles`, `x-tenant-id` taken **only from the session**.
- **Never** copy an actor from a request body. For case commands, the BFF sets `actor` from the session (case-api re-derives it anyway via `verifiedActor`).

### 5.3 Session endpoint and roles

`GET /v1/session` returns `Session`:
- `roles` are resolved server-side.
- `actions` is the union of `ROLE_ACTIONS[role]` from `@ehf/identity`. Import the function; don't copy the table.
- `authoringEnabled` comes from `AUTHORING_MODE`.
- `environment` gives `{name, managedConfiguration, runtimeMode, build, synthetic}` (no hard-coded values). `managedConfiguration` is true when the environment's deployment pipeline owns provider bindings, model routing and the runtime/observability settings (§PLT-14 delta 2).
- `domains` lists the registered modules with the active catalog digest.
- `csrfToken` and `expiresAt` complete the response.

### 5.4 Relay

- The route table is **generated from `OPERATIONS`**. Each op with `x-upstream.service ∈ {control-api, case-api, capability-gateway}` maps method + path to the upstream method + path. Unknown paths → 404. There are **no catch-alls** (control-ui's `governance/[...path]` and `integrations/[...path]` are gone).
- **Path params:** validate against the OpenAPI pattern before relaying (e.g. `{id}:test`).
- **Bodies:** validate against the OpenAPI request schema (Ajv). Where the OpenAPI `$ref`s an EHF schema, validate with the zod schema from `@ehf/contracts`. Invalid → 400 `request.invalid` with `details.issues`.
- **Responses:** keep the upstream status and the `error` reason code. Wrap in `ApiError` with `message`, `correlationId`, `retryable` and **`details`** (diagnostics, issues, report, blockers, actor). **Never flatten** 409/422/500 to 400 or 502 (ui-specs §6.3, §10.2). Upstream connection failure → 503 `bff.upstream_unavailable`. Upstream 5xx → 502 `bff.upstream_failed` with the upstream code.
- **List envelopes:** normalise to `{items, nextCursor, generatedAt}` as the OpenAPI declares (control-ui did `{drafts}` → `{items}`; keep that).
- **ETag:** set `ETag` on GETs from upstream ETag if present, else a weak hash of the body. Return 304 on `If-None-Match`. For FinCrime case reads the ETag is `"seq-<caseSequence>"`.
- **Caching:** `Cache-Control: no-store` on every `/api` response. Never cache across tenants or users (EHF 03 test list).
- Rate limit 1000 req/min per session → 429 `request.rate_limit_exceeded`.
- **Telemetry:** a span per request with `http.route`, operationId and upstream status. **Never** record cookies, tokens, request bodies, evidence or prompts (EHF 21).

### 5.5 Compositions (`x-upstream.service = experience-bff`)

| Op | Composition (parity with control-ui `runtime-service.ts`) |
|---|---|
| `getOverview` | `getOverviewData()`: plans, runs by status, stale leases, cost, service readiness, model tiers |
| `getSystem` | `getSystemStatus()`: component readiness, runtime isolation, build, queue/work state, migrations, Jaeger |
| `getRunsRunId` | run + attempts + events → `RunDetail` |
| `getCasesCaseId` | case + events + snapshot + ledger verify → `CaseDetailView` |
| `getTracesTraceId` | `GET control-api /v1/traces/{id}/authority` **first**, then the trace store. 404 if unauthorised (no existence leak) |
| `getGatewayProfiles` | gateway `/v1/model-profiles` + `/v1/status` → `ModelTierProfileView[]` (real `maxInputTokens`) |
| `getSearch` | fan-out: cases (case-api), plans, drafts, catalog agents/tasks/skills; at most 8 per group |

### 5.6 FinCrime module (`apps/experience-bff/src/domains/fincrime`)

It implements every `x-owner: fincrime-module` op as a **pure projection** over upstream reads. It stores nothing.

| Op | Reads | Projection rules |
|---|---|---|
| `getFincrimeCatalog` | active release → catalog digest → `GET /v1/authoring/catalogs/fincrime/{digest}` | Parse canonical JSON. Cache by digest (immutable) |
| `getFincrimeAgents[AgentId]`, `getFincrimeTasksTaskId`, `getFincrimeSkills[SkillId]`, `getFincrimeContext*` | catalog + vendored `context-matrix.json` pinned to the catalog's `sourceRelease` | readiness = context product × agent ceiling (`context_fields`; `policy_fields` for `Policy`). Never a percentage |
| `getFincrimeWork` | human-work queue + case summaries + catalog | `mine` = session subject ∈ `assignedTo`. `claimable` = item pending and caller holds `human_work.claim`. Group: the caller already decided and quorum is unmet → `waiting_on_others`; otherwise `needs_action` |
| `getFincrimeCasesCaseIdRoom` | snapshot, work items (via human-work and runs), case events (last 6) | stages derived from work items × `task_order`; ETag `"seq-<n>"` |
| `…/claims`, `…/contradictions/{id}`, `…/ownership`, `…/screening[/{id}]` | `caseSnapshot.data` + evidence | G1: the BFF owns this projection. Unit-test it against fixtures |
| `…/decision` | snapshot + decision work item + recommendation/gate/policy/QA commands | `basis` = snapshot `{caseSequence, snapshotDigest}`. `youMay` from `Session.actions` + assignment + prior deciders |
| `…/commands:preview` | snapshot | Build the full `businessCommand` (actor from session; authority from snapshot, G6) and diff against the snapshot. Stale `preconditions.caseSequence` → 409 |
| `…/recorder[...]`, `…/lineage`, `…/assurance/mission-control` | case events, run events, human decisions, ledger verify | merged chronology; ordering in §10 ASR-02 |
| `DecisionOption` labels | module table keyed by `(workType, constraints.gate, constraints.taskId)` | G8 |

### 5.7 Static hosting

The BFF serves the SPA from `apps/web/dist` with `index.html` for unknown non-API paths, after the session check. Use a strict CSP: `default-src 'self'`, no inline script, `frame-ancestors 'none'`. Set HSTS.

---

## 6. Mock API (`packages/ui-mock`)

### 6.1 Structure

`store.ts` (EHF-shaped, seeded from `ehf.kyb-1042.json` + `platform.json`) · `fincrime.ts` (serves `scenario.kyb-1042.json` + `fincrime.catalog.json`) · `auth.ts` · `handlers/<tag>.ts` (one per OpenAPI tag, generated skeleton + hand logic) · `scenario.ts` (state machine) · `faults.ts` · `toolbar/` · `validate.ts`.

### 6.2 Seeding

- **Personas:** `personas.json`. The current persona's `session` is returned by `getSession`. Authorization uses **`roleActions` only**, never persona names.
- **EHF store:** per scenario state, `ehf.kyb-1042.json#/states/<state>`. Relay handlers (`/v1/operations/human-work`, `/v1/cases/**`, `/v1/runs/**`, `/v1/releases`) read and mutate it.
- **FinCrime projections:** `scenario.kyb-1042.json#/states/<state>`. After every mutation and every persona switch, recompute `mine`, `claimable` and `group` for the current persona (same rule as §5.6), and the `assignedTo` and `decisions` arrays from the store.
- **Platform views:** `platform.json`. Extend in place as PLT surfaces need more rows. Every addition must validate.
- **Catalog:** `fincrime.catalog.json`.

### 6.3 Handler rules

1. Every handler validates its response with `validateResponse` in dev and tests. A violation → console error plus a toolbar badge.
2. Lists honour `limit`/`cursor` and filters (`status`, `caseId`, `planDigest`).
3. GETs honour `If-None-Match` with the same ETag rules as §5.4.
4. Latency from `VITE_MOCK_LATENCY_MS` ± 30% jitter. Faults override it.
5. Mutations bump `caseSequence` and append to `caseEvents` exactly as the scenario `rules` say, and never otherwise.

### 6.4 Authorization and workflow rules (mock = upstream)

Apply in this order:

| Check | Failure |
|---|---|
| Session present | 401 `session.expired` |
| Non-GET carries `X-CSRF-Token` = session token | 403 `csrf.invalid` |
| `x-action` permitted by `roleActions` of the persona's roles | 403 `authorization.role_missing` |
| Draft approve/publish by a principal who created, updated or compiled that draft | 403 `authorization.separation_of_duties` |
| Policy revision compile by a non-author; approve by its author | 409 `policy.revision_author_mismatch` / `policy.separation_or_lifecycle_conflict` |
| Draft mutation with stale `expectedRevision` or on a PUBLISHED draft (any successful mutation bumps the revision and resets `status` to DRAFT) | 409 `authoring.revision_conflict_or_published` |
| Claim on an item not `HUMAN_REQUIRED`/`WAITING_HUMAN` | 409 `workflow.human_assignment_not_pending` |
| Decide on an item that has assignees, by a non-assignee | 409 `workflow.human_decision_not_assigned` |
| Decide on a non-pending item | 409 `workflow.human_decision_not_pending` |
| Same `decisionId`, different body | 409 `workflow.human_decision_idempotency_conflict`. Same body → 201 with the stored decision (replay) |
| **Target:** `basis.caseSequence` ≠ current | 409 `human.basis_stale` (G2) |
| Dual control: same principal decides twice | 409 `workflow.human_decision_conflict` (mock rule, G3) |
| Dual control: two different decisions | item stays `WAITING_HUMAN`, reason `workflow.human_decision_conflict`. Only `human_work.resolve` by a non-decider clears it (`workflow.human_resolution_separation_required`) |
| Quorum reached with one decision value | item `COMPLETED`, reason = that decision's `reasonCode`. Apply the scenario transition |
| Case command with stale `preconditions.caseSequence` | 200 `{outcome:'CONFLICT'}` (receipt, not an exception) |
| `RecordPolicyEvaluation` command | 403 `policy.evaluator_endpoint_required` |
| Release transition with stale `expectedRevision` | 409 `release.transition_failed` |

### 6.5 Scenario engine

States: `ownership_review → screening_review → decision_pending → second_approval → decided` (shorthand **S1–S5**). Transitions are in `scenario.kyb-1042.json#/transitions` and fire on the human decision that completes the named work item. Other effects:

- `ResolveContradiction` on `cf-12` in S1: `caseSequence` 14 → 15. The contradiction shows RESOLVED and the claims view updates. The state doesn't change.
- `RETURN` on `wi_own_review`: the item completes with a RETURN outcome, a new work item `wi_own_rework` (READY, `agent.identity_ownership`) appears, and the attention queue moves the case to *Prepared by agents*.
- `REJECT` on `wi_scr_review`: case status → `INVESTIGATING`, and the attention item "EDD required" appears (gap G11 frame).
- Toolbar jumps set the state directly and reset the store slice.

### 6.6 Faults (`PUT /mock/faults`)

`latencyMs`, `offline` (all requests fail as network), `failNext {status, error}`, `staleBasisNext` (next decision → `human.basis_stale`), `expireSessionNext`, `csrfRejectNext`, `revokeRoleNext <role>` (removes a role after page load: the next mutation → 403, and the session refetch shows the change), `upstreamDown [service]` (ops on that service → 503 `bff.upstream_unavailable`). Faults are one-shot unless marked sticky in the toolbar.

### 6.7 Mock toolbar

A floating panel (mock mode only): persona switcher (13), scenario jump (S1–S5), clock (+1 h / +1 d / set), faults, "reset store", and a response-violation counter. It mounts from `mock-bootstrap.ts`.

---

## 7. Design system (`packages/ui-tokens`, `packages/ui-kit`)

### 7.1 Tokens, fonts, icons

As v1. Source `docs/ui/tokens.json`. Generate `tokens.css` (identical variables to `assets/tokens.css`, including compact density, reduced-motion and high-contrast) and `tokens.ts`. `stateMap` maps enum → tone. Export `stateTone(dimension, value)` and `stateGlyph(dimension, value)`. Self-host fonts (OFL). Port the sprite in `assets/shell.js` to `<Icon>`.

**stateMap additions for v2** are already in `tokens.json` (tones are the existing set: positive · attention · blocking · info · neutral · running):

| Dimension (key in `stateMap`) | EHF enum | Notable mappings |
|---|---|---|
| `WorkItemStatus` | `executionWorkItemStatus` | RUNNING → running · HUMAN_REQUIRED, WAITING_HUMAN → attention (hand glyph) · COMPLETED → positive · FAILED, BLOCKED → blocking |
| `RunStatus` | `runStatus` | running, retrying → running · manual_review → attention · denied, failed → blocking |
| `KycCaseStatus` | `kycCaseStatus` | review/decision states → attention · APPROVED → positive · **DECLINED → neutral** (a decision, not a failure; own glyph) |
| `ReleaseStatus` | `releaseStatus` | active → positive · revoked → blocking |
| `AuthoringStatus` | control-ui `AuthoringStatus` | PUBLISHED → positive |
| `PolicyDecision` | `policyDecision` | ALLOW → positive · REVIEW, **UNKNOWN → attention (never positive)** · BLOCK, ERROR → blocking |
| `CommandOutcome` | `commandOutcome` | CONFLICT → attention · REJECTED → blocking |
| `HumanDecision` | `humanWorkDecision.decision` | all neutral with distinct glyphs: a decision is neither good nor bad |
| `ContextReadiness` | `ContextReadinessMatrix.cells[].status` | gaps → attention · not_subscribed → neutral (hatched) |

### 7.2 Component inventory

Every component gets a Storybook story per state value, plus keyboard and axe checks. v1 components are kept unless struck below.

- **Primitives (v1):** Button (no trusted variant), SegmentedControl, Tabs, Chip, Id, Hash/**DigestValue** (ui-specs §2.2: truncate `first15…last6` when > 22, title = full, copy), **LocalTimestamp** (compact `HH:MM:SS`, tooltip UTC), Switch, Field/TextArea/Select, Table, Sheet, Tooltip, Skeleton, EmptyState, **JsonViewer** (wrap toggle, copy), **InspectorSection** (`<details>`, count badge).
- **Platform components (new, from ui-specs §2.2):** `ReadinessBadge`, `FreshnessIndicator`, `StaleDataBanner` (keeps last good, "Retry now"), `InlineMessage` (ok/error, `role=status`), `LifecycleRail` (DRAFT→COMPILED→EVALUATED→APPROVED→PUBLISHED with who/when), `DiagnosticsList` (code, path, message, severity; links into the source editor), `SourceEditor` (mono, YAML, dirty/discard bar, expectedRevision footer), `KeyValueEditor`/`JsonSchemaEditor`, `GraphCanvas` (xyflow; edit mode with batched moves, §10 PLT-03), `RunTimeline`, `NodeAttemptTable`, `SpanWaterfall`, `ServiceReadinessGrid`, `ReleaseCard`, `DeploymentWizard`, `ChangeLogTable`, `ErrorDetail` (reason code + message + details + correlation id).
- **Domain components (v1, data-retargeted):**

| Component | v2 data | Notes |
|---|---|---|
| `StatusBadge`, `EpistemicMarker`, `ObjectHeader`, `Disclosure`, `SyntheticPill` | unchanged | `EpistemicMarker` adds `claim` and `assumption` kinds |
| `InstrumentBank`, `ReadinessMeter` | `ContextReadinessMatrix` cells | 12 banks = 12 products, fixed positions |
| `SkillKey`, `SkillInspector` | `SkillSummary`, `SkillDetail.manifest` | Binding markers removed (no draft bindings upstream); show allowed/not-allowed for the agent |
| `TaskSpecPanel`, `DependencyMap` | `TaskComposition` | lanes = `parallelGroup`; gate = `requiresHumanDecision` |
| `ContextHandshake` | `SkillDetail.fieldRequirements` × `AgentDetail.ceilings` | requirement states: met · outside ceiling · missing (dry run, G4) |
| `OwnershipGraph`, `ReconciliationTable` | `OwnershipView`, `ContradictionDetail.reconciliation` | unchanged rules |
| `VerificationDrawer` | `ContradictionDetail` | actions are `CommandAffordance`s |
| `AttentionQueue`/`WorkItemRow` | `AttentionQueue` | 5 groups; shows `n/requiredApprovals` and the claim state |
| `StageTrack` | `CaseRoom.stages` | statuses incl. `needs_review`, `needs_evidence` |
| `HumanWorkCard` (**new**) | `HumanQueueItem` | objective, gate, assignees, decisions so far (who, what, when), dual-control meter `1 of 2`, Claim button |
| `ComparisonView`, `PolicyEvaluationList`, `RiskAttribution`, `ThreeObjects` | `ScreeningComparison`, `DecisionDesk` | ThreeObjects = recommendation · policy evaluation · human decision(s) |
| `CommandPreviewPanel` (**replaces** ImpactPreview) | `CommandPreview` | diff rows, effects, warnings, basis |
| `ActionBar`/`ActionSheet` | `CommandAffordance[]` | disabled with reason; L1 commands only |
| `TrustedDecisionSheet` (**replaces** TrustedApprovalSheet) | `HumanQueueItem` + `DecisionOption[]` + `basis` | §9.3 |
| `ChronologyList`, `CausalLanes`, `EventInspector`, `SpanRail`, `LineageGraph` | `FlightRecorder`, `CausalGraph`, `RecorderEntryDetail`, `NativeTraceView`, `LineageGraph` | |
| `A2UISlot` | `proposed/SurfaceInstance` | unchanged |
| *Removed* | `BindingMarker` editing, `HandoffCard`, `ImpactPreview`, `ApprovalView` | no upstream contract |

### 7.3 Formatting helpers

As v1 (`fmtPercent` from decimal strings, `fmtDuration`, `fmtHash`, …). Add `fmtDigest` (same as DigestValue), `fmtCost` (`costUsd` with 4 dp, plus "incomplete" when `costComplete=false`) and `fmtReason(code)` (maps a reason code to copy from the domain module or platform table; unknown codes show the code verbatim).

---

## 8. App shell and routing (`apps/web`)

### 8.1 P0 chrome (application-owned)

Left to right: brand tile + **"EHF"** (→ `/`); experience switcher; ⌘K search; SyntheticPill; environment chip (`Session.environment.name` + `runtimeMode`, from data, never hard-coded); readiness badge (from `/v1/system`, polled 15 s); notifications (stub); avatar + name + first role.

The experience switcher shows **Workspace · Agent Studio · Contextboard · Assurance** (from domain modules) and **Platform** (always). Each item appears only if the session holds at least one action its routes require (§8.4).

### 8.2 Layout templates

As v1 (`WorkspaceLayout` with `orient`, `main`, `inspector`, `rail`). At ≥ 1440 px the CaseRoom rail renders as the **bottom bar** (concept slide 4: case history · task status · agent activity). Platform pages use `ConsoleLayout`, the ui-specs §2.1 shell: left nav 248 px ≥ 1280, a 72 px icon rail at 960–1279, a drawer below 960, a sticky top bar with breadcrumb, title, freshness, Refresh and actions.

### 8.3 Route table

| Route | Surface | Template | Required action (any) |
|---|---|---|---|
| `/` | hub → `persona.landingRoute` | — | session |
| `/work` | BIZ-01 | Queue | `human_work.read` \| `case.read` |
| `/work/cases/$caseId[/$section]` | BIZ-02 (`activity · evidence · claims · work · decisions · history`) | CaseRoom | `case.read` |
| `/work/cases/$caseId/lens/ownership` | BIZ-03 | CaseRoom | `case.read` |
| `/work/cases/$caseId/lens/edd` · `/lens/aml` | BIZ-04 · BIZ-05 | CaseRoom | `case.read` |
| `/work/cases/$caseId/lens/screening` (`?finding=`) | BIZ-06 | CaseRoom | `case.read` |
| `/work/cases/$caseId/lens/risk` · `/lens/qa` | BIZ-07 risk view · BIZ-08 | CaseRoom | `case.read` |
| `/work/decisions/$caseId` (`#decide`) | BIZ-07 | DecisionDesk | `case.read` |
| `/work/ops` | BIZ-09 | Queue | `human_work.read` |
| `/agents` | AGT-01 | Atlas | `draft.read` |
| `/agents/$agentId` | AGT-02 | Instrument | `draft.read` |
| `/agents/$agentId/tasks/$taskId` (`?step=&tab=`) | AGT-03 + AGT-04 (+ AGT-05 at `tab=context`) | Instrument | `draft.read` |
| `/agents/$agentId/rehearsal/$runId` | AGT-06 | Preview | `run.read` |
| `/agents/$agentId/publish` | AGT-07 | Instrument | `release.read` |
| `/agents/skills/$skillId` | skill detail | Instrument | `draft.read` |
| `/context` (`?agent=&mode=play\|tune\|engineer&product=`) | CXT-01/02/03 | Instrument | `draft.read` |
| `/context/preview` (`?agent=&task=&case=`) | CXT-04 | Preview | `draft.read` |
| `/assurance` | ASR-01 | Queue | `run.read` \| `human_work.read` |
| `/assurance/recorder/$caseId` (`?entry=&tab=chronology\|causality\|traces`) | ASR-02 | Recorder | `event.read` |
| `/assurance/lineage/$caseId` (`?decision=&node=`) | ASR-03 | Lineage | `case.read` |
| `/assurance/lab` | ASR-04 | Queue | `run.read` |
| `/assurance/packages` (`?case=`) | ASR-05 | Queue | `case.read` |
| `/platform` | PLT-01 | Console | any read action |
| `/platform/drafts`, `/platform/drafts/$draftId` (`?tab=`) | PLT-02, PLT-03 | Console | `draft.read` |
| `/platform/drafts/$draftId/policies`, `/platform/policies` | PLT-04 | Console | `draft.read` |
| `/platform/plans`, `/platform/plans/$planDigest` | PLT-05 | Console | `plan.read` |
| `/platform/runs`, `/platform/runs/$runId` | PLT-06, PLT-07 | Console | `run.read` |
| `/platform/traces/$traceId` | PLT-08 | Console | `telemetry.read` \| `run.read` |
| `/platform/cases`, `/platform/cases/$caseId` | PLT-09 | Console | `case.read` |
| `/platform/human-work` | PLT-10 | Console | `human_work.read` |
| `/platform/releases` | PLT-11 | Console | `release.read` |
| `/platform/system` (`?tab=services\|gateway\|runtime`) | PLT-12 | Console | `capability.read` \| `telemetry.read` |
| `/platform/admin` (`?tab=models\|providers\|capabilities\|settings\|changes`) | PLT-14 | Console | `admin.read` |
| `/platform/integrations` | PLT-15 | Console | `integration.read` |
| `/platform/document-factory` (`?tab=releases\|datasets\|jobs`) | PLT-23 | Console | `dataset.read` |
| `*` | 404 with search | — | — |

**Guards:** a missing action renders a **403 surface** naming the role(s) that grant it ("Requires Harness.Approver"). Never a silent redirect. With `authoringEnabled=false`, `/platform/drafts*` and `/platform/policies` render "Authoring is disabled in this environment", and the switcher hides authoring entries (ui-specs §1.4).

### 8.4 Cross-links ("Open in…")

Typed helpers:

- work item → `/work/cases/$caseId/...` (domain) or `/platform/human-work?item=` (platform)
- run → `/platform/runs/$runId`
- trace → `/platform/traces/$traceId`
- case event → `/assurance/recorder/$caseId?entry=`
- plan → `/platform/plans/$digest`
- skill → `/agents/skills/$id`
- context product → `/context?product=`
- release → `/platform/releases?release=`

### 8.5 Domain module contract

```ts
export interface DomainModule {
  id: 'fincrime';
  label: string;
  studios: { id: string; label: string; icon: IconName; route: string; requires: PlatformAction[] }[];
  routes: RouteTree;                                    // mounted under the studio paths above
  decisionOptions(item: Schemas['HumanQueueItem']): Schemas['DecisionOption'][] | null; // null → platform defaults
  commandLabel(type: Schemas['CaseCommandRequest']['commandType']): string;
  reasonLabel(code: string): string | undefined;
  search?: (q: string) => Promise<SearchGroup[]>;
}
```

The platform console uses `decisionOptions` when it renders a human-work item from a domain (PLT-10). Without a module it shows the neutral labels *Approve · Reject · Return*.

---

## 9. Cross-cutting behaviours

### 9.1 Region states

`useRegionState(query)` derives `idle · loading · ready · stale · conflict · offline · degraded · retryable_failure · terminal_failure`. Buttons track `committing · confirmed`. Rendering is as v1, plus:

- **stale** (poll failed) → `StaleDataBanner` ("Showing the last verified data from 14:05:12. Refresh failed (bff.upstream_unavailable). Retry now"). L2/L3 controls are disabled with a reason.
- **session expired** (401) → a modal "Your session ended" with Sign in again (`/auth/login?returnTo=`). Unsaved input stays in memory.

### 9.2 Error UI by reason code

| Code(s) | UI |
|---|---|
| `authorization.role_missing` | Region or inline "Your role doesn't permit this", plus which role does |
| `authorization.separation_of_duties`, `policy.separation_or_lifecycle_conflict` | "You authored or compiled this, so someone else must approve it." No retry |
| `authoring.revision_conflict_or_published` | Conflict view: "Changed since you opened it (rev 7 → 8)". Reload, then re-apply your edit by hand. Never auto-merge |
| `workflow.human_assignment_not_pending`, `…decision_not_pending` | "This item is no longer waiting for a decision." Refresh the item |
| `workflow.human_decision_not_assigned` | "Claimed by A. Ruiz. Claim it too, or ask them" (show assignees) |
| `workflow.human_decision_conflict` | Dual-control conflict banner. Resolution needs `human_work.resolve` by someone who did not decide |
| `workflow.human_decision_idempotency_conflict` | "This decision was already recorded with different content." Show the stored decision |
| `human.basis_stale` | "The case changed while you were reviewing (sequence 14 → 15)." Show what changed (case events between), then **Review again** reloads the sheet. Never resubmit automatically |
| `CommandReceipt.outcome = CONFLICT` | Same pattern as basis stale, for commands |
| `csrf.invalid` | Refetch session, then ask the user to retry |
| `request.rate_limit_exceeded` | Back off, toast |
| `bff.upstream_unavailable` / `failed` | degraded/offline per §9.1 with the service name |
| 422 with `details.diagnostics` | `DiagnosticsList` inline |

Always show the correlation id in a disclosure ("Details").

### 9.3 Human decisions (TrustedDecisionSheet, P3)

Opened from `HumanWorkCard`, the Decision Desk (`#decide`), Screening or Ownership.

1. **Header band:** "PLATFORM-VERIFIED ACTION · not agent-composed". Show work item id, objective, gate and case id.
2. **Basis:** `caseSequence` + `snapshotDigest` (DigestValue) and "You are deciding on the case as of sequence 31".
3. **Dual control:** `requiredApprovals`. Prior decisions (who, decision, when, rationale excerpt). If the caller already decided → the sheet is read-only with "You've already decided. A second, different approver is required."
4. **Claim:** if the item has assignees and the caller isn't one, show "Claim to decide" (`postOperationsHumanWorkWorkItemIdClaim`) first. Claiming doesn't lock others out (EHF behaviour). Say so.
5. **Decision:** SegmentedControl of `DecisionOption`s (label + consequence). `reasonCode` select from `option.reasonCodes`. Rationale (required, ≤ 10 000). Evidence picker (`evidenceRefs`). Fields render from `option.form` (`humanActionUi`).
6. **Attestation:** checkbox "I reviewed the evidence and this decision is mine" (G9: no step-up).
7. **Submit:** *Decide* (`btn--trusted`, defined **only** here) → `postOperationsHumanWorkWorkItemIdDecisions` with `{caseId, decisionId (created when the sheet opened), decision, reasonCode, rationale, evidenceRefs, basis}` → *Recording…* → refetch the item and the case room → *Recorded* (+ "1 of 2 approvals — waiting for a second approver" when quorum is unmet). Close only after the refetch.
8. **Retry** after a network error reuses the same `decisionId` (replay-safe).

### 9.4 Business commands (L1, non-trusted)

`CommandAffordance` → `ActionSheet` with the payload form → `postFincrimeCasesCaseIdCommandsPreview` → `CommandPreviewPanel` → Submit → `postCasesCaseIdCommands` with the same body and `idempotencyKey` → `CommandReceipt`. `ACCEPTED` → refetch and close. `CONFLICT` → §9.2. `REJECTED` → show `reasonCode`. `IN_PROGRESS` → poll the case room until the sequence advances. `FinalizeDisposition` and `RecordReview` are **not** offered as affordances. They are produced by human-work decisions or by agents.

### 9.5 Freshness

Polling per `x-poll`, paused when the tab is hidden. Queues don't reorder while focused or selected: show "N new items" and apply on click (v1 rule). Values update in place inside reserved boxes. A "live · 5 s" `FreshnessIndicator` shows on polled regions and switches to "stale · refresh failed" on error.

### 9.6 A2UI slots, epistemic rules, copy, accessibility, density

As v1 §9.6–9.10. One change: the slot fallback for case work products is the deterministic card built from `CaseRoom.workItems` (BridgeOutcome status) and `ClaimsView`.

---

## 10. Surface specifications

Format: **Route · Data (operationIds) · Layout · Actions · ACs.** ACs are test cases named `<ID>-AC<n>`. **Scenario shorthand:** S1 `ownership_review`, S2 `screening_review`, S3 `decision_pending`, S4 `second_approval`, S5 `decided`.

### 10.0 Shell

- **Data:** `getSession`, `getSystem` (readiness, 15 s), `getSearch`.
- **AC1:** No hard-coded environment, mode, build or telemetry text. Changing `Session.environment` in the mock changes the chrome.
- **AC2:** The switcher shows only experiences the session can use. Deep-linking a forbidden route shows the 403 surface naming the granting role.
- **AC3:** ⌘K → "KYB-1042" → Enter opens the case room.
- **AC4:** Switching persona refetches the session and re-filters navigation with no reload.
- **AC5:** With `expireSessionNext`, the next request shows the session-ended modal. After sign-in, the user returns to the same route.
- **AC6:** With `revokeRoleNext Case.Reviewer`, the next decide returns 403, the session refetches, and the decide controls disable with a reason.
- **AC7:** The SPA makes no request without `X-CSRF-Token` on non-GET (network assertion over journeys A–G).

---

### Platform console (PLT)

Behaviour follows **ui-specs.md** sections as cited. The deltas listed here win.

#### PLT-01 · Overview — `/platform`
- **Data:** `getOverview` (15 s, ETag).
- **Layout:** KPI tiles (admitted harnesses, active, queued, running, retrying, needs attention, failed, denied, stale leases, 24 h cost) · active runs table · recent issues · service status grid · model tiers.
- **AC1:** Every tile links to the filtered list (e.g. failed → `/platform/runs?status=failed`).
- **AC2:** Cost shows "incomplete" when the underlying runs have `costComplete=false`.

#### PLT-02 · Drafts — `/platform/drafts` (ui-specs §4.1)
- **Data:** `getAuthoringDrafts` (5 s), `getAuthoringTemplates`, `postAuthoringDrafts`.
- **AC1:** "New draft" from a template or blank. "Import FinCrime catalog" (`postAuthoringImportFincrime`, needs `agent.register`) shows the artifact digest and catalog counts.
- **AC2:** Status uses the `authoring` dimension. PUBLISHED rows show the plan digest (DigestValue).

#### PLT-03 · Draft workspace — `/platform/drafts/$draftId?tab=workflow|agents|sources|capabilities|models|integrations|release` (ui-specs §4.2–4.10)
- **Data:** `getAuthoringDraftsDraftId` (5 s, ETag), every draft mutation op, `postAuthoringDraftsDraftIdValidate`, registry reads (`getAuthoringAgents`, `getAuthoringSkills`, `getGatewayRegistry`, `getGatewayAdapters`, `getGatewayProfiles`).
- **Deltas from ui-specs:**
  1. Context selectors and classification policies save through their own ops (§10.1 fix).
  2. Canvas: **View** mode by default. **Edit canvas** toggles editing. Node moves are buffered and committed as **one** `graph` mutation on drop or after 1 s idle (§10.4 fix).
  3. `caseWrites[].commandType` is a Select over `businessCommandType`.
  4. Validate runs on demand and before compile, and shows `DiagnosticsList`.
  5. 422 diagnostics from compile, evaluate or orchestration-nodes are shown.
  6. Agent status chip reflects the registry status (no always-green).
  7. Review & release tab: **no one-click "compile & publish"**. Approve and publish are enabled only for a principal holding `draft.approve`/`draft.publish` who isn't an author. Otherwise they're disabled with "Needs a different approver (separation of duties)".
- **AC1:** Editing as `agent_architect` then approving as the same persona → the control is disabled. Forcing the call → 403 `authorization.separation_of_duties` → "someone else must approve".
- **AC2:** Two tabs editing the same draft: the second save → 409 conflict view with both revisions. No data loss in the losing tab's editor.
- **AC3:** Dragging three nodes in edit mode produces **one** revision.
- **AC4:** Context selectors save as their own mutation and survive a reload.
- **AC5:** Compile failure shows diagnostics with code and path, and clicking one focuses the source editor at the path.

#### PLT-04 · Policy Studio — `/platform/drafts/$draftId/policies`, `/platform/policies` (ui-specs §4.11)
- **Data:** `getAuthoringPolicies`, `postAuthoringPoliciesCompile`, `postAuthoringPoliciesEvaluate`, revision workspace ops.
- **AC1:** Compile of a revision by a non-author → `policy.revision_author_mismatch` copy. Approve by the author → separation copy.
- **AC2:** A production-blocked compile shows `details.blockers` as a list (not a generic failure).
- **AC3:** The test-corpus runner (`evaluate`) shows the policy decision per gate with the `policy` dimension.

#### PLT-05 · Plans — `/platform/plans[/$planDigest]`
- **Data:** `getPlans`, `getPlansPlanDigest`, `getPlansPlanDigestRuns`, `postPlans` (admit, `plan.admit`), `postRuns` (start, `run.start`, Idempotency-Key).
- **Layout:** list with node/edge counts, tiers, completion rate, p50/p95, last run. Detail: graph preview (read-only xyflow), budgets, dependencies, runs table, "Start run" form (JSON input validated against the plan's input schema).
- **AC1:** Starting twice with the same Idempotency-Key returns the same run (200) and the UI links to it rather than creating a duplicate.
- **AC2:** When runtime admission is stopped, start → 409 and the copy points to PLT-12 runtime tab.

#### PLT-06 / PLT-07 · Runs / Run detail — `/platform/runs[/$runId]`
- **Data:** `getRuns` (5 s), `getRunsRunId` (3 s), `getRunsRunIdEvents?after=` (3 s, incremental), `getRunsRunIdAttempts`, `getRunsRunIdTrace`, `postRunsRunIdCancel` (`run.cancel`, reason required).
- **AC1:** Events are appended incrementally using `after = last sequence`. No duplicates, and order is by `sequence`.
- **AC2:** `manual_review` links to the human-work item(s) for the run.
- **AC3:** Cancel of a terminal run → 409 `run.already_terminal` shown inline with the run's state.
- **AC4:** The trace link opens PLT-08. When `trace.not_bound`, show "No trace bound to this run".

#### PLT-08 · Trace — `/platform/traces/$traceId`
- **Data:** `getTracesTraceId`.
- **AC1:** An unauthorised trace renders as not found (no existence leak).
- **AC2:** Span attributes never show cookie, authorization or body fields. The view renders an allow-list of attributes.

#### PLT-09 · Cases (platform view) — `/platform/cases[/$caseId]`
- **Data:** `getCases`, `postCases`, `getCasesCaseId` (5 s, ETag), `getCasesCaseIdSnapshot`, `getCasesCaseIdEvents`, `postCasesCaseIdLedgerVerify`, exports.
- **AC1:** Create case fixes jurisdiction to US and says why (G14).
- **AC2:** Ledger verify shows checked events, head digest and `failedSequence` when broken.
- **AC3:** "Open in Workspace" appears when the case type belongs to a registered domain.

#### PLT-10 · Human work — `/platform/human-work` (`?item=&case=`)
- **Data:** `getOperationsHumanWork` (5 s), claim, decisions, resolve.
- **Layout:** queue table (case, objective, gate, status, assignees, `n/required`, deadline, overdue/escalated flags) + `HumanWorkCard` inspector. Decisions use `TrustedDecisionSheet` with module options when the item belongs to a domain.
- **AC1:** Resolve is offered only to `human_work.resolve` holders on items in `workflow.human_decision_conflict`. It is disabled for principals who decided ("You decided this item").
- **AC2:** Overdue and escalated show glyph + text.

#### PLT-11 · Releases — `/platform/releases`
- **Data:** `getReleases` (15 s), `postReleases`, `postReleasesReleaseIdTransition`.
- **AC1:** Transitions offered = allowed next states × caller actions (`release.approve` for approved; `release.activate` for active/deprecated; `release.revoke` for revoked). Each runs in the `TrustedDecisionSheet` variant with `expectedRevision` and a reason code.
- **AC2:** A stale revision → 409 → conflict copy and refresh.
- **AC3:** Registering a manifest with an invalid signature → 422 `release.signature_invalid` shown verbatim.

#### PLT-12 · Health — `/platform/system?tab=services|gateway|runtime`
- **Data:** `getSystem`, `getGatewayStatus`, `getGatewayProfiles`, `getGatewayCapabilities`, `getGatewayDecisions`, `postGatewayOpenrouterTest`, `getAdminRuntime`, `postAdminRuntime`.
- **AC1:** Stopping admission asks for an active-run policy (drain | cancel) in a trusted sheet and reports the cancelled count.
- **AC2:** Gateway decisions filter by run and decision. Denials link to the run.

#### PLT-13 · Deployment Studio — removed
The in-product deployment studio (`/v1/deployments/*`, bootstrap runs, cloud discovery) was removed from the platform (apps/web CONTRACT-GAPS GAP-116). Environments are deployed by their own pipeline, cloud-neutrally; the console has no deployment surface. The id is kept so references stay unambiguous.

#### PLT-14 · Administration — `/platform/admin?tab=…` (ui-specs §5)
- **Data:** admin ops, `getGatewayRegistry`/`postGatewayRegistry` for the capabilities tab, `postSigningKeysRevoke`.
- **Deltas:**
  1. Tab drafts persist across tab switches (in-memory store per tab).
  2. When `Session.environment.managedConfiguration` is true, every write requires a `reason`, and fields owned by the deployment pipeline are read-only with "Deployment configuration — change via deployment".
  3. Upstream 409/500 are shown as such.
  4. The capabilities tab round-trips `model`-kind entries.
  5. `credentialRef` is a reference input (pattern `^[A-Z][A-Z0-9_]{2,64}$`) with a lock glyph. No secret is ever displayed or accepted.
- **AC1:** As `auditor`, all tabs are readable and every write control is disabled with "Requires Platform.Admin".
- **AC2:** Change history shows before/after digests and reason, with a JSON diff on expand.

#### PLT-15 · Integrations — `/platform/integrations`
- **Data:** integration ops.
- **AC1:** Binding actions (`:test`, `:activate`, `:pause`) appear per caller action (`integration.test`, …). Delivery replay requires `integration.replay`.
- **AC2:** Connector credentials are `secret_ref` only.

#### PLT-23 · Document Factory — `/platform/document-factory?tab=releases|datasets|jobs`
Train, evaluate and release document models per catalog type (document factory plan §7.4).
- **Data:** `getDocumentFactory` (overview), `postDocumentFactoryReleasePlan`, `postDocumentFactoryReleaseJobs`,
  `getDocumentFactoryReleaseJobsJobId`, `getDocumentFactoryReportsDigest`, and the approve, activate and rollback operations.
- **AC1 (New release):** select types, or "everything with new data since the active release". Readiness is shown per type,
  and a blocked type says what is missing without stopping the others. The plan and estimate show their pricing basis,
  and planning records a job that waits for spend approval.
- **AC2 (Approve spend):** `factory.train`. The planner cannot approve their own job's spend. Over the budget limit, a
  budget owner must also approve.
- **AC3 (Run):** the job's stage and per-type progress update while it runs, and it can be cancelled.
- **AC4 (Review and release):** the report shows metrics and gates per type. Approving a release (`release.approve`) is
  refused to its registrant. Activation (`release.activate`) names an environment and optionally a date. Rollback puts
  the previous release back in effect.
- **AC5 (Datasets):** each type's strategy, current dataset version (counts per split, readiness) and history.

---

### FinCrime: Contextboard (CXT)

#### CXT-01 · Contextboard (Play) — `/context?agent=&mode=play`
- **Data:** `getFincrimeContextProducts`, `getFincrimeContextReadiness` (`?agentId`), `getFincrimeCatalog`.
- **Layout:** orient = agents (consumer perspective; "All agents" default) · main = `ObjectHeader` (catalog digest, source release, context schema version) → 12 `InstrumentBank`s in three bays (Subject: identity, ownership, party360, network · Sources: document, registry, screening, transaction, evidence · Governance: risk, case, policy) → legend · inspector = product objects/fields, consumers, ceilings for the selected agent.
- **AC1:** Bank positions are fixed and independent of readiness.
- **AC2:** Each bank shows the cell status **in words** and the field counts. No percentages.
- **AC3:** Selecting an agent restricts banks to its subscriptions. Unsubscribed banks render `not_subscribed` (neutral, hatched).
- **AC4:** Keyboard arrow-grid navigation. The aria-label includes name, status and counts.

#### CXT-02 · Composition (Tune) — `/context?mode=tune&product=`
Context composition upstream is **harness-draft context selectors + classification policies**. Tune is therefore a focused editor over a draft.
- **Data:** `getAuthoringDrafts` (pick a draft), `getAuthoringDraftsDraftId`, `putAuthoringDraftsDraftIdContextSelectors`, `putAuthoringDraftsDraftIdContextClassificationPolicies`.
- **AC1:** No draft selected → "Choose a draft to compose context for", with a link to PLT-02. Production readiness (Play) never changes from Tune edits.
- **AC2:** Saving sends `expectedRevision`. A conflict shows the §9.2 conflict view.
- **AC3:** Requires `draft.write`. Others see read-only selectors.

#### CXT-03 · Engineer — `/context?mode=engineer&product=`
- **Data:** `getFincrimeContextProductsProductId`, `getGatewayRegistry`, `getGatewayAdapters`.
- **AC1:** Field requirements table (object, field, required, min count, on missing, freshness, skill) for the product.
- **AC2:** The provider binding panel shows `capabilityReadiness.status = pending_upstream` as a neutral disclosure (G5). Gateway capabilities and adapters are listed read-only.
- **AC3:** No secret value is ever rendered.

#### CXT-04 · Context preview — `/context/preview?agent=&task=&case=`
- **Data:** `postFincrimeContextPacketsPreview` (`x-status: needs-upstream`).
- **AC1:** Until G4 closes, the mock returns 503 `bff.upstream_unavailable` with `details.blockers=['bridge.preview_unavailable']`. The surface renders its frame plus the disclosure "Context packet preview needs a Bridge preview hook". No fabricated packet.

### FinCrime: Agent Studio (AGT)

#### AGT-01 · Workforce Atlas — `/agents`
- **Data:** `getFincrimeAgents` (15 s).
- **AC1:** **6** agent cards (id, mandate, personas, task ids, human gates, readiness, active work counts). The release chip comes from `publication.release.status`.
- **AC2:** Readiness and publication are separate chips.
- **AC3:** The header shows catalog digest + source release.

#### AGT-02 · Agent profile — `/agents/$agentId`
- **Data:** `getFincrimeAgentsAgentId`.
- **AC1:** Execution bounds from `agent.execution` (`max_agent_steps`, `max_objects`, `model_char_budget`, `timeout_seconds`, purposes) and ceilings (`context_fields`, `policy_fields`) as tables.
- **AC2:** Human gates listed verbatim. Allowed skills with versions.

#### AGT-03 / AGT-04 · Taskboard + Skillboard — `/agents/$agentId/tasks/$taskId?step=`
- **Data:** `getFincrimeTasksTaskId`, `getFincrimeSkillsSkillId`.
- **AC1:** The `DependencyMap` shows steps with `parallelGroup` lanes. `task.identity_ownership` shows entity ∥ registry → UBO resolve → UBO verify (F2 resolved: no duplicate-execution disclosure).
- **AC2:** Steps with `requiresHumanDecision` show the gate glyph.
- **AC3:** The validation chips come from `TaskComposition.validation`.
- **AC4:** The inspector tabs are Contract, Context (AGT-05), Guardrails, Evaluation and Trace. There's no Tune binding editor: "Bindings are defined in the FinCrime catalog (kyc) and admitted per release."

#### AGT-05 · Context handshake — `?tab=context`
- **AC1:** Each requirement row shows met / **outside agent ceiling** / needs runtime check. No aggregate percentage.
- **AC2:** "Dry run" links to CXT-04 (needs-upstream).

#### AGT-06 · Rehearsal — `/agents/$agentId/rehearsal/$runId`
- **Data:** `postRuns` (synthetic case input) → `getRunsRunId`, `getRunsRunIdEvents`.
- **AC1:** Events stream in by polling `after`. `manual_review` shows as attention, not failure.

#### AGT-07 · Publish & diff — `/agents/$agentId/publish`
- **Data:** `getReleases`, `getFincrimeCatalog`.
- **AC1:** The active and candidate releases are shown side by side (manifest digest, status, revision). The diff is a G10 disclosure. Transitions are deep links to PLT-11.

### FinCrime: KYC Workspace (BIZ)

#### BIZ-01 · My Workspace — `/work`
- **Data:** `getFincrimeWork` (5 s, ETag).
- **Layout (concept slide 5):** KPI tiles; attention groups; each `WorkItemRow` shows case, subject, objective, gate, claim state, `n/required`, deadline; inspector = accountable human step (objective, expected work product, options preview) + "Open".
- **AC1:** No reorder while focused. The "N new items" pill appears.
- **AC2:** In S4, the item sits under *Waiting on a second approver* for `s.varga` and under *Needs your decision* for `h.adeyemi`.
- **AC3:** Enter opens the route in `item.route`.

#### BIZ-02 · Case room — `/work/cases/$caseId[/$section]`
- **Data:** `getFincrimeCasesCaseIdRoom` (5 s, ETag `seq-n`), `getFincrimeCasesCaseIdClaims`, `getCasesCaseIdEvents`, `getIntegrationsHumanCasesCaseIdActions`.
- **Layout (concept slide 4):** orient *My Work* (current human step, sections, lenses with badges, case timeline) · main header (subject, status `case` dimension, sequence, snapshot digest, `StageTrack`) + section body · inspector *Case Intelligence* (AI findings from work items, review needed, evidence sources, policy requirements, uncertainty = assumptions + open contradictions, **Human action** = `HumanWorkCard`) · bottom bar (case history · task status · agent activity).
- **AC1:** Stages are labelled "derived". S1→S2→S3 moves the current stage Identity & ownership → Screening → Decision.
- **AC2:** A 304 on poll changes nothing on screen. A new sequence updates in place.
- **AC3:** Claims show `EpistemicMarker` (claim, fact, assumption, contradiction). Accepted facts show who accepted them.

#### BIZ-03 · Ownership workbench — `/work/cases/$caseId/lens/ownership`
- **Data:** room, `getFincrimeCasesCaseIdOwnership`, `getFincrimeCasesCaseIdContradictionsContradictionId`, `postFincrimeCasesCaseIdCommandsPreview`, `postCasesCaseIdCommands`, human-work claim/decide (`wi_own_review`).
- **AC1:** Edge styles as v1. The conflict edge shows both values ("12% / 22%").
- **AC2:** Unverified persons never show the fact glyph.
- **AC3:** The Table view lists every edge.
- **AC4:** In S1, "Accept register value (12%)" → preview shows the `ResolveContradiction` command and diff → submit → `ACCEPTED`, sequence 14→15, contradiction RESOLVED, Bram's edge solid 12%.
- **AC5:** Deciding `APPROVE` on `wi_own_review` **with basis 14 after the command above** → 409 `human.basis_stale` → "Review again" reloads with basis 15 → decide succeeds → state S2.
- **AC6:** As `relationship_manager` (no `human_work.decide`), the human step is visible but its Decide control is disabled with the reason.
- **AC7:** `RETURN` creates the rework item and moves the case to *Prepared by agents* in BIZ-01.

#### BIZ-04 / BIZ-05 · EDD / AML — frames only (G11)
- **AC1:** The lens renders the CaseRoom frame + disclosure. No fabricated data.

#### BIZ-06 · Screening — `/work/cases/$caseId/lens/screening?finding=s-pep`
- **Data:** `getFincrimeCasesCaseIdScreening`, `getFincrimeCasesCaseIdScreeningFindingId`, human-work for `wi_scr_review`.
- **AC1:** No percentage or probability for the match.
- **AC2:** "No candidates" rows carry the coverage + negative-search disclosure. `universalClearance` is never shown as clear.
- **AC3:** As `screening_analyst` in S2, *Confirm false match* (APPROVE) in the trusted sheet → S3.
- **AC4:** Incomplete coverage shows an attention chip on the list.

#### BIZ-07 · Decision desk — `/work/decisions/$caseId#decide`
- **Data:** `getFincrimeCasesCaseIdDecision` (5 s, ETag), claim/decide on `wi_decision`.
- **Layout:** header (status, basis, policy + bundle digest) → `ThreeObjects` (recommendation · policy evaluation · human decisions with `0/1/2 of 2`) → controls | risk + QA → limitations; inspector = requirements (`youMay`, reasons, options with consequences).
- **AC1:** `btn--trusted` appears only inside `TrustedDecisionSheet` (lint + DOM test).
- **AC2:** S3 as `s.varga`: APPROVE → S4. The sheet then shows "1 of 2". `s.varga` reopening → read-only "a second, different approver is required".
- **AC3:** S4 as `h.adeyemi`: the item already has an assignee (`s.varga`), so the sheet asks to **claim first**. Then APPROVE → S5 (APPROVED). The lineage link appears.
- **AC4:** S4 as `h.adeyemi` choosing REJECT → item stays waiting with the conflict banner. As `ops_manager`, Resolve is offered. As `s.varga`, it is not.
- **AC5:** UNKNOWN controls render as attention. A `REVIEW` policy decision is never shown as pass.
- **AC6:** Risk bars use `share`.
- **AC7 (risk view `/lens/risk`):** read-only RiskAttribution full width.

#### BIZ-08 · QA lens — `/work/cases/$caseId/lens/qa`
From `DecisionDesk.qa` + `policyEvaluation.controls`. **AC1:** UNKNOWN never renders as pass. Policy diff is G11.

#### BIZ-09 · Operations — `/work/ops`
- **Data:** `getFincrimeAssuranceMissionControl`, `getOperationsHumanWork`.
- **AC1:** Every metric shows its definition and `generatedAt`. Periodic reviews are G11.

### FinCrime: Assurance Studio (ASR)

#### ASR-01 · Mission Control — `/assurance`
- **Data:** `getFincrimeAssuranceMissionControl` (15 s).
- **AC1:** KPI definitions are visible. Exceptions link to filtered platform lists.

#### ASR-02 · Flight Recorder — `/assurance/recorder/$caseId?tab=chronology|causality|traces&entry=`
- **Data:** `getFincrimeCasesCaseIdRecorder`, `…/recorder/entries/{entryRef}`, `…/recorder/causality?focus=`, `getTracesTraceId`.
- **Layout (concept slide 2):** summary strip (events, interrupts, final state, Historical chip) → tabs **Chronology · Causality · Traces** → event inspector (ledger ref, raw record in `JsonViewer`, ledger verification).
- **AC1:** Order is by time. A human decision precedes the case events it caused at the same timestamp. The UI states the ordering rule.
- **AC2:** Interrupts (RequestHumanReview) are marked and counted.
- **AC3:** The Traces tab uses PLT-08 components and links to the run.
- **AC4:** Ledger verification failure shows `failedSequence` and blocks the "Verified" chip.

#### ASR-03 · Decision lineage — `/assurance/lineage/$caseId?decision=`
- **Data:** `getFincrimeCasesCaseIdLineage`.
- **AC1:** Backward highlighting from the decision reaches sources. Distinct actors are counted.
- **AC2:** Before S5, "No decision recorded yet".

#### ASR-04 · Assurance Lab — `/assurance/lab`
Frame + G11 disclosure. Shows failed and denied runs from `getRuns?status=failed` as the interim list.

#### ASR-05 · Assurance packages — `/assurance/packages?case=`
- **Data:** `postCasesCaseIdExports`, `getCasesCaseIdExportsDigestFormat`, `postCasesCaseIdLedgerVerify`.
- **AC1:** Generating requires a purpose (kept in the UI only, G11). The result lists the digest + caseSequence and offers json and zip downloads.

---

## 11. Testing strategy

### 11.1 Unit and component
Vitest 4 + Testing Library: `useRegionState`, `usePolled` (ETag/304, backoff, keep last good), formatters, `stateTone` over every enum in §7.1, `decisionId` stability. Storybook interaction tests for every component state. The axe addon must be clean.

### 11.2 Contract tests
1. **Coverage:** every operation in `OPERATIONS` has a mock handler and a BFF route (relay or composition). The test lists any missing.
2. **Response validity:** every GET × S1–S5 × the 13 personas that can access it validates.
3. **Auth matrix:** for each op with `x-action`, a persona lacking the action gets 403 from the mock. The table comes from `roleActions`.
4. **Fixtures:** `validate_contracts.py --ehf-root .` in CI.
5. **Freshness:** `ui:sync --check` fails on stale vendor or generated files. `check_sources.py` fails on drift.

### 11.3 End-to-end journeys (Playwright, mock)

| Journey | Steps | Asserts |
|---|---|---|
| **A · Configure context** | `context_architect`: `/context` → agent.screening → Tune → pick draft → edit selector → save → conflict in second tab | CXT-01, CXT-02 |
| **B · Author and release** | `agent_architect` edits draft → validate → compile → evaluate; tries approve (blocked); `harness_approver` approves + publishes; `ops_manager` activates the release in PLT-11 | PLT-03-AC1..5, PLT-11-AC1 |
| **C · Process corporate KYB** | `cdd_analyst` S1: resolve contradiction → stale basis → decide → S2; `screening_analyst` confirms false match → S3; `compliance_officer` approves → S4; `second_approver` approves → S5 | BIZ-01..03, BIZ-06, BIZ-07 |
| **D · Dual-control conflict** | S4: `second_approver` REJECTs → conflict; `ops_manager` resolves | BIZ-07-AC4, PLT-10-AC1 |
| **E · Audit a decision** | `auditor` S5: recorder → entry → traces → lineage → export package | ASR-02, ASR-03, ASR-05 |
| **F · Operate** | `ops_manager`: overview → failed run → cancel (terminal) → system → stop admission (drain) → start run → 409 | PLT-01, PLT-05-AC2, PLT-07-AC3, PLT-12-AC1 |
| **G · Administer** | `platform_admin` edits a model profile → activate; `auditor` reads change log | PLT-14 |

### 11.4 BFF tests (`apps/experience-bff`, vitest + fastify `inject`, upstream stubs)
The EHF 03 list, as named tests:
- concurrent draft edits (409 passthrough)
- expired session (401 + HTML redirect)
- CSRF missing/mismatched/foreign Origin (403)
- cross-tenant cache (two sessions, two tenants, same URL → no shared response; `no-store` set)
- role revoked after page load (next mutation 403 from upstream passes through; session refetch reflects it)
- backend denial despite enabled UI control (403 passthrough with reason)
- replayed decision (same `decisionId` → upstream replay → 201 with stored decision)
- stale human evidence (upstream 409 `human.basis_stale` passthrough with details)

Also:
- identity headers from the browser are stripped
- relay table covers all ops
- no catch-all routes exist
- status codes are never flattened
- traces authority is checked before reading spans
- spans contain no cookies, tokens or bodies

### 11.5 Accessibility and visual
axe on every route × {cdd_analyst, compliance_officer, auditor, agent_architect, platform_admin} × {S1, S3, S5}, with zero serious or critical issues. Keyboard-only replay of journeys C and E. Visual check of the 16 mocked surfaces against `mockups/` (layout, hierarchy, copy). PLT surfaces are checked against the control-ui pages they replace (screenshots captured before cutover).

---

## 12. Milestones

| M | Scope | Exit criteria |
|---|---|---|
| **M0 · Scaffold** | workspace in ehfconcept, `ui:sync`, generated types, validators, `check-bundle`, CI gates | sync green; `ui:contracts` green; types compile |
| **M1 · Mock engine** | EHF-shaped store, auth/workflow rules (§6.4), scenario engine, faults, toolbar, all 151 handlers | §11.2 1–3 green |
| **M2 · Design system** | tokens (+ v2 stateMap), fonts, icons, primitives, platform + domain components | Storybook complete, a11y clean |
| **M3 · Shell + module registry** | chrome, routing, guards, ConsoleLayout + WorkspaceLayout, search, 403/404, session-ended modal, FinCrime module manifest | Shell AC1–7 |
| **M4 · Platform parity** | PLT-01…15 | Journeys B, F, G; parity checklist (ALIGNMENT §4) ticked |
| **M5 · FinCrime surfaces** | BIZ-01…03, 06, 07; AGT-01…05; CXT-01…03; ASR-01…03, 05 | Journeys A, C, D, E |
| **M6 · BFF** | auth, session, CSRF, delegated identity, relay, compositions, FinCrime module, static hosting | §11.4 green; http-mode smoke against local EHF |
| **M7 · Cutover** | Deploy `experience-bff` + `web` beside control-ui; shadow-run for 1 week, comparing PLT views; switch ingress; **delete `apps/control-ui`**; update EHF docs 03 (G13) | Parity checklist signed off; no P1 regressions; control-ui removed in the same PR as ingress switch |
| **M8 · Remaining** | frames for BIZ-04/05/08/09, AGT-06/07, CXT-04, ASR-04; A2UI hardening; virtualise lists > 100 rows | DoD §0.4 |

Commit at least once per milestone with its ID in the message. Don't start M(n+1) with M(n) failing. M6 can run in parallel with M4–M5 once M1 is green.

---

## 13. Agent working rules

### 13.1 Do
- Read the cited ui-specs section or mockup before building a surface.
- Keep surfaces thin: route → data hooks → `@ehf/ui-kit` components.
- Type everything from `Schemas[…]`. Use exhaustive `switch` over enums.
- When upstream behaviour is unclear, read the pinned source (`execution-work.ts`, route files) before guessing, and cite it in CONTRACT-GAPS.

### 13.2 CONTRACT-GAPS.md protocol

Format as v1 (`## GAP-nnn · surface · title`, severity, needed, workaround, proposed change). **Pre-populate G1–G14** from ALIGNMENT §7, numbered GAP-001…GAP-014.

### 13.3 Lint guards
- No `fetch(`, `msw` or fixtures imports in `apps/web/src/**` except `mock-bootstrap.ts`.
- No colour literals outside `packages/ui-tokens`.
- `btn--trusted` / `TrustedButton` only in `TrustedDecisionSheet`.
- No `parseFloat`/`Number(` on decimal-string fields.
- **No imports from `domains/**` in `shell/**`, `platform/**` or `packages/ui-shell/**`** (N13).
- **No header names matching `/^x-(actor|ehf-authenticated|tenant)/i`** anywhere in `apps/web` or `packages/ui-client` (N11).

### 13.4 Don't
- Don't invent fields, enums, endpoints or certainty.
- Don't hand-edit `vendor/`, `generated/` or `upstream/`.
- Don't add catch-all relay routes, optimistic success, or percentages for readiness or match scores.
- Don't put a commit control inside an A2UI slot.
- Don't merge two state dimensions into one chip.
- Don't keep any code path from `apps/control-ui` alive after M7.

---

<!-- GENERATED APPENDICES BELOW — do not edit by hand; regenerate with docs/ui/contracts/tools/gen_appendices.py -->

## Appendix A — Operation matrix

Generated from `experience-api.openapi.yaml`. *Upstream* is the service and route a relay calls (`bff` = composed in the BFF). *Action* is the EHF platform action enforced upstream. *Poll* is the `x-poll` interval.

### Auth

| operationId | Route | Upstream | Action | Screens | Poll |
|---|---|---|---|---|---|
| `getAuthLogin` | `GET /auth/login` | bff |  | shell |  |
| `getAuthCallback` | `GET /auth/callback` | bff |  |  |  |
| `postAuthLogout` | `POST /auth/logout` | bff |  |  |  |

### Session

| operationId | Route | Upstream | Action | Screens | Poll |
|---|---|---|---|---|---|
| `getSession` | `GET /v1/session` | bff |  | shell |  |
| `getSearch` | `GET /v1/search` | bff |  | shell |  |

### Platform

| operationId | Route | Upstream | Action | Screens | Poll |
|---|---|---|---|---|---|
| `getOverview` | `GET /v1/overview` | bff |  | PLT-01 | 15s |
| `getSystem` | `GET /v1/system` | bff |  | PLT-12 | 15s |

### Authoring

| operationId | Route | Upstream | Action | Screens | Poll |
|---|---|---|---|---|---|
| `getAuthoringDrafts` | `GET /v1/authoring/drafts` | control-api `GET /v1/authoring/drafts` | draft.read | PLT-02 | 5s |
| `postAuthoringDrafts` | `POST /v1/authoring/drafts` | control-api `POST /v1/authoring/drafts` | draft.write | PLT-02 |  |
| `getAuthoringDraftsDraftId` | `GET /v1/authoring/drafts/{draftId}` | control-api `GET /v1/authoring/drafts/:draftId` | draft.read | PLT-03 | 5s |
| `putAuthoringDraftsDraftId` | `PUT /v1/authoring/drafts/{draftId}` | control-api `PUT /v1/authoring/drafts/:draftId` | draft.write | PLT-03 |  |
| `postAuthoringDraftsDraftIdValidate` | `POST /v1/authoring/drafts/{draftId}/validate` | control-api `POST /v1/authoring/drafts/:draftId/validate` | draft.read | PLT-03 |  |
| `postAuthoringDraftsDraftIdCompile` | `POST /v1/authoring/drafts/{draftId}/compile` | control-api `POST /v1/authoring/drafts/:draftId/compile` | draft.compile | PLT-03 |  |
| `postAuthoringDraftsDraftIdEvaluate` | `POST /v1/authoring/drafts/{draftId}/evaluate` | control-api `POST /v1/authoring/drafts/:draftId/evaluate` | draft.evaluate | PLT-03 |  |
| `postAuthoringDraftsDraftIdApprove` | `POST /v1/authoring/drafts/{draftId}/approve` | control-api `POST /v1/authoring/drafts/:draftId/approve` | draft.approve | PLT-03 |  |
| `postAuthoringDraftsDraftIdPublish` | `POST /v1/authoring/drafts/{draftId}/publish` | control-api `POST /v1/authoring/drafts/:draftId/publish` | draft.publish | PLT-03 |  |
| `postAuthoringDraftsDraftIdGraph` | `POST /v1/authoring/drafts/{draftId}/graph` | control-api `POST /v1/authoring/drafts/:draftId/graph` | draft.write | PLT-03 |  |
| `postAuthoringDraftsDraftIdOrchestrationNodes` | `POST /v1/authoring/drafts/{draftId}/orchestration-nodes` | control-api `POST /v1/authoring/drafts/:draftId/orchestration-nodes` | draft.write | PLT-03 |  |
| `putAuthoringDraftsDraftIdNodesNodeIdCaseWrites` | `PUT /v1/authoring/drafts/{draftId}/nodes/{nodeId}/case-writes` | control-api `PUT /v1/authoring/drafts/:draftId/nodes/:nodeId/case-writes` | draft.write | PLT-03 |  |
| `postAuthoringDraftsDraftIdAgentsAgentIdAttach` | `POST /v1/authoring/drafts/{draftId}/agents/{agentId}/attach` | control-api `POST /v1/authoring/drafts/:draftId/agents/:agentId/attach` | draft.write | PLT-03 |  |
| `putAuthoringDraftsDraftIdContextSelectors` | `PUT /v1/authoring/drafts/{draftId}/context-selectors` | control-api `PUT /v1/authoring/drafts/:draftId/context-selectors` | draft.write | PLT-03 |  |
| `putAuthoringDraftsDraftIdContextClassificationPolicies` | `PUT /v1/authoring/drafts/{draftId}/context-classification-policies` | control-api `PUT /v1/authoring/drafts/:draftId/context-classification-policies` | draft.write | PLT-03 |  |
| `getAuthoringTemplates` | `GET /v1/authoring/templates` | control-api `GET /v1/authoring/templates` | draft.read | PLT-02 |  |
| `getAuthoringAgents` | `GET /v1/authoring/agents` | control-api `GET /v1/authoring/agents` | draft.read | PLT-03 | 5s |
| `postAuthoringAgents` | `POST /v1/authoring/agents` | control-api `POST /v1/authoring/agents` | agent.register | PLT-03 |  |
| `getAuthoringSkills` | `GET /v1/authoring/skills` | control-api `GET /v1/authoring/skills` | draft.read | PLT-03 | 5s |
| `postAuthoringSkills` | `POST /v1/authoring/skills` | control-api `POST /v1/authoring/skills` | agent.register | PLT-03 |  |
| `postAuthoringImportGithub` | `POST /v1/authoring/import/github` | control-api `POST /v1/authoring/import/github` | agent.register | PLT-03 |  |
| `postAuthoringImportFincrime` | `POST /v1/authoring/import/fincrime` | control-api `POST /v1/authoring/import/fincrime` | agent.register | PLT-03, AGT-01 |  |
| `getAuthoringCatalogsFincrimeDigest` | `GET /v1/authoring/catalogs/fincrime/{digest}` | control-api `GET /v1/authoring/catalogs/fincrime/:digest` | draft.read | AGT-01 |  |

### PolicyStudio

| operationId | Route | Upstream | Action | Screens | Poll |
|---|---|---|---|---|---|
| `getAuthoringPolicies` | `GET /v1/authoring/policies` | control-api `GET /v1/authoring/policies/templates/kyc` | draft.read | PLT-04 |  |
| `postAuthoringPoliciesCompile` | `POST /v1/authoring/policies/compile` | control-api `POST /v1/authoring/policies/compile` | draft.compile | PLT-04 |  |
| `postAuthoringPoliciesEvaluate` | `POST /v1/authoring/policies/evaluate` | control-api `POST /v1/authoring/policies/evaluate` | draft.evaluate | PLT-04 |  |
| `getAuthoringPoliciesWorkspacesWorkspaceIdRevisions` | `GET /v1/authoring/policies/workspaces/{workspaceId}/revisions` | control-api `GET /v1/authoring/policies/workspaces/:workspaceId/revisions` | draft.read | PLT-04 |  |
| `postAuthoringPoliciesWorkspacesWorkspaceIdRevisions` | `POST /v1/authoring/policies/workspaces/{workspaceId}/revisions` | control-api `POST /v1/authoring/policies/workspaces/:workspaceId/revisions` | draft.write | PLT-04 |  |
| `postAuthoringPoliciesWorkspacesWorkspaceIdRevisionsRevisionCompile` | `POST /v1/authoring/policies/workspaces/{workspaceId}/revisions/{revision}/compile` | control-api `POST /v1/authoring/policies/workspaces/:workspaceId/revisions/:revision/compile` | draft.compile | PLT-04 |  |
| `postAuthoringPoliciesWorkspacesWorkspaceIdRevisionsRevisionApprove` | `POST /v1/authoring/policies/workspaces/{workspaceId}/revisions/{revision}/approve` | control-api `POST /v1/authoring/policies/workspaces/:workspaceId/revisions/:revision/approve` | draft.approve | PLT-04 |  |
| `postAuthoringPoliciesWorkspacesWorkspaceIdRevisionsRevisionPublish` | `POST /v1/authoring/policies/workspaces/{workspaceId}/revisions/{revision}/publish` | control-api `POST /v1/authoring/policies/workspaces/:workspaceId/revisions/:revision/publish` | draft.publish | PLT-04 |  |

### Runs

| operationId | Route | Upstream | Action | Screens | Poll |
|---|---|---|---|---|---|
| `getPlans` | `GET /v1/plans` | control-api `GET /v1/plan-records` | plan.read | PLT-05 | 15s |
| `postPlans` | `POST /v1/plans` | control-api `POST /v1/plans` | plan.admit | PLT-05 |  |
| `getPlansPlanDigest` | `GET /v1/plans/{planDigest}` | control-api `GET /v1/plans/:digest` | plan.read | PLT-05 |  |
| `getPlansPlanDigestRuns` | `GET /v1/plans/{planDigest}/runs` | control-api `GET /v1/runs?planDigest=` | run.read | PLT-05 | 5s |
| `getRuns` | `GET /v1/runs` | control-api `GET /v1/runs` | run.read | PLT-06 | 5s |
| `postRuns` | `POST /v1/runs` | control-api `POST /v1/runs` | run.start | PLT-05 |  |
| `getRunsRunId` | `GET /v1/runs/{runId}` | bff | run.read | PLT-07, ASR-02 | 3s |
| `postRunsRunIdCancel` | `POST /v1/runs/{runId}/cancel` | control-api `POST /v1/runs/:runId/cancel` | run.cancel | PLT-07 |  |
| `getRunsRunIdEvents` | `GET /v1/runs/{runId}/events` | control-api `GET /v1/runs/:runId/events` | run.read | PLT-07, ASR-02 | 3s |
| `getRunsRunIdAttempts` | `GET /v1/runs/{runId}/attempts` | control-api `GET /v1/runs/:runId/attempts` | run.read | PLT-07 |  |
| `getRunsRunIdTrace` | `GET /v1/runs/{runId}/trace` | control-api `GET /v1/runs/:runId/trace` | run.read | PLT-07, ASR-02 |  |
| `getTracesTraceId` | `GET /v1/traces/{traceId}` | bff | telemetry.read | run.read (interactive human only) | PLT-08, ASR-02 |  |

### Cases

| operationId | Route | Upstream | Action | Screens | Poll |
|---|---|---|---|---|---|
| `getCases` | `GET /v1/cases` | case-api `GET /v1/cases` | case.read | PLT-09, BIZ-01 | 10s |
| `postCases` | `POST /v1/cases` | case-api `POST /v1/cases` | case.write | PLT-09 |  |
| `getCasesCaseId` | `GET /v1/cases/{caseId}` | bff | case.read | PLT-09 | 5s |
| `getCasesCaseIdSnapshot` | `GET /v1/cases/{caseId}/snapshot` | case-api `GET /v1/cases/:caseId/snapshot` | case.read | BIZ-02 |  |
| `getCasesCaseIdEvents` | `GET /v1/cases/{caseId}/events` | case-api `GET /v1/cases/:caseId/events` | event.read | BIZ-02, ASR-02 | 5s |
| `postCasesCaseIdCommands` | `POST /v1/cases/{caseId}/commands` | case-api `POST /v1/cases/:caseId/commands` | case.write | case.review (FinalizeDisposition, RecordReview) | BIZ-03, BIZ-06, BIZ-07 |  |
| `postCasesCaseIdExports` | `POST /v1/cases/{caseId}/exports` | case-api `POST /v1/cases/:caseId/exports` | case.read | ASR-05 |  |
| `getCasesCaseIdExportsDigestFormat` | `GET /v1/cases/{caseId}/exports/{digest}/{format}` | case-api `GET /v1/cases/:caseId/exports/:digest/:format` | case.read | ASR-05 |  |
| `postCasesCaseIdLedgerVerify` | `POST /v1/cases/{caseId}/ledger:verify` | case-api `POST /v1/cases/:caseId/ledger:verify` | case.read | ASR-02, PLT-09 |  |
| `getEvidenceEvidenceId` | `GET /v1/evidence/{evidenceId}` | case-api `GET /v1/evidence/:evidenceId` | evidence.read | BIZ-03 |  |

### HumanWork

| operationId | Route | Upstream | Action | Screens | Poll |
|---|---|---|---|---|---|
| `getOperationsHumanWork` | `GET /v1/operations/human-work` | control-api `GET /v1/operations/human-work` | human_work.read | PLT-10, BIZ-01 | 5s |
| `postOperationsHumanWorkWorkItemIdClaim` | `POST /v1/operations/human-work/{workItemId}/claim` | control-api `POST /v1/operations/human-work/:workItemId/claim` | human_work.claim | PLT-10, BIZ-06, BIZ-07 |  |
| `postOperationsHumanWorkWorkItemIdDecisions` | `POST /v1/operations/human-work/{workItemId}/decisions` | control-api `POST /v1/operations/human-work/:workItemId/decisions` | human_work.decide | PLT-10, BIZ-06, BIZ-07 |  |
| `postOperationsHumanWorkWorkItemIdResolve` | `POST /v1/operations/human-work/{workItemId}/resolve` | control-api `POST /v1/operations/human-work/:workItemId/resolve` | human_work.resolve | PLT-10, BIZ-07 |  |

### Releases

| operationId | Route | Upstream | Action | Screens | Poll |
|---|---|---|---|---|---|
| `getReleases` | `GET /v1/releases` | control-api `GET /v1/releases` | release.read | PLT-11, AGT-07 | 15s |
| `postReleases` | `POST /v1/releases` | control-api `POST /v1/releases` | release.create | PLT-11 |  |
| `postReleasesReleaseIdTransition` | `POST /v1/releases/{releaseId}/transition` | control-api `POST /v1/releases/:releaseId/transition` | release.approve | release.activate | release.revoke (by target) | PLT-11, AGT-07 |  |
| `postSigningKeysRevoke` | `POST /v1/signing-keys/revoke` | control-api `POST /v1/signing-keys/revoke` | release.revoke | PLT-14 |  |

### Integrations

| operationId | Route | Upstream | Action | Screens | Poll |
|---|---|---|---|---|---|
| `getIntegrationsConnectors` | `GET /v1/integrations/connectors` | control-api `GET /v1/integrations/connectors` | integration.read | PLT-15 | 15s |
| `postIntegrationsConnectors` | `POST /v1/integrations/connectors` | control-api `POST /v1/integrations/connectors` | integration.connector.write | PLT-15 |  |
| `getIntegrationsBindings` | `GET /v1/integrations/bindings` | control-api `GET /v1/integrations/bindings` | integration.read | PLT-15 | 15s |
| `postIntegrationsBindings` | `POST /v1/integrations/bindings` | control-api `POST /v1/integrations/bindings` | integration.bind | PLT-15 |  |
| `postIntegrationsBindingsBindingIdTest` | `POST /v1/integrations/bindings/{bindingId}:test` | control-api `POST /v1/integrations/bindings/:bindingId:test` | integration.test | PLT-15 |  |
| `postIntegrationsBindingsBindingIdActivate` | `POST /v1/integrations/bindings/{bindingId}:activate` | control-api `POST /v1/integrations/bindings/:bindingId:activate` | integration.activate | PLT-15 |  |
| `postIntegrationsBindingsBindingIdPause` | `POST /v1/integrations/bindings/{bindingId}:pause` | control-api `POST /v1/integrations/bindings/:bindingId:pause` | integration.pause | PLT-15 |  |
| `getIntegrationsDeliveries` | `GET /v1/integrations/deliveries` | control-api `GET /v1/integrations/deliveries` | integration.read | PLT-15 | 10s |
| `postIntegrationsDeliveriesDeliveryIdReplay` | `POST /v1/integrations/deliveries/{deliveryId}:replay` | control-api `POST /v1/integrations/deliveries/:deliveryId:replay` | integration.replay | PLT-15 |  |
| `getIntegrationsHumanCasesCaseIdActions` | `GET /v1/integrations/human/cases/{caseId}/actions` | control-api `GET /v1/integrations/human/cases/:caseId/actions` | case.read | BIZ-02 |  |
| `postIntegrationsHumanCasesCaseIdActionsActionIdExecute` | `POST /v1/integrations/human/cases/{caseId}/actions/{actionId}:execute` | control-api `POST /v1/integrations/human/cases/:caseId/actions/:actionId:execute` | case.read, then per-action checks upstream | BIZ-02 |  |

### Gateway

| operationId | Route | Upstream | Action | Screens | Poll |
|---|---|---|---|---|---|
| `getGatewayRegistry` | `GET /v1/gateway/registry` | capability-gateway `GET /v1/capabilities` | capability.read | PLT-12, CXT-03 | 15s |
| `postGatewayRegistry` | `POST /v1/gateway/registry` | capability-gateway `POST /v1/capabilities` | capability.register (admin.write when authoring is disabled) | PLT-12 |  |
| `getGatewayAdapters` | `GET /v1/gateway/adapters` | capability-gateway `GET /v1/adapters` | capability.read | PLT-12 |  |
| `getGatewayProfiles` | `GET /v1/gateway/profiles` | bff | capability.read | PLT-12 |  |
| `getGatewayStatus` | `GET /v1/gateway/status` | capability-gateway `GET /v1/status` | capability.read | PLT-12 | 15s |
| `getGatewayCapabilities` | `GET /v1/gateway/capabilities` | capability-gateway `GET /v1/capabilities` | capability.read | PLT-12 |  |
| `getGatewayDecisions` | `GET /v1/gateway/decisions` | control-api `GET /v1/gateway/receipts` | receipt.read | PLT-12, ASR-02 |  |
| `postGatewayOpenrouterTest` | `POST /v1/gateway/openrouter/test` | capability-gateway `POST /v1/openrouter/test` | capability.read (gateway-defined; verify) | PLT-14 |  |

### Admin

| operationId | Route | Upstream | Action | Screens | Poll |
|---|---|---|---|---|---|
| `getAdminProviders` | `GET /v1/admin/providers` | control-api `GET /v1/admin/providers` | admin.read | PLT-14 | 15s |
| `putAdminProvidersProviderId` | `PUT /v1/admin/providers/{providerId}` | control-api `PUT /v1/admin/providers/:providerId` | admin.write | PLT-14 |  |
| `getAdminModelProfiles` | `GET /v1/admin/model-profiles` | control-api `GET /v1/admin/model-profiles` | admin.read | PLT-14 | 15s |
| `putAdminModelProfilesProfileId` | `PUT /v1/admin/model-profiles/{profileId}` | control-api `PUT /v1/admin/model-profiles/:profileId` | admin.write | PLT-14 |  |
| `postAdminModelProfilesProfileIdActivate` | `POST /v1/admin/model-profiles/{profileId}/activate` | control-api `POST /v1/admin/model-profiles/:profileId/activate` | admin.write | PLT-14 |  |
| `getAdminSettings` | `GET /v1/admin/settings` | control-api `GET /v1/admin/settings` | admin.read | PLT-14 |  |
| `putAdminSettingsSection` | `PUT /v1/admin/settings/{section}` | control-api `PUT /v1/admin/settings/:section` | admin.write | PLT-14 |  |
| `getAdminChangeLog` | `GET /v1/admin/change-log` | control-api `GET /v1/admin/change-log` | admin.read | PLT-14 |  |
| `getAdminRuntime` | `GET /v1/admin/runtime` | control-api `GET /v1/deployment/runtime` | deployment.execute | PLT-12 |  |
| `postAdminRuntime` | `POST /v1/admin/runtime` | control-api `POST /v1/deployment/runtime` | deployment.execute | PLT-12 |  |

### FinCrime

| operationId | Route | Upstream | Action | Screens | Poll |
|---|---|---|---|---|---|
| `getFincrimeCatalog` | `GET /v1/fincrime/catalog` | bff |  | AGT-01, CXT-01 |  |
| `getFincrimeAgents` | `GET /v1/fincrime/agents` | bff |  | AGT-01 | 15s |
| `getFincrimeAgentsAgentId` | `GET /v1/fincrime/agents/{agentId}` | bff |  | AGT-02 |  |
| `getFincrimeTasksTaskId` | `GET /v1/fincrime/tasks/{taskId}` | bff |  | AGT-03, AGT-04 |  |
| `getFincrimeSkills` | `GET /v1/fincrime/skills` | bff |  | AGT-04 |  |
| `getFincrimeSkillsSkillId` | `GET /v1/fincrime/skills/{skillId}` | bff |  | AGT-04, AGT-05 |  |
| `getFincrimeContextProducts` | `GET /v1/fincrime/context/products` | bff |  | CXT-01 |  |
| `getFincrimeContextProductsProductId` | `GET /v1/fincrime/context/products/{productId}` | bff |  | CXT-02, CXT-03 |  |
| `getFincrimeContextReadiness` | `GET /v1/fincrime/context/readiness` | bff |  | CXT-01 |  |
| `postFincrimeContextPacketsPreview` | `POST /v1/fincrime/context/packets:preview` | bff |  | CXT-04, AGT-05 |  · *needs-upstream* |
| `getFincrimeWork` | `GET /v1/fincrime/work` | bff |  | BIZ-01 | 5s |
| `getFincrimeCasesCaseIdRoom` | `GET /v1/fincrime/cases/{caseId}/room` | bff |  | BIZ-02, BIZ-03 | 5s |
| `getFincrimeCasesCaseIdClaims` | `GET /v1/fincrime/cases/{caseId}/claims` | bff |  | BIZ-03 |  |
| `getFincrimeCasesCaseIdContradictionsContradictionId` | `GET /v1/fincrime/cases/{caseId}/contradictions/{contradictionId}` | bff |  | BIZ-03 |  |
| `getFincrimeCasesCaseIdOwnership` | `GET /v1/fincrime/cases/{caseId}/ownership` | bff |  | BIZ-03 |  |
| `getFincrimeCasesCaseIdDocuments` | `GET /v1/fincrime/cases/{caseId}/documents` | bff |  | BIZ-02 |  |
| `postFincrimeCasesCaseIdDocuments` | `POST /v1/fincrime/cases/{caseId}/documents` | bff |  | BIZ-02 |  |
| `getFincrimeCasesCaseIdDocumentsDocumentId` | `GET /v1/fincrime/cases/{caseId}/documents/{documentId}` | bff |  | BIZ-02, BIZ-03 |  |
| `getFincrimeCasesCaseIdScreening` | `GET /v1/fincrime/cases/{caseId}/screening` | bff |  | BIZ-06 |  |
| `getFincrimeCasesCaseIdScreeningFindingId` | `GET /v1/fincrime/cases/{caseId}/screening/{findingId}` | bff |  | BIZ-06 |  |
| `getFincrimeCasesCaseIdDecision` | `GET /v1/fincrime/cases/{caseId}/decision` | bff |  | BIZ-07 | 5s |
| `postFincrimeCasesCaseIdCommandsPreview` | `POST /v1/fincrime/cases/{caseId}/commands:preview` | bff |  | BIZ-03, BIZ-06, BIZ-07 |  |
| `getFincrimeCasesCaseIdRecorder` | `GET /v1/fincrime/cases/{caseId}/recorder` | bff |  | ASR-02 |  |
| `getFincrimeCasesCaseIdRecorderEntriesEntryRef` | `GET /v1/fincrime/cases/{caseId}/recorder/entries/{entryRef}` | bff |  | ASR-02 |  |
| `getFincrimeCasesCaseIdRecorderCausality` | `GET /v1/fincrime/cases/{caseId}/recorder/causality` | bff |  | ASR-02 |  |
| `getFincrimeCasesCaseIdLineage` | `GET /v1/fincrime/cases/{caseId}/lineage` | bff |  | ASR-03 |  |
| `getFincrimeAssuranceMissionControl` | `GET /v1/fincrime/assurance/mission-control` | bff |  | ASR-01 | 15s |

### Presentation

| operationId | Route | Upstream | Action | Screens | Poll |
|---|---|---|---|---|---|
| `getPresentationCatalog` | `GET /v1/presentation/catalog` | bff |  | all |  · *proposed* |
| `getFincrimeCasesCaseIdSurfaces` | `GET /v1/fincrime/cases/{caseId}/surfaces` | bff |  | BIZ-02, BIZ-03, BIZ-06 |  · *proposed* |
| `postPresentationEvents` | `POST /v1/presentation/events` | bff |  | all |  · *proposed* |

### Mock

| operationId | Route | Upstream | Action | Screens | Poll |
|---|---|---|---|---|---|
| `getMockPersonas` | `GET /mock/personas` | mock |  |  |  |
| `putMockSession` | `PUT /mock/session` | mock |  |  |  |
| `getMockScenario` | `GET /mock/scenario` | mock |  |  |  |
| `putMockScenario` | `PUT /mock/scenario` | mock |  |  |  |
| `putMockClock` | `PUT /mock/clock` | mock |  |  |  |
| `putMockFaults` | `PUT /mock/faults` | mock |  |  |  |
| `postMockReset` | `POST /mock/reset` | mock |  |  |  |

## Appendix B — Personas

From `fixtures/personas.json`. Actions are the union of the roles' actions in `packages/identity/src/authorization.ts`.

| Persona | Principal | Roles | # actions | Landing | Notes |
|---|---|---|---|---|---|
| CDD / KYB Analyst (`cdd_analyst`) | `r.okafor` | Case.Analyst, Case.Reviewer | 9 | `/work` | Claims and decides ownership review work items. |
| Sanctions & Screening Analyst (`screening_analyst`) | `l.nakamura` | Case.Analyst, Case.Reviewer | 9 | `/work` | Decides screening review work items. |
| Compliance Officer / MLRO (`compliance_officer`) | `s.varga` | Case.Reviewer | 7 | `/work` | First approver on the dual-control decision gate. |
| Deputy MLRO (`second_approver`) | `h.adeyemi` | Case.Reviewer | 7 | `/work` | Second, distinct approver for dual control. |
| QA Reviewer (`qa_reviewer`) | `t.brandt` | Case.Reviewer, Harness.Reader | 14 | `/assurance` | Reads everything; reviews QA work items. |
| Relationship Manager (`relationship_manager`) | `d.patel` | Case.Analyst | 5 | `/work` | Can add evidence; cannot decide. |
| KYC Operations Manager (`ops_manager`) | `a.ruiz` | Harness.Operator | 24 | `/assurance` | Resolves conflicting decisions; starts/cancels runs. |
| Agent Architect (`agent_architect`) | `j.moreau` | Harness.Author | 17 | `/platform/drafts` | Authors drafts; cannot approve own drafts. |
| Harness Approver (`harness_approver`) | `e.kowalski` | Harness.Approver | 14 | `/platform/drafts` | Approves and publishes drafts authored by others. |
| Context Architect (`context_architect`) | `m.lindqvist` | Harness.Author | 17 | `/context` | Edits context selectors and classification policies on drafts. |
| Internal Auditor (`auditor`) | `p.lindgren` | Platform.Auditor | 13 | `/assurance` | Read-only including admin configuration and change log. |
| Platform Administrator (`platform_admin`) | `n.osei` | Platform.Admin | 15 | `/platform/admin` | Writes admin configuration; not an author or approver. |

## Appendix C — Roles → platform actions (pinned)

| Role | Actions |
|---|---|
| `Case.Analyst` | `case.read`, `case.write`, `evidence.read`, `evidence.write`, `run.read` |
| `Case.Reviewer` | `case.read`, `case.review`, `evidence.read`, `human_work.claim`, `human_work.decide`, `human_work.read`, `run.read` |
| `Harness.Approver` | `capability.read`, `case.read`, `draft.approve`, `draft.publish`, `draft.read`, `event.read`, `evidence.read`, `human_work.read`, `integration.read`, `plan.read`, `receipt.read`, `release.approve`, `release.read`, `run.read` |
| `Harness.Author` | `agent.register`, `capability.read`, `capability.register`, `case.read`, `draft.compile`, `draft.evaluate`, `draft.read`, `draft.write`, `event.read`, `evidence.read`, `human_work.read`, `integration.read`, `plan.read`, `receipt.read`, `release.create`, `release.read`, `run.read` |
| `Harness.Operator` | `capability.read`, `case.read`, `draft.read`, `event.read`, `evidence.read`, `human_work.read`, `human_work.resolve`, `integration.activate`, `integration.bind`, `integration.pause`, `integration.read`, `integration.replay`, `integration.test`, `plan.admit`, `plan.read`, `receipt.read`, `release.activate`, `release.read`, `release.revoke`, `run.cancel`, `run.read`, `run.retry`, `run.start`, `telemetry.read` |
| `Harness.Reader` | `capability.read`, `case.read`, `draft.read`, `event.read`, `evidence.read`, `human_work.read`, `integration.read`, `plan.read`, `receipt.read`, `release.read`, `run.read` |
| `Platform.Admin` | `admin.read`, `admin.write`, `capability.read`, `capability.register`, `case.read`, `draft.read`, `event.read`, `evidence.read`, `human_work.read`, `integration.connector.write`, `integration.read`, `plan.read`, `receipt.read`, `release.read`, `run.read` |
| `Platform.Auditor` | `admin.read`, `capability.read`, `case.read`, `draft.read`, `event.read`, `evidence.read`, `human_work.read`, `integration.read`, `plan.read`, `receipt.read`, `release.read`, `run.read`, `telemetry.read` |

## Appendix D — Scenario KYB-1042

| S | State | Case status | caseSequence | Open human work (required approvals · decisions so far) | Clock |
|---|---|---|---|---|---|
| S1 | `ownership_review` | INVESTIGATING | 14 | `wi_own_review` (1 · 0) | 2026-11-07T14:05:00Z |
| S2 | `screening_review` | SCREENING | 22 | `wi_scr_review` (1 · 0) | 2026-11-08T11:50:00Z |
| S3 | `decision_pending` | HUMAN_REVIEW | 31 | `wi_decision` (2 · 0) | 2026-11-08T15:14:30Z |
| S4 | `second_approval` | HUMAN_REVIEW | 31 | `wi_decision` (2 · 1) | 2026-11-08T15:20:00Z |
| S5 | `decided` | APPROVED | 33 | — | 2026-11-08T15:26:00Z |

**Transitions** (fire when the named work item completes with the decision):

- `ownership_review` → `screening_review` on `APPROVE` for `wi_own_review`
- `screening_review` → `decision_pending` on `APPROVE` for `wi_scr_review`
- `decision_pending` → `second_approval` on `APPROVE` for `wi_decision`
- `second_approval` → `decided` on `APPROVE` for `wi_decision` — must be a different principal from the first approver

**Rules:**

- Decide requires a claim only when the item already has assignees (upstream: workflow.human_decision_not_assigned).
- Same principal deciding a dual-control item twice → 409. Upstream counts decision rows; verify the DB enforces distinct principals (ALIGNMENT G3).
- Differing decisions on a dual-control item → item stays WAITING_HUMAN with reason workflow.human_decision_conflict; only human_work.resolve by a non-decider clears it.
- Any decision whose basis.caseSequence is behind the scenario's caseSequence → 409 human.basis_stale (target behaviour; mock enforces it so the UI is ready).
- ResolveContradiction on cf-12 in ownership_review advances caseSequence by 1 and marks the contradiction RESOLVED; it does not change state by itself.
- RETURN on wi_own_review completes it with a RETURN outcome and adds wi_own_rework (READY, agent.identity_ownership); the attention item moves to prepared_by_agents.
- REJECT on wi_scr_review sets case status INVESTIGATING and adds an 'EDD required' attention item (EDD view is gap G11).

## Appendix E — Fixture → schema map

| Fixture path | Schema |
|---|---|
| `personas.json#/personas/*/persona` | `Persona` |
| `personas.json#/personas/*/session` | `Session` |
| `fincrime.catalog.json#/catalog` | `CatalogView` |
| `fincrime.catalog.json#/skills/*` | `SkillSummary` |
| `fincrime.catalog.json#/tasks/*` | `TaskComposition` |
| `fincrime.catalog.json#/contextProducts/*` | `ContextProductView` |
| `fincrime.catalog.json#/readiness` | `ContextReadinessMatrix` |
| `ehf.kyb-1042.json#/states/*/snapshot` | EHF `caseSnapshot` |
| `…/workItems/*` | EHF `executionWorkItem` |
| `…/humanQueue/*` | `HumanQueueItem` |
| `…/decisions/*` | EHF `humanWorkDecision` |
| `…/run` | EHF `runRecord` |
| `…/runEvents/*` | EHF `runtimeEvent` |
| `…/releases/*` | EHF `releaseRecord` |
| `…/caseSummary` | control-ui `CaseSummaryView` |
| `…/caseEvents/*` | `CaseEventRow` |
| `scenario.kyb-1042.json#/states/*/{attention,caseRoom,claims,ownership,screening,decision,recorder,causality,lineage,missionControl,agents}` | `AttentionQueue`, `CaseRoom`, `ClaimsView`, `OwnershipView`, `ScreeningView`, `DecisionDesk`, `FlightRecorder`, `CausalGraph`, `LineageGraph`, `MissionControl`, `AgentAtlas` |
| `…/contradictions/*`, `…/screeningComparisons/*`, `…/ownershipOptions/*` | `ContradictionDetail`, `ScreeningComparison`, `DecisionOption` |
| `platform.json#/{overview,system,gatewayStatus}` | control-ui `OverviewView`, `SystemView`, `GatewayStatusView` |
| `platform.json#/{drafts,harnesses,runs,cases,modelTiers,providers,modelProfiles,settings,changeLog}/*` | control-ui views of the same names |
| `records.kyb-1042.json#/records/*` | kyc `schemas/runtime/Record` |

## Appendix F — Glossary

- **Basis:** the `{caseSequence, snapshotDigest}` a human reviewed. A decision on an older basis is stale (EHF 17).
- **BusinessAgent:** a kyc agent profile: mandate, personas, tasks, human gates, context products, and execution ceilings.
- **Business command:** a typed case mutation submitted to case-api (`businessCommandType`), answered with a receipt (`commandOutcome`).
- **Ceiling:** the most context an agent may ever see: `context_fields` per object type, plus `policy_fields`.
- **Claim (work item):** joining a human work item's assignees. It does not lock others out. Once anyone has claimed, only assignees can decide.
- **Context product:** one of 12 governed canonical projections a BusinessAgent subscribes to.
- **Dual control:** `constraints.dualControlRequired` → two distinct principals must submit the same decision.
- **Relay:** a BFF operation that forwards 1:1 to an EHF route under delegated identity, adding no authority.
- **Receipt:** the durable response that proves a mutation happened. The UI shows nothing as done before it.
- **TaskSpec:** a kyc task: ordered skill steps with dependencies, completion criteria and a failure policy.
