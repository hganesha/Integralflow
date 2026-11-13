"""Capability interfaces. Recorded inference is explicitly synthetic and request-bound."""
from __future__ import annotations

from typing import Protocol

from .contracts import Contract, Ref, SkillError, Status, digest
from pydantic import JsonValue, ValidationError


class ProviderResponse(Contract):
    provider_id: str
    capability: str
    request_hash: str
    payload: dict[str, JsonValue]
    evidence_refs: list[Ref]
    source_version: str
    coverage: dict[str, JsonValue]
    synthetic: bool = True

    @classmethod
    def model_json_schema(cls, *args, **kwargs):
        from .schema_types import document
        from . import payload_types
        return document("ProviderEnvelope")


class Provider(Protocol):
    provider_id: str
    async def invoke(self, capability: str, request: dict) -> ProviderResponse: ...


class RecordedProvider:
    def __init__(self, recordings: list[ProviderResponse]):
        self.recordings = {(r.capability, r.request_hash): r for r in recordings}
        provider_ids = {r.provider_id for r in recordings}
        if len(provider_ids) != 1:
            raise ValueError("one adapter must have one provider identity")
        self.provider_id = next(iter(provider_ids))

    async def invoke(self, capability, request):
        response = self.recordings.get((capability, digest(request)))
        if response is None:
            raise SkillError("SOURCE_UNAVAILABLE", "no exact request-bound provider recording", Status.NEEDS_EVIDENCE)
        return response.model_copy(deep=True)


class Router:
    def __init__(self, providers=None):
        self.providers = providers or {}
        self.calls = 0

    async def invoke(self, capability, request, *, permitted, allowed_providers):
        if capability not in permitted:
            raise SkillError("ACCESS_DENIED", "capability not admitted")
        if capability not in self.providers:
            raise SkillError("SOURCE_UNAVAILABLE", f"no provider for {capability}", Status.NEEDS_EVIDENCE)
        provider_id = getattr(self.providers[capability], "provider_id", None)
        if provider_id not in allowed_providers:
            raise SkillError("ACCESS_DENIED", "provider identity not entitled by tenant policy")
        self.calls += 1
        from .payload_types import CAPABILITY_SCHEMAS
        from .schema_types import document
        from .registry import validate
        if capability not in CAPABILITY_SCHEMAS:
            raise SkillError("ACCESS_DENIED", "capability contract unavailable")
        validate(document(CAPABILITY_SCHEMAS[capability][0]), request, "INPUT_INVALID")
        try:
            result = await self.providers[capability].invoke(capability, request)
        except ValidationError:
            raise SkillError("INTEGRITY_FAILURE", "provider response violates wire contract")
        validate(ProviderResponse.model_json_schema(), result.model_dump(mode="json"), "INTEGRITY_FAILURE")
        if result.request_hash != digest(request) or result.capability != capability or result.provider_id != provider_id:
            raise SkillError("INTEGRITY_FAILURE", "provider response does not match request")
        if not result.coverage.get("complete", False):
            raise SkillError("EVIDENCE_INSUFFICIENT", "provider coverage incomplete", Status.NEEDS_EVIDENCE)
        return result

