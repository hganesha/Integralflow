"""Stateless preparation: native parsing, supplied canonical layouts, and the HTTP route."""
import base64
import hashlib
import json
import threading
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

import pymupdf
import pytest

from kyc_pipeline.prepare import PrepareError, prepare
from kyc_pipeline.server import Service, make_handler

TOKEN = "test-token-0123456789"
PNG = b"\x89PNG\r\n\x1a\nsynthetic scan bytes"


def ids(data: bytes) -> tuple[str, str]:
    sha = hashlib.sha256(data).hexdigest()
    return "doc_" + sha[:24], sha


def layout_for(data: bytes, **overrides) -> dict:
    _, sha = ids(data)
    value = {
        "contract": "document.layout.v1", "provider": "azure_document_intelligence", "model": "prebuilt-layout",
        "model_version": "2024-11-30", "source_sha256": sha,
        "pages": [{"page": 1, "width": 8.5, "height": 11, "unit": "inch", "angle": 0.1, "has_text": True, "handwritten_spans": 1}],
        "blocks": [
            {"kind": "title", "page": 1, "text": "ENERGY BILL", "bbox": [1, 1, 3, 1.4], "min_word_confidence": 0.99},
            {"kind": "paragraph", "page": 1, "text": "Billing address: 57 Mock Lane,\n Fixture Bay", "bbox": [1, 2, 6, 2.4], "min_word_confidence": 0.62},
            {"kind": "table", "page": 1, "bbox": [1, 3, 7, 5], "table": {"rows": [["Item", "Amount"], ["Electricity", "85.10"]], "header_rows": 1, "merged_cells": 1}},
            {"kind": "page_footer", "page": 1, "text": "Page 1 of 1", "bbox": [1, 10.5, 7, 10.8]},
        ],
        "figures": [{"id": "1.1", "page": 1}],
    }
    value.update(overrides)
    return value


def test_native_text_is_prepared_without_storing_anything():
    data = b"SYNTHETIC PASSPORT\nName: Alex Example\n"
    document_id, sha = ids(data)
    result = prepare("case-1", "passport.txt", data, document_id, sha)
    assert result["status"] == "PREPARED" and result["layout_recommended"] is False
    assert result["documents"][0] | {} == result["documents"][0] and result["documents"][0]["parser"]["name"] == "native"
    page = result["pages"][0]
    assert page["document_id"] == document_id and "Alex Example" in page["text"] and "geometry" not in page
    for segment in page["segments"]:
        assert page["text"][segment["start"]:segment["end"]]


def test_the_version_must_be_the_bytes_and_images_need_a_layout():
    data = b"text"
    document_id, sha = ids(data)
    with pytest.raises(PrepareError) as error:
        prepare("case-1", "a.txt", data, document_id, "0" * 64)
    assert error.value.code == "DOCUMENT_VERSION_MISMATCH"
    with pytest.raises(PrepareError) as error:
        prepare("case-1", "a.txt", data, "bad-id", sha)
    assert error.value.code == "DOCUMENT_ID_INVALID"
    png_id, png_sha = ids(PNG)
    with pytest.raises(PrepareError) as error:
        prepare("case-1", "scan.png", PNG, png_id, png_sha)
    assert error.value.code == "LAYOUT_REQUIRED"


def test_an_image_only_pdf_page_recommends_layout(tmp_path):
    pdf = pymupdf.open()
    page = pdf.new_page()
    pixmap = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, 60, 60), 0)
    pixmap.clear_with(180)
    page.insert_image(pymupdf.Rect(72, 72, 400, 400), pixmap=pixmap)
    data = pdf.tobytes()
    pdf.close()
    document_id, sha = ids(data)
    result = prepare("case-1", "scan.pdf", data, document_id, sha)
    assert result["layout_recommended"] is True
    assert {"PDF_IMAGES_NOT_OCR", "PDF_PAGE_TEXT_INSUFFICIENT", "EMPTY_DOCUMENT"} & {i["code"] for i in result["issues"]}


def test_a_supplied_layout_becomes_full_pages_with_regions_in_points():
    document_id, sha = ids(PNG)
    result = prepare("case-1", "scan.png", PNG, document_id, sha, layout_for(PNG))
    document, page = result["documents"][0], result["pages"][0]
    assert document["parser"] == {"name": "layout", "contract": "document.layout.v1", "provider": "azure_document_intelligence",
                                  "model": "prebuilt-layout", "model_version": "2024-11-30", "page_count_basis": "layout_provider"}
    assert page["geometry"] == {"width": 612.0, "height": 792.0, "unit": "point", "rotation": "0", "basis": "layout_provider"}
    assert "Billing address: 57 Mock Lane,\nFixture Bay" in page["text"] and "Electricity" in page["text"]
    paragraph = next(s for s in page["segments"] if page["text"][s["start"]:s["end"]].startswith("Billing address"))
    assert paragraph["bbox"] == [72.0, 144.0, 432.0, 172.8]
    assert all(page["text"][s["start"]:s["end"]] for s in page["segments"])
    codes = {i["code"] for i in result["issues"]}
    assert {"OCR_LOW_CONFIDENCE", "HANDWRITTEN_CONTENT", "LAYOUT_FIGURE_NOT_INTERPRETED", "LAYOUT_TABLE_MERGED_CELLS"} <= codes
    assert result["layout_recommended"] is False


def test_a_rotated_page_keeps_text_but_draws_no_boxes():
    document_id, sha = ids(PNG)
    layout = layout_for(PNG, pages=[{"page": 1, "width": 1000, "height": 1400, "unit": "pixel", "angle": 7.5}])
    result = prepare("case-1", "scan.png", PNG, document_id, sha, layout)
    assert result["pages"][0]["geometry"]["rotation"] == "skewed"
    assert "LAYOUT_PAGE_ROTATED" in {i["code"] for i in result["issues"]}


@pytest.mark.parametrize("change", [
    {"source_sha256": "0" * 64},
    {"contract": "something.else"},
    {"pages": []},
    {"pages": [{"page": 2, "width": 1, "height": 1, "unit": "inch"}]},
    {"pages": [{"page": 1, "width": 1, "height": 1, "unit": "furlong"}]},
    {"blocks": [{"kind": "poem", "page": 1, "text": "x"}]},
    {"blocks": [{"kind": "paragraph", "page": 3, "text": "x"}]},
    {"blocks": [{"kind": "paragraph", "page": 1, "text": "x", "bbox": [5, 5, 1, 1]}]},
    {"blocks": [{"kind": "table", "page": 1, "table": {"rows": [[1, 2]]}}]},
])
def test_an_unusable_layout_is_refused_not_repaired(change):
    document_id, sha = ids(PNG)
    with pytest.raises(PrepareError) as error:
        prepare("case-1", "scan.png", PNG, document_id, sha, layout_for(PNG, **change))
    assert error.value.code == "LAYOUT_INVALID"


def test_a_region_outside_the_page_is_dropped_but_its_text_kept():
    document_id, sha = ids(PNG)
    layout = layout_for(PNG, blocks=[{"kind": "paragraph", "page": 1, "text": "Off the page", "bbox": [1, 1, 20, 2]}])
    segment = prepare("case-1", "scan.png", PNG, document_id, sha, layout)["pages"][0]["segments"][0]
    assert "bbox" not in segment


@pytest.fixture()
def server(tmp_path):
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(Service(tmp_path, TOKEN)))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{httpd.server_address[1]}"
    httpd.shutdown()


def call(base, path, body):
    request = urllib.request.Request(base + path, data=json.dumps(body).encode(), method="POST",
                                     headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(request) as response:
            return response.status, json.loads(response.read())
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read())


def test_the_route_prepares_and_refuses_with_codes(server, tmp_path):
    document_id, sha = ids(PNG)
    body = {"filename": "scan.png", "content_base64": base64.b64encode(PNG).decode(), "document_id": document_id, "document_version": sha}
    status, refused = call(server, "/v1/cases/case-1/documents/prepare", body)
    assert status == 422 and refused["code"] == "LAYOUT_REQUIRED"
    status, prepared = call(server, "/v1/cases/case-1/documents/prepare", {**body, "layout": layout_for(PNG)})
    assert status == 200 and prepared["pages"][0]["geometry"]["unit"] == "point"
    status, invalid = call(server, "/v1/cases/case-1/documents/prepare", {**body, "layout": layout_for(PNG, source_sha256="1" * 64)})
    assert status == 422 and invalid["code"] == "LAYOUT_INVALID"
    assert not any((tmp_path).rglob("*.png"))  # nothing was stored


def test_the_azure_adapters_canonical_layout_is_prepared():
    """Cross-language contract: packages/adapters/src/document-layout-azure.test.ts keeps this fixture current."""
    from pathlib import Path
    layout = json.loads((Path(__file__).parent / "fixtures" / "azure-layout.canonical.json").read_text())
    data = b"synthetic scanned bill"
    document_id, sha = ids(data)
    result = prepare("case-1", "bill.png", data, document_id, sha, layout)
    page = result["pages"][0]
    assert page["geometry"]["width"] == 612.0 and page["geometry"]["rotation"] == "0"
    assert "Billing address:\n57 Mock Lane" in page["text"] and "Electricity | 85.10" in page["text"]
    assert all(segment.get("bbox") for segment in page["segments"])
    assert {"OCR_LOW_CONFIDENCE", "HANDWRITTEN_CONTENT", "LAYOUT_FIGURE_NOT_INTERPRETED", "LAYOUT_TABLE_MERGED_CELLS"} <= {i["code"] for i in result["issues"]}


def test_demo_mode_marks_prepared_documents_synthetic(server, monkeypatch):
    data = b"synthetic statement text"
    document_id, sha = ids(data)
    body = {"filename": "statement.txt", "content_base64": base64.b64encode(data).decode(), "document_id": document_id, "document_version": sha}
    status, prepared = call(server, "/v1/cases/case-1/documents/prepare", body)
    assert status == 200 and not any(w.startswith("DEMO_ONLY") for w in prepared.get("warnings", []))
    monkeypatch.setenv("EVIDENCE_PIPELINE_MODE", "demo")
    status, prepared = call(server, "/v1/cases/case-1/documents/prepare", body)
    assert status == 200 and prepared["warnings"][-1].startswith("DEMO_ONLY")
