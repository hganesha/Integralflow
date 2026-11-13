"""Stateless preparation of one hash-bound document for catalog extraction.

`prepare` decodes one original into full page text and returns it in the evidence package's shape
(`documents`, `pages`, `evidence`), without storing anything, running extraction or deciding anything.
The platform normalizes it into DocumentVersion and DocumentPage records.

Two sources of page text:

* the native parsers, for text-based PDF, TXT/Markdown, HTML and CSV; and
* a supplied canonical layout (`document.layout.v1`) made by a platform layout adapter, for scans,
  images and PDFs without a usable text layer. The pipeline never calls the provider itself.

When native parsing finds image-only or text-poor pages, the response says `layout_recommended`, so
the caller can analyze the original with its bound layout provider and prepare again with the layout.
"""
from __future__ import annotations

import hashlib
import re
from pathlib import PurePath

from .layout import LayoutError, page_geometry, segments_from_layout, validate
from .pages import assemble_pages
from .parsing import NATIVE_SUFFIXES, parse_bytes

DOCUMENT_ID = re.compile(r"^doc_[a-f0-9]{8,64}$")
SHA256 = re.compile(r"^[a-f0-9]{64}$")
LAYOUT_SUFFIXES = NATIVE_SUFFIXES | {".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp", ".heif", ".docx", ".xlsx", ".pptx"}
IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp", ".heif"}
LAYOUT_SIGNALS = {"PDF_IMAGES_NOT_OCR", "PDF_PAGE_TEXT_INSUFFICIENT", "EMPTY_DOCUMENT"}


class PrepareError(ValueError):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status, self.code = status, code


def prepare(case_id: str, filename: str, data: bytes, document_id: str, document_version: str, layout: dict | None = None) -> dict:
    sha256 = hashlib.sha256(data).hexdigest()
    if not isinstance(document_id, str) or not DOCUMENT_ID.match(document_id):
        raise PrepareError(400, "DOCUMENT_ID_INVALID", "document_id must be doc_ followed by 8 to 64 lowercase hex characters")
    if not isinstance(document_version, str) or not SHA256.match(document_version) or document_version != sha256:
        raise PrepareError(409, "DOCUMENT_VERSION_MISMATCH", "document_version must be the sha256 of the supplied bytes")
    suffix = PurePath(filename).suffix.lower()
    if layout is not None:
        if suffix not in LAYOUT_SUFFIXES:
            raise PrepareError(415, "FORMAT_UNSUPPORTED", "this file type cannot be prepared from a layout")
        try:
            checked = validate(layout, sha256)
            segments, issues, page_count = segments_from_layout(checked, document_id)
            geometry = page_geometry(checked)
        except LayoutError as error:
            raise PrepareError(422, "LAYOUT_INVALID", str(error)) from None
        parser = {"name": "layout", "contract": checked["contract"], "provider": checked["provider"], "model": checked["model"],
                  "model_version": checked.get("model_version"), "page_count_basis": "layout_provider"}
        blank_pages: list[int] = []
    else:
        if suffix in IMAGE_SUFFIXES or suffix not in NATIVE_SUFFIXES:
            raise PrepareError(422, "LAYOUT_REQUIRED", "this file type needs a layout provider; no native text parser reads it")
        try:
            segments, issues, page_count, blank_pages = parse_bytes(data, suffix, document_id)
        except ValueError as error:
            raise PrepareError(422, "PARSE_FAILED", str(error)) from None
        geometry = None
        parser = {"name": "native", "page_count_basis": "parser"}
    pages = assemble_pages(document_id, segments, geometry)
    recommended = layout is None and any(issue.get("code") in LAYOUT_SIGNALS for issue in issues)
    document = {"document_id": document_id, "sha256": sha256, "filename": filename, "format": suffix.lstrip("."),
                "page_count": page_count or len(pages) or None, "structurally_blank_pdf_pages": blank_pages, "parser": parser}
    return {"case_id": case_id, "status": "PREPARED", "documents": [document], "pages": pages, "evidence": [],
            "issues": issues, "layout_recommended": recommended}
