"""Azure analyze results as catalog field candidates (`document.model_fields.v1`) for evaluation in the Factory worker.

Two kinds of model are evaluated:

* **Prebuilt** models, through the platform's field maps (`packages/adapters/src/azure-prebuilt-routes.json`, the
  one source the gateway adapter also reads).
* **Custom** models the Factory trained, whose field names are catalog label names (`document_factory.azure_training`),
  so each maps straight back to its catalog pointer.

Candidates are then anchored on the page text by `kyc_documents.route_answers`, exactly as Route A is in production.
"""
from __future__ import annotations

import json
import os
import re
from functools import lru_cache
from pathlib import Path

from .azure_training import catalog_pointer

ROUTES_FILE = "packages/adapters/src/azure-prebuilt-routes.json"


@lru_cache(maxsize=1)
def prebuilt_routes() -> dict:
    if routes := os.environ.get("FACTORY_PREBUILT_ROUTES_JSON"):
        return json.loads(routes)["routes"]
    explicit = os.environ.get("FACTORY_PREBUILT_ROUTES_PATH")
    candidates = [Path(explicit)] if explicit else [parent / ROUTES_FILE for parent in Path(__file__).resolve().parents]
    for path in candidates:
        if path.is_file():
            return json.loads(path.read_text())["routes"]
    raise FileNotFoundError("azure-prebuilt-routes.json not found; set FACTORY_PREBUILT_ROUTES_PATH")


def _value(field: dict | None, kind: str | None = None) -> tuple[str, str | None] | None:
    if not isinstance(field, dict):
        return None
    content = field.get("content") if isinstance(field.get("content"), str) else None
    if kind == "date":
        out = field.get("valueDate")
    elif kind == "decimal":
        printed = re.sub(r"[^\d.\-]", "", content or "")
        out = printed if re.fullmatch(r"-?(?:0|[1-9]\d*)(?:\.\d+)?", printed) else (str(field["valueNumber"]) if isinstance(field.get("valueNumber"), (int, float)) else None)
    else:
        out = field.get("valueString") if isinstance(field.get("valueString"), str) else content
    return (out.strip(), content) if isinstance(out, str) and out.strip() else None


def _page(field: dict | None) -> int | None:
    regions = (field or {}).get("boundingRegions") or []
    page = regions[0].get("pageNumber") if regions else None
    return page if isinstance(page, int) and page > 0 else None


def _confidence(field: dict | None) -> float | None:
    value = (field or {}).get("confidence")
    return value if isinstance(value, (int, float)) and 0 <= value <= 1 else None


def _candidate(path, read, field, provider_field, transform=None):
    return {"path": path, "value": read[0], "content": read[1], "confidence": _confidence(field), "page": _page(field), "transform": transform, "provider_field": provider_field}


def _envelope(result: dict, document_type: str, sha256: str, fields: list[dict], model: str) -> dict:
    document = (result.get("documents") or [{}])[0]
    return {"contract": "document.model_fields.v1", "provider": "azure_document_intelligence", "model": result.get("modelId") or model,
            "model_version": result.get("apiVersion"), "document_type": document_type, "source_sha256": sha256,
            "provider_document_type": document.get("docType"), "provider_document_confidence": _confidence(document), "fields": fields}


def from_prebuilt(result: dict, document_type: str, sha256: str) -> dict:
    """The same mapping as the gateway's `modelFieldsFromAzure`, from the shared route file."""
    route = prebuilt_routes().get(document_type)
    if route is None:
        raise ValueError(f"no prebuilt route for {document_type}")
    fields = ((result.get("documents") or [{}])[0].get("fields")) or {}
    out, seen = [], set()

    def add(path, field, mapping, provider_field):
        read = _value(field, mapping.get("kind"))
        if read and path not in seen:
            seen.add(path)
            out.append(_candidate(path, read, field, provider_field))

    for mapping in route["fields"]:
        add(f"/extracted_fields/{mapping['to']}", fields.get(mapping["from"]), mapping, mapping["from"])
    given, family = _value(fields.get("FirstName")), _value(fields.get("LastName"))
    if document_type in ("passport", "national_identity_card") and given and family:
        confidence = min(_confidence(fields.get("FirstName")) or 1, _confidence(fields.get("LastName")) or 1)
        out.append({"path": "/extracted_fields/person_name", "value": f"{given[0]} {family[0]}", "content": None, "confidence": confidence,
                    "page": _page(fields.get("FirstName")), "transform": "join_given_family", "provider_field": "FirstName+LastName"})
    rows = route.get("rows")
    if rows:
        for index, row in enumerate(((fields.get(rows["from"]) or {}).get("valueArray") or [])[:200]):
            members = (row or {}).get("valueObject") or {}
            for mapping in rows["members"]:
                add(f"/extracted_fields/{rows['to']}/{index}/{mapping['to']}", members.get(mapping["from"]), mapping, f"{rows['from']}.{mapping['from']}")
            for source, target in (("AccountHolderName", "holder_name"), ("BankName", "institution_name")):
                if _value(fields.get(source)):
                    add(f"/extracted_fields/{rows['to']}/{index}/{target}", fields.get(source), {}, source)
    return _envelope(result, document_type, sha256, out, route["model"])


def from_custom(result: dict, document_type: str, sha256: str) -> dict:
    """A Factory-trained model's fields, named by catalog labels, back to catalog pointers."""
    fields = ((result.get("documents") or [{}])[0].get("fields")) or {}
    out = []
    for key, field in fields.items():
        if not isinstance(field, dict):
            continue
        if field.get("type") == "array":
            for index, item in enumerate((field.get("valueArray") or [])[:200]):
                for column, cell in ((item or {}).get("valueObject") or {}).items():
                    pointer = catalog_pointer(document_type, f"{key}/{index}/{column}")
                    read = _value(cell)
                    if pointer and read:
                        out.append(_candidate(pointer, read, cell, f"{key}/{index}/{column}"))
            continue
        pointer, read = catalog_pointer(document_type, key), _value(field)
        if pointer and read:
            out.append(_candidate(pointer, read, field, key))
    return _envelope(result, document_type, sha256, out, "custom")
