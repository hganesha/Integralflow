"""Acceptance tests for the transaction.* analytics skills.

Each test names the "Examples and acceptance" bullet it encodes in skill-content/skills/<id>.md.
Every skill reads one complete DatasetScope: a window that is incomplete, miscounted, stale or holds
a record outside its bounds is never analysed; two records of one event are counted once only when
they agree. Unpinned policy is POLICY_UNRESOLVED, and an account, currency or window the data does
not cover is a visible gap rather than a clean "nothing found".
"""
from financial_crime import synthetic as f
from financial_crime.contracts import Status
from financial_crime.execution import Executor
from financial_crime.store import Store

ACCOUNTS = [("Account", "acct-a", {"entity_id": "acme", "account_type": "deposit"}),
            ("Account", "acct-b", {"entity_id": "alice", "account_type": "deposit"})]


def tx(key, source, target, amount, at, *, currency="SYN", status="settled", country="SYN", kind="transfer", event=None):
    """A transaction on 2026-11-02 at `at` (HH:MM, UTC unless `at` carries its own offset)."""
    timestamp = at if "T" in at else f"2026-11-02T{at}:00+00:00"
    return ("Transaction", key, {"source": source, "target": target, "amount": amount, "currency": currency, "timestamp": timestamp,
                                 "event_id": event or f"event-{key}", "status": status, "country": country, "transaction_type": kind})


SEEDED = [tx("tx-1", "acct-a", "acct-b", "60", "01:00"), tx("tx-2", "acct-a", "acct-b", "60", "02:00"), tx("tx-3", "acct-b", "acct-a", "110", "03:00")]


def window(*extra, base=SEEDED, **scope):
    """The seeded transactions plus `extra`, under one complete scope counting every record (unless overridden)."""
    rows = [*base, *extra]
    return [*rows, ("DatasetScope", "dataset-1", {"start": f.START, "end": f.END, "watermark": f.END, "complete": True, "expected_count": len(rows), **scope})]


async def run(skill_id, records, parameters=None, *, policy=None, drop=()):
    store = Store()
    data = {**f.policy(), **(policy or {})}
    for key in drop:
        data.pop(key)
    store.put(f.make_record("Policy", "synthetic-policy-v1", data))
    for object_type, object_id, payload in records:
        store.put(f.make_record(object_type, object_id, payload))
    try:
        request = f.invocation(skill_id, parameters={**f.parameters(skill_id), **(parameters or {})})
        return await Executor(store, [f.profile()], f.router()).run(request, f.principal())
    finally:
        store.close()


def failed(result, code, status):
    assert result.lifecycle == "FAILED" and result.payload == {}, result.model_dump()
    assert result.error["code"] == code and result.status == status


def items(result):
    return [(x["code"], x["subject_ref"]) for x in result.unresolved_items]


def completed(result):
    assert result.status == Status.COMPLETED and result.unresolved_items == [], result.model_dump()
    return result.payload


# ------------------------------------------------------------------------------------ transaction.ingest

async def test_ingest_normal():
    """Normal input: settled SYN 60, 60, 110 in the complete window -> three transactions, totals {SYN: 230}, COMPLETED."""
    payload = completed(await run("transaction.ingest", window()))
    assert [x["id"] for x in payload["transactions"]] == ["tx-1", "tx-2", "tx-3"] and payload["totals"] == {"SYN": "230"}


async def test_ingest_identical_duplicate_is_counted_once():
    """Duplicate: tx-9 repeating event-tx-1 with identical values is counted once: tx-1..tx-3, totals {SYN: 230}."""
    payload = completed(await run("transaction.ingest", window(tx("tx-9", "acct-a", "acct-b", "60", "01:00", event="event-tx-1"))))
    assert [x["id"] for x in payload["transactions"]] == ["tx-1", "tx-2", "tx-3"] and payload["totals"] == {"SYN": "230"}


async def test_ingest_conflicting_duplicate():
    """Contradictory: a second record of event-tx-1 with amount 61 -> SOURCE_CONFLICT / NEEDS_REVIEW, neither record preferred."""
    failed(await run("transaction.ingest", window(tx("tx-9", "acct-a", "acct-b", "61", "01:00", event="event-tx-1"))), "SOURCE_CONFLICT", Status.NEEDS_REVIEW)


async def test_ingest_record_outside_the_window():
    """Outside the window: tx-0 on 2026-10-31, counted in expected_count 4 -> EVIDENCE_INSUFFICIENT / NEEDS_EVIDENCE."""
    result = await run("transaction.ingest", window(tx("tx-0", "acct-a", "acct-b", "5", "2026-10-31T23:00:00+00:00")))
    failed(result, "EVIDENCE_INSUFFICIENT", Status.NEEDS_EVIDENCE)
    assert "tx-0" in result.error["message"]


async def test_ingest_incomplete_miscounted_or_stale_window():
    """Missing evidence: complete false, or expected_count 4 for three records -> EVIDENCE_INSUFFICIENT; watermark before end -> CONTEXT_STALE."""
    failed(await run("transaction.ingest", window(complete=False)), "EVIDENCE_INSUFFICIENT", Status.NEEDS_EVIDENCE)
    failed(await run("transaction.ingest", window(expected_count=4)), "EVIDENCE_INSUFFICIENT", Status.NEEDS_EVIDENCE)
    failed(await run("transaction.ingest", window(watermark="2026-11-06T00:00:00+00:00")), "CONTEXT_STALE", Status.NEEDS_EVIDENCE)


# ------------------------------------------------------------------------------------ transaction.enrich

async def test_enrich_normal():
    """Normal input: acct-a (acme) and acct-b (alice) both have Account records -> each transaction carries both, COMPLETED."""
    payload = completed(await run("transaction.enrich", window() + ACCOUNTS))
    first = payload["transactions"][0]
    assert first["id"] == "tx-1" and first["source_account"]["entity_id"] == "acme" and first["target_account"]["entity_id"] == "alice"


async def test_enrich_unknown_account():
    """Unresolved: tx-4 to acct-x, which has no Account record -> target_account null, NEEDS_EVIDENCE with EVIDENCE_INSUFFICIENT for acct-x."""
    result = await run("transaction.enrich", window(tx("tx-4", "acct-a", "acct-x", "5", "04:00")) + ACCOUNTS)
    assert result.status == Status.NEEDS_EVIDENCE and items(result) == [("EVIDENCE_INSUFFICIENT", "acct-x")]
    last = result.payload["transactions"][-1]
    assert last["id"] == "tx-4" and last["target_account"] is None and last["source_account"]["entity_id"] == "acme"


async def test_enrich_without_accounts():
    """Missing evidence: no admitted Account record -> CONTEXT_MISSING / NEEDS_EVIDENCE."""
    failed(await run("transaction.enrich", window()), "CONTEXT_MISSING", Status.NEEDS_EVIDENCE)


# ---------------------------------------------------------------------------------- transaction.classify

async def test_classify_normal():
    """Normal input: transaction_types {transfer: bank_transfer} -> tx-1..tx-3 typed bank_transfer, COMPLETED."""
    payload = completed(await run("transaction.classify", window()))
    assert payload == {"classifications": [{"id": f"tx-{i}", "type": "bank_transfer"} for i in (1, 2, 3)]}


async def test_classify_unmapped_code():
    """Unmapped code: tx-4 of type cash -> type UNKNOWN, NEEDS_REVIEW with POLICY_UNRESOLVED for cash."""
    result = await run("transaction.classify", window(tx("tx-4", "acct-a", "acct-b", "5", "04:00", kind="cash")))
    assert result.status == Status.NEEDS_REVIEW and items(result) == [("POLICY_UNRESOLVED", "cash")]
    assert result.payload["classifications"][-1] == {"id": "tx-4", "type": "UNKNOWN"}


async def test_classify_without_policy():
    """Policy unresolved: no transaction_types -> POLICY_UNRESOLVED / BLOCKED, not every type UNKNOWN."""
    failed(await run("transaction.classify", window(), drop=("transaction_types",)), "POLICY_UNRESOLVED", Status.BLOCKED)


# ------------------------------------------------------------------------ transaction.counterparty.resolve

async def test_counterparty_resolve_normal():
    """Normal input: tx-1 acct-a -> acct-b resolves to {source_entity: acme, target_entity: alice}, COMPLETED."""
    payload = completed(await run("transaction.counterparty.resolve", window() + ACCOUNTS))
    assert payload["counterparties"][0] == {"transaction_id": "tx-1", "source_entity": "acme", "target_entity": "alice"}
    assert payload["counterparties"][2] == {"transaction_id": "tx-3", "source_entity": "alice", "target_entity": "acme"}


async def test_counterparty_resolve_unknown_account():
    """Unresolved: tx-4 to acct-x -> target_entity null, NEEDS_EVIDENCE with EVIDENCE_INSUFFICIENT for acct-x."""
    result = await run("transaction.counterparty.resolve", window(tx("tx-4", "acct-a", "acct-x", "5", "04:00")) + ACCOUNTS)
    assert result.status == Status.NEEDS_EVIDENCE and items(result) == [("EVIDENCE_INSUFFICIENT", "acct-x")]
    assert result.payload["counterparties"][-1] == {"transaction_id": "tx-4", "source_entity": "acme", "target_entity": None}


async def test_counterparty_resolve_incomplete_window():
    """Missing evidence: a DatasetScope with complete false -> EVIDENCE_INSUFFICIENT / NEEDS_EVIDENCE."""
    failed(await run("transaction.counterparty.resolve", window(complete=False) + ACCOUNTS), "EVIDENCE_INSUFFICIENT", Status.NEEDS_EVIDENCE)


# --------------------------------------------------------------------------- transaction.behavior.profile

async def test_behavior_profile_normal():
    """Normal input: {count: 3, totals: {SYN: 230}, source_count: 2, target_count: 2}, COMPLETED."""
    assert completed(await run("transaction.behavior.profile", window())) == {"profile": {"count": 3, "totals": {"SYN": "230"}, "source_count": 2, "target_count": 2}}


async def test_behavior_profile_currencies_and_reversals():
    """Mixed currency and reversal: tx-4 EUR 5 and tx-5 SYN 500 reversed -> count 5, totals {EUR: 5, SYN: 230}."""
    result = await run("transaction.behavior.profile", window(tx("tx-4", "acct-a", "acct-b", "5", "04:00", currency="EUR"),
                                                              tx("tx-5", "acct-a", "acct-b", "500", "05:00", status="reversed")))
    assert completed(result)["profile"] == {"count": 5, "totals": {"EUR": "5", "SYN": "230"}, "source_count": 2, "target_count": 2}


async def test_behavior_profile_incomplete_window():
    """Missing evidence: complete false -> EVIDENCE_INSUFFICIENT / NEEDS_EVIDENCE, no empty profile."""
    failed(await run("transaction.behavior.profile", window(complete=False)), "EVIDENCE_INSUFFICIENT", Status.NEEDS_EVIDENCE)


# --------------------------------------------------------------------------- transaction.baseline.compare

async def test_baseline_compare_normal():
    """Normal input: expected {SYN: 200} -> [{currency: SYN, actual: 230, difference: 30, baseline_known: true}], COMPLETED."""
    payload = completed(await run("transaction.baseline.compare", window(), {"expected_totals": {"SYN": "200"}}))
    assert payload == {"deviations": [{"currency": "SYN", "actual": "230", "difference": "30", "baseline_known": True}]}


async def test_baseline_compare_expected_currency_without_activity():
    """No activity: expected {SYN: 230, EUR: 50} -> SYN difference 0 and {currency: EUR, actual: 0, difference: -50}, COMPLETED."""
    payload = completed(await run("transaction.baseline.compare", window(), {"expected_totals": {"SYN": "230", "EUR": "50"}}))
    assert payload == {"deviations": [{"currency": "SYN", "actual": "230", "difference": "0", "baseline_known": True},
                                      {"currency": "EUR", "actual": "0", "difference": "-50", "baseline_known": True}]}


async def test_baseline_compare_without_a_baseline():
    """Missing evidence: expected {} -> SYN with difference null, baseline_known false, NEEDS_EVIDENCE with EVIDENCE_INSUFFICIENT for SYN."""
    result = await run("transaction.baseline.compare", window(), {"expected_totals": {}})
    assert result.status == Status.NEEDS_EVIDENCE and items(result) == [("EVIDENCE_INSUFFICIENT", "SYN")]
    assert result.payload == {"deviations": [{"currency": "SYN", "actual": "230", "difference": None, "baseline_known": False}]}


# -------------------------------------------------------------------------- transaction.velocity.analyze

async def test_velocity_normal():
    """Normal input: window 86400 -> tx-1 count 1 (SYN 60), tx-2 count 2 (SYN 120), tx-3 (acct-b) count 1 (SYN 110), COMPLETED."""
    payload = completed(await run("transaction.velocity.analyze", window(), {"window_seconds": 86400}))
    assert payload == {"windows": [{"anchor": "tx-1", "source": "acct-a", "count": 1, "totals": {"SYN": "60"}},
                                   {"anchor": "tx-2", "source": "acct-a", "count": 2, "totals": {"SYN": "120"}},
                                   {"anchor": "tx-3", "source": "acct-b", "count": 1, "totals": {"SYN": "110"}}]}


async def test_velocity_half_open_boundary():
    """Boundary: window 3600 -> tx-1 at exactly one hour before tx-2 is outside tx-2's window (count 1)."""
    payload = completed(await run("transaction.velocity.analyze", window(), {"window_seconds": 3600}))
    assert [x["count"] for x in payload["windows"]] == [1, 1, 1]


async def test_velocity_offsets_compared_as_instants():
    """Offsets: tx-4 at 03:30+02:00 (01:30 UTC) from acct-a falls inside tx-2's 86400 window -> tx-2 count 3."""
    payload = completed(await run("transaction.velocity.analyze", window(tx("tx-4", "acct-a", "acct-b", "5", "2026-11-02T03:30:00+02:00")), {"window_seconds": 86400}))
    assert {x["anchor"]: x["count"] for x in payload["windows"]} == {"tx-1": 1, "tx-2": 3, "tx-3": 1, "tx-4": 2}


async def test_velocity_window_reaching_before_the_dataset():
    """Partial: window 172800 starts every window before the dataset start (2026-11-01) -> counts kept, PARTIAL with EVIDENCE_INSUFFICIENT for tx-1, tx-2, tx-3."""
    result = await run("transaction.velocity.analyze", window(), {"window_seconds": 172800})
    assert result.status == Status.PARTIAL and items(result) == [("EVIDENCE_INSUFFICIENT", f"tx-{i}") for i in (1, 2, 3)]
    assert [x["count"] for x in result.payload["windows"]] == [1, 2, 1]


# ------------------------------------------------------------------------------ transaction.flow.trace

async def test_flow_trace_normal():
    """Normal input: acct-a -> acct-b, max_hops 3 -> paths [[acct-a, acct-b]], allocation_assumed false, COMPLETED."""
    payload = completed(await run("transaction.flow.trace", window(), {"source": "acct-a", "target": "acct-b", "max_hops": 3}))
    assert payload == {"paths": [["acct-a", "acct-b"]], "allocation_assumed": False}


async def test_flow_trace_beyond_max_hops():
    """Beyond the limit: acct-a -> acct-b -> acct-c -> acct-d traced with max_hops 1 -> paths [], PARTIAL with EVIDENCE_INSUFFICIENT for acct-d."""
    records = window(tx("tx-4", "acct-b", "acct-c", "50", "04:00"), tx("tx-5", "acct-c", "acct-d", "40", "05:00"))
    result = await run("transaction.flow.trace", records, {"source": "acct-a", "target": "acct-d", "max_hops": 1})
    assert result.status == Status.PARTIAL and items(result) == [("EVIDENCE_INSUFFICIENT", "acct-d")]
    assert result.payload == {"paths": [], "allocation_assumed": False}
    payload = completed(await run("transaction.flow.trace", records, {"source": "acct-a", "target": "acct-d", "max_hops": 3}))
    assert payload["paths"] == [["acct-a", "acct-b", "acct-c", "acct-d"]]


async def test_flow_trace_against_direction_and_unknown_accounts():
    """No flow: tx-4 acct-c -> acct-a only, so acct-a never paid acct-c -> paths [], COMPLETED; acct-z in no transaction -> NEEDS_EVIDENCE."""
    records = window(tx("tx-4", "acct-c", "acct-a", "5", "04:00"))
    assert completed(await run("transaction.flow.trace", records, {"source": "acct-a", "target": "acct-c", "max_hops": 3}))["paths"] == []
    result = await run("transaction.flow.trace", records, {"source": "acct-a", "target": "acct-z", "max_hops": 3})
    assert result.status == Status.NEEDS_EVIDENCE and items(result) == [("EVIDENCE_INSUFFICIENT", "acct-z")] and result.payload["paths"] == []



async def test_flow_trace_enumeration_budget():
    """Budget: four fully linked layers of six accounts between s and t (1296 paths) -> CONTEXT_BUDGET_EXCEEDED, no payload."""
    layers = [["s"], *[[f"l{i}-{j}" for j in range(6)] for i in range(4)], ["t"]]
    links = [tx(f"tx-{a}-{b}", a, b, "1", "04:00") for left, right in zip(layers, layers[1:]) for a in left for b in right]
    result = await run("transaction.flow.trace", window(*links, base=[]), {"source": "s", "target": "t", "max_hops": 5})
    assert result.lifecycle == "FAILED" and result.payload == {} and result.error["code"] == "CONTEXT_BUDGET_EXCEEDED"

# -------------------------------------------------------------------------- transaction.cashflow.analyze

async def test_cashflow_normal():
    """Normal input: account acct-a -> inflows {SYN: 110}, outflows {SYN: 120}, COMPLETED."""
    assert completed(await run("transaction.cashflow.analyze", window(), {"account": "acct-a"})) == {"inflows": {"SYN": "110"}, "outflows": {"SYN": "120"}}


async def test_cashflow_currencies_and_reversals():
    """Mixed currency and reversal: tx-4 acct-b -> acct-a EUR 5, tx-5 acct-a -> acct-b SYN 500 reversed -> inflows {EUR: 5, SYN: 110}, outflows {SYN: 120}."""
    records = window(tx("tx-4", "acct-b", "acct-a", "5", "04:00", currency="EUR"), tx("tx-5", "acct-a", "acct-b", "500", "05:00", status="reversed"))
    assert completed(await run("transaction.cashflow.analyze", records, {"account": "acct-a"})) == {"inflows": {"EUR": "5", "SYN": "110"}, "outflows": {"SYN": "120"}}


async def test_cashflow_account_without_transactions():
    """Not covered: account acct-z appears in no transaction -> inflows {}, outflows {}, NEEDS_EVIDENCE with EVIDENCE_INSUFFICIENT for acct-z."""
    result = await run("transaction.cashflow.analyze", window(), {"account": "acct-z"})
    assert result.status == Status.NEEDS_EVIDENCE and items(result) == [("EVIDENCE_INSUFFICIENT", "acct-z")]
    assert result.payload == {"inflows": {}, "outflows": {}}


# ------------------------------------------------------------------------- transaction.geography.analyze

async def test_geography_normal():
    """Normal input: all three in country SYN -> {SYN: {SYN: 230}}, COMPLETED."""
    assert completed(await run("transaction.geography.analyze", window())) == {"exposures": {"SYN": {"SYN": "230"}}}


async def test_geography_keeps_countries_and_currencies_apart():
    """Separate groups: tx-4 country ZZ in EUR 5 -> {SYN: {SYN: 230}, ZZ: {EUR: 5}}."""
    result = await run("transaction.geography.analyze", window(tx("tx-4", "acct-a", "acct-b", "5", "04:00", currency="EUR", country="ZZ")))
    assert completed(result) == {"exposures": {"SYN": {"SYN": "230"}, "ZZ": {"EUR": "5"}}}


async def test_geography_duplicates_disagreeing_on_country():
    """Contradictory: a second record of event-tx-1 with country ZZ (amount equal) -> SOURCE_CONFLICT / NEEDS_REVIEW."""
    records = window(tx("tx-9", "acct-a", "acct-b", "60", "01:00", country="ZZ", event="event-tx-1"))
    failed(await run("transaction.geography.analyze", records), "SOURCE_CONFLICT", Status.NEEDS_REVIEW)


async def test_geography_without_country():
    """Missing evidence: a transaction without country -> CONTEXT_MISSING / NEEDS_EVIDENCE."""
    _, key, data = tx("tx-4", "acct-a", "acct-b", "5", "04:00")
    data.pop("country")
    failed(await run("transaction.geography.analyze", window(("Transaction", key, data))), "CONTEXT_MISSING", Status.NEEDS_EVIDENCE)


# --------------------------------------------------------------------------- transaction.anomaly.detect

BASELINE = {"mean": "50", "standard_deviation": "10", "z_threshold": "2", "currency": "SYN"}


async def test_anomaly_normal():
    """Normal input: mean 50, deviation 10, threshold 2 in SYN -> [{id: tx-3, z_score: 6}], calibrated false, COMPLETED."""
    assert completed(await run("transaction.anomaly.detect", window(), BASELINE)) == {"anomalies": [{"id": "tx-3", "z_score": "6"}], "calibrated": False}


async def test_anomaly_other_currency_not_scored():
    """Partial: tx-4 in EUR is not scored against the SYN baseline -> same anomalies, PARTIAL with EVIDENCE_INSUFFICIENT for EUR."""
    result = await run("transaction.anomaly.detect", window(tx("tx-4", "acct-a", "acct-b", "5000", "04:00", currency="EUR")), BASELINE)
    assert result.status == Status.PARTIAL and items(result) == [("EVIDENCE_INSUFFICIENT", "EUR")]
    assert result.payload == {"anomalies": [{"id": "tx-3", "z_score": "6"}], "calibrated": False}


async def test_anomaly_nothing_in_the_baseline_currency():
    """Nothing scored: currency EUR with only SYN transactions -> anomalies [], NEEDS_EVIDENCE with items for EUR and SYN."""
    result = await run("transaction.anomaly.detect", window(), {**BASELINE, "currency": "EUR"})
    assert result.status == Status.NEEDS_EVIDENCE and items(result) == [("EVIDENCE_INSUFFICIENT", "EUR"), ("EVIDENCE_INSUFFICIENT", "SYN")]
    assert result.payload == {"anomalies": [], "calibrated": False}


async def test_anomaly_invalid_baseline():
    """Invalid input: standard_deviation 0 -> INPUT_INVALID / FAILED."""
    failed(await run("transaction.anomaly.detect", window(), {**BASELINE, "standard_deviation": "0"}), "INPUT_INVALID", Status.FAILED)


# ------------------------------------------------------------------------ transaction.exposure.aggregate

async def test_exposure_normal():
    """Normal input: dimension source -> {acct-a: {SYN: 120}, acct-b: {SYN: 110}}, COMPLETED."""
    assert completed(await run("transaction.exposure.aggregate", window(), {"dimension": "source"})) == {"exposures": {"acct-a": {"SYN": "120"}, "acct-b": {"SYN": "110"}}}


async def test_exposure_by_currency_and_duplicate():
    """Dimension currency with tx-4 EUR 5 and an identical repeat of event-tx-1 -> {EUR: {EUR: 5}, SYN: {SYN: 230}}."""
    records = window(tx("tx-4", "acct-a", "acct-b", "5", "04:00", currency="EUR"), tx("tx-9", "acct-a", "acct-b", "60", "01:00", event="event-tx-1"))
    assert completed(await run("transaction.exposure.aggregate", records, {"dimension": "currency"})) == {"exposures": {"EUR": {"EUR": "5"}, "SYN": {"SYN": "230"}}}


async def test_exposure_miscounted_window():
    """Missing evidence: expected_count 4 for three records -> EVIDENCE_INSUFFICIENT / NEEDS_EVIDENCE."""
    failed(await run("transaction.exposure.aggregate", window(expected_count=4), {"dimension": "source"}), "EVIDENCE_INSUFFICIENT", Status.NEEDS_EVIDENCE)
