"""Design step 4: vendor-test normalization takes capability and role from the reviewed operation mapping."""
import collections, copy, json
from pathlib import Path
import pytest
from cryptography.fernet import Fernet
from fastapi.testclient import TestClient
from jsonschema import Draft202012Validator, FormatChecker
from vendor_connections import capability_mapping as cm
from vendor_connections.client import definitions
from vendor_connections.normalization import interpret, normalize
from wiring.core import ATLAS, Settings, Registry, WiringError, read
from wiring.app import create_app

P = Path(__file__).resolve().parents[1]
CONTEXT = {'tenant_id': 't', 'request_id': 'r', 'subject_entity_id': 's'}
RECEIPT = Draft202012Validator(read(ATLAS / 'schemas/v2/operation-receipt.schema.json'), format_checker=FormatChecker())
MAPPINGS = json.loads((P / 'vendor_connections/mappings/operation-mappings.json').read_text())['records']
ALL = [(m['vendor_definition_id'], m['native_operation_id']) for m in MAPPINGS]

def native(vendor, operation, ok=True, payload=None):
    op = definitions()[vendor]['operations'][operation]
    return {'provider_id': vendor, 'operation_id': operation, 'semantics': op['semantics'], 'successful_http': ok, 'http_status': 200 if ok else 500,
            'native_status': None, 'native_payload': {} if payload is None else payload, 'raw_sha256': '0' * 64, 'source': op['source'], 'resource_id': None}

@pytest.fixture(scope='module')
def registry(tmp_path_factory):
    return Registry(Settings(database_url='sqlite:///' + str(tmp_path_factory.mktemp('r') / 'host.db'), encryption_key=Fernet.generate_key().decode()))

@pytest.mark.parametrize('ok', [True, False])
def test_every_operation_returns_exactly_one_honest_output(ok, registry):
    outputs = collections.Counter()
    for vendor, operation in ALL:
        m = cm.mapping(vendor, operation); out = interpret(native(vendor, operation, ok), CONTEXT, 'artifact://x')
        assert (out['host'] is None) != (out['operation_receipt'] is None), (vendor, operation)
        assert out['capability_mapping']['operation_mapping_id'] == m['operation_mapping_id']
        if out['host'] is not None:
            h = out['host']; registry.validate('host', h); outputs['host'] += 1
            assert h['capability'] == cm.legacy_capability(m), 'v1 capability is the mapped family alias, never a semantics default'
            assert h['assessment']['bank_decision'] == 'not_evaluated' and h['assertions'] == []
            assert h['extensions']['capability_mapping']['capability_id'] == m['capability_id']
            if m['operation_role'] == 'submit' and ok: assert (h['execution']['status'], h['assessment']['outcome']) == ('pending', 'not_checked')
        else:
            r = out['operation_receipt']; RECEIPT.validate(r); outputs['receipt'] += 1
            assert r['produces_intelligence'] is False and r['assertions'] == [] and r['checked_scope'] == []
            assert r['receipt_reason'] == cm.receipt_reason(m)
            assert (r['execution']['status'] == 'failed') == (not ok)
    assert outputs == {'host': 168, 'receipt': 564}

def test_receipts_cover_controls_blocked_and_native_only_families():
    reasons = collections.Counter(cm.receipt_reason(m) for m in MAPPINGS)
    assert reasons == {None: 168, 'control_operation': 281, 'no_v1_capability_contract': 221, 'upload_operation': 32, 'synthetic_test_operation': 14, 'mapping_blocked': 16}
    for m in MAPPINGS:
        if m['operation_role'] in ('control', 'upload', 'simulate') or m['status'] == 'blocked' or not cm.definition(m)['legacy_aliases']:
            assert cm.receipt_reason(m) is not None

def test_vendor_native_no_longer_defaults_to_person_verification():
    # Before step 4 each of these returned capability identity.person.verify, screening.sanctions or account.ownership.verify.
    assert interpret(native('plaid', 'accountsGet'), CONTEXT, 'a')['operation_receipt']['capability_id'] == 'account.profile.intelligence.unresolved'
    assert interpret(native('plaid', 'transactionsGet'), CONTEXT, 'a')['operation_receipt']['capability_id'] == 'financial.transactions.intelligence.unresolved'
    assert interpret(native('belvo', 'owners'), CONTEXT, 'a')['operation_receipt']['primary_capability_path'] == 'account.profile'
    assert interpret(native('dilisense', 'individual_media'), CONTEXT, 'a')['host']['capability'] == 'screening.adverse_media'
    assert interpret(native('gleif', 'get_lei'), CONTEXT, 'a')['host']['capability'] == 'reference.identifier.lookup'
    watchlist = [m for m in MAPPINGS if m['primary_capability_path'] == 'screening.watchlist']
    assert watchlist and all(interpret(native(m['vendor_definition_id'], m['native_operation_id']), CONTEXT, 'a')['host'] is None for m in watchlist)
    person = [m for m in MAPPINGS if m['native_semantics_original'] == 'vendor_native' and interpret(native(m['vendor_definition_id'], m['native_operation_id']), CONTEXT, 'a')['host'] is not None
              and cm.legacy_capability(m) == 'identity.person.verify']
    assert all(m['primary_capability_path'] == 'identity.person' for m in person)

def test_compatible_capability_keeps_deep_normalizer():
    p = json.loads((ATLAS / 'examples/native/plaid.json').read_text())
    h = interpret(native('plaid', 'identityMatch', payload=p), {**CONTEXT, 'capability': 'account.ownership.verify'}, 'a')['host']
    assert h['capability'] == 'account.ownership.verify' and 'NATIVE_FIELDS_NOT_FULLY_NORMALIZED' not in h['warnings'] and h['result']['accounts']

@pytest.mark.parametrize('vendor,operation,requested,code', [
    ('plaid', 'accountsGet', 'account.ownership.verify', 'CAPABILITY_INCOMPATIBLE'),
    ('plaid', 'identityMatch', 'identity.person.verify', 'CAPABILITY_INCOMPATIBLE'),
    ('gleif', 'get_lei', 'business.registry.lookup', 'CAPABILITY_INCOMPATIBLE'),
    ('dilisense', 'individual_media', 'screening.sanctions', 'CAPABILITY_INCOMPATIBLE'),
    ('entrust-onfido', 'create_check', 'identity.document.verify', 'DISPATCH_NOT_CONFIGURED'),
    ('prembly', 'documented_national_id', 'identity.person.verify', 'OPERATION_MAPPING_BLOCKED'),
])
def test_incompatible_requested_capability_is_rejected(vendor, operation, requested, code):
    with pytest.raises(WiringError) as e: interpret(native(vendor, operation), {**CONTEXT, 'capability': requested}, 'a')
    assert e.value.code == code

def test_normalize_refuses_receipt_only_operations():
    with pytest.raises(WiringError) as e: normalize(native('plaid', 'accountsGet'), CONTEXT, 'a')
    assert e.value.code == 'OPERATION_RECEIPT_ONLY'

def test_missing_mapping_fails_closed(monkeypatch):
    monkeypatch.setattr(cm, '_registry', lambda: {})
    with pytest.raises(WiringError) as e: interpret(native('plaid', 'identityMatch'), CONTEXT, 'a')
    assert e.value.code == 'OPERATION_MAPPING_MISSING'

def test_api_rejects_incompatible_capability_before_reserving_or_sending(tmp_path, monkeypatch):
    monkeypatch.setenv('VENDOR_TEST_ENABLED', '1'); monkeypatch.setenv('VENDOR_TEST_TENANTS_JSON', '["test"]')
    app = create_app(Settings(demo=False, database_url='sqlite:///' + str(tmp_path / 'v.db'), encryption_key=Fernet.generate_key().decode(),
                              api_keys={'secret': {'tenant_id': 'test', 'role': 'admin'}}, worker_enabled=False))
    sent = []
    monkeypatch.setattr(app.state.vendor_client, 'build', lambda *a, **k: (None, None, None))
    monkeypatch.setattr(app.state.vendor_client, 'send', lambda *a, **k: sent.append(a) or {**native('plaid', 'accountsGet'), 'raw_bytes_base64': 'e30='})
    req = json.loads((ATLAS / 'examples/requests/plaid.json').read_text()) | {'tenant_id': 'test', 'request_id': 'r', 'subject_entity_id': 'subject-001'}
    body = {'request_id': 'r', 'subject_entity_id': 'subject-001', 'body': {'access_token': 'x'}, 'canonical_request': req}
    url, h = '/v1/vendor-connections/plaid/operations/accountsGet/invoke', {'Authorization': 'Bearer secret', 'Idempotency-Key': 'k'}
    with TestClient(app) as c:
        r = c.post(url, json=body, headers=h)
        assert r.status_code == 422 and r.json()['code'] == 'CAPABILITY_INCOMPATIBLE' and sent == []
        ok = c.post(url, json={k: v for k, v in body.items() if k != 'canonical_request'}, headers=h)
        assert ok.status_code == 200, ok.text
        result = ok.json()['result']
        assert result['host'] is None and result['operation_receipt']['receipt_reason'] == 'no_v1_capability_contract'
        assert result['capability_mapping']['capability_id'] == 'account.profile.intelligence.unresolved' and len(sent) == 1

def test_failed_list_download_is_schema_valid(registry):
    # Regression: a failed dataset download used to be labelled not_applicable, which the host schema rejects for failed executions.
    h = interpret(native('ofac-sanctions-list-service', 'download_sdn', ok=False), CONTEXT, 'a')['host']
    registry.validate('host', h); assert (h['execution']['status'], h['assessment']['outcome']) == ('failed', 'unknown')
    assert interpret(native('ofac-sanctions-list-service', 'download_sdn'), CONTEXT, 'a')['host']['assessment']['outcome'] == 'not_applicable'
