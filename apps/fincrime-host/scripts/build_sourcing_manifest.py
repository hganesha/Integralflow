#!/usr/bin/env python3
"""Build or check the Document Model Factory's sourcing manifest.

The manifest is derived from the document catalog and the human decisions in
src/document_factory/resources/sourcing-reviews.yaml. --check fails when the committed manifest
differs from what the catalog and reviews produce.
"""
import argparse
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from kyc_documents.artifacts import json_text
from document_factory.sourcing import build_manifest

OUTPUT = ROOT / "src/document_factory/resources/sourcing-manifest.json"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    text = json_text(build_manifest())
    if args.check:
        if not OUTPUT.is_file() or OUTPUT.read_text(encoding="utf-8") != text:
            raise SystemExit(f"stale: {OUTPUT.relative_to(ROOT)}; run scripts/build_sourcing_manifest.py")
        return
    OUTPUT.write_text(text, encoding="utf-8")
    print(f"wrote {OUTPUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
