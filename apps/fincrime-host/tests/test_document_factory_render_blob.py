"""The Factory's text-to-PDF renderer and its Blob training container."""
import re

import pytest

from document_factory.blob import BlobError, TrainingContainer
from document_factory.render import text_pdf


def test_rendered_pdf_has_a_valid_cross_reference_table_and_is_deterministic():
    text = "W-9\nName (as shown on your income tax return): Sam Testwell (Trust)\n" + "\n".join(f"line {i}" for i in range(130))
    pdf = text_pdf(text)
    assert pdf.startswith(b"%PDF-1.4") and pdf.rstrip().endswith(b"%%EOF") and pdf == text_pdf(text)
    start = int(re.search(rb"startxref\n(\d+)", pdf).group(1))
    assert pdf[start:start + 4] == b"xref"
    for number, offset in enumerate(re.findall(rb"(\d{10}) 00000 n", pdf), start=1):
        assert pdf[int(offset):].startswith(b"%d 0 obj" % number)
    assert pdf.count(b"/Type /Page ") == 3  # 132 lines at 60 per page
    assert b"\\(Trust\\)" in pdf


def test_training_container_accepts_only_azure_blob_and_safe_names():
    calls = []
    container = TrainingContainer("https://ehfdata.blob.core.windows.net/train?sv=2025&sig=x", lambda m, u, h, b: (calls.append((m, u, h)) or (201, {}, b"")))
    container.put("job_1/models/w9/a.pdf", b"x", "application/pdf")
    method, url, headers = calls[0]
    assert method == "PUT" and url == "https://ehfdata.blob.core.windows.net/train/job_1/models/w9/a.pdf?sv=2025&sig=x" and headers["x-ms-blob-type"] == "BlockBlob"
    for bad in ("https://evil.example.com/train?sig=x", "http://ehfdata.blob.core.windows.net/train", "https://ehfdata.blob.core.windows.net/a/b"):
        with pytest.raises(BlobError):
            TrainingContainer(bad, lambda *a: (201, {}, b""))
    with pytest.raises(BlobError):
        container.put("../escape", b"x", "text/plain")
    failing = TrainingContainer("https://ehfdata.blob.core.windows.net/train?sig=x", lambda *a: (403, {}, b""))
    with pytest.raises(BlobError, match="HTTP 403"):
        failing.put("a.pdf", b"x", "application/pdf")
