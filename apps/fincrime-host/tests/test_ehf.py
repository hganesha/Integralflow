import asyncio
from copy import deepcopy
import hashlib
import json
import subprocess
import sys
import threading

import httpx
import pytest
from pydantic import ValidationError

from financial_crime import synthetic as f
from financial_crime.contracts import SkillError, Status, digest
from financial_crime.ehf import Bridge, BridgeRequest, BridgeOutcome, ContextPacket, SnapshotRepository, SyntheticAuthority, create_bridge_host, export_catalog, synthetic_assignment
from financial_crime.registry import load_registry, validate
from financial_crime.tasks import TaskSpec, compile_task, check_completion, context_products, workforce

AGENTS, TASKS = workforce()
STEPS = [(task.id, step) for task in TASKS.values() for step in task.steps]


def test_catalog_preserves_every_executable_contract_and_exact_source_digest():
    envelope = export_catalog()
    assert hashlib.sha256(envelope['content'].encode()).hexdigest() == envelope['sha256']
    catalog = json.loads(envelope['content'])
    assert len(catalog['skills']) == 232 and len(catalog['agents']) == len(catalog['tasks']) == 7
    for artifact in catalog['skills']:
        assert digest(artifact['value']) == artifact['sha256']
        assert json.loads(artifact['canonical']) == artifact['value']
        spec = load_registry()[artifact['value']['id']]
        assert artifact['value']['entrypoint'] == spec.manifest()['entrypoint']
        assert artifact['value']['input_schema'] == spec.params
        assert artifact['value']['output_schema'] == spec.output
        assert digest(artifact['instructionContent']) == artifact['value']['instruction_hash']


def test_products_cover_all_context_objects_and_tasks_avoid_duplicate_computation():
    from financial_crime.context_types import CONTEXT_TYPES
    assert len(context_products()) == 12
    assert {t for p in context_products().values() for t in p.objects} == CONTEXT_TYPES
    identity = TASKS['task.identity_ownership']
    assert 'ownership.ubo.resolve' in [s.skill_id for s in identity.steps]
    assert 'ownership.interest.calculate' not in [s.skill_id for s in identity.steps]
    assert all('case.create' not in [s.skill_id for s in t.steps] for t in TASKS.values())


def test_snapshot_digest_is_stable_across_process_hash_randomization():
    other = subprocess.check_output([sys.executable, '-c', 'from financial_crime.ehf import SyntheticAuthority; print(SyntheticAuthority().snapshot_digest)'], text=True).strip()
    assert other == SyntheticAuthority().snapshot_digest


@pytest.mark.parametrize('task', list(TASKS.values()), ids=lambda t: t.id)
def test_all_tasks_compile_with_declared_inputs_and_profile_ceilings(task):
    inputs = {}
    for step in task.steps:
        for parameter, name in step.input_bindings.items(): inputs[name] = f.parameters(step.skill_id)[parameter]
    plan = compile_task(task, AGENTS[task.agent_profile], inputs)
    assert plan.task_hash == digest(task)
    assert len(plan.steps) == len(task.steps)
    for step in plan.steps: validate(load_registry()[step.skill_id].params, step.parameters)
    with pytest.raises(SkillError): compile_task(task, AGENTS[task.agent_profile], {**inputs, 'undeclared': True})
    assert not check_completion(task, {})['complete']


@pytest.mark.parametrize('task_id,step', STEPS, ids=[step.skill_id for _,step in STEPS])
async def test_all_initial_task_skills_run_proposal_only(task_id, step):
    bridge = Bridge(SyntheticAuthority(), f.router())
    outcome = await bridge.execute(synthetic_assignment(step.skill_id))
    assert outcome.error_code is None, outcome
    assert outcome.status == (Status.NEEDS_REVIEW if step.skill_id == 'decision.human.review' else Status.COMPLETED)
    assert outcome.effects_committed is False and outcome.synthetic is True
    assert outcome.context_hash and outcome.context_manifest
    validate(load_registry()[step.skill_id].output, outcome.payload)


@pytest.mark.parametrize('change', [dict(bundle_code_hash='0'*64), dict(profile_hash='0'*64), dict(instruction_hash='0'*64), dict(skill_version='999.0.0'), dict(task_id='task.qa_assurance')])
async def test_bridge_rejects_unpinned_or_unassigned_artifacts(change):
    request = synthetic_assignment('ownership.ubo.resolve')
    request.scope = request.scope.model_copy(update=change)
    result = await Bridge(SyntheticAuthority()).execute(request)
    assert result.status in {Status.BLOCKED, Status.FAILED} and result.error_code


async def test_no_identity_permissions_can_be_supplied_in_the_request():
    raw = synthetic_assignment('entity.resolve').model_dump(mode='json')
    with pytest.raises(ValidationError): BridgeRequest.model_validate({**raw, 'principal': f.principal().model_dump(mode='json')})


async def test_parameters_are_bound_to_the_authorized_work_item():
    request = synthetic_assignment('entity.resolve')
    request.parameters['name'] = 'unassigned customer'
    assert (await Bridge(SyntheticAuthority()).execute(request)).error_code == 'ACCESS_DENIED'


async def test_published_bridge_schemas_validate_full_context_and_selected_skill_payload():
    authority = SyntheticAuthority(); request = synthetic_assignment('ownership.ubo.resolve')
    _, packet = await authority.resolve(request.scope)
    validate(ContextPacket.model_json_schema(), packet.model_dump(mode='json'))
    result = await Bridge(authority).execute(request)
    wire = result.model_dump(mode='json'); validate(BridgeOutcome.model_json_schema(), wire)
    wire['payload'] = {'invented': True}
    with pytest.raises(SkillError): validate(BridgeOutcome.model_json_schema(), wire)


def test_human_task_criteria_do_not_complete_from_a_proposal_alone():
    task = TASKS['task.decision_support']
    results = {c.step_id: {'status': c.accepted_statuses[0], 'payload': {field: None for field in c.required_payload_fields}}
        for c in task.completion_criteria}
    assert not check_completion(task, results)['complete']
    results['decision_human_review']['human_decision'] = {'authority': 'HUMAN', 'decision': 'APPROVE', 'decisionIds': ['review-a','review-b']}
    assert check_completion(task, results)['complete']


async def test_profile_context_and_policy_ceilings_are_enforced():
    authority = SyntheticAuthority()
    request = synthetic_assignment('ownership.ubo.resolve')
    agents = deepcopy(AGENTS); agent = agents[request.scope.profile_id]
    agent.execution.context_fields.pop('OwnershipInterest')
    request.scope.profile_hash = digest(agent)
    result = await Bridge(authority, agents=agents).execute(request)
    assert result.error_code == 'ACCESS_DENIED'
    agents = deepcopy(AGENTS); agent = agents[request.scope.profile_id]
    agent.execution.policy_fields.clear(); request.scope.profile_hash = digest(agent)
    assert (await Bridge(authority, agents=agents).execute(request)).error_code == 'ACCESS_DENIED'


async def test_live_authority_is_rechecked_after_computation():
    class Revoked(SyntheticAuthority):
        def __init__(self): super().__init__(); self.calls = 0
        async def assert_current(self, scope):
            self.calls += 1
            if self.calls >= 3: raise SkillError('ACCESS_DENIED', 'work cancelled')
            await super().assert_current(scope)
    result = await Bridge(Revoked()).execute(synthetic_assignment('entity.resolve'))
    assert result.error_code == 'ACCESS_DENIED' and result.payload == {}


async def test_snapshot_cannot_mutate_state_or_bypass_tenant_binding():
    request = synthetic_assignment('entity.resolve'); authority = SyntheticAuthority()
    _, packet = await authority.resolve(request.scope)
    repository = SnapshotRepository(packet)
    with pytest.raises(SkillError): repository.set_state('tenant-synthetic', 'case', 'case-demo', 0, {})
    with pytest.raises(SkillError): repository.records('other-tenant', 'Entity')
    with pytest.raises(ValidationError): ContextPacket.model_validate({**packet.model_dump(mode='python'), 'tenant_id': 'other'})


def test_bridge_http_host_authenticates_and_returns_typed_outcomes():
    host = create_bridge_host(Bridge(SyntheticAuthority(), f.router()), lambda r: r.headers.get('authorization') == 'Bearer explicit-local-test')
    server = host.server('127.0.0.1', 0)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        base = f'http://127.0.0.1:{server.server_address[1]}'
        with httpx.Client(base_url=base, timeout=30) as client:
            assert client.get('/readiness').status_code == 200
            body = synthetic_assignment('entity.resolve').model_dump(mode='json')
            assert client.post('/invocations', json=body).status_code == 401
            headers = {'authorization': 'Bearer explicit-local-test'}
            response = client.post('/invocations', json=body, headers=headers)
            assert response.status_code == 200 and response.json()['status'] == 'COMPLETED'
            assert client.post('/invocations', json={**body, 'permissions': ['all']}, headers=headers).status_code == 400
            assert client.post('/invocations', content=b'x' * (host.MAX_BODY + 1), headers=headers).status_code == 413
            task = TASKS['task.identity_ownership']; agent = AGENTS[task.agent_profile]
            inputs = {name: f.parameters(step.skill_id)[parameter] for step in task.steps for parameter, name in step.input_bindings.items()}
            plan = client.post('/invocations', headers=headers, json={'api_version': 'fincrime.ehf/plan-request-v1', 'task_id': task.id,
                'task_hash': digest(task), 'profile_hash': digest(agent), 'inputs': inputs})
            assert plan.status_code == 200 and plan.json() == compile_task(task, agent, inputs).model_dump(mode='json')
            stale = client.post('/invocations', headers=headers, json={'api_version': 'fincrime.ehf/plan-request-v1', 'task_id': task.id,
                'task_hash': '0' * 64, 'profile_hash': digest(agent), 'inputs': {}})
            assert stale.status_code == 409
    finally:
        server.shutdown(); server.server_close()


def test_task_cycles_and_undefined_completion_fields_fail_at_registration():
    raw = TASKS['task.identity_ownership'].model_dump(mode='json')
    raw['steps'][0]['dependencies']=[raw['steps'][-1]['id']]
    with pytest.raises(ValidationError): TaskSpec.model_validate(raw)
    raw = TASKS['task.identity_ownership'].model_dump(mode='json')
    raw['completion_criteria'][0]['required_payload_fields']=['not_a_payload_field']
    with pytest.raises(ValidationError): TaskSpec.model_validate(raw)
