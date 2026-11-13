"""Acceptance tests for registry.company.verify (legal-existence check in the KYB process).

Legal status is verified only for a policy-active status under complete registry coverage.
Exact payloads and every fail-closed case are asserted; known defects are strict xfails.
"""
import pytest

from financial_crime import synthetic as f
from financial_crime.contracts import SkillError, Status
from financial_crime.execution import Executor
from financial_crime.store import Store

SKILL = "registry.company.verify"
COVERAGE = {"complete": True, "jurisdictions": ["synthetic-neutral"], "as_of": f.OLD.isoformat(), "limitations": ["synthetic test source only"]}


def build(records, *, policy=None, drop=()):
    store = Store()
    data = f.policy()
    data.update(policy or {})
    for key in drop:
        data.pop(key)
    store.put(f.make_record("Policy", "synthetic-policy-v1", data))
    for object_type, object_id, payload in records:
        store.put(f.make_record(object_type, object_id, payload))
    return store, Executor(store, [f.profile()])


async def run(records, **kwargs):
    store, executor = build(records, **kwargs)
    try:
        return await executor.run(f.invocation(SKILL), f.principal())
    finally:
        store.close()


def registry(key, registration_id="SYN-0001", status="ACTIVE", coverage=COVERAGE):
    return ("RegistryRecord", key, {"name": "Acme", "registration_id": registration_id, "status": status, "coverage": coverage})


def assert_failed(result, code, status):
    assert result.lifecycle == "FAILED"
    assert result.error is not None and result.error.code == code
    assert result.status == status
    assert result.payload == {}


async def test_active_status_with_complete_coverage_is_verified():
    """Normal input: an ACTIVE (policy-active) status under complete coverage is verified, with its source record."""
    result = await run([registry("registry-1")])
    assert result.status == Status.COMPLETED
    assert result.payload == {"verifications": [{"id": "SYN-0001", "verified": True, "status": "ACTIVE"}]}
    assert ("RegistryRecord", "registry-1", "v1") in {(r.object_type, r.object_id, r.version_id) for r in result.evidence_refs}


@pytest.mark.parametrize("record,status", [
    pytest.param(registry("r-1", status="DISSOLVED"), "DISSOLVED", id="dissolved"),
    pytest.param(registry("r-1", status="PENDING"), "PENDING", id="pending"),
    pytest.param(registry("r-1", status="active"), "active", id="case-variant-not-mapped"),
    pytest.param(registry("r-1", coverage={**COVERAGE, "complete": False}), "ACTIVE", id="incomplete-coverage"),
])
async def test_inactive_status_or_incomplete_coverage_is_not_verified(record, status):
    """Source gaps: inactive/unmapped status or incomplete coverage is never verified; the captured status is preserved."""
    result = await run([record])
    assert result.payload == {"verifications": [{"id": "SYN-0001", "verified": False, "status": status}]}


async def test_each_registration_is_verified_independently():
    """Multiple registrations: each captured registration keeps its own status and verification outcome."""
    result = await run([registry("r-1"), registry("r-2", "SYN-0002", "DISSOLVED"), registry("r-3", "SYN-0003", coverage={**COVERAGE, "complete": False})])
    assert result.payload == {"verifications": [
        {"id": "SYN-0001", "verified": True, "status": "ACTIVE"},
        {"id": "SYN-0002", "verified": False, "status": "DISSOLVED"},
        {"id": "SYN-0003", "verified": False, "status": "ACTIVE"}]}


async def test_without_policy_active_statuses_nothing_is_verified():
    """Unknown policy: with no approved active_registry_statuses no status is assumed active."""
    result = await run([registry("r-1")], drop=["active_registry_statuses"])
    assert result.payload == {"verifications": [{"id": "SYN-0001", "verified": False, "status": "ACTIVE"}]}


async def test_conflicting_statuses_for_one_registration_are_not_a_clean_pass():
    """Conflicting statuses: ACTIVE vs DISSOLVED for the same registration must not produce a clean verified result."""
    result = await run([registry("r-1"), registry("r-2", status="DISSOLVED")])
    assert not (result.status == Status.COMPLETED and any(v["verified"] for v in result.payload["verifications"]))


async def test_conflicting_statuses_for_one_registration_are_a_source_conflict():
    """Conflicting statuses: ACTIVE and DISSOLVED for SYN-0001 verify nothing; NEEDS_REVIEW with a SOURCE_CONFLICT item."""
    result = await run([registry("r-1"), registry("r-2", status="DISSOLVED")])
    assert result.status == Status.NEEDS_REVIEW
    assert result.payload == {"verifications": [{"id": "SYN-0001", "verified": False, "status": "ACTIVE"},
                                                {"id": "SYN-0001", "verified": False, "status": "DISSOLVED"}]}
    assert [(i.code, i.subject_ref) for i in result.unresolved_items] == [("SOURCE_CONFLICT", "SYN-0001")]


def test_coverage_without_completeness_flag_cannot_be_admitted():
    """Unsupported input: coverage must state completeness explicitly; it cannot default to complete."""
    with pytest.raises(SkillError) as raised:
        f.make_record(*registry("r-1", coverage={"jurisdictions": ["synthetic-neutral"]}))
    assert raised.value.code == "CONTEXT_INVALID"


async def test_missing_registry_record_is_context_missing():
    """Missing evidence: without a RegistryRecord the executor returns CONTEXT_MISSING, never a verification."""
    other = ("GeographyExposure", "g-1", {"country": "SYN", "basis": "domicile", "value": "1"})
    assert_failed(await run([other]), "CONTEXT_MISSING", Status.NEEDS_EVIDENCE)


async def test_stale_registry_record_is_context_stale():
    """Freshness: a registry capture older than the pinned freshness window is CONTEXT_STALE."""
    policy = {"freshness_seconds": {**f.policy()["freshness_seconds"], "RegistryRecord": 3600}}
    assert_failed(await run([registry("r-1")], policy=policy), "CONTEXT_STALE", Status.NEEDS_EVIDENCE)


async def test_retry_is_idempotent_and_changed_request_cannot_reuse_key():
    """Changed basis or retry: the same invocation replays the stored result; a changed request with the old key is refused."""
    store, executor = build([registry("r-1")])
    try:
        invocation = f.invocation(SKILL)
        first = await executor.run(invocation, f.principal())
        again = await executor.run(invocation, f.principal())
        assert again.model_dump() == first.model_dump()
        changed = await executor.run(f.invocation(SKILL, purpose="review"), f.principal())
        assert changed.lifecycle == "FAILED" and changed.error.code == "IDEMPOTENCY_CONFLICT"
    finally:
        store.close()
