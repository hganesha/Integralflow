"""A dependency-free renderer: document text to a born-digital PDF, for training and evaluating document models.

Synthetic samples are text by construction; Azure trains and analyzes files. One US Letter page per 60 lines,
Helvetica 10 pt, long lines wrapped at word boundaries, characters outside Latin-1 replaced by `?` (their labels
then fail to match and are reported, never guessed). The output is deterministic for the same text, so a rendered
sample has a stable digest. Checked live: Azure prebuilt-layout reads every gold value of the 10 pilot types.
"""
from __future__ import annotations

import textwrap

LINES_PER_PAGE = 60
WIDTH, HEIGHT, MARGIN, LEADING = 612, 792, 54, 12
WRAP = 95  # characters per line at Helvetica 10 pt within the margins


def _escape(line: str) -> str:
    safe = line.encode("latin-1", "replace").decode("latin-1")
    return safe.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def text_pdf(text: str) -> bytes:
    # Long lines wrap at word boundaries; labels map onto words, so wrapping never moves a value.
    lines = [part for line in text.replace("\r\n", "\n").split("\n") for part in (textwrap.wrap(line, WRAP, break_long_words=True, break_on_hyphens=False) or [""])]
    pages = [lines[i:i + LINES_PER_PAGE] for i in range(0, max(len(lines), 1), LINES_PER_PAGE)]
    objects: list[bytes] = []

    def add(body: bytes) -> int:
        objects.append(body)
        return len(objects)

    font = add(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>")
    kids_placeholder = add(b"")  # pages tree, filled in below
    page_ids = []
    for page in pages:
        stream = "BT /F1 10 Tf {} TL {} {} Td ".format(LEADING, MARGIN, HEIGHT - MARGIN)
        stream += " ".join(f"({_escape(line)}) Tj T*" for line in page) + " ET"
        data = stream.encode("latin-1")
        content = add(b"<< /Length %d >>\nstream\n" % len(data) + data + b"\nendstream")
        page_ids.append(add(("<< /Type /Page /Parent %d 0 R /MediaBox [0 0 %d %d] /Resources << /Font << /F1 %d 0 R >> >> /Contents %d 0 R >>"
                             % (kids_placeholder, WIDTH, HEIGHT, font, content)).encode()))
    objects[kids_placeholder - 1] = ("<< /Type /Pages /Kids [%s] /Count %d >>" % (" ".join(f"{i} 0 R" for i in page_ids), len(page_ids))).encode()
    catalog = add(("<< /Type /Catalog /Pages %d 0 R >>" % kids_placeholder).encode())
    out = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = []
    for number, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % number + body + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1)
    out += b"".join(b"%010d 00000 n \n" % offset for offset in offsets)
    out += b"trailer\n<< /Size %d /Root %d 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objects) + 1, catalog, xref)
    return bytes(out)
