"""Acceptance tests for the regulatory.* reporting skills.

Each test names the "Examples and acceptance" bullet it encodes in skill-content/skills/<id>.md.
Obligations, thresholds, fields and deadlines come only from pinned policy; unknown facts are never
"not required"; narratives and filings cite admitted evidence; a queued, uncertain or receipt-less
submission is never reported as filed; and one filing is one submission.
"""
import pytest

from financial_crime import synthetic as f
from financial_crime.contracts import SkillError, Status, canonical, digest
from financial_crime.effects import LocalRegulator, OutboxWorker
from financial_crime.execution import Executor
from financial_crime.store import Store

TENANT = "tenant-synthetic"
POLICY_ID = "synthetic-policy-v1"
CASE = "case-demo"
FILING = {"report_type": "SAR", "subject_id": "acme", "narrative": "Synthetic finding [evidence-1]", "citations": ["evidence-1"]}


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


def request(skill_id, parameters=None, **overrides):
    result = f.invocation(skill_id, **({"parameters": parameters} if parameters is not None else {}), **overrides)
    if parameters is not None and "idempotency_key" not in overrides:
        result = result.model_copy(update={"idempotency_key": skill_id + "-" + digest(parameters)[:16]})
    return result


async def run(executor, principal, skill_id, parameters=None, **overrides):
    return await executor.run(request(skill_id, parameters, **overrides), principal)


def failed(result, code, status):
    assert result.lifecycle == "FAILED" and result.payload == {}, result.model_dump()
    assert result.error["code"] == code and result.status == status


def items(result):
    return [(x["code"], x["subject_ref"]) for x in result.unresolved_items]


def finding(finding_id, status="INDICATOR", evidence=("evidence-1",), claim="Synthetic indicator."):
    return ("Finding", finding_id, {"claim": claim, "evidence_ids": list(evidence), "status": status})


def tx(tx_id, amount, currency="SYN", status="settled", hour=1, transaction_type="cash_deposit"):
    return ("Transaction", tx_id, {"source": "acct-a", "target": "acct-b", "amount": amount, "currency": currency,
                                   "timestamp": f"2026-11-02T{hour:02d}:00:00+00:00", "event_id": "event-" + tx_id, "status": status,
                                   "transaction_type": transaction_type})


def dataset(*transactions, complete=True):
    return {"without": ("Transaction", "DatasetScope"), "extra": [*transactions, ("DatasetScope", "dataset-1", {
        "start": f.START, "end": f.END, "watermark": f.END, "complete": complete, "expected_count": len(transactions)})]}


def obligations(*extra):
    return {"reporting_obligations": [*f.policy()["reporting_obligations"], *extra]}


# ------------------------------------------------------------------ regulatory.obligations.resolve

async def test_obligations_normal(build):
    """Normal: report_type SAR -> [synthetic-sar: 7 calendar days], synthetic true; COMPLETED."""
    _, executor, principal = build()
    result = await run(executor, principal, "regulatory.obligations.resolve", {"report_type": "SAR"})
    assert result.status == Status.COMPLETED
    assert result.payload == {"obligations": [{"id": "synthetic-sar", "type": "SAR", "deadline_days": 7, "business_days": False, "time_zone": "UTC"}], "synthetic": True}


async def test_obligations_unpinned(build):
    """Policy unresolved: no reporting_obligations, or only a CTR obligation when SAR is asked -> POLICY_UNRESOLVED / BLOCKED."""
    _, executor, principal = build(drop=["reporting_obligations"])
    failed(await run(executor, principal, "regulatory.obligations.resolve", {"report_type": "SAR"}), "POLICY_UNRESOLVED", Status.BLOCKED)
    _, executor, principal = build(policy={"reporting_obligations": [f.policy()["reporting_obligations"][1]]})
    failed(await run(executor, principal, "regulatory.obligations.resolve", {"report_type": "SAR"}), "POLICY_UNRESOLVED", Status.BLOCKED)


# ------------------------------------------------------------------------- regulatory.sar.evaluate

async def test_sar_evaluate_normal(build):
    """Normal: only the RESOLVED finding-1 -> review_required false, indicator_ids []; INDICATOR finding-2 citing
    evidence-1 -> review_required true, [finding-2]; filing_decided false; COMPLETED."""
    _, executor, principal = build()
    result = await run(executor, principal, "regulatory.sar.evaluate")
    assert result.status == Status.COMPLETED
    assert result.payload == {"review_required": False, "indicator_ids": [], "filing_decided": False}
    _, executor, principal = build(extra=[finding("finding-2")])
    result = await run(executor, principal, "regulatory.sar.evaluate")
    assert result.status == Status.COMPLETED
    assert result.payload == {"review_required": True, "indicator_ids": ["finding-2"], "filing_decided": False}


async def test_sar_evaluate_unknown_facts_are_not_not_required(build):
    """Unknown facts: an indicator citing evidence-9 (not admitted), or a DISPUTED finding -> review_required true,
    indicator_ids [], NEEDS_REVIEW with EVIDENCE_INSUFFICIENT for that finding."""
    for extra in (finding("finding-2", evidence=["evidence-9"]), finding("finding-2", status="DISPUTED")):
        _, executor, principal = build(extra=[extra])
        result = await run(executor, principal, "regulatory.sar.evaluate")
        assert result.payload == {"review_required": True, "indicator_ids": [], "filing_decided": False}
        assert result.status == Status.NEEDS_REVIEW and items(result) == [("EVIDENCE_INSUFFICIENT", "finding-2")]


# ---------------------------------------------------------------------------- regulatory.sar.draft

async def test_sar_draft_normal(build):
    """Normal: finding-1 citing evidence-1 -> narrative "[RESOLVED] Captured synthetic activity exceeds a test
    baseline. [evidence: evidence-1]", citations [evidence-1], review_required true; COMPLETED."""
    _, executor, principal = build()
    result = await run(executor, principal, "regulatory.sar.draft")
    assert result.status == Status.COMPLETED
    assert result.payload == {"report_type": "SAR", "narrative": "[RESOLVED] Captured synthetic activity exceeds a test baseline. [evidence: evidence-1]",
                              "citations": ["evidence-1"], "review_required": True}


async def test_sar_draft_leaves_out_unadmitted_citations(build):
    """Unsupported: finding-2 citing evidence-9 (not admitted) is not in the narrative and not dropped -> narrative
    and citations as normal, NEEDS_REVIEW with EVIDENCE_INSUFFICIENT for finding-2."""
    _, executor, principal = build(extra=[finding("finding-2", evidence=["evidence-9"], claim="Unsupported claim.")])
    result = await run(executor, principal, "regulatory.sar.draft")
    assert "Unsupported claim" not in result.payload["narrative"] and result.payload["citations"] == ["evidence-1"]
    assert result.status == Status.NEEDS_REVIEW and items(result) == [("EVIDENCE_INSUFFICIENT", "finding-2")]


async def test_sar_draft_without_supported_findings(build):
    """Missing evidence: the only finding cites nothing -> narrative "", citations [], NEEDS_EVIDENCE with
    EVIDENCE_INSUFFICIENT for it."""
    _, executor, principal = build(without=("Finding",), extra=[finding("finding-2", evidence=[])])
    result = await run(executor, principal, "regulatory.sar.draft")
    assert result.payload == {"report_type": "SAR", "narrative": "", "citations": [], "review_required": True}
    assert result.status == Status.NEEDS_EVIDENCE and items(result) == [("EVIDENCE_INSUFFICIENT", "finding-2")]


# ------------------------------------------------------------------------- regulatory.sar.validate

async def test_sar_validate_normal(build):
    """Normal: report_type SAR, subject_id acme, a narrative and citations [evidence-1] -> valid true, issues []; COMPLETED."""
    _, executor, principal = build()
    result = await run(executor, principal, "regulatory.sar.validate", {"filing": FILING})
    assert result.status == Status.COMPLETED and result.payload == {"valid": True, "issues": []}


async def test_sar_validate_incomplete_filing(build):
    """Incomplete: no citations -> valid false, [MISSING citations, UNCITED_NARRATIVE]; citations [evidence-9] ->
    UNADMITTED_CITATION; report_type CTR -> WRONG_REPORT_TYPE."""
    _, executor, principal = build()
    result = await run(executor, principal, "regulatory.sar.validate", {"filing": {k: v for k, v in FILING.items() if k != "citations"}})
    assert result.payload == {"valid": False, "issues": [{"field": "citations", "code": "MISSING"}, {"code": "UNCITED_NARRATIVE"}]}
    result = await run(executor, principal, "regulatory.sar.validate", {"filing": {**FILING, "citations": ["evidence-9"]}})
    assert result.payload == {"valid": False, "issues": [{"field": "citations", "code": "UNADMITTED_CITATION", "explanation": "evidence-9 is not admitted evidence"}]}
    result = await run(executor, principal, "regulatory.sar.validate", {"filing": {**FILING, "report_type": "CTR"}})
    assert result.payload["valid"] is False and [x["code"] for x in result.payload["issues"]] == ["WRONG_REPORT_TYPE"]


async def test_sar_validate_without_fields(build):
    """Policy unresolved: no filing_fields -> POLICY_UNRESOLVED / BLOCKED, never valid."""
    _, executor, principal = build(drop=["filing_fields"])
    failed(await run(executor, principal, "regulatory.sar.validate", {"filing": FILING}), "POLICY_UNRESOLVED", Status.BLOCKED)


# ------------------------------------------------------------------------- regulatory.ctr.evaluate

async def test_ctr_evaluate_normal(build):
    """Normal: seeded tx-1, tx-2 (60 + 60 acme -> alice) and tx-3 (110 alice -> acme) on 2026-11-02 (UTC) are
    totalled per customer, day, currency and direction: acme out 120 and alice in 120 meet the threshold of 100,
    alice out 110 and acme in 110 meet it; filing_decided false, time_zone UTC; COMPLETED."""
    _, executor, principal = build()
    result = await run(executor, principal, "regulatory.ctr.evaluate")
    assert result.status == Status.COMPLETED
    day = "2026-11-02"
    assert result.payload == {"evaluations": [
        {"entity_id": "acme", "business_day": day, "currency": "SYN", "direction": "in", "total": "110", "transaction_ids": ["tx-3"], "threshold_met": True},
        {"entity_id": "acme", "business_day": day, "currency": "SYN", "direction": "out", "total": "120", "transaction_ids": ["tx-1", "tx-2"], "threshold_met": True},
        {"entity_id": "alice", "business_day": day, "currency": "SYN", "direction": "in", "total": "120", "transaction_ids": ["tx-1", "tx-2"], "threshold_met": True},
        {"entity_id": "alice", "business_day": day, "currency": "SYN", "direction": "out", "total": "110", "transaction_ids": ["tx-3"], "threshold_met": True},
    ], "time_zone": "UTC", "calendar_basis": "calendar_days", "filing_decided": False}


def acme_out(result):
    return [x for x in result.payload["evaluations"] if x["entity_id"] == "acme" and x["direction"] == "out"]


async def test_ctr_evaluate_threshold_boundary(build):
    """Boundary: 60 + 40 = 100 meets the threshold of 100 (at or above); 60 + 39.99 does not; COMPLETED."""
    for second, met in (("40", True), ("39.99", False)):
        _, executor, principal = build(**dataset(tx("c-1", "60"), tx("c-2", second, hour=2)))
        result = await run(executor, principal, "regulatory.ctr.evaluate")
        assert result.status == Status.COMPLETED and [x["threshold_met"] for x in acme_out(result)] == [met]


async def test_ctr_evaluate_aggregates_per_customer_per_local_day(build):
    """Per customer, per day: 60 at 2026-11-02T23:00Z and 60 at 2026-11-03T01:00Z are on two UTC days (60 each,
    not met), but with ctr_time_zone America/New_York both are on 2026-11-02 local (120, met). Two customers'
    accounts are never summed: acct-a (acme) 60 and acct-c (bob) 60 to acct-b stay two outgoing totals of 60."""
    late = ("Transaction", "c-2", {**tx("c-2", "60")[2], "timestamp": "2026-11-03T01:00:00+00:00"})
    _, executor, principal = build(**dataset(tx("c-1", "60", hour=23), late))
    result = await run(executor, principal, "regulatory.ctr.evaluate")
    assert [(x["business_day"], x["total"], x["threshold_met"]) for x in acme_out(result)] == [("2026-11-02", "60", False), ("2026-11-03", "60", False)]
    _, executor, principal = build(**dataset(tx("c-1", "60", hour=23), late), policy={"ctr_time_zone": "America/New_York"})
    result = await run(executor, principal, "regulatory.ctr.evaluate")
    assert result.payload["time_zone"] == "America/New_York"
    assert [(x["business_day"], x["total"], x["threshold_met"]) for x in acme_out(result)] == [("2026-11-02", "120", True)]
    other = ("Transaction", "c-2", {**tx("c-2", "60", hour=2)[2], "source": "acct-c"})
    spec = dataset(tx("c-1", "60"), other)
    _, executor, principal = build(**{**spec, "extra": [*spec["extra"], ("Account", "acct-c", {"entity_id": "bob", "account_type": "deposit"})]})
    result = await run(executor, principal, "regulatory.ctr.evaluate")
    out = [(x["entity_id"], x["total"], x["threshold_met"]) for x in result.payload["evaluations"] if x["direction"] == "out"]
    assert result.status == Status.COMPLETED and out == [("acme", "60", False), ("bob", "60", False)]


async def test_ctr_evaluate_unattributed_account(build):
    """Unattributed: acct-z has no Account record -> its side is not aggregated for anyone; acme's side still is;
    NEEDS_EVIDENCE with EVIDENCE_INSUFFICIENT for acct-z."""
    paid = ("Transaction", "c-1", {**tx("c-1", "60")[2], "target": "acct-z"})
    _, executor, principal = build(**dataset(paid))
    result = await run(executor, principal, "regulatory.ctr.evaluate")
    assert [(x["entity_id"], x["direction"]) for x in result.payload["evaluations"]] == [("acme", "out")]
    assert result.status == Status.NEEDS_EVIDENCE and items(result) == [("EVIDENCE_INSUFFICIENT", "acct-z")]


async def test_ctr_evaluate_currency_without_threshold(build):
    """Unknown: 60 SYN and 500 XYZ are not summed; XYZ has no pinned threshold -> threshold_met null, NEEDS_REVIEW
    with POLICY_UNRESOLVED for XYZ."""
    _, executor, principal = build(**dataset(tx("c-1", "60"), tx("c-2", "500", currency="XYZ", hour=2)))
    result = await run(executor, principal, "regulatory.ctr.evaluate")
    assert [(x["currency"], x["total"], x["threshold_met"]) for x in acme_out(result)] == [("SYN", "60", False), ("XYZ", "500", None)]
    assert result.status == Status.NEEDS_REVIEW and items(result) == [("POLICY_UNRESOLVED", "XYZ")]


async def test_ctr_evaluate_without_thresholds(build):
    """Policy unresolved: no ctr_thresholds, no ctr_time_zone, a zone that is not a known IANA name, no
    ctr_transaction_types or an empty selection, or no ctr_business_day -> POLICY_UNRESOLVED / BLOCKED.
    Incomplete scope -> EVIDENCE_INSUFFICIENT / NEEDS_EVIDENCE."""
    for change in ({"drop": ["ctr_thresholds"]}, {"drop": ["ctr_time_zone"]}, {"policy": {"ctr_time_zone": "Mars/Olympus"}},
                   {"drop": ["ctr_transaction_types"]}, {"policy": {"ctr_transaction_types": []}}, {"drop": ["ctr_business_day"]}):
        _, executor, principal = build(**change)
        failed(await run(executor, principal, "regulatory.ctr.evaluate"), "POLICY_UNRESOLVED", Status.BLOCKED)
    _, executor, principal = build(**dataset(tx("c-1", "60"), complete=False))
    failed(await run(executor, principal, "regulatory.ctr.evaluate"), "EVIDENCE_INSUFFICIENT", Status.NEEDS_EVIDENCE)


async def test_ctr_evaluate_counts_only_selected_cash_types(build):
    """Cash selection: 60 cash_deposit and 50 wire_out are not summed; the wire is not a CTR transaction type and
    is left out -> acme out [c-1] 60 only; COMPLETED."""
    _, executor, principal = build(**dataset(tx("c-1", "60"), tx("c-2", "50", hour=2, transaction_type="wire_out")))
    result = await run(executor, principal, "regulatory.ctr.evaluate")
    assert result.status == Status.COMPLETED
    assert [(x["total"], x["transaction_ids"]) for x in acme_out(result)] == [("60", ["c-1"])]


def business_day(cutoff, roll=False):
    return {"ctr_business_day": {"cutoff": cutoff, "roll_non_working_days": roll}}


async def test_ctr_evaluate_business_day_cutoff_and_calendar(build):
    """Cut-off: with cutoff 17:00, 60 at Monday 2026-11-02T16:00Z and 60 at 18:00Z fall on business days 11-02
    and 11-03 (not summed). Calendar: with roll_non_working_days, 60 on Saturday 2026-11-07 and 60 on Sunday
    2026-11-08 both roll to Monday 2026-11-09 (120, met), calendar_basis business_days. Rolling with no
    BusinessCalendar -> CONTEXT_MISSING / NEEDS_EVIDENCE."""
    _, executor, principal = build(**dataset(tx("c-1", "60", hour=16), tx("c-2", "60", hour=18)), policy=business_day("17:00"))
    result = await run(executor, principal, "regulatory.ctr.evaluate")
    assert [(x["business_day"], x["total"]) for x in acme_out(result)] == [("2026-11-02", "60"), ("2026-11-03", "60")]
    weekend = [("Transaction", k, {**tx(k, "60")[2], "timestamp": at}) for k, at in (("c-1", "2026-11-07T10:00:00+00:00"), ("c-2", "2026-11-08T10:00:00+00:00"))]
    spec = dataset(*weekend)
    scope = ("DatasetScope", "dataset-1", {"start": "2026-11-07T00:00:00+00:00", "end": "2026-11-09T00:00:00+00:00",
                                           "watermark": "2026-11-09T00:00:00+00:00", "complete": True, "expected_count": 2})
    spec["extra"] = [*weekend, scope]
    _, executor, principal = build(**spec, policy=business_day("00:00", roll=True))
    result = await run(executor, principal, "regulatory.ctr.evaluate")
    assert result.status == Status.COMPLETED and result.payload["calendar_basis"] == "business_days"
    assert [(x["business_day"], x["total"], x["threshold_met"]) for x in acme_out(result)] == [("2026-11-09", "120", True)]
    _, executor, principal = build(**{**spec, "without": (*spec["without"], "BusinessCalendar")}, policy=business_day("00:00", roll=True))
    failed(await run(executor, principal, "regulatory.ctr.evaluate"), "CONTEXT_MISSING", Status.NEEDS_EVIDENCE)


# -------------------------------------------------------------------------- regulatory.ctr.prepare

async def test_ctr_prepare_normal(build):
    """Normal: seeded -> the four customer-day totals that meet 100 (acme in 110 and out 120, alice in 120 and out
    110), transaction_ids [tx-1, tx-2, tx-3], time_zone UTC, synthetic true; COMPLETED."""
    _, executor, principal = build()
    result = await run(executor, principal, "regulatory.ctr.prepare")
    assert result.status == Status.COMPLETED
    assert [(x["entity_id"], x["direction"], x["total"]) for x in result.payload["reportable"]] == [
        ("acme", "in", "110"), ("acme", "out", "120"), ("alice", "in", "120"), ("alice", "out", "110")]
    assert {k: v for k, v in result.payload.items() if k != "reportable"} == {
        "report_type": "CTR", "transaction_ids": ["tx-1", "tx-2", "tx-3"], "time_zone": "UTC", "calendar_basis": "calendar_days", "synthetic": True}


async def test_ctr_prepare_reports_only_totals_that_meet_the_threshold(build):
    """Below threshold: 60 + 39.99 -> reportable [], COMPLETED (evaluated, nothing to report). Reversed: c-2 reversed
    leaves 60 -> reportable []. All reversed, or none of a CTR type, in the complete scope -> reportable [], COMPLETED.
    An incomplete scope -> EVIDENCE_INSUFFICIENT / NEEDS_EVIDENCE, never "nothing to report"."""
    for transactions in ((tx("c-1", "60"), tx("c-2", "39.99", hour=2)), (tx("c-1", "60"), tx("c-2", "40", status="reversed", hour=2)),
                         (tx("c-1", "60", status="reversed"),), (tx("c-1", "60", transaction_type="wire_out"),)):
        _, executor, principal = build(**dataset(*transactions))
        result = await run(executor, principal, "regulatory.ctr.prepare")
        assert result.status == Status.COMPLETED and result.payload["reportable"] == [] and result.payload["transaction_ids"] == []
    _, executor, principal = build(**dataset(tx("c-1", "160"), complete=False))
    failed(await run(executor, principal, "regulatory.ctr.prepare"), "EVIDENCE_INSUFFICIENT", Status.NEEDS_EVIDENCE)


async def test_ctr_prepare_carries_the_evaluation_gaps(build):
    """Gaps: a payment to acct-z with no Account record -> acme's side is prepared, NEEDS_EVIDENCE with
    EVIDENCE_INSUFFICIENT for acct-z; a currency with no threshold -> NEEDS_REVIEW with POLICY_UNRESOLVED."""
    paid = ("Transaction", "c-1", {**tx("c-1", "160")[2], "target": "acct-z"})
    _, executor, principal = build(**dataset(paid))
    result = await run(executor, principal, "regulatory.ctr.prepare")
    assert [(x["entity_id"], x["direction"]) for x in result.payload["reportable"]] == [("acme", "out")]
    assert result.status == Status.NEEDS_EVIDENCE and items(result) == [("EVIDENCE_INSUFFICIENT", "acct-z")]
    _, executor, principal = build(**dataset(tx("c-1", "500", currency="XYZ")))
    result = await run(executor, principal, "regulatory.ctr.prepare")
    assert result.status == Status.NEEDS_REVIEW and items(result) == [("POLICY_UNRESOLVED", "XYZ")]


# ---------------------------------------------------------------------- regulatory.deadline.calculate

async def test_deadline_normal(build):
    """Normal: CTR (3 business days, Mon-Fri, no holidays) from Friday 2026-11-06T00:00Z -> 2026-11-11T00:00:00+00:00,
    business_days; SAR (7 calendar days) from 2026-11-01T00:00Z -> 2026-11-08T00:00:00+00:00, calendar_days."""
    _, executor, principal = build()
    result = await run(executor, principal, "regulatory.deadline.calculate", {"event_at": "2026-11-06T00:00:00+00:00", "report_type": "CTR"})
    assert result.status == Status.COMPLETED and result.payload == {"deadline": "2026-11-11T00:00:00+00:00", "calendar_basis": "business_days", "time_zone": "UTC"}
    result = await run(executor, principal, "regulatory.deadline.calculate", {"event_at": "2026-11-01T00:00:00+00:00", "report_type": "SAR"})
    assert result.status == Status.COMPLETED and result.payload == {"deadline": "2026-11-08T00:00:00+00:00", "calendar_basis": "calendar_days", "time_zone": "UTC"}


async def test_deadline_counts_utc_dates(build):
    """Offsets: under the UTC obligation 2026-11-06T20:00-05:00 is Saturday 01:00; it and 2026-11-07T01:00Z give the same CTR deadline,
    2026-11-11T01:00:00+00:00."""
    _, executor, principal = build()
    deadlines = set()
    for event_at in ("2026-11-06T20:00:00-05:00", "2026-11-07T01:00:00+00:00"):
        result = await run(executor, principal, "regulatory.deadline.calculate", {"event_at": event_at, "report_type": "CTR"})
        deadlines.add(result.payload["deadline"])
    assert deadlines == {"2026-11-11T01:00:00+00:00"}


async def test_deadline_holiday(build):
    """Holiday: with 2026-11-09 a holiday the CTR deadline from 2026-11-06T00:00Z is 2026-11-12T00:00:00+00:00."""
    _, executor, principal = build(without=("BusinessCalendar",), extra=[("BusinessCalendar", "calendar-1", {"working_weekdays": [0, 1, 2, 3, 4], "holidays": ["2026-11-09"]})])
    result = await run(executor, principal, "regulatory.deadline.calculate", {"event_at": "2026-11-06T00:00:00+00:00", "report_type": "CTR"})
    assert result.status == Status.COMPLETED and result.payload["deadline"] == "2026-11-12T00:00:00+00:00"


def zoned(zone):
    return {"reporting_obligations": [{**x, "time_zone": zone} for x in f.policy()["reporting_obligations"]]}


async def test_deadline_counts_local_dates_of_the_obligation_zone(build):
    """Obligation time zone: 2026-11-06T20:00-05:00 is Friday in America/New_York but Saturday in UTC, so the
    CTR deadline is 2026-11-11T20:00:00-05:00 (Wednesday local), a day earlier than under UTC. Daylight saving:
    SAR 7 calendar days from 2026-10-30T12:00-04:00 keep the local wall time -> 2026-11-06T12:00:00-05:00."""
    _, executor, principal = build(policy=zoned("America/New_York"))
    result = await run(executor, principal, "regulatory.deadline.calculate", {"event_at": "2026-11-06T20:00:00-05:00", "report_type": "CTR"})
    assert result.status == Status.COMPLETED
    assert result.payload == {"deadline": "2026-11-11T20:00:00-05:00", "calendar_basis": "business_days", "time_zone": "America/New_York"}
    result = await run(executor, principal, "regulatory.deadline.calculate", {"event_at": "2026-10-30T12:00:00-04:00", "report_type": "SAR"})
    assert result.payload["deadline"] == "2026-11-06T12:00:00-05:00"


async def test_deadline_without_a_known_zone(build):
    """Policy unresolved: an obligation with no time_zone is refused when the policy is admitted; an unknown zone
    -> POLICY_UNRESOLVED / BLOCKED; two CTR obligations differing only in zone -> SOURCE_CONFLICT / NEEDS_REVIEW."""
    parameters = {"event_at": "2026-11-06T00:00:00+00:00", "report_type": "CTR"}
    unzoned = {"reporting_obligations": [{k: v for k, v in x.items() if k != "time_zone"} for x in f.policy()["reporting_obligations"]]}
    with pytest.raises(SkillError, match="reporting_obligations.0: failed required"):
        build(policy=unzoned)
    _, executor, principal = build(policy=zoned("Mars/Olympus"))
    failed(await run(executor, principal, "regulatory.deadline.calculate", parameters), "POLICY_UNRESOLVED", Status.BLOCKED)
    _, executor, principal = build(policy=obligations({"id": "other-ctr", "type": "CTR", "deadline_days": 3, "business_days": True, "time_zone": "Asia/Tokyo"}))
    failed(await run(executor, principal, "regulatory.deadline.calculate", parameters), "SOURCE_CONFLICT", Status.NEEDS_REVIEW)


async def test_deadline_conflict_and_gaps(build):
    """Conflict: a second CTR obligation of 5 business days -> SOURCE_CONFLICT / NEEDS_REVIEW, neither picked.
    No business calendar for a business-day rule -> CONTEXT_MISSING / NEEDS_EVIDENCE. No obligations -> POLICY_UNRESOLVED / BLOCKED."""
    parameters = {"event_at": "2026-11-06T00:00:00+00:00", "report_type": "CTR"}
    _, executor, principal = build(policy=obligations({"id": "other-ctr", "type": "CTR", "deadline_days": 5, "business_days": True, "time_zone": "UTC"}))
    failed(await run(executor, principal, "regulatory.deadline.calculate", parameters), "SOURCE_CONFLICT", Status.NEEDS_REVIEW)
    _, executor, principal = build(without=("BusinessCalendar",))
    failed(await run(executor, principal, "regulatory.deadline.calculate", parameters), "CONTEXT_MISSING", Status.NEEDS_EVIDENCE)
    _, executor, principal = build(drop=["reporting_obligations"])
    failed(await run(executor, principal, "regulatory.deadline.calculate", parameters), "POLICY_UNRESOLVED", Status.BLOCKED)


# ----------------------------------------------------------------------- regulatory.filing.prepare

async def test_filing_prepare_normal(build):
    """Normal: the complete SAR filing -> package {filing, policy_hash, context_hash, synthetic true}, package_hash the
    digest of the package, submitted false; COMPLETED."""
    _, executor, principal = build()
    result = await run(executor, principal, "regulatory.filing.prepare", {"filing": FILING})
    assert result.status == Status.COMPLETED
    package = result.payload["package"]
    assert package["filing"] == FILING and package["synthetic"] is True and set(package) == {"filing", "policy_hash", "context_hash", "synthetic"}
    assert result.payload["package_hash"] == digest(package) and result.payload["submitted"] is False


async def test_filing_prepare_incomplete(build):
    """Incomplete: a SAR filing without citations -> the package is returned for repair, NEEDS_EVIDENCE with
    EVIDENCE_INSUFFICIENT for citations. No filing_fields -> POLICY_UNRESOLVED / BLOCKED."""
    _, executor, principal = build()
    result = await run(executor, principal, "regulatory.filing.prepare", {"filing": {k: v for k, v in FILING.items() if k != "citations"}})
    assert result.payload["submitted"] is False
    assert result.status == Status.NEEDS_EVIDENCE and items(result) == [("EVIDENCE_INSUFFICIENT", "citations")]
    _, executor, principal = build(drop=["filing_fields"])
    failed(await run(executor, principal, "regulatory.filing.prepare", {"filing": FILING}), "POLICY_UNRESOLVED", Status.BLOCKED)


# ------------------------------------------------------------------------ regulatory.filing.submit

async def submit(store, executor, principal, key):
    """Request, independently approve and run one submission of FILING under idempotency key `key`."""
    invocation = request("regulatory.filing.submit", {"filing": FILING}, idempotency_key=key)
    pending = await executor.run(invocation, principal)
    assert pending.status == Status.NEEDS_REVIEW and not pending.effects_committed
    reviewer = f.principal("reviewer")
    reviewer.permissions.add("approve:regulatory.filing.submit")
    executor.approve(pending.unresolved_items[0]["approval_id"], reviewer)
    return await executor.run(invocation, principal, approved_task=pending.unresolved_items[0]["approval_id"])


async def test_filing_submit_normal(build):
    """Normal: the complete SAR filing -> NEEDS_REVIEW with HUMAN_REVIEW_REQUIRED and nothing queued; after independent
    approval -> COMPLETED, state PENDING, submission_id digest([tenant-synthetic, submit_filing, filing])."""
    store, executor, principal = build()
    pending = await run(executor, principal, "regulatory.filing.submit", {"filing": FILING})
    assert pending.status == Status.NEEDS_REVIEW and [x["code"] for x in pending.unresolved_items] == ["HUMAN_REVIEW_REQUIRED"]
    assert store.db.execute("SELECT COUNT(*) FROM outbox").fetchone()[0] == 0
    submitted = await submit(store, executor, principal, "first")
    assert submitted.status == Status.COMPLETED
    assert submitted.payload == {"submission_id": digest([TENANT, "submit_filing", FILING]), "state": "PENDING"}


async def test_filing_submit_duplicate_is_idempotent(build):
    """Duplicate: the same filing submitted again under another idempotency key, after the first was delivered ->
    the same submission_id, state CONFIRMED, and still one outbox entry."""
    store, executor, principal = build()
    first = await submit(store, executor, principal, "first")
    OutboxWorker(store, LocalRegulator(store)).drain_submissions(TENANT)
    second = await submit(store, executor, principal, "second")
    assert second.status == Status.COMPLETED
    assert second.payload == {"submission_id": first.payload["submission_id"], "state": "CONFIRMED"}
    assert store.db.execute("SELECT COUNT(*) FROM outbox").fetchone()[0] == 1


async def test_filing_submit_refusals(build):
    """Refused: a filing without citations -> CONTROL_FAILED / BLOCKED; no filing_fields -> POLICY_UNRESOLVED / BLOCKED."""
    _, executor, principal = build()
    incomplete = {k: v for k, v in FILING.items() if k != "citations"}
    failed(await run(executor, principal, "regulatory.filing.submit", {"filing": incomplete}), "CONTROL_FAILED", Status.BLOCKED)
    _, executor, principal = build(drop=["filing_fields"])
    failed(await run(executor, principal, "regulatory.filing.submit", {"filing": FILING}), "POLICY_UNRESOLVED", Status.BLOCKED)


# ------------------------------------------------------------------------- regulatory.filing.track

def outbox(store, sid, status, receipt=None, filing=FILING):
    command = {"kind": "outbox", "id": sid, "action": "submit_filing", "filing": filing, "synthetic": True}
    store.db.execute("INSERT INTO outbox VALUES(?,?,?,?,?,?)", (TENANT, sid, "hash", status, canonical(command), canonical(receipt) if receipt is not None else None))


RECEIPT = {"receipt_id": "synthetic-sub-1", "filing_hash": digest(FILING), "accepted_by_local_test_endpoint": True, "synthetic": True}


async def test_filing_track_confirmed(build):
    """Normal: sub-1 CONFIRMED with a receipt for this filing -> state CONFIRMED and the receipt; COMPLETED."""
    store, executor, principal = build()
    outbox(store, "sub-1", "CONFIRMED", RECEIPT)
    result = await run(executor, principal, "regulatory.filing.track", {"submission_id": "sub-1"})
    assert result.status == Status.COMPLETED and result.payload == {"state": "CONFIRMED", "receipt": RECEIPT}


async def test_filing_track_not_yet_filed(build):
    """Not filed: PENDING -> PARTIAL; UNCERTAIN -> NEEDS_REVIEW; CONFIRMED without a receipt -> receipt null,
    NEEDS_REVIEW; each with EXTERNAL_ACTION_UNCONFIRMED for the submission."""
    store, executor, principal = build()
    for sid, status, expected in (("sub-p", "PENDING", Status.PARTIAL), ("sub-u", "UNCERTAIN", Status.NEEDS_REVIEW), ("sub-c", "CONFIRMED", Status.NEEDS_REVIEW)):
        outbox(store, sid, status)
        result = await run(executor, principal, "regulatory.filing.track", {"submission_id": sid})
        assert result.payload == {"state": status, "receipt": None}
        assert result.status == expected and items(result) == [("EXTERNAL_ACTION_UNCONFIRMED", sid)]


async def test_filing_track_receipt_for_another_filing(build):
    """Conflict: the receipt's filing_hash is not this filing's -> NEEDS_REVIEW with SOURCE_CONFLICT. Unknown
    submission -> CONTEXT_MISSING / NEEDS_EVIDENCE."""
    store, executor, principal = build()
    outbox(store, "sub-1", "CONFIRMED", {**RECEIPT, "filing_hash": digest({"other": True})})
    result = await run(executor, principal, "regulatory.filing.track", {"submission_id": "sub-1"})
    assert result.status == Status.NEEDS_REVIEW and items(result) == [("SOURCE_CONFLICT", "sub-1")]
    failed(await run(executor, principal, "regulatory.filing.track", {"submission_id": "sub-9"}), "CONTEXT_MISSING", Status.NEEDS_EVIDENCE)
