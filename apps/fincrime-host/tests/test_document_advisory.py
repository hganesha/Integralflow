"""System 1 advice over an adjudication (plan §6.5): questions are bounded, and answers can only add review."""
from datetime import date

import pytest

from document_factory.synthetic import generate
from kyc_documents.adjudication import adjudicate
from kyc_documents.advisory import QUESTION_SET, advisory_requests, apply_advisory

BINDING = {"id": "document.advisory.jev", "model": "typesafe/jev-1.13", "returned_model": "typesafe/jev-1.13-20260917"}


def single_route_passport():
    _, _, label = generate("passport", 0)
    pages = [p.model_dump(mode="json") for p in label.pages]
    result = adjudicate("passport", pages, {"llm": label.result.model_dump(mode="json"), "azure_di": None}, as_of=date(2026, 11, 12))
    return pages, result


def answered(kind, choice, probabilities=None):
    return {"contract": "decision.system1.v1", "status": "answered", "abstention": None,
            "answers": {kind: {"status": "answered", "answer": {"primitive": "choice", "value": choice, "confidence": None, "probabilities": probabilities}}}}


def agreed(values):
    outcome = {"path": "entity_name", "field": "entity_name", "criticality": "critical", "key_field": True, "outcome": "AGREED_GROUNDED", "rule": "R1",
               "comparator": "legal_name_equivalent", "comparison": "equivalent", "review": "standard",
               "selected": {"route": "llm", "value": values[0], "spans": []},
               "candidates": {"llm": {"value": values[0], "grounded": True}, "azure_di": {"value": values[1], "grounded": True}}}
    return {"outcomes": [outcome], "review_required": False, "inputs_digest": "0" * 64, "counts": {"AGREED_GROUNDED": 1}}


def test_single_route_critical_fields_get_a_span_question_with_the_cited_text():
    pages, result = single_route_passport()
    requests = advisory_requests("passport", pages, result)
    kinds = {(r["kind"], r["path"]) for r in requests}
    assert ("span_support", "document_number") in kinds and all(k == "span_support" for k, _ in kinds)
    request = next(r for r in requests if r["path"] == "document_number")
    state = request["request"]["state"]
    assert state["value"] in state["cited_text"] and set(request["request"]["questions"]) == {"span_support"}
    assert len(request["input_digest"]) == 64


def test_agreement_on_different_raw_text_is_asked_and_identical_agreement_is_not():
    asked = advisory_requests("certificate_of_incorporation", [], agreed(["ACME HOLDINGS LIMITED", "Acme Holdings Ltd"]))
    assert [r["kind"] for r in asked] == ["same_value"]
    assert asked[0]["request"]["state"]["readings"] == {"azure_di": "Acme Holdings Ltd", "llm": "ACME HOLDINGS LIMITED"}
    assert advisory_requests("certificate_of_incorporation", [], agreed(["ACME", "ACME"])) == []


def test_different_turns_agreement_into_conflict_and_keeps_the_deterministic_outcome():
    adjudication = agreed(["ACME HOLDINGS LIMITED", "Acme Holdings Ltd"])
    requests = advisory_requests("certificate_of_incorporation", [], adjudication)
    out = apply_advisory(adjudication, requests, {requests[0]["key"]: answered("same_value", "different", {"same": 0.1, "different": 0.85, "cannot_tell": 0.05})}, BINDING)
    (outcome,) = out["outcomes"]
    assert outcome["outcome"] == "CONFLICT" and outcome["rule"] == "R6+S1" and outcome["review"] == "required" and outcome["selected"] is None
    assert outcome["deterministic"]["outcome"] == "AGREED_GROUNDED"
    assert outcome["advisory"][0]["probabilities"] == {"same": 0.1, "different": 0.85, "cannot_tell": 0.05}
    assert outcome["advisory"][0]["effect"] == "escalated_to_conflict" and outcome["advisory"][0]["question_set"] == QUESTION_SET
    assert out["review_required"] and out["advisory"]["escalated"] == 1 and out["advisory"]["binding"] == "document.advisory.jev"
    assert adjudication["outcomes"][0]["outcome"] == "AGREED_GROUNDED"  # the input is not changed


def test_same_never_lowers_review_and_abstentions_change_nothing():
    adjudication = agreed(["ACME HOLDINGS LIMITED", "Acme Holdings Ltd"])
    requests = advisory_requests("certificate_of_incorporation", [], adjudication)
    key = requests[0]["key"]
    for result in (answered("same_value", "same"), {"status": "abstained", "abstention": {"reason": "timeout"}, "answers": {}},
                   {"status": "answered", "answers": {"same_value": {"status": "abstained", "reason": "cannot_tell"}}}, None):
        out = apply_advisory(adjudication, requests, {key: result}, BINDING)
        assert out["outcomes"][0]["outcome"] == "AGREED_GROUNDED" and out["outcomes"][0]["review"] == "standard"
        assert out["outcomes"][0]["advisory"][0]["effect"] == "none"
    out = apply_advisory(adjudication, requests, {key: {"status": "abstained", "abstention": {"reason": "unavailable"}, "answers": {}}}, BINDING)
    assert out["advisory"]["abstained"] == 1
    assert out["outcomes"][0]["advisory"][0]["reason"] == "unavailable"


def test_not_supported_is_a_hint_on_a_value_that_already_needs_review():
    pages, result = single_route_passport()
    requests = [r for r in advisory_requests("passport", pages, result) if r["path"] == "document_number"]
    out = apply_advisory(result, requests, {requests[0]["key"]: answered("span_support", "not_supported")}, BINDING)
    outcome = next(o for o in out["outcomes"] if o["path"] == "document_number")
    assert outcome["outcome"] == "SINGLE_ROUTE" and outcome["review"] == "required" and outcome["selected"]["value"]
    assert outcome["advisory"][0]["effect"] == "review_hint"


def test_two_disagreeing_classifiers_get_a_type_question_with_other_and_cannot_tell():
    pages, result = single_route_passport()
    (request,) = [r for r in advisory_requests("passport", pages, result, {"candidates": ["passport", "national_identity_card"]}) if r["kind"] == "document_type"]
    assert set(request["request"]["questions"]["document_type"]["criteria"]) == {"passport", "national_identity_card", "other", "cannot_tell"}
    out = apply_advisory(result, [request], {request["key"]: answered("document_type", "passport")}, BINDING)
    assert out["advisory"]["answered"] == 1 and out["outcomes"] == result["outcomes"]
    assert out["advisory"]["digest"] and apply_advisory(result, [request], {request["key"]: answered("document_type", "passport")}, BINDING)["advisory"]["digest"] == out["advisory"]["digest"]
