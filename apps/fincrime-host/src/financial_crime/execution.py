"""Runtime-independent executor and controlled local effects."""
from __future__ import annotations

import asyncio
import importlib.metadata
import inspect
import json
import time
import sys
from dataclasses import dataclass, field
from datetime import timedelta

from .context import ContextCompiler
from .contracts import AgentProfile, Computation, Invocation, Principal, Record, RecordView, UnresolvedItem, SkillError, SkillResult, Status, canonical, digest, now
from .providers import Router
from .repositories import Repository
from .registry import bundle_code_hash, instructions_for, load_registry, validate


@dataclass
class Services:
    store: Repository
    router: Router
    invocation: Invocation
    principal: Principal
    capabilities: set[str]
    synthetic: bool = True
    admitted_evidence: set[str] = field(default_factory=set)
    captures: list[dict] = field(default_factory=list)
    permitted_providers: dict[str, list[str]] = field(default_factory=dict)

    def state(self, kind, object_id=None):
        return self.store.state(self.invocation.tenant_id, kind, object_id or self.invocation.case_id or self.invocation.execution_id)

    async def provider(self, capability, payload):
        response = await self.router.invoke(capability, payload, permitted=self.capabilities, allowed_providers=set(self.permitted_providers.get(capability, [])))
        if response.synthetic and not self.synthetic:
            raise SkillError("CONTROL_FAILED", "synthetic provider cannot assess non-synthetic context")
        if any(x.tenant_id != self.invocation.tenant_id for x in response.evidence_refs):
            raise SkillError("INTEGRITY_FAILURE", "provider evidence crosses tenant boundary")
        if not response.evidence_refs or any(canonical(x) not in self.admitted_evidence for x in response.evidence_refs):
            raise SkillError("INTEGRITY_FAILURE", "provider cites unadmitted evidence")
        self.captures.append({"request": payload, "response": response.model_dump(mode="json")})
        return response


class Executor:
    def __init__(self, store: Repository, profiles: list[AgentProfile], router=None, command_sink=None):
        self.store, self.profiles, self.router = store, {p.id: p for p in profiles}, router or Router()
        # A host that serves skills to another platform receives every effect command a skill
        # computes (applied or held for approval), so none is lost with this executor's store.
        self.command_sink = command_sink
        self.registry = load_registry()
        if len(self.profiles) != len(profiles):
            raise ValueError("duplicate agent profile IDs")
        for profile in profiles:
            if any(k not in self.registry or self.registry[k].version != v for k, v in profile.allowed_skills.items()):
                raise ValueError("profile references an unknown skill/version")
        self.compiler = ContextCompiler(store)
        self._lock = asyncio.Lock()
        self._active = {}

    def _admit(self, request, principal):
        if principal.revoked or principal.tenant_id != request.tenant_id or principal.actor_id != request.actor_ref:
            raise SkillError("ACCESS_DENIED", "identity mismatch")
        profile = self.profiles.get(request.profile_id)
        spec = self.registry.get(request.skill_id)
        if profile is None or spec is None:
            raise SkillError("ACCESS_DENIED", "profile or skill unavailable")
        if profile.allowed_skills.get(spec.id) != request.skill_version or spec.version != request.skill_version:
            raise SkillError("ACCESS_DENIED", "skill version not admitted by profile")
        required = {f"skill:{spec.id}"}
        if spec.effects != "read_only":
            required.add(f"effect:{spec.effects}")
        effective = principal.permissions & profile.permissions
        if not required <= effective or request.purpose not in principal.purposes & profile.purposes:
            raise SkillError("ACCESS_DENIED", "action or purpose denied")
        validate(spec.params, request.parameters)
        return profile, spec

    async def run(self, request: Invocation, principal: Principal, *, approved_task=None):
        key = (request.tenant_id, principal.actor_id, request.execution_id)
        task = asyncio.current_task()
        owner = key not in self._active
        if owner:
            self._active[key] = task
        try:
            return await self._execute(request, principal, approved_task=approved_task)
        finally:
            if owner:
                self._active.pop(key, None)

    async def _execute(self, request: Invocation, principal: Principal, *, approved_task=None):
        started = time.monotonic()
        result_base = dict(execution_id=request.execution_id, skill_id=request.skill_id, skill_version=request.skill_version,
                           policy_snapshot_ref=request.policy_snapshot_ref, trace_ref=request.trace_id)
        # One executor serializes runs; SQLite transactions protect state across executor instances.
        async with self._lock:
            reserved = False
            try:
                profile, spec = self._admit(request, principal)
                context_spec = spec
                if spec.id == "case.context.hydrate":
                    target = self.registry.get(request.parameters["target_skill"])
                    if target is None or target.id == spec.id or profile.allowed_skills.get(target.id) != target.version or f"skill:{target.id}" not in principal.permissions & profile.permissions:
                        raise SkillError("ACCESS_DENIED", "target context skill not admitted")
                    context_spec = target
                context = self.compiler.compile(request, principal, profile, context_spec)
                if spec.effects != "read_only" and not context.manifest.synthetic:
                    raise SkillError("CONTROL_FAILED", "this release permits consequential effects only on explicitly synthetic context")
                policy_permissions = set(context.policy.get("permissions", []))
                required = {f"skill:{spec.id}"} | ({f"effect:{spec.effects}"} if spec.effects != "read_only" else set())
                if not required <= policy_permissions:
                    raise SkillError("ACCESS_DENIED", "tenant policy does not grant action")
                if spec.id == "case.context.hydrate" and f"skill:{target.id}" not in policy_permissions:
                    raise SkillError("ACCESS_DENIED", "tenant policy denies target context")
                request_hash = digest(request)
                context_hash = digest(context.manifest)
                key = (request.tenant_id, principal.actor_id, request.idempotency_key)
                old = self.store.get_job(*key)
                if old:
                    if old.request_hash != request_hash:
                        raise SkillError("IDEMPOTENCY_CONFLICT", "key is already bound to different input")
                    saved = old.body
                    if saved.get("state") == "RUNNING":
                        raise SkillError("EXECUTION_IN_PROGRESS", "durable job requires recovery", retryable=True)
                    if not approved_task:
                        return SkillResult.model_validate(saved["result"])
                    if saved.get("result", {}).get("lifecycle") == "CANCELLED":
                        raise SkillError("CONTROL_FAILED", "cancelled work cannot resume")
                elif approved_task:
                    raise SkillError("ACCESS_DENIED", "approval cannot create a new job")
                lock = {"profile_hash": digest(profile), "skill_version": spec.version, "code_hash": spec.code_hash,
                        "bundle_code_hash": bundle_code_hash(), "instruction_hash": digest(instructions_for(spec.id)),
                        "python_version": sys.version.split()[0],
                        "policy_hash": context.manifest.policy_hash, "context_hash": context_hash,
                        "requirements_hash": context.manifest.requirements_hash, "capabilities": sorted(profile.capabilities & set(spec.capabilities)),
                        "libraries": {n: importlib.metadata.version(n) for n in ["pydantic", "jsonschema", "networkx"]}}
                if approved_task:
                    self._validate_approval(approved_task, request, request_hash, context_hash, digest(lock))
                with self.store.transaction():
                    self.store.claim_job(*key, request_hash, {"state": "RUNNING", "request": request.model_dump(mode="json")}, resume=bool(approved_task))
                    if not any(r.id == context_hash for r in self.store.records(request.tenant_id, "ContextManifest")):
                        self.store.put(Record(id=context_hash, tenant_id=request.tenant_id, object_type="ContextManifest",
                            version_id=context_hash, data=context.manifest.model_dump(mode="json"), subject_ids=request.subject_ids,
                            synthetic=context.manifest.synthetic))
                    self.store.event(request.tenant_id, {"event": "skill_started", "execution_id": request.execution_id, "skill_id": spec.id, "lock": lock})
                reserved = True
                services = Services(self.store, self.router, request, principal, profile.capabilities & set(spec.capabilities), context.manifest.synthetic)
                services.admitted_evidence = {canonical(x) for x in context.refs()}
                services.permitted_providers = context.policy.get("permitted_providers", {})
                async def compute():
                    if inspect.iscoroutinefunction(spec.function):
                        return await spec.function(request.parameters, context, services)
                    # A synchronous skill runs off the event loop, so the timeout below answers on
                    # time instead of waiting for a computation that never yields.
                    result = await asyncio.to_thread(spec.function, request.parameters, context, services)
                    return await result if inspect.isawaitable(result) else result
                async with asyncio.timeout(min(profile.timeout_seconds, 30)):
                    computed = await compute()
                if not isinstance(computed, Computation):
                    computed = Computation(payload=json.loads(canonical(computed)))
                validate(spec.output, computed.payload, "OUTPUT_INVALID")
                if computed.commands and spec.effects == "read_only":
                    raise SkillError("CONTROL_FAILED", "read-only skill attempted an effect")
                if computed.commands and spec.effects == "proposal":
                    # A proposal skill's output is proposals for the platform to commit under the
                    # node's grants; it never applies an effect itself.
                    raise SkillError("CONTROL_FAILED", "proposal skill attempted an effect")
                evidence = computed.evidence_refs or context.refs()
                allowed_refs = {canonical(x) for x in context.refs()}
                for ref in evidence:
                    if ref.tenant_id != request.tenant_id or canonical(ref) not in allowed_refs:
                        raise SkillError("INTEGRITY_FAILURE", "unadmitted evidence reference")
                if computed.commands and self.command_sink is not None:
                    self.command_sink([c.model_dump(mode="json", exclude_unset=True) for c in computed.commands])
                with self.store.transaction():
                    if computed.commands:
                        self._validate_action_snapshot(request, context)
                    if spec.effects == "human_gated" and not approved_task:
                        approval_id = digest({"request": request_hash, "context": context_hash})
                        rev, _ = self.store.state(request.tenant_id, "approval", approval_id)
                        case_revision, _ = self.store.state(request.tenant_id, "case", request.case_id or "")
                        self.store.set_state(request.tenant_id, "approval", approval_id, rev,
                            {"status": "PENDING", "skill_id": spec.id, "request_hash": request_hash, "context_hash": context_hash,
                             "execution_lock_hash": digest(lock),
                             "case_revision": case_revision, "case_id": request.case_id, "requester": principal.actor_id,
                             "expires_at": (now()+timedelta(hours=1)).isoformat(), "execution_id": request.execution_id})
                        computed.status = Status.NEEDS_REVIEW
                        computed.payload = {**computed.payload}
                        computed.unresolved_items.append(UnresolvedItem(code="HUMAN_REVIEW_REQUIRED", approval_id=approval_id))
                    else:
                        for command in computed.commands:
                            command = command.model_dump(mode="json", exclude_unset=True)
                            self._apply(command, request, principal)
                            self.store.event(request.tenant_id, {"event": "command_committed", "execution_id": request.execution_id,
                                "command_hash": digest(command), "approval_id": approved_task, "actor": principal.actor_id})
                        if approved_task:
                            rev, task = self.store.state(request.tenant_id, "approval", approved_task)
                            self.store.set_state(request.tenant_id, "approval", approved_task, rev, {**task, "status": "CONSUMED"})
                    for index, capture in enumerate(services.captures):
                        evidence.append(self.store.put(Record(id=f"{request.execution_id}:{index}", tenant_id=request.tenant_id, object_type="ToolInvocation",
                            data=capture, source_refs=context.refs(), subject_ids=request.subject_ids, synthetic=context.manifest.synthetic)))
                    payload_record = Record(id=request.execution_id, tenant_id=request.tenant_id, object_type="SkillExecution",
                        data={"skill_id": spec.id, "payload": computed.payload, "lock": lock, "status": computed.status.value},
                        source_refs=evidence, subject_ids=request.subject_ids, synthetic=context.manifest.synthetic)
                    ref = self.store.put(payload_record)
                    result = SkillResult(**result_base, status=computed.status,
                        lifecycle="WAITING_FOR_HUMAN" if computed.status == Status.NEEDS_REVIEW else "SUCCEEDED",
                        payload=computed.payload, result_refs=[ref], evidence_refs=evidence, unresolved_items=computed.unresolved_items,
                        context_hash=context_hash, execution_lock=lock, synthetic=context.manifest.synthetic,
                        effects_committed=bool(computed.commands) and computed.status != Status.NEEDS_REVIEW,
                        metrics={"duration_ms": int((time.monotonic()-started)*1000), "provider_calls": len(services.captures)})
                    self.store.save_job(*key, {"state": "DONE", "request": request.model_dump(mode="json"), "result": result.model_dump(mode="json")})
                    self.store.event(request.tenant_id, {"event": "skill_completed", "execution_id": request.execution_id, "status": result.status.value})
                return result
            except asyncio.CancelledError:
                # No domain commands are applied before the final transaction. Persist cancellation.
                if reserved:
                    result = SkillResult(**result_base, status=Status.PARTIAL, lifecycle="CANCELLED")
                    self.store.save_job(request.tenant_id, principal.actor_id, request.idempotency_key, {"state": "DONE", "request": request.model_dump(mode="json"), "result": result.model_dump(mode="json")})
                raise
            except (SkillError, TimeoutError) as error:
                if isinstance(error, TimeoutError):
                    error = SkillError("TIMEOUT", "execution budget exceeded", Status.FAILED, True)
                result = SkillResult(**result_base, status=error.status, lifecycle="FAILED", error={"code": error.code, "message": error.message, "retryable": error.retryable})
                if reserved:
                    self.store.save_job(request.tenant_id, principal.actor_id, request.idempotency_key, {"state": "DONE", "request": request.model_dump(mode="json"), "result": result.model_dump(mode="json")})
                return result
            except Exception:
                import logging
                logging.getLogger(__name__).exception("Implementation error in execution %s", request.execution_id)
                result = SkillResult(**result_base, status=Status.FAILED, lifecycle="FAILED", error={"code": "IMPLEMENTATION_ERROR", "retryable": False})
                if reserved:
                    self.store.save_job(request.tenant_id, principal.actor_id, request.idempotency_key, {"state": "DONE", "request": request.model_dump(mode="json"), "result": result.model_dump(mode="json")})
                return result

    def _validate_action_snapshot(self, request, context):
        policy_versions = [r for r in self.store.records(request.tenant_id, "Policy") if r.id == request.policy_snapshot_ref and r.recorded_at <= now()]
        if not policy_versions or digest(max(policy_versions, key=lambda r: (r.recorded_at, r.version_id))) != context.manifest.policy_hash:
            raise SkillError("POLICY_UNRESOLVED", "action policy changed; re-evaluate")
        for ref in context.refs():
            versions = [r for r in self.store.records(request.tenant_id, ref.object_type) if r.id == ref.object_id and r.recorded_at <= now()]
            if versions and max(versions, key=lambda r: (r.recorded_at, r.version_id)).version_id != ref.version_id:
                raise SkillError("CONTEXT_STALE", "action evidence changed; re-evaluate", Status.NEEDS_EVIDENCE)

    def _job(self, execution_id, principal):
        for row in self.store.jobs(principal.tenant_id, actor=principal.actor_id):
            saved = row.body
            request = Invocation.model_validate(saved["request"])
            if request.execution_id == execution_id:
                self._admit(request, principal)
                return row.key, saved
        raise SkillError("CONTEXT_MISSING", "job not found", Status.NEEDS_EVIDENCE)

    def status(self, execution_id, principal):
        _, saved = self._job(execution_id, principal)
        return saved.get("result", {"execution_id": execution_id, "lifecycle": "RUNNING"})

    def cancel(self, execution_id, principal):
        key, saved = self._job(execution_id, principal)
        profile = self.profiles[saved["request"]["profile_id"]]
        if "execution:cancel" not in principal.permissions & profile.permissions:
            raise SkillError("ACCESS_DENIED", "cancellation permission required")
        active = self._active.get((principal.tenant_id, principal.actor_id, execution_id))
        if active:
            active.cancel()
            return {"execution_id": execution_id, "lifecycle": "CANCELLATION_REQUESTED"}
        if saved.get("result", {}).get("lifecycle") != "WAITING_FOR_HUMAN":
            return self.status(execution_id, principal)
        result = SkillResult.model_validate(saved["result"]).model_copy(update={"status": Status.PARTIAL, "lifecycle": "CANCELLED"})
        with self.store.transaction():
            self.store.save_job(principal.tenant_id, principal.actor_id, key, {**saved, "result": result.model_dump(mode="json")})
            for item in result.unresolved_items:
                if item.get("approval_id"):
                    revision, task = self.store.state(principal.tenant_id, "approval", item["approval_id"])
                    if task:
                        self.store.set_state(principal.tenant_id, "approval", item["approval_id"], revision, {**task, "status": "REVOKED"})
            self.store.event(principal.tenant_id, {"event": "execution_cancelled", "execution_id": execution_id})
        return result.model_dump(mode="json")

    def replay(self, context_hash, principal: Principal):
        """Reconstruct projected inputs from retained immutable versions under current authorization."""
        from .contracts import ContextManifest
        if principal.revoked:
            raise SkillError("ACCESS_DENIED", "identity revoked")
        found = [x for x in self.store.records(principal.tenant_id, "ContextManifest") if x.id == context_hash]
        if not found:
            raise SkillError("CONTEXT_MISSING", "manifest unavailable", Status.NEEDS_EVIDENCE)
        manifest = ContextManifest.model_validate(found[0].data)
        if digest(manifest) != context_hash or manifest.authorization_hash != digest(principal):
            raise SkillError("ACCESS_DENIED", "replay authorization changed")
        policy_versions = [x for x in self.store.records(principal.tenant_id, "Policy") if x.id == manifest.policy_ref.object_id and x.version_id == manifest.policy_ref.version_id]
        if not policy_versions or digest(policy_versions[0]) != manifest.policy_hash:
            raise SkillError("INTEGRITY_FAILURE", "replay policy unavailable or changed")
        reconstructed = {}
        for ref in manifest.refs:
            candidates = [x for x in self.store.records(principal.tenant_id, ref.object_type) if x.id == ref.object_id and x.version_id == ref.version_id]
            if not candidates:
                raise SkillError("CONTEXT_MISSING", "replay source unavailable", Status.NEEDS_EVIDENCE)
            source = candidates[0]
            fields = manifest.selected_fields[ref.object_type] or list(source.data)
            source = RecordView.project(source, fields)
            if digest(source) != manifest.content_hashes[digest(ref)]:
                raise SkillError("INTEGRITY_FAILURE", "replay source changed")
            reconstructed.setdefault(ref.object_type, []).append(json.loads(canonical(source)))
        for key in manifest.selected_fields:
            reconstructed.setdefault(key, [])
        if digest(reconstructed) != manifest.structured_hash:
            raise SkillError("INTEGRITY_FAILURE", "replay context hash mismatch")
        return {"manifest": manifest.model_dump(mode="json"), "structured": reconstructed,
                "policy": {k: policy_versions[0].data[k] for k in manifest.policy_fields if k in policy_versions[0].data}}

    def _validate_approval(self, approval_id, request, request_hash, context_hash, lock_hash):
        from datetime import datetime
        _, task = self.store.state(request.tenant_id, "approval", approval_id)
        case_revision, _ = self.store.state(request.tenant_id, "case", request.case_id or "")
        if not task or task["status"] != "APPROVED" or task["request_hash"] != request_hash or task["context_hash"] != context_hash:
            raise SkillError("ACCESS_DENIED", "approval does not bind the current input")
        if task.get("execution_lock_hash") != lock_hash:
            raise SkillError("CONTROL_FAILED", "approved code or runtime changed; re-evaluate")
        if datetime.fromisoformat(task["expires_at"]) <= now() or task["case_revision"] != case_revision:
            raise SkillError("CONTROL_FAILED", "approval expired or case revision changed")

    def approve(self, approval_id, principal: Principal):
        with self.store.transaction():
            rev, task = self.store.state(principal.tenant_id, "approval", approval_id)
            if not task or principal.revoked or f"approve:{task['skill_id']}" not in principal.permissions or principal.actor_id == task["requester"]:
                raise SkillError("ACCESS_DENIED", "independent authorized approver required")
            if principal.case_ids is not None and task["case_id"] not in principal.case_ids:
                raise SkillError("ACCESS_DENIED", "approval case scope denied")
            requests = self.store.jobs(principal.tenant_id, request_hash=task["request_hash"])
            if not requests:
                raise SkillError("CONTROL_FAILED", "approval execution missing")
            invocation = Invocation.model_validate(requests[0].body["request"])
            policy = self.compiler.policy(invocation, principal).data
            allowed_actors = policy.get("role_members", {}).get(policy.get("acceptance_role", "compliance"), [])
            if principal.actor_id not in allowed_actors:
                raise SkillError("ACCESS_DENIED", "approver is not in the policy-authorized role")
            if task["status"] != "PENDING":
                raise SkillError("CONTROL_FAILED", "approval task is not pending")
            self.store.set_state(principal.tenant_id, "approval", approval_id, rev, {**task, "status": "APPROVED", "approver": principal.actor_id})
            self.store.event(principal.tenant_id, {"event": "human_approved", "actor": principal.actor_id, "approval_id": approval_id})

    def _apply(self, command, request, principal):
        kind = command["kind"]
        if kind == "state":
            if command["type"] == "case" and principal.case_ids is not None and command["id"] not in principal.case_ids:
                raise SkillError("ACCESS_DENIED", "case command outside actor scope")
            self.store.set_state(request.tenant_id, command["type"], command["id"], command["expected_revision"], command["data"])
        elif kind == "outbox":
            self.store.add_outbox(request.tenant_id, command)
        else:
            raise SkillError("CONTROL_FAILED", "unsupported effect command")

    def recover(self, request: Invocation, principal: Principal):
        """Operator-controlled recovery, allowed only when no prior worker is active."""
        self._admit(request, principal)
        if "execution:recover" not in principal.permissions:
            raise SkillError("ACCESS_DENIED", "recovery authority required")
        if (request.tenant_id, principal.actor_id, request.execution_id) in self._active:
            raise SkillError("CONTROL_FAILED", "cannot recover an active local worker")
        key = (request.tenant_id, principal.actor_id, request.idempotency_key)
        with self.store.transaction():
            row = self.store.get_job(*key)
            if row and row.request_hash == digest(request) and row.body.get("state") == "RUNNING":
                self.store.discard_job(*key)
                self.store.event(request.tenant_id, {"event": "job_recovered", "execution_id": request.execution_id})

