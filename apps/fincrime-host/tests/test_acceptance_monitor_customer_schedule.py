"""Acceptance tests for monitor.customer.schedule (periodic-review handoff at the end of KYC/KYB).

Asserts the exact due time and schedule identity, the single executor-governed state effect,
idempotent replay, and fail-closed handling of a missing or non-positive review interval.
"""
from datetime import datetime, timedelta, timezone
import json

import pytest

from financial_crime import synthetic as f
from financial_crime.contracts import SkillError, Status, digest
from financial_crime.execution import Executor
from financial_crime.store import Store

SKILL = "monitor.customer.schedule"
TENANT = "tenant-synthetic"


def build(*, policy=None, drop=(), synthetic=True):
    store = Store()
    data = f.policy()
    data.update(policy or {})
    for key in drop:
        data.pop(key)
    store.put(f.make_record("Policy", "synthetic-policy-v1", data, synthetic=synthetic))
    return store, Executor(store, [f.profile()])


def schedules(store):
    return store.db.execute("SELECT id, revision, body FROM state WHERE tenant=? AND kind='schedule'", (TENANT,)).fetchall()


def committed_events(store):
    return [json.loads(row[0]) for row in store.db.execute("SELECT body FROM audit WHERE tenant=?", (TENANT,))
            if json.loads(row[0]).get("event") == "command_committed"]


async def test_positive_interval_exact_due_time_stable_id_and_governed_command():
    """Positive interval: due_at = as-of + 30 days exactly, stable schedule id, one executor-committed state effect."""
    store, executor = build()
    try:
        result = await executor.run(f.invocation(SKILL), f.principal())
        due = "2026-12-07T12:00:00+00:00"
        assert result.status == Status.COMPLETED and result.lifecycle == "SUCCEEDED"
        assert result.payload == {"schedule_id": digest(["case-demo", "review", due])[:20], "due_at": due}
        assert result.effects_committed is True
        assert store.state(TENANT, "schedule", result.payload["schedule_id"]) == (1, {"due_at": due, "action": "review"})
        assert len(committed_events(store)) == 1
    finally:
        store.close()


@pytest.mark.parametrize("interval,as_of,due", [
    (1, f.AT, "2026-11-07T12:00:01+00:00"),
    (86400, f.AT, "2026-11-08T12:00:00+00:00"),
    (31536000, f.AT, "2027-11-07T12:00:00+00:00"),
    (2592000, datetime(2026, 12, 31, 23, 30, tzinfo=timezone.utc), "2027-01-30T23:30:00+00:00"),
])
async def test_due_time_is_exactly_as_of_plus_policy_interval(interval, as_of, due):
    """Positive interval: due time is exact relative to the invocation business time (as-of), not wall-clock time."""
    store, executor = build(policy={"review_interval_seconds": interval})
    try:
        result = await executor.run(f.invocation(SKILL, as_of_time=as_of, knowledge_cutoff=max(as_of, f.AT)), f.principal())
        assert result.payload["due_at"] == due
        assert datetime.fromisoformat(due) - as_of == timedelta(seconds=interval)
        assert result.payload["schedule_id"] == digest(["case-demo", "review", due])[:20]
    finally:
        store.close()


async def test_missing_interval_is_policy_unresolved_and_writes_nothing():
    """Missing interval: POLICY_UNRESOLVED (BLOCKED) and no schedule state is committed."""
    store, executor = build(drop=["review_interval_seconds"])
    try:
        result = await executor.run(f.invocation(SKILL), f.principal())
        assert result.lifecycle == "FAILED" and result.error.code == "POLICY_UNRESOLVED"
        assert result.status == Status.BLOCKED and result.payload == {} and result.effects_committed is False
        assert schedules(store) == [] and committed_events(store) == []
    finally:
        store.close()


@pytest.mark.parametrize("interval", [0, -86400, "2592000", 1.5, True, None])
def test_nonpositive_or_malformed_interval_cannot_be_pinned(interval):
    """Nonpositive interval: a zero/negative/non-integer review_interval_seconds is rejected at policy admission."""
    with pytest.raises(SkillError) as raised:
        f.make_record("Policy", "synthetic-policy-v1", {**f.policy(), "review_interval_seconds": interval})
    assert "review_interval_seconds" in raised.value.message


async def test_replay_same_invocation_commits_no_duplicate_effect():
    """Replay same invocation: identical result, schedule revision stays 1, exactly one committed command."""
    store, executor = build()
    try:
        invocation = f.invocation(SKILL)
        first = await executor.run(invocation, f.principal())
        again = await executor.run(invocation, f.principal())
        assert again.model_dump() == first.model_dump()
        assert [(row[0], row[1]) for row in schedules(store)] == [(first.payload["schedule_id"], 1)]
        assert len(committed_events(store)) == 1
        changed = await executor.run(f.invocation(SKILL, as_of_time=f.AT - timedelta(days=1)), f.principal())
        assert changed.lifecycle == "FAILED" and changed.error.code == "IDEMPOTENCY_CONFLICT"
        assert len(schedules(store)) == 1
    finally:
        store.close()


async def test_new_request_for_same_case_and_time_reuses_the_schedule_id():
    """Stable schedule identity: a separate request for the same case/business time targets the same schedule, not a second one."""
    store, executor = build()
    try:
        first = await executor.run(f.invocation(SKILL), f.principal())
        second = await executor.run(f.invocation(SKILL, idempotency_key="schedule-retry-2"), f.principal())
        assert second.payload == first.payload
        assert [row[0] for row in schedules(store)] == [first.payload["schedule_id"]]
    finally:
        store.close()


async def test_schedule_is_an_outstanding_handoff_not_completed_monitoring():
    """Due schedule with stopped worker: the result is only a review handoff; nothing records the review as performed."""
    store, executor = build()
    try:
        result = await executor.run(f.invocation(SKILL), f.principal())
        assert set(result.payload) == {"schedule_id", "due_at"}
        (_, _, body), = schedules(store)
        assert json.loads(body) == {"due_at": result.payload["due_at"], "action": "review"}
        kinds = {row[0] for row in store.db.execute("SELECT kind FROM state WHERE tenant=?", (TENANT,))}
        assert kinds == {"schedule"}
    finally:
        store.close()


async def test_consequential_effect_refused_on_non_synthetic_policy():
    """Effect controls: this release refuses to commit a schedule against non-synthetic (production) context."""
    store, executor = build(synthetic=False)
    try:
        result = await executor.run(f.invocation(SKILL), f.principal())
        assert result.lifecycle == "FAILED" and result.error.code == "CONTROL_FAILED"
        assert schedules(store) == []
    finally:
        store.close()


async def test_actor_without_effect_permission_is_denied():
    """Effect controls: an actor lacking effect:internal_write cannot create a schedule."""
    store, executor = build()
    try:
        principal = f.principal()
        principal = principal.model_copy(update={"permissions": principal.permissions - {"effect:internal_write"}})
        result = await executor.run(f.invocation(SKILL), principal)
        assert result.lifecycle == "FAILED" and result.error.code == "ACCESS_DENIED"
        assert schedules(store) == []
    finally:
        store.close()
