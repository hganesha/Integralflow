import json
from importlib import resources

import pytest
from pydantic import ValidationError

from document_factory.sourcing import (COMPARATORS, MODEL_PILOT, SOURCING_PILOT, SYNTHETIC_RULE, Rights, Source,
                                       build_entry, build_manifest, expand)
from kyc_documents.profiles import PROFILES
from kyc_documents.runtime import contract


def committed():
    return json.loads(resources.files("document_factory").joinpath("resources/sourcing-manifest.json").read_text())


def test_committed_manifest_is_current_and_covers_every_catalog_type_once():
    manifest = committed()
    assert manifest == build_manifest()
    types = [e["document_type"] for e in manifest["entries"]]
    assert sorted(types) == sorted(PROFILES) and len(types) == len(set(types)) == 293


def test_entries_bind_the_catalog_contracts_and_measure_key_fields():
    for entry in expand(committed()):
        assert entry.contract_hash == contract(entry.document_type)["contract_hash"]
        assert entry.measurement.key_fields == PROFILES[entry.document_type].key_fields
        assert set(entry.measurement.comparators) == set(entry.measurement.key_fields)
        assert set(entry.measurement.comparators.values()) <= set(COMPARATORS)


def test_rights_default_to_pending_except_the_synthetic_rule():
    for entry in expand(committed()):
        for source in entry.sources:
            if source.source_kind == "synthetic":
                assert source.rights.training_use == "allowed" and source.rights.reviewed_by == SYNTHETIC_RULE
            else:
                assert {source.rights.training_use, source.rights.evaluation_use, source.rights.redistribution} == {"pending_review"}


def test_pilots_match_the_plan():
    manifest = committed()
    assert len(MODEL_PILOT) == 10 and len(SOURCING_PILOT) == 20 and not set(MODEL_PILOT) & set(SOURCING_PILOT)
    assert sorted(manifest["summary"]["pilot"]["model"]) == sorted(MODEL_PILOT)
    for entry in expand(manifest):
        assert entry.status == ("planned" if entry.pilot != "none" else "unreviewed")


def test_partial_families_only_give_listed_types_authentic_sources():
    entries = {e.document_type: e for e in expand(committed())}
    kinds = lambda t: {s.source_kind for s in entries[t].sources}
    assert "authentic_public" in kinds("annual_report")
    assert "authentic_public" not in kinds("management_accounts")
    assert {"synthetic", "partner_authorized"} <= kinds("management_accounts")
    assert entries["w9"].qualification_gap and entries["certificate_of_incorporation"].qualification_gap is None


def test_rights_decisions_need_a_reviewer_and_repo_commits_need_redistribution():
    with pytest.raises(ValidationError, match="reviewed_by"):
        Rights(training_use="allowed")
    with pytest.raises(ValidationError, match="redistribution"):
        Rights(commit_to_repo=True)


def test_templates_are_never_test_samples():
    with pytest.raises(ValidationError, match="template"):
        Source(id="t", source_kind="official_template", collection="download", jurisdiction=None, purposes=("test",),
               rights=Rights(), privacy={"personal_data": "none_expected", "handling": "none"}, structured_truth="none")


def test_status_beyond_planned_needs_an_allowed_source_from_a_review():
    # liveness_assessment has only tenant_provided, whose rights are pending until reviewed.
    with pytest.raises(ValidationError, match="rights allow a use"):
        build_entry("liveness_assessment", {"status": "collecting"})
    assert build_entry("annual_return", {"status": "collecting"}).status == "collecting"  # synthetic is allowed


def test_review_can_allow_a_source_and_unknown_review_keys_fail():
    review = {"status": "collecting", "sources": {"companies_house_documents": {"rights": {
        "training_use": "allowed", "evaluation_use": "allowed", "reviewed_by": "reviewer:a", "reviewed_at": "2026-11-20"}}}}
    entry = build_entry("annual_return", review)
    source = next(s for s in entry.sources if s.id == "companies_house_documents")
    assert entry.status == "collecting" and source.usable_for("train") and not source.rights.commit_to_repo
    with pytest.raises(ValueError, match="unknown review keys"):
        build_entry("annual_return", {"verdict": "ok"})
    with pytest.raises(ValueError, match="not in the entry"):
        build_entry("annual_return", {"sources": {"sec_edgar": {}}})
    with pytest.raises(ValueError, match="unknown document types"):
        build_manifest({"not_a_type": {}})
