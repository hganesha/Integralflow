"""Every business ID must execute real code and respect its public admission contract."""
import importlib
import json
from pathlib import Path
import re

import pytest
import yaml
from jsonschema import Draft202012Validator

from financial_crime import synthetic
from financial_crime.contracts import Status
from financial_crime.registry import instructions_for, load_registry

REGISTRY = load_registry()
ROOT = Path(__file__).resolve().parents[1]
# The sandbox specialist recordings answer INCONCLUSIVE. Outside the KYC/KYB document check, which
# relays that answer as it stands, an inconclusive detector is an evidence gap with its payload kept.
INCONCLUSIVE_SANDBOX = {k for k, v in REGISTRY.items() if k.startswith("fraud.") and v.capabilities}


def test_catalog_has_exactly_the_source_ids():
    source = (ROOT / "financial_crime_canonical_skills_spec_v1.md").read_text()
    ids = re.findall(r"^#### `([^`]+)`", source, re.M)
    extensions = re.findall(r"^#### `([^`]+)`", (ROOT / "docs/skill-extensions.md").read_text(), re.M)
    assert len(ids) == len(set(ids)) == 222
    assert not set(ids) & set(extensions)
    assert set(ids) | set(extensions) == set(REGISTRY) and len(REGISTRY) == 222 + len(extensions)
    # Every extension wraps exactly one canonical skill and keeps its domain.
    for skill_id in extensions:
        (wrapped,) = REGISTRY[skill_id].dependencies
        assert wrapped in ids and wrapped.split(".")[0] == skill_id.split(".")[0]


@pytest.mark.parametrize("skill_id", sorted(REGISTRY))
async def test_all_skills_execute_and_validate_payload(skill_id, environment):
    store, executor, principal = environment
    if skill_id == "case.create":
        store.db.execute("DELETE FROM state WHERE kind='case'")
    request = synthetic.invocation(skill_id)
    result = await executor.run(request, principal)
    expected = Status.NEEDS_REVIEW if REGISTRY[skill_id].effects == "human_gated" else Status.COMPLETED
    if skill_id in INCONCLUSIVE_SANDBOX:
        expected = Status.NEEDS_EVIDENCE
        assert result.payload["assessment"]["assessment"] == "INCONCLUSIVE" and result.unresolved_items
    assert result.status == expected, result.model_dump()
    assert result.error is None
    assert result.result_refs and result.context_hash
    assert result.execution_lock["instruction_hash"]
    assert result.synthetic is True
    Draft202012Validator(REGISTRY[skill_id].output).validate(result.payload)
    if expected == Status.NEEDS_REVIEW:
        assert not result.effects_committed


@pytest.mark.parametrize("skill_id", sorted(REGISTRY))
async def test_every_skill_denies_ungranted_execution(skill_id, environment):
    _, executor, principal = environment
    principal.permissions.clear()
    result = await executor.run(synthetic.invocation(skill_id), principal)
    assert result.status == Status.BLOCKED
    assert result.error["code"] == "ACCESS_DENIED"
    assert not result.payload and not result.result_refs


@pytest.mark.parametrize("skill_id", sorted(REGISTRY))
async def test_every_skill_rejects_undeclared_parameters(skill_id, environment):
    _, executor, principal = environment
    request = synthetic.invocation(skill_id)
    request.parameters["undeclared_parameter"] = "ignored instruction injection must fail schema validation"
    result = await executor.run(request, principal)
    assert result.status == Status.FAILED
    assert result.error["code"] == "INPUT_INVALID"


REQUIRED = [(s.id, r.object_type) for s in REGISTRY.values() for r in s.requirements if not r.optional and r.min_count]


@pytest.mark.parametrize("skill_id,object_type", REQUIRED)
async def test_missing_required_collection_cannot_complete(skill_id, object_type, environment):
    store, executor, principal = environment
    store.db.execute("DELETE FROM records WHERE type=?", (object_type,))
    result = await executor.run(synthetic.invocation(skill_id), principal)
    assert result.status == Status.NEEDS_EVIDENCE
    assert result.error["code"] == "CONTEXT_MISSING"


@pytest.mark.parametrize("skill_id", sorted(REGISTRY))
def test_packages_have_valid_instructions_schemas_and_resolvable_entrypoints(skill_id):
    domain, name = skill_id.split(".", 1)
    package = ROOT / "skills" / domain / name.replace(".", "-")
    instruction = (package / "SKILL.md").read_text()
    assert instruction == instructions_for(skill_id)
    frontmatter = yaml.safe_load(instruction.split("---")[1])
    assert re.fullmatch(r"[a-z0-9-]{1,64}", frontmatter["name"])
    manifest = yaml.safe_load((package / "skill.yaml").read_text())
    assert manifest["id"] == skill_id
    module, function = manifest["entrypoint"].split(":")
    assert getattr(importlib.import_module(module), function) is REGISTRY[skill_id].function
    for name in ["input.schema.json", "output.schema.json"]:
        Draft202012Validator.check_schema(json.loads((package / name).read_text()))

