"""Azure custom-model training files from catalog gold labels."""
import pytest

from document_factory.azure_training import catalog_pointer, fields_json, label_name, labels_json
from document_factory.synthetic import generate


def layout_from(pages, width=8.5, height=11.0):
    """An Azure-shaped analyzeResult: one word per whitespace token, laid out in rows."""
    out = []
    for number, page in enumerate(pages, start=1):
        words = []
        for index, token in enumerate(page["text"].split()):
            x, y = 0.5 + (index % 8) * 0.9, 0.5 + (index // 8) * 0.3
            words.append({"content": token, "polygon": [x, y, x + 0.8, y, x + 0.8, y + 0.2, x, y + 0.2], "confidence": 0.99})
        out.append({"pageNumber": number, "width": width, "height": height, "unit": "inch", "words": words})
    return {"apiVersion": "2024-11-30", "modelId": "prebuilt-layout", "pages": out}


def sample(document_type):
    _, _, label = generate(document_type, 0)
    pages = [p.model_dump(mode="json") for p in label.pages]
    return label.result.model_dump(mode="json"), pages


def test_fields_follow_the_catalog_contract():
    schema = fields_json("bank_statement")
    keys = {f["fieldKey"]: f for f in schema["fields"]}
    assert keys["accounts"] == {"fieldKey": "accounts", "fieldType": "array", "fieldFormat": "not-specified", "itemType": "Account"}
    assert {"account_identifier", "closing_balance"} <= {c["fieldKey"] for c in schema["definitions"]["Account"]["fields"]}
    assert keys["subject_address__locality"]["fieldType"] == "string" and "subject_address" not in keys
    assert all(f["fieldType"] in ("string", "array") for f in schema["fields"])


@pytest.mark.parametrize("pointer, label", [
    ("/extracted_fields/issue_date", "issue_date"),
    ("/extracted_fields/subject_address/locality", "subject_address__locality"),
    ("/extracted_fields/accounts/0/account_identifier", "accounts/0/account_identifier"),
])
def test_labels_and_pointers_are_inverse(pointer, label):
    assert label_name("bank_statement", pointer) == label
    assert catalog_pointer("bank_statement", label) == pointer


def test_untrained_and_unknown_pointers_are_refused():
    assert label_name("bank_statement", "/extracted_fields/not_a_field") is None
    assert label_name("bank_statement", "/extracted_fields/accounts/x/account_identifier") is None
    assert label_name("bank_statement", "/extracted_fields/subject_address/nowhere") is None


def test_every_present_gold_value_is_labelled_on_the_layout_words():
    gold, pages = sample("passport")
    labels, report = labels_json("passport", "sample.pdf", gold, pages, layout_from(pages))
    assert labels["document"] == "sample.pdf" and labels["$schema"].endswith("labels.json")
    present = [o["path"] for o in gold["observations"] if o["status"] == "present" and o["spans"]]
    assert sorted(report["labelled"]) == sorted(present) and not report["not_found"]
    entry = next(l for l in labels["labels"] if l["label"] == "document_number")
    assert entry["value"][0]["text"] == gold["extracted_fields"]["document_number"]
    box = entry["value"][0]["boundingBoxes"][0]
    assert len(box) == 8 and all(0 <= v <= 1 for v in box)


def test_table_rows_are_labelled_by_row_and_column():
    gold, pages = sample("bank_statement")
    labels, report = labels_json("bank_statement", "s.pdf", gold, pages, layout_from(pages))
    names = {l["label"] for l in labels["labels"]}
    assert "accounts/0/account_identifier" in names
    assert not report["not_found"]


def test_a_quote_missing_from_the_ocr_is_reported_not_guessed():
    gold, pages = sample("passport")
    ocr = layout_from([{**p, "text": p["text"].replace(gold["extracted_fields"]["document_number"], "XXXX")} for p in pages])
    labels, report = labels_json("passport", "s.pdf", gold, pages, ocr)
    assert "/extracted_fields/document_number" in report["not_found"]
    assert "document_number" not in {l["label"] for l in labels["labels"]}
