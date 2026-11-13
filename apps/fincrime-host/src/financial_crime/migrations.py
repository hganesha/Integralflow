"""Explicit, non-destructive translations and conservative contract compatibility reports."""
from copy import deepcopy
import json

from .contracts import Invocation, Record, SkillError, Status, digest
from .context_types import CONTEXT_TYPES
from .ontology import ensure_types
from .registry import load_registry, validate
from .schema_types import DEFS
from .versions import LEGACY_SCHEMA_VERSION, SCHEMA_VERSION, SKILL_VERSION


def migrate_record(raw):
    """Return a new version; never mutate a persisted source or invent missing evidence."""
    if raw.get("schema_version") != LEGACY_SCHEMA_VERSION:
        raise SkillError("SCHEMA_VERSION_UNSUPPORTED", "only explicit 1.0.0 -> 2.0.0 migration is supported")
    required = {"id", "tenant_id", "object_type", "version_id", "data", "recorded_at", "observed_at", "purposes", "classification", "synthetic"}
    if not required <= raw.keys():
        raise SkillError("MIGRATION_REQUIRES_EVIDENCE", "identity, time and access metadata must be supplied explicitly", Status.NEEDS_EVIDENCE)
    ensure_types()
    object_type = raw["object_type"]
    if object_type not in CONTEXT_TYPES or object_type == "SkillExecution":
        raise SkillError("MIGRATION_REQUIRES_REVIEW", "execution/audit artifacts require their original versioned reader")
    candidate = deepcopy(raw)
    data = candidate["data"]
    if not isinstance(data, dict):
        raise SkillError("MIGRATION_REQUIRES_REVIEW", "record data must be an object")
    def require_reference_versions(value, schema, resolving=()):
        # Traverse declared types only; arbitrary raw JSON values are never reinterpreted as references.
        name = schema.get("$ref", "").removeprefix("#/$defs/")
        if name == "Ref":
            if isinstance(value, dict) and "schema_version" not in value:
                raise SkillError("MIGRATION_REQUIRES_EVIDENCE", "nested canonical references need an explicit source schema version", Status.NEEDS_EVIDENCE)
            return
        if name:
            if name in {"JsonValue", "JsonObject"} or name in resolving:
                return
            require_reference_versions(value, DEFS[name], (*resolving, name))
            return
        if isinstance(value, dict):
            for key, nested in value.items():
                child = schema.get("properties", {}).get(key)
                if child is None and isinstance(schema.get("additionalProperties"), dict):
                    child = schema["additionalProperties"]
                if child is not None:
                    require_reference_versions(nested, child, resolving)
        if isinstance(value, list) and "items" in schema:
            for nested in value:
                require_reference_versions(nested, schema["items"], resolving)
        for keyword in ("allOf", "anyOf", "oneOf"):
            for child in schema.get(keyword, []):
                require_reference_versions(value, child, resolving)
    require_reference_versions(data, DEFS[object_type])
    unknown = {k: data.pop(k) for k in list(data) if k not in DEFS[object_type]["properties"]}
    extensions = data.setdefault("extensions", {})
    if not isinstance(extensions, dict) or any(k in extensions for k in ["legacy.v1", "migration.v1"]):
        raise SkillError("MIGRATION_REQUIRES_REVIEW", "extension namespace collision; no data was overwritten")
    if unknown:
        extensions["legacy.v1"] = {"schema_version": LEGACY_SCHEMA_VERSION, "value": unknown}
    extensions["migration.v1"] = {"schema_version": LEGACY_SCHEMA_VERSION, "value": {
        "source_version_id": raw["version_id"], "source_schema_version": LEGACY_SCHEMA_VERSION, "source_value_hash": digest(raw)}}
    def legacy_references(value):
        if isinstance(value, dict):
            if {"tenant_id", "object_type", "object_id", "version_id"} <= value.keys():
                value.setdefault("schema_version", LEGACY_SCHEMA_VERSION)
            for nested in value.values():
                legacy_references(nested)
        elif isinstance(value, list):
            for nested in value:
                legacy_references(nested)
    # Only canonical metadata references are normalized; raw source/extension values stay byte-semantically unchanged.
    for source_ref in candidate.get("source_refs", []):
        legacy_references(source_ref)
    candidate["schema_version"] = SCHEMA_VERSION
    candidate["supersedes"] = raw["version_id"]
    candidate["version_id"] = digest({"source": raw, "target_schema": SCHEMA_VERSION})
    try:
        return Record.model_validate(candidate)
    except (SkillError, ValueError):
        raise SkillError("MIGRATION_REQUIRES_EVIDENCE", "new required fields or nested types are unresolved; source retained unchanged", Status.NEEDS_EVIDENCE)


def migrate_invocation(raw, *, new_execution_id, new_idempotency_key, new_profile_id):
    """Re-plan under a new API version; never relabel an old approval or reuse its action key."""
    if raw.get("skill_version") != "0.1.0":
        raise SkillError("SCHEMA_VERSION_UNSUPPORTED", "expected a 0.1.0 skill invocation")
    if not new_execution_id or not new_idempotency_key or not new_profile_id:
        raise SkillError("INPUT_INVALID", "new execution, idempotency key and profile are required", Status.FAILED)
    if new_execution_id == raw.get("execution_id") or new_idempotency_key == raw.get("idempotency_key"):
        raise SkillError("IDEMPOTENCY_CONFLICT", "migration cannot reuse a previous action identity")
    candidate = deepcopy(raw)
    candidate.update(execution_id=new_execution_id, idempotency_key=new_idempotency_key, profile_id=new_profile_id, skill_version=SKILL_VERSION)
    registry = load_registry()
    if candidate.get("skill_id") not in registry:
        raise SkillError("INPUT_INVALID", "unknown skill", Status.FAILED)
    validate(registry[candidate["skill_id"]].params, candidate.get("parameters", {}), "MIGRATION_REQUIRES_REVIEW")
    if any(x.get("schema_version", LEGACY_SCHEMA_VERSION) != SCHEMA_VERSION for x in candidate.get("object_refs", [])):
        raise SkillError("MIGRATION_REQUIRES_EVIDENCE", "object references must be migrated explicitly", Status.NEEDS_EVIDENCE)
    return Invocation.model_validate(candidate)


def compare_schemas(old, new, *, direction="acceptance"):
    """Conservative structural check. Unknown implications require review, never auto-promotion.

    Acceptance asks whether a new validator accepts old inputs. Production reverses
    the relation: can an old consumer accept all new producer outputs?
    """
    if direction not in {"acceptance", "production"}:
        raise ValueError("direction must be acceptance or production")
    if direction == "production":
        old, new = new, old
    def remote(value):
        if isinstance(value, dict):
            return any(key in value and (not isinstance(value[key], str) or not (value[key] == "#" or value[key].startswith("#/"))) for key in ("$ref", "$dynamicRef")) or any(remote(x) for x in value.values())
        return isinstance(value, list) and any(remote(x) for x in value)
    if remote(old) or remote(new):
        return {"direction": direction, "verdict": "REVIEW_REQUIRED", "changes": [{"path": "#", "severity": "REVIEW_REQUIRED", "reason": "external schema content is not pinned"}], "automatic_promotion_allowed": False}
    changes = []
    annotation = {"$id", "$schema", "description", "title", "default", "examples"}
    def normalized(value):
        if isinstance(value, dict):
            result = {}
            for key, item in value.items():
                if key in annotation or key.startswith("x-"):
                    continue
                if key in {"properties", "$defs", "patternProperties", "dependentSchemas", "dependentRequired"}:
                    # Member names are business data, even when named title/default/x-foo.
                    result[key] = {name: normalized(child) for name, child in item.items()}
                elif key in {"enum", "const"}:
                    result[key] = deepcopy(item)
                else:
                    result[key] = sorted(item) if key == "required" else normalized(item)
            return result
        if isinstance(value, list):
            return [normalized(v) for v in value]
        return value
    def walk(a, b, path):
        if normalized(a) == normalized(b):
            return
        if not isinstance(a, dict) or not isinstance(b, dict):
            changes.append({"path": path, "severity": "REVIEW_REQUIRED", "reason": "constraint changed"})
            return
        added_required = set(b.get("required", []))-set(a.get("required", []))
        if added_required:
            changes.append({"path": path, "severity": "BREAKING", "reason": "new required fields: "+", ".join(sorted(added_required))})
        ap, bp = a.get("properties", {}), b.get("properties", {})
        for key in sorted(set(bp)-set(ap)):
            if a.get("additionalProperties", True) is not False:
                changes.append({"path": path+"/properties/"+key, "severity": "REVIEW_REQUIRED", "reason": "new named field may restrict previously accepted dynamic values"})
        for key in sorted(set(ap)-set(bp)):
            if b.get("additionalProperties") is False:
                changes.append({"path": path+"/properties/"+key, "severity": "BREAKING", "reason": "previously accepted field removed"})
            elif b.get("additionalProperties", True) is not True:
                changes.append({"path": path+"/properties/"+key, "severity": "REVIEW_REQUIRED", "reason": "removed named field now uses a dynamic value contract"})
        for key in sorted(set(ap) & set(bp)):
            walk(ap[key], bp[key], path+"/properties/"+key)
        if a.get("additionalProperties", True) is not False and b.get("additionalProperties") is False:
            changes.append({"path": path, "severity": "BREAKING", "reason": "object was closed"})
        if "enum" in b and ("enum" not in a or not {json.dumps(x, sort_keys=True) for x in a["enum"]} <= {json.dumps(x, sort_keys=True) for x in b["enum"]}):
            changes.append({"path": path, "severity": "BREAKING", "reason": "accepted enum values narrowed"})
        structural = {"properties", "required", "additionalProperties", *annotation}
        rest_a = {k: v for k, v in a.items() if k not in structural and not k.startswith("x-")}
        rest_b = {k: v for k, v in b.items() if k not in structural and not k.startswith("x-")}
        if normalized(rest_a) != normalized(rest_b):
            changes.append({"path": path, "severity": "REVIEW_REQUIRED", "reason": "type, reference, bounds or composition changed"})
        extra_a, extra_b = a.get("additionalProperties", True), b.get("additionalProperties", True)
        if extra_a != extra_b and extra_b is not False:
            changes.append({"path": path+"/additionalProperties", "severity": "REVIEW_REQUIRED", "reason": "dynamic value contract changed"})
    walk(old, new, "#")
    verdict = "BREAKING" if any(x["severity"] == "BREAKING" for x in changes) else "REVIEW_REQUIRED" if changes else "COMPATIBLE"
    return {"direction": direction, "verdict": verdict, "changes": changes, "automatic_promotion_allowed": verdict == "COMPATIBLE"}
