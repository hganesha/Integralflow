"""Acceptance tests for the fraud.* signal skills (fraud.document.tamper.detect has its own file).

Each test names the "Examples and acceptance" bullet it encodes in skill-content/skills/<id>.md.
Specialist detectors are driven by exact request-bound provider recordings: an INCONCLUSIVE answer
(what every sandbox simulator returns) is an evidence gap, an answer that does not cite every
record sent is refused, and an absent provider is never a clean result. The computed skills keep
unknowns, gaps and conflicts visible instead of reading them as "no fraud".
"""
import hashlib
import hmac

import pytest

from financial_crime import synthetic as f
from financial_crime.contracts import Status, canonical, digest
from financial_crime.execution import Executor
from financial_crime.providers import ProviderResponse, RecordedProvider, Router
from financial_crime.skills.fraud import SPECIALISTS
from financial_crime.store import Store

SEEDED = {(r.object_type, r.id): r for r in f.records()}
EVIDENCE = ("Evidence", "evidence-1", SEEDED[("Evidence", "evidence-1")].data)


def build(records, *, router=None, policy=None, drop=()):
    store = Store()
    data = {**f.policy(), **(policy or {})}
    for key in drop:
        data.pop(key)
    store.put(f.make_record("Policy", "synthetic-policy-v1", data))
    for object_type, object_id, payload in records:
        store.put(f.make_record(object_type, object_id, payload))
    return store, Executor(store, [f.profile()], router if router is not None else f.router())


async def run(skill_id, records, **kwargs):
    store, executor = build(records, **kwargs)
    try:
        return await executor.run(f.invocation(skill_id), f.principal())
    finally:
        store.close()


def failed(result, code, status):
    assert result.lifecycle == "FAILED" and result.payload == {}, result.model_dump()
    assert result.error["code"] == code and result.status == status


def items(result):
    return [(x["code"], x["subject_ref"]) for x in result.unresolved_items]


# ------------------------------------------------------------------------------ specialist detectors

def seeded(object_type, object_id):
    return (object_type, object_id, SEEDED[(object_type, object_id)].data)


FIRST = {"Identity": seeded("Identity", "identity-1"), "Session": seeded("Session", "session-1"),
         "AuthenticationEvent": seeded("AuthenticationEvent", "authentication-1")}
SECOND = {"Identity": ("Identity", "identity-2", {"attributes": {"name": "Bob Example", "synthetic": True}}),
          "Session": ("Session", "session-2", {"artifact_hash": digest("other-video"), "modality": "video", "challenge_id": "challenge-2"}),
          "AuthenticationEvent": ("AuthenticationEvent", "authentication-2", {"session_id": "session-2", "signals": {"failed_attempts": 4}})}
DEFINITIVE = {
    "fraud.identity.synthetic.detect": {"score": "0.91", "assessment": "SYNTHETIC_INDICATED"},
    "fraud.identity.theft.assess": {"score": "0.12", "assessment": "NO_THEFT_INDICATED"},
    "fraud.deepfake.detect": {"score": "0.88", "assessment": "MANIPULATED"},
    "fraud.liveness.verify": {"score": "0.97", "assessment": "LIVE"},
    "fraud.account_takeover.detect": {"score": "0.81", "assessment": "TAKEOVER_SUSPECTED"},
}
DETECTORS = sorted(DEFINITIVE)
SANDBOX = {"score": "0.25", "assessment": "INCONCLUSIVE", "model_version": "synthetic-recording-v1",
           "limitations": ["Synthetic control-flow fixture; no real detector executed."]}


def recorded(skill_id, records, payload, *, cite=None):
    """A recording answering exactly the request the skill builds from `records`, citing `cite` (default all)."""
    object_type, fields, capability = SPECIALISTS[skill_id]
    request = {"records": [{"id": key, **{k: data[k] for k in fields}} for _, key, data in sorted(records, key=lambda r: r[1])]}
    cited = [f.make_record(*r).ref() for r in (records if cite is None else cite)]
    response = ProviderResponse(provider_id="synthetic-recording", capability=capability, request_hash=digest(request), payload=payload,
                                evidence_refs=cited, source_version="recording-v1", coverage={"complete": True})
    return Router({capability: RecordedProvider([response])})


def answer(skill_id):
    return {**DEFINITIVE[skill_id], "model_version": "detector-v2", "limitations": ["vendor-evaluated on synthetic data only"]}


@pytest.mark.parametrize("skill_id", DETECTORS)
async def test_specialist_definitive_answer_is_relayed_without_decision(skill_id):
    """Normal input: a definitive answer citing the record sent is relayed verbatim, COMPLETED, final_decision false."""
    record = FIRST[SPECIALISTS[skill_id][0]]
    result = await run(skill_id, [record], router=recorded(skill_id, [record], answer(skill_id)))
    assert result.status == Status.COMPLETED and result.unresolved_items == []
    assert result.payload == {"assessment": answer(skill_id), "provider_id": "synthetic-recording", "synthetic": True, "final_decision": False}
    assert result.metrics.provider_calls == 1


@pytest.mark.parametrize("skill_id", DETECTORS)
async def test_specialist_inconclusive_sandbox_answer_is_an_evidence_gap(skill_id):
    """Sandbox: the simulator's INCONCLUSIVE (score 0.25) is kept in the payload but is NEEDS_EVIDENCE, never clear."""
    record = FIRST[SPECIALISTS[skill_id][0]]
    result = await run(skill_id, [record])
    assert result.status == Status.NEEDS_EVIDENCE and result.lifecycle == "SUCCEEDED"
    assert result.payload == {"assessment": SANDBOX, "provider_id": "synthetic-recording", "synthetic": True, "final_decision": False}
    assert items(result) == [("EVIDENCE_INSUFFICIENT", record[1])]


@pytest.mark.parametrize("skill_id", DETECTORS)
async def test_specialist_answer_not_citing_every_record_is_refused(skill_id):
    """Attestation: two records sent, the answer cites only the first: EVIDENCE_INSUFFICIENT / NEEDS_EVIDENCE, no payload."""
    object_type = SPECIALISTS[skill_id][0]
    records = [FIRST[object_type], SECOND[object_type]]
    result = await run(skill_id, records, router=recorded(skill_id, records, answer(skill_id), cite=records[:1]))
    failed(result, "EVIDENCE_INSUFFICIENT", Status.NEEDS_EVIDENCE)
    assert SECOND[object_type][1] in result.error["message"]


@pytest.mark.parametrize("skill_id", DETECTORS)
async def test_specialist_absent_provider_is_source_unavailable(skill_id):
    """Unavailable: no provider for the capability is SOURCE_UNAVAILABLE / NEEDS_EVIDENCE, no payload."""
    failed(await run(skill_id, [FIRST[SPECIALISTS[skill_id][0]]], router=Router()), "SOURCE_UNAVAILABLE", Status.NEEDS_EVIDENCE)


@pytest.mark.parametrize("skill_id", DETECTORS)
async def test_specialist_score_outside_zero_to_one_is_an_integrity_failure(skill_id):
    """Malformed output: score 1.5 (or no limitations) is INTEGRITY_FAILURE, no payload."""
    record = FIRST[SPECIALISTS[skill_id][0]]
    for payload in [{**answer(skill_id), "score": "1.5"}, {k: v for k, v in answer(skill_id).items() if k != "limitations"}]:
        result = await run(skill_id, [record], router=recorded(skill_id, [record], payload))
        assert result.lifecycle == "FAILED" and result.error["code"] == "INTEGRITY_FAILURE" and result.payload == {}


@pytest.mark.parametrize("skill_id", DETECTORS)
async def test_specialist_without_records_is_context_missing(skill_id):
    """Missing evidence: no admitted record of the detector's type is CONTEXT_MISSING / NEEDS_EVIDENCE."""
    failed(await run(skill_id, [EVIDENCE]), "CONTEXT_MISSING", Status.NEEDS_EVIDENCE)


# ----------------------------------------------------------------------------- fraud.device.fingerprint

DEVICE = seeded("Device", "device-1")


def expected_fingerprint(attributes):
    key = f.policy()["synthetic_fingerprint_key"].encode()
    return hmac.new(key, canonical(["tenant-synthetic", attributes]).encode(), hashlib.sha256).hexdigest()


async def test_fingerprint_keys_the_configured_device_fields():
    """Normal: device-1 (os SyntheticOS, browser SyntheticBrowser), device_fields [os, browser] -> one keyed fingerprint, COMPLETED."""
    result = await run("fraud.device.fingerprint", [DEVICE])
    assert result.status == Status.COMPLETED
    value = expected_fingerprint({"os": "SyntheticOS", "browser": "SyntheticBrowser"})
    assert result.payload == {"fingerprints": [{"device_id": "device-1", "fingerprint": value, "synthetic": True}]}


async def test_fingerprint_device_missing_a_configured_field_is_not_fingerprinted():
    """A device without browser is not fingerprinted on os alone: NEEDS_EVIDENCE, EVIDENCE_INSUFFICIENT for it."""
    partial = ("Device", "device-2", {"attributes": {"os": "SyntheticOS"}, "permitted": True})
    result = await run("fraud.device.fingerprint", [DEVICE, partial])
    assert result.status == Status.NEEDS_EVIDENCE
    assert [x["device_id"] for x in result.payload["fingerprints"]] == ["device-1"]
    assert items(result) == [("EVIDENCE_INSUFFICIENT", "device-2")]


@pytest.mark.parametrize("change", [{"drop": ("device_fields",)}, {"policy": {"device_fields": []}}, {"drop": ("synthetic_fingerprint_key",)}],
                         ids=["no-device-fields", "empty-device-fields", "no-key"])
async def test_fingerprint_policy_unresolved(change):
    """Policy unresolved: no or empty device_fields, or no fingerprint key, is POLICY_UNRESOLVED / BLOCKED."""
    failed(await run("fraud.device.fingerprint", [DEVICE], **change), "POLICY_UNRESOLVED", Status.BLOCKED)


async def test_fingerprint_unpermitted_device_is_access_denied():
    """A device not permitted for processing is ACCESS_DENIED / BLOCKED, no fingerprints."""
    denied = ("Device", "device-2", {"attributes": {"os": "SyntheticOS", "browser": "SyntheticBrowser"}, "permitted": False})
    failed(await run("fraud.device.fingerprint", [DEVICE, denied]), "ACCESS_DENIED", Status.BLOCKED)


# ------------------------------------------------------------------------------- fraud.behavior.anomaly

def session(features, baseline, key="session-1"):
    return ("Session", key, {"features": features, "baseline": baseline})


VELOCITY = {"velocity": {"minimum": "0", "maximum": "2"}}


async def test_behavior_feature_outside_baseline_is_an_anomaly():
    """Normal: velocity 3 against 0..2 is a deviation; velocity 2 (on the bound) is not, COMPLETED."""
    result = await run("fraud.behavior.anomaly", [session({"velocity": "3"}, VELOCITY), session({"velocity": "2"}, VELOCITY, "session-2")])
    assert result.status == Status.COMPLETED
    assert result.payload == {"anomalies": [{"session_id": "session-1", "feature": "velocity", "value": "3", "bounds": {"minimum": "0", "maximum": "2"}}]}


async def test_behavior_feature_without_baseline_is_unknown_not_normal():
    """A feature with no baseline (typing_speed) is UNKNOWN_BASELINE and NEEDS_EVIDENCE, not normal."""
    result = await run("fraud.behavior.anomaly", [session({"velocity": "1", "typing_speed": "40"}, VELOCITY)])
    assert result.status == Status.NEEDS_EVIDENCE
    assert result.payload == {"anomalies": [{"session_id": "session-1", "feature": "typing_speed", "status": "UNKNOWN_BASELINE"}]}
    assert items(result) == [("EVIDENCE_INSUFFICIENT", "session-1")]


async def test_behavior_session_without_observed_features_is_not_clear():
    """Absent signals: features {} with a velocity baseline has no anomaly but is NEEDS_EVIDENCE (nothing observed)."""
    result = await run("fraud.behavior.anomaly", [session({}, VELOCITY)])
    assert result.status == Status.NEEDS_EVIDENCE and result.payload == {"anomalies": []}
    assert [x["explanation"] for x in result.unresolved_items] == ["session session-1 has no observed feature", "baseline feature velocity was not observed"]


async def test_behavior_inverted_baseline_is_unknown():
    """A baseline whose minimum 5 is above its maximum 2 is unusable: UNKNOWN_BASELINE, NEEDS_EVIDENCE."""
    result = await run("fraud.behavior.anomaly", [session({"velocity": "3"}, {"velocity": {"minimum": "5", "maximum": "2"}})])
    assert result.status == Status.NEEDS_EVIDENCE
    assert result.payload == {"anomalies": [{"session_id": "session-1", "feature": "velocity", "status": "UNKNOWN_BASELINE"}]}


async def test_behavior_without_sessions_is_context_missing():
    """Missing evidence: no admitted Session is CONTEXT_MISSING / NEEDS_EVIDENCE."""
    failed(await run("fraud.behavior.anomaly", [EVIDENCE]), "CONTEXT_MISSING", Status.NEEDS_EVIDENCE)


# -------------------------------------------------------------------------------- fraud.payment.anomaly

def pay(key, amount, baseline="100"):
    return ("Payment", key, {"amount": amount, "currency": "SYN", "baseline_maximum": baseline})


async def test_payment_above_baseline_is_an_anomaly():
    """Normal: 200 SYN against a 100 baseline is an anomaly; 100 (equal) and 50 are not, COMPLETED."""
    result = await run("fraud.payment.anomaly", [pay("payment-1", "200"), pay("payment-2", "100"), pay("payment-3", "50")])
    assert result.status == Status.COMPLETED
    assert result.payload == {"anomalies": [{"payment_id": "payment-1", "amount": "200", "currency": "SYN"}]}


async def test_payment_negative_amount_is_reviewed_not_cleared():
    """Wrong direction: amount -500 is not compared and not cleared: NEEDS_REVIEW, HUMAN_REVIEW_REQUIRED for it."""
    result = await run("fraud.payment.anomaly", [pay("payment-1", "200"), pay("payment-2", "-500")])
    assert result.status == Status.NEEDS_REVIEW
    assert result.payload == {"anomalies": [{"payment_id": "payment-1", "amount": "200", "currency": "SYN"}]}
    assert items(result) == [("HUMAN_REVIEW_REQUIRED", "payment-2")]


async def test_payment_without_payments_is_context_missing():
    """Missing evidence: no admitted Payment is CONTEXT_MISSING / NEEDS_EVIDENCE."""
    failed(await run("fraud.payment.anomaly", [EVIDENCE]), "CONTEXT_MISSING", Status.NEEDS_EVIDENCE)


# ------------------------------------------------------------------------------- fraud.beneficiary.risk

def counterparty(key, indicators, evidence_ids, entity="alice"):
    return ("Counterparty", key, {"entity_id": entity, "risk_indicators": indicators, "evidence_ids": evidence_ids})


async def test_beneficiary_with_admitted_evidence_and_no_indicator():
    """Normal: alice, no indicators, citing admitted evidence-1 -> evidence_sufficient true, review_required false, COMPLETED."""
    result = await run("fraud.beneficiary.risk", [counterparty("counterparty-1", [], ["evidence-1"]), EVIDENCE])
    assert result.status == Status.COMPLETED
    assert result.payload == {"assessments": [{"entity_id": "alice", "indicators": [], "evidence_sufficient": True, "review_required": False}]}


async def test_beneficiary_indicator_requires_review():
    """A captured indicator (mule_account) sets review_required true, COMPLETED."""
    result = await run("fraud.beneficiary.risk", [counterparty("counterparty-1", ["mule_account"], ["evidence-1"]), EVIDENCE])
    assert result.status == Status.COMPLETED
    assert result.payload["assessments"][0]["review_required"] is True


@pytest.mark.parametrize("evidence_ids", [[], ["evidence-9"]], ids=["none-cited", "unadmitted"])
async def test_beneficiary_without_admitted_evidence_needs_evidence(evidence_ids):
    """Missing evidence: no citation, or only evidence-9 (not admitted) -> evidence_sufficient false, NEEDS_EVIDENCE."""
    result = await run("fraud.beneficiary.risk", [counterparty("counterparty-1", [], evidence_ids), EVIDENCE])
    assert result.status == Status.NEEDS_EVIDENCE
    assert result.payload == {"assessments": [{"entity_id": "alice", "indicators": [], "evidence_sufficient": False, "review_required": True}]}
    assert items(result) == [("EVIDENCE_INSUFFICIENT", "counterparty-1")]


async def test_beneficiary_conflicting_records_are_not_collapsed():
    """Conflict: two alice records, [] and [mule_account] -> both review_required, NEEDS_REVIEW with SOURCE_CONFLICT alice."""
    result = await run("fraud.beneficiary.risk", [counterparty("counterparty-1", [], ["evidence-1"]),
                                                  counterparty("counterparty-2", ["mule_account"], ["evidence-1"]), EVIDENCE])
    assert result.status == Status.NEEDS_REVIEW
    assert [x["review_required"] for x in result.payload["assessments"]] == [True, True]
    assert items(result) == [("SOURCE_CONFLICT", "alice")]


# -------------------------------------------------------------------------------- fraud.network.detect

def entity(key, attributes):
    return ("Entity", key, {"name": key.title(), "identifiers": [], "entity_type": "individual", "attributes": attributes})


STREET = {"address": "1 Test Street"}


async def test_network_shared_address_is_a_candidate_group():
    """Normal: acme and alice share address 1 Test Street -> one candidate group, collusion_proven false, COMPLETED."""
    result = await run("fraud.network.detect", [entity("acme", STREET), entity("alice", STREET)])
    assert result.status == Status.COMPLETED
    assert result.payload == {"candidate_groups": [{"attribute": "address", "value": "1 Test Street", "entities": ["acme", "alice"]}], "collusion_proven": False}


async def test_network_entity_without_link_attribute_is_unchecked():
    """An entity with no address (bob) was not compared: group kept, NEEDS_EVIDENCE with EVIDENCE_INSUFFICIENT for bob."""
    result = await run("fraud.network.detect", [entity("acme", STREET), entity("alice", STREET), entity("bob", {})])
    assert result.status == Status.NEEDS_EVIDENCE
    assert len(result.payload["candidate_groups"]) == 1
    assert items(result) == [("EVIDENCE_INSUFFICIENT", "bob")]


async def test_network_single_comparable_entity_is_not_no_network():
    """Only acme carries an address: no group, but NEEDS_EVIDENCE (nothing was compared), not a clean result."""
    result = await run("fraud.network.detect", [entity("acme", STREET)])
    assert result.status == Status.NEEDS_EVIDENCE and result.payload == {"candidate_groups": [], "collusion_proven": False}
    assert items(result) == [("EVIDENCE_INSUFFICIENT", None)]


@pytest.mark.parametrize("change", [{"drop": ("link_attributes",)}, {"policy": {"link_attributes": []}}], ids=["absent", "empty"])
async def test_network_policy_unresolved(change):
    """Policy unresolved: no or empty link_attributes is POLICY_UNRESOLVED / BLOCKED, not an empty group list."""
    failed(await run("fraud.network.detect", [entity("acme", STREET), entity("alice", STREET)], **change), "POLICY_UNRESOLVED", Status.BLOCKED)


# ----------------------------------------------------------------------------------- fraud.case.assess

def signal(key, score, kind="behavior", evidence_ids=("evidence-1",)):
    return ("FraudSignal", key, {"kind": kind, "score": score, "model_version": "detector-v1", "evidence_ids": list(evidence_ids)})


@pytest.mark.parametrize("score,recommendation", [("0.8", "STEP_UP_OR_ESCALATE"), ("0.7", "STEP_UP_OR_ESCALATE"), ("0.5", "REVIEW_FOR_CLEARANCE")])
async def test_case_signal_against_pinned_threshold(score, recommendation):
    """Normal: a behavior signal at or above the 0.7 threshold escalates; 0.5 is REVIEW_FOR_CLEARANCE; COMPLETED, final false."""
    result = await run("fraud.case.assess", [signal("signal-1", score), EVIDENCE])
    assert result.status == Status.COMPLETED
    assert result.payload["recommendation"] == recommendation and result.payload["final"] is False
    assert [x["id"] for x in result.payload["signals"]] == ["signal-1"]


async def test_case_kind_without_threshold_is_unresolved():
    """A velocity signal has no pinned threshold: recommendation REVIEW, NEEDS_REVIEW with POLICY_UNRESOLVED for it."""
    result = await run("fraud.case.assess", [signal("signal-2", "0.9", kind="velocity"), EVIDENCE])
    assert result.status == Status.NEEDS_REVIEW and result.payload["recommendation"] == "REVIEW"
    assert items(result) == [("POLICY_UNRESOLVED", "signal-2")]


async def test_case_elevated_signal_is_not_softened_by_another_gap():
    """Conflict: behavior 0.8 (elevated) plus an uncited signal -> still STEP_UP_OR_ESCALATE, NEEDS_REVIEW, both signals kept."""
    result = await run("fraud.case.assess", [signal("signal-1", "0.8"), signal("signal-2", "0.1", evidence_ids=()), EVIDENCE])
    assert result.status == Status.NEEDS_REVIEW and result.payload["recommendation"] == "STEP_UP_OR_ESCALATE"
    assert [x["id"] for x in result.payload["signals"]] == ["signal-1", "signal-2"]
    assert items(result) == [("EVIDENCE_INSUFFICIENT", "signal-2")]


async def test_case_without_thresholds_is_policy_unresolved():
    """Policy unresolved: no fraud_thresholds is POLICY_UNRESOLVED / BLOCKED, no recommendation."""
    failed(await run("fraud.case.assess", [signal("signal-1", "0.8"), EVIDENCE], drop=("fraud_thresholds",)), "POLICY_UNRESOLVED", Status.BLOCKED)


async def test_case_without_signals_is_context_missing():
    """Missing evidence: no admitted FraudSignal is CONTEXT_MISSING / NEEDS_EVIDENCE."""
    failed(await run("fraud.case.assess", [EVIDENCE]), "CONTEXT_MISSING", Status.NEEDS_EVIDENCE)
