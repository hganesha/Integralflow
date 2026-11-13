"""Mint real scoped proofs for synthetic live-transport fixtures; no verifier is mocked."""
import base64
import copy
import hashlib
import hmac
import json
import time
from wiring.core import canonical

KEY = 'synthetic-source-authorization-fixture-signing-key'


def proof_for(request, provider, contract, issued_at=None):
    clean = copy.deepcopy(request)
    clean.setdefault('extensions', {}).pop('source_authorization', None)
    if contract:
        contract.setdefault('storage_regions', list(contract.get('processing_regions', [])))
        contract.setdefault('subprocessors', [])
    body = json.dumps({'provider_id': provider, 'request': clean})
    now = int(time.time()) if issued_at is None else issued_at
    claims = {'iss': 'ehf-source-policy', 'aud': 'ehf-kyc-wiring', 'iat': now, 'exp': now + 60,
              'tenant_id': clean['tenant_id'], 'operation_id': provider + ':' + clean['capability'],
              'request_digest': hashlib.sha256(body.encode()).hexdigest(), 'decision_id': 'SD-synthetic-fixture',
              'scope': {'purpose': clean['purpose'], 'legal_basis': clean['legal_basis'],
                        'policy_refs': contract.get('policy_refs', []), 'processing_regions': contract.get('processing_regions', []),
                        'storage_regions': contract.get('storage_regions', []), 'subprocessors': contract.get('subprocessors', []),
                        'dataset_ids': contract.get('upstream_datasets', []), 'approved_endpoints': contract.get('approved_base_urls', []),
                        'upstream_contract_digest': hashlib.sha256(canonical(contract).encode()).hexdigest()}}
    encode = lambda value: base64.urlsafe_b64encode(json.dumps(value).encode()).decode().rstrip('=')
    value = encode({'alg': 'HS256', 'typ': 'JWT'}) + '.' + encode(claims)
    signature = base64.urlsafe_b64encode(hmac.new(KEY.encode(), value.encode(), hashlib.sha256).digest()).decode().rstrip('=')
    return value + '.' + signature, body


def authorize_stored_request(request, provider, contract, issued_at=None):
    token, body = proof_for(request, provider, contract, issued_at)
    request.setdefault('extensions', {})['source_authorization'] = {'token': token, 'request_body': body}
