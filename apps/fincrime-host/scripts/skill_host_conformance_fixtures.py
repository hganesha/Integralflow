#!/usr/bin/env python3
"""Fixtures for running EHF's skill.execution.v1 conformance suite against this library's host.

    python scripts/skill_host_conformance_fixtures.py > fixtures.json
    pnpm --filter @ehf/skill-conformance conformance -- --base-url http://127.0.0.1:8090 --fixtures fixtures.json

The deterministic and read-only checks use document.classify.catalog and document.validity.assess;
the capability check uses document.fields.contract_extract, whose gateway output must be a valid
extraction of exactly the page the fixture sends.
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from financial_crime import synthetic  # noqa: E402

OBSERVED = "2026-11-01T00:00:00Z"


def record(object_type, object_id, data):
    return {"object_type": object_type, "object_id": object_id, "version_id": "v1", "schema_version": "2.0.0", "data": data,
            "observed_at": OBSERVED, "source_refs": [], "classification": "CONFIDENTIAL", "synthetic": True}


def main():
    page = {"text": synthetic.PAGE_TEXT, "page": 1, "document_version": "doc-v1"}
    pages = [r for r in synthetic.records() if r.object_type == "DocumentPage"]
    _, extraction = synthetic.document_fields_extraction(pages)
    page_section = {"id": "recDocumentPage", "kind": "case", "value": [record("DocumentPage", "page-1", page)]}
    assertion = record("ExtractedAssertion", "extract-2", {"subject": "acme", "field": "expiry_date", "value": "2031-05-02", "document_version": "doc-v1"})
    def policy(skill_id, effects="read_only"):
        # The case's pinned policy projection: the only source of the host's authority.
        grants = [f"skill:{skill_id}"] + ([f"effect:{effects}"] if effects != "read_only" else [])
        return {"id": "policy", "kind": "policy", "value": {"version": "1.0.0", "jurisdiction": "GB", "permissions": grants}}

    fixtures = {
        "purpose": "onboarding",
        "deterministic": {"skillId": "document.classify.catalog", "parameters": {}, "sections": [page_section, policy("document.classify.catalog")]},
        "readOnly": {"skillId": "document.validity.assess", "parameters": {}, "requiredSectionId": "recExtractedAssertion",
                     "sections": [{"id": "recExtractedAssertion", "kind": "case", "value": [assertion]}, policy("document.validity.assess")]},
        "capability": {"skillId": "document.fields.contract_extract", "dependency": "document.fields",
                       "parameters": {"classifications": [{"document_version": "doc-v1", "document_type": "certificate_of_incorporation",
                                                       "basis": "title", "candidates": []}], "subject": "acme"},
                       "sections": [page_section, policy("document.fields.contract_extract", "proposal")], "passOutput": extraction,
                       "unknownOutputs": [{"status": "unknown"}, {"status": "not_checked", "observations": []}]},
    }
    json.dump(fixtures, sys.stdout, indent=2)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
