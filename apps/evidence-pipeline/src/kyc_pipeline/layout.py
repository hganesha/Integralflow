"""Supplied canonical layout (`document.layout.v1`) mapped onto the pipeline's segments.

The pipeline never contacts an OCR or layout provider and holds no provider credential. A platform
adapter (for example Azure Document Intelligence prebuilt-layout, `packages/adapters`) analyzes the
original bytes and sends the result here in a provider-neutral shape; this module only maps it.

The supplied layout is untrusted input. It must name the exact bytes it describes (`source_sha256`),
stay within size limits, and use known block kinds; anything else is refused rather than repaired.
The page text the pipeline builds from it is the provider's recognition: an OCR misread becomes the
"source", so low-confidence words and handwriting are raised as parse issues on their pages.

Geometry is kept only in a usable basis: inches are converted to points (72 per inch), pixels and
points are kept, and a page with a non-trivial text angle is marked rotated so viewers draw no boxes.
"""
from __future__ import annotations

import math
from typing import Any

from .parsing import _new_segment, _path, _table_text, _update_heading

CONTRACT = "document.layout.v1"
UNITS = {"inch": 72.0, "point": 1.0, "pixel": 1.0}
BLOCK_KINDS = {"title", "heading", "paragraph", "page_header", "page_footer", "page_number", "footnote", "table"}
MAX_PAGES = 2000
MAX_BLOCKS = 50_000
MAX_TEXT = 200_000
MAX_TABLE_CELLS = 100_000
LOW_CONFIDENCE = 0.8
ROTATION_TOLERANCE_DEGREES = 0.5


class LayoutError(ValueError):
    """The supplied layout is not a usable document.layout.v1 for these bytes."""


def _number(value: Any, *, minimum: float | None = None) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        return None
    return None if minimum is not None and value < minimum else float(value)


def _page_number(value: Any, pages: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= pages:
        raise LayoutError("block page must name a supplied page")
    return value


def _bbox(value: Any, scale: float, width: float | None, height: float | None) -> list[float] | None:
    if value is None:
        return None
    if not isinstance(value, list) or len(value) != 4 or any(_number(v, minimum=0) is None for v in value):
        raise LayoutError("bbox must be [left, top, right, bottom] with non-negative numbers")
    left, top, right, bottom = (round(float(v) * scale, 2) for v in value)
    if right <= left or bottom <= top:
        raise LayoutError("bbox must have positive width and height")
    if width is not None and height is not None and (right > width * scale + 0.01 or bottom > height * scale + 0.01):
        return None  # outside the page: keep the text, drop the region
    return [left, top, right, bottom]


def validate(layout: Any, sha256: str) -> dict:
    """The layout, checked for shape, limits and source binding. Raises LayoutError."""
    if not isinstance(layout, dict) or layout.get("contract") != CONTRACT:
        raise LayoutError(f"layout must be a {CONTRACT} object")
    if layout.get("source_sha256") != sha256:
        raise LayoutError("layout source_sha256 does not match the document bytes")
    for key in ("provider", "model"):
        if not isinstance(layout.get(key), str) or not layout[key] or len(layout[key]) > 120:
            raise LayoutError(f"layout {key} is required")
    pages, blocks = layout.get("pages"), layout.get("blocks")
    if not isinstance(pages, list) or not 1 <= len(pages) <= MAX_PAGES:
        raise LayoutError(f"layout must have 1 to {MAX_PAGES} pages")
    if not isinstance(blocks, list) or len(blocks) > MAX_BLOCKS:
        raise LayoutError(f"layout blocks must be a list of at most {MAX_BLOCKS}")
    for index, page in enumerate(pages, start=1):
        if not isinstance(page, dict) or page.get("page") != index:
            raise LayoutError("layout pages must be numbered 1..n in order")
        if page.get("unit") not in UNITS:
            raise LayoutError("page unit must be inch, point or pixel")
        if _number(page.get("width"), minimum=0.0001) is None or _number(page.get("height"), minimum=0.0001) is None:
            raise LayoutError("page width and height must be positive numbers")
    cells = 0
    for block in blocks:
        if not isinstance(block, dict) or block.get("kind") not in BLOCK_KINDS:
            raise LayoutError("each block needs a known kind")
        _page_number(block.get("page"), len(pages))
        if block["kind"] == "table":
            rows = (block.get("table") or {}).get("rows") if isinstance(block.get("table"), dict) else None
            if not isinstance(rows, list) or not all(isinstance(r, list) and all(isinstance(c, str) for c in r) for r in rows):
                raise LayoutError("a table block needs rows of strings")
            cells += sum(len(r) for r in rows)
        elif not isinstance(block.get("text"), str) or len(block["text"]) > MAX_TEXT:
            raise LayoutError("a text block needs text within the size limit")
    if cells > MAX_TABLE_CELLS:
        raise LayoutError("layout tables exceed the cell limit")
    return layout


def page_geometry(layout: dict) -> dict[int, dict]:
    """Per page: width and height in the segments' coordinate unit, and whether boxes can be drawn upright."""
    geometry = {}
    for page in layout["pages"]:
        scale = UNITS[page["unit"]]
        angle = _number(page.get("angle")) or 0.0
        geometry[page["page"]] = {
            "width": round(page["width"] * scale, 2), "height": round(page["height"] * scale, 2),
            "unit": "point" if page["unit"] in ("inch", "point") else "pixel",
            "rotation": "0" if abs(angle) <= ROTATION_TOLERANCE_DEGREES else "skewed",
            "basis": "layout_provider",
        }
    return geometry


def segments_from_layout(layout: dict, document_id: str) -> tuple[list[dict], list[dict], int]:
    """Segments, parse issues and page count from a validated layout, in the provider's reading order."""
    pages = {p["page"]: p for p in layout["pages"]}
    segments: list[dict] = []
    headings: list[tuple[int, str]] = []
    low_confidence: dict[int, int] = {}
    merged: dict[int, int] = {}
    for index, block in enumerate(layout["blocks"]):
        page_number = block["page"]
        page = pages[page_number]
        bbox = _bbox(block.get("bbox"), UNITS[page["unit"]], page["width"], page["height"])
        confidence = _number(block.get("min_word_confidence"))
        if confidence is not None and confidence < LOW_CONFIDENCE:
            low_confidence[page_number] = low_confidence.get(page_number, 0) + 1
        metadata: dict[str, Any] = {"min_word_confidence": confidence, "layout_kind": block["kind"]}
        spanned = block.get("pages")
        if isinstance(spanned, list) and len(spanned) > 1:
            metadata["pages"] = [p for p in spanned if isinstance(p, int)]
        if block.get("figure_id"):
            metadata["figure_id"] = str(block["figure_id"])[:64]
        if block["kind"] == "table":
            table = block["table"]
            rows = [[" ".join(cell.split()) for cell in row] for row in table["rows"]]
            count = int(_number(table.get("merged_cells"), minimum=0) or 0)
            if count:
                merged[page_number] = merged.get(page_number, 0) + count
            caption = table.get("caption") if isinstance(table.get("caption"), str) else None
            metadata.update({"header_rows": int(_number(table.get("header_rows"), minimum=0) or 0),
                             "caption": " ".join(caption.split()) if caption else None,
                             "note": "Cell text comes from the layout provider; merged cells are placed at their first row and column."})
            _new_segment(segments, document_id, text=_table_text(rows), kind="table", section_path=_path(headings),
                         locator=f"page:{page_number}/layout-table:{index}", page=page_number, bbox=bbox,
                         representation="layout_table", metadata=metadata)
            continue
        # Whitespace is normalized within each line; the provider's line breaks are kept, because a form's
        # label and value are often separated only by a line boundary.
        text = "\n".join(" ".join(line.split()) for line in block["text"].splitlines() if line.strip())
        kind = block["kind"]
        if kind in ("title", "heading") and text:
            level = block.get("heading_level")
            level = level if isinstance(level, int) and not isinstance(level, bool) and 1 <= level <= 6 else (1 if kind == "title" else 2)
            headings = _update_heading(headings, level, text)
            segment_kind = "heading"
        elif kind in ("page_header", "page_footer", "page_number"):
            segment_kind = "page_furniture"
        elif kind == "footnote":
            segment_kind = "footnote"
        else:
            segment_kind = "paragraph"
        _new_segment(segments, document_id, text=text, kind=segment_kind, section_path=_path(headings),
                     locator=f"page:{page_number}/layout-{kind}:{index}", page=page_number, bbox=bbox,
                     representation="layout_text", metadata=metadata)

    issues: list[dict] = []
    provider = layout["provider"]
    geometry = page_geometry(layout)
    for number, page in pages.items():
        if page.get("has_text") is False:
            issues.append({"code": "LAYOUT_PAGE_NO_TEXT", "message": "The layout provider found no text on this page; check whether it is blank or unreadable.", "page": number})
        if _number(page.get("handwritten_spans"), minimum=0):
            issues.append({"code": "HANDWRITTEN_CONTENT", "message": "Page contains handwriting; recognized text needs visual verification.", "page": number, "span_count": int(page["handwritten_spans"])})
        if geometry[number]["rotation"] != "0":
            issues.append({"code": "LAYOUT_PAGE_ROTATED", "message": "The page's text is at an angle; source regions are not drawn and positions need visual verification.", "page": number})
    for number, count in sorted(low_confidence.items()):
        issues.append({"code": "OCR_LOW_CONFIDENCE", "message": f"Some recognized words have confidence below {LOW_CONFIDENCE}; check names, numbers and dates against the original page.", "page": number, "segment_count": count})
    for figure in layout.get("figures") or []:
        if isinstance(figure, dict):
            issues.append({"code": "LAYOUT_FIGURE_NOT_INTERPRETED", "message": "Text inside figures was recognized, but charts, photos and graphics were not interpreted.", "page": figure.get("page"), "figure_id": str(figure.get("id"))[:64]})
    for number, count in sorted(merged.items()):
        issues.append({"code": "LAYOUT_TABLE_MERGED_CELLS", "message": "A table has merged body cells; verify row and column relationships against the original page.", "page": number, "count": count})
    if not segments:
        issues.append({"code": "EMPTY_DOCUMENT", "message": f"The layout provider ({provider}) returned no text.", "page": None})
    return segments, issues, len(pages)
