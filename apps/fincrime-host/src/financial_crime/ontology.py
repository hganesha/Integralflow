"""Executable closed ontology and projected-field validation."""
from functools import lru_cache
from .context_types import CONTEXT_TYPES, POLICY_FIELDS, data_schema
from .schema_types import DEFS, document, obj


def ensure_types():
    from . import payload_types  # installs named runtime and provider payload definitions


@lru_cache(maxsize=256)
def field_schema(object_type, name):
    ensure_types()
    if object_type not in CONTEXT_TYPES or name not in DEFS[object_type]['properties']:
        raise ValueError(f'context field not declared: {object_type}.{name}')
    return document(DEFS[object_type]['properties'][name])


@lru_cache(maxsize=1024)
def projection_schema(object_type, fields):
    ensure_types()
    properties = DEFS[object_type]['properties']
    return document(obj({k: properties[k] for k in fields}))


def validate_fields(object_type, data, fields):
    from .registry import validate
    projected = {f: data[f] for f in fields}
    validate(projection_schema(object_type, tuple(fields)), projected, 'CONTEXT_INVALID')


@lru_cache(maxsize=64)
def policy_field_schema(name):
    if name not in POLICY_FIELDS:
        raise ValueError('undeclared policy field '+name)
    return document(POLICY_FIELDS[name])


def validate_policy(data):
    from .registry import validate
    validate(projection_schema('Policy', tuple(data)), data, 'POLICY_UNRESOLVED')
    if not {'permissions','version','jurisdiction'} <= data.keys():
        from .contracts import SkillError
        raise SkillError('POLICY_UNRESOLVED','bootstrap policy fields missing')


@lru_cache(maxsize=128)
def canonical_data_schema(object_type):
    ensure_types()
    if object_type == "SkillExecution":
        from .registry import load_registry
        load_registry()
    return data_schema(object_type)


def validate_record_data(object_type, data):
    from .registry import validate
    from .contracts import SkillError, Status
    try:
        schema = canonical_data_schema(object_type)
    except ValueError as e:
        raise SkillError('CONTEXT_INVALID', str(e), Status.FAILED)
    validate(schema, data, 'CONTEXT_INVALID')
