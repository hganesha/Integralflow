"""Regulatory boundary cases independent of the synthetic demonstration decisions."""
from decimal import Decimal
import pytest

from financial_crime import synthetic as f
from financial_crime.contracts import Status
from financial_crime.primitives import ofac_ownership


def edge(key, owner, owned, interest):
    return {"id": key, "owner": owner, "owned": owned, "interest": interest}


@pytest.mark.parametrize("edges,target,blocked", [
    ([edge("1", "X", "A", ".5"), edge("2", "A", "B", ".5")], "B", True),
    ([edge("1", "X", "A", ".5"), edge("2", "X", "B", ".5"), edge("3", "A", "C", ".25"), edge("4", "B", "C", ".25")], "C", True),
    ([edge("1", "X", "A", ".5"), edge("2", "X", "B", ".1"), edge("3", "A", "B", ".4")], "B", True),
    ([edge("1", "X", "A", ".5"), edge("2", "X", "B", ".25"), edge("3", "A", "C", ".25"), edge("4", "B", "C", ".25")], "C", False),
    ([edge("1", "X", "A", ".25"), edge("2", "X", "B", ".25"), edge("3", "A", "C", ".5"), edge("4", "B", "C", ".5")], "C", False),
])
def test_ofac_faq_401_examples(edges, target, blocked):
    _, blocked_entities = ofac_ownership(edges, ["X"], target)
    assert (target in blocked_entities) is blocked


def test_ofac_aggregates_different_blocked_owners_and_deduplicates_edges():
    rows = [edge("1", "X", "A", "0.3"), edge("2", "Y", "A", "0.2")]
    total, blocked = ofac_ownership(rows + rows, ["X", "Y"], "A")
    assert total == Decimal("0.5") and "A" in blocked


async def test_completed_negative_searches_are_scoped_results_not_universal_clearance(environment):
    store, executor, principal = environment
    store.db.execute("DELETE FROM records WHERE type='WatchlistEntry'")
    for entity in store.records("tenant-synthetic", "Entity"):
        store.put(f.make_record("ScreeningExecution", "search-" + entity.id, {
            "subject": entity.id, "screening_type": "sanctions", "provider": "synthetic-search",
            "query": entity.data["name"], "query_time": f.OLD.isoformat(), "status": "COMPLETED",
            "dataset_versions": ["v1"], "scope": ["synthetic-list"], "list_published_at": None,
            "candidate_count": 0, "truncated": False, "limitations": ["Scoped search only"],
        }))
    result = await executor.run(f.invocation("screening.sanctions.execute"), principal)
    assert result.status == Status.COMPLETED and result.payload["universal_clearance"] is False


async def test_one_partys_negative_search_cannot_clear_other_parties(environment):
    store, executor, principal = environment
    store.db.execute("DELETE FROM records WHERE type='WatchlistEntry'")
    store.put(f.make_record("ScreeningExecution", "search-acme", {
        "subject": "acme", "screening_type": "sanctions", "provider": "synthetic-search", "query": "Acme",
        "query_time": f.OLD.isoformat(), "status": "COMPLETED", "dataset_versions": ["v1"], "scope": ["synthetic-list"],
        "list_published_at": None, "candidate_count": 0, "truncated": False, "limitations": [],
    }))
    result = await executor.run(f.invocation("screening.sanctions.execute"), principal)
    assert result.status == Status.NEEDS_EVIDENCE


async def test_ownership_range_never_becomes_an_exact_clearance(environment):
    store, executor, principal = environment
    store.put(f.make_record("OwnershipRange", "range-1", {"owner": "bob", "owned": "acme", "lower": "0.1", "upper": "0.5", "lower_inclusive": False, "upper_inclusive": True}))
    result = await executor.run(f.invocation("ownership.interest.calculate"), principal)
    assert result.status == Status.PARTIAL
    assert any(g["reason"] == "OWNERSHIP_RANGE_REQUIRES_RESOLUTION" for g in result.payload["unresolved"])
