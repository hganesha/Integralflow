"""Acceptance tests for the case.* lifecycle skills.

Each test names the "Examples and acceptance" bullet it encodes in skill-content/skills/<id>.md:
missing context is an evidence gap, an unpinned policy key is POLICY_UNRESOLVED, conflicting or
dangling records are flagged rather than dropped, and a case is never closed with open work, an
unknown state or without independent approval.
"""
import pytest

from financial_crime import synthetic as f
from financial_crime.contracts import SkillError, Status, digest
from financial_crime.execution import Executor
from financial_crime.store import Store

TENANT = "tenant-synthetic"
POLICY_ID = "synthetic-policy-v1"
CASE = "case-demo"


@pytest.fixture
def build():
    """A fresh synthetic store: all seeded records except `without` types, plus `extra` records, the
    synthetic policy with `policy` overrides and `drop` keys removed, and the case in `case_state`."""
    stores = []

    def make(*, without=(), extra=(), policy=None, drop=(), case_state="OPEN"):
        store = Store()
        stores.append(store)
        data = {**f.policy(), **(policy or {})}
        for key in drop:
            data.pop(key)
        store.put(f.make_record("Policy", POLICY_ID, data))
        for record in f.records():
            if record.object_type not in without:
                store.put(record)
        for object_type, object_id, value in extra:
            store.put(f.make_record(object_type, object_id, value))
        if case_state:
            store.set_state(TENANT, "case", CASE, 0, {"state": case_state, "case_type": "KYB"})
        return store, Executor(store, [f.profile()], f.router()), f.principal()

    yield make
    for store in stores:
        store.close()


async def run(executor, principal, skill_id, parameters=None, **overrides):
    request = f.invocation(skill_id, **({"parameters": parameters} if parameters is not None else {}), **overrides)
    if parameters is not None and "idempotency_key" not in overrides:
        request = request.model_copy(update={"idempotency_key": skill_id + "-" + digest(parameters)[:16]})
    return await executor.run(request, principal)


def failed(result, code, status):
    assert result.lifecycle == "FAILED" and result.payload == {}, result.model_dump()
    assert result.error["code"] == code and result.status == status


def items(result):
    return [(x["code"], x["subject_ref"]) for x in result.unresolved_items]


def task(task_id, status="PENDING", dependencies=(), role="analyst"):
    return ("Task", task_id, {"role": role, "status": status, "dependencies": list(dependencies), "skill_id": "entity.address.normalize", "parameters": {}})


def case_state(store):
    return store.state(TENANT, "case", CASE)


# ------------------------------------------------------------------------------------- case.create

async def test_case_create_opens_the_invocation_case(build):
    """Normal: no case-demo yet, case_type KYB -> {case_id: case-demo, state: OPEN}, state written at revision 1."""
    store, executor, principal = build(case_state=None)
    result = await run(executor, principal, "case.create", {"case_type": "KYB"})
    assert result.status == Status.COMPLETED and result.payload == {"case_id": CASE, "state": "OPEN"}
    assert case_state(store) == (1, {"state": "OPEN", "case_type": "KYB"})


async def test_case_create_refuses_an_existing_case(build):
    """Existing case: case-demo already exists -> CONTROL_FAILED / BLOCKED and the case is untouched."""
    store, executor, principal = build(case_state="REVIEW")
    failed(await run(executor, principal, "case.create", {"case_type": "KYB"}), "CONTROL_FAILED", Status.BLOCKED)
    assert case_state(store) == (1, {"state": "REVIEW", "case_type": "KYB"})


async def test_case_create_without_case_id_derives_a_stable_id(build):
    """No case id: case_id is case-<first 16 hex of digest([tenant, idempotency key])>; a replay returns the same result."""
    _, executor, principal = build(case_state=None)
    request = f.invocation("case.create", parameters={"case_type": "KYC"}, case_id=None, idempotency_key="open-1")
    first = await executor.run(request, principal)
    expected = "case-" + digest([TENANT, "open-1"])[:16]
    assert first.status == Status.COMPLETED and first.payload == {"case_id": expected, "state": "OPEN"}
    again = await executor.run(request, principal)
    assert again.model_dump() == first.model_dump()


async def test_case_create_requires_a_case_type(build):
    """Unsupported input: no case_type -> INPUT_INVALID / FAILED."""
    store, executor, principal = build(case_state=None)
    failed(await run(executor, principal, "case.create", {}), "INPUT_INVALID", Status.FAILED)
    assert case_state(store) == (0, None)


# ------------------------------------------------------------------------------ case.context.hydrate

async def test_context_hydrate_returns_the_target_manifest(build):
    """Normal: target entity.resolve -> its manifest (skill_id entity.resolve, Entity refs acme and alice, no gaps), COMPLETED."""
    _, executor, principal = build()
    result = await run(executor, principal, "case.context.hydrate", {"target_skill": "entity.resolve"})
    manifest = result.payload["manifest"]
    assert result.status == Status.COMPLETED and result.unresolved_items == []
    assert manifest["skill_id"] == "entity.resolve" and manifest["gaps"] == []
    assert sorted((r["object_type"], r["object_id"]) for r in manifest["refs"]) == [("Entity", "acme"), ("Entity", "alice")]
    assert result.payload["context_hash"] == result.context_hash


async def test_context_hydrate_missing_target_context(build):
    """Missing evidence: no Entity records for entity.resolve -> CONTEXT_MISSING / NEEDS_EVIDENCE."""
    _, executor, principal = build(without=("Entity",))
    failed(await run(executor, principal, "case.context.hydrate", {"target_skill": "entity.resolve"}), "CONTEXT_MISSING", Status.NEEDS_EVIDENCE)


async def test_context_hydrate_flags_an_excluded_optional_record(build):
    """Partial context: an optional BusinessCalendar older than its pinned freshness is excluded -> PARTIAL with CONTEXT_STALE for calendar-1."""
    _, executor, principal = build(policy={"freshness_seconds": {"BusinessCalendar": 86400}})
    result = await run(executor, principal, "case.context.hydrate", {"target_skill": "regulatory.deadline.calculate"})
    assert result.status == Status.PARTIAL and result.lifecycle == "SUCCEEDED"
    assert items(result) == [("CONTEXT_STALE", "calendar-1")]
    assert result.payload["manifest"]["refs"] == []


async def test_context_hydrate_absent_optional_type_is_not_a_gap(build):
    """Edge: no BusinessCalendar at all for an optional requirement -> COMPLETED with no gap."""
    _, executor, principal = build(without=("BusinessCalendar",))
    result = await run(executor, principal, "case.context.hydrate", {"target_skill": "regulatory.deadline.calculate"})
    assert result.status == Status.COMPLETED and result.unresolved_items == []
    assert result.payload["manifest"]["gaps"] == [] and result.payload["manifest"]["refs"] == []


@pytest.mark.parametrize("target", ["case.context.hydrate", "no.such.skill"])
async def test_context_hydrate_refuses_an_unadmitted_target(build, target):
    """Unsupported input: hydrating itself or an unregistered skill -> ACCESS_DENIED / BLOCKED."""
    _, executor, principal = build()
    failed(await run(executor, principal, "case.context.hydrate", {"target_skill": target}), "ACCESS_DENIED", Status.BLOCKED)


# ---------------------------------------------------------------------------------- case.tasks.plan

def workflow(workflow_id, *steps):
    return ("WorkflowDefinition", workflow_id, {"steps": [{"id": i, "skill_id": sid, "dependencies": list(deps)} for i, sid, deps in steps]})


def tid(step):
    return digest([CASE, step])[:20]


async def test_tasks_plan_maps_prerequisites_to_planned_ids(build):
    """Normal: steps a, then b depending on a -> task ids digest([case, step])[:20]; b's dependency is a's task id."""
    _, executor, principal = build(without=("WorkflowDefinition",), extra=[workflow("wf", ("a", "entity.resolve", []), ("b", "entity.match", ["a"]))])
    result = await run(executor, principal, "case.tasks.plan")
    assert result.status == Status.COMPLETED
    assert result.payload == {"tasks": [{"id": tid("a"), "skill_id": "entity.resolve", "dependencies": []},
                                        {"id": tid("b"), "skill_id": "entity.match", "dependencies": [tid("a")]}]}


async def test_tasks_plan_flags_an_undefined_prerequisite(build):
    """Missing evidence: b depends on x, which no definition states -> tasks listed, NEEDS_REVIEW with EVIDENCE_INSUFFICIENT for b."""
    _, executor, principal = build(without=("WorkflowDefinition",), extra=[workflow("wf", ("a", "entity.resolve", []), ("b", "entity.match", ["x"]))])
    result = await run(executor, principal, "case.tasks.plan")
    assert result.status == Status.NEEDS_REVIEW and items(result) == [("EVIDENCE_INSUFFICIENT", "b")]
    assert [t["id"] for t in result.payload["tasks"]] == [tid("a"), tid("b")]


async def test_tasks_plan_refuses_conflicting_step_definitions(build):
    """Contradictory: two definitions give step a different skills -> SOURCE_CONFLICT / NEEDS_REVIEW, no plan."""
    _, executor, principal = build(without=("WorkflowDefinition",), extra=[
        workflow("wf-1", ("a", "entity.resolve", [])), workflow("wf-2", ("a", "entity.match", []))])
    failed(await run(executor, principal, "case.tasks.plan"), "SOURCE_CONFLICT", Status.NEEDS_REVIEW)


async def test_tasks_plan_merges_an_identical_shared_step(build):
    """Edge: the same step stated identically by two definitions -> one task."""
    _, executor, principal = build(without=("WorkflowDefinition",), extra=[
        workflow("wf-1", ("a", "entity.resolve", [])), workflow("wf-2", ("a", "entity.resolve", []), ("b", "entity.match", ["a"]))])
    result = await run(executor, principal, "case.tasks.plan")
    assert result.status == Status.COMPLETED and [t["id"] for t in result.payload["tasks"]] == [tid("a"), tid("b")]


async def test_tasks_plan_without_a_definition(build):
    """Missing evidence: no WorkflowDefinition -> CONTEXT_MISSING / NEEDS_EVIDENCE."""
    _, executor, principal = build(without=("WorkflowDefinition",))
    failed(await run(executor, principal, "case.tasks.plan"), "CONTEXT_MISSING", Status.NEEDS_EVIDENCE)


# -------------------------------------------------------------------------------- case.tasks.assign

async def test_tasks_assign_writes_an_authorized_assignment(build):
    """Normal: {task-1: analyst} for an analyst task -> [{task_id: task-1, actor: analyst, role: analyst}], assignment state written."""
    store, executor, principal = build()
    result = await run(executor, principal, "case.tasks.assign", {"assignments": {"task-1": "analyst"}})
    assert result.status == Status.COMPLETED and result.effects_committed
    assert result.payload == {"assignments": [{"task_id": "task-1", "actor": "analyst", "role": "analyst"}]}
    assert store.state(TENANT, "assignment", "task-1") == (1, {"task_id": "task-1", "actor": "analyst", "role": "analyst"})


async def test_tasks_assign_without_role_members(build):
    """Policy unresolved: no pinned role_members -> POLICY_UNRESOLVED / BLOCKED."""
    _, executor, principal = build(drop=["role_members"])
    failed(await run(executor, principal, "case.tasks.assign", {"assignments": {"task-1": "analyst"}}), "POLICY_UNRESOLVED", Status.BLOCKED)


async def test_tasks_assign_refuses_an_unknown_task(build):
    """Missing evidence: {task-1: analyst, task-9: analyst} with no task-9 -> CONTEXT_MISSING / NEEDS_EVIDENCE and nothing is written."""
    store, executor, principal = build()
    failed(await run(executor, principal, "case.tasks.assign", {"assignments": {"task-1": "analyst", "task-9": "analyst"}}), "CONTEXT_MISSING", Status.NEEDS_EVIDENCE)
    assert store.state(TENANT, "assignment", "task-1") == (0, None)


async def test_tasks_assign_refuses_an_assignee_outside_the_role(build):
    """Contradictory: {task-1: reviewer} for an analyst task -> ACCESS_DENIED."""
    _, executor, principal = build()
    failed(await run(executor, principal, "case.tasks.assign", {"assignments": {"task-1": "reviewer"}}), "ACCESS_DENIED", Status.BLOCKED)


async def test_tasks_assign_refuses_an_empty_request(build):
    """Unsupported input: assignments {} -> INPUT_INVALID / FAILED, never a completed no-op."""
    _, executor, principal = build()
    failed(await run(executor, principal, "case.tasks.assign", {"assignments": {}}), "INPUT_INVALID", Status.FAILED)


# ----------------------------------------------------------------------------- case.state.transition

async def test_state_transition_applies_a_pinned_transition(build):
    """Normal: OPEN at revision 1, target REVIEW, expected_revision 1 -> {state: REVIEW, revision: 2}."""
    store, executor, principal = build()
    result = await run(executor, principal, "case.state.transition", {"target": "REVIEW", "expected_revision": 1})
    assert result.status == Status.COMPLETED and result.payload == {"state": "REVIEW", "revision": 2}
    assert case_state(store) == (2, {"state": "REVIEW", "case_type": "KYB"})


async def test_state_transition_never_closes(build):
    """Closure: target CLOSED (even though the policy lists OPEN -> CLOSED) -> CONTROL_FAILED; only case.close closes."""
    store, executor, principal = build()
    failed(await run(executor, principal, "case.state.transition", {"target": "CLOSED", "expected_revision": 1}), "CONTROL_FAILED", Status.BLOCKED)
    assert case_state(store)[1]["state"] == "OPEN"


@pytest.mark.parametrize("case,code,status", [
    ("stale_revision", "REVISION_CONFLICT", Status.BLOCKED),
    ("no_case", "CONTEXT_MISSING", Status.NEEDS_EVIDENCE),
    ("no_policy", "POLICY_UNRESOLVED", Status.BLOCKED),
    ("unlisted_state", "CONTROL_FAILED", Status.BLOCKED),
    ("unlisted_target", "CONTROL_FAILED", Status.BLOCKED),
])
async def test_state_transition_fails_closed(build, case, code, status):
    """Stale revision 0 -> REVISION_CONFLICT; no case -> CONTEXT_MISSING; no case_transitions -> POLICY_UNRESOLVED;
    a REVIEW case under a policy with no REVIEW entry, or REVIEW -> OPEN, -> CONTROL_FAILED."""
    options = {"stale_revision": ({}, 0, "OPEN", "REVIEW"), "no_case": ({}, 1, None, "REVIEW"),
               "no_policy": ({"drop": ["case_transitions"]}, 1, "OPEN", "REVIEW"),
               "unlisted_state": ({"policy": {"case_transitions": {"OPEN": ["REVIEW"]}}}, 1, "REVIEW", "OPEN"),
               "unlisted_target": ({}, 1, "REVIEW", "OPEN")}
    kwargs, revision, state, target = options[case]
    _, executor, principal = build(case_state=state, **kwargs)
    failed(await run(executor, principal, "case.state.transition", {"target": target, "expected_revision": revision}), code, status)


# ------------------------------------------------------------------------- case.dependencies.evaluate

async def test_dependencies_ready_and_blocked(build):
    """Normal: t1 COMPLETED, t2 PENDING after t1, t3 PENDING after t2 -> ready [t2], blocked [t3], no cycles;
    t1 and a RUNNING t4 and CANCELLED t5 are neither ready nor blocked."""
    _, executor, principal = build(without=("Task",), extra=[task("t1", "COMPLETED"), task("t2", dependencies=["t1"]), task("t3", dependencies=["t2"]),
                                                             task("t4", "RUNNING"), task("t5", "CANCELLED")])
    result = await run(executor, principal, "case.dependencies.evaluate")
    assert result.status == Status.COMPLETED and result.payload == {"ready": ["t2"], "blocked": ["t3"], "cycles": []}


async def test_dependencies_flag_an_unknown_prerequisite(build):
    """Missing evidence: t2 depends on t9, which is not an admitted task -> blocked [t2], NEEDS_EVIDENCE with EVIDENCE_INSUFFICIENT for t2."""
    _, executor, principal = build(without=("Task",), extra=[task("t2", dependencies=["t9"])])
    result = await run(executor, principal, "case.dependencies.evaluate")
    assert result.payload == {"ready": [], "blocked": ["t2"], "cycles": []}
    assert result.status == Status.NEEDS_EVIDENCE and items(result) == [("EVIDENCE_INSUFFICIENT", "t2")]


async def test_dependencies_report_a_cycle(build):
    """Contradictory: a depends on b and b on a -> both blocked, the cycle listed, NEEDS_REVIEW with DEPENDENCY_CYCLE."""
    _, executor, principal = build(without=("Task",), extra=[task("a", dependencies=["b"]), task("b", dependencies=["a"])])
    result = await run(executor, principal, "case.dependencies.evaluate")
    assert result.payload["ready"] == [] and result.payload["blocked"] == ["a", "b"]
    assert [sorted(c) for c in result.payload["cycles"]] == [["a", "b"]]
    assert result.status == Status.NEEDS_REVIEW and [x["code"] for x in result.unresolved_items] == ["DEPENDENCY_CYCLE"]


async def test_dependencies_without_tasks(build):
    """Missing evidence: no Task -> CONTEXT_MISSING / NEEDS_EVIDENCE."""
    _, executor, principal = build(without=("Task",))
    failed(await run(executor, principal, "case.dependencies.evaluate"), "CONTEXT_MISSING", Status.NEEDS_EVIDENCE)


# ---------------------------------------------------------------------------------- case.sla.monitor

def sla(sla_id, deadline, task_id="task-1"):
    return ("SLA", sla_id, {"task_id": task_id, "deadline": deadline})


async def test_sla_monitor_measures_at_the_business_time(build):
    """Normal: deadline 2027-11-07T00:00Z at as-of 2026-11-07T12:00Z -> overdue false, seconds_remaining 31492800."""
    _, executor, principal = build()
    result = await run(executor, principal, "case.sla.monitor")
    assert result.status == Status.COMPLETED
    assert result.payload == {"deadlines": [{"task_id": "task-1", "overdue": False, "seconds_remaining": 31492800.0}]}


async def test_sla_monitor_compares_instants_across_offsets(build):
    """Edge: deadline 2026-11-07T13:00+02:00 (11:00Z) at as-of 12:00Z -> overdue true, seconds_remaining -3600."""
    _, executor, principal = build(without=("SLA",), extra=[sla("sla-x", "2026-11-07T13:00:00+02:00")])
    result = await run(executor, principal, "case.sla.monitor")
    assert result.payload == {"deadlines": [{"task_id": "task-1", "overdue": True, "seconds_remaining": -3600.0}]}


async def test_sla_monitor_flags_conflicting_deadlines(build):
    """Contradictory: two SLAs give task-1 different deadlines -> both listed, NEEDS_REVIEW with SOURCE_CONFLICT for task-1."""
    _, executor, principal = build(without=("SLA",), extra=[sla("sla-a", "2026-11-08T12:00:00+00:00"), sla("sla-b", "2026-11-09T12:00:00+00:00")])
    result = await run(executor, principal, "case.sla.monitor")
    assert [x["seconds_remaining"] for x in result.payload["deadlines"]] == [86400.0, 172800.0]
    assert result.status == Status.NEEDS_REVIEW and items(result) == [("SOURCE_CONFLICT", "task-1")]


async def test_sla_monitor_same_instant_in_two_offsets_is_not_a_conflict(build):
    """Edge: 2026-11-08T12:00Z and 2026-11-08T14:00+02:00 are one deadline -> COMPLETED."""
    _, executor, principal = build(without=("SLA",), extra=[sla("sla-a", "2026-11-08T12:00:00+00:00"), sla("sla-b", "2026-11-08T14:00:00+02:00")])
    result = await run(executor, principal, "case.sla.monitor")
    assert result.status == Status.COMPLETED and result.unresolved_items == []


async def test_sla_monitor_missing_deadline(build):
    """Missing evidence: no SLA -> CONTEXT_MISSING / NEEDS_EVIDENCE, never on time; an SLA without a deadline is refused at admission."""
    _, executor, principal = build(without=("SLA",))
    failed(await run(executor, principal, "case.sla.monitor"), "CONTEXT_MISSING", Status.NEEDS_EVIDENCE)
    with pytest.raises(SkillError):
        f.make_record("SLA", "sla-x", {"task_id": "task-1"})


# ------------------------------------------------------------------------------------ case.escalate

async def test_escalate_writes_an_escalation_for_a_staffed_role(build):
    """Normal: role compliance (member reviewer) -> escalation_id digest([case, parameters])[:20], escalation state written."""
    store, executor, principal = build()
    parameters = {"reason": "Synthetic test", "role": "compliance"}
    result = await run(executor, principal, "case.escalate", parameters)
    eid = digest([CASE, parameters])[:20]
    assert result.status == Status.COMPLETED and result.payload == {"escalation_id": eid}
    assert store.state(TENANT, "escalation", eid) == (1, parameters)


@pytest.mark.parametrize("policy,drop", [({}, ["role_members"]), ({"role_members": {"analyst": ["analyst"]}}, []),
                                         ({"role_members": {"analyst": ["analyst"], "compliance": []}}, [])])
async def test_escalate_policy_unresolved(build, policy, drop):
    """Policy unresolved: no role_members, a role the policy does not name, or a role with no members -> POLICY_UNRESOLVED / BLOCKED."""
    _, executor, principal = build(policy=policy, drop=drop)
    failed(await run(executor, principal, "case.escalate", {"reason": "Synthetic test", "role": "compliance"}), "POLICY_UNRESOLVED", Status.BLOCKED)


@pytest.mark.parametrize("state,code,status", [(None, "CONTEXT_MISSING", Status.NEEDS_EVIDENCE), ("CLOSED", "CONTROL_FAILED", Status.BLOCKED)])
async def test_escalate_requires_an_open_case(build, state, code, status):
    """Missing case -> CONTEXT_MISSING / NEEDS_EVIDENCE; a CLOSED case -> CONTROL_FAILED."""
    _, executor, principal = build(case_state=state)
    failed(await run(executor, principal, "case.escalate", {"reason": "Synthetic test", "role": "compliance"}), code, status)


# ---------------------------------------------------------------------------- case.summary.generate

async def test_summary_lists_cited_findings(build):
    """Normal: finding-1 citing evidence-1 -> {case_id: case-demo, findings: [finding-1], gaps: []}, COMPLETED."""
    _, executor, principal = build()
    result = await run(executor, principal, "case.summary.generate")
    summary = result.payload["summary"]
    assert result.status == Status.COMPLETED and summary["case_id"] == CASE and summary["gaps"] == []
    assert [(x["id"], x["status"], x["evidence_ids"]) for x in summary["findings"]] == [("finding-1", "RESOLVED", ["evidence-1"])]


async def test_summary_flags_an_uncited_finding(build):
    """Missing evidence: a DISPUTED finding with no evidence_ids -> listed as is, NEEDS_REVIEW with EVIDENCE_INSUFFICIENT for it."""
    _, executor, principal = build(extra=[("Finding", "finding-2", {"claim": "Funds came from a third party.", "evidence_ids": [], "status": "DISPUTED"})])
    result = await run(executor, principal, "case.summary.generate")
    assert [x["id"] for x in result.payload["summary"]["findings"]] == ["finding-1", "finding-2"]
    assert result.status == Status.NEEDS_REVIEW and items(result) == [("EVIDENCE_INSUFFICIENT", "finding-2")]


async def test_summary_without_findings(build):
    """Missing evidence: no Finding -> CONTEXT_MISSING / NEEDS_EVIDENCE, never an empty summary."""
    _, executor, principal = build(without=("Finding",))
    failed(await run(executor, principal, "case.summary.generate"), "CONTEXT_MISSING", Status.NEEDS_EVIDENCE)


# ---------------------------------------------------------------------------------------- case.close

async def test_close_waits_for_and_consumes_independent_approval(build):
    """Normal: tasks COMPLETED, identity control PASS, case OPEN -> WAITING_FOR_HUMAN (case still OPEN);
    after an independent compliance approval -> closed true, case CLOSED."""
    store, executor, principal = build()
    request = f.invocation("case.close")
    pending = await executor.run(request, principal)
    assert pending.status == Status.NEEDS_REVIEW and pending.lifecycle == "WAITING_FOR_HUMAN"
    assert [x["code"] for x in pending.unresolved_items] == ["HUMAN_REVIEW_REQUIRED"] and not pending.effects_committed
    assert case_state(store)[1]["state"] == "OPEN"
    reviewer = f.principal("reviewer")
    reviewer.permissions.add("approve:case.close")
    executor.approve(pending.unresolved_items[0]["approval_id"], reviewer)
    done = await executor.run(request, principal, approved_task=pending.unresolved_items[0]["approval_id"])
    assert done.status == Status.COMPLETED and done.payload == {"closed": True}
    assert case_state(store) == (2, {"state": "CLOSED", "case_type": "KYB"})


async def test_close_refuses_open_work(build):
    """Open work: task t2 PENDING -> CONTROL_FAILED naming t2, no approval requested."""
    store, executor, principal = build(extra=[task("t2")])
    result = await run(executor, principal, "case.close")
    failed(result, "CONTROL_FAILED", Status.BLOCKED)
    assert "t2" in result.error["message"]
    assert store.db.execute("SELECT COUNT(*) FROM state WHERE kind='approval'").fetchone()[0] == 0


@pytest.mark.parametrize("kwargs,code", [
    ({"without": ("Control",), "extra": [("Control", "c-1", {"requirement_id": "identity", "outcome": "UNKNOWN"})]}, "CONTROL_FAILED"),
    ({"extra": [("Control", "c-2", {"requirement_id": "identity", "outcome": "FAIL"})]}, "CONTROL_FAILED"),
    ({"drop": ["requirements"]}, "POLICY_UNRESOLVED"),
    ({"drop": ["case_transitions"]}, "POLICY_UNRESOLVED"),
])
async def test_close_requires_satisfied_controls_and_pinned_policy(build, kwargs, code):
    """Controls: identity UNKNOWN, or a PASS and a FAIL row -> CONTROL_FAILED; no requirements or case_transitions -> POLICY_UNRESOLVED."""
    _, executor, principal = build(**kwargs)
    failed(await run(executor, principal, "case.close"), code, Status.BLOCKED)


@pytest.mark.parametrize("state,policy,code,status", [
    ("CLOSED", None, "CONTROL_FAILED", Status.BLOCKED),
    ("REVIEW", {"case_transitions": {"OPEN": ["REVIEW", "CLOSED"]}}, "CONTROL_FAILED", Status.BLOCKED),
    (None, None, "CONTEXT_MISSING", Status.NEEDS_EVIDENCE),
])
async def test_close_requires_a_closable_state(build, state, policy, code, status):
    """State: already CLOSED, or REVIEW when the policy only closes from OPEN -> CONTROL_FAILED; no case -> CONTEXT_MISSING."""
    _, executor, principal = build(case_state=state, policy=policy)
    failed(await run(executor, principal, "case.close"), code, status)
