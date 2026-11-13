from copy import deepcopy

import pytest

from financial_crime import synthetic as f
from financial_crime.contracts import Record, SkillError
from financial_crime.migrations import compare_schemas, migrate_record, migrate_invocation
from financial_crime.versions import SCHEMA_VERSION, SKILL_VERSION


def legacy_record():
    raw = next(r for r in f.records() if r.object_type == "Entity").model_dump(mode="json")
    raw["schema_version"] = "1.0.0"
    raw["data"]["vendor_specific_field"] = {"raw_score": 12}
    return raw


def test_record_migration_is_lossless_explicit_and_deterministic():
    old = legacy_record()
    saved = deepcopy(old)
    new = migrate_record(old)
    assert old == saved
    assert new.schema_version == SCHEMA_VERSION
    assert new.version_id != old["version_id"] and new.supersedes == old["version_id"]
    assert new.version_id == migrate_record(old).version_id
    assert new.data["extensions"]["legacy.v1"]["value"] == {"vendor_specific_field": {"raw_score": 12}}
    assert new.observed_at == f.OLD and new.recorded_at == f.OLD
    assert new.synthetic is old["synthetic"]


def test_migration_does_not_invent_missing_evidence():
    old = legacy_record()
    del old["data"]["name"]
    with pytest.raises(SkillError) as error:
        migrate_record(old)
    assert error.value.code == "MIGRATION_REQUIRES_EVIDENCE"
    assert "name" not in old["data"]


@pytest.mark.parametrize("version", [None, "2.0.0", "99.0.0"])
def test_unknown_or_current_versions_are_not_silently_migrated(version):
    old = legacy_record(); old["schema_version"] = version
    with pytest.raises(SkillError) as error:
        migrate_record(old)
    assert error.value.code == "SCHEMA_VERSION_UNSUPPORTED"


def test_migration_preserves_real_data_classification_and_does_not_relabel_synthetic():
    old = legacy_record(); old["synthetic"] = False; old["classification"] = "restricted"
    new = migrate_record(old)
    assert new.synthetic is False and new.classification == "restricted"


def test_migration_requires_access_metadata_and_preserves_existing_extensions():
    old = legacy_record()
    old["data"]["extensions"] = {"provider.v1": {"schema_version": "1.0.0", "value": {"raw": True}}}
    assert migrate_record(old).data["extensions"]["provider.v1"] == old["data"]["extensions"]["provider.v1"]
    del old["purposes"]
    with pytest.raises(SkillError) as error:
        migrate_record(old)
    assert error.value.code == "MIGRATION_REQUIRES_EVIDENCE"


def test_migration_never_overwrites_an_extension_namespace():
    old = legacy_record()
    old["data"]["extensions"] = {"legacy.v1": {"schema_version": "1.0.0", "value": "original"}}
    with pytest.raises(SkillError) as error:
        migrate_record(old)
    assert error.value.code == "MIGRATION_REQUIRES_REVIEW"


def test_old_invocation_requires_new_action_identity_and_new_parameter_validation():
    old = f.invocation("entity.resolve").model_dump(mode="json"); old["skill_version"] = "0.1.0"
    with pytest.raises(SkillError) as error:
        migrate_invocation(old, new_execution_id=old["execution_id"], new_idempotency_key="new", new_profile_id="synthetic-analyst")
    assert error.value.code == "IDEMPOTENCY_CONFLICT"
    new = migrate_invocation(old, new_execution_id="new-execution", new_idempotency_key="new-key", new_profile_id="synthetic-analyst")
    assert new.skill_version == SKILL_VERSION
    old["parameters"]["unknown"] = True
    with pytest.raises(SkillError):
        migrate_invocation(old, new_execution_id="other", new_idempotency_key="other", new_profile_id="synthetic-analyst")


def test_execution_artifacts_are_not_rewritten_as_new_decisions():
    old = legacy_record(); old["object_type"] = "SkillExecution"
    with pytest.raises(SkillError) as error:
        migrate_record(old)
    assert error.value.code == "MIGRATION_REQUIRES_REVIEW"


def test_missing_nested_reference_versions_are_not_guessed_as_current():
    from context_examples import examples
    old = legacy_record(); old["object_type"] = "Fact"; old["data"] = deepcopy(examples()["Fact"])
    del old["data"]["verification_ref"]["schema_version"]
    with pytest.raises(SkillError) as error:
        migrate_record(old)
    assert error.value.code == "MIGRATION_REQUIRES_EVIDENCE"
    old["data"]["verification_ref"]["schema_version"] = "1.0.0"
    assert migrate_record(old).data["verification_ref"]["schema_version"] == "1.0.0"


def test_raw_source_values_are_not_reinterpreted_as_reference_objects():
    from context_examples import examples
    old = legacy_record(); old["object_type"] = "Fact"
    raw = {"tenant_id": "raw", "object_type": "raw", "object_id": "raw", "version_id": "raw"}
    old["data"] = deepcopy(examples()["Fact"]); old["data"]["value"] = raw
    assert migrate_record(old).data["value"] == raw


def test_compatibility_distinguishes_input_and_output_direction():
    old = {"type": "object", "properties": {"name": {"type": "string"}}, "required": ["name"], "additionalProperties": False}
    new = deepcopy(old); new["properties"]["alias"] = {"type": "string"}
    assert compare_schemas(old, new)["verdict"] == "COMPATIBLE"
    assert compare_schemas(old, new, direction="production")["verdict"] == "BREAKING"
    new["required"].append("alias")
    assert compare_schemas(old, new)["verdict"] == "BREAKING"


def test_unknown_schema_implication_requires_review_not_automatic_promotion():
    result = compare_schemas({"type": "string", "pattern": "^a"}, {"type": "string", "pattern": "^b"})
    assert result["verdict"] == "REVIEW_REQUIRED" and not result["automatic_promotion_allowed"]
    assert compare_schemas({"type": "string", "description": "old"}, {"type": "string", "description": "new"})["verdict"] == "COMPATIBLE"


def test_new_named_fields_cannot_silently_restrict_dynamic_values():
    old = {"type": "object", "additionalProperties": True}
    new = {**old, "properties": {"name": {"type": "string"}}}
    assert compare_schemas(old, new)["verdict"] == "REVIEW_REQUIRED"
    for keyword in ["$ref", "$dynamicRef"]:
        remote = {keyword: "https://example.invalid/schema"}
        assert compare_schemas(remote, remote)["verdict"] == "REVIEW_REQUIRED"


@pytest.mark.parametrize("name", ["title", "description", "default", "examples", "x-business-field"])
def test_business_property_names_are_not_discarded_as_schema_annotations(name):
    old = {"type": "object", "properties": {name: {"type": "string"}}, "additionalProperties": False}
    new = deepcopy(old); new["properties"][name] = {"type": "integer"}
    assert compare_schemas(old, new)["verdict"] == "REVIEW_REQUIRED"
    assert compare_schemas({"const": {name: "old"}}, {"const": {name: "new"}})["verdict"] == "REVIEW_REQUIRED"


async def test_old_stored_versions_and_old_skill_versions_fail_explicitly(environment):
    store, executor, principal = environment
    raw = legacy_record()
    from financial_crime.contracts import canonical, digest
    store.db.execute("INSERT INTO records VALUES(?,?,?,?,?,?)", (raw["tenant_id"], raw["object_type"], raw["id"], "legacy", canonical(raw), digest(raw)))
    result = await executor.run(f.invocation("entity.resolve"), principal)
    assert result.error["code"] == "SCHEMA_VERSION_UNSUPPORTED"
    result = await executor.run(f.invocation("entity.resolve", skill_version="0.1.0"), principal)
    assert result.error["code"] == "ACCESS_DENIED"
