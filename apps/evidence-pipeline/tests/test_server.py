"""The HTTP API EHF's gateway calls: auth, routing, ingest -> package, and refusals."""
import base64
import json
import threading
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

import pytest

from kyc_pipeline.server import Service, make_handler

TOKEN = "test-token-0123456789"
EXAMPLES = Path(__file__).resolve().parents[1] / "examples"


@pytest.fixture()
def server(tmp_path):
    service = Service(tmp_path, TOKEN)
    httpd = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(service))
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{httpd.server_address[1]}"
    httpd.shutdown()


def call(base, method, path, body=None, token=TOKEN):
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(base + path, data=data, method=method)
    if token:
        request.add_header("Authorization", f"Bearer {token}")
    if data:
        request.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(request) as response:
            return response.status, json.loads(response.read())
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read())


def test_health_is_open_and_routes_need_the_token(server):
    assert call(server, "GET", "/healthz", token=None) == (200, {"status": "ok"})
    status, body = call(server, "GET", "/v1/cases/case-1/package", token=None)
    assert (status, body["code"]) == (401, "UNAUTHORIZED")
    status, body = call(server, "GET", "/v1/cases/case-1/package", token="wrong-token-0123456789")
    assert status == 401


def test_ingest_then_package_and_ownership(server):
    content = base64.b64encode((EXAMPLES / "synthetic_shareholder_register.txt").read_bytes()).decode()
    status, result = call(server, "POST", "/v1/cases/case-1/documents",
                          {"filename": "register.txt", "content_base64": content, "profile": "ownership_control"})
    assert status == 200, result
    assert result["run_id"].startswith("run_") and result["case_id"] == "case-1"
    assert result["status"] in ("PERSISTED", "PAUSED_FOR_REVIEW")
    assert len(result["document_sha256"]) == 64
    status, package = call(server, "GET", "/v1/cases/case-1/package")
    assert status == 200 and package["documents"]
    assert package["documents"][0]["sha256"] == result["document_sha256"]
    pages = package["pages"]
    assert pages and all(p["offset_basis"] == "unicode_code_points" for p in pages)
    by_segment = {seg["segment_id"]: (page, seg) for page in pages for seg in page["segments"]}
    for evidence in package["evidence"]:
        page, segment = by_segment[evidence["segment_id"]]
        start, end = segment["start"] + evidence["start"], segment["start"] + evidence["end"]
        assert page["text"][start:end] == evidence["quote"]
    status, ownership = call(server, "GET", "/v1/cases/case-1/ownership")
    assert status == 200 and "ownership_graph" in ownership


@pytest.mark.parametrize("path,body,code", [
    ("/v1/cases/..x/documents", {"filename": "a.txt", "content_base64": "aGk="}, "CASE_ID_INVALID"),
    ("/v1/cases/c/documents", {"filename": "../a.txt", "content_base64": "aGk="}, "FILENAME_INVALID"),
    ("/v1/cases/c/documents", {"filename": "a.txt", "content_base64": "not base64!"}, "CONTENT_INVALID"),
    ("/v1/cases/c/documents", {"filename": "a.txt", "content_base64": "aGk=", "profile": "../x"}, "PROFILE_INVALID"),
    ("/v1/runs/run_x/resume", {"reviewer_id": "r", "decisions": []}, "RUN_ID_INVALID"),
    ("/v1/runs/run_" + "a" * 32 + "/resume", {"decisions": []}, "DECISION_INVALID"),
])
def test_invalid_requests_are_refused(server, path, body, code):
    status, result = call(server, "POST", path, body)
    assert status == 400 and result["code"] == code


def test_unknown_case_and_run_are_not_found(server):
    status, body = call(server, "GET", "/v1/cases/missing/package")
    assert (status, body["code"]) == (404, "NOT_FOUND")
    status, body = call(server, "POST", "/v1/runs/run_" + "b" * 32 + "/resume", {"reviewer_id": "r", "decisions": []})
    assert (status, body["code"]) == (404, "NOT_FOUND")


def test_document_pages_for_ocr_are_bound_to_the_artifact_hash(server):
    content = base64.b64encode((EXAMPLES / "synthetic_passport.txt").read_bytes()).decode()
    status, result = call(server, "POST", "/v1/cases/case-ocr/documents", {"filename": "passport.txt", "content_base64": content, "profile": "identity_verification"})
    assert status == 200
    status, package = call(server, "GET", "/v1/cases/case-ocr/package")
    document = package["documents"][0]
    status, pages = call(server, "GET", f"/v1/documents/{document['document_id']}/pages?sha256={document['sha256']}")
    assert status == 200 and [p["page"] for p in pages["pages"]] == [1]
    assert pages["pages"][0]["text"] == package["pages"][0]["text"] and pages["parser"]["name"].startswith("kyc-evidence-pipeline:")
    status, body = call(server, "GET", f"/v1/documents/{document['document_id']}/pages?sha256={'0' * 64}")
    assert (status, body["code"]) == (409, "ARTIFACT_MISMATCH")
    status, body = call(server, "GET", f"/v1/documents/{document['document_id']}/pages")
    assert (status, body["code"]) == (400, "SHA256_REQUIRED")
    status, body = call(server, "GET", "/v1/documents/doc_00000000/pages?sha256=" + "a" * 64)
    assert status == 404


def test_operations_work_where_the_process_has_no_user_name(server, monkeypatch):
    """A hardened container has no passwd entry or USER variable; every operation builds the CLI parser."""
    import getpass

    def no_user():
        raise OSError("No username set in the environment")

    monkeypatch.setattr(getpass, "getuser", no_user)
    status, body = call(server, "GET", "/v1/cases/CASE-UNKNOWN/package")
    assert (status, body["code"]) == (404, "NOT_FOUND")
