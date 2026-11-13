"""Route A answers from provider field candidates, and adjudicated answers, are contract-valid catalog answers."""
from datetime import date

import pytest

from document_factory.synthetic import generate
from kyc_documents.adjudication import adjudicate
from kyc_documents.route_answers import answer_from_adjudication, answer_from_model_fields
from kyc_documents.runtime import validate_extraction


def sample(document_type, seed=0):
    _, _, label = generate(document_type, seed)
    return label, [p.model_dump(mode="json") for p in label.pages]


def model_fields(document_type, fields):
    return {"contract": "document.model_fields.v1", "provider": "azure_document_intelligence", "model": "prebuilt-idDocument",
            "document_type": document_type, "source_sha256": "0" * 64, "fields": fields}


def test_candidates_are_anchored_on_the_page_text_with_the_providers_confidence():
    label, pages = sample("passport")
    gold = label.result.extracted_fields
    answer, report = answer_from_model_fields("passport", pages, model_fields("passport", [
        {"path": "/extracted_fields/document_number", "value": gold["document_number"], "content": gold["document_number"], "confidence": 0.77},
        {"path": "/extracted_fields/date_of_birth", "value": gold["date_of_birth"], "content": gold["date_of_birth"], "confidence": 0.8},
        {"path": "/extracted_fields/person_name", "value": gold["person_name"], "content": None, "confidence": 0.7, "transform": "join_given_family"},
    ]))
    assert validate_extraction("passport", answer, pages)["valid"]
    assert report["anchored"] == ["/extracted_fields/document_number", "/extracted_fields/date_of_birth", "/extracted_fields/person_name"]
    observation = next(o for o in answer["observations"] if o["path"] == "/extracted_fields/document_number")
    assert observation["confidence"] == 0.77 and observation["spans"][0]["quote"] == gold["document_number"]


def test_a_value_not_on_the_page_is_ambiguous_never_given_an_invented_span():
    label, pages = sample("national_identity_card")
    answer, report = answer_from_model_fields("national_identity_card", pages, model_fields("national_identity_card", [
        {"path": "/extracted_fields/family_name", "value": "Alex Example Example", "content": "Alex Example\nExample", "confidence": 0.4},
        {"path": "/extracted_fields/not_a_field", "value": "x"},
        {"path": "/extracted_fields/subject_address", "value": "x"},
    ]))
    assert validate_extraction("national_identity_card", answer, pages)["valid"]
    observation = next(o for o in answer["observations"] if o["path"] == "/extracted_fields/family_name")
    assert observation["status"] == "ambiguous" and observation["note"] and answer["extracted_fields"]["family_name"] is None
    assert report["unanchored"] == ["/extracted_fields/family_name"]
    assert report["unmapped"] == ["/extracted_fields/not_a_field", "/extracted_fields/subject_address"]


def test_row_candidates_build_rows():
    label, pages = sample("bank_statement")
    account = label.result.extracted_fields["accounts"][0]
    answer, _ = answer_from_model_fields("bank_statement", pages, model_fields("bank_statement", [
        {"path": "/extracted_fields/accounts/0/account_identifier", "value": account["account_identifier"], "confidence": 0.74},
        {"path": "/extracted_fields/accounts/0/closing_balance", "value": account["closing_balance"], "confidence": 0.7},
    ]))
    assert validate_extraction("bank_statement", answer, pages)["valid"]
    row = answer["extracted_fields"]["accounts"][0]
    assert row["account_identifier"] == account["account_identifier"] and row["currency"] is None


def test_the_adjudicated_answer_holds_only_selected_values():
    label, pages = sample("passport")
    gold = label.result.model_dump(mode="json")
    route_a, _ = answer_from_model_fields("passport", pages, model_fields("passport", [
        {"path": "/extracted_fields/document_number", "value": gold["extracted_fields"]["document_number"]},
        {"path": "/extracted_fields/date_of_birth", "value": gold["extracted_fields"]["issue_date"]},  # a misreading, grounded elsewhere
    ]))
    result = adjudicate("passport", pages, {"azure_di": route_a, "llm": gold}, as_of=date(2026, 11, 12))
    answer = answer_from_adjudication("passport", pages, result)
    assert validate_extraction("passport", answer, pages)["valid"]
    assert answer["extracted_fields"]["document_number"] == gold["extracted_fields"]["document_number"]  # agreed
    assert answer["extracted_fields"]["date_of_birth"] is None  # conflict: no value selected
    assert answer["extracted_fields"]["person_name"] == gold["extracted_fields"]["person_name"]  # single route


def test_the_contract_must_match():
    _, pages = sample("passport")
    with pytest.raises(ValueError):
        answer_from_model_fields("passport", pages, {**model_fields("passport", []), "document_type": "w9"})
