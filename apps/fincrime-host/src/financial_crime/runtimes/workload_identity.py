"""Service identity for the library's hosts, matching the platform's `WORKLOAD_AUTH` mechanism.

The platform gives every service exactly one identity and presents it to every service it
calls (packages/identity/src/workload.ts). This module is the Python side of the same
contract, with the same settings:

- ``WORKLOAD_AUTH=static_token`` (development): a shared bearer per calling service. Refused
  under ``SECURITY_PROFILE=production``.
- ``WORKLOAD_AUTH=workload_identity`` (production): each service presents the one token its
  platform projects for it (a Kubernetes service-account token, a SPIFFE JWT-SVID or a
  client-credentials token from any OpenID Connect issuer) and re-reads it from
  ``WORKLOAD_TOKEN_FILE`` as the platform rotates it. Callers are verified against the issuer's
  published keys (``WORKLOAD_IDENTITY_ISSUER``, ``WORKLOAD_IDENTITY_AUDIENCE``, and
  ``WORKLOAD_IDENTITY_JWKS_URI``/``WORKLOAD_IDENTITY_JWKS_FILE`` or discovery), and the verified
  subject is mapped to a logical service name through ``WORKLOAD_IDENTITIES``. What a caller may
  do is decided by the host's code, never by a claim in the token.
"""
from __future__ import annotations

import hmac
import json
import os
import threading
import time
from dataclasses import dataclass, field
from typing import Callable, Mapping

import httpx
import jwt
from jwt import PyJWK, PyJWKSet

ASYMMETRIC_ALGORITHMS = ("RS256", "RS384", "RS512", "PS256", "PS384", "PS512", "ES256", "ES384", "ES512", "EdDSA")
TOKEN_FILE_REFRESH_SECONDS = 30.0
JWKS_REFRESH_SECONDS = 300.0


class WorkloadIdentityError(Exception):
    """A configuration the host must refuse to start with."""


def workload_auth(env: Mapping[str, str]) -> str:
    production = env.get("SECURITY_PROFILE", "development") == "production"
    if env.get("SECURITY_PROFILE", "development") not in ("development", "production"):
        raise WorkloadIdentityError(f"platform.security_profile_unsupported:{env.get('SECURITY_PROFILE')}")
    value = (env.get("WORKLOAD_AUTH") or "").strip()
    if not value:
        if production:
            raise WorkloadIdentityError("platform.production_requires:WORKLOAD_AUTH")
        return "static_token"
    if value not in ("static_token", "workload_identity"):
        raise WorkloadIdentityError(f"platform.setting_unsupported:WORKLOAD_AUTH={value}")
    if production and value == "static_token":
        raise WorkloadIdentityError("platform.production_forbids:WORKLOAD_AUTH=static_token")
    return value


def _required(env: Mapping[str, str], name: str) -> str:
    value = (env.get(name) or "").strip()
    if not value:
        raise WorkloadIdentityError(f"identity.config_missing:{name}")
    return value


def _identities(env: Mapping[str, str]) -> dict[str, str]:
    try:
        parsed = json.loads(_required(env, "WORKLOAD_IDENTITIES"))
    except json.JSONDecodeError as error:
        raise WorkloadIdentityError("identity.workload_identities_invalid") from error
    if not isinstance(parsed, dict) or any(not isinstance(v, str) or not v for v in parsed.values()):
        raise WorkloadIdentityError("identity.workload_identities_invalid")
    if len(set(parsed.values())) != len(parsed):
        # Two services sharing one subject would be one identity wearing two names.
        raise WorkloadIdentityError("identity.workload_identities_not_distinct")
    return parsed


@dataclass
class _KeySource:
    """Issuer keys from a file, a JWKS URI or OIDC discovery, refreshed on an unknown key ID."""
    issuer: str
    jwks_uri: str | None = None
    jwks_file: str | None = None
    fetch: Callable[[str], dict] | None = None
    _keys: dict[str, PyJWK] = field(default_factory=dict)
    _loaded_at: float = 0.0
    _lock: threading.Lock = field(default_factory=threading.Lock)

    def _get(self, url: str) -> dict:
        if self.fetch:
            return self.fetch(url)
        response = httpx.get(url, timeout=10, follow_redirects=False)
        response.raise_for_status()
        return response.json()

    def _load(self) -> None:
        if self.jwks_file:
            with open(self.jwks_file, encoding="utf-8") as handle:
                document = json.load(handle)
        else:
            uri = self.jwks_uri
            if not uri:
                discovery = self._get(self.issuer.rstrip("/") + "/.well-known/openid-configuration")
                if discovery.get("issuer") != self.issuer or not isinstance(discovery.get("jwks_uri"), str):
                    raise WorkloadIdentityError("identity.oidc_discovery_invalid")
                uri = discovery["jwks_uri"]
            document = self._get(uri)
        keys = PyJWKSet.from_dict(document).keys
        self._keys = {key.key_id or "": key for key in keys}
        self._loaded_at = time.monotonic()

    def key(self, kid: str | None) -> PyJWK:
        with self._lock:
            stale = time.monotonic() - self._loaded_at > JWKS_REFRESH_SECONDS
            if not self._keys or stale or (kid or "") not in self._keys:
                self._load()
            if kid is None and len(self._keys) == 1:
                return next(iter(self._keys.values()))
            found = self._keys.get(kid or "")
        if found is None:
            raise jwt.InvalidTokenError("unknown key")
        return found


class CallerVerifier:
    """Decides whether a bearer belongs to one of the logical services this host accepts."""

    def __init__(self, accepted: Mapping[str, str], env: Mapping[str, str] | None = None, *,
                 fetch: Callable[[str], dict] | None = None):
        """``accepted`` maps a logical caller (``capability-gateway``) to its development token variable."""
        env = os.environ if env is None else env
        self.mode = workload_auth(env)
        if self.mode == "static_token":
            self.tokens = {name: env.get(variable, "") for name, variable in accepted.items()}
            if not any(len(token) >= 16 for token in self.tokens.values()):
                raise WorkloadIdentityError("identity.service_token_grants_missing")
            return
        self.issuer = _required(env, "WORKLOAD_IDENTITY_ISSUER")
        if not self.issuer.startswith("https://") and not self.issuer.startswith(("http://localhost", "http://127.0.0.1")):
            raise WorkloadIdentityError("identity.oidc_issuer_https_required")
        self.audience = _required(env, "WORKLOAD_IDENTITY_AUDIENCE")
        algorithms = [a.strip() for a in (env.get("WORKLOAD_IDENTITY_ALGORITHMS") or "RS256,PS256,ES256").split(",") if a.strip()]
        if any(a not in ASYMMETRIC_ALGORITHMS for a in algorithms):
            raise WorkloadIdentityError("identity.oidc_algorithm_unsupported")
        self.algorithms = algorithms
        identities = _identities(env)
        self.by_subject = {identities[name]: name for name in accepted if name in identities}
        if not self.by_subject:
            raise WorkloadIdentityError("identity.workload_identities_missing")
        self.keys = _KeySource(self.issuer, env.get("WORKLOAD_IDENTITY_JWKS_URI") or None,
                               env.get("WORKLOAD_IDENTITY_JWKS_FILE") or None, fetch)

    def caller(self, header: str | None) -> str | None:
        """The logical caller this bearer proves, or None."""
        if not header or not header.startswith("Bearer "):
            return None
        token = header[7:].strip()
        if self.mode == "static_token":
            for name, expected in self.tokens.items():
                if len(expected) >= 16 and hmac.compare_digest(token.encode(), expected.encode()):
                    return name
            return None
        try:
            kid = jwt.get_unverified_header(token).get("kid")
            claims = jwt.decode(token, self.keys.key(kid), algorithms=self.algorithms, audience=self.audience,
                                issuer=self.issuer, leeway=5, options={"require": ["exp", "iss", "aud", "sub"]})
        except (jwt.PyJWTError, WorkloadIdentityError, OSError, ValueError, httpx.HTTPError):
            return None
        return self.by_subject.get(claims.get("sub", ""))


class OutboundToken:
    """This host's one outgoing credential: the development token, or its projected token file."""

    def __init__(self, static_token_variable: str, env: Mapping[str, str] | None = None):
        env = os.environ if env is None else env
        self.mode = workload_auth(env)
        self.static = env.get(static_token_variable) or None
        self.path = _required(env, "WORKLOAD_TOKEN_FILE") if self.mode == "workload_identity" else None
        self._cached: tuple[str, float, float] | None = None
        self._lock = threading.Lock()

    def __call__(self) -> str | None:
        if self.path is None:
            return self.static
        with self._lock:
            now = time.monotonic()
            if self._cached and now - self._cached[1] < TOKEN_FILE_REFRESH_SECONDS:
                return self._cached[0]
            mtime = os.stat(self.path).st_mtime
            if self._cached and self._cached[2] == mtime:
                self._cached = (self._cached[0], now, mtime)
                return self._cached[0]
            with open(self.path, encoding="utf-8") as handle:
                token = handle.read().strip()
            if not token:
                raise WorkloadIdentityError("identity.workload_token_empty")
            self._cached = (token, now, mtime)
            return token
