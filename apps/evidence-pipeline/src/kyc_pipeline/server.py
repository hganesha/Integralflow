"""Authenticated HTTP API over the evidence pipeline (`kyc-evidence-server`).

The routes are the ones EHF's capability gateway calls (packages/adapters/src/evidence-pipeline.ts):

    GET  /healthz                         liveness and readiness, unauthenticated
    POST /v1/cases/{case_id}/documents    {filename, content_base64, profile?} -> ingest one document
    POST /v1/cases/{case_id}/documents/prepare  {filename, content_base64, document_id, document_version, layout?}
                                          -> decode one hash-bound original into full page text; stores nothing
    GET  /v1/cases/{case_id}/package      the case's canonical evidence package, plus full page text
    GET  /v1/cases/{case_id}/ownership    the case's ownership and control graph
    POST /v1/runs/{run_id}/resume         {reviewer_id, decisions} -> resume a paused run
    GET  /v1/documents/{document_id}/pages?sha256=<hex>  a parsed document's numbered page text (document.ocr)

Every route except /healthz needs `Authorization: Bearer <token>`. The token comes from
EVIDENCE_PIPELINE_TOKEN or EVIDENCE_PIPELINE_TOKEN_FILE; the server refuses to start without one,
except in demo mode (EVIDENCE_PIPELINE_MODE=demo), which uses the published synthetic-only demo token.
The server runs the same operations as the CLI, through `cli.execute`, so the CLI's validation,
checkpointing and audit rules apply unchanged. Only the offline configuration is served: native
parsing, rule extraction and lexical retrieval. Nothing here sends document content off the machine.

Uploaded originals are kept under <data dir>/uploads/<sha256>/ with owner-only permissions so a
retry can re-read identical bytes; the evidence store itself never copies a source file. Every
fact the pipeline returns stays PENDING_HUMAN: this service prepares evidence and decides nothing.
"""
from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import json
import os
import re
import tempfile
import threading
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

from .cli import execute, make_parser
from .extraction import ProviderError
from .prepare import PrepareError, prepare as prepare_document
from .store import EvidenceStore
from .util import json_text

CASE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$")
RUN_ID = re.compile(r"^run_[0-9a-f]{32}$")
PROFILE_ID = re.compile(r"^[a-z0-9_]{1,80}$")
FILENAME = re.compile(r"^[^/\\\x00-\x1f]{1,255}$")
MAX_DOCUMENT_BYTES = 12 * 1024 * 1024
MAX_BODY_BYTES = 17 * 1024 * 1024
# A prepare request may carry a supplied layout (document.layout.v1) beside the base64 original.
MAX_PREPARE_BODY_BYTES = 40 * 1024 * 1024

ROUTES = (
    ("POST", re.compile(r"^/v1/cases/([^/]+)/documents$"), "ingest"),
    ("POST", re.compile(r"^/v1/cases/([^/]+)/documents/prepare$"), "prepare"),
    ("GET", re.compile(r"^/v1/cases/([^/]+)/package$"), "package"),
    ("GET", re.compile(r"^/v1/cases/([^/]+)/ownership$"), "ownership"),
    ("POST", re.compile(r"^/v1/runs/([^/]+)/resume$"), "resume"),
    ("GET", re.compile(r"^/v1/documents/([^/?]+)/pages(?:\?sha256=([a-f0-9]{64}))?$"), "pages"),
)
DOCUMENT_ID = re.compile(r"^doc_[a-f0-9]{8,64}$")


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


DEMO_TOKEN = "evidence-demo-token-local-only"
DEMO_WARNING = "DEMO_ONLY: evidence pipeline demo mode; synthetic documents only"


def _token() -> str:
    path = os.environ.get("EVIDENCE_PIPELINE_TOKEN_FILE")
    value = Path(path).read_text(encoding="utf-8").strip() if path else os.environ.get("EVIDENCE_PIPELINE_TOKEN", "").strip()
    # Demo mode (synthetic data only) publishes a fixed token so a local stack works unconfigured.
    if not value and os.environ.get("EVIDENCE_PIPELINE_MODE") == "demo":
        value = DEMO_TOKEN
    if len(value) < 16:
        raise SystemExit("EVIDENCE_PIPELINE_TOKEN (or _FILE) must be set to at least 16 characters")
    return value


class Service:
    """The operations, independent of HTTP so tests can call them directly."""

    def __init__(self, data_dir: Path, token: str):
        self.data_dir = data_dir
        self.token = token
        self.uploads = data_dir / "uploads"
        self.uploads.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.db = str(data_dir / "evidence.sqlite")
        self.checkpoints = str(data_dir / "checkpoints.sqlite")
        # SQLite and the LangGraph checkpointer are single-writer; serialize operations.
        self.lock = threading.Lock()

    def authorized(self, header: str | None) -> bool:
        if not header or not header.startswith("Bearer "):
            return False
        return hmac.compare_digest(header[7:].strip().encode(), self.token.encode())

    def _run(self, argv: list[str]) -> Any:
        args = make_parser().parse_args(argv)
        with self.lock:
            try:
                return execute(args)
            except (ValueError, ProviderError) as exc:
                message = str(exc)
                if message in ("Case not found", "Case has no persisted documents", "Run not found"):
                    raise ApiError(404, "NOT_FOUND", message) from None
                if "not paused" in message:
                    raise ApiError(409, "RUN_NOT_PAUSED", message) from None
                raise ApiError(422, "PIPELINE_REJECTED", message) from None

    def _db(self, checkpoint: bool) -> list[str]:
        return ["--db", self.db] + (["--checkpoint-db", self.checkpoints] if checkpoint else [])

    def ingest(self, case_id: str, body: dict) -> dict:
        filename, content, profile = body.get("filename"), body.get("content_base64"), body.get("profile")
        if not isinstance(filename, str) or not FILENAME.match(filename) or filename in (".", ".."):
            raise ApiError(400, "FILENAME_INVALID", "filename must be a plain file name")
        if not isinstance(content, str) or not content:
            raise ApiError(400, "CONTENT_INVALID", "content_base64 is required")
        try:
            data = base64.b64decode(content, validate=True)
        except (binascii.Error, ValueError):
            raise ApiError(400, "CONTENT_INVALID", "content_base64 is not valid base64") from None
        if not data or len(data) > MAX_DOCUMENT_BYTES:
            raise ApiError(413, "CONTENT_TOO_LARGE", f"a document must be 1 to {MAX_DOCUMENT_BYTES} bytes")
        if profile is not None and (not isinstance(profile, str) or not PROFILE_ID.match(profile)):
            raise ApiError(400, "PROFILE_INVALID", "profile must be a profile ID")
        sha256 = hashlib.sha256(data).hexdigest()
        folder = self.uploads / sha256
        folder.mkdir(exist_ok=True, mode=0o700)
        path = folder / filename
        if not path.exists():
            fd, temporary = tempfile.mkstemp(dir=folder)
            with os.fdopen(fd, "wb") as handle:
                handle.write(data)
            os.chmod(temporary, 0o600)
            os.replace(temporary, path)
        argv = ["ingest", str(path), "--case-id", case_id, *self._db(True)]
        if profile:
            argv += ["--profile", profile]
        result = self._run(argv)
        return {**result, "document_sha256": sha256}

    def prepare(self, case_id: str, body: dict) -> dict:
        """Stateless: decode one hash-bound original (natively, or from a supplied layout); nothing is stored."""
        filename, content = body.get("filename"), body.get("content_base64")
        if not isinstance(filename, str) or not FILENAME.match(filename) or filename in (".", ".."):
            raise ApiError(400, "FILENAME_INVALID", "filename must be a plain file name")
        if not isinstance(content, str) or not content:
            raise ApiError(400, "CONTENT_INVALID", "content_base64 is required")
        try:
            data = base64.b64decode(content, validate=True)
        except (binascii.Error, ValueError):
            raise ApiError(400, "CONTENT_INVALID", "content_base64 is not valid base64") from None
        if not data or len(data) > MAX_DOCUMENT_BYTES:
            raise ApiError(413, "CONTENT_TOO_LARGE", f"a document must be 1 to {MAX_DOCUMENT_BYTES} bytes")
        layout = body.get("layout")
        if layout is not None and not isinstance(layout, dict):
            raise ApiError(400, "LAYOUT_INVALID", "layout must be a document.layout.v1 object")
        try:
            result = prepare_document(case_id, filename, data, body.get("document_id"), body.get("document_version"), layout)
        except PrepareError as error:
            raise ApiError(error.status, error.code, str(error)) from None
        # Demo mode takes synthetic documents only (its token is published), and says so: the platform's
        # normalizer marks records from a DEMO_ONLY response synthetic, which a synthetic-only skill release requires.
        if os.environ.get("EVIDENCE_PIPELINE_MODE") == "demo":
            result["warnings"] = [*result.get("warnings", []), DEMO_WARNING]
        return result

    def package(self, case_id: str) -> dict:
        """The CLI's evidence package plus `pages`: each current document's full decoded page text
        with the segment offsets that map evidence spans onto it (EvidenceStore.document_pages)."""
        package = self._run(["report", "--case-id", case_id, *self._db(False)])
        with self.lock:
            store = EvidenceStore(self.db)
            try:
                package["pages"] = store.document_pages(case_id)
            finally:
                store.close()
        return package

    def ownership(self, case_id: str) -> dict:
        return self._run(["ownership", "--case-id", case_id, *self._db(False)])

    def pages(self, document_id: str, sha256: str | None) -> dict:
        """The decoded pages of one parsed document, in the skill library's document.ocr response shape.

        The caller names the artifact hash it expects; a different document is refused rather than
        returned. The text is the pipeline's normalized decoding (native parsers), with no OCR claim
        beyond what the parser did.
        """
        if not sha256:
            raise ApiError(400, "SHA256_REQUIRED", "sha256 query parameter is required")
        with self.lock:
            store = EvidenceStore(self.db)
            try:
                found = store.document_pages_by_id(document_id)
            finally:
                store.close()
        if not found:
            raise ApiError(404, "NOT_FOUND", "Document not found")
        document, pages = found
        if document.get("sha256") != sha256:
            raise ApiError(409, "ARTIFACT_MISMATCH", "the document's sha256 differs from the requested artifact")
        if not pages:
            raise ApiError(404, "NOT_FOUND", "Document has no decoded pages")
        numbers = [p["page"] for p in pages]
        if numbers != list(range(1, len(numbers) + 1)):
            raise ApiError(409, "PAGES_INCOMPLETE", "decoded pages are not numbered 1..n")
        parser = document.get("parser") or {}
        return {"pages": [{"page": p["page"], "text": p["text"]} for p in pages],
                "parser": {"name": "kyc-evidence-pipeline:" + str(parser.get("name") or "native"), "version": "0.1.0"}}

    def resume(self, run_id: str, body: dict) -> dict:
        if not isinstance(body.get("reviewer_id"), str) or not isinstance(body.get("decisions"), list):
            raise ApiError(400, "DECISION_INVALID", "reviewer_id and decisions are required")
        fd, decision = tempfile.mkstemp(dir=self.data_dir, suffix=".json")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                json.dump(body, handle)
            return self._run(["resume", "--run-id", run_id, "--decision", decision, *self._db(True)])
        finally:
            os.unlink(decision)


def make_handler(service: Service) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        server_version = "kyc-evidence-server"
        sys_version = ""

        def log_message(self, format: str, *args: Any) -> None:  # no request bodies or paths with case IDs in logs
            pass

        def _send(self, status: int, payload: Any) -> None:
            body = (json_text(payload) if not isinstance(payload, str) else json.dumps({"text": payload})).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def _body(self, limit: int = MAX_BODY_BYTES) -> dict:
            length = int(self.headers.get("Content-Length") or 0)
            if length > limit:
                raise ApiError(413, "BODY_TOO_LARGE", "request body too large")
            try:
                value = json.loads(self.rfile.read(length) or b"{}")
            except json.JSONDecodeError:
                raise ApiError(400, "BODY_INVALID", "request body must be JSON") from None
            if not isinstance(value, dict):
                raise ApiError(400, "BODY_INVALID", "request body must be a JSON object")
            return value

        def _dispatch(self, method: str) -> None:
            try:
                if method == "GET" and self.path == "/healthz":
                    return self._send(200, {"status": "ok"})
                for route_method, pattern, operation in ROUTES:
                    match = pattern.match(self.path)
                    if not match:
                        continue
                    if route_method != method:
                        raise ApiError(405, "METHOD_NOT_ALLOWED", "method not allowed")
                    if not service.authorized(self.headers.get("Authorization")):
                        raise ApiError(401, "UNAUTHORIZED", "Bearer token required")
                    identifier = match.group(1)
                    if operation == "pages":
                        if not DOCUMENT_ID.match(identifier):
                            raise ApiError(400, "DOCUMENT_ID_INVALID", "invalid document ID")
                        return self._send(200, service.pages(identifier, match.group(2)))
                    if operation == "resume":
                        if not RUN_ID.match(identifier):
                            raise ApiError(400, "RUN_ID_INVALID", "invalid run ID")
                        return self._send(200, service.resume(identifier, self._body()))
                    if not CASE_ID.match(identifier) or ".." in identifier:
                        raise ApiError(400, "CASE_ID_INVALID", "invalid case ID")
                    if operation == "ingest":
                        return self._send(200, service.ingest(identifier, self._body()))
                    if operation == "prepare":
                        return self._send(200, service.prepare(identifier, self._body(MAX_PREPARE_BODY_BYTES)))
                    return self._send(200, getattr(service, operation)(identifier))
                raise ApiError(404, "NOT_FOUND", "no such route")
            except ApiError as error:
                self._send(error.status, {"code": error.code, "message": error.message})
            except Exception:  # never echo internals
                self._send(500, {"code": "INTERNAL", "message": "internal error"})

        def do_GET(self) -> None:
            self._dispatch("GET")

        def do_POST(self) -> None:
            self._dispatch("POST")

    return Handler


def main() -> None:
    data_dir = Path(os.environ.get("EVIDENCE_PIPELINE_DATA_DIR", "kyc_data")).resolve()
    data_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    service = Service(data_dir, _token())
    host = os.environ.get("EVIDENCE_PIPELINE_HOST", "0.0.0.0")
    port = int(os.environ.get("EVIDENCE_PIPELINE_PORT", "8080"))
    ThreadingHTTPServer((host, port), make_handler(service)).serve_forever()


if __name__ == "__main__":
    main()
