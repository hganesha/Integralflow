"""Full page text from a document's segments, shared by the stored package and stateless preparation.

A page's text is its normalized segments in reading order, joined by a blank line. Each segment's
`start`/`end` are Unicode code-point offsets of its text in the page, so an evidence span
(segment_id, start, end) maps to the page span (start + offset, end + offset). A document without page
numbers (plain text, HTML, CSV) is one page, number 1. The text is the pipeline's normalized
representation, not the original file's bytes.

A segment's `bbox` is carried when the parser recorded one, and a page's `geometry` when the caller
supplies it (layout providers). Viewers draw a region only in a page with usable geometry.
"""
from __future__ import annotations

from .util import digest


def assemble_pages(document_id: str, segments: list[dict], geometry: dict[int, dict] | None = None) -> list[dict]:
    pages: dict[int, dict] = {}
    for segment in segments:
        number = segment.get("page") or 1
        page = pages.setdefault(number, {"document_id": document_id, "page": number, "parts": [], "segments": []})
        offset = sum(len(part) for part in page["parts"]) + 2 * len(page["parts"])
        page["parts"].append(segment["text"])
        entry = {"segment_id": segment["segment_id"], "start": offset, "end": offset + len(segment["text"]),
                 "locator": segment.get("locator"), "kind": segment.get("kind")}
        if isinstance(segment.get("bbox"), list) and len(segment["bbox"]) == 4:
            entry["bbox"] = segment["bbox"]
        page["segments"].append(entry)
    result = []
    for number, page in sorted(pages.items()):
        text = "\n\n".join(page.pop("parts"))
        item = {**page, "text": text, "text_sha256": digest(text), "representation": "normalized_text", "offset_basis": "unicode_code_points"}
        if geometry and number in geometry:
            item["geometry"] = geometry[number]
        result.append(item)
    return result
