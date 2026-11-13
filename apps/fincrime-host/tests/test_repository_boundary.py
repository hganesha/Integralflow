import pytest

from financial_crime import synthetic as f
from financial_crime.contracts import Status
from financial_crime.execution import Executor
from financial_crime.providers import Router


async def test_executor_and_business_skills_do_not_depend_on_sqlite_connection(environment):
    store, _, principal = environment
    class RepositoryOnly:
        def __getattr__(self, name):
            if name == "db":
                raise AssertionError("business code cannot use raw database connections")
            return getattr(store, name)
    executor = Executor(RepositoryOnly(), [f.profile()], f.router())
    for sid in ["entity.resolve", "decision.audit.verify", "regulatory.filing.track", "alert.feedback.capture"]:
        result = await executor.run(f.invocation(sid), principal)
        assert result.status == Status.COMPLETED, result


async def test_unentitled_provider_is_denied_before_receiving_data(environment):
    _, executor, principal = environment
    class Unentitled:
        provider_id = "unlicensed-provider"
        called = False
        async def invoke(self, capability, request):
            self.called = True
            raise AssertionError("unentitled provider must not receive context")
    provider = Unentitled()
    executor.router = Router({"document.entities": provider})
    result = await executor.run(f.invocation("document.entities.extract"), principal)
    assert result.error["code"] == "ACCESS_DENIED" and not provider.called


async def test_agent_loads_selected_skill_instructions_and_schema(environment):
    from financial_crime.agents import AgentRunner, ScriptedPlanner, Selection
    _, executor, principal = environment
    class InspectPlanner(ScriptedPlanner):
        prepared = False
        async def prepare(self, *, selection, skill_instructions, parameters_schema, **kwargs):
            assert "entity.address.normalize" in skill_instructions
            assert parameters_schema["required"] == ["address"]
            self.prepared = True
            return selection.parameters
    planner = InspectPlanner([Selection(skill_id="entity.address.normalize", parameters={"address": "Test"})])
    runner = AgentRunner(executor)
    assert all("parameters" not in tool for tool in runner.tools("synthetic-analyst", principal))
    result = await runner.run("Normalize", f.invocation("entity.address.normalize"), principal, planner)
    assert planner.prepared and result["state"] == "COMPLETED"


async def test_profile_agent_step_limit_cannot_be_widened(environment):
    from financial_crime.agents import AgentRunner, ScriptedPlanner
    from financial_crime.contracts import SkillError
    _, executor, principal = environment
    executor.profiles["synthetic-analyst"].max_agent_steps = 1
    with pytest.raises(SkillError, match="profile limit"):
        await AgentRunner(executor).run("Task", f.invocation("entity.resolve"), principal, ScriptedPlanner([]), max_steps=2)


async def test_unqualified_real_data_effects_fail_closed(environment):
    store, executor, principal = environment
    original = next(r for r in store.records("tenant-synthetic", "Control"))
    store.db.execute("DELETE FROM records WHERE type='Control'")
    store.put(original.model_copy(update={"synthetic": False}))
    result = await executor.run(f.invocation("decision.disposition.record"), principal)
    assert result.error["code"] == "CONTROL_FAILED"
    assert "disposition" not in store.state("tenant-synthetic", "case", "case-demo")[1]
