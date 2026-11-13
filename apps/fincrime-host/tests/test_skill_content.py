"""Business-policy and content-integrity regressions at public execution boundaries."""
import importlib.resources
from pathlib import Path
import sys

import pytest

from financial_crime import synthetic as f
from financial_crime.contracts import SkillError, Status, digest
from financial_crime import registry
from financial_crime.workflows import Step, Workflow, WorkflowRunner
from financial_crime.runtimes.skill_host import load_lock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from skill_content import read_source, render_instructions, validate_sources


def policy_with(store, field, *, missing=False):
    policy = f.policy()
    if missing:
        policy.pop(field)
    else:
        policy[field] = []
    store.db.execute("DELETE FROM records WHERE type='Policy'")
    store.put(f.make_record("Policy", "synthetic-policy-v1", policy))


@pytest.mark.parametrize("skill_id,field", [("edd.trigger.evaluate", "edd_triggers"), ("party.profile.completeness", "profile_fields")])
async def test_missing_policy_is_blocked_at_executor_boundary(environment, skill_id, field):
    store, executor, principal = environment
    policy_with(store, field, missing=True)
    result = await executor.run(f.invocation(skill_id), principal)
    assert result.status == Status.BLOCKED
    assert result.error.code == "POLICY_UNRESOLVED"
    assert not result.payload and not result.effects_committed


@pytest.mark.parametrize("skill_id,field", [("edd.trigger.evaluate", "edd_triggers"), ("party.profile.completeness", "profile_fields")])
async def test_explicit_empty_policy_remains_a_distinct_supported_input(environment, skill_id, field):
    store, executor, principal = environment
    policy_with(store, field)
    result = await executor.run(f.invocation(skill_id), principal)
    assert result.status == Status.COMPLETED
    if field == "edd_triggers":
        assert result.payload == {"triggers": [], "required": False}
    else:
        assert all(item["complete"] for item in result.payload["profiles"])


async def test_workflow_does_not_advance_past_missing_edd_policy(environment):
    store, executor, principal = environment
    policy_with(store, "edd_triggers", missing=True)
    workflow = Workflow(id="policy-gap", steps=[
        Step(id="edd", skill_id="edd.trigger.evaluate", parameters={"facts": {}}),
        Step(id="schedule", skill_id="monitor.customer.schedule", dependencies=["edd"]),
    ])
    result = await WorkflowRunner(executor).run(workflow, f.invocation("edd.trigger.evaluate"), principal, "missing-policy")
    assert result["state"] != "COMPLETED"
    assert "schedule" not in result["results"]
    assert store.db.execute("SELECT count(*) FROM state WHERE kind='schedule'").fetchone()[0] == 0


def test_every_skill_has_authored_content_and_domain_guidance():
    specs = registry.load_registry()
    validate_sources(ROOT, specs)
    for spec in specs.values():
        assert registry.instructions_for(spec.id) == render_instructions(ROOT, spec)
        assert spec.description != spec.id


def test_instruction_bytes_are_verified_against_released_catalog(tmp_path, monkeypatch):
    path = tmp_path / "resources/skills/entity.resolve"
    path.mkdir(parents=True)
    (path / "SKILL.md").write_text("changed content")
    monkeypatch.setattr(importlib.resources, "files", lambda _: tmp_path)
    monkeypatch.setattr(registry, "expected_instruction_hashes", lambda: {"entity.resolve": digest("released content")})
    with pytest.raises(SkillError, match="differ from the released catalog") as failure:
        registry.instructions_for("entity.resolve")
    assert failure.value.code == "INTEGRITY_FAILURE"


def test_host_checks_runtime_policy_contract_against_released_manifest(monkeypatch):
    from copy import deepcopy
    declared = deepcopy(registry.declared_policy_fields())
    declared["entity.resolve"].append("screening_threshold")
    monkeypatch.setattr(registry, "declared_policy_fields", lambda: declared)
    with pytest.raises(SystemExit, match="runtime manifest differs"):
        load_lock()


@pytest.mark.parametrize("target", ["../../private.md", "https://untrusted.example/rules", "/etc/passwd"])
def test_content_build_rejects_unpinned_references(tmp_path, target):
    source = tmp_path / "procedure.md"
    source.write_text(f"Instructions [more]({target})")
    with pytest.raises(ValueError, match="unpinned instruction reference"):
        read_source(source)


def test_content_build_requires_all_business_sections(tmp_path):
    (tmp_path / "skill-content/skills").mkdir(parents=True)
    (tmp_path / "skill-content/domains").mkdir()
    (tmp_path / "skill-content/skills/entity.resolve.md").write_text("## Procedure\n\nToo little.")
    (tmp_path / "skill-content/domains/entity.md").write_text("Domain guidance")
    with pytest.raises(ValueError, match="business section"):
        validate_sources(tmp_path, {"entity.resolve": object()})
