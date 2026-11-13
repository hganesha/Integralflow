from copy import deepcopy
import json
from pathlib import Path

from jsonschema import Draft202012Validator, FormatChecker
import pytest
from pydantic import ValidationError

from financial_crime import synthetic as f
from financial_crime.context_types import CONTEXT_TYPES
from financial_crime.contracts import Record, RecordView, SkillError, SkillResult, Invocation, AgentProfile, Metrics
from financial_crime.ontology import canonical_data_schema
from financial_crime.registry import load_registry, validate
from financial_crime.schema_types import audit_schema
from financial_crime.versions import SCHEMA_VERSION, SKILL_VERSION
from context_examples import examples

REGISTRY = load_registry()
EXAMPLES = examples()


def test_every_context_type_has_a_designed_example_and_closed_named_shape():
    assert set(EXAMPLES) == CONTEXT_TYPES
    assert len(EXAMPLES) == 89
    for name in sorted(CONTEXT_TYPES):
        schema = canonical_data_schema(name)
        assert not audit_schema(schema), name
        validate(schema, EXAMPLES[name])


@pytest.mark.parametrize("name", sorted(CONTEXT_TYPES))
def test_canonical_context_rejects_unknown_fields(name):
    data = deepcopy(EXAMPLES[name])
    data["undeclared_field"] = "must not be accepted"
    with pytest.raises(SkillError):
        f.make_record(name, "strict-example", data)


@pytest.mark.parametrize("name", sorted(CONTEXT_TYPES))
def test_all_context_examples_validate_as_full_record_envelopes(name):
    record = f.make_record(name, "strict-example", deepcopy(EXAMPLES[name]))
    validate(Record.model_json_schema(), record.model_dump(mode="json"))


@pytest.mark.parametrize("skill_id", sorted(REGISTRY))
def test_all_skill_contracts_have_no_untyped_container(skill_id):
    spec = REGISTRY[skill_id]
    assert not audit_schema(spec.params)
    assert not audit_schema(spec.output)
    assert spec.params["$id"].endswith(f"input:{SKILL_VERSION}")
    assert spec.output["$id"].endswith(f"output:{SKILL_VERSION}")


def test_named_match_candidate_rejects_partial_wrong_typed_and_extra_data():
    schema = REGISTRY["entity.resolve"].output
    valid = {"entity_id": "acme", "candidates": [{"entity_id": "acme", "score": 1.0, "shared_identifiers": ["SYN-0001"], "identifier_conflict": False, "name_score": 1.0, "verified_match": True}]}
    validate(schema, valid)
    for change in [{"score": "1.0"}, {"score": 2.0}, {"unexpected": True}]:
        wrong = deepcopy(valid)
        wrong["candidates"][0].update(change)
        with pytest.raises(SkillError):
            validate(schema, wrong)
    del valid["candidates"][0]["verified_match"]
    with pytest.raises(SkillError):
        validate(schema, valid)


def test_extensions_are_explicit_versioned_and_namespaced():
    data = deepcopy(EXAMPLES["Entity"])
    data["extensions"] = {"vendor.example": {"schema_version": "1.0.0", "value": {"vendor_score": 12, "raw_flags": ["a"]}}}
    record = f.make_record("Entity", "extension-example", data)
    assert record.data["extensions"]["vendor.example"]["value"]["vendor_score"] == 12
    for malformed in [{"vendor.example": {"value": 12}}, {"Invalid Namespace": {"schema_version": "1.0.0", "value": 12}}, {"vendor.example": {"schema_version": "1.0.0", "value": 12, "unknown": True}}]:
        with pytest.raises(SkillError):
            f.make_record("Entity", "bad-extension", {**data, "extensions": malformed})


def test_partial_record_views_cannot_be_ingested_as_full_records(environment):
    store, _, _ = environment
    source = store.records("tenant-synthetic", "Entity")[0]
    view = RecordView.project(source, ["entity_type"])
    validate(RecordView.model_json_schema(), view.model_dump(mode="json"))
    with pytest.raises((SkillError, ValidationError)):
        store.put(view)
    with pytest.raises((SkillError, ValidationError)):
        RecordView.model_validate({**view.model_dump(mode="python"), "selected_fields": ["name"]})


def test_timestamp_formats_and_closed_rules_are_enforced():
    assert "date-time" in FormatChecker.checkers
    for invalid in ["2026-11-07", "yesterday", "2026-13-99T20:00:00Z"]:
        with pytest.raises(SkillError):
            f.make_record("Document", "bad-date", {**EXAMPLES["Document"], "expires_at": invalid})
    with pytest.raises(SkillError):
        f.make_record("Hypothesis", "bad-rule", {"predicate": {"field": "count", "op": "eval", "value": "execute code"}, "facts": {}})


def test_metrics_do_not_accept_extra_measurements():
    with pytest.raises(ValidationError):
        Metrics.model_validate({"duration_ms": 1, "invented_latency": 3})


@pytest.mark.parametrize("value", [True, "3", None])
def test_wire_numbers_are_not_coerced(value):
    with pytest.raises(ValidationError):
        Metrics.model_validate({"duration_ms": value})


def test_wire_booleans_and_timestamps_are_not_coerced():
    record = f.make_record("Entity", "strict-scalar", EXAMPLES["Entity"]).model_dump(mode="json")
    for field, value in [("synthetic", "false"), ("synthetic", 1), ("observed_at", 1800000000), ("observed_at", "2026-11-07")]:
        with pytest.raises(ValidationError):
            Record.model_validate({**record, field: value})


def test_duplicate_projection_fields_are_rejected(environment):
    store, _, _ = environment
    source = store.records("tenant-synthetic", "Entity")[0]
    with pytest.raises(ValidationError):
        RecordView.project(source, ["name", "name"])


def test_schema_validation_skill_supports_local_references_and_formats():
    handler = REGISTRY["quality.schema.validate"].function
    schema = {"$defs": {"time": {"type": "string", "format": "date-time"}}, "type": "object", "properties": {"time": {"$ref": "#/$defs/time"}}}
    assert handler({"schema": schema, "instance": {"time": "2026-11-07T12:00:00Z"}}, None, None)["valid"]
    assert not handler({"schema": schema, "instance": {"time": "not a date"}}, None, None)["valid"]


@pytest.mark.parametrize("schema", [{"$ref": "https://example.invalid/schema"}, {"$dynamicRef": "https://example.invalid/schema"}, {"$ref": "#/$defs/missing"}, {"$ref": 123}])
def test_schema_validation_skill_rejects_unresolvable_and_remote_schemas(schema):
    with pytest.raises(SkillError) as error:
        REGISTRY["quality.schema.validate"].function({"schema": schema, "instance": {}}, None, None)
    assert error.value.code == "INPUT_INVALID"


async def test_results_and_persisted_payloads_validate_against_selected_skill(environment):
    store, executor, principal = environment
    result = await executor.run(f.invocation("ownership.interest.calculate"), principal)
    wire = result.model_dump(mode="json")
    validate(SkillResult.model_json_schema(), wire)
    wire["payload"]["paths"] = [{"unexpected": "untyped path must fail"}]
    with pytest.raises(SkillError):
        SkillResult.model_validate(wire)
    execution = store.records("tenant-synthetic", "SkillExecution")[0]
    corrupt = execution.model_dump(mode="python")
    corrupt["data"]["payload"] = {"invented": True}
    with pytest.raises(SkillError):
        Record.model_validate(corrupt)


async def test_legacy_refs_do_not_match_current_records_by_id_only(environment):
    store, executor, principal = environment
    legacy = store.records("tenant-synthetic", "Entity")[0].ref().model_copy(update={"schema_version": "1.0.0"})
    result = await executor.run(f.invocation("entity.resolve", object_refs=[legacy]), principal)
    assert result.error["code"] == "SCHEMA_VERSION_UNSUPPORTED"


def test_schema_errors_do_not_echo_private_values():
    with pytest.raises(SkillError) as error:
        validate(REGISTRY["entity.resolve"].params, {"name": "Acme", "identifiers": [123456789]})
    assert "123456789" not in str(error.value)
