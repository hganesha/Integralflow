"""Acceptance tests for the ongoing-monitoring monitor.* skills (monitor.customer.schedule has its own file).

Each test names the "Examples and acceptance" bullet it encodes in skill-content/skills/<id>.md:
an unpinned policy key is POLICY_UNRESOLVED, an empty snapshot or a missing baseline is an evidence
gap, conflicting records are flagged rather than collapsed, and a review is never closed with open
work or without independent approval.
"""
import pytest

from financial_crime import synthetic as f
from financial_crime.contracts import Status, digest
from financial_crime.execution import Executor
from financial_crime.store import Store

TENANT = "tenant-synthetic"
POLICY_ID = "synthetic-policy-v1"
CASE = "case-demo"
COVERAGE = {"complete": True, "jurisdictions": ["synthetic-neutral"], "as_of": f.OLD.isoformat(), "limitations": ["synthetic test source only"]}


@pytest.fixture
def build():
    """A fresh synthetic store: all seeded records except `without` types, plus `extra` records, and the
    synthetic policy with `policy` overrides and `drop` keys removed."""
    stores = []

    def make(*, without=(), extra=(), policy=None, drop=()):
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
        store.set_state(TENANT, "case", CASE, 0, {"state": "OPEN", "case_type": "KYB"})
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


def event(event_id, event_type="risk_changed", key="change-1", facts=None):
    return ("Event", event_id, {"event_type": event_type, "event_key": key, "facts": {"changed": True} if facts is None else facts})


def task(task_id, status="PENDING", dependencies=()):
    return ("Task", task_id, {"role": "analyst", "status": status, "dependencies": list(dependencies), "skill_id": "entity.address.normalize",
                              "parameters": {"address": "1 Test Street"}})


# --------------------------------------------------------------------------- monitor.trigger.evaluate

async def test_trigger_evaluate_normal(build):
    """Normal: event-1 risk_changed with changed true -> [{event_id: event-1, trigger_id: risk-change, outcome: PASS}], COMPLETED."""
    _, executor, principal = build()
    result = await run(executor, principal, "monitor.trigger.evaluate")
    assert result.status == Status.COMPLETED
    assert result.payload == {"triggers": [{"event_id": "event-1", "trigger_id": "risk-change", "outcome": "PASS"}]}


async def test_trigger_evaluate_missing_fact_is_unknown(build):
    """Missing evidence: facts without changed -> outcome UNKNOWN, never FAIL."""
    _, executor, principal = build(without=("Event",), extra=[event("e-1", facts={"other": 1})])
    result = await run(executor, principal, "monitor.trigger.evaluate")
    assert result.payload == {"triggers": [{"event_id": "e-1", "trigger_id": "risk-change", "outcome": "UNKNOWN"}]}


async def test_trigger_evaluate_without_pinned_triggers(build):
    """Policy unresolved: no monitor_triggers -> POLICY_UNRESOLVED / BLOCKED, never "no triggers fired"."""
    _, executor, principal = build(drop=["monitor_triggers"])
    failed(await run(executor, principal, "monitor.trigger.evaluate"), "POLICY_UNRESOLVED", Status.BLOCKED)


async def test_trigger_evaluate_flags_an_uncovered_event_type(build):
    """Uncovered: event e-2 of type address_changed, which no pinned trigger covers -> NEEDS_REVIEW with POLICY_UNRESOLVED for e-2."""
    _, executor, principal = build(extra=[event("e-2", event_type="address_changed", key="change-2")])
    result = await run(executor, principal, "monitor.trigger.evaluate")
    assert result.payload == {"triggers": [{"event_id": "event-1", "trigger_id": "risk-change", "outcome": "PASS"}]}
    assert result.status == Status.NEEDS_REVIEW and items(result) == [("POLICY_UNRESOLVED", "e-2")]


async def test_trigger_evaluate_deduplicates_and_flags_conflicting_events(build):
    """Duplicates: a second identical record of change-1 is evaluated once (COMPLETED); one with different facts
    -> no evaluation for change-1, NEEDS_REVIEW with SOURCE_CONFLICT for change-1."""
    _, executor, principal = build(extra=[event("event-2")])
    same = await run(executor, principal, "monitor.trigger.evaluate")
    assert same.status == Status.COMPLETED and len(same.payload["triggers"]) == 1
    _, executor, principal = build(extra=[event("event-2", facts={"changed": False})])
    result = await run(executor, principal, "monitor.trigger.evaluate")
    assert result.payload == {"triggers": []}
    assert result.status == Status.NEEDS_REVIEW and items(result) == [("SOURCE_CONFLICT", "change-1")]


# ---------------------------------------------------------------------------- monitor.profile.change

async def test_profile_change_normal(build):
    """Normal: before {name: Acme}, after {name: Acme New} -> [{field: name, before: Acme, after: Acme New}], COMPLETED."""
    _, executor, principal = build()
    result = await run(executor, principal, "monitor.profile.change", {"before": {"name": "Acme"}, "after": {"name": "Acme New"}})
    assert result.status == Status.COMPLETED
    assert result.payload == {"changes": [{"field": "name", "before": "Acme", "after": "Acme New"}]}


async def test_profile_change_unchanged(build):
    """Edge: identical snapshots -> changes [], COMPLETED."""
    _, executor, principal = build()
    result = await run(executor, principal, "monitor.profile.change", {"before": {"name": "Acme"}, "after": {"name": "Acme"}})
    assert result.status == Status.COMPLETED and result.payload == {"changes": []}


async def test_profile_change_empty_snapshot(build):
    """Missing evidence: before {} -> the change is listed, NEEDS_EVIDENCE with EVIDENCE_INSUFFICIENT for before."""
    _, executor, principal = build()
    result = await run(executor, principal, "monitor.profile.change", {"before": {}, "after": {"name": "Acme"}})
    assert result.payload == {"changes": [{"field": "name", "before": None, "after": "Acme"}]}
    assert result.status == Status.NEEDS_EVIDENCE and items(result) == [("EVIDENCE_INSUFFICIENT", "before")]


async def test_profile_change_one_sided_field(build):
    """Missing evidence: employees captured only after -> listed, NEEDS_EVIDENCE with EVIDENCE_INSUFFICIENT for employees."""
    _, executor, principal = build()
    result = await run(executor, principal, "monitor.profile.change", {"before": {"name": "Acme"}, "after": {"name": "Acme", "employees": 10}})
    assert result.payload == {"changes": [{"field": "employees", "before": None, "after": 10}]}
    assert result.status == Status.NEEDS_EVIDENCE and items(result) == [("EVIDENCE_INSUFFICIENT", "employees")]


# -------------------------------------------------------------------------- monitor.ownership.change

async def test_ownership_change_normal(build):
    """Normal: alice 0.6 -> 0.8 -> [{field: alice, before: 0.6, after: 0.8}], COMPLETED."""
    _, executor, principal = build()
    result = await run(executor, principal, "monitor.ownership.change", {"before": {"alice": "0.6"}, "after": {"alice": "0.8"}})
    assert result.status == Status.COMPLETED
    assert result.payload == {"changes": [{"field": "alice", "before": "0.6", "after": "0.8"}]}


async def test_ownership_change_compares_decimals(build):
    """Edge: alice 0.5 -> 0.50 is the same holding -> changes [], COMPLETED."""
    _, executor, principal = build()
    result = await run(executor, principal, "monitor.ownership.change", {"before": {"alice": "0.5"}, "after": {"alice": "0.50"}})
    assert result.status == Status.COMPLETED and result.payload == {"changes": []}


async def test_ownership_change_empty_snapshot(build):
    """Missing evidence: after {} -> NEEDS_EVIDENCE with EVIDENCE_INSUFFICIENT for after."""
    _, executor, principal = build()
    result = await run(executor, principal, "monitor.ownership.change", {"before": {"alice": "0.6"}, "after": {}})
    assert result.status == Status.NEEDS_EVIDENCE and items(result) == [("EVIDENCE_INSUFFICIENT", "after")]


async def test_ownership_change_oversubscribed_snapshot(build):
    """Contradictory: after {alice: 0.8, bob: 0.4} sums above 1 -> changes listed, NEEDS_REVIEW with SOURCE_CONFLICT for after."""
    _, executor, principal = build()
    result = await run(executor, principal, "monitor.ownership.change", {"before": {"alice": "0.6"}, "after": {"alice": "0.8", "bob": "0.4"}})
    assert [x["field"] for x in result.payload["changes"]] == ["alice", "bob"]
    assert result.status == Status.NEEDS_REVIEW and items(result) == [("SOURCE_CONFLICT", "after")]


# ------------------------------------------------------------------------- monitor.screening.refresh

async def test_screening_refresh_complete_lists(build):
    """Normal: three complete list captures -> versions [synthetic-general-v1, synthetic-pep-v1, synthetic-sanctions-v1], refresh_required false."""
    _, executor, principal = build()
    result = await run(executor, principal, "monitor.screening.refresh")
    assert result.status == Status.COMPLETED
    assert result.payload == {"versions": ["synthetic-general-v1", "synthetic-pep-v1", "synthetic-sanctions-v1"], "refresh_required": False}


async def test_screening_refresh_incomplete_capture(build):
    """Incomplete: one capture with coverage complete false -> refresh_required true."""
    _, executor, principal = build(extra=[("WatchlistEntry", "watch-2", {"name": "Another", "identifiers": ["SYN-9994"], "list_type": "sanctions",
                                                                         "list_version": "synthetic-sanctions-v2", "coverage": {**COVERAGE, "complete": False}})])
    result = await run(executor, principal, "monitor.screening.refresh")
    assert result.payload["refresh_required"] is True and "synthetic-sanctions-v2" in result.payload["versions"]


async def test_screening_refresh_without_entries(build):
    """Missing evidence: no WatchlistEntry -> CONTEXT_MISSING / NEEDS_EVIDENCE, never "no refresh required"."""
    _, executor, principal = build(without=("WatchlistEntry",))
    failed(await run(executor, principal, "monitor.screening.refresh"), "CONTEXT_MISSING", Status.NEEDS_EVIDENCE)


async def test_screening_refresh_stale_entries(build):
    """Stale: pinned freshness of one day for WatchlistEntry, captures from 2026-01-01 -> CONTEXT_STALE / NEEDS_EVIDENCE."""
    _, executor, principal = build(policy={"freshness_seconds": {"WatchlistEntry": 86400}})
    failed(await run(executor, principal, "monitor.screening.refresh"), "CONTEXT_STALE", Status.NEEDS_EVIDENCE)


# ---------------------------------------------------------------------- monitor.transaction.deviation

async def test_transaction_deviation_normal(build):
    """Normal: expected SYN 200 against settled SYN 60+60+110 -> [{currency: SYN, actual: 230, difference: 30, baseline_known: true}]."""
    _, executor, principal = build()
    result = await run(executor, principal, "monitor.transaction.deviation", {"expected_totals": {"SYN": "200"}})
    assert result.status == Status.COMPLETED
    assert result.payload == {"deviations": [{"currency": "SYN", "actual": "230", "difference": "30", "baseline_known": True}]}


async def test_transaction_deviation_expected_currency_without_activity(build):
    """Edge: expected EUR 50 with no EUR activity in the complete window -> {currency: EUR, actual: 0, difference: -50}."""
    _, executor, principal = build()
    result = await run(executor, principal, "monitor.transaction.deviation", {"expected_totals": {"SYN": "230", "EUR": "50"}})
    assert result.status == Status.COMPLETED
    assert result.payload == {"deviations": [{"currency": "SYN", "actual": "230", "difference": "0", "baseline_known": True},
                                             {"currency": "EUR", "actual": "0", "difference": "-50", "baseline_known": True}]}


async def test_transaction_deviation_without_a_baseline(build):
    """Missing evidence: expected_totals {} -> SYN listed with difference null, NEEDS_EVIDENCE with EVIDENCE_INSUFFICIENT for SYN."""
    _, executor, principal = build()
    result = await run(executor, principal, "monitor.transaction.deviation", {"expected_totals": {}})
    assert result.payload == {"deviations": [{"currency": "SYN", "actual": "230", "difference": None, "baseline_known": False}]}
    assert result.status == Status.NEEDS_EVIDENCE and items(result) == [("EVIDENCE_INSUFFICIENT", "SYN")]


async def test_transaction_deviation_incomplete_window(build):
    """Missing evidence: a DatasetScope with complete false -> EVIDENCE_INSUFFICIENT / NEEDS_EVIDENCE."""
    _, executor, principal = build(without=("DatasetScope",), extra=[("DatasetScope", "dataset-1", {"start": f.START, "end": f.END, "watermark": f.END, "complete": False, "expected_count": 3})])
    failed(await run(executor, principal, "monitor.transaction.deviation", {"expected_totals": {"SYN": "200"}}), "EVIDENCE_INSUFFICIENT", Status.NEEDS_EVIDENCE)


async def test_transaction_deviation_conflicting_duplicate(build):
    """Contradictory: a second record of event-tx-1 with another amount -> SOURCE_CONFLICT / NEEDS_REVIEW."""
    _, executor, principal = build(without=("DatasetScope",), extra=[
        ("DatasetScope", "dataset-1", {"start": f.START, "end": f.END, "watermark": f.END, "complete": True, "expected_count": 4}),
        ("Transaction", "tx-9", {"source": "acct-a", "target": "acct-b", "amount": "61", "currency": "SYN", "timestamp": "2026-11-02T01:00:00+00:00",
                                 "event_id": "event-tx-1", "status": "settled", "country": "SYN", "transaction_type": "transfer"})])
    failed(await run(executor, principal, "monitor.transaction.deviation", {"expected_totals": {"SYN": "200"}}), "SOURCE_CONFLICT", Status.NEEDS_REVIEW)


# --------------------------------------------------------------------------- monitor.risk.recalculate

def factor(factor_id, name, score):
    return ("RiskFactor", factor_id, {"name": name, "score": score})


async def test_risk_recalculate_normal(build):
    """Normal: geography 0.2 (weight 0.4) and product 0.3 (weight 0.6) -> score 0.26, tier LOW, COMPLETED."""
    _, executor, principal = build()
    result = await run(executor, principal, "monitor.risk.recalculate")
    assert result.status == Status.COMPLETED and result.payload["tier"] == "LOW"
    assessment = result.payload["assessment"]
    assert assessment["score"] == "0.26" and assessment["missing"] == [] and assessment["model_version"] == "synthetic-risk-v1"


async def test_risk_recalculate_missing_factor(build):
    """Missing evidence: no product factor -> score null, tier UNKNOWN, NEEDS_EVIDENCE with EVIDENCE_INSUFFICIENT for product."""
    _, executor, principal = build(without=("RiskFactor",), extra=[factor("risk-geo", "geography", "0.2")])
    result = await run(executor, principal, "monitor.risk.recalculate")
    assert result.payload["assessment"]["score"] is None and result.payload["tier"] == "UNKNOWN"
    assert result.status == Status.NEEDS_EVIDENCE and items(result) == [("EVIDENCE_INSUFFICIENT", "product")]


async def test_risk_recalculate_conflicting_factor(build):
    """Contradictory: two geography factors scored 0.2 and 0.9 -> SOURCE_CONFLICT / NEEDS_REVIEW."""
    _, executor, principal = build(extra=[factor("risk-geo-2", "geography", "0.9")])
    failed(await run(executor, principal, "monitor.risk.recalculate"), "SOURCE_CONFLICT", Status.NEEDS_REVIEW)


@pytest.mark.parametrize("key", ["risk_model_version", "risk_tiers", "risk_weights"])
async def test_risk_recalculate_policy_unresolved(build, key):
    """Policy unresolved: no risk_model_version, risk_tiers or risk_weights -> POLICY_UNRESOLVED / BLOCKED."""
    _, executor, principal = build(drop=[key])
    failed(await run(executor, principal, "monitor.risk.recalculate"), "POLICY_UNRESOLVED", Status.BLOCKED)


async def test_risk_recalculate_score_in_no_tier(build):
    """Edge: tiers start at 0.5 and the score is 0.26 -> tier UNKNOWN, NEEDS_REVIEW with POLICY_UNRESOLVED."""
    _, executor, principal = build(policy={"risk_tiers": [{"minimum": "0.5", "tier": "HIGH"}]})
    result = await run(executor, principal, "monitor.risk.recalculate")
    assert result.payload["tier"] == "UNKNOWN" and result.payload["assessment"]["score"] == "0.26"
    assert result.status == Status.NEEDS_REVIEW and [x["code"] for x in result.unresolved_items] == ["POLICY_UNRESOLVED"]


# ------------------------------------------------------------------------------- monitor.review.scope

def trigger(trigger_id, requirement_ids, reason):
    return ("ReviewTrigger", trigger_id, {"requirement_ids": requirement_ids, "reason": reason})


async def test_review_scope_normal(build):
    """Normal: trigger-1 naming identity -> requirements [identity], reasons [Synthetic periodic review], COMPLETED."""
    _, executor, principal = build()
    result = await run(executor, principal, "monitor.review.scope")
    assert result.status == Status.COMPLETED
    assert result.payload == {"requirements": ["identity"], "reasons": ["Synthetic periodic review"]}


async def test_review_scope_merges_triggers(build):
    """Edge: a second trigger naming ubo and identity -> requirements [identity, ubo] once each, both reasons in record order."""
    _, executor, principal = build(extra=[trigger("trigger-2", ["ubo", "identity"], "Ownership change")])
    result = await run(executor, principal, "monitor.review.scope")
    assert result.payload == {"requirements": ["identity", "ubo"], "reasons": ["Synthetic periodic review", "Ownership change"]}


async def test_review_scope_trigger_without_requirements(build):
    """Missing evidence: trigger-2 naming no requirement -> its reason listed, NEEDS_REVIEW with EVIDENCE_INSUFFICIENT for trigger-2."""
    _, executor, principal = build(extra=[trigger("trigger-2", [], "Adverse media")])
    result = await run(executor, principal, "monitor.review.scope")
    assert result.payload == {"requirements": ["identity"], "reasons": ["Synthetic periodic review", "Adverse media"]}
    assert result.status == Status.NEEDS_REVIEW and items(result) == [("EVIDENCE_INSUFFICIENT", "trigger-2")]


async def test_review_scope_without_triggers(build):
    """Missing evidence: no ReviewTrigger -> CONTEXT_MISSING / NEEDS_EVIDENCE, never an empty scope."""
    _, executor, principal = build(without=("ReviewTrigger",))
    failed(await run(executor, principal, "monitor.review.scope"), "CONTEXT_MISSING", Status.NEEDS_EVIDENCE)


# ----------------------------------------------------------------------------- monitor.review.execute

def outbox(store):
    return [row[0] for row in store.db.execute("SELECT id FROM outbox WHERE tenant=? ORDER BY id", (TENANT,))]


async def test_review_execute_queues_ready_work(build):
    """Normal: t1 COMPLETED, t2 PENDING after t1 -> queued_tasks [t2], complete false, PARTIAL, one execute_skill command."""
    store, executor, principal = build(without=("Task",), extra=[task("t1", "COMPLETED"), task("t2", dependencies=["t1"])])
    result = await run(executor, principal, "monitor.review.execute")
    assert result.status == Status.PARTIAL and result.payload == {"queued_tasks": ["t2"], "complete": False}
    assert outbox(store) == [digest([CASE, "t2"])]


async def test_review_execute_all_complete(build):
    """Complete: every task COMPLETED -> queued_tasks [], complete true, COMPLETED, nothing queued."""
    store, executor, principal = build()
    result = await run(executor, principal, "monitor.review.execute")
    assert result.status == Status.COMPLETED and result.payload == {"queued_tasks": [], "complete": True}
    assert outbox(store) == []


async def test_review_execute_unknown_prerequisite(build):
    """Missing evidence: t2 depends on t9, which is not an admitted task -> nothing queued, BLOCKED with EVIDENCE_INSUFFICIENT for t2."""
    store, executor, principal = build(without=("Task",), extra=[task("t2", dependencies=["t9"])])
    result = await run(executor, principal, "monitor.review.execute")
    assert result.payload == {"queued_tasks": [], "complete": False}
    assert result.status == Status.BLOCKED and items(result) == [("EVIDENCE_INSUFFICIENT", "t2")]
    assert outbox(store) == []


async def test_review_execute_waits_on_running_work(build):
    """Edge: t2 PENDING after t1, which is RUNNING -> nothing queued, complete false, BLOCKED."""
    _, executor, principal = build(without=("Task",), extra=[task("t1", "RUNNING"), task("t2", dependencies=["t1"])])
    result = await run(executor, principal, "monitor.review.execute")
    assert result.status == Status.BLOCKED and result.payload == {"queued_tasks": [], "complete": False} and result.unresolved_items == []


# ------------------------------------------------------------------------------- monitor.review.close

async def test_review_close_waits_for_and_consumes_independent_approval(build):
    """Normal: tasks COMPLETED and identity PASS -> WAITING_FOR_HUMAN; after an independent compliance approval -> closed true, review CLOSED."""
    store, executor, principal = build()
    request = f.invocation("monitor.review.close")
    pending = await executor.run(request, principal)
    assert pending.status == Status.NEEDS_REVIEW and pending.lifecycle == "WAITING_FOR_HUMAN" and not pending.effects_committed
    assert store.state(TENANT, "review", CASE) == (0, None)
    reviewer = f.principal("reviewer")
    reviewer.permissions.add("approve:monitor.review.close")
    approval = pending.unresolved_items[0]["approval_id"]
    executor.approve(approval, reviewer)
    done = await executor.run(request, principal, approved_task=approval)
    assert done.status == Status.COMPLETED and done.payload == {"closed": True}
    assert store.state(TENANT, "review", CASE) == (1, {"status": "CLOSED"})


async def test_review_close_refuses_open_work(build):
    """Open work: task t2 PENDING -> CONTROL_FAILED naming t2."""
    _, executor, principal = build(extra=[task("t2")])
    result = await run(executor, principal, "monitor.review.close")
    failed(result, "CONTROL_FAILED", Status.BLOCKED)
    assert "t2" in result.error["message"]


@pytest.mark.parametrize("kwargs,code", [
    ({"extra": [("Control", "c-2", {"requirement_id": "identity", "outcome": "FAIL"})]}, "CONTROL_FAILED"),
    ({"without": ("Control",), "extra": [("Control", "c-1", {"requirement_id": "other", "outcome": "PASS"})]}, "CONTROL_FAILED"),
    ({"drop": ["requirements"]}, "POLICY_UNRESOLVED"),
])
async def test_review_close_requires_satisfied_controls(build, kwargs, code):
    """Controls: a FAIL row for identity, or no control for identity -> CONTROL_FAILED; no pinned requirements -> POLICY_UNRESOLVED."""
    _, executor, principal = build(**kwargs)
    failed(await run(executor, principal, "monitor.review.close"), code, Status.BLOCKED)


async def test_review_close_refuses_a_closed_review(build):
    """State: the review is already CLOSED -> CONTROL_FAILED."""
    store, executor, principal = build()
    store.set_state(TENANT, "review", CASE, 0, {"status": "CLOSED"})
    failed(await run(executor, principal, "monitor.review.close"), "CONTROL_FAILED", Status.BLOCKED)
