"""Explicit allowlisted entrypoints and machine-readable per-skill contracts."""
from __future__ import annotations

import inspect
from pathlib import Path
from dataclasses import dataclass, field
from typing import Any, Callable
from functools import lru_cache
import json

from jsonschema import Draft202012Validator, FormatChecker

from .contracts import Requirement, SkillError, Status, digest
from .versions import SKILL_VERSION, RELEASE_VERSION

S = {"type": "string", "minLength": 1, "maxLength": 4000}
N = {"type": "number"}
I = {"type": "integer"}
B = {"type": "boolean"}
O = {"type": "object"}
A = {"type": "array"}


def array(items=O, min_items=0):
    from .schema_types import MAX_ITEMS
    return {"type": "array", "items": items, "minItems": min_items, "maxItems": MAX_ITEMS}


def enum(*values):
    return {"enum": list(values)}


def object_schema(fields, required=None):
    return {"$schema": "https://json-schema.org/draft/2020-12/schema", "type": "object", "properties": fields,
            "required": list(fields) if required is None else required, "additionalProperties": False}


@dataclass
class SkillSpec:
    id: str
    function: Callable
    params: dict
    output: dict
    requirements: list[Requirement]
    description: str
    mode: str = "code"
    effects: str = "read_only"
    capabilities: tuple[str, ...] = ()
    dependencies: tuple[str, ...] = ()
    version: str = SKILL_VERSION
    limitations: list[str] = field(default_factory=list)

    @property
    def code_hash(self):
        # This skill's own code: its handler and everything of this package it reaches (helpers,
        # classes, module constants), not the whole module, so editing one skill does not repin
        # every skill that shares a file with it.
        return digest(reached_code(self.function)[0])

    @property
    def failure_codes(self):
        # Every code the executor can answer with for any skill, plus every code this skill's own
        # code raises; derived, so the manifest cannot drift from the handler.
        raised = reached_code(self.function)[1]
        provider = PROVIDER_FAILURE_CODES if self.capabilities or self.mode == "model" else set()
        # Declared as the platform observes them (skill.execution.v1 §4.3): a library-internal code
        # outside that vocabulary reaches the platform as CONTROL_FAILED, as the skill host maps it.
        return sorted({c if c in PLATFORM_ERROR_CODES else "CONTROL_FAILED" for c in EXECUTOR_FAILURE_CODES | provider | raised})

    @property
    def policy_fields(self):
        # An explicit reviewed contract: refactoring or moving a helper must not silently
        # change what policy data is admitted to a skill. Included in every manifest digest.
        fields = declared_policy_fields().get(self.id)
        if fields is None:
            raise ValueError(f"policy fields not declared: {self.id}")
        return list(fields)

    def manifest(self):
        return {"id": self.id, "semver": self.version, "description": self.description, "business_outcome": self.description,
                "input_schema": self.params, "output_schema": self.output,
                "required_context": [x.model_dump() for x in self.requirements if not x.optional],
                "optional_context": [x.model_dump() for x in self.requirements if x.optional],
                "context_freshness": "per requirement and pinned policy; no implicit freshness guarantee",
                "policy_context_fields": self.policy_fields,
                "preconditions": ["authorized purpose", "pinned policy", "satisfied required context"],
                "dependencies": {"skills": list(self.dependencies), "capabilities": list(self.capabilities), "libraries": ["financial-crime-skills=="+RELEASE_VERSION]},
                "composition_type": "composite" if self.dependencies else "atomic", "execution_mode": self.mode,
                "entrypoint": f"{self.function.__module__}:{self.function.__name__}", "permitted_capabilities": list(self.capabilities),
                "provider_policy": "explicit allowlist; synthetic local sources by default",
                "policy_gates": ["unknown != pass", "no automatic consequential decision"],
                "authorization": [f"skill:{self.id}", *([f"effect:{self.effects}"] if self.effects != "read_only" else [])],
                "effects": self.effects, "idempotency": "tenant+actor+key with request hash conflict detection",
                "timeout": 30, "retry_policy": {"max_attempts": 1, "external_uncertain": "reconcile"},
                "human_interrupt_conditions": HUMAN_INTERRUPTS[self.effects],
                "failure_codes": self.failure_codes,
                "evidence_requirements": "immutable selected source refs and per-finding citations; synthetic sources labeled",
                "audit_fields": ["actor", "policy_hash", "context_hash", "code_hash", "profile_hash", "trace_id"],
                "evaluation_profile": self.id + "-synthetic-v1", "cost_latency_budget": {"timeout_seconds": 30},
                "data_classification": "internal", "jurisdiction_scope": ["synthetic-neutral"],
                "owner": "financial-crime-skills", "deprecation_policy": "new version for contract changes",
                "maturity": "implemented_synthetic", "limitations": self.limitations, "code_hash": self.code_hash}


REGISTRY: dict[str, SkillSpec] = {}

# When a person must act, by effect mode: stated per mode so a manifest says what actually happens.
HUMAN_INTERRUPTS = {
    "read_only": ["none for the skill itself: its output is an observation; the parent workflow's checkpoints decide whether a person acts"],
    "proposal": ["none for the skill itself: its proposals are committed only through the node's grants and are never adopted without a checkpoint or a person"],
    "internal_write": ["before the effect when the parent workflow holds it for approval; otherwise the effect commits only through the node's grant"],
    "human_gated": ["always: an independent, authenticated reviewer approves before any effect commits; an expired or revised approval is void"],
    "external_write": ["always: approval before the external action; an uncertain outcome is reconciled, never retried blind"],
}

# The platform's closed error vocabulary (skill.execution.v1 §4.3; @ehf/contracts SKILL_ERROR_CODES).
PLATFORM_ERROR_CODES = {"INPUT_INVALID", "CONTEXT_MISSING", "CONTEXT_STALE", "ACCESS_DENIED", "POLICY_UNRESOLVED", "SOURCE_UNAVAILABLE",
                        "SOURCE_CONFLICT", "LOW_CONFIDENCE", "EVIDENCE_INSUFFICIENT", "HUMAN_REVIEW_REQUIRED", "CONTROL_FAILED",
                        "RATE_LIMITED", "TIMEOUT", "INTEGRITY_FAILURE", "EXTERNAL_ACTION_UNCONFIRMED"}
# Codes the executor and context compiler answer with whatever the skill (execution.py, context.py).
EXECUTOR_FAILURE_CODES = {"ACCESS_DENIED", "INPUT_INVALID", "OUTPUT_INVALID", "CONTEXT_MISSING", "CONTEXT_STALE",
                          "CONTEXT_BUDGET_EXCEEDED", "POLICY_UNRESOLVED", "CONTROL_FAILED", "INTEGRITY_FAILURE",
                          "IDEMPOTENCY_CONFLICT", "EXECUTION_IN_PROGRESS", "TIMEOUT"}
# Codes a provider capability call can answer with (providers.py, the gateway provider).
PROVIDER_FAILURE_CODES = {"SOURCE_UNAVAILABLE", "SOURCE_CONFLICT", "RATE_LIMITED", "LOW_CONFIDENCE", "EXTERNAL_ACTION_UNCONFIRMED"}


def _plain(value, depth=0) -> bool:
    """Plain data whose text is the same in every process (no object addresses or identities)."""
    import re as _re
    if depth > 20:
        return False
    if value is None or isinstance(value, (str, int, float, bool)):
        return True
    if isinstance(value, _re.Pattern):
        return True
    if isinstance(value, (list, tuple, set, frozenset)):
        return all(_plain(v, depth + 1) for v in value)
    if isinstance(value, dict):
        return all(isinstance(k, (str, int)) and _plain(v, depth + 1) for k, v in value.items())
    return False


def _stable(value):
    import re as _re
    def default(v):
        if isinstance(v, (set, frozenset)):
            return sorted(v, key=lambda x: json.dumps(x, sort_keys=True, default=default))
        if isinstance(v, _re.Pattern):
            return {"pattern": v.pattern, "flags": v.flags}
        raise TypeError(type(v).__name__)
    return json.dumps(value, sort_keys=True, default=default)


@lru_cache(maxsize=None)
def reached_code(function) -> tuple[str, frozenset]:
    """The source of everything in this package a function reaches, and the SkillError codes it raises.

    Follows names the function's code loads (globals, closures and attributes of package modules)
    to functions and classes defined in ``financial_crime``, transitively; module-level constants
    it reads are included by value. Returns a canonical text of all of it and the literal codes
    passed to ``SkillError``."""
    import ast
    import types
    package = __name__.rsplit(".", 1)[0]
    seen: dict[str, str] = {}
    codes: set[str] = set()
    pending = [function]
    def ours(obj):
        module = getattr(obj, "__module__", None) or ""
        return module == package or module.startswith(package + ".")
    while pending:
        obj = pending.pop()
        name = f"{obj.__module__}:{obj.__qualname__}"
        if name in seen:
            continue
        try:
            source = inspect.getsource(obj)
        except (OSError, TypeError):
            continue
        seen[name] = source
        tree = ast.parse(__import__("textwrap").dedent(source))
        namespace = dict(getattr(obj, "__globals__", None) or vars(inspect.getmodule(obj)))
        if getattr(obj, "__closure__", None):
            namespace.update({n: c.cell_contents for n, c in zip(obj.__code__.co_freevars, obj.__closure__) if c.cell_contents is not None})
        for node in ast.walk(tree):
            if isinstance(node, ast.Call) and getattr(node.func, "id", None) == "SkillError" and node.args \
                    and isinstance(node.args[0], ast.Constant) and isinstance(node.args[0].value, str):
                codes.add(node.args[0].value)
            target = None
            if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load):
                target = namespace.get(node.id)
            elif isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name):
                base = namespace.get(node.value.id)
                if isinstance(base, types.ModuleType) and (base.__name__ == package or base.__name__.startswith(package + ".")):
                    target = getattr(base, node.attr, None)
            if target is None or isinstance(target, types.ModuleType):
                continue
            if (inspect.isfunction(target) or inspect.isclass(target)) and ours(target):
                pending.append(target)
            elif not callable(target) and isinstance(node, ast.Name) and node.id.isupper() and _plain(target):
                seen.setdefault(f"{obj.__module__}:{node.id}=", _stable(target))
    return "\n".join(f"{k}\n{v}" for k, v in sorted(seen.items())), frozenset(codes)


@lru_cache(maxsize=1)
def declared_policy_fields():
    from importlib.resources import files
    fields = json.loads(files("financial_crime").joinpath("resources", "skill-policy-fields.json").read_text())
    if not isinstance(fields, dict) or any(not isinstance(v, list) or not v or
            any(not isinstance(x, str) or not x for x in v) or len(v) != len(set(v)) for v in fields.values()):
        raise ValueError("invalid explicit skill policy fields")
    return fields


def bundle_code_hash():
    root = Path(__file__).parent
    return digest({str(p.relative_to(root)): p.read_text() for p in sorted(root.rglob("*.py"))})


def instructions_for(skill_id):
    from importlib.resources import files
    if skill_id not in REGISTRY:
        raise SkillError("ACCESS_DENIED", "unregistered instructions")
    resource = files("financial_crime").joinpath("resources", "skills", skill_id, "SKILL.md")
    if not resource.is_file():
        raise SkillError("CONTROL_FAILED", "bundled instructions absent; build the catalog")
    content = resource.read_text()
    if expected_instruction_hashes().get(skill_id) != digest(content):
        raise SkillError("INTEGRITY_FAILURE", "bundled instructions differ from the released catalog")
    return content


@lru_cache(maxsize=1)
def expected_instruction_hashes():
    from importlib.resources import files
    catalog = json.loads(files("financial_crime").joinpath("resources", "catalog.json").read_text())
    return {entry["id"]: entry["instruction_hash"] for entry in catalog["skills"]}


def skill(skill_id, *, params=None, returns=None, context=None, optional=None, mode="code", effects="read_only",
          capabilities=(), dependencies=(), required=None, limitations=(), description=None):
    def decorate(fn):
        if skill_id in REGISTRY:
            raise ValueError(f"duplicate skill {skill_id}")
        # A field written `name?` may be absent from a record (optional in the data model).
        def requirement(k, v, **extra):
            return Requirement(object_type=k, fields=[f.rstrip("?") for f in v], nullable_fields=[f[:-1] for f in v if f.endswith("?")], **extra)
        requirements = [requirement(k, v) for k, v in (context or {}).items()]
        requirements += [requirement(k, v, min_count=0, optional=True) for k, v in (optional or {}).items()]
        spec = SkillSpec(skill_id, fn, object_schema(params or {}, required), object_schema(returns or {}), requirements,
                         description or inspect.getdoc(fn) or skill_id, mode, effects, tuple(capabilities), tuple(dependencies), limitations=list(limitations))
        Draft202012Validator.check_schema(spec.params)
        Draft202012Validator.check_schema(spec.output)
        REGISTRY[skill_id] = spec
        return fn
    return decorate


@lru_cache(maxsize=2048)
def compiled_validator(serialized):
    return Draft202012Validator(json.loads(serialized), format_checker=FormatChecker())


def validate(schema, data, code="INPUT_INVALID"):
    errors = sorted(compiled_validator(json.dumps(schema, sort_keys=True)).iter_errors(data), key=lambda e: str(e.path))
    if errors:
        raise SkillError(code, "; ".join(f"{'.'.join(map(str,e.path)) or '$'}: failed {e.validator}" for e in errors[:5]), Status.FAILED)


def load_registry():
    from . import skills  # noqa: F401
    global _HARDENED
    if set(declared_policy_fields()) != set(REGISTRY):
        raise ValueError("explicit policy declarations must cover exactly the registered skills")
    if not _HARDENED:
        from importlib.resources import files
        limits = json.loads(files("financial_crime").joinpath("resources", "skill-limitations.json").read_text())
        if set(limits) != set(REGISTRY) or any(not isinstance(v, list) or not v or
                any(not isinstance(text, str) or not text.strip() for text in v) for v in limits.values()):
            raise ValueError("business limitations must cover exactly the registered skills")
        for skill_id, limitations in limits.items():
            REGISTRY[skill_id].limitations = list(limitations)
        from .payload_types import configure
        from .schema_types import audit_schema
        configure(REGISTRY)
        for spec in REGISTRY.values():
            for kind, schema in [("input", spec.params), ("output", spec.output)]:
                errors = audit_schema(schema, bounded=True)
                if errors:
                    raise ValueError(f"untyped {kind} contract {spec.id}: {errors[:4]}")
                Draft202012Validator.check_schema(schema)
        _HARDENED = True
    import networkx as nx
    graph = nx.DiGraph()
    for spec in REGISTRY.values():
        graph.add_node(spec.id)
        for dep in spec.dependencies:
            if dep not in REGISTRY:
                raise ValueError(f"missing dependency: {spec.id} -> {dep}")
            graph.add_edge(spec.id, dep)
    if not nx.is_directed_acyclic_graph(graph):
        raise ValueError("cyclic skill dependency graph")
    return REGISTRY


_HARDENED = False

