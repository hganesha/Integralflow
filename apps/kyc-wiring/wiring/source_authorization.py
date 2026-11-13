"""Verify gateway authority again at live admission and each queued provider attempt."""
import base64
import hashlib
import hmac
import json
import os
import time
from urllib.parse import urlparse
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding
from .core import WiringError, canonical


def denied():
    raise WiringError('SOURCE_AUTHORIZATION_DENIED', 'Current gateway source authorization is required', 403)


def verify_source_authorization(request, provider_id, contract=None):
    """The stored raw submission binds all subject/purpose fields without cross-language JSON hashing."""
    proof = request.get('extensions', {}).get('source_authorization', {})
    token, raw_body = proof.get('token'), proof.get('request_body')
    key = os.getenv('SOURCE_AUTHORIZATION_VERIFY_KEY', '')
    if not isinstance(token, str) or len(token) > 32768 or not isinstance(raw_body, str) or len(raw_body) > 1048576 or not key:
        denied()
    try:
        head, body, signature = token.split('.')
        decode = lambda value: base64.urlsafe_b64decode(value + '=' * (-len(value) % 4))
        header, claims = json.loads(decode(head)), json.loads(decode(body))
        if set(header) != {'alg', 'typ'} or header['typ'] != 'JWT':
            denied()
        message = (head + '.' + body).encode()
        if key.startswith('-----BEGIN PUBLIC KEY-----'):
            if header['alg'] != 'RS256':
                denied()
            serialization.load_pem_public_key(key.encode()).verify(decode(signature), message, padding.PKCS1v15(), hashes.SHA256())
        else:
            if len(key) < 24 or header['alg'] != 'HS256' or not hmac.compare_digest(decode(signature), hmac.new(key.encode(), message, hashlib.sha256).digest()):
                denied()
        now = time.time()
        if claims.get('iss') != 'ehf-source-policy' or claims.get('aud') != 'ehf-kyc-wiring' or type(claims.get('iat')) is not int or type(claims.get('exp')) is not int:
            denied()
        if not claims['iat'] <= now + 5 or not now < claims['exp'] <= claims['iat'] + 60:
            denied()
        original = json.loads(raw_body)
        clean = {**request, 'extensions': {k: v for k, v in request.get('extensions', {}).items() if k != 'source_authorization'}}
        if canonical(original) != canonical({'provider_id': provider_id, 'request': clean}):
            denied()
        if claims.get('tenant_id') != request['tenant_id'] or claims.get('operation_id') != provider_id + ':' + request['capability']:
            denied()
        if not hmac.compare_digest(claims.get('request_digest', ''), hashlib.sha256(raw_body.encode()).hexdigest()):
            denied()
        scope = claims['scope']
        if scope['purpose'] != request['purpose'] or scope['legal_basis'] != request['legal_basis']:
            denied()
        if contract is not None:
            if scope.get('upstream_contract_digest') != hashlib.sha256(canonical(contract).encode()).hexdigest():
                denied()
            if not set(scope['policy_refs']) <= set(contract.get('policy_refs', [])):
                denied()
            for key_name in ['processing_regions', 'storage_regions', 'subprocessors']:
                actual = contract.get(key_name)
                if not isinstance(actual, list) or (key_name != 'subprocessors' and not actual) or not set(actual) <= set(scope[key_name]):
                    denied()
            if not set(scope['dataset_ids']) <= set(contract.get('upstream_datasets', [])):
                denied()
            target = urlparse(contract['base_url'])
            allowed = False
            for endpoint in scope['approved_endpoints']:
                base = urlparse(endpoint)
                path = base.path.rstrip('/')
                if target.scheme == base.scheme == 'https' and target.netloc == base.netloc and not target.username and not target.password and (target.path == path or target.path.startswith(path + '/')):
                    allowed = True
            if not allowed:
                denied()
        return claims
    except WiringError:
        raise
    except Exception:
        denied()
