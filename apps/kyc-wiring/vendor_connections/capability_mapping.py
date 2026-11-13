"""Versioned operation-mapping lookup for documented vendor operations (design step 4).

The capability and lifecycle role of a native call come from the reviewed NativeOperationMapping, never
from coarse native semantics or a caller-supplied label. The v1 host envelope can only name the 37 legacy
capabilities, so an operation gets a v1 host result only when its mapped family has a legacy alias, its
role can produce a finding and its mapping is not blocked. Everything else returns a typed operation
receipt that produces no intelligence. See ../docs/CANONICAL_EXTERNAL_CAPABILITY_MODEL.md, section 6.2.
"""
from functools import lru_cache
import json
from jsonschema import Draft202012Validator, FormatChecker
from wiring.core import ATLAS, WiringError, read, stamp, uid
from .client import ROOT

NON_PRODUCING_ROLES = frozenset({'upload', 'submit', 'control', 'simulate'})
RECEIPT_REASONS = {'control': 'control_operation', 'upload': 'upload_operation', 'simulate': 'synthetic_test_operation'}

@lru_cache
def _registry():
    return {(r['vendor_definition_id'], r['native_operation_id']): r for r in json.loads((ROOT / 'mappings/operation-mappings.json').read_text())['records']}

@lru_cache
def _definitions():
    return {d['capability_path']: d for d in read(ATLAS / 'capability-model/capability-definitions.json')['records']}

@lru_cache
def _receipt_validator():
    return Draft202012Validator(read(ATLAS / 'schemas/v2/operation-receipt.schema.json'), format_checker=FormatChecker())

def mapping(vendor, operation):
    """Return the reviewed mapping or fail closed: an unmapped operation never falls back to person verification."""
    m = _registry().get((vendor, operation))
    if m is None: raise WiringError('OPERATION_MAPPING_MISSING', f'No reviewed capability mapping for {vendor}:{operation}; rebuild operation mappings after review', 409)
    return m

def definition(m): return _definitions()[m['primary_capability_path']]

def legacy_capability(m):
    aliases = definition(m)['legacy_aliases']
    return aliases[0] if aliases else None

def receipt_reason(m):
    """None when the v1 host envelope can carry this operation; otherwise why it is receipt-only."""
    if m['status'] == 'blocked': return 'mapping_blocked'
    if m['operation_role'] in RECEIPT_REASONS: return RECEIPT_REASONS[m['operation_role']]
    if legacy_capability(m) is None: return 'no_v1_capability_contract'
    return None

def check_requested(m, requested):
    """Reject a caller capability the operation cannot satisfy. Call before any upstream request is sent."""
    if requested is None: return
    op = f"{m['vendor_definition_id']}:{m['native_operation_id']}"
    if m['dispatch_status'] == 'required_unconfigured':
        raise WiringError('DISPATCH_NOT_CONFIGURED', f'{op} is a configurable check; its dispatch branches are not configured, so it cannot satisfy {requested}', 409)
    if m['status'] == 'blocked':
        raise WiringError('OPERATION_MAPPING_BLOCKED', f'{op} mapping is blocked ({", ".join(m["blockers"])})', 409)
    if receipt_reason(m) is not None or legacy_capability(m) != requested:
        raise WiringError('CAPABILITY_INCOMPATIBLE', f"{op} maps to {m['capability_id']} ({m['operation_role']}) and cannot satisfy {requested}", 422)

def summary(m):
    return {'operation_mapping_id': m['operation_mapping_id'], 'capability_id': m['capability_id'], 'primary_capability_path': m['primary_capability_path'],
            'operation_role': m['operation_role'], 'legacy_capability': legacy_capability(m), 'receipt_reason': receipt_reason(m),
            'mapping_status': m['status'], 'mapping_relation': m['mapping_relation'], 'blockers': list(m['blockers'])}

def operation_receipt(native, m, context, artifact_ref):
    """Typed receipt for a call that cannot produce an intelligence result. Native payload fields are not copied."""
    ok = native['successful_http']
    pending = ok and (native['semantics'] in ('session', 'submission') or m['operation_role'] == 'submit')
    status = native.get('native_status')
    r = {'receipt_id': uid(), 'request_id': context['request_id'], 'tenant_id': context['tenant_id'], 'subject_entity_id': context['subject_entity_id'],
         'operation_mapping_id': m['operation_mapping_id'], 'vendor_definition_id': m['vendor_definition_id'], 'provider_record_id': m['provider_record_id'],
         'native_operation_id': m['native_operation_id'], 'native_api_version': m['native_api_version'], 'capability_id': m['capability_id'],
         'primary_capability_path': m['primary_capability_path'], 'operation_role': m['operation_role'], 'operation_kind': m['operation_kind'],
         'receipt_reason': receipt_reason(m) or 'no_v1_capability_contract',
         'execution': {'status': 'failed' if not ok else 'pending' if pending else 'completed', 'http_status': native.get('http_status'), 'received_at': stamp()},
         'native_status_original': str(status) if status is not None else None,
         'provider_resource_ref': str(native['resource_id']) if native.get('resource_id') is not None else None,
         'produces_intelligence': False, 'synthetic': m['primary_capability_path'] == 'platform.testing', 'assertions': [], 'checked_scope': [], 'enables': list(m['enables']),
         'mapping': {'status': m['status'], 'mapping_relation': m['mapping_relation'], 'blockers': list(m['blockers']), 'model_version': definition(m)['model_version']},
         'raw_payload': {'vault_ref': artifact_ref, 'sha256': native['raw_sha256'], 'classification': 'restricted'},
         'warnings': ['VENDOR_IMPLEMENTATION_NOT_LIVE_TESTED', 'OPERATION_RECEIPT_IS_NOT_A_CHECK_RESULT', 'CAPABILITY_MAPPING_PROPOSED'],
         'errors': [] if ok else [{'code': 'UPSTREAM_HTTP_' + str(native.get('http_status')), 'message': 'Vendor returned an unsuccessful HTTP response; inspect restricted artifact'}]}
    error = next(_receipt_validator().iter_errors(r), None)
    if error: raise WiringError('SCHEMA_INVALID', 'operation receipt schema mismatch at /' + '/'.join(map(str, error.absolute_path)))
    return r
