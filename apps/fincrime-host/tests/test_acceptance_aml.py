"""Acceptance tests for the aml.* typology skills.

Each test names the "Examples and acceptance" bullet it encodes in skill-content/skills/<id>.md.
A detector runs only on a pinned rule with every parameter it uses stated; amounts are exact
decimals and windows exact instants; cancelled and reversed records never count; and a window the
dataset scope cuts off that found nothing is PARTIAL, never a clear "no typology".
"""
import pytest

from financial_crime import synthetic as f
from financial_crime.contracts import SkillError, Status, digest
from financial_crime.execution import Executor
from financial_crime.store import Store

TENANT = "tenant-synthetic"
POLICY_ID = "synthetic-policy-v1"
CASE = "case-demo"
RULE = {"amount_threshold": "100", "currency": "SYN", "minimum_count": 2, "window_seconds": 86400, "max_hops": 4, "throughput_ratio": "0.8"}
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


def tx(tx_id, source, target, amount, at, currency="SYN", status="settled"):
    return ("Transaction", tx_id, {"source": source, "target": target, "amount": amount, "currency": currency, "timestamp": at,
                                   "event_id": "event-" + tx_id, "status": status})


def dataset(*transactions, complete=True):
    """Exactly these transactions, inside the seeded complete scope 2026-11-01 to 2026-11-07 (UTC)."""
    return {"without": ("Transaction", "DatasetScope"), "extra": [*transactions, ("DatasetScope", "dataset-1", {
        "start": f.START, "end": f.END, "watermark": f.END, "complete": complete, "expected_count": len(transactions)})]}


def rule(kind, **changes):
    """The synthetic detector pack with one kind's rule changed (a None value removes the key)."""
    detectors = f.policy()["aml_detectors"]
    detectors[kind] = {k: v for k, v in {**detectors[kind], **changes}.items() if v is not None}
    return {"aml_detectors": detectors}


def day(hour, date="2026-11-02"):
    return f"{date}T{hour:02d}:00:00+00:00"


# --------------------------------------------------------------------------- aml.structuring.detect

async def test_structuring_normal(build):
    """Normal: tx-1 and tx-2 (60 each, acct-a, one hour apart) -> one indicator for acct-a, total 120; COMPLETED."""
    _, executor, principal = build()
    result = await run(executor, principal, "aml.structuring.detect")
    assert result.status == Status.COMPLETED
    assert result.payload == {"indicators": [{"account": "acct-a", "currency": "SYN", "transaction_ids": ["tx-1", "tx-2"], "total": "120", "kind": "structuring"}], "not_proof": True}


async def test_structuring_threshold_boundary(build):
    """Boundary: 99.99 + 0.01 reach the threshold exactly -> an indicator, total 100.00; a payment of exactly 100
    is not below the threshold and is not counted, so 100 + 60 -> no indicator."""
    _, executor, principal = build(**dataset(tx("s-1", "acct-a", "acct-b", "99.99", day(1)), tx("s-2", "acct-a", "acct-b", "0.01", day(2))))
    result = await run(executor, principal, "aml.structuring.detect")
    assert result.status == Status.COMPLETED
    assert result.payload["indicators"] == [{"account": "acct-a", "currency": "SYN", "transaction_ids": ["s-1", "s-2"], "total": "100.00", "kind": "structuring"}]
    _, executor, principal = build(**dataset(tx("s-1", "acct-a", "acct-b", "100", day(1)), tx("s-2", "acct-a", "acct-b", "60", day(2))))
    result = await run(executor, principal, "aml.structuring.detect")
    assert result.status == Status.COMPLETED and result.payload["indicators"] == []


async def test_structuring_window_is_half_open(build):
    """Window: two 60 payments exactly 86400 seconds apart are not in one window -> no indicator; COMPLETED."""
    _, executor, principal = build(**dataset(tx("s-1", "acct-a", "acct-b", "60", day(0, "2026-11-03")), tx("s-2", "acct-a", "acct-b", "60", day(0, "2026-11-04"))))
    result = await run(executor, principal, "aml.structuring.detect")
    assert result.status == Status.COMPLETED and result.payload["indicators"] == []


async def test_structuring_reversed_does_not_count(build):
    """Reversed: with tx-2 reversed only tx-1 counts -> no indicator; COMPLETED."""
    _, executor, principal = build(**dataset(tx("tx-1", "acct-a", "acct-b", "60", day(1)), tx("tx-2", "acct-a", "acct-b", "60", day(2), status="reversed")))
    result = await run(executor, principal, "aml.structuring.detect")
    assert result.status == Status.COMPLETED and result.payload["indicators"] == []


async def test_structuring_window_cut_off_by_scope(build):
    """Cut-off window: a lone 60 payment at 2026-11-01T05:00, whose 24-hour look-back starts before the scope ->
    no indicator, PARTIAL with EVIDENCE_INSUFFICIENT for it."""
    _, executor, principal = build(**dataset(tx("s-1", "acct-a", "acct-b", "60", day(5, "2026-11-01"))))
    result = await run(executor, principal, "aml.structuring.detect")
    assert result.payload["indicators"] == []
    assert result.status == Status.PARTIAL and items(result) == [("EVIDENCE_INSUFFICIENT", "s-1")]


async def test_structuring_threshold_currency(build):
    """Threshold currency: with the rule stated in XYZ, the seeded SYN payments are not evaluated (no SYN rate is
    assumed) -> no indicator, PARTIAL with POLICY_UNRESOLVED for SYN. A rule with no currency is refused when the
    policy is admitted."""
    _, executor, principal = build(policy=rule("structuring", currency="XYZ"))
    result = await run(executor, principal, "aml.structuring.detect")
    assert result.payload["indicators"] == []
    assert result.status == Status.PARTIAL and items(result) == [("POLICY_UNRESOLVED", "SYN")]
    with pytest.raises(SkillError, match="aml_detectors.structuring: failed required"):
        build(policy=rule("structuring", currency=None))


async def test_structuring_policy_and_scope_gaps(build):
    """Policy unresolved: no structuring rule, or no aml_detectors at all -> POLICY_UNRESOLVED / BLOCKED.
    Incomplete scope: DatasetScope complete false -> EVIDENCE_INSUFFICIENT / NEEDS_EVIDENCE."""
    detectors = {k: v for k, v in f.policy()["aml_detectors"].items() if k != "structuring"}
    _, executor, principal = build(policy={"aml_detectors": detectors})
    failed(await run(executor, principal, "aml.structuring.detect"), "POLICY_UNRESOLVED", Status.BLOCKED)
    _, executor, principal = build(drop=["aml_detectors"])
    failed(await run(executor, principal, "aml.structuring.detect"), "POLICY_UNRESOLVED", Status.BLOCKED)
    _, executor, principal = build(**dataset(tx("tx-1", "acct-a", "acct-b", "60", day(1)), complete=False))
    failed(await run(executor, principal, "aml.structuring.detect"), "EVIDENCE_INSUFFICIENT", Status.NEEDS_EVIDENCE)


# ----------------------------------------------------------------------------- aml.smurfing.detect

async def test_smurfing_normal_and_single_depositor(build):
    """Normal: acct-c (60) and acct-d (50) both pay acct-b within a day -> one indicator for acct-b, total 110.
    One depositor: the seeded tx-1 and tx-2 both come from acct-a -> no indicator; COMPLETED."""
    _, executor, principal = build(**dataset(tx("m-1", "acct-c", "acct-b", "60", day(1)), tx("m-2", "acct-d", "acct-b", "50", day(2))))
    result = await run(executor, principal, "aml.smurfing.detect")
    assert result.status == Status.COMPLETED
    assert result.payload["indicators"] == [{"account": "acct-b", "currency": "SYN", "transaction_ids": ["m-1", "m-2"], "total": "110", "kind": "smurfing"}]
    _, executor, principal = build()
    result = await run(executor, principal, "aml.smurfing.detect")
    assert result.status == Status.COMPLETED and result.payload["indicators"] == []


async def test_smurfing_currencies_are_not_mixed(build):
    """Currencies: the threshold is stated in SYN, so 50 XYZ is neither summed with 60 SYN nor compared with 100 in
    its own units -> no indicator, PARTIAL with POLICY_UNRESOLVED for XYZ (1 transaction not evaluated)."""
    _, executor, principal = build(**dataset(tx("m-1", "acct-c", "acct-b", "60", day(1)), tx("m-2", "acct-d", "acct-b", "50", day(2), currency="XYZ")))
    result = await run(executor, principal, "aml.smurfing.detect")
    assert result.payload["indicators"] == []
    assert result.status == Status.PARTIAL and items(result) == [("POLICY_UNRESOLVED", "XYZ")]


async def test_smurfing_without_rule(build):
    """Policy unresolved: no smurfing rule in aml_detectors -> POLICY_UNRESOLVED / BLOCKED."""
    _, executor, principal = build(policy={"aml_detectors": {k: v for k, v in f.policy()["aml_detectors"].items() if k != "smurfing"}})
    failed(await run(executor, principal, "aml.smurfing.detect"), "POLICY_UNRESOLVED", Status.BLOCKED)


# ------------------------------------------------------------------------------- aml.funnel.detect

async def test_funnel_normal_and_seeded(build):
    """Normal: acct-c (500) and acct-d (700) pay acct-b within a day -> one indicator, total 1200 (funnel counts
    payments at any amount). Seeded: one payer per receiving account -> no indicator; COMPLETED."""
    _, executor, principal = build(**dataset(tx("u-1", "acct-c", "acct-b", "500", day(1)), tx("u-2", "acct-d", "acct-b", "700", day(2))))
    result = await run(executor, principal, "aml.funnel.detect")
    assert result.status == Status.COMPLETED
    assert result.payload["indicators"] == [{"account": "acct-b", "currency": "SYN", "transaction_ids": ["u-1", "u-2"], "total": "1200", "kind": "funnel"}]
    _, executor, principal = build()
    result = await run(executor, principal, "aml.funnel.detect")
    assert result.status == Status.COMPLETED and result.payload["indicators"] == []


async def test_funnel_cancelled_payment_does_not_count(build):
    """Cancelled: with u-2 cancelled acct-b has one payer -> no indicator; COMPLETED."""
    _, executor, principal = build(**dataset(tx("u-1", "acct-c", "acct-b", "500", day(1)), tx("u-2", "acct-d", "acct-b", "700", day(2), status="cancelled")))
    result = await run(executor, principal, "aml.funnel.detect")
    assert result.status == Status.COMPLETED and result.payload["indicators"] == []


# ----------------------------------------------------------------------------- aml.velocity.detect

async def test_velocity_normal(build):
    """Normal: acct-a sends tx-1 and tx-2 within a day -> one indicator for acct-a, total 120; COMPLETED."""
    _, executor, principal = build()
    result = await run(executor, principal, "aml.velocity.detect")
    assert result.status == Status.COMPLETED
    assert result.payload["indicators"] == [{"account": "acct-a", "currency": "SYN", "transaction_ids": ["tx-1", "tx-2"], "total": "120", "kind": "velocity"}]


async def test_velocity_offsets_compare_as_instants(build):
    """Instants: 2026-11-02T23:00+00:00 and 2026-11-03T08:00+09:00 are the same instant, inside one window ->
    one indicator; COMPLETED."""
    _, executor, principal = build(**dataset(tx("v-1", "acct-a", "acct-b", "5", day(23)), tx("v-2", "acct-a", "acct-b", "5", "2026-11-03T08:00:00+09:00")))
    result = await run(executor, principal, "aml.velocity.detect")
    assert result.status == Status.COMPLETED
    assert [x["transaction_ids"] for x in result.payload["indicators"]] == [["v-1", "v-2"]]


async def test_velocity_window_cut_off_by_scope(build):
    """Cut-off window: one payment at 2026-11-01T02:00 -> no indicator, PARTIAL with EVIDENCE_INSUFFICIENT for it."""
    _, executor, principal = build(**dataset(tx("v-1", "acct-a", "acct-b", "5", day(2, "2026-11-01"))))
    result = await run(executor, principal, "aml.velocity.detect")
    assert result.payload["indicators"] == [] and result.status == Status.PARTIAL and items(result) == [("EVIDENCE_INSUFFICIENT", "v-1")]


# ------------------------------------------------------------------------- aml.pass_through.detect

THROUGH = (tx("p-1", "acct-x", "acct-m", "100", day(1)), tx("p-2", "acct-m", "acct-y", "50", day(2)), tx("p-3", "acct-m", "acct-z", "40", day(3)))


async def test_pass_through_normal_and_seeded(build):
    """Normal: acct-m receives 100 (p-1) and sends 50 and 40 within a day (90 >= 0.8 x 100, two payments) -> one
    indicator [p-1, p-2, p-3], allocation temporal_aggregate_indicator. Seeded: acct-b passes on one payment -> none."""
    _, executor, principal = build(**dataset(*THROUGH))
    result = await run(executor, principal, "aml.pass_through.detect")
    assert result.status == Status.COMPLETED
    assert result.payload["indicators"] == [{"account": "acct-m", "currency": "SYN", "transaction_ids": ["p-1", "p-2", "p-3"], "kind": "pass_through", "allocation": "temporal_aggregate_indicator"}]
    _, executor, principal = build()
    result = await run(executor, principal, "aml.pass_through.detect")
    assert result.status == Status.COMPLETED and result.payload["indicators"] == []


async def test_pass_through_window_cut_off_by_scope(build):
    """Cut-off window: 100 received at 2026-11-06T12:00 with nothing sent on; its 24-hour window passes the scope end
    -> no indicator, PARTIAL with EVIDENCE_INSUFFICIENT for that payment."""
    _, executor, principal = build(**dataset(tx("p-1", "acct-x", "acct-m", "100", day(12, "2026-11-06"))))
    result = await run(executor, principal, "aml.pass_through.detect")
    assert result.payload["indicators"] == [] and result.status == Status.PARTIAL and items(result) == [("EVIDENCE_INSUFFICIENT", "p-1")]


async def test_pass_through_without_ratio(build):
    """Policy unresolved: the rule states no throughput_ratio -> POLICY_UNRESOLVED / BLOCKED (no 0.8 default)."""
    _, executor, principal = build(policy=rule("pass_through", throughput_ratio=None))
    failed(await run(executor, principal, "aml.pass_through.detect"), "POLICY_UNRESOLVED", Status.BLOCKED)


# ------------------------------------------------------------------------------- aml.mule.detect

async def test_mule_ratio_boundary(build):
    """Boundary: 100 in, 50 + 30 out (80 = 0.8 x 100) -> an indicator; 50 + 29.99 out -> none; COMPLETED."""
    def flows(second):
        return dataset(tx("p-1", "acct-x", "acct-m", "100", day(1)), tx("p-2", "acct-m", "acct-y", "50", day(2)), tx("p-3", "acct-m", "acct-z", second, day(3)))
    _, executor, principal = build(**flows("30"))
    result = await run(executor, principal, "aml.mule.detect")
    assert result.status == Status.COMPLETED
    assert result.payload["indicators"] == [{"account": "acct-m", "currency": "SYN", "transaction_ids": ["p-1", "p-2", "p-3"], "kind": "mule", "allocation": "temporal_aggregate_indicator"}]
    _, executor, principal = build(**flows("29.99"))
    result = await run(executor, principal, "aml.mule.detect")
    assert result.status == Status.COMPLETED and result.payload["indicators"] == []


async def test_mule_reversed_outflow_does_not_count(build):
    """Reversed: with p-3 reversed only 50 of 100 moved on -> no indicator; COMPLETED."""
    _, executor, principal = build(**dataset(*THROUGH[:2], tx("p-3", "acct-m", "acct-z", "40", day(3), status="reversed")))
    result = await run(executor, principal, "aml.mule.detect")
    assert result.status == Status.COMPLETED and result.payload["indicators"] == []


async def test_mule_without_ratio(build):
    """Policy unresolved: the mule rule states no throughput_ratio -> POLICY_UNRESOLVED / BLOCKED."""
    _, executor, principal = build(policy=rule("mule", throughput_ratio=None))
    failed(await run(executor, principal, "aml.mule.detect"), "POLICY_UNRESOLVED", Status.BLOCKED)


# ---------------------------------------------------------------------------- aml.roundtrip.detect

async def test_roundtrip_normal(build):
    """Normal: acct-a pays acct-b (tx-1, tx-2) and acct-b pays acct-a back (tx-3) -> [tx-2, tx-3] and [tx-1, tx-3]; COMPLETED."""
    _, executor, principal = build()
    result = await run(executor, principal, "aml.roundtrip.detect")
    assert result.status == Status.COMPLETED
    assert result.payload["indicators"] == [{"transaction_ids": ["tx-2", "tx-3"], "kind": "roundtrip", "currency": "SYN"},
                                            {"transaction_ids": ["tx-1", "tx-3"], "kind": "roundtrip", "currency": "SYN"}]


async def test_roundtrip_orders_by_instant_not_text(build):
    """Instants: r-1 acct-a to acct-b at 2026-11-02T10:00+00:00 and r-2 back at 2026-11-02T12:00+05:00 (07:00 UTC, earlier)
    -> the cycle is acct-b to acct-a to acct-b, [r-2, r-1]; never [r-1, r-2]."""
    _, executor, principal = build(**dataset(tx("r-1", "acct-a", "acct-b", "100", day(10)), tx("r-2", "acct-b", "acct-a", "100", "2026-11-02T12:00:00+05:00")))
    result = await run(executor, principal, "aml.roundtrip.detect")
    assert result.status == Status.COMPLETED
    assert result.payload["indicators"] == [{"transaction_ids": ["r-2", "r-1"], "kind": "roundtrip", "currency": "SYN"}]


async def test_roundtrip_without_max_hops(build):
    """Policy unresolved: the rule states no max_hops -> POLICY_UNRESOLVED / BLOCKED (no 5-hop default)."""
    _, executor, principal = build(policy=rule("roundtrip", max_hops=None))
    failed(await run(executor, principal, "aml.roundtrip.detect"), "POLICY_UNRESOLVED", Status.BLOCKED)


# ----------------------------------------------------------------------------- aml.layering.detect

CHAIN = (tx("l-1", "acct-a", "acct-b", "100", day(1)), tx("l-2", "acct-b", "acct-c", "95", day(2)), tx("l-3", "acct-c", "acct-d", "90", day(3)))


async def test_layering_chain(build):
    """Normal: a to b to c to d one hour apart with minimum_count 3 -> one path [l-1, l-2, l-3]; with max_hops 2 the
    three-hop path is not built -> none; COMPLETED."""
    _, executor, principal = build(**dataset(*CHAIN), policy=rule("layering", minimum_count=3))
    result = await run(executor, principal, "aml.layering.detect")
    assert result.status == Status.COMPLETED
    assert result.payload["indicators"] == [{"transaction_ids": ["l-1", "l-2", "l-3"], "kind": "layering", "currency": "SYN"}]
    _, executor, principal = build(**dataset(*CHAIN), policy=rule("layering", minimum_count=3, max_hops=2))
    result = await run(executor, principal, "aml.layering.detect")
    assert result.status == Status.COMPLETED and result.payload["indicators"] == []


async def test_layering_currency_change_breaks_the_path(build):
    """Currencies: l-2 in XYZ -> no SYN path of three hops; COMPLETED."""
    _, executor, principal = build(**dataset(CHAIN[0], tx("l-2", "acct-b", "acct-c", "95", day(2), currency="XYZ"), CHAIN[2]), policy=rule("layering", minimum_count=3))
    result = await run(executor, principal, "aml.layering.detect")
    assert result.status == Status.COMPLETED and result.payload["indicators"] == []


async def test_layering_window_cut_off_by_scope(build):
    """Cut-off window: one hop at 2026-11-06T20:00 whose onward window passes the scope end -> PARTIAL with
    EVIDENCE_INSUFFICIENT for it; without max_hops -> POLICY_UNRESOLVED / BLOCKED."""
    _, executor, principal = build(**dataset(tx("l-1", "acct-a", "acct-b", "100", day(20, "2026-11-06"))))
    result = await run(executor, principal, "aml.layering.detect")
    assert result.payload["indicators"] == [] and result.status == Status.PARTIAL and items(result) == [("EVIDENCE_INSUFFICIENT", "l-1")]
    _, executor, principal = build(policy=rule("layering", max_hops=None))
    failed(await run(executor, principal, "aml.layering.detect"), "POLICY_UNRESOLVED", Status.BLOCKED)


# -------------------------------------------------------------------------- aml.trade_based.detect

async def test_trade_based_normal(build):
    """Normal: invoice-1 quantity 10, shipment-1 quantity 9 -> QUANTITY_MISMATCH for trade-1; COMPLETED."""
    _, executor, principal = build()
    result = await run(executor, principal, "aml.trade_based.detect")
    assert result.status == Status.COMPLETED
    assert result.payload == {"indicators": [{"trade_id": "trade-1", "invoice_id": "invoice-1", "shipment_id": "shipment-1", "reason": "QUANTITY_MISMATCH"}], "not_proof": True}


async def test_trade_based_exact_decimal_match(build):
    """Exact decimals: shipment quantity 10.00 against invoice quantity 10 -> no indicator; COMPLETED."""
    _, executor, principal = build(without=("Shipment",), extra=[("Shipment", "shipment-1", {"quantity": "10.00"})])
    result = await run(executor, principal, "aml.trade_based.detect")
    assert result.status == Status.COMPLETED and result.payload["indicators"] == []


async def test_trade_based_unlinked_trade(build):
    """Missing evidence: trade-2 links shipment-9, which is not admitted -> trade-1's indicator is kept, NEEDS_EVIDENCE
    with EVIDENCE_INSUFFICIENT for trade-2."""
    _, executor, principal = build(extra=[("TradeRecord", "trade-2", {"invoice_id": "invoice-1", "shipment_id": "shipment-9"})])
    result = await run(executor, principal, "aml.trade_based.detect")
    assert [x["trade_id"] for x in result.payload["indicators"]] == ["trade-1"]
    assert result.status == Status.NEEDS_EVIDENCE and items(result) == [("EVIDENCE_INSUFFICIENT", "trade-2")]


# ------------------------------------------------------------------------ aml.shell_company.detect

def party(party_id, profile):
    return ("Party", party_id, {"entity_id": "acme", "role": "customer", "customer_type": "corporate", "industry": "SYN-TECH", "profile": profile})


async def test_shell_company_normal(build):
    """Normal: party-1 states business_purpose and employees -> no indicator; party-2 without employees ->
    [{party_id: party-2, missing: [employees]}]; COMPLETED."""
    _, executor, principal = build()
    result = await run(executor, principal, "aml.shell_company.detect")
    assert result.status == Status.COMPLETED and result.payload == {"indicators": [], "not_proof": True}
    _, executor, principal = build(extra=[party("party-2", {"legal_name": "Shell", "business_purpose": "holding"})])
    result = await run(executor, principal, "aml.shell_company.detect")
    assert result.status == Status.COMPLETED and result.payload["indicators"] == [{"party_id": "party-2", "missing": ["employees"]}]


async def test_shell_company_without_substance_fields(build):
    """Policy unresolved: no business_substance_fields, or an empty list -> POLICY_UNRESOLVED / BLOCKED."""
    _, executor, principal = build(drop=["business_substance_fields"])
    failed(await run(executor, principal, "aml.shell_company.detect"), "POLICY_UNRESOLVED", Status.BLOCKED)
    _, executor, principal = build(policy={"business_substance_fields": []})
    failed(await run(executor, principal, "aml.shell_company.detect"), "POLICY_UNRESOLVED", Status.BLOCKED)


async def test_shell_company_incomplete_registry_coverage(build):
    """Missing evidence: registry-1 states coverage complete false -> no indicator, NEEDS_EVIDENCE with
    EVIDENCE_INSUFFICIENT for registry-1."""
    registry = {"name": "Acme", "registration_id": "SYN-0001", "status": "ACTIVE", "coverage": {**COVERAGE, "complete": False},
                "address": "1 Test Street", "attributes": {"name": "Acme", "status": "ACTIVE"}}
    _, executor, principal = build(without=("RegistryRecord",), extra=[("RegistryRecord", "registry-1", registry)])
    result = await run(executor, principal, "aml.shell_company.detect")
    assert result.payload["indicators"] == []
    assert result.status == Status.NEEDS_EVIDENCE and items(result) == [("EVIDENCE_INSUFFICIENT", "registry-1")]


# ---------------------------------------------------------------------------- aml.typology.match

async def test_typology_match_normal(build):
    """Normal: all eight pinned kinds are evaluated in name order; structuring finds [tx-1, tx-2]; COMPLETED."""
    _, executor, principal = build()
    result = await run(executor, principal, "aml.typology.match")
    assert result.status == Status.COMPLETED
    typologies = {x["typology"]: x["indicators"] for x in result.payload["typologies"]}
    assert list(typologies) == ["funnel", "layering", "mule", "pass_through", "roundtrip", "smurfing", "structuring", "velocity"]
    assert [x["transaction_ids"] for x in typologies["structuring"]] == [["tx-1", "tx-2"]]
    assert typologies["funnel"] == typologies["smurfing"] == []


async def test_typology_match_without_detectors(build):
    """Policy unresolved: aml_detectors {} or absent -> POLICY_UNRESOLVED / BLOCKED, never "no typology";
    an unsupported kind -> POLICY_UNRESOLVED / BLOCKED."""
    _, executor, principal = build(policy={"aml_detectors": {}})
    failed(await run(executor, principal, "aml.typology.match"), "POLICY_UNRESOLVED", Status.BLOCKED)
    _, executor, principal = build(drop=["aml_detectors"])
    failed(await run(executor, principal, "aml.typology.match"), "POLICY_UNRESOLVED", Status.BLOCKED)
    _, executor, principal = build(policy={"aml_detectors": {"cuckoo": RULE}})
    failed(await run(executor, principal, "aml.typology.match"), "POLICY_UNRESOLVED", Status.BLOCKED)


async def test_typology_match_window_cut_off_by_scope(build):
    """Cut-off window: only a structuring rule and a lone payment at 2026-11-01T05:00 -> PARTIAL with
    EVIDENCE_INSUFFICIENT for it."""
    _, executor, principal = build(**dataset(tx("s-1", "acct-a", "acct-b", "60", day(5, "2026-11-01"))), policy={"aml_detectors": {"structuring": RULE}})
    result = await run(executor, principal, "aml.typology.match")
    assert result.payload["typologies"] == [{"typology": "structuring", "indicators": []}]
    assert result.status == Status.PARTIAL and items(result) == [("EVIDENCE_INSUFFICIENT", "s-1")]


# --------------------------------------------------------------------------- aml.suspicion.assess

def finding(finding_id, status="INDICATOR", evidence=("evidence-1",)):
    return ("Finding", finding_id, {"claim": "Synthetic indicator.", "evidence_ids": list(evidence), "status": status})


async def test_suspicion_normal(build):
    """Normal: the seeded RESOLVED finding-1 is no indicator -> investigation_recommended false, reasons []; an
    INDICATOR finding-2 citing evidence-1 (minimum 1) -> true, reasons [finding-2]; COMPLETED."""
    _, executor, principal = build()
    result = await run(executor, principal, "aml.suspicion.assess")
    assert result.status == Status.COMPLETED
    assert result.payload == {"investigation_recommended": False, "reasons": [], "filing_decided": False}
    _, executor, principal = build(extra=[finding("finding-2")])
    result = await run(executor, principal, "aml.suspicion.assess")
    assert result.status == Status.COMPLETED
    assert result.payload == {"investigation_recommended": True, "reasons": ["finding-2"], "filing_decided": False}


async def test_suspicion_unsupported_or_open_findings(build):
    """Unsupported: an indicator citing evidence-9 (not admitted) is not counted and not dropped -> false,
    NEEDS_REVIEW with EVIDENCE_INSUFFICIENT for finding-2; an UNRESOLVED finding-3 -> NEEDS_REVIEW for finding-3."""
    _, executor, principal = build(extra=[finding("finding-2", evidence=["evidence-9"])])
    result = await run(executor, principal, "aml.suspicion.assess")
    assert result.payload == {"investigation_recommended": False, "reasons": [], "filing_decided": False}
    assert result.status == Status.NEEDS_REVIEW and items(result) == [("EVIDENCE_INSUFFICIENT", "finding-2")]
    _, executor, principal = build(extra=[finding("finding-3", status="UNRESOLVED")])
    result = await run(executor, principal, "aml.suspicion.assess")
    assert result.status == Status.NEEDS_REVIEW and items(result) == [("EVIDENCE_INSUFFICIENT", "finding-3")]


async def test_suspicion_without_minimum(build):
    """Policy unresolved: no investigation_indicator_minimum -> POLICY_UNRESOLVED / BLOCKED."""
    _, executor, principal = build(drop=["investigation_indicator_minimum"])
    failed(await run(executor, principal, "aml.suspicion.assess"), "POLICY_UNRESOLVED", Status.BLOCKED)
