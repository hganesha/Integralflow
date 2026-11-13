"""Explicit workflow DAGs with durable progress and action-bound approval resume."""
from __future__ import annotations

from pydantic import JsonValue

import networkx as nx
from pydantic import Field, model_validator

from .contracts import Contract, Invocation, SkillError, Status, digest
from .primitives import evaluate
from .registry import bundle_code_hash
from .versions import RELEASE_VERSION, SKILL_VERSION


class Step(Contract):
    id: str
    skill_id: str
    parameters: dict[str, JsonValue] = Field(default_factory=dict)
    dependencies: list[str] = Field(default_factory=list)
    bindings: dict[str, str] = Field(default_factory=dict)
    condition: dict[str, JsonValue] | None = None
    success_condition: dict[str, JsonValue] | None = None

    @model_validator(mode="after")
    def predicates(self):
        from .registry import validate
        from .schema_types import document
        for predicate in [self.condition, self.success_condition]:
            if predicate is not None:
                validate(document("Predicate"), predicate)
        return self


class Workflow(Contract):
    id: str
    version: str = RELEASE_VERSION
    steps: list[Step]

    @classmethod
    def model_json_schema(cls, *args, **kwargs):
        from .schema_types import document, term
        schema = super().model_json_schema(*args, **kwargs)
        for name in ["condition", "success_condition"]:
            schema["$defs"]["Step"]["properties"][name] = term("Predicate?")
        schema["$defs"].update(document("Predicate")["$defs"])
        return schema


def lookup(value, path):
    for key in path.split("."):
        if isinstance(value, list) and key.isdigit() and int(key) < len(value):
            value = value[int(key)]
        elif isinstance(value, dict) and key in value:
            value = value[key]
        else:
            raise SkillError("CONTEXT_MISSING", f"workflow binding unresolved: {path}", Status.NEEDS_EVIDENCE)
    return value


def assign(data, path, value):
    pieces = path.split(".")
    for key in pieces[:-1]:
        data = data.setdefault(key, {})
    data[pieces[-1]] = value


class WorkflowRunner:
    def __init__(self, executor):
        self.executor, self.store = executor, executor.store

    async def run(self, workflow: Workflow, template: Invocation, principal, run_id: str, approvals=None):
        from copy import deepcopy
        approvals = approvals or {}
        if principal.revoked or principal.tenant_id != template.tenant_id or principal.actor_id != template.actor_ref:
            raise SkillError("ACCESS_DENIED", "workflow identity mismatch")
        g = nx.DiGraph()
        steps = {s.id: s for s in workflow.steps}
        if len(steps) != len(workflow.steps):
            raise SkillError("INPUT_INVALID", "duplicate workflow step ID", Status.FAILED)
        for step in workflow.steps:
            g.add_node(step.id)
            for dep in step.dependencies:
                if dep not in steps:
                    raise SkillError("INPUT_INVALID", "unknown workflow dependency", Status.FAILED)
                g.add_edge(dep, step.id)
        if not nx.is_directed_acyclic_graph(g):
            raise SkillError("INPUT_INVALID", "cyclic workflow", Status.FAILED)
        revision, saved = self.store.state(template.tenant_id, "workflow", run_id)
        binding = digest({"definition": workflow, "template": template, "actor": principal, "bundle_code_hash": bundle_code_hash(),
            "profile": self.executor.profiles.get(template.profile_id), "policy_hash": digest(self.executor.compiler.policy(template, principal))})
        if saved and saved["binding"] != binding:
            raise SkillError("CONTROL_FAILED", "workflow definition, identity or template changed")
        progress = deepcopy(saved) if saved else {"binding": binding, "results": {}, "completed": [], "state": "RUNNING"}
        for step_id in nx.topological_sort(g):
            if step_id in progress["completed"]:
                continue
            step = steps[step_id]
            if step.condition:
                outcome = evaluate(step.condition, {"steps": progress["results"]})
                if outcome == "UNKNOWN":
                    progress["state"] = "NEEDS_EVIDENCE"
                    break
                if outcome == "FAIL":
                    progress["completed"].append(step_id)
                    progress["results"][step_id] = {"status": "SKIPPED"}
                    continue
            parameters = deepcopy(step.parameters)
            for target, source in step.bindings.items():
                assign(parameters, target, lookup(progress["results"], source))
            request = template.model_copy(update={"skill_id": step.skill_id, "skill_version": SKILL_VERSION, "parameters": parameters,
                "execution_id": digest([run_id, step_id]), "idempotency_key": f"{run_id}:{step_id}", "trace_id": run_id})
            result = await self.executor.run(request, principal, approved_task=approvals.get(step_id))
            progress["results"][step_id] = result.model_dump(mode="json")
            if result.status == Status.COMPLETED and step.success_condition and evaluate(step.success_condition, result.model_dump(mode="json")) != "PASS":
                progress["state"] = "BLOCKED"
                progress["blocking_step"] = step_id
                break
            if result.status == Status.COMPLETED:
                progress["completed"].append(step_id)
            else:
                progress["state"] = result.lifecycle if result.lifecycle == "WAITING_FOR_HUMAN" else result.status.value
                break
            progress["state"] = "RUNNING"
            with self.store.transaction():
                revision = self.store.set_state(template.tenant_id, "workflow", run_id, revision, progress)
        if len(progress["completed"]) == len(workflow.steps):
            progress["state"] = "COMPLETED"
        with self.store.transaction():
            self.store.set_state(template.tenant_id, "workflow", run_id, revision, progress)
        return progress


def synthetic_kyb():
    from .synthetic import parameters
    ids = ["case.create", "decision.policy.resolve", "decision.requirements.compile", "entity.resolve", "entity.match", "registry.company.verify",
        "document.classify", "document.fields.extract", "document.evidence.link",
        # EHF document wrappers over the document field catalog (docs/skill-extensions.md).
        "document.classify.catalog", "document.fields.contract_extract", "document.validity.assess", "document.consistency.assess",
        "party.profile.build", "ownership.graph.build", "ownership.interest.calculate",
        "ownership.ubo.resolve", "ownership.ubo.verify", "screening.sanctions.execute", "screening.pep.execute", "screening.adverse_media.execute",
        "screening.match.disambiguate", "risk.customer.assess", "edd.trigger.evaluate", "case.context.hydrate", "case.tasks.plan",
        "evidence.provenance.attach", "evidence.sufficiency.assess", "quality.findings.verify", "decision.rules.evaluate", "decision.approval.route",
        "decision.disposition.record", "monitor.customer.schedule"]
    steps = []
    for index, sid in enumerate(ids):
        bindings = {}
        if sid == "document.evidence.link":
            bindings["assertions"] = "document_fields_extract.payload.assertions"
        if sid == "document.fields.contract_extract":
            bindings["classifications"] = "document_classify_catalog.payload.classifications"
        if sid == "decision.rules.evaluate":
            bindings["facts.identity_verified"] = "registry_company_verify.payload.verifications.0.verified"
        if sid == "edd.trigger.evaluate":
            bindings["facts.tier"] = "risk_customer_assess.payload.tier"
        step = Step(id=sid.replace(".", "_"), skill_id=sid, parameters=parameters(sid), dependencies=[steps[-1].id] if steps else [], bindings=bindings)
        if sid == "decision.rules.evaluate":
            step.success_condition = {"field": "payload.outcome", "op": "eq", "value": "PASS"}
        if sid == "evidence.sufficiency.assess":
            step.success_condition = {"field": "payload.sufficient", "op": "eq", "value": True}
        if sid == "edd.trigger.evaluate":
            # This demo template stops for an EDD workflow handoff; it never bypasses required EDD.
            step.success_condition = {"field": "payload.required", "op": "eq", "value": False}
        steps.append(step)
    return Workflow(id="synthetic-kyb", steps=steps)
