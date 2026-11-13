"""Golden tests for deterministic route adjudication: one or more cases per decision-table row."""
import copy
from datetime import date

import pytest
from pydantic import ValidationError

from kyc_documents.adjudication import DEFAULT_POLICY, AdjudicationPolicy, LightReview, adjudicate, is_current
from kyc_documents.fields import FIELDS
from kyc_documents.profiles import PROFILES
from kyc_documents.runtime import _leaves, contract, source_digest

TYPE = "certificate_of_incorporation"
TEXT = ("CERTIFICATE OF INCORPORATION\nCompany: Northmock Limited\nCompany number SY111111\nPreviously filed as SY222222\n"
        "Incorporated on 2020-03-12 in England and Wales\nDated 03/12/2020\n")
PAGES = [{"page_id": "p1", "document_version": "v" * 64, "text": TEXT}]
AS_OF = date(2026, 11, 12)


def answer(values: dict, cite: dict | None = None) -> dict:
    """A contract-valid answer: each present value cites its first literal occurrence, or the quote in `cite`."""
    cite = cite or {}
    fields = {name: values.get(name) for name in PROFILES[TYPE].field_names}
    observations = []
    for name in PROFILES[TYPE].field_names:
        for path, value, _ in _leaves(fields[name], FIELDS[name].value_type, "/extracted_fields/" + name):
            if value is None:
                observations.append({"path": path, "status": "not_present", "confidence": None, "spans": [], "note": None})
                continue
            quote = cite.get(name, value)
            start = TEXT.index(quote)
            observations.append({"path": path, "status": "present", "confidence": None, "note": None,
                                 "spans": [{"page_id": "p1", "start": start, "end": start + len(quote), "quote": quote}]})
    return {"document_type": TYPE, "profile_version": PROFILES[TYPE].version, "contract_hash": contract(TYPE)["contract_hash"],
            "document_version": "v" * 64, "source_digest": source_digest(PAGES), "extracted_fields": fields, "observations": observations}


BASE = {"entity_name": "Northmock Limited", "registration_number": "SY111111", "formation_date": "2020-03-12",
        "formation_jurisdiction": "England and Wales"}


def outcome(result, field):
    return next(o for o in result["outcomes"] if o["field"] == field)


def run(a, b, **kwargs):
    return adjudicate(TYPE, PAGES, {"azure_di": a, "llm": b}, as_of=AS_OF, **kwargs)


def test_r1_agreement_with_every_candidate_grounded():
    result = run(answer(BASE), answer(BASE))
    o = outcome(result, "entity_name")
    assert (o["rule"], o["outcome"], o["review"], o["criticality"]) == ("R1", "AGREED_GROUNDED", "standard", "critical")
    assert o["selected"]["value"] == "Northmock Limited" and o["selected"]["spans"][0]["quote"] == "Northmock Limited"
    assert result["promotion_allowed"] is False and result["epistemic_status"] == "EXTRACTED_ASSERTION"


def test_r2_one_grounded_value_is_selected_and_critical_fields_need_review():
    normalized = answer({**BASE, "registration_number": "SY 111 111"}, cite={"registration_number": "SY111111"})
    o = outcome(run(answer(BASE), normalized), "registration_number")
    assert (o["rule"], o["outcome"], o["review"]) == ("R2", "SELECTED_GROUNDED", "required")
    assert o["selected"]["route"] == "azure_di" and o["candidates"]["llm"]["grounded"] is False
    misread = answer({**BASE, "registration_number": "SY999999"}, cite={"registration_number": "SY111111"})
    o = outcome(run(answer(BASE), misread), "registration_number")
    assert (o["rule"], o["outcome"], o["comparison"]) == ("R2", "SELECTED_GROUNDED", "different")


def test_r3_one_route_states_absent_and_r4_only_one_route_ran():
    without = {k: v for k, v in BASE.items() if k != "formation_jurisdiction"}
    o = outcome(run(answer(BASE), answer(without)), "formation_jurisdiction")
    assert (o["rule"], o["outcome"], o["review"]) == ("R3", "SINGLE_ROUTE", "required")
    result = run(answer(BASE), None)
    assert result["routes"]["llm"]["status"] == "not_run"
    assert {outcome(result, f)["rule"] for f in BASE} == {"R4"}


def test_r5_no_grounded_candidate():
    loose = answer({**BASE, "registration_number": "SY-111111"}, cite={"registration_number": "SY111111"})
    o = outcome(run(loose, loose), "registration_number")
    assert (o["rule"], o["outcome"], o["selected"]) == ("R5", "UNGROUNDED", None)


def test_r6_conflicting_grounded_values_and_undecidable_comparisons():
    o = outcome(run(answer(BASE), answer({**BASE, "registration_number": "SY222222"})), "registration_number")
    assert (o["rule"], o["outcome"], o["selected"], o["review"]) == ("R6", "CONFLICT", None, "required")
    assert {c["value"] for c in o["candidates"].values()} == {"SY111111", "SY222222"}
    partial = answer({**BASE, "formation_date": "2020-03"})
    o = outcome(run(answer(BASE), partial), "formation_date")
    assert (o["rule"], o["outcome"], o["comparison"]) == ("R6", "CONFLICT", "ambiguous")


def test_r7_a_selected_value_that_fails_a_policy_validator_escalates():
    o = outcome(adjudicate(TYPE, PAGES, {"azure_di": answer(BASE), "llm": answer(BASE)}, as_of=date(2019, 1, 1)), "formation_date")
    assert (o["rule"], o["outcome"], o["selected"], o["review"]) == ("R7", "VALIDATION_FAILED", None, "required")


def test_r8_a_key_field_no_route_found():
    without = {k: v for k, v in BASE.items() if k != "registration_number"}
    o = outcome(run(answer(without), answer(without)), "registration_number")
    assert (o["rule"], o["outcome"], o["review"], o["key_field"]) == ("R8", "NOT_PRESENT", "required", True)


def test_r9_a_vision_reading_that_differs_is_reported_not_resolved():
    vision = answer({**BASE, "registration_number": "SY222222"})
    result = adjudicate(TYPE, PAGES, {"azure_di": answer(BASE), "llm": answer(BASE), "vision": vision}, vision_routes=("vision",), as_of=AS_OF)
    o = outcome(result, "registration_number")
    assert (o["rule"], o["outcome"], o["selected"]) == ("R9", "OCR_DISAGREEMENT", None)
    assert outcome(result, "entity_name")["outcome"] == "AGREED_GROUNDED"


def test_an_answer_that_fails_validation_is_unusable_as_a_whole():
    tampered = answer(BASE)
    next(o for o in tampered["observations"] if o["status"] == "present")["spans"][0]["quote"] = "TAMPERED"
    result = run(answer(BASE), tampered)
    assert result["routes"]["llm"]["status"] == "integrity_failure" and "SOURCE_SPAN_MISMATCH" in result["routes"]["llm"]["issues"]
    assert outcome(result, "entity_name")["rule"] == "R4"
    failed = run(tampered, copy.deepcopy(tampered))
    assert failed["review_required"] is True


def test_light_review_only_with_a_qualified_policy_and_never_above_its_criticality():
    policy = AdjudicationPolicy(policy_id="t", version="1", criticality={**DEFAULT_POLICY.criticality},
                                light_review=LightReview(qualification_ref="eval:report-123", max_criticality="material"))
    result = run(answer(BASE), answer(BASE), policy=policy)
    assert outcome(result, "formation_jurisdiction")["review"] == "light"
    assert outcome(result, "entity_name")["review"] == "standard"


def test_tenant_overlays_may_only_tighten():
    tighter = DEFAULT_POLICY.tightened(AdjudicationPolicy(policy_id="tenant", version="1", criticality={"formation_jurisdiction": "critical"},
                                                         validators={"formation_date": ("date_not_future",)}))
    assert tighter.criticality_of("formation_jurisdiction") == "critical" and tighter.criticality_of("entity_name") == "critical"
    with pytest.raises(ValueError, match="lowers"):
        DEFAULT_POLICY.tightened(AdjudicationPolicy(policy_id="tenant", version="1", criticality={"entity_name": "informational"}))
    with pytest.raises(ValueError, match="light review"):
        DEFAULT_POLICY.tightened(AdjudicationPolicy(policy_id="tenant", version="1", light_review=LightReview(qualification_ref="x")))
    with pytest.raises(ValidationError):
        AdjudicationPolicy(policy_id="x", version="1", criticality={"not_a_field": "critical"})


def test_results_pin_their_inputs_and_go_stale_when_one_changes():
    a, b = answer(BASE), answer(BASE)
    result = run(a, b)
    assert is_current(result, TYPE, PAGES, {"azure_di": a, "llm": b})
    assert not is_current(result, TYPE, PAGES, {"azure_di": a, "llm": answer({**BASE, "entity_name": None})})
    assert result == run(a, b)
