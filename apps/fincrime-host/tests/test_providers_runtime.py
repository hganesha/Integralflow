import asyncio
import json

import pytest

from financial_crime import synthetic as f
from financial_crime.contracts import Principal, SkillError, Status, digest
from financial_crime.providers import ProviderResponse, RecordedProvider, Router
from financial_crime.registry import load_registry

PROVIDER_SKILLS = [x.id for x in load_registry().values() if x.capabilities]


@pytest.mark.parametrize("skill_id", PROVIDER_SKILLS)
async def test_absent_specialist_provider_is_never_success(skill_id, environment):
    _, executor, principal = environment
    executor.router = Router()
    result = await executor.run(f.invocation(skill_id), principal)
    assert result.status == Status.NEEDS_EVIDENCE
    assert result.error["code"] == "SOURCE_UNAVAILABLE"


async def test_request_bound_recording_and_provider_capture(environment):
    store, executor, principal = environment
    result = await executor.run(f.invocation("document.entities.extract"), principal)
    assert result.metrics["provider_calls"] == 1
    assert any(x.object_type == "ToolInvocation" for x in result.evidence_refs)
    captures = store.records("tenant-synthetic", "ToolInvocation")
    assert captures[0].data["response"]["request_hash"] == digest(captures[0].data["request"])
    missing = await executor.run(f.invocation("document.translation.normalize", parameters={"target_language": "fr"}), principal)
    assert missing.error["code"] == "SOURCE_UNAVAILABLE"


async def test_mismatched_or_cross_tenant_provider_response_denied(environment):
    _, executor, principal = environment
    class BadProvider:
        provider_id = "synthetic-recording"
        async def invoke(self, capability, request):
            foreign = f.records()[0].ref().model_copy(update={"tenant_id": "other"})
            return ProviderResponse(provider_id="bad", capability=capability, request_hash=digest(request), payload={"entities": []}, evidence_refs=[foreign], source_version="v1", coverage={"complete": True})
    executor.router = Router({"document.entities": BadProvider()})
    result = await executor.run(f.invocation("document.entities.extract"), principal)
    assert result.error["code"] == "INTEGRITY_FAILURE"


async def test_partial_provider_coverage_is_explicit(environment):
    _, executor, principal = environment
    class PartialProvider:
        provider_id = "synthetic-recording"
        async def invoke(self, capability, request):
            return ProviderResponse(provider_id=self.provider_id, capability=capability, request_hash=digest(request), payload={"entities": []}, evidence_refs=[f.records()[0].ref()], source_version="v1", coverage={"complete": False})
    executor.router = Router({"document.entities": PartialProvider()})
    result = await executor.run(f.invocation("document.entities.extract"), principal)
    assert result.error["code"] == "EVIDENCE_INSUFFICIENT"


async def test_cancel_running_provider_persists_terminal_state(environment):
    _, executor, principal = environment
    entered = asyncio.Event()
    class SlowProvider:
        provider_id = "synthetic-recording"
        async def invoke(self, capability, request):
            entered.set()
            await asyncio.Event().wait()
    executor.router = Router({"document.entities": SlowProvider()})
    request = f.invocation("document.entities.extract")
    task = asyncio.create_task(executor.run(request, principal))
    await asyncio.wait_for(entered.wait(), timeout=2)
    assert executor.cancel(request.execution_id, principal)["lifecycle"] == "CANCELLATION_REQUESTED"
    with pytest.raises(asyncio.CancelledError):
        await task
    assert executor.status(request.execution_id, principal)["lifecycle"] == "CANCELLED"


async def test_pending_approval_cancellation_revokes_resume(environment):
    _, executor, principal = environment
    request = f.invocation("decision.disposition.record")
    pending = await executor.run(request, principal)
    aid = pending.unresolved_items[0]["approval_id"]
    assert executor.cancel(request.execution_id, principal)["lifecycle"] == "CANCELLED"
    reviewer = f.principal("reviewer"); reviewer.permissions.add("approve:decision.disposition.record")
    with pytest.raises(SkillError):
        executor.approve(aid, reviewer)
