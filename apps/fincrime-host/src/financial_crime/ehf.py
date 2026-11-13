"""Lossless EHF catalog export and proposal-only execution over authorized snapshots.

The EHF controller owns task durability, retries, approvals and business mutations.
This module deliberately never invokes the local executor's approval/effect machinery.
"""
from __future__ import annotations

from copy import deepcopy
import asyncio
import inspect
import json
from typing import Literal, Protocol

from pydantic import Field, JsonValue, AwareDatetime, model_validator

from .contracts import Contract, Computation, ContextManifest, EffectCommand, Identifier, Invocation, Principal, Record, Ref, SkillError, Status, canonical, digest
from .context import ContextCompiler
from .execution import Services
from .providers import Router
from .registry import bundle_code_hash, instructions_for, load_registry, validate
from .tasks import workforce, context_products, compile_task
from .versions import RELEASE_VERSION, SCHEMA_VERSION

EHF_SOURCE_REVISION = "63874109c2ad9c4405e9337c66ec3c87886ddce7"


class AssignmentScope(Contract):
    tenant_id: Identifier
    case_id: Identifier
    run_id: Identifier
    node_id: Identifier
    work_item_id: Identifier
    execution_id: Identifier
    work_fencing_epoch: int = Field(ge=1)
    run_fencing_epoch: int = Field(ge=1)
    case_sequence: int = Field(ge=0)
    plan_digest: str = Field(pattern="^[a-f0-9]{64}$")
    snapshot_digest: str = Field(pattern="^[a-f0-9]{64}$")
    task_id: Identifier
    task_version: Identifier
    profile_id: Identifier
    profile_hash: str = Field(pattern="^[a-f0-9]{64}$")
    skill_id: Identifier
    skill_version: Identifier
    bundle_code_hash: str = Field(pattern="^[a-f0-9]{64}$")
    instruction_hash: str = Field(pattern="^[a-f0-9]{64}$")


class BridgeRequest(Contract):
    api_version: Literal["fincrime.ehf/assignment-v1"] = "fincrime.ehf/assignment-v1"
    scope: AssignmentScope
    parameters: dict[str, JsonValue]


class PlanRequest(Contract):
    api_version: Literal["fincrime.ehf/plan-request-v1"] = "fincrime.ehf/plan-request-v1"
    task_id: Identifier
    task_hash: str = Field(pattern="^[a-f0-9]{64}$")
    profile_hash: str = Field(pattern="^[a-f0-9]{64}$")
    inputs: dict[str, JsonValue]


class StateSnapshot(Contract):
    kind: Identifier
    object_id: Identifier
    revision: int = Field(ge=0)
    data: dict[str, JsonValue] | None


class AuditSnapshotEntry(Contract):
    event: dict[str, JsonValue]
    hash: str = Field(pattern="^[a-f0-9]{64}$")


class ContextPacket(Contract):
    tenant_id: Identifier
    case_id: Identifier
    case_sequence: int = Field(ge=0)
    snapshot_digest: str = Field(pattern="^[a-f0-9]{64}$")
    policy_snapshot_ref: Identifier
    subject_ids: list[Identifier]
    purpose: Literal["onboarding", "review", "monitoring", "investigation", "fraud", "reporting"]
    as_of_time: AwareDatetime
    knowledge_cutoff: AwareDatetime
    authorized_parameters: dict[str, JsonValue]
    records: list[Record]
    states: list[StateSnapshot] = Field(default_factory=list)
    audit_chain: list[AuditSnapshotEntry] | None = None

    @model_validator(mode="after")
    def same_tenant(self):
        if any(r.tenant_id != self.tenant_id for r in self.records):
            raise ValueError("context packet crosses tenant boundary")
        if len({(r.object_type, r.id, r.version_id) for r in self.records}) != len(self.records):
            raise ValueError("duplicate canonical record version")
        return self

    @classmethod
    def model_json_schema(cls, *args, **kwargs):
        base = super().model_json_schema(*args, **kwargs)
        records = Record.model_json_schema()
        base.setdefault("$defs", {}).update(records.get("$defs", {}))
        base["$defs"]["Record"] = {k: v for k, v in records.items() if k != "$defs"}
        return base


class BridgeOutcome(Contract):
    api_version: Literal["fincrime.ehf/outcome-v1"] = "fincrime.ehf/outcome-v1"
    scope: AssignmentScope
    status: Status
    payload: dict[str, JsonValue] = Field(default_factory=dict)
    context_manifest: ContextManifest | None = None
    context_hash: str | None = None
    evidence_refs: list[Ref] = Field(default_factory=list)
    proposed_commands: list[EffectCommand] = Field(default_factory=list)
    provider_captures: list[dict[str, JsonValue]] = Field(default_factory=list)
    unresolved_items: list[dict[str, JsonValue]] = Field(default_factory=list)
    error_code: str | None = None
    effects_committed: Literal[False] = False
    synthetic: bool = False

    @model_validator(mode="after")
    def computed_payload(self):
        if self.context_manifest is not None:
            spec = load_registry().get(self.scope.skill_id)
            if spec is None or self.scope.skill_version != spec.version:
                raise ValueError("computed outcome skill version is unsupported")
            validate(spec.output, self.payload, "OUTPUT_INVALID")
            if (self.context_manifest.tenant_id, self.context_manifest.skill_id, self.context_manifest.skill_version, self.context_manifest.scope.case_id) != (
                    self.scope.tenant_id, spec.id, spec.version, self.scope.case_id) or self.context_hash != digest(self.context_manifest):
                raise ValueError("outcome context manifest binding is invalid")
        return self

    @classmethod
    def model_json_schema(cls, *args, **kwargs):
        from .schema_types import document, ref
        registry = load_registry()
        base = super().model_json_schema(*args, **kwargs)
        rules = {"properties": {"scope": {"properties": {"skill_id": {"enum": sorted(registry)}}}},
            "allOf": [{"if": {"properties": {"scope": {"properties": {"skill_id": {"const": sid}}}}},
            "then": {"properties": {"payload": ref("Payload_"+sid.replace(".", "_")),
                "scope": {"properties": {"skill_version": {"const": spec.version}}},
                "context_manifest": {"properties": {"skill_id": {"const": sid}, "skill_version": {"const": spec.version}}}}}} for sid, spec in registry.items()]}
        base["allOf"] = [{"if": {"required": ["context_manifest"], "properties": {"context_manifest": {"not": {"type": "null"}}}}, "then": rules}]
        base.setdefault("$defs", {}).update(document(rules)["$defs"])
        return base


class Authority(Protocol):
    async def resolve(self, scope: AssignmentScope) -> tuple[Principal, ContextPacket]: ...
    async def assert_current(self, scope: AssignmentScope) -> None: ...


class SnapshotRepository:
    """Read-only snapshot, never a second business database or workflow journal."""
    def __init__(self, packet: ContextPacket):
        self.packet = packet

    def records(self, tenant, object_type):
        if tenant != self.packet.tenant_id:
            raise SkillError("ACCESS_DENIED", "snapshot tenant mismatch")
        return [r.model_copy(deep=True) for r in self.packet.records if r.object_type == object_type]

    def state(self, tenant, kind, object_id):
        if tenant != self.packet.tenant_id:
            raise SkillError("ACCESS_DENIED", "snapshot tenant mismatch")
        for state in self.packet.states:
            if state.kind == kind and state.object_id == object_id:
                return state.revision, deepcopy(state.data)
        raise SkillError("CONTEXT_MISSING", "state was not included in the authorized snapshot", Status.NEEDS_EVIDENCE)

    def audit_chain(self, tenant):
        if tenant != self.packet.tenant_id or self.packet.audit_chain is None:
            raise SkillError("CONTEXT_MISSING", "audit input was not declared", Status.NEEDS_EVIDENCE)
        return [(deepcopy(item.event), item.hash) for item in self.packet.audit_chain]

    def outbox_item(self, *args):
        raise SkillError("CONTEXT_MISSING", "delivery receipt requires a governed snapshot adapter", Status.NEEDS_EVIDENCE)

    def __getattr__(self, name):
        raise SkillError("CONTROL_FAILED", "bridge cannot mutate canonical or orchestration state")


class Bridge:
    def __init__(self, authority: Authority, router=None, *, agents=None, tasks=None):
        self.authority, self.router = authority, router or Router()
        self.registry = load_registry()
        defaults = workforce()
        self.agents, self.tasks = agents if agents is not None else defaults[0], tasks if tasks is not None else defaults[1]

    async def execute(self, request: BridgeRequest) -> BridgeOutcome:
        scope = request.scope
        try:
            agent, task = self.agents.get(scope.profile_id), self.tasks.get(scope.task_id)
            if agent is None or task is None or task.agent_profile != scope.profile_id or scope.task_id not in agent.task_ids:
                raise SkillError("ACCESS_DENIED", "unadmitted business assignment")
            if scope.profile_hash != digest(agent) or scope.task_version != task.version or scope.bundle_code_hash != bundle_code_hash():
                raise SkillError("INTEGRITY_FAILURE", "assignment artifacts differ from installed bundle")
            spec = self.registry.get(scope.skill_id)
            if (spec is None or spec.version != scope.skill_version or agent.execution.allowed_skills.get(spec.id) != spec.version
                    or not any(s.skill_id == spec.id and s.skill_version == spec.version for s in task.steps)):
                raise SkillError("ACCESS_DENIED", "skill outside pinned task")
            if scope.instruction_hash != digest(instructions_for(spec.id)):
                raise SkillError("INTEGRITY_FAILURE", "instructions differ from admitted artifact")
            validate(spec.params, request.parameters)
            principal, packet = await self.authority.resolve(scope)
            packet = ContextPacket.model_validate(packet.model_dump(mode="python"))
            if (packet.tenant_id, packet.case_id, packet.case_sequence, packet.snapshot_digest) != (
                    scope.tenant_id, scope.case_id, scope.case_sequence, scope.snapshot_digest):
                raise SkillError("INTEGRITY_FAILURE", "assignment and authorized snapshot disagree")
            if canonical(packet.authorized_parameters) != canonical(request.parameters):
                raise SkillError("ACCESS_DENIED", "parameters differ from the authorized work item")
            required = {"skill:"+spec.id} | ({"effect:"+spec.effects} if spec.effects != "read_only" else set())
            if (principal.revoked or principal.tenant_id != scope.tenant_id
                    or not required <= principal.permissions & agent.execution.permissions
                    or packet.purpose not in principal.purposes & agent.execution.purposes):
                raise SkillError("ACCESS_DENIED", "identity or action denied")
            invocation = Invocation(execution_id=scope.execution_id, skill_id=spec.id, skill_version=spec.version,
                tenant_id=scope.tenant_id, actor_ref=principal.actor_id, profile_id=agent.id, case_id=scope.case_id,
                subject_ids=packet.subject_ids, parameters=request.parameters, purpose=packet.purpose,
                policy_snapshot_ref=packet.policy_snapshot_ref, as_of_time=packet.as_of_time, knowledge_cutoff=packet.knowledge_cutoff,
                idempotency_key=scope.execution_id, trace_id=scope.run_id)
            store = SnapshotRepository(packet)
            context = ContextCompiler(store).compile(invocation, principal, agent.execution, spec)
            if not required <= set(context.policy.get("permissions", [])):
                raise SkillError("ACCESS_DENIED", "institution policy denies action")
            services = Services(store, self.router, invocation, principal,
                agent.execution.capabilities & set(spec.capabilities), context.manifest.synthetic)
            services.admitted_evidence = {canonical(ref) for ref in context.refs()}
            services.permitted_providers = context.policy.get("permitted_providers", {})
            await self.authority.assert_current(scope)
            async with asyncio.timeout(min(30, agent.execution.timeout_seconds)):
                value = spec.function(request.parameters, context, services)
                value = await value if inspect.isawaitable(value) else value
            computed = value if isinstance(value, Computation) else Computation(payload=json.loads(canonical(value)))
            validate(spec.output, computed.payload, "OUTPUT_INVALID")
            if computed.commands and spec.effects == "read_only":
                raise SkillError("CONTROL_FAILED", "read-only skill proposed an effect")
            evidence = computed.evidence_refs or context.refs()
            if any(canonical(ref) not in services.admitted_evidence for ref in evidence):
                raise SkillError("INTEGRITY_FAILURE", "unadmitted evidence")
            await self.authority.assert_current(scope)
            status = Status.NEEDS_REVIEW if spec.effects == "human_gated" and computed.status == Status.COMPLETED else computed.status
            return BridgeOutcome(scope=scope, status=status, payload=computed.payload,
                context_manifest=context.manifest.model_dump(mode="json"), context_hash=digest(context.manifest),
                evidence_refs=evidence, proposed_commands=computed.commands, provider_captures=services.captures,
                unresolved_items=[i.model_dump(mode="json") for i in computed.unresolved_items], synthetic=context.manifest.synthetic)
        except (SkillError, TimeoutError) as error:
            return BridgeOutcome(scope=scope, status=error.status if isinstance(error, SkillError) else Status.FAILED,
                error_code=error.code if isinstance(error, SkillError) else "TIMEOUT")


def export_catalog(instructions=None):
    """`instructions` maps a skill ID to its SKILL.md text; by default the installed resource is read."""
    instructions = instructions or instructions_for
    registry = load_registry(); agents, tasks = workforce()
    def artifact(value):
        return {"value": json.loads(canonical(value)), "canonical": canonical(value), "sha256": digest(value)}
    manifests = []
    for spec in sorted(registry.values(), key=lambda spec: spec.id):
        manifest = {**spec.manifest(), "harness_name": spec.id.replace(".", "-").replace("_", "-"),
            "instructions": "SKILL.md", "instruction_hash": digest(instructions(spec.id)), "bundle_code_hash": bundle_code_hash()}
        manifests.append({**artifact(manifest), "instructionContent": instructions(spec.id)})
    content = {"apiVersion": "fincrime.ehf/catalog-v1", "sourceRelease": RELEASE_VERSION,
        "contextSchemaVersion": SCHEMA_VERSION, "bundleCodeHash": bundle_code_hash(),
        "skills": manifests, "agents": [artifact(a) for a in agents.values()],
        "tasks": [artifact(t) for t in tasks.values()],
        "contextProducts": [p.model_dump(mode="json") for p in context_products().values()]}
    # Hash exact UTF-8 source bytes, preserving Python schema numeric representations.
    return {"apiVersion": "fincrime.ehf/catalog-artifact-v1", "content": canonical(content), "sha256": digest(content)}


class SyntheticAuthority:
    """Explicit local fixture source; never installed as a production authority."""
    def __init__(self, *, case_id="case-demo", case_sequence=0):
        from . import synthetic as fixture
        self.fixture = fixture
        self.case_id, self.case_sequence = case_id, case_sequence
        self.records = [fixture.make_record("Policy", "synthetic-policy-v1", fixture.policy()), *fixture.records()]
        self.snapshot_digest = digest(self.records)

    async def assert_current(self, scope):
        if (scope.tenant_id, scope.case_id, scope.case_sequence, scope.snapshot_digest) != (
                "tenant-synthetic", self.case_id, self.case_sequence, self.snapshot_digest):
            raise SkillError("ACCESS_DENIED", "synthetic fixture scope mismatch")

    async def resolve(self, scope):
        await self.assert_current(scope)
        return self.fixture.principal("ehf-synthetic-worker"), ContextPacket(
            tenant_id=scope.tenant_id, case_id=scope.case_id, case_sequence=scope.case_sequence,
            snapshot_digest=self.snapshot_digest, policy_snapshot_ref="synthetic-policy-v1", subject_ids=["acme"],
            purpose="onboarding", as_of_time=self.fixture.AT.isoformat(), knowledge_cutoff=self.fixture.AT.isoformat(),
            authorized_parameters=self.fixture.parameters(scope.skill_id),
            records=self.records, states=[StateSnapshot(kind="case", object_id=self.case_id, revision=0, data=None)], audit_chain=[])


def synthetic_assignment(skill_id, *, run_id="ehf-fixture-run", work_item_id=None):
    """Explicit fixture request; no inference or production identity defaults."""
    from . import synthetic
    agents, tasks = workforce()
    task = next(t for t in tasks.values() if any(s.skill_id == skill_id for s in t.steps))
    agent = agents[task.agent_profile]; spec = load_registry()[skill_id]
    return BridgeRequest(scope=AssignmentScope(tenant_id="tenant-synthetic", case_id="case-demo", run_id=run_id,
        node_id=skill_id.replace(".", "_"), work_item_id=work_item_id or "work-"+skill_id,
        execution_id="exec-"+skill_id, work_fencing_epoch=1, run_fencing_epoch=1, case_sequence=0,
        plan_digest=digest("synthetic-plan"), snapshot_digest=SyntheticAuthority().snapshot_digest,
        task_id=task.id, task_version=task.version, profile_id=agent.id, profile_hash=digest(agent),
        skill_id=skill_id, skill_version=spec.version, bundle_code_hash=bundle_code_hash(),
        instruction_hash=digest(instructions_for(skill_id))), parameters=synthetic.parameters(skill_id))


class BridgeHost:
    """Portable HTTP host for the bridge (standard library only, no cloud SDK).

    POST /invocations takes a `fincrime.ehf/assignment-v1` BridgeRequest or a
    `fincrime.ehf/plan-request-v1` PlanRequest; GET /readiness and /liveness are unauthenticated.
    `authenticate(request)` receives the request handler (use `request.headers`) and must return True.
    """
    MAX_BODY = 1_048_576

    def __init__(self, bridge: Bridge, authenticate):
        self.bridge, self.authenticate = bridge, authenticate

    async def _admitted(self, request) -> bool:
        admitted = self.authenticate(request)
        if inspect.isawaitable(admitted):
            admitted = await admitted
        return admitted is True

    async def handle(self, request, body: bytes) -> tuple[int, dict]:
        from pydantic import ValidationError
        if not await self._admitted(request):
            return 401, {"error": "ACCESS_DENIED"}
        try:
            raw = json.loads(body)
            if isinstance(raw, dict) and raw.get("api_version") == "fincrime.ehf/plan-request-v1":
                planning = PlanRequest.model_validate(raw)
                task = self.bridge.tasks.get(planning.task_id)
                agent = self.bridge.agents.get(task.agent_profile) if task else None
                if task is None or agent is None or planning.task_hash != digest(task) or planning.profile_hash != digest(agent):
                    return 409, {"error": "INTEGRITY_FAILURE"}
                return 200, compile_task(task, agent, planning.inputs).model_dump(mode="json")
            assignment = BridgeRequest.model_validate_json(body)
            result = await self.bridge.execute(assignment)
            return 200, result.model_dump(mode="json")
        except SkillError as error:
            return 400, {"error": error.code}
        except (ValidationError, ValueError, TypeError):
            return 400, {"error": "INPUT_INVALID"}

    def handler(self):
        from http.server import BaseHTTPRequestHandler
        host = self

        class Handler(BaseHTTPRequestHandler):
            server_version = "financial-crime-ehf-bridge"
            sys_version = ""

            def log_message(self, format, *args):  # never log bodies or identifiers
                pass

            def _send(self, status: int, payload: dict):
                data = json.dumps(payload).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_GET(self):
                if self.path in ("/readiness", "/liveness"):
                    return self._send(200, {"status": "ok"})
                self._send(404, {"error": "NOT_FOUND"})

            def do_POST(self):
                if self.path != "/invocations":
                    return self._send(404, {"error": "NOT_FOUND"})
                try:
                    length = int(self.headers.get("Content-Length") or 0)
                except ValueError:
                    return self._send(400, {"error": "INPUT_INVALID"})
                if length > host.MAX_BODY:
                    return self._send(413, {"error": "INPUT_TOO_LARGE"})
                body = self.rfile.read(length) if length > 0 else b""
                self._send(*asyncio.run(host.handle(self, body)))

        return Handler

    def server(self, host: str = "0.0.0.0", port: int | None = None):
        import os
        from http.server import ThreadingHTTPServer
        return ThreadingHTTPServer((host, int(os.environ.get("PORT", "8088")) if port is None else port), self.handler())

    def run(self, host: str = "0.0.0.0", port: int | None = None) -> None:
        self.server(host, port).serve_forever()


def create_bridge_host(bridge: Bridge, authenticate) -> BridgeHost:
    """Bridge HTTP host; authenticators are injected and request bodies cannot grant access."""
    return BridgeHost(bridge, authenticate)


def configured_bridge_host() -> BridgeHost:
    import hashlib
    import hmac
    import os
    from . import synthetic
    token_hash = os.environ.get("FC_EHF_BEARER_SHA256", "")
    if os.environ.get("FC_EHF_SYNTHETIC") != "true" or len(token_hash) != 64:
        raise RuntimeError("EHF bootstrap requires explicit synthetic mode and a bearer hash; production must inject Authority/authentication")
    def authenticate(request):
        auth = request.headers.get("authorization", "")
        return auth.startswith("Bearer ") and hmac.compare_digest(hashlib.sha256(auth[7:].encode()).hexdigest(), token_hash)
    authority = SyntheticAuthority(case_id=os.environ.get("FC_EHF_CASE_ID", "case-demo"), case_sequence=int(os.environ.get("FC_EHF_CASE_SEQUENCE", "0")))
    return create_bridge_host(Bridge(authority, synthetic.router()), authenticate)


if __name__ == "__main__":
    configured_bridge_host().run()
