# Case-level access model

**Status:** Decisions accepted 2026-11-11 (the recommended option in each row of [Decisions](#decisions)). Steps 1 and 2 are built, and step 3 is built for the case API only; see [What is built](#what-is-built). None of it has run against a database. Human-work claims and decisions, restricted cases and break-glass are not built.
**Date:** 2026-11-11
**Scope:** Who may see and act on a case and its human work. Authoring, releases and platform administration are out of scope.

## Summary

Today access to a case is decided by role and tenant only. Any case analyst can read every case in the tenant and list every human-work item. There is no notion of "my cases" or "my queue".

This proposal adds case assignment as recorded data, a case manager role, and an authorization check that looks at the case being accessed. The recommended first step restricts **acting** and **the work queue** by assignment, keeps **reading** tenant-wide except for cases flagged restricted, and leaves full need-to-know reading for later.

The five decisions it rests on are listed in [Decisions](#decisions). The recommended option was accepted for each.

## What exists today

| Area | Current behaviour | Where |
|---|---|---|
| Authorization decision | Role grants the action, and the resource's tenant must match the caller's. The resource id is recorded but never checked. | `packages/identity/src/authorization.ts`, `evaluate()` |
| Case API | Every case route calls `authorize(request, action, { kind: "case", id })`. The id reaches the authorizer and is ignored. | `apps/case-api/src/app.ts` |
| Human-work list | `GET /v1/operations/human-work` requires `human_work.read` and returns every item in the tenant, optionally filtered by a `caseId` the caller supplies. | `apps/control-api/src/governance-routes.ts` |
| Case ownership | None. A case has a classification but no owner, team or assignee. | `packages/case-store/migrations/001_case_store.sql` |
| Work assignment | A work item has `assigned_to`, set when someone claims it. This is the only assignment in the system. | `case_work_items.assigned_to` |
| Roles | `Case.Analyst` and `Case.Reviewer`. The "operations manager" persona is `Harness.Operator`, a platform role that can resolve decision conflicts but has no case-specific standing. | `ROLE_ACTIONS` |

Two consequences matter for analysts:

- "My Workspace" is every human-work item in the tenant, grouped by whether the caller has claimed it. It is not a personal queue.
- Reading the event log, evidence list and findings of a case requires only the role. There is no per-case gate behind those reads.

## Goals

1. An analyst's queue shows work on cases assigned to them or their team, plus unclaimed work their team may pick up.
2. A manager sees the whole queue and can assign and reassign.
3. Only people assigned to a case, or holding a wider standing, can act on it.
4. Sensitive cases can be closed to everyone but those assigned and those with oversight.
5. Every access decision that depends on assignment is enforced by the service that owns the data, and every assignment change is on the case ledger.

## Non-goals

- Field-level redaction inside a case.
- Cross-tenant access.
- Changing dual control. "A second, different approver" stays as it is and is independent of assignment.
- Replacing the identity provider's groups. Teams here are case-work queues, mapped from directory groups where a deployment has them.

## Proposed model

### Concepts

| Concept | Meaning |
|---|---|
| Team | A named case-work queue in a tenant, with members. A person may belong to several. |
| Case assignment | A case is assigned to one team and, optionally, to named people in it. Recorded on the case ledger. |
| Standing | Why a caller may touch a case: `assigned` (named on it), `team` (member of its team), `oversight` (manager or auditor scope), or none. |
| Restricted case | A case flagged so that reading it requires `assigned` or `oversight` standing. |

### Roles

| Role | Change |
|---|---|
| `Case.Analyst` | Unchanged grants. Acting on a case requires `assigned` or `team` standing. |
| `Case.Reviewer` | Unchanged grants. Deciding human work requires `assigned` or `team` standing on the case, in addition to the existing rule that a decider has not already decided. |
| `Case.Manager` (new) | `case.read`, `event.read`, `evidence.read`, `human_work.read`, plus `case.assign`. `oversight` standing on every case in the tenant. May assign and reassign. Cannot decide, so a manager is never also the approver by default. |
| `Platform.Auditor` | Unchanged grants. `oversight` standing for reading only. |
| `Harness.Operator` | Keeps `human_work.resolve`. Gains no case standing from this proposal. |

### What each standing allows

| Action | none | team | assigned | oversight (manager) | oversight (auditor) |
|---|---|---|---|---|---|
| Read an ordinary case | Yes (see decision 2) | Yes | Yes | Yes | Yes |
| Read a restricted case | No | No | Yes | Yes | Yes |
| See its work in the queue | No | Yes | Yes | Yes | No |
| Claim unclaimed work | No | Yes | Yes | No | No |
| Write to the case, add evidence | No | Yes | Yes | No | No |
| Decide or disposition | No | Yes, with the role | Yes, with the role | No | No |
| Assign or reassign | No | No | No | Yes | No |

### Data

- `case_teams`: tenant, team id, name, optional directory group.
- `case_team_members`: tenant, team id, subject id.
- `case_assignments`: tenant, case id, team id, assignee subject ids, assigned by, assigned at, reason. One current row per case; history is on the ledger.
- A `restricted` flag on the case, set at creation or by a manager, with a required reason.

New case commands: `AssignCase` and `SetCaseRestriction`. Both are refused to skills and agents, like the other decision and review commands.

### Enforcement

- `evaluate()` gains a standing check for case-scoped actions. It needs the case's assignment and restriction, so the authorizer takes a resolver that the case API and control API each supply from their own store.
- The case API enforces standing on every route that already passes a case id.
- The human-work list filters by standing in the query, not after it. A `caseId` filter from the caller narrows the result and never widens it.
- The BFF adds nothing to the decision. It passes the caller's identity through, as it does now.
- A denial for lack of standing returns `authorization.case_standing_missing`, distinct from `authorization.role_missing`, so the screen can say "this case is assigned to another team" instead of "you lack a role".

### Screen

- My Workspace becomes a real personal queue, with a "Team" group for unclaimed work the caller may pick up.
- Managers get a tenant-wide view with assignee and team columns and an Assign action.
- The case header shows the team and assignees.
- A restricted case shows a "Restricted" marker to those who can open it. Those who cannot get a plain "not available to you" with no case details.

## Decisions

All five were decided on 2026-11-11 as recommended.

| # | Decision | Options | Decided |
|---|---|---|---|
| 1 | Unit of assignment | Person only · team only · team plus optional named people | Team plus optional named people. Teams give a queue to pull from; named people give accountability. |
| 2 | Reading ordinary cases | Tenant-wide · team only · assigned only | Tenant-wide for now. Analysts routinely need a related case for context. Restriction covers the sensitive ones. |
| 3 | Who assigns | Manager only · manager, and analysts may self-assign from their team's queue | Both. Self-assignment within a team keeps work moving; cross-team moves need a manager. |
| 4 | What makes a case restricted | Manual flag · automatic from case attributes (staff account, PEP, legal hold) · both | Manual flag first. Automatic rules are policy and belong in the policy engine once the flag exists. |
| 5 | Break-glass | None · manager may open any restricted case with a recorded reason · a separate emergency role | Manager with a recorded reason, written to the ledger and visible to auditors. |

## Delivery

| Step | What ships | Depends on |
|---|---|---|
| 1 | Teams, case assignment, `AssignCase`, `Case.Manager`; assignment shown on the case and in the queue. No enforcement yet. | Decisions 1 and 3 |
| 2 | The human-work list and My Workspace filter by standing. Analysts get their queue. | Step 1 |
| 3 | Standing enforced on case writes, evidence writes, claims and decisions. | Step 2 |
| 4 | Restricted cases and break-glass. | Decisions 4 and 5 |
| 5 | Team-only or assigned-only reading, if decision 2 changes. | Evidence from steps 1–4 |

Each step is usable on its own. Step 2 is the one that answers "analysts should see their queue".

## What is built

### Step 1: teams, assignment, case manager

| Piece | Where |
|---|---|
| `Case.Manager` role and `case.assign` action | `packages/identity/src/authorization.ts` |
| `AssignCase` command type, refused to skills | `packages/contracts/src/index.ts` |
| Tables `case_teams`, `case_team_members`, `case_assignments`, with forced row-level security | `packages/case-store/migrations/020_case_assignment.sql` |
| `AssignCase` handler; team and assignment reads and team upsert | `packages/case-store/src/index.ts`, `packages/case-store/src/assignment.ts` |
| `AssignCase` requires `case.assign` and a human; `GET`/`PUT /v1/case-teams`, `GET /v1/cases/:caseId/assignment`, `GET /v1/case-assignments` | `apps/case-api/src/app.ts` |
| `GET /v1/fincrime/teams`, `POST /v1/fincrime/cases/{caseId}/assignment`; `assignment` on the case room and on each queue item | BFF and Experience API contract |
| "Assigned to" panel, Reassign sheet for managers, assignment on queue items; two teams and a manager persona in the mock | `apps/web`, `packages/ui-mock` |

### Step 2: the work queue is scoped by standing

- The Workspace queue (`GET /v1/fincrime/work`) lists a person's work on cases they are named on, whose team they are in, or that have no assignment. A caller with `case.assign` sees everything. Each item carries its `standing` and the queue its `scope`, and the screen states the scope above the list.
- If assignments or teams cannot be read, the queue returns an error. It never falls back to showing everything. A case API that predates the assignment routes (404) is treated as having no assignments.
- **This is scoping in the BFF, not enforcement in the service that owns human work.** `GET /v1/operations/human-work` in the control API still returns every item to anyone with `human_work.read`, and the platform console's human-work page still shows them all.

### Step 3: standing enforced on case writes (case API only)

- A person's business commands and document uploads are refused with `authorization.case_standing_missing` unless they are named on the case, in its team, or the case is unassigned. The check runs after request validation and immediately before the write.
- `AssignCase` is exempt: it is the manager's own authority.
- Agents and services are exempt: they act under execution envelopes, not standing.
- **Not enforced:** claiming and deciding human work. Those live in the control API, which has no access to case assignments. Enforcing them needs the control API to ask the case API for standing, or assignment to be replicated to it.

### Decisions taken while building

- **An unassigned case is open to everyone with the role.** Otherwise every existing case would lock the moment enforcement shipped. Assign cases to a default team before relying on standing.
- **Assignment is not in the case snapshot.** It is read through its own route, so reassigning a case does not change the snapshot digest a decision is made on.
- **Reassigning advances the case sequence**, because it is a ledger event. A reviewer with a decision sheet open at that moment is told the case changed and must confirm before deciding.
- **A named person keeps standing after leaving the team**, until the case is reassigned: the assignment records what was decided.
- **Members are removed softly.** The case API has no delete right on these tables, so removing a member sets `removed_at`.

### Not built, not verified

- **Steps 4 and 5:** restricted cases, break-glass, and narrower reading. Reading a case is still tenant-wide.
- **Team management screen.** Teams are created and their members set through `PUT /v1/case-teams/:teamId` only.
- **PostgreSQL.** The migration, the row-level security policies, the `AssignCase` SQL and the standing query follow the existing patterns but have never executed: the store's database tests need `EHF_TEST_DATABASE_URL`. `grants.test.ts` will check the new tables' grants and forced row-level security when it is set.
- **`upstream/ehf-contracts.schema.json` was not re-exported**, so the UI contract's command-type enum does not list `AssignCase`. The screen assigns through the dedicated endpoint and does not need it.
- **The mock does not enforce standing on writes.** It scopes the queue only.

## Risks and open points

- **Existing cases have no assignment.** They need a default team at migration, or steps 2 and 3 hide them from everyone but managers.
- **Assignment lookups on every request.** The case API already loads the case for most routes. The human-work list needs the join in its query, with an index on case id.
- **Agents and services.** Workload identities are unaffected: standing applies to people. A workload still needs its own role, as now.
- **Directory groups.** Where a deployment manages teams in its identity provider, team membership should be read from there and not duplicated. That mapping is not designed here.
- **Earlier grants.** `Case.Analyst` now holds `human_work.read` and both case roles hold `event.read`, tenant-wide. Step 2 scopes the Workspace queue, but the reads themselves (events, evidence, the control API's human-work list) are still tenant-wide until steps 4 and 5.
- **Mock personas.** The mock grants by role only. It needs teams and assignments in its fixtures to exercise any of this.
