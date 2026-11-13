"""Small, closed contracts shared by field authoring and extraction validation."""
from __future__ import annotations

import hashlib
import json
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, JsonValue

from . import CATALOG_VERSION


def fingerprint(value) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False,
                                     separators=(",", ":"), allow_nan=False).encode()).hexdigest()


class ClosedModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)


class ContextTarget(ClosedModel):
    object_type: str
    field_path: str
    condition: str
    mode: Literal["candidate_assertion_only"] = "candidate_assertion_only"
    # Catalog-only scoping: the target applies to these document types (empty: every type with the
    # field). Contracts and skill outputs carry only the targets that apply, without this key.
    document_types: tuple[str, ...] = ()


class FieldDefinition(ClosedModel):
    name: str = Field(pattern=r"^[a-z][a-z0-9_]*$")
    description: str = Field(min_length=20)
    value_type: str
    section: str
    sensitivity: Literal["internal", "personal", "restricted"]
    normalization: str
    context_targets: tuple[ContextTarget, ...] = ()


class DocumentProfile(ClosedModel):
    id: str = Field(pattern=r"^[a-z][a-z0-9_]*$")
    display_name: str
    version: str = CATALOG_VERSION
    family: str
    coverage: tuple[str, ...]
    field_names: tuple[str, ...]
    key_fields: tuple[str, ...]
    aliases: tuple[str, ...] = ()
    use_cases: tuple[str, ...]
    origins: tuple[Literal["customer", "independent", "institution"], ...]
    artifact_kind: Literal["document", "structured_record", "credential", "media_assessment"] = "document"
    extraction_notes: str
    sources: tuple[str, ...] = ("conversation:kyc-document-universe-2026-11-07",)
    maturity: Literal["draft_field_contract"] = "draft_field_contract"


class SourcePage(ClosedModel):
    page_id: str = Field(min_length=1)
    document_version: str = Field(min_length=1)
    text: str


class SourceSpan(ClosedModel):
    page_id: str = Field(min_length=1)
    start: int = Field(ge=0)
    end: int = Field(gt=0)
    quote: str = Field(min_length=1)


class Observation(ClosedModel):
    path: str = Field(pattern=r"^/extracted_fields/")
    status: Literal["present", "not_present", "illegible", "redacted", "ambiguous", "not_applicable"]
    confidence: float | None = Field(ge=0, le=1)
    spans: tuple[SourceSpan, ...]
    note: str | None


class ExtractionResult(ClosedModel):
    document_type: str
    profile_version: str
    contract_hash: str = Field(pattern=r"^[a-f0-9]{64}$")
    document_version: str
    source_digest: str = Field(pattern=r"^[a-f0-9]{64}$")
    extracted_fields: dict[str, JsonValue]
    observations: tuple[Observation, ...]


class ConfidencePolicy(ClosedModel):
    """An explicitly supplied, evaluator-qualified policy; there is no default cutoff."""
    policy_id: str = Field(min_length=1)
    qualification_ref: str = Field(min_length=1)
    thresholds: dict[str, Annotated[float, Field(ge=0, le=1, allow_inf_nan=False)]]
