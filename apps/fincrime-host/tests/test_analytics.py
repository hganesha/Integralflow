from datetime import timedelta
from decimal import Decimal

from hypothesis import given, strategies as st
import pytest

from financial_crime import synthetic as f
from financial_crime.contracts import SkillError, Status
from financial_crime.primitives import dec, evaluate, ownership, total_by_currency
from test_controls import revise


def edge(key, owner, owned, interest):
    return {"id": key, "owner": owner, "owned": owned, "interest": interest}


@given(st.integers(min_value=1, max_value=99), st.integers(min_value=1, max_value=99))
def test_effective_ownership_path_products_are_exact(a, b):
    left, right = Decimal(a)/100, Decimal(b)/100
    result = ownership([edge("a", "alice", "holding", str(left)), edge("b", "holding", "acme", str(right))], "acme")
    assert dec(result["interests"]["alice"]) == left*right
    assert result["unresolved"]  # incomplete direct interests remain visible


def test_multipath_ownership_aggregates_without_double_counting():
    result = ownership([edge("1", "alice", "hold-a", "1"), edge("2", "alice", "hold-b", "1"), edge("3", "hold-a", "acme", "0.4"), edge("4", "hold-b", "acme", "0.6")], "acme")
    assert result["interests"] == {"alice": "1.0"}
    assert len(result["paths"]) == 2 and not result["unresolved"]


def test_circular_and_excess_ownership_are_explicit():
    circular = ownership([edge("1", "a", "b", "1"), edge("2", "b", "a", "1")], "a")
    assert circular["cycles"] and circular["unresolved"]
    with pytest.raises(SkillError, match="exceeds"):
        ownership([edge("1", "a", "target", "0.7"), edge("2", "b", "target", "0.6")], "target")


@given(st.integers(min_value=-100000, max_value=100000), st.integers(min_value=-100000, max_value=100000))
def test_currency_aggregation_is_exact_and_duplicate_safe(a, b):
    rows = [{"id": "1", "amount": str(Decimal(a)/100), "currency": "SYN"}, {"id": "2", "amount": str(Decimal(b)/100), "currency": "SYN"}]
    result = total_by_currency(rows+[rows[0]])
    assert dec(result["SYN"]) == (Decimal(a)+Decimal(b))/100


def test_reversals_and_currencies_are_not_silently_mixed():
    rows = [{"id": "a", "amount": "0.1", "currency": "AAA"}, {"id": "b", "amount": "0.2", "currency": "AAA"}, {"id": "c", "amount": "1", "currency": "BBB"}, {"id": "d", "amount": "99", "currency": "AAA", "status": "reversed"}]
    assert total_by_currency(rows) == {"AAA": "0.3", "BBB": "1"}


def test_conflicting_duplicate_events_fail():
    with pytest.raises(SkillError, match="conflicting"):
        total_by_currency([{"id": "x", "amount": "1", "currency": "SYN"}, {"id": "x", "amount": "2", "currency": "SYN"}])


@pytest.mark.parametrize("value", [True, 0.1, "NaN", "Infinity", "bad"])
def test_unsafe_financial_values_rejected(value):
    with pytest.raises(SkillError):
        dec(value)


@pytest.mark.parametrize("predicate,outcome", [
    ({"all": [{"field": "missing", "op": "eq", "value": True}, {"field": "yes", "op": "eq", "value": True}]}, "UNKNOWN"),
    ({"any": [{"field": "missing", "op": "eq", "value": True}, {"field": "yes", "op": "eq", "value": True}]}, "PASS"),
    ({"all": [{"field": "missing", "op": "eq", "value": True}, {"field": "yes", "op": "eq", "value": False}]}, "FAIL"),
])
def test_three_valued_rule_composition(predicate, outcome):
    assert evaluate(predicate, {"yes": True}) == outcome


async def test_weighted_risk_and_residual_math(environment):
    _, executor, principal = environment
    risk = await executor.run(f.invocation("risk.customer.assess"), principal)
    assert risk.payload["assessment"]["score"] == "0.26"
    assert risk.payload["tier"] == "LOW"
    residual = await executor.run(f.invocation("risk.residual.calculate"), principal)
    assert residual.payload["residual_score"] == "0.30"


async def test_missing_risk_factor_is_unknown_not_zero(environment):
    store, executor, principal = environment
    store.db.execute("DELETE FROM records WHERE type='RiskFactor' AND id='risk-product'")
    risk = await executor.run(f.invocation("risk.customer.assess"), principal)
    assert risk.status == Status.NEEDS_EVIDENCE
    assert risk.payload["assessment"]["score"] is None and risk.payload["tier"] == "UNKNOWN"


async def test_partial_dataset_cannot_produce_detection_clearance(environment):
    store, executor, principal = environment
    revise(store, "DatasetScope", "dataset-1", {"complete": False})
    result = await executor.run(f.invocation("aml.structuring.detect"), principal)
    assert result.status == Status.NEEDS_EVIDENCE


async def test_window_counts_must_match_declared_scope(environment):
    store, executor, principal = environment
    revise(store, "DatasetScope", "dataset-1", {"expected_count": 4})
    result = await executor.run(f.invocation("transaction.ingest"), principal)
    assert result.error["code"] == "EVIDENCE_INSUFFICIENT"


async def test_typology_positive_and_benign_controls(environment):
    store, executor, principal = environment
    result = await executor.run(f.invocation("aml.structuring.detect"), principal)
    assert result.payload["indicators"][0]["transaction_ids"] == ["tx-1", "tx-2"]
    assert result.payload["not_proof"] is True
    policy = f.policy()
    policy["aml_detectors"]["structuring"]["amount_threshold"] = "1000"
    revise(store, "Policy", "synthetic-policy-v1", policy)
    benign = await executor.run(f.invocation("aml.structuring.detect", idempotency_key="benign"), principal)
    assert benign.payload["indicators"] == []


async def test_trade_discrepancy_and_network_paths(environment):
    _, executor, principal = environment
    trade = await executor.run(f.invocation("aml.trade_based.detect"), principal)
    assert trade.payload["indicators"][0]["reason"] == "QUANTITY_MISMATCH"
    network = await executor.run(f.invocation("network.path.find"), principal)
    assert network.payload["paths"] == [["acct-a", "acct-b", "acct-c"]]
    propagation = await executor.run(f.invocation("network.risk.propagate"), principal)
    assert {x["target"]: x["contribution"] for x in propagation.payload["exposures"]} == {"acct-b": "0.40", "acct-c": "0.200"}


async def test_synthetic_reporting_calendar_and_legal_holds(environment):
    store, executor, principal = environment
    deadline = await executor.run(f.invocation("regulatory.deadline.calculate", parameters={"event_at": "2026-11-06T00:00:00+00:00", "report_type": "CTR"}), principal)
    assert deadline.payload["deadline"] == "2026-11-11T00:00:00+00:00"
    revise(store, "RetentionRule", "retention-1", {"retain_until": f.START, "legal_hold": True})
    retention = await executor.run(f.invocation("evidence.retention.enforce"), principal)
    assert retention.payload["held"] == ["evidence-1"] and retention.payload["deletion_candidates"] == []

