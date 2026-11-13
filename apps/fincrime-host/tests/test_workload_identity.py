"""The skill host's service identity follows the platform's WORKLOAD_AUTH contract."""
import json
import time

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import ec, rsa
from jwt.algorithms import ECAlgorithm, RSAAlgorithm

from financial_crime.runtimes.skill_host import SkillHost
from financial_crime.runtimes.workload_identity import CallerVerifier, OutboundToken, WorkloadIdentityError

ISSUER = "https://k8s.example.test"
AUDIENCE = "ehf-internal"
GATEWAY_SUBJECT = "system:serviceaccount:ehf:capability-gateway"
IDENTITIES = json.dumps({"capability-gateway": GATEWAY_SUBJECT, "harness-runtime": "system:serviceaccount:ehf:runtime-host"})


@pytest.fixture
def issuer(tmp_path):
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    jwk = json.loads(RSAAlgorithm.to_jwk(key.public_key()))
    jwk.update(kid="k1", alg="RS256", use="sig")
    jwks = tmp_path / "jwks.json"
    jwks.write_text(json.dumps({"keys": [jwk]}))

    def mint(sub=GATEWAY_SUBJECT, *, audience=AUDIENCE, iss=ISSUER, exp=None, signer=key, kid="k1"):
        claims = {"sub": sub, "aud": audience, "iss": iss, "exp": exp or int(time.time()) + 300, "roles": ["Platform.Admin"]}
        return jwt.encode(claims, signer, algorithm="RS256", headers={"kid": kid})

    env = {"WORKLOAD_AUTH": "workload_identity", "WORKLOAD_IDENTITY_ISSUER": ISSUER, "WORKLOAD_IDENTITY_AUDIENCE": AUDIENCE,
           "WORKLOAD_IDENTITY_JWKS_FILE": str(jwks), "WORKLOAD_IDENTITIES": IDENTITIES}
    return mint, env


def test_maps_a_verified_token_to_the_logical_caller(issuer):
    mint, env = issuer
    verifier = CallerVerifier({"capability-gateway": "SKILL_HOST_AUTH_TOKEN"}, env)
    assert verifier.caller(f"Bearer {mint()}") == "capability-gateway"


def test_refuses_other_services_issuers_audiences_keys_and_expired_tokens(issuer):
    mint, env = issuer
    verifier = CallerVerifier({"capability-gateway": "SKILL_HOST_AUTH_TOKEN"}, env)
    # A real platform service that is not the gateway is still not allowed to call the host.
    assert verifier.caller(f"Bearer {mint('system:serviceaccount:ehf:runtime-host')}") is None
    assert verifier.caller(f"Bearer {mint(audience='other')}") is None
    assert verifier.caller(f"Bearer {mint(iss='https://evil.example.test')}") is None
    assert verifier.caller(f"Bearer {mint(exp=int(time.time()) - 60)}") is None
    stranger = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    assert verifier.caller(f"Bearer {mint(signer=stranger)}") is None
    assert verifier.caller(f"Bearer {jwt.encode({'sub': GATEWAY_SUBJECT, 'aud': AUDIENCE, 'iss': ISSUER, 'exp': int(time.time()) + 60}, 'x' * 32, algorithm='HS256')}") is None
    assert verifier.caller(None) is None and verifier.caller("Basic abc") is None


def test_accepts_ec_keys_from_the_issuer(tmp_path):
    key = ec.generate_private_key(ec.SECP256R1())
    jwk = json.loads(ECAlgorithm.to_jwk(key.public_key()))
    jwk.update(kid="ec1", alg="ES256")
    (tmp_path / "jwks.json").write_text(json.dumps({"keys": [jwk]}))
    env = {"WORKLOAD_AUTH": "workload_identity", "WORKLOAD_IDENTITY_ISSUER": ISSUER, "WORKLOAD_IDENTITY_AUDIENCE": AUDIENCE,
           "WORKLOAD_IDENTITY_JWKS_FILE": str(tmp_path / "jwks.json"), "WORKLOAD_IDENTITIES": IDENTITIES}
    token = jwt.encode({"sub": GATEWAY_SUBJECT, "aud": AUDIENCE, "iss": ISSUER, "exp": int(time.time()) + 60}, key, algorithm="ES256", headers={"kid": "ec1"})
    assert CallerVerifier({"capability-gateway": "X"}, env).caller(f"Bearer {token}") == "capability-gateway"


def test_discovers_keys_from_the_issuer(issuer, tmp_path):
    mint, env = issuer
    jwks = json.loads(open(env.pop("WORKLOAD_IDENTITY_JWKS_FILE")).read())
    calls = []

    def fetch(url):
        calls.append(url)
        if url.endswith("/.well-known/openid-configuration"):
            return {"issuer": ISSUER, "jwks_uri": f"{ISSUER}/openid/v1/jwks"}
        return jwks

    verifier = CallerVerifier({"capability-gateway": "X"}, env, fetch=fetch)
    assert verifier.caller(f"Bearer {mint()}") == "capability-gateway"
    assert calls == [f"{ISSUER}/.well-known/openid-configuration", f"{ISSUER}/openid/v1/jwks"]


def test_configuration_is_refused_rather_than_degraded(issuer):
    _, env = issuer
    with pytest.raises(WorkloadIdentityError, match="production_forbids:WORKLOAD_AUTH=static_token"):
        CallerVerifier({"capability-gateway": "T"}, {"SECURITY_PROFILE": "production", "WORKLOAD_AUTH": "static_token", "T": "x" * 32})
    with pytest.raises(WorkloadIdentityError, match="production_requires:WORKLOAD_AUTH"):
        CallerVerifier({"capability-gateway": "T"}, {"SECURITY_PROFILE": "production"})
    with pytest.raises(WorkloadIdentityError, match="setting_unsupported"):
        CallerVerifier({"capability-gateway": "T"}, {"WORKLOAD_AUTH": "azure_managed_identity"})
    with pytest.raises(WorkloadIdentityError, match="not_distinct"):
        CallerVerifier({"capability-gateway": "T"}, {**env, "WORKLOAD_IDENTITIES": json.dumps({"capability-gateway": "a", "harness-runtime": "a"})})
    with pytest.raises(WorkloadIdentityError, match="config_missing:WORKLOAD_IDENTITY_AUDIENCE"):
        CallerVerifier({"capability-gateway": "T"}, {k: v for k, v in env.items() if k != "WORKLOAD_IDENTITY_AUDIENCE"})


def test_outbound_token_is_the_projected_file_and_follows_rotation(tmp_path):
    path = tmp_path / "token"
    path.write_text("projected-1\n")
    token = OutboundToken("SKILL_HOST_GATEWAY_TOKEN", {"WORKLOAD_AUTH": "workload_identity", "WORKLOAD_TOKEN_FILE": str(path)})
    assert token() == "projected-1"
    assert OutboundToken("SKILL_HOST_GATEWAY_TOKEN", {"SKILL_HOST_GATEWAY_TOKEN": "dev-token"})() == "dev-token"
    with pytest.raises(WorkloadIdentityError, match="config_missing:WORKLOAD_TOKEN_FILE"):
        OutboundToken("SKILL_HOST_GATEWAY_TOKEN", {"WORKLOAD_AUTH": "workload_identity"})


def test_skill_host_admits_only_the_gateways_workload_identity(issuer):
    mint, env = issuer
    host = SkillHost(verifier=CallerVerifier({"capability-gateway": "SKILL_HOST_AUTH_TOKEN"}, env), gateway_token=lambda: "projected")
    assert host.authorized(f"Bearer {mint()}")
    assert not host.authorized(f"Bearer {mint('system:serviceaccount:ehf:runtime-host')}")
    assert host.gateway_token() == "projected"
