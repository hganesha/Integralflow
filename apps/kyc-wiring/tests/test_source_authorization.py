import base64
import copy
import hashlib
import hmac
import json
import time
import pytest
from wiring.core import WiringError, canonical
from wiring.source_authorization import verify_source_authorization

KEY = 'synthetic-source-authorization-key-for-tests'


def signed_request(monkeypatch):
    monkeypatch.setenv('SOURCE_AUTHORIZATION_VERIFY_KEY', KEY)
    request = {'tenant_id': 'test-tenant', 'capability': 'business.registry.lookup', 'purpose': 'CDD', 'legal_basis': 'test-basis',
               'entities': [{'name': 'Synthetic subject', 'score': 1e-7}], 'extensions': {}}
    contract = {'base_url': 'https://source.test/api', 'processing_regions': ['gb'], 'storage_regions': ['gb'],
                'subprocessors': [], 'policy_refs': ['policy:1'], 'upstream_datasets': ['register']}
    body = json.dumps({'provider_id': 'companies-house', 'request': request})
    now = int(time.time())
    claims = {'iss': 'ehf-source-policy', 'aud': 'ehf-kyc-wiring', 'iat': now, 'exp': now + 60, 'tenant_id': 'test-tenant',
              'operation_id': 'companies-house:business.registry.lookup', 'request_digest': hashlib.sha256(body.encode()).hexdigest(),
              'decision_id': 'SD-synthetic', 'scope': {'purpose': 'CDD', 'legal_basis': 'test-basis', 'policy_refs': ['policy:1'],
                'processing_regions': ['gb'], 'storage_regions': ['gb'], 'subprocessors': [], 'dataset_ids': ['register'],
                'approved_endpoints': ['https://source.test/api'], 'upstream_contract_digest': hashlib.sha256(canonical(contract).encode()).hexdigest()}}
    encode = lambda value: base64.urlsafe_b64encode(json.dumps(value).encode()).decode().rstrip('=')
    unsigned = encode({'alg': 'HS256', 'typ': 'JWT'}) + '.' + encode(claims)
    signature = base64.urlsafe_b64encode(hmac.new(KEY.encode(), unsigned.encode(), hashlib.sha256).digest()).decode().rstrip('=')
    request['extensions']['source_authorization'] = {'token': unsigned + '.' + signature, 'request_body': body}
    return request, contract, claims


def test_live_proof_binds_exact_request_scope_and_contract(monkeypatch):
    request, contract, claims = signed_request(monkeypatch)
    assert verify_source_authorization(request, 'companies-house', contract)['decision_id'] == 'SD-synthetic'
    for mutation in [lambda r: r.update(purpose='marketing'), lambda r: r.update(tenant_id='other'),
                     lambda r: r['entities'][0].update(name='Different subject'), lambda r: r['extensions'].clear()]:
        changed = copy.deepcopy(request)
        mutation(changed)
        with pytest.raises(WiringError, match='Current gateway source authorization'):
            verify_source_authorization(changed, 'companies-house', contract)
    for mutation in [{'base_url': 'https://source.test.evil/api'}, {'processing_regions': ['us']}, {'product': 'changed'}]:
        with pytest.raises(WiringError):
            verify_source_authorization(request, 'companies-house', {**contract, **mutation})
    monkeypatch.setattr('wiring.source_authorization.time.time', lambda: claims['exp'])
    with pytest.raises(WiringError):
        verify_source_authorization(request, 'companies-house', contract)


def test_proof_rejects_tampering_wrong_key_algorithm_and_cross_operation(monkeypatch):
    request, contract, _ = signed_request(monkeypatch)
    with pytest.raises(WiringError):
        verify_source_authorization(request, 'different-provider', contract)
    monkeypatch.setenv('SOURCE_AUTHORIZATION_VERIFY_KEY', 'another-source-authorization-key-for-tests')
    with pytest.raises(WiringError):
        verify_source_authorization(request, 'companies-house', contract)
    request, contract, _ = signed_request(monkeypatch)
    proof = request['extensions']['source_authorization']
    original = proof['token']
    proof['token'] = original[:-12] + 'tamperedtest'
    with pytest.raises(WiringError):
        verify_source_authorization(request, 'companies-house', contract)
    header = base64.urlsafe_b64encode(json.dumps({'alg': 'none', 'typ': 'JWT'}).encode()).decode().rstrip('=')
    proof['token'] = header + '.' + original.split('.', 1)[1]
    with pytest.raises(WiringError):
        verify_source_authorization(request, 'companies-house', contract)


def test_rsa_proof_uses_public_verifier_and_rejects_algorithm_substitution(monkeypatch):
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import padding, rsa
    request, contract, claims = signed_request(monkeypatch)
    private = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    public = private.public_key().public_bytes(serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo).decode()
    monkeypatch.setenv('SOURCE_AUTHORIZATION_VERIFY_KEY', public)
    encode = lambda value: base64.urlsafe_b64encode(json.dumps(value).encode()).decode().rstrip('=')
    unsigned = encode({'alg': 'RS256', 'typ': 'JWT'}) + '.' + encode(claims)
    signature = base64.urlsafe_b64encode(private.sign(unsigned.encode(), padding.PKCS1v15(), hashes.SHA256())).decode().rstrip('=')
    request['extensions']['source_authorization']['token'] = unsigned + '.' + signature
    assert verify_source_authorization(request, 'companies-house', contract)['decision_id'] == 'SD-synthetic'
    unsigned = encode({'alg': 'HS256', 'typ': 'JWT'}) + '.' + encode(claims)
    signature = base64.urlsafe_b64encode(hmac.new(public.encode(), unsigned.encode(), hashlib.sha256).digest()).decode().rstrip('=')
    request['extensions']['source_authorization']['token'] = unsigned + '.' + signature
    with pytest.raises(WiringError):
        verify_source_authorization(request, 'companies-house', contract)


def test_expired_queued_authority_holds_then_renews_without_losing_native_progress(tmp_path, monkeypatch):
    from cryptography.fernet import Fernet
    from wiring.core import Settings, Registry
    from wiring.store import Store
    from wiring.worker import Worker
    from wiring.connectors import simulation
    from test_wiring import request as example_request, live_contract
    from source_proof_helpers import KEY as fixture_key, authorize_stored_request
    monkeypatch.setenv('SOURCE_AUTHORIZATION_VERIFY_KEY', fixture_key)
    monkeypatch.setenv('TEST_VENDOR_KEY', 'synthetic-key')
    request = example_request()
    contract = live_contract(req=request)
    authorize_stored_request(request, 'persona', contract, issued_at=int(time.time()) - 120)
    settings = Settings(demo=False, database_url='sqlite:///' + str(tmp_path / 'authority.db'), encryption_key=Fernet.generate_key().decode(),
                        contracts={'persona:identity.person.verify': contract}, worker_enabled=False)
    store = Store(settings)
    row, reused = store.submit('tenant-a', request, 'persona')
    from sqlalchemy import update
    with store.engine.begin() as connection:
        connection.execute(update(store.checks).where(store.checks.c.id == row['id']).values(artifact=store.enc({'provider_record_id': 'already-created'})))
    calls = []
    class Connector:
        def execute(self, row, request, operation, contract, artifact):
            calls.append(artifact['provider_record_id'])
            result, _ = simulation(row, request, operation)
            return result, artifact
    worker = Worker(store, Registry(settings), Connector())
    worker.run_one()
    assert store.row(row['id'])['status'] == 'authorization_required'
    assert calls == []
    authorize_stored_request(request, 'persona', contract)
    renewed, reused = store.submit('tenant-a', request, 'persona')
    assert reused and renewed['id'] == row['id'] and renewed['status'] == 'queued'
    worker.run_one()
    assert calls == ['already-created']


def test_live_api_cannot_admit_an_unsigned_source_call(tmp_path, monkeypatch):
    from cryptography.fernet import Fernet
    from fastapi.testclient import TestClient
    from wiring.core import Settings
    from wiring.app import create_app
    from test_wiring import request as example_request
    settings = Settings(demo=False, database_url='sqlite:///' + str(tmp_path / 'unsigned.db'), encryption_key=Fernet.generate_key().decode(),
                        api_keys={'test': {'tenant_id': 'tenant-a', 'role': 'admin'}}, worker_enabled=False)
    request = example_request()
    with TestClient(create_app(settings)) as client:
        response = client.post('/v1/checks', json={'provider_id': 'persona', 'request': request},
                               headers={'Authorization': 'Bearer test', 'Idempotency-Key': request['idempotency_key']})
        assert response.status_code == 403
        assert response.json()['code'] == 'SOURCE_AUTHORIZATION_DENIED'
