"""Document semantics, source binding and strict boundary regressions."""
import copy
import json
from pathlib import Path

from jsonschema import Draft202012Validator
from pydantic import ValidationError
import pytest

from kyc_documents.fields import FIELDS, MEMBER_DESCRIPTIONS, OBJECTS
from kyc_documents.model import ConfidencePolicy
from kyc_documents.profiles import COVERAGE, ENTITY_PACKS, PROFILES, REVIEW_EVENTS
from kyc_documents.runtime import (
    contract, coverage_report, extraction_schema, fields_schema, resolve, source_digest, validate_extraction,
)

ROOT = Path(__file__).resolve().parents[1]
EXAMPLES = ("passport", "bank_statement", "shareholder_register", "trust_deed", "w8bene", "commercial_invoice")


def example(identifier="passport"):
    return json.loads((ROOT / "examples/documents" / (identifier + ".json")).read_text())


def codes(result):
    return {i["code"] for i in result["issues"]}


@pytest.mark.parametrize("identifier", EXAMPLES)
def test_authored_contract_and_source_examples(identifier):
    data = example(identifier)
    outcome = validate_extraction(identifier, data["result"], data["pages"])
    assert {k: outcome[k] for k in data["expected"]} == data["expected"]
    assert outcome["candidate_assertions"]
    assert all(a["epistemic_status"] == "EXTRACTED_ASSERTION" and a["verification"] == "UNVERIFIED"
               for a in outcome["candidate_assertions"])


def test_nested_owner_edges_and_trust_roles_survive_without_inference():
    ownership = example("shareholder_register")
    rows = ownership["result"]["extracted_fields"]["ownership_interests"]
    assert [(r["owner_name"], r["owned_entity_name"], r["percentage"]) for r in rows] == [
        ("Alex Example", "Example Trading", "60"), ("Morgan Example", "Example Trading", "40")]
    assert all(r["voting_percentage"] is None and r["percentage_basis"] is None for r in rows)
    trust = example("trust_deed")["result"]["extracted_fields"]
    assert [r["role"] for r in trust["trust_parties"]] == ["Settlor", "Trustee", "Protector"]
    assert trust["beneficiary_classes"] == ["Descendants of Alex Example"]
    assert not any(r["role"] == "Beneficiary" for r in trust["trust_parties"])


@pytest.mark.parametrize("identifier", sorted(PROFILES))
def test_each_profile_is_closed_typed_and_explicit_about_absence(identifier):
    profile = PROFILES[identifier]
    schema = fields_schema(identifier)
    checker = Draft202012Validator(schema)
    blank = dict.fromkeys(profile.field_names)
    assert checker.is_valid(blank)
    assert not checker.is_valid({**blank, "undeclared_fact": "invented"})
    first = profile.field_names[0]
    del blank[first]
    assert not checker.is_valid(blank)
    assert set(profile.key_fields) <= set(profile.field_names)


def test_coverage_is_traceable_and_packages_reference_real_profiles():
    assert set(coverage_report()) == set(COVERAGE)
    assert all(row["document_types"] for row in coverage_report().values())
    assert set(FIELDS) == {f for p in PROFILES.values() for f in p.field_names}
    assert {m for members in OBJECTS.values() for m in members} <= MEMBER_DESCRIPTIONS.keys()
    for ids in list(ENTITY_PACKS.values()) + list(REVIEW_EVENTS.values()):
        assert set(ids) <= PROFILES.keys()
    assert resolve("cbddq").id != resolve("fccq").id
    assert resolve("cap_table").id == "capitalization_table"
    with pytest.raises(ValueError):
        resolve("unknown_certificate")


@pytest.mark.parametrize("mutation", ["contract", "source_digest", "version", "extra", "wrong_type", "unknown_nested", "missing_nested"])
def test_stale_or_untyped_results_cannot_yield_assertions(mutation):
    data = example("shareholder_register")
    result = data["result"]
    if mutation == "contract":
        result["contract_hash"] = "0" * 64
    elif mutation == "source_digest":
        result["source_digest"] = "0" * 64
    elif mutation == "version":
        result["document_version"] = "different-version"
    elif mutation == "extra":
        result["extracted_fields"]["approved"] = True
    elif mutation == "wrong_type":
        result["extracted_fields"]["ownership_interests"][0]["percentage"] = 60.0
    elif mutation == "unknown_nested":
        result["extracted_fields"]["ownership_interests"][0]["resolved_ubo"] = True
    else:
        del result["extracted_fields"]["ownership_interests"][0]["percentage_basis"]
    outcome = validate_extraction("shareholder_register", result, data["pages"])
    assert not outcome["valid"] and outcome["candidate_assertions"] == []


@pytest.mark.parametrize("mutation", ["quote", "page", "negative", "reversed", "past_end", "missing", "duplicate", "unknown_path"])
def test_source_span_and_observation_integrity(mutation):
    data = example()
    result = data["result"]
    observation = next(o for o in result["observations"] if o["path"] == "/extracted_fields/person_name")
    if mutation == "quote":
        observation["spans"][0]["quote"] = "Invented Person"
    elif mutation == "page":
        observation["spans"][0]["page_id"] = "another-page"
    elif mutation == "negative":
        observation["spans"][0]["start"] = -1
    elif mutation == "reversed":
        observation["spans"][0]["end"] = observation["spans"][0]["start"]
    elif mutation == "past_end":
        observation["spans"][0]["end"] = 100000
    elif mutation == "missing":
        result["observations"].remove(observation)
    elif mutation == "duplicate":
        result["observations"].append(copy.deepcopy(observation))
    else:
        observation["path"] = "/extracted_fields/invented"
    outcome = validate_extraction("passport", result, data["pages"])
    assert not outcome["valid"] and not outcome["candidate_assertions"]


def test_unicode_offsets_are_codepoints_and_capture_digest_is_version_bound():
    data = example()
    prefix = "😀 日本語\n"
    page = data["pages"][0]
    page["text"] = prefix + page["text"]
    for o in data["result"]["observations"]:
        for span in o["spans"]:
            span["start"] += len(prefix)
            span["end"] += len(prefix)
    data["result"]["source_digest"] = source_digest(data["pages"])
    assert validate_extraction("passport", data["result"], data["pages"])["valid"]
    page["text"] += "trailing change"
    result = validate_extraction("passport", data["result"], data["pages"])
    assert "SOURCE_BINDING_MISMATCH" in codes(result)


def test_no_fake_defaults_for_absence_or_redaction():
    data = example()
    field = "nationalities"
    observation = next(o for o in data["result"]["observations"] if o["path"] == "/extracted_fields/" + field)
    assert data["result"]["extracted_fields"][field] is None
    observation["status"] = "redacted"
    result = validate_extraction("passport", data["result"], data["pages"])
    assert "MISSING_STATUS_EXPLANATION" in codes(result)
    observation["note"] = "Source is redacted; no nationality can be recovered."
    assert validate_extraction("passport", data["result"], data["pages"])["valid"]
    data["result"]["extracted_fields"][field] = []
    assert "STATUS_VALUE_MISMATCH" in codes(validate_extraction("passport", data["result"], data["pages"]))


def test_missing_key_fields_are_explicit_evidence_gaps_not_completed_work():
    data = example()
    data["result"]["extracted_fields"]["document_number"] = None  # the passport number: a passport key field
    observation = next(o for o in data["result"]["observations"] if o["path"].endswith("/document_number"))
    observation.update(status="not_present", spans=[])
    outcome = validate_extraction("passport", data["result"], data["pages"])
    assert outcome["valid"] and outcome["status"] == "NEEDS_EVIDENCE"
    assert "KEY_FIELD_GAP" in codes(outcome)


def test_real_calendar_validation_and_partial_dates():
    data = example()
    data["result"]["extracted_fields"]["date_of_birth"] = "1987-02-30"
    assert "INVALID_CALENDAR_DATE" in codes(validate_extraction("passport", data["result"], data["pages"]))
    data["result"]["extracted_fields"]["date_of_birth"] = "1987"
    assert "INVALID_CALENDAR_DATE" not in codes(validate_extraction("passport", data["result"], data["pages"]))


@pytest.mark.parametrize("value", ["101", "-1", "NaN", "1e2", "60%", 60, True])
def test_percentages_are_decimal_strings_on_an_explicit_percent_scale(value):
    data = example("shareholder_register")
    data["result"]["extracted_fields"]["ownership_interests"][0]["percentage"] = value
    outcome = validate_extraction("shareholder_register", data["result"], data["pages"])
    assert not outcome["valid"] and "SCHEMA_INVALID" in codes(outcome)


def test_normalization_and_confidence_are_reviewed_not_certified():
    data = example()
    data["result"]["extracted_fields"]["person_name"] = "Alex EXAMPLE"
    outcome = validate_extraction("passport", data["result"], data["pages"])
    assert outcome["valid"] and "NORMALIZATION_REQUIRES_REVIEW" in codes(outcome)
    assert outcome["review_required"] and not outcome["promotion_allowed"]
    assert outcome["semantic_verification"] == "not_performed"
    policy = ConfidencePolicy(policy_id="synthetic-policy", qualification_ref="synthetic-evaluation", thresholds={"person_name": 0.9})
    outcome = validate_extraction("passport", data["result"], data["pages"], confidence_policy=policy)
    assert "CONFIDENCE_POLICY_REVIEW" in codes(outcome)
    with pytest.raises(ValidationError):
        ConfidencePolicy(policy_id="bad", qualification_ref="bad", thresholds={"person_name": 1.1})
    with pytest.raises(ValueError):
        validate_extraction("passport", data["result"], data["pages"], confidence_policy=ConfidencePolicy(
            policy_id="bad", qualification_ref="bad", thresholds={"unknown_field": 0.9}))


def test_empty_or_mixed_source_sets_are_rejected():
    with pytest.raises(ValueError):
        source_digest([])
    data = example()
    other = {**data["pages"][0], "page_id": "second", "document_version": "other-version"}
    with pytest.raises(ValueError):
        source_digest(data["pages"] + [other])
    with pytest.raises(ValueError):
        source_digest(data["pages"] * 2)


def test_context_targets_reference_existing_shapes_without_writing_records():
    from financial_crime.ontology import canonical_data_schema
    from financial_crime.schema_types import DEFS
    for field in FIELDS.values():
        for target in field.context_targets:
            shape = canonical_data_schema(target.object_type)
            # Resolve existing schema refs while checking declared property paths.
            for component in target.field_path.split("."):
                while "$ref" in shape:
                    shape = DEFS[shape["$ref"].split("/")[-1]]
                shape = shape["properties"][component]
    data = example("shareholder_register")
    outcome = validate_extraction("shareholder_register", data["result"], data["pages"])
    mapping = next(m for m in outcome["mapping_candidates"] if m["source_path"].endswith("ownership_interests"))
    assert mapping["requires_subject_resolution_and_transform"]
    assert not outcome["promotion_allowed"]
    assert all(not a["context_targets"] for a in outcome["candidate_assertions"] if "/ownership_interests/" in a["path"])


def test_catalog_hash_and_generated_assets_are_bound_to_the_same_definitions():
    from kyc_documents.model import fingerprint
    catalog = json.loads((ROOT / "src/kyc_documents/resources/catalog.json").read_text())
    published_hash = catalog.pop("catalog_hash")
    assert fingerprint(catalog) == published_hash
    assert catalog["statistics"]["document_types"] == len(PROFILES)
    assert catalog["qualification"]["real_document_evaluations"] == 0
    for entry in catalog["document_types"]:
        assert contract(entry["id"])["contract_hash"] == entry["contract_hash"]
    schema = extraction_schema("bank_statement")
    assert schema["$defs"]["Account"]["additionalProperties"] is False
    assert schema["$defs"]["Account"]["properties"]["account_identifier"]["anyOf"][0]["type"] == "string"
