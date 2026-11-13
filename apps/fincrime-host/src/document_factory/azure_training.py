"""Training data for Azure Document Intelligence custom models, written from catalog gold labels (plan §7.2 step 3).

Azure trains a custom extraction model from, per document, the original file, its layout result
(`<file>.ocr.json`) and its labels (`<file>.labels.json`), plus one `fields.json` per training folder. The
field names come from the catalog contract, so labels and contracts cannot drift:

| Catalog field | Azure field | Label name |
| --- | --- | --- |
| scalar (`text`, `identifier`, `date`, ...) | `string` | `issue_date` |
| object (`Address`) | one `string` per part | `subject_address__locality` |
| list of strings (`texts`) | dynamic table, column `value` | `nationalities/0/value` |
| list of rows (`[Account]`) | dynamic table, one `string` column per row field | `accounts/0/account_identifier` |

Inside a row, an object part is flattened the same way (`parties/0/address__locality`) and a list of strings is
labelled as one value over all its regions. Every value is a string: the catalog normalizes values itself, and
Route A anchors each value on the page text (`kyc_documents.route_answers`).

Gold spans are offsets into the canonical page text, which need not be Azure's OCR text. Each quote is found again
among the layout's words, page by page, as a run of words with the same text; a quote that cannot be found is
reported, never labelled with a guessed region.
"""
from __future__ import annotations

import re

from kyc_documents.fields import FIELDS, OBJECTS
from kyc_documents.profiles import PROFILES

LABELS_SCHEMA = "https://schema.cognitiveservices.azure.com/formrecognizer/2021-03-01/labels.json"
FIELDS_SCHEMA = "https://schema.cognitiveservices.azure.com/formrecognizer/2021-03-01/fields.json"
SCALARS = {"text", "identifier", "date", "datetime", "decimal", "percentage", "integer", "boolean"}
TRAILING = ".,;:)(%£$€\"'"


def _row_type(value_type: str) -> str | None:
    return value_type[1:-1] if value_type.startswith("[") and value_type[1:-1] in OBJECTS else None


def _columns(object_type: str) -> list[str]:
    """A row's columns: scalars and string lists as they are, object parts as `part__sub`."""
    out = []
    for name, kind in OBJECTS[object_type].items():
        if kind in OBJECTS:
            out.extend(f"{name}__{sub}" for sub in OBJECTS[kind])
        else:
            out.append(name)
    return out


def fields_json(document_type: str) -> dict:
    """`fields.json` for one catalog type."""
    fields, definitions = [], {}
    for name in PROFILES[document_type].field_names:
        kind = FIELDS[name].value_type
        row = _row_type(kind)
        if row:
            definitions[row] = {"fieldKey": row, "fieldType": "object", "fieldFormat": "not-specified",
                                "itemType": None, "fields": [{"fieldKey": c, "fieldType": "string", "fieldFormat": "not-specified"} for c in _columns(row)]}
            fields.append({"fieldKey": name, "fieldType": "array", "fieldFormat": "not-specified", "itemType": row})
        elif kind == "texts":
            definitions["TextItem"] = {"fieldKey": "TextItem", "fieldType": "object", "fieldFormat": "not-specified", "itemType": None,
                                       "fields": [{"fieldKey": "value", "fieldType": "string", "fieldFormat": "not-specified"}]}
            fields.append({"fieldKey": name, "fieldType": "array", "fieldFormat": "not-specified", "itemType": "TextItem"})
        elif kind in OBJECTS:
            fields.extend({"fieldKey": f"{name}__{sub}", "fieldType": "string", "fieldFormat": "not-specified"} for sub in OBJECTS[kind])
        else:
            fields.append({"fieldKey": name, "fieldType": "string", "fieldFormat": "not-specified"})
    return {"$schema": FIELDS_SCHEMA, "fields": fields, "definitions": dict(sorted(definitions.items()))}


def label_name(document_type: str, pointer: str) -> str | None:
    """The Azure label for a catalog leaf pointer, or None when the leaf is not trained."""
    parts = pointer.removeprefix("/extracted_fields/").split("/")
    field = parts[0]
    if field not in PROFILES[document_type].field_names:
        return None
    kind = FIELDS[field].value_type
    row = _row_type(kind)
    if row:
        if len(parts) < 3 or not parts[1].isdigit():
            return None
        column, rest = parts[2], parts[3:]
        member = OBJECTS[row].get(column)
        if member in OBJECTS:
            return f"{field}/{parts[1]}/{column}__{rest[0]}" if rest and rest[0] in OBJECTS[member] else None
        return f"{field}/{parts[1]}/{column}" if member is not None else None
    if kind == "texts":
        return f"{field}/{parts[1]}/value" if len(parts) == 2 and parts[1].isdigit() else None
    if kind in OBJECTS:
        return f"{field}__{parts[1]}" if len(parts) >= 2 and parts[1] in OBJECTS[kind] else None
    return field if len(parts) == 1 else None


def catalog_pointer(document_type: str, label: str) -> str | None:
    """The catalog pointer a trained label stands for (the inverse of `label_name` for scalar leaves)."""
    parts = label.split("/")
    field = parts[0].split("__")[0]
    if field not in PROFILES[document_type].field_names:
        return None
    if len(parts) == 1:
        head, _, sub = parts[0].partition("__")
        return f"/extracted_fields/{head}/{sub}" if sub else f"/extracted_fields/{head}"
    if len(parts) == 3 and parts[1].isdigit():
        column, _, sub = parts[2].partition("__")
        if column == "value" and FIELDS[field].value_type == "texts":
            return f"/extracted_fields/{field}/{parts[1]}"
        return f"/extracted_fields/{field}/{parts[1]}/{column}" + (f"/{sub}" if sub else "")
    return None


def _words(layout: dict) -> dict[int, list[dict]]:
    return {page["pageNumber"]: page.get("words", []) for page in layout.get("pages", [])}


def _norm(token: str) -> str:
    return token.strip(TRAILING)


def _find(words: list[dict], tokens: list[str]) -> list[dict] | None:
    """The first run of words whose text equals the quote's tokens (exactly, then ignoring edge punctuation)."""
    if not tokens:
        return None
    for compare in (lambda a, b: a == b, lambda a, b: _norm(a) == _norm(b) and _norm(b) != ""):
        for start in range(len(words) - len(tokens) + 1):
            if all(compare(words[start + k]["content"], tokens[k]) for k in range(len(tokens))):
                return words[start:start + len(tokens)]
    return None


def _box(word: dict, page: dict) -> list[float]:
    width, height = page["width"], page["height"]
    polygon = word["polygon"]
    return [round(v / (width if i % 2 == 0 else height), 6) for i, v in enumerate(polygon)]


def labels_json(document_type: str, filename: str, gold: dict, gold_pages: list[dict], layout: dict) -> tuple[dict, dict]:
    """`<file>.labels.json` for one gold-labelled document and its Azure layout result, with a report.

    `gold` is the catalog extraction result; `gold_pages` its source pages, in page order. `layout` is Azure's
    `analyzeResult` for the same file. The report lists labelled pointers, pointers with no trained label, and
    quotes not found among the layout's words.
    """
    pages = {p["pageNumber"]: p for p in layout.get("pages", [])}
    words = _words(layout)
    page_of = {p["page_id"]: index + 1 for index, p in enumerate(gold_pages)}
    labels: dict[str, list[dict]] = {}
    report = {"labelled": [], "untrained": [], "not_found": []}
    for observation in gold.get("observations", []):
        if observation["status"] != "present" or not observation.get("spans"):
            continue
        name = label_name(document_type, observation["path"])
        if name is None:
            report["untrained"].append(observation["path"])
            continue
        values = []
        for span in observation["spans"]:
            tokens = span["quote"].split()
            preferred = page_of.get(span["page_id"])
            order = ([preferred] if preferred in words else []) + [n for n in sorted(words) if n != preferred]
            found = next(((n, run) for n in order if (run := _find(words[n], tokens))), None)
            if found is None:
                continue
            number, run = found
            values.append({"page": number, "text": " ".join(w["content"] for w in run), "boundingBoxes": [_box(w, pages[number]) for w in run]})
        if values:
            labels.setdefault(name, []).extend(values)
            report["labelled"].append(observation["path"])
        else:
            report["not_found"].append(observation["path"])
    document = {"$schema": LABELS_SCHEMA, "document": filename,
                "labels": [{"label": name, "key": None, "value": value} for name, value in sorted(labels.items())]}
    return document, report


def ocr_json(analyze_response: dict) -> dict:
    """`<file>.ocr.json`: Azure's full prebuilt-layout response (status and analyzeResult)."""
    if analyze_response.get("status") != "succeeded" or "analyzeResult" not in analyze_response:
        raise ValueError("the layout analysis did not succeed")
    return analyze_response


SAFE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$")
