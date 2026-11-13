import copy
import threading
from http.server import ThreadingHTTPServer
from types import SimpleNamespace

import httpx
import pytest

from financial_crime import synthetic as f
from kyc_document_studio import prepare, evaluate
from kyc_document_studio.__main__ import make_handler
from kyc_documents.profiles import PROFILES


def sample():
    page = f.make_record("DocumentPage", "page-1", {"text": "📄 " + f.PAGE_TEXT, "page": 1, "document_version": "a" * 64})
    pages, response = f.document_fields_extraction([page])
    return {"documentType": "certificate_of_incorporation", "pages": pages, "response": response}


def test_every_builtin_type_can_prepare_a_studio_contract():
    body = sample()
    for identifier in PROFILES:
        result = prepare({**body, "documentType": identifier})
        assert result["request"]["document_type"] == identifier
        assert result["request"]["pages"] == body["pages"]
        assert result["request"]["source_digest"]


async def test_studio_uses_wrapper_validation_and_preserves_unicode_citations():
    result = await evaluate(sample())
    assert result["validation"]["valid"]
    assert result["extraction"]["promotion_allowed"] is False
    assert result["classification"]["classifications"][0]["document_type"] == "certificate_of_incorporation"
    for assertion in result["validation"]["candidate_assertions"]:
        for span in assertion["source_spans"]:
            assert sample()["pages"][0]["text"][span["start"]:span["end"]] == span["quote"]


async def test_fabricated_citation_returns_issues_and_no_assertions():
    body = sample()
    body["response"]["observations"][0]["spans"][0]["quote"] = "Fabricated quote"
    result = await evaluate(body)
    assert result["validation"]["valid"] is False
    assert result["validation"]["candidate_assertions"] == []
    assert result["extraction"] is None
    assert "SOURCE_SPAN_MISMATCH" in {issue["code"] for issue in result["validation"]["issues"]}


async def test_selected_contract_does_not_override_automatic_classification():
    body = sample()
    body["pages"][0]["text"] = "Unrecognizable sample"
    result = prepare(body)
    assert result["classification"]["classifications"][0]["document_type"] == "UNKNOWN"
    assert result["request"]["document_type"] == "certificate_of_incorporation"


@pytest.mark.parametrize("change", ["hash", "version"])
async def test_wrong_source_binding_produces_no_assertions(change):
    body = copy.deepcopy(sample())
    body["response"]["source_digest" if change == "hash" else "document_version"] = "b" * 64
    result = await evaluate(body)
    assert result["validation"]["candidate_assertions"] == []
    assert result["validation"]["valid"] is False


def test_studio_http_helpers_require_authentication_and_evaluate_the_same_source():
    host = SimpleNamespace(authorized=lambda value: value == "Bearer studio-service-test-token")
    server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(host))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with httpx.Client(base_url=f"http://127.0.0.1:{server.server_port}") as client:
            assert client.post("/v1/document-studio/prepare", json=sample()).status_code == 401
            headers = {"authorization": "Bearer studio-service-test-token"}
            result = client.post("/v1/document-studio/prepare", json=sample(), headers=headers)
            assert result.status_code == 200
            assert result.json()["request"]["pages"] == sample()["pages"]
            result = client.post("/v1/document-studio/evaluate", json=sample(), headers=headers)
            assert result.status_code == 200
            assert result.json()["validation"]["valid"] is True
            assert client.post("/v1/document-studio/evaluate", json={}, headers=headers).status_code == 400
    finally:
        server.shutdown()
        server.server_close()
        thread.join()
