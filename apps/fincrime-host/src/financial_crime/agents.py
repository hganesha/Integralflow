"""Small bounded agent harness; model-specific planners are dependency-injected."""
from typing import Protocol
import asyncio

from pydantic import Field

from .contracts import Contract, Invocation, SkillError, Status, canonical, digest
from .registry import instructions_for


class Selection(Contract):
    skill_id: str | None = None
    parameters: dict = Field(default_factory=dict)
    stop: bool = False


class Planner(Protocol):
    async def choose(self, *, task: str, profile_instructions: str, tools: list[dict], history: list[dict]) -> Selection: ...
    async def prepare(self, *, selection: Selection, skill_instructions: str, parameters_schema: dict, history: list[dict]) -> dict: ...


class ScriptedPlanner:
    """Deterministic plan fixture for testing the harness without real model inference."""
    def __init__(self, selections):
        self.selections = iter(selections)

    async def choose(self, **kwargs):
        return next(self.selections, Selection(stop=True))

    async def prepare(self, *, selection, **kwargs):
        return selection.parameters


class AgentRunner:
    def __init__(self, executor):
        self.executor = executor

    def tools(self, profile_id, principal):
        profile = self.executor.profiles[profile_id]
        return [{"id": spec.id, "description": spec.description} for spec in self.executor.registry.values()
                if profile.allowed_skills.get(spec.id) == spec.version and f"skill:{spec.id}" in principal.permissions & profile.permissions]

    async def run(self, task, template: Invocation, principal, planner: Planner, *, max_steps=None):
        profile = self.executor.profiles.get(template.profile_id)
        if profile is None or principal.tenant_id != template.tenant_id or principal.actor_id != template.actor_ref or principal.revoked:
            raise SkillError("ACCESS_DENIED", "agent identity/profile denied")
        max_steps = profile.max_agent_steps if max_steps is None else max_steps
        if not 1 <= max_steps <= profile.max_agent_steps:
            raise SkillError("INPUT_INVALID", "agent step budget exceeds profile limit", Status.FAILED)
        history = []
        for step in range(max_steps):
            index = self.tools(template.profile_id, principal)
            planning_input = {"task": task, "profile": profile.instructions, "tools": index, "history": history}
            if len(canonical(planning_input)) > profile.model_char_budget:
                return {"state": "CONTEXT_BUDGET_EXCEEDED", "steps": history}
            async with asyncio.timeout(profile.timeout_seconds):
                selected = Selection.model_validate(await planner.choose(task=task, profile_instructions=profile.instructions,
                    tools=index, history=history))
            if selected.stop:
                return {"state": "COMPLETED", "steps": history}
            if selected.skill_id not in {x["id"] for x in self.tools(template.profile_id, principal)}:
                raise SkillError("ACCESS_DENIED", "planner chose an unadmitted skill")
            instructions = instructions_for(selected.skill_id)
            if len(canonical({"instructions": instructions, "schema": self.executor.registry[selected.skill_id].params, "history": history})) > profile.model_char_budget:
                return {"state": "CONTEXT_BUDGET_EXCEEDED", "steps": history}
            async with asyncio.timeout(profile.timeout_seconds):
                parameters = await planner.prepare(selection=selected, skill_instructions=instructions,
                    parameters_schema=self.executor.registry[selected.skill_id].params, history=history)
            request = template.model_copy(update={"skill_id": selected.skill_id, "skill_version": profile.allowed_skills[selected.skill_id],
                "parameters": parameters, "execution_id": digest([template.execution_id, step]), "idempotency_key": f"{template.idempotency_key}:agent:{step}"})
            instruction_hash = digest(instructions)
            result = await self.executor.run(request, principal)
            history.append({"skill_id": selected.skill_id, "instruction_hash": instruction_hash, "result": result.model_dump(mode="json")})
            if result.status != Status.COMPLETED:
                return {"state": result.lifecycle if result.lifecycle == "WAITING_FOR_HUMAN" else result.status.value, "steps": history}
        return {"state": "BUDGET_EXHAUSTED", "steps": history}
