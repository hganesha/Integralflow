import json
from pathlib import Path

from kyc_documents.runtime import contract, field_inventory, validate_extraction

ROOT = Path(__file__).resolve().parents[1]
CLOSED_KEYS = {"object_type", "field_path", "condition", "mode"}  # financial_crime ContextTargetDecl


def test_a_passport_number_is_its_document_number_and_an_identity_identifier():
    passport = field_inventory("passport")
    assert passport["key_fields"] == ["person_name", "document_number", "date_of_birth", "expiry_date"]
    targets = next(f for f in passport["fields"] if f["name"] == "document_number")["context_targets"]
    assert [t["object_type"] for t in targets] == ["IdentityIdentifier"] and all(set(t) == CLOSED_KEYS for t in targets)
    assert "identity_number holds only a separate personal or national number" in contract("passport")["instructions"]


def test_document_number_maps_to_identity_only_on_passports():
    for document_type in ("certificate_of_incorporation", "commercial_invoice", "national_identity_card", "w9"):
        inventory = field_inventory(document_type)
        field = next(f for f in inventory["fields"] if f["name"] == "document_number")
        assert field["context_targets"] == []
    assert field_inventory("national_identity_card")["key_fields"][1] == "identity_number"


def test_validated_passport_assertions_carry_the_scoped_target_in_the_closed_shape():
    example = json.loads((ROOT / "examples/documents/passport.json").read_text())
    result = validate_extraction("passport", example["result"], example["pages"])
    assert result["valid"]
    assertion = next(a for a in result["candidate_assertions"] if a["path"] == "/extracted_fields/document_number")
    assert assertion["value"] == "SYN-000042"
    assert [set(t) for t in assertion["context_targets"]] == [CLOSED_KEYS]
    mapping = next(m for m in result["mapping_candidates"] if m["source_path"] == "/extracted_fields/document_number")
    assert mapping["targets"][0]["object_type"] == "IdentityIdentifier"
    for candidate in result["candidate_assertions"]:
        assert all(set(t) == CLOSED_KEYS for t in candidate["context_targets"])
