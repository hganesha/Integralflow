"""Catalog answers from route outputs: model field candidates (Route A) and adjudication results.

A provider model (for example Azure Document Intelligence prebuilt-idDocument) reports field values
in its own coordinates. `answer_from_model_fields` turns its provider-neutral candidates
(`document.model_fields.v1`, made by `packages/adapters`) into a catalog extraction result on the same
page text every other route reads, so `validate_extraction` and the adjudicator treat it like any
answer. Each value is re-anchored: its printed text (or its value) must occur exactly on a page. A
value that cannot be found there gets status `ambiguous` with a note and no value, never an invented
span.

`answer_from_adjudication` is the adjudicated answer: each leaf's selected value with the selected
route's spans, and nothing where adjudication selected no value. It is what an adjudicated route
proposes, and it is scored like any route.
"""
from __future__ import annotations

from typing import Any

from .fields import FIELDS, OBJECTS
from .model import ExtractionResult
from .profiles import PROFILES
from .runtime import _leaves, contract, source_digest

MODEL_FIELDS_CONTRACT = "document.model_fields.v1"


def _is_leaf(pointer: str) -> bool:
    parts = pointer.removeprefix("/extracted_fields/").split("/")
    if not pointer.startswith("/extracted_fields/") or parts[0] not in FIELDS:
        return False
    kind = FIELDS[parts[0]].value_type
    if len(parts) == 1:
        return kind not in OBJECTS and not kind.startswith("[")
    if kind.startswith("[") and kind[1:-1] in OBJECTS:
        member = OBJECTS[kind[1:-1]].get(parts[2]) if len(parts) == 3 and parts[1].isdigit() else None
        return member is not None and member not in OBJECTS and not member.startswith("[") and member != "texts"
    return kind in OBJECTS and len(parts) == 2 and OBJECTS[kind].get(parts[1]) not in (None, *OBJECTS)


def _set(fields: dict, pointer: str, value) -> bool:
    """Set a leaf by its catalog pointer, creating rows and objects with every member null. False if the pointer is not a leaf."""
    parts = pointer.removeprefix("/extracted_fields/").split("/")
    name = parts[0]
    if name not in fields:
        return False
    kind = FIELDS[name].value_type
    if len(parts) == 1:
        if kind in OBJECTS or kind.startswith("["):
            return False
        fields[name] = value
        return True
    if kind.startswith("[") and kind[1:-1] in OBJECTS and len(parts) == 3 and parts[1].isdigit():
        row_kind = kind[1:-1]
        if parts[2] not in OBJECTS[row_kind] or OBJECTS[row_kind][parts[2]] in OBJECTS or OBJECTS[row_kind][parts[2]].startswith("["):
            return False
        rows = fields[name] or []
        while len(rows) <= int(parts[1]):
            rows.append({member: None for member in OBJECTS[row_kind]})
        rows[int(parts[1])][parts[2]] = value
        fields[name] = rows
        return True
    if kind in OBJECTS and len(parts) == 2 and parts[1] in OBJECTS[kind] and OBJECTS[kind][parts[1]] not in OBJECTS:
        member_kind = OBJECTS[kind][parts[1]]
        obj = fields[name] or {member: None for member in OBJECTS[kind]}
        obj[parts[1]] = [value] if member_kind == "texts" else value
        fields[name] = obj
        return True
    return False


def _locate(pages: list[dict], needles: list[str]) -> dict | None:
    for needle in needles:
        if not needle:
            continue
        for page in pages:
            start = page["text"].find(needle)
            if start >= 0:
                return {"page_id": page["page_id"], "start": start, "end": start + len(needle), "quote": needle}
    return None


def _answer(document_type: str, pages: list[dict], fields: dict, observations: dict[str, dict]) -> dict:
    out = []
    for name in PROFILES[document_type].field_names:
        for path, value, _ in _leaves(fields[name], FIELDS[name].value_type, "/extracted_fields/" + name):
            if path in observations and (value is not None or observations[path]["status"] != "present"):
                out.append({"path": path, **observations[path]})
            else:
                out.append({"path": path, "status": "not_present", "confidence": None, "spans": [], "note": None})
    result = {"document_type": document_type, "profile_version": PROFILES[document_type].version,
              "contract_hash": contract(document_type)["contract_hash"], "document_version": pages[0]["document_version"],
              "source_digest": source_digest(pages), "extracted_fields": fields, "observations": out}
    ExtractionResult.model_validate(result, strict=False)
    return result


def answer_from_model_fields(document_type: str, pages: list[dict], model_fields: dict) -> tuple[dict, dict]:
    """A catalog answer from `document.model_fields.v1` candidates, and a report of what was anchored or dropped."""
    if model_fields.get("contract") != MODEL_FIELDS_CONTRACT or model_fields.get("document_type") != document_type:
        raise ValueError("model fields must be document.model_fields.v1 for this document type")
    fields: dict[str, Any] = {name: None for name in PROFILES[document_type].field_names}
    observations: dict[str, dict] = {}
    report = {"anchored": [], "unanchored": [], "unmapped": []}
    for candidate in model_fields.get("fields", []):
        pointer, value = candidate.get("path", ""), candidate.get("value")
        if not isinstance(value, str) or not value:
            continue
        if pointer.removeprefix("/extracted_fields/").split("/")[0] not in fields or not _is_leaf(pointer):
            report["unmapped"].append(pointer)
            continue
        printed = candidate.get("content") if isinstance(candidate.get("content"), str) else None
        span = _locate(pages, [value, printed, " ".join(printed.split()) if printed else None])
        confidence = candidate.get("confidence") if isinstance(candidate.get("confidence"), (int, float)) else None
        if span is None:
            _set(fields, pointer, None)
            observations[pointer] = {"status": "ambiguous", "confidence": confidence, "spans": [],
                                     "note": f"The provider read a value that does not occur in the page text ({candidate.get('transform') or 'as read'})."}
            report["unanchored"].append(pointer)
            continue
        _set(fields, pointer, value)
        observations[pointer] = {"status": "present", "confidence": confidence, "spans": [span], "note": None}
        report["anchored"].append(pointer)
    return _answer(document_type, pages, fields, observations), report


def answer_from_adjudication(document_type: str, pages: list[dict], adjudication: dict) -> dict:
    """The adjudicated answer: selected values with their spans; nothing where no value was selected."""
    fields: dict[str, Any] = {name: None for name in PROFILES[document_type].field_names}
    observations: dict[str, dict] = {}
    for outcome in adjudication["outcomes"]:
        selected = outcome.get("selected")
        if not selected or selected.get("value") is None:
            continue
        candidate = outcome["candidates"][selected["route"]]
        pointer = candidate.get("pointer") or "/extracted_fields/" + outcome["path"]
        # Rows are renumbered in adjudication order so every selected leaf of one row stays together.
        parts = outcome["path"].split("/")
        target = "/extracted_fields/" + outcome["path"] if len(parts) == 3 and parts[1].isdigit() else pointer
        if _set(fields, target, selected["value"]):
            observations[target] = {"status": "present", "confidence": candidate.get("confidence"), "spans": selected["spans"], "note": None}
    return _answer(document_type, pages, fields, observations)
