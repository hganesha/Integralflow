#!/usr/bin/env python3
"""Build or check the independently versioned document field sidecar.

Committed outputs are the compact resources the package loads at runtime, the document index
and the golden examples. The per-type bundle (fields.json, extraction.schema.json and
instructions.md for every document type) is generated on demand with --export and is never
committed; --check still renders it in memory so a broken profile fails the check.
"""
import argparse
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from kyc_documents.artifacts import render_bundle, render_index
from kyc_documents.artifacts import json_text
from document_catalog_examples import EXAMPLES, fixture

RESOURCES = ("catalog.json", "field-library.json", "coverage.json", "entity-packages.json", "review-events.json")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--export", type=Path, help="write the full per-type bundle to this directory")
    args = parser.parse_args()
    bundle = render_bundle()
    resources = ROOT / "src/kyc_documents/resources"
    outputs = {resources / name: bundle[name] for name in RESOURCES}
    outputs[ROOT / "docs/document-field-catalog.md"] = render_index()
    for identifier in EXAMPLES:
        outputs[ROOT / "examples/documents" / (identifier + ".json")] = json_text(fixture(identifier))
    stale = []
    for path, value in outputs.items():
        if args.check:
            if not path.is_file() or path.read_text(encoding="utf-8") != value:
                stale.append(str(path.relative_to(ROOT)))
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(value, encoding="utf-8")
    stale.extend(str(p.relative_to(ROOT)) for p in resources.rglob("*") if p.is_file() and p not in outputs)
    if stale:
        raise SystemExit("Stale/unexpected document artifacts:\n" + "\n".join(sorted(stale)))
    if args.export:
        for relative, value in bundle.items():
            path = args.export / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(value, encoding="utf-8")
    print(f"{'Checked' if args.check else 'Built'} {len(outputs)} document artifacts"
          + (f"; exported {len(bundle)} to {args.export}" if args.export else f" ({len(bundle)} bundle artifacts rendered)"))


if __name__ == "__main__":
    main()
