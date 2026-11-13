"""Wire contracts shared by all runtimes. No SDK imports belong here."""
from __future__ import annotations

import hashlib
import json
from decimal import Decimal
from datetime import datetime, timezone
from enum import StrEnum
from typing import Any, Literal, Annotated, get_args
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field, AwareDatetime, JsonValue, model_validator, field_validator
from .versions import RELEASE_VERSION, SKILL_VERSION, SCHEMA_VERSION

Identifier = Annotated[str, Field(min_length=1, max_length=512, strict=True)]
SchemaVersion = Annotated[str, Field(pattern=r"^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$", strict=True)]


def now() -> datetime:
    return datetime.now(timezone.utc)


def canonical(value: Any) -> str:
    def normalize(item):
        if isinstance(item, BaseModel):
            return normalize(item.model_dump(mode="python"))
        if isinstance(item, dict):
            return {k: normalize(v) for k, v in item.items()}
        if isinstance(item, (set, frozenset)):
            return sorted((normalize(x) for x in item), key=lambda x: json.dumps(x, sort_keys=True))
        if isinstance(item, (list, tuple)):
            return [normalize(x) for x in item]
        if isinstance(item, datetime):
            return item.isoformat()
        if isinstance(item, Decimal):
            return format(item, "f")
        return item
    return json.dumps(normalize(value), sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)


def digest(value: Any) -> str:
    return hashlib.sha256(canonical(value).encode()).hexdigest()


class Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", validate_assignment=True, allow_inf_nan=False)

    @field_validator("*", mode="before")
    @classmethod
    def wire_scalar_types(cls, value, info):
        annotation = cls.model_fields[info.field_name].annotation
        options = [x for x in get_args(annotation) if x is not type(None)]
        if type(None) in get_args(annotation) and len(options) == 1:
            annotation = options[0]
        if value is None:
            return value
        if annotation is bool and type(value) is not bool:
            raise ValueError("boolean values must not be coerced")
        if annotation is int and type(value) is not int:
            raise ValueError("integer values must not be coerced")
        if annotation is float and type(value) not in (int, float):
            raise ValueError("numeric values must not be coerced")
        if annotation is str and not isinstance(value, str):
            raise ValueError("string values must not be coerced")
        if annotation in (datetime, AwareDatetime):
            if not isinstance(value, (str, datetime)):
                raise ValueError("an aware RFC3339 timestamp is required")
            if isinstance(value, str):
                from jsonschema import FormatChecker
                from jsonschema.exceptions import FormatError
                try:
                    FormatChecker().check(value, "date-time")
                except FormatError:
                    raise ValueError("an aware RFC3339 timestamp is required")
        return value

    def __getitem__(self, key):
        return getattr(self, key)

    def get(self, key, default=None):
        return getattr(self, key, default)

    @classmethod
    def model_json_schema(cls, *args, **kwargs):
        schema = super().model_json_schema(*args, **kwargs)
        def annotate(value):
            if isinstance(value, dict):
                if value.get("type") == "object" and isinstance(value.get("additionalProperties"), dict):
                    value["x-dynamic-map-reason"] = "typed keyed runtime values; business payloads are validated by their selected skill contract"
                for child in value.values():
                    annotate(child)
            elif isinstance(value, list):
                for child in value:
                    annotate(child)
        annotate(schema)
        if schema.get("$defs", {}).get("JsonValue") == {}:
            from .schema_types import document
            schema["$defs"].update(document("JsonValue")["$defs"])
        if "EffectCommand" in schema.get("$defs", {}):
            from .ontology import ensure_types
            from .schema_types import document
            ensure_types()
            schema["$defs"].update(document("EffectCommand")["$defs"])
        return schema


class Status(StrEnum):
    COMPLETED = "COMPLETED"
    PARTIAL = "PARTIAL"
    NEEDS_EVIDENCE = "NEEDS_EVIDENCE"
    NEEDS_REVIEW = "NEEDS_REVIEW"
    BLOCKED = "BLOCKED"
    FAILED = "FAILED"


class SkillError(Exception):
    def __init__(self, code: str, message: str, status: Status = Status.BLOCKED, retryable: bool = False):
        self.code, self.message, self.status, self.retryable = code, message, status, retryable
        super().__init__(message)


class Ref(Contract):
    tenant_id: Identifier
    object_type: Identifier
    object_id: Identifier
    version_id: Identifier
    schema_version: SchemaVersion = SCHEMA_VERSION


class RecordEnvelope(Contract):
    id: Identifier
    tenant_id: Identifier
    object_type: Identifier
    version_id: Identifier = Field(default_factory=lambda: str(uuid4()))
    schema_version: Literal["2.0.0"] = SCHEMA_VERSION
    data: dict[str, JsonValue]
    subject_ids: list[str] = Field(default_factory=list)
    source_refs: list[Ref] = Field(default_factory=list)
    valid_from: AwareDatetime | None = None
    valid_to: AwareDatetime | None = None
    observed_at: AwareDatetime = Field(default_factory=now)
    recorded_at: AwareDatetime = Field(default_factory=now)
    purposes: set[str] = Field(default_factory=lambda: {"onboarding", "review", "monitoring", "investigation", "fraud", "reporting"})
    classification: str = "internal"
    synthetic: bool = False
    supersedes: str | None = None

    @model_validator(mode="after")
    def valid_interval(self):
        if self.valid_from and self.valid_to and self.valid_from >= self.valid_to:
            raise ValueError("valid_to must follow valid_from")
        return self

    def ref(self) -> Ref:
        return Ref(tenant_id=self.tenant_id, object_type=self.object_type, object_id=self.id, version_id=self.version_id, schema_version=self.schema_version)


class Record(RecordEnvelope):
    @model_validator(mode="after")
    def canonical_data(self):
        from .ontology import validate_record_data
        validate_record_data(self.object_type, self.data)
        if any(ref.tenant_id != self.tenant_id for ref in self.source_refs):
            raise ValueError("source reference crosses tenant boundary")
        return self

    @classmethod
    def model_json_schema(cls, *args, **kwargs):
        from .ontology import ensure_types
        from .registry import load_registry
        from .context_types import CONTEXT_TYPES
        from .schema_types import document, ref
        ensure_types()
        load_registry()
        base = super().model_json_schema(*args, **kwargs)
        types = sorted(CONTEXT_TYPES | {"ContextManifest", "ToolInvocation"})
        branches = {"allOf": [{"if": {"properties": {"object_type": {"const": name}}}, "then": {"properties": {"data": ref(name)}}} for name in types]}
        definitions = document(branches)
        base["allOf"] = branches["allOf"]
        base["properties"]["object_type"] = {"enum": types}
        base.setdefault("$defs", {}).update(definitions["$defs"])
        return base


class RecordView(RecordEnvelope):
    selected_fields: list[str]

    @classmethod
    def project(cls, record, fields):
        fields = list(fields) or list(record.data)
        return cls(**{**record.model_dump(mode="python"), "data": {k: record.data[k] for k in fields}, "selected_fields": fields})

    @model_validator(mode="after")
    def selected_data(self):
        from .ontology import validate_fields
        if len(self.selected_fields) != len(set(self.selected_fields)) or set(self.data) != set(self.selected_fields):
            raise ValueError("projection must contain exactly its selected fields")
        validate_fields(self.object_type, self.data, self.selected_fields)
        return self

    @classmethod
    def model_json_schema(cls, *args, **kwargs):
        from .ontology import ensure_types
        from .context_types import CONTEXT_TYPES
        from .schema_types import DEFS, document, obj
        ensure_types()
        base = super().model_json_schema(*args, **kwargs)
        branches = {"allOf": [{"if": {"properties": {"object_type": {"const": name}}}, "then": {"properties": {
            "data": obj(DEFS[name]["properties"], required=[]),
            "selected_fields": {"type": "array", "items": {"enum": sorted(DEFS[name]["properties"])}, "uniqueItems": True}}}}
            for name in sorted(CONTEXT_TYPES)]}
        base["allOf"] = branches["allOf"]
        base["properties"]["object_type"] = {"enum": sorted(CONTEXT_TYPES)}
        base.setdefault("$defs", {}).update(document(branches).get("$defs", {}))
        base["x-semantic-checks"] = ["data keys must equal selected_fields", "selected fields must be authorized by the context compiler"]
        return base


class Principal(Contract):
    """Trusted application identity. Never construct permissions from request JSON."""
    tenant_id: Identifier
    actor_id: Identifier
    permissions: set[str]
    purposes: set[str]
    classifications: set[str] = Field(default_factory=lambda: {"internal"})
    subject_ids: set[str] | None = None
    case_ids: set[str] | None = None
    readable_fields: dict[str, set[str]] = Field(default_factory=dict)
    revoked: bool = False


class AgentProfile(Contract):
    id: Identifier
    version: str = RELEASE_VERSION
    instructions: str
    allowed_skills: dict[str, str]
    permissions: set[str]
    purposes: set[str]
    capabilities: set[str] = Field(default_factory=set)
    max_objects: int = Field(default=1000, ge=1, le=10000)
    model_char_budget: int = Field(default=64000, ge=1)
    timeout_seconds: float = Field(default=30, gt=0, le=300)
    model_config_ref: str | None = None
    max_agent_steps: int = Field(default=8, ge=1, le=32)
    context_fields: dict[str, set[str]] | None = None
    policy_fields: set[str] | None = None


class Invocation(Contract):
    execution_id: str = Field(default_factory=lambda: str(uuid4()))
    skill_id: Identifier
    skill_version: str = SKILL_VERSION
    tenant_id: Identifier
    actor_ref: Identifier
    profile_id: Identifier
    case_id: str | None = None
    subject_ids: list[str] = Field(default_factory=list)
    object_refs: list[Ref] = Field(default_factory=list)
    parameters: dict[str, JsonValue] = Field(default_factory=dict)
    purpose: Literal["onboarding", "review", "monitoring", "investigation", "fraud", "reporting"]
    policy_snapshot_ref: str
    as_of_time: AwareDatetime
    knowledge_cutoff: AwareDatetime
    idempotency_key: str = Field(min_length=1)
    trace_id: str = Field(default_factory=lambda: str(uuid4()))


class Requirement(Contract):
    object_type: str
    fields: list[str]
    # Of `fields`, those a record may lack (optional in the data model): read when present, never a gap.
    nullable_fields: list[str] = Field(default_factory=list)
    min_count: int = Field(default=1, ge=0)
    max_age_seconds: int | None = Field(default=None, ge=0)
    optional: bool = False
    model_visible: bool = True


class ContextGap(Contract):
    code: Literal["CONTEXT_MISSING", "CONTEXT_STALE"]
    object: str | None = None
    object_type: str | None = None
    fields: list[str] | None = None
    minimum: int | None = Field(default=None, ge=0)
    optional: bool


class ContextScope(Contract):
    subjects: list[str]
    case_id: str | None
    explicit_refs: bool
    complete_for_declared_scope: bool


class ExecutionLock(Contract):
    profile_hash: str
    skill_version: str
    code_hash: str
    bundle_code_hash: str
    instruction_hash: str
    python_version: str
    policy_hash: str
    context_hash: str
    requirements_hash: str
    capabilities: list[str]
    libraries: dict[str, str]


class Metrics(Contract):
    duration_ms: int = Field(default=0, ge=0)
    provider_calls: int = Field(default=0, ge=0)


class Failure(Contract):
    code: str
    message: str | None = None
    retryable: bool


class UnresolvedItem(Contract):
    code: str
    approval_id: str | None = None
    subject_ref: str | None = None
    explanation: str | None = None


class EffectCommand(Contract):
    kind: Literal["state", "outbox"]
    type: str | None = None
    id: str
    expected_revision: int | None = Field(default=None, ge=0)
    data: dict[str, JsonValue] | None = None
    action: Literal["execute_skill", "submit_filing", "delete_artifact"] | None = None
    skill_id: str | None = None
    parameters: dict[str, JsonValue] | None = None
    parent_execution_id: str | None = None
    filing: dict[str, JsonValue] | None = None
    synthetic: bool | None = None
    object_id: str | None = None

    @model_validator(mode="after")
    def command_shape(self):
        from .registry import validate
        from .schema_types import document
        from .ontology import ensure_types
        ensure_types()
        validate(document("EffectCommand"), self.model_dump(mode="json", exclude_unset=True), "CONTROL_FAILED")
        return self

    @classmethod
    def model_json_schema(cls, *args, **kwargs):
        from .ontology import ensure_types
        from .schema_types import document
        ensure_types()
        return document("EffectCommand")


class ContextManifest(Contract):
    schema_version: Literal["2.0.0"] = SCHEMA_VERSION
    tenant_id: str
    actor_ref: str
    purpose: str
    skill_id: str
    skill_version: str
    profile_hash: str
    policy_hash: str
    policy_ref: Ref
    policy_fields: list[str]
    requirements_hash: str
    authorization_hash: str
    as_of_time: AwareDatetime
    knowledge_cutoff: AwareDatetime
    refs: list[Ref]
    content_hashes: dict[str, str]
    selected_fields: dict[str, list[str]]
    gaps: list[ContextGap]
    scope: ContextScope
    model_view: str
    structured_hash: str
    synthetic: bool
    compiler_version: str = RELEASE_VERSION


class Computation(Contract):
    payload: dict[str, JsonValue]
    status: Status = Status.COMPLETED
    evidence_refs: list[Ref] = Field(default_factory=list)
    unresolved_items: list[UnresolvedItem] = Field(default_factory=list)
    commands: list[EffectCommand] = Field(default_factory=list)


class SkillResult(Contract):
    execution_id: str
    skill_id: str
    skill_version: str
    status: Status
    lifecycle: Literal["SUCCEEDED", "WAITING_FOR_HUMAN", "FAILED", "CANCELLED"]
    payload: dict[str, JsonValue] = Field(default_factory=dict)
    result_refs: list[Ref] = Field(default_factory=list)
    evidence_refs: list[Ref] = Field(default_factory=list)
    finding_refs: list[Ref] = Field(default_factory=list)
    unresolved_items: list[UnresolvedItem] = Field(default_factory=list)
    policy_snapshot_ref: str
    context_hash: str | None = None
    trace_ref: str
    execution_lock: ExecutionLock | None = None
    metrics: Metrics = Field(default_factory=Metrics)
    error: Failure | None = None
    synthetic: bool = True
    effects_committed: bool = False

    @model_validator(mode="after")
    def selected_payload(self):
        if self.result_refs:
            from .registry import load_registry, validate
            spec = load_registry().get(self.skill_id)
            if spec is None or self.skill_version != spec.version:
                raise ValueError("computed result refers to an unsupported skill version")
            validate(spec.output, self.payload, "OUTPUT_INVALID")
        return self

    @classmethod
    def model_json_schema(cls, *args, **kwargs):
        from .registry import load_registry
        from .schema_types import document, ref
        registry = load_registry()
        base = super().model_json_schema(*args, **kwargs)
        choices = {"properties": {"skill_id": {"enum": sorted(registry)}}, "allOf": [
            {"if": {"properties": {"skill_id": {"const": sid}}}, "then": {"properties": {"skill_version": {"const": spec.version},
            "payload": ref("Payload_"+sid.replace(".", "_"))}}} for sid, spec in registry.items()]}
        base["allOf"] = [{"if": {"required": ["result_refs"], "properties": {"result_refs": {"minItems": 1}}}, "then": choices}]
        base.setdefault("$defs", {}).update(document(choices)["$defs"])
        return base

