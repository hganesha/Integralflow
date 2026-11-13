"""Business profiles and bounded tasks; durable execution belongs to the host controller."""
from __future__ import annotations

from collections import defaultdict
from typing import Literal
import networkx as nx
from pydantic import Field, JsonValue, model_validator

from .contracts import AgentProfile, Contract, Identifier, SchemaVersion, SkillError, Status, digest
from .registry import load_registry, validate
from .versions import RELEASE_VERSION, SKILL_VERSION


class ContextProduct(Contract):
    id: Identifier
    version: SchemaVersion = "1.0.0"
    description: str
    objects: dict[str, list[str]]


class BusinessAgent(Contract):
    id: Identifier
    version: SchemaVersion = "1.0.0"
    mandate: str
    personas: list[str]
    task_ids: list[str]
    context_products: list[str]
    human_gates: list[str]
    execution: AgentProfile


class TaskStep(Contract):
    id: Identifier
    skill_id: Identifier
    skill_version: SchemaVersion = SKILL_VERSION
    parameters: dict[str, JsonValue] = Field(default_factory=dict)
    # Bind named skill parameters to task input fields. No expressions or executable paths.
    input_bindings: dict[str, str] = Field(default_factory=dict)
    dependencies: list[str] = Field(default_factory=list)


LiteralStatus = Literal["COMPLETED", "PARTIAL", "NEEDS_EVIDENCE", "NEEDS_REVIEW", "BLOCKED", "FAILED"]


class CompletionCriterion(Contract):
    step_id: Identifier
    required_payload_fields: list[str]
    accepted_statuses: list[LiteralStatus] = Field(default_factory=lambda: ["COMPLETED"])
    requires_human_decision: bool = False


class TaskSpec(Contract):
    api_version: Literal["fincrime.tasks/v1"] = "fincrime.tasks/v1"
    id: Identifier
    version: SchemaVersion = "1.0.0"
    agent_profile: Identifier
    objective: str
    input_fields: list[str]
    input_schema: dict[str, JsonValue]
    steps: list[TaskStep]
    completion_criteria: list[CompletionCriterion]
    failure_policy: dict[str, LiteralStatus] = Field(default_factory=lambda: {
        "missing_required_evidence": "NEEDS_EVIDENCE", "ambiguous_evidence": "NEEDS_REVIEW",
        "unavailable_required_source": "BLOCKED"})

    @model_validator(mode="after")
    def valid_graph(self):
        registry = load_registry()
        if set(self.input_fields) != self.input_schema.get("properties", {}).keys():
            raise ValueError("task input fields and schema disagree")
        by_id = {step.id: step for step in self.steps}
        if not self.steps or len(by_id) != len(self.steps):
            raise ValueError("task steps must have unique IDs")
        graph = nx.DiGraph(); graph.add_nodes_from(by_id)
        for step in self.steps:
            spec = registry.get(step.skill_id)
            if spec is None or spec.version != step.skill_version:
                raise ValueError("task references unsupported skill version")
            if not set(step.dependencies) <= by_id.keys():
                raise ValueError("unknown step dependency")
            if not set(step.input_bindings.values()) <= set(self.input_fields):
                raise ValueError("binding refers to undeclared task input")
            if not (set(step.parameters) | set(step.input_bindings)) <= spec.params["properties"].keys():
                raise ValueError("undeclared skill parameter")
            if set(step.parameters) & set(step.input_bindings):
                raise ValueError("parameter cannot be both bound and constant")
            for dep in step.dependencies:
                graph.add_edge(dep, step.id)
        if not nx.is_directed_acyclic_graph(graph):
            raise ValueError("task dependency cycle")
        criteria = {c.step_id: c for c in self.completion_criteria}
        if len(criteria) != len(self.completion_criteria) or criteria.keys() != by_id.keys():
            raise ValueError("every task step needs one completion criterion")
        for sid, criterion in criteria.items():
            if not set(criterion.required_payload_fields) <= registry[by_id[sid].skill_id].output["properties"].keys():
                raise ValueError("completion criterion names an undeclared payload field")
        return self


class PlannedStep(Contract):
    id: Identifier
    skill_id: Identifier
    skill_version: SchemaVersion
    parameters: dict[str, JsonValue]
    dependencies: list[str]
    requirements_hash: str


class TaskPlan(Contract):
    task_id: Identifier
    task_version: SchemaVersion
    profile_id: Identifier
    profile_hash: str
    task_hash: str
    input_hash: str
    steps: list[PlannedStep]


def compile_task(task: TaskSpec, agent: BusinessAgent, inputs: dict) -> TaskPlan:
    if task.agent_profile != agent.id or task.id not in agent.task_ids or agent.execution.id != agent.id:
        raise SkillError("ACCESS_DENIED", "task/profile assignment denied")
    validate(task.input_schema, inputs)
    registry = load_registry()
    steps = []
    for step in task.steps:
        spec = registry[step.skill_id]
        if agent.execution.allowed_skills.get(step.skill_id) != step.skill_version:
            raise SkillError("ACCESS_DENIED", "task skill outside profile")
        parameters = {**step.parameters, **{k: inputs[v] for k, v in step.input_bindings.items()}}
        validate(spec.params, parameters)
        steps.append(PlannedStep(id=step.id, skill_id=step.skill_id, skill_version=step.skill_version,
            parameters=parameters, dependencies=step.dependencies, requirements_hash=digest([r.model_dump() for r in spec.requirements])))
    return TaskPlan(task_id=task.id, task_version=task.version, profile_id=agent.id, profile_hash=digest(agent),
        task_hash=digest(task), input_hash=digest(inputs), steps=steps)


def check_completion(task: TaskSpec, results: dict[str, dict]) -> dict:
    checks = []
    for criterion in task.completion_criteria:
        result = results.get(criterion.step_id, {})
        decision = result.get("human_decision", {})
        human_passed = not criterion.requires_human_decision or (decision.get("decision") == "APPROVE"
            and decision.get("authority") in {"HUMAN", "HUMAN_CONFLICT_RESOLUTION"} and bool(decision.get("decisionIds")))
        checks.append({"step_id": criterion.step_id, "passed": result.get("status") in criterion.accepted_statuses
            and set(criterion.required_payload_fields) <= result.get("payload", {}).keys() and human_passed})
    return {"complete": all(c["passed"] for c in checks), "checks": checks}


PRODUCT_OBJECTS = {
    "identity.intelligence": ["Entity", "Identity", "IdentityIdentifier", "Alias", "Address", "EntityCandidate"],
    "ownership.intelligence": ["OwnershipGraph", "OwnershipInterest", "OwnershipRange", "ControlRight", "BeneficialOwner", "OfficerRole"],
    "document.intelligence": ["Document", "DocumentVersion", "DocumentPage", "ExtractedAssertion"],
    "registry.intelligence": ["Registration", "RegistryRecord", "Filing", "License"],
    "party360": ["Party", "CustomerRelationship", "Account", "Product", "ExpectedActivity", "GeographyExposure", "Counterparty"],
    "transaction.intelligence": ["Transaction", "Payment", "PaymentRail", "DatasetScope", "TradeRecord", "Invoice", "Shipment", "Typology", "DetectionRule"],
    "screening.intelligence": ["WatchlistEntry", "ScreeningHit", "ScreeningExecution", "SanctionsRegime", "PEPRelationship", "AdverseMediaEvent"],
    "network.intelligence": ["Relationship", "NetworkGraph"],
    "risk.intelligence": ["RiskFactor", "RiskAssessment", "RiskModel", "SourceOfFunds", "SourceOfWealth"],
    "case.intelligence": ["Case", "Task", "WorkflowDefinition", "Checkpoint", "SLA", "Investigation", "SkillExecution", "Decision", "MonitoringPlan", "ReviewTrigger", "Event", "Alert"],
    "policy.intelligence": ["Policy", "Requirement", "Control", "Obligation", "Exception", "Approval", "Actor", "Jurisdiction", "RetentionRule", "BusinessCalendar"],
    "evidence.intelligence": ["Evidence", "SourceRecord", "Provenance", "Assertion", "Fact", "Finding", "Conflict", "Hypothesis", "TimelineEvent", "VerificationRecord", "AuditEvent", "EvaluationCase", "ExpectedOutcome", "ModelVersion", "Device", "Session", "AuthenticationEvent", "FraudSignal"],
}


def context_products():
    from .context_types import CONTEXT_TYPES
    from .schema_types import DEFS
    load_registry()
    assert {t for names in PRODUCT_OBJECTS.values() for t in names} == CONTEXT_TYPES
    return {name: ContextProduct(id=name, description="Governed canonical projection for "+name,
        objects={t: sorted(DEFS[t]["properties"]) for t in names}) for name, names in PRODUCT_OBJECTS.items()}


def workforce():
    """Seven profiles (six initial plus A03 document intelligence), with explicit tasks. Broader specialist roles remain logical targets."""
    definitions = [
        ("intake_profile", "Establish legal customer, party roles, capacity, banking products, expected activity and lifecycle-specific information gaps.", ["relationship_manager", "onboarding_specialist"],
            ["case.create", "decision.requirements.compile", "party.profile.build", "party.type.classify", "party.activity.profile", "party.profile.completeness", "document.requirements.evaluate", "document.request.generate"]),
        ("identity_ownership", "Establish legal identity, existence, role authority, ownership and control; preserve trust-specific treatment, ownership ranges and incomplete structures.", ["kyb_analyst", "ownership_specialist"],
            ["entity.resolve", "registry.company.verify", "ownership.ubo.resolve", "ownership.ubo.verify"]),
        ("screening", "Assess required customer and related-party sanctions, PEP and watchlist scope; retain search completion, negative scope, ownership/control restrictions and unresolved matches.", ["sanctions_analyst", "kyb_analyst"],
            ["screening.sanctions.execute", "screening.pep.execute", "screening.watchlist.execute", "screening.match.disambiguate"]),
        ("risk_edd", "Assess customer, product, geography, channel and activity risk; scope enhanced due diligence, distinguish funds from wealth and retain remediation and approval gaps.", ["kyb_analyst", "edd_analyst"],
            ["risk.customer.assess", "risk.tier.assign", "edd.trigger.evaluate", "edd.source_of_funds.verify", "edd.source_of_wealth.assess"]),
        ("decision_support", "Reconcile applicable obligations and evidence into a product-specific recommendation, restrictions, approval authority and monitoring handoff for authorized human review.", ["compliance_officer"],
            ["decision.rules.evaluate", "decision.gaps.evaluate", "decision.recommendation.generate", "decision.approval.route", "decision.human.review"]),
        ("qa_assurance", "Independently challenge legal applicability, omitted parties, evidence sufficiency, stale sources, unsupported findings, overrides and monitoring handoff.", ["qa_reviewer"],
            ["quality.findings.verify", "quality.hallucination.detect", "quality.policy.compliance", "quality.coverage.assess"]),
        # A03 (UX spec): classification, extraction, validation and citation over the document field
        # catalog through the EHF document wrappers (docs/skill-extensions.md). Extraction is the
        # adjudicated wrapper under the route policy (document factory plan Phase 4). Extracted values
        # stay unverified proposals; requirements and requests stay with intake.
        ("document_intelligence", "Classify case documents, extract their catalog fields with exact spans, and report validity, conflicts and missing documents for human review.",
            ["onboarding_specialist", "kyc_analyst", "kyb_analyst"],
            ["document.classify.catalog", "document.fields.adjudicated_extract", "document.validity.assess", "document.consistency.assess",
             "document.requirements.resolve", "document.request.compose"]),
    ]
    registry = load_registry(); products = context_products()
    agents, tasks = {}, {}
    for name, mandate, personas, ids in definitions:
        agent_id, task_id = "agent."+name, "task."+name
        fields = defaultdict(set); policy_fields = set(); capabilities = set(); permissions = set()
        steps = []; input_shapes = {}
        for index, sid in enumerate(ids):
            spec = registry[sid]
            for req in spec.requirements:
                fields[req.object_type].update(req.fields)
            policy_fields.update(spec.policy_fields); capabilities.update(spec.capabilities)
            permissions.add("skill:"+sid)
            if spec.effects != "read_only":
                permissions.add("effect:"+spec.effects)
            # Parameters are declared here rather than borrowed from demonstration invocations.
            # customer.assess already returns its assigned tier; do not calculate it twice.
            # Case creation is a controller/Case API operation before task assignment.
            if sid in {"risk.tier.assign", "case.create"}:
                continue
            constants = {"case_type": "KYB"} if sid == "case.create" else {}
            bindings = {k: "entity_id" if k == "target" else k for k in spec.params["required"] if k not in constants}
            for parameter, input_name in bindings.items():
                shape = spec.params["properties"][parameter]
                if input_name in input_shapes and input_shapes[input_name] != shape:
                    raise ValueError("task input schema conflict")
                input_shapes[input_name] = shape
            steps.append(TaskStep(id=sid.replace(".", "_"), skill_id=sid, parameters=constants,
                input_bindings=bindings, dependencies=[steps[-1].id] if steps else []))
        if name == "screening":
            for step in steps[:3]: step.dependencies = []
            steps[3].dependencies = [step.id for step in steps[:3]]
        if name == "identity_ownership":
            steps[1].dependencies = []
            steps[2].dependencies = [step.id for step in steps[:2]]
        execution = AgentProfile(id=agent_id, instructions=mandate+" Use admitted evidence. Keep proposed actions and authorized decisions separate.",
            allowed_skills={sid: registry[sid].version for sid in ids}, permissions=permissions,
            purposes={"onboarding", "review", "investigation"}, capabilities=capabilities,
            context_fields=dict(fields), policy_fields=policy_fields, max_agent_steps=16)
        subscriptions = [pid for pid, product in products.items() if set(product.objects) & (set(fields)|{"Policy"})]
        agent = BusinessAgent(id=agent_id, mandate=mandate, personas=personas, task_ids=[task_id], context_products=subscriptions,
            human_gates=["ambiguous evidence", "policy exception", "consequential decision"], execution=execution)
        input_fields = sorted({v for s in steps for v in s.input_bindings.values()})
        from .schema_types import document, obj
        task = TaskSpec(id=task_id, agent_profile=agent_id, objective=mandate, input_fields=input_fields, steps=steps,
            input_schema=document(obj(input_shapes)),
            completion_criteria=[CompletionCriterion(step_id=s.id, required_payload_fields=list(registry[s.skill_id].output["required"]),
                accepted_statuses=["NEEDS_REVIEW"] if registry[s.skill_id].effects == "human_gated" else ["COMPLETED"],
                requires_human_decision=registry[s.skill_id].effects == "human_gated") for s in steps])
        agents[agent_id], tasks[task_id] = agent, task
    return agents, tasks
