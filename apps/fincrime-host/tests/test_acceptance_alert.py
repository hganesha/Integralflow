"""Acceptance tests for the alert.* triage skills.

Each test encodes an "Examples and acceptance" bullet of skill-content/skills/<id>.md: the registered
handler runs through the Executor against an explicit record set and pinned policy, and the exact
status, payload and error or unresolved-item codes are asserted. Missing policy is BLOCKED, unknown
rules and severities stay visible, and nothing is cleared, merged or dropped on incomplete input.
"""
from datetime import timedelta

import pytest

from financial_crime import synthetic as f
from financial_crime.contracts import Record, Status, digest
from financial_crime.execution import Executor
from financial_crime.store import Store

EVIDENCE = ("Evidence", "evidence-1", {"content": "Registry extract: Acme is ACTIVE.", "content_hash": digest("Registry extract: Acme is ACTIVE."),
                                        "source_id": "source-1", "requirement_ids": ["identity"], "verified": True})


async def execute(skill_id, rows=(), *, policy=None, drop=(), parameters=None):
    """Run one skill against exactly `rows` (tuples or Records) and a pinned policy."""
    store = Store()
    try:
        pinned = {**f.policy(), **(policy or {})}
        for name in drop:
            pinned.pop(name, None)
        store.put(f.make_record("Policy", "synthetic-policy-v1", pinned))
        for row in rows:
            store.put(row if isinstance(row, Record) else f.make_record(*row))
        executor = Executor(store, [f.profile()], f.router())
        overrides = {} if parameters is None else {"parameters": parameters}
        return await executor.run(f.invocation(skill_id, **overrides), f.principal())
    finally:
        store.close()


def alert(key, *, source=None, rule="synthetic-rule", subject="acme", severity="HIGH", events=("tx-1",)):
    return ("Alert", key, {"source_id": source or f"source-{key}", "rule_id": rule, "subject": subject, "severity": severity, "event_ids": list(events)})


def finding(key, evidence_ids, *, status="RESOLVED", claim="Acme is an active company."):
    return ("Finding", key, {"claim": claim, "evidence_ids": list(evidence_ids), "status": status})


def items(result):
    return [(x["code"], x["subject_ref"]) for x in result.unresolved_items]


def failed(result, code, status):
    assert result.lifecycle == "FAILED" and result.payload == {}, result.model_dump()
    assert result.error["code"] == code and result.status == status


def ids(rows):
    return [x["id"] for x in rows]


# --------------------------------------------------------------------------- alert.ingest

async def test_ingest_keeps_alerts_from_distinct_sources():
    """Normal input: alert-1 and alert-2 from different source alerts are both ingested, COMPLETED."""
    result = await execute("alert.ingest", [alert("alert-1"), alert("alert-2")])
    assert result.status == Status.COMPLETED and ids(result.payload["alerts"]) == ["alert-1", "alert-2"]


async def test_ingest_collapses_an_identical_redelivery():
    """alert-1 and alert-2 carry source alert s-1 with the same rule, subject and severity: only alert-1 is kept, COMPLETED."""
    result = await execute("alert.ingest", [alert("alert-1", source="s-1"), alert("alert-2", source="s-1")])
    assert result.status == Status.COMPLETED and ids(result.payload["alerts"]) == ["alert-1"]


async def test_ingest_keeps_conflicting_records_of_one_source():
    """Same source s-1 but alert-2 is LOW: both are kept, NEEDS_REVIEW with SOURCE_CONFLICT for s-1."""
    result = await execute("alert.ingest", [alert("alert-1", source="s-1"), alert("alert-2", source="s-1", severity="LOW")])
    assert result.status == Status.NEEDS_REVIEW and items(result) == [("SOURCE_CONFLICT", "s-1")]
    assert ids(result.payload["alerts"]) == ["alert-1", "alert-2"]


async def test_ingest_without_alerts_needs_evidence():
    """Missing evidence: no Alert is CONTEXT_MISSING / NEEDS_EVIDENCE."""
    failed(await execute("alert.ingest"), "CONTEXT_MISSING", Status.NEEDS_EVIDENCE)


# --------------------------------------------------------------------------- alert.classify

async def test_classify_maps_pinned_rules():
    """Normal input: synthetic-rule is classified AML, COMPLETED."""
    result = await execute("alert.classify", [alert("alert-1")])
    assert result.status == Status.COMPLETED and result.payload == {"classifications": [{"id": "alert-1", "type": "AML"}]}


async def test_classify_unknown_rule_stays_visible():
    """A rule with no pinned type is UNKNOWN: NEEDS_REVIEW with POLICY_UNRESOLVED for that alert; the other keeps AML."""
    result = await execute("alert.classify", [alert("alert-1"), alert("alert-2", rule="other-rule")])
    assert result.status == Status.NEEDS_REVIEW and items(result) == [("POLICY_UNRESOLVED", "alert-2")]
    assert result.payload == {"classifications": [{"id": "alert-1", "type": "AML"}, {"id": "alert-2", "type": "UNKNOWN"}]}


@pytest.mark.parametrize("policy,drop", [({}, ("alert_types",)), ({"alert_types": {}}, ())], ids=["absent", "empty"])
async def test_classify_without_taxonomy_is_blocked(policy, drop):
    """Policy unresolved: no or empty alert_types is POLICY_UNRESOLVED / BLOCKED, not every alert UNKNOWN."""
    failed(await execute("alert.classify", [alert("alert-1")], policy=policy, drop=drop), "POLICY_UNRESOLVED", Status.BLOCKED)


# --------------------------------------------------------------------------- alert.prioritize

async def test_prioritize_ranks_by_weight_then_id():
    """Normal input: LOW alert-1, HIGH alert-2 and HIGH alert-3 rank alert-2, alert-3 (3) before alert-1 (1), COMPLETED."""
    result = await execute("alert.prioritize", [alert("alert-1", severity="LOW"), alert("alert-2"), alert("alert-3")])
    assert result.status == Status.COMPLETED
    assert result.payload == {"ranked": [{"id": "alert-2", "priority": 3, "severity": "HIGH"}, {"id": "alert-3", "priority": 3, "severity": "HIGH"},
                                         {"id": "alert-1", "priority": 1, "severity": "LOW"}]}


async def test_prioritize_unweighted_severity_is_ranked_at_the_top():
    """An UNKNOWN severity has no weight: it takes the top weight 3, ahead of LOW, NEEDS_REVIEW with POLICY_UNRESOLVED."""
    result = await execute("alert.prioritize", [alert("alert-1", severity="LOW"), alert("alert-2", severity="UNKNOWN")])
    assert result.status == Status.NEEDS_REVIEW and items(result) == [("POLICY_UNRESOLVED", "alert-2")]
    assert result.payload == {"ranked": [{"id": "alert-2", "priority": 3, "severity": "UNKNOWN"}, {"id": "alert-1", "priority": 1, "severity": "LOW"}]}


async def test_prioritize_without_weights_is_blocked():
    """Policy unresolved: no alert_priority is POLICY_UNRESOLVED / BLOCKED, never every alert at priority 0."""
    failed(await execute("alert.prioritize", [alert("alert-1")], drop=("alert_priority",)), "POLICY_UNRESOLVED", Status.BLOCKED)


# --------------------------------------------------------------------------- alert.deduplicate

async def test_deduplicate_groups_same_subject_rule_and_events():
    """Normal input: alert-1 [tx-1, tx-2] and alert-2 [tx-2, tx-1] are grouped; alert-3 [tx-3] is not; COMPLETED."""
    rows = [alert("alert-1", events=["tx-1", "tx-2"]), alert("alert-2", events=["tx-2", "tx-1"]), alert("alert-3", events=["tx-3"])]
    result = await execute("alert.deduplicate", rows)
    assert result.status == Status.COMPLETED and result.payload == {"groups": [["alert-1", "alert-2"]]}


async def test_deduplicate_does_not_merge_different_severities():
    """Same events but alert-2 is LOW: not grouped, NEEDS_REVIEW with SOURCE_CONFLICT for alert-1."""
    result = await execute("alert.deduplicate", [alert("alert-1"), alert("alert-2", severity="LOW")])
    assert result.status == Status.NEEDS_REVIEW and items(result) == [("SOURCE_CONFLICT", "alert-1")]
    assert result.payload == {"groups": []}


async def test_deduplicate_alerts_without_events_are_not_compared():
    """Two acme alerts naming no event are not grouped: NEEDS_EVIDENCE with EVIDENCE_INSUFFICIENT for each."""
    result = await execute("alert.deduplicate", [alert("alert-1", events=[]), alert("alert-2", events=[])])
    assert result.status == Status.NEEDS_EVIDENCE and items(result) == [("EVIDENCE_INSUFFICIENT", "alert-1"), ("EVIDENCE_INSUFFICIENT", "alert-2")]
    assert result.payload == {"groups": []}


# --------------------------------------------------------------------------- alert.correlate

async def test_correlate_links_only_through_a_shared_attribute():
    """alert-1 (acme, tx-1) and alert-2 (alice, tx-1, tx-2) share tx-1; alert-3 (acme, tx-9) shares acme with alert-1; alert-4 (bob, tx-8) is unlinked."""
    rows = [alert("alert-1"), alert("alert-2", subject="alice", events=["tx-1", "tx-2"]), alert("alert-3", events=["tx-9"]),
            alert("alert-4", subject="bob", events=["tx-8"])]
    result = await execute("alert.correlate", rows)
    assert result.status == Status.COMPLETED
    assert result.payload == {"links": [{"left": "alert-1", "right": "alert-2", "shared_subject": False, "shared_events": ["tx-1"]},
                                        {"left": "alert-1", "right": "alert-3", "shared_subject": True, "shared_events": []}]}


async def test_correlate_unrelated_alerts_have_no_link():
    """Different subjects and no shared event: links [], COMPLETED."""
    result = await execute("alert.correlate", [alert("alert-1"), alert("alert-2", subject="alice", events=["tx-2"])])
    assert result.status == Status.COMPLETED and result.payload == {"links": []}


# --------------------------------------------------------------------------- alert.context.assemble

async def test_context_assemble_is_stable():
    """Normal input: alert-1 with tx-1 is assembled with a 64-hex manifest_hash; the same request gives the same hash; COMPLETED."""
    first, second = await execute("alert.context.assemble", [alert("alert-1")]), await execute("alert.context.assemble", [alert("alert-1")])
    assert first.status == Status.COMPLETED and ids(first.payload["alerts"]) == ["alert-1"]
    assert len(first.payload["manifest_hash"]) == 64 and first.payload["manifest_hash"] == second.payload["manifest_hash"]


async def test_context_assemble_alert_without_events_is_incomplete():
    """alert-2 names no event: both alerts are returned, NEEDS_EVIDENCE with EVIDENCE_INSUFFICIENT for alert-2."""
    result = await execute("alert.context.assemble", [alert("alert-1"), alert("alert-2", events=[])])
    assert result.status == Status.NEEDS_EVIDENCE and items(result) == [("EVIDENCE_INSUFFICIENT", "alert-2")]
    assert ids(result.payload["alerts"]) == ["alert-1", "alert-2"]


# --------------------------------------------------------------------------- alert.false_positive.assess

async def test_false_positive_supported_exculpatory_evidence():
    """Normal input: f1 EXCULPATORY citing admitted evidence-1 is exculpatory; contradictory []; final_clearance false; COMPLETED."""
    result = await execute("alert.false_positive.assess", [EVIDENCE, finding("f1", ["evidence-1"], status="EXCULPATORY")])
    assert result.status == Status.COMPLETED
    assert (ids(result.payload["exculpatory"]), result.payload["contradictory"], result.payload["final_clearance"]) == (["f1"], [], False)


async def test_false_positive_unadmitted_citation_supports_nothing():
    """f1 EXCULPATORY cites evidence-9, which is not admitted: exculpatory [], NEEDS_EVIDENCE with EVIDENCE_INSUFFICIENT for f1."""
    result = await execute("alert.false_positive.assess", [EVIDENCE, finding("f1", ["evidence-9"], status="EXCULPATORY")])
    assert result.status == Status.NEEDS_EVIDENCE and items(result) == [("EVIDENCE_INSUFFICIENT", "f1")]
    assert result.payload["exculpatory"] == [] and result.payload["final_clearance"] is False


async def test_false_positive_contradicted_exculpatory_evidence_needs_review():
    """f1 EXCULPATORY (admitted) with f2 DISPUTED: both kept, NEEDS_REVIEW with SOURCE_CONFLICT for f2, final_clearance false."""
    rows = [EVIDENCE, finding("f1", ["evidence-1"], status="EXCULPATORY"), finding("f2", ["evidence-1"], status="DISPUTED")]
    result = await execute("alert.false_positive.assess", rows)
    assert result.status == Status.NEEDS_REVIEW and items(result) == [("SOURCE_CONFLICT", "f2")]
    assert (ids(result.payload["exculpatory"]), ids(result.payload["contradictory"]), result.payload["final_clearance"]) == (["f1"], ["f2"], False)


@pytest.mark.parametrize("status", ["INDICATOR", "UNRESOLVED", "DISPUTED", "UNVERIFIED"])
async def test_false_positive_open_finding_only_is_not_cleared(status):
    """Only f2 INDICATOR (or UNRESOLVED, DISPUTED, UNVERIFIED): exculpatory [], contradictory [f2], final_clearance false, COMPLETED."""
    result = await execute("alert.false_positive.assess", [EVIDENCE, finding("f2", ["evidence-1"], status=status)])
    assert result.status == Status.COMPLETED
    assert (result.payload["exculpatory"], ids(result.payload["contradictory"]), result.payload["final_clearance"]) == ([], ["f2"], False)


# --------------------------------------------------------------------------- alert.escalation.evaluate

async def test_escalation_follows_pinned_severities():
    """Normal input: HIGH alert-1 escalates, LOW alert-2 does not; COMPLETED."""
    result = await execute("alert.escalation.evaluate", [alert("alert-1"), alert("alert-2", severity="LOW")])
    assert result.status == Status.COMPLETED and result.payload == {"escalations": ["alert-1"]}


async def test_escalation_unknown_severity_is_escalated():
    """alert-3 of UNKNOWN severity is escalated: NEEDS_REVIEW with HUMAN_REVIEW_REQUIRED for alert-3."""
    result = await execute("alert.escalation.evaluate", [alert("alert-2", severity="LOW"), alert("alert-3", severity="UNKNOWN")])
    assert result.status == Status.NEEDS_REVIEW and items(result) == [("HUMAN_REVIEW_REQUIRED", "alert-3")]
    assert result.payload == {"escalations": ["alert-3"]}


@pytest.mark.parametrize("policy,drop", [({}, ("escalation_severities",)), ({"escalation_severities": []}, ())], ids=["absent", "empty"])
async def test_escalation_without_rules_is_blocked(policy, drop):
    """Policy unresolved: no or empty escalation_severities is POLICY_UNRESOLVED / BLOCKED, not "nothing escalates"."""
    failed(await execute("alert.escalation.evaluate", [alert("alert-1")], policy=policy, drop=drop), "POLICY_UNRESOLVED", Status.BLOCKED)


# --------------------------------------------------------------------------- alert.disposition.recommend

async def test_disposition_settled_and_cited_findings_allow_closure_review():
    """Normal input: f1 RESOLVED citing admitted evidence-1 is REVIEW_FOR_CLOSURE, reason_ids [], COMPLETED."""
    result = await execute("alert.disposition.recommend", [EVIDENCE, finding("f1", ["evidence-1"])])
    assert result.status == Status.COMPLETED and result.payload == {"recommendation": "REVIEW_FOR_CLOSURE", "reason_ids": []}


@pytest.mark.parametrize("status", ["INDICATOR", "UNRESOLVED", "DISPUTED", "UNVERIFIED"])
async def test_disposition_open_finding_escalates(status):
    """f1 RESOLVED plus a cited f2 that is INDICATOR, UNRESOLVED, DISPUTED or UNVERIFIED: ESCALATE with reason_ids [f2], COMPLETED."""
    result = await execute("alert.disposition.recommend", [EVIDENCE, finding("f1", ["evidence-1"]), finding("f2", ["evidence-1"], status=status)])
    assert result.status == Status.COMPLETED and result.payload == {"recommendation": "ESCALATE", "reason_ids": ["f2"]}


@pytest.mark.parametrize("rows", [pytest.param([EVIDENCE, finding("f1", ["evidence-9"])], id="unadmitted"),
                                  pytest.param([EVIDENCE, finding("f1", [])], id="uncited"),
                                  pytest.param([finding("f1", ["evidence-1"])], id="no-evidence-admitted")])
async def test_disposition_unsupported_finding_is_never_closed(rows):
    """f1 RESOLVED citing evidence-9 (not admitted), citing nothing, or citing evidence-1 with no Evidence admitted: ESCALATE [f1],
    NEEDS_EVIDENCE with EVIDENCE_INSUFFICIENT for f1."""
    result = await execute("alert.disposition.recommend", rows)
    assert result.status == Status.NEEDS_EVIDENCE and items(result) == [("EVIDENCE_INSUFFICIENT", "f1")]
    assert result.payload == {"recommendation": "ESCALATE", "reason_ids": ["f1"]}


# --------------------------------------------------------------------------- alert.feedback.capture

async def test_feedback_each_capture_is_its_own_record(environment):
    """Normal input: alert-1 labelled reviewed is stored under digest([tenant, key, parameters, actor])[:20], model_changed false;
    the same label under another idempotency key is a second record, the first is not written over."""
    store, executor, principal = environment
    request = f.invocation("alert.feedback.capture")
    first = await executor.run(request, principal)
    expected = digest(["tenant-synthetic", "alert.feedback.capture-example", request.parameters, "analyst"])[:20]
    assert first.status == Status.COMPLETED and first.payload == {"feedback_id": expected, "model_changed": False}
    second = await executor.run(request.model_copy(update={"idempotency_key": "feedback-again"}), principal)
    assert second.status == Status.COMPLETED and second.payload["feedback_id"] != expected
    for fid in (expected, second.payload["feedback_id"]):
        assert store.state("tenant-synthetic", "feedback", fid) == (1, {**request.parameters, "actor": "analyst"})


async def test_feedback_existing_record_is_never_overwritten(environment):
    """A feedback record already stored under the computed id is CONTROL_FAILED / BLOCKED, and the record is unchanged."""
    store, executor, principal = environment
    request = f.invocation("alert.feedback.capture")
    fid = digest(["tenant-synthetic", request.idempotency_key, request.parameters, "analyst"])[:20]
    store.set_state("tenant-synthetic", "feedback", fid, 0, {"alert_id": "alert-1", "label": "earlier", "reason": "kept", "actor": "analyst"})
    failed(await executor.run(request, principal), "CONTROL_FAILED", Status.BLOCKED)
    assert store.state("tenant-synthetic", "feedback", fid)[1]["label"] == "earlier"


async def test_feedback_changed_parameters_cannot_reuse_the_key(environment):
    """Retry: the same request returns the stored result; label changed on the same key is IDEMPOTENCY_CONFLICT."""
    _, executor, principal = environment
    request = f.invocation("alert.feedback.capture")
    first = await executor.run(request, principal)
    assert await executor.run(request, principal) == first
    changed = request.model_copy(update={"parameters": {**request.parameters, "label": "changed"}})
    assert (await executor.run(changed, principal)).error["code"] == "IDEMPOTENCY_CONFLICT"


# --------------------------------------------------------------------------- missing evidence / retry / changed basis

@pytest.mark.parametrize("skill_id", ["alert.classify", "alert.prioritize", "alert.deduplicate", "alert.correlate", "alert.context.assemble",
                                      "alert.escalation.evaluate", "alert.false_positive.assess", "alert.disposition.recommend"])
async def test_without_required_records_needs_evidence(skill_id):
    """Missing evidence: no admitted Alert (or Finding) is CONTEXT_MISSING / NEEDS_EVIDENCE, never an empty success."""
    failed(await execute(skill_id), "CONTEXT_MISSING", Status.NEEDS_EVIDENCE)


SKILLS = ["alert.ingest", "alert.classify", "alert.prioritize", "alert.deduplicate", "alert.correlate", "alert.context.assemble",
          "alert.false_positive.assess", "alert.escalation.evaluate", "alert.disposition.recommend", "alert.feedback.capture"]


@pytest.mark.parametrize("skill_id", SKILLS)
async def test_retry_is_stable_and_changed_request_cannot_reuse_key(skill_id, environment):
    """Changed basis or retry: an identical retry returns the stored result; a changed request on the same key is IDEMPOTENCY_CONFLICT."""
    _, executor, principal = environment
    request = f.invocation(skill_id)
    first = await executor.run(request, principal)
    assert first.error is None and first.status == Status.COMPLETED
    assert await executor.run(request, principal) == first
    changed = request.model_copy(update={"as_of_time": f.AT - timedelta(seconds=1)})
    assert (await executor.run(changed, principal)).error["code"] == "IDEMPOTENCY_CONFLICT"
